# Current project state

## Branch

`jarvis-v4-p3-ai-techlead-shadow`

## Current milestone

Jarvis V4 P3 — **P3.0 and P3.1 implemented; awaiting owner acceptance for P3.1**.
Do not start TechLead yet.

### P3.1 — Native Chat web search (done)

- `src/web-search/`: deterministic `search-policy.mjs`, bounded
  `evidence-packet.mjs`, pluggable `web-search-service.mjs` and providers.
- Default backend: **OpenCode Go native `web_search`** (Responses transport,
  model `grok-4.6`), billing **SUBSCRIPTION** — reuses the existing OpenCode Go
  credential; no extra search key and no coding Agent. Tavily is an optional
  **METERED** adapter (`ALLOW_METERED_WEB_SEARCH=false` by default).
- Chat runs at most one search phase + one answer phase; evidence is injected as
  compact system instructions and real sources are appended as a `Sources:` block.
  AUTO searches only on current-info/explicit intent; `不要联网` always wins.
- Config: `WEB_SEARCH_MODE=auto|off|always`, `WEB_SEARCH_PROVIDER`,
  `ALLOW_METERED_WEB_SEARCH`, `WEB_SEARCH_MAX_RESULTS`, `WEB_SEARCH_MODEL`.
- Owner control: `!search [auto|on|off]`, doctor shows provider/billing.
- Verified: `npm test` 411/0; `npm run check` 130/0; `npm run smoke:p31-search`
  7/7 (real OpenCode Go search + real model answer + real sources);
  `smoke:p222` 25/25, `smoke:p2` 11/11. Owner Discord turn: PENDING.

### P3.0 — Timeout policy cleanup (done)

- No arbitrary total-duration limit in the default path; durable result outbox
  (`result_deliveries`) separates Worker execution from Discord delivery.
- Audit: `docs/P3_0_TIMEOUT_AUDIT.md` (remaining arbitrary total limits: 0).

Active doc: `docs/tasks/JARVIS_V4_P3_1_CHAT_WEB_SEARCH.md` (complete) →
`docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md` (queued).

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

### P3.1 — Native Chat Web Search (DONE — awaiting owner acceptance)

- modern Chat-style AUTO web search (deterministic policy);
- normal Chat remains lightweight; no coding Agent startup for search;
- current-info questions retrieve live evidence and show real sources;
- no silent metered/unknown search spend (OpenCode Go native = SUBSCRIPTION).

Verification: `npm test` 411/0; `npm run check` 130/0; `smoke:p31-search` 7/7
(real OpenCode Go `web_search` + real model answer + real sources); `smoke:p222`
25/25; `smoke:p2` 11/11. Owner Discord turn: PENDING.

### P3 — AI TechLead Shadow Mode (NOT STARTED)

- event-driven, near-zero-token standby;
- deterministic monitoring first;
- Grok 4.6 reviewer on meaningful incidents only;
- advisory Shadow Mode before any automatic intervention.

## Live runtime

Production remains the verified P2 `main` chain until P3 work is explicitly
promoted. The live supervised bridge currently runs this feature branch (single
Supervisor + single Bridge).

## Next action

Owner acceptance of P3.1 on real Discord (ask a current-info question, verify
live sources and the `Web` footer, verify no Agent starts). Do not start P3
TechLead until the owner accepts P3.1.
