# P3.0 timeout policy audit

Rule: **time alone is never a failure condition for valid owner work.** Every
elapsed-time limit in the Chat / Work / result-delivery path is classified as
exactly one of `PROTOCOL_REQUIRED`, `PER_ATTEMPT_SAFETY`, `STALL_WATCHDOG`, or
`ARBITRARY_TOTAL_LIMIT`.

```text
location | current value | class | final behavior
```

| location | current value | class | final behavior |
| --- | --- | --- | --- |
| `src/discord-ui.mjs` Work turn (`TASK_TIMEOUT_MS`) | `0` default | ARBITRARY_TOTAL_LIMIT, **opt-in only** | unlimited by default; a positive value is an explicit operator cap. Default path has no wall-clock fail. |
| `src/chat-runtime.mjs` request (`CHAT_TIMEOUT_MS`) | `0` default | ARBITRARY_TOTAL_LIMIT, **opt-in only** | unlimited by default; `AbortSignal.timeout` is only attached when a positive value is configured. |
| `src/approval-manager.mjs` (`APPROVAL_TIMEOUT_MS`) | `0` default | ARBITRARY_TOTAL_LIMIT, **opt-in only** | unlimited by default; no auto-deny. |
| Discord REST connect (undici) | ~10s connect deadline | PER_ATTEMPT_SAFETY | kept. A connect/send failure now persists the full result and schedules a bounded retry; it never fails the Work. |
| `src/discord-ui.mjs` interaction defer/ACK | Discord 3s window | PROTOCOL_REQUIRED | kept (defer before work). |
| `src/discord-ui.mjs` stall watchdog (`STALL_NOTICE_MS`) | `30000` | STALL_WATCHDOG | notice/repaint only; never fails or kills a task. |
| `src/backend.mjs` startup probe (`BACKEND_PROBE_TIMEOUT_MS`) | `180000` | PER_ATTEMPT_SAFETY | startup per-attempt only. |
| `src/executor-manager.mjs` version probe | `5000` | PER_ATTEMPT_SAFETY | per-attempt only. |
| `src/provider-manager.mjs` list/probe | `10000` | PER_ATTEMPT_SAFETY | per-attempt only. |
| `src/litellm.mjs` health (`LITELLM_HEALTH_TIMEOUT_MS`) | `2500` | PER_ATTEMPT_SAFETY | per-attempt only. |
| `src/attachments.mjs` download | `60000` | PER_ATTEMPT_SAFETY | per-attempt only. |
| `src/updater.mjs` git | `60000` | PER_ATTEMPT_SAFETY | per-attempt only. |
| `src/kill-tree.mjs` taskkill | `10000` | PER_ATTEMPT_SAFETY | per-attempt only. |
| `src/index.mjs` crash-notify race | `5000` | PER_ATTEMPT_SAFETY | best-effort shutdown notice. |
| `src/compat-gateway.mjs` | `0` | n/a | disabled by default. |

Remaining `ARBITRARY_TOTAL_LIMIT` in the user-facing Chat/Work/result-delivery
path: **0**. The only total-duration caps left are explicit, default-off operator
overrides.

## Result delivery (P3.0)

- `src/durable-store.mjs` (schema v2) adds `result_deliveries`: the durable outbox.
- `src/result-delivery.mjs` owns delivery state `PENDING | DELIVERED | DEGRADED`,
  persists the full result before the first send, retries with bounded backoff
  (resumes partially delivered chunks), and keeps exhausted rows recoverable.
- `src/discord-ui.mjs` `#deliverResult` always persists before send; a transport
  failure is surfaced as `PENDING`/`DEGRADED` (execution stays `SUCCEEDED`).
  `!status` shows `📨 Result delivery: …`; `!redeliver` re-attempts manually.
- Recovery on startup via `resumePendingDeliveries()`.
