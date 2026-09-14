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

Verification commands:

```text
npm test          # unit + integration tests
npm run check     # syntax check of every module
npm run smoke:local   # real Claude Code end-to-end on a throwaway repo
npm run doctor:discord
```
