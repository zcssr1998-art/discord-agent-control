# Jarvis V4 — Discord AI Terminal Architecture

## Product goal

Jarvis is the stable user-facing AI terminal. Discord is the UI. Model providers and coding agents are replaceable backends.

The user experience must stay stable when OpenCode, WorkBuddy, Claude Code, Codex, DeepSeek, GLM, MiniMax, Gemini, GPT, or any API provider changes.

```text
Discord
  -> Jarvis Core
      -> Chat Runtime (default)
          -> LiteLLM Gateway (primary for standard model APIs)
              -> DeepSeek / GLM / MiniMax / Gemini / GPT / Claude / ...
          -> special direct adapter only when a provider cannot be represented safely in LiteLLM
      -> Work Runtime (explicit)
          -> Agent Adapter -> OpenCode / Claude Code / Codex / WorkBuddy
              -> model transport may use LiteLLM when the Agent supports a compatible API endpoint
```

Critical invariants:
- ordinary chat must never pay the startup/tooling cost of an Agent runtime
- LiteLLM is a model gateway, not the Agent/orchestration layer
- Jarvis remains authoritative for Chat/Work mode, sessions, workspace, permissions, queue, cancellation and Agent lifecycle

## Existing code to preserve

Do not rewrite the repository. Preserve and extend the existing:

- ProviderManager / ModelManager / CredentialStore
- ExecutorManager and protocol compatibility layer
- ClaudeRunner persistent stream-json execution
- PermissionManager + approval hook
- task watchdog / kill-tree / stop semantics
- Discord proxy handling on Windows
- current OpenCode Go transport detection and Anthropic -> OpenAI compatibility gateway

## V4 foundation already added

- `src/mode-router.mjs` — deterministic local `chat` / `work` parser; no LLM routing call
- `src/provider-health.mjs` — failure classification, cooldown and circuit-breaker logic
- `src/chat-runtime.mjs` — direct API Chat implementation retained as compatibility/special-provider path
- `StateStore` / `SessionManager` — default mode = Chat; Chat selection separated from Work Agent selection

The direct Node routing code remains useful for providers that LiteLLM cannot safely represent, but standard providers should go through LiteLLM so Jarvis does not reimplement provider normalization, retries, fallbacks, usage/cost accounting and model aliases.

## LiteLLM role in V4

LiteLLM is now a planned V4 component, not a future-only idea.

Use the official LiteLLM Proxy/Gateway in the smallest possible deployment:
- bind to `127.0.0.1` only
- use a validated stable release and pin that version after smoke testing
- no Postgres, Redis or multi-tenant infrastructure for the personal deployment unless a concrete later requirement needs it
- provider secrets come from environment/secret storage, never committed YAML
- Jarvis talks to one OpenAI-compatible local gateway for normal Chat routes

Expose logical model aliases instead of provider-specific names in Jarvis, for example:

```text
chat-fast
chat-smart
vision
work-fast
work-smart
```

Suggested initial `chat-fast` policy:
1. OpenCode Go DeepSeek 4.1 Flash, if LiteLLM compatibility is proven on the real account
2. OpenCode Go GLM 5.3 Flash, if compatibility is proven
3. other healthy FREE/SUBSCRIPTION routes

OpenCode Go is special: the repository already measured per-model transports and `x-api-key` behavior. Do not assume LiteLLM compatibility. Probe DeepSeek/GLM through LiteLLM on the user's Windows machine. If the real call cannot preserve the required endpoint/auth semantics, keep OpenCode Go behind the existing direct adapter while all normal providers use LiteLLM. Do not break a working subscription route just to force architectural purity.

LiteLLM may handle:
- provider format normalization
- retries and fallbacks
- load balancing across deployments
- rate-limit/cooldown behavior
- cost/token/latency accounting where supported
- model aliases

Jarvis must still enforce:
- no silent METERED/unknown-billing spend in AUTO
- manual pin means no silent cross-provider/model fallback unless the user selected an AUTO alias
- Chat/Work mode separation
- actual provider/model attribution in Discord

## Reusable upstream references

### `atou42/agents-in-discord`
Use for thread/session mapping, settings, model/effort/workspace overrides, progress cards, workspace serial lock/queue and real cancellation.

### `simpolism/discord-agent-bridges`
Use for persistent CLI session lifecycle and bridge separation from the underlying Agent.

### `jakestrouse00/opencode-discord-bot`
Use for OpenCode session/channel follow-ups and OpenCode control patterns.

### `adam-paterson/codex-opencode-notifier`
Use for one Discord thread per tool conversation and reply queue patterns.

### `comeran/discord-codex-bridge`
Use for project/channel binding and serial task execution.

### `Openclaw-Metis/codex-discord-mcp`
Use for resume-by-channel, attachments and least-permissive sandbox defaults.

### `BerriAI/litellm`
Use as the primary standard model gateway. Reuse its routing/fallback/cost/usage behavior instead of duplicating those subsystems in Jarvis.

## Runtime modes

### CHAT (default)

Preferred path:

```text
Discord message
 -> local deterministic parser
 -> Chat Runtime
 -> LiteLLM local gateway
 -> provider/model
 -> response
```

Special compatibility path:

```text
Discord message
 -> Chat Runtime
 -> existing direct provider adapter
 -> provider/model
```

Rules:
- no Agent process
- no workspace scan
- no tool initialization
- no approval hook
- no Agent session creation
- AUTO is default
- failed provider details are hidden if a safe fallback succeeds
- reply footer shows actual provider/model and whether fallback occurred

### WORK (explicit)

Enter by `work`, `/work`, `!work`, or `work <task>`.

```text
Discord Work thread
 -> Work Runtime
 -> Agent Adapter
 -> OpenCode / Claude Code / Codex / WorkBuddy
 -> tools / repo / shell
```

Do not put Agent lifecycle into LiteLLM. LiteLLM can supply a model endpoint to an Agent only when that Agent supports it. Never switch an active Agent implementation in the middle of side effects without a safe checkpoint/handoff.

## Session model

Main channels are Chat-first.

Preferred Work UX:
- `work <task>` creates a Discord thread
- the thread is permanently Work mode
- thread stores workspace, Agent, model alias/model, effort, permissions, queue state and provider session id
- parent channel remains Chat while Work runs

Per-channel mode is acceptable only as a transitional implementation before thread creation lands.

## Provider and cost policy

Default Chat route: `AUTO` / `chat-fast`.

AUTO may select only routes explicitly marked FREE or SUBSCRIPTION unless the user enables paid fallback.

Failure policy:
- 401/403 -> credential problem; disable/cooldown route
- 402/quota -> long cooldown
- 429 -> retry/fallback and cooldown
- 5xx -> short retry/fallback
- timeout/network -> short retry/fallback
- repeated failures -> bounded backoff

Prefer LiteLLM's proven router behavior for standard providers. Keep Jarvis's health registry as a gateway/special-route guard and for attribution, not as a second full provider router that fights LiteLLM.

## Work provider vs model

Agent and model are independent selections:

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

Prefer Discord buttons/select menus for configuration and plain text for conversation. Work progress updates one status card rather than flooding the channel.

## Permissions, queue and persistence

Keep current permissions/approval code. Product presets may later be Safe / Auto / Full.

One writable workspace must have at most one active Work task; other writes queue or report busy.

V4 may keep the existing JSON state for the first milestone. Move to SQLite when queue persistence, chat history, usage history or multiple projects make it useful. Do not introduce Redis/Postgres/Kubernetes for this personal deployment.

## Acceptance targets

### Chat
- `你好` never starts an Agent
- routing overhead is local/gateway-only, not tens of seconds
- LiteLLM path is used for standard compatible providers
- LiteLLM failure does not strand Jarvis: a validated special/direct route may still serve configured FREE/SUBSCRIPTION models

### LiteLLM
- actual stable version pinned after real smoke test
- local-only listener
- health check visible in Jarvis status
- logical aliases work
- fallback and cost/usage metadata are verified with real requests
- OpenCode Go DeepSeek/GLM compatibility is tested, not assumed

### Work
- explicit Work entry only
- existing tool execution, approvals and process-tree cancellation remain functional

### Reliability and cost safety
- quota/rate-limit on the first AUTO route can move to the next safe route
- cooldown prevents hammering a broken route
- manual model/provider pin never silently routes elsewhere
- AUTO never silently uses METERED/unknown-billing APIs
- detailed logs remain in repo/log files; Discord shows compact status only
