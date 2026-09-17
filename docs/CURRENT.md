# Current project state

## Branch

`jarvis-v4-p2-2-hardening`

Stacked on P2/P2.1. Do not merge P2.2 yet.

## Current milestone

Jarvis V4 P2.2.4 — Work lifecycle / insert / terminal-state correctness. **FIXED.**

Spec: `docs/JARVIS_V4_P2_2_4_WORK_LIFECYCLE_TASK.md`.
Bug ledger entry: `docs/P2_2_3_BUG_BASH.md` K6.

## What changed

- one monotonic outer lifecycle per Work; exactly one terminal state
  (DONE / FAILED / CANCELLED) guarded by `#markTerminal`;
- an Agent turn result no longer renders DONE while the same run still has a
  queued continuation; the completed turn result is posted as its own durable
  message before the next turn repaints the progress card;
- explicit insert state machine (RECEIVED / DELIVERED_LIVE /
  QUEUED_CONTINUATION / CONSUMED / CANCELLED): a completed turn consumes its
  live deliveries and an executed continuation is settled, so Stop never reports
  an already-applied insert as unprocessed;
- one Stop press freezes the run, cancels only genuinely pending demands, kills
  the real process tree once, renders STOPPED once and clears controls; repeated
  and stale `workctl` stops are idempotent and cannot touch a newer run;
- terminal cards (progress + parent summary) expose no live Insert/Stop controls.

## Baselines preserved

- P2.2.1 Supervisor / LiteLLM / Task Scheduler watchdog recovery; one bridge instance.
- P2.2.2 Chat default AUTO, manual pin, persistence, placeholder repair.
- P2.2.3 paginated model selection, ACK hardening, help consistency, FULL
  semantics, unlimited default Work duration (`TASK_TIMEOUT_MS=0`).

## Evidence

- `npm test` 356/356, `npm run check` 113 files / 0 failed.
- `smoke:p2` 11/11, `smoke:p22` 10/10, `smoke:p222` 25/25,
  `smoke:p22-insert` 14/14, `smoke:p223-full` 15/15.
- `smoke:p224-lifecycle` 21/21 (real Agent + real Windows process tree).

## Next action

P2.2.4 acceptance passed. Stop here; do not start P3.
