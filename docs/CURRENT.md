# Current project state

## Branch

`jarvis-v4-p3-ai-techlead-shadow`

## Current milestone

Jarvis V4 P3 — **P3.0, P3.1, P3 AI TechLead Shadow Mode and P3.2 Work model
library hotfix implemented; real Discord owner smoke pending**.

### P3.2 — Work model library regression (done, pending real smoke)

- `#workProviderList` no longer filters providers by the previously selected
  executor: `#providerRunnable` asks whether any ready executor can run the
  provider, so OpenCode Go is reachable from `workbuddy / workbuddy-free / null`.
- `#workRouteFor` / `#selectWorkRoute` resolve and persist
  `executor + provider + model + transport` atomically: keep the current
  executor when compatible, otherwise pick the first ready compatible executor
  with a truthful confirmation, and disable models that have no runnable
  executor. `compatible()` is not weakened.
- Verified: `npm test` 440/0; `npm run check` 141/0; `smoke:p2` 11/11;
  `smoke:p222` 25/25; `smoke:p3-techlead` 12/12 (+ live `grok-4.6` reviewer).
  Owner real Discord smoke: PENDING.

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

Active doc: `docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md` (implemented — advisory
Shadow Mode).

### P3 — AI TechLead Shadow Mode (DONE — awaiting owner acceptance)

- `src/techlead/`: `work-event.mjs`, `work-contract.mjs`,
  `progress-fingerprint.mjs`, `incident-detector.mjs`, `incident-deduper.mjs`,
  `incident-packet.mjs`, `techlead-reviewer.mjs`, `techlead-controller.mjs`.
- Event-driven, zero-token standby (no timers/polling); deterministic checks
  first; the reviewer model wakes only for a meaningful incident.
- At most one startup review per Work; incidents STAGNATION / PLAN_THRASH /
  SCOPE_DRIFT / RISKY_NEXT_ACTION / REPEATED_TEST_FAILURE /
  COMPLETION_REVIEW_NEEDED; signature dedupe + cooldown; hard wake budget
  (default 6); bounded sanitized packet; strict response parser.
- Reviewer route resolved through discovery; real smoke used **OpenCode Go
  `grok-4.6`** (Responses transport, SUBSCRIPTION) and reported
  `SUGGEST_INJECT` in ~29s. No silent METERED/unknown fallback; missing route ->
  `DEGRADED` and Work proceeds.
- **Shadow safety:** TechLead never inserts/pauses/stops/executes tools; all
  actions are advisory-only. State persisted in `data/state.json`
  (`preferences.techLead`) for dedupe/budget/advisory/capability across restart.
- Status/doctor surface: `TechLead: SHADOW / Grok 4.6 / SLEEPING`; one concise
  advisory on a material incident.
- Config: `TECHLEAD_ENABLED`, `TECHLEAD_MODE`, `TECHLEAD_PROVIDER`,
  `TECHLEAD_MODEL`, `TECHLEAD_MAX_WAKES`, `TECHLEAD_COOLDOWN_MS`,
  `TECHLEAD_PACKET_MAX_CHARS`, `TECHLEAD_STAGNATION_REPEATS`.
- Verified: `npm test` 432/0; `npm run check` 140/0; `npm run smoke:p3-techlead`
  12/12 deterministic + live reviewer PASS (`opencode-go`/`grok-4.6`);
  `smoke:p2` 11/11; `smoke:p222` 25/25; `smoke:p224-lifecycle` 21/21. Owner
  Discord turn: PENDING.

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

### P3 — AI TechLead Shadow Mode (DONE — awaiting owner acceptance)

- event-driven, near-zero-token standby;
- deterministic monitoring first;
- Grok 4.6 reviewer on meaningful incidents only;
- advisory Shadow Mode before any automatic intervention.

Verification: `npm test` 432/0; `npm run check` 140/0; `smoke:p3-techlead`
12/12 deterministic + live `opencode-go`/`grok-4.6` reviewer PASS;
`smoke:p2` 11/11; `smoke:p222` 25/25; `smoke:p224-lifecycle` 21/21. Real Discord
owner Work turn: PENDING.

## Live runtime

Production remains the verified P2 `main` chain until P3 work is explicitly
promoted. The live supervised bridge currently runs this feature branch (single
Supervisor + single Bridge).

## Next action

Owner acceptance of P3.1 (real Discord Chat search) and of P3 TechLead on a real
Discord Work turn: confirm the startup review attribution to `opencode-go` /
`grok-4.6` (`TechLead: SHADOW / Grok 4.6 / SLEEPING`), trigger a safe synthetic
stagnation event, confirm one advisory and duplicate suppression, confirm the
Worker is untouched. Do not enable automatic intervention in P3.
