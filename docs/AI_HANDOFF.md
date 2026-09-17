# AI handoff

## Branch

`jarvis-v4-p3-ai-techlead-shadow`

## Active task

`docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`

P3.0 and P3.1 are complete. P3.1 has passed owner acceptance on real Discord and TechLead implementation may start.

## Completed baseline

### P3.1 — Native Chat web search

- Default backend: OpenCode Go native `web_search` (Responses transport, `grok-4.6`), billing `SUBSCRIPTION`.
- Normal Chat remains lightweight; no coding Agent / Work session for search.
- AUTO current-info search works; stable knowledge can skip search; visible real Sources + `Web` footer when search is used.
- Deterministic/real smoke: `npm test` 411/0, `npm run check` 130/0, `smoke:p31-search` 7/7, `smoke:p222` 25/25, `smoke:p2` 11/11.
- Owner acceptance observed: stable question without Web; current-info question with real Web/Sources.

### P3.0 — Timeout policy cleanup

- No arbitrary total-duration failure in the default path.
- Durable result outbox separates Worker execution from Discord delivery.
- Result persists before delivery; transport timeout becomes recoverable pending/degraded delivery, never reruns a completed Work.
- Audit: `docs/P3_0_TIMEOUT_AUDIT.md`.

## TechLead objective

Implement the existing task exactly as specified:

- zero-token standby;
- deterministic incident detection first;
- ProgressFingerprint + dedupe/cooldown;
- Grok 4.6 only for meaningful judgment events;
- bounded per-Work wake budget;
- Shadow Mode advisory only (`CONTINUE`, `SUGGEST_INJECT`, `SUGGEST_PAUSE_REPLAN`, `ASK_OWNER`);
- no automatic insert/pause/stop/tool/file action;
- failure of TechLead/provider/events must never block normal Work.

## Preserve

- one process Supervisor + one Bridge;
- Chat/Work separation;
- P3.0 timeout/result-delivery semantics;
- P3.1 native Chat web search;
- persistent Work lifecycle/session state;
- truthful insert accounting;
- Stop/cancellation/permission controls;
- billing safeguards/manual pin semantics;
- updater rollback/quarantine;
- secret redaction/credential isolation.

Duplicate Bridge startup/provider-warning notifications observed during development are a non-blocking UX follow-up; do not expand TechLead scope to fix them unless required by a touched path.

## Completion contract

```text
PASS | FAIL
commit: <sha or none>
tests: <compact result>
blocker: <none or one key blocker>
techlead: <provider/model, SHADOW>
wakes: <startup + incident count>
events: <FULL|PARTIAL|DEGRADED>
real-smoke: <PASS|PENDING + reason>
```
