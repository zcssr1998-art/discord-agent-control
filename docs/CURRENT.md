# Current project state

Keep this file compact. It is the first project-state file a new worker should read.

## Branch

`jarvis-v4-p2-control-context`

## Milestone

Jarvis V4 P2 — persistent control panel + Work launcher + Chat history + New/Compact + attachments.

## Stable baseline

P0/P0.5 and P1 are merged to `main` and are the rollback point.

Preserve these invariants:

- ordinary Chat never starts an Agent
- LiteLLM primary + OpenCode Go direct fallback
- manual Chat pin never silently falls back
- AUTO never surprises the owner with metered routes
- guild `work <task>` creates a permanent Work thread; parent remains Chat
- one canonical workspace has at most one active Jarvis Work task; same-workspace tasks FIFO
- queued Work never starts an Agent before lock acquisition
- real `!stop` kills active process trees / cancels queued work correctly
- permission/approval/session safety remains intact

P1 real Discord smoke passed for cross-channel workspace queue and Work-thread session continuation. Evidence: `docs/V4_P1_SMOKE.md`.

## Current task

`docs/JARVIS_V4_P2_TASK.md`

The earlier P1.1 control-panel task was folded into P2; do not implement it separately.

## P2 scope

1. persistent `!panel` control panel
2. `🛠 新建 Work` modal that reuses existing Work paths
3. Chat/Work Provider -> model selectors
4. Settings / Permission / Status / Stop / Usage Guide from the panel
5. bounded persistent channel-scoped Chat history
6. New Chat (`!new`, panel; `/new` where supported)
7. Compact context (`!compact`, panel; `/compact` where supported)
8. Discord attachments: Work files + Chat text/images with safe limits

## Key architecture decisions

- no second settings/model/work implementation: panel delegates to existing managers and P1 Work paths
- no SQLite/Redis; small local JSON/JSONL runtime state is enough
- Chat history is separate from Work Agent sessions
- failed Chat fallback attempts must not duplicate history
- explicit Compact may call the Chat model; no surprise background summarization calls
- Work attachments download once to a safe runtime inbox and are passed to Agent as local paths
- Chat binary files are not silently ignored; unsupported files should be redirected to Work

## Next action

Worker implements P2 in order: P2A panel -> P2B history -> P2C New/Compact -> P2D attachments -> P2E real smoke/evidence.

Do not merge to `main` until final review.

## Verification baseline

Before P2 changes, stable P1 baseline was:

```text
npm test      -> 195 passed / 0 failed
npm run check -> 76 file(s), 0 failed
npm run smoke:p1 -> 20/20
Real Discord queue/thread smoke -> PASS
```
