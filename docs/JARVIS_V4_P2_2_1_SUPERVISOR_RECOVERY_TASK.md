# Jarvis V4 P2.2.1 — Supervisor / Autostart Recovery Task

## Objective

Make Jarvis a genuinely persistent Windows user-session service using the existing lightweight stack: **Windows Task Scheduler + PowerShell supervisor**.

Success means: while the owner is logged in and the machine is on, Jarvis must eventually recover to Discord ONLINE after bridge crashes, LiteLLM crashes, temporary network/proxy/Discord failures, or an unexpected supervisor exit. No manual restart should be required.

This is a focused P2.2 reliability fix. Do **not** redo P2/P2.1/P2.2 or start P3.

## Read first

Follow repo startup order:

1. `AGENTS.md`
2. central `GLOBAL_AI_RULES.md`
3. `docs/CURRENT.md`
4. `docs/AI_HANDOFF.md`
5. `docs/tasks/CURRENT.md`
6. this task
7. current branch / HEAD / `git status` / relevant diff only

Reuse the existing implementation. Do not rebuild the architecture.

## Real failure evidence

Owner reboot smoke failed on Windows.

Observed sequence after real reboot/logon:

- Task Scheduler task `Jarvis Discord Agent Control` triggered successfully.
- Logon trigger is enabled, current-user scoped, delay `PT15S`.
- Scheduled task launched the autostart wrapper and supervisor.
- LiteLLM became healthy.
- Jarvis bridge started and reached `Discord control plane ready`.
- Bridge then ran for about `2503.5s` (~41m43s) and exited.
- Supervisor logged:
  - `Run lasted >= 60s, resetting crash counter`
  - `Restarting in 2s... (0/5)`
- No later `Starting bridge` appeared.
- Jarvis remained Discord OFFLINE.
- Scheduled task returned to `Ready`.
- `Get-ScheduledTaskInfo` reported `LastTaskResult = 3221225786` (`0xC000013A`, control-C/control-exit class result).
- TaskScheduler Operational log query around 17:10–17:14 did not reveal a more specific owner/cause.

Do **not** treat the exact origin of that control event as a prerequisite to fixing reliability. The product defect is already established: the bridge and its supervisor can both disappear and nothing recovers the service.

`PENDING_OWNER_REBOOT_SMOKE` is therefore currently **FAIL**, not PASS/pending-success.

## Product invariant

As long as:

1. Windows user session is logged in,
2. the machine remains powered on,
3. required repo/runtime files still exist,
4. network/proxy/Discord eventually recover,

Jarvis must eventually return ONLINE.

Temporary failures must not permanently strand the service.

## Required architecture

Keep the current lightweight model:

```text
Windows Task Scheduler
        ↓
Persistent Supervisor
   ├── Jarvis Bridge
   └── LiteLLM
```

Two recovery layers are required:

- **Level 1:** Supervisor continuously keeps Bridge + LiteLLM healthy.
- **Level 2:** Task Scheduler restarts Supervisor if the Supervisor itself exits unexpectedly.

Do not add Windows Service/NSSM/PM2/Docker/Redis/Postgres or another daemon framework.

## A. Supervisor must not permanently give up

Target: `scripts/start-supervisor.ps1`.

Current finite restart behavior (`MaxRestarts=5` / finite while loop) is unsuitable for production autostart.

Production/autostart behavior must retry indefinitely with bounded exponential backoff, for example:

`2s → 5s → 10s → 30s → 60s → 120s`, capped at ~120s.

Requirements:

- no permanent exit after N bridge startup/crash failures in production;
- stable run >= ~60s resets crash/backoff counter;
- keep an optional finite retry/test mode if useful for deterministic tests;
- network/proxy/Discord may be unavailable for hours; supervisor must remain recoverable and retry later;
- do not busy-loop.

## B. Task Scheduler must recover the Supervisor

Target: `scripts/install-autostart.ps1` and current installed task.

Configure the canonical task `Jarvis Discord Agent Control` with Windows-native restart-on-failure semantics.

Required effective settings:

- restart on failure with a short interval (about 1 minute is acceptable);
- sufficiently high restart count so a long outage does not permanently strand Jarvis;
- `ExecutionTimeLimit = unlimited`;
- `StartWhenAvailable = true`;
- allow battery start / do not stop merely because power source changes (preserve current intent);
- one canonical task only; reinstall updates it idempotently.

Do not merely change the installer source. Re-run/update the **actual current Windows scheduled task** and verify its effective settings.

## C. Review and simplify the launch chain where it improves reliability

Current path is approximately:

`Task Scheduler → cmd.exe → start-supervisor-autostart.cmd → powershell.exe → start-supervisor.ps1 → node`.

Prefer the simpler native task action:

`Task Scheduler → powershell.exe -NoProfile -ExecutionPolicy Bypass -File <absolute start-supervisor.ps1>`

with repo root as working directory **if real Windows testing proves it reliable with the current checkout/path**.

If the wrapper is required for path-with-spaces or logging compatibility, keep it. Reliability wins over aesthetic simplification.

Do not leave a console/control-event coupling where killing/crashing the bridge can terminate the supervisor.

## D. Isolate Supervisor lifecycle from Bridge control events

Review Windows behavior around:

- `Start-Process -NoNewWindow`;
- `[Console]::TreatControlCAsInput`;
- `Console.KeyAvailable` / Ctrl+C polling;
- scheduled-task non-interactive execution;
- child process group / console inheritance.

Requirements:

- scheduled-task Supervisor must not depend on an interactive console;
- Bridge crash/control event must not terminate Supervisor;
- manual interactive `start-supervisor.ps1` should still support a clean user stop where practical;
- use the smallest reliable Windows-native implementation, not a new service framework.

Do not claim a specific root cause for `0xC000013A` unless deterministic evidence establishes it.

## E. LiteLLM must also be continuously supervised

Current startup-only health check is insufficient if LiteLLM dies while Bridge remains alive.

Add low-frequency health monitoring (roughly 30–60s is enough):

- probe existing LiteLLM liveliness endpoint;
- if DOWN, recover it using the existing LiteLLM startup path;
- do not restart a healthy LiteLLM;
- do not introduce another independent supervisor.

## F. Minimal health observability

Logs must make recovery diagnosable without high-volume spam.

Useful state-change lines should include equivalents of:

- supervisor started / heartbeat;
- bridge UP/DOWN + PID;
- LiteLLM UP/DOWN + PID when known;
- bridge failed, retrying in X seconds;
- LiteLLM unhealthy, recovering;
- recovery succeeded;
- scheduled-task/supervisor identity where useful.

A heartbeat every ~5 minutes is sufficient; state changes should log immediately.

Reuse `/doctor`; do not create a second state database.

## G. Required real Windows self-healing smoke

Unit tests are not enough. Run focused real-machine smoke on the current Windows machine.

### G1. Scheduled-task start

Start from the installed scheduled task. Verify:

- Supervisor running;
- LiteLLM healthy;
- Bridge reaches Discord ready;
- exactly one Jarvis bridge owns the instance lock.

### G2. Kill Bridge only

Kill the real Bridge process only.

PASS only if:

- Supervisor PID remains alive;
- a new Bridge PID appears automatically;
- Discord bridge returns ready/online;
- no duplicate Jarvis instance exists.

### G3. Kill LiteLLM only

Kill LiteLLM only.

PASS only if:

- Supervisor remains alive;
- LiteLLM is restarted automatically;
- liveliness becomes UP again;
- Jarvis does not become permanently offline.

### G4. Kill Supervisor only

Force-stop the real Supervisor process.

Do **not** manually run a startup script afterward.

PASS only if Windows Task Scheduler restarts Supervisor automatically, which then restores LiteLLM + Bridge and Jarvis returns ready.

This is a critical acceptance gate.

### G5. More than five failures

Using a safe isolated smoke/test fixture (do not destructively modify the user's real proxy), force bridge startup failure >5 times.

PASS only if the production recovery chain remains alive/recoverable and succeeds once the simulated fault is removed.

The old behavior “five failures → permanent death” must be impossible in production mode.

## H. Owner reboot smoke

Worker must **never reboot the owner's PC**.

After all automated/real-machine recovery gates pass, leave:

`PENDING_OWNER_REBOOT_SMOKE`

for the owner to reboot Windows manually.

Before handoff, verify the actual installed task configuration with `Get-ScheduledTask` / `Get-ScheduledTaskInfo` and record key effective settings in smoke evidence.

## I. Workspace issue: focused verification only

Recent boot logs still showed historical `D:\deepseeek` values in channel state/default output although P2.2 introduced first-class workspace resolution.

Do not redesign workspace and do not mass-delete state.

Only verify that **new** startup ready card, `/status`, and new Work launch use the intended `effectiveRuntimeState()` / effective workspace resolution rather than an obsolete historical-run fallback. Fix only if a live path still violates that invariant.

## Non-goals

Do not add or expand:

- P3 market/finance monitoring;
- Longbridge/Futu;
- new model/provider work;
- web dashboard;
- Agent teams/worktrees;
- Redis/Postgres;
- Windows Service/NSSM/PM2/Docker;
- unrelated UI or `discord-ui.mjs` refactors.

## Verification / acceptance

Required before PASS:

- `npm test` PASS;
- `npm run check` PASS;
- existing `npm run smoke:p2` PASS;
- existing `npm run smoke:p22` PASS;
- add a focused supervisor/autostart recovery smoke if needed;
- installed Task Scheduler task has verified restart-on-failure configuration;
- kill Bridge → automatic recovery PASS;
- kill LiteLLM → automatic recovery PASS;
- kill Supervisor → Task Scheduler automatic recovery PASS;
- >5 simulated startup failures do not permanently kill production recovery;
- no duplicate Jarvis bridge;
- no orphan Node/PowerShell/LiteLLM processes left by tests;
- no credentials/secrets logged or committed;
- update repo state/evidence;
- commit + push to `jarvis-v4-p2-2-hardening` unless a concrete reason requires a small stacked fix branch.

Owner reboot remains `PENDING_OWNER_REBOOT_SMOKE` and must not be fabricated.

## Repository updates on completion

Update only as needed:

- `docs/CURRENT.md`
- `docs/AI_HANDOFF.md`
- `docs/tasks/CURRENT.md`
- `docs/V4_P2_2_SMOKE.md`

Keep evidence compact; store detailed logs as artifacts/log files rather than pasting them into chat.

## Stop condition

When the acceptance gates above pass, stop. Do not continue into refactoring, cleanup, P3 planning, or unrelated enhancements.

## Final worker response

Return only:

```text
PASS | FAIL
commit: <sha or none>
tests: <compact result>
windows-smoke: <bridge/litellm/supervisor recovery>
autostart: <effective restart config>
reboot-smoke: PENDING_OWNER
blocker: <none or one key blocker>
```
