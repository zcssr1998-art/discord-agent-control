# AI handoff

Keep this file short and overwrite/update it at every meaningful handoff. Do not paste old chat transcripts here.

## Current task

Jarvis V4 P1: workspace lock/queue, Work-thread isolation, and minimum useful settings UX.

## Branch

`jarvis-v4-p1-workflow`

## Last known good state

P0/P0.5 is merged to `main` and is the stable rollback point. Final baseline evidence is in `docs/V4_SMOKE.md`.

P1 preparation already done:

- new branch created from latest `main`
- P1 requirements/acceptance written to `docs/JARVIS_V4_P1_TASK.md`
- external pattern research checked against `atou42/agents-in-discord`; use concepts, do not vendor the project
- `docs/CURRENT.md` advanced to P1

## Architecture decisions already made

- safety priority: workspace serialization before thread/settings polish
- one canonical workspace -> one active Jarvis Work task; same-workspace FIFO queue
- different workspaces may run concurrently
- queue is in-memory for P1; no SQLite/Redis/distributed scheduler
- lock is Work-orchestration state, not LiteLLM/provider state
- thread-capable guild parent: `work <task>` should create one permanent Work thread while parent stays Chat
- Discord DM has no threads: preserve existing DM Work behavior
- one thread/channel ID remains one Agent session key; do not add a second session DB
- permanent Work thread cannot be flipped into Chat
- `!settings` is a compact control panel over existing state mutation logic, not a second settings system

## Next action

Read `docs/JARVIS_V4_P1_TASK.md` and implement **P1A WorkspaceScheduler first**, with deterministic concurrency tests before Discord thread work.

## Do not redo

- Chat/Work split
- LiteLLM integration/fallback
- hook ownership/401 repair
- real `!stop` process-tree kill

## Blocker

None.

## Verification

During implementation use targeted tests, then at each milestone:

```text
npm test
npm run check
```

Detailed P1 real-smoke evidence should go to `docs/V4_P1_SMOKE.md`, not chat.
