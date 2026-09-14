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
npm test            -> 55 passed / 0 failed
npm run check       -> checked 27 file(s), 0 failed
npm run smoke:local -> 22/22 checks passed
npm run smoke:discord -> 16/16 checks passed
```

There are two smoke tests, at two different levels of realism:

| | real | faked |
| --- | --- | --- |
| `smoke:local` | Claude Code CLI, hook, hook server, policy, approval manager, git, tests | Discord (absent) |
| `smoke:discord` | everything above **plus** `DiscordControlPlane` — commands, progress throttling, approval buttons, session bookkeeping | only the Discord network |

If both are green, the only hop never exercised is Discord's own servers.

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

## 7. Bugs found and fixed during this work

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

## 8. Environment quirks worth knowing

- Claude Code 2.1.270 invokes `reg.exe` internally on Windows. In a sandboxed
  shell that call is blocked and logs a warning; it does not affect the run. In a
  normal PowerShell window it is not blocked.
- The `Bash` tool on Windows runs through Git Bash, so POSIX commands
  (`rm -rf`, `curl`) work and are what the policy patterns match.
- Discord messages are capped at 2000 characters; the bridge clips to 1900.

## 9. Still requiring a human step

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

## 10. Reproducing everything

```powershell
npm install
npm test
npm run check
npm run smoke:local      # real Claude Code, throwaway repo, no Discord needed
npm run smoke:discord    # + real control plane, fake Discord transport
npm run doctor:discord   # needs .env
.\scripts\start-windows.ps1
```

The disposable repo used by each smoke test is left on disk and its path is
printed at the end of the run so the result can be inspected by hand.
