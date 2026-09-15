# Discord Agent Control

Windows-first Discord control plane for a local Claude Code style agent, running
on the **WorkBuddy free DeepSeek Flash backend** with paid fallback disabled.

```text
iPhone Discord
  -> Windows bridge (discord-agent-control)
  -> Claude Code compatible agent shell
  -> WorkBuddy Free DSF   (apiKeySource = www.workbuddy.ai, cost 0)
  -> real files / commands / git
  -> phone approval for risky actions
  -> result back to Discord
```

The agent shell is the WorkBuddy agent CLI (`@genie/agent-cli`), which is a
Claude Code fork: same `stream-json` protocol, same tools, same `PreToolUse` hook
schema. Only the model backend is different. See
`docs/WORKBUDDY_BACKEND.md` for the investigation behind that choice, including
why an Anthropic-compatible adapter in front of it would be worse.

## Start here

- **Backend investigation and decision:** `docs/WORKBUDDY_BACKEND.md`
- **Real-machine evidence:** `docs/WINDOWS_SMOKE.md`
- Handover task / acceptance checklist: `docs/GEMINI_3_8_TASK.md`
- Windows setup: `docs/WINDOWS_SETUP.md`

## Quick start (Windows)

```powershell
npm install
.\scripts\install-global-hook.ps1     # once; installs into ~/.claude AND ~/.codebuddy
Copy-Item .env.example .env           # then fill DISCORD_TOKEN + DISCORD_OWNER_ID
npm run verify:workbuddy              # proves the free backend + real tool calls
npm run doctor:discord                # verifies token, owner, proxy, invite URL
.\scripts\start-windows.ps1
```

Then, from Discord on your phone, either DM the bot or post in a channel it can read:

```text
!cwd D:\path\to\your\project
把这个项目启动失败的问题修掉，修完自己跑测试
```

## Backend guarantees

The bridge reports, and gates on, the backend that actually served each request:

- `system/init.apiKeySource` from the agent itself is the source of truth — the
  bridge never guesses;
- when `ALLOW_PAID_FALLBACK=false` (the default) every metered credential
  variable is removed from the agent process environment;
- a run that reports any other backend is **refused**, not silently billed;
- `!status` prints the backend, model, billing route and paid-fallback state.

```text
Executor: workbuddy agent CLI
Backend: WorkBuddy Free DSF
Model: fast-model
Billing route: WorkBuddy Free
Paid fallback: disabled
```

## Commands

| Command | Meaning |
| --- | --- |
| _any text_ | run it as a task in the bound project |
| `!status` | executor / backend / model / billing route / cwd / session / busy-idle |
| `!perm` / `!permission` | 查看四档权限菜单 |
| `!perm strict\|standard\|relaxed\|full` | 切换权限；FULL 需要二次确认 |
| `!cwd <absolute path>` | bind this Discord channel to a project (clears the session) |
| `!stop` | kill the running agent process and cancel pending approvals |
| `!reset` | stop + clear the session, approvals and failure counters |
| `!handoff` | print a compact handoff package for manual escalation |
| `!help` | command list |

## Runaway protection

A remote agent that keeps failing or restarting burns tokens where nobody is
watching, so every path is capped:

- `TASK_TIMEOUT_MS` — hard wall-clock cap per task; hitting it kills the process;
- `MAX_CONSECUTIVE_FAILURES` — refuse new work after N consecutive failures;
- `MAX_PROCESS_RESTARTS` — cap on agent process restarts;
- `!stop` kills the whole process tree and cancels pending approvals;
- `!reset` clears the failure and restart counters.

## How approvals work

The bridge launches Claude Code with `DISCORD_BRIDGE_ACTIVE=1` and a global
`PreToolUse` hook. The hook is **inert** for ordinary local Claude Code and the
WebUI — it exits immediately without that variable.

For bridge sessions every tool call is classified through the shared
`PermissionManager`; see `docs/PERMISSIONS.md` for the four-level matrix and
lifecycle.

- auto-allowed: read-only tools, in-workspace edits, `git status/diff/log/add/commit`, lint/test/build;
- sent to your phone: `git push`, `reset --hard`, `clean`, rebase, recursive deletes, install/publish, network access, writes outside the workspace, `.env`/credential files, unknown MCP tools.

The phone shows `✅ 仅允许这一次` / `✅ 本次会话允许` / `❌ 拒绝`. `Allow session` is scoped
to one Claude session **and** one policy rule key — it never becomes a global
permanent allow. If the local approval service is unreachable the hook **fails
closed** (denies).

## Verification

```powershell
npm test              # unit + integration tests
npm run check         # syntax check of every module
npm run smoke:local   # real Claude Code end-to-end on a throwaway repo (no Discord needed)
npm run smoke:discord # same, plus the real Discord control plane with a fake transport
npm run verify:hook   # the installed global hook really fires (and is inert otherwise)
```

`npm run smoke:local` drives the real Claude Code CLI through the real bridge
components against a disposable git repository and asserts on real side effects
(files created, tests passing, a git commit present, a denied destructive command
that really did not happen).

`npm run smoke:discord` goes one layer further: real Claude Code, real hook
server, real policy, real `DiscordControlPlane` — only the Discord *network* is
faked. It sends `!cwd` and a task as the owner, watches the approval messages that
get posted and taps the buttons, then verifies the outcome. If both smokes are
green, the only untested hop is Discord's own servers.

`npm run verify:hook` checks the configuration the bridge actually relies on: the
global `~/.claude/settings.json` hook. It runs real Claude Code twice against a
repo with no project-level settings — once with `DISCORD_BRIDGE_ACTIVE=1` (the
hook must fire) and once without (the hook must stay inert and the tool must still
run). Run `scripts/install-global-hook.ps1` first.

## Layout

```text
src/
  index.mjs            entry point: routing check + hook server + Discord
  config.mjs           env configuration
  claude-runner.mjs    persistent Claude Code stream-json process
  discord-ui.mjs       Discord control plane, commands, approval buttons
  progress.mjs         low-noise progress state machine + throttled editor
  policy.mjs           tool risk classification
  hook-server.mjs      127.0.0.1 approval service for the PreToolUse hook
  approval-manager.mjs Allow once / Allow session / Deny, fail-closed
  win-env.mjs          DeepSeek routing recovery from the Windows user env
  state.mjs            channel -> cwd + session persistence
  logger.mjs           full stream-json transcript, never sent to Discord
scripts/
  approval-hook.mjs        Claude Code PreToolUse hook client
  install-global-hook.ps1  install/remove the user-level hook
  start-windows.ps1        start the bridge
  local-e2e.mjs            real end-to-end smoke test (no Discord)
  discord-e2e.mjs          end-to-end smoke with the real control plane
  verify-global-hook.mjs   verifies the installed global hook (and its inertness)
  discord-doctor.mjs       credential / connectivity diagnostics
  check-syntax.mjs         syntax check used by `npm run check`
```
