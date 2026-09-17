# Current project state

## Branch

`jarvis-v4-p3-ai-techlead-shadow`

## Current milestone

Jarvis V4 P3 — **P3.0 complete, P3.1 active**.

Done (P3.0): `docs/tasks/JARVIS_V4_P3_0_TIMEOUT_POLICY_CLEANUP.md`.

- Default Chat/Work/result-delivery path has no arbitrary total-duration limit;
  the only total caps left are explicit, default-off operator overrides.
- Durable result outbox (`data/jarvis.db` schema v2 `result_deliveries`) persists
  the full result before the first send; a Discord connect/send failure becomes
  `PENDING`/`DEGRADED` and is retried, never failing the Worker execution.
- `!status` distinguishes `📨 Result delivery` state; `!redeliver` re-attempts.
- Audit: `docs/P3_0_TIMEOUT_AUDIT.md` (remaining arbitrary total limits: 0).

Active now:

`docs/tasks/JARVIS_V4_P3_1_CHAT_WEB_SEARCH.md`

Queued after P3.1:

1. `docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`

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

### P3.0 — Timeout policy cleanup (DONE)

- eliminate arbitrary total-duration failures (done; audit remaining = 0);
- separate Worker execution state from Discord delivery state (done);
- persist full result before delivery attempts (done);
- network timeout -> durable pending/retry, never rerun completed Work (done).

Verification: `npm test` 395/0; `npm run check` 123/0; `smoke:p2` 11/11,
`smoke:p22` 10/10, `smoke:p222` 25/25, `smoke:p22-insert` 14/14,
`smoke:p223-full` 15/15, `smoke:p224-lifecycle` 21/21, `smoke:p225-limits` 23/23,
`smoke:p226-update` 49/49, `verify:hook` 9/9,
`smoke-supervisor-recovery.ps1` 23/23. Real Discord owner run: PENDING (owner-only).

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

Execute P3.1 (`docs/tasks/JARVIS_V4_P3_1_CHAT_WEB_SEARCH.md`), then stop for owner
acceptance. Do not start P3 TechLead until the owner accepts P3.1.
