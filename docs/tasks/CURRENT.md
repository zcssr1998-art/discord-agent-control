# Active task

Current execution specification:

`docs/JARVIS_V4_P2_2_1_SUPERVISOR_RECOVERY_TASK.md`

Branch: `jarvis-v4-p2-2-hardening`

## Status

Implemented and verified on the real Windows machine; owner reboot smoke is the only remaining gate.

Evidence: `docs/V4_P2_2_SMOKE.md` §0 — `scripts/smoke-supervisor-recovery.ps1` 23/23, plus `npm test` 316/0, `npm run check` 105/0, `smoke:p2` 11/11, `smoke:p22` 10/10.

## What was done

1. Production supervisor retries indefinitely with bounded backoff (`2/5/10/30/60/120s`, `>=60s` resets); optional finite mode is test-only.
2. Bridge runs in its own hidden console → a bridge/control event can no longer terminate the supervisor.
3. Installed Task Scheduler task updated: native `powershell.exe` action, `ExecutionTimeLimit=unlimited`, `StartWhenAvailable`, `IgnoreNew`, `RestartCount=999`/`PT1M`, plus a `PT1M` watchdog repetition trigger (the reliable Level-2 recovery; Windows restart-on-failure did not fire for a killed action on this machine).
4. LiteLLM health-checked/recovered every 30s while the bridge runs; the recovery launch no longer deadlocks on a piped child.
5. Minimal observability: heartbeat, UP/DOWN + PID, retry-with-delay, recovery lines; no new state DB (`/doctor` unchanged).
6. Real Windows smoke: kill bridge / kill LiteLLM / kill supervisor / >5 simulated failures — all recover; no duplicate bridge; task settings verified.

## Remaining

`PENDING_OWNER_REBOOT_SMOKE` — owner-only; the worker must never reboot the machine.

## Preserved constraints

- single-instance guard remains authoritative;
- Supervisor remains Level-1 owner of Bridge + LiteLLM;
- Windows Task Scheduler is Level-2 recovery for Supervisor;
- no secrets in repo/logs;
- retain existing Chat/Work/model/workspace/permission invariants.

## Completion

State files updated (`docs/CURRENT.md`, `docs/AI_HANDOFF.md`, this file, `docs/V4_P2_2_SMOKE.md`); commit + push.
