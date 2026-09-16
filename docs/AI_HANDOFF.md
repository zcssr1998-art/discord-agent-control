# AI handoff

Keep this file short and overwrite/update it at every meaningful handoff. Do not paste old chat transcripts here.

## Branch

`jarvis-v4-p2-2-hardening`.

Stacked on P2/P2.1 head `6d7f60af241ef65b226b6ebfc602593b797b5231`. PR #4 (`jarvis-v4-p2-control-context`) is still the parent functional PR. Do not merge this branch to `main` until P2/P2.1 is accepted/merged.

## Active spec

`docs/JARVIS_V4_P2_2_HARDENING_TASK.md`

## Baseline

At branch point P2/P2.1 were machine-verified:

- `npm test` 244/0
- `npm run check` 85/0
- `npm run smoke:p2` 11/11
- live `/work` ACK timeout bug fixed: interactions ACK before slow thread/filesystem/Agent/network work
- P2.1 slash commands + follow-up queue + Stop card behavior already implemented

Do not rebuild P2/P2.1.

## P2.2 goals

- single-instance guard before Discord login
- `/status` runtime/build identity: PID/uptime/branch/commit/instance/autostart
- Windows Task Scheduler autostart at owner logon; canonical task launches `scripts/start-supervisor.ps1`, not raw Node
- autostart install/remove/status is idempotent and does not touch unrelated tasks
- parent-channel compact Work summary card reusing existing Work thread/follow-up/stop paths
- SQLite WAL operational store for run/session/queue metadata; credentials remain outside; restart never silently resumes a dead Agent
- incrementally split the giant Discord control-plane module without changing behavior
- minimal Windows GitHub CI
- deterministic local `/doctor` (no LLM)

## Autostart safety

Treat “开机自启” as current-user logon autostart, not a pre-login Windows service. The supervisor remains the sole bridge/LiteLLM restart owner. Manual + scheduled launch must be safe because the second instance fails fast.

Never reboot the owner PC automatically. Mark final reboot acceptance `PENDING_OWNER_REBOOT_SMOKE` until the owner explicitly restarts Windows.

## Execution order

1. single-instance + live build identity
2. Task Scheduler autostart
3. durable SQLite store / restart-interrupted semantics
4. parent Work summary card
5. incremental `discord-ui.mjs` extraction
6. CI + `/doctor`
7. full regression / Windows smoke / minimal owner Discord smoke

## Read first

- `AGENTS.md`
- `docs/CURRENT.md`
- `docs/tasks/CURRENT.md`
- active P2.2 spec
- then only relevant files/diffs

Minimal code entry points:

- `scripts/start-supervisor.ps1`
- `src/index.mjs`
- `src/discord-ui.mjs`
- `src/workspace-scheduler.mjs`
- `src/state.mjs`
- `src/session-manager.mjs`
- `src/progress.mjs`
- `package.json`

## Verification

Use targeted tests during implementation, then:

```text
npm test
npm run check
npm run smoke:p2
```

Add P2.2 Windows/autostart/store smoke as appropriate. Evidence goes to `docs/V4_P2_2_SMOKE.md`.

## Non-goals

No Longbridge/Futu/P3, no web dashboard, no Redis/Postgres, no Agent swarm/worktree, no new real Codex/OpenCode adapter, no voice.

## Delivery

Update `CURRENT`, this file, `docs/tasks/CURRENT.md`, and `docs/V4_P2_2_SMOKE.md`; commit + push to `jarvis-v4-p2-2-hardening`.

Final worker reply stays short:

```text
PASS/FAIL
commit: <sha>
tests: <summary>
windows-smoke: <summary>
autostart: <installed/status/PENDING_OWNER_REBOOT_SMOKE>
blocker: <none or one key blocker>
```
