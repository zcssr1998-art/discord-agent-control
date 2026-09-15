# Current project state

Keep this file compact. It is the first project-state file a new worker should read.

## Branch

`jarvis-v4-p1-workflow`

## Milestone

Jarvis V4 P1 — safe Work concurrency + Work-thread UX + compact settings UX.

## Stable baseline

P0/P0.5 was merged to `main` via PR #2 and is the rollback point.

Verified baseline:

- default mode is Chat; ordinary messages never start an Agent
- deterministic `chat` / `work` controls
- LiteLLM primary Chat gateway + OpenCode Go direct fallback
- fallback/cooldown attribution
- Work permissions/approval hook
- real `!stop` process-tree kill
- stale approval-hook 401 self-repair with explicit Jarvis ownership marker
- `npm test` 166/0, `npm run check` 70/0 at the P0/P0.5 closeout
- real evidence: `docs/V4_SMOKE.md`

## Current task

`docs/JARVIS_V4_P1_TASK.md`

Priority:

1. workspace lock/queue
2. Work threads where Discord supports them
3. minimum useful `!settings` UX

Important reality constraint: Discord DMs do not support threads. DM Work must keep working; thread support is an enhancement for thread-capable guild channels.

## Current status

P1 branch and execution specification are prepared. No P1 production code is implemented yet.

## Next action

Implement P1A WorkspaceScheduler and its deterministic tests first. Do not start with UI polish.

## Acceptance

See `docs/JARVIS_V4_P1_TASK.md`. Preserve all P0/P0.5 invariants and do not merge `main` until P1 review passes.
