# Jarvis — 初始化设置语义修复 + Owner Defaults 一次配置长期继承

## 结论先行

当前实现方向有产品语义错误：`♻️ 初始化设置` 被实现成了“恢复产品出厂默认值”，导致真实 Discord 中把 Work 路由直接重置成 `WorkBuddy / WorkBuddy Free / 未选择(fast-model)`，这与 owner 的真实目标相反。

**这轮必须马上改成：**

> `初始化设置` = 一次完成 Jarvis 的常用配置，并把这套配置保存为 durable owner defaults；以后重启、新频道、新 Work 线程、新 Agent session 自动继承。

它**绝对不是**恢复出厂设置。

如果保留旧的清空能力，必须改名为 `⚠️ 恢复出厂设置`，放到次级/高级入口，并继续二次确认；不能再占用 `初始化设置` 这个名字，也不能让用户误触后掉回 WorkBuddy。

---

## 当前现场 / 不要重做

分支：`jarvis-settings-persistence-reset-task`

远端已存在：

- `cb3ed4d` — owner defaults + 原“初始化设置(reset)”实现
- `4d3d98e` — 真实 Discord 修复任务书

**本机当前很可能还有 4d3d98e 之后未提交的 live Discord repair 改动。必须保留。**

接手顺序：

1. `git status --short`
2. `git diff --stat`
3. 查看当前未提交 diff，只读与本任务相关部分
4. **禁止 reset / checkout 覆盖 / 丢弃当前未提交修复**
5. 在现有修复上继续改，不重新实现整套 settings/state

之前已经验证通过的 ACK/本地控制面修复、`/status`、`/settings` 不依赖 Chat provider、失败可恢复提示等必须全部保留。

---

## 真实用户目标

Owner 不想每次：

- 重新开权限；
- 重新选 Work executor；
- 重新选 Provider；
- 重新选模型；
- 重启电脑/Jarvis 后再来一遍；
- 新建 Work 线程后再来一遍。

因此产品应当是：

`配置一次 -> 保存为 owner defaults -> 所有后续 scope 自动继承`

而不是：

`点初始化 -> 清空 -> 回 WorkBuddy -> 再重新配置`

---

## 必须实现的产品语义

### A. `♻️ 初始化设置` 改为“初始化/保存默认配置”

点击后打开一个**本地、零模型调用**的初始化配置流程。

最低要求覆盖：

1. **Chat 路由**
   - AUTO，或
   - 手动 Provider + Model
2. **Work Executor**
3. **Work Provider**
4. **Work Model**
5. **Permission tier**
6. **Workspace / 默认工作目录**
   - 复用现有 global workspace 机制
   - 不新增第二套 workspace 状态

允许复用现有 Settings 页面/按钮/选择器，不要求做华丽新 UI。优先最低复杂度。

### B. 初始化完成后保存为 durable owner defaults

确认保存后：

- 写入现有 `preferences.ownerDefaults`；
- 立即应用到当前 scope；
- 新频道继承；
- 新 Work thread 继承；
- Bridge/Supervisor 重启后继承；
- Windows 重启后继承；
- model/provider/executor/workspace 导致的新 Agent session 仍继承；
- 不依赖内存 Map 才能恢复。

**禁止保存 transient 状态：** sessionId、run/busy、pending approval、one-shot allow、cooldown、progress 等。

### C. 继承优先级保持一致

继续保持：

`当前 scope 显式覆盖 > workspace 选择 > owner defaults > product built-in`

但初始化流程保存完成后，当前 scope 必须同步到所选值，不能被旧 channel override 留在 UI 上造成“保存了默认但当前还是旧值”的错觉。

### D. 普通显式修改继续更新 owner defaults

Owner 在正常设置 UI / `/model` / 权限 / executor / provider 中做出的**显式选择**，继续视为 owner 的长期偏好并更新 owner defaults。

Trusted thread inheritance、内部恢复、自动 fallback 不得反向覆盖 owner defaults。

### E. 原“恢复出厂”能力处理

当前 `#factoryReset` / `!reset-settings` 如继续保留：

- UI 名称必须改成 `⚠️ 恢复出厂设置`；
- 不能再显示成 `初始化设置`；
- 必须二次确认；
- Work active 时继续拒绝；
- 继续保证 credentials/providers/chat history/task history/run DB/logs/updater/repo 不被删除；
- 允许恢复 product built-in，但这是**独立高级动作**，不能作为初始化流程的一部分。

如果当前产品没有强需求，可以先隐藏 UI 入口，仅保留安全的内部/文本命令；不要为了这轮增加复杂度。

---

## 兼容性和安全边界

### Provider / Executor / Model 合法性

保存 owner defaults 前必须验证：

- executor 存在且 available；
- provider 存在且可用于所选 executor；
- model 属于该 provider（provider 能枚举模型时必须精确验证）；
- 不兼容组合必须明确报错，**不得写入 owner defaults**；
- 不允许新 scope 因一套坏 owner defaults 直接进入不可用路由。

### 控制面必须与模型健康解耦

以下功能必须在 Chat provider 完全挂掉时仍可用：

- `/status`
- `/settings`
- `初始化设置`
- `恢复出厂设置`（如保留）
- 权限、executor、provider、model 配置入口

它们是本地控制面，**禁止经过 Chat/Work/LiteLLM/LLM**。

### Secrets

任何测试、日志、状态卡、diff、任务报告不得输出 API Key / token / cookie / credential 内容。

---

## UX 最低要求

不要让用户猜“初始化设置”到底做什么。

Settings 页面至少显示一句：

> `初始化设置：配置并保存你的默认 Chat / Work / 权限 / 工作目录；以后重启和新线程自动继承。`

保存成功后明确显示实际保存的 owner defaults 摘要，例如：

`默认配置已保存：Claude Code · OpenCode Go · deepseek-v4.1-flash · 🔓全开放 · D:\xxx · Chat AUTO`

如果配置未完整，不要静默保存半套；提示缺哪一项。

---

## 不要做的事

- 不重写 StateStore / SessionManager / PermissionManager；扩展现有实现。
- 不新增第二个配置数据库。
- 不引入 Redis/Postgres 等依赖。
- 不改现有 secrets/credential 存储。
- 不因为“初始化设置”去清空聊天记录或任务记录。
- 不把 WorkBuddy 作为 owner 的强制默认。
- 不把 `fast-model` 之类内部 fallback 当成 owner 已选择模型显示。
- 不回退已经完成的 live Discord ACK 修复。
- 不合并 `main`，直到 owner 真人 Discord 验收 PASS。

---

## 最小验收标准

### 1. 自动化

至少新增/修改测试覆盖：

- 初始化入口不再调用 factory reset；
- 初始化保存 owner defaults；
- 当前 scope 立即同步；
- 新 channel 继承；
- 新 Work thread 继承；
- restart 后继承；
- permission 继承；
- workspace 继承；
- incompatible executor/provider/model 不写 defaults；
- Chat provider 故障时 `/status`、`/settings`、初始化流程仍工作；
- 恢复出厂（若保留）与初始化是两个完全不同的 action；
- credentials/history/task DB 未受影响。

运行最低集合：

```text
npm test
npm run check
npm run smoke:owner-settings
npm run smoke:p222
npm run smoke:p2
```

若现有 live repair 有更针对性的 smoke，一并跑它；不要无目的全仓扫描。

### 2. 真实 Discord owner 验收

必须在人类 owner 账号上验证，不能用 fake Discord 代替最终 PASS：

1. `/settings` 正常打开。
2. 点 `♻️ 初始化设置`，应进入配置/保存默认流程，**绝不能立刻重置到 WorkBuddy**。
3. 设置一套非产品默认配置，例如：
   - executor = Claude Code
   - provider = OpenCode Go
   - model = 当前可用模型
   - permission = owner 指定档位
   - workspace = 当前项目目录
   - Chat = AUTO 或 owner 指定 pin
4. 保存后 `/status` 立即显示这套配置。
5. 重启 Bridge，再 `/status`，配置不变。
6. 新建 Work thread，executor/provider/model/permission/workspace 自动继承。
7. 若保留 `恢复出厂设置`，单独验证 cancel 不变、confirm 才恢复 built-in。

**只有这 7 步全部通过才允许 PASS。**

---

## 完成标准

完成后：

1. 更新相关 current/handoff 状态文件，但不要重复长日志；
2. commit 到当前任务分支；
3. push；
4. 不 merge main；
5. 最终只回：

```text
PASS | FAIL
commit: <sha or none>
tests: <compact results>
blocker: <none or one blocker>
owner_live: PASS | PENDING | FAIL
```

当前目标是**尽快修正确产品语义并恢复可用**，不要扩展到 P3 或做无关重构。
