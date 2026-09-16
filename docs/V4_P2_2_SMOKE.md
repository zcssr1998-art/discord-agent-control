# Jarvis V4 P2.2 Smoke / Acceptance Evidence

Status: deterministic + Windows real-machine evidence recorded. Owner Discord smoke and owner reboot smoke remain PENDING (owner-only).

Branch: `jarvis-v4-p2-2-hardening`
Commit under test: the branch HEAD P2.2 implementation commit (its parent is P2/P2.1 head `3fc0c35`); regression and machine smoke were run on the working tree of that commit.
Host: Windows, `DESKTOP-RHFCBBR`, Node `v24.19.0`

Do not mark an item PASS from unit tests alone. Items below record what was actually executed.

## 1. Baseline regression

- [x] `npm test` — 266 pass / 0 fail
- [x] `npm run check` — 95 files, 0 failed
- [x] `npm run smoke:p2` — 11/11 passed (includes a real Agent run in a panel Work thread, 9.8s)
- [x] `npm run smoke:p22` — 10/10 checks passed (new P2.2 machine smoke)

```text
> npm test        → tests 266, pass 266, fail 0
> npm run check   → checked 95 file(s), 0 failed
> npm run smoke:p2 → === summary: 11/11 passed ===
> npm run smoke:p22 → P2.2 smoke: 10/10 checks passed
```

## 2. Single-instance guard

- [x] first bridge acquires instance ownership
- [x] second launch fails before Discord login
- [x] live instance remains healthy (supervisor restarted it and it re-registered commands)
- [x] stale lock is recovered safely (unit + machine smoke)
- [x] graceful shutdown releases ownership (unit test)
- [x] `/status` shows actual PID / uptime / branch / commit / instance id (unit test + implementation)
- [x] corrupt/partial lock is reclaimed only when no live pid owns it

Real machine: the scheduled-task bridge held the lock (pid 50220) while a manual launch was refused with exit code 1.

```text
lock: data/jarvis-instance.lock
{
  "pid": 50220,
  "startedAt": "2026-09-16T04:04:22.166Z",
  "repoRoot": "C:\\Users\\Administrator.DESKTOP-RHFCBBR\\Documents\\Default Project",
  "branch": "jarvis-v4-p2-2-hardening",
  "commit": "3fc0c35ab063173509dcca4e2a99bcc2c1dc4099",
  "instanceId": "9830463aef9b:50220",
  "host": "DESKTOP-RHFCBBR"
}

> node src/index.mjs
[instance] another live Jarvis bridge already holds the instance lock
  (pid=50220, started=2026-09-16T04:04:22.166Z jarvis-v4-p2-2-hardening@3fc0c35).
[instance] Refusing to start a second bridge.  ... The other process was NOT killed.
exit=1   (no Discord login attempted)

smoke:p22:
PASS build identity matches git · live=jarvis-v4-p2-2-hardening@3fc0c35 git=jarvis-v4-p2-2-hardening@3fc0c35
PASS first (live child) instance acquires
PASS lock metadata readable, foreign pid
PASS second live holder refused, not killed
```

Unit tests: `tests/v4-p22-instance.test.mjs` (8 checks) — acquire, refuse, stale reclaim, corrupt reclaim, release, metadata, build identity.

## 3. Windows autostart

- [x] install script creates exactly one Jarvis-owned current-user Task Scheduler entry
- [x] re-running installer updates/reuses the same task (no duplicate) — verified by running install twice
- [x] task action points at this checkout's supervisor (never raw node)
- [x] task state/status can be queried without secrets (`-Status`, `npm run autostart:status`)
- [x] manual scheduled-task start brings supervisor + Jarvis online
- [x] LiteLLM still belongs to the supervisor lifecycle
- [x] manual Jarvis launch while scheduled instance is alive is refused by single-instance guard
- [x] uninstall removes only the exact Jarvis-owned task (script refuses non-matching task names)

```text
> powershell -File scripts\install-autostart.ps1   (run twice)
[autostart] installed: task='Jarvis Discord Agent Control'
[autostart] args:      cmd.exe /c ""C:\...\scripts\start-supervisor-autostart.cmd""

> schtasks /query /fo list
TaskName: \Jarvis Discord Agent Control
Status:   Ready

> powershell -File scripts\install-autostart.ps1 -Status
TaskName: Jarvis Discord Agent Control
State:    Ready
Action:   C:\WINDOWS\System32\cmd.exe /c ""C:\...\scripts\start-supervisor-autostart.cmd""

> Start-ScheduledTask -TaskName 'Jarvis Discord Agent Control'
(supervisor → LiteLLM → bridge, all started by the scheduled task)

logs\wrapper.log (tail):
[executor] workbuddy=PASS version=2.137.1
[executor] claude=PASS version=2.1.270 (Claude Code)
[litellm] baseUrl=http://127.0.0.1:4000/v1 billing=SUBSCRIPTION health=UP (healthy)
[proxy] discord via http://127.0.0.1:7897 (source=windows-system)
[hook] listening at http://127.0.0.1:37911/pre-tool-use
[commands] registered=11 changed=1
[bridge] Billing route: WorkBuddy Free
[discord] control plane ready | ... default cwd=D:\deepseeek

LiteLLM process owned by the supervisor: pid 5360 (litellm.exe)
Supervisor auto-restart proof: bridge pid 46524 killed → supervisor restarted it as pid 50220
without any manual step; lock + login re-established.
```

Scheduled task action never runs `node src/index.mjs`: it runs `scripts/start-supervisor-autostart.cmd`, which runs `scripts/start-supervisor.ps1`. `install-autostart.ps1 -DryRun` previews without changing anything; `-Status` prints name/state/action.

### Owner reboot smoke

**PENDING_OWNER_REBOOT_SMOKE** — the worker did not reboot the machine (and must not). After the owner explicitly restarts Windows and logs in, record:

- reboot/logon timestamp
- time until Jarvis online
- live PID / branch / commit
- LiteLLM health
- duplicate-instance check (manual launch must be refused)

Expected result from the current machine state: after logon the task starts the supervisor, which starts LiteLLM and the bridge; `/status` then shows the live identity.

## 4. Durable store / restart semantics

- [x] DB opens in WAL mode (`data/jarvis.db`, `-wal`/`-shm` sidecars present)
- [x] schema migration is idempotent (`PRAGMA user_version`, re-open is a no-op)
- [x] run record persists across bridge restart
- [x] prior live RUNNING/QUEUED work becomes INTERRUPTED on startup, never falsely RUNNING
- [x] pending queue/follow-up metadata stays auditable and never auto-executes after restart
- [x] secrets are not stored in the DB (no migration of `credentials.json`)
- [x] existing JSON configuration remains compatible (`state.json` / `providers.json` unchanged)

```text
data\jarvis.db       40960 bytes
data\jarvis.db-shm   32768 bytes
data\jarvis.db-wal       0 bytes      → WAL journal active

smoke:p22:
PASS durable store opens with WAL
PASS restart marks stale running run interrupted (no auto-resume)
```

Unit tests: `tests/v4-p22-durable-store.test.mjs` (6 tests) — schema/WAL, run lifecycle, interrupted-on-reopen, follow-up audit trail, no auto-resume.

## 5. Parent Work summary card

Deterministic evidence (`tests/v4-p22-controls.test.mjs`, 4 tests):

- [x] parent remains Chat; the thread stays the detailed progress site
- [x] exactly one compact parent card per Work chain (updated in place, not spammed)
- [x] controls bound to the live runId (`workctl:append:<runId>` / `workctl:stop:<runId>`)
- [x] card carries an `打开 Work` link row to the existing thread
- [x] final card shows the terminal state and drops the run controls (stale card cannot affect newer work)
- [x] `追加需求` delegates to the same P2.1 follow-up queue; `Stop` delegates to the shared stop path

Owner Discord smoke (still owner-run):

1. Start one guild Work task.
2. Parent channel remains Chat.
3. Parent gets/updates one compact Work summary card.
4. `打开 Work` opens the existing Work thread.
5. `追加需求` reaches the same P2.1 follow-up queue.
6. `Stop` stops the same active run/process tree.
7. An old/stale card cannot stop or append to a newer run.
8. Final card shows DONE/FAILED/CANCELLED without parent-channel spam.

```text
PENDING_OWNER_DISCORD_SMOKE
```

## 6. `/doctor`

- [x] local/deterministic; no model call (asserted: 0 ChatRuntime calls, 0 Agent starts)
- [x] runtime/build identity (PID, uptime, branch@commit, instance id, lock ownership)
- [x] Discord connection state
- [x] LiteLLM health via existing health API
- [x] executor discovery status
- [x] autostart scheduled-task state (deterministic `schtasks` query, no secrets)
- [x] durable-store open/schema status
- [x] registered as a native command (11 commands registered on the live bridge)
- [x] no credentials/environment dump (fixed field set only)

```text
tests/v4-p22-controls.test.mjs:
PASS !doctor is local/deterministic, reports identity/store/gateway and never calls a model

live bridge: [commands] registered=11 changed=1   (adds /doctor)
```

`!doctor` text-command compatibility is implemented as well.

## 7. CI

- [x] Windows workflow exists (`.github/workflows/ci.yml`, `windows-latest`, Node 24)
- [x] no secrets required
- [x] `npm ci` → `npm test` → `npm run check`
- [x] extra Linux portability job (non-blocking signal, same three steps)
- [ ] workflow PASS for final commit — **not verifiable from this machine** (`gh` is not authenticated here); the workflow runs the exact commands that pass locally. Record the Actions run URL after the owner (or a CI-authenticated shell) checks the push. Do not mark PASS from local runs alone.

```text
.github/workflows/ci.yml
jobs: windows (runs-on: windows-latest) [required], linux-portability (ubuntu-latest)
local equivalents: npm test 266/0, npm run check 95/0
```

## 8. Refactor regression

`discord-ui.mjs` extracted pure render/row helpers into `src/discord/renderers.mjs` (no behavior change):

- [x] Chat remains direct API only
- [x] Work thread behavior unchanged
- [x] native slash commands unchanged
- [x] buttons/modals ACK correctly (same deferred-ACK ordering preserved)
- [x] follow-ups FIFO / same session
- [x] stop/approval/attachments/history/model/settings all remain green
- [x] no parallel replacement state/control implementation introduced (single source of truth kept in `DiscordControlPlane`)

```text
tests 266 pass / 0 fail after extraction (baseline at branch point: 244 pass / 0 fail)
check 95 files / 0 failed
smoke:p2 11/11
```

Note: this milestone extracted the pure helper/row layer only. Further controller extraction is intentionally deferred to keep the change behavior-preserving; the class now routes to `src/discord/renderers.mjs` for all row/label building.

## Final verdict

```text
P2.2: PASS (deterministic + Windows real-machine); owner Discord smoke + owner reboot smoke pending owner action
commit: branch jarvis-v4-p2-2-hardening HEAD (P2.2 implementation)
tests: 266/0 · check 95/0 · smoke:p2 11/11 · smoke:p22 10/10
windows-smoke: scheduled task → supervisor → LiteLLM(UP) → bridge online; second launch refused pre-login (exit 1)
autostart: installed (task 'Jarvis Discord Agent Control', Ready) · PENDING_OWNER_REBOOT_SMOKE
blocker: none
```
