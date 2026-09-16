# AI handoff

Keep this file short and overwrite/update it at every meaningful handoff. Do not paste old chat transcripts here.

## Branch

`jarvis-v4-p2-2-hardening` (stacked on P2/P2.1; do not merge P2.2 yet).

## Active task

`docs/JARVIS_V4_P2_2_1_SUPERVISOR_RECOVERY_TASK.md` — implemented and verified; awaiting owner reboot smoke.

## Current status

The P2.2.1 recovery fix is complete and proven on the real machine (`docs/V4_P2_2_SMOKE.md` §0, 23/23).

Key facts a successor must not re-derive:

- `scripts/start-supervisor.ps1` is unlimited in production (`-MaxRestarts 0`), bounded backoff `2/5/10/30/60/120s`, `>=60s` run resets the counter, and recovers any bridge exit; it also probes/recover LiteLLM every 30s and keeps a supervisor pid file + orphan-bridge reclaim. The bridge runs in its own hidden console (`logs/bridge.log`).
- The installed task action is native `powershell.exe -File <abs>\scripts\start-supervisor.ps1` (the old `cmd.exe -> start-supervisor-autostart.cmd` chain and that file were removed).
- **Task Scheduler restart-on-failure did not restart a killed action process on this machine** (probe reproduced). Level-2 recovery is the `RepetitionInterval PT1M` watchdog trigger with `MultipleInstances=IgnoreNew`; restart-on-failure stays configured too.
- Real smoke: kill bridge / kill LiteLLM / kill supervisor / >5 startup failures all recover automatically. Worker never reboots the machine.

## Remaining

`PENDING_OWNER_REBOOT_SMOKE`. Owner reboots Windows; expected: AtLogOn trigger starts the supervisor, LiteLLM comes up, the bridge reaches Discord ready, `/status` shows the live identity, and a manual second launch is refused by the single-instance guard.

## Preserve

Do not regress P2/P2.1/P2.2 Chat/Work/thread/queue/permissions/model/workspace/live-insert/ACK behavior. Do not start P3. No secrets in repo/logs.

## Delivery

State is recorded in `docs/CURRENT.md`, `docs/tasks/CURRENT.md` and `docs/V4_P2_2_SMOKE.md`. Final worker response follows the short contract in the active task.
