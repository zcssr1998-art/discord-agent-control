# AI handoff

Keep this file short and overwrite/update it at every meaningful handoff. Do not paste old chat transcripts here.

## Current task

Jarvis V4 P1: workspace lock/queue, Work-thread isolation, minimum settings UX.

## Branch

`jarvis-v4-p1-workflow` (do not merge `main`).

## Last known good state

P1A/P1B/P1C implemented, tested and smoke-verified, including the real Discord
guild network smoke (queue across two channels + thread Work/session
continuation). `npm test` 195/0, `npm run check` 76/0, `npm run smoke:p1` 20/20
with real Claude Code agents. Evidence: `docs/V4_P1_SMOKE.md`. P0/P0.5 is merged
on `main` and remains the rollback point.

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

- P2: attachments, chat history, `/new` `/compact`
- WorkBuddy backend is currently quota-exhausted (429); unrelated to P1

## Blocker

None. All P1 real-Discord checks passed.

## Next action

P1 is complete; leave the P1 PR unmerged for final review, then start P2.

## Verification

```text
npm test
npm run check
npm run smoke:p1
```

Real Discord smoke evidence (queue + thread/session) is in
`docs/V4_P1_SMOKE.md` section 6. Note: write `data/state.json` without a BOM
(`StateStore.load` now strips one, but PowerShell `Set-Content -Encoding UTF8`
still adds it).

## Minimal relevant files

- `src/workspace-scheduler.mjs`
- `src/discord-ui.mjs`
- `src/i18n.mjs`
- `scripts/p1-e2e.mjs`
- `tests/v4-p1-*.test.mjs`, `tests/workspace-scheduler.test.mjs`
