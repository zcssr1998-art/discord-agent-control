# AI handoff

## Branch

`jarvis-v4-p3-ai-techlead-shadow`

## Active task

`docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md` (P3.0 + P3.1 complete and
committed; **awaiting owner acceptance of P3.1 — do not start TechLead**).

## P3.1 outcome (done)

- `src/web-search/`: `search-policy.mjs`, `evidence-packet.mjs`,
  `web-search-service.mjs`, `providers/opencode-websearch.mjs`,
  `providers/tavily.mjs`.
- Default backend **OpenCode Go native `web_search`** (Responses transport,
  model `grok-4.6`), billing **SUBSCRIPTION**; reuses the existing OpenCode Go
  credential, no extra search key, no coding Agent. Tavily is an optional
  **METERED** adapter gated by `ALLOW_METERED_WEB_SEARCH`.
- `runChat` runs ≤1 search phase + 1 answer phase; evidence is injected as a
  compact system instruction and real sources are appended as a `Sources:` block;
  footer marks `Web`. Search failure degrades to a model-knowledge answer.
- Config: `WEB_SEARCH_MODE=auto|off|always`, `WEB_SEARCH_PROVIDER`,
  `ALLOW_METERED_WEB_SEARCH`, `WEB_SEARCH_MAX_RESULTS`, `WEB_SEARCH_MODEL`.
- Owner control: `!search [auto|on|off]`; doctor shows provider/billing.
- Verified: `npm test` 411/0; `npm run check` 130/0; `npm run smoke:p31-search`
  7/7 (real search + real model answer + real sources); `smoke:p222` 25/25;
  `smoke:p2` 11/11. Owner Discord turn: PENDING.

## P3.0 outcome (done)

- Default Chat/Work/result-delivery path has no arbitrary total-duration limit;
  remaining explicit caps are default-off operator overrides (`TASK_TIMEOUT_MS`,
  `CHAT_TIMEOUT_MS`, `APPROVAL_TIMEOUT_MS`).
- New durable result outbox: `src/result-delivery.mjs` +
  `data/jarvis.db` schema v2 `result_deliveries`. `#deliverResult` persists the
  full result before the first send; a connect/send timeout is `PENDING` then
  `DEGRADED` (recoverable), retried with bounded backoff, and never fails the Work.
- `!status` shows `📨 Result delivery:`; `!redeliver` re-attempts; startup
  `resumePendingDeliveries()` recovers after restart.
- Audit: `docs/P3_0_TIMEOUT_AUDIT.md`.

## Preserve

P2/P2.1/P2.2.1–P2.2.6 are complete on `main`. Preserve:

- one process Supervisor + one Bridge;
- Chat/Work separation;
- Work timeout default unlimited;
- approval timeout default unlimited;
- persistent Work lifecycle/session state;
- truthful insert accounting;
- owner Stop/process-tree cancellation;
- permission controls;
- AUTO billing safety/manual pin semantics;
- updater rollback/quarantine;
- secret redaction/credential isolation.

## TechLead intent

After P3.1 passes, continue to `docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`: zero-token standby, deterministic incident detection first, Grok 4.6 only on meaningful incidents, advisory Shadow Mode.

## Current Worker completion contract

```text
PASS | FAIL
commit: <sha or none>
tests: <compact result>
search: <actual backend / billing class>
auto-policy: <PASS|FAIL>
agent-started-for-chat-search: <NO required>
real-smoke: <PASS|PENDING + reason>
blocker: <none or one key blocker>
```
