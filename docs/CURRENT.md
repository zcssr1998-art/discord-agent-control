# Current project state

Keep this file compact. It is the first project-state file a new worker should read.

## Branch

`jarvis-v4-p2-2-hardening`

Stacked on P2/P2.1 head `6d7f60af241ef65b226b6ebfc602593b797b5231`. Do not merge P2.2 to `main` before P2/P2.1 PR #4 is accepted/merged.

## Current milestone

Jarvis V4 P2.2.1 — Supervisor / Autostart recovery hardening. **Implemented and verified on the real machine.**

Spec (authoritative):

`docs/JARVIS_V4_P2_2_1_SUPERVISOR_RECOVERY_TASK.md`

Evidence:

`docs/V4_P2_2_SMOKE.md` §0 (real Windows kill/recovery smoke, 23/23).

## Verified recovery model

```text
Windows Task Scheduler  (Level 2: AtLogOn + 1-min watchdog trigger restarts Supervisor)
        ↓
Persistent Supervisor   (Level 1: recovers Bridge + LiteLLM, never gives up)
   ├── Jarvis Bridge  (own hidden console, logs/bridge.log)
   └── LiteLLM
```

- Supervisor production default is unlimited; backoff `2s → 5s → 10s → 30s → 60s → 120s`; a `>= 60s` run resets the counter.
- The bridge runs in its own hidden console so a bridge/control event cannot kill the supervisor.
- LiteLLM is re-probed every 30s and recovered while the bridge runs.
- Task Scheduler restart-on-failure is configured (`RestartCount=999`, `RestartInterval=PT1M`) but Windows did **not** honor it for an externally killed action process; the reliable Level-2 path is the `RepetitionInterval PT1M` watchdog trigger with `MultipleInstances=IgnoreNew`. Both remain configured.
- Supervisor pid file + orphan-bridge reclaim keep exactly one supervised bridge.

## Verified gates (2026-09-16, real Windows)

- `npm test` 316/0 · `npm run check` 105/0 · `smoke:p2` 11/11 · `smoke:p22` 10/10.
- `scripts/smoke-supervisor-recovery.ps1` 23/23: G1 scheduled-task start → LiteLLM + bridge + Discord ready; G2 kill bridge → supervisor survives + new bridge; G3 kill LiteLLM → auto-recovered; G4 kill supervisor → watchdog restarts it + bridge restored; G5 >5 failures still retrying.

## Pending

- `PENDING_OWNER_REBOOT_SMOKE` — owner reboots Windows and confirms Jarvis returns ONLINE. The worker must never reboot the machine.

## Preserved invariants

- ordinary Chat never starts an Agent;
- LiteLLM primary + OpenCode Go direct fallback;
- manual Chat pin never silently falls back;
- AUTO never surprises the owner with metered routes;
- guild Work remains isolated in its Work thread;
- one canonical workspace has at most one active Jarvis Work task;
- stop/approval/session/model/workspace behavior must not regress;
- single-instance guard remains authoritative;
- no secret in repo/logs/SQLite.

## Non-goals

No P3 market monitoring, Longbridge/Futu, web dashboard, Redis/Postgres, Agent swarm/worktrees, new provider/model work, voice, Windows Service/NSSM/PM2/Docker, or unrelated UI refactor.

## Next action

Owner: run the reboot smoke and, if it passes, proceed to the P2.2 → P2/P2.1 merge decision. Do not start P3 or an unrelated refactor.
