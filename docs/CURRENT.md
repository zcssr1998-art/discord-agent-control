# Current project state

Keep this file compact. It is the first project-state file a new worker should read.

## Branch

`jarvis-v4-p2-control-context`

## Milestone

Jarvis V4 P2 + P2.1 — persistent control panel, Chat context/attachments, native Discord commands, and interactive Work controls.

Status: P2 implementation + machine-side smoke are complete on this branch; P2 human Discord smoke was in progress when the owner requested P2.1 UX additions. PR #4 remains Draft and must not merge until combined P2/P2.1 human smoke + final review pass.

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
- real stop kills active process trees / cancels queued work correctly
- permission/approval/session safety remains intact

P1 evidence: `docs/V4_P1_SMOKE.md`.
P2 evidence so far: `npm test` 226/0, `npm run check` 83/0, `npm run smoke:p2` 11/11. Evidence: `docs/V4_P2_SMOKE.md`.

## Active specs

1. `docs/JARVIS_V4_P2_TASK.md` — implemented; owner human Discord smoke not yet closed.
2. `docs/JARVIS_V4_P2_1_NATIVE_COMMANDS_TASK.md` — **current implementation task**.

The former P1.1 panel task is superseded; do not implement it separately.

## P2.1 requested UX

- Discord-native application commands: `/panel /work /model /settings /permission /status /stop /new /compact /help`
- active/queued Work progress card buttons: `➕ 追加需求` + `⛔ Stop`
- append button opens a multiline Modal
- normal owner text in an active Work thread/Work-mode DM/channel also queues a follow-up requirement
- follow-ups execute FIFO as later turns in the same Work session, through the existing `runTask` + `WorkspaceScheduler` path; no fragile stdin injection
- parent guild channel stays Chat
- Stop cancels active/queued work and clears pending follow-ups
- stale task cards must never affect a newer run

## Key architecture decisions

- no second settings/model/work/stop implementation; slash commands and card controls delegate to existing handlers
- no second state store; add only minimal in-memory per-run follow-up state unless persistence is proven necessary
- follow-up queue is distinct from workspace scheduling, but every follow-up must reacquire the workspace through `WorkspaceScheduler` for FIFO fairness
- progress-card controls bind to a per-run identifier, not only channel ID
- Discord cards have no permanent inline text field; use a Modal for the button path, plus ordinary Work-thread text as the fastest path
- no adapter-specific mid-process stdin injection

## Next action

Implement `docs/JARVIS_V4_P2_1_NATIVE_COMMANDS_TASK.md`, run targeted tests then full regression, update `docs/V4_P2_SMOKE.md`, and perform one combined human Discord smoke. Do not redo already-proven P2 internals unless a regression is found.

## Minimal relevant files

- `src/discord-ui.mjs`
- `src/progress.mjs`
- `src/session-manager.mjs`
- `src/workspace-scheduler.mjs`
- `tests/helpers/fake-discord.mjs`
- current P2 UI/history/attachment tests
