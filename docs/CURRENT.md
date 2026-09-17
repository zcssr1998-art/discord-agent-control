# Current project state

## Branch

`jarvis-v4-p2-2-hardening`

## Current milestone

Jarvis V4 P2 — release merge / mainline closeout.

Authoritative task:

`docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md`

## Why this task is active

P2.2.4 implementation and owner real-Discord validation are complete. The remaining work is no longer feature development: the stacked P2 branches must be merged cleanly into `main` and the resulting `main` must pass a short real-machine smoke before P3 starts.

Current PR stack:

- PR #4: `jarvis-v4-p2-control-context` -> `main` (P2/P2.1), still Draft at task creation;
- PR #5: `jarvis-v4-p2-2-hardening` -> `jarvis-v4-p2-control-context` (P2.2–P2.2.4), still Draft at task creation;
- verified P2.2.4 head before this release task: `aa6dc27521527b86f1122292abe5d97179623915`.

Required merge order: **PR #4 first, then retarget/reconcile PR #5 to the new `main`, verify, then merge PR #5.**

## Owner validation completed

P2.2.4 owner smoke is PASS:

- live insert/lifecycle: one Work created `step1/2/3.txt` plus live-inserted `inserted.txt = INSERT_CONSUMED_OK`, with no false intermediate DONE and one final completion;
- Stop: one owner Stop killed the real Agent process tree, produced a stable STOPPED terminal state, reported no false pending insert, and terminal controls disappeared.

Do not rerun the long Hunyuan3D reproduction.

## Baselines to preserve

- P2.2.1 Supervisor / LiteLLM / Task Scheduler watchdog recovery; one bridge instance;
- P2.2.2 Chat default AUTO, manual pin, persistence, placeholder repair;
- P2.2.3 paginated model selection, ACK hardening, help consistency, FULL semantics, unlimited default Work duration;
- P2.2.4 monotonic Work lifecycle, truthful insert accounting, one-shot Stop, stale-control safety, no terminal live controls.

## Existing evidence

- `npm test` 356/356, `npm run check` 113 files / 0 failed;
- `smoke:p2` 11/11, `smoke:p22` 10/10, `smoke:p222` 25/25,
  `smoke:p22-insert` 14/14, `smoke:p223-full` 15/15;
- `smoke:p224-lifecycle` 21/21 (real Agent + real Windows process tree).

## Next action

Execute `docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md` exactly. Merge #4 first, retarget/verify/merge #5 second, run the final smoke from `main`, update closeout docs, then stop. Do not start P3.
