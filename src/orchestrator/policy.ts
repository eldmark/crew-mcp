/**
 * Optional server-side policy seam.
 *
 * A policy is a module that can veto (or annotate) a tool call before it
 * mutates anything. With no policy configured, every hook is a no-op and
 * tool behaviour is unchanged. With a policy configured, the seam fails
 * closed: a module that cannot be loaded, a hook that throws, or a hook that
 * returns a malformed decision all refuse the call.
 *
 * Configuration: `<crewHome>/config.json`
 *   { "policy": { "module": "/absolute/path/to/policy.js" } }
 * The module's default export is a `CrewPolicy` object or a (possibly async)
 * factory returning one. Modules are loaded once per path per process;
 * restart `crew-mcp serve` after changing the policy module.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveConfigPath } from '../utils/config-store.js';
import { logger } from '../utils/logger.js';
import type { RunStateV1 } from './run-state.js';

export type PolicyHookName = 'beforeDispatch' | 'beforeMerge';

export interface PolicyContext {
  /** MCP tool being evaluated (`run_agent`, `merge_run`). */
  readonly tool: string;
  /** Validated tool input (after agent-id canonicalisation for run_agent). */
  readonly input: unknown;
  /** Current run state, when the tool targets an existing run. */
  readonly runState?: RunStateV1;
  readonly repoRoot: string;
  readonly crewHome: string;
}

export type PolicyDecision =
  | { readonly allow: true; readonly warnings?: readonly string[] }
  | { readonly allow: false; readonly code: string; readonly message: string };

export interface CrewPolicy {
  beforeDispatch?(ctx: PolicyContext): PolicyDecision | Promise<PolicyDecision>;
  beforeMerge?(ctx: PolicyContext): PolicyDecision | Promise<PolicyDecision>;
}

export type ResolvedPolicy =
  | { readonly kind: 'none' }
  | { readonly kind: 'loaded'; readonly policy: CrewPolicy; readonly source: string }
  | { readonly kind: 'failed'; readonly reason: string };

export type PolicyOutcome =
  | { readonly allow: true; readonly warnings: readonly string[] }
  | { readonly allow: false; readonly message: string };

const HOOK_NAMES: readonly PolicyHookName[] = ['beforeDispatch', 'beforeMerge'];
const POLICY_CODE_RE = /^[a-z0-9_.-]{1,64}$/;
const MAX_WARNINGS = 20;
const MAX_TEXT = 2_000;

const loadedModules = new Map<string, Promise<ResolvedPolicy>>();

/**
 * Resolve the policy configured for this crew home. Never throws: problems
 * with a configured policy come back as `{ kind: 'failed' }` so callers
 * refuse instead of silently running unguarded.
 */
export async function resolveConfiguredPolicy(crewHome: string): Promise<ResolvedPolicy> {
  const configured = readPolicyConfig(crewHome);
  if (configured.kind !== 'module') return configured;
  let pending = loadedModules.get(configured.module);
  if (pending === undefined) {
    pending = loadPolicyModule(configured.module);
    loadedModules.set(configured.module, pending);
  }
  return pending;
}

/** Test hook: forget loaded policy modules. */
export function resetPolicyModuleCacheForTests(): void {
  loadedModules.clear();
}

/**
 * Run one hook. `none` and hooks the policy does not implement allow with no
 * warnings; everything abnormal refuses with a `policy_denied` message.
 */
export async function evaluatePolicy(
  resolved: ResolvedPolicy,
  hook: PolicyHookName,
  ctx: PolicyContext,
): Promise<PolicyOutcome> {
  if (resolved.kind === 'none') return { allow: true, warnings: [] };
  if (resolved.kind === 'failed') {
    return {
      allow: false,
      message: policyDeniedMessage(ctx.tool, 'policy_unavailable', resolved.reason),
    };
  }
  const fn = resolved.policy[hook];
  if (fn === undefined) return { allow: true, warnings: [] };
  let decision: unknown;
  try {
    decision = await fn.call(resolved.policy, ctx);
  } catch (err) {
    logger.warn(
      `[policy] ${hook} threw for ${ctx.tool} (${resolved.source}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {
      allow: false,
      message: policyDeniedMessage(ctx.tool, 'policy_error', `${hook} failed; see the crew log`),
    };
  }
  return normalizeDecision(decision, hook, ctx.tool);
}

export function policyDeniedMessage(tool: string, code: string, message: string): string {
  return `policy_denied: ${tool} refused by policy (${code}): ${clip(message)}`;
}

type PolicyConfig =
  | { readonly kind: 'none' }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'module'; readonly module: string };

function readPolicyConfig(crewHome: string): PolicyConfig {
  const path = resolveConfigPath(crewHome);
  if (!existsSync(path)) return { kind: 'none' };
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    // Unparsable config already falls back to defaults elsewhere; there is
    // no way to tell whether a policy was intended, so keep upstream
    // behaviour. Deployments that require a policy must keep config valid.
    return { kind: 'none' };
  }
  if (!record || typeof record !== 'object' || Array.isArray(record) || !('policy' in record)) {
    return { kind: 'none' };
  }
  // From here on a policy was requested: anything malformed fails closed.
  const policy = (record as { policy?: unknown }).policy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return { kind: 'failed', reason: '"policy" in config.json must be an object' };
  }
  const module = (policy as { module?: unknown }).module;
  if (typeof module !== 'string' || module.trim() === '') {
    return { kind: 'failed', reason: '"policy.module" must be a non-empty string' };
  }
  if (!isAbsolute(module)) {
    return { kind: 'failed', reason: '"policy.module" must be an absolute path' };
  }
  return { kind: 'module', module };
}

async function loadPolicyModule(modulePath: string): Promise<ResolvedPolicy> {
  try {
    const imported = await import(pathToFileURL(modulePath).href) as { default?: unknown };
    let candidate = imported.default;
    if (typeof candidate === 'function') {
      candidate = await (candidate as () => unknown)();
    }
    const invalid = invalidPolicyShape(candidate);
    if (invalid !== undefined) {
      return { kind: 'failed', reason: `policy module ${modulePath}: ${invalid}` };
    }
    return { kind: 'loaded', policy: candidate as CrewPolicy, source: modulePath };
  } catch (err) {
    logger.warn(
      `[policy] failed to load ${modulePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: 'failed', reason: `policy module ${modulePath} could not be loaded` };
  }
}

function invalidPolicyShape(candidate: unknown): string | undefined {
  if (!candidate || typeof candidate !== 'object') {
    return 'default export must be a policy object or a factory returning one';
  }
  for (const hook of HOOK_NAMES) {
    const value = (candidate as Record<string, unknown>)[hook];
    if (value !== undefined && typeof value !== 'function') {
      return `${hook} must be a function`;
    }
  }
  return undefined;
}

function normalizeDecision(decision: unknown, hook: PolicyHookName, tool: string): PolicyOutcome {
  if (decision && typeof decision === 'object') {
    const d = decision as Record<string, unknown>;
    if (d.allow === true) {
      const warnings = d.warnings;
      if (warnings === undefined) return { allow: true, warnings: [] };
      if (Array.isArray(warnings) && warnings.every((w) => typeof w === 'string')) {
        return {
          allow: true,
          warnings: (warnings as string[]).slice(0, MAX_WARNINGS).map((w) => `policy: ${clip(w)}`),
        };
      }
    } else if (
      d.allow === false
      && typeof d.code === 'string'
      && POLICY_CODE_RE.test(d.code)
      && typeof d.message === 'string'
    ) {
      return { allow: false, message: policyDeniedMessage(tool, d.code, d.message) };
    }
  }
  return {
    allow: false,
    message: policyDeniedMessage(tool, 'policy_error', `${hook} returned a malformed decision`),
  };
}

function clip(text: string): string {
  const oneLine = text.replace(/[\r\n]+/g, ' ');
  return oneLine.length <= MAX_TEXT ? oneLine : `${oneLine.slice(0, MAX_TEXT)}...`;
}
