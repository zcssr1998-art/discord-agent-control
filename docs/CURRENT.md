# Current project state

Keep this file compact. It is the first project-state file a new worker should read.

## Branch

`jarvis-v4-p2-2-hardening`

Stacked on P2/P2.1 head `6d7f60af241ef65b226b6ebfc602593b797b5231`. P2/P2.1 PR #4 is still the parent functional PR; do not merge P2.2 to `main` before P2/P2.1 is accepted and merged.

## Milestone

Jarvis V4 P2.2 — hardening: single-instance guard, Windows logon autostart, durable SQLite store, parent Work summary card, `discord-ui.mjs` extraction, CI + `/doctor`.

Implementation is **complete on this branch**. Real evidence: `docs/V4_P2_2_SMOKE.md`.

## P2.2 delivered

1. `src/instance-guard.mjs` + `src/build-identity.mjs` — exclusive instance lock (`data/jarvis-instance.lock`) with PID/startedAt/repoRoot/branch/commit/instanceId; second live instance fails fast with exit 1 before Discord login; stale/corrupt locks reclaimed only when no live pid owns them; graceful release. Identity exposed in `/status` (`Build:` / `Runtime:` / `Instance:`).
2. `scripts/install-autostart.ps1` / `uninstall-autostart.ps1` / `start-supervisor-autostart.cmd` — one canonical per-user logon task `Jarvis Discord Agent Control` that starts the existing supervisor (never raw `node src/index.mjs`); idempotent re-install; `-DryRun`/`-Status`; uninstall touches only that task. npm: `autostart:install|status|remove`.
3. `src/durable-store.mjs` — SQLite WAL store at `data/jarvis.db` (built-in `node:sqlite`), `PRAGMA user_version` schema v1, idempotent open/migrate; startup marks stale `RUNNING`/`QUEUED` runs `INTERRUPTED` (no auto-resume); follow-up queue audit rows; no secrets migrated.
4. Parent-channel compact Work summary card (one per chain, updated in place, terminal state kept, controls bound to the live runId) + `打开 Work` thread link.
5. `src/discord/renderers.mjs` — pure rows/labels extracted from `discord-ui.mjs` (behavior-preserving; controller extraction deliberately deferred).
6. `.github/workflows/ci.yml` (windows-latest required + cheap linux portability) and deterministic `/doctor` + `!doctor` (identity, lock, store, Discord, LiteLLM, executors, autostart; no model call).

## Verified at this commit

- `npm test` 266/0
- `npm run check` 95/0
- `npm run smoke:p2` 11/11
- `npm run smoke:p22` 10/10 (real Windows single-instance + store + autostart query)
- Real machine: scheduled task started supervisor → LiteLLM UP → bridge online; supervisor auto-restarted the bridge after a kill; manual second launch refused pre-login

## Pending (owner-only)

- `PENDING_OWNER_REBOOT_SMOKE`: reboot Windows, confirm Jarvis returns online after logon.
- `PENDING_OWNER_DISCORD_SMOKE`: parent summary card `打开 Work` / `追加需求` / `Stop`, and `/status` + `/doctor` live output.

Never reboot the owner machine automatically.

## Preserved invariants

- ordinary Chat never starts an Agent
- LiteLLM primary + OpenCode Go direct fallback
- manual Chat pin never silently falls back
- AUTO never surprises the owner with metered routes
- guild Work runs in a permanent Work thread; parent remains Chat
- one canonical workspace has at most one active Jarvis Work task; same-workspace tasks FIFO
- queued Work never starts an Agent before lock acquisition
- real stop kills active process trees, cancels queued work, clears pending follow-ups
- stale cards/runIds cannot control newer work
- supervisor remains the only restart owner for Jarvis + LiteLLM
- `state.json` / `providers.json` / credential store unchanged; no secret in SQLite or logs

## Not in P2.2

market monitoring, web dashboard, Redis/Postgres, Agent swarm/worktrees, new Codex/OpenCode adapters, voice.

## Next action

After P2/P2.1 PR #4 is accepted, merge P2.2. Remaining work is owner-run smoke only (reboot + Discord card/doctor check). Do not redo the P2.2 implementation.
