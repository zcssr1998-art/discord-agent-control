// First import on purpose: it wraps the `ws` WebSocket constructor before
// discord.js is evaluated, which is required for the Gateway to use a proxy.
import './discord-proxy.mjs';

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  Partials,
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
    this.extraEnv = extraEnv;
    this.envUnset = envUnset;
    this.autoLogin = autoLogin;
    this.runners = new Map();
    this.tasks = new Map();
    this.channelBySession = new Map();
    this.backendVerdictByChannel = new Map();
    this.apiOnboarding = new Map();
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

  #statusLine(channelId) {
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
    const text = message.content.trim();
    if (!text) return;

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
      await message.reply({ content: clip(this.#statusLine(message.channelId)), components: [permissionMenuButton()] });
      return;
    }
    if (text === '!config') {
      await message.reply(this.#configCard(message.channelId));
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
      // Order matters. Mark the task cancelled and release the agent *before*
      // replying, so the channel is immediately usable again: a stuck task must
      // never leave `busy` set, and `!stop` must kill the whole child tree, not
      // just the direct child.
      const runner = this.runners.get(message.channelId);
      const task = this.tasks.get(message.channelId);
      const sessionId = this.state.getChannel(message.channelId, this.config.defaultCwd).sessionId;
      const cancelled = sessionId ? this.approvalManager.cancelForSession(sessionId, 'stopped from Discord') : 0;
      if (task) {
        task.cancelled = true;
        task.progress.setState(STATE.CANCELLED, '已由 OWNER 停止');
        task.schedule();
      }
      const killed = (runner && await runner.stop({ reason: 'stopped by owner (!stop)' })) || { killed: false, pid: null };
      this.runners.delete(message.channelId);
      if (task) await task.finish();
      await message.reply([
        killed.pid
          ? `⛔ 已停止 Agent 进程树（pid ${killed.pid}）。`
          : '⛔ 当前没有 Agent 进程；任务占用已释放。',
        `已取消 ${cancelled} 个待审批请求。`,
        '可发送 `!status` 确认，或直接发送新任务。',
      ].join('\n'));
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

    if (this.tasks.has(message.channelId) || this.runners.get(message.channelId)?.busy) {
      await message.reply('当前频道已有任务正在运行。如需中止，请先发送 `!stop`。');
      return;
    }

    // Refuse to keep hammering a broken setup; that is how a background loop
    // burns tokens unattended.
    const blocked = this.limits?.blocked(message.channelId);
    if (blocked?.blocked) {
      await message.reply(`⛔ 拒绝启动：${redact(blocked.reason)}`);
      return;
    }

    await this.runTask(message, text);
  }

  async runTask(message, prompt) {
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
    if (!interaction.isButton()) return;
    if (interaction.user.id !== this.config.ownerId) {
      await interaction.reply({ content: '无权执行此操作。', ephemeral: true });
      return;
    }
    const [prefix, id, action] = interaction.customId.split(':');
    const channelId = interaction.message.channelId;
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
