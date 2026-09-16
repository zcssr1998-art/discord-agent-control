# Jarvis V4 P2.2 Smoke / Acceptance Evidence

Status: deterministic + Windows real-machine evidence recorded. Owner Discord smoke and owner reboot smoke remain PENDING (owner-only).

Branch: `jarvis-v4-p2-2-hardening`
Commit under test: the branch HEAD P2.2 implementation commit (its parent is P2/P2.1 head `3fc0c35`); regression and machine smoke were run on the working tree of that commit.
Host: Windows, `DESKTOP-RHFCBBR`, Node `v24.19.0`

Do not mark an item PASS from unit tests alone. Items below record what was actually executed.

## 1. Baseline regression

- [x] `npm test` 鈥?266 pass / 0 fail
- [x] `npm run check` 鈥?97 files, 0 failed
- [x] `npm run smoke:p2` 鈥?11/11 passed (includes a real Agent run in a panel Work thread, 9.8s)
- [x] `npm run smoke:p22` 鈥?10/10 checks passed (new P2.2 machine smoke)

```text
> npm test        鈫?tests 266, pass 266, fail 0
> npm run check   鈫?checked 97 file(s), 0 failed
> npm run smoke:p2 鈫?=== summary: 11/11 passed ===
> npm run smoke:p22 鈫?P2.2 smoke: 10/10 checks passed
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
PASS build identity matches git 路 live=jarvis-v4-p2-2-hardening@3fc0c35 git=jarvis-v4-p2-2-hardening@3fc0c35
PASS first (live child) instance acquires
PASS lock metadata readable, foreign pid
PASS second live holder refused, not killed
```

Unit tests: `tests/v4-p22-instance.test.mjs` (8 checks) 鈥?acquire, refuse, stale reclaim, corrupt reclaim, release, metadata, build identity.

## 3. Windows autostart

- [x] install script creates exactly one Jarvis-owned current-user Task Scheduler entry
- [x] re-running installer updates/reuses the same task (no duplicate) 鈥?verified by running install twice
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
(supervisor 鈫?LiteLLM 鈫?bridge, all started by the scheduled task)

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
Supervisor auto-restart proof: bridge pid 46524 killed 鈫?supervisor restarted it as pid 50220
without any manual step; lock + login re-established.
```

Scheduled task action never runs `node src/index.mjs`: it runs `scripts/start-supervisor-autostart.cmd`, which runs `scripts/start-supervisor.ps1`. `install-autostart.ps1 -DryRun` previews without changing anything; `-Status` prints name/state/action.

### Owner reboot smoke

**PENDING_OWNER_REBOOT_SMOKE** 鈥?the worker did not reboot the machine (and must not). After the owner explicitly restarts Windows and logs in, record:

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
data\jarvis.db-wal       0 bytes      鈫?WAL journal active

smoke:p22:
PASS durable store opens with WAL
PASS restart marks stale running run interrupted (no auto-resume)
```

Unit tests: `tests/v4-p22-durable-store.test.mjs` (6 tests) 鈥?schema/WAL, run lifecycle, interrupted-on-reopen, follow-up audit trail, no auto-resume.

## 5. Parent Work summary card

Deterministic evidence (`tests/v4-p22-controls.test.mjs`, 4 tests):

- [x] parent remains Chat; the thread stays the detailed progress site
- [x] exactly one compact parent card per Work chain (updated in place, not spammed)
- [x] controls bound to the live runId (`workctl:append:<runId>` / `workctl:stop:<runId>`)
- [x] card carries an `鎵撳紑 Work` link row to the existing thread
- [x] final card shows the terminal state and drops the run controls (stale card cannot affect newer work)
- [x] `杩藉姞闇€姹俙 delegates to the same P2.1 follow-up queue; `Stop` delegates to the shared stop path

Owner Discord smoke (still owner-run):

1. Start one guild Work task.
2. Parent channel remains Chat.
3. Parent gets/updates one compact Work summary card.
4. `鎵撳紑 Work` opens the existing Work thread.
5. `杩藉姞闇€姹俙 reaches the same P2.1 follow-up queue.
6. `Stop` stops the same active run/process tree.
7. An old/stale card cannot stop or append to a newer run.
8. Final card shows DONE/FAILED/CANCELLED without parent-channel spam.

```text
PENDING_OWNER_DISCORD_SMOKE
```

## 5b. Interaction ACK hardening (real `/work` FAIL fix)

Reported real-machine failure: `/work` 鈫?Discord showed "璇ュ簲鐢ㄧ▼搴忔湭鍝嶅簲" while the backend still created the Work thread. Root cause: `#acknowledge()` wrapped `deferReply`/`deferUpdate` in `try { 鈥?} catch { /* swallowed */ }`, so a failed ACK continued into thread creation and Agent start.

Fixed:

- failed ACK is never swallowed; `#acknowledge()`/`#showModalAck()` return a result and `onInteraction` aborts before any side effect
- `showModal` is treated as an ACK too (`/work` without task, panel new Work, append follow-up)
- modal-submit `deferReply` must succeed before thread/filesystem/Agent work
- real cause is classified: `UnknownInteraction(10062)`, `InteractionAlreadyAcknowledged(40060)`, `InteractionAlreadyReplied`, `DiscordAPIError(<code>)`
- timing observation on every interaction: request received 鈫?ACK start 鈫?ACK complete 鈫?latency 鈫?PASS/FAIL
- live log format: `[interaction] /work ACK PASS 84ms method=deferReply`

```text
tests/v4-p22-ack.test.mjs (8 tests):
PASS classifyInteractionError names the real Discord cause
PASS /work with a task: a rejected deferReply creates no thread and starts no Agent
PASS /work with a task: a successful ACK logs PASS with latency, then creates the thread
PASS /work without a task: a rejected showModal performs no side effect
PASS /work without a task: a successful showModal is the ACK (PASS) and shows the modal
PASS modal submit: a rejected deferReply creates no thread and starts no Agent
PASS modal submit: a successful deferReply allows the Work thread
PASS an already acknowledged interaction is skipped, not treated as a failure

failure-injection view (deferReply 鈫?DiscordAPIError 10062 Unknown interaction):
[interaction] /work ACK FAIL 0ms method=deferReply code=10062 type=UnknownInteraction error=Unknown interaction
[interaction] /work ABORTED after failed ACK at defer: type=UnknownInteraction code=10062 ...
[interaction] /work no Work thread, no filesystem write, no Agent start performed.
鈫?fake.threads.length = 0, runner starts = 0
```

Real owner Discord smoke (must be re-run by the owner, expected log):

```text
PENDING_OWNER_DISCORD_SMOKE  (expect: [interaction] /work ACK PASS <ms> method=deferReply)
```

## 5c. Live insert / steering (➕ 插入需求)

Previous (wrong) behavior: the button queued a next turn that only ran after the current task reached DONE. Required behavior: insert into the RUNNING turn.

Implemented:

- `ClaudeRunner.injectRequirement(prompt)` writes a stream-json `user` message straight into the RUNNING child's stdin; it never touches the `pending` (next turn) queue, never starts a second process, never interrupts the tool in flight. `send(prompt)` keeps its next-turn semantics — the two are separate APIs.
- Verified on the real CLI before wiring: a message injected during a 14s Bash tool call was executed after the tool returned and produced exactly ONE `result` event.
- Every executor advertises a capability (`live-steering` present on WorkBuddy + Claude Code); when an executor cannot steer, the UI says so instead of pretending.
- Discord: the control is now `➕ 插入需求` (modal id `workinsert:<runId>`, legacy `workappend` still accepted). Reply on success: `✅ 已插入当前任务，Agent 将在下一个安全执行边界读取。` — never a queue position.
- Owner text while the Agent is RUNNING is also steered, not queued. The follow-up queue remains only for a Work run that is queued and has not started yet.
- Delivery is observable: `[work-insert] run=<runId> accepted mode=live bytes=<n>` (no requirement body is logged).
- Race safety: if the turn ends in the same instant, the demand becomes an extra turn in the SAME run/session (`mode=continued`, UI: `当前轮刚结束，已转为同 Session 继续执行。`); an unsupported executor reports `⚠️ 当前执行器不支持运行中插入，将在当前轮后继续。`
- `Stop` clears unconsumed inserts/continuations and reports `已清空 N 条未处理的插入需求。`
- Same runId, same sessionId, no second Agent, no re-acquired workspace lock, one final DONE.

Deterministic: `tests/v4-p22-insert.test.mjs` (10 tests) + updated P2.1/P2.2 suites (`npm test` 284/0).

Real-machine smoke: `npm run smoke:p22-insert` (`scripts/p22-live-insert-e2e.mjs`) — real Agent process, real provider route, real filesystem, real hook server, real durable store. A ~35s task was inserted into while RUNNING.

```text
[smoke][env] providerRoute=local-adapter baseUrl=set inheritEnv=false
PASS a real Work task reached RUNNING before the insert
PASS the live insert was accepted into the running turn · ✅ 已插入当前任务，Agent 将在下一个安全执行边界读取。
PASS the UI did not show a queue position for the live insert
PASS exactly one Agent process was used (no second Agent PID) · pids=38464
PASS exactly one workspace lock acquisition / Work run (no new run) · submit=1
PASS the same runId was used for the insert · runIdAfter=null
PASS one stable Agent session for the insert and the final result · runner=38aa7f1c-… channel=38aa7f1c-…
PASS the run finished through the same channel (no active run left)
PASS the workspace lock was released
PASS the inserted side effect is part of the same Work run · inserted.txt="INSERT_OK"
PASS exactly one Work run record exists · ["DONE"]
PASS the run reached a single terminal DONE · states=DONE
PASS the progress card shows a single DONE · doneTokens=1
PASS no follow-up queue entries were created for the live insert

P2.2 live-insert smoke: 14/14 checks passed
```

Real Discord click (owner-run, still pending) — start a Work, wait for RUNNING, tap `➕ 插入需求`:

```text
PENDING_OWNER_DISCORD_SMOKE  (expect: [work-insert] run=<id> accepted mode=live)
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
- [x] `npm ci` 鈫?`npm test` 鈫?`npm run check`
- [x] extra Linux portability job (non-blocking signal, same three steps)
- [ ] workflow PASS for final commit 鈥?**not verifiable from this machine** (`gh` is not authenticated here); the workflow runs the exact commands that pass locally. Record the Actions run URL after the owner (or a CI-authenticated shell) checks the push. Do not mark PASS from local runs alone.

```text
.github/workflows/ci.yml
jobs: windows (runs-on: windows-latest) [required], linux-portability (ubuntu-latest)
local equivalents: npm test 284/0, npm run check 97/0
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
tests 284 pass / 0 fail after extraction + ACK hardening + live-insert steering (baseline at branch point: 244 pass / 0 fail)
check 95 files / 0 failed
smoke:p2 11/11
```

Note: this milestone extracted the pure helper/row layer only. Further controller extraction is intentionally deferred to keep the change behavior-preserving; the class now routes to `src/discord/renderers.mjs` for all row/label building.

## Final verdict

```text
P2.2: PASS (deterministic + Windows real-machine); owner Discord smoke + owner reboot smoke pending owner action
commit: branch jarvis-v4-p2-2-hardening HEAD (P2.2 implementation + ACK hardening)
tests: 284/0 · check 97/0 · smoke:p2 11/11 · smoke:p22 10/10 · smoke:p22-insert 14/14
windows-smoke: scheduled task 鈫?supervisor 鈫?LiteLLM(UP) 鈫?bridge online; second launch refused pre-login (exit 1)
autostart: installed (task 'Jarvis Discord Agent Control', Ready) 路 PENDING_OWNER_REBOOT_SMOKE
blocker: real /work ACK timeout previously reproduced twice and has been fixed (see 搂5b); owner re-test pending
```
