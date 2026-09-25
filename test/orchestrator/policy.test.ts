import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  evaluatePolicy,
  resetPolicyModuleCacheForTests,
  resolveConfiguredPolicy,
  type CrewPolicy,
  type PolicyContext,
  type ResolvedPolicy,
} from '../../src/orchestrator/policy.js';
import { mergeRunToolHandler } from '../../src/orchestrator/tools/merge-run.js';
import { runAgentToolHandler } from '../../src/orchestrator/tools/run-agent.js';
import type { ToolHandlerDeps, ToolRequestExtra } from '../../src/orchestrator/tools/shared.js';
import { DEFAULT_CONFIG, writeConfigFile } from '../../src/utils/config-store.js';
import { getDefaultConfig } from '../../src/workflow/config-codec.js';
import {
  makeHarness,
  makeMockAdapter,
  type PanelHarness,
  waitFor,
} from './tools/panel-test-harness.js';

const cleanups: Array<() => void> = [];
const extra: ToolRequestExtra = { sendNotification: async () => undefined };

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  resetPolicyModuleCacheForTests();
});

function loaded(policy: CrewPolicy): () => Promise<ResolvedPolicy> {
  return async () => ({ kind: 'loaded', policy, source: 'test' });
}

const ctx: PolicyContext = { tool: 'run_agent', input: {}, repoRoot: '/repo', crewHome: '/crew' };

describe('policy config resolution', () => {
  let crewHome: string;

  beforeEach(() => {
    crewHome = mkdtempSync(join(tmpdir(), 'crew-policy-'));
    cleanups.push(() => rmSync(crewHome, { recursive: true, force: true }));
  });

  function writeRawConfig(value: unknown): void {
    writeFileSync(join(crewHome, 'config.json'), JSON.stringify(value));
  }

  function writeModule(name: string, source: string): string {
    const path = join(crewHome, name);
    writeFileSync(path, source);
    return path;
  }

  it('is none without a config file or without a policy key', async () => {
    expect(await resolveConfiguredPolicy(crewHome)).toEqual({ kind: 'none' });
    writeRawConfig({ confirmBeforeMerge: true });
    expect(await resolveConfiguredPolicy(crewHome)).toEqual({ kind: 'none' });
  });

  it.each([
    [{ policy: 'x' }, /must be an object/],
    [{ policy: {} }, /non-empty string/],
    [{ policy: { module: 'relative/policy.mjs' } }, /absolute path/],
  ])('fails closed on malformed policy config %j', async (config, reason) => {
    writeRawConfig(config);
    const resolved = await resolveConfiguredPolicy(crewHome);
    expect(resolved.kind).toBe('failed');
    expect((resolved as { reason: string }).reason).toMatch(reason);
  });

  it('fails closed when the module is missing or has the wrong shape', async () => {
    writeRawConfig({ policy: { module: join(crewHome, 'missing.mjs') } });
    expect((await resolveConfiguredPolicy(crewHome)).kind).toBe('failed');

    const bad = writeModule('bad.mjs', 'export default { beforeMerge: 42 };');
    writeRawConfig({ policy: { module: bad } });
    const resolved = await resolveConfiguredPolicy(crewHome);
    expect(resolved.kind).toBe('failed');
    expect((resolved as { reason: string }).reason).toContain('beforeMerge must be a function');
  });

  it('loads a policy object or factory from an absolute module path', async () => {
    const objectModule = writeModule(
      'object.mjs',
      'export default { beforeDispatch: () => ({ allow: false, code: "nope", message: "no" }) };',
    );
    writeRawConfig({ policy: { module: objectModule } });
    const fromObject = await resolveConfiguredPolicy(crewHome);
    expect(fromObject.kind).toBe('loaded');
    expect(await evaluatePolicy(fromObject, 'beforeDispatch', ctx)).toEqual({
      allow: false,
      message: 'policy_denied: run_agent refused by policy (nope): no',
    });

    const factoryModule = writeModule(
      'factory.mjs',
      'export default async () => ({ beforeMerge: () => ({ allow: true }) });',
    );
    writeRawConfig({ policy: { module: factoryModule } });
    const fromFactory = await resolveConfiguredPolicy(crewHome);
    expect(fromFactory.kind).toBe('loaded');
    expect(await evaluatePolicy(fromFactory, 'beforeMerge', ctx)).toEqual({ allow: true, warnings: [] });
  });
});

describe('policy evaluation', () => {
  it('allows everything when no policy is configured or the hook is not implemented', async () => {
    expect(await evaluatePolicy({ kind: 'none' }, 'beforeDispatch', ctx)).toEqual({ allow: true, warnings: [] });
    expect(await evaluatePolicy(await loaded({})(), 'beforeMerge', ctx)).toEqual({ allow: true, warnings: [] });
  });

  it('refuses when the configured policy failed to load', async () => {
    const out = await evaluatePolicy({ kind: 'failed', reason: 'boom' }, 'beforeDispatch', ctx);
    expect(out).toEqual({
      allow: false,
      message: 'policy_denied: run_agent refused by policy (policy_unavailable): boom',
    });
  });

  it('fails closed when a hook throws or returns a malformed decision', async () => {
    const throwing = await loaded({ beforeDispatch: () => { throw new Error('secret detail'); } })();
    const thrown = await evaluatePolicy(throwing, 'beforeDispatch', ctx);
    expect(thrown.allow).toBe(false);
    expect((thrown as { message: string }).message).toContain('(policy_error)');
    expect((thrown as { message: string }).message).not.toContain('secret detail');

    for (const decision of [undefined, { allow: 'yes' }, { allow: false, code: 'Bad Code!', message: 'x' }, { allow: true, warnings: [1] }]) {
      const out = await evaluatePolicy(
        await loaded({ beforeDispatch: () => decision as never })(),
        'beforeDispatch',
        ctx,
      );
      expect(out.allow).toBe(false);
      expect((out as { message: string }).message).toContain('malformed decision');
    }
  });

  it('prefixes policy warnings', async () => {
    const out = await evaluatePolicy(
      await loaded({ beforeDispatch: () => ({ allow: true, warnings: ['watch out'] }) })(),
      'beforeDispatch',
      ctx,
    );
    expect(out).toEqual({ allow: true, warnings: ['policy: watch out'] });
  });
});

function runAgentDeps(h: PanelHarness, resolvePolicy?: () => Promise<ResolvedPolicy>): ToolHandlerDeps {
  return {
    registry: h.ctx.registry as ToolHandlerDeps['registry'],
    worktreeManager: h.worktreeManager,
    runStateStore: h.runStateStore,
    dispatcher: h.dispatcher,
    crewHome: h.crewHome,
    projectRoot: h.root,
    getClientKind: () => 'codex',
    getCrewWaitCommand: () => undefined,
    progressTokenSeen: { presentLogged: false, absentLogged: false },
    readAgentPrefs: () => ({}),
    loadWorkflowConfig: () => getDefaultConfig(),
    ...(resolvePolicy ? { resolvePolicy } : {}),
  };
}

function runDirs(h: PanelHarness): string[] {
  const runsDir = join(h.crewHome, 'runs');
  return existsSync(runsDir) ? readdirSync(runsDir).filter((name) => !name.startsWith('.')) : [];
}

describe('run_agent beforeDispatch hook', () => {
  it('refuses before allocating a run or worktree and passes the canonical agent id', async () => {
    const h = makeHarness([makeMockAdapter({ name: 'reviewer', aliases: ['review-alias'] })]);
    cleanups.push(h.cleanup);
    const seen: PolicyContext[] = [];

    const out = await runAgentToolHandler(
      { agent_id: 'review-alias', prompt: 'implement' },
      extra,
      runAgentDeps(h, loaded({
        beforeDispatch: (c) => {
          seen.push(c);
          return { allow: false, code: 'role_not_active', message: 'task is not in IMPLEMENTATION' };
        },
      })),
    );

    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe(
      'policy_denied: run_agent refused by policy (role_not_active): task is not in IMPLEMENTATION',
    );
    expect(runDirs(h)).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0].tool).toBe('run_agent');
    expect((seen[0].input as { agent_id: string }).agent_id).toBe('reviewer');
  });

  it('dispatches normally when allowed and surfaces policy warnings in the envelope', async () => {
    const h = makeHarness([makeMockAdapter()]);
    cleanups.push(h.cleanup);

    const out = await runAgentToolHandler(
      { agent_id: 'mock', prompt: 'implement' },
      extra,
      runAgentDeps(h, loaded({ beforeDispatch: () => ({ allow: true, warnings: ['labels missing'] }) })),
    );

    expect(out.isError, out.content[0].text).not.toBe(true);
    expect(out.structuredContent?.warnings).toEqual(['policy: labels missing']);
    const runId = out.structuredContent?.run_id as string;
    await waitFor(() => h.runStateStore.read(runId)?.status === 'success');
  });
});

async function seedTerminalRun(h: PanelHarness, runId: string): Promise<void> {
  const worktreePath = await h.worktreeManager.createRunWorktree(runId);
  await h.runStateStore.create({ runId, agentId: 'mock', worktreePath, initialPrompt: 'initial' });
  await h.runStateStore.markTerminal(runId, { status: 'success', summary: 'done', filesChanged: [] });
}

function mergeDeps(h: PanelHarness, resolvePolicy: () => Promise<ResolvedPolicy>): Pick<
  ToolHandlerDeps,
  'crewHome' | 'runStateStore' | 'worktreeManager' | 'dispatcher' | 'resolvePolicy'
> {
  return {
    crewHome: h.crewHome,
    runStateStore: h.runStateStore,
    worktreeManager: h.worktreeManager,
    dispatcher: h.dispatcher,
    resolvePolicy,
  };
}

describe('merge_run beforeMerge hook', () => {
  it('refuses before merging, even with confirmed:true, and sees the run state', async () => {
    const h = makeHarness([makeMockAdapter()]);
    cleanups.push(h.cleanup);
    writeConfigFile(h.crewHome, { ...DEFAULT_CONFIG, confirmBeforeMerge: true });
    await seedTerminalRun(h, 'guarded-run');
    const seen: PolicyContext[] = [];

    const out = await mergeRunToolHandler(
      { run_id: 'guarded-run', confirmed: true, merge_strategy: 'preserve' },
      mergeDeps(h, loaded({
        beforeMerge: (c) => {
          seen.push(c);
          return { allow: false, code: 'approval_missing', message: 'no human merge approval' };
        },
      })),
    );

    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe(
      'policy_denied: merge_run refused by policy (approval_missing): no human merge approval',
    );
    expect(h.runStateStore.read('guarded-run')?.status).toBe('success');
    expect(seen[0].runState?.runId).toBe('guarded-run');
  });

  it('fails closed when the configured policy is unavailable', async () => {
    const h = makeHarness([makeMockAdapter()]);
    cleanups.push(h.cleanup);
    await seedTerminalRun(h, 'unguarded-run');

    const out = await mergeRunToolHandler(
      { run_id: 'unguarded-run', confirmed: true, merge_strategy: 'preserve' },
      mergeDeps(h, async () => ({ kind: 'failed', reason: 'module missing' })),
    );

    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('(policy_unavailable): module missing');
    expect(h.runStateStore.read('unguarded-run')?.status).toBe('success');
  });

  it('merges when allowed and appends policy warnings', async () => {
    const h = makeHarness([makeMockAdapter()]);
    cleanups.push(h.cleanup);
    await seedTerminalRun(h, 'allowed-run');

    const out = await mergeRunToolHandler(
      { run_id: 'allowed-run', confirmed: true, merge_strategy: 'preserve' },
      mergeDeps(h, loaded({ beforeMerge: () => ({ allow: true, warnings: ['audit only'] }) })),
    );

    expect(out.isError, out.content[0].text).not.toBe(true);
    expect(out.structuredContent?.status).toBe('no-changes');
    expect(out.structuredContent?.warnings).toEqual(['policy: audit only']);
  });
});
