# DSH 原生 C 组重测证据（2026-11-01）

旧 kkrich C 组为 INVALID_ROUTE，旧 A/B 为自制 HTTP 执行器，均不作为此次原生 DSH 同条件架构对照。旧报告保留在 Git 历史 ef8790b，不再重复发布其中已撤回的结论。

## 当前结果

三任务均已真实发起并终止，但不是三项端到端成功：T1 产物通过且两 Worker 完成；T2 产物通过但 Worker 被周额度中断；T3 Worker 全被周额度拦截，未生产交付物。三任务 Manager 均达到3次请求上限，第四请求被审计层拦截，无最终 Review，均标 MANAGER_REVIEW_INCOMPLETE。禁止把产物PASS写成整体PASS。

|任务|Manager耗时秒（会话创建至末次turn/end）|独立验收|Manager模型请求|Worker数|端到端状态|
|---|---:|---|---:|---:|---|
|T1|207.195|31/31|3|2|PARTIAL / MANAGER_REVIEW_INCOMPLETE|
|T2|548.033|32/32|3|3|PARTIAL / MANAGER_REVIEW_INCOMPLETE|
|T3|115.676|1/27|3|2|FAIL / WORKER_QUOTA_EXHAUSTED|

## 真实模型、父子关系与逐会话用量

Manager 原生 provider=codex/model=gpt-6.1-sol，reasoningEffort=high；Worker 原生 provider=cline-api/model=cline-pass/deepseek-v4.1-flash-1017，high。审计源 audit/audit.jsonl，持久化源 sessions-plain/*/*/session.v4.jsonl。Worker 零成功消息时，模型绑定依据原生agent/request审计，不假冒上游成功回显。

inputTokens 在 DSH 原生结构中为非缓存输入，cacheReadTokens 单列；DS upstream totalTokens已含缓存，不额外相加。Codex未给totalTokens，表中总量明确按 input+cached+output 计算（非估算）；reasoningTokens已包含在output，不再加。缺失字段N/A，不当零；没有成功消息的Worker表中0 total仅代表已记录成功用量为0，未给出收费断言。费用：原生会话未暴露可核实金额，DS/GPT均N/A，订阅不换算美元。

|会话|父会话|角色/任务|成功请求|非缓存输入|缓存输入|输出|推理|总tokens|
|---|---|---|---:|---:|---:|---:|---:|---:|
|66cdc095-3dfd-4cca-a40c-d8f0670f51d9|session-15a396ed-94a6-4163-8079-f37e9912cfb2|Worker/C-native-T1|16|175391|416262|25492|N/A|617145|
|9589282d-339c-4b55-a6b8-74fb392ee942|session-15a396ed-94a6-4163-8079-f37e9912cfb2|Worker/C-native-T1|10|124733|153268|14143|N/A|292144|
|session-15a396ed-94a6-4163-8079-f37e9912cfb2|-|Manager/C-native-T1|3|18707|33408|1752|180|53867|
|26e59056-03c0-41c7-a6b2-9c7899ce8f4d|session-e18f9a87-d84b-4886-9935-132fbed075c0|Worker/C-native-T2|31|385245|1657546|43939|N/A|2086730|
|735952f2-911d-4b0e-ac59-7ff021e3c065|session-e18f9a87-d84b-4886-9935-132fbed075c0|Worker/C-native-T2|29|317504|1515824|44932|N/A|1878260|
|bc5f38b9-a871-4ccf-b6cc-1f246b8c8d68|session-e18f9a87-d84b-4886-9935-132fbed075c0|Worker/C-native-T2|0|N/A|N/A|N/A|N/A|0|
|session-e18f9a87-d84b-4886-9935-132fbed075c0|-|Manager/C-native-T2|3|21751|36480|5325|688|63556|
|574a9369-ad78-4007-b3ac-91e63eecb9f5|session-ba944cab-d124-49e1-bc67-1717e25045af|Worker/C-native-T3|0|N/A|N/A|N/A|N/A|0|
|f2366e17-5ef1-4e1e-b437-fb180be65ab0|session-ba944cab-d124-49e1-bc67-1717e25045af|Worker/C-native-T3|0|N/A|N/A|N/A|N/A|0|
|session-ba944cab-d124-49e1-bc67-1717e25045af|-|Manager/C-native-T3|3|19526|37760|3838|339|61124|

## 失败与基础设施开销

1. T1首次派发失败：临时DS模型定义缺high档声明；未生成Worker。另一次重试因持久化压缩模式冲突在模型调用前退出。原始证据T1-native.infra-failure.*及T1-native-retry.*单列，不删除失败。之后模型声明修正、plain会话根目录隔离，T1进入真实DS生产；未借失败清除后续正式结果。
2. T1 Manager先使用todo_write，派发分布在后续请求，三请求预算耗尽后未做最终Review；两个DS Worker产物经独立验收31/31，自带测试98/98。未放宽请求上限以追求PASS。
3. T2 Worker在已生成产物后收到429 INFERENCE_CAP_ERROR：weekly Clinepass limit，服务称1d16h后恢复。两初始Worker均错误结束，第三Worker亦被拦截；独立验收32/32，Manager无最终Review。
4. T3两Worker在首个模型请求即遭相同周额度429，无分析脚本与REPORT；独立验收1/27（唯一通过为输入CSV存在），不能计为分析正确率。
5. DS报告Worker也被同一额度429拦截，无法交付分析报告。此页为已有机器证据的确定性表格导出，不是追加GPT评估。没有独立评分，没有编造返工次数。

## 额度与用户追加指令

23:09:48五小时已用16%，旧预算停止线37%；23:20:58读到45%曾止损。用户23:25:48明确指示继续使用当前额度直到完成，旧37%线因此撤销，记录为预算变更，绝不声称仍满足旧25%预算。
23:27:17已用56%（正式路由收口阶段）；T2-before23:36:13已用69%，T2-after23:45:26已用79%；T3-before79%，T3-after23:47:26已用82%。差值为账户窗口读数，含并行会话/主控排查，不等于可独立归因的单任务账单。T1缺少紧邻启动/结束的额度采样，标N/A，不补估。没有重置额度，没有使用第三方GPT通道。

## 验收命令和本地证据

- Node 20.19.0，PATH显式前置。T1: node D:/dsh-bench/bench/accept/T1_accept.mjs runs/C-native-T1；T2/T3: python t2_accept.py / t3_accept.py <workspace>，冻结验收器未因本轮失败降低标准。
- 每任务原生CLI进程1500000ms硬超时；此次会话耗时均小于25分钟。
- 原生入口为安装包内 @deepseek-ai/dsh/lib/bin.js headless，通过原插件dsh-plugin-subscriptions复用用户模型列表对应订阅认证。没有自制模型工具循环。
- 本地根目录 D:/dsh-bench/native-c-20261101/；NATIVE_EVIDENCE.json、T1/T2/T3-independent.json、T*-native*.events.jsonl、T*-native*.exit、quota/及audit/audit.jsonl均保留。无凭据进入仓库。

## 限制与下一步

产物验收不是完整业务契约证明；32条CLI检查与27条CSV检查覆盖仍有限，T2原子写异常路径等需查自身测试，不仅凭字符串检查确认。不得基于本轮与旧A/B不同执行框架的数据得出GPT优劣或Opus采购结论。
三项真实尝试与验收已结束；全部成功的目标未达成。现有真实阻塞为Cline Pass周额度耗尽（429）；恢复后应从原会话/产物续接，不偷换Worker，不自动重开已完成的生产过程。Manager最终Review在三请求内未闭环保留为本次失败，不回填成功。
