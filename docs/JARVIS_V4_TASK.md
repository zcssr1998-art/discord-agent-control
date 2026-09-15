# OpenCode DS Task — Integrate Jarvis V4 Chat/Work Runtime

## Mission

Continue the existing repository. Do not rewrite it.

Repository: `zcssr1998-art/discord-agent-control`
Branch to continue from: `jarvis-v4-foundation`
Base commit before V4 foundation: `30d01bf2714afcdd3353fac02b900c0242b50bd1`

Read first:
1. `AGENTS.md`
2. `docs/JARVIS_V4_ARCHITECTURE.md`
3. `docs/WINDOWS_SMOKE.md`
4. existing `src/discord-ui.mjs`, `src/provider-manager.mjs`, `src/executor-manager.mjs`

## Real user goal

Jarvis must behave like a Codex-style Discord AI terminal:

- default is fast ordinary Chat
- sending `work` enters/creates a real Agent workflow
- Chat must not invoke WorkBuddy/OpenCode/Claude Code/Codex Agent machinery
- Work may use OpenCode / Claude Code / Codex / WorkBuddy as interchangeable Agent backends
- providers/models are replaceable and AUTO-routed
- later API/provider changes must not change the Discord interaction model

Immediate bugs to eliminate:
1. `你好` taking ~55 seconds because it enters the Agent path
2. `切换成 OpenCode DeepSeek` being sent to WorkBuddy instead of handled locally
3. WorkBuddy quota failure blocking a usable OpenCode Go DeepSeek/GLM backend

## Foundation already implemented — use it

Do not duplicate these modules:
- `src/mode-router.mjs`
- `src/provider-health.mjs`
- `src/chat-runtime.mjs`
- Chat fields in `StateStore` / `SessionManager`

Tests for the foundation must stay green.

## Phase 1 — wire ChatRuntime into the real Discord path (P0)

### 1. Instantiate ChatRuntime in `src/index.mjs`
Pass the existing `ProviderManager` and `CredentialStore`.
Do not create a second provider database or secret store.

### 2. Update `DiscordControlPlane`
Add `chatRuntime` dependency.

At the top of message handling:
- strip the bot's own mention with `stripSelfMention`
- parse `chat`/`work` with `parseModeCommand`
- process mode changes locally, before any Agent runner is touched

Rules:
- default state is Chat
- `work` -> change mode to Work
- `chat` -> change mode to Chat
- `work <prompt>` -> switch and execute prompt as Work
- `chat <prompt>` -> switch and execute prompt as Chat
- `/work`, `!work`, `/chat`, `!chat` must also work
- mode commands must not call a model

### 3. Add `runChat()`
`runChat()` must call only `ChatRuntime.send()`.
It must never call:
- `getRunner()`
- `ExecutorManager.createRunner()`
- approval hooks
- workspace inspection
- Agent session startup

Output footer example:

```text
💬 Chat · OpenCode Go · deepseek-v4.1-flash · 1.8s
```

If AUTO falls back:

```text
💬 Chat · OpenCode Go · glm-5.3-flash · fallback · 2.1s
```

Do not print the full failed-provider error when a fallback succeeds.

### 4. Route ordinary messages by mode
After local/config commands:

```text
mode=chat -> runChat
mode=work -> existing runTask
```

Existing Agent behavior must remain unchanged in Work mode.

## Phase 2 — Chat provider/model controls (P0)

Add deterministic controls. Reuse existing ProviderManager model data.

Required:
- `!chatmodel` -> current Chat route
- `!chatmodel auto`
- `!chatmodel <provider-id> <model-id>`
- status output shows separate Chat and Work configuration

Do not overload existing `!model` semantics if doing so would make Work sessions ambiguous.

AUTO policy:
1. OpenCode Go DeepSeek Flash
2. OpenCode Go GLM Flash
3. other healthy FREE/SUBSCRIPTION providers/models
4. never use METERED/UNKNOWN automatically unless an explicit setting enables it

Manual pin must never silently fallback.

## Phase 3 — Discord thread Work sessions (P1)

Reuse the design patterns from:
- `atou42/agents-in-discord`
- `adam-paterson/codex-opencode-notifier`
- `simpolism/discord-agent-bridges`

Preferred behavior:
- parent channel is Chat
- `work <task>` creates a thread
- thread is permanently Work mode
- one thread maps to one Agent session
- subsequent plain messages in that thread continue the same session
- parent channel can still Chat while the Work thread is running

Do not block Phase 1 on thread support. First make Chat fast and correct.

## Phase 4 — Agent adapter cleanup (P1)

Current `ExecutorManager` is the starting point. Extend it instead of replacing it.

Target adapters:
- OpenCode
- Claude Code compatible runner
- Codex
- WorkBuddy

Agent and model must stay independent.

Create/standardize an adapter contract only if necessary:

```text
start / resume / send / cancel / status / compact / dispose
```

Do not create an abstraction layer larger than the concrete implementations require.

## Phase 5 — queue and workspace lock (P1)

Reuse `agents-in-discord` / `discord-codex-bridge` patterns.

Rules:
- one writable workspace -> one active Work task
- same-workspace second task queues or reports busy
- `/cancel` / `!stop` must truly terminate the active child process and clear the queue when requested
- preserve existing process-tree kill semantics

## Phase 6 — settings/status UX (P1)

Keep text commands but add Discord-native settings gradually.

Status should show:

```text
Jarvis       🟢
Mode         💬 Chat / 🛠 Work

CHAT
Route        AUTO
Actual       OpenCode Go / DeepSeek 4.1 Flash
Health       healthy

WORK
Agent        OpenCode
Provider     OpenCode Go
Model        DeepSeek 4.1 Flash
Workspace    D:\...
Permission   Auto
State        idle/running/queued
```

Avoid verbose provider diagnostics in ordinary replies.

## Phase 7 — attachments and context (P2)

After P0/P1 are stable:
- Discord image/file attachments to Chat models
- attachments to Work thread workspace/temp directory
- chat history + compact
- `/new` and `/compact`

Do not add vector DB/RAG/multi-agent teams in this task.

## Reuse policy

Before writing a subsystem from scratch, inspect the referenced upstream implementation and reuse the smallest proven pattern.

Do NOT vendor entire repositories unless there is a concrete reason.
Do NOT add LiteLLM yet unless the current Node provider layer cannot satisfy a concrete provider. The current problem does not justify another long-running service.

## Tests and acceptance — mandatory

Run at minimum:

```text
npm test
npm run check
```

Add focused tests proving:

1. new/legacy channels default to Chat
2. `work`, `/work`, `!work`, `chat`, `/chat`, `!chat` are local deterministic commands
3. `你好` in Chat does not invoke `getRunner()` / Agent executor
4. Work mode still invokes existing `runTask()`
5. OpenCode DeepSeek 429/quota -> AUTO falls back to GLM
6. cooldown prevents retrying the same broken model on the next message
7. manual model pin never silently falls back
8. provider error after successful fallback does not spam the channel
9. `!stop` still kills a real Agent process in Work mode
10. legacy state files load without migration failure

Then on the user's Windows machine run the minimum real smoke test:

### Chat smoke
- OpenCode Go credential configured
- send `你好`
- verify no WorkBuddy/Claude Agent child process is spawned for that turn
- record actual response latency and actual provider/model

### Fallback smoke
- temporarily force/imitate first model unavailable
- verify second healthy model answers automatically

### Work smoke
- `work`
- execute a disposable repo task that causes real read/write/tool execution
- verify existing permission/stop behavior
- `chat`
- send ordinary question and verify it returns to direct Chat path

Persist detailed results in `docs/WINDOWS_SMOKE.md` or a new V4 smoke document. Do not paste long logs into Discord/chat.

## Completion definition

P0 is complete only when the user's original failure is impossible by design:

- ordinary Chat cannot accidentally enter WorkBuddy/Agent path
- local mode/model control cannot be interpreted as a user prompt by WorkBuddy
- WorkBuddy quota cannot block Chat when another configured healthy Chat provider exists

Commit code + tests + concise docs. Do not claim success from code inspection alone.
