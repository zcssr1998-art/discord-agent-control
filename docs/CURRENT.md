# Current project state

Keep this file compact. It is the first project-state file a new worker should read.

## Branch

`jarvis-v4-p2-2-hardening`

Stacked on P2/P2.1 head `6d7f60af241ef65b226b6ebfc602593b797b5231`. Do not merge P2.2 to `main` before P2/P2.1 PR #4 is accepted/merged.

## Current milestone

Jarvis V4 P2.2.1 — Supervisor / Autostart recovery hardening.

Active spec:

`docs/JARVIS_V4_P2_2_1_SUPERVISOR_RECOVERY_TASK.md`

## Why P2.2.1 exists

P2.2 implementation passed earlier deterministic and machine smoke, but the owner's first real reboot smoke exposed a production reliability failure.

Real sequence:

- Windows logon task fired successfully and Jarvis initially reached Discord ready;
- LiteLLM was healthy and the Bridge ran for ~2503.5s;
- Bridge then exited;
- Supervisor logged `Restarting in 2s...` but never logged another `Starting bridge`;
- Scheduled Task returned to `Ready` and Jarvis remained OFFLINE;
- `Get-ScheduledTaskInfo` reported `LastTaskResult = 3221225786` (`0xC000013A`, control-exit class result).

TaskScheduler Operational logs around the failure did not establish the exact source of the control event. Do not block the fix on proving that source: the established defect is that both Bridge and Supervisor can disappear without recovery.

The previous owner reboot gate is therefore **FAIL until repaired and re-tested**.

## Required recovery model

Use the existing lightweight stack only:

```text
Windows Task Scheduler  (Level 2: recover Supervisor)
        ↓
Persistent Supervisor   (Level 1: recover Bridge + LiteLLM)
   ├── Jarvis Bridge
   └── LiteLLM
```

Production behavior must not permanently give up after five failures. Use bounded backoff and continue recovering while the logged-in Windows session is alive.

## P2.2 baseline to preserve

Already implemented and not to be redone:

- single-instance guard + runtime/build identity;
- Windows logon autostart scripts;
- SQLite WAL durable operational store;
- parent Work summary/control card;
- `/doctor` + CI;
- first-class workspace resolution;
- model-selection persistence;
- live Work insert/steering;
- Discord interaction ACK hardening.

Existing regression evidence before this recovery fix included `npm test` 311/0, `npm run check` 104/0, `npm run smoke:p2` 11/11, `npm run smoke:p22` 10/10. Re-run required gates after changes; do not assume old evidence proves the new recovery path.

## Acceptance focus

P2.2.1 is not complete until real Windows smoke proves:

- Scheduled Task starts Supervisor → LiteLLM + Bridge;
- killing Bridge only causes automatic Bridge recovery with Supervisor PID preserved;
- killing LiteLLM only causes automatic LiteLLM recovery;
- killing Supervisor only causes Task Scheduler to restart it without a manual startup command;
- >5 simulated startup failures do not permanently strand production recovery;
- the actual installed scheduled task has effective restart-on-failure settings;
- no duplicate Jarvis instance or orphan runtime processes remain.

Worker must never reboot the owner's PC. After all machine gates pass, leave a fresh `PENDING_OWNER_REBOOT_SMOKE` for the owner.

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

Execute `docs/JARVIS_V4_P2_2_1_SUPERVISOR_RECOVERY_TASK.md`, verify the real Windows recovery paths, update evidence/state, commit + push. Do not merge P2.2 before this recovery task is accepted.
