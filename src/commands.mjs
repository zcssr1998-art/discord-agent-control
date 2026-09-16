/**
 * Discord application-command definitions + idempotent registration.
 *
 * One place owns the native commands so definitions are never scattered across
 * the codebase. The handlers themselves live in `src/discord-ui.mjs` and reuse
 * the exact same renderers/actions as the text commands and the control panel.
 *
 * No guild ID or user ID is ever embedded here: an optional guild-scoped
 * registration comes from configuration (env), never from a hard-coded owner.
 */

// Discord application command / option types.
const CHAT_INPUT = 1;
const STRING = 3;

export const COMMAND_NAMES = Object.freeze([
  'panel', 'work', 'model', 'settings', 'permission', 'status', 'doctor', 'stop', 'new', 'compact', 'help',
]);

function simple(name, description) {
  return { name, description, type: CHAT_INPUT };
}

/** The desired global command set, as plain REST JSON. */
export function buildCommandPayloads() {
  return [
    simple('panel', '显示 Jarvis 控制面板'),
    {
      name: 'work',
      description: '新建 Work 任务（留空则打开输入窗口）',
      type: CHAT_INPUT,
      options: [
        { type: STRING, name: 'task', description: '任务内容（可选）', required: false, max_length: 1500 },
      ],
    },
    simple('model', '切换 Chat / Work 模型'),
    simple('settings', '打开 Jarvis 设置'),
    simple('permission', '设置权限档位'),
    simple('status', '查看 Jarvis 状态'),
    simple('doctor', '本地健康诊断（无模型调用）'),
    simple('stop', '停止当前 Work 任务'),
    simple('new', '开始新的 Chat 对话（只清空本频道上下文）'),
    simple('compact', '压缩当前 Chat 上下文'),
    simple('help', '查看使用说明'),
  ];
}

function collectionToArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value.values === 'function') return [...value.values()];
  return [];
}

function normalizeOption(option) {
  const normalized = {
    type: option?.type,
    name: option?.name,
    description: option?.description,
    required: Boolean(option?.required),
  };
  if (option?.max_length != null) normalized.max_length = option.max_length;
  if (Array.isArray(option?.options)) normalized.options = option.options.map(normalizeOption);
  return normalized;
}

function normalizeCommand(command) {
  return {
    name: command?.name,
    description: command?.description,
    options: (command?.options ?? []).map(normalizeOption),
  };
}

/** Which desired commands are new/changed, plus any stale commands to remove. */
export function diffCommands(existing, desired) {
  const byName = new Map(collectionToArray(existing).map((command) => [command.name, command]));
  const changes = [];
  for (const want of desired) {
    const have = byName.get(want.name);
    if (!have || JSON.stringify(normalizeCommand(have)) !== JSON.stringify(normalizeCommand(want))) {
      changes.push(want);
    }
    byName.delete(want.name);
  }
  for (const stale of byName.values()) changes.push({ name: stale.name, delete: true });
  return changes;
}

/**
 * Idempotent sync: if nothing changed, no REST write happens at all. `set`
 * replaces the whole command set, so removals are handled for free.
 */
export async function syncApplicationCommands({ application, guildId = null, logger = null } = {}) {
  if (!application?.commands) return { skipped: true, changed: 0, total: 0 };
  const desired = buildCommandPayloads();
  let existing = [];
  try {
    existing = guildId
      ? await application.commands.fetch({ guildId })
      : await application.commands.fetch();
  } catch (error) {
    logger?.warn?.(`[commands] could not fetch existing commands: ${error?.message || error}`);
  }
  const changes = diffCommands(existing, desired);
  if (!changes.length) return { skipped: false, changed: 0, total: desired.length };
  await application.commands.set(desired, guildId);
  return { skipped: false, changed: changes.length, total: desired.length };
}

/** Startup entry point. Best-effort: a registration failure never blocks login. */
export async function registerApplicationCommands({ client, guildId = null, logger = null } = {}) {
  const application = client?.application;
  if (!application) return { skipped: true, changed: 0, total: 0, reason: 'application unavailable' };
  try { await application.fetch?.(); } catch { /* commands may still work from cache */ }
  return syncApplicationCommands({ application, guildId, logger });
}

export default { COMMAND_NAMES, buildCommandPayloads, diffCommands, syncApplicationCommands, registerApplicationCommands };
