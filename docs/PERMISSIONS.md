# V2 权限系统

`PermissionManager` 是权限档位和 session 映射的唯一真源。生产入口、Discord 控制面和 `PreToolUse` hook 共用同一个实例；Discord 按钮与 `!perm` / `!permission` 命令调用同一条切换路径。

| 档位 | 自动允许 | 需要审批 |
| --- | --- | --- |
| 🔒 严格 | Read / Glob / Grep、只读 shell、`git status/diff/log` | 工作区写入、测试/build、普通 shell/PowerShell、网络、安装、push、删除、系统操作 |
| 🛡️ 标准（默认） | 工作区读写、测试/build/lint、本地 `git add/commit` 和只读 Git | 工作区外写入、普通 shell/PowerShell、网络、安装、push、递归删除、reset/clean/rebase、系统/凭据操作 |
| ⚡ 放宽 | 标准档全部、普通 shell/PowerShell、普通网络、安装、push | 递归删除、磁盘/系统配置、SSH、凭据、reset/clean/rebase、明显不可逆操作 |
| 🔓 全开放 | 除永久安全边界外的普通工具，包括 shell、网络、push、删除 | 敏感文件访问仍审批；检测到 secret 字面量的 Git 提交直接拒绝 |

## 生命周期

- FULL 每次进入都必须点击“确认全开放”；取消不会改变当前档位。
- 任务运行中可以切换，档位从下一次 tool call 生效。
- 已经处于等待授权的调用不会因提权自动放行。
- `!reset`、`!cwd` / 切换项目、Bridge 重启都会恢复 🛡️ 标准。
- OWNER 校验、secret 保护、`TASK_TIMEOUT`、`!stop`、`!reset`、后端校验、禁用付费回退和进程清理不受 FULL 影响。

## Discord UI

- `!perm`、`!permission`：显示当前档位和四档按钮。
- `!perm strict|standard|relaxed|full`：命令切换；FULL 仍需按钮二次确认。
- `!status` 带“🔐 权限设置”按钮。
- 审批按钮的 `customId` / hook protocol 保持不变，仅显示为“✅ 仅允许这一次 / ✅ 本次会话允许 / ❌ 拒绝”。

## 可观测过程和脱敏

`EventPresenter` 只消费现有 runner 事件并更新一条 Discord 状态消息；没有模型调用，额外模型 Token 固定为 0。命令、工具输入和错误在展示前经过本地脱敏并截断，原始 `thinking_tokens` / reasoning 不进入 Discord。

## V3 共用边界

V3 的 WorkBuddy 与 Claude Code Adapter 仍把 `PreToolUse` 送入同一个 `PermissionManager`；Provider 只决定模型线路和隔离环境，不拥有独立审批规则。`SessionManager` 在 Executor、Provider、Model 或 cwd 变化时结束旧进程、撤销该 session 的待审批与 session allow，并恢复 STANDARD。OpenCode / Codex Adapter 未就绪，因此不会伪装成已经接入权限系统。
