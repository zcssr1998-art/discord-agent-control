# OpenCode DS Task — Integrate Jarvis V4 + LiteLLM Gateway

## Mission

Continue the existing repository. Do not rewrite it.

Repository: `zcssr1998-art/discord-agent-control`
Branch: `jarvis-v4-foundation`
Base before V4 foundation: `30d01bf2714afcdd3353fac02b900c0242b50bd1`

Read first:
1. `AGENTS.md`
2. `docs/JARVIS_V4_ARCHITECTURE.md`
3. `docs/WINDOWS_SMOKE.md`
4. existing `src/discord-ui.mjs`, `src/provider-manager.mjs`, `src/executor-manager.mjs`, `src/chat-runtime.mjs`

## Real user goal

Jarvis is the permanent Discord AI terminal. Providers/models/Agent CLIs are replaceable backends.

- default is fast ordinary Chat
- `work` enters/creates a real Agent workflow
- Chat must never invoke WorkBuddy/OpenCode/Claude Code/Codex Agent machinery
- Work may use OpenCode / Claude Code / Codex / WorkBuddy
- LiteLLM becomes the primary standard model gateway
- provider/API changes should normally require config changes, not Jarvis UI changes

Immediate bugs to eliminate:
1. `你好` taking ~55 seconds because it enters the Agent path
2. model-switch language being sent to WorkBuddy instead of handled locally
3. WorkBuddy quota blocking usable OpenCode Go DeepSeek/GLM

## Existing V4 foundation — use it

Do not duplicate:
- `src/mode-router.mjs`
- `src/provider-health.mjs`
- `src/chat-runtime.mjs`
- Chat fields in `StateStore` / `SessionManager`

`src/chat-runtime.mjs` is now the compatibility/direct-provider path. Standard provider routing should move behind LiteLLM where real compatibility is proven.

# P0 — Chat/Work split

## Wire ChatRuntime into Discord

Instantiate ChatRuntime in `src/index.mjs` and inject it into `DiscordControlPlane`.

At the top of message handling:
- strip self mention
- parse `chat`/`work` locally
- process mode changes before any Agent runner is touched

Required:
- default = Chat
- `work`, `/work`, `!work`
- `chat`, `/chat`, `!chat`
- `work <prompt>` switches + executes as Work
- `chat <prompt>` switches + executes as Chat

Mode commands must never call an LLM.

## Add `runChat()`

`runChat()` must not call:
- `getRunner()`
- `ExecutorManager.createRunner()`
- approval hooks
- workspace inspection
- Agent session startup

Ordinary messages route by mode:

```text
mode=chat -> runChat
mode=work -> existing runTask
```

Existing Work behavior must remain functional.

# P0.5 — install and integrate LiteLLM

LiteLLM is now required as the primary gateway for standard model APIs.

Use the official LiteLLM Proxy/Gateway. Prefer the lowest-complexity Windows deployment:
- if `uv` is available, use the official `litellm[proxy]` installation path
- otherwise use a local Python venv/pip path
- use Docker only if it is already present and simpler on this machine
- after a successful smoke test, pin the validated LiteLLM version; do not leave `latest` floating

Runtime requirements:
- listen on `127.0.0.1` only
- no Postgres
- no Redis
- no multi-tenant setup
- secrets via env/secret storage, never committed
- integrate LiteLLM lifecycle into the existing Windows supervisor/start flow so Jarvis starts/restarts predictably
- Jarvis `/status` or `!status` shows LiteLLM health

## Logical aliases

Create a minimal gateway config with logical names instead of leaking provider IDs throughout Jarvis:

```text
chat-fast
chat-smart
vision
```

Do not add aliases that are not yet used.

`chat-fast` should prefer the user's cheap/subscription routes. Initial intent:
1. OpenCode Go DeepSeek 4.1 Flash
2. OpenCode Go GLM 5.3 Flash
3. other configured FREE/SUBSCRIPTION routes

## Critical OpenCode Go compatibility check

Do not assume LiteLLM can proxy OpenCode Go correctly.

The repository has already verified:
- DeepSeek/GLM use OpenAI chat transport
- OpenCode Go has special endpoint/auth behavior including `x-api-key`

On the actual Windows machine:
1. configure a temporary LiteLLM route for OpenCode Go DeepSeek
2. make a real minimal request through LiteLLM
3. verify endpoint, model ID and auth are preserved
4. repeat for GLM
5. verify fallback DS -> GLM

If LiteLLM cannot preserve OpenCode Go semantics cleanly:
- keep OpenCode Go behind the existing direct adapter
- keep LiteLLM as primary gateway for normal providers
- do not create a hack that leaks secrets or rewrites the working OpenCode path

The goal is a stable gateway architecture, not forcing every provider through LiteLLM at any cost.

## Routing authority

LiteLLM should own standard-provider:
- normalization
- retry/fallback
- load balancing
- usage/cost metadata
- provider cooldowns where supported

Jarvis still owns:
- Chat vs Work
- safe billing policy
- manual pin vs AUTO semantics
- actual provider/model attribution
- special direct-provider fallback when LiteLLM cannot support a provider safely

Do not maintain two independent full fallback engines that fight each other. Keep `ProviderHealthRegistry` as a gateway/special-route guard and for local health/attribution.

## Billing safety

AUTO aliases may only include explicitly FREE or SUBSCRIPTION routes by default.
METERED/UNKNOWN routes require explicit enablement.
Manual pin must not silently jump to another model/provider.

# P0.6 — Chat controls

Required:
- `!chatmodel` -> current Chat route
- `!chatmodel auto`
- `!chatmodel <provider-or-alias> [model]`
- status shows separate Chat and Work configuration
- status shows LiteLLM up/down and actual served model when known

Do not make existing Work `!model` ambiguous.

# P1 — Work threads

Reuse patterns from:
- `atou42/agents-in-discord`
- `adam-paterson/codex-opencode-notifier`
- `simpolism/discord-agent-bridges`

Preferred behavior:
- parent channel stays Chat
- `work <task>` creates a thread
- thread is permanently Work
- one thread maps to one Agent session
- subsequent messages continue that session
- parent channel can still Chat while Work runs

Do not block P0/P0.5 on thread support.

# P1 — Agent adapter cleanup

Extend existing `ExecutorManager`; do not replace it.

Targets:
- OpenCode
- Claude Code compatible runner
- Codex
- WorkBuddy

Agent and model remain independent.

Only introduce an adapter contract if the concrete implementations need it:

```text
start / resume / send / cancel / status / compact / dispose
```

LiteLLM is not an Agent adapter.

# P1 — queue/workspace lock

Reuse `agents-in-discord` / `discord-codex-bridge` patterns.

Rules:
- one writable workspace -> one active Work task
- same-workspace second task queues or reports busy
- `/cancel` / `!stop` truly kills the active child process tree
- preserve current process-tree kill semantics

# P1 — status/settings UX

Target status:

```text
Jarvis       🟢
Mode         💬 Chat / 🛠 Work
LiteLLM      🟢 / 🔴

CHAT
Route        AUTO / chat-fast
Actual       provider / model
Fallback     none / from X
Latency      ...

WORK
Agent        OpenCode
Provider     ...
Model        ...
Workspace    D:\...
Permission   Auto
State        idle/running/queued
```

Do not dump verbose gateway/provider diagnostics into ordinary Discord replies.

# P2 — attachments/context

After P0/P1 are stable:
- image/file attachments to Chat
- attachments to Work thread workspace/temp
- chat history + compact
- `/new` and `/compact`

Do not add RAG/vector DB/multi-agent teams in this task.

# Tests and acceptance — mandatory

Run at minimum:

```text
npm test
npm run check
```

Add/keep tests proving:
1. new/legacy channels default to Chat
2. mode commands are local/deterministic
3. `你好` in Chat never invokes Agent runner creation
4. Work still invokes existing Agent path
5. AUTO fallback works
6. cooldown prevents hammering a failed route
7. manual pin never silently falls back
8. successful fallback does not spam raw backend errors
9. `!stop` still kills a real Work Agent process
10. legacy state loads cleanly
11. LiteLLM health failure is handled without crashing Jarvis
12. safe billing policy prevents AUTO metered use

## Real Windows smoke — required

### A. LiteLLM install/lifecycle
- install validated stable LiteLLM
- run local-only on `127.0.0.1`
- restart via supervisor
- verify health after restart
- record pinned version

### B. OpenCode Go through LiteLLM
- real DeepSeek request
- real GLM request
- real DS -> GLM fallback test
- if incompatible, document exactly why and retain direct adapter

### C. Chat
Discord sends `你好`:
- no WorkBuddy/Claude/OpenCode/Codex Agent child process for this turn
- record total response latency
- record actual route/provider/model

### D. Gateway fallback
Force first safe route unavailable:
- next safe route answers
- next message does not hammer failed route
- raw failure does not pollute Discord

### E. Work
- send `work`
- execute a disposable repo task with real read/write/command
- verify permission and `!stop`
- send `chat`
- ordinary question returns to direct Chat path

Persist detailed logs/results in repo docs, not chat.

# Completion definition

Do not claim complete until:
- ordinary Chat cannot accidentally enter Agent path
- local mode/model control cannot be interpreted as WorkBuddy prompt
- WorkBuddy quota cannot block Chat when another safe route exists
- LiteLLM is installed, supervised, health-checked and used for compatible standard providers
- OpenCode Go compatibility with LiteLLM is proven or explicitly rejected by real evidence while the direct adapter remains functional
- tests + real Windows smoke pass

Commit and push to `jarvis-v4-foundation`; update PR #2; do not merge main yet.
