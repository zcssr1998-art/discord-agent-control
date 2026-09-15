# Agent instructions — Jarvis

This repository inherits the cross-project AI workflow from:

`https://github.com/zcssr1998-art/AI-Development-Rules/blob/main/GLOBAL_AI_RULES.md`

This file contains **Jarvis-specific** rules only. Rule precedence:

`explicit current user instruction > this AGENTS.md > GLOBAL_AI_RULES.md > agent defaults`

## New-session read order

1. `AGENTS.md`
2. global `GLOBAL_AI_RULES.md`
3. `docs/CURRENT.md`
4. `docs/AI_HANDOFF.md`
5. `docs/tasks/CURRENT.md`
6. active task referenced there
7. current branch / HEAD / `git status` / relevant diff
8. only the code/docs needed for that task

Project workflow overlay: `docs/DEVELOPMENT_WORKFLOW.md`.
Architecture: `docs/JARVIS_V4_ARCHITECTURE.md`.
Real-machine evidence and known gotchas: `docs/WINDOWS_SMOKE.md`.

Do not paste the global rulebook or a repo-resident taskbook into chat again.

## Core product principles

- Do not rewrite from scratch; inspect and extend the existing implementation.
- Jarvis is the stable Discord AI terminal. Models/providers/Agent CLIs are replaceable backends.
- Default user mode is **Chat**. Chat must not start an Agent.
- **Work** is explicit and uses an Agent runtime.
- **LiteLLM is the primary standard model gateway in V4** for provider normalization/routing/cost metadata where compatibility is proven.
- LiteLLM is not the Agent/orchestration layer. Jarvis still owns mode, sessions, workspace, permissions, queue and cancellation.
- OpenCode Go is a special provider: verify LiteLLM compatibility on the real Windows/account setup before routing it through LiteLLM. Preserve the working direct adapter if necessary.
- Keep Agent and model selections independent.
- AUTO routing must prefer healthy FREE/SUBSCRIPTION routes and must not silently spend on METERED/unknown billing.
- Run real tests. Code inspection is not acceptance.

## Jarvis state / handoff files

Jarvis currently uses these project-specific state files:

- `docs/CURRENT.md` — compact project/milestone state.
- `docs/AI_HANDOFF.md` — model handoff where it adds information not already in `CURRENT.md`.
- `docs/tasks/CURRENT.md` — pointer to the active detailed task.

Do not make these files repeat the same facts. If one becomes redundant, consolidate rather than maintaining duplicate state.

## Current implementation baseline

Base V3 already provides:
- WorkBuddy free backend support
- OpenCode Go provider/model discovery
- OpenCode Go transport detection
- local Anthropic -> OpenAI Chat compatibility adapter for Claude-compatible Agent runners
- ProviderManager / ModelManager / CredentialStore
- ExecutorManager
- persistent Agent runner/session state
- permission tiers and approval hook
- real `!stop` process-tree kill
- watchdog and runaway protection
- Discord proxy support on Windows

V4 foundation adds:
- `src/mode-router.mjs` — deterministic local Chat/Work controls
- `src/provider-health.mjs` — circuit breaker/cooldowns
- `src/chat-runtime.mjs` — direct API Chat compatibility/special-provider route
- Chat-specific persistent state fields in `StateStore` / `SessionManager`

V4 integration additionally requires:
- LiteLLM local gateway for standard providers
- local-only listener
- validated/pinned stable LiteLLM version
- supervisor lifecycle integration
- health/status integration
- real OpenCode Go compatibility probe before attempting to force it through LiteLLM

## Verification commands

```text
npm test
npm run check
npm run verify:workbuddy
npm run verify:opencode-go
npm run verify:claude-opencode-chat
npm run smoke:local
npm run smoke:discord
npm run verify:hook
npm run doctor:discord
```

## Windows / runtime traps that already cost time once

- **Never use `spawnSync` while a server in the same process has to answer the child.** It blocks the event loop. Use async `spawn`.
- **`shell: true` on Windows means Node quotes nothing.** Quote executable and every argument by hand; see `buildSpawnPlan` / `quoteWindowsArg`.
- **Never write `~/.claude/settings.json` with a BOM.** PowerShell 5.1 can silently break hook loading.
- **A smoke test that depends on the model choosing a destructive command is flaky.** Use an observable safe local side effect or drive the hook client directly.
- Do not simplify Discord networking to one proxy path. The existing gateway and REST proxy handling is deliberate.
- Do not regress fail-closed backend/credential isolation.
- Do not add Postgres/Redis/Kubernetes just because LiteLLM supports them; this is a personal local deployment.
- Do not run two independent full routing engines that fight each other: LiteLLM owns normal provider routing; Jarvis owns policy and special-provider escape hatches.

## Reporting additions

Follow the global concise-reporting rule. For Jarvis include only material project evidence, such as:

- actual Chat provider/model and latency when relevant;
- fallback result when routing changed;
- Work/Agent smoke status;
- Windows/Discord real-machine verification;
- blocker if real smoke could not be completed.
