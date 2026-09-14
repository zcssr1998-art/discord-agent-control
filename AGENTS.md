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

## Current state (V1)

Implemented and verified on the user's Windows machine:

- `src/claude-runner.mjs` — persistent Claude Code `stream-json` process. Windows
  spawn rules are encoded in the exported `buildSpawnPlan()` and covered by
  `tests/spawn-plan.test.mjs`; do not "simplify" it back to a bare
  `spawn(command, args, { shell: true })`, that breaks any command path
  containing a space.
- `src/win-env.mjs` — recovers `ANTHROPIC_*` routing from the Windows *User*
  environment when the bridge process inherited a stale environment. This is the
  guard against silently running on the official Anthropic endpoint.
- `src/policy.mjs` — risk classification. `git add/commit/status/diff/log` are
  safe; `git push`, `reset --hard`, `clean`, rebase, recursive deletes,
  install/publish and network calls are gated.
- `src/hook-server.mjs` + `scripts/approval-hook.mjs` — the approval gate. The
  hook is inert without `DISCORD_BRIDGE_ACTIVE=1`.
- `src/approval-manager.mjs` — Allow once / Allow session / Deny, scoped to
  `sessionId:ruleKey`, fail-closed, cancellable by `!stop` / `!reset`.
- `src/progress.mjs` — the single throttled status message. Raw Claude stdout
  must never be rendered into Discord; it goes to `logs/`.
- `scripts/local-e2e.mjs` (`npm run smoke:local`) — real end-to-end smoke test
  without Discord. Treat a red run here as a release blocker.
- `scripts/discord-e2e.mjs` (`npm run smoke:discord`) — the same loop plus the
  real `DiscordControlPlane`, with only the Discord transport faked. Run this
  before blaming Discord when the live bridge misbehaves.
- `scripts/verify-global-hook.mjs` (`npm run verify:hook`) — verifies the *global*
  `~/.claude/settings.json` hook, which is the configuration the bridge actually
  relies on. The other smokes use a project-scoped hook, so this is the one that
  proves the real deployment path.
- `tests/startup.test.mjs` — boots `src/index.mjs` as a child process and checks
  the approval service really comes up and that bad credentials fail with an
  actionable message rather than a stack trace.
- `tests/helpers/fake-discord.mjs` — the fake transport used above. It is test
  infrastructure, not a replacement for the live Discord smoke.

Verification commands:

```text
npm test              # unit + integration tests
npm run check         # syntax check of every module
npm run smoke:local   # real Claude Code end-to-end on a throwaway repo
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
