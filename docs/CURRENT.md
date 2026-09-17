# Current project state

## Branch

`jarvis-v4-p2-2-hardening`

## Current milestone

Jarvis V4 P2.2.6 — Runtime Freshness / Safe Self-Update.

Authoritative task:

`docs/JARVIS_V4_P2_2_6_SAFE_SELF_UPDATE_TASK.md`

## Why this task is active

P2.2.5 code/tests passed, but owner real-Discord smoke exposed a live-runtime freshness gap: GitHub source already defined `/work task max_length=6000`, while the currently running Windows Jarvis process and Discord-registered Slash Command schema still exposed the old 1500-character limit.

The root issue is not the 6000 constant. GitHub HEAD, the Windows runtime SHA and Discord command schema can drift until the owner manually restarts the Bridge.

The owner requested automatic receipt of verified repository updates. This task implements safe self-deploy + Supervisor restart, **not** in-process hot module replacement.

The previously prepared `docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md` is deferred again until P2.2.6 passes. Do not merge PR #4/#5 in this Worker.

## Required product behavior

- automatically check a configured trusted remote/branch (production target after merge: `origin/main`);
- expose running SHA vs remote SHA and update state in `/status`/`/doctor`;
- never interrupt active/queued Work merely to update;
- auto-apply only at a deterministic safe idle boundary;
- fast-forward only; dirty/diverged checkout blocks rather than being stashed/reset/merged automatically;
- candidate verification + known-good rollback/quarantine on failure;
- existing Supervisor remains the process replacement authority and exactly one Bridge remains;
- after restart, reconcile Discord application commands and fetch them back to prove the remote schema matches desired definitions;
- specifically prove real Discord `/work task max_length == 6000`;
- owner controls: update status/now/pause/resume;
- one controlled bootstrap restart is required so the current live machine actually begins running the updater.

## Baselines to preserve

- P2.2.1 Supervisor / LiteLLM / Task Scheduler watchdog recovery; one Bridge instance;
- P2.2.2 Chat default AUTO, manual pin, persistence, placeholder repair;
- P2.2.3 pagination, ACK hardening, help consistency, FULL semantics, unlimited default Work duration;
- P2.2.4 monotonic Work lifecycle, truthful insert accounting, one-shot Stop, stale-control safety;
- P2.2.5 owner-friendly limits cleanup, full result delivery, persistent permission tier, auto-compact, visible cooldown, no permanent channel lockout;
- AUTO never silently spends on metered/unknown billing; manual pins never silently switch; secrets protected.

## Existing evidence

P2.2.5 baseline before this task:

- `npm test` 372/372; `npm run check` 114 files / 0 failed;
- `smoke:p225-limits` 23/23 plus P2/P2.2 smokes green;
- commit `14bc0c16227bfd55665e79236c4be5b1be4fc2c3`.

## Next action

Execute `docs/JARVIS_V4_P2_2_6_SAFE_SELF_UPDATE_TASK.md` exactly. After P2.2.6 is verified/committed/pushed, restore the active pointer to `docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md` and stop. Do not start P3.
