# Current project state

Keep this file compact. It is the first project-state file a new worker should read.

## Branch

`jarvis-v4-p2-control-context`

## Milestone

Jarvis V4 P2 + P2.1 — persistent control panel, Chat context/attachments, native Discord commands, and interactive Work controls.

Status: P2 + P2.1 are implemented and machine-verified on this branch. PR #4 remains Draft and must not merge until the combined P2/P2.1 human Discord smoke + final review pass.

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
P2 + P2.1 evidence: `npm test` 240/0, `npm run check` 85/0, `npm run smoke:p2` 11/11. Evidence: `docs/V4_P2_SMOKE.md` (§9 for P2.1).

## Active specs

1. `docs/JARVIS_V4_P2_TASK.md` — implemented; owner human Discord smoke not yet closed.
2. `docs/JARVIS_V4_P2_1_NATIVE_COMMANDS_TASK.md` — implemented; owner human Discord smoke not yet closed.

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
- no second state store; P2.1 uses minimal in-memory per-run/per-chain follow-up state
- follow-up queue is distinct from workspace scheduling, but every follow-up must reacquire the workspace through `WorkspaceScheduler` for FIFO fairness
- progress-card controls bind to a per-run identifier, not only channel ID
- Discord cards have no permanent inline text field; use a Modal for the button path, plus ordinary Work-thread text as the fastest path
- no adapter-specific mid-process stdin injection

## P2.1 implementation map

- `src/commands.mjs` — application-command definitions + idempotent registration (no hard-coded IDs)
- `src/discord-ui.mjs` — `onInteraction` handles chat-input commands, `workctl:append|stop:<runId>` card controls, `workappend:<runId>` modal; shared `#stopChannel`; `#appendFollowUp` / `#drainFollowUps`; `#launchWork` reused by text/panel/slash
- `src/progress.mjs` — `TaskProgress.setFollowUps` + `ThrottledEditor` optional components so active cards keep controls
- `src/config.mjs` — `DISCORD_AUTO_REGISTER_COMMANDS`, optional `DISCORD_COMMANDS_GUILD_ID`, `MAX_WORK_FOLLOWUPS`

## Next action

Owner runs the combined minimal P2/P2.1 human Discord smoke (`docs/V4_P2_SMOKE.md` §8–§9), then final PR #4 review. Do not redo already-proven P2 internals.

## Minimal relevant files

- `src/discord-ui.mjs`
- `src/commands.mjs`
- `src/progress.mjs`
- `tests/v4-p2-native.test.mjs`
- `tests/helpers/fake-discord.mjs`
