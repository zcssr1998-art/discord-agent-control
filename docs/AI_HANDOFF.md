# AI handoff

Keep this file short and overwrite/update it at every meaningful handoff. Do not paste old chat transcripts here.

## Current task

Jarvis V4 P1: workspace lock/queue, Work-thread isolation, minimum settings UX.

## Branch

`jarvis-v4-p1-workflow` (do not merge `main`).

## Last known good state

P1A/P1B/P1C implemented, tested and real-machine smoked. `npm test` 194/0,
`npm run check` 76/0, `npm run smoke:p1` 20/20 with real Claude Code agents.
Evidence: `docs/V4_P1_SMOKE.md`. P0/P0.5 is merged on `main` and remains the
rollback point.

## Architecture decisions (P1)

- `WorkspaceScheduler` owns one-active-Work-task-per-canonical-workspace + FIFO
  queue; it is Work-orchestration state, not LiteLLM/provider state.
- Canonical key: resolve → realpath → strip trailing separators → lower-case on
  Windows. The queue is in-memory on purpose (no SQLite/Redis).
- `runTask` acquires the workspace before `getRunner`; a queued item never creates
  a runner. Release happens in the scheduler's `finally` on every exit path.
- Work threads: `work <task>` in a thread-capable guild channel creates one
  permanent Work thread; parent stays Chat; thread-create failure starts nothing.
- `!settings` reuses the existing SessionManager/PermissionManager mutations; it
  never starts a runner and never calls ChatRuntime.

## Done

- `src/workspace-scheduler.mjs` + `tests/workspace-scheduler.test.mjs`
- scheduler wired into `src/discord-ui.mjs` (`runTask`, `!stop`, `!status`) and
  `src/index.mjs`
- Work threads in `discord-ui.mjs`; `FakeDiscord` gained thread/channel support
- `!settings` panel + interaction handlers
- `scripts/p1-e2e.mjs` (`npm run smoke:p1`) — real Agent queue/thread/cancel smoke

## Pending

- `PENDING_REAL_MULTI_CHANNEL_SMOKE` / `PENDING_REAL_GUILD_THREAD_SMOKE` (need the
  human owner in real Discord; the bridge ignores bot messages by design)
- P2: attachments, chat history, `/new` `/compact`
- WorkBuddy backend is currently quota-exhausted (429); unrelated to P1

## Blocker

None for P1 code. Real Discord network smoke is pending human interaction.

## Next action

Human runs the two real-Discord checks, then P2 or final P1 review.

## Verification

```text
npm test
npm run check
npm run smoke:p1
```

## Minimal relevant files

- `src/workspace-scheduler.mjs`
- `src/discord-ui.mjs`
- `src/i18n.mjs`
- `scripts/p1-e2e.mjs`
- `tests/v4-p1-*.test.mjs`, `tests/workspace-scheduler.test.mjs`
