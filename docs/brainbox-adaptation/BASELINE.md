# BrainBox Crew — T0 Baseline

**Date:** 2026-09-24 · **Commit:** `9b1eb28` (upstream, no changes) · **Host:** BrainBox server, Debian 13, Node 22.23.2, npm 12.0.2, `/tmp` on tmpfs.
Run as the operator in the operator's clone (the `crew` user needs its own `npm ci`).

## Commands and results

| Step | Result |
|---|---|
| `npm ci` | OK. npm 12 blocks install scripts by default (esbuild postinstall skipped); build and tests work anyway. |
| `npm run build` | OK |
| `npm run lint` (`tsc --noEmit`) | OK |
| `npm run test:run` (without build, `crew-wait` not on PATH) | 21 failed / 2021 passed / 5 skipped |
| `npm run test:run` (after build, `crew-mcp` + `crew-wait` on PATH) | **6 failed / 2044 passed / 3 skipped** (169 files) |

**Precondition not documented in the plan:** install/verify tests need `npm run build` and `crew-wait` resolvable on `PATH` (upstream assumes `npm link` or a global install). Baseline used a scratch `bin/` with symlinks to `dist/index.js` and `dist/cli/wait.js`; nothing was installed globally.

## Remaining 6 failures (upstream defects on Linux, not caused by the environment)

| Test | Cause |
|---|---|
| `run-state.test.ts` › quarantines corrupt state.json | `RunStateStore.parsedStateCache` is keyed on `mtimeMs`. Linux file timestamps advance in kernel ticks (~ms), so a rewrite right after a write keeps the same mtime and the stale cached state is returned. |
| `run-state.test.ts` › throws for unknown schemaVersion | same |
| `run-state.test.ts` › tolerates legacy v1 records | same |
| `list-runs.test.ts` › re-parses cached state when mtime changes | same pattern in the `list_runs` cache |
| `captain-inbox/store.test.ts` › skips filename/id mismatches | **flaky** (passed 1 of 3 isolated runs); timing-dependent, consistent with the same cache pattern |
| `serve.test.ts` › run_agent markdown text | platform assumption: on non-macOS the test expects no `crew-tail://` in the text, but the summary line always includes `tail: crew-tail://…` |

The mtime-cache issue is a **real correctness risk** beyond tests: a state rewrite within the same timestamp tick can be served stale. It matters to the BrainBox policy seam (S1), which will decide from run state.

## Decision needed before P1

Plan rule: *"every task: `npm run test:run` green"*. The baseline is not green. Options:
1. Treat these 6 as the accepted baseline (known-failing list); a task passes if it adds no new failures.
2. Add a fork-only task **T0.1** that fixes the mtime cache (e.g. key on `mtimeMs` + `size` + `ino`, or use the nanosecond `mtimeNs` via `statSync(p, { bigint: true })`) and the Linux assumption in the serve test, so the baseline is green.

## T0.1 — Resolution (2026-09-24, decision: option 2)

- New `src/utils/file-version.ts`: a cached file version is `mtimeMs` + `size` + `ino` (size/ino optional on the cached side, so mtime-only entries keep old behaviour). Applied to every stat-keyed parse cache: `run-state.ts`, `tools/list-runs.ts`, `panels/store.ts`, `captain-inbox/store.ts`, `run-gc.ts` + the boot cache in `serve.ts`.
- `captain-inbox/store.test.ts`: the tamper step now replaces the file via tmp + rename like real writers (an in-place same-size rewrite inside one tick is undetectable by `stat`; documented as the residual blind spot).
- `serve.test.ts`: non-macOS branch excludes the `relay_verbatim` breadcrumb (which carries `crew-tail://` on every platform by design) and asserts no clickable Terminal link.
- New `test/utils/file-version.test.ts`.
- No version bump (fork policy, proposal §13.3).

**Result:** `npm run lint` OK; `npm run test:run` (build + `crew-wait` on PATH) **2054 passed / 0 failed / 3 skipped**, twice in a row. New rule for later tasks: the suite must stay fully green.
