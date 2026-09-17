# Current project state

## Branch

`jarvis-v4-p3-ai-techlead-shadow`

## Current milestone

Jarvis V4 P3 preflight — **P3.0 timeout policy cleanup**.

Active task:

`docs/tasks/JARVIS_V4_P3_0_TIMEOUT_POLICY_CLEANUP.md`

The prepared AI TechLead Shadow task is queued after P3.0:

`docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`

## Why P3.0 is first

A real Discord result-delivery path surfaced a `Connect Timeout Error (... timeout: 10000ms)` and the full result was not available through the normal delivery path. This exposed a broader UX issue: internal elapsed-time limits can still leak into owner-visible failures.

Product rule now:

> Valid owner work must not terminally fail merely because Jarvis waited N seconds. Per-attempt transport deadlines may exist only as internal recoverable safety mechanisms; they must not discard completed work/results or require the original Work to be rerun.

## Baseline to preserve

P2/P2.1/P2.2.1–P2.2.6 are complete and merged to `main`.

Verified release baseline before P3:

```text
npm test                 -> 386 pass / 0 fail
npm run check            -> 121 file(s), 0 failed
npm run smoke:p2         -> 11/11
npm run smoke:p22        -> 10/10
npm run smoke:p222       -> 25/25
npm run smoke:p22-insert -> 14/14
npm run smoke:p223-full  -> 15/15
npm run smoke:p224-lifecycle -> 21/21
npm run smoke:p225-limits    -> 23/23
npm run smoke:p226-update    -> 49/49
npm run verify:hook      -> 9/9
scripts/smoke-supervisor-recovery.ps1 -> 23/23
```

Already-established owner-friendly defaults that must not regress:

- Work wall-clock timeout default `0` (unlimited);
- approval timeout default `0` (no auto-expiry);
- Work follow-up cap default `0` (unlimited);
- long Chat/Work output must remain recoverable in full;
- historical failures must not permanently poison a channel.

## P3.0 target

- audit every user-facing timeout in Chat/Work/result-delivery paths;
- eliminate arbitrary total-duration deadlines;
- make Chat default client-side timeout unlimited where safely supported;
- separate Worker execution success from Discord delivery state;
- persist full result before delivery attempts;
- transient Discord/network timeout -> durable pending/retry state, never task rerun/data loss;
- preserve mandatory protocol deadlines, rate-limit pacing, backoff, liveness repaint and cleanup TTLs;
- prove behavior with deterministic tests plus minimum real Windows/Discord smoke.

## Live runtime

Production/live runtime remains the already-verified P2 `main` chain until P3 work is implemented, tested and explicitly promoted.

## Next action

Execute `docs/tasks/JARVIS_V4_P3_0_TIMEOUT_POLICY_CLEANUP.md` on this branch. After it passes, restore `docs/tasks/CURRENT.md` to the existing AI TechLead Shadow task and stop that Worker job.
