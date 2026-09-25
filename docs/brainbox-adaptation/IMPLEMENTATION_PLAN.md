# BrainBox Crew — Implementation Plan

**Base:** `crew-mcp` 0.20.0 @ `9b1eb28` · **Date:** 2026-09-23 · **Status:** PLAN — not started; decisions recorded in `ARCHITECTURE_PROPOSAL.md` §0; requires human approval to start. Q7 = (a). Q9 (secrets / local-only) pending.

Rules for whoever implements (mirrors BrainBox ADR-021):
- Work in small commits, one task each, on branch `brainbox/adaptation`; never on `main`.
- Upstream files change **only** in tasks marked `Core: yes`, and only at the listed seams.
- Every task: `npm run test:run && npm run lint` green (upstream + BrainBox suites) and the tool-catalog parity test green.
- If an assumption here is false: **stop and report**; do not redesign.
- Do not add runtime dependencies (YAML/JSON-schema: use the existing `yaml` and `zod`).

Commands: `npm ci` (first time) · `npm run test:run` · `npm run lint` · `npm run build`.

---

## Phase 0 — Baseline

### H0 — Host preparation (HUMAN, sudo; decision Q5, proposal §11.1)
- Create user `crew` (no sudo, not in `docker`); `chmod o-rx /srv/brainbox/private`; verify `/home/dmark123` is 700.
- As `crew`: install/login its own `claude` (and optionally `codex`) CLI; clone the fork to `/home/crew/crew-mcp` and `brainbox-skeleton` to `/home/crew/work/brainbox-skeleton` (read-only credentials).
- **Done:** `sudo -u crew docker ps` fails; `sudo -u crew cat /home/dmark123/brainbox/.env` fails; `sudo -u crew ls /srv/brainbox/private` fails; `sudo -u crew claude --version` works.
- **Rollback:** `userdel -r crew`.

### T0 — Reproduce upstream baseline
- **Objective:** prove the fork builds and tests pass before any change.
- **Files:** none.
- **Tests:** `npm ci && npm run test:run && npm run lint && npm run build`.
- **Done:** all green; counts recorded in `docs/brainbox-adaptation/BASELINE.md`.
- **Deps:** none · **Core:** no · **Rollback:** n/a.

### T0.1 — Fix upstream Linux test failures (fork-only; decided 2026-09-24)
- **Objective:** green baseline. File-version cache key (mtime + size + inode) for stat-keyed parse caches; fix the macOS-only assertion in `serve.test.ts`.
- **Done:** see `BASELINE.md` §T0.1. Test precondition: `npm run build` and `crew-wait` resolvable on `PATH`.
- **Deps:** T0 · **Core:** yes (bug fix, not a seam) · **Rollback:** revert the commit.

---

## Phase 1 — Minimal Proof of Concept (proves the architecture before building all of it)

The PoC implements **only what is needed to run one task end-to-end**: S1 (policy seam, merge + dispatch hooks only), S2 (labels), S3 (ephemeral for any adapter), S4 (env allow-list), a minimal ledger with 6 states, the host-permission approval channel, merge-time path policy, and findings parsing for one reviewer. Everything else is Phase 2.

### P1 — Policy seam S1 (dispatch + merge only)
- **Objective:** `CrewPolicy` interface; call `beforeDispatch` in `run_agent` plan and `beforeMerge` in `merge_run` before any mutation; default no policy.
- **Files:** new `src/orchestrator/policy.ts`; `src/orchestrator/tools/run-agent.ts`, `merge-run.ts` (call sites); `src/utils/config-store.ts` (`policy.module` key); tests `test/orchestrator/policy.test.ts`.
- **Tests:** (1) no policy → behaviour identical (existing tests untouched); (2) policy refusing → typed error `policy_denied`, no worktree allocated / no merge; (3) policy throwing → refused (fail-closed); (4) policy warnings surfaced in envelope.
- **Done:** tests green; zero diffs in existing test expectations.
- **Deps:** T0 · **Core:** yes (≈60 lines) · **Rollback:** revert commit; no persisted format change.

### P2 — Run labels S2
- **Objective:** optional `labels: Record<string,string>` (≤ 8 keys, key/value length caps, no secrets heuristics) on `run_agent`, persisted in `RunStateV1.labels` and `run.json`.
- **Files:** `run-agent.ts` schema, `run-state.ts`, `receipts.ts`, `get-run-status.ts` (echo); tests.
- **Tests:** labels round-trip to state/receipt/status; absent labels → unchanged records; oversize/invalid rejected.
- **Done:** additive to schema v1; old records still readable.
- **Deps:** T0 · **Core:** yes (additive) · **Rollback:** revert; extra field ignored by older readers.

### P3 — Ephemeral review for any adapter S3
- **Objective:** allow `run_mode:'ephemeral_review'` for adapters whose `reviewDispatchMode` is `read-only-dispatch` when explicitly requested (and a snapshot source/run can be named).
- **Files:** `run-agent.ts` mode check; tests.
- **Tests:** Claude/Codex ephemeral run gets a disposable snapshot worktree, `merge_run` refuses it, discard reclaims it; agy behaviour unchanged.
- **Done:** tests green.
- **Deps:** T0 · **Core:** yes (small) · **Rollback:** revert.

### P4 — Worker env allow-list S4
- **Objective:** `codexSafeSpawnEnvironment()` applies an optional allow-list (`workerEnv.allow` in `config.json`, default = current behaviour) plus always-kept essentials (`PATH`, `HOME`, `LANG`, provider auth dirs, `CREW_RUN_*`).
- **Files:** `src/codex/environment.ts`, config; tests.
- **Tests:** with allow-list, a dummy `SECRET_X` is absent from the spawned env; without it, current behaviour.
- **Done:** tests green; provider CLIs still authenticate in a manual smoke.
- **Deps:** T0 · **Core:** yes (one function) · **Rollback:** unset config key.

### P5 — Role registry (BrainBox)
- **Objective:** load/validate `.crew/brainbox/roles.yaml` (schema in proposal §2) with `zod`; resolve role → dispatch params; closed capability vocabulary.
- **Files:** new `src/brainbox/roles.ts`, `src/brainbox/schemas.ts`; tests `test/brainbox/roles.test.ts`.
- **Tests:** valid file; unknown capability, unknown agent, `write` without `write_worktree`, duplicate roles → precise errors; swapping a provider changes only the resolved `agent_id`.
- **Done:** tests green.
- **Deps:** T0 · **Core:** no · **Rollback:** delete files.

### P6 — Minimal task ledger + state machine (PoC subset)
- **Objective:** digest-chained `events.jsonl` per task; states `NEW, PLAN_FROZEN, IMPLEMENTATION, TESTING, REVIEW, HUMAN_APPROVAL, DONE, ABANDONED`; pure replay; guards `human_approval(plan)`, `tests_passed(head)`, `no_open_blocker`, `human_approval(merge, head)`.
- **Files:** new `src/brainbox/ledger.ts`, `src/brainbox/workflow/{states,transitions,guards}.ts`; tests.
- **Tests:** legal/illegal transitions; tampered ledger detected; replay after process restart yields identical state; guards evaluated from ledger only.
- **Done:** tests green.
- **Deps:** P5 · **Core:** no · **Rollback:** delete files + `<crewHome>/brainbox/`.

### P7 — BrainBoxPolicy (PoC rules)
- **Objective:** implement `CrewPolicy` for dispatch and merge: labels required; role/state/agent/run_mode match; reviewers & tester only `ephemeral_review` of the implementer run; merge requires HUMAN_APPROVAL + bound approval + tests pass + no BLOCKER + path policy (allowed/forbidden globs, frozen hashes) + allowed target branch.
- **Files:** new `src/brainbox/policy.ts`, `src/brainbox/path-policy.ts`; tests.
- **Tests:** each rule has a refusing and an accepting case; path policy on a real temp git repo (touching `docs/adr/x.md` → refused; frozen file changed → refused).
- **Done:** tests green.
- **Deps:** P1, P2, P3, P6 · **Core:** no · **Rollback:** unset `policy.module`.

### P8 — Findings + test artifacts (server-parsed)
- **Objective:** parse a fenced ```json `findings_v1` / `tests_v1` block from the terminal output of a labelled reviewer/tester run (`onTerminal` hook); invalid/missing → artifact `unparseable` which counts as an **open BLOCKER-equivalent** for gates (fail-closed).
- **Files:** new `src/brainbox/artifacts.ts`; call from policy `onTerminal`; tests.
- **Tests:** valid/invalid outputs; captain-provided summaries are ignored; BLOCKER blocks merge until a later clean review of a newer head or a human waiver.
- **Done:** tests green.
- **Deps:** P6, P7 · **Core:** only if `onTerminal` needs S1 extension (yes, one call in run lifecycle listeners) · **Rollback:** revert.

### P9 — BrainBox tools + registration seam S5
- **Objective:** `bb_task_create`, `bb_task_status`, `bb_request_transition`, `bb_approve`; registered through a generic extension seam; catalog parity extended.
- **Files:** `src/cli/commands/serve.ts` (seam), `src/install/tool-catalog.ts` (extension list), new `src/brainbox/tools/*.ts`; tests incl. parity.
- **Tests:** tool schemas; `bb_approve` records `channel: host_permission` and binds to object; transitions refused without guards; parity test green with and without the extension enabled.
- **Done:** tests green.
- **Deps:** P6, P7 · **Core:** yes (seam) · **Rollback:** disable extension.

### P10 — Host approval gates (config) + BrainBox skill
- **Objective:** documented Claude Code/Codex settings that put `bb_approve`, `merge_run`, `discard_run`, `confirm_criteria` under "ask"; `skills/crew-brainbox.body.md` playbook (roles, states, DECISION REQUIRED template); rendered by the existing renderer.
- **Files:** new skill body; renderer registration (1 line); `docs/brainbox-adaptation/SETUP.md`.
- **Tests:** rendered-skill test; manual check that the host prompts on `bb_approve`.
- **Done:** skill renders; manual host check recorded.
- **Deps:** P9 · **Core:** minimal (renderer list) · **Rollback:** remove skill.

### P11 — PoC run (end-to-end)
- **Objective:** one trivial feature from a frozen contract, run through the real roles:
  Human brief (no local Secretary, Q2) → Architect (Claude) → Researcher (Gemini/agy) → **human plan approval** → Implementer (agy) → Tester (Codex) → Reviewer (Codex or Claude) → Security Reviewer (Claude) → **human merge approval**.
  Feature (decided, Q7=a): add a `--json` output flag to `brainbox.admin token list` with an acceptance test, in `crew`'s clone of `brainbox-skeleton` (never `/srv/brainbox`). Must not print secrets or hashes.
- **Success criteria (each with evidence in `docs/brainbox-adaptation/POC_REPORT.md`):**

| Criterion | Evidence |
|---|---|
| isolated worktree | run `worktreePath` under `~/.crew/runs/` + branch `crew-run/*` |
| role permissions respected | policy refusals captured when the captain is *asked* to violate them (dispatch reviewer as `write`, implementer outside IMPLEMENTATION) |
| frozen contract unchanged | frozen-hash check in merge decision log |
| tests execute | `tests_v1` artifact bound to head SHA |
| reviewer cannot modify implementation | reviewer ran on snapshot; implementer head unchanged before/after review |
| implementer cannot merge | worker tool surface = `send_message` only |
| provenance captured | `run.json` labels + audit entries for every step |
| human approval required | host permission prompt screenshots/log for plan + merge; policy refusal without approval |
| resumable after interruption | kill `crew-mcp serve` mid-IMPLEMENTATION; `bb_task_status` + `list_runs` recover; continue |
| worktree discarded cleanly | abandon a second throwaway task; worktree and branch reclaimed |

- **Deps:** P1–P10 · **Core:** no · **Rollback:** discard PoC task worktrees.

---

## Phase 2 — Complete the architecture (after PoC review)

| ID | Objective | Files | Core | Deps |
|---|---|---|---|---|
| F1 | Remaining states (`SECRETARY`, `ARCHITECT_DRAFT`, `RESEARCH`, `SECURITY_REVIEW`, `ARCHITECT_REVISION`, `PLAN_REVIEW`, `FINAL_SECURITY`, `DECISION_REQUIRED`) + guards | `src/brainbox/workflow/*` | no | P6 |
| F2 | Policy hooks for `continue_run`, `run_panel`, `discard_run`, `confirm_criteria` | S1 call sites | yes | P1 |
| F3 | Secretary schema + promotion guard; evaluate against BrainBox fixtures 01–10 (endpoint: Brain API façade, Q2 — blocked until it exists) | `src/brainbox/secretary.ts` | no | P5 |
| F4 | Research artifact schema + Researcher preset (web, ephemeral, env allow-list) | `src/brainbox/research.ts` | no | P3, P4 |
| F5 | DECISION REQUIRED dossier renderer | `src/brainbox/decisions.ts` | no | F1 |
| F6 | Independence rule (`different_agent_or_model`) | policy | no | P7 |
| F7 | Metadata-only audit log (`audit.jsonl`), separate retention | `src/brainbox/audit.ts` | no | P6 |
| F8 | TTY approval CLI `crew-brainbox approve` (**required**, Q1) | `src/brainbox/cli/approve.ts` | no | P9 |
| F9 | Optional Claude read-only tool denial for review dispatches (S6 adapter) | `claude-code.ts` | yes (adapter) | P3 |

Each Phase 2 task follows the same template (objective, files, tests, done, deps, core, rollback) when scheduled; they are listed here, not detailed, until the PoC validates the design.

---

## Rollback strategy (global)

- Every core seam is default-off: removing `policy.module` / `workerEnv.allow` / extension registration restores upstream behaviour without code changes.
- BrainBox state lives under `<crewHome>/brainbox/`; deleting it removes all BrainBox data without affecting Crew runs.
- Branch `brainbox/adaptation` can be dropped entirely; `main` stays equal to upstream until the PoC is approved.
