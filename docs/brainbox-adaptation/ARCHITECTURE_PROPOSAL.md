# BrainBox Crew — Architecture Proposal

**Base:** `crew-mcp` 0.20.0 @ `9b1eb28` · **Date:** 2026-09-23 · **Status:** PROPOSAL — human decisions recorded (§0); awaiting approval to start the PoC. Nothing here is implemented.
Companions: `UPSTREAM_AUDIT.md`, `GAP_ANALYSIS.md`, `IMPLEMENTATION_PLAN.md`.

Legend used throughout: **[UPSTREAM]** reused as-is · **[EXTENSION]** small generic seam in core, upstreamable · **[BRAINBOX]** fork-owned files only.

---

## 0. Human decisions (2026-09-23)

| # | Question | Decision | Effect on this proposal |
|---|---|---|---|
| Q1 | Approval channel | **Host permission + TTY** | §10 channel 1 for routine gates; channel 2 (TTY CLI) **required** for security waivers and merge of tasks touching sensitive paths. F8 is no longer optional. |
| Q2 | Local Secretary endpoint | **Brain API** (as an authenticated `agent` principal) once it exposes an OpenAI-compatible façade | No local Secretary in the PoC; the human writes the task brief directly. Never point at `llama-server` directly (§4). |
| Q3 | Upstream PRs for S1–S5 | **Fork only** | §13 item 2/6: seams are kept as a thin patch series in the fork; F10 dropped. Seams still designed generic and default-off to keep rebases cheap. |
| Q5 | Where Crew runs | **On the BrainBox server (interim)** until the dev laptop is reformatted | New §11.1 hosting constraints (dedicated OS user, separate clone, no docker/sudo). |
| Q4 | Reviewer independence | Default accepted: **different agent or model** | F6 required. |
| Q6 | Captain | Default accepted: **Claude Code or Codex** (agy cannot captain) | — |
| Q8 | Version these docs | Default accepted: allowlist `docs/brainbox-adaptation/` and commit on `brainbox/adaptation` | — |
| — | Doc language | Default accepted: English (upstream language) | — |
| Q7 | PoC feature | **(a)** `--json` flag for `brainbox.admin token list` | Implemented in `crew`'s clone of `brainbox-skeleton`; never in `/srv/brainbox`. Merge requires human approval; deployment stays manual. |
| Q9 | "Only local-model agents may read passwords" | **Proposed alternative, pending confirmation** | See §11.2. |

---

## 1. Boundary

BrainBox Crew is a **development control plane**. It builds BrainBox; it is not part of the BrainBox runtime and does **not** modify Brain API V1.0.2.

```
 DEVELOPMENT CONTROL PLANE                                   BRAINBOX RUNTIME (untouched)
 ─────────────────────────                                   ────────────────────────────
 Human ──(host permission prompts / TTY approvals)──┐        Clients → Brain API → Identity,
                                                     │        AuthZ, Model Provider, Memory…
 Captain host (Claude Code | Codex)                 │
   │  reads skills/crew-brainbox.body.md  [BRAINBOX] │        (Crew may later call Brain API as an
   │                                                 │         authenticated agent principal —
   ▼                                                 ▼         out of scope)
 crew-mcp serve ─────────────────────────────────────────────
   ├─ Crew tools (run_agent, run_panel, merge_run…)   [UPSTREAM]
   ├─ Policy seam: CrewPolicy hooks                   [EXTENSION S1]
   │     └─ BrainBoxPolicy                            [BRAINBOX]
   ├─ Extension tools: bb_* (task/transition/approve) [EXTENSION S5 + BRAINBOX]
   ├─ Task ledger + findings + audit                  [BRAINBOX]
   ├─ Role registry (roles.yaml)                      [BRAINBOX]
   ├─ Adapters: claude-code, codex, agy, openai-compatible (local Secretary)  [UPSTREAM]
   └─ Worktrees / merge / discard / criteria / panels [UPSTREAM]
```

**Principle:** prose (the skill) drives *user experience*; the server (policy + ledger) decides *authority*. If the captain misbehaves, the worst case is a refused tool call — never an unauthorised dispatch, merge or transition.

---

## 2. Role model [BRAINBOX]

Roles are **data**, loaded from `.crew/brainbox/roles.yaml` (project) with schema validation. A role never names behaviour in code.

```yaml
schema_version: 1
roles:
  secretary:
    agent: local-gemma          # custom openai-compatible agent (text-only)
    model: null                 # agent default
    run_mode: text_only         # derived: adapter has no filesystem
    capabilities: [read_context, write_task_artifact]
    output_schema: secretary_v1
  architect:
    agent: claude-code
    model: opus
    run_mode: ephemeral_review  # sees the repo, cannot land changes
    capabilities: [read_repo, write_task_artifact]
  researcher:
    agent: agy
    run_mode: ephemeral_review
    capabilities: [read_repo, web_research, write_task_artifact]
  implementer:
    agent: agy
    run_mode: write
    capabilities: [read_repo, write_worktree, run_dev_tools]
  tester:
    agent: codex
    run_mode: ephemeral_review
    capabilities: [read_repo, run_tests, write_test_artifact]
  reviewer:
    agent: codex
    run_mode: read_only         # Codex: OS-enforced
    capabilities: [read_repo, write_findings]
  security_reviewer:
    agent: claude-code
    model: opus
    run_mode: ephemeral_review
    capabilities: [read_repo, read_config, write_findings, veto_blocker]
policy:
  independence: different_agent_or_model   # reviewer vs implementer (G-08)
  default_forbidden_paths: [docs/adr/**, docs/canonical/**, infra/**, .env, "**/*.env", secrets/**]
```

- **Capabilities are a closed vocabulary** checked by policy (e.g. only `write_worktree` permits `run_mode: write`; only `veto_blocker` findings can block).
- The **assignment table is not normative**: changing `implementer.agent` from `agy` to `codex` changes nothing else.
- A role resolves to ordinary Crew parameters: `run_agent({agent_id, model, effort, run_mode, criteria_set_id, labels:{task_id, role}, prompt})`.

---

## 3. Provider abstraction [UPSTREAM]

Reused unchanged: `AgentAdapter`, exact-or-refuse model selection, `ModelSelectionRecord` (requested/argument/observed), health/quota preflight, stream parsing and failure taxonomy. BrainBox adds **no adapter**. The role layer sits *above* adapters.

Per-adapter containment facts the policy relies on (from the audit):

| Adapter | `write` | Non-writing role mode | Technical guarantee |
|---|---|---|---|
| codex | worktree | `read_only` | OS sandbox |
| claude-code | worktree | `ephemeral_review` (needs S3) | disposal + non-mergeable; optional tool denial |
| agy | worktree | `ephemeral_review` | disposal + non-mergeable |
| openai-compatible | — | `text_only` | no filesystem at all |

---

## 4. Local Secretary [BRAINBOX + CFG]

- Registered as a custom `openai-compatible` agent. Input: the user's raw notes (inline), plus explicitly attached context excerpts.
- Output validated against `secretary_v1` JSON schema:
  `intent, problem, constraints[], ideas[{text,status}], explicit_decisions[{text,source_ref}], assumptions[], unresolved_questions[], affected_components[], possible_scope_creep[], source_refs[]`.
- **Promotion guard (deterministic):** an entry in `explicit_decisions` must carry a `source_ref` that points at a human-authored span in the input containing a decision marker; otherwise the server moves it to `ideas` with `status: unresolved` and records a `secretary_promotion_blocked` event. Evaluated with the BrainBox benchmark fixtures (`01…10`, e.g. `07-unresolved-idea`, `03-preference-vs-decision`).
- **Endpoint — DECIDED (Q2): Brain API**, once it has an OpenAI-compatible façade; until then no local Secretary. Background: pointing it at BrainBox's GPU `llama-server` would bypass the Brain API and its single-residency GPU policy (BrainBox principle §1, ADR-018). Options: a CPU-only Ollama/llama.cpp on a dev machine; a CPU-only instance on the server; or, later, Brain API itself as an authenticated `agent` principal once an OpenAI-compatible façade exists (not V1.0.2). Note BrainBox II-004: Gemma 4 thinking consumes the token budget.

---

## 5. Policy engine [EXTENSION S1 + BRAINBOX]

### 5.1 Seam (upstream-generic)

```ts
// src/orchestrator/policy.ts  [EXTENSION]
export interface PolicyContext { tool: string; input: unknown; runState?: RunStateV1; repoRoot: string; }
export type PolicyDecision = { allow: true; warnings?: string[] } | { allow: false; code: string; message: string };
export interface CrewPolicy {
  beforeDispatch?(ctx: PolicyContext): Promise<PolicyDecision>;      // run_agent
  beforeContinue?(ctx: PolicyContext): Promise<PolicyDecision>;      // continue_run
  beforePanel?(ctx: PolicyContext): Promise<PolicyDecision>;         // run_panel
  beforeCriteriaConfirm?(ctx: PolicyContext): Promise<PolicyDecision>;
  beforeMerge?(ctx: PolicyContext): Promise<PolicyDecision>;         // merge_run
  beforeDiscard?(ctx: PolicyContext): Promise<PolicyDecision>;       // discard_run
  onTerminal?(runState: RunStateV1): Promise<void>;                  // observe only
}
```
Loaded from `config.json` `policy.module` (absolute path or package name). Default: no policy (upstream behaviour byte-identical). A policy **exception fails closed** (refuse) when a policy is configured.

### 5.2 BrainBoxPolicy rules (deterministic)

| Hook | Rule |
|---|---|
| beforeDispatch/Panel | The run must carry `labels.task_id` and `labels.role`; the task must be in a state where that role is active; `agent_id`/`run_mode` must equal the role's resolution; `write` only for roles with `write_worktree`; reviewers/testers of a task must use `ephemeral_review` snapshots of the implementer's worktree; independence rule enforced; deny otherwise (deny-by-default, G-26). |
| beforeContinue | Same task/role/state checks; continuing an implementer is allowed only in `IMPLEMENTATION` (incl. fix loops). |
| beforeCriteriaConfirm | Only while task is in `PLAN_REVIEW` and a human `plan` approval exists for this criteria epoch. |
| beforeMerge | Task in `HUMAN_APPROVAL` with a valid human `merge` approval bound to the run head SHA; zero open BLOCKER (or waiver); latest test artifact = pass for the same head; diff within `allowed_paths`, outside `forbidden_paths`, frozen-file hashes unchanged; target branch allowed. |
| beforeDiscard | Allowed any time for non-mergeable runs; for the task's implementer run requires a human `discard` approval. |

Captain override claims (`dispatch_anyway`, `ban_override`, …) remain upstream features but **never satisfy a BrainBox gate**; only BrainBox approval records do.

---

## 6. Workflow state machine [BRAINBOX]

States (from the assignment) plus explicit exits:

```
NEW → SECRETARY → ARCHITECT_DRAFT ─┬→ RESEARCH ────────┐
                                   └→ SECURITY_REVIEW ─┴→ ARCHITECT_REVISION → PLAN_REVIEW
PLAN_REVIEW --(human: approve plan)--> PLAN_FROZEN → IMPLEMENTATION → TESTING
TESTING --fail--> IMPLEMENTATION          TESTING --pass--> REVIEW
REVIEW --findings--> IMPLEMENTATION       REVIEW --clean--> FINAL_SECURITY
FINAL_SECURITY --BLOCKER open--> IMPLEMENTATION (or DECISION_REQUIRED / waiver)
FINAL_SECURITY --clean--> HUMAN_APPROVAL --(human: approve merge)--> DONE
any state --conflict/assumption broken--> DECISION_REQUIRED --(human decision)--> <chosen state>
any state --(human: abandon)--> ABANDONED   (discards task worktrees)
```

- **Transition table is code-defined data** (`src/brainbox/workflow/transitions.ts`): `(from, to, requester_roles, guards[])`.
- **Guards** are pure functions over the ledger: e.g. `research_and_security_done`, `human_approval(plan, epoch)`, `tests_passed(head)`, `no_open_blocker`, `findings_resolved`.
- **Requests:** `bb_request_transition(task_id, to, evidence_refs)` → policy evaluates guards → appends `transition_accepted`/`transition_refused` to the ledger. The captain can request; only guards/human approvals grant.
- **Fix loops** are bounded by upstream iterate caps (3/epoch, 9 total) — reused, not reimplemented.
- **DECISION REQUIRED** renders the assignment's template (positions, evidence refs, options, consequences) from ledger artifacts and blocks until `bb_approve(decision)`.

---

## 7. Worktree lifecycle [UPSTREAM + BRAINBOX guards]

```
PLAN_FROZEN: task records base_commit (= host HEAD), allowed/forbidden paths, frozen-file hashes
IMPLEMENTATION: run_agent(write) → crew worktree ~/.crew/runs/<run>/worktree on crew-run/<id>
   each terminal turn: record head SHA + advisory path-policy check (early warning)
TESTING/REVIEW/SECURITY: ephemeral_review snapshots of the implementer worktree (never in place)
HUMAN_APPROVAL: human approves merge bound to head SHA
DONE: merge_run (policy re-verifies everything) → upstream squash/preserve → worktree cleaned
ABANDONED: discard_run on every task run (human-approved for the implementer run)
```
Upstream GC/retention apply unchanged.

---

## 8. Artifact model [BRAINBOX]

`<crewHome>/brainbox/tasks/<task_id>/`

| Artifact | Producer role | Format | Notes |
|---|---|---|---|
| `intent.json` | secretary | `secretary_v1` | raw input kept separately as `input.md` |
| `architecture.md`, `plan.md` | architect | markdown | + criteria set id (upstream criteria reused as acceptance criteria) |
| `research/<n>.json` | researcher | `research_v1` (candidate, license, maintenance, integration_cost, security_notes, fit, replaceability, recommendation, sources) | UNTRUSTED |
| `tests/<head>.json` | tester | machine-readable results (command, exit code, counts, duration) | bound to head SHA |
| `findings/<run>.json` | reviewer / security_reviewer | `findings_v1` (`id, severity, category, location, evidence, status`) | **parsed by the server** from the run's terminal output |
| `approvals.jsonl` | human | approval records | see §10 |
| `decisions/<n>.md` | orchestrator | DECISION REQUIRED dossier | |

Artifacts may contain model outputs and are **not** the audit log. Promotion of architect docs into the repo (`docs/**`) happens only through a normal, human-approved write task.

---

## 9. Provenance model [UPSTREAM + EXTENSION S2 + BRAINBOX]

| Field (assignment) | Source |
|---|---|
| task_id, role | `labels` on the run (S2) — persisted in `RunStateV1` and `run.json` |
| agent_run_id | Crew `runId` [UPSTREAM] |
| provider / model | `agentId` + `ModelSelectionRecord` (requested/argument/**observed**) [UPSTREAM] |
| started_at / finished_at | prompt records [UPSTREAM] |
| input_context_refs / artifact_refs | task ledger [BRAINBOX] |
| base_commit | `branchPointSha` [UPSTREAM] + task `base_commit` |
| result_commit | head SHA per terminal turn [BRAINBOX], `mergeStatus.commitSha` [UPSTREAM] |
| test_result_refs / review_refs | task ledger → artifacts [BRAINBOX] |
| status | run status [UPSTREAM] + task state [BRAINBOX] |

**Audit vs artifacts:** `<crewHome>/brainbox/audit.jsonl` is digest-chained and **metadata only** (ids, role, provider, model, SHAs, refs, decisions, approval channel). No prompts, no outputs, no secrets. Prompts/outputs stay in run dirs and task artifacts with their own retention.

---

## 10. Approval gates (human root of trust)

Gates: **plan approval** (PLAN_REVIEW→PLAN_FROZEN), **decision** (DECISION_REQUIRED exit), **security waiver**, **merge approval**, **implementer discard**.

A gate is satisfied only by an approval record whose **channel cannot be exercised by a model**:

1. **Host permission gate (config, default):** `bb_approve` (and `merge_run`, `discard_run`, `confirm_criteria`) are *removed* from the Claude Code auto-allow list (`permissions.ask`) / set to prompt in Codex. The host shows the human a native permission dialog with the exact arguments (task, gate, bound SHA). The model can request; only the human's click lets the call execute. Record: `channel: host_permission`.
2. **Out-of-band TTY approval (optional, stronger):** `crew-brainbox approve <task> <gate> <nonce>` in a separate terminal; the CLI refuses to run without an interactive TTY and asks the human to retype a short challenge shown in the DECISION/approval request. A model's shell tool has no TTY. Record: `channel: tty`.

Honest limits (documented, not hidden): a host launched in permission-bypass mode, or a human who auto-approves everything, defeats channel 1; channel 2 defends against that. agy cannot be a BrainBox captain (no approval switch). No cryptographic identity is attempted.

Every approval binds to what was approved: `(task_id, gate, criteria_epoch | head_sha | finding_id | decision_id, expires_at)`. A later change to the bound object invalidates it.

---

## 11. Security model

| Threat | Control |
|---|---|
| Model forges human approval | §10 channels; policy ignores captain override claims for BrainBox gates |
| Agent escalates its own permissions | Roles are data read by the server; runs carry `labels` validated against the role table; no tool lets an agent edit `roles.yaml` (it lives under a forbidden path + hash-pinned at task creation) |
| Reviewer edits code under review | reviewers run on disposable snapshots; non-mergeable modes |
| Implementer touches ADRs/contracts/infra/secrets | merge-time diff policy (allowed/forbidden globs + frozen hashes) |
| Implementer merges its own work | workers have only `send_message` [UPSTREAM]; merge needs human approval |
| Secrets exfiltration | worker env allow-list (S4); forbidden paths include `.env`/`secrets/**`; audit log metadata-only; `check_sensitive.py`-style scan in PoC artifacts |
| Prompt injection via web/research or worker output | outputs labelled UNTRUSTED [UPSTREAM]; findings/results parsed as data with schemas; nothing in model output changes policy or roles |
| Confused deputy (captain acting for an agent) | policy decides from ledger state + labels, not from captain narrative; approvals bound to exact objects |
| Supply chain (new deps) | Researcher reports license/maintenance; adding dependencies is a forbidden-path change (`package.json`, lockfile) unless the task allows it explicitly |
| Fail-open policy | configured policy that throws → refuse; missing ledger → refuse |

### 11.1 Hosting on the BrainBox server (interim, decision Q5)

Crew and its captain run **on the same host as the BrainBox runtime**. The operator account (`dmark123`) is in the `docker` group (root-equivalent), has `sudo`, owns `/srv/brainbox` (the **live, deployed** checkout) and `~/brainbox/.env` (Postgres password). Workers run with the privileges of the Crew process, and Claude/agy workers run with permission bypass — so an env allow-list (S4) alone does **not** contain them. Required constraints:

1. **Dedicated OS user `crew`** (no `sudo`, not in `docker`, own `$HOME`, `/home/dmark123` stays 700). Crew, the captain host and all workers run as `crew`. Created by the human (sudo).
2. **Separate clone** of `brainbox-skeleton` under `/home/crew/work/brainbox-skeleton`. Workers **never** operate on `/srv/brainbox`; it is production. Deployment stays a human step (`git pull` + service restart in `/srv/brainbox`).
3. **No secrets reachable by `crew`:** `/etc/brainbox/api.env` is already `600 root`; `~/brainbox/.env` is under a 700 home. `/srv/brainbox/private` (real domain/IPs) must become `o-rx`. The `crew` user gets its own provider credentials (its own `claude`/`codex` login), never the operator's.
4. **Git access:** read-only deploy key or HTTPS fetch for `crew`; pushing to GitHub remains a human action after merge approval.
5. **Runtime isolation:** `crew` cannot reach Postgres (no password) and must not call `llama-server` ports directly; Brain API access (future Secretary) uses its own `agent` token with minimal scopes (`chat:use`).
6. **Resources:** 16 GB RAM shared with the Brain API and GPU models. Cap concurrent workers (`maxConcurrent = 2`) and prefer cloud workers; local GPU-bound tests (e.g. T18) are human-run, not Crew-dispatched.
7. **Exit:** when the laptop is ready, move Crew there; the `crew` user and its clone can be deleted without touching BrainBox.

### 11.2 Secrets and local-only agents (request Q9)

Request: only agents backed by local models may read passwords, since they do not depend on an external provider.

Assessment: the concern (credential material leaving to a third-party provider) is valid, but "local agents may read secrets" does not deliver it:
- A secret read by any agent enters its context and can flow into its output, which the (cloud) captain and later agents consume; the invariant "secrets must never appear in prompts, logs, commits or artifacts" would be broken regardless of where the model runs.
- Local models are smaller and more prompt-injectable; a poisoned file or research result could make them echo the secret.
- OS permissions are per user, not per model: all workers run as `crew`; `openai-compatible` local agents are text-only and have no file tools, so the server would have to inject the secret into the prompt.

Proposed rule instead (two tiers):
1. **Credentials: no agent reads them, ever.** Tasks that need a database get an **ephemeral** Postgres with a throwaway password (as the BrainBox integration tests already do). Operations that need real credentials are human steps, or later a narrow broker tool that *uses* a secret server-side and returns only the result (never the value).
2. **Private data residency: local-only routing.** Tasks labelled `sensitivity: private` (e.g. personal notes, family data, audit contents) may be dispatched **only** to agents whose endpoint is local (Brain API / loopback). Enforced by `BrainBoxPolicy.beforeDispatch` from role/agent metadata, not by the captain.

---

## 12. Failure and recovery

- **Crash/restart:** Crew run state and watchers recover runs [UPSTREAM]; the task ledger is append-only and replayed on read; `bb_task_status` returns current state + allowed next actions.
- **Assumption broken during implementation:** implementer reports → `bb_request_transition(to: DECISION_REQUIRED)`; never silent redesign.
- **Tests or findings loop:** bounded by upstream iterate caps → DECISION_REQUIRED at the cap.
- **Provider failure/quota:** upstream typed failures; re-routing to another agent means **changing the role assignment** (human-visible), not silently swapping providers.
- **Merge conflict:** upstream behaviour (preserve evidence); task stays in HUMAN_APPROVAL with a conflict flag.
- **Ledger corruption:** digest chain breaks → task frozen read-only, human decision required.

---

## 13. Upstream compatibility strategy

1. **All BrainBox logic in new paths:** `src/brainbox/**`, `skills/crew-brainbox*.md`, `test/brainbox/**`, `docs/brainbox-adaptation/**`.
2. **Five small generic seams** (S1–S5, plus optional S6), each default-off and behaviour-preserving, kept in the fork only (decision Q3; no upstream PRs).
3. **No renames, no reformatting, no version bumps of upstream files.** Fork version suffix `0.20.0-brainbox.N` recorded in a fork-only file; do not touch `package.json` version / `version.ts` unless rebasing.
4. **Rebase cadence:** track `upstream/main`; each rebase runs upstream tests + BrainBox tests + the tool-catalog parity test (extension tools listed separately).
5. **Kill-switch:** removing `policy.module` from config and the BrainBox skill returns to vanilla Crew behaviour.
6. **Patch-series discipline (Q3):** keep S1–S5 as a thin patch series (≈ 150–250 lines) rebased with `git rebase --onto`; still no deep fork.

---

## 14. What we deliberately do NOT build

A second orchestrator/engine; a new adapter layer; our own worktree/merge logic; our own criteria or review aggregation; an LLM judge; autonomous agent orchestration inside Brain API; any change to BrainBox runtime.
