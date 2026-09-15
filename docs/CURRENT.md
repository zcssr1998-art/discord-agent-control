# Current project state

Keep this file compact. It is the first project-state file a new worker should read.

## Branch

`jarvis-v4-p1-workflow`

## Milestone

Jarvis V4 P1 — safe Work concurrency + Work-thread UX + compact settings UX.

## Stable baseline

P0/P0.5 was merged to `main` via PR #2 and is the rollback point
(`docs/V4_SMOKE.md`). Its invariants are preserved: default Chat, ordinary Chat
never starts an Agent, LiteLLM primary + OpenCode Go direct fallback,
fallback/cooldown attribution, manual pin never falls back, Work
permissions/approval, real `!stop` process-tree kill, AUTO never spends METERED.

## Current status

P1A/P1B/P1C are implemented and verified:

- P1A `src/workspace-scheduler.mjs` — one active Jarvis Work task per canonical
  workspace, FIFO queue, in-memory, release on every exit path, queued cancel.
  `runTask` acquires the workspace before the Agent starts; `!status` shows
  `idle / running / queued (#N)`; `!stop` on a queued channel removes only that
  request.
- P1B Work threads — thread-capable guild parent + `work <task>` creates one
  permanent Work thread, parent stays Chat, one thread = one session, no nested
  threads, DM Work unchanged, thread-create failure runs nothing.
- P1C `!settings` — compact Chat + Work panel reusing the existing
  SessionManager/PermissionManager mutations (no second config system), no
  runner/LLM calls; Chat control omitted inside a permanent Work thread.

## Current task

`docs/JARVIS_V4_P1_TASK.md`. All P1 acceptance items are implemented.

## Next action

Real-Discord verification of the two remaining network-only items
(`PENDING_REAL_MULTI_CHANNEL_SMOKE`, `PENDING_REAL_GUILD_THREAD_SMOKE`), then P2
(attachments, chat history, `/new` `/compact`). Do not merge `main`.

## Verification

```text
npm test      -> 194 passed / 0 failed
npm run check -> 76 file(s), 0 failed
npm run smoke:p1 -> 20/20 real Agent checks (Claude Code + OpenCode Go)
Real Chat via LiteLLM chat-fast -> opencode-go/deepseek-v4.1-flash, 2.2 s
```

Evidence: `docs/V4_P1_SMOKE.md`.
