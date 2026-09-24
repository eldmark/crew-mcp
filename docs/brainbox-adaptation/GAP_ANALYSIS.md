# BrainBox Crew — Gap Analysis

**Base:** `crew-mcp` 0.20.0 @ `9b1eb28` · **Date:** 2026-09-23 · Companion to `UPSTREAM_AUDIT.md`.

Solution tiers, in order of preference:
**CFG** configuration → **EXT** extension/plugin (new fork-owned files) → **ADP** adapter-level change → **CORE-S** small, generic core patch (upstreamable) → **FORK** fork-specific subsystem.

"Core modification required?" = does any **existing upstream file** change. Priority: **P0** needed for the PoC · **P1** needed before real use · **P2** later.

## 1. Roles and providers

| ID | Requirement | Existing upstream capability | Gap | Proposed solution | Core mod? | Risk | Priority |
|---|---|---|---|---|---|---|---|
| G-10 | ROLE ≠ MODEL; role → capabilities → provider | Agent adapters + orthogonal exact-or-refuse model selection; `agents.json` defaults; `useWhen`/`strengths` advisory | No role concept (upstream pruned `roleModels` in v0.1) | **EXT**: `brainbox/roles.yaml` (data) mapping role → `{agent_id, model?, effort?, run_mode, capabilities, path defaults, prompt template}`; validated at load; resolves to ordinary `run_agent` params | no | Low | P0 |
| G-11 | Swap provider per role without changing workflow | Per-call `agent_id`/`model` | Nothing binds a workflow step to "whoever occupies the role" | **EXT**: workflow refers to roles only; policy resolves role → agent at dispatch time | no | Low | P0 |
| G-12 | Secretary on a small local model | `openai-compatible` custom agents (Ollama / LM Studio / any `/v1`); text-only | None functionally; **BrainBox constraint**: must not bypass Brain API GPU residency | **CFG**: register a local `openai-compatible` agent. Endpoint choice is a human decision (§Q2 of proposal) | no | Medium (GPU contention if pointed at BrainBox llama-server) | P0 |
| G-13 | Secretary must not promote idea → decision | None (prompt-level only) | No structural guard | **EXT**: Secretary output schema with explicit `status` per item (`idea/unresolved/decision/constraint`) + policy check: an item may be `decision` only if `source_refs` point to a human-authored statement; otherwise downgraded + flagged. Evaluated against the BrainBox semantic fixtures | no | Medium (LLM compliance) | P1 |
| G-14 | Researcher with web access, advisory only | Provider-native web tools (Claude/Codex); `UNTRUSTED worker content` labelling | No safe preset; env leaks (G-41) | **EXT** role preset (`run_mode: ephemeral_review` or Codex `read_only`) + **CORE-S** env allow-list (G-41) | yes (via G-41) | Medium (prompt injection from web) | P1 |

## 2. Authority, policy and workflow

| ID | Requirement | Existing upstream capability | Gap | Proposed solution | Core mod? | Risk | Priority |
|---|---|---|---|---|---|---|---|
| G-01 | Deterministic policy controls authority | Server-enforced lifecycle invariants; everything else captain prose | Workflow orchestration is prose; overrides are captain-asserted booleans | **CORE-S** generic **policy hook** (`CrewPolicy`: `beforeDispatch/beforeContinue/beforePanel/beforeMerge/beforeDiscard/beforeCriteriaConfirm`, default allow-all) + **EXT** BrainBox policy implementing it | yes (≈6 call sites + 1 interface + config key) | Medium (hot files `run-agent.ts`, `merge-run.ts`) | P0 |
| G-02 | Workflow state machine with validated transitions | Criteria epochs + iterate round state (prose-driven) | No task state machine | **FORK** task ledger (digest-chained JSONL, PR-watch pattern) + static transition table + guards | no (new files) | Low | P0 |
| G-03 | Agents request transitions; they don't grant them | n/a | n/a | **EXT** tool `bb_request_transition` evaluated by policy; human gates require G-04 | no* | Low | P0 |
| G-04 | Human is root of trust (approval gates cannot be forged by a model) | `confirmed:true` (captain claim); host permission prompts exist but installer auto-approves `mcp__crew__*` | Approval is model-asserted | **CFG** host gate: exclude gate tools (`merge_run`, `discard_run`, `confirm_criteria`, `bb_approve`) from auto-allow so **the host** asks the human; **EXT** optional out-of-band `crew-brainbox approve` CLI that requires an interactive TTY (a model's shell tool has none). Approval records store channel + nonce | no (CFG) / optional CORE-S installer flag | Medium: host in bypass mode defeats host gates; documented | P0 |
| G-05 | No LLM majority vote; DECISION REQUIRED on disagreement | Panels aggregate labelled findings; captain consolidates | No structured disagreement stop | **EXT** policy: conflicting positions (Architect vs Researcher vs Security vs Reviewer) → task enters `DECISION_REQUIRED`; renderer produces the required template; only `bb_approve` exits | no | Low | P1 |
| G-06 | Architect cannot implement its own architecture | n/a | No role/run linkage | **EXT** policy: role `architect` may only dispatch `read_only`/`ephemeral_review`/text agents; its output is a task **artifact** (task store), never a repo write; promoting architecture docs into `docs/**` requires a separate, human-approved write task | no | Low | P1 |
| G-07 | Frozen plan/contracts cannot be modified by implementer | Criteria confirmed/epochs | No file-level freeze | **EXT** at `PLAN_FROZEN`: record `frozen_paths` + SHA-256; **merge-time diff policy** refuses changes to frozen/forbidden paths | yes (via G-01 merge hook) | Low | P0 |
| G-08 | Agent cannot approve its own implementation | Reviewers are separate runs; panel independence | Nothing forbids the same provider/model reviewing its own work | **EXT** policy `independence` rule (default: reviewer run ≠ implementer run AND different `agent_id` or model; configurable) | no | Low | P1 |
| G-09 | Implementer cannot merge its own work | Workers only get `send_message` (token-scoped MCP) — **already true** | — | Reuse; add a test in PoC | no | — | P0 (verify only) |

## 3. Isolation and permissions

| ID | Requirement | Existing upstream capability | Gap | Proposed solution | Core mod? | Risk | Priority |
|---|---|---|---|---|---|---|---|
| G-20 | Code-writing roles in isolated worktrees | Write runs own a worktree + `crew-run/*` branch + `branchPointSha` | — | Reuse | no | — | P0 |
| G-21 | `allowed_paths` / `forbidden_paths` per task | None (only git-internal `writablePaths` for Codex) | No path policy | **EXT** diff-based check at merge (and advisory check at each terminal turn) using `branchPointSha..HEAD` + uncommitted changes; globs from task | yes (via G-01 hooks) | Low | P0 |
| G-22 | Read-only roles technically constrained | Codex OS sandbox; agy forced to `ephemeral_review`; Claude advisory + dirty-tree probe; openai-compatible has no FS | Claude reviewers can write (skip-permissions) and `ephemeral_review` is limited to `ephemeral-worktree` adapters | **CORE-S** allow `run_mode:'ephemeral_review'` for any adapter on explicit request; **EXT** role presets force reviewers onto snapshots of the implementer's worktree; **ADP** optional Claude tool denial for review dispatches | yes (small) | Low | P0 |
| G-23 | Reviewer cannot modify implementation | Panels can snapshot a source worktree for ephemeral reviewers | In-place `read_only` Claude reviewer pointed at the implementer worktree could edit it | Policy: reviewers of a task must use `ephemeral_review` snapshots (never the implementer's worktree in place) | yes (via G-22) | Low | P0 |
| G-24 | Tester runs tests without modifying production code | `[M]` criteria re-run by the captain in the worktree | Tester as a separate role/run | **EXT** tester = `ephemeral_review` snapshot run executing the frozen test commands; results parsed into a test artifact; its file changes are discarded by construction | yes (via G-22) | Low | P0 |
| G-25 | No direct merge into protected branch | `merge_run` targets a branch; captain-invoked | No protected-branch list | **EXT** merge hook: target branch allow-list per task (e.g. only `main` via approved task) + human gate | yes (via G-01) | Low | P1 |
| G-26 | Deny by default | Dispatch allowed unless banned/unhealthy | Allow-by-default for dispatch | **EXT** BrainBox policy denies any dispatch not attributable to a task+role in a state that permits it (only when the BrainBox policy is enabled — upstream default unchanged) | yes (via G-01) | Medium (usability) | P0 |

## 4. Findings, security and review

| ID | Requirement | Existing upstream capability | Gap | Proposed solution | Core mod? | Risk | Priority |
|---|---|---|---|---|---|---|---|
| G-30 | Reviewer is read-only and reports findings as artifacts | Panel results → labelled peer messages; iterate PASS/FAIL per criterion | No persistent structured findings store | **EXT** findings artifact schema (`id, severity, category, file:line, evidence, status`) parsed from the reviewer run's terminal output (JSON block), stored per task | no | Medium (output-format compliance → mitigate with JSON-schema adapters / parse-or-reject) | P0 |
| G-31 | Security severities BLOCKER/HIGH/MEDIUM/LOW/INFO; BLOCKER vetoes | Iterate `BLOCKING` verdict pauses loop (prose) | No veto semantics | **EXT** guard: `FINAL_SECURITY → HUMAN_APPROVAL` and merge hook refuse with open BLOCKER; closing requires re-review evidence or human waiver record | yes (via G-01) | Low | P0 |
| G-32 | Security review before freeze and before merge | Panels | No workflow slots | **FORK** states `SECURITY_REVIEW` and `FINAL_SECURITY` in the state machine | no | Low | P0 |
| G-33 | Findings must not come from captain prose | `untrusted-provenance` labelling | Captain summarises reviewer output | Findings extracted **by the server** from run artifacts (`state.json` prompts/summary, receipts), never from a captain-supplied summary | no | Medium | P0 |

## 5. Provenance, audit and secrets

| ID | Requirement | Existing upstream capability | Gap | Proposed solution | Core mod? | Risk | Priority |
|---|---|---|---|---|---|---|---|
| G-40 | task_id / role / agent_run_id on every run | runId, agentId, modelSelection, timestamps, receipts | No task/role linkage | **CORE-S** opaque `labels` map on `run_agent`/`run_panel`/`continue_run`, persisted in `RunStateV1` + `run.json` (additive, schema v1 compatible) | yes (small, additive) | Low | P0 |
| G-41 | Secrets never reach prompts/logs/artifacts | Deny-list removes Crew captain vars only | Other env secrets reach workers | **CORE-S** configurable worker env allow-list in `codexSafeSpawnEnvironment()` (single choke point) | yes (one function + config) | Low | P0 |
| G-42 | Separate audit metadata from artifacts | `state.json` mixes lifecycle metadata with full prompts | No metadata-only audit log | **FORK** `brainbox/audit.jsonl` (digest-chained, metadata only: ids, role, provider, model, commits, refs, decisions) distinct from artifacts (run dirs, task artifacts) with separate retention | no | Low | P1 |
| G-43 | base_commit / result_commit / test & review refs | `branchPointSha` (worktree), `mergeStatus.commitSha` | Result commit before merge, test/review refs | **EXT** record run head SHA at each terminal turn (read via git in the worktree) + refs to test/finding artifacts in the task ledger | no | Low | P1 |
| G-44 | API keys not stored in plain config | `apiKey` field in `agents.json` | Plaintext secret | **CFG** use keyless local endpoints; **CORE-S** (later) `apiKeyEnv` indirection | no / later | Low | P2 |

## 6. Operations

| ID | Requirement | Existing upstream capability | Gap | Proposed solution | Core mod? | Risk | Priority |
|---|---|---|---|---|---|---|---|
| G-50 | Resume after interruption | Durable run state, `list_runs`, watchers, `continue_run` | Task-level resume | **FORK** task ledger replay (pure read) + `bb_task_status` returns next allowed actions | no | Low | P0 |
| G-51 | Worktree discard cleanly | `discard_run`, GC | — | Reuse | no | — | P0 |
| G-52 | Upstream mergeability | — | — | Keep BrainBox in new files; ≤ 6 small generic seams; propose seams upstream | yes (seams) | Medium (upstream churn) | P0 |
| G-53 | BrainBox tools registered alongside Crew tools | `serve.ts` hard-codes registrations; catalog parity test pins list | No registration seam | **CORE-S** tool-registration seam (`registerExtensionTools(server, deps)` + catalog extension list) **or** ship BrainBox tools as a **separate MCP server** (zero core change; weaker because Crew tools stay callable directly → still needs G-01 hooks for enforcement) | yes (small) / no | Medium | P0 |
| G-54 | Captain playbook for BrainBox roles | `skills/*.body.md` + renderer | No BrainBox skill | **EXT** `skills/crew-brainbox.body.md` rendered by the existing renderer (prose drives UX; policy enforces) | minimal (renderer list) | Low | P0 |
| G-55 | agy as captain | agy has no approval switch | Host gates impossible | **CFG** decision: BrainBox captain must be Claude Code or Codex | no | — | P0 |

`*` G-03 requires the tool-registration seam (G-53) or a separate MCP server.

## 7. Summary of core touchpoints (all small, generic, upstreamable)

| Seam | Files touched | Default behaviour | Why upstream might accept it |
|---|---|---|---|
| S1 Policy hook (G-01) | new `src/orchestrator/policy.ts`; call sites in `run-agent.ts`, `continue-run.ts`, `run-panel.ts`, `merge-run.ts`, `discard-run.ts`, `confirm-criteria.ts`; config key | allow-all | Teams want org policy without forking |
| S2 Run labels (G-40) | `run-agent.ts`, `run-panel.ts`, `continue-run.ts` schemas; `run-state.ts`; `receipts.ts` | absent | Generic attribution/CI linkage |
| S3 Ephemeral review for any adapter (G-22) | `run-agent.ts` mode check | unchanged unless requested | Safer reviews for Claude |
| S4 Worker env allow-list (G-41) | `src/codex/environment.ts`, config | current deny-list | Security hardening |
| S5 Extension tool registration (G-53) | `serve.ts`, `tool-catalog.ts` | none | Enables plugins generally |
| S6 (optional) Installer "ask" gates (G-04) | `install/hosts/claude-code.ts`, `codex.ts` | current auto-approve | Stronger consent posture |
