# V3 架构与验证证据

V3 在 V2 控制面上增加 Executor / Provider / Model 三层，不替换权限、事件展示、watchdog、超时或进程清理。

```text
Discord
  -> DiscordControlPlane
     -> PermissionManager / EventPresenter / SessionManager
     -> ExecutorManager -> ClaudeRunner (stream-json + PreToolUse)
     -> ProviderManager -> CredentialStore
     -> ModelManager
```

## 边界

- **Executor** 是本机 Agent 壳子。Adapter 声明命令、能力、协议、环境与事件标准化。
- **Provider** 是模型线路。Profile 保存 Base URL、协议、计费类型、credential reference、模型缓存与来源。
- **Model** 是 Provider 动态返回或经真实最小请求验证的 Model ID。
- `EventPresenter` 只消费标准化事件；不判断 WorkBuddy / Claude / OpenCode / Codex。
- `PermissionManager` 仍是所有 stream-json Executor 的唯一权限真源。

## ExecutorManager

启动时执行 `--version` 探测，区分 `PASS`、`NOT_INSTALLED` 和 `ADAPTER_NOT_READY`。2026-09-15 本机实测：

| Executor | 版本 | 状态 | 已接协议 |
| --- | --- | --- | --- |
| WorkBuddy | 2.137.1 | PASS | WorkBuddy Native |
| Claude Code | 2.1.270 | PASS | Anthropic Compatible |
| OpenCode | 未安装 | NOT_INSTALLED | 无运行时能力 |
| Codex | 0.154.0 | ADAPTER_NOT_READY | 尚未接入其非 stream-json 事件协议 |

WorkBuddy 和 Claude Code 复用现有 `ClaudeRunner`。OpenCode / Codex 不伪装成可运行；补齐其真实启动参数、session 和事件 schema 后，只需在 `executor-manager.mjs` 增加 Adapter。

Executor 的 `PASS` 只表示本机存在且 Adapter 可运行，不等于 Provider 当前健康。WorkBuddy 启动预检失败或额度不足时只把内置 Provider 标为 `FAIL` / `BLOCKED_BY_QUOTA`，Shared Control Plane 继续上线；不会自动切到任何其他 Provider。

## ProviderManager 与 `!api`

`!api` 仅允许 OWNER 私聊：

1. 接收 Base URL + Key（两行或分两次）。
2. Key 消息先调用 Discord delete；失败会明确要求手动删除。
3. Key 不进入 task、EventPresenter、普通日志或 Provider profile。
4. 内置 `fetch` 探测 OpenAI `/v1/models` / chat completions，再探测 Anthropic models / messages。
5. 根据可靠域名识别 DeepSeek、OpenRouter、MiniMax、GLM、OpenCode Go；否则显示“自定义 API”。
6. 创建 Profile，并计算本机 Executor 兼容性。

普通兼容 API 都使用同一 Generic Provider 实现，不新增 Provider 源文件。只有特殊认证或特殊协议才新增专用逻辑。

## CredentialStore 与隔离

- `data/credentials.json` 只保存 `credentialRef -> secret`，已 gitignore；写入采用临时文件替换并尽力设置 `0600`。
- `data/providers.json` 只保存非 Secret Profile，也已 gitignore。
- `redactSecrets()` 是 Bot 回复、状态、异常与 run log 的统一脱敏入口；显示最多为 `sk-****7F2A`。
- Generic Provider 子进程从系统变量白名单构建环境，只注入当前 Provider 的 URL、Key 与 Model。
- WorkBuddy 子进程只保留系统必需变量及 `WORKBUDDY_*` / `CODEBUDDY_*`，并继续剥离全部付费 Provider 变量。
- 不自动 fallback；错误只报告当前 Provider。

## ModelManager

- `/models` 成功结果缓存在 Provider Profile 中 45 分钟。
- 刷新失败时继续使用上一次成功缓存，并标记 stale。
- 无 models endpoint 时允许 `!model <id>`；通过一次 `max_tokens: 1` 的真实协议请求验证。
- `!models` 每页 15 个，使用上一页 / 下一页按钮，避免生成几十个按钮。

## SessionManager

每个频道 Session 绑定：

```text
cwd + executorId + providerId + model + permission + executorSessionId
```

Executor、Provider、Model 或 cwd 改变都会停止旧进程、取消审批、清除旧 session allow、创建新 Session 并恢复 STANDARD。RUNNING 时禁止这些变化。删除 Provider 同时删除 credential、模型缓存，并使关联 Session 失效。配置不兼容时任务启动会被拒绝；不会自动切 Executor 或 Provider。

## 标准事件

Adapter 将事件标注为：`ANALYZE / SEARCH / READ / WRITE / EDIT / SHELL / TEST / GIT / NETWORK / APPROVAL / DONE / FAILED / CANCELLED / TIMEOUT`。V2 的中文 `EventPresenter` 继续渲染同一条低噪声状态消息。

## 新增扩展

### 新 Executor

在 `ExecutorManager` 登记 id、名称、命令、`supportedProtocols`、能力和 `normalizeEvent()`；只有真实通过版本探测且 Adapter 完整时设置 `adapterReady: true`。若不是 Claude stream-json，需要实现对应 runner，但仍输出统一事件。

### 特殊 Provider

仅在通用 Bearer / `x-api-key` 与标准兼容 endpoint 无法覆盖时新增。Profile 和 credential 仍必须分别进入 `data/providers.json` 与 CredentialStore。

### 普通 API

无需改代码：Discord `!api` -> Base URL + Key -> 协议探测 -> 模型发现 -> 兼容矩阵 -> `!provider` / `!model`。

## OpenCode Go（内置特殊 Provider）

`opencode-go` 是内置 Provider，不是 Generic Provider：

```text
id            : opencode-go
displayName   : OpenCode Go
protocol      : opencode-go
baseUrl       : https://opencode.ai/zen/go
modelsEndpoint: https://opencode.ai/zen/go/v1/models
billingType   : SUBSCRIPTION
credentialRef : provider:opencode-go（只存在于 gitignored CredentialStore）
```

模型列表必须动态获取 `https://opencode.ai/zen/go/v1/models`。2026-09-15 真实返回 **37** 个模型，响应字段只有 `id / object / created / owned_by`，没有任何协议信息，所以 transport 由官方 endpoint 表推导（`openCodeGoTransport()`，来源 `https://opencode.ai/docs/go/#endpoints`）：

| Transport | 模型族 | 端点 |
| --- | --- | --- |
| `anthropic-messages` | `minimax-*`、`qwen*` | `/zen/go/v1/messages` |
| `openai-chat` | `glm-*`、`kimi-*`、`longcat-*`、`deepseek-*`、`mimo-*`、`hy*` | `/zen/go/v1/chat/completions` |
| `openai-responses` | `gpt-*`、`grok-*`、`muse-*` | `/zen/go/v1/responses` |
| `unknown` | 其它（例如 `omen-alpha`） | 不允许选择 |

**Transport 挂在模型上（`model.transport`），不是 Provider 上。** 因此：

- 兼容性判断是 `Executor capability × model.transport`，不是 `executor × provider.protocol`；
- Claude Code 只声明 `supportedTransports: [anthropic-messages]`，所以只有 `minimax-*` / `qwen*` 能被选中；
- 选择一个不兼容模型时 Discord 直接回复 `❌ 当前执行器不支持此模型协议。`，不会等任务启动才失败；
- `unknown` transport 的真实最小验证无法进行，因此 `!model` 会拒绝，绝不猜测。

### 认证与子进程隔离

- `GET /v1/models` 公开且无需鉴权；真实调用仍然带上当前 Provider 的 `x-api-key`。
- `/v1/messages` 只接受 `x-api-key`；`Authorization: Bearer` 返回 `401 Missing API key`。
- 网关要求 session 头（`x-opencode-session` 或 Claude Code 原生 session 头）。Claude Code 原生满足；bridged 探针显式带上 `x-opencode-session`。
- 因此 OpenCode Go + Claude Code 的子进程只注入：

```text
ANTHROPIC_BASE_URL=https://opencode.ai/zen/go
ANTHROPIC_API_KEY=<provider:opencode-go>
ANTHROPIC_MODEL=<model>
```

**不注入 `ANTHROPIC_AUTH_TOKEN`**（Bearer 会被拒绝），也绝不注入其它 Provider 的 Key / Discord Bot Token。子进程环境从系统变量白名单构建（`isolatedBase`），并通过真实测试断言 OpenAI / Anthropic / Discord 凭据都不可见。

### 真实证据（2026-09-15）

`npm run verify:opencode-go`（17/17）：

```text
discovered 37 model(s): {"anthropic-messages":9,"openai-chat":22,"openai-responses":5,"unknown":1}
Claude Code 2.1.270 PASS
model reported by CLI: minimax-m3
apiKeySource: ANTHROPIC_API_KEY
tools: Write, Read, Bash
approval prompts: (none — all auto-allowed by PermissionManager)
final: DONE
opencode-go-test.txt exists, content OPENCODE_GO_OK
git status --short -> ?? opencode-go-test.txt
```

## 自动化证据

- V2 基线：100 passed / 0 failed。
- V3 单元与 Fake Discord：协议探测、无效 URL/Key、动态模型、缓存/过期/stale、手动 Model ID、Provider 删除、Executor discovery、compatibility、Session reset、FULL -> STANDARD、Key 消息删除、全链路脱敏、真实子进程 credential isolation。
- OpenCode Go：37 个真实模型的 transport 映射、内置定义 + 持久化模型缓存（无 Key）、按模型协议的兼容矩阵、`x-api-key`/无 Bearer 的子进程隔离、`unknown` 拒绝、Fake Discord 的 `!provider opencode-go` / `!models` / `!model` 与真实副作用。
- 最终 Windows smoke 与 Git/Secret 扫描结果记录在 `docs/WINDOWS_SMOKE.md` 的 V3 章节。
