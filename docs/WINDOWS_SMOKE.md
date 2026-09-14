# Windows smoke test — real-machine evidence

This file records what was actually executed and observed on the user's Windows
machine, not what the code is expected to do. Anything listed as **verified** has
a reproducible command and a captured result.

No token, secret or credential value is recorded here.

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
npm test        -> 34 passed / 0 failed
npm run check   -> checked 23 file(s), 0 failed
npm run smoke:local -> 19/19 checks passed
```

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
[progress] 🟡 RUNNING · 12s | Write .../test/health.test.mjs
[progress] 🧪 TESTING · 15s | Bash: npm test
[progress] 🟡 RUNNING · 44s | Bash: git add -A && git commit -m "feat: add health endpoint"
[final]    ✅ DONE · 1m 00s tools=6 cost=$0.22
```

Checks that passed:

- `src/health.mjs` really exists and really returns `{"status":"ok"}`;
- the test file really exists;
- `node --test` passes on the modified repo (re-run independently of the agent);
- a real commit `feat: add health endpoint` is present in `git log`;
- the agent reported a concrete model (`deepseek-flash[1m]`).

Note that in-workspace edits, tests and `git add/commit` produced **zero**
approval prompts — the "don't interrupt me for normal work" requirement.

### Phase B — destructive command is denied

A decoy directory containing `keep-me.txt` was created. The agent was asked to run
`rm -rf decoy`.

```text
[progress] 🟡 RUNNING · 22s | Bash: rm -rf decoy
[phone]    Bash (bash-destructive) -> deny
```

**Verified**: `decoy/keep-me.txt` still exists afterwards. Deny prevented the real
filesystem operation.

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

### Phase E — ordinary Claude Code is unaffected

The same repo, same installed hook, but **without** `DISCORD_BRIDGE_ACTIVE`:

```text
E1 plain Claude Code still runs (hook is inert without DISCORD_BRIDGE_ACTIVE)
E2 the plain session really read the file instead of being blocked
E3 no approval was requested for the plain session
```

**Verified**: the hook is inert for normal local Claude Code and the WebUI.

## 5. Session / state recovery

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

## 6. Bugs found and fixed during this work

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

## 7. Environment quirks worth knowing

- Claude Code 2.1.270 invokes `reg.exe` internally on Windows. In a sandboxed
  shell that call is blocked and logs a warning; it does not affect the run. In a
  normal PowerShell window it is not blocked.
- The `Bash` tool on Windows runs through Git Bash, so POSIX commands
  (`rm -rf`, `curl`) work and are what the policy patterns match.
- Discord messages are capped at 2000 characters; the bridge clips to 1900.

## 8. Still requiring a human step

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

## 9. Reproducing everything

```powershell
npm install
npm test
npm run check
npm run smoke:local      # real Claude Code, throwaway repo, no Discord needed
npm run doctor:discord   # needs .env
.\scripts\start-windows.ps1
```

The disposable repo used by `smoke:local` is left on disk and its path is printed
at the end of the run so the result can be inspected by hand.
