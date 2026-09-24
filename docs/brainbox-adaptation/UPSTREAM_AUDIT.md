# BrainBox Crew — Upstream Audit of crew-mcp

**Audited revision:** `eldmark/crew-mcp` @ `9b1eb28` (identical to `upstream/main`: 0 commits ahead/behind), package `crew-mcp` **0.20.0**, 567 commits, MIT.
**Date:** 2026-09-23 · **Author:** architect (Claude) · **Status:** for human review — no code was changed.
**Method:** read every tracked doc (`README.md`, `AGENTS.md`, `docs/architecture/*`, `docs/guides/*`), the captain skills (`skills/*.md`), and the load-bearing source (`src/adapters/types.ts`, `src/orchestrator/{run-mode,run-state,receipts,untrusted-provenance}.ts`, `src/orchestrator/tools/{run-agent,merge-run,discard-run,confirm-criteria,dispatch-policy,dispatch-preflight,lifecycle-guards}.ts`, `src/orchestrator/auth/*`, `src/adapters/{claude-code,codex,agy,registry}.ts`, `src/agent-prefs/store.ts`, `src/workflow/types.ts`, `src/install/hosts/claude-code.ts`, `src/git/worktree.ts`). Claims below cite files; line numbers are for `9b1eb28`.

---

## 0. The one thing to understand first

crew-mcp has **two kinds of authority**, and BrainBox's requirements depend on telling them apart:

| Kind | Where it lives | Can the LLM forge it? |
|---|---|---|
| **Server-enforced** | TypeScript in `crew-mcp serve` (run modes, merge eligibility, worktree isolation, worker token scoping, busy-worktree guards, exact-or-refuse model pins, iterate round backstop) | **No** — a tool call either satisfies the check or is refused. |
| **Captain-asserted ("journaled captain claims")** | Booleans the *captain LLM* passes: `confirmed`, `dispatch_anyway`, `same_host_ok`, `ban_override`, `cap_override`, `user_requested_wait` (`skills/crew-captain.body.md` §"Server override vocabulary") | **Yes.** The server journals the claim but cannot verify a human said "yes". The rule "never auto-pass `confirmed:true`" is **prose**. |

Upstream's own vocabulary is honest about this: overrides are *"journaled captain claims"*. The captain is the host CLI's model (Claude Code / Codex / agy) following `skills/crew-captain.body.md` / `crew-iterate.body.md` — **the workflow itself (criteria → implement → review → merge) is orchestrated by prose**, with the server enforcing only lifecycle invariants.

BrainBox requires *"deterministic orchestration policy controls authority"* and *"human remains root of trust"*. That is the central gap (§5, §9, GAP_ANALYSIS G-01..G-04).

---

## 1. How crew-mcp represents each concept

### 1.1 Captain
- The **host CLI** (Claude Code, Codex, or agy) talking to the user. Not a process Crew owns.
- Behaviour comes from rendered skills: `skills/crew-captain.body.md` (973 lines), `crew-iterate.body.md` (994), `crew-pr-watch.*`. Rendered per host by `src/install/skill-renderer.ts`.
- Surface: 26 captain MCP tools registered in `src/cli/commands/serve.ts`, mirrored in `src/install/tool-catalog.ts` (parity test `test/install/tool-catalog.test.ts`).

### 1.2 Workers / agents
- An **agent** = an adapter id (`claude-code`, `codex`, `agy`) or a custom agent from `~/.crew/agents.json` (`adapter: openai-compatible | generic`) — `src/adapters/registry.ts:440-510` (`mergeCustomAgents`).
- `AgentAdapter` (`src/adapters/types.ts:~115-260`) declares capability flags: `enforcesReadOnly`, `rejectsReadOnly`, `reviewDispatchMode` (`read-only-dispatch | ephemeral-worktree | unsupported`), `requiresCrewWorktree`, `unmetered`, `supportsResume`, `goalSupport`, `modelSelectionSupport`, `strengths`/`useWhen` (**advisory prose, "NOT enforced anywhere"**).
- Workers get a **worker-scoped MCP server** exposing only `send_message`, authenticated by a per-run `CREW_RUN_ID` + `CREW_RUN_TOKEN` sidecar (`src/orchestrator/auth/token.ts`, `serve.ts:1514-1520`). This separation is **server-enforced**.

### 1.3 Providers / models
- Provider = adapter; model is an **orthogonal per-turn selection**, exact-or-refuse (`src/adapters/model-selection.ts`, `docs/architecture/adapters.md`). Precedence: per-call → saved provider default (`agents.json`) → provider CLI default.
- `ModelSelectionRecord` (requested / argument / validation / inherited / **observed**) persisted per prompt turn.

### 1.4 Runs & lifecycle
- `RunStateV1` (`src/orchestrator/run-state.ts:123-202`) in `<crewHome>/runs/<runId>/state.json` (atomic writes) + append-only `events.log`; terminal receipts `run.json` + `summary.md` (`src/orchestrator/receipts.ts`).
- `RunStatus`: `running | success | partial | error | cancelled | merged | merge_conflict | discarded`.
- `RunMode` (`src/orchestrator/run-mode.ts`): `write` (owns worktree, mergeable) · `read_only` (in place, never mergeable) · `ephemeral_review` (owns disposable worktree, never mergeable).
- Async dispatch + `crew-wait` watcher; stale-run sweeper keyed on `serverPid`; run GC (`run-gc.ts`).

### 1.5 Criteria
- Criteria sets (`create/confirm/get/revise_criteria`, `src/orchestrator/criteria/`) with types `[M]` mechanical, `[B]` behavioral, `[N]` negative, epochs, and review-round state.
- Dispatch refuses an **unconfirmed** `criteria_set_id` (server-enforced) — but **who** confirms is the captain (`confirm_criteria` is a plain captain tool; no human proof).

### 1.6 Permissions
- Per-dispatch `Task.constraints` (`types.ts:367-452`): `sandbox` (`read-only | workspace-write | danger-full-access`), `networkAccess`, `writablePaths` (git internals of the run worktree only), `reviewIntent`.
- **Enforcement is adapter-dependent** (verified in source):

| Adapter | Write isolation | Read-only enforcement | Flags |
|---|---|---|---|
| Codex | worktree | **OS sandbox** (`--sandbox read-only`) | `codex.ts:568-600` |
| Claude Code | worktree | **Advisory** prompt + post-run dirty-tree probe; always `--dangerously-skip-permissions` | `claude-code.ts:1051` |
| agy | worktree | **Cannot** (`rejectsReadOnly`); reviews forced to `ephemeral_review` snapshot; always `--dangerously-skip-permissions` | `agy.ts:631-635` |
| openai-compatible | n/a | Inherent: **no repo/filesystem access at all** (chat only) | `openai-compatible.ts` |
| generic | command-dependent | command-dependent | `generic.ts` |

- `networkAccess: true` is **always** passed (`run-agent.ts:831`).
- There is **no path-level policy inside a worktree** (no allowed/forbidden globs).
- Host-level: the installer auto-approves **all** Crew tools with `mcp__crew__*` in Claude Code (`src/install/hosts/claude-code.ts:13-15, 105-111`); Codex gets per-tool approval blocks in TOML; agy has **no approval switch** (`captain-portability.md`).
- Dispatch policy (`dispatch-policy.ts`, `dispatch-preflight.ts`): ban lists, same-host rule, health/quota — each overridable by a captain claim.

### 1.7 Worktrees
- `WorktreeManager` (`src/git/worktree.ts`, 2,296 lines): per-run worktree `~/.crew/runs/<id>/worktree` on branch `crew-run/*`, records **`branchPointSha`** (base commit, `worktree.ts:43,265`), syncs dirty host state without mutating the host checkout, ephemeral snapshots for reviews.

### 1.8 Merge / discard
- Only `merge_run` / `discard_run` cross the mutation boundary (`merge-run.ts`, `discard-run.ts`). Squash (default, requires captain-written title) or preserve. Refuses dirty host, unresolved conflicts, non-mergeable modes, busy worktrees.
- `confirmBeforeMerge` (default on, `CREW_CONFIRM_BEFORE_MERGE`) → server requires `confirmed:true` — a **captain claim**.

### 1.9 Panels
- `run_panel` dispatches parallel reviewers with independent agent/model identity; routing per `reviewDispatchMode`; `aggregate_panel` turns terminal results into peer messages labelled per agent/model. Host-native reviewer (not a Crew run) joins via prose, with a Codex `SubagentStop` hook bridge.

### 1.10 Continuation / resume
- `continue_run` adds a turn to the same worktree, inheriting model decision, with goal policy; provider session resume for stateful adapters (`resumeSessionId`). Durable state + `list_runs` recover after context loss; watchers use generation tokens.

### 1.11 Persistence / state
- `~/.crew/` (or `CREW_HOME`): `runs/`, criteria store, `agents.json`, `config.json`, `workflow.yaml` (compat), `pr-watches/` (digest-chained ledgers). Project `.crew/`.

### 1.12 A precedent worth reusing: PR-watch authorization
`src/pr-watch/` is the most "BrainBox-like" subsystem upstream: **default-deny**, a separate `authorize_pr_watch_actions` grant bound to generation/hashes/budgets/expiry, digest-chained `events.jsonl` ledger as authority, journaled effect phases, structurally unavailable dangerous effects. Its grant is still captain-asserted (`confirmed:true`), but its **ledger + compare-and-set + bounded-grant pattern** is exactly what a deterministic BrainBox workflow needs.

### 1.13 Roles upstream (historical)
v0.1 had a workflow DSL with `steps`, `roleModels`, `captain.*`, presets — **pruned 2026-07-07** because nothing consumed it (`src/workflow/types.ts` comment; `config-registry.md`: *"role-model surfaces are not supported"*). `AgentStrength` likewise replaced a dead `capabilities` enum. **Upstream deliberately moved away from roles-in-core.** Re-adding them to core would fight upstream's direction.

---

## 2. Answers to the assignment's questions

**1. Capabilities that already exist unchanged**
Isolated write worktrees with base commit (`branchPointSha`); non-mergeable review modes; merge/discard as the only mutation boundary; workers cannot call captain tools (token-scoped MCP) → **an implementer worker cannot merge its own work**; criteria contract with `[M]/[B]/[N]` and epochs; parallel independent reviewers (panels) with per-model identity; iterate loop with round caps; durable resumable run state; provider/model audit per turn (requested/argument/observed); receipts; untrusted-content labelling of worker output (`untrusted-provenance.ts`); exact-or-refuse model pins; GC/cleanup; local model workers (Ollama/LM Studio/OpenAI-compatible).

**2. Implementable through configuration**
Role→provider/model mapping *as a convention* (`agents.json` defaults + per-call `model`/`effort`); local Secretary as an `openai-compatible` custom agent; panel/iterate reviewer defaults and ban lists (`workflow.agentDefaults.*`); `confirmBeforeMerge`; **host-level human gates** by removing `mcp__crew__merge_run`/`discard_run`/`confirm_criteria` from the Claude Code auto-allow list (the host then prompts the human — enforced by the host, not the model); retention/TTL.

**3. Require plugins/extensions**
Role registry as data; deterministic task workflow state machine; policy evaluation (role permissions, transitions, gates); structured findings with severities and BLOCKER semantics; path policy (allowed/forbidden globs, frozen-file hashes); task-level provenance ledger; DECISION REQUIRED rendering; BrainBox captain skill. crew-mcp has **no plugin API** today, so these need one small core seam (Q4).

**4. Require small upstream modifications (generic, upstreamable)**
(a) a **policy hook** interface called before `run_agent` / `continue_run` / `run_panel` / `merge_run` / `discard_run` / `confirm_criteria`; (b) **opaque run labels** (`labels: {task_id, role}`) persisted in `RunStateV1` and receipts; (c) allow **`ephemeral_review` for any adapter** on request (today only `ephemeral-worktree` adapters, `run-agent.ts:153`); (d) a **worker environment allow-list** (today `codexSafeSpawnEnvironment()` in `src/codex/environment.ts` passes the whole environment minus three Crew captain variables, so other secrets reach every worker; it is already the single choke point for all adapters); (e) optional **Claude read-only hardening** via tool denial for `read_only`/review dispatches; (f) an installer option to **not auto-approve** gate tools; (g) a way for an extension to **register extra MCP tools** (today `serve.ts` hard-codes registrations and the catalog parity test pins the list).

**5. Would require invasive core changes (avoid)**
Making the captain deterministic (replacing prose orchestration with a server-driven engine); true OS-level read-only for Claude Code/agy (provider limitation); per-path write enforcement *during* execution for adapters without a sandbox; cryptographic human identity. None are needed for a minimal adaptation (see ARCHITECTURE_PROPOSAL §5–§9).

**6. Representation** — §1 above.

**7. Where should BrainBox roles live?**
In a **fork-owned extension** (`src/brainbox/**` + data files), **not** in adapters and **not** in upstream core (upstream pruned `roleModels`). A role is data: `role → {agent_id, model?, effort?, run_mode, capabilities, path policy defaults, prompt template}`, consumed by the BrainBox policy + skill.

**8. Can roles be data rather than subclasses?** **Yes.** Nothing in dispatch needs a role type: a role resolves to existing `run_agent` parameters (`agent_id`, `model`, `effort`, `run_mode`, `criteria_set_id`, prompt). ROLE ≠ MODEL falls out naturally: swapping `implementer: gemini → codex` is a data edit.

**9. How to add deterministic workflow transitions?**
A task ledger (digest-chained JSONL, same pattern as PR-watch) + a static transition table with guard functions; agents/captain **request** transitions through a BrainBox tool; the policy grants or refuses. Dispatch/merge policy hooks refuse any Crew action that does not match the task's current state (e.g. a `write` dispatch outside `IMPLEMENTATION`, a merge outside `HUMAN_APPROVAL→DONE`).

**10. Enforce role permissions independently from prompts?**
Three server-side layers, none relying on the prompt: (i) **dispatch policy hook** — role determines allowed `run_mode`, adapter, and whether `write` is possible; (ii) **run-mode containment** — non-writing roles only ever get `read_only` (Codex OS sandbox) or `ephemeral_review` (disposable, non-mergeable snapshot) or `openai-compatible` (no filesystem); (iii) **merge-time diff policy** — the diff between `branchPointSha` and the run head must stay within `allowed_paths`, outside `forbidden_paths`, and leave frozen-file hashes unchanged, otherwise merge is refused. Layer (iii) is adapter-independent and covers adapters that cannot sandbox.

**11. Secretary on a local provider?** Yes, as an `openai-compatible` custom agent (`crew-mcp agents add --provider openai-compatible --api-base …`). It is text-only, which *fits* the Secretary (input = user's raw notes). **BrainBox caveat:** pointing it straight at BrainBox's `llama-server` would bypass the Brain API and its GPU residency policy (BrainBox principle §1, ADR-018); see ARCHITECTURE_PROPOSAL §4 and questions.

**12. Researcher with web capability, safely?** Use a provider's native web tools (Claude Code / Codex) in a **non-mergeable** mode (`ephemeral_review`, or `read_only` on Codex), with (d) env allow-list so no secrets are reachable, output labelled UNTRUSTED (existing), no repo write path, research stored as an artifact. Web content is a prompt-injection vector: the Researcher's output is advisory input to the Architect, never an instruction to the policy.

**13. Technically constraining read-only roles?** Codex: OS sandbox (existing). Claude Code: prefer `ephemeral_review` snapshots (needs change (c)), optionally plus tool denial (e); agy: `ephemeral_review` (existing). openai-compatible: inherently read-only. For *any* adapter, the non-mergeable run modes guarantee a reviewer's edits can never reach the target branch, and running reviewers on **snapshots** (not the implementer's worktree) guarantees they cannot alter the implementation under review.

**14. Security BLOCKER stopping transitions?** Findings are persisted as structured artifacts **parsed from the reviewer run's own terminal output** (not from captain prose). Transition guards (`FINAL_SECURITY → HUMAN_APPROVAL`, and the merge policy hook) refuse while any BLOCKER is `open`; a BLOCKER closes only by a verified fix (re-review) or a **human-gated waiver** record.

**15. Provenance upstream already persists**
Per run: `runId`, `agentId` (provider), `runMode`, `repoRoot`, `worktreePath`, `branchPointSha` (worktree registry), per-turn `prompt`, `peer_messages_input`, criteria linkage (`criteriaSetId`, `criteriaEpoch`, `criteriaContract`), `modelSelection` (requested/argument/observed), `goal`, timestamps, `summary`, `filesChanged`, `sessionId`, `failure`, `warnings`, `mergeStatus` (`target`, `commitSha`, conflicts), `serverPid`; `events.log`; receipts `run.json`/`summary.md`; captain override claims journaled; panel records per reviewer.

**16. Provenance missing**
`task_id`, `role`, stable `agent_run_id` distinct from Crew's run id (Crew's `runId` can serve), input context refs, artifact refs, test-result refs, review refs, **result commit before merge** (only `mergeStatus.commitSha` after merge), human approval records with approver/channel, and a **separation of audit metadata from artifacts**: today `state.json` stores full prompts next to lifecycle metadata (fine as an artifact, not as a security audit log).

**17. Can upstream updates still be merged cleanly?**
Yes, **if** the fork keeps (a) all BrainBox logic in new files (`src/brainbox/**`, `skills/crew-brainbox*.md`, `docs/brainbox-adaptation/**`) and (b) the core diff to a handful of small, generic seams (policy hook call sites, labels, ephemeral-for-any, env allow-list, tool-registration seam). Risk factors: upstream churn is high (v0.20, "not backward compatible" per `AGENTS.md`), `serve.ts` and `run-agent.ts` are hot files, and the tool-catalog parity test pins the tool list. Mitigation: propose the generic seams upstream (they are useful beyond BrainBox) so the long-term core diff trends to zero.

**18. Upstream concepts that must NOT be duplicated**
Run lifecycle/state and receipts; worktree manager and snapshots; merge/discard; criteria (reuse them as the Architect's acceptance criteria); panels (reuse for Reviewer + Security Reviewer); iterate loop and round caps; model selection/audit; worker auth + `send_message`; watchers/wakes; GC; untrusted-content labelling; agent registry/preferences; PR-watch ledger pattern (reuse the *pattern*, not the watch).

---

## 3. Notable risks discovered (independent of BrainBox)

| # | Finding | Evidence | Relevance |
|---|---|---|---|
| R1 | Human consent for merge/discard/criteria is a captain-passed boolean | `merge-run.ts:70-75`, skill "Server override vocabulary" | Violates "human root of trust" unless a host-level gate is added |
| R2 | Claude Code and agy workers always run with `--dangerously-skip-permissions`, even for reviews | `claude-code.ts:1051`, `agy.ts:635` | A "read-only" Claude reviewer can write wherever the OS user can |
| R3 | Workers inherit the server's environment minus a 3-variable deny-list | every worker spawn uses `codexSafeSpawnEnvironment()` (`src/codex/environment.ts`: `extendEnv:false`, `env = process.env` minus Crew's own Codex captain-capability vars) | Any other secret in the captain's environment (API keys, DB URLs, cloud creds) reaches every worker, including a web-connected Researcher. That single function is a ready-made seam for an allow-list |
| R4 | `networkAccess: true` for every dispatch | `run-agent.ts:831` | Egress is always available to workers |
| R5 | `apiKey` for OpenAI-compatible agents stored in plain text in `agents.json` | `agent-prefs/store.ts:~93` | BrainBox rule: secrets never in config files |
| R6 | Claude Code captain auto-approves all Crew tools (`mcp__crew__*`) | `install/hosts/claude-code.ts` | Removes the one out-of-model human gate the host could provide |
| R7 | Tracked-docs allowlist: `docs/brainbox-adaptation/` is git-ignored by `.gitignore:6` | `.gitignore` | These deliverables are invisible to git until an allowlist line is added |
