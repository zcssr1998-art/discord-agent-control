# Jarvis V4 — Discord AI Terminal Architecture

## Product goal

Jarvis is the stable user-facing AI terminal. Discord is the UI. Model providers and coding agents are replaceable backends.

The user experience must stay stable when OpenCode, WorkBuddy, Claude Code, Codex, DeepSeek, GLM, MiniMax, Gemini, GPT, or any API provider changes.

```text
Discord
  -> Jarvis Core
      -> Chat Runtime (default)
          -> Provider Router -> direct model API
      -> Work Runtime (explicit)
          -> Agent Adapter -> OpenCode / Claude Code / Codex / WorkBuddy
```

Critical invariant: ordinary chat must never pay the startup/tooling cost of an Agent runtime.

## Existing code to preserve

Do not rewrite the repository. Preserve and extend the existing:

- ProviderManager / ModelManager / CredentialStore
- ExecutorManager and protocol compatibility layer
- ClaudeRunner persistent stream-json execution
- PermissionManager + approval hook
- task watchdog / kill-tree / stop semantics
- Discord proxy handling on Windows
- current OpenCode Go transport detection and Anthropic -> OpenAI compatibility gateway

## New foundation already added on `jarvis-v4-foundation`

- `src/mode-router.mjs`
  - deterministic local `chat` / `work` parser
  - no LLM routing call
  - handles bot mentions
- `src/provider-health.mjs`
  - failure classification
  - circuit breaker / cooldown / bounded exponential backoff
- `src/chat-runtime.mjs`
  - direct model API chat path
  - OpenAI Chat / Anthropic Messages / OpenAI Responses
  - OpenCode Go transport support
  - AUTO fallback
  - manual provider/model pin does not silently fall back
  - AUTO excludes metered/unknown billing unless explicitly enabled
- `StateStore` / `SessionManager`
  - default mode = `chat`
  - separate `chatProviderId` / `chatModel`
  - existing Agent executor/provider/model/session preserved

## Reusable upstream design references

Do not copy whole projects blindly. Reuse proven patterns with the minimum necessary code.

### `atou42/agents-in-discord`
Use as the main interaction reference:
- channel/thread -> provider session mapping
- settings panel
- provider/model/effort/workspace overrides
- progress card instead of message spam
- workspace serial lock / queue
- real cancellation

### `simpolism/discord-agent-bridges`
Use for:
- persistent CLI session lifecycle
- session continuity after bridge restart
- stop/newsession/compact/fork/status style controls
- bridge separation from the underlying CLI agent

### `jakestrouse00/opencode-discord-bot`
Use for:
- OpenCode session/channel follow-ups
- OpenCode serve/session lifecycle
- Discord <-> OpenCode control patterns

### `adam-paterson/codex-opencode-notifier`
Use for:
- one Discord thread per tool conversation
- reply queue pattern between Discord and Codex/OpenCode

### `comeran/discord-codex-bridge`
Use for:
- project/channel binding
- serial task execution

### `Openclaw-Metis/codex-discord-mcp`
Use for:
- resume-by-channel
- attachment delivery
- least-permissive sandbox defaults

### `BerriAI/litellm`
Treat as an optional future gateway, not a V4 dependency by default.
Its useful patterns are provider normalization, retry/fallback, cost tracking and routing. The current Node code already supports the concrete protocols needed for the first V4 milestone, so adding a Python proxy now would increase operational complexity without solving the immediate bottleneck.

## Runtime modes

### CHAT (default)

Path:

```text
Discord message
 -> local command parser
 -> ChatRuntime
 -> Provider health/circuit breaker
 -> direct model API
 -> response
```

Rules:
- no Agent process
- no workspace scan
- no tool initialization
- no approval hook
- no agent session creation
- AUTO is default
- ordinary failures silently fall back when safe
- actual model/provider is shown in a short footer

### WORK (explicit)

Enter by:
- `work`
- `/work`
- `!work`
- `work <task>`

Path:

```text
Discord work thread
 -> Work Runtime
 -> Agent Adapter
 -> OpenCode / Claude Code / Codex / WorkBuddy
 -> tools / repo / shell
```

Work fallback is conservative. Never switch an active Agent implementation in the middle of side effects. Model fallback is allowed only at a safe boundary or after a saved checkpoint/handoff.

## Session model

Main channel should remain Chat-first.

Preferred Work UX:
- `work <task>` in the main channel creates a Discord thread
- the thread is permanently `mode=work`
- thread stores workspace, agent, model, effort, permissions, queue state, provider session id
- the parent channel remains Chat and can be used while Work runs

Until thread creation is implemented, per-channel `mode` is acceptable as a transitional fallback.

## Provider policy

Default Chat route: `AUTO`.

Initial preference for the user's current setup:
1. OpenCode Go DeepSeek Flash
2. OpenCode Go GLM Flash
3. other FREE/SUBSCRIPTION healthy models

AUTO must not silently use METERED or unknown-billing providers. Manual selection may use them.

Failure handling:
- 401/403 -> disable/cooldown as credential problem
- 402/quota -> long cooldown
- 429 -> short cooldown
- 5xx -> short cooldown and fallback
- timeout/network -> short cooldown and fallback
- repeated failures -> bounded exponential cooldown

If fallback succeeds, do not spam the channel with the failed backend error. Show only a compact footer such as `GLM · fallback from DeepSeek`.

## Work provider vs model

Agent and model are independent selections.

Examples:

```text
OpenCode + DeepSeek
OpenCode + GLM
Claude Code + DeepSeek
Codex + GPT
```

Do not encode `WorkBuddy == DeepSeek` or `OpenCode == one model` into core state.

## Discord UI target

Minimum controls:
- `work` / `chat`
- `/mode`
- `/model`
- `/agent`
- `/project`
- `/status`
- `/cancel`
- `/new`
- `/compact`
- `/settings`

Prefer buttons/select menus for configuration and plain text for conversation.

Work progress should update one status card rather than post a log stream.

## Permissions

Keep current permissions and approval code. Expose three product-level presets later:
- Safe
- Auto
- Full

Do not weaken OWNER checks, secret redaction, timeout, stop, or backend verification.

## Queue / locking

One writable workspace must have at most one active Work task.

Other tasks targeting the same workspace:
- queue, or
- return a clear busy state

Do not allow two independent Agents to concurrently edit the same workspace by default.

## Persistence

V4 milestone may continue using the existing JSON state file for compatibility.

Move to SQLite only when the code needs:
- task queue persistence
- chat history
- session indexing
- usage history
- multiple projects/workspaces

Do not introduce Redis/Postgres/Kubernetes for this personal deployment.

## Acceptance targets

### Chat latency
For a healthy fast provider and a trivial prompt such as `你好`:
- routing overhead must be effectively local-only
- no Agent is spawned
- first useful response should be provider-limited, not tens of seconds of Jarvis overhead

### Work
- explicit Work entry only
- existing tool execution and approval behavior remains functional
- `!stop`/cancel still truly kills the child process tree

### Reliability
- quota/rate-limit on the first Chat model automatically moves to the next healthy subscription/free candidate
- cooldown prevents hammering the failed model on every message
- manual provider/model pin never silently routes elsewhere

### Cost safety
- AUTO does not silently use metered/unknown-billing APIs
- detailed logs remain in repo/log files; Discord shows compact status
