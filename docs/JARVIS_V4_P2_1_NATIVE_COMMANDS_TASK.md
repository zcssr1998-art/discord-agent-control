# Jarvis V4 P2.1 — Native Discord Commands + Interactive Work Controls

## Goal

Make Jarvis feel native inside Discord and make an active Work task controllable without remembering text commands.

P2.1 extends the current P2 branch. Do not redesign P0/P1/P2 routing, Work threads, workspace queue, permissions, Chat history, attachments, or LiteLLM behavior.

## User-facing outcome

The owner should be able to use Discord-native application commands from the composer/App Launcher:

- `/work`
- `/model`
- `/settings`
- `/permission`
- `/status`
- `/stop`
- `/new`
- `/compact`
- `/help`
- `/panel`

Text commands remain backward compatible.

An active Work progress card must expose:

```text
[➕ 追加需求] [⛔ Stop]
```

Discord message components do not provide a permanent inline free-text box inside a normal message card, so `➕ 追加需求` opens a multiline Modal. In addition, while a Work task is active, ordinary owner messages sent directly in that Work thread/channel should be treated as follow-up requirements and queued through the same backend. This gives both a discoverable button path and the fastest natural-input path.

## A. Native application commands

Use Discord application commands; do not fake slash commands by parsing `/...` text.

### A1. Commands

Register these stable commands:

- `/panel` -> render the existing P2 control panel
- `/work` -> open the existing New Work modal; optional task text may be supported only if it stays simple
- `/model` -> open existing Chat/Work model selector
- `/settings` -> open existing settings UI
- `/permission` -> open existing permission UI
- `/status` -> render existing status data
- `/stop` -> exact existing stop semantics
- `/new` -> exact existing New Chat semantics
- `/compact` -> exact existing Compact semantics
- `/help` -> render the existing usage guide

Rules:

- OWNER-only, using the same authorization rules as current controls.
- Local UI commands must not invoke ChatRuntime/LLM/Agent unless the command inherently requires it (`/compact`) or `/stop` is acting on an existing task.
- Reuse existing handlers/renderers. No second implementation of settings/model/status/stop/new/compact.
- Keep existing `!` commands fully functional.
- Support guild channels and bot DM where Discord permits application commands.
- Registration must be idempotent. Prefer one small registration module/script or a startup registration path; do not scatter REST command definitions across files.
- If useful for development, allow an optional guild-scoped registration env for immediate propagation, while production/default can remain global. Do not hard-code the owner's guild ID.

### A2. UX

`/work` should be the primary native "create Work" entry. It should reuse the P2 New Work modal and the existing behavior:

- guild parent -> create one permanent Work thread, parent remains Chat
- DM -> run inline
- permanent Work thread -> same thread/session

`/model`, `/settings`, etc. should open the same button UI the persistent panel already uses.

## B. Active Work progress-card controls

Every queued/running Work progress card must expose stable controls:

```text
[➕ 追加需求] [⛔ Stop]
```

When the task reaches a terminal state (done/stopped/error), remove or disable the active controls so stale cards cannot control a later task.

### B1. Stale-card safety

Do not bind card controls only to channel ID. An old card must never stop or append to a newer task in the same channel.

Use a stable per-run/task-chain identifier in the custom ID or backend lookup, e.g.:

```text
workctl:append:<runId>
workctl:stop:<runId>
```

If the referenced run is no longer active/queued, reply locally that the task has ended; do nothing else.

### B2. Stop button

`⛔ Stop` must delegate to exactly the existing `!stop` semantics:

- queued Work -> cancel only that queued request
- active Work -> kill Agent process tree, cancel approvals, release workspace/task state
- idle/stale card -> no-op with concise message

Do not maintain a second stop implementation.

Stopping a Work chain must also cancel its pending appended requirements so nothing unexpectedly starts after the owner pressed Stop. Report the number of cancelled follow-ups if non-zero.

## C. Append / follow-up requirements

### C1. Button path

Clicking `➕ 追加需求` opens a Discord Modal with one multiline text field:

- title: `追加需求`
- field: `补充要求`
- max length: use a conservative Discord-compatible cap (<= 4000 chars)

On submit:

- validate OWNER + run identity
- enqueue one follow-up item for the same Work thread/channel and same Agent session
- acknowledge locally, e.g. `✅ 已追加，当前任务结束后执行（队列 #2）`
- do not start a second Agent concurrently for the same channel/session

### C2. Natural Discord input path

For maximum convenience, while Work is active:

- in a permanent Work thread, a normal owner text message is a follow-up requirement
- in DM/channel that is explicitly in Work mode, a normal owner text message is a follow-up requirement
- in the guild parent Chat channel, normal text remains Chat and must never be captured as Work follow-up

This normal-message path and the Modal path must call the same follow-up queue implementation.

If the appended message contains Work attachments, reuse the P2 attachment pipeline. Snapshot/download safely exactly once; do not lose the attachment before the follow-up executes.

### C3. Execution semantics

Do **not** inject text into a currently-running child process/stdin in an adapter-specific way. That is fragile across Claude Code/OpenCode/WorkBuddy.

Instead:

1. current Agent turn keeps running
2. follow-up requirements are queued FIFO
3. when the current turn exits normally, release its workspace lock
4. schedule the next follow-up through the existing `runTask` + `WorkspaceScheduler` path
5. reuse the same Agent session/thread when valid
6. reacquire the workspace lock normally, preserving global FIFO fairness

This means an already-waiting task from another channel for the same workspace is not starved forever by one thread's append loop.

### C4. Queue bounds and failure behavior

- cap pending follow-ups per Work chain (suggested default: 10)
- reject additional items clearly when full
- preserve FIFO order
- deduplicate repeated modal submissions/message events if Discord retries
- user Stop clears the pending follow-ups
- normal turn completion may continue to queued follow-ups even if the Agent reported a task-level failure, as long as the runner/session is still valid
- infrastructure/session/provider failure must not spin indefinitely; stop draining and report remaining follow-ups as not executed

The progress card/status should show a concise pending count when > 0, e.g. `追加需求：2 条待执行`.

## D. Progress-card component persistence

The current progress editor updates the same Discord message over time. Ensure button components survive normal progress edits while the task is active.

If `ThrottledEditor` currently edits only content, extend/refactor it minimally so progress edits can preserve/update components without duplicating the card implementation.

Terminal update must disable/remove controls.

## E. Interaction architecture

Keep the implementation centralized:

- one shared stop method used by `!stop`, `/stop`, panel Stop, and progress-card Stop
- one shared Work launcher used by text `work`, panel New Work, `/work`
- one shared model/settings/status/help renderer used by text commands, panel, and slash commands
- one shared follow-up queue used by card Modal and normal active-Work messages

Do not create parallel state stores.

## F. Non-goals

Do not add in P2.1:

- market data / P3 monitor engine
- new Agent runtime/provider router
- SQLite/Redis
- web dashboard
- mid-process stdin injection
- multi-user collaboration permissions
- autonomous model calls for follow-up classification

## Acceptance tests

Add deterministic tests covering at least:

1. native command definitions include `/panel /work /model /settings /permission /status /stop /new /compact /help`.
2. application-command registration is idempotent and contains no hard-coded guild/user IDs.
3. `/panel`, `/model`, `/settings`, `/permission`, `/status`, `/help` call local existing renderers and do not invoke Agent/ChatRuntime.
4. `/work` reuses existing New Work behavior; guild parent creates one Work thread and parent stays Chat.
5. active/queued progress card contains `追加需求` + `Stop` controls.
6. completed/stopped/error card cannot control a newer run.
7. card Stop == current `!stop` for active and queued Work.
8. Stop clears pending follow-ups.
9. append button opens multiline Modal; valid submit queues a follow-up without starting a concurrent Agent.
10. normal text in active Work thread queues via the same follow-up backend.
11. normal text in parent Chat while child Work is active remains Chat.
12. multiple follow-ups drain FIFO and reuse the same Agent session where valid.
13. each follow-up goes through `WorkspaceScheduler`; lock is released/reacquired and other same-workspace queued channels are not starved.
14. queue cap is enforced.
15. follow-up attachment is processed exactly once through P2 safe attachment handling.
16. old P0/P1/P2 tests remain green.

## Real Discord smoke

Use the existing live P2 bridge after implementation. Human owner smoke should be minimal:

1. confirm Jarvis application commands appear via `/` / App Launcher
2. run `/panel` and `/settings`
3. run `/work` and create one disposable long-enough task
4. while active, confirm progress card shows `➕ 追加需求` and `⛔ Stop`
5. click `➕ 追加需求`, submit `最终再创建 followup.txt，内容 FOLLOWUP_OK`
6. also type one normal follow-up message in the Work thread; confirm it queues rather than starts concurrently
7. confirm queued follow-ups execute in order in the same Work session
8. start another disposable long task and stop it with the progress-card Stop button; process tree must die and no queued follow-up may start afterward
9. verify old completed card buttons cannot affect a newer run

Record evidence in `docs/V4_P2_SMOKE.md` as a new P2.1 section. Do not claim PASS without human Discord output for the interaction-specific items.

## Verification

```text
npm test
npm run check
npm run smoke:p2
```

Add one small focused smoke only if slash registration or progress-card component persistence cannot be proven through current fake Discord tests. Do not create a second large E2E harness unnecessarily.

## Delivery

Stay on `jarvis-v4-p2-control-context` / PR #4 until P2 + P2.1 human smoke and final review are complete.

Update:

- `docs/CURRENT.md`
- `docs/AI_HANDOFF.md`
- `docs/tasks/CURRENT.md`
- `docs/V4_P2_SMOKE.md`

Commit + push to the current P2 branch.

Final worker report only:

```text
PASS/FAIL
commit: <sha>
tests: <summary>
real-smoke: <summary>
blocker: <none|reason>
```
