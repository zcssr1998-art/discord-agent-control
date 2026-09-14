# Agent instructions

Primary execution spec: `docs/GEMINI_3_8_TASK.md`.
Real-machine evidence and known gotchas: `docs/WINDOWS_SMOKE.md`.

Principles:
- Do not rewrite from scratch; inspect and extend the existing implementation.
- Default executor is the user's existing DeepSeek-backed Claude Code.
- Codex is optional fallback only after the DeepSeek V1 works.
- Reuse the user's existing Claude/DeepSeek environment; do not create a second provider configuration unless required by an observed incompatibility.
- Run real tests. The task is not done until the Windows Discord -> Claude Code -> tool execution -> phone approval -> result loop is proven on a disposable repo.
- Keep chat reports short; persist detailed debugging/results in this repository.
- Never commit secrets.

## Current state (V2 — WorkBuddy free backend)

The bridge now runs on the **WorkBuddy free DeepSeek Flash** backend with paid
fallback disabled. Read `docs/WORKBUDDY_BACKEND.md` before changing anything about
the backend: it records what was measured, why the agent shell is the WorkBuddy
agent CLI, and why wrapping that CLI behind a model-shaped adapter would be worse.

- `src/backend.mjs` — backend identity and the paid-fallback guard.
  `system/init.apiKeySource` reported by the agent is the source of truth;
  `stripPaidCredentials()` removes metered variables from the child environment;
  `assertBackendAllowed()` fails closed. `resolveWorkbuddyCli()` locates the
  bundled CLI and `resolveExecutorCommand()` expands the `workbuddy` keyword.
- `src/limits.mjs` — runaway protection: task wall-clock cap, consecutive-failure
  cap, restart cap.
- `src/discord-proxy.mjs` — Discord needs **two** proxies: `undici`'s global
  dispatcher for REST and a wrapped `ws` constructor for the gateway. This must be
  imported before `discord.js` is evaluated. Do not "simplify" it to one.
- `src/discord-errors.mjs` — turns Discord's opaque failures (blocked network,
  disabled privileged intent) into actionable messages.
- `src/win-env.mjs` — recovers `ANTHROPIC_*` routing from the Windows user
  environment. Only used when `ALLOW_PAID_FALLBACK=true`.
- `src/claude-runner.mjs` — persistent `stream-json` agent process. Windows spawn
  rules live in the exported `buildSpawnPlan()`; the `.js` entry of the WorkBuddy
  CLI is launched through `process.execPath` because the extensionless launcher
  cannot be executed by `cmd.exe`.
- `src/policy.mjs`, `src/hook-server.mjs`, `src/approval-manager.mjs`,
  `src/progress.mjs` — unchanged in spirit; the approval gate is still the
  `PreToolUse` hook, which the WorkBuddy CLI implements with the same schema.
- `scripts/verify-workbuddy.mjs` (`npm run verify:workbuddy`) — proves the free
  backend, real tool calls, blocked credentials and no fallback.

Verification commands:

```text
npm test              # unit + integration tests
npm run check         # syntax check of every module
npm run verify:workbuddy  # free backend + real tool calls + no paid fallback
npm run smoke:local   # real agent end-to-end on a throwaway repo
npm run smoke:discord # real control plane, fake Discord transport
npm run verify:hook   # the installed global hook fires, and stays inert otherwise
npm run doctor:discord
```


## Traps that already cost time once

- **Never use `spawnSync` while a server in the same process has to answer the
  child.** It blocks the event loop, so the hook client can never get a response
  and the run hangs until it is killed. Use async `spawn`. This has bitten twice.
- **`shell: true` on Windows means Node quotes nothing.** Both the executable and
  every argument must be quoted by hand — see `buildSpawnPlan` / `quoteWindowsArg`.
  A prompt with spaces otherwise arrives truncated to its first word.
- **Never write `~/.claude/settings.json` with a BOM.** PowerShell 5.1's
  `Set-Content -Encoding UTF8` adds one, which makes the file invalid JSON and
  silently stops Claude Code from loading the hook. Use
  `[System.IO.File]::WriteAllText` with a BOM-less `UTF8Encoding`.
- **A smoke test that depends on the model choosing to run a destructive command
  is flaky.** The agent inspects the repo and declines. Use a gated command with an
  observable local side effect, or drive the hook client directly.
