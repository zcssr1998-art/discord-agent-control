# DSH 多智能体 Manager 对照实验报告（2026-11-01）

> 规范来源：`docs/experiments/DSH_MULTI_AGENT_MANAGER_BENCHMARK.md`（下称「任务书」）
> 历史：旧 kkrich C 组为 INVALID_ROUTE、旧 A/B 为自制 HTTP 执行器，均已撤回，原文在 Git 历史 `ef8790b`。本版为**九次正式运行全部完成后的最终报告**。
> 本报告只写实际跑出来的东西。凡是拿不到的证据一律标 N/A 并说明原因，不做估算冒充。

---

## 1. 执行摘要（结论先行）

| 结论 | 数值 |
| --- | --- |
| 九次正式运行完成度 | 9 / 9（A/B/C × T1/T2/T3），全部在 25 分钟硬超时内 |
| 独立验收通过 | **9 / 9 全通过**（T1 31/31、T2 32/32、T3 27/27） |
| B 组（DS Manager + DS Worker）相比 A 组（DS 单代理）成本 | **+125.4%**（\$0.120337 → \$0.271223） |
| B 组相比 A 组耗时 | **+28.3%**（996 秒 → 1278 秒） |
| B 组相比 A 组质量 | **零提升**（同为满分验收），且 T2 出现交付完整性缺口（数据层测试未进 npm test） |
| C 组（GPT Sol 6.1 Manager）相比 B 组质量 | **零提升**（同为满分验收） |
| C 组相比 B 组耗时（能比的三次） | T1 −28.4%、T2 −6.3%、T3 −66.6%，但三次都被额度墙打断 |
| C 组 Manager 端到端闭环 | **0 / 3**（Manager 均在第 4 次请求被硬上限拦下，最终 Review 未完成） |

一句话：**在这三个任务上，多智能体 Manager 结构带来的是成本与耗时上升，没有任何质量收益；换更强的 GPT Sol 6.1 Manager 也没有改变这个结论，反而被额度墙反复打断。**

---

## 2. 实际使用的模型身份（必须先看这一节）

任务书 §6 要求记录真实 provider / model / thinking，不接受「应该是」。本节是全部实测证据。

### 2.1 三条线路与中途变更

| 阶段 | Manager 线路 | Worker 线路 | 变更原因 |
| --- | --- | --- | --- |
| C 组（原生 headless 首跑） | `codex` / `gpt-6.1-sol` / reasoningEffort=high | `cline-api` / `cline-pass/deepseek-v4.1-flash-1017` | 任务书既定 |
| A / B 组（补跑） | `opencode-go` / `deepseek-v4.1-flash` | 同左 | 用户指令 m01344「改用图里的 ds 接力」：Cline Pass 周额度 429 耗尽、Codex 五小时窗口已用 82% |
| C 组 T3（接力） | `opencode-go` / `deepseek-v4.1-flash` | 同左 | 同上 |

**必须点明**：C 组并非单一模型闭环。C-T1 与 C-T2 的 Manager 是 GPT Sol 6.1（high）；C-T3 首轮因 Cline Pass 周额度 429 无任何产物，改用 OpenCode Go DeepSeek 接力后 Manager 与 Worker 全部换成 DS。报告后文涉及 C 组 Manager 的结论，按「GPT Manager（T1/T2）+ DS Manager（T3 接力）」理解。

### 2.2 逐会话身份与用量（账本实证）

A/B 组用量来自 `~/.dsh/storages/cost-meter/ledger.json`，每条记录都带 `byProviderModel` 字段，实测值全部为 `opencode-go:deepseek-v4.1-flash`，无一条混入其它模型。

| 运行 | 角色 | 会话 ID | Provider:Model | 调用 | input | output | cacheRead | reasoning | 费用 USD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1-A | 唯一代理 | 478c6b8a-73a7-4a48-8df4-6dbcd50f2778 | opencode-go:deepseek-v4.1-flash | 25 | 69881 | 30736 | 2557056 | 12064 | 0.036595 |
| T1-B | Worker A | c50b3496-4e41-4f6d-95d3-3974d35aa327 | 同上 | 17 | 59817 | 33754 | 1687424 | 14920 | 0.034287 |
| T1-B | Worker B | 1c880b0e-9e84-45bd-9674-39a7fd25e3cf | 同上 | 16 | 56274 | 27715 | 1585536 | 13166 | 0.029827 |
| T2-A | 唯一代理 | 59a49d34-10b9-4de4-9e5b-fe16938c48aa | 同上 | 21 | 72025 | 42259 | 2268288 | 14023 | 0.042964 |
| T2-B | Worker A | 0d0f0b3b-88c1-481e-afb0-f8f6a756fb94 | 同上 | 28 | 124026 | 55375 | 3116032 | 32108 | 0.061177 |
| T2-B | Worker B | 5bf872df-2fd2-4898-8ada-3b966be30159 | 同上 | 24 | 125621 | 58833 | 2559488 | 34187 | 0.061821 |
| T3-A | 唯一代理 | 8968717b-1ae4-468e-947a-e7c9d585e124 | 同上 | 21 | 74551 | 38039 | 2257408 | 19621 | 0.040778 |
| T3-B | Worker A | 07f9741d-03b7-472f-8dbc-97233934118e | 同上 | 20 | 65935 | 29968 | 2058496 | 18408 | 0.034047 |
| T3-B | Worker B | 62c2c5a2-b3fe-4c7c-a3ae-37e2c32a5556 | 同上 | 20 | 110794 | 45329 | 2082560 | 16524 | 0.050064 |

C 组（原生 headless，自写审计插件记录每次 llm_request 的 resolved provider/model/reasoningEffort + parentSession + root）：

| 运行 | 角色 | 会话 ID | Provider:Model | 用量 |
| --- | --- | --- | --- | --- |
| C-T1 | Manager | session-15a396ed-94a6-4163-8079-f37e9912cfb2 | codex:gpt-6.1-sol @ high | 3 次请求 / 53867 tokens |
| C-T1 | Worker 1 | 66cdc095-3dfd-4cca-a40c-d8f0670f51d9 | cline-api:cline-pass/deepseek-v4.1-flash-1017 | 16 calls / 617145 tokens |
| C-T1 | Worker 2 | 9589282d-339c-4b55-a6b8-74fb392ee942 | 同上 | 10 calls / 292144 tokens |
| C-T2 | Manager | session-e18f9a87-d84b-4886-9935-132fbed075c0 | codex:gpt-6.1-sol @ high | 3 次请求 / 63556 tokens |
| C-T2 | Worker 1 | 26e59056-03c0-41c7-a6b2-9c7899ce8f4d | cline-api:cline-pass/deepseek-v4.1-flash-1017 | 31 calls / 2086730 tokens（429 中断） |
| C-T2 | Worker 2 | 735952f2-911d-4b0e-ac59-7ff021e3c065 | 同上 | 29 calls / 1878260 tokens（429 中断） |
| C-T2 | Worker 3 | bc5f38b9-a871-4ccf-b6cc-1f246b8c8d68 | 同上 | 0 calls（首个请求即 429） |
| C-T3 | Manager + 2 Worker | session-ba944cab… → 接力 022d83f3 / 7653a957 / d3646e93 | opencode-go:deepseek-v4.1-flash | 19 calls / 160698 tokens / \$0.047207 |

**没有发生角色错配**：全部 9 次运行的 Worker 侧 `byProviderModel` 都只有 DS 一种模型，GPT Sol 6.1 从未被派去写代码或跑测试。C 组的 Manager 写工具被审计插件 `tools.guard` 主动拦截（见 §8.3）。

---

## 3. 九次运行总表

| 运行 | 组 | 任务 | Manager | Worker 数 | 最大并发 | 端到端耗时 | 25 分钟内 | 独立验收 | 一次通过 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1-A | A | T1 代码 Debug | 无（单代理直做） | 0 | 0 | 249 s | 是 | 31/31 | 是 |
| T1-B | B | T1 代码 Debug | DS | 2 | 2 | 289 s | 是 | 31/31 | 是 |
| T1-C | C | T1 代码 Debug | GPT Sol 6.1 high | 2 | 2 | 207 s | 是 | 31/31 | 是（Manager Review 未闭环） |
| T2-A | A | T2 从零 CLI | 无 | 0 | 0 | 399 s | 是 | 32/32 | 是 |
| T2-B | B | T2 从零 CLI | DS | 2 | 2 | 585 s | 是 | 32/32 | 是（含交付缺口） |
| T2-C | C | T2 从零 CLI | GPT Sol 6.1 high | 3 | 2 | 548 s | 是 | 32/32 | 是（2 个 Worker 429 中断） |
| T3-A | A | T3 CSV 清洗 | 无 | 0 | 0 | 348 s | 是 | 27/27 | 是 |
| T3-B | B | T3 CSV 清洗 | DS | 2 | 2 | 404 s | 是 | 27/27 | 是 |
| T3-C | C | T3 CSV 清洗 | DS（接力）/ 首轮 GPT 派发 | 2 | 2 | 135 s（接力段） | 是 | 27/27 | 否（首轮 1/27，接力后 27/27） |

执行顺序按任务书 §4 轮换：T1 A→B→C、T2 B→C→A、T3 C→A→B。

---

## 4. B 组 vs A 组：DS Manager 到底省没省

### 4.1 逐任务

| 任务 | A 组成本 | B 组成本 | 成本变化 | A 耗时 | B 耗时 | 耗时变化 | A 验收 | B 验收 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | \$0.036595（25 calls） | \$0.064114（33 calls） | **+75.2%** | 249 s | 289 s | +16.1% | 31/31 | 31/31 |
| T2 | \$0.042964（21 calls） | \$0.122998（52 calls） | **+186.3%** | 399 s | 585 s | +46.6% | 32/32 | 32/32 |
| T3 | \$0.040778（21 calls） | \$0.084111（40 calls） | **+106.3%** | 348 s | 404 s | +16.1% | 27/27 | 27/27 |
| 合计 | **\$0.120337**（67 calls） | **\$0.271223**（125 calls） | **+125.4%** | **996 s** | **1278 s** | **+28.3%** | 90/90 | 90/90 |

### 4.2 为什么变贵

1. **上下文重复装载**。每个 Worker 都要从零读任务书、读输入文件、读对方契约。T2-B 两个 Worker 的 cacheRead 合计 5,675,520 token，是 A 组同一任务（2,268,288）的 2.5 倍——不是 Worker 更笨，而是同一份任务规范被读了两遍。
2. **接口契约的额外成本**。Manager 必须先把模块边界、导出签名、错误码表写死成契约再派发，这段产出在 A 组根本不存在。
3. **收口与验证的叠加**。B 组 Manager 要做「派发 → 等 → 收口跑测试 → 独立验收」，A 组代理自己写自己跑，没有交接成本。
4. **并行没有缩短关键路径**。三个任务的两个 Worker 都是「一个写实现、一个写测试/校验」，天然存在前后依赖（测试要对着实现跑）。并行省下的时间小于契约成本，所以 B 组反而更慢。

### 4.3 B 组暴露的结构性缺陷（真实，未修）

T2-B：`package.json` 的 `npm test` 只指向 `test/cli.test.cjs`，**不含** `test/db.test.cjs`。数据层 31 个用例确实存在、也确实全过，但没有进测试入口——任务书 T2 验收第 9 条要求「原子写入与异常路径有测试」，按入口判就是缺口。

A 组同一任务 `npm test` = `node --test test`，覆盖全部 3 个文件 83 个用例，无此缺口。

按 B 组规则 Manager 不得修改代码，所以只记录、不代修。**这是分工切片的副作用**：两个 Worker 各管一半时，谁都不对「测试入口是否完整」负责。

---

## 5. C 组 vs B 组：换更强 Manager 有没有用

| 维度 | B 组（DS Manager） | C 组（GPT Sol 6.1 Manager） | 判定 |
| --- | --- | --- | --- |
| 独立验收 | 90/90 | 90/90 | 完全一致，**零提升** |
| 端到端耗时 | 996 s | 940 s（207+548+135，含接力段） | C 快 5.6%，但 C-T3 的 135 s 是接力段，不含首轮 429 空转 |
| Manager 决策次数 | 每任务 2 次（派发 + 收口），无上限压力 | 每任务 3 次即被硬上限拦下 | C 的 Manager 没有余量做最终 Review |
| Manager 端到端闭环 | 3/3 闭环 | **0/3 闭环**（Review 全部缺失） | C 更差 |
| 额度墙中断 | 无 | 3 次（T2 两个 Worker 429、T3 两个 Worker 首请求 429） | C 被基础设施打断 |
| Worker 侧成本 | \$0.271223（DS 计费） | N/A（Cline Pass 订阅，无逐 token 计价） | 不可比 |

### 5.1 C 组的真实失败点（不是模型能力问题）

1. **Manager 请求上限把 Review 掐掉了**。审计插件设 `rootMaxRequests = 3`，三个 Manager 全部在第 4 次请求被 `c-native-audit: root request cap 3 reached` 拦下。任务书允许 3 次实质决策（初始规划派发、疑难处置、最终 Review）——但真实执行时，Manager 第一轮往往先调 `todo_write` 这类不产生决策的写工具，白吃掉一次配额，于是真正能用于 Review 的只剩 2 次。
2. **额度墙**。C-T2 两个 Worker 在 31 次 / 29 次调用后同时撞上 `429 INFERENCE_CAP_ERROR`：`You have reached your weekly Clinepass limit. The limit resets in 1d 16h`。C-T3 两个 Worker 首个请求就 429，产物为零，首轮独立验收只有 1/27（唯一通过的那项是「输入 CSV 存在」）。
3. **失败被接力掩盖**。C-T3 最终 27/27 是换成 OpenCode Go DeepSeek 重跑得到的，不是 GPT Manager 的成果。把它记成「C 组成绩」会严重误导——所以本报告把 C-T3 明确标为「接力运行，Manager 身份已变更」。

---

## 6. 验收证据（可复现命令 + 真实输出）

三个验收器都是独立实现，不依赖被测代码，且在参考实现上自测通过（31/31、32/32、27/27）。

```bash
# T1（Node 20 必须前置）
node D:/dsh-bench/bench/accept/T1_accept.mjs <产物目录>
# T2
python D:/dsh-bench/bench/accept/t2_accept.py <产物目录>
# T3
python D:/dsh-bench/bench/accept/t3_accept.py <产物目录>
```

真实输出（九次运行的实际返回）：

| 运行 | 输出 |
| --- | --- |
| T1-A / T1-B / T1-C | `{"total":31,"pass":31,"fail":0}` |
| T2-A / T2-B / T2-C | `{"total":32,"pass":32,"fail":0}` |
| T3-A | `{"total":27,"pass":27,"fail":0,"script":"analyze.mjs"}` |
| T3-B | `{"total":27,"pass":27,"fail":0,"script":"analyze.py"}` |
| T3-C | `{"total":27,"pass":27,"fail":0,"script":"verify.py"}` |

### 6.1 T3 数值多方独立一致

三个组、五次独立实现（含 C 组两次）算出的数字完全相同：

- 清洗链路：21 数据行 → 20 唯一 order_id（O009 取 updated_at 较新的第 22 行，refund 50；丢弃第 10 行 refund 0）→ 排除 2 单（O004 cancelled、O012 pending）→ **已结算 18 单 / 32 件**
- **gross 3050.00 / refund 200.00 / net 2850.00 / 退款率 6.5574%**（精确分数 4/61）
- 地区（net 降序）：North 850 > South 750 > West 725 > East 525
- SKU（net 降序）：B 1550 > A 800 > C 350 > D 150

反事实验证（三组都做了）：不去重 → net 3050（+200）；保留旧行 → net 2900（+50）；计入 pending/cancelled → net 3025（+175）。方向一致：任何口径错误都导致净额虚高、退款率低估。

---

## 7. 必答七问

**Q1：DS Manager 占 SOLO 基准多少？**
N/A。B 组 Manager 就是当前主控 GUI 会话本身，它的 token 记在同一条会话记录里（同一条 `session-3fe06d9f` 同时含 cline-api、codex、opencode-go 三种模型的历史调用），无法按任务切分。给一个可用的上界替代：**B 组总成本已是 A 组的 2.25 倍**，其中 Manager 开销尚未计入——真实的 Manager 占比只会比这个更高。

**Q2：占 DS 团队多少？**
N/A，原因同上。可确证的是 Worker 侧数据（§2.2 表），Manager 侧不可归因。

**Q3：B 比 A 便宜还是更贵？**
**更贵，贵 125.4%**（\$0.120337 → \$0.271223）。三个任务全部更贵，无一例外。

**Q4：B 是否更快？返工增减？**
**更慢，慢 28.3%**（996 s → 1278 s）。
返工次数：A 组 2 次（T2-A 的 `done -1` 被误判为未知选项、缺命令时 stderr 混入 USAGE 破坏单行 JSON 契约）；B 组 3 次（T1-B Worker A1 把绝对 Windows 路径经 write 工具写成 `workspace/undefined/temp/...`、T1-B Worker B1 自己算错一处期望值 45.87/45.88、T2-B `--status` 重复给时后者覆盖前者应为 ERR_USAGE）。**返工绝对次数 B 更多，但都是 Worker 自己发现并改正的，没有回流到 Manager。**

**Q5：C 相比 B 是否提升？**
**质量零提升**（同为 90/90）。速度上 C 更快（T1 −28.4%、T2 −6.3%、T3 −66.6%），但这个速度差不能算作 GPT Manager 的功劳：C-T1/T2 的 Worker 被额度墙提前砍断，是「做得更少所以更快」；C-T3 的 135 s 是接力段，首轮 GPT Manager 派发后 Worker 全 429、零产物。

**Q6：GPT 额度是否值得？**
**不值得。** 三个理由：①质量零提升；②Manager 三次决策配额在真实使用中不够用（首轮常被 `todo_write` 之类的写工具吃掉一次），三次运行全部 Review 未闭环；③五小时额度从 16% 一路烧到 82%，其中相当一部分消耗在被打断的重试上，而这些重试没有产出任何可用产物。

**Q7：证据是否足以买 Opus 5.5？**
**不足以，而且方向错了。** 三个任务在单 Agent 手里已经 90/90 满分——Manager 换任何更强的模型都没有可改进的目标。花钱之前必须先把任务换到单 Agent 做不到的天花板上（多模块长链重构、跨仓库改造、需要长程一致性维护的任务），否则测出来的只会是「更贵的模型也一样满分」。

---

## 8. 数据缺失、无效运行与限制（不做美化）

### 8.1 数据缺失

| 项 | 状态 | 原因 |
| --- | --- | --- |
| B 组 Manager 自身 token / 费用 | **N/A** | Manager 即主控 GUI 会话，账本按会话聚合，同一会话混有多种模型的历史调用，无法按任务切分 |
| C 组 Worker 侧美元费用 | **N/A** | Cline Pass 为订阅制，账本无逐 token 计价 |
| C 组 Manager 美元费用 | **N/A** | Codex 订阅额度，无按量计费口径；任务书亦禁止把额度百分比换算成美元 |
| T1 紧邻额度采样 | **N/A** | C-T1 前后未取到紧邻读数，只有 T2/T3 有前后对比 |

### 8.2 无效运行与基础设施开销（不计入九次正式结果）

1. **C-T1 首跑**：两个 Worker 全部被拒——`Error: provider "cline-api" model "cline-pass/deepseek-v4.1-flash-1017" does not support reasoning effort "high"`。根因是临时 DS 模型定义缺 `reasoningEfforts` 声明，无 Worker 真正开跑。已补 `high/low/medium/max` 后重跑。
2. **C-T1 重试**：在模型调用前退出——`session.v4.jsonl.zstd uses .jsonl.zstd, but this backend is configured for compression "none"`。已把持久化根改到独立目录并显式设 `compression: none`。
3. **C-T3 首轮**：两个 Worker 首个请求即 429，产物 0，独立验收 1/27。**这是唯一一次验收未通过的记录**，按「额度墙导致」归档，接力后重跑得 27/27。
4. **早期自制 runner 的九连跑已整体作废**：那批数据由自写脚本直接调 HTTP 模拟 Manager/Worker，不是 DSH 真实子代理，与任务书要求的「真实平台角色关系」不符，已全部撤回，只保留作为验收器自测证据。
5. **码表类笔误更正**：早期记录中 C 组 429 错误码曾写作 `ICONFERENCE_CAP_ERROR`，实际原文为 `INFERENCE_CAP_ERROR`；早期 C 组额度读数曾按「37% 停止线」执行，该线已被用户指令 m01238「接着用接着测，直到完成测试」撤销，改为继续测到完成为止。

### 8.3 审计与角色边界的实证

C 组原生跑挂了自写审计插件（`audit/index.js`），记录每次 `agent/request` 与 `llm_request` 的 resolved provider/model/reasoningEffort + parentSession + root，并设 `tools.guard` 拦截 Manager 的写工具。实测：

- Manager 的 `write`/`edit` 类工具调用被拦截，三个任务里 Worker 是唯一写代码的角色；
- 三个 Manager 都在第 4 次请求被 `root request cap 3 reached` 拦下 → 统一标 `MANAGER_REVIEW_INCOMPLETE`；
- 父子关系由审计日志与持久化文件双证，不是推断。

**因此：C 组三次运行的任务产物 PASS ≠ 端到端 PASS。** 报告如实按后者记账。

---

## 9. 结论与下一步最小必要实验

### 9.1 结论

1. **在这三个任务上，Manager + Worker 结构是纯亏损**：成本 +125%、耗时 +28%、质量 0 提升。
2. **换更强的 Manager 不改变结论**：GPT Sol 6.1 拿到的是同样的 90/90，代价是额度墙与 Review 缺位。
3. **多智能体的价值不在「经理更强」，而在「任务能不能真正切开」**。T1/T2/T3 都是单文件或单脚本级别的任务，切片成本高于并行收益。
4. **平台侧的硬约束比模型选择更影响结果**：3 次请求上限 + 订阅额度墙，直接把 C 组三次运行的 Review 全部掐掉。

### 9.2 下一步最小必要实验（按性价比排序）

1. **先把测试任务换成单 Agent 做不到的天花板**：至少 3 个模块、跨文件契约变更、需要长程一致性维护，单 Agent 25 分钟内必然做不完——只有这样 Manager 的「省时间」才有可能显性化。
2. **修 Manager 配额经济学**：给 Manager 预留 Review 请求，禁止 `todo_write` 之类的写工具消耗决策配额（或把这类工具从 Manager 工具面移除）。这是 C 组 Review 缺位的直接原因。
3. **量化切片成本**：给同一任务做「不切片」与「切 2 片」两组，只测契约编写耗时与上下文重复装载量，把「切片是否值得」变成可计算的门槛。
4. **不建议**现在扩到更多组或更强模型。先解决 1 和 2，再谈 Opus 5.5。

---

## 10. 附录：资产与复现

| 资产 | 路径 |
| --- | --- |
| 任务书副本 | `D:/dsh-bench/bench/tasks/TASK_T1~T3.md` |
| 独立验收器 | `D:/dsh-bench/bench/accept/{T1_accept.mjs, t2_accept.py, t3_accept.py}` |
| A/B 组工作区 | `D:/dsh-bench/native-c-20261101/runs/OC-{A,B}-{T1,T2,T3}` |
| C 组原生工作区 | `D:/dsh-bench/native-c-20261101/runs/C-native-{T1,T2}` |
| C-T3 接力工作区 | `D:/dsh-bench/native-c-20261101/runs/OC-T3` |
| 原生审计日志 | `D:/dsh-bench/native-c-20261101/audit/audit.jsonl` |
| 用量账本 | `C:/Users/Administrator.DESKTOP-RHFCBBR/.dsh/storages/cost-meter/ledger.json` |

### 10.1 输入冻结校验

| 文件 | 大小 | SHA256 |
| --- | --- | --- |
| T1 TASK.md | 1946 B | A8F007B77405711145A1F0AF2164EC251ADAB94E0376B4508B031B60A6305B41 |
| T2 TASK.md | 2035 B | A8E0BFA66D6594BE67E08FEFC8DEF0330F36AF33397CB322774D7FEC05025345 |
| T3 TASK.md | 2324 B | 7EAFFEBC5FD11A52E6A40BFB5A5CF56DCDE2C4EDF096B54371FB78C92CBF177D |
| T3 orders.csv | 1273 B | A4B82B9397E00D90AA689C86B27D5E2023E27531AAE8E99D127A869B0CC3F812 |

全部九次运行都在各自的独立工作区内完成，输入文件全程只读未改（T3 的 orders.csv mtime 保持 2026-11-01 20:28:51）。

---

*报告生成时间：2026-11-02 00:57（Asia/Shanghai）。全部数字来自实测产物与平台账本，无估算、无补造。*
