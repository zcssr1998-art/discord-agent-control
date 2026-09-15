/**
 * i18n — Discord 用户界面中文化。
 *
 * 不影响程序运行的用户可见内容尽量中文。
 * 文件路径 / Shell 命令 / 代码 / 模型 ID / Git SHA / API 字段 / 错误 code 保持原样。
 */
import { redactSecrets } from './secrets.mjs';

/** 任务状态标签。 */
export const STATE_LABEL = {
  CREATED: '🆕 任务已创建',
  PLANNING: '🧠 正在分析任务',
  RUNNING: '🟡 正在执行',
  TESTING: '🧪 正在测试',
  WAITING_APPROVAL: '🔐 等待授权',
  DONE: '✅ 已完成',
  FAILED: '❌ 执行失败',
  CANCELLED: '⛔ 已停止',
  TIMEOUT: '⏱️ 执行超时',
  STALLED: '⏳ 正在等待执行结果',
};

/** 工具调用 → 中文描述。 */
export function describeTool(toolName, toolInput = {}) {
  const input = toolInput || {};
  const safe = (value, max) => shorten(redact(value), max);
  switch (toolName) {
    case 'Read':
    case 'NotebookRead':
      return `📖 读取 \`${safe(input.file_path || input.notebook_path || '?', 50)}\``;
    case 'Write':
      return `✏️ 创建 \`${safe(input.file_path || '?', 50)}\``;
    case 'Edit':
    case 'NotebookEdit':
      return `✏️ 修改 \`${safe(input.file_path || input.notebook_path || '?', 50)}\``;
    case 'Glob':
      return `🔎 扫描文件 \`${safe(input.pattern || '?', 40)}\``;
    case 'Grep':
      return `🔎 搜索 \`${safe(input.pattern || '?', 40)}\``;
    case 'Bash':
    case 'Shell':
    case 'PowerShell': {
      const cmd = redact(input.command || '');
      if (/^\s*(npm|pnpm|yarn)\s+(test|run\s+(test|lint|check|build))\b/i.test(cmd)) {
        return `🧪 运行测试 / 检查`;
      }
      if (/^\s*git\s+status\b/i.test(cmd)) return `🔀 检查 Git 状态`;
      if (/^\s*git\s+diff\b/i.test(cmd)) return `🔀 查看代码改动`;
      if (/^\s*git\s+log\b/i.test(cmd)) return `🔀 查看提交历史`;
      if (/^\s*git\s+add\b/i.test(cmd)) return `📦 准备提交`;
      if (/^\s*git\s+commit\b/i.test(cmd)) return `📦 创建提交`;
      if (/^\s*git\s+push\b/i.test(cmd)) return `☁️ 推送 GitHub`;
      if (/\b(curl|wget|Invoke-WebRequest|iwr)\b/i.test(cmd)) return `🌐 访问网络`;
      if (/\b(pip|pip3|npm|pnpm|yarn|choco|winget|scoop)\s+(install|add)\b/i.test(cmd)) {
        return `📥 安装依赖`;
      }
      if (toolName === 'PowerShell' || /powershell|pwsh/i.test(cmd)) return `⚙️ 执行 PowerShell`;
      return `⚙️ 执行命令 \`${safe(cmd, 60)}\``;
    }
    case 'WebFetch':
      return `🌐 获取网页 \`${safe(input.url || '?', 50)}\``;
    case 'WebSearch':
      return `🌐 搜索网络 \`${safe(input.query || '?', 50)}\``;
    case 'Agent':
      return `🤖 调用子代理`;
    case 'Task':
      return `📋 创建任务`;
    default:
      if (toolName?.startsWith('mcp__')) return `🔌 MCP: ${shorten(toolName, 40)}`;
      return `🔧 ${shorten(toolName || 'Tool', 30)}`;
  }
}

/** 审批按钮标签。 */
export const APPROVAL_BUTTONS = {
  ALLOW_ONCE: '✅ 仅允许这一次',
  ALLOW_SESSION: '✅ 本次会话允许',
  DENY: '❌ 拒绝',
};

/** 权限档位中文。 */
export const PERM_LABEL = {
  strict: '🔒 严格',
  standard: '🛡️ 标准',
  relaxed: '⚡ 放宽',
  full: '🔓 全开放',
};

/** 权限档位简短标签（用于状态行）。 */
export const PERM_SHORT = {
  strict: '🔒 严格',
  standard: '🛡️ 标准',
  relaxed: '⚡ 放宽',
  full: '🔓 全开放 ⚠️',
};

/** !help 内容。 */
export function helpText() {
  return [
    '**指令列表**',
    '`chat` / `/chat` / `!chat` — 切回 Chat 模式（直接调用模型 API，不启动 Agent）',
    '`work` / `/work` / `!work` — 切换到 Work 模式（使用 Agent）',
    '`chat <问题>` / `work <任务>` — 一步切换并立即执行',
    '`!chatmodel [auto | <provider-id> <model-id>]` — 查看或设置 Chat 模型路由',
    '`!status` — 查看当前状态（模式 / Chat / Work / 权限 / 会话）',
    '`!config` — 打开 Agent 统一配置',
    '`!executor [id]` — 查看或切换执行器',
    '`!providers` / `!provider [id]` — 查看或切换 Provider',
    '`!models` / `!model [model-id]` — 查看或切换模型',
    '`!api` — 在私聊中添加兼容 API',
    '`!health` — 检查当前执行器、Provider、模型与 Session',
    '`!perm` 或 `!permission` — 查看或切换权限档位',
    '`!perm [strict|standard|relaxed|full]` — 直接切换权限',
    '`!stop` — 停止当前运行中的 Agent',
    '`!reset` — 停止 + 重置会话和权限为默认值',
    '`!cwd <绝对路径>` — 绑定当前频道到指定项目',
    '`!handoff` — 生成交接信息',
    '`!help` — 显示此帮助',
    '',
    '**默认 Chat**：普通消息 = 直接问模型。切到 Work 后，普通消息 = Agent 任务。',
  ].join('\n');
}

/** 启动通知。 */
export function readyText({ executor, provider, protocol, backend, model, billingRoute, paidFallback, defaultCwd, permissionLabel }) {
  return [
    '✅ **Bridge 已就绪**',
    `执行器：${executor ?? 'WorkBuddy'}`,
    `${provider ? 'Provider' : '后端'}：${provider ?? backend ?? 'unknown'}`,
    `协议：${protocol ?? 'workbuddy'}`,
    `模型：${model ?? 'unknown'}`,
    `计费线路：${billingRoute ?? 'unknown'}`,
    `付费回退：${paidFallback ? '已启用' : '已禁用'}`,
    `权限：${permissionLabel ?? '🛡️ 标准'}`,
    `默认目录：\`${defaultCwd}\``,
    '发送任务开始，或输入 `!help` 查看指令。',
  ].join('\n');
}

/** 格式化 !status 输出。 */
export function formatStatus({
  executor, provider, protocol, adapter, backend, model, billingRoute, billingType, paidFallback,
  cwd, sessionId, state, idleSec, pendingApprovals, permissionLabel, blocked,
  mode, chatRoute, chatActual, chatHealth,
}) {
  const lines = [
    '🤖 **Jarvis 状态**',
    '',
    `🧭 模式：${mode === 'work' ? '🛠 Work' : '💬 Chat'}`,
    ...(chatRoute ? [
      '',
      '💬 **CHAT**',
      `路由：${chatRoute}`,
      ...(chatActual ? [`实际：${chatActual}`] : []),
      ...(chatHealth ? [`健康：${chatHealth}`] : []),
      '',
      '🛠 **WORK / Agent**',
    ] : []),
    `📁 当前项目：\`${cwd}\``,
    `🟢 状态：${state}`,
    `🔐 权限：${permissionLabel}`,
    `🛠️ 执行器：${executor ?? 'unknown'}`,
    `🌐 ${provider ? '提供商' : '后端'}：${provider ?? backend ?? 'unknown'}`,
    `🔌 协议：${protocol ?? 'unknown'}`,
    ...(adapter ? [`🔄 兼容层：${adapter}`] : []),
    `🧠 模型：${model ?? '未选择'}`,
    `💰 ${provider ? '计费' : '计费线路'}：${billingType ?? billingRoute ?? '未知'}`,
    `🧠 Session / 会话：\`${sessionId || '新会话'}\``,
  ];
  if (provider == null && paidFallback != null) lines.push(`💰 付费回退：${paidFallback ? '已启用' : '已禁用'}`);
  if (idleSec != null) lines.push(`⏱️ 最后事件：${idleSec}秒前`);
  lines.push(`🔐 待审批：${pendingApprovals}`);
  if (blocked) lines.push(`⚠️ ${blocked}`);
  return lines.join('\n');
}

/** 截断长文本。 */
export function shorten(text, maxLen = 120) {
  const s = String(text ?? '');
  if (s.length <= maxLen) return s;
  return s.slice(0, Math.max(0, maxLen - 1)) + '…';
}

export const redact = redactSecrets;
