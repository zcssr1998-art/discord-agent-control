# AI handoff

## Branch

`jarvis-v4-p2-2-hardening`

## Active task

`docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md`

## Current status

P2.2.1–P2.2.4 fixes are complete and owner P2.2.4 real-Discord validation is PASS.

Owner evidence:

- live insert/lifecycle Work: no false intermediate DONE, inserted path requirement executed in the same Work, one final completion;
- Stop Work: one Stop killed the real Agent process tree, no false pending-insert report, stable STOPPED terminal, no terminal live controls.

The next task is release integration only: merge the stacked P2 PRs into `main` in the correct order and verify the resulting mainline runtime.

## Required order

1. Re-check remote/PR state and run the release gates on the latest hardening head.
2. PR #4 (`jarvis-v4-p2-control-context` -> `main`) first: Ready/checks/merge.
3. Retarget PR #5 (`jarvis-v4-p2-2-hardening`) to the new `main`; reconcile/verify its diff and tests.
4. Merge PR #5 second.
5. Run final short real-machine Discord/Chat/Work/Stop/single-instance smoke from `main`.
6. Update closeout docs on `main`, then stop.

Do not start P3 in this task and do not delete remote feature branches automatically.

## Preserve

- Supervisor/LiteLLM/Task Scheduler recovery and one bridge instance;
- Chat AUTO/manual selection and model persistence;
- model pagination/ACK/help consistency;
- FULL means no routine prompts and Work threads inherit it exactly;
- Work duration unlimited by default;
- monotonic Work lifecycle, truthful insert accounting, one-shot Stop and stale-control safety;
- no secrets in repo/logs.

## External limitation

WorkBuddy gateway may still return `HTTP 403 request illegal`; keep it documented as external if unchanged. It must not block other providers or the bridge.
