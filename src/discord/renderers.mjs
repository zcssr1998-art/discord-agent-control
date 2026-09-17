// P2.2E: pure Discord renderers / control rows extracted from discord-ui.mjs.
// No client access, no state, no side effects: pure builders so the control
// plane keeps a single source of truth for rendering while delegating rows here.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { PROTOCOL, TRANSPORT } from '../provider-manager.mjs';
import { PERM_LABEL } from '../i18n.mjs';

export const DISCORD_LIMIT = 1900;

export function clip(text, n = DISCORD_LIMIT) {
  const s = String(text ?? '');
  return s.length <= n ? s : `${s.slice(0, n - 20)}\n…(truncated)`;
}

export function permissionButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('perm:strict').setLabel(PERM_LABEL.strict).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('perm:standard').setLabel(PERM_LABEL.standard).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('perm:relaxed').setLabel(PERM_LABEL.relaxed).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('perm:full').setLabel(PERM_LABEL.full).setStyle(ButtonStyle.Danger),
  );
}

export function permissionMenuButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('perm:menu').setLabel('🔐 权限设置').setStyle(ButtonStyle.Secondary),
  );
}

export function fullConfirmationButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('permfull:confirm').setLabel('确认全开放').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('permfull:cancel').setLabel('取消').setStyle(ButtonStyle.Secondary),
  );
}

export function configButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cfg:executor').setLabel('🛠️ 执行器').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cfg:provider').setLabel('🌐 提供商').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cfg:model').setLabel('🧠 模型').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cfg:permission').setLabel('🔐 权限').setStyle(ButtonStyle.Secondary),
  );
}

export function providerResultButtons(providerId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`apiuse:${providerId}`).setLabel('选择 Provider').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`apimodel:${providerId}`).setLabel('选择模型').setStyle(ButtonStyle.Secondary),
  );
}

export function protocolButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`apiproto:${PROTOCOL.OPENAI}`).setLabel('OpenAI Compatible').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`apiproto:${PROTOCOL.ANTHROPIC}`).setLabel('Anthropic Compatible').setStyle(ButtonStyle.Secondary),
  );
}

export function settingsButtons({ workThread = false } = {}) {
  const top = [];
  if (!workThread) top.push(new ButtonBuilder().setCustomId('set:chatauto').setLabel('💬 Chat→AUTO').setStyle(ButtonStyle.Secondary));
  top.push(
    new ButtonBuilder().setCustomId('set:executor').setLabel('🛠️ 执行器').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('set:provider').setLabel('🌐 提供商').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('set:model').setLabel('🧠 模型').setStyle(ButtonStyle.Secondary),
  );
  return [
    new ActionRowBuilder().addComponents(...top),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('set:permission').setLabel('🔐 权限').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('set:refresh').setLabel('🔄 刷新').setStyle(ButtonStyle.Primary),
    ),
  ];
}

export function settingsBackRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('set:refresh').setLabel('⬅️ 返回').setStyle(ButtonStyle.Secondary),
  );
}

export function panelMainRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel:newwork').setLabel('🛠 新建 Work').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('panel:models').setLabel('🧠 换模型').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel:settings').setLabel('⚙️ 设置').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel:permission').setLabel('🔐 权限').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel:newchat').setLabel('🆕 新对话').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel:compact').setLabel('🧹 压缩上下文').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel:status').setLabel('📊 状态').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel:stop').setLabel('⛔ Stop').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('panel:help').setLabel('📖 使用说明').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel:refresh').setLabel('🔄 刷新').setStyle(ButtonStyle.Success),
    ),
  ];
}

export function panelBackRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel:refresh').setLabel('⬅️ 返回').setStyle(ButtonStyle.Secondary),
  );
}

/**
 * The help view carries the real controls its copy references (`⚙️ 设置`,
 * `🔐 权限`, `🛠 新建 Work`, `⛔ Stop`) so they are never described as
 * clickable while absent. Handlers are the existing `panel:*` ones.
 */
export function panelHelpRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel:newwork').setLabel('🛠 新建 Work').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('panel:settings').setLabel('⚙️ 设置').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel:permission').setLabel('🔐 权限').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel:stop').setLabel('⛔ Stop').setStyle(ButtonStyle.Danger),
    ),
    panelBackRow(),
  ];
}

export function panelModelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panelmodels:chat').setLabel('💬 Chat 模型').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('panelmodels:work').setLabel('🛠 Work 模型').setStyle(ButtonStyle.Primary),
    ),
    panelBackRow(),
  ];
}

/**
 * Active Work progress-card controls. The custom id carries the run id so a
 * stale card from an earlier run can never stop/insert into a newer task.
 * `插入需求` steers the RUNNING turn; it is not a queued follow-up.
 */
export function workControlRows(runId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`workctl:append:${runId}`).setLabel('➕ 插入需求').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`workctl:stop:${runId}`).setLabel('⛔ Stop').setStyle(ButtonStyle.Danger),
    ),
  ];
}

/**
 * Paginated model buttons for one provider. Returns `{ rows, page, pages }`
 * with a nav row whenever the list spans more than one page, so a provider
 * with many models (e.g. OpenCode Go) always has a real selectable path in
 * Discord instead of a fake `<model-id>` placeholder instruction.
 * Discord allows at most 5 action rows per message; 15 models = 3 rows, plus
 * nav + Back still fits.
 */
export const MODEL_PAGE_SIZE = 15;

export function providerModelRows(prefix, providerId, items, { current = null, page = 1, pageSize = MODEL_PAGE_SIZE } = {}) {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const pageNow = Math.min(pages, Math.max(1, Number(page) || 1));
  const slice = items.slice((pageNow - 1) * pageSize, pageNow * pageSize);
  const rows = [];
  for (let i = 0; i < slice.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      ...slice.slice(i, i + 5).map((item) => new ButtonBuilder()
        .setCustomId(`${prefix}:${providerId}:${item.id}`)
        .setLabel(item.id === current ? `✓ ${item.label}`.slice(0, 80) : String(item.label).slice(0, 80))
        .setStyle(item.id === current ? ButtonStyle.Primary : ButtonStyle.Secondary)),
    ));
  }
  if (pages > 1) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${prefix}nav:${providerId}:${pageNow - 1}`).setLabel('⬅️ 上一页').setStyle(ButtonStyle.Secondary).setDisabled(pageNow <= 1),
      new ButtonBuilder().setCustomId(`${prefix}nav:${providerId}:${pageNow + 1}`).setLabel('下一页 ➡️').setStyle(ButtonStyle.Secondary).setDisabled(pageNow >= pages),
    ));
  }
  return { rows, page: pageNow, pages };
}

export const SETTINGS_MODEL_LIMIT = 20;
export const CHOICE_PAGE_SIZE = 10;

export function choiceRows(prefix, items, { current = null } = {}) {
  if (!items.length || items.length > 25) return null;
  const rows = [];
  for (let i = 0; i < items.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      ...items.slice(i, i + 5).map((item) => new ButtonBuilder()
        .setCustomId(`${prefix}:${item.id}`)
        .setLabel(item.id === current ? `✓ ${item.label}`.slice(0, 80) : String(item.label).slice(0, 80))
        .setStyle(item.id === current ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(Boolean(item.disabled))),
    ));
  }
  return rows;
}

/** Paginated variant of `choiceRows` for lists that can exceed one page. */
export function pagedChoiceRows(prefix, items, { current = null, page = 1, pageSize = CHOICE_PAGE_SIZE } = {}) {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const pageNow = Math.min(pages, Math.max(1, Number(page) || 1));
  const slice = items.slice((pageNow - 1) * pageSize, pageNow * pageSize);
  const rows = [];
  for (let i = 0; i < slice.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      ...slice.slice(i, i + 5).map((item) => new ButtonBuilder()
        .setCustomId(`${prefix}:${item.id}`)
        .setLabel(item.id === current ? `✓ ${item.label}`.slice(0, 80) : String(item.label).slice(0, 80))
        .setStyle(item.id === current ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(Boolean(item.disabled))),
    ));
  }
  if (pages > 1) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${prefix}nav:${pageNow - 1}`).setLabel('⬅️ 上一页').setStyle(ButtonStyle.Secondary).setDisabled(pageNow <= 1),
      new ButtonBuilder().setCustomId(`${prefix}nav:${pageNow + 1}`).setLabel('下一页 ➡️').setStyle(ButtonStyle.Secondary).setDisabled(pageNow >= pages),
    ));
  }
  return { rows, page: pageNow, pages };
}

function modelPageButtons(page, pages) {
  if (pages <= 1) return null;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`models:${Math.max(1, page - 1)}`).setLabel('上一页').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`models:${Math.min(pages, page + 1)}`).setLabel('下一页').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages),
  );
}

export { modelPageButtons };

export function protocolLabel(protocol) {
  return { [PROTOCOL.WORKBUDDY]: 'WorkBuddy Native', [PROTOCOL.OPENAI]: 'OpenAI Compatible', [PROTOCOL.ANTHROPIC]: 'Anthropic Compatible', [PROTOCOL.OPENCODE_GO]: 'OpenCode Go' }[protocol] || protocol || 'unknown';
}

export function transportLabel(transport) {
  return {
    [TRANSPORT.ANTHROPIC_MESSAGES]: 'anthropic-messages',
    [TRANSPORT.OPENAI_CHAT]: 'openai-chat',
    [TRANSPORT.OPENAI_RESPONSES]: 'openai-responses',
    [TRANSPORT.UNKNOWN]: 'unknown',
  }[transport] || transport || 'unknown';
}

export function billingLabel(type) {
  return { FREE: '免费', SUBSCRIPTION: '订阅', METERED: '按量 API', UNKNOWN: '未知' }[type] || '未知';
}

const THREAD_NAME_MAX = 90;

export function sanitizeThreadName(task) {
  const cleaned = String(task ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[`*_~|]/g, '')
    .trim();
  const base = cleaned || 'Work';
  const name = `🛠 ${base}`;
  return name.length <= 100 ? name : `${name.slice(0, THREAD_NAME_MAX)}…`;
}

/** Compact Work chain title for the parent summary card (no emoji prefix). */
export function workTitle(task) {
  const cleaned = String(task ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[`*_~|]/g, '')
    .replace(/^🛠\s*/, '')
    .trim();
  return cleaned || 'Work';
}
