// First import on purpose: it wraps the `ws` WebSocket constructor before
// discord.js is evaluated, which is required for the Gateway to use a proxy.
import './discord-proxy.mjs';

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import path from 'node:path';
import fs from 'node:fs';
import { ClaudeRunner } from './claude-runner.mjs';
import { ThrottledEditor, STATE } from './progress.mjs';
import { EventPresenter } from './event-presenter.mjs';
import { describeRouting } from './win-env.mjs';
import { discordRestAgent } from './discord-proxy.mjs';
import { classifyBackend, billingRoute, assertBackendAllowed } from './backend.mjs';
import { withTimeout } from './limits.mjs';
import { PermissionManager, LEVEL } from './permission-manager.mjs';
import { helpText, readyText, formatStatus, APPROVAL_BUTTONS, PERM_LABEL, PERM_SHORT, redact } from './i18n.mjs';
import { PROTOCOL, TRANSPORT, normalizeBaseUrl, providerErrorMessage } from './provider-manager.mjs';
import { SessionManager } from './session-manager.mjs';
import { MODE, parseModeCommand, stripSelfMention } from './mode-router.mjs';
import { WorkspaceScheduler } from './workspace-scheduler.mjs';
import {
  downloadWorkAttachments, buildWorkManifest, readChatAttachments, buildChatContent, buildChatHistoryText,
} from './attachments.mjs';

const DISCORD_LIMIT = 1900;

function clip(text, n = DISCORD_LIMIT) {
  const s = String(text ?? '');
  return s.length <= n ? s : `${s.slice(0, n - 20)}\n…(truncated)`;
}

function permissionButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('perm:strict').setLabel(PERM_LABEL.strict).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('perm:standard').setLabel(PERM_LABEL.standard).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('perm:relaxed').setLabel(PERM_LABEL.relaxed).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('perm:full').setLabel(PERM_LABEL.full).setStyle(ButtonStyle.Danger),
  );
}

function permissionMenuButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('perm:menu').setLabel('🔐 权限设置').setStyle(ButtonStyle.Secondary),
  );
}

function fullConfirmationButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('permfull:confirm').setLabel('确认全开放').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('permfull:cancel').setLabel('取消').setStyle(ButtonStyle.Secondary),
  );
}

function configButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cfg:executor').setLabel('🛠️ 执行器').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cfg:provider').setLabel('🌐 提供商').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cfg:model').setLabel('🧠 模型').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cfg:permission').setLabel('🔐 权限').setStyle(ButtonStyle.Secondary),
  );
}

function providerResultButtons(providerId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`apiuse:${providerId}`).setLabel('选择 Provider').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`apimodel:${providerId}`).setLabel('选择模型').setStyle(ButtonStyle.Secondary),
  );
}

function protocolButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`apiproto:${PROTOCOL.OPENAI}`).setLabel('OpenAI Compatible').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`apiproto:${PROTOCOL.ANTHROPIC}`).setLabel('Anthropic Compatible').setStyle(ButtonStyle.Secondary),
  );
}

function settingsButtons({ workThread = false } = {}) {
  const top = [];
  // A permanent Work thread has no Chat context, so the Chat-route control is
  // deliberately absent there.
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

function settingsBackRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('set:refresh').setLabel('⬅️ 返回').setStyle(ButtonStyle.Secondary),
  );
}

export const PANEL_HELP_TEXT = [
  '📖 **Jarvis 使用说明**',
  '',
  '💬 **Chat** = 普通问答，不启动 Agent。',
  '🛠 **Work** = Agent，可读写文件、执行 Shell、测试。',
  '',
  '**创建 Work**',
  '服务器父频道：`work <任务>`',
  '→ 自动创建 🛠 Work 线程，父频道继续 Chat。',
  '私聊：`work <任务>`',
  '→ 私聊内直接运行 Work。',
  '',
  '`work` → 当前频道切到 Work，下一条普通消息作为任务',
  '`chat` → 切回 Chat（永久 Work 线程里禁止切 Chat）',
  '`!cwd <绝对路径>` → 绑定项目目录',
  '',
  '**快速开始**',
  '1. 点 ⚙️ 设置：Work = Claude Code + OpenCode Go + deepseek-v4.1-flash',
  '2. 点 🔐 权限：standard / relaxed',
  '3. 点 🛠 新建 Work，直接输入任务',
  '4. 在自动创建的 🛠 线程看进度',
  '5. 要中止：点 ⛔ Stop 或输入 `!stop`',
  '',
  '**上下文控制**',
  '`🆕 新对话`：只清空本频道 Chat 上下文，不影响模型/Work 配置',
  '`🧹 压缩上下文`：把较早的 Chat 上下文压缩成摘要，节省 token',
  '附件：文本/图片可作为 Chat 输入；任意项目文件建议发到 Work',
].join('\n');

const PANEL_COMPACT_HEADER = '以下是此前对话的摘要，请在回答时作为背景上下文：';
const PANEL_COMPACT_SYSTEM = '你是一个对话摘要器。只输出摘要本身，不要寒暄，不要复述原始日志。';

function panelMainRows() {
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

function panelBackRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel:refresh').setLabel('⬅️ 返回').setStyle(ButtonStyle.Secondary),
  );
}

function panelModelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panelmodels:chat').setLabel('💬 Chat 模型').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('panelmodels:work').setLabel('🛠 Work 模型').setStyle(ButtonStyle.Primary),
    ),
    panelBackRow(),
  ];
}

/** Choice rows that keep provider + model in the custom id (`prefix:provider:model`). */
function providerModelRows(prefix, providerId, items, { current = null } = {}) {
  if (!items.length || items.length > 20) return null;
  const rows = [];
  for (let i = 0; i < items.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      ...items.slice(i, i + 5).map((item) => new ButtonBuilder()
        .setCustomId(`${prefix}:${providerId}:${item.id}`)
        .setLabel(item.id === current ? `✓ ${item.label}`.slice(0, 80) : String(item.label).slice(0, 80))
        .setStyle(item.id === current ? ButtonStyle.Primary : ButtonStyle.Secondary)),
    ));
  }
  return rows;
}

export const SETTINGS_MODEL_LIMIT = 20;

/**
 * Turn a choice list into button rows (5 per row, 5 rows). Returns null when the
 * list does not fit; callers fall back to the existing text command instead of
 * building pagination in P1.
 */
function choiceRows(prefix, items, { current = null } = {}) {
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

function modelPageButtons(page, pages) {
  if (pages <= 1) return null;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`models:${Math.max(1, page - 1)}`).setLabel('上一页').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`models:${Math.min(pages, page + 1)}`).setLabel('下一页').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages),
  );
}

function protocolLabel(protocol) {
  return { [PROTOCOL.WORKBUDDY]: 'WorkBuddy Native', [PROTOCOL.OPENAI]: 'OpenAI Compatible', [PROTOCOL.ANTHROPIC]: 'Anthropic Compatible', [PROTOCOL.OPENCODE_GO]: 'OpenCode Go' }[protocol] || protocol || 'unknown';
}

function transportLabel(transport) {
  return {
    [TRANSPORT.ANTHROPIC_MESSAGES]: 'anthropic-messages',
    [TRANSPORT.OPENAI_CHAT]: 'openai-chat',
    [TRANSPORT.OPENAI_RESPONSES]: 'openai-responses',
    [TRANSPORT.UNKNOWN]: 'unknown',
  }[transport] || transport || 'unknown';
}

function billingLabel(type) {
  return { FREE: '免费', SUBSCRIPTION: '订阅', METERED: '按量 API', UNKNOWN: '未知' }[type] || '未知';
}

export class DiscordControlPlane {
  constructor({
    config,
    state,
    approvalManager,
    permissionManager = null,
    routing = { env: {}, source: 'process-env', added: [] },
    logger = null,
    limits = null,
    backendState = null,
    credentialStore = null,
    providerManager = null,
    modelManager = null,
    executorManager = null,
    chatRuntime = null,
    chatHistory = null,
    gatewayHealth = null,
    workspaceScheduler = null,
    attachmentInbox = null,
    attachmentFetch = fetch,
    extraEnv = {},
    envUnset = [],
    client = null,
    autoLogin = true,
  }) {
    this.config = config;
    this.state = state;
    this.approvalManager = approvalManager;
    this.permissionManager = permissionManager || new PermissionManager();
    this.routing = routing;
    this.logger = logger;
    this.limits = limits;
    this.backendState = backendState;
    this.credentialStore = credentialStore;
    this.providerManager = providerManager;
    this.modelManager = modelManager;
    this.executorManager = executorManager;
    this.chatRuntime = chatRuntime;
    // Bounded, channel-scoped Chat history. It is separate from the Agent
    // session and is only ever touched by the Chat path.
    this.chatHistory = chatHistory;
    this.gatewayHealth = gatewayHealth;
    // Where downloaded Discord attachments land. Null disables attachments so a
    // bare test harness cannot accidentally write to the real data directory.
    this.attachmentInbox = attachmentInbox;
    this.attachmentFetch = attachmentFetch;
    // Workspace serialization lives in the Work orchestration layer, not in
    // LiteLLM/provider routing and not in the per-channel busy flag: two threads
    // can target the same cwd.
    this.scheduler = workspaceScheduler || new WorkspaceScheduler();
    this.queuedNotices = new Map();
    this.extraEnv = extraEnv;
    this.envUnset = envUnset;
    this.autoLogin = autoLogin;
    this.runners = new Map();
    this.tasks = new Map();
    this.channelBySession = new Map();
    this.backendVerdictByChannel = new Map();
    this.apiOnboarding = new Map();
    // Last provider/model a Chat turn actually used, for the short status footer.
    this.chatActual = new Map();
    this.sessionManager = new SessionManager({
      state,
      permissionManager: this.permissionManager,
      approvalManager,
      defaultCwd: config.defaultCwd,
      isRunning: (channelId) => this.tasks.has(channelId) || Boolean(this.runners.get(channelId)?.busy),
      stopRunner: async (channelId, reason) => {
        const runner = this.runners.get(channelId);
        const sessionId = this.sessionManager?.get(channelId).sessionId;
        if (runner) await runner.stop({ reason });
        this.runners.delete(channelId);
        if (sessionId) this.channelBySession.delete(sessionId);
      },
    });
    const restAgent = discordRestAgent();
    this.client = client || new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
      // Explicit so the REST side uses the same proxy as the gateway.
      ...(restAgent ? { rest: { agent: restAgent } } : {}),
    });
  }

  async start() {
    this.approvalManager.setPresenter((req) => this.presentApproval(req));
    this.approvalManager.setSettledHandler(({ answer, meta }) => this.onApprovalSettled(answer, meta));
    this.client.on('messageCreate', (m) => this.onMessage(m).catch((e) => console.error(`[discord] message handler: ${redact(e?.stack || e)}`)));
    this.client.on('interactionCreate', (i) => this.onInteraction(i).catch((e) => console.error(`[discord] interaction handler: ${redact(e?.stack || e)}`)));
    if (this.autoLogin) await this.client.login(this.config.discordToken);
    if (this.config.notifyOnStart !== false) await this.notifyReady();
  }

  /**
   * Kill every live agent tree and release every task.
   *
   * Used by the shutdown path so a bridge exit can never leave orphan
   * PowerShell / cmd / node processes running against the user's machine.
   */
  async stopAll({ reason = 'bridge shutdown' } = {}) {
    const runners = [...this.runners.values()];
    this.runners.clear();
    for (const task of this.tasks.values()) task.cancelled = true;
    await Promise.all(runners.map((runner) => runner.stop({ reason }).catch(() => {})));
    for (const task of [...this.tasks.values()]) {
      await task.finish().catch(() => {});
    }
    return runners.length;
  }

  /**
   * Tell the owner the bridge is actually online.
   *
   * Worth the one message: Discord does not replay messages sent while the bot
   * was offline, so "is it up yet?" has to be answered from the bot side.
   */
  async notifyReady() {
    const owner = await this.client.users.fetch(this.config.ownerId).catch(() => null);
    if (!owner) return;
    const backend = this.backendState?.backend ?? null;
    const workbuddyProfile = this.providerManager?.get('workbuddy-free');
    const workbuddyStatus = this.backendState?.workbuddyStatus;
    const workbuddySuffix = workbuddyStatus && workbuddyStatus !== 'PASS'
      ? ` · ${workbuddyStatus === 'BLOCKED_BY_QUOTA' ? '额度不足' : '当前不可用'}` : '';
    const permLabel = PERM_SHORT[this.permissionManager.getLevel(null)] || PERM_SHORT.standard;
    const text = readyText({
      executor: this.executorManager?.get('workbuddy')?.displayName,
      provider: workbuddyProfile ? `${workbuddyProfile.displayName}${workbuddySuffix}` : undefined,
      protocol: protocolLabel(this.providerManager?.get('workbuddy-free')?.protocol),
      backend: backend?.label ?? 'unknown',
      model: backend?.model ?? 'unknown',
      billingRoute: backend ? billingRoute(backend) : 'unknown',
      paidFallback: this.config.allowPaidFallback,
      defaultCwd: this.config.defaultCwd,
      permissionLabel: permLabel,
    });
    try { await owner.send(text); } catch (error) { console.warn(`[discord] could not send the ready DM: ${redact(error?.message)}`); }
  }

  allowedMessage(message) {
    if (message.author?.bot) return false;
    if (message.author?.id !== this.config.ownerId) return false;
    if (!message.guildId) return true;
    if (this.config.guildId && message.guildId !== this.config.guildId) return false;
    if (this.config.channelId && message.channelId !== this.config.channelId) return false;
    return true;
  }

  async getRunner(channelId) {
    const existing = this.runners.get(channelId);
    if (existing) return existing;

    const chState = this.sessionManager.get(channelId);
    const common = {
      cwd: chState.cwd,
      sessionId: chState.sessionId,
      includePartialMessages: this.config.includePartialMessages,
      onLog: (entry) => this.tasks.get(channelId)?.runLog?.log(entry),
      onEvent: (e) => {
        const adapter = this.executorManager?.get(chState.executorId);
        this.onRunnerEvent(channelId, adapter?.normalizeEvent ? adapter.normalizeEvent(e) : e);
      },
      onExit: () => this.runners.delete(channelId),
    };
    let runner;
    if (this.executorManager && this.providerManager && this.credentialStore) {
      const provider = this.providerManager.get(chState.providerId);
      if (!provider) throw Object.assign(new Error('Provider 未选择或已删除'), { code: 'PROVIDER_NOT_FOUND' });
      if (provider.id === 'workbuddy-free' && this.backendState?.workbuddyStatus && this.backendState.workbuddyStatus !== 'PASS') {
        throw Object.assign(new Error(this.backendState.workbuddyStatus), {
          code: this.backendState.workbuddyStatus === 'BLOCKED_BY_QUOTA' ? 'WORKBUDDY_QUOTA' : 'WORKBUDDY_UNAVAILABLE',
        });
      }
      const credential = provider.credentialRef ? this.credentialStore.get(provider.credentialRef) : null;
      if (provider.credentialRef && !credential) throw Object.assign(new Error('Provider credential missing'), { code: 'INVALID_CREDENTIAL' });
      const model = chState.model || (provider.protocol === PROTOCOL.WORKBUDDY ? provider.models?.[0]?.id : null);
      if (!model) throw Object.assign(new Error('请先使用 !model <model-id> 选择模型'), { code: 'MODEL_REQUIRED' });
      runner = await this.executorManager.createRunner({
        executorId: chState.executorId, provider, credential, model, ...common,
      });
    } else {
      runner = new ClaudeRunner({
        command: this.config.claudeCommand, extraEnv: this.extraEnv, envUnset: this.envUnset, ...common,
      });
    }
    this.runners.set(channelId, runner);
    return runner;
  }

  onRunnerEvent(channelId, event) {
    if (event.type === 'session') {
      this.sessionManager.bindExecutorSession(channelId, event.sessionId);
      this.channelBySession.set(event.sessionId, channelId);
      this.permissionManager.syncSession(event.sessionId, channelId);
    }
    if (event.type === 'model') {
      const chState = this.state.getChannel(channelId, this.config.defaultCwd);
      if (chState.model !== event.model) this.state.patchChannel(channelId, { model: event.model }, this.config.defaultCwd);
    }
    if (event.type === 'init') this.#noteBackend(channelId, event);

    const task = this.tasks.get(channelId);
    if (!task) return;
    if (task.progress.record(event)) task.schedule();
  }

  /**
   * Record which credential actually served the request, and fail closed when it
   * is not the expected free backend.
   */
  #noteBackend(channelId, event) {
    const session = this.sessionManager.get(channelId);
    if (this.providerManager && session.providerId !== 'workbuddy-free') {
      this.backendVerdictByChannel.set(channelId, { ok: true, reason: 'provider-isolated environment' });
      return { ok: true };
    }
    const observed = classifyBackend({ apiKeySource: event.apiKeySource, model: event.model });
    this.backendState = {
      ...(this.backendState ?? {}),
      backend: observed,
      billingRoute: billingRoute(observed),
      executor: this.config.claudeCommand,
      allowPaidFallback: this.config.allowPaidFallback,
    };
    const verdict = assertBackendAllowed(observed, {
      allowPaidFallback: this.config.allowPaidFallback,
      expected: this.config.agentBackend,
    });
    // Per channel, so one bad run cannot be masked by another channel's good one.
    this.backendVerdictByChannel.set(channelId, verdict);
    console.log(`[backend] observed=${observed.label} model=${observed.model ?? 'unknown'} apiKeySource=${observed.apiKeySource ?? 'none'} -> ${verdict.ok ? 'OK' : 'REJECTED'}`);
    if (!verdict.ok) console.error(`[backend] ${verdict.reason}`);
    return verdict;
  }

  #statusLine(channelId, gateway = null) {
    const s = this.sessionManager.get(channelId);
    const runner = this.runners.get(channelId);
    const backend = this.backendState?.backend ?? null;
    const provider = this.providerManager?.get(s.providerId);
    const executor = this.executorManager?.get(s.executorId);
    const blocked = this.limits?.blocked(channelId);
    const providerBlocked = provider?.id === 'workbuddy-free'
      && this.backendState?.workbuddyStatus && this.backendState.workbuddyStatus !== 'PASS'
      ? (this.backendState.workbuddyStatus === 'BLOCKED_BY_QUOTA' ? 'WorkBuddy 当前额度不足' : 'WorkBuddy 当前不可用')
      : null;
    const permLabel = PERM_SHORT[this.permissionManager.getLevel(channelId)] || PERM_SHORT.standard;
    const modelId = runner?.model || s.model || null;
    const transport = provider?.protocol === PROTOCOL.OPENCODE_GO
      ? this.executorManager?.resolveTransport(provider, modelId)
      : null;
    const protocol = provider?.protocol === PROTOCOL.OPENCODE_GO ? transportLabel(transport) : protocolLabel(provider?.protocol);
    const adapter = provider ? this.executorManager?.adapterLabel(provider.protocol, transport) : null;
    return formatStatus({
      executor: executor?.displayName ?? this.config.claudeCommand,
      provider: this.providerManager ? provider?.displayName || '未选择' : undefined,
      protocol,
      adapter,
      backend: backend?.label ?? 'unknown',
      model: runner?.model || s.model || backend?.model || 'unknown',
      billingRoute: backend ? billingRoute(backend) : 'unknown',
      billingType: provider ? billingLabel(provider.billingType) : null,
      paidFallback: this.config.allowPaidFallback,
      cwd: s.cwd,
      sessionId: s.sessionId,
      state: runner?.busy ? '忙碌' : '空闲',
      idleSec: runner?.busy ? Math.round((runner.idleMs ?? 0) / 1000) : null,
      pendingApprovals: this.approvalManager.pending.size,
      permissionLabel: permLabel,
      blocked: blocked?.blocked ? blocked.reason : providerBlocked,
      mode: s.mode,
      workState: this.#workStateText(channelId),
      workWorkspace: this.scheduler.stateFor(channelId).workspace || s.cwd,
      chatRoute: this.#chatRouteText(channelId),
      chatActual: this.#chatActualText(channelId),
      chatHealth: this.#chatHealthText(channelId),
      gateway,
    });
  }

  #permissionMenu(channelId) {
    const level = this.permissionManager.getLevel(channelId);
    return {
      content: `🔐 当前权限：${PERM_SHORT[level]}\n\n请选择权限档位：`,
      components: [permissionButtons()],
    };
  }

  async #refreshTaskPermission(channelId, level) {
    const task = this.tasks.get(channelId);
    if (!task) return;
    task.progress.setPermissionLabel(PERM_SHORT[level]);
    await task.editor.flushNow(task.progress.render());
  }

  async #switchPermission(channelId, level, { confirmed = false } = {}) {
    const result = confirmed
      ? this.permissionManager.confirmFull(channelId)
      : this.permissionManager.switchLevel(channelId, level);
    if (result.needsConfirm) return { ...result, confirmation: true };
    if (!result.ok) return result;
    await this.#refreshTaskPermission(channelId, result.current);
    return result;
  }

  #busy(channelId) {
    return this.tasks.has(channelId) || Boolean(this.runners.get(channelId)?.busy);
  }

  #workStateText(channelId) {
    const work = this.scheduler.stateFor(channelId);
    if (work.state === 'running') return 'running';
    if (work.state === 'queued') return `queued (#${work.position})`;
    return 'idle';
  }

  /**
   * Compact settings panel. It only *renders* state; every mutation reuses the
   * same SessionManager / PermissionManager logic as the text commands, so there
   * is exactly one configuration system.
   */
  #settingsPanel(channelId) {
    const state = this.sessionManager.get(channelId);
    const provider = this.providerManager?.get(state.providerId);
    const executor = this.executorManager?.get(state.executorId);
    const actual = this.#chatActualText(channelId);
    const lines = [
      '⚙️ **Jarvis Settings**',
      '',
      '💬 **CHAT**',
      `Route: ${this.#chatRouteText(channelId)}`,
      `Last actual: ${actual || '—'}`,
      '',
      '🛠 **WORK**',
      `Executor: ${executor?.displayName || state.executorId || '未选择'}`,
      `Provider: ${provider?.displayName || state.providerId || '未选择'}`,
      `Model: ${state.model || '未选择'}`,
      `Workspace: \`${state.cwd}\``,
      `Permission: ${PERM_SHORT[this.permissionManager.getLevel(channelId)]}`,
      `State: ${this.#workStateText(channelId)}`,
      ...(this.#isWorkThread(channelId) ? ['', '🛠 这是永久 Work 线程；请到父频道使用 Chat。'] : []),
      '',
      '使用下方按钮修改；文本指令仍然有效。',
    ];
    return { content: clip(lines.join('\n')), components: settingsButtons({ workThread: this.#isWorkThread(channelId) }) };
  }

  #configCard(channelId) {
    const state = this.sessionManager.get(channelId);
    const executor = this.executorManager?.get(state.executorId);
    const provider = this.providerManager?.get(state.providerId);
    const transport = provider?.protocol === PROTOCOL.OPENCODE_GO
      ? this.executorManager?.resolveTransport(provider, state.model)
      : null;
    const protocol = provider?.protocol === PROTOCOL.OPENCODE_GO ? transportLabel(transport) : protocolLabel(provider?.protocol);
    const adapter = provider ? this.executorManager?.adapterLabel(provider.protocol, transport) : null;
    return {
      content: [
        '【⚙️ Agent 配置】', '',
        `🛠️ 执行器\n${executor?.displayName || '未选择'}`, '',
        `🌐 提供商\n${provider?.displayName || '未选择'}`, '',
        `🧠 模型\n${state.model || '未选择'}`, '',
        `🔌 协议\n${protocol}`, '',
        ...(adapter ? [`🔄 兼容层\n${adapter}`, ''] : []),
        `🔐 权限\n${PERM_SHORT[this.permissionManager.getLevel(channelId)]}`, '',
        `💰 计费\n${billingLabel(provider?.billingType)}`,
      ].join('\n'),
      components: [configButtons()],
    };
  }

  #executorText(channelId) {
    const current = this.sessionManager.get(channelId).executorId;
    const lines = ['🛠️ **可用执行器**', ''];
    for (const executor of this.executorManager?.list() ?? []) {
      const icon = executor.status === 'PASS' ? '✅' : executor.status === 'ADAPTER_NOT_READY' ? '⚠️' : '❌';
      lines.push(`${icon} ${executor.displayName}${executor.id === current ? ' · 当前' : ''}`);
      lines.push(`   ${executor.id} · ${executor.version || executor.status}`);
    }
    lines.push('', '切换：`!executor <id>`');
    return lines.join('\n');
  }

  #providersText(channelId) {
    const current = this.sessionManager.get(channelId).providerId;
    const lines = ['🌐 **Provider**', ''];
    for (const provider of this.providerManager?.list() ?? []) {
      const ready = this.providerManager.hasCredential(provider);
      const status = provider.id === 'workbuddy-free' ? this.backendState?.workbuddyStatus : null;
      lines.push(`${ready && (!status || status === 'PASS') ? '✅' : '❌'} ${provider.displayName}${provider.id === current ? ' · 当前' : ''}`);
      lines.push(`   ${provider.id} · ${protocolLabel(provider.protocol)}${status && status !== 'PASS' ? ` · ${status}` : ''}`);
    }
    lines.push('', '切换：`!provider <id>`');
    return lines.join('\n');
  }

  async #modelsPayload(channelId, requestedPage = 1, providerId = null) {
    const state = this.sessionManager.get(channelId);
    const id = providerId || state.providerId;
    const provider = this.providerManager?.get(id);
    if (!provider) return { content: '❌ 当前未选择 Provider。', components: [] };
    let result;
    try { result = await this.modelManager.list(id); }
    catch (error) { return { content: providerErrorMessage(error), components: [] }; }
    if (!result.models.length) {
      return { content: `⚠️ ${provider.displayName} 未能自动获取模型列表。\n请使用 \`!provider ${id}\` 后输入 \`!model <model-id>\`，系统会发起真实调用验证。`, components: [] };
    }
    const pageSize = 15;
    const pages = Math.max(1, Math.ceil(result.models.length / pageSize));
    const page = Math.min(pages, Math.max(1, Number(requestedPage) || 1));
    const rows = result.models.slice((page - 1) * pageSize, page * pageSize);
    const executor = this.executorManager?.get(state.executorId);
    const lines = [
      `🧠 **${provider.displayName} 模型** · ${page}/${pages}`,
      result.stale ? '⚠️ 模型列表可能不是最新' : '',
      '',
      ...rows.map((model) => {
        const marks = [];
        if (provider.protocol === PROTOCOL.OPENCODE_GO) {
          const compatible = this.executorManager?.compatible(state.executorId, provider.protocol, model.transport);
          const adapter = this.executorManager?.adapterLabel(provider.protocol, model.transport);
          marks.push(`🔌 ${transportLabel(model.transport)}`);
          marks.push(compatible
            ? `✅ ${executor?.displayName || state.executorId}${adapter ? `（${adapter}）` : ''}`
            : '❌ 不支持当前执行器');
        }
        const suffix = marks.length ? `\n  ${marks.join(' · ')}` : '';
        return `${model.id === state.model ? '✅' : '•'} ${model.displayName}\n  \`${model.id}\`${suffix}`;
      }),
      '',
      id === state.providerId ? '切换：`!model <model-id>`' : `先切换 Provider：\`!provider ${id}\``,
    ].filter(Boolean);
    const buttons = modelPageButtons(page, pages);
    return { content: clip(lines.join('\n')), components: buttons ? [buttons] : [] };
  }

  async #switchExecutor(channelId, executorId) {
    if (this.#busy(channelId)) return '⚠️ 当前任务正在执行。请等待任务完成或使用 `!stop`。';
    const executor = this.executorManager?.get(executorId);
    if (!executor) return '❌ 未知执行器。';
    if (!executor.available) return `❌ ${executor.displayName} · 未安装`;
    if (!executor.adapterReady) return `⚠️ ${executor.displayName} · ADAPTER_NOT_READY`;
    const state = this.sessionManager.get(channelId);
    const provider = this.providerManager?.get(state.providerId);
    if (!provider || !this.executorManager.compatible(executorId, provider.protocol)) {
      await this.sessionManager.change(channelId, { executorId }, 'executor changed');
      return `⚠️ 已选择执行器：${executor.displayName}，但它不支持当前 Provider。\n请继续使用 \`!provider <id>\` 选择兼容 Provider；配置完成前不会启动任务。`;
    }
    await this.sessionManager.change(channelId, { executorId }, 'executor changed');
    return `✅ 已切换执行器：${executor.displayName}\n已创建新安全 Session，权限恢复为 🛡️ 标准。`;
  }

  async #switchProvider(channelId, providerId) {
    if (this.#busy(channelId)) return '⚠️ 当前任务正在执行。请等待任务完成或使用 `!stop`。';
    const provider = this.providerManager?.get(providerId);
    if (!provider) return '❌ 未知 Provider。';
    if (!this.providerManager.hasCredential(provider)) return '❌ 当前 Provider 缺少 credential。';
    const state = this.sessionManager.get(channelId);
    if (!this.executorManager.compatible(state.executorId, provider.protocol, null)) {
      const recommendations = this.executorManager.compatibleExecutors(provider.protocol).map((item) => item.displayName);
      return `❌ 当前执行器不支持此 Provider 协议。${recommendations.length ? `\n可用执行器：${recommendations.join('、')}` : ''}`;
    }
    const model = provider.protocol === PROTOCOL.WORKBUDDY ? provider.models?.[0]?.id || null : null;
    await this.sessionManager.change(channelId, { providerId, model }, 'provider changed');
    const hint = provider.protocol === PROTOCOL.OPENCODE_GO
      ? '\n请使用 `!models` 选择模型；只有当前执行器兼容的协议才能被选中。'
      : '\n请使用 `!models` 选择模型。';
    return `✅ 已切换 Provider：${provider.displayName}\n已创建新安全 Session，权限恢复为 🛡️ 标准。${model ? `\n🧠 模型：${model}` : hint}`;
  }

  async #selectModel(channelId, modelId) {
    if (this.#busy(channelId)) return '⚠️ 当前任务正在执行。请等待任务完成或使用 `!stop`。';
    const state = this.sessionManager.get(channelId);
    try { await this.modelManager.select(state.providerId, modelId); }
    catch (error) { return providerErrorMessage(error); }
    const provider = this.providerManager?.get(state.providerId);
    const transport = this.executorManager?.resolveTransport(provider, modelId);
    if (provider && !this.executorManager.compatible(state.executorId, provider.protocol, transport)) {
      return `❌ 当前执行器不支持此模型协议（${transportLabel(transport)}）。\n请改用兼容模型，或先用 \`!provider\` 选择兼容 Provider。`;
    }
    await this.sessionManager.change(channelId, { model: modelId }, 'model changed');
    return `✅ 已切换模型：\`${modelId}\`\n已创建新安全 Session，权限恢复为 🛡️ 标准。`;
  }

  #providerAdded(channelId, added, deleted) {
    const compatible = this.executorManager.compatibleExecutors(added.profile.protocol);
    const lines = [
      '✅ **API 已添加**', '',
      `🌐 Provider\n${added.profile.displayName}`, '',
      `🔌 协议\n${protocolLabel(added.profile.protocol)}`, '',
      `🧠 发现模型\n${added.profile.models.length} 个`, '',
      `🔑 Credential\n${added.credentialMask}`, '',
      '🛠️ 可用执行器',
      ...(compatible.length ? compatible.map((executor) => `✅ ${executor.displayName}`) : ['⚠️ 当前没有已就绪的兼容执行器']),
    ];
    if (added.modelsMissing) lines.push('', '⚠️ 未能自动获取模型列表，可切换 Provider 后使用 `!model <model-id>` 验证并添加。');
    if (!deleted) lines.push('', '⚠️ Discord 未允许删除原消息，请立即手动删除。');
    return { content: lines.join('\n'), components: [providerResultButtons(added.profile.id)] };
  }

  async #handleApiInput(message) {
    const channelId = message.channelId;
    const respond = (payload) => message.channel?.send ? message.channel.send(payload) : message.reply(payload);
    const pending = this.apiOnboarding.get(channelId);
    const lines = String(message.content ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!pending.baseUrl && lines.length < 2) {
      try { pending.baseUrl = normalizeBaseUrl(lines[0]); }
      catch { await message.reply('❌ Base URL 无效，请重新发送。'); return; }
      await message.reply('已收到 Base URL。现在请只发送 API Key。');
      return;
    }
    const baseUrl = pending.baseUrl || lines[0];
    const secret = pending.baseUrl ? lines.join('') : lines.slice(1).join('');
    let deleted = false;
    try {
      if (typeof message.delete === 'function') { await message.delete(); deleted = true; }
    } catch { /* Report below without logging message contents. */ }
    try {
      const added = await this.providerManager.addGeneric({ baseUrl, secret });
      if (added.needsProtocol) {
        this.apiOnboarding.set(channelId, { ...added.pending, deleted });
        await respond({
          content: `⚠️ 无法自动识别协议。请选择协议后再次验证：${deleted ? '' : '\n⚠️ Discord 未允许删除原消息，请立即手动删除。'}`,
          components: [protocolButtons()],
        });
        return;
      }
      this.apiOnboarding.delete(channelId);
      await respond(this.#providerAdded(channelId, added, deleted));
    } catch (error) {
      this.apiOnboarding.delete(channelId);
      await respond(`${providerErrorMessage(error)}${deleted ? '' : '\n⚠️ Discord 未允许删除原消息，请立即手动删除。'}`);
    }
  }

  async onMessage(message) {
    if (!this.allowedMessage(message)) return;
    // Routing evidence: which live bridge PID handled this DM/guild message.
    console.log(`[discord] message pid=${process.pid} source=${message.guildId ? 'guild' : 'dm'} channel=${message.channelId}`);
    // Strip our own leading mention so `@Jarvis 你好` chats exactly like `你好`,
    // and so `@Jarvis work` still parses as a local mode command.
    const text = stripSelfMention(String(message.content ?? '').trim(), this.client?.user?.id ?? null);
    const attachments = this.#messageAttachments(message);
    if (!text && !attachments.length) return;

    if (text === '!api') {
      if (message.guildId) {
        await message.reply('❌ `!api` 仅允许在 Bot 私聊中使用。');
        return;
      }
      const old = this.apiOnboarding.get(message.channelId);
      if (old?.credentialRef) this.credentialStore?.remove(old.credentialRef);
      this.apiOnboarding.set(message.channelId, { baseUrl: null });
      await message.reply([
        '🔐 **添加 API**', '',
        '请发送 Base URL 和 API Key。',
        '可一次发送两行：',
        '```text',
        'https://api.example.com/v1',
        'sk-xxxxxxxxxxxxxxxx',
        '```',
        '也可以先发 Base URL，再单独发送 Key。发送 `!cancel` 取消。',
      ].join('\n'));
      return;
    }
    if (this.apiOnboarding.has(message.channelId)) {
      if (text === '!cancel') {
        const pending = this.apiOnboarding.get(message.channelId);
        if (pending?.credentialRef) this.credentialStore?.remove(pending.credentialRef);
        this.apiOnboarding.delete(message.channelId);
        await message.reply('已取消 API 添加。');
      } else {
        await this.#handleApiInput(message);
      }
      return;
    }

    if (text === '!help') {
      await message.reply(helpText());
      return;
    }
    if (text === '!status') {
      const gateway = this.gatewayHealth
        ? await this.gatewayHealth().catch(() => ({ ok: false, detail: 'error' }))
        : null;
      await message.reply({ content: clip(this.#statusLine(message.channelId, gateway)), components: [permissionMenuButton()] });
      return;
    }
    if (text === '!config') {
      await message.reply(this.#configCard(message.channelId));
      return;
    }
    if (text === '!settings') {
      await message.reply(this.#settingsPanel(message.channelId));
      return;
    }
    if (text === '!panel' || text === '/panel') {
      console.log(`[panel] pid=${process.pid} source=${message.guildId ? 'guild' : 'dm'} channel=${message.channelId} (local, no model call)`);
      const panel = message.channel?.send ? await message.channel.send(this.#controlPanel(message.channelId)) : await message.reply(this.#controlPanel(message.channelId));
      let pinned = false;
      try {
        if (typeof panel?.pin === 'function') { await panel.pin(); pinned = true; }
      } catch { pinned = false; }
      if (!pinned) await message.reply('控制面板已发送。自动置顶未成功，可手动置顶该消息。');
      return;
    }
    if (/^[/!]new$/i.test(text)) {
      await message.reply(this.#newChat(message.channelId));
      return;
    }
    if (/^[/!]compact$/i.test(text)) {
      await message.reply(clip(await this.#compactChat(message.channelId)));
      return;
    }
    const executorCommand = text.toLowerCase().match(/^!executor(?:\s+(\S+))?$/);
    if (executorCommand) {
      await message.reply(executorCommand[1]
        ? await this.#switchExecutor(message.channelId, executorCommand[1])
        : this.#executorText(message.channelId));
      return;
    }
    if (text === '!providers') {
      await message.reply(this.#providersText(message.channelId));
      return;
    }
    const providerCommand = text.match(/^!provider(?:\s+(.+))?$/i);
    if (providerCommand) {
      const argument = providerCommand[1]?.trim();
      if (!argument) {
        const state = this.sessionManager.get(message.channelId);
        const provider = this.providerManager?.get(state.providerId);
        await message.reply(provider
          ? `🌐 当前 Provider：${provider.displayName}\nID：\`${provider.id}\`\n协议：${protocolLabel(provider.protocol)}`
          : '❌ 当前未选择 Provider。');
        return;
      }
      if (/^remove(?:\s+|$)/i.test(argument)) {
        const providerId = argument.replace(/^remove\s*/i, '');
        if (!providerId) {
          const removable = this.providerManager.list().filter((item) => item.removable);
          await message.reply(removable.length
            ? `可删除 Provider：\n${removable.map((item) => `• \`${item.id}\` ${item.displayName}`).join('\n')}\n\n删除：\`!provider remove <id>\``
            : '没有可删除的 Provider。');
          return;
        }
        if (this.#busy(message.channelId)) {
          await message.reply('⚠️ 当前任务正在执行。请等待任务完成或使用 `!stop`。');
          return;
        }
        try {
          await this.sessionManager.invalidateProvider(providerId);
          const removed = this.providerManager.remove(providerId);
          await message.reply(removed ? `✅ 已删除 Provider：\`${providerId}\`、credential、模型缓存和关联 Session。` : '❌ 未找到 Provider。');
        } catch (error) {
          await message.reply(error.code === 'BUILTIN_PROVIDER' ? '❌ 核心内置 Provider 不能删除。' : providerErrorMessage(error));
        }
        return;
      }
      await message.reply(await this.#switchProvider(message.channelId, argument));
      return;
    }
    const modelsCommand = text.match(/^!models(?:\s+(\d+))?$/i);
    if (modelsCommand) {
      await message.reply(await this.#modelsPayload(message.channelId, modelsCommand[1] || 1));
      return;
    }
    const modelCommand = text.match(/^!model(?:\s+(.+))?$/i);
    if (modelCommand) {
      const modelId = modelCommand[1]?.trim();
      if (!modelId) {
        const state = this.sessionManager.get(message.channelId);
        await message.reply(`🧠 当前模型\n${state.model || '未选择'}${state.model ? `\nModel ID：\`${state.model}\`` : ''}`);
      } else {
        await message.reply(await this.#selectModel(message.channelId, modelId));
      }
      return;
    }
    const chatModelCommand = text.match(/^!chatmodel(?:\s+(.+))?$/i);
    if (chatModelCommand) {
      await message.reply(await this.#chatModelCommand(message.channelId, chatModelCommand[1]?.trim() || null));
      return;
    }
    if (text === '!health') {
      const state = this.sessionManager.snapshot(message.channelId);
      const executor = this.executorManager?.get(state.executorId);
      const provider = this.providerManager?.get(state.providerId);
      const providerHealth = provider ? await this.providerManager.health(provider.id) : { ok: false };
      const compatible = Boolean(executor && provider && this.executorManager.compatible(executor.id, provider.protocol));
      const modelExists = Boolean(state.model && provider?.models?.some((model) => model.id === state.model));
      await message.reply([
        '🩺 **Agent 健康检查**', '',
        `${executor?.available && executor.adapterReady ? '✅' : '❌'} 执行器：${executor?.displayName || '未选择'} · ${executor?.status || 'MISSING'}`,
        `${provider ? '✅' : '❌'} Provider：${provider?.displayName || '未选择'}`,
        `${providerHealth.ok ? '✅' : '❌'} Provider health${providerHealth.error ? `：${providerErrorMessage(providerHealth.error)}` : ''}`,
        `${provider && this.providerManager?.hasCredential(provider) ? '✅' : '❌'} Credential`,
        `${modelExists ? '✅' : '❌'} Model：${state.model || '未选择'}`,
        `${compatible ? '✅' : '❌'} Executor × Provider 兼容性`,
        `${state.executorSessionId ? '✅' : '⚠️'} Session：${state.executorSessionId || '新会话'}`,
      ].join('\n'));
      return;
    }
    const permissionCommand = text.toLowerCase().match(/^!(?:perm|permission)(?:\s+(\S+))?$/);
    if (permissionCommand) {
      const requested = permissionCommand[1];
      if (!requested) {
        await message.reply(this.#permissionMenu(message.channelId));
        return;
      }
      if (!Object.values(LEVEL).includes(requested)) {
        await message.reply('未知权限档位。可用值：`strict`、`standard`、`relaxed`、`full`。');
        return;
      }
      const result = await this.#switchPermission(message.channelId, requested);
      if (result.confirmation) {
        await message.reply({
          content: '⚠️ **全开放模式**\n\n普通工具调用将自动允许。OWNER 校验、凭据保护、超时、停止和后端校验仍然有效。',
          components: [fullConfirmationButtons()],
        });
        return;
      }
      await message.reply(`🔐 当前权限：${PERM_SHORT[result.current]}`);
      return;
    }
    if (text === '!stop') {
      await message.reply(await this.#stopChannel(message.channelId));
      return;
    }
    if (text === '!reset') {
      const runner = this.runners.get(message.channelId);
      const task = this.tasks.get(message.channelId);
      if (task) task.cancelled = true;
      if (runner?.sessionId) {
        this.approvalManager.cancelForSession(runner.sessionId, 'session reset (!reset)');
        this.approvalManager.clearSessionAllows(runner.sessionId);
      }
      if (runner) await runner.stop({ reason: 'session reset (!reset)' });
      this.runners.delete(message.channelId);
      if (task) await task.finish();
      await this.sessionManager.reset(message.channelId);
      this.limits?.reset(message.channelId);
      this.backendVerdictByChannel.delete(message.channelId);
      await message.reply('✅ 会话已重置。下一个任务将使用新会话，权限已恢复为 🛡️ 标准，失败/重启计数已清零。');
      return;
    }
    if (text === '!handoff') {
      const s = this.sessionManager.get(message.channelId);
      const runner = this.runners.get(message.channelId);
      const last = this.tasks.get(message.channelId);
      const lines = [
        '```text',
        `目标: <填写>`,
        `项目: ${s.cwd}`,
        `执行器: ${s.executorId} (${runner?.model || 'unknown model'})`,
        `Provider: ${s.providerId || 'none'}`,
        `当前状态: ${last?.progress?.state || 'idle'}`,
        `最近动作: ${last?.progress?.lastAction || '-'}`,
        `测试: ${last?.progress?.tests || '-'}`,
        `最近错误: ${redact(runner?.lastError?.message || '-')}`,
        '需要判断: <填写>',
        '```',
      ];
      await message.reply(clip(lines.join('\n')));
      return;
    }
    if (text.startsWith('!cwd ')) {
      const requested = text.slice(5).trim().replace(/^"(.*)"$/s, '$1');
      if (!path.isAbsolute(requested) || !fs.existsSync(requested)) {
        await message.reply('路径必须是 Bridge 所在 Windows 机器上已存在的绝对路径。');
        return;
      }
      if (this.#busy(message.channelId)) {
        await message.reply('⚠️ 当前任务正在执行。请等待任务完成或使用 `!stop`。');
        return;
      }
      await this.sessionManager.change(message.channelId, { cwd: requested }, 'cwd changed');
      await message.reply(`✅ 当前频道已绑定到 \`${requested}\`。\n会话已清除，权限已恢复为 🛡️ 标准。`);
      return;
    }

    // --- local mode control (deterministic, never calls a model) ------------
    // Handled before any Agent runner is touched, so `work` / `chat` can never be
    // forwarded to WorkBuddy as if it were a task prompt.
    const modeCommand = parseModeCommand(text);
    if (modeCommand) {
      await this.#handleModeCommand(message, modeCommand);
      return;
    }

    // Ordinary messages are routed by the channel's current mode. Chat is the
    // default and never enters the Agent path.
    const mode = this.sessionManager.get(message.channelId).mode;
    if (mode === MODE.WORK) {
      if (this.tasks.has(message.channelId) || this.runners.get(message.channelId)?.busy) {
        await message.reply('当前频道已有任务正在运行。如需中止，请先发送 `!stop`。');
        return;
      }
      if (this.scheduler?.stateFor(message.channelId).state === 'queued') {
        await message.reply('⏳ 该频道已有任务在队列中等待。使用 `!stop` 取消排队。');
        return;
      }
      // Refuse to keep hammering a broken setup; that is how a background loop
      // burns tokens unattended.
      const blocked = this.limits?.blocked(message.channelId);
      if (blocked?.blocked) {
        await message.reply(`⛔ 拒绝启动：${redact(blocked.reason)}`);
        return;
      }
      await this.runTask(message, text, { attachments });
      return;
    }

    await this.runChat(message, text, { attachments });
  }

  /**
   * Switch mode locally and, when an inline prompt is present, execute it in the
   * target mode. This function never calls a model on its own.
   */
  async #handleModeCommand(message, command) {
    const channelId = message.channelId;

    // A permanent Work thread is Work-scoped: `chat` must never silently turn it
    // back into Chat, and `work <task>` must never nest a second thread.
    if (this.#isWorkThread(channelId)) {
      if (command.mode === MODE.CHAT) {
        await message.reply('这是 Work 线程。请到父频道使用 Chat。');
        return;
      }
      if (!command.prompt) {
        await message.reply('🛠 这是 Work 线程，下一条普通消息将作为 Agent 任务执行。');
        return;
      }
      await this.#startWorkInChannel(message, command.prompt);
      return;
    }

    // Thread-capable guild parent + inline task: isolate the Work into a thread
    // and leave the parent in Chat. DMs / non-thread channels keep the existing
    // inline behavior.
    if (command.mode === MODE.WORK && command.prompt && this.#supportsThreads(message)) {
      await this.#startWorkThread(message, command.prompt, { attachments: this.#messageAttachments(message) });
      return;
    }

    await this.sessionManager.setMode(channelId, command.mode);
    if (command.mode === MODE.WORK) {
      if (!command.prompt) {
        await message.reply('🛠 已切换到 Work 模式。下一条普通消息将作为 Agent 任务执行。');
        return;
      }
      await this.#startWorkInChannel(message, command.prompt, { attachments: this.#messageAttachments(message) });
      return;
    }
    if (!command.prompt) {
      await message.reply('💬 已切换到 Chat 模式。下一条普通消息将直接调用模型 API（不启动 Agent）。');
      return;
    }
    await this.runChat(message, command.prompt, { attachments: this.#messageAttachments(message) });
  }

  /** Local pre-flight for Work: refuse double-run and a blocked setup. */
  async #startWorkInChannel(message, prompt, options = {}) {
    const channelId = message.channelId;
    if (this.tasks.has(channelId) || this.runners.get(channelId)?.busy) {
      await message.reply('当前频道已有任务正在运行。如需中止，请先发送 `!stop`。');
      return;
    }
    if (this.scheduler?.stateFor(channelId).state === 'queued') {
      await message.reply('⏳ 该频道已有任务在队列中等待。使用 `!stop` 取消排队。');
      return;
    }
    const blocked = this.limits?.blocked(channelId);
    if (blocked?.blocked) {
      await message.reply(`⛔ 拒绝启动：${redact(blocked.reason)}`);
      return;
    }
    await this.runTask(message, prompt, options);
  }

  #isWorkThread(channelId) {
    return Boolean(this.state.getChannel(channelId, this.config.defaultCwd).workThread);
  }

  #supportsThreads(message) {
    const channel = message.channel;
    if (!message.guildId || !channel) return false;
    if (this.#isWorkThread(message.channelId)) return false;
    if (typeof channel.isThread === 'function' && channel.isThread()) return false;
    if (typeof message.startThread === 'function') return true;
    return Boolean(channel.threads && typeof channel.threads.create === 'function');
  }

  /**
   * Create one permanent Work thread for an inline task. On any Discord
   * permission/API failure the task is NOT executed anywhere: silently falling
   * back to running Work in the parent Chat channel would be a surprise.
   */
  async #startWorkThread(message, task, options = {}) {
    const parentId = message.channelId;
    let thread;
    try {
      const name = sanitizeThreadName(task);
      thread = typeof message.startThread === 'function'
        ? await message.startThread({ name, autoArchiveDuration: 1440 })
        : await message.channel.threads.create({ name, autoArchiveDuration: 1440 });
    } catch (error) {
      await message.reply(`❌ 无法创建 Work 线程：${redact(error?.message || error)}\n任务未启动；父频道仍为 Chat。`);
      return;
    }
    if (!thread?.id) {
      await message.reply('❌ 无法创建 Work 线程（Discord 未返回线程）。任务未启动；父频道仍为 Chat。');
      return;
    }

    const parent = this.sessionManager.get(parentId);
    this.state.patchChannel(thread.id, {
      mode: MODE.WORK,
      workThread: true,
      parentChannelId: parentId,
      cwd: parent.cwd,
      executorId: parent.executorId,
      providerId: parent.providerId,
      model: parent.model,
      sessionId: null,
    }, this.config.defaultCwd);
    // Permission inheritance is explicit: copy the parent's current level. The
    // parent may later change without affecting the thread's snapshot.
    this.permissionManager.switchLevel(thread.id, this.permissionManager.getLevel(parentId));

    console.log(`[work-thread] created thread=${thread.id} parent=${parentId} cwd=${parent.cwd}`);
    await message.reply(`🛠 已创建 Work 线程 <#${thread.id}>，任务已在线程中开始。父频道保持 Chat。`);

    const threadMessage = {
      channelId: thread.id,
      guildId: message.guildId,
      channel: thread,
      reply: (payload) => thread.send(payload),
    };
    await this.runTask(threadMessage, task, options);
  }

  /**
   * Direct Chat path. Calls ChatRuntime.send() and nothing else: no getRunner,
   * no ExecutorManager, no approval hook, no workspace scan, no Agent session.
   */
  async runChat(message, prompt, { attachments = null } = {}) {
    const channelId = message.channelId;
    const text = String(prompt ?? '').trim();
    const list = attachments ?? this.#messageAttachments(message);
    if (!text && !list.length) {
      await message.reply('请输入要发送给模型的内容。');
      return;
    }
    if (!this.chatRuntime) {
      await message.reply('❌ Chat 运行时未接入。未启动 Agent；请检查 ChatRuntime 配置。');
      return;
    }

    // Read/normalize attachments exactly once, before routing, so a provider
    // retry/fallback reuses the same turn and never re-downloads.
    let extracted = { texts: [], images: [], unsupported: [] };
    if (list.length) {
      try {
        extracted = await readChatAttachments({ attachments: list, fetchImpl: this.attachmentFetch });
      } catch (error) {
        console.warn(`[attachments] chat read failed: ${redact(error?.message || error)}`);
      }
    }
    const structured = extracted.texts.length || extracted.images.length || extracted.unsupported.length;
    const userContent = structured ? buildChatContent({ prompt: text, ...extracted }) : text;

    const selection = this.sessionManager.get(channelId);
    const providerId = selection.chatProviderId || 'auto';
    const model = selection.chatModel || null;
    const history = this.chatHistory ? this.chatHistory.get(channelId) : { messages: [], summary: null };
    const system = history.summary ? `${PANEL_COMPACT_HEADER}\n${history.summary}` : null;
    const startedAt = Date.now();
    let result;
    try {
      result = await this.chatRuntime.send({
        messages: [...history.messages, { role: 'user', content: userContent }],
        system,
        providerId,
        model,
      });
    } catch (error) {
      console.error(`[chat] failed channel=${channelId} provider=${providerId} model=${model ?? 'auto'} code=${error?.code ?? 'UNKNOWN'} ${redact(error?.message || error)}`);
      await message.reply(this.#chatFailureText(error, { providerId, model }));
      return;
    }

    // Append exactly one user + one assistant turn, and only after success. A
    // failed attempt/fallback inside ChatRuntime never reaches this point twice.
    if (this.chatHistory) {
      const userText = buildChatHistoryText({ prompt: text, ...extracted });
      if (userText.trim()) this.chatHistory.appendTurn(channelId, { user: userText, assistant: result.text });
    }

    const durationMs = Date.now() - startedAt;
    const fallback = typeof result.fallback === 'boolean'
      ? result.fallback
      : (Array.isArray(result.attempts) && result.attempts.length > 0);
    const served = result.upstreamModel && result.upstreamModel !== result.model
      ? `${result.model} → ${result.upstreamModel}`
      : result.model;
    this.chatActual.set(channelId, {
      providerId: result.providerId, providerName: result.providerName, model: result.model,
      served, fallback, durationMs, at: Date.now(),
    });
    const footer = [
      '💬 Chat',
      result.providerName || result.providerId || providerId,
      served,
      ...(fallback ? ['fallback'] : []),
      `${(durationMs / 1000).toFixed(1)}s`,
    ].join(' · ');
    console.log(`[chat] done channel=${channelId} provider=${result.providerId} model=${result.model} served=${served} fallback=${fallback} durationMs=${durationMs}`);
    await message.reply(clip(`${result.text}\n\n${footer}`));
  }

  #chatFailureText(error, { providerId, model }) {
    const pinned = (providerId && providerId !== 'auto') || Boolean(model);
    if (error?.code === 'NO_VISION_ROUTE') {
      return '❌ 当前没有可用的图片识别路由。请手动固定一个支持图片的模型（`!chatmodel <provider-id> <model-id>`），或改用 Work 处理该图片。';
    }
    if (error?.code === 'NO_CHAT_PROVIDER') {
      return pinned
        ? `❌ 指定的 Chat 模型不可用（provider=${providerId}${model ? ` model=${model}` : ''}）。手动选择不会自动切换。`
        : '❌ 当前没有可用的 Chat 模型（需要凭据有效且计费为免费/订阅的 Provider）。';
    }
    const detail = redact(error?.message || error);
    return pinned
      ? `❌ 指定的 Chat 模型调用失败：${detail}\n（手动选择不会自动切换到其他 Provider/模型）`
      : `❌ Chat 调用失败：${detail}`;
  }

  #chatRouteText(channelId) {
    const selection = this.sessionManager.get(channelId);
    const providerId = selection.chatProviderId || 'auto';
    if (providerId === 'auto') return 'AUTO';
    const provider = this.providerManager?.get(providerId);
    return `${provider?.displayName || providerId}${selection.chatModel ? ` · ${selection.chatModel}` : ''}`;
  }

  #chatActualText(channelId) {
    const actual = this.chatActual.get(channelId);
    if (!actual) return null;
    return `${actual.providerName || actual.providerId} · ${actual.served || actual.model}${actual.fallback ? ' · fallback' : ''}`;
  }

  #chatHealthText(channelId) {
    const selection = this.sessionManager.get(channelId);
    const providerId = selection.chatProviderId || 'auto';
    if (providerId === 'auto' || !this.chatRuntime?.health) return null;
    const snapshot = this.chatRuntime.health.snapshot(providerId, selection.chatModel || '*');
    return snapshot.status === 'unknown' ? 'healthy' : snapshot.status;
  }

  // ---- P2 control panel + daily UX -----------------------------------------

  #messageAttachments(message) {
    const raw = message?.attachments;
    if (!raw) return [];
    if (typeof raw.values === 'function') return [...raw.values()];
    return Array.isArray(raw) ? raw : [];
  }

  /** A message-like context backed by an interaction, so Work can be reused. */
  #interactionContext(interaction) {
    let replied = false;
    const send = (payload) => {
      if (!replied) {
        replied = true;
        return interaction.reply(payload);
      }
      if (typeof interaction.followUp === 'function') return interaction.followUp(payload);
      return interaction.channel?.send ? interaction.channel.send(payload) : Promise.resolve(null);
    };
    const channel = interaction.channel ?? null;
    return {
      channelId: interaction.channelId,
      guildId: interaction.guildId ?? null,
      channel,
      reply: send,
      get startThread() {
        if (!channel || typeof channel.threads?.create !== 'function') return undefined;
        return async ({ name, autoArchiveDuration }) => channel.threads.create({
          name, autoArchiveDuration, type: ChannelType.PublicThread,
        });
      },
    };
  }

  #controlPanel(channelId) {
    const state = this.sessionManager.get(channelId);
    const provider = this.providerManager?.get(state.providerId);
    const executor = this.executorManager?.get(state.executorId);
    const actual = this.#chatActualText(channelId);
    const route = this.#chatRouteText(channelId);
    const work = [executor?.displayName || state.executorId || '未选择', provider?.displayName || state.providerId || '未选择', state.model || '未选择'];
    return {
      content: clip([
        '🤖 **Jarvis Control Panel**',
        '',
        `Chat: ${route}${route === 'AUTO' && actual ? ` / ${actual}` : ''}`,
        `Work: ${work.join(' · ')}`,
        `Permission: ${PERM_SHORT[this.permissionManager.getLevel(channelId)]}`,
        `Workspace: \`${state.cwd}\``,
      ].join('\n')),
      components: panelMainRows(),
    };
  }

  #panelHelp() {
    return { content: clip(PANEL_HELP_TEXT), components: [panelBackRow()] };
  }

  async #panelStatus(channelId) {
    const gateway = this.gatewayHealth
      ? await this.gatewayHealth().catch(() => ({ ok: false, detail: 'error' }))
      : null;
    return { content: clip(this.#statusLine(channelId, gateway)), components: [panelBackRow()] };
  }

  #newWorkModal() {
    return new ModalBuilder()
      .setCustomId('workmodal:task')
      .setTitle('新建 Work')
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('task')
          .setLabel('任务内容')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1500),
      ));
  }

  async #handlePanelInteraction(interaction, id, channelId) {
    if (id === 'newwork') {
      await interaction.showModal(this.#newWorkModal());
      return;
    }
    if (id === 'models') {
      const state = this.sessionManager.get(channelId);
      const workProvider = this.providerManager?.get(state.providerId);
      await interaction.update({
        content: [
          '🧠 **换模型**',
          `💬 Chat：${this.#chatRouteText(channelId)}`,
          `🛠 Work：${workProvider?.displayName || state.providerId || '未选择'} · ${state.model || '未选择'}`,
        ].join('\n'),
        components: panelModelRows(),
      });
      return;
    }
    if (id === 'settings') { await interaction.update(this.#settingsPanel(channelId)); return; }
    if (id === 'permission') { await interaction.update(this.#permissionMenu(channelId)); return; }
    if (id === 'newchat') { await interaction.update({ content: clip(this.#newChat(channelId)), components: [panelBackRow()] }); return; }
    if (id === 'compact') { await interaction.update({ content: clip(await this.#compactChat(channelId)), components: [panelBackRow()] }); return; }
    if (id === 'status') { await interaction.update(await this.#panelStatus(channelId)); return; }
    if (id === 'stop') { await interaction.update({ content: clip(await this.#stopChannel(channelId)), components: [panelBackRow()] }); return; }
    if (id === 'help') { await interaction.update(this.#panelHelp()); return; }
    // refresh / back / unknown
    await interaction.update(this.#controlPanel(channelId));
  }

  async #handleModalSubmit(interaction, parts) {
    if (parts[0] !== 'workmodal') return;
    let task = '';
    try { task = String(interaction.fields?.getTextInputValue?.('task') ?? '').trim(); } catch { task = ''; }
    if (!task) {
      await interaction.reply({ content: '❌ 任务内容为空。', ephemeral: true });
      return;
    }
    await this.#launchWork(this.#interactionContext(interaction), task);
  }

  #chatProviderList() {
    return (this.providerManager?.list() ?? [])
      .filter((provider) => provider.protocol !== PROTOCOL.WORKBUDDY)
      .filter((provider) => this.providerManager.hasCredential(provider))
      .map((provider) => ({ id: provider.id, label: `${provider.displayName} · ${billingLabel(provider.billingType)}` }));
  }

  #chatModelMenu(channelId) {
    const selection = this.sessionManager.get(channelId);
    const current = selection.chatProviderId || 'auto';
    const providers = this.#chatProviderList();
    const rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panelchat:auto').setLabel(current === 'auto' ? '✓ AUTO' : 'AUTO')
        .setStyle(current === 'auto' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    )];
    const providerRows = choiceRows('panelchatp', providers, { current });
    if (providerRows) rows.push(...providerRows);
    rows.push(panelBackRow());
    if (rows.length > 5) {
      return {
        content: '💬 **Chat 模型**\n当前：AUTO 或 Provider → model\n⚠️ Provider 较多，请使用 `!chatmodel <provider-id> <model-id>`。',
        components: [rows[0], panelBackRow()],
      };
    }
    return {
      content: `💬 **Chat 模型**\n当前：${this.#chatRouteText(channelId)}\n选择 AUTO，或选择 Provider 后再选模型。手动固定后不会自动回退。`,
      components: rows,
    };
  }

  async #chatProviderModels(channelId, providerId) {
    const provider = this.providerManager?.get(providerId);
    if (!provider) return { content: '❌ 未知 Provider。', components: [panelBackRow()] };
    if (provider.protocol === PROTOCOL.WORKBUDDY) return { content: '❌ WorkBuddy 不是 Chat Provider。', components: [panelBackRow()] };
    if (!this.providerManager.hasCredential(provider)) return { content: '❌ 该 Provider 缺少 credential。', components: [panelBackRow()] };
    let models = [];
    try { models = (await this.modelManager.list(providerId)).models; }
    catch (error) { return { content: `${providerErrorMessage(error)}\n请使用 \`!chatmodel ${providerId} <model-id>\`。`, components: [panelBackRow()] }; }
    if (!models.length) {
      return { content: `⚠️ 未能自动获取 ${provider.displayName} 的模型列表。\n请使用 \`!chatmodel ${providerId} <model-id>\`。`, components: [panelBackRow()] };
    }
    const rows = providerModelRows('panelchatm', providerId, models.map((model) => ({ id: model.id, label: model.id })), {
      current: this.sessionManager.get(channelId).chatModel,
    });
    if (!rows) return { content: `⚠️ ${provider.displayName} 模型较多，请使用 \`!chatmodel ${providerId} <model-id>\`。`, components: [panelBackRow()] };
    return { content: `💬 ${provider.displayName} 模型（固定后不会自动回退）`, components: [...rows, panelBackRow()] };
  }

  #workProviderList(channelId) {
    const selection = this.sessionManager.get(channelId);
    return (this.providerManager?.list() ?? [])
      .filter((provider) => this.providerManager.hasCredential(provider))
      .filter((provider) => !this.executorManager || this.executorManager.compatible(selection.executorId, provider.protocol, null))
      .map((provider) => ({ id: provider.id, label: provider.displayName }));
  }

  #workModelMenu(channelId) {
    const selection = this.sessionManager.get(channelId);
    const executor = this.executorManager?.get(selection.executorId);
    const providers = this.#workProviderList(channelId);
    const rows = choiceRows('panelworkp', providers, { current: selection.providerId });
    if (!rows) {
      return {
        content: `🛠 **Work 模型**\n当前：${executor?.displayName || selection.executorId} · ${selection.providerId} · ${selection.model || '未选择'}\n⚠️ 请在 ⚙️ 设置 中切换到兼容当前 Provider 的执行器（例如 Claude Code）。`,
        components: [panelBackRow()],
      };
    }
    return {
      content: `🛠 **Work 模型**\n当前：${executor?.displayName || selection.executorId} · ${selection.providerId} · ${selection.model || '未选择'}\n选择 Provider：`,
      components: [...rows, panelBackRow()],
    };
  }

  async #workProviderModels(channelId, providerId) {
    const provider = this.providerManager?.get(providerId);
    if (!provider) return { content: '❌ 未知 Provider。', components: [panelBackRow()] };
    const selection = this.sessionManager.get(channelId);
    if (this.executorManager && !this.executorManager.compatible(selection.executorId, provider.protocol, null)) {
      return { content: '❌ 当前执行器不支持此 Provider 协议。', components: [panelBackRow()] };
    }
    let models = [];
    try { models = (await this.modelManager.list(providerId)).models; }
    catch (error) { return { content: `${providerErrorMessage(error)}\n请使用 \`!provider ${providerId}\` 后输入 \`!model <model-id>\`。`, components: [panelBackRow()] }; }
    if (!models.length) {
      return { content: `⚠️ 未能自动获取 ${provider.displayName} 的模型列表。\n请切换到该 Provider 后使用 \`!model <model-id>\` 验证。`, components: [panelBackRow()] };
    }
    const rows = providerModelRows('panelworkm', providerId, models.map((model) => ({ id: model.id, label: model.id })), {
      current: selection.providerId === providerId ? selection.model : null,
    });
    if (!rows) return { content: `⚠️ ${provider.displayName} 模型较多，请切换到该 Provider 后使用 \`!model <model-id>\`。`, components: [panelBackRow()] };
    return { content: `🛠 ${provider.displayName} 模型（选择后会创建新安全 Session）`, components: [...rows, panelBackRow()] };
  }

  #newChat(channelId) {
    if (this.#isWorkThread(channelId)) return '这是 Work 线程；新对话请在父频道 Chat 使用。';
    const cleared = this.chatHistory ? this.chatHistory.clear(channelId) : false;
    this.chatActual.delete(channelId);
    return cleared
      ? '🆕 已开始新对话：本频道 Chat 上下文已清空（模型与 Work 配置保持不变）。'
      : '🆕 已开始新对话：本频道没有可清除的 Chat 上下文。';
  }

  async #compactChat(channelId) {
    if (this.#isWorkThread(channelId)) return '这是 Work 线程；压缩上下文请在父频道 Chat 使用。';
    if (!this.chatHistory) return '❌ Chat 历史未启用，无法压缩。';
    if (!this.chatRuntime) return '❌ Chat 运行时未接入。';
    const stored = this.chatHistory.get(channelId);
    const stats = this.chatHistory.stats(channelId);
    if (stored.messages.length <= 6 && !stored.summary) {
      return `无需压缩（当前 ${stats.turns} 轮 / ${stats.chars} 字符）。`;
    }
    const selection = this.sessionManager.get(channelId);
    const keepTail = stored.messages.slice(-4);
    const older = stored.messages.slice(0, Math.max(0, stored.messages.length - keepTail.length));
    const transcript = older.map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.content}`).join('\n');
    const prompt = [
      stored.summary ? `已有摘要：\n${stored.summary}\n` : '',
      '请把下面的对话压缩为简洁的上下文摘要，保留：用户目标/意图、已作出的决定、重要约束、未解决的问题、提到的文件名或附件事实。不要保留寒暄、重复表述或原始工具日志。',
      '',
      '对话：',
      transcript,
    ].filter(Boolean).join('\n');
    let result;
    try {
      result = await this.chatRuntime.send({
        prompt, system: PANEL_COMPACT_SYSTEM,
        providerId: selection.chatProviderId || 'auto', model: selection.chatModel || null,
      });
    } catch (error) {
      console.error(`[chat] compact failed channel=${channelId} code=${error?.code ?? 'UNKNOWN'} ${redact(error?.message || error)}`);
      return `❌ 压缩失败，原上下文保持不变：${redact(error?.message || error)}`;
    }
    this.chatHistory.replace(channelId, { summary: result.text, messages: keepTail });
    const served = result.upstreamModel && result.upstreamModel !== result.model
      ? `${result.model} → ${result.upstreamModel}` : result.model;
    return [
      `🧹 已压缩上下文：${Math.ceil(older.length / 2)} 轮 -> 摘要 + ${Math.ceil(keepTail.length / 2)} 轮最近消息。`,
      `模型：${result.providerName || result.providerId} · ${served}`,
    ].join('\n');
  }

  /** One shared stop implementation so panel Stop and `!stop` cannot drift. */
  async #stopChannel(channelId) {
    const queued = this.scheduler?.cancelQueued(channelId);
    if (queued) {
      console.log(`[queue] cancel channel=${channelId} workspace=${queued.key} position=${queued.position}`);
      this.queuedNotices.delete(channelId);
      return `⛔ 已取消排队中的任务（原队列位置 ${queued.position}）。活动任务不受影响。`;
    }
    const runner = this.runners.get(channelId);
    const task = this.tasks.get(channelId);
    const sessionId = this.state.getChannel(channelId, this.config.defaultCwd).sessionId;
    const cancelled = sessionId ? this.approvalManager.cancelForSession(sessionId, 'stopped from Discord') : 0;
    if (task) {
      task.cancelled = true;
      task.progress.setState(STATE.CANCELLED, '已由 OWNER 停止');
      task.schedule();
    }
    const killed = (runner && await runner.stop({ reason: 'stopped by owner (!stop)' })) || { killed: false, pid: null };
    this.runners.delete(channelId);
    if (task) await task.finish();
    return [
      killed.pid
        ? `⛔ 已停止 Agent 进程树（pid ${killed.pid}）。`
        : '⛔ 当前没有 Agent 进程；任务占用已释放。',
      `已取消 ${cancelled} 个待审批请求。`,
      '可发送 `!status` 确认，或直接发送新任务。',
    ].join('\n');
  }

  /** Reuse the existing Work start paths for a modal/panel-initiated task. */
  async #launchWork(ctx, task) {
    if (this.#isWorkThread(ctx.channelId)) {
      await this.#startWorkInChannel(ctx, task);
      return;
    }
    if (this.#supportsThreads(ctx)) {
      await this.#startWorkThread(ctx, task);
      return;
    }
    await this.sessionManager.setMode(ctx.channelId, MODE.WORK);
    await this.#startWorkInChannel(ctx, task);
  }

  async #prepareWorkPrompt(message, prompt, attachments) {
    if (!this.attachmentInbox || !attachments?.length) return prompt;
    const { files, skipped } = await downloadWorkAttachments({
      attachments,
      inboxRoot: this.attachmentInbox,
      channelId: message.channelId,
      messageId: message.id,
      fetchImpl: this.attachmentFetch,
    });
    const notes = [];
    if (files.length) notes.push(buildWorkManifest(files));
    if (skipped.length) notes.push(`⚠️ 以下附件未下载：${skipped.map((item) => `${item.name}(${item.reason})`).join('、')}`);
    if (!notes.length) return prompt;
    return `${notes.join('\n\n')}\n\n---\n任务：\n${prompt}`;
  }

  async #chatModelCommand(channelId, argument) {
    if (!argument) {
      const selection = this.sessionManager.get(channelId);
      const actual = this.#chatActualText(channelId);
      return [
        '💬 **Chat 模型**',
        `路由：${this.#chatRouteText(channelId)}`,
        ...(actual ? [`最近实际：${actual}`] : []),
        '',
        '切换：`!chatmodel auto` 或 `!chatmodel <provider-id> <model-id>`',
        '手动指定后不会自动回退。',
      ].join('\n');
    }
    if (argument.toLowerCase() === 'auto') {
      this.sessionManager.setChatSelection(channelId, { providerId: 'auto', model: null });
      return '✅ Chat 路由已设为 **AUTO**（优先 LiteLLM `chat-fast`；网关不可用时回退 OpenCode Go 直连，再到其他健康免费/订阅模型）。';
    }
    const [providerId, modelId] = argument.split(/\s+/);
    const provider = this.providerManager?.get(providerId);
    if (!provider) return `❌ 未知 Provider：\`${providerId}\`。`;
    if (provider.protocol === PROTOCOL.WORKBUDDY) return '❌ WorkBuddy 不是 Chat Provider。';
    if (!this.providerManager.hasCredential(provider)) return `❌ Provider \`${providerId}\` 缺少 credential。`;
    if (!modelId) return `❌ 请同时指定 model：\`!chatmodel ${providerId} <model-id>\`。`;
    this.sessionManager.setChatSelection(channelId, { providerId, model: modelId });
    return `✅ Chat 模型已固定为 \`${providerId} / ${modelId}\`。\n该选择不会自动回退到其他模型。`;
  }

  /**
   * Queue the task behind a per-workspace FIFO lock. The workspace lock is
   * acquired before the Agent starts, so a second task on the same cwd never runs
   * concurrently and a queued task never creates a runner.
   */
  async runTask(message, prompt, { attachments = null } = {}) {
    const channelId = message.channelId;
    const chState = this.sessionManager.get(channelId);
    const workspace = chState.cwd || this.config.defaultCwd;

    if (this.scheduler.stateFor(channelId).state === 'queued') {
      await message.reply('⏳ 该频道已有任务在队列中等待。使用 `!stop` 取消排队。');
      return;
    }

    // Download attachments once, before the workspace lock is acquired, so a
    // provider retry/queue wait never triggers a second download.
    const list = attachments ?? this.#messageAttachments(message);
    let taskPrompt = String(prompt ?? '').trim() || '请查看并处理这些附件。';
    if (list.length) {
      try { taskPrompt = await this.#prepareWorkPrompt(message, taskPrompt, list); }
      catch (error) { console.warn(`[attachments] work download failed: ${redact(error?.message || error)}`); }
    }

    const entry = this.scheduler.submit({
      workspace,
      channelId,
      label: message.guildId ? `<#${channelId}>` : 'DM',
      run: () => this.#runTaskNow(message, taskPrompt),
      onQueued: ({ position, active }) => this.#notifyQueued(message, workspace, position, active),
      onStart: async ({ key }) => {
        console.log(`[queue] start channel=${channelId} workspace=${key}`);
        const notice = this.queuedNotices.get(channelId);
        if (!notice) return;
        this.queuedNotices.delete(channelId);
        await notice.edit('▶️ 已获得工作区锁，任务开始执行。').catch(() => {});
      },
    });
    return entry.done;
  }

  async #notifyQueued(message, workspace, position, active) {
    const activeLabel = active?.channelId ? `<#${active.channelId}>` : '其他任务';
    console.log(`[queue] queued channel=${message.channelId} workspace=${workspace} position=${position} active=${active?.channelId ?? 'none'}`);
    try {
      const sent = await message.reply([
        `⏳ Workspace busy: ${workspace}`,
        `Queue position: ${position}`,
        `Active task: ${activeLabel}`,
      ].join('\n'));
      this.queuedNotices.set(message.channelId, sent);
    } catch (error) {
      console.warn(`[queue] could not send the queue notice: ${redact(error?.message || error)}`);
    }
  }

  async #runTaskNow(message, prompt) {
    const channelId = message.channelId;
    const chState = this.sessionManager.get(channelId);
    let runner;
    try { runner = await this.getRunner(channelId); }
    catch (error) {
      const text = ['INVALID_CREDENTIAL', 'PROVIDER_NOT_FOUND', 'WORKBUDDY_QUOTA', 'WORKBUDDY_UNAVAILABLE', 'INCOMPATIBLE'].includes(error.code)
        ? providerErrorMessage(error)
        : `❌ 无法启动 Agent：${redact(error.message || error)}`;
      await message.reply(text);
      return;
    }

    const level = this.permissionManager.getLevel(channelId);
    const progress = new EventPresenter({
      cwd: chState.cwd,
      model: chState.model || this.backendState?.backend?.model || 'unknown',
    }).setPermissionLabel(PERM_SHORT[level]);
    const statusMessage = await message.reply(progress.render());
    const editor = new ThrottledEditor({
      intervalMs: this.config.progressThrottleMs,
      write: (content) => statusMessage.edit(clip(content)),
    });
    const runLog = this.logger?.open({ channelId, prompt }) ?? { path: null, log: () => {}, close: () => {} };

    const task = {
      progress,
      editor,
      statusMessage,
      runLog,
      cancelled: false,
      finished: false,
      watchdog: null,
      schedule: () => editor.submit(progress.render()),
      finish: async () => {
        // Idempotent: `!stop` and the run's own `finally` can both land here.
        if (task.finished) return;
        task.finished = true;
        if (task.watchdog) { clearInterval(task.watchdog); task.watchdog = null; }
        editor.dispose();
        runLog.close();
        this.tasks.delete(channelId);
      },
    };
    this.tasks.set(channelId, task);

    if (runner.sessionId) {
      this.channelBySession.set(runner.sessionId, channelId);
      this.permissionManager.syncSession(runner.sessionId, channelId);
    }
    progress.setModel(runner.model || progress.model);
    progress.setState(STATE.PLANNING);
    await editor.flushNow(progress.render());
    console.log(`[task] start channel=${channelId} cwd=${chState.cwd} prompt=${clip(redact(prompt), 140).replace(/\n/g, ' ⏎ ')}`);

    // Watchdog. It only repaints the existing status message: it never calls the
    // model and never touches the agent process, so a wedged PowerShell/Agent
    // call stays visible on the phone instead of the run looking frozen. This is
    // what makes "the task is stuck" distinguishable from "the bot is dead".
    const stallNoticeMs = this.config.stallNoticeMs ?? 30000;
    const watchEveryMs = Math.max(1000, Math.min(5000, Math.floor(stallNoticeMs / 6)));
    task.watchdog = setInterval(() => {
      if (task.finished) return;
      const idleMs = Number.isFinite(runner.idleMs) ? runner.idleMs : 0;
      if (idleMs < stallNoticeMs) return;
      progress.markStalled(idleMs);
      task.schedule();
    }, watchEveryMs);
    if (typeof task.watchdog.unref === 'function') task.watchdog.unref();

    try {
      const result = await withTimeout(runner.send(prompt), this.config.taskTimeoutMs, {
        label: 'task',
        onTimeout: () => { console.error(`[task] timeout after ${this.config.taskTimeoutMs}ms; killing the agent process`); runner.stop({ reason: 'task wall-clock timeout' }).catch(() => {}); },
      });

      // A result that arrives after `!stop` must not be presented as a success.
      if (task.cancelled) {
        throw Object.assign(new Error('stopped by owner'), { code: 'TASK_CANCELLED' });
      }

      // Fail closed: never present a paid-backend result as a successful run.
      // The verdict comes from the init event this run actually produced.
      const verdict = this.backendVerdictByChannel.get(channelId);
      if (verdict && !verdict.ok) throw new Error(`Backend rejected: ${verdict.reason}`);

      progress.recordText(result.text);
      progress.clearStall();
      progress.setState(result.isError ? STATE.FAILED : STATE.DONE);
      if (result.isError) this.limits?.noteFailure(channelId, result.text);
      else this.limits?.noteSuccess(channelId);
      if (result.sessionId) {
        this.state.patchChannel(channelId, { sessionId: result.sessionId }, this.config.defaultCwd);
        this.channelBySession.set(result.sessionId, channelId);
      }
      console.log(`[task] done channel=${channelId} state=${progress.state} tools=${result.tools.length} durationMs=${result.durationMs} tests=${progress.tests || '-'}`);
      const extras = [
        runLog.path ? `日志：\`${path.basename(runLog.path)}\`` : null,
      ].filter(Boolean).join(' · ');
      progress.costUsd = result.costUsd ?? 0;
      // progress.render() already carries the state, project, last action, test
      // result and tool histogram — reuse it instead of rebuilding the summary.
      const body = [
        progress.render(),
        extras || null,
        '',
        clip(redact(result.text || '（无最终文本）'), 1200),
      ].filter((line) => line !== null).join('\n');
      await editor.flushNow(body);
    } catch (error) {
      const detail = redact(error?.message || error);
      // A run that ends because the owner stopped it, the wall-clock cap fired,
      // or the agent died mid-flight must land on a terminal state. Leaving it
      // on RUNNING was the original bug: the channel stayed "busy" forever.
      const cancelled = task.cancelled || error?.code === 'TASK_CANCELLED';
      if (cancelled) {
        progress.clearStall();
        progress.setState(STATE.CANCELLED, '已由 OWNER 停止');
        console.log(`[task] cancelled channel=${channelId} reason=${detail}`);
      } else if (error?.code === 'TASK_TIMEOUT') {
        progress.clearStall();
        progress.setState(STATE.TIMEOUT, '任务达到时间上限');
        const failures = this.limits?.noteFailure(channelId, error);
        console.log(`[task] timeout channel=${channelId} consecutiveFailures=${failures ?? '-'} error=${detail}`);
      } else {
        progress.clearStall();
        progress.setState(STATE.FAILED, 'Agent 执行失败');
        const failures = this.limits?.noteFailure(channelId, error);
        console.log(`[task] failed channel=${channelId} consecutiveFailures=${failures ?? '-'} error=${detail}`);
      }
      await editor.flushNow(`${progress.render()}\n\n\`\`\`\n${clip(detail, 900)}\n\`\`\``);
    } finally {
      await task.finish();
    }
  }

  async presentApproval(req) {
    const channelId = this.channelBySession.get(req.sessionId) || req.channelId || null;
    const task = channelId ? this.tasks.get(channelId) : null;
    console.log(`[approval] requested tool=${req.toolName} rule=${req.ruleKey} channel=${channelId || 'dm'} reason=${clip(redact(req.reason), 80)}`);

    if (task) {
      task.progress.setApproval(req);
      await task.editor.flushNow(task.progress.render());
    }

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ap:${req.id}:allow-once`).setLabel(APPROVAL_BUTTONS.ALLOW_ONCE).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`ap:${req.id}:allow-session`).setLabel(APPROVAL_BUTTONS.ALLOW_SESSION).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`ap:${req.id}:deny`).setLabel(APPROVAL_BUTTONS.DENY).setStyle(ButtonStyle.Danger),
    );

    const body = [
      '🔐 **Agent 请求授权**',
      `工具：**${req.toolName}**`,
      `项目：\`${redact(req.cwd)}\``,
      `原因：${redact(req.reason)}`,
      '',
      '```json',
      clip(redact(JSON.stringify(req.toolInput ?? {}, null, 2)), 700),
      '```',
    ].join('\n');

    const target = channelId ? await this.client.channels.fetch(channelId).catch(() => null) : null;
    const message = target?.isTextBased?.()
      ? await target.send({ content: body, components: [buttons] })
      : await (await this.client.users.fetch(this.config.ownerId)).send({ content: body, components: [buttons] });
    return message;
  }

  onApprovalSettled(answer, meta) {
    console.log(`[approval] resolved decision=${answer.decision} rule=${meta.ruleKey} reason=${redact(answer.reason)}`);
    const channelId = this.channelBySession.get(meta.sessionId) || null;
    const task = channelId ? this.tasks.get(channelId) : null;
    if (!task) return;
    task.progress.clearApproval(answer.decision === 'allow' ? 'allowed' : 'denied');
    task.editor.submit(task.progress.render());
  }

  async onInteraction(interaction) {
    const isButton = typeof interaction.isButton === 'function' && interaction.isButton();
    const isModal = typeof interaction.isModalSubmit === 'function' && interaction.isModalSubmit();
    if (!isButton && !isModal) return;
    // Every panel/render/selection interaction is OWNER-only. Rendering and
    // selection buttons never call ChatRuntime or start an Agent.
    if (interaction.user.id !== this.config.ownerId) {
      await interaction.reply({ content: '无权执行此操作。', ephemeral: true });
      return;
    }
    const parts = String(interaction.customId).split(':');
    const prefix = parts[0];
    if (isModal) {
      await this.#handleModalSubmit(interaction, parts);
      return;
    }
    const id = parts[1];
    const action = parts[2];
    const channelId = interaction.channelId || interaction.message?.channelId;
    if (prefix === 'panel') {
      await this.#handlePanelInteraction(interaction, id, channelId);
      return;
    }
    if (prefix === 'panelmodels') {
      await interaction.update(id === 'chat' ? this.#chatModelMenu(channelId) : this.#workModelMenu(channelId));
      return;
    }
    if (prefix === 'panelchat') {
      if (id === 'auto') {
        this.sessionManager.setChatSelection(channelId, { providerId: 'auto', model: null });
        await interaction.update(this.#chatModelMenu(channelId));
        return;
      }
      await interaction.update(this.#chatModelMenu(channelId));
      return;
    }
    if (prefix === 'panelchatp') {
      await interaction.update(await this.#chatProviderModels(channelId, parts.slice(1).join(':')));
      return;
    }
    if (prefix === 'panelchatm') {
      const providerId = parts[1];
      const modelId = parts.slice(2).join(':');
      this.sessionManager.setChatSelection(channelId, { providerId, model: modelId });
      await interaction.update({
        content: `✅ Chat 模型已固定为 \`${providerId} / ${modelId}\`（不会自动回退）。`,
        components: [panelBackRow()],
      });
      return;
    }
    if (prefix === 'panelworkp') {
      const providerId = parts.slice(1).join(':');
      const switched = await this.#switchProvider(channelId, providerId);
      const models = await this.#workProviderModels(channelId, providerId);
      await interaction.update({ ...models, content: clip(`${switched}\n\n${models.content}`) });
      return;
    }
    if (prefix === 'panelworkm') {
      const providerId = parts[1];
      const modelId = parts.slice(2).join(':');
      const state = this.sessionManager.get(channelId);
      if (state.providerId !== providerId) {
        await interaction.update({ content: '❌ Provider 已变化，请重新选择。', components: [panelBackRow()] });
        return;
      }
      const result = await this.#selectModel(channelId, modelId);
      await interaction.update({ content: clip(result), components: [panelBackRow()] });
      return;
    }
    if (prefix === 'set') {
      if (id === 'chatauto') {
        this.sessionManager.setChatSelection(channelId, { providerId: 'auto', model: null });
        await interaction.update(this.#settingsPanel(channelId));
        return;
      }
      if (id === 'permission') {
        await interaction.update(this.#permissionMenu(channelId));
        return;
      }
      if (id === 'executor') {
        const current = this.sessionManager.get(channelId).executorId;
        const items = (this.executorManager?.list() ?? []).map((executor) => ({
          id: executor.id,
          label: `${executor.displayName}${executor.status && executor.status !== 'PASS' ? ` (${executor.status})` : ''}`,
          disabled: !executor.available,
        }));
        const rows = choiceRows('setexec', items, { current });
        await interaction.update(rows
          ? { content: '🛠️ 选择执行器', components: [...rows, settingsBackRow()] }
          : { content: this.#executorText(channelId), components: [settingsBackRow()] });
        return;
      }
      if (id === 'provider') {
        const state = this.sessionManager.get(channelId);
        const items = (this.providerManager?.list() ?? [])
          .filter((provider) => this.providerManager.hasCredential(provider)
            && (!this.executorManager || this.executorManager.compatible(state.executorId, provider.protocol)))
          .map((provider) => ({ id: provider.id, label: provider.displayName }));
        const rows = choiceRows('setprov', items, { current: state.providerId });
        await interaction.update(rows
          ? { content: '🌐 选择 Provider', components: [...rows, settingsBackRow()] }
          : { content: this.#providersText(channelId), components: [settingsBackRow()] });
        return;
      }
      if (id === 'model') {
        const state = this.sessionManager.get(channelId);
        const provider = this.providerManager?.get(state.providerId);
        const models = provider?.models ?? [];
        if (models.length && models.length <= SETTINGS_MODEL_LIMIT) {
          const rows = choiceRows('setmodel', models.map((model) => ({ id: model.id, label: model.id })), { current: state.model });
          await interaction.update({ content: `🧠 选择模型（${provider.displayName}）`, components: [...rows, settingsBackRow()] });
        } else {
          await interaction.update({
            content: `🧠 模型数量较多或未缓存（${models.length}）。请使用 \`!models\` / \`!model <model-id>\`。`,
            components: [settingsBackRow()],
          });
        }
        return;
      }
      // refresh / back / unknown
      await interaction.update(this.#settingsPanel(channelId));
      return;
    }
    if (prefix === 'setexec' || prefix === 'setprov' || prefix === 'setmodel') {
      const result = prefix === 'setexec'
        ? await this.#switchExecutor(channelId, id)
        : prefix === 'setprov'
          ? await this.#switchProvider(channelId, id)
          : await this.#selectModel(channelId, id);
      await interaction.update({
        content: clip(`${result}\n\n${this.#settingsPanel(channelId).content}`),
        components: settingsButtons({ workThread: this.#isWorkThread(channelId) }),
      });
      return;
    }
    if (prefix === 'cfg') {
      if (id === 'executor') await interaction.update({ content: this.#executorText(channelId), components: [] });
      else if (id === 'provider') await interaction.update({ content: this.#providersText(channelId), components: [] });
      else if (id === 'model') await interaction.update(await this.#modelsPayload(channelId));
      else if (id === 'permission') await interaction.update(this.#permissionMenu(channelId));
      return;
    }
    if (prefix === 'models') {
      await interaction.update(await this.#modelsPayload(channelId, id));
      return;
    }
    if (prefix === 'apiproto') {
      const pending = this.apiOnboarding.get(channelId);
      if (!pending?.credentialRef) {
        await interaction.reply({ content: 'API 添加请求已过期。', ephemeral: true });
        return;
      }
      try {
        const added = await this.providerManager.completePending(pending, id);
        this.apiOnboarding.delete(channelId);
        await interaction.update(this.#providerAdded(channelId, added, pending.deleted));
      } catch (error) {
        this.apiOnboarding.delete(channelId);
        await interaction.update({
          content: `${providerErrorMessage(error)}${pending.deleted ? '' : '\n⚠️ Discord 未允许删除原消息，请立即手动删除。'}`,
          components: [],
        });
      }
      return;
    }
    if (prefix === 'apiuse') {
      await interaction.update({ content: await this.#switchProvider(channelId, id), components: [] });
      return;
    }
    if (prefix === 'apimodel') {
      await interaction.update(await this.#modelsPayload(channelId, 1, id));
      return;
    }
    if (prefix === 'perm') {
      if (id === 'menu') {
        await interaction.update(this.#permissionMenu(interaction.message.channelId));
        return;
      }
      if (!Object.values(LEVEL).includes(id)) return;
      const result = await this.#switchPermission(interaction.message.channelId, id);
      if (result.confirmation) {
        await interaction.update({
          content: '⚠️ **全开放模式**\n\n普通工具调用将自动允许。OWNER 校验、凭据保护、超时、停止和后端校验仍然有效。',
          components: [fullConfirmationButtons()],
        });
        return;
      }
      await interaction.update({ content: `🔐 当前权限：${PERM_SHORT[result.current]}`, components: [permissionButtons()] });
      return;
    }
    if (prefix === 'permfull') {
      if (id === 'cancel') {
        await interaction.update({ content: `已取消。\n🔐 当前权限：${PERM_SHORT[this.permissionManager.getLevel(interaction.message.channelId)]}`, components: [permissionButtons()] });
        return;
      }
      if (id === 'confirm') {
        const result = await this.#switchPermission(interaction.message.channelId, LEVEL.FULL, { confirmed: true });
        await interaction.update({ content: `🔐 当前权限：${PERM_SHORT[result.current]}`, components: [permissionButtons()] });
      }
      return;
    }
    if (prefix !== 'ap') return;
    const ok = this.approvalManager.resolve(id, action);
    if (!ok) {
      await interaction.reply({ content: '审批请求已过期或已处理。', ephemeral: true });
      return;
    }
    const label = { 'allow-once': APPROVAL_BUTTONS.ALLOW_ONCE, 'allow-session': APPROVAL_BUTTONS.ALLOW_SESSION, deny: APPROVAL_BUTTONS.DENY }[action] || action;
    await interaction.update({
      content: clip(`${interaction.message.content}\n\n**处理结果：${label}** — <@${interaction.user.id}>`),
      components: [],
    });
  }
}
