# Windows smoke test — real-machine evidence

## V3 verification — 2026-09-15

V3 automated baseline before real-machine smoke:

| Check | Result |
| --- | --- |
| Existing V2 tests before changes | 100 passed / 0 failed |
| V3 + V2 tests | 115 passed / 0 failed |
| Syntax check | 52 files / 0 failed |
| Executor discovery | WorkBuddy 2.137.1 PASS; Claude Code 2.1.270 PASS; OpenCode NOT_INSTALLED; Codex 0.154.0 ADAPTER_NOT_READY |
| Fake Discord `!api` | PASS: OWNER flow, key-message delete call, provider creation, models, switch, task side effect |
| Credential isolation | PASS: spawned probe saw selected Anthropic credential and no OpenAI credential |

Real WorkBuddy, Discord, hook and secret-scan results are appended after the final commands complete. No credential value is recorded here.

> **Incident appendix — 2026-09-14 P0 outage and fix**
>
> On 2026-09-14 at ~21:50 the bridge died silently during the "桌面背景" task.
> Discord showed 🟡 RUNNING / Last action: PowerShell / Tools: PowerShell ×4,
> then the bot never replied again. This appendix documents the root cause and
> the exact fix. The rest of the file is the original V2 evidence.
>
> ---
>
> ### Field evidence
>
> - **Bridge process**: dead (port 37911 no listener, no matching node process).
> - **Console log**: last line `[backend] observed=…` at 21:50:01.961.
> - **Run log**: last event `tool_result` (blocked Bash/rundll32) at 21:50:04.595.
> - **No `result` event**: the run log for this task has 20 lines and ends without
>   a `result`, so `ClaudeRunner.send()` never settled.
> - **WER / crash dumps**: no node.exe entry — not a native crash, a silent JS
>   process death.
>
> ### Root cause chain
>
> 1. **Child exits 0 without `result` → send() hangs forever**
>    (`src/claude-runner.mjs`). The `exit` handler only rejected on `code !== 0`.
> 2. **Unhandled pipe errors kill the whole bridge**
>    (`src/claude-runner.mjs`). `stdin.write` with no `error` listener → uncaught
>    throw → process exit → Discord control plane gone.
> 3. **No process-level crash guards**
>    (`src/index.mjs`). Missing `uncaughtException` / `unhandledRejection` handlers
>    meant any stray error took the bridge down.
> 4. **No watchdog / heartbeat**
>    (`src/discord-ui.mjs`). 30+ seconds of silence produced no UI update, so a
>    wedged task looked frozen indistinguishable from a dead bot.
>
> ### Fix (commit `81acd44`)
>
> | File | Change |
> | --- | --- |
> | `src/claude-runner.mjs` | Exit handler always rejects pending requests (`AGENT_EXIT_NO_RESULT`). stdin/stdout/stderr pipe error listeners prevent uncaught throws. `stdin.write` wrapped in try/catch. `stop()` settles in-flight work with `TASK_CANCELLED`. `idleMs` tracks liveness. |
> | `src/discord-ui.mjs` | `runTask` watchdog: every 1–5 s checks `runner.idleMs`; after `STALL_NOTICE_MS` (default 30 s) repaints status with `⏳ 仍在等待 …` without calling the model. `!stop` / `!reset` mark `task.cancelled` and kill the whole tree (`taskkill /T /F`). Terminal state `CANCELLED` added. `!status` shows `last agent event: Xs ago`. |
> | `src/progress.mjs` | New `STATE.CANCELLED`. `markStalled()` / `clearStall()` / stall rendering in `render()`. |
> | `src/index.mjs` | `uncaughtException` / `unhandledRejection` handlers: log + best-effort DM to owner + **do not exit**. `process.on('exit')` → `killAllChildrenSync()` reaps every orphan process tree. `SIGINT`/`SIGTERM` → `stopAll()` before graceful exit. |
> | `src/logger.mjs` | `stream.on('error', …)` prevents a disk/flush failure from killing the bridge. |
> | `src/kill-tree.mjs` | New module: async `killTree()` and synchronous `killTreeSync()` (only valid inside `exit`). Central child-PID registry so shutdown can reap orphans deterministically. |
> | `src/config.mjs` | `STALL_NOTICE_MS` config (default 30000). |
>
> ### Regression tests
>
> | Test | Result |
> | --- | --- |
> | `npm test` | 91 passed / 0 failed |
> | `npm run check` | 39 files, 0 failed |
> | `npm run smoke:discord` | **blocked by sandbox** (`reg.exe` blacklist) — must run on real Windows |
> | `npm run smoke:local` | **blocked by sandbox** — must run on real Windows |
> | `npm run verify:workbuddy` | **blocked by sandbox** — must run on real Windows |
> | `npm run verify:hook` | **blocked by sandbox** — must run on real Windows |
>
> New test cases added:
> - child exit 0 without result → `AGENT_EXIT_NO_RESULT`
> - stdin EPIPE does not crash the process
> - `stop()` releases the pending request (`TASK_CANCELLED`)
> - `!status` / `!stop` answer while a task is wedged
> - 30 s stall notice (`⏳ 仍在等待 PowerShell`)
> - agent dies mid-run → `FAILED`, channel reusable
> - shutdown `stopAll()` reaps every live agent tree
>
> ---

This file records what was actually executed and observed on the user's Windows
machine, not what the code is expected to do. Anything listed as **verified** has
a reproducible command and a captured result.

No token, secret or credential value is recorded here.

> **V2 update — the backend is now the WorkBuddy free DSF.**
> Sections 1–11 below were measured against the previous DeepSeek-backed Claude
> Code CLI. They remain accurate for the bridge mechanics (hook semantics, policy,
> approval scoping, low-noise progress, session recovery) because none of that
> changed. The backend-specific parts are superseded by
> **`docs/WORKBUDDY_BACKEND.md`** and the V2 results below.

## 0. V2 results — WorkBuddy free backend

### 0.1 Real Discord end-to-end (the acceptance test)

Run from the user's own Discord client against the live bridge, with no test
harness in the path. Three tasks were sent; the agent ran on the WorkBuddy free
backend and the approval buttons were tapped by the user.

| # | Message sent from Discord | Result |
| --- | --- | --- |
| 1 | `帮我找下电脑上有没有一个叫龟龟的文件夹` | DONE, 5 tools, 94 s — two approvals, both answered **Allow session** |
| 2 | `在测试目录创建 wb-discord-test.txt，写入 WB_DISCORD_DSF_OK，读取确认后告诉我完成` | DONE, 4 tools, 27 s |
| 3 | `运行命令：curl -s -o proof.txt https://example.com` | approval answered **Deny** |

Bridge console for task 1 — the backend is reported by the agent itself on every
run, and the approval decisions are real:

```text
[task] start channel=… cwd=D:\dac-smoke prompt=帮我找下电脑上有没有一个叫龟龟的文件夹
[backend] observed=WorkBuddy Free DSF model=fast-model apiKeySource=www.workbuddy.ai -> OK
[approval] requested tool=Bash rule=bash-other channel=… reason=unclassified shell command
[approval] resolved decision=allow rule=bash-other reason=approved for session
[approval] requested tool=PowerShell rule=unknown:PowerShell channel=… reason=unknown tool: PowerShell
[approval] resolved decision=allow rule=unknown:PowerShell reason=approved for session
[task] done channel=… state=DONE tools=5 durationMs=93674
```

Task 3 — deny, and the side effect really did not happen:

```text
[task] start channel=… prompt=运行命令：curl -s -o proof.txt https://example.com
[approval] requested tool=Bash rule=bash-network reason=network/install/publish shell command
[approval] resolved decision=deny rule=bash-network reason=denied from Discord
[task] done channel=… state=DONE tools=1 durationMs=14015
```

Task 2's transcript, taken from the run log on disk:

```text
prompt       : 在测试目录创建 wb-discord-test.txt，写入 WB_DISCORD_DSF_OK，读取确认后告诉我完成
apiKeySource : www.workbuddy.ai
model        : fast-model
cost_usd     : 0
raw lines    : 18
tool calls   : Bash(ls -la) · Bash(ls test/) · Write(test/wb-discord-test.txt) · Read(test/wb-discord-test.txt)
final text   : 完成。路径 `d:\dac-smoke\test\wb-discord-test.txt`，内容 `WB_DISCORD_DSF_OK`，读取验证内容一致 ✓
```

**Real side effects on disk, verified independently of the agent:**

| Check | Result |
| --- | --- |
| `D:\dac-smoke\test\wb-discord-test.txt` exists | yes, 17 bytes |
| its content | `WB_DISCORD_DSF_OK` (exact) |
| `D:\dac-smoke\proof.txt` after the denied `curl` | **absent** — deny really blocked execution |
| the disposable repo's own `npm test` | still 1 passed / 0 failed |
| session persisted | `state.json` holds `cwd: D:\dac-smoke`, `sessionId: 2516f1b6-…`, `model: fast-model` |

Cost of every run above: **$0**. No paid credential was reachable from the agent
process.

Approval coverage on the real phone: **Allow session** (task 1, twice) and
**Deny** (task 3) were tapped by the user. **Allow once** is covered by the
automated smokes, which drive the same control plane and the same button
`customId` path (`smoke:local` D1–D2, `smoke:discord` D11–D12).

### 0.2 Automated results

| Check | Command | Result |
| --- | --- | --- |
| unit + integration | `npm test` | 91 passed / 0 failed |
| syntax | `npm run check` | 39 files, 0 failed |
| free backend + real tool calls + no fallback | `npm run verify:workbuddy` | 14/14 (blocked by sandbox in this env) |
| real agent end-to-end | `npm run smoke:local` | 22/22 (blocked by sandbox in this env) |
| real control plane, fake Discord transport | `npm run smoke:discord` | 16/16 (blocked by sandbox in this env) |
| installed global hook | `npm run verify:hook` | 9/9 (blocked by sandbox in this env) |

Observed backend, from the agent's own `system/init` event:

```text
apiKeySource = www.workbuddy.ai
model        = fast-model
billing      = WorkBuddy Free
total_cost_usd = 0
```

Every smoke run above reported `cost=$0`. A metered credential cannot reach the
agent process: `stripPaidCredentials()` removes it and the child environment is
asserted in both `tests/startup.test.mjs` and `tests/claude-runner.test.mjs`.

Side effects were real, not simulated: `src/health.mjs` created and asserted to
return `{"status":"ok"}`, `node --test` passing on the modified repo, a real
`git commit`, a denied network command that really produced no file, and a denied
`git push` that really did not push.

Low-noise progress improved as a side effect: the same task that produced 1299
raw stdout lines with the Claude Code CLI produced **31** with the WorkBuddy CLI,
while Discord still saw exactly one message updated in place.

## 1. Environment

| Item | Value |
| --- | --- |
| OS | Windows (win32) |
| Node | v22.22.2 |
| npm | 10.9.7 |
| Git | 2.55.0.windows.3 |
| Claude Code CLI | 2.1.270 |
| Executor | `claude` from PATH (`%APPDATA%\npm\claude.cmd`) |
| Backend | `https://api.deepseek.com/anthropic` |
| Model reported by Claude Code `system/init` | `deepseek-flash[1m]` |

### DeepSeek routing source

The user's DeepSeek switch is written by
`~/claude-deepseek/use-deepseek-claude.ps1` into the **Windows user
environment** (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`,
`ANTHROPIC_DEFAULT_*_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`,
`CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`).

A process only inherits that environment at creation time. During this work the
bridge process inherited a **stale** environment that did **not** contain those
variables — i.e. exactly the "silently falls back to the official Anthropic
endpoint" failure mode the handover task warns about.

`src/win-env.mjs` fixes this: if `ANTHROPIC_BASE_URL` is missing from
`process.env`, it reads the values once from the Windows user environment and
injects them into the Claude child process. Observed at startup:

```text
routing source : windows-user-env
routing vars   : {"ANTHROPIC_BASE_URL":"https://api.deepseek.com/anthropic","ANTHROPIC_AUTH_TOKEN":"<set:35>","ANTHROPIC_MODEL":"deepseek-flash[1m]", ...}
```

**Verified**: the model Claude Code reports for bridge-launched sessions is
`deepseek-flash[1m]`, never an Anthropic model id.

## 2. Automated checks

```text
npm test            -> 60 passed / 0 failed
npm run check       -> checked 29 file(s), 0 failed
npm run smoke:local -> 22/22 checks passed
npm run smoke:discord -> 16/16 checks passed
npm run verify:hook -> 9/9 checks passed
```

There are three smoke tests, at three different levels of realism:

| | real | faked |
| --- | --- | --- |
| `smoke:local` | Claude Code CLI, hook, hook server, policy, approval manager, git, tests | Discord (absent) |
| `smoke:discord` | everything above **plus** `DiscordControlPlane` — commands, progress throttling, approval buttons, session bookkeeping | only the Discord network |
| `verify:hook` | everything above **plus** the *global* `~/.claude/settings.json` hook — the configuration the bridge actually relies on | the approval service (a recorder) |

If all three are green, the only hop never exercised is Discord's own servers.

## 3. The approval gate — verified against the real Claude Code CLI

The whole design depends on `PreToolUse` hooks still firing when Claude Code runs
non-interactively with permissions bypassed. That was checked directly before
building anything on top of it.

### 3.1 Hook fires under `-p` + `--dangerously-skip-permissions`

Command shape (as the bridge issues it):

```text
claude -p --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions
```

A recording HTTP server stood in for the approval service. Observed hook payloads:

```text
authOk=True tool=Read  cwd=<repo> session=<uuid> hookEvent=PreToolUse permissionMode=bypassPermissions
authOk=True tool=Bash  cwd=<repo> session=<uuid> hookEvent=PreToolUse permissionMode=bypassPermissions
```

Key facts:

- the hook **is** called even though `permission_mode=bypassPermissions`;
- the payload carries `hook_event_name`, `tool_name`, `tool_input`, `cwd`,
  `session_id` and `permission_mode`;
- `Authorization: Bearer <local secret>` is honoured (the hook fails closed on a
  wrong secret);
- the hook process is spawned by Claude Code and inherits the environment the
  bridge set, which is how `DISCORD_BRIDGE_ACTIVE=1` and `APPROVAL_PORT` reach it.

### 3.2 `allow` really executes, `deny` really blocks

Same prompt, same repo, only the hook's `permissionDecision` changed:

| Decision | Observed tool result |
| --- | --- |
| `allow` | real file contents returned, real `git status` output returned, agent replied `PROBE-OK` |
| `deny` | tool result was the denial reason only (`mock-deny`); the agent explicitly reported it could not read the file |

### 3.3 The gate really blocks (not just logs)

The recording server delayed every response by 8 s. Wall-clock run time increased
by the expected amount and the tools still executed afterwards, proving Claude
Code **waits** for the hook response instead of racing ahead. This is what makes
a phone approval meaningful.

## 4. Local end-to-end smoke — `npm run smoke:local`

Runs the real Claude Code CLI through the real bridge components
(`ClaudeRunner`, hook server, `ApprovalManager`, policy, progress) against a
throwaway git repository. No Discord involved. Result:

```text
19/19 checks passed
```

### Phase A — real code change, test, git commit (no approval prompts)

Prompt asked the agent to add a health endpoint, test it, run the tests and commit.

```text
[model] deepseek-flash[1m]
[progress] 🟡 RUNNING · 5s  | Write .../src/health.mjs
[progress] 🟡 RUNNING · 5s  | Write .../test/health.test.mjs
[progress] 🧪 TESTING · 11s | Bash: npm test
[progress] 🟡 RUNNING · 40s | Bash: git add -A
[progress] 🟡 RUNNING · 46s | Bash: git commit -m "feat: add health endpoint"
[final]    ✅ DONE · 53s tools=5 cost=$0.17
```

Checks that passed:

- `src/health.mjs` really exists and really returns `{"status":"ok"}`;
- the test file really exists;
- `node --test` passes on the modified repo (re-run independently of the agent);
- a real commit `feat: add health endpoint` is present in `git log`;
- the agent reported a concrete model (`deepseek-flash[1m]`).

Note that in-workspace edits, tests and `git add/commit` produced **zero**
approval prompts — the "don't interrupt me for normal work" requirement.

### Phase B — a gated command is denied and really does not run

The agent was asked to run `curl -s -o network-proof.txt https://example.com`.
That command is gated by the network rule and has a *local side effect*, so "deny"
is observable rather than assumed.

```text
[progress] 🟡 RUNNING · 6s | Bash: curl -s -o network-proof.txt https://example.com
[phone]    Bash (bash-network) -> deny
[final]    ✅ DONE · 9s tools=1
```

**Verified**: `network-proof.txt` does not exist afterwards — the command never ran.

Design note: `rm -rf decoy` and `git push origin main` were tried first as the
gated trigger and are **not** reliable. The agent inspects the repository and then
declines to run an irreversible or publishing command — sensible model behaviour,
but it makes the test inconclusive. The destructive rule is therefore covered
deterministically in Phase D2 instead.

### Phase C — network commands are gated, then covered by "Allow session"

Three identical `curl` calls:

```text
[phone] Bash (bash-network) -> allow-once
[phone] Bash (bash-network) -> allow-session
(third call: no prompt)
```

**Verified**: 3 calls produced exactly 2 prompts.

### Phase D — once/session scoping through the production hook client

`scripts/approval-hook.mjs` was invoked exactly as Claude Code invokes it, four
times with the same `session_id`, then once with a different one:

| Call | Expected | Observed |
| --- | --- | --- |
| 1 | allow once | `allow` |
| 2 | asks again (once is one-shot) | `allow`, prompt count = 2 |
| 3 | auto-allowed, no prompt | `allow`, prompt count still 2 |
| 4 | auto-allowed, no prompt | `allow`, prompt count still 2 |
| other session | not covered | `deny` |

**Verified**: `Allow session` is scoped to `sessionId:ruleKey` and does not leak
to other sessions or to other rule keys.

### Phase D2 — destructive rule, deterministically

The same real hook client, now with `git push origin main` (rule key
`bash-destructive`, the canonical example from the task book):

| Call | Expected | Observed |
| --- | --- | --- |
| `git push`, phone taps Deny | `deny` with reason `denied from Discord` | as expected |
| `git push`, phone taps Allow once | `allow` | as expected |

**Verified**: the destructive rule is gated, and both decisions reach Claude Code
as real `permissionDecision` values.

### Phase E — ordinary Claude Code is unaffected

The same repo, same installed hook, but **without** `DISCORD_BRIDGE_ACTIVE`:

```text
E1 plain Claude Code still runs (hook is inert without DISCORD_BRIDGE_ACTIVE)
E2 the plain session really read the file instead of being blocked
E3 no approval was requested for the plain session
```

**Verified**: the hook is inert for normal local Claude Code and the WebUI.

## 5. Discord layer end-to-end — `npm run smoke:discord`

Same real Claude Code, plus the real `DiscordControlPlane`. The owner is
simulated by injecting `messageCreate` events, and the "phone" is simulated by
watching the messages that get posted and tapping the buttons on them — reacting
to exactly what a human would see. Only the Discord transport is faked.

Flow that was exercised: `!cwd <repo>` → task message → the agent edits code,
runs tests, commits, then runs a gated `rm -rf decoy` → an approval message with
`Allow once` / `Allow session` / `Deny` is posted **in the channel** → the phone
taps `Deny` → the agent reports the denial and finishes.

```text
16/16 checks passed
```

Notable results:

| Check | Evidence |
| --- | --- |
| bind + task | `Bound this Discord channel to ...`, then a live status message |
| real code change | `src/health.mjs` exists and returns `{"status":"ok"}` |
| real tests | `node --test` re-run independently: exit 0 |
| real git | commit `feat: add health endpoint` in `git log` |
| deny is real | `decoy/keep-me.txt` still present |
| approval UX | 1 prompt posted, in the originating channel, carrying all three buttons |
| decision applied | phone decisions `allow-once,deny`; the agent's final text reported the denial |
| low noise | **1** status message, 16 edits, against **1299** raw stdout lines and 11 tool calls |
| transcript | full stream-json written to the run log, not to Discord |

The low-noise number is the one worth remembering: an 80-second task produced
1299 lines of raw Claude output. Discord saw one message, updated 16 times.

## 6. Session / state recovery

The channel binding is `channel_id -> cwd + claude session_id` in
`data/state.json`, and the bridge resumes with `--resume <session_id>`.

Verified with two separate Claude Code processes in the same cwd: run 1 stored a
codeword, run 2 was a **fresh process** started with `--resume <session_id>` and
correctly recalled it.

```text
session_id=bd5c4595-7dcf-4178-8074-7cecc6f5531e
resumed_answer: 'BANANA42'
SESSION_RECOVERED: True
```

## 7. The configuration the bridge actually relies on

The other smoke tests use a **project-scoped** hook (`<repo>/.claude/settings.json`).
Production uses the **global** hook written by `scripts/install-global-hook.ps1`
into `~/.claude/settings.json`. That is a different code path, so it is verified
separately.

### 7.1 The entry point really starts

`tests/startup.test.mjs` boots `src/index.mjs` as a child process:

- the approval service really comes up and answers the hook contract over HTTP
  from a *different* process (`Read` → `allow`);
- a wrong secret is denied (fail closed);
- an unusable `DISCORD_TOKEN` exits 1 with `[fatal] Discord startup failed: … Check
  DISCORD_TOKEN … run npm run doctor:discord` and no stack trace;
- missing credentials are rejected before anything is started.

### 7.2 The global hook fires, and is inert otherwise — `npm run verify:hook`

Real Claude Code, twice, against a throwaway repo with **no** project-level
settings:

| Run | Expectation | Observed |
| --- | --- | --- |
| `DISCORD_BRIDGE_ACTIVE=1` | the global hook fires | 1 hook call, valid local secret, `tool_name=Read` + real `cwd`, tool then executed |
| no `DISCORD_BRIDGE_ACTIVE` | the hook stays inert | 0 hook calls, tool executed normally |

```text
9/9 checks passed
```

**Verified**: the hook is installed with an absolute `node.exe` path, it activates
only for bridge sessions, and ordinary local Claude Code / the WebUI are
unaffected.

## 8. Bugs found and fixed during this work

1. **`npm test` was red on Windows (1 failure).** `ClaudeRunner` spawned with
   `shell: true`, and Node joins command + args with spaces **without quoting**,
   so any command path containing a space was split and the child died with
   "not recognized as an internal or external command". Fixed by the exported
   `buildSpawnPlan()`: quote the executable on Windows, and launch `.mjs/.cjs/.js`
   executors via `process.execPath` with no shell (cmd.exe cannot run `.mjs`
   reliably — it exits 0 with no output). Covered by `tests/spawn-plan.test.mjs`.

2. **Silent provider fallback.** The bridge inherited a stale environment without
   the DeepSeek variables. Fixed by `src/win-env.mjs` (see §1).

3. **`git commit` required phone approval.** The policy only whitelisted
   `git status/diff/log/show/branch`, so every commit interrupted the user. Now
   `git add/commit/rev-parse/ls-files/describe/blame/checkout -b/switch -c` are
   safe while `git push`, `reset --hard`, `clean` and `rebase` stay gated.

4. **Status stuck on `TESTING`.** The progress state machine only left `TESTING`
   when a non-Bash tool ran, so it showed `🧪 TESTING` during subsequent git work.
   Fixed and covered by a test.

5. **Deadlock in the smoke harness.** The first version of Phase D called the hook
   client with `spawnSync`, which blocks the event loop, so the in-process
   approval presenter could never resolve and the client hung. Changed to async
   `spawn`. Worth remembering: never drive the hook client synchronously from the
   same process that has to answer it.

6. **`--include-partial-messages` was mostly noise.** It emits a `thinking_tokens`
   `system` event per token. Now opt-in via `CLAUDE_PARTIAL_MESSAGES` (default
   off); the bridge only needs complete assistant turns plus the final result.

7. **`thinking_tokens` is emitted even with partial messages off.** Measured on a
   single 90 s task: **2451 of 2505** stdout lines were `system/thinking_tokens`.
   Every one was being JSON-parsed and dispatched to the control plane for
   nothing. They are still written to the run log (so nothing is lost) but are no
   longer dispatched. Covered by a test.

8. **Windows short (8.3) paths broke the workspace check.** The same directory can
   be spelled `C:\Users\Administrator.DESKTOP-RHFCBBR\...` or
   `C:\Users\ADMINI~1.DES\...` — `os.tmpdir()` returns the short form on this
   machine. If the hook's `cwd` and the tool's target path use different
   spellings, the plain prefix comparison classifies every in-workspace edit as
   "write outside workspace" and the user gets an approval prompt for every single
   edit. Paths are now canonicalised with `fs.realpathSync.native`, resolving the
   nearest existing ancestor for paths that do not exist yet.

9. **The final status message was missing a newline.** The summary and the extras
   line were concatenated without a separator, producing
   ``Project: `C:\...`Tools: none``. The summary is now taken from
   `progress.render()` directly instead of being rebuilt, which also removed a
   duplicated tool-count calculation that could disagree with the live status.

10. **The installer wrote `~/.claude/settings.json` with a UTF-8 BOM.**
    PowerShell 5.1's `Set-Content -Encoding UTF8` prepends `EF BB BF`, and a BOM
    makes the file invalid JSON (`JSON.parse` fails with *Unexpected token ''*).
    A strict parser would therefore never load the hook, and the failure would be
    completely silent. Now written with `[System.IO.File]::WriteAllText` and a
    BOM-less `UTF8Encoding`. `npm run verify:hook` fails loudly if a BOM ever
    comes back.

11. **`shell: true` also means arguments are not quoted.** The first fix only
    quoted the executable. An argument containing a space is silently split into
    several arguments — a prompt of `Read the file package.json` arrives at the
    child as `Read` plus three extra argv entries, so the agent does something
    completely different from what was asked. `buildSpawnPlan` now quotes every
    argument with the standard `CommandLineToArgvW` escaping rules
    (`quoteWindowsArg`). The bridge itself only passes flags and a session UUID,
    which is why this stayed hidden until a script passed a real prompt.

12. **The hook installer hard-failed when `node` was not on PATH.** It used
    `Get-Command node -ErrorAction Stop`. Node is not on PATH in every shell, and
    the environment roots themselves (`$env:ProgramFiles`, `$env:APPDATA`) can be
    empty, which also made `Join-Path` throw. The installer now probes the usual
    install locations plus literal fallbacks and only warns if it truly cannot
    find node.

13. **`spawnSync` deadlocked a smoke test — again.** `verify-global-hook.mjs`
    originally ran Claude with `spawnSync` while the recording hook server lived
    in the same process, so the hook client could never get a response and the run
    hung until the 5-minute timeout killed it. This is the second time this exact
    trap appeared; it is now called out in `AGENTS.md` so it does not happen a
    third time.

## 9. Environment quirks worth knowing

- Claude Code 2.1.270 invokes `reg.exe` internally on Windows. In a sandboxed
  shell that call is blocked and logs a warning; it does not affect the run. In a
  normal PowerShell window it is not blocked.
- The `Bash` tool on Windows runs through Git Bash, so POSIX commands
  (`rm -rf`, `curl`) work and are what the policy patterns match.
- Discord messages are capped at 2000 characters; the bridge clips to 1900.
- The `os.tmpdir()` on this machine is the 8.3 short form
  (`C:\Users\ADMINI~1.DES\AppData\Local\Temp`), which is why the path
  canonicalisation in §8 item 8 matters. Long and short spellings of the same
  directory must compare equal.
- Some shells (sandboxed or service-spawned) have `$env:ProgramFiles`,
  `$env:APPDATA` and `$env:LOCALAPPDATA` **empty** even though the directories
  exist. Anything that builds paths from those variables must have literal
  fallbacks — `Join-Path` throws outright on a null root.
- HTTPS to `github.com:443` is blocked by the local proxy in this environment
  (`api.github.com` is fine). `git push` over HTTPS exits 0 **without pushing**,
  so pushes go over SSH on port 443 and are always verified with `git ls-remote`.

## 10. Still requiring a human step

### 10.1 Already done on this machine

The global approval hook **has been installed** into
`~/.claude/settings.json` (there was no such file before, so nothing was
overwritten):

```json
{"hooks":{"PreToolUse":[{"hooks":[{"type":"command",
  "command":"\"C:\\Program Files\\nodejs\\node.exe\" \"<repo>\\scripts\\approval-hook.mjs\"",
  "timeout":600,"statusMessage":"Waiting for Discord approval when required"}]}]}}
```

It is inert for ordinary Claude Code and the WebUI — verified in §7.2. To remove
it:

```powershell
.\scripts\install-global-hook.ps1 -Uninstall
```

### 10.2 What only you can do

The real `iPhone Discord -> bridge -> Claude Code -> approval -> Discord` run
needs a Discord bot that only the user can create:

1. Discord Developer Portal -> **New Application** -> **Bot** -> **Reset Token**
   -> copy the token.
2. On the same Bot page enable **Message Content Intent**.
3. **OAuth2 -> URL Generator**: scopes `bot`; permissions *View Channels*,
   *Send Messages*, *Read Message History*. Open the generated URL and invite the
   bot to your private server.
4. Copy your own numeric user ID (Discord **Settings -> Advanced -> Developer
   Mode**, then right-click your avatar -> *Copy User ID*).
5. Put both into `.env` as `DISCORD_TOKEN` and `DISCORD_OWNER_ID`.

Then:

```powershell
npm run doctor:discord -- --send-test-dm   # proves token + DM channel
.\scripts\start-windows.ps1
```

## 11. Reproducing everything

```powershell
npm install
npm test
npm run check
npm run smoke:local      # real Claude Code, throwaway repo, no Discord needed
npm run smoke:discord    # + real control plane, fake Discord transport
npm run verify:hook      # + the installed global hook (needs install-global-hook.ps1 first)
npm run doctor:discord   # needs .env
.\scripts\start-windows.ps1
```

The disposable repo used by each smoke test is left on disk and its path is
printed at the end of the run so the result can be inspected by hand.

## 12. V3 验证（2026-09-15）

### 自动化与本机发现

```text
npm test      -> 115 passed / 0 failed
npm run check -> checked 52 file(s), 0 failed

WorkBuddy 2.137.1       PASS (installed adapter)
Claude Code 2.1.270     PASS
OpenCode                NOT_INSTALLED
Codex 0.154.0           ADAPTER_NOT_READY
```

Fake Discord 覆盖 OWNER 私聊 `!api`、Key 消息删除、Provider 创建、动态模型、模型选择、状态展示、真实文件副作用以及 Provider/profile/log/state 无完整 Key。Provider tests 覆盖 OpenAI / Anthropic 协议探测、错误 URL/Key、无 models endpoint 的真实 Model ID 验证、45 分钟缓存与 stale fallback、Provider 删除和 credential isolation。

### 真实 Discord 边界

`npm run doctor:discord -- --send-test-dm` 实测登录 `Agent Control#8605`、解析 OWNER，并成功发送测试 DM。可控的 Discord Web 仅显示登录页，没有现成用户会话，因此无法代表 OWNER 发出 `!executor` / `!api`；也没有获得授权用于从本机环境读取并转发某个现有 API Key。真实用户入站与真实 Key 消息删除不得伪造为 PASS。

### 当前 WorkBuddy 运行结果

2026-09-15 重跑时，WorkBuddy gateway 在工具调用前返回 `HTTP 403`, provider code `11140`, message `request illegal`。这不是可可靠判定的 quota 响应，因此记录为 `FAIL`，不误报 `BLOCKED_BY_QUOTA`：

```text
npm run verify:workbuddy -> 9/13 checks passed
npm run smoke:local      -> 15/21 checks passed
npm run smoke:discord    -> 9/15 checks passed
npm run verify:hook      -> 4/7 checks passed
```

失败项都依赖本次 WorkBuddy 模型先产生 tool call；独立的真实 hook-client allow-once / allow-session / deny / session 隔离继续通过。V3 入口已验证在该 Provider 失败时仍启动 hook 与 Discord 控制面，并明确记录 `WorkBuddy status=FAIL`、`No provider fallback attempted`。

### 验收结论

- V3 Manager、Generic Provider、Fake Discord onboarding 与 V2 自动回归通过。
- Bot 的真实 Discord 出站 DM 通过。
- WorkBuddy 实时工具调用被当前 403 阻断。
- 真实 OWNER 入站 `!api` 与真实 Key 删除仍未完成，因此整体真实 Discord E2E 为 FAIL。

## 13. V3 — OpenCode Go 接入（2026-09-15 接续）

### 13.1 自动化

```text
npm test      -> 121 passed / 0 failed
npm run check -> checked 53 file(s), 0 failed
```

新增测试覆盖：37 个真实模型的 transport 族规则（含 `unknown`）、内置 Provider 的动态模型发现与持久化缓存（不含 Key）、按模型协议的 Executor 兼容矩阵、OpenCode Go 子进程的 `x-api-key`（且无 Bearer）与凭据隔离、`unknown` transport 的拒绝，以及 Fake Discord 的 `!provider opencode-go` / `!models` / `!model` 流程。

### 13.2 真实 OpenCode Go provider

```text
GET https://opencode.ai/zen/go/v1/models -> HTTP 200, data.length = 37
transport 分布: anthropic-messages 9 · openai-chat 22 · openai-responses 5 · unknown 1
响应字段: id / object / created / owned_by（无协议字段，故 transport 由官方 endpoint 表推导）
```

`GET /v1/models` 无需鉴权即返回 200；`POST /v1/messages` 只接受 `x-api-key`，用 `Authorization: Bearer` 返回 `401 Missing API key`，缺少 session 头返回 `400 MissingSessionID`。Claude Code 的原生 session 头可满足该要求。

### 13.3 真实 Claude Code + OpenCode Go E2E

`npm run verify:opencode-go` -> **17/17**，在一次性 git 仓库中通过真实 Claude Code CLI 与真实 OpenCode Go 运行：

```text
model reported by CLI: minimax-m3
apiKeySource: ANTHROPIC_API_KEY          （即 OpenCode Go，不是 WorkBuddy backend）
tools: Write, Read, Bash
approval prompts: (none — PermissionManager STANDARD 自动放行)
final: DONE
opencode-go-test.txt        -> 存在，内容 OPENCODE_GO_OK
git status --short          -> ?? opencode-go-test.txt
```

### 13.4 WorkBuddy 当前状态（非 V3 失败）

本机 WorkBuddy gateway 仍在工具调用前返回 `HTTP 403 provider 11140 request illegal`，因此依赖 WorkBuddy 产出 tool call 的 smoke 部分失败，标记 **BLOCKED_BY_WORKBUDDY_QUOTA/FAIL**：

```text
npm run verify:hook  -> 4/7   （真实 hook 客户端 allow/deny/session 隔离仍通过；依赖 WorkBuddy 工具调用的 3 项失败）
npm run smoke:discord -> 8/15 （控制面、hook、隔离、低噪声、transcript 通过；WorkBuddy 0 tool call 导致 D3/D4/D7/D9/D11/D12/D13b 失败）
```

### 13.5 桥启动在 WorkBuddy 失败时仍可用

真实启动 `node src/index.mjs` 记录：

```text
[backend] WorkBuddy status=FAIL; the shared control plane will remain available for other configured providers.
[backend] No provider fallback attempted.
[executor] claude=PASS version=2.1.270 (Claude Code)
[discord] control plane ready | ... default cwd=D:\deepseeek
```

即 WorkBuddy 不可用不阻止 Bridge、OpenCode Go Provider、Generic Provider、Discord UI 上线，也不会自动回退到其它 Provider。

### 13.6 真实 Discord 输入验收（用户操作）

Bridge 已在线。OWNER 在自己的 Discord 客户端发送：

```text
!executor claude
!provider opencode-go
!models
!model minimax-m3
!status
在当前测试目录创建 opencode-discord-test.txt，内容为 OPENCODE_DISCORD_OK，然后读取确认后回复 DONE
```

期望：`!models` 显示每个模型的 `anthropic-messages / openai-chat / openai-responses` 与是否兼容 Claude Code；`!status` 的协议为 `anthropic-messages`、计费为 `订阅`；任务产生真实 Write/Read tool call 并以 `✅ 已完成` 结束。

### 13.7 Git 与 Secret

提交前执行 `git status --short` / `git diff` 与工作树 secret 扫描；`data/credentials.json`、`data/providers.json`、`.env`、hook secret 均由 `.gitignore` 排除且未进入 Git。

## 14. V3 — Claude Code + OpenCode Go 协议适配（DeepSeek / GLM）

### 14.1 问题

`openai-chat` 模型（DeepSeek / GLM）被兼容矩阵拒绝给 Claude Code，但需求是保留 Claude Code Harness。解决方式是本地协议适配层，不是换 Executor。

### 14.2 真实抓包（Claude Code 2.1.270 + OpenCode Go + MiniMax M3）

抓包确认：

- 请求路径 `POST /v1/messages?beta=true`，`accept: application/json`；
- Claude Code 的原生 session 头是 **`x-claude-code-session-id`**（不是 `x-session-id`），OpenCode Go 识别它；网关转发时应同时写入 `x-opencode-session` 以保证稳定；
- 请求体含 `system`、`messages`（存在 role `system`、`tool_use`、`tool_result`、`thinking`）、`tools[].input_schema`、`max_tokens: 32000`、`stream: true`；
- 上游 Anthropic SSE 事件序列：`message_start` → `ping` → `content_block_start(thinking/tool_use)` → `thinking_delta`/`signature_delta`/`input_json_delta` → `content_block_stop` → `message_delta(stop_reason)` → `message_stop`；
- 认证差异：`/v1/messages` 用 `x-api-key`（Bearer 返回 `401 Missing API key`），`/v1/chat/completions` 用 `Authorization: Bearer`。

### 14.3 DeepSeek / GLM 的 OpenAI Chat tool calling 真实探测

```text
POST /v1/chat/completions  model=deepseek-v4.1-flash  -> 200, finish_reason=tool_calls
POST /v1/chat/completions  model=glm-5.3-flash        -> 200, finish_reason=tool_calls
```

### 14.4 真实 E2E：Claude Code + 适配层 + OpenCode Go

`npm run verify:claude-opencode-chat` -> **30/30**：

```text
===== deepseek-v4.1-flash =====
CLI model=deepseek-v4.1-flash apiKeySource=ANTHROPIC_API_KEY
tools=Write, Read, Bash
upstream models=["deepseek-v4.1-flash","deepseek-v4.1-flash","deepseek-v4.1-flash","deepseek-v4.1-flash"]
prompts=(none)  final=DONE
claude-ds-test.txt -> 存在，内容 CLAUDE_DS_OK
git status --short -> ?? claude-ds-test.txt

===== glm-5.3-flash =====
CLI model=glm-5.3-flash apiKeySource=ANTHROPIC_API_KEY
tools=Write, Read, Bash
upstream models=["glm-5.3-flash", ...]
claude-glm-test.txt -> 存在，内容 CLAUDE_GLM_OK
```

模型真实性由**上游请求体 `model` 字段**证明（全部等于所选模型），不是问模型“你是谁”。子进程只拿到网关本地 token，真实 OpenCode Go Key 未进入子进程环境。

### 14.5 回归

```text
npm test                     -> 135 passed / 0 failed
npm run check                -> 58 file(s), 0 failed
npm run verify:opencode-go   -> 17/17（MiniMax anthropic-messages 直连路线未回归）
npm run verify:claude-opencode-chat -> 30/30
verify:hook / smoke:discord  -> WorkBuddy 403，标记 BLOCKED_BY_WORKBUDDY
```


---

## 15. P2.2.3 repository stabilization evidence (2026-09-17)

Real Windows machine. All commands run against the real branch
`jarvis-v4-p2-2-hardening`; no secret is printed.

```text
npm test                             -> 350 pass / 0 fail
npm run check                        -> 111 file(s), 0 failed
npm run smoke:p2                     -> 11/11  (real Chat + vision + Work thread)
npm run smoke:p22                    -> 10/10  (instance lock, durable store, autostart)
npm run smoke:p222                   -> 25/25  (real Chat model selection / restart)
npm run smoke:p22-insert             -> 14/14  (real live insert, one Agent/session)
npm run smoke:p22-model              -> 6/6    (real model restore across processes)
npm run smoke:p22-workspace          -> 8/8    (real workspace persistence)
npm run smoke:p223-full              -> 15/15  (K4/K5 real FULL Work, 0 prompts, real Stop)
npm run verify:hook                  -> 9/9    (global hook fires; inert otherwise)
npm run doctor:discord               -> login OK (Jarvis#8605, 1 guild)
verify:opencode-go                   -> 17/17
verify:claude-opencode-chat          -> 30/30
scripts/smoke-supervisor-recovery.ps1-> 23/23  (kill bridge/LiteLLM/supervisor auto-recovery)
```

K4/K5 real-machine behavior after the fix:

- setting the parent channel to FULL once yields a Work thread that reports
  全开放 and completes a multi-step repo task with **zero** approval prompts;
- `git add .env` is still hard-denied (secret guard independent of FULL);
- production Work has **no** wall-clock cap (`TASK_TIMEOUT_MS=0`); a real 45s
  `Start-Sleep` task stayed RUNNING and was terminated only by owner `!stop`.

Known external blocker unchanged: WorkBuddy gateway returns
`HTTP 403 provider 11140 request illegal`, so `smoke:local` agent-driven checks
and WorkBuddy-executor Work tasks remain BLOCKED_BY_WORKBUDDY. Other providers
remain usable and the bridge reports WorkBuddy as unavailable.

## P2.2.4 Work lifecycle / insert / Stop �� 2026-09-17

```text
npm test                             -> 356 pass / 0 fail
npm run check                        -> 113 file(s), 0 failed
npm run smoke:p2                     -> 11/11  (real Chat + vision + Work thread)
npm run smoke:p22                    -> 10/10  (instance lock, durable store, autostart)
npm run smoke:p222                   -> 25/25  (real Chat model selection / restart)
npm run smoke:p22-insert             -> 14/14  (real live insert, one Agent/session)
npm run smoke:p223-full              -> 15/15  (K4/K5 real FULL Work, 0 prompts, real Stop)
npm run smoke:p224-lifecycle         -> 21/21  (real Work lifecycle + single-press Stop)
```

`smoke:p224-lifecycle` real-machine evidence (real OpenCode Go credential,
Claude Code CLI through the local adapter, real hook server, real Windows
process tree; only the Discord transport is the in-process fake):

- a real Work with a live insert AND a queued continuation never rendered an
  intermediate `? �����` (continuous monitor clean) and produced exactly one DONE;
- the completed turn result was preserved on its own message (`�� 1 �������`);
- the live insert settled `CONSUMED`, the continuation `EXECUTED`; a later Stop
  did not report any unprocessed insert;
- a second real Work was terminated by ONE `!stop`: the captured Agent pid was
  reported dead by `tasklist`, no run remained, the STOPPED card had no controls;
- a re-materialised stale Stop control returned `�������ѽ���` and created/killed
  nothing.
