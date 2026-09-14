# Discord Agent Control

Windows-first Discord control plane for a local Claude Code agent.

Primary target:

`iPhone Discord → Windows bridge → existing DeepSeek-backed Claude Code → real project execution → phone approval for risky actions → result back to Discord`

DeepSeek Claude Code is the default executor. Codex is an optional later escalation path, not part of the required V1 loop.

## Start here

- **Windows smoke-test evidence:** `docs/WINDOWS_SMOKE.md`
- **Handover task / acceptance checklist:** `docs/GEMINI_3_8_TASK.md`
- Windows setup: `docs/WINDOWS_SETUP.md`
- Original Chinese design brief: `docs/开发任务书.md`
- Architecture/task notes: `docs/TASKBOOK.md`

## Quick start (Windows)

```powershell
npm install
.\scripts\install-global-hook.ps1     # once; inert unless the bridge launches Claude
Copy-Item .env.example .env           # then fill DISCORD_TOKEN + DISCORD_OWNER_ID
npm run doctor:discord                # verifies token, owner, invite URL, DM channel
.\scripts\start-windows.ps1
```

Then, from Discord on your phone, either DM the bot or post in a channel it can read:

```text
!cwd D:\path\to\your\project
把这个项目启动失败的问题修掉，修完自己跑测试
```

## Commands

| Command | Meaning |
| --- | --- |
| _any text_ | run it as a task in the bound project |
| `!status` | cwd / session / executor / resolved backend + model / busy-idle |
| `!cwd <absolute path>` | bind this Discord channel to a project (clears the session) |
| `!stop` | kill the running agent process and cancel pending approvals |
| `!reset` | stop + clear the Claude session and any session-scoped approvals |
| `!handoff` | print a compact handoff package for ChatGPT/manual escalation |
| `!help` | command list |

## How approvals work

The bridge launches Claude Code with `DISCORD_BRIDGE_ACTIVE=1` and a global
`PreToolUse` hook. The hook is **inert** for ordinary local Claude Code and the
WebUI — it exits immediately without that variable.

For bridge sessions every tool call is classified by `src/policy.mjs`:

- auto-allowed: read-only tools, in-workspace edits, `git status/diff/log/add/commit`, lint/test/build;
- sent to your phone: `git push`, `reset --hard`, `clean`, rebase, recursive deletes, install/publish, network access, writes outside the workspace, `.env`/credential files, unknown MCP tools.

The phone shows `Allow once` / `Allow session` / `Deny`. `Allow session` is scoped
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
