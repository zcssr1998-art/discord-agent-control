# Current project state

Keep this file compact. It is the first project-state file a new worker should read.

## Branch

`jarvis-v4-p2-2-hardening`

This is a stacked follow-up branch based on P2/P2.1 head `6d7f60af241ef65b226b6ebfc602593b797b5231`. P2/P2.1 PR #4 is still Draft/open; do not merge P2.2 to `main` before P2/P2.1 is accepted and merged.

## Milestone

Jarvis V4 P2.2 — hardening, durable runtime metadata, parent Work controls, CI/doctor, and Windows autostart.

Active spec: `docs/JARVIS_V4_P2_2_HARDENING_TASK.md`.

## Stable baseline

P0/P0.5 and P1 are merged to `main`.

P2/P2.1 are the direct functional baseline for this branch and are machine-verified at branch point:

- `npm test` 244/0
- `npm run check` 85/0
- `npm run smoke:p2` 11/11
- real `/work` interaction ACK lifecycle fixed on the live bridge

P2/P2.1 final owner smoke/PR #4 merge may still be pending. Do not redo their implementation in P2.2.

Preserve these invariants:

- ordinary Chat never starts an Agent
- LiteLLM primary + OpenCode Go direct fallback
- manual Chat pin never silently falls back
- AUTO never surprises the owner with metered routes
- guild Work runs in a permanent Work thread; parent remains Chat
- one canonical workspace has at most one active Jarvis Work task; same-workspace tasks FIFO
- queued Work never starts an Agent before lock acquisition
- P2.1 follow-ups are later turns in the same Work session; no mid-process stdin injection
- real stop kills active process trees, cancels queued work, and clears pending follow-ups
- stale cards/runIds cannot control newer work
- permission/approval/session/secret safety remains intact

## P2.2 scope

1. single-instance lock + real PID/branch/commit/uptime/instance identity
2. Windows Task Scheduler autostart at user logon, launching the existing supervisor (and therefore LiteLLM + bridge), with install/remove/status/idempotency
3. compact parent-channel Work summary card: open thread / append / stop
4. local SQLite WAL durable operational store for run/session/queue metadata; no secret migration and no surprise auto-resume after restart
5. incremental split of the oversized `discord-ui.mjs`; no big-bang rewrite
6. Windows GitHub CI + local deterministic `/doctor`

Explicitly not P2.2: market monitoring, web dashboard, Redis/Postgres, Agent swarm/worktrees, new real Codex/OpenCode adapters, voice.

## Key autostart decision

“开机自启” means: after Windows starts and the owner logs into the user profile, Task Scheduler starts `scripts/start-supervisor.ps1` from the current checkout. Do not build a Windows service in this milestone. Do not start `node src/index.mjs` directly. The supervisor remains the only restart owner for Jarvis + LiteLLM.

A single-instance guard must make manual launch + scheduled launch safe. The scheduled task installer must be idempotent and update the canonical task to the current checkout rather than create duplicates.

Never reboot the owner machine automatically. Real reboot acceptance remains `PENDING_OWNER_REBOOT_SMOKE` until the owner explicitly restarts and confirms Jarvis returns.

## Next action

Read `AGENTS.md`, this file, `docs/AI_HANDOFF.md`, `docs/tasks/CURRENT.md`, then execute `docs/JARVIS_V4_P2_2_HARDENING_TASK.md` in the specified order. Use targeted tests while coding and full regression at milestones. Do not rescan/replan P2/P2.1.

## Minimal relevant files first

- `scripts/start-supervisor.ps1`
- `src/index.mjs`
- `src/discord-ui.mjs`
- `src/workspace-scheduler.mjs`
- `src/state.mjs`
- `src/session-manager.mjs`
- `src/progress.mjs`
- `package.json`
