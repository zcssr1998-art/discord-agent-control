# Current project state

## Branch

`jarvis-v4-p2-2-hardening`

Stacked on P2/P2.1. Do not merge P2.2 yet.

## Current milestone

Jarvis V4 P2.2.4 — Work lifecycle / insert / terminal-state correctness.

Authoritative spec:

`docs/JARVIS_V4_P2_2_4_WORK_LIFECYCLE_TASK.md`

## Why this milestone exists

P2.2.3 closed K1–K5 and passed broad regression, but owner real-Discord validation exposed a remaining lifecycle bug cluster in a long Hunyuan3D Work:

- an intermediate Agent turn was shown as `✅ 已完成` although the same Work still had continuation work and resumed running;
- useful completed-turn output was overwritten/disappeared when the mutable progress card returned to RUNNING;
- a live insert that had already successfully changed installation behavior was later falsely counted by Stop as `1 条未处理的插入需求`;
- Stop required repeated owner interaction before the task visibly settled;
- terminal STOPPED UI still exposed active Insert/Stop controls.

These are release-blocking correctness issues: displayed lifecycle != actual lifecycle, and insert accounting != actual execution.

## Required invariants

- one Work has one monotonic outer lifecycle and exactly one terminal state: DONE / STOPPED / FAILED;
- Agent turn completion is not Work completion when continuations/follow-ups remain;
- completed-turn result output remains visible when later turns start;
- live inserts and queued continuations have truthful consumed/pending/cancelled accounting;
- one valid Stop request is sufficient to kill the actual process tree and settle the run;
- repeated/stale controls are idempotent and cannot mutate newer runs;
- terminal cards expose no active controls.

## Baselines to preserve

P2.2.1:
- persistent Supervisor / LiteLLM / Task Scheduler watchdog recovery;
- one bridge instance / process cleanup.

P2.2.2:
- Chat default AUTO, selectable manual pin, persistence, placeholder repair.

P2.2.3:
- real paginated model selection;
- Discord interaction ACK hardening;
- help/control consistency;
- FULL means no routine re-approval and Work threads inherit FULL exactly;
- production Work duration is unlimited by default (`TASK_TIMEOUT_MS=0`).

## Next action

Execute `docs/JARVIS_V4_P2_2_4_WORK_LIFECYCLE_TASK.md`, add focused deterministic regression and one small real Work lifecycle smoke, append the finding/fix to `docs/P2_2_3_BUG_BASH.md`, commit + push, verify remote HEAD, then stop. Do not start P3.
