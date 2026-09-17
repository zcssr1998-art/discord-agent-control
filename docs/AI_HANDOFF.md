# AI handoff

## Branch

`jarvis-v4-p3-ai-techlead-shadow`

## Active task

`docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`

The P3 specification is complete. Implementation has not started.

## Objective

Add a low-token event-driven **AI TechLead** to explicit Work mode without changing the Worker authority model.

P3 is **Shadow Mode only**:

- at most one compact startup review per Work;
- zero model calls while idle/standby;
- deterministic monitoring first;
- wake the TechLead only for deduped meaningful incidents;
- default desired reviewer: Grok 4.6 through existing safe OpenCode Go/provider infrastructure when available;
- advisory decisions only: `CONTINUE`, `SUGGEST_INJECT`, `SUGGEST_PAUSE_REPLAN`, `ASK_OWNER`;
- no automatic insert/pause/stop/tool/file action;
- provider/event degradation must never block Work.

## Baseline to preserve

P2/P2.1/P2.2.1–P2.2.6 are complete and merged on `main`. Preserve:

- one process Supervisor + one Bridge recovery chain;
- Chat/Work separation;
- persistent Work session/lifecycle state;
- approval/permission controls;
- truthful Work insert accounting;
- one-shot Stop / process-tree cancellation / stale-control safety;
- watchdog/runaway protection;
- AUTO billing safety and no silent METERED/unknown fallback;
- updater rollback/quarantine behavior;
- secret redaction and credential isolation.

The verified P2 baseline is recorded in `docs/CURRENT.md` and must remain green.

## Key P3 design decisions already made

- Call the new AI reviewer `TechLead`; do not overload the existing process `Supervisor` name.
- No LangGraph/AutoGen/CrewAI or new daemon/router/database.
- Jarvis-owned Work/runner events are canonical; OpenCode-specific hooks/events are optional enrichment.
- Add a capability probe and safe fallback because OpenCode event interfaces may change.
- Detect stagnation from repeated action/error **plus no new evidence/progress**, not repetition alone.
- Maintain a cheap ProgressFingerprint; do not recursively scan the workspace just for supervision.
- Deduplicate incidents and enforce cooldown.
- Default hard wake budget is 6 per Work; after exhaustion, monitoring continues but model calls stop.
- Bound and sanitize incident packets; never stream full logs to the reviewer.
- Deterministic PASS does not require a final model review.
- Persist enough dedupe/budget state to avoid repeat billing after restart.

## Worker startup

Do not create a second plan. Read the active task, then inspect only the relevant current implementation:

- Work lifecycle/runner output path;
- watchdog/runaway protection;
- insert accounting;
- state persistence;
- provider/model discovery and billing safety;
- Discord Work/status rendering;
- existing tests/smokes around those paths.

Implement the smallest compatible seam and verify it on the real Windows/OpenCode Go/Discord environment where available.

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

## Do not

Do not enable automatic TechLead intervention in P3. That requires a separate follow-up task after Shadow data is reviewed.
