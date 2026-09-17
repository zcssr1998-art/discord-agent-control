# Current project state

## Branch

`jarvis-v4-p2-2-hardening`

## Current milestone

Jarvis V4 P2.2.5 — user-hostile limits cleanup before release merge.

Authoritative task:

`docs/JARVIS_V4_P2_2_5_USER_HOSTILE_LIMITS_CLEANUP_TASK.md`

## Why this task is active

P2.2.4 implementation and owner real-Discord validation are complete, but a source audit found several Jarvis-imposed limits that are not real platform limits and can surprise/block the owner: `/work`/modal input caps, silent result truncation, non-persistent permission tier, permanent failure/restart lockout, aggressive Chat timeout, opaque cooldowns, silent Chat-history trimming, approval expiry, follow-up cap, and a hard-coded Anthropic output ceiling.

The previously prepared release task `docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md` is **deferred**, not cancelled. Do not merge PR #4/#5 until P2.2.5 passes.

## Owner validation completed

P2.2.4 owner smoke is PASS:

- live insert/lifecycle: one Work created `step1/2/3.txt` plus live-inserted `inserted.txt = INSERT_CONSUMED_OK`, with no false intermediate DONE and one final completion;
- Stop: one owner Stop killed the real Agent process tree, produced a stable STOPPED terminal state, reported no false pending insert, and terminal controls disappeared.

Do not rerun the long Hunyuan3D reproduction.

## Baselines to preserve

- P2.2.1 Supervisor / LiteLLM / Task Scheduler watchdog recovery; one bridge instance;
- P2.2.2 Chat default AUTO, manual pin, persistence, placeholder repair;
- P2.2.3 paginated model selection, ACK hardening, help consistency, FULL semantics, unlimited default Work duration;
- P2.2.4 monotonic Work lifecycle, truthful insert accounting, one-shot Stop, stale-control safety, no terminal live controls;
- AUTO must not silently spend on metered/unknown billing; manual pins must not silently switch.

## Existing evidence

- `npm test` 356/356, `npm run check` 113 files / 0 failed;
- `smoke:p2` 11/11, `smoke:p22` 10/10, `smoke:p222` 25/25,
  `smoke:p22-insert` 14/14, `smoke:p223-full` 15/15;
- `smoke:p224-lifecycle` 21/21 (real Agent + real Windows process tree).

## Next action

Execute `docs/JARVIS_V4_P2_2_5_USER_HOSTILE_LIMITS_CLEANUP_TASK.md` exactly. Audit remaining hard caps/timeouts/lockouts, implement the required owner-friendly behavior, add focused regression coverage, update evidence, commit/push, then return the active task pointer to `docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md` and stop. Do not execute the release merge in the same Worker job and do not start P3.
