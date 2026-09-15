# AI handoff

Keep this file short and overwrite/update it at every meaningful handoff. Do not paste old chat transcripts here.

## Current task

Jarvis V4 integration: make Chat the default direct-model path, make Work explicit, integrate the standard model gateway, and preserve existing Work Agent behavior.

## Branch

`jarvis-v4-foundation`

## Last known good repository state

Draft PR #2 contains the V4 foundation plus architecture/task updates.

## Done

- local deterministic `chat` / `work` parser
- Chat-specific state fields
- direct ChatRuntime compatibility route
- provider health/cooldown logic
- fallback tests for foundation behavior
- V4 architecture/task docs
- token-efficient development workflow docs

## Pending

- wire ChatRuntime into live Discord message handling
- integrate/install/supervise LiteLLM for standard-provider routing
- real-smoke-test OpenCode Go DeepSeek/GLM through LiteLLM; keep direct adapter if compatibility is not clean
- validate fallback in the actual Windows environment
- validate Work flow and real stop semantics
- later: Work threads, workspace lock/queue, settings/progress UX

## Blocker

None known at documentation/foundation level. Real compatibility and latency require execution on the user's Windows/Discord environment.

## Next action

Read `docs/tasks/CURRENT.md`, then execute the referenced active task. Do not redesign V4 from scratch.

## Verification

```text
npm test
npm run check
```

Then perform the real Windows/Discord Chat, fallback and Work smoke tests required by the active task.

## Minimal relevant files

- `AGENTS.md`
- `docs/CURRENT.md`
- `docs/tasks/CURRENT.md`
- `docs/JARVIS_V4_TASK.md`
- `src/discord-ui.mjs`
- `src/index.mjs`
- `src/chat-runtime.mjs`
- `src/provider-manager.mjs`
- `src/executor-manager.mjs`
