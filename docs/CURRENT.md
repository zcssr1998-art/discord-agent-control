# Current project state

## Branch

`jarvis-v4-p3-ai-techlead-shadow`

## Current milestone

Jarvis V4 P3 preflight — **P3.0 timeout policy cleanup**.

Active task:

`docs/tasks/JARVIS_V4_P3_0_TIMEOUT_POLICY_CLEANUP.md`

Queued next:

1. `docs/tasks/JARVIS_V4_P3_1_CHAT_WEB_SEARCH.md`
2. `docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`

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

Owner-friendly defaults that must not regress:

- Work wall-clock timeout default `0` (unlimited);
- approval timeout default `0`;
- Work follow-up cap default `0`;
- long Chat/Work output recoverable in full;
- historical failures do not permanently poison a channel.

## P3 sequence

### P3.0 — Timeout policy cleanup

- eliminate arbitrary total-duration failures;
- separate Worker execution state from Discord delivery state;
- persist full result before delivery attempts;
- network timeout -> durable pending/retry, never rerun completed Work.

### P3.1 — Native Chat Web Search

- modern Chat-style AUTO web search;
- normal Chat remains lightweight;
- no coding Agent startup for search;
- current-info questions retrieve live evidence and show real sources;
- no silent metered/unknown search spend.

### P3 — AI TechLead Shadow Mode

- event-driven, near-zero-token standby;
- deterministic monitoring first;
- Grok 4.6 reviewer on meaningful incidents only;
- advisory Shadow Mode before any automatic intervention.

## Live runtime

Production remains the verified P2 `main` chain until P3 work is implemented, tested and explicitly promoted.

## Next action

Execute P3.0. After PASS, point `docs/tasks/CURRENT.md` to P3.1 and stop that Worker job.
