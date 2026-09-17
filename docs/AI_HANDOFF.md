# AI handoff

## Branch

`jarvis-v4-p2-2-hardening`

## Active task

`docs/JARVIS_V4_P2_2_4_WORK_LIFECYCLE_TASK.md`

## Current status

P2.2.1–P2.2.3 fixes are complete and must be preserved. Owner real-Discord validation then exposed one remaining Work lifecycle/accounting cluster:

- intermediate turn falsely rendered terminal DONE, then same Work resumed;
- completed-turn output disappeared when continuation restarted the mutable progress card;
- a live insert that had already been applied was later reported as unprocessed;
- Stop needed repeated owner action before settling;
- terminal STOPPED cards retained live controls.

Treat this as lifecycle correctness, not a new feature.

## Required outcome

- continuation decision happens before terminal DONE rendering;
- completed results remain visible across later turns;
- insert/continuation states are truthfully consumed/pending/cancelled;
- one Stop settles the active run and kills the real process tree;
- repeated/stale controls are harmless;
- terminal state is monotonic and unique.

## Preserve

Do not regress Supervisor recovery, Chat AUTO/manual behavior, P2.2.3 model pagination/ACK/help fixes, FULL semantics, or unlimited default Work duration. Do not start P3. No secrets in repo/logs.

## Delivery

Add deterministic lifecycle/insert/Stop regression, run a small real Work smoke, append the bug/fix to `docs/P2_2_3_BUG_BASH.md`, update state/evidence, commit + push, verify remote HEAD, then stop.
