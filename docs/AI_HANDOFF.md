# AI handoff

Keep this file short and overwrite/update it at every meaningful handoff. Do not paste old chat transcripts here.

## Branch

`jarvis-v4-p2-2-hardening` (stacked on P2/P2.1; do not merge P2.2 yet).

## Active task

`docs/JARVIS_V4_P2_2_1_SUPERVISOR_RECOVERY_TASK.md`

## Current status

P2.2 baseline exists, but the owner's first real reboot smoke exposed a reliability failure that reopens hardening work.

Observed:

- logon Scheduled Task triggered and Jarvis initially reached Discord ready;
- Bridge ran ~2503.5s, then exited;
- Supervisor logged `Restarting in 2s...` but never started a new Bridge;
- Scheduled Task returned to `Ready`; Jarvis stayed OFFLINE;
- `LastTaskResult = 3221225786` / `0xC000013A` (control-exit class result).

Exact origin of the control event is unproven and is not a prerequisite. The defect is the missing recovery layer when Supervisor exits.

## Required recovery model

- Level 1: persistent Supervisor continuously recovers Bridge + LiteLLM with bounded backoff and no production five-failure give-up.
- Level 2: Windows Task Scheduler restarts Supervisor if Supervisor exits unexpectedly.
- Keep the existing single-instance guard.
- No Windows Service/NSSM/PM2/Docker or other new daemon framework.

## Real acceptance gates

Worker must prove on Windows:

1. scheduled-task startup;
2. kill Bridge → Supervisor survives and Bridge auto-recovers;
3. kill LiteLLM → LiteLLM auto-recovers;
4. kill Supervisor → Task Scheduler restarts it with no manual startup command;
5. >5 safe simulated startup failures do not permanently strand recovery;
6. actual installed task has restart-on-failure settings.

Never reboot the owner's PC. After these pass, leave a fresh `PENDING_OWNER_REBOOT_SMOKE` for owner-only validation.

## Preserve

Do not regress P2/P2.1/P2.2 Chat/Work/thread/queue/permissions/model/workspace/live-insert/ACK behavior. Do not start P3. No secrets in repo/logs.

## Delivery

Update `docs/CURRENT.md`, this handoff, `docs/tasks/CURRENT.md`, and `docs/V4_P2_2_SMOKE.md`; commit + push to the active branch. Final response must follow the short contract in the active task.
