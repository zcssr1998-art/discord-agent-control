# AI handoff

## Branch

`jarvis-v4-p3-ai-techlead-shadow`

## Active task

`docs/tasks/JARVIS_V4_P3_1_CHAT_WEB_SEARCH.md` (P3.0 complete and committed).

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
- Verified: `npm test` 395/0; `npm run check` 123/0; P2 smokes all green
  (`p2` 11/11, `p22` 10/10, `p222` 25/25, `p22-insert` 14/14, `p223-full` 15/15,
  `p224-lifecycle` 21/21, `p225-limits` 23/23, `p226-update` 49/49, `verify:hook`
  9/9, supervisor recovery 23/23). Real Discord owner full-result run: PENDING.

## Current objective (P3.1)

Native Chat web search without the Work/coding-agent runtime: deterministic
freshness/intent policy, pluggable `WebSearchService`, compact evidence packet,
visible sources, explicit billing classification, graceful degradation. One search
phase + one answer phase.

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
