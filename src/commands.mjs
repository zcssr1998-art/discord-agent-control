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

// Real Discord platform maxima (not Jarvis policy): an application-command
// STRING option caps at 6000 characters, while a modal Text Input caps at 4000.
// They are deliberately different and must not be advertised as interchangeable.
export const SLASH_TASK_MAX_LENGTH = 6000;
export const MODAL_TASK_MAX_LENGTH = 4000;

// P2.2.6 owner update controls. Expressed as a STRING option with `choices`
// rather than SUB_COMMAND: the UX is equivalent and the handler reads a single
// value, so there is no second command tree to keep in sync.
export const UPDATE_ACTIONS = Object.freeze(['status', 'now', 'pause', 'resume']);

export const COMMAND_NAMES = Object.freeze([
  'panel', 'work', 'model', 'settings', 'permission', 'status', 'doctor', 'stop', 'new', 'compact', 'help', 'update',
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
        { type: STRING, name: 'task', description: '任务内容（可选）', required: false, max_length: SLASH_TASK_MAX_LENGTH },
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
    {
      name: 'update',
      description: 'Jarvis 自动更新控制（查看/立即检查/暂停/恢复）',
      type: CHAT_INPUT,
      options: [
        {
          type: STRING,
          name: 'action',
          description: 'status · now · pause · resume',
          required: true,
          choices: UPDATE_ACTIONS.map((value) => ({ name: value, value })),
        },
      ],
    },
  ];
}

/** The raw REST shape of a command/option, accepting discord.js objects too. */
function toRaw(value) {
  if (!value) return null;
  if (typeof value.toJSON === 'function') { try { return value.toJSON(); } catch { /* fall through */ } }
  if (value.data && typeof value.data === 'object') return value.data;
  return value;
}

function collectionToArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value.values === 'function') return [...value.values()];
  return [];
}

function normalizeOption(option) {
  const raw = toRaw(option) ?? {};
  const normalized = {
    type: raw.type,
    name: raw.name,
    description: raw.description,
    required: Boolean(raw.required),
  };
  const maxLength = raw.max_length ?? raw.maxLength;
  if (maxLength != null) normalized.max_length = maxLength;
  const choices = raw.choices;
  if (Array.isArray(choices) && choices.length) {
    normalized.choices = choices.map((choice) => ({ name: choice?.name, value: choice?.value }));
  }
  const children = raw.options;
  if (Array.isArray(children)) normalized.options = children.map(normalizeOption);
  return normalized;
}

function normalizeCommand(command) {
  const raw = toRaw(command) ?? {};
  return {
    name: raw.name,
    description: raw.description,
    options: collectionToArray(raw.options).map(normalizeOption),
  };
}

/** Find one command by name in a desired or fetched schema. */
export function findCommandSchema(schema, name) {
  return collectionToArray(schema).map(toRaw).find((command) => command?.name === name) ?? null;
}

/**
 * The `/work task` slash option's real Discord `max_length`, read from a fetched
 * schema. Returns null when the command/option is absent so a mismatch is
 * reported rather than silently passing.
 */
export function workTaskMaxLength(schema) {
  const work = findCommandSchema(schema, 'work');
  const option = (work?.options ?? []).find((item) => item?.name === 'task');
  return option?.max_length ?? option?.maxLength ?? null;
}

/**
 * Compare a fetched Discord schema against the desired one. This is the real
 * "fetch back and verify" check: success means Discord reports the desired
 * schema, not that the local constant changed.
 */
export function compareCommandSchema(actual, desired = buildCommandPayloads()) {
  const actualBy = new Map(collectionToArray(actual).map((command) => [toRaw(command)?.name, toRaw(command)]));
  const mismatches = [];
  for (const want of desired) {
    const normalizedWant = normalizeCommand(want);
    const have = actualBy.get(normalizedWant.name);
    if (!have) { mismatches.push({ command: normalizedWant.name, field: 'command', expected: 'present', actual: 'missing' }); continue; }
    const normalizedHave = normalizeCommand(have);
    if (normalizedHave.description !== normalizedWant.description) {
      mismatches.push({ command: normalizedWant.name, field: 'description', expected: normalizedWant.description, actual: normalizedHave.description });
    }
    if (JSON.stringify(normalizedHave.options) !== JSON.stringify(normalizedWant.options)) {
      mismatches.push({ command: normalizedWant.name, field: 'options', expected: normalizedWant.options, actual: normalizedHave.options });
    }
    actualBy.delete(normalizedWant.name);
  }
  for (const stale of actualBy.keys()) mismatches.push({ command: stale, field: 'command', expected: 'absent', actual: 'stale-present' });
  return {
    ok: mismatches.length === 0,
    mismatches,
    workTaskMaxLength: workTaskMaxLength(actual),
    checkedAt: new Date().toISOString(),
  };
}

/** Which desired commands are new/changed, plus any stale commands to remove. */
export function diffCommands(existing, desired) {
  const byName = new Map(collectionToArray(existing).map((command) => [toRaw(command)?.name, command]));
  const changes = [];
  for (const want of desired) {
    const have = byName.get(want.name);
    if (!have || JSON.stringify(normalizeCommand(have)) !== JSON.stringify(normalizeCommand(want))) {
      changes.push(want);
    }
    byName.delete(want.name);
  }
  for (const stale of byName.values()) changes.push({ name: toRaw(stale)?.name, delete: true });
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

/**
 * P2.2.6 K7: fetch the ACTUAL Discord application commands back and compare
 * them to the desired schema. This is the only acceptable proof that the remote
 * schema matches the running code (a local constant is not evidence).
 *
 * A transient REST failure is reported as out-of-sync, never as a rollback
 * reason: otherwise-good source must not be discarded because Discord blipped.
 */
export async function verifyApplicationCommands({ application, guildId = null, logger = null } = {}) {
  const desired = buildCommandPayloads();
  if (!application?.commands?.fetch) {
    return { ok: false, mismatches: [], workTaskMaxLength: null, checkedAt: new Date().toISOString(), error: 'application commands unavailable' };
  }
  let actual = [];
  try {
    actual = guildId
      ? await application.commands.fetch({ guildId })
      : await application.commands.fetch();
  } catch (error) {
    logger?.warn?.(`[commands] fetch-back failed: ${error?.message || error}`);
    return { ok: false, mismatches: [], workTaskMaxLength: null, checkedAt: new Date().toISOString(), error: `fetch-back failed: ${error?.message || error}` };
  }
  const result = compareCommandSchema(actual, desired);
  result.source = 'discord-fetch-back';
  return result;
}

export default {
  COMMAND_NAMES,
  UPDATE_ACTIONS,
  buildCommandPayloads,
  diffCommands,
  syncApplicationCommands,
  registerApplicationCommands,
  verifyApplicationCommands,
  compareCommandSchema,
  workTaskMaxLength,
};
