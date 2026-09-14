# Gemini 3.8 执行任务书：Discord → Windows Claude Code / DeepSeek 远程控制台

## 0. 任务性质

你不是来重新设计一个概念 Demo，而是接管现有仓库，把它在用户真实 Windows 电脑上跑通并交付可日用的 V1。

**先读现有代码和文档，再改。不要从零重写。**

仓库：`https://github.com/zcssr1998-art/discord-agent-control.git`

## 1. 最终目标

把 iPhone 上的 Discord 变成用户 Windows 开发机的远程 Agent 控制台：

```text
iPhone Discord 发自然语言任务
        ↓
Discord Bot / Gateway
        ↓
Windows 本地 Bridge
        ↓
现有 Claude Code → DeepSeek 4.1 Flash
        ↓
真实读取 / 修改项目 / 跑命令 / 跑测试
        ↓
危险操作才暂停
        ↓
iPhone Discord 按钮审批
        ↓
继续执行
        ↓
Discord 返回精简进度和最终结果
```

**DeepSeek-backed Claude Code 是默认执行器。**

用户另外有：

1. 已经能工作的 Claude Code WebUI + DeepSeek 换脑环境；
2. Codex 的 ChatGPT Plus 额度；
3. ChatGPT 在线聊天，可承担大量研究、规划、审查、任务拆解等非 Agent 工作。

但这三者的优先级是：

- 日常真实执行：DeepSeek Claude Code；
- Codex：仅作为明确失败后的人工升级通道，V1 不强制接入；
- ChatGPT 在线聊天：人工 handoff，不做浏览器劫持或非官方自动化调用。

不要为了“多模型”增加复杂度。

## 2. 第一性原则和边界

### 必须做

- 让 Discord 真正控制用户电脑上的 Claude Code，而不是模拟执行。
- 尽可能复用用户当前已经跑通的 DeepSeek/Claude Code 环境。
- 保留真实 session / cwd / tool execution。
- 手机能看到低噪音实时进度。
- 高风险操作必须能在手机上审批，并且审批决定要真的控制原始 tool call。
- Windows 上实际运行和验证。

### 不要做

- 不重新维护第二套 DeepSeek API Key / Provider 配置，除非实测证明继承现有环境不可行。
- 不屏幕 OCR、键鼠自动化、抓 WebUI DOM 来控制 Claude Code；应控制 CLI/后端进程。
- 不默认接 Codex。
- 不做复杂多 Agent 编排。
- 不做云服务器、数据库、账号系统、语音、图像、音乐等偏题功能。
- 不为了“架构漂亮”推翻能跑的现有代码。

## 3. 现有代码基线

先逐个阅读：

- `src/claude-runner.mjs`：Claude Code 持久进程 / stream-json / session。
- `src/discord-ui.mjs`：Discord 输入输出和审批按钮。
- `src/policy.mjs`：风险分类。
- `src/hook-server.mjs`：本地 Hook 审批服务。
- `src/approval-manager.mjs`：Allow once / Allow session / Deny。
- `scripts/approval-hook.mjs`：Claude `PreToolUse` Hook 客户端。
- `scripts/install-global-hook.ps1`：Windows Hook 安装。
- `docs/WINDOWS_SETUP.md`。
- `docs/开发任务书.md`。
- `tests/`。

现有基线在提交前已经通过：

```text
npm test  -> 10 passed / 0 failed
npm run check -> passed
```

不要为了省事删除、跳过或弱化这些测试。

## 4. 关键兼容性任务：复用用户现有 WebUI + DeepSeek 环境

用户当前已经有一个能工作的 Claude Code WebUI，它后端使用换脑后的 DeepSeek。

你的第一项实机工作不是“重装 Claude Code”，而是确认这套 WebUI 最终如何启动 Claude Code / 如何注入环境变量 / executable 在哪里。

按以下顺序处理：

1. 确认普通 PowerShell 中 `claude` 是否已经继承 DeepSeek 配置并能工作。
2. 如果可以，Bridge 直接调用同一个 `claude` / `claude.cmd` 并继承用户环境，这是首选。
3. 如果 WebUI 使用专门的 wrapper、`.cmd`、启动脚本或环境文件，则让 Bridge 复用这个入口；不要复制一套 Provider 配置。
4. 只有以上都不行时，才增加一个极薄的 adapter 层。
5. 不修改现有 WebUI 的正常使用方式，不把 Discord Bridge 和 WebUI 强耦合。

### 必须验证

Discord 启动的 Agent 实际模型仍然是用户当前 DeepSeek 路由，而不是悄悄回到 Anthropic 官方模型。

把验证方法和结果写入 `docs/WINDOWS_SMOKE.md`，但不要记录任何 token/secret。

## 5. Discord 产品形态

V1 只服务用户自己，优先私人服务器或 DM。

### 普通消息

用户直接发：

```text
把这个项目启动失败的问题修掉，修完自己跑测试
```

Bot 就应把它作为当前绑定项目的 Agent 任务，而不是要求用户先输入复杂命令。

### 最低必要控制

保留或实现：

- `!status`：当前 cwd、session、executor、busy/idle。
- `!cwd <absolute path>`：绑定当前频道/DM 到本地项目。
- `!stop`：停止当前执行。
- `!reset`：清空当前 Discord context 对应 Claude session。
- `!handoff`：生成紧凑的 ChatGPT/Codex handoff 包，可后置到 V1.1，但实现成本低时可以做。

如果改成 Discord Slash Commands 明显更稳定/更适合手机，可以改；但不要为了命令 UI 延迟核心闭环。

## 6. 实时进度要求

手机端要知道 Agent 在干什么，但禁止刷屏。

推荐：一条可编辑状态消息 + 必要的关键事件。

示例：

```text
🟡 Working · 46s
Project: D:\\Projects\\SignalDesk

Last action: Edit src/App.swift
Tests: running
Tools: Read ×4 · Edit ×2 · Bash ×1
```

更新节流，例如 1~2 秒最多一次；不要逐 token 创建 Discord 新消息。

最终只返回：

- 成功/失败；
- 改了什么；
- 核心测试结果；
- 需要用户决策的问题；
- 重要文件/commit。

详细日志写本地/仓库，不要把内部输出全部倒进 Discord。

## 7. 手机权限审批：V1 核心

不要抓终端 permission prompt。

继续以 Claude Code `PreToolUse` Hook 为核心。

Bridge 启动的 Claude 子进程设置：

```text
DISCORD_BRIDGE_ACTIVE=1
```

普通本地 Claude Code / WebUI 没有这个变量时，Hook 必须保持无影响。

### 自动允许

- Read / Glob / Grep 等只读工具；
- 当前 workspace 内普通 Edit / Write；
- `git status/diff/log/show`；
- 正常 lint / test / build；
- 无副作用的项目检查。

### 必须手机确认

- `git push`；
- `git reset --hard` / `git clean` / rebase；
- 删除文件、递归删除、格式化磁盘等；
- package install / publish；
- 外部网络操作；
- workspace 外写入；
- `.env`、credentials、SSH/AWS/GitHub 凭据；
- 未识别且可能写入/执行的 MCP/工具。

审批 UI：

```text
🔐 Agent requests permission
Bash: git push origin main
Project: SignalDesk
Reason: remote side effect

[Allow once] [Allow session] [Deny]
```

### 安全底线

- 只有 `DISCORD_OWNER_ID` 能发任务、切 cwd、stop/reset、审批。
- 本地审批服务只监听 `127.0.0.1`。
- 使用本地随机 secret。
- Bridge 会话审批服务不可达时 **fail closed**。
- 不把 Discord token、DeepSeek token、SSH key 提交 Git。

## 8. Session / Project 行为

每个 Discord channel / thread 至少要绑定：

```text
channel_id -> cwd + Claude session_id
```

目标：

- 用户今天在某频道处理项目 A，明天继续发消息时，仍能恢复项目 A 的上下文；
- `!cwd` 切换项目时，避免错误复用上一个项目的 session；
- `!reset` 只重置当前 context；
- Bridge 重启后 state 能恢复。

如果发现当前状态逻辑存在 session/cwd 交叉污染，优先修。

## 9. Codex 的定位

**V1 不因用户有 Plus 就强行接 Codex。**

只有 DeepSeek 闭环完全跑通后，才评估 V1.1：

```text
[Escalate to Codex]
```

触发方式必须是：

- 用户主动点/命令；或
- DeepSeek 明确多次失败后建议用户升级，而不是自动烧额度。

Codex 如接入，应优先调用用户现有本地 `codex` 登录态 / app-server，保持：

- 同一 cwd；
- 目标；
- 当前错误；
- 已改文件；
- git diff 摘要；
- 测试结果。

不要把完整聊天历史重新灌一遍。

## 10. ChatGPT 在线聊天的定位

ChatGPT 在线聊天不是本项目的后端 API。

不要：

- Selenium 登录 ChatGPT；
- 抓浏览器 cookie；
- 模拟网页操作来“自动调用 Plus”。

可以实现 `!handoff`：

```text
目标：...
项目：...
当前失败：...
已修改：...
测试：...
需要 ChatGPT 判断：...
```

由用户人工粘贴到 ChatGPT，拿到新的任务书后再发回 Discord。

## 11. 你应该优先参考的现成轮子

不要机械复制，但在需要重构前先参考：

- `lyramakesmusic/claudebot-discord`：Discord ↔ persistent Claude Code、Windows supervisor/session 设计。
- `chadingTV/codex-discord`：远程审批和 Codex 接入思路；仅 Phase 2 参考。
- Discord 官方 Gateway / Component 文档。
- Claude Code 官方 hooks / stream-json 行为。

如果现有仓库已经足够简单可靠，不要为了接入这些轮子而大改。

## 12. 第一轮执行步骤

严格按“最高概率问题优先”，不要全盘扫描机器。

1. `git clone` / 拉取本仓库。
2. 阅读代码、README、本任务书。
3. 运行 `node -v`、`npm -v`、`claude --version` 和最低必要环境检查。
4. `npm install`。
5. `npm test` + `npm run check`。
6. 确认现有 DeepSeek Claude Code 在普通终端可以工作；若不行，再查 WebUI 实际启动入口。
7. 配置 Discord Bot：Token、Owner ID、必要 intents。
8. 安装/校验 PreToolUse Hook。
9. 先绑定一个 disposable repo 做真实端到端 smoke test。
10. 从 iPhone Discord 发任务，让 Agent 真创建/修改文件并跑一个测试。
11. 故意触发一条安全但命中“需要审批”的命令，验证：审批前真的阻塞；Allow once 继续；Deny 真阻止。
12. 验证 `!stop / !reset / !status / !cwd`。
13. 重启 Bridge，确认 state/session/cwd 恢复行为。
14. 修复实际发现的问题，重复最小必要测试。
15. 结果写到 `docs/WINDOWS_SMOKE.md` 并提交 Git。

## 13. V1 验收标准

以下全部满足才叫完成：

- [ ] iPhone Discord 能给 Windows Agent 发自然语言任务。
- [ ] 实际执行器是现有 DeepSeek-backed Claude Code。
- [ ] 能真实读、改、运行项目。
- [ ] 手机能看到节流后的实时工具/任务进度。
- [ ] 正常 workspace 编辑无需每次审批。
- [ ] 高风险操作在手机弹出审批。
- [ ] Allow once 真放行原 tool call。
- [ ] Allow session 仅对当前 session / 对应规则生效，不变成全局永久放行。
- [ ] Deny 真阻止原 tool call。
- [ ] Owner 白名单有效。
- [ ] 审批服务异常时 fail closed。
- [ ] 普通本地/WebUI Claude Code 不受 Hook 干扰。
- [ ] `!status / !cwd / !stop / !reset` 可用。
- [ ] Bridge 重启后项目绑定状态可恢复。
- [ ] `npm test` 和最低必要真实 smoke test 通过。
- [ ] 没有 secret/token 被提交。

## 14. 交付方式

开发过程详细记录写到 GitHub，不要在聊天窗口输出大篇过程。

最终只需要向用户汇报：

```text
状态：完成 / 未完成
Windows 端到端：通过 / 未通过
DeepSeek executor：确认 / 未确认
Discord 手机审批：通过 / 未通过
测试：xx passed / xx failed
关键剩余问题：...
Commit：...
```

如果遇到必须由用户完成的 Discord Developer Portal 操作，只给出最短步骤并停在需要用户输入/点击的位置，不要因此重写架构。
