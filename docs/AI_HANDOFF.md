# AI handoff

## Branch

`jarvis-v4-p3-ai-techlead-shadow`

## Active task

`docs/tasks/JARVIS_V4_P3_0_TIMEOUT_POLICY_CLEANUP.md`

This is a priority preflight blocker before the already-prepared AI TechLead Shadow task.

Queued next task after P3.0 passes:

`docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`

## Objective

Remove/redesign Jarvis-owned elapsed-time limits that can make valid Chat/Work/result-delivery flows fail merely because an internal timer fired.

The user-facing invariant is now:

> Time alone is not a failure condition for valid owner work. Low-level per-attempt transport deadlines may exist only as internal recoverable safety mechanisms and must never discard completed work/results or require rerunning the original Work.

## Triggering failure

Real Discord result delivery surfaced a 10-second connect timeout and the full result was not available through the normal delivery path. Treat this as a systemic timeout-policy issue, not a one-line magic-number patch.

## Preserve

P2/P2.1/P2.2.1–P2.2.6 are complete on `main`. Preserve:

- one process Supervisor + one Bridge recovery chain;
- Chat/Work separation;
- Work wall-clock timeout default `0` unlimited;
- approval timeout default `0`;
- unlimited default Work follow-ups;
- persistent Work lifecycle/session state;
- truthful insert accounting;
- owner Stop/process-tree cancellation/stale-control safety;
- permission controls;
- AUTO billing safety and manual pin semantics;
- updater rollback/quarantine;
- secret redaction/credential isolation.

## Key P3.0 decisions

- Do not blindly delete every timer.
- Remove arbitrary total-duration/user-expiry semantics.
- Keep real Discord/platform deadlines and rate-limit/backoff/throttle/cleanup timers that do not expire owner work.
- A Discord/HTTP connect timeout is transport failure, not Worker failure.
- Persist complete result before delivery attempt.
- `Work SUCCEEDED + delivery PENDING` must remain a valid state.
- Retry transport delivery without rerunning the Worker.
- Immediate retry count may be bounded, but exhaustion must become durable pending/delayed retry, not data loss.
- Prefer progress/state-based watchdogs over elapsed-time kill switches.
- No new daemon/database/queue framework.

## Worker startup

Do not create a second plan. Read the active task and inspect only timeout/result-delivery/Work-lifecycle/Discord transport paths needed to implement it.

After P3.0 passes:

1. write/update the timeout audit evidence requested by the task;
2. restore `docs/tasks/CURRENT.md` to `docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`;
3. commit/push and verify remote HEAD;
4. stop. Do not implement TechLead in the same Worker job.

## Completion contract

```text
PASS | FAIL
commit: <sha or none>
tests: <compact result>
timeout-audit: <remaining arbitrary total limits: 0 | blocker>
real-smoke: <PASS | PENDING + reason>
blocker: <none or one key blocker>
```
