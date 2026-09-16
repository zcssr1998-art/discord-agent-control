# Active task

Current execution specification:

`docs/JARVIS_V4_P2_2_1_SUPERVISOR_RECOVERY_TASK.md`

Branch: `jarvis-v4-p2-2-hardening`

## Why this task is active

P2.2 passed earlier deterministic/machine smoke, but the owner's first real reboot smoke exposed a reliability failure:

- logon Task Scheduler trigger fired and Jarvis initially came ONLINE;
- after ~2503.5s the Bridge exited;
- Supervisor logged `Restarting in 2s...` but no later `Starting bridge` occurred;
- Scheduled Task returned to `Ready` and Jarvis stayed Discord OFFLINE;
- `LastTaskResult = 3221225786` (`0xC000013A`, control-exit class result).

Therefore the reboot smoke is a real FAIL requiring repair.

## Scope

Execute only the focused P2.2.1 recovery task:

1. production Supervisor retries indefinitely with bounded backoff;
2. Task Scheduler restarts Supervisor on unexpected exit;
3. isolate scheduled Supervisor lifetime from Bridge/control-console failures;
4. continuously health-check/recover LiteLLM;
5. add minimal recovery observability;
6. real Windows smoke: kill Bridge, kill LiteLLM, kill Supervisor, and >5 simulated startup failures;
7. update the actual installed scheduled task and verify effective restart settings.

Do not redo P2/P2.1/P2.2, start P3, or add a new service/daemon framework.

## Preserved constraints

- single-instance guard remains authoritative;
- Supervisor remains Level-1 owner of Bridge + LiteLLM;
- Windows Task Scheduler is Level-2 recovery for Supervisor;
- never reboot the owner's machine automatically;
- no secrets in repo/logs;
- retain existing Chat/Work/model/workspace/permission invariants.

## Completion

Update `docs/CURRENT.md`, `docs/AI_HANDOFF.md`, this file, and `docs/V4_P2_2_SMOKE.md`; commit + push.

Final worker reply must use the short response contract defined in the task file.
