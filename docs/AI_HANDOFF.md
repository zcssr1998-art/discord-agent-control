# AI handoff

## Branch

`jarvis-v4-p3-ai-techlead-shadow`

## Active task

`docs/tasks/JARVIS_V4_P3_0_TIMEOUT_POLICY_CLEANUP.md`

Queued next:

1. `docs/tasks/JARVIS_V4_P3_1_CHAT_WEB_SEARCH.md`
2. `docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`

## Current objective

P3.0 removes/redesigns Jarvis-owned elapsed-time limits that can make valid Chat/Work/result-delivery flows fail merely because an internal timer fired.

Invariant:

> Time alone is not a failure condition for valid owner work. Per-attempt transport deadlines may exist only as recoverable safety mechanisms; they must not discard completed work/results or require rerunning the original Work.

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

## P3.0 completion handoff

After P3.0 passes:

1. save compact timeout audit evidence;
2. set `docs/tasks/CURRENT.md` to `docs/tasks/JARVIS_V4_P3_1_CHAT_WEB_SEARCH.md`;
3. commit/push and verify remote HEAD;
4. stop that Worker job.

Do not jump directly to TechLead.

## P3.1 intent

Implement native Chat web search in the normal Chat path, using a lightweight search/evidence layer rather than a coding Agent. AUTO search should be selective, cite real sources, preserve billing/privacy safeguards, and never create a Work session just to search.

## TechLead intent

After P3.1 passes, continue to `docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`: zero-token standby, deterministic incident detection first, Grok 4.6 only on meaningful incidents, advisory Shadow Mode.

## Current Worker completion contract

```text
PASS | FAIL
commit: <sha or none>
tests: <compact result>
timeout-audit: <remaining arbitrary total limits: 0 | blocker>
real-smoke: <PASS | PENDING + reason>
blocker: <none or one key blocker>
```
