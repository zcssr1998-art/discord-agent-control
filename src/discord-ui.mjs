// First import on purpose: it wraps the `ws` WebSocket constructor before
// discord.js is evaluated, which is required for the Gateway to use a proxy.
import './discord-proxy.mjs';

import {
  ActionRowBuilder,
  AttachmentBuilder,
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
import { randomUUID } from 'node:crypto';
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
import { isPlaceholderId } from './model-selection.mjs';
import { MODE, parseModeCommand, stripSelfMention } from './mode-router.mjs';
import { WorkspaceScheduler } from './workspace-scheduler.mjs';
import {
  downloadWorkAttachments, buildWorkManifest, readChatAttachments, buildChatContent, buildChatHistoryText,
} from './attachments.mjs';
import { registerApplicationCommands, verifyApplicationCommands, COMMAND_NAMES, MODAL_TASK_MAX_LENGTH } from './commands.mjs';
import { shortSha as shortUpdateSha } from './updater.mjs';
import { autostartSummary } from './autostart.mjs';
import {
  clip, planResultDelivery,
  permissionButtons, permissionMenuButton, fullConfirmationButtons, configButtons,
  providerResultButtons, protocolButtons, settingsButtons, settingsBackRow, resetConfirmButtons, panelMainRows,
  panelBackRow, panelHelpRows, panelModelRows, workControlRows, providerModelRows, choiceRows, pagedChoiceRows,
  modelPageButtons, protocolLabel, transportLabel, billingLabel, sanitizeThreadName, workTitle,
  SETTINGS_MODEL_LIMIT, DISCORD_LIMIT,
} from './discord/renderers.mjs';

/**
 * P2.2A/P2.2F: live uptime + WebSocket-state rendering for /status and /doctor.
 * Pure functions, model-free.
 */
export function formatUptime(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const days = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!days && !h && !m) parts.push(`${s}s`);
  return parts.join('');
}

export function wsStatusText(status) {
  const map = {
    0: 'connecting', 1: 'connected', 2: 'disconnected', 3: 'reconnecting',
    4: 'identifying', 5: 'resuming', 6: 'close requested', 7: 'destroyed', '-1': 'ready',
  };
  return map[status] ?? `ws status ${status}`;
}

/**
 * User-facing result of an insert/steering attempt. Never claims a live insert
 * that did not happen: an unsupported executor is reported as such.
 */
export function insertMessage(mode) {
  if (mode === 'inserted') return '✅ 已插入当前任务，Agent 将在下一个安全执行边界读取。';
  if (mode === 'continued') return '✅ 当前轮刚结束，已转为同 Session 继续执行。';
  if (mode === 'unsupported') return '⚠️ 当前执行器不支持运行中插入，将在当前轮后继续。';
  return '该任务已结束。';
}

/**
 * P2.2.4 exact insert/continuation state machine.
 *
 * A requirement always carries one of these states, so Stop/cleanup can report
 * the truth instead of counting an already-executed demand as unprocessed:
 *   RECEIVED            — accepted, not yet handed to a turn
 *   DELIVERED_LIVE      — written into the RUNNING turn's stdin/session
 *   QUEUED_CONTINUATION — queued to run as the next turn in the SAME run
 *   CONSUMED            — the turn it was delivered into completed successfully
 *   CANCELLED           — genuinely dropped by Stop/end before it ever ran
 */
export const INSERT_STATE = Object.freeze({
  RECEIVED: 'RECEIVED',
  DELIVERED_LIVE: 'DELIVERED_LIVE',
  QUEUED_CONTINUATION: 'QUEUED_CONTINUATION',
  CONSUMED: 'CONSUMED',
  CANCELLED: 'CANCELLED',
});

const TERMINAL_PROGRESS_STATES = new Set([STATE.DONE, STATE.FAILED, STATE.CANCELLED, STATE.TIMEOUT]);

/**
 * P2.2 ACK fix: classify a failed interaction acknowledgement with the real
 * Discord cause instead of a generic swallow. Codes:
 *   10062 Unknown interaction · 40060 already acknowledged · 50027 invalid webhook.
 */
export function classifyInteractionError(error) {
  const name = String(error?.name || 'Error');
  const code = error?.code ?? error?.status ?? null;
  const byCode = {
    10062: 'UnknownInteraction',
    10015: 'UnknownWebhook',
    40060: 'InteractionAlreadyAcknowledged',
    50027: 'InvalidWebhookToken',
  };
  let type;
  if (name === 'DiscordAPIError') type = byCode[code] || `DiscordAPIError(${code ?? '?'})`;
  else if (name === 'InteractionAlreadyReplied') type = 'InteractionAlreadyReplied';
  else if (name === 'InteractionNotReplied') type = 'InteractionNotReplied';
  else type = name;
  return { type, code, name, message: String(error?.message || error) };
}

export const PANEL_HELP_TEXT = [
  '📖 **Jarvis 使用说明**',
  '',
  '💬 **Chat** = 普通问答，不启动 Agent。',
  '🛠 **Work** = Agent，可读写文件、执行 Shell、测试。',
  '',
  '**创建 Work**',
  '服务器父频道：`work` + 任务内容',
  '→ 自动创建 🛠 Work 线程，父频道继续 Chat。',
  '私聊：`work` + 任务内容',
  '→ 私聊内直接运行 Work。',
  '',
  '`work` → 当前频道切到 Work，下一条普通消息作为任务',
  '`chat` → 切回 Chat（永久 Work 线程里禁止切 Chat）',
  '`!cwd` + 绝对路径 → 绑定当前频道项目目录',
  '`!workspace` → 查看/切换工作目录（`!workspace reset` 恢复默认）',
  '',
  '**快速开始**',
  '1. 点 ⚙️ 设置：配置 Work 执行器 / Provider / 模型',
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
    runtimeIdentity = null,
    durableStore = null,
    updater = null,
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
    // P2.2A live build/runtime identity (guard lock + branch/commit) and the
    // P2.2D durable store. Both optional so existing test harnesses work.
    this.runtimeIdentity = runtimeIdentity;
    this.durableStore = durableStore;
    // P2.2.6 safe self-update. All updater access is read-only from the UI; the
    // updater itself owns the checkout/Supervisor restart lifecycle.
    this.updater = updater;
    this.commandSchema = null;
    // Where downloaded Discord attachments land. Null disables attachments so a
    // bare test harness cannot accidentally write to the real data directory.
    this.attachmentInbox = attachmentInbox;
    this.attachmentFetch = attachmentFetch;
    // Workspace serialization lives in the Work orchestration layer, not in
    // LiteLLM/provider routing and not in the per-channel busy flag: two threads
    // can target the same cwd.
    this.scheduler = workspaceScheduler || new WorkspaceScheduler();
    this.queuedNotices = new Map();
    // P2.1: interactive Work chains. A run tracks one active/queued turn; a
    // chain tracks the per-channel follow-up queue that drains after each turn.
    this.workRuns = new Map();
    this.workChains = new Map();
    // 0 (default) means unlimited for this single-owner bridge. A positive value
    // is a finite, owner-visible resource policy.
    this.maxWorkFollowUps = Number(config.maxWorkFollowUps) > 0 ? Number(config.maxWorkFollowUps) : 0;
    this.followUpSeq = 0;
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
      // Chat manual pins are validated against the provider's real model list
      // when one is available; placeholder syntax is always rejected.
      chatModelResolver: async (providerId) => {
        if (!this.modelManager) return null;
        const result = await this.modelManager.list(providerId);
        return Array.isArray(result) ? result : result?.models ?? null;
      },
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
    if (this.autoLogin && this.config.autoRegisterCommands !== false) await this.registerCommands();
    if (this.config.notifyOnStart !== false) await this.notifyReady();
  }

  /**
   * Register the native application commands. Idempotent and best-effort: a
   * Discord REST hiccup must never stop the bridge from coming online.
   */
  async registerCommands() {
    try {
      const result = await registerApplicationCommands({
        client: this.client,
        guildId: this.config.commandsGuildId || null,
        logger: console,
      });
      console.log(`[commands] registered=${COMMAND_NAMES.length} changed=${result.changed ?? 0}${result.skipped ? ' (skipped)' : ''}`);
      return result;
    } catch (error) {
      console.warn(`[commands] registration failed: ${redact(error?.message || error)}`);
      return { skipped: true, changed: 0, total: COMMAND_NAMES.length, error };
    }
  }

  /**
   * P2.2.6 K7: sync the desired commands, then FETCH THEM BACK from Discord and
   * compare the real remote schema. `/doctor` reports this PASS/FAIL. A REST
   * failure is recorded as out-of-sync and never blocks or rolls back the bridge.
   */
  async reconcileCommandSchema() {
    await this.registerCommands().catch(() => null);
    try {
      const result = await verifyApplicationCommands({
        application: this.client?.application ?? null,
        guildId: this.config.commandsGuildId || null,
        logger: console,
      });
      this.commandSchema = result;
      console.log(`[commands] fetch-back schema ${result.ok ? 'PASS' : 'FAIL'} · /work task max_length=${result.workTaskMaxLength ?? 'unknown'}${result.error ? ` error=${redact(result.error)}` : ''}`);
      return result;
    } catch (error) {
      this.commandSchema = { ok: false, mismatches: [], workTaskMaxLength: null, checkedAt: new Date().toISOString(), error: redact(error?.message || error) };
      console.warn(`[commands] fetch-back schema FAIL: ${redact(error?.message || error)}`);
      return this.commandSchema;
    }
  }

  /**
   * P2.2.6 K3: the deterministic safe-to-restart boundary. An update must never
   * interrupt active/queued Work, a busy Agent runner, a live Work chain, an
   * in-flight task or a pending approval. Duration alone is never a reason to
   * stop a healthy Work.
   */
  runtimeActivity() {
    const reasons = [];
    for (const slot of this.scheduler?.snapshot?.() ?? []) {
      if (slot.active) reasons.push(`active Work ${slot.active.channelId || slot.workspace}`);
      if (slot.queueLength) reasons.push(`queued Work x${slot.queueLength}`);
    }
    for (const [channelId, runner] of this.runners) {
      if (runner?.busy) reasons.push(`busy Agent ${channelId}`);
    }
    for (const [channelId, chain] of this.workChains) {
      if (chain?.activeRunId) reasons.push(`active Work chain ${channelId}`);
    }
    if (this.tasks.size) reasons.push(`active task x${this.tasks.size}`);
    const approvals = this.approvalManager?.pending?.size ?? 0;
    if (approvals) reasons.push(`pending approval x${approvals}`);
    return { safe: reasons.length === 0, reasons: [...new Set(reasons)] };
  }

  /** Compact updater line for /status and the startup identity block. */
  #updateLine() {
    const view = this.updater?.statusSnapshot?.();
    if (!view) return null;
    const parts = [`Update: ${view.status}`, `${shortUpdateSha(view.localSha)}→${shortUpdateSha(view.remoteSha)}`];
    if (view.pendingSha) parts.push(`pending ${shortUpdateSha(view.pendingSha)}`);
    if (view.paused) parts.push('paused');
    return parts.join(' · ');
  }

  /** Detailed updater + command-schema lines for /doctor. */
  #updateDoctorLines() {
    const lines = [];
    const view = this.updater?.statusSnapshot?.();
    if (view) {
      lines.push(`⬆️ Update: ${view.status} · source ${view.remote}/${view.branch}`);
      lines.push(`   local ${shortUpdateSha(view.localSha)} · remote ${shortUpdateSha(view.remoteSha)}${view.relation && view.relation !== 'unknown' ? ` (${view.relation})` : ''}`);
      if (view.pendingSha) lines.push(`   pending ${shortUpdateSha(view.pendingSha)}`);
      if (view.previousGoodSha) lines.push(`   known-good ${shortUpdateSha(view.previousGoodSha)}`);
      if (view.lastAppliedSha) lines.push(`   last applied ${shortUpdateSha(view.lastAppliedSha)}${view.lastAppliedAt ? ` @ ${view.lastAppliedAt}` : ''}`);
      if (view.quarantinedSha) lines.push(`   quarantined ${shortUpdateSha(view.quarantinedSha)}`);
      if (view.lastFailure?.reason) lines.push(`   last failure: ${redact(view.lastFailure.reason)}`);
      if (view.blockedReason) lines.push(`   blocked: ${redact(view.blockedReason)}`);
    }
    const schema = this.commandSchema ?? view?.schema ?? null;
    if (schema) {
      lines.push(`🧩 Command schema (fetch-back): ${schema.ok ? 'PASS' : 'FAIL'}`
        + `${schema.workTaskMaxLength != null ? ` · /work task max_length=${schema.workTaskMaxLength}` : ''}`
        + `${schema.error ? ` (${redact(schema.error)})` : ''}`);
    }
    return lines;
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
    // The card renders the SAME resolved runtime state that a task launch uses:
    // restored model, active provider/executor route, restored workspace. No
    // WorkBuddy/fast-model/config-default fallbacks.
    const state = this.effectiveRuntimeState({});
    const permLabel = PERM_SHORT[state.permissionLevel] || state.permissionLevel || null;
    const text = readyText({
      ok: state.ok,
      executor: state.executor?.displayName ?? state.executor?.id ?? null,
      provider: state.provider ? (state.provider.displayName ?? state.provider.id) : null,
      backend: state.backend ?? null,
      protocol: state.protocol,
      adapter: state.adapter,
      model: state.model,
      billingType: state.billingType ? billingLabel(state.billingType) : (state.billingRoute ?? null),
      paidFallback: state.paidFallback,
      workspace: state.workspace,
      permissionLabel: permLabel,
      note: state.problem,
    });
    console.log(`[bridge] ready card: ok=${state.ok} executor=${state.executor?.id ?? '-'} provider=${state.provider?.id ?? '-'} model=${state.model ?? '-'} workspace=${state.workspace} source=${state.modelSource}/${state.workspaceSource}`);
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
      const resolved = this.#resolveWorkModel(channelId, chState, provider);
      if (!resolved.model) {
        throw Object.assign(new Error('未选择 Work 模型：请使用 /model → Work 模型，或 !models 浏览后选择'), { code: 'MODEL_REQUIRED' });
      }
      runner = await this.executorManager.createRunner({
        executorId: chState.executorId, provider, credential, model: resolved.model, ...common,
      });
      if (resolved.source !== 'channel') {
        console.log(`[model] restored channel=${channelId} provider=${provider.id} model=${resolved.model} source=${resolved.source}`);
      }
    } else {
      runner = new ClaudeRunner({
        command: this.config.claudeCommand, extraEnv: this.extraEnv, envUnset: this.envUnset, ...common,
      });
    }
    this.runners.set(channelId, runner);
    return runner;
  }

  /**
   * `!workspace` — show the effective Agent working directory, its source and
   * whether it is persisted; `!workspace <abs dir>` — explicitly select and
   * persist it; `!workspace reset` — drop the selection and fall back to the
   * configured default / repo root. A run's temporary directory never changes it.
   */
  async #workspaceCommand(channelId, argument) {
    const saved = this.state.getGlobalWorkspace();
    const label = (source) => ({ channel: 'channel', saved: 'saved', config: 'config', 'repo-fallback': 'repo-fallback', explicit: 'explicit', none: 'none' }[source] ?? source);

    if (!argument) {
      const state = this.effectiveRuntimeState({ channelId });
      const globalState = this.effectiveRuntimeState({});
      const lines = [
        `📁 当前工作目录：\`${state.workspace ?? '未配置'}\``,
        `来源：${label(state.workspaceSource)}`,
        `持久化：${saved ? 'yes' : 'no'}`,
      ];
      if (globalState.workspace && globalState.workspace !== state.workspace) {
        lines.push(`全局默认：\`${globalState.workspace}\`（来源：${label(globalState.workspaceSource)}）`);
      }
      lines.push('', '切换：`!workspace` + 绝对路径 · 恢复默认：`!workspace reset`');
      return lines.join('\n');
    }

    if (/^reset$/i.test(argument)) {
      if (this.#busy(channelId)) return '⚠️ 当前任务正在执行。请等待任务完成或使用 `!stop`。';
      this.state.clearGlobalWorkspace();
      const fallback = this.config.defaultWorkspace || this.config.repoRoot || this.config.defaultCwd;
      await this.sessionManager.change(channelId, { cwd: fallback }, 'workspace reset');
      console.log(`[workspace] reset channel=${channelId} fallback=${fallback}`);
      return `✅ 已恢复默认工作目录：\`${fallback}\`\n来源：${this.config.defaultWorkspace ? 'config' : 'repo-fallback'}`;
    }

    // Explicit selection: must be an existing absolute directory.
    if (!path.isAbsolute(argument)) return '❌ 工作目录必须是绝对路径。';
    if (!fs.existsSync(argument)) return `❌ 工作目录不存在：\`${argument}\``;
    let stats;
    try { stats = fs.statSync(argument); } catch { return `❌ 无法访问该路径：\`${argument}\``; }
    if (!stats.isDirectory()) return `❌ 不是目录：\`${argument}\``;
    if (this.#busy(channelId)) return '⚠️ 当前任务正在执行。请等待任务完成或使用 `!stop`。';

    const resolved = path.resolve(argument);
    this.state.setGlobalWorkspace(resolved);
    await this.sessionManager.change(channelId, { cwd: resolved }, 'workspace changed');
    console.log(`[workspace] selected channel=${channelId} workspace=${resolved}`);
    return `✅ 已切换并持久化工作目录：\`${resolved}\`\n会话已清除（权限档位保持不变）。重启后会恢复该目录。`;
  }

  /**
   * Which Work model to use for a channel, in order of specificity:
   *   1. the channel/thread's own explicit selection
   *   2. the project directory's saved selection (same provider)
   *   3. the last model the owner selected anywhere (same provider)
   *   4. an explicit configured default (config.defaultWorkModel)
   *   5. the pre-existing WorkBuddy first-model behavior
   * A saved/configured model that the provider no longer offers fails loudly
   * (MODEL_UNAVAILABLE) instead of silently switching to a different model.
   */
  #resolveWorkModel(channelId, chState, provider) {
    return this.#resolveWorkModelFor({ channelId, cwd: chState.cwd, model: chState.model }, provider);
  }

  /** Resolver core shared by task launch, `/status` and the startup card. */
  #resolveWorkModelFor({ channelId = null, cwd = null, model = null }, provider) {
    const models = Array.isArray(provider?.models) ? provider.models : [];
    const known = models.length ? new Set(models.map((m) => m.id)) : null;
    const configuredDefault = this.config.defaultWorkModel || null;

    const candidates = [];
    if (model) candidates.push({ model, source: 'channel' });
    const saved = channelId
      ? this.sessionManager.savedModelCandidates(channelId)
      : this.sessionManager.savedModelCandidatesForCwd(cwd);
    for (const entry of saved ?? []) {
      if (!entry?.model || entry.model === model) continue;
      // A saved selection from a different provider is not applicable to this
      // route: the owner changed the provider explicitly, so fall through.
      if (entry.providerId && provider?.id && entry.providerId !== provider.id) continue;
      candidates.push({ model: entry.model, source: 'saved' });
    }
    if (configuredDefault) candidates.push({ model: configuredDefault, source: 'default' });

    for (const candidate of candidates) {
      if (!known || known.has(candidate.model)) return candidate;
      // A stale selection must fail loudly, never silently switch the model.
      throw Object.assign(
        new Error(`已保存模型 ${candidate.model} 当前不可用，请重新使用 /model 或 !models 选择模型。`),
        { code: 'MODEL_UNAVAILABLE', model: candidate.model },
      );
    }

    if (provider?.protocol === PROTOCOL.WORKBUDDY && models.length) {
      return { model: models[0].id, source: 'builtin' };
    }
    return { model: null, source: 'none' };
  }

  /**
   * The ONE resolved runtime state behind task launch, `/status` and the startup
   * card. It reads config → durable state → restored selection → provider route →
   * workspace, and never falls back to a historical WorkBuddy/fast-model default.
   * Unknown values are reported as null so callers can omit them.
   */
  effectiveRuntimeState({ channelId = null, cwd = null } = {}) {
    // Direct-runner mode (no provider registry configured, e.g. a minimal
    // harness): the observed backend IS the runtime, so it is reported as such
    // instead of being dressed up as a provider route.
    if (!this.providerManager) {
      const backend = this.backendState?.backend ?? null;
      const executor = this.executorManager?.get?.('workbuddy') ?? null;
      return {
        mode: 'direct',
        ok: Boolean(backend),
        executor: { id: executor?.id ?? null, displayName: executor?.displayName ?? null, ready: true },
        provider: null,
        backend: backend?.label ?? null,
        protocol: null,
        adapter: null,
        transport: null,
        model: backend?.model ?? null,
        modelSource: backend ? 'backend' : 'none',
        billingType: null,
        billingRoute: this.backendState?.billingRoute ?? null,
        paidFallback: this.config.allowPaidFallback ?? null,
        permissionLevel: this.permissionManager.getLevel(channelId),
        workspace: cwd || this.config.defaultCwd,
        workspaceSource: 'config',
        credentialOk: true,
        problem: null,
      };
    }

    const last = this.state.getLastWorkModel();
    const base = channelId
      ? this.sessionManager.get(channelId)
      : { cwd: null, executorId: last?.executorId ?? null, providerId: last?.providerId ?? null, model: null };
    // Workspace priority: explicit arg → channel's persisted cwd → the user's
    // global selection → configured DEFAULT_WORKSPACE/CWD → the Jarvis repo root.
    // A previous run's directory is NEVER a workspace source: a task executed in
    // a temporary folder must not permanently move the default workspace.
    const savedWorkspace = channelId ? null : this.state.getGlobalWorkspace();
    const configuredDefault = this.config.defaultWorkspace || this.config.repoRoot || this.config.defaultCwd || null;
    let workspace;
    let workspaceSource;
    if (cwd) { workspace = cwd; workspaceSource = 'explicit'; }
    else if (channelId && base.cwd) { workspace = base.cwd; workspaceSource = 'channel'; }
    else if (savedWorkspace?.path) { workspace = savedWorkspace.path; workspaceSource = 'saved'; }
    else if (configuredDefault) { workspace = configuredDefault; workspaceSource = this.config.defaultWorkspace ? 'config' : 'repo-fallback'; }
    else { workspace = null; workspaceSource = 'none'; }
    const providerId = base.providerId || (channelId ? null : last?.providerId) || null;
    const provider = providerId ? this.providerManager?.get(providerId) ?? null : null;
    const executorId = base.executorId || (channelId ? null : last?.executorId) || null;
    const executor = executorId ? this.executorManager?.get(executorId) ?? null : null;

    let model = null;
    let modelSource = 'none';
    let problem = null;
    if (provider) {
      try {
        const resolved = this.#resolveWorkModelFor({ channelId, cwd: workspace, model: base.model ?? null }, provider);
        model = resolved.model;
        modelSource = resolved.source;
      } catch (error) {
        problem = error.code === 'MODEL_UNAVAILABLE' ? error.message : `模型解析失败：${redact(error.message)}`;
      }
    } else if (providerId) {
      problem = `Provider ${providerId} 未注册`;
    }

    const transport = provider?.protocol === PROTOCOL.OPENCODE_GO
      ? this.executorManager?.resolveTransport(provider, model)
      : null;
    const protocol = provider
      ? (provider.protocol === PROTOCOL.OPENCODE_GO ? transportLabel(transport) : protocolLabel(provider.protocol))
      : null;
    const adapter = provider ? this.executorManager?.adapterLabel(provider.protocol, transport) ?? null : null;
    const credentialOk = provider ? Boolean(this.providerManager?.hasCredential(provider)) : false;
    const executorReady = executor ? executor.available !== false && executor.adapterReady !== false : false;

    return {
      mode: 'provider',
      ok: Boolean(provider && model && credentialOk && executorReady && !problem),
      executor: { id: executorId, displayName: executor?.displayName ?? null, ready: executorReady },
      provider: provider
        ? { id: provider.id, displayName: provider.displayName ?? null, billingType: provider.billingType ?? null }
        : (providerId ? { id: providerId, displayName: null, billingType: null } : null),
      protocol,
      adapter,
      transport,
      model,
      modelSource,
      // Billing/paid-fallback are only meaningful for the built-in WorkBuddy
      // route (the only place the concept exists); otherwise report null.
      billingType: provider?.protocol === PROTOCOL.WORKBUDDY ? provider.billingType ?? 'UNKNOWN' : (provider ? provider.billingType ?? null : null),
      paidFallback: provider?.protocol === PROTOCOL.WORKBUDDY ? Boolean(this.config.allowPaidFallback) : null,
      permissionLevel: this.permissionManager.getLevel(channelId),
      workspace,
      workspaceSource,
      credentialOk,
      problem,
    };
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
      // Learn from the model the Agent actually used so the next Work thread in
      // this project (and the next process start) restores it automatically.
      if (event.model) {
        this.sessionManager.rememberWorkModel(channelId, { providerId: chState.providerId, executorId: chState.executorId, model: event.model });
      }
    }
    if (event.type === 'init') this.#noteBackend(channelId, event);

    const task = this.tasks.get(channelId);
    if (!task) return;
    // Once a run is terminal its card must never be flipped back to RUNNING by a
    // late event from the dying process (terminal is monotonic).
    if (task.runId && this.workRuns.get(task.runId)?.terminal) return;
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
    const blocked = this.limits?.blocked(channelId);
    // Historical failure/restart counters are diagnostics, never a lockout: they
    // are shown as a warning but a new Work is always accepted.
    const limitWarning = blocked?.warning ?? (blocked?.blocked ? blocked.reason : null);
    // Same resolved runtime state as the startup card and task launch: this is
    // what prevents `/status` from drifting back to WorkBuddy/fast-model.
    const effective = this.effectiveRuntimeState({ channelId });
    const providerBlocked = effective.provider?.id === 'workbuddy-free' && !effective.ok
      ? (this.backendState?.workbuddyStatus === 'BLOCKED_BY_QUOTA' ? 'WorkBuddy 当前额度不足' : 'WorkBuddy 当前不可用')
      : null;
    const permLabel = PERM_SHORT[effective.permissionLevel] || PERM_SHORT.standard;
    const statusText = formatStatus({
      executor: effective.executor?.displayName ?? effective.executor?.id ?? null,
      provider: effective.provider ? (effective.provider.displayName || effective.provider.id) : null,
      protocol: effective.protocol,
      adapter: effective.adapter,
      backend: effective.backend ?? (this.backendState?.backend?.label ?? null),
      // Direct mode: prefer the model the live runner actually reported.
      model: effective.mode === 'direct' ? (runner?.model ?? effective.model ?? null) : (effective.model ?? runner?.model ?? null),
      billingRoute: effective.mode === 'direct' ? effective.billingRoute : null,
      billingType: effective.billingType ? billingLabel(effective.billingType) : null,
      paidFallback: effective.paidFallback,
      cwd: s.cwd,
      sessionId: s.sessionId,
      state: runner?.busy ? '忙碌' : '空闲',
      idleSec: runner?.busy ? Math.round((runner.idleMs ?? 0) / 1000) : null,
      pendingApprovals: this.approvalManager.pending.size,
      permissionLabel: permLabel,
      blocked: [limitWarning, providerBlocked].filter(Boolean).join(' · ') || null,
      mode: s.mode,
      workState: this.#workStateText(channelId),
      workWorkspace: this.scheduler.stateFor(channelId).workspace || s.cwd,
      chatRoute: this.#chatRouteText(channelId),
      chatActual: this.#chatActualText(channelId),
      chatHealth: this.#chatHealthText(channelId),
      gateway,
    });
    // P2.2A/P2.2B: real runtime/build/instance identity + autostart state.
    return this.#withRuntimeIdentity(statusText);
  }

  /** Append live identity lines; never invents a branch/commit. */
  #withRuntimeIdentity(text) {
    const identity = this.runtimeIdentity;
    const lines = [];
    if (identity?.describe && identity.describe !== 'unknown') lines.push(`Build: ${identity.describe}`);
    lines.push(`Runtime: PID ${process.pid} · uptime ${formatUptime(process.uptime() * 1000)}`);
    const ownerId = identity?.guard?.info?.instanceId;
    if (ownerId) lines.push(`Instance: ${ownerId.split(':')[0]}`);
    const updateLine = this.#updateLine();
    if (updateLine) lines.push(updateLine);
    return lines.length ? `${text}\n\n${lines.join('\n')}` : text;
  }

  /** Deterministic local diagnostics for /doctor and !doctor. No model call. */
  async #doctorText() {
    const lines = ['🩺 **Doctor**（本地确定性检查，无模型调用）', ''];

    const identity = this.runtimeIdentity;
    if (identity) {
      lines.push(`🖥 Instance: PID ${process.pid} · uptime ${formatUptime(process.uptime() * 1000)} · build ${identity.describe}`);
      lines.push(`🔒 Instance lock: ${identity.guard?.acquired ? 'yes' : 'NO'}`);
      const store = this.durableStore?.status?.();
      lines.push(`💾 Durable store: ${store?.open ? `open (v${store.schemaVersion}, ${store.runCount} runs, ${store.pendingFollowups} pending follow-up(s))` : 'unavailable'}`);
    }

    let discord = 'offline';
    if (this.client?.ws) discord = wsStatusText(this.client.ws.status);
    else if (this.client) discord = 'client online';
    lines.push(`💬 Discord: ${discord}`);

    let gateway = 'disabled';
    if (this.gatewayHealth) {
      const result = await this.gatewayHealth().catch(() => ({ ok: false, detail: 'error' }));
      gateway = result.ok ? 'UP' : `DOWN (${result.detail || 'error'})`;
    }
    lines.push(`🌐 LiteLLM gateway: ${gateway}`);

    const executors = (this.executorManager?.list() ?? []);
    lines.push(`🛠 Executors: ${executors.length ? '' : '(none discovered)'}`);
    for (const executor of executors.slice(0, 6)) {
      lines.push(`   ${executor.status === 'PASS' ? '✅' : '❌'} ${executor.id}=${executor.status}`);
    }

    try {
      lines.push(`⏰ Autostart: ${await autostartSummary()}`);
    } catch {
      lines.push('⏰ Autostart: unknown');
    }

    // Chat provider/model cooldowns must be visible here, not silently swallow
    // routes: provider/model, reason and remaining time (K7).
    if (this.chatRuntime?.health?.list) {
      const cooldowns = this.chatRuntime.health.list().filter((item) => item.remainingMs > 0);
      lines.push(cooldowns.length
        ? `💬 Chat cooldowns: ${cooldowns.map((c) => `${c.providerId}/${c.modelId} ${formatUptime(c.remainingMs)} (${c.lastErrorCode || 'UNKNOWN'})`).join(', ')}`
        : '💬 Chat cooldowns: (none)');
    }
    lines.push(...this.#updateDoctorLines());
    return lines.join('\n');
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
      '',
      `💾 持久默认（新会话/重启继承）：${this.#ownerDefaultsText()}`,
      ...(this.#isWorkThread(channelId) ? ['', '🛠 这是永久 Work 线程；请到父频道使用 Chat。'] : []),
      '',
      '使用下方按钮修改；文本指令仍然有效。',
    ];
    return { content: clip(lines.join('\n')), components: settingsButtons({ workThread: this.#isWorkThread(channelId) }) };
  }

  /** One concise line describing the durable owner-default profile. */
  #ownerDefaultsText() {
    const owner = this.state?.getOwnerDefaults?.();
    if (!owner) return '未启用';
    const executor = this.executorManager?.get(owner.executorId);
    const provider = this.providerManager?.get(owner.providerId);
    const chat = !owner.chatProviderId || owner.chatProviderId === 'auto'
      ? 'AUTO'
      : `${owner.chatProviderId}/${owner.chatModel ?? '—'}`;
    return [
      executor?.displayName || owner.executorId || '—',
      provider?.displayName || owner.providerId || '—',
      owner.model || '未选择',
      PERM_SHORT[owner.permission] || owner.permission,
      `Chat ${chat}`,
    ].join(' · ');
  }

  /** Confirmation copy for `初始化设置`; never includes secret material. */
  #resetConfirmationText() {
    return [
      '♻️ **初始化设置**',
      '',
      '将把用户可配置的设置恢复为产品默认值：',
      '• Chat 路由 → AUTO',
      '• Work 执行器 / Provider / 模型 → 默认',
      '• 权限 → 标准',
      '• 工作目录 → 配置默认',
      '',
      '**不会**删除：API Key / 凭据、Provider 账号、Discord 配置、聊天与任务历史、运行记录、日志。',
      '',
      '确认初始化？',
    ].join('\n');
  }

  /**
   * `初始化设置` core. Refuses cleanly while any Work is active (never kills a
   * running task), otherwise resets the persisted settings layer and re-seeds the
   * in-memory managers from the file. It disposes only cached, non-busy runners
   * so the next Work uses the reset route.
   */
  async #factoryReset() {
    const activity = this.runtimeActivity();
    if (!activity.safe) {
      return {
        ok: false,
        message: `⚠️ 初始化被拒绝：当前仍有运行中的 Work（${activity.reasons.join('、')}）。\n请等待任务结束或先使用 ⛔ Stop；设置保持不变，任务不会被终止。`,
      };
    }
    for (const [channelId, runner] of [...this.runners]) {
      if (runner?.busy) continue;
      try { await runner.stop({ reason: 'settings reset' }); } catch { /* best effort */ }
      this.runners.delete(channelId);
    }
    this.state.resetOwnerSettings();
    this.permissionManager.resetAll(this.state.getOwnerDefaults().permission);
    this.chatActual.clear();
    console.log(`[settings] initialized to product defaults pid=${process.pid}`);
    return {
      ok: true,
      message: '✅ 已初始化设置：Chat/Work 路由、权限与工作目录已恢复为产品默认值。凭据、历史与任务记录未受影响。',
    };
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
    const first = (this.executorManager?.list() ?? [])[0];
    lines.push('', first ? `切换示例：\`!executor ${first.id}\`（使用上方列出的真实执行器 ID）` : '切换：`!executor` 加真实执行器 ID');
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
    const first = (this.providerManager?.list() ?? [])[0];
    lines.push('', first ? `切换示例：\`!provider ${first.id}\`（使用上方列出的真实 Provider ID）` : '切换：`!provider` 加真实 Provider ID');
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
      return { content: `⚠️ ${provider.displayName} 未能自动获取模型列表。\n可稍后重试；也可发送 \`!model\` 加真实的模型 ID 手动选择（会发起真实调用验证）。`, components: [] };
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
      id === state.providerId
        ? `切换：\`!model\` 加真实模型 ID（示例：\`!model ${rows[0]?.id ?? '实际模型ID'}\`）`
        : `先切换 Provider：\`!provider ${id}\``,
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
    this.state?.setOwnerDefaults?.({ executorId });
    const state = this.sessionManager.get(channelId);
    const provider = this.providerManager?.get(state.providerId);
    if (!provider || !this.executorManager.compatible(executorId, provider.protocol)) {
      await this.sessionManager.change(channelId, { executorId }, 'executor changed');
      return `⚠️ 已选择执行器：${executor.displayName}，但它不支持当前 Provider。\n请在 \`/model\` → Work 模型 或 \`/settings\` → 提供商 中选择兼容 Provider；配置完成前不会启动任务。`;
    }
    await this.sessionManager.change(channelId, { executorId }, 'executor changed');
    return `✅ 已切换执行器：${executor.displayName}\n已创建新安全 Session（权限档位保持不变）。`;
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
    this.state?.setOwnerDefaults?.({ providerId, ...(model ? { model } : {}) });
    await this.sessionManager.change(channelId, { providerId, model }, 'provider changed');
    if (model) this.sessionManager.rememberWorkModel(channelId, { providerId, executorId: state.executorId, model });
    const hint = provider.protocol === PROTOCOL.OPENCODE_GO
      ? '\n请使用 `!models` 选择模型；只有当前执行器兼容的协议才能被选中。'
      : '\n请使用 `!models` 选择模型。';
    return `✅ 已切换 Provider：${provider.displayName}\n已创建新安全 Session（权限档位保持不变）。${model ? `\n🧠 模型：${model}` : hint}`;
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
    // Persist the selection beyond the ephemeral Discord channel: a new Work
    // thread, a bridge restart or a fresh process must restore it.
    this.sessionManager.rememberWorkModel(channelId, { providerId: state.providerId, executorId: state.executorId, model: modelId });
    return `✅ 已切换模型：\`${modelId}\`\n已创建新安全 Session（权限档位保持不变）。`;
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
    if (added.modelsMissing) lines.push('', '⚠️ 未能自动获取模型列表：可稍后发送 `!models` 刷新，或用 `!model` 加真实模型 ID 验证并添加。');
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
    if (text === '!doctor') {
      await message.reply(clip(await this.#doctorText()));
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
            ? `可删除 Provider：\n${removable.map((item) => `• \`${item.id}\` ${item.displayName}`).join('\n')}\n\n删除示例：\`!provider remove ${removable[0].id}\``
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
    const cooldownCommand = text.match(/^!cooldown(?:\s+(.+))?$/i);
    if (cooldownCommand) {
      const argument = (cooldownCommand[1] || '').trim();
      if (!argument) {
        await message.reply(this.#chatCooldownText());
        return;
      }
      const [action, providerArg, modelArg] = argument.split(/\s+/);
      if (action.toLowerCase() !== 'clear') {
        await message.reply('用法：`!cooldown` 查看冷却；`!cooldown clear [providerId] [modelId]` 清除并立即重试。');
        return;
      }
      if (!this.chatRuntime?.health?.reset) {
        await message.reply('❌ Chat 健康状态未接入。');
        return;
      }
      const selection = this.sessionManager.get(message.channelId);
      const pinnedProvider = selection.chatProviderId && selection.chatProviderId !== 'auto' ? selection.chatProviderId : null;
      const targetProvider = providerArg || pinnedProvider;
      const targetModel = modelArg || (targetProvider && targetProvider === pinnedProvider ? (selection.chatModel || null) : null);
      // Clear ONLY the intended entry (or the intended provider's models); a
      // manual retry must never reset unrelated providers. AUTO safeguards stay.
      if (targetProvider && targetModel) this.chatRuntime.health.reset(targetProvider, targetModel);
      else if (targetProvider) this.chatRuntime.health.reset(targetProvider);
      else this.chatRuntime.health.reset();
      const scope = targetProvider
        ? `${targetProvider}${targetModel ? ` / ${targetModel}` : '（全部模型）'}`
        : '全部 provider';
      console.log(`[chat] cooldown cleared by owner scope=${scope}`);
      await message.reply(`✅ 已清除 ${scope} 的 Chat 冷却；下一条 Chat 会立即重试。`);
      return;
    }
    if (text === '!health') {
      const state = this.sessionManager.snapshot(message.channelId);
      const executor = this.executorManager?.get(state.executorId);
      const provider = this.providerManager?.get(state.providerId);
      const providerHealth = provider ? await this.providerManager.health(provider.id) : { ok: false };
      const compatible = Boolean(executor && provider && this.executorManager.compatible(executor.id, provider.protocol));
      const modelExists = Boolean(state.model && provider?.models?.some((model) => model.id === state.model));
      const cooldowns = this.chatRuntime?.health?.list?.().filter((item) => item.remainingMs > 0) ?? [];
      await message.reply([
        '🩺 **Agent 健康检查**', '',
        `${executor?.available && executor.adapterReady ? '✅' : '❌'} 执行器：${executor?.displayName || '未选择'} · ${executor?.status || 'MISSING'}`,
        `${provider ? '✅' : '❌'} Provider：${provider?.displayName || '未选择'}`,
        `${providerHealth.ok ? '✅' : '❌'} Provider health${providerHealth.error ? `：${providerErrorMessage(providerHealth.error)}` : ''}`,
        `${provider && this.providerManager?.hasCredential(provider) ? '✅' : '❌'} Credential`,
        `${modelExists ? '✅' : '❌'} Model：${state.model || '未选择'}`,
        `${compatible ? '✅' : '❌'} Executor × Provider 兼容性`,
        `${state.executorSessionId ? '✅' : '⚠️'} Session：${state.executorSessionId || '新会话'}`,
        `${cooldowns.length ? '🕒' : '✅'} Chat 冷却：${cooldowns.length ? cooldowns.map((c) => `${c.providerId}/${c.modelId} ${formatUptime(c.remainingMs)}`).join('、') : '无'}`,
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
      await message.reply('✅ 会话已重置。下一个任务将使用新会话（权限档位保持不变），失败/重启诊断计数已清零。');
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
    if (/^!workspace(?:\s+.*)?$/i.test(text)) {
      const argument = text.replace(/^!workspace\s*/i, '').trim().replace(/^"(.*)"$/s, '$1');
      await message.reply(await this.#workspaceCommand(message.channelId, argument));
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
      await message.reply(`✅ 当前频道已绑定到 \`${requested}\`。\n会话已清除（权限档位保持不变）。`);
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
      // P2.1: while a Work chain is active in this explicit Work context, an
      // ordinary owner message is a follow-up requirement, not a new task.
      if (this.#hasActiveWork(message.channelId)) {
        if (await this.#handleWorkFollowUp(message, text, attachments)) return;
      }
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

  /** Local pre-flight for Work: append follow-ups while active, else start. */
  async #startWorkInChannel(message, prompt, options = {}) {
    const channelId = message.channelId;
    const attachments = options.attachments ?? this.#messageAttachments(message);
    // An inline `work <task>` (or any Work launch) in an already-active Work
    // context becomes a follow-up through the same queue as the card modal.
    if (this.#hasActiveWork(channelId)) {
      if (await this.#handleWorkFollowUp(message, prompt, attachments)) return;
    }
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
    // Inherit the parent's EFFECTIVE route (channel override, workspace, then
    // durable owner default) so the first Work turn already uses the expected
    // executor/provider/model instead of a hard-coded value.
    const inherited = this.effectiveRuntimeState({ channelId: parentId });
    this.state.patchChannel(thread.id, {
      mode: MODE.WORK,
      workThread: true,
      parentChannelId: parentId,
      cwd: inherited.workspace ?? parent.cwd,
      executorId: inherited.executor?.id ?? parent.executorId,
      providerId: inherited.provider?.id ?? parent.providerId,
      model: inherited.model ?? parent.model,
      sessionId: null,
    }, this.config.defaultCwd);
    // Permission inheritance is explicit: copy the parent's current level,
    // including FULL. `switchLevel()` would refuse FULL without a UI
    // confirmation and silently leave the child at STANDARD, so inheritance
    // uses the trusted internal path instead. The parent may later change
    // without affecting the thread's snapshot.
    this.permissionManager.inheritLevel(thread.id, this.permissionManager.getLevel(parentId));

    console.log(`[work-thread] created thread=${thread.id} parent=${parentId} cwd=${parent.cwd}`);
    await message.reply(`🛠 已创建 Work 线程 <#${thread.id}>，任务已在线程中开始。父频道保持 Chat。`);

    // P2.2C: one compact parent summary card for the Work chain. The parent
    // stays Chat; the thread carries the verbose progress card.
    {
      const chain = this.#chain(thread.id);
      chain.channelTitle = workTitle(task);
      chain.threadId = thread.id;
      chain.parentChannelId = parentId;
      chain.guildId = message.guildId ?? null;
      if (message.channel?.send) {
        const card = this.#renderParentCard(thread.id);
        if (card) {
          await message.channel.send({ content: card.content, components: card.components })
            .then((sent) => { chain.parentCard = sent; })
            .catch((error) => console.warn(`[work-card] could not post the parent summary card: ${redact(error?.message || error)}`));
        }
      }
    }

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
    // K8: before an append would destructively trim, auto-compact older context
    // into the existing summary. If compaction cannot run we do NOT silently drop
    // history: the stored context is preserved and a warning is surfaced.
    const userText = buildChatHistoryText({ prompt: text, ...extracted });
    const incoming = [];
    if (userText.trim()) incoming.push({ role: 'user', content: userText });
    if (String(result.text ?? '').trim()) incoming.push({ role: 'assistant', content: result.text });
    let historyNote = null;
    let mayAppend = true;
    if (this.chatHistory && incoming.length
      && this.chatHistory.wouldTrim(channelId, { extraMessages: incoming })) {
      const compacted = await this.#compactContext(channelId);
      if (compacted.ok) {
        historyNote = `🧹 上下文已自动压缩：${compacted.olderTurns} 轮较早内容 -> 摘要（旧事实保留在摘要中），最近 ${compacted.keepTurns} 轮保持原样。`;
        console.log(`[chat] auto-compact channel=${channelId} olderTurns=${compacted.olderTurns} keepTurns=${compacted.keepTurns}`);
      } else {
        mayAppend = false;
        historyNote = `⚠️ 上下文已达上限，自动压缩未成功（${compacted.reason}）；为避免静默丢弃旧内容，本轮未写入历史，原上下文保持不变。请发送 \`/compact\` 重试。`;
        console.warn(`[chat] auto-compact failed channel=${channelId} reason=${compacted.reason}`);
      }
    }
    if (this.chatHistory && mayAppend && incoming.length) {
      this.chatHistory.appendTurn(channelId, { user: userText, assistant: result.text });
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
      [
        '💬 Chat',
        result.providerName || result.providerId || providerId,
        served,
        ...(fallback ? ['fallback'] : []),
        `${(durationMs / 1000).toFixed(1)}s`,
      ].join(' · '),
      historyNote,
    ].filter(Boolean).join('\n');
    console.log(`[chat] done channel=${channelId} provider=${result.providerId} model=${result.model} served=${served} fallback=${fallback} durationMs=${durationMs}`);
    // K3: deliver the FULL answer (chunked or as an attachment for very long
    // text). A real model answer is never replaced by a truncated preview.
    await this.#deliverResult(message, result.text, { footer, label: 'chat' });
  }

  #chatFailureText(error, { providerId, model }) {
    const pinned = (providerId && providerId !== 'auto') || Boolean(model);
    if (error?.code === 'NO_VISION_ROUTE') {
      return '❌ 当前没有可用的图片识别路由。请在 `/model` → Chat 模型中固定一个支持图片的模型，或改用 Work 处理该图片。';
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
    const name = provider?.displayName || providerId;
    return selection.chatModel ? `手动固定 · ${name} / ${selection.chatModel}` : `手动固定 · ${name}`;
  }

  /** Verbose label for menus: makes AUTO vs manual pin explicit. */
  #chatRouteLabel(channelId) {
    const selection = this.sessionManager.get(channelId);
    const providerId = selection.chatProviderId || 'auto';
    if (providerId === 'auto') return 'AUTO（自动选择）';
    const provider = this.providerManager?.get(providerId);
    return `${provider?.displayName || providerId} / ${selection.chatModel}（手动固定）`;
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
    if (snapshot.status !== 'cooldown') return snapshot.status === 'unknown' ? 'healthy' : snapshot.status;
    const remaining = Math.max(0, (snapshot.cooldownUntil ?? 0) - Date.now());
    return `冷却 ${formatUptime(remaining)} · ${snapshot.lastErrorCode || 'UNKNOWN'}（!cooldown clear 可立即重试）`;
  }

  /** Owner-visible Chat/provider cooldowns with reason + remaining time (K7). */
  #chatCooldownText() {
    const health = this.chatRuntime?.health;
    if (!health?.list) return '❌ Chat 健康状态未接入。';
    const items = health.list().filter((item) => item.remainingMs > 0);
    const lines = ['🕒 **Chat 冷却状态**', ''];
    if (!items.length) {
      lines.push('当前没有冷却中的 Chat provider/model。');
    } else {
      for (const item of items.slice(0, 8)) {
        lines.push(`• ${item.providerId} / ${item.modelId} · 剩余 ${formatUptime(item.remainingMs)} · ${item.lastErrorCode || 'UNKNOWN'}（失败 ${item.failures} 次）`);
      }
    }
    lines.push('', '清除并立即重试：`!cooldown clear [providerId] [modelId]`');
    return lines.join('\n');
  }

  // ---- P2 control panel + daily UX -----------------------------------------

  #messageAttachments(message) {
    const raw = message?.attachments;
    if (!raw) return [];
    if (typeof raw.values === 'function') return [...raw.values()];
    return Array.isArray(raw) ? raw : [];
  }

  /**
   * Immediately ACK an interaction so Discord never shows "该应用程序未响应".
   * Must run before any slow work (thread create, filesystem, Agent start,
   * provider/model check, workspace queue, network).
   *
   * A failed ACK is NEVER swallowed. If Discord did not acknowledge, the caller
   * must abort before any side effect: otherwise Discord shows the timeout while
   * the backend still creates a Work thread / starts an Agent (the real /work
   * bug). Returns a record with latency + real failure classification.
   */
  async #acknowledge(interaction, { label = null, receivedAt = null } = {}) {
    const startedAt = Date.now();
    const ackLabel = label || this.#interactionLabel(interaction);
    if (interaction.deferred || interaction.replied) {
      return this.#recordAck(ackLabel, { ok: true, skipped: true, method: 'skip', startedAt, receivedAt });
    }
    const isButton = typeof interaction.isButton === 'function' && interaction.isButton();
    const isModal = typeof interaction.isModalSubmit === 'function' && interaction.isModalSubmit();
    const method = isButton ? 'deferUpdate' : isModal ? 'deferReply(ephemeral)' : 'deferReply';
    try {
      if (isButton) await interaction.deferUpdate();
      else if (isModal) await interaction.deferReply({ ephemeral: true });
      else await interaction.deferReply();
      return this.#recordAck(ackLabel, { ok: true, method, startedAt, receivedAt });
    } catch (error) {
      return this.#recordAck(ackLabel, { ok: false, method, startedAt, receivedAt, error });
    }
  }

  /** A human label for logs: `/work`, `button:panel:status`, `modal:workmodal:task`. */
  #interactionLabel(interaction) {
    if (typeof interaction.isChatInputCommand === 'function' && interaction.isChatInputCommand()) {
      return `/${interaction.commandName ?? '?'}`;
    }
    if (typeof interaction.isModalSubmit === 'function' && interaction.isModalSubmit()) {
      return `modal:${interaction.customId ?? '?'}`;
    }
    return `button:${interaction.customId ?? '?'}`;
  }

  /** Emit the ACK observation and return the record for the caller to gate on. */
  #recordAck(label, { ok, skipped = false, method, startedAt, receivedAt = null, error = null }) {
    const completedAt = Date.now();
    const latencyMs = Math.max(0, completedAt - startedAt);
    const result = skipped ? 'SKIP' : ok ? 'PASS' : 'FAIL';
    const reason = error ? classifyInteractionError(error) : null;
    const suffix = reason
      ? ` code=${reason.code ?? '-'} type=${reason.type} error=${redact(reason.message).slice(0, 180)}`
      : skipped ? ' (already acknowledged)' : '';
    const line = `[interaction] ${label} ACK ${result} ${latencyMs}ms method=${method}${suffix}`;
    if (ok || skipped) console.log(line);
    else console.error(line);
    const record = {
      label, result, method,
      // Timing observation: request received → ACK started → ACK completed.
      requestReceivedAt: receivedAt,
      ackStartedAt: startedAt,
      ackCompletedAt: completedAt,
      reachMs: receivedAt ? startedAt - receivedAt : null,
      latencyMs,
      reason, at: completedAt,
    };
    this.lastAck = record;
    this.ackLog = this.ackLog ?? [];
    this.ackLog.push(record);
    return { ok, skipped, ...record, error };
  }

  /**
   * `showModal` is itself the ACK (it cannot follow a defer). It must therefore
   * be checked the same way: a rejected modal means no Work side effect at all.
   */
  async #showModalAck(interaction, modal, { label = null, receivedAt = null } = {}) {
    const startedAt = Date.now();
    const ackLabel = label || this.#interactionLabel(interaction);
    if (interaction.deferred || interaction.replied) {
      return this.#recordAck(ackLabel, { ok: true, skipped: true, method: 'showModal', startedAt, receivedAt });
    }
    try {
      await interaction.showModal(modal);
      return this.#recordAck(ackLabel, { ok: true, method: 'showModal', startedAt, receivedAt });
    } catch (error) {
      return this.#recordAck(ackLabel, { ok: false, method: 'showModal', startedAt, receivedAt, error });
    }
  }

  /**
   * A failed ACK must abort the interaction before any side effect. Log the real
   * cause (DiscordAPIError/Unknown interaction/AlreadyAcknowledged) with the
   * interaction type, command/customId, and latency so a live /work failure is
   * diagnosable instead of appearing as a silent Discord timeout.
   */
  #abortAfterFailedAck(label, ack, stage) {
    const reason = ack?.reason ?? {};
    console.error(
      `[interaction] ${label} ABORTED after failed ACK at ${stage}: type=${reason.type ?? 'unknown'}`
      + ` code=${reason.code ?? '-'} latency=${ack?.latencyMs ?? '-'}ms`
      + ` method=${ack?.method ?? '-'} error=${redact(reason.message || 'unknown')}`,
    );
    console.error(`[interaction] ${label} no Work thread, no filesystem write, no Agent start performed.`);
    return false;
  }

  /** Send/update an interaction result regardless of deferred/replied state. */
  async #edit(interaction, payload) {
    const body = typeof payload === 'string' ? { content: payload } : payload;
    if (interaction.deferred) return interaction.editReply(body);
    if (interaction.replied && typeof interaction.followUp === 'function') {
      const { ephemeral, ...rest } = body;
      return interaction.followUp({ ...rest, ...(ephemeral ? { ephemeral: true } : {}) });
    }
    return interaction.reply(body);
  }

  /** An ephemeral result that works before or after deferral. */
  async #ephemeral(interaction, payload) {
    const body = typeof payload === 'string' ? { content: payload } : payload;
    if (interaction.deferred || interaction.replied) {
      if (typeof interaction.followUp === 'function') return interaction.followUp({ ...body, ephemeral: true });
      return interaction.channel?.send ? interaction.channel.send(body) : Promise.resolve(null);
    }
    return interaction.reply({ ...body, ephemeral: true });
  }

  /** A message-like context backed by an interaction, so Work can be reused. */
  #interactionContext(interaction) {
    const channel = interaction.channel ?? null;
    return {
      channelId: interaction.channelId,
      guildId: interaction.guildId ?? null,
      channel,
      // Handles deferred/replied/none so Work never calls reply() twice.
      reply: (payload) => this.#edit(interaction, payload),
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
    // The quick-start copy references these controls, so the help view itself
    // must expose them (single panel handler, no duplicate implementation).
    return { content: clip(PANEL_HELP_TEXT), components: panelHelpRows() };
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
          // Real Discord Text Input maximum. The slash option has a different
          // (larger) platform limit, so the two are not advertised as the same.
          .setMaxLength(MODAL_TASK_MAX_LENGTH),
      ));
  }

  async #handlePanelInteraction(interaction, id, channelId) {
    // `newwork` shows a modal and is handled before the immediate ACK. Kept here
    // too so a direct call still gets the never-swallow ACK path.
    if (id === 'newwork') {
      const modalAck = await this.#showModalAck(interaction, this.#newWorkModal());
      if (!modalAck.ok) this.#abortAfterFailedAck(modalAck.label, modalAck, 'showModal (panel new Work)');
      return;
    }
    if (id === 'models') {
      const state = this.sessionManager.get(channelId);
      const workProvider = this.providerManager?.get(state.providerId);
      await this.#edit(interaction, {
        content: [
          '🧠 **换模型**',
          `💬 Chat：${this.#chatRouteText(channelId)}`,
          `🛠 Work：${workProvider?.displayName || state.providerId || '未选择'} · ${state.model || '未选择'}`,
        ].join('\n'),
        components: panelModelRows(),
      });
      return;
    }
    if (id === 'settings') { await this.#edit(interaction, this.#settingsPanel(channelId)); return; }
    if (id === 'permission') { await this.#edit(interaction, this.#permissionMenu(channelId)); return; }
    if (id === 'newchat') { await this.#edit(interaction, { content: clip(this.#newChat(channelId)), components: [panelBackRow()] }); return; }
    if (id === 'compact') { await this.#edit(interaction, { content: clip(await this.#compactChat(channelId)), components: [panelBackRow()] }); return; }
    if (id === 'status') { await this.#edit(interaction, await this.#panelStatus(channelId)); return; }
    if (id === 'stop') { await this.#edit(interaction, { content: clip(await this.#stopChannel(channelId)), components: [panelBackRow()] }); return; }
    if (id === 'help') { await this.#edit(interaction, this.#panelHelp()); return; }
    // refresh / back / unknown
    await this.#edit(interaction, this.#controlPanel(channelId));
  }

  async #handleModalSubmit(interaction, parts) {
    // `workinsert` is the current id; `workappend` is accepted for a modal that
    // was already open in Discord before the rename.
    if (parts[0] === 'workinsert' || parts[0] === 'workappend') {
      const runId = parts[1];
      const run = this.workRuns.get(runId);
      const chain = run ? this.workChains.get(run.channelId) : null;
      if (!run || !chain || chain.activeRunId !== runId) {
        await this.#ephemeral(interaction, '该任务已结束。');
        return;
      }
      let requirement = '';
      try { requirement = String(interaction.fields?.getTextInputValue?.('requirement') ?? '').trim(); } catch { requirement = ''; }
      if (!requirement) {
        await this.#ephemeral(interaction, '❌ 插入内容为空。');
        return;
      }
      const result = await this.#insertRequirement({
        runId,
        channelId: run.channelId,
        guildId: interaction.guildId ?? null,
        channel: interaction.channel ?? chain.channel,
        prompt: requirement,
        dedupeKey: `modal:${interaction.id}`,
      });
      if (result.ok) {
        await this.#ephemeral(interaction, insertMessage(result.mode));
      } else if (result.reason === 'duplicate') {
        await this.#ephemeral(interaction, '已收到该插入需求。');
      } else if (result.reason === 'empty') {
        await this.#ephemeral(interaction, '❌ 插入内容为空。');
      } else {
        await this.#ephemeral(interaction, '该任务已结束。');
      }
      return;
    }
    if (parts[0] !== 'workmodal') return;
    let task = '';
    try { task = String(interaction.fields?.getTextInputValue?.('task') ?? '').trim(); } catch { task = ''; }
    if (!task) {
      await this.#ephemeral(interaction, '❌ 任务内容为空。');
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

  #chatModelMenu(channelId, page = 1) {
    const selection = this.sessionManager.get(channelId);
    const current = selection.chatProviderId || 'auto';
    const providers = this.#chatProviderList();
    const paged = pagedChoiceRows('panelchatp', providers, { current, page });
    const rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panelchat:auto').setLabel(current === 'auto' ? '✓ AUTO' : 'AUTO')
        .setStyle(current === 'auto' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    )];
    rows.push(...paged.rows, panelBackRow());
    const browse = paged.pages > 1 ? `\nProvider 列表第 ${paged.page}/${paged.pages} 页，可用下方翻页按钮浏览。` : '';
    return {
      content: `💬 **Chat 模型**\n当前：${this.#chatRouteLabel(channelId)}\n选择 AUTO，或选择 Provider 后再选模型。手动固定后不会自动回退。${browse}`,
      components: rows,
    };
  }

  async #chatProviderModels(channelId, providerId, page = 1) {
    const provider = this.providerManager?.get(providerId);
    if (!provider) return { content: '❌ 未知 Provider。', components: [panelBackRow()] };
    if (provider.protocol === PROTOCOL.WORKBUDDY) return { content: '❌ WorkBuddy 不是 Chat Provider。', components: [panelBackRow()] };
    if (!this.providerManager.hasCredential(provider)) return { content: '❌ 该 Provider 缺少 credential。', components: [panelBackRow()] };
    let models = [];
    try { models = (await this.modelManager.list(providerId)).models; }
    catch (error) { return { content: `${providerErrorMessage(error)}\n可稍后重试，或发送 \`!chatmodel ${providerId}\` 后再试。`, components: [panelBackRow()] }; }
    if (!models.length) {
      return { content: `⚠️ 未能自动获取 ${provider.displayName} 的模型列表。\n可稍后重试，或发送 \`!chatmodel ${providerId}\` 查看手动指定方式。`, components: [panelBackRow()] };
    }
    const paged = providerModelRows('panelchatm', providerId, models.map((model) => ({ id: model.id, label: model.id })), {
      current: this.sessionManager.get(channelId).chatModel,
      page,
    });
    const header = `💬 ${provider.displayName} 模型（固定后不会自动回退）`
      + (paged.pages > 1 ? `\n第 ${paged.page}/${paged.pages} 页` : '');
    return { content: header, components: [...paged.rows, panelBackRow()] };
  }

  #workProviderList(channelId) {
    const selection = this.sessionManager.get(channelId);
    return (this.providerManager?.list() ?? [])
      .filter((provider) => this.providerManager.hasCredential(provider))
      .filter((provider) => !this.executorManager || this.executorManager.compatible(selection.executorId, provider.protocol, null))
      .map((provider) => ({ id: provider.id, label: provider.displayName }));
  }

  #workModelMenu(channelId, page = 1) {
    const selection = this.sessionManager.get(channelId);
    const executor = this.executorManager?.get(selection.executorId);
    const providers = this.#workProviderList(channelId);
    const paged = pagedChoiceRows('panelworkp', providers, { current: selection.providerId, page });
    if (!providers.length) {
      return {
        content: `🛠 **Work 模型**\n当前：${executor?.displayName || selection.executorId} · ${selection.providerId} · ${selection.model || '未选择'}\n⚠️ 暂无可用的兼容 Provider。请先在 \`/model\` → Work 或 \`/settings\` 中检查执行器与 Provider。`,
        components: [panelBackRow()],
      };
    }
    const browse = paged.pages > 1 ? `\nProvider 列表第 ${paged.page}/${paged.pages} 页。` : '';
    return {
      content: `🛠 **Work 模型**\n当前：${executor?.displayName || selection.executorId} · ${selection.providerId} · ${selection.model || '未选择'}\n选择 Provider：${browse}`,
      components: [...paged.rows, panelBackRow()],
    };
  }

  async #workProviderModels(channelId, providerId, page = 1) {
    const provider = this.providerManager?.get(providerId);
    if (!provider) return { content: '❌ 未知 Provider。', components: [panelBackRow()] };
    const selection = this.sessionManager.get(channelId);
    if (this.executorManager && !this.executorManager.compatible(selection.executorId, provider.protocol, null)) {
      const recommendations = this.executorManager.compatibleExecutors?.(provider.protocol)?.map((item) => item.displayName) ?? [];
      return {
        content: `❌ 当前执行器不支持此 Provider 协议。${recommendations.length ? `\n兼容执行器：${recommendations.join('、')}（可在 \`/settings\` → \`🛠️ 执行器\` 切换）` : ''}`,
        components: [panelBackRow()],
      };
    }
    let models = [];
    try { models = (await this.modelManager.list(providerId)).models; }
    catch (error) { return { content: `${providerErrorMessage(error)}\n可先用 \`!models\` 重试。`, components: [panelBackRow()] }; }
    if (!models.length) {
      return { content: `⚠️ 未能自动获取 ${provider.displayName} 的模型列表。\n可先用 \`!models\` 重试，再用本菜单选择。`, components: [panelBackRow()] };
    }
    const paged = providerModelRows('panelworkm', providerId, models.map((model) => ({ id: model.id, label: model.id })), {
      current: selection.providerId === providerId ? selection.model : null,
      page,
    });
    const header = `🛠 ${provider.displayName} 模型（选择后会创建新安全 Session）`
      + (paged.pages > 1 ? `\n第 ${paged.page}/${paged.pages} 页` : '');
    return { content: header, components: [...paged.rows, panelBackRow()] };
  }

  /**
   * Cached Work-model list for the settings panel, paginated the same way as
   * the Chat menu so a many-model provider never needs a fake placeholder.
   */
  #settingsModelMenu(channelId, page = 1) {
    const state = this.sessionManager.get(channelId);
    const provider = this.providerManager?.get(state.providerId);
    if (!provider) return { content: '❌ 当前未选择 Provider。', components: [settingsBackRow()] };
    const models = provider.models ?? [];
    if (!models.length) {
      return {
        content: `🧠 ${provider.displayName} 尚未缓存模型列表。\n请先发送 \`!models\` 刷新后再回到本菜单。`,
        components: [settingsBackRow()],
      };
    }
    const paged = pagedChoiceRows('setmodel', models.map((model) => ({ id: model.id, label: model.id })), {
      current: state.model,
      page,
    });
    const header = `🧠 选择模型（${provider.displayName}）`
      + (paged.pages > 1 ? `\n第 ${paged.page}/${paged.pages} 页` : '');
    return { content: header, components: [...paged.rows, settingsBackRow()] };
  }

  #newChat(channelId) {
    if (this.#isWorkThread(channelId)) return '这是 Work 线程；新对话请在父频道 Chat 使用。';
    const cleared = this.chatHistory ? this.chatHistory.clear(channelId) : false;
    this.chatActual.delete(channelId);
    return cleared
      ? '🆕 已开始新对话：本频道 Chat 上下文已清空（模型与 Work 配置保持不变）。'
      : '🆕 已开始新对话：本频道没有可清除的 Chat 上下文。';
  }

  /**
   * Shared compaction core for the manual `/compact` action and K8 auto-compact.
   * It reuses the CURRENTLY selected Chat route and billing policy (never a
   * metered fallback just to compact) and never recurses. Returns a structured
   * result so the auto path can refuse to append rather than silently trim.
   */
  async #compactContext(channelId, { keepCount = 4 } = {}) {
    if (this.#isWorkThread(channelId)) return { ok: false, reason: '这是 Work 线程，请在父频道 Chat 压缩' };
    if (!this.chatHistory) return { ok: false, reason: 'Chat 历史未启用' };
    if (!this.chatRuntime) return { ok: false, reason: 'Chat 运行时未接入' };
    const stored = this.chatHistory.get(channelId);
    const keepTail = stored.messages.slice(-keepCount);
    const older = stored.messages.slice(0, Math.max(0, stored.messages.length - keepTail.length));
    if (!older.length) return { ok: false, reason: '没有可压缩的较早消息' };
    const selection = this.sessionManager.get(channelId);
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
      const detail = redact(error?.message || error);
      console.error(`[chat] compact failed channel=${channelId} code=${error?.code ?? 'UNKNOWN'} ${detail}`);
      return { ok: false, reason: detail };
    }
    this.chatHistory.replace(channelId, { summary: result.text, messages: keepTail });
    return {
      ok: true,
      olderTurns: Math.ceil(older.length / 2),
      keepTurns: Math.ceil(keepTail.length / 2),
      summary: result.text,
      result,
    };
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
    const compacted = await this.#compactContext(channelId);
    if (!compacted.ok) return `❌ 压缩失败，原上下文保持不变：${compacted.reason}`;
    const served = compacted.result.upstreamModel && compacted.result.upstreamModel !== compacted.result.model
      ? `${compacted.result.model} → ${compacted.result.upstreamModel}` : compacted.result.model;
    return [
      `🧹 已压缩上下文：${compacted.olderTurns} 轮 -> 摘要 + ${compacted.keepTurns} 轮最近消息。`,
      `模型：${compacted.result.providerName || compacted.result.providerId} · ${served}`,
    ].join('\n');
  }

  /**
   * One shared stop implementation so panel Stop, the card Stop and `!stop`
   * cannot drift.
   *
   * P2.2.4: one valid Stop must settle the whole run in a single press. It is
   * idempotent, only clears GENUINELY pending inserts/continuations (a live
   * insert consumed by a completed turn is never reported as unprocessed), and
   * a stale Stop carrying an older run id can never touch a newer run.
   */
  async #stopChannel(channelId, { runId = null } = {}) {
    const chain = this.workChains.get(channelId);
    const activeRun = chain?.activeRunId ? this.workRuns.get(chain.activeRunId) : null;
    const task = this.tasks.get(channelId);
    const runner = this.runners.get(channelId);
    const queuedState = this.scheduler?.stateFor(channelId).state === 'queued';
    const followUpCount = chain?.followUps?.length ?? 0;

    // A stale card's Stop carries an older run id. Never let it touch a newer run.
    if (runId && activeRun && activeRun.id !== runId) {
      console.log(`[work-lifecycle] stale stop ignored run=${runId} active=${activeRun.id}`);
      return '该任务已结束。';
    }
    // Idempotent terminal response: nothing live left to settle.
    if (!activeRun && !task && !runner?.busy && !queuedState && !followUpCount) {
      return '⛔ 当前没有 Agent 进程；任务已结束。';
    }

    // Cancel this channel's scheduler queue entry (a queued run must not start
    // after Stop). The active run, if any, is settled below.
    const queued = queuedState ? this.scheduler?.cancelQueued(channelId) : null;
    if (queued) {
      console.log(`[queue] cancel channel=${channelId} workspace=${queued.key} position=${queued.position}`);
      this.queuedNotices.delete(channelId);
    }

    // Freeze the run first so a late insert can no longer be accepted, then drop
    // only the demands that never affected execution.
    let clearedInserts = 0;
    if (activeRun) {
      this.#markTerminal(activeRun, STATE.CANCELLED);
      clearedInserts = this.#cancelRunInserts(activeRun);
    }
    const clearedFollowUps = this.#clearFollowUps(channelId);

    const sessionId = this.state.getChannel(channelId, this.config.defaultCwd).sessionId;
    const cancelled = sessionId ? this.approvalManager.cancelForSession(sessionId, 'stopped from Discord') : 0;
    let stoppedProgress = null;
    let stoppedMessage = null;
    if (task) {
      stoppedProgress = task.progress;
      stoppedMessage = task.statusMessage;
      task.cancelled = true;
      if (this.#markTerminal(activeRun, STATE.CANCELLED)) {
        task.progress.setState(STATE.CANCELLED, '已由 OWNER 停止');
      }
    }
    const killed = (runner && await runner.stop({ reason: 'stopped by owner (!stop)' })) || { killed: false, pid: null };
    this.runners.delete(channelId);
    if (task) await task.finish();
    // Guarantee the terminal card exposes no live controls even if the run's own
    // finally never repainted it (runner was already gone / no in-flight result).
    if (stoppedMessage && stoppedProgress) {
      await stoppedMessage.edit({ content: clip(stoppedProgress.render()), components: [] }).catch(() => {});
    }
    await this.#refreshParentCard(channelId, { finalState: true }).catch(() => {});
    const followUpLine = [
      queued ? `⛔ 已取消排队中的任务（原队列位置 ${queued.position}）。` : null,
      clearedFollowUps ? `已清空 ${clearedFollowUps} 条待执行的追加需求。` : null,
      clearedInserts ? `已清空 ${clearedInserts} 条未处理的插入需求。` : null,
    ].filter(Boolean);
    return [
      killed.pid
        ? `⛔ 已停止 Agent 进程树（pid ${killed.pid}）。`
        : '⛔ 当前没有 Agent 进程；任务占用已释放。',
      `已取消 ${cancelled} 个待审批请求。`,
      ...followUpLine,
      '可发送 `!status` 确认，或直接发送新任务。',
    ].join('\n');
  }

  // ---- P2.1 interactive Work chains ----------------------------------------

  #chain(channelId) {
    let chain = this.workChains.get(channelId);
    if (!chain) {
      chain = { channelId, activeRunId: null, followUps: [], dedupe: new Set(), channel: null, queuedNotice: null, queuedRunId: null,
        channelTitle: null, cardStartedAt: null, threadId: null, parentChannelId: null, guildId: null, parentCard: null };
      this.workChains.set(channelId, chain);
    }
    return chain;
  }

  #beginRun(message) {
    const channelId = message.channelId;
    const run = {
      id: randomUUID(), channelId, state: 'queued', drainable: true, createdAt: Date.now(),
      // Live steering bookkeeping. `injected` = delivered into the running turn;
      // `continuations` = not deliverable live (race/unsupported), executed as an
      // extra turn in the SAME run/session so nothing is silently dropped.
      injected: [], continuations: [],
      // P2.2.4: one monotonic outer lifecycle for the whole Work. `terminal`
      // records the SINGLE terminal state (DONE/FAILED/CANCELLED) and makes any
      // later transition a no-op. `settledInserts` keeps consumed/cancelled
      // demands for truthful accounting.
      terminal: null,
      settledInserts: [],
    };
    this.workRuns.set(run.id, run);
    const chain = this.#chain(channelId);
    chain.activeRunId = run.id;
    if (message.channel) chain.channel = message.channel;
    chain.dedupe.clear();
    return run;
  }

  #endRun(run) {
    if (!run) return;
    run.state = 'ended';
    // Anything still pending never ran: mark it cancelled, never "unprocessed
    // later" (that would misreport an already-applied live insert).
    for (const record of [...(run.injected ?? []), ...(run.continuations ?? [])]) {
      if (record.state !== INSERT_STATE.CONSUMED) record.state = INSERT_STATE.CANCELLED;
      try { if (record.durableId) this.durableStore?.followUpRemove(record.durableId, { state: record.state }); } catch { /* audit-only */ }
    }
    run.settledInserts = [...(run.settledInserts ?? []), ...(run.injected ?? []), ...(run.continuations ?? [])];
    run.injected = [];
    run.continuations = [];
    this.workRuns.delete(run.id);
    const chain = this.workChains.get(run.channelId);
    if (chain?.activeRunId === run.id) chain.activeRunId = null;
  }

  /**
   * Exactly one terminal transition per run. Returns false when the run already
   * reached a DIFFERENT terminal state (DONE then RUNNING / STOPPED then DONE is
   * impossible). Same-state repeats stay idempotent so a second Stop is harmless.
   */
  #markTerminal(run, state) {
    if (!run) return true;
    if (run.terminal) {
      if (run.terminal !== state) {
        console.warn(`[work-lifecycle] run=${run.id} ignore terminal=${state}; already=${run.terminal}`);
        return false;
      }
      return true;
    }
    run.terminal = state;
    console.log(`[work-lifecycle] run=${run.id} terminal=${state}`);
    return true;
  }

  /**
   * A successfully completed turn consumes every requirement delivered live into
   * it. It already affected execution, so it must never be reported as
   * "unprocessed" afterwards (P2.2.4 K6/L3).
   */
  #settleInjected(run, state = INSERT_STATE.CONSUMED) {
    const records = Array.isArray(run?.injected) ? run.injected : [];
    if (!records.length) return 0;
    for (const record of records) {
      record.state = state;
      try { if (record.durableId) this.durableStore?.followUpRemove(record.durableId, { state }); } catch { /* audit-only */ }
    }
    run.settledInserts = [...(run.settledInserts ?? []), ...records];
    run.injected = [];
    return records.length;
  }

  /** Cancel only genuinely pending inserts/continuations of a stopped run. */
  #cancelRunInserts(run, state = INSERT_STATE.CANCELLED) {
    const records = [...(run?.injected ?? []), ...(run?.continuations ?? [])];
    const pending = records.filter((record) => {
      const current = record.state ?? (run.continuations?.includes(record) ? INSERT_STATE.QUEUED_CONTINUATION : INSERT_STATE.DELIVERED_LIVE);
      return current !== INSERT_STATE.CONSUMED && current !== INSERT_STATE.CANCELLED;
    });
    for (const record of pending) {
      record.state = state;
      try { if (record.durableId) this.durableStore?.followUpRemove(record.durableId, { state }); } catch { /* audit-only */ }
    }
    if (run) {
      run.settledInserts = [...(run.settledInserts ?? []), ...pending];
      run.injected = (run.injected ?? []).filter((record) => !pending.includes(record));
      run.continuations = (run.continuations ?? []).filter((record) => !pending.includes(record));
    }
    return pending.length;
  }

  /**
   * P2.2.5 K3: the ONE long-result delivery path for user-visible Chat/Work
   * answers. It never replaces a real answer with a `…(truncated)` preview:
   *   - short  → one normal message;
   *   - medium → ordered Discord chunks preserving every character;
   *   - very long → short preview + generated `.md` attachment with the full text.
   * If delivery itself fails, the failure is reported explicitly and the full
   * text is written to the run log so it is never lost. Status cards, labels and
   * diagnostics keep using compact `clip()`.
   */
  async #deliverResult(message, text, { header = null, footer = null, runLog = null, label = 'result' } = {}) {
    const full = String(text ?? '');
    const combined = [header, full, footer].filter((part) => part != null && part !== '').join('\n\n');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const plan = planResultDelivery(combined, { fileName: `jarvis-${label}-${stamp}.md` });
    try {
      if (plan.mode === 'message') {
        await message.reply?.({ content: plan.chunks[0] });
        return { ok: true, mode: 'message', chars: plan.totalChars };
      }
      if (plan.mode === 'chunks') {
        for (const chunk of plan.chunks) await message.reply?.({ content: chunk });
        return { ok: true, mode: 'chunks', chunks: plan.chunks.length, chars: plan.totalChars };
      }
      const preview = [
        `🧾 结果较长（${plan.totalChars} 字符），完整内容见附件 \`${plan.attachment.name}\`。`,
        '',
        plan.preview,
        ...(footer ? ['', footer] : []),
      ].join('\n');
      await message.reply?.({
        content: clip(preview),
        files: [new AttachmentBuilder(Buffer.from(plan.attachment.content, 'utf8'), { name: plan.attachment.name })],
      });
      return { ok: true, mode: 'attachment', chars: plan.totalChars, name: plan.attachment.name };
    } catch (error) {
      const detail = redact(error?.message || error);
      console.error(`[delivery] ${label} full delivery failed: ${detail}`);
      try { runLog?.log?.({ type: 'result_full', text: combined }); } catch { /* best effort */ }
      const logNote = runLog?.path ? `完整内容已写入运行日志 \`${path.basename(runLog.path)}\`。` : '完整内容未能写入运行日志。';
      await message.reply?.({ content: `⚠️ 完整结果投递失败：${detail}\n${logNote}` }).catch(() => {});
      return { ok: false, mode: 'failed', error, chars: plan.totalChars };
    }
  }

  /**
   * Post a completed intermediate turn's result as its OWN immutable message,
   * before the next continuation repaints the mutable progress card. Without
   * this the continuation's RUNNING edit erased the turn's useful output
   * (P2.2.4 K6/L2). P2.2.5 K3: the full turn text is delivered, never clipped.
   */
  async #postTurnResult(message, turn, result, runLog) {
    const header = [
      `🟡 第 ${turn} 轮已完成，仍有插入需求/后续工作，任务继续。`,
      runLog?.path ? `日志：\`${path.basename(runLog.path)}\`` : null,
    ].filter((line) => line !== null).join('\n');
    try {
      await this.#deliverResult(message, redact(result?.text || '（无最终文本）'), {
        header, runLog, label: 'work-turn',
      });
      console.log(`[work-lifecycle] preserved turn=${turn} result as its own message`);
    } catch (error) {
      console.warn(`[work-lifecycle] could not preserve turn ${turn} result: ${redact(error?.message || error)}`);
    }
  }

  #hasActiveWork(channelId) {
    const chain = this.workChains.get(channelId);
    return Boolean(chain?.activeRunId && this.workRuns.has(chain.activeRunId));
  }

  #clearFollowUps(channelId) {
    const chain = this.workChains.get(channelId);
    if (!chain) return 0;
    const count = chain.followUps.length;
    chain.followUps = [];
    chain.dedupe.clear();
    try { this.durableStore?.followUpsClear(channelId, { state: 'CANCELLED' }); } catch { /* audit-only */ }
    if (this.tasks.get(channelId)) this.#refreshWorkCard(channelId);
    return count;
  }

  // ---- P2.2C parent-channel Work summary card ------------------------------

  /** Card state tuple from the live task progress (or workspace scheduler). */
  #cardState(channelId) {
    const task = this.tasks.get(channelId);
    const progressState = task?.progress?.state;
    if (progressState) {
      const map = {
        [STATE.RUNNING]: ['🟡', 'RUNNING'],
        [STATE.PLANNING]: ['🟡', 'RUNNING'],
        [STATE.TESTING]: ['🟡', 'RUNNING'],
        [STATE.WAITING_APPROVAL]: ['🟡', 'RUNNING'],
        [STATE.DONE]: ['🟢', 'DONE'],
        [STATE.FAILED]: ['🔴', 'FAILED'],
        [STATE.CANCELLED]: ['⚪', 'CANCELLED'],
        [STATE.TIMEOUT]: ['🔴', 'TIMEOUT'],
      };
      const [icon, label] = map[progressState] ?? ['🟡', 'RUNNING'];
      return [icon, label, progressState];
    }
    const work = this.scheduler?.stateFor(channelId);
    if (work?.state === 'queued') return ['⏳', 'QUEUED', work.state];
    if (work?.state === 'running') return ['🟡', 'RUNNING', work.state];
    return ['🟢', 'IDLE', 'idle'];
  }

  /**
   * Compact parent summary: state + elapsed + model + workspace. Controls are
   * bound to the LIVE run id, so a stale parent card can never stop/append to a
   * newer run (same shared workctl paths as the thread card).
   */
  #renderParentCard(channelId) {
    const chain = this.workChains.get(channelId);
    if (!chain) return null;
    const [icon, label, progressState] = this.#cardState(channelId);
    const s = this.sessionManager.get(channelId);
    const task = this.tasks.get(channelId);
    const model = task?.progress?.model || s.model || 'unknown';
    const runId = chain.activeRunId || chain.queuedRunId || null;
    const liveRun = runId ? this.workRuns.get(runId) : null;
    const finished = Boolean(liveRun?.terminal) || TERMINAL_PROGRESS_STATES.has(progressState);
    const workedMs = Math.max(0, Date.now() - (chain.cardStartedAt || Date.now()));
    const stateLine = finished ? `${icon} ${label}` : `${icon} ${label} · ${formatUptime(workedMs)}`;
    const content = [
      `🛠 Work · ${clip(String(chain.channelTitle ?? '任务'), 60)}`,
      stateLine,
      `🤖 ${model}`,
      `📁 ${s.cwd}`,
      ...(chain.followUps.length
        ? [`➕ 待执行追加需求：${chain.followUps.length}${this.maxWorkFollowUps > 0 ? ` / ${this.maxWorkFollowUps}` : ''}`]
        : []),
    ].join('\n');
    const rows = [];
    if (chain.threadId && chain.guildId) {
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setURL(`https://discord.com/channels/${chain.guildId}/${chain.threadId}`)
          .setLabel('打开 Work')
          .setStyle(ButtonStyle.Link),
      ));
    }
    if (liveRun && !finished) rows.push(...workControlRows(liveRun.id));
    return { content, components: rows };
  }

  /** Update the single parent card message; best-effort, no throttle needed. */
  async #refreshParentCard(channelId, { finalState = null } = {}) {
    const chain = this.workChains.get(channelId);
    if (!chain?.parentCard || typeof chain.parentCard.edit !== 'function') return;
    const card = this.#renderParentCard(channelId);
    if (card) {
      await chain.parentCard.edit({ content: card.content, components: card.components })
        .catch((error) => console.warn(`[work-card] edit failed: ${redact(error?.message || error)}`));
    }
    if (finalState) chain.parentCard = null; // keep the last summary as a history pointer
  }

  #appendModal(runId) {
    return new ModalBuilder()
      .setCustomId(`workinsert:${runId}`)
      .setTitle('插入需求')
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('requirement')
          .setLabel('插入到当前任务')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(4000),
      ));
  }

  /**
   * The one follow-up queue shared by the modal button and normal active-Work
   * text messages. Attachments are downloaded once here, before queuing.
   */
  async #appendFollowUp({ channelId, guildId = null, channel = null, prompt, attachments = null, dedupeKey = null }) {
    const chain = this.workChains.get(channelId);
    if (!chain || !this.#hasActiveWork(channelId)) return { ok: false, reason: 'not-active' };
    if (dedupeKey) {
      if (chain.dedupe.has(dedupeKey)) return { ok: false, reason: 'duplicate' };
      chain.dedupe.add(dedupeKey);
    }
    // 0 = unlimited; only a positive operator policy can reject a follow-up.
    if (this.maxWorkFollowUps > 0 && chain.followUps.length >= this.maxWorkFollowUps) {
      return { ok: false, reason: 'full' };
    }

    const list = attachments ?? [];
    let prepared = String(prompt ?? '').trim() || '请查看并处理这些附件。';
    if (list.length) {
      try {
        prepared = await this.#prepareWorkPrompt({ channelId, id: `followup-${++this.followUpSeq}` }, prepared, list);
      } catch (error) {
        console.warn(`[followup] attachment prepare failed: ${redact(error?.message || error)}`);
      }
    }
    const durableId = `${channelId}:${Date.now()}:${chain.followUps.length + 1}`;
    chain.followUps.push({ prompt: prepared, channelId, guildId, channel, durableId, createdAt: Date.now() });
    chain.channel = channel || chain.channel;
    try {
      this.durableStore?.followUpAdd({
        id: durableId,
        runId: chain.activeRunId ?? null,
        channelId,
        position: chain.followUps.length,
        prompt: clip(String(prepared ?? ''), 500),
      });
    } catch { /* audit-only */ }
    this.#refreshWorkCard(channelId);
    await this.#refreshParentCard(channelId).catch(() => {});
    return { ok: true, position: chain.followUps.length };
  }

  #refreshWorkCard(channelId) {
    const chain = this.workChains.get(channelId);
    if (!chain) return;
    const task = this.tasks.get(channelId);
    if (task && task.runId === chain.activeRunId) {
      task.progress.setFollowUps(chain.followUps.length);
      task.schedule();
      return;
    }
    const notice = chain.queuedNotice;
    const queuedRun = chain.queuedRunId ? this.workRuns.get(chain.queuedRunId) : null;
    if (notice && queuedRun && !queuedRun.terminal) {
      const pending = chain.followUps.length;
      const base = `⏳ 排队中 · 追加需求：${pending} 条待执行`;
      notice.edit({ content: base, components: workControlRows(queuedRun.id) }).catch(() => {});
    }
  }

  /**
   * After a turn releases its workspace lock, start the next queued follow-up
   * through the exact same `runTask` + `WorkspaceScheduler` path, so global
   * FIFO fairness is preserved and no Agent runs concurrently.
   */
  #drainFollowUps(channelId, endedRun) {
    const chain = this.workChains.get(channelId);
    if (!chain) return;
    if (endedRun && endedRun.drainable === false) {
      if (chain.followUps.length) {
        const remaining = chain.followUps.length;
        chain.followUps = [];
        const target = chain.channel;
        target?.send?.(`⛔ 任务已结束，剩余 ${remaining} 条追加需求未执行。`).catch(() => {});
        this.#refreshWorkCard(channelId);
      }
      return;
    }
    if (!chain.followUps.length) return;
    const next = chain.followUps.shift();
    try { this.durableStore?.followUpRemove(next.durableId, { state: 'EXECUTED' }); } catch { /* audit-only */ }
    const target = next.channel || chain.channel;
    if (!target?.send) return;
    const message = {
      channelId,
      guildId: next.guildId ?? null,
      channel: target,
      id: `followup-${++this.followUpSeq}`,
      reply: (payload) => target.send(payload),
    };
    Promise.resolve()
      .then(() => this.runTask(message, next.prompt, { attachments: [] }))
      .catch((error) => console.warn(`[followup] drain failed: ${redact(error?.message || error)}`));
  }

  async #handleWorkFollowUp(message, text, attachments) {
    const chain = this.workChains.get(message.channelId);
    const activeRun = chain?.activeRunId ? this.workRuns.get(chain.activeRunId) : null;
    // While the Agent is actually RUNNING, an owner message is steering, not a
    // queued next turn. Only the not-yet-started case falls back to the queue.
    if (activeRun && activeRun.state === 'running') {
      const inserted = await this.#insertRequirement({
        runId: activeRun.id,
        channelId: message.channelId,
        guildId: message.guildId,
        channel: message.channel,
        prompt: text,
        attachments,
      });
      if (inserted.ok) {
        await message.reply(insertMessage(inserted.mode));
        return true;
      }
      if (inserted.reason === 'duplicate') {
        await message.reply('已收到该插入需求。');
        return true;
      }
    }
    const result = await this.#appendFollowUp({
      channelId: message.channelId,
      guildId: message.guildId,
      channel: message.channel,
      prompt: text,
      attachments,
    });
    if (result.ok) {
      await message.reply(`✅ 已追加，当前任务结束后执行（队列 #${result.position}）。`);
      return true;
    }
    if (result.reason === 'full') {
      await message.reply(`⛔ 追加队列已满（配置上限 ${this.maxWorkFollowUps} 条，可用 MAX_WORK_FOLLOWUPS 调整），请等待当前任务结束后再发送。`);
      return true;
    }
    return false;
  }

  /** Which executor can steer a running turn (Claude-compatible stream-json). */
  #supportsLiveInsert(channelId) {
    if (!this.executorManager) return true; // direct ClaudeRunner path
    const executorId = this.sessionManager.get(channelId).executorId;
    if (typeof this.executorManager.supportsLiveSteering === 'function') {
      return this.executorManager.supportsLiveSteering(executorId);
    }
    return Boolean(this.executorManager.get(executorId)?.capabilities?.includes('live-steering'));
  }

  /**
   * Insert a requirement into the CURRENTLY RUNNING Work turn.
   *
   * Never starts a second Agent, never re-acquires the workspace lock, never
   * changes runId/sessionId. Delivered live into the running child's stdin when
   * the executor supports steering; otherwise (or when the turn ended in the
   * same instant) it becomes an extra turn in the SAME run/session so the demand
   * is never lost.
   */
  async #insertRequirement({ runId, channelId, prompt, attachments = null, guildId = null, channel = null, dedupeKey = null }) {
    const chain = this.workChains.get(channelId);
    const run = this.workRuns.get(runId);
    if (!run || !chain || chain.activeRunId !== runId) return { ok: false, reason: 'not-active' };
    if (dedupeKey) {
      if (chain.dedupe.has(dedupeKey)) return { ok: false, reason: 'duplicate' };
      chain.dedupe.add(dedupeKey);
    }

    let prepared = String(prompt ?? '').trim();
    if (attachments?.length) {
      try { prepared = await this.#prepareWorkPrompt({ channelId, id: `insert-${++this.followUpSeq}` }, prepared, attachments); }
      catch (error) { console.warn(`[work-insert] attachment prepare failed: ${redact(error?.message || error)}`); }
    }
    if (!prepared) return { ok: false, reason: 'empty' };

    // Re-check the run is still live and insertable: Stop may have landed while
    // attachments were prepared, and a late insert must never be accepted after
    // the run was frozen/terminal.
    if (run.terminal || run.state === 'ended' || chain.activeRunId !== runId
      || !this.#hasActiveWork(channelId) || this.tasks.get(channelId)?.cancelled) {
      return { ok: false, reason: 'ended' };
    }

    const runner = this.tasks.get(channelId)?.runner ?? this.runners.get(channelId);
    const supports = this.#supportsLiveInsert(channelId);
    const durableId = `${channelId}:insert:${Date.now()}:${++this.followUpSeq}`;
    const record = { prompt: prepared, channelId, guildId, channel, at: Date.now(), durableId };

    if (supports && runner?.busy && typeof runner.injectRequirement === 'function') {
      const delivery = runner.injectRequirement(prepared);
      if (delivery?.delivered) {
        run.injected.push({ ...record, state: INSERT_STATE.DELIVERED_LIVE });
        // Observable delivery receipt; the requirement body is never logged.
        console.log(`[work-insert] run=${run.id} accepted mode=live state=${INSERT_STATE.DELIVERED_LIVE} bytes=${delivery.bytes ?? '-'}`);
        try { this.durableStore?.followUpAdd({ id: durableId, runId: run.id, channelId, position: run.injected.length, state: INSERT_STATE.DELIVERED_LIVE }); } catch { /* audit-only */ }
        return { ok: true, mode: 'inserted' };
      }
      console.log(`[work-insert] run=${run.id} live delivery rejected (${delivery?.reason ?? 'unknown'}); continuing in the same session`);
    } else if (!supports) {
      console.log(`[work-insert] run=${run.id} executor does not support live insert; continuing in the same session`);
    }

    run.continuations = run.continuations ?? [];
    run.continuations.push({ ...record, state: INSERT_STATE.QUEUED_CONTINUATION });
    try { this.durableStore?.followUpAdd({ id: durableId, runId: run.id, channelId, position: run.continuations.length, state: INSERT_STATE.QUEUED_CONTINUATION }); } catch { /* audit-only */ }
    const mode = supports ? 'continued' : 'unsupported';
    console.log(`[work-insert] run=${run.id} accepted mode=${mode} state=${INSERT_STATE.QUEUED_CONTINUATION} pending=${run.continuations.length}`);
    await this.#refreshParentCard(channelId).catch(() => {});
    return { ok: true, mode };
  }

  /**
   * The interaction is already ACKed (deferredReply) before this runs, except
   * for `/work` without a task which shows its modal as the ACK.
   */
  async #handleApplicationCommand(interaction) {
    const channelId = interaction.channelId;
    const name = interaction.commandName;
    if (name === 'panel') { await this.#edit(interaction, this.#controlPanel(channelId)); return; }
    if (name === 'model') {
      await this.#edit(interaction, { content: '🧠 换模型', components: panelModelRows() });
      return;
    }
    if (name === 'settings') { await this.#edit(interaction, this.#settingsPanel(channelId)); return; }
    if (name === 'permission') { await this.#edit(interaction, this.#permissionMenu(channelId)); return; }
    if (name === 'help') { await this.#edit(interaction, this.#panelHelp()); return; }
    if (name === 'status') { await this.#edit(interaction, await this.#panelStatus(channelId)); return; }
    if (name === 'doctor') { await this.#edit(interaction, { content: clip(await this.#doctorText()) }); return; }
    if (name === 'new') { await this.#edit(interaction, { content: clip(this.#newChat(channelId)) }); return; }
    if (name === 'compact') { await this.#edit(interaction, { content: clip(await this.#compactChat(channelId)) }); return; }
    if (name === 'stop') { await this.#edit(interaction, { content: clip(await this.#stopChannel(channelId)) }); return; }
    if (name === 'update') { await this.#handleUpdateCommand(interaction); return; }
    if (name === 'work') {
      const task = typeof interaction.options?.getString === 'function' ? interaction.options.getString('task') : null;
      if (task && String(task).trim()) await this.#launchWork(this.#interactionContext(interaction), String(task).trim());
    }
  }

  /**
   * P2.2.6 K8 owner-only update controls. `status` has no side effects (it never
   * fetches); `now` forces a check and, when the runtime is safely idle, may
   * deploy; `pause`/`resume` persist. Busy runtime keeps the update PENDING
   * instead of killing Work.
   */
  async #handleUpdateCommand(interaction) {
    if (!this.updater) {
      await this.#edit(interaction, { content: '❌ 自动更新器未启用（AUTO_UPDATE_ENABLED）。' });
      return;
    }
    const action = String(interaction.options?.getString?.('action') ?? 'status').toLowerCase();
    if (action === 'pause') {
      this.updater.pause('owner');
      await this.#edit(interaction, { content: clip(`⏸ 已暂停自动更新。\n\n${this.updater.describe()}`) });
      return;
    }
    if (action === 'resume') {
      await this.updater.resume().catch(() => null);
      await this.#edit(interaction, { content: clip(`▶️ 已恢复自动更新。\n\n${this.updater.describe()}`) });
      return;
    }
    if (action === 'now') {
      await this.updater.refresh({ force: true, reason: 'owner' }).catch((error) => this.updater?.logger?.warn?.(`[update] owner check failed: ${error?.message || error}`));
      await this.#edit(interaction, { content: clip(`🔄 已立即检查。\n\n${this.updater.describe()}`) });
      return;
    }
    await this.#edit(interaction, { content: clip(`⬆️ **Jarvis 自动更新**\n\n${this.updater.describe()}`) });
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

  /**
   * The single Chat-selection entry point for every Discord surface: the
   * `!chatmodel` text command, the control-panel buttons and the settings
   * panel. It validates the provider, delegates to the shared SessionManager
   * boundary (placeholder rejection + real-model match) and never mutates
   * persisted state on failure.
   */
  async #applyChatSelection(channelId, { providerId = 'auto', model = null } = {}) {
    const normalizedProvider = providerId == null ? 'auto' : String(providerId).trim();
    const isAuto = !normalizedProvider || normalizedProvider.toLowerCase() === 'auto';
    const normalizedModel = model == null ? null : String(model).trim();
    // Reject placeholder syntax before any provider lookup, so `<provider-id>`
    // is reported as an invalid selection instead of a vague unknown provider.
    if (!isAuto && (isPlaceholderId(normalizedProvider) || isPlaceholderId(normalizedModel))) {
      return { ok: false, message: this.#invalidChatSelectionText(isPlaceholderId(normalizedProvider) ? normalizedProvider : normalizedModel) };
    }
    if (!isAuto) {
      const provider = this.providerManager?.get(normalizedProvider);
      if (!provider) return { ok: false, message: `❌ 未知 Provider：\`${normalizedProvider}\`。` };
      if (provider.protocol === PROTOCOL.WORKBUDDY) return { ok: false, message: '❌ WorkBuddy 不是 Chat Provider。' };
      if (!this.providerManager.hasCredential(provider)) return { ok: false, message: `❌ Provider \`${normalizedProvider}\` 缺少 credential。` };
    }
    try {
      const selection = await this.sessionManager.resolveChatSelection(channelId, { providerId: normalizedProvider, model });
      // An explicit Chat choice is durable owner configuration: persist it so new
      // scopes and restarts inherit it instead of reverting to AUTO.
      this.state?.setOwnerDefaults?.({ chatProviderId: selection.chatProviderId, chatModel: selection.chatModel });
      return { ok: true, selection };
    } catch (error) {
      if (error?.code === 'INVALID_CHAT_SELECTION') {
        const shown = error.field === 'providerId' ? normalizedProvider : model;
        return { ok: false, message: this.#invalidChatSelectionText(shown) };
      }
      return { ok: false, message: `❌ 无法保存 Chat 模型选择：${redact(error?.message || error)}` };
    }
  }

  #invalidChatSelectionText(value) {
    return `❌ 无效的 Chat 模型选择：\`${String(value ?? '').trim() || '空'}\`。\n占位符（如 \`<model-id>\`）不会被保存；请选择 AUTO 或真实的 Provider/model。`;
  }

  async #chatModelCommand(channelId, argument) {
    if (!argument) {
      // Same selectable menu as `/model` → Chat, so the text command has a real
      // click path instead of an unusable `<provider-id> <model-id>` example.
      return this.#chatModelMenu(channelId);
    }
    if (argument.toLowerCase() === 'auto') {
      const result = await this.#applyChatSelection(channelId, { providerId: 'auto', model: null });
      return result.ok
        ? '✅ Chat 路由已设为 **AUTO**（优先 LiteLLM `chat-fast`；网关不可用时回退 OpenCode Go 直连，再到其他健康免费/订阅模型）。'
        : result.message;
    }
    const [providerId, modelId] = argument.split(/\s+/);
    if (!modelId) {
      const provider = this.providerManager?.get(providerId);
      if (!provider) return `❌ 未知 Provider：\`${providerId}\`。`;
      if (provider.protocol === PROTOCOL.WORKBUDDY) return '❌ WorkBuddy 不是 Chat Provider。';
      if (!this.providerManager.hasCredential(provider)) return `❌ Provider \`${providerId}\` 缺少 credential。`;
      // Show the real paginated model list for that provider instead of
      // demanding a model id the owner may not know.
      return this.#chatProviderModels(channelId, providerId);
    }
    const result = await this.#applyChatSelection(channelId, { providerId, model: modelId });
    return result.ok
      ? `✅ Chat 模型已固定为 \`${providerId} / ${modelId}\`。\n该选择不会自动回退到其他模型。`
      : result.message;
  }

  /**
   * Queue the task behind a per-workspace FIFO lock. The workspace lock is
   * acquired before the Agent starts, so a second task on the same cwd never runs
   * concurrently and a queued task never creates a runner.
   */
  async runTask(message, prompt, { attachments = null } = {}) {
    const channelId = message.channelId;
    // A new Work always starts a fresh recovery episode: an earlier crash loop
    // can never require `!reset` before this valid task is accepted (K5).
    this.limits?.beginWork(channelId);
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

    const run = this.#beginRun(message);
    // P2.2D durable run record: persisted BEFORE the workspace queue so a
    // pending record explains what a restart interrupted (never auto-resumed).
    // The model/provider are the RESOLVED ones, so the record matches the actual
    // runtime rather than the raw channel entry.
    try {
      const effective = this.effectiveRuntimeState({ channelId });
      this.durableStore?.runStart({
        runId: run.id,
        chainId: channelId,
        channelId,
        threadId: this.#isWorkThread(channelId) ? channelId : null,
        parentChannelId: this.state.getChannel(channelId, this.config.defaultCwd).parentChannelId ?? null,
        workspace,
        title: clip(String(taskPrompt ?? '').replace(/\s+/g, ' ').trim(), 120),
        prompt: clip(String(prompt ?? ''), 2000),
        executorId: effective.executor?.id ?? chState.executorId,
        providerId: effective.provider?.id ?? chState.providerId,
        model: effective.model ?? chState.model,
        permissionLevel: this.permissionManager.getLevel(channelId),
      });
    } catch (error) { console.warn(`[store] runStart failed: ${redact(error?.message || error)}`); }
    const chainForCard = this.workChains.get(channelId);
    if (chainForCard) chainForCard.channelTitle = chainForCard.channelTitle || workTitle(taskPrompt);
    const entry = this.scheduler.submit({
      workspace,
      channelId,
      label: message.guildId ? `<#${channelId}>` : 'DM',
      run: () => this.#runTaskNow(message, taskPrompt, run),
      onQueued: ({ position, active }) => this.#notifyQueued(message, workspace, position, active, run),
      onStart: async ({ key }) => {
        console.log(`[queue] start channel=${channelId} workspace=${key}`);
        run.state = 'running';
        const chain = this.workChains.get(channelId);
        if (chain) {
          chain.queuedNotice = null;
          chain.queuedRunId = null;
          if (!chain.cardStartedAt) chain.cardStartedAt = Date.now();
        }
        // P2.2C: repaint the parent summary card as soon as the lock is held.
        await this.#refreshParentCard(channelId).catch(() => {});
        const notice = this.queuedNotices.get(channelId);
        if (!notice) return;
        this.queuedNotices.delete(channelId);
        await notice.edit({ content: '▶️ 已获得工作区锁，任务开始执行。', components: [] }).catch(() => {});
      },
    });
    await entry.done.catch(() => {});
    this.#drainFollowUps(channelId, run);
    // P2.2C: final compact summary card refresh (DONE/FAILED/CANCELLED/...).
    await this.#refreshParentCard(channelId, { finalState: true }).catch(() => {});
  }

  async #notifyQueued(message, workspace, position, active, run = null) {
    const activeLabel = active?.channelId ? `<#${active.channelId}>` : '其他任务';
    console.log(`[queue] queued channel=${message.channelId} workspace=${workspace} position=${position} active=${active?.channelId ?? 'none'}`);
    try {
      const payload = {
        content: [
          `⏳ Workspace busy: ${workspace}`,
          `Queue position: ${position}`,
          `Active task: ${activeLabel}`,
        ].join('\n'),
        ...(run ? { components: workControlRows(run.id) } : {}),
      };
      const sent = await message.reply(payload);
      this.queuedNotices.set(message.channelId, sent);
      if (run) {
        const chain = this.#chain(message.channelId);
        chain.queuedNotice = sent;
        chain.queuedRunId = run.id;
      }
    } catch (error) {
      console.warn(`[queue] could not send the queue notice: ${redact(error?.message || error)}`);
    }
  }

  async #runTaskNow(message, prompt, run = null) {
    const channelId = message.channelId;
    // A run stopped while still queued must never start an Agent afterwards.
    if (run?.terminal) {
      console.log(`[work-lifecycle] run=${run.id} terminal=${run.terminal}; skipping queued start`);
      this.#endRun(run);
      await this.#refreshParentCard(channelId, { finalState: true }).catch(() => {});
      return;
    }
    const chState = this.sessionManager.get(channelId);
    let runner;
    try { runner = await this.getRunner(channelId); }
    catch (error) {
      if (run) run.drainable = false;
      const text = ['INVALID_CREDENTIAL', 'PROVIDER_NOT_FOUND', 'WORKBUDDY_QUOTA', 'WORKBUDDY_UNAVAILABLE', 'INCOMPATIBLE',
        'MODEL_REQUIRED', 'MODEL_UNAVAILABLE'].includes(error.code)
        ? (error.code === 'MODEL_UNAVAILABLE' ? `❌ ${redact(error.message)}` : providerErrorMessage(error))
        : `❌ 无法启动 Agent：${redact(error.message || error)}`;
      await message.reply(text);
      return;
    }

    const level = this.permissionManager.getLevel(channelId);
    const progress = new EventPresenter({
      cwd: chState.cwd,
      model: chState.model || this.backendState?.backend?.model || 'unknown',
    }).setPermissionLabel(PERM_SHORT[level]);
    const chain = this.workChains.get(channelId);
    if (run && chain && chain.activeRunId === run.id) progress.setFollowUps(chain.followUps.length);
    // The active card keeps its controls across progress edits; a terminal
    // update clears them so a finished card cannot control a newer run.
    const activeComponents = () => {
      if (!run || this.workRuns.get(run.id) !== run || run.state === 'ended' || run.terminal) return null;
      return workControlRows(run.id);
    };
    const statusMessage = await message.reply({ content: progress.render(), components: activeComponents() ?? [] });
    const editor = new ThrottledEditor({
      intervalMs: this.config.progressThrottleMs,
      write: (content, components) => statusMessage.edit(components ? { content: clip(content), components } : clip(content)),
    });
    const runLog = this.logger?.open({ channelId, prompt }) ?? { path: null, log: () => {}, close: () => {} };

    const task = {
      runId: run?.id ?? null,
      // The exact runner this task owns; live insert steering must target it.
      runner,
      progress,
      editor,
      statusMessage,
      runLog,
      cancelled: false,
      finished: false,
      startedAt: Date.now(),
      watchdog: null,
      schedule: () => editor.submit(progress.render(), activeComponents()),
      finish: async () => {
        // Idempotent: `!stop` and the run's own `finally` can both land here.
        if (task.finished) return;
        task.finished = true;
        if (task.watchdog) { clearInterval(task.watchdog); task.watchdog = null; }
        editor.dispose();
        runLog.close();
        // P2.2C: final parent card render WHILE the task is still present so the
        // terminal state (DONE/FAILED/CANCELLED) is what the owner last sees.
        await this.#refreshParentCard(channelId, { finalState: true }).catch(() => {});
        this.tasks.delete(channelId);
        this.#endRun(run);
        // P2.2D terminal durable record for this run.
        try {
          this.durableStore?.runFinish(run?.id ?? null, {
            state: (progress.state || 'DONE').toUpperCase(),
            durationMs: Date.now() - (task.startedAt ?? Date.now()),
            costUsd: progress.costUsd ?? null,
            sessionId: this.state.getChannel(channelId, this.config.defaultCwd).sessionId ?? null,
            tests: progress.tests ?? null,
          });
        } catch { /* audit-only, never breaks the run */ }
      },
    };
    this.tasks.set(channelId, task);
    if (run) run.state = 'running';

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
      // P2.2C parent card heartbeat: cheap, model-free, failures swallowed.
      this.#refreshParentCard(channelId).catch(() => {});
      const idleMs = Number.isFinite(runner.idleMs) ? runner.idleMs : 0;
      if (idleMs < stallNoticeMs) return;
      progress.markStalled(idleMs);
      task.schedule();
    }, watchEveryMs);
    if (typeof task.watchdog.unref === 'function') task.watchdog.unref();

    try {
      // Same-turn steering goes straight into the running child's stdin, so most
      // inserts produce exactly one `result`. Anything that could not be
      // delivered live (race/unsupported executor) is executed here as an extra
      // turn in the SAME run, session and card — never a second Agent, never a
      // new workspace lock, and only ONE final DONE.
      let turnPrompt = prompt;
      let result;
      let turn = 0;
      // Explicit unlimited-vs-timed branch. A healthy task has NO default
      // wall-clock cap: it ends on result, owner Stop, process exit/failure, or
      // an explicitly configured positive operator limit. Never pass 0 into the
      // timeout helper and hope it means "disabled".
      const operatorTimeoutMs = Number(this.config.taskTimeoutMs);
      const timed = Number.isFinite(operatorTimeoutMs) && operatorTimeoutMs > 0;
      for (;;) {
        turn += 1;
        const sendPromise = runner.send(turnPrompt);
        result = timed
          ? await withTimeout(sendPromise, operatorTimeoutMs, {
            label: 'task',
            onTimeout: () => { console.error(`[task] operator timeout after ${operatorTimeoutMs}ms; killing the agent process`); runner.stop({ reason: 'task wall-clock timeout' }).catch(() => {}); },
          })
          : await sendPromise;

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
        if (result.sessionId) {
          this.state.patchChannel(channelId, { sessionId: result.sessionId }, this.config.defaultCwd);
          this.channelBySession.set(result.sessionId, channelId);
        }
        console.log(`[task] turn=${turn} channel=${channelId} isError=${Boolean(result.isError)} tools=${result.tools.length} durationMs=${result.durationMs}`);

        // A successful turn consumes every requirement that was delivered live
        // into it, so Stop/cleanup can never later call it "unprocessed".
        if (!result.isError && !task.cancelled) this.#settleInjected(run, INSERT_STATE.CONSUMED);

        // Decide the continuation BEFORE any terminal rendering: an Agent turn
        // ending is not the Work ending while a continuation still remains.
        const next = run?.continuations?.length && !result.isError && !task.cancelled
          ? run.continuations.shift()
          : null;
        if (!next) break;

        // Preserve this turn's completed result as its own immutable message
        // before the continuation repaints the mutable progress card.
        await this.#postTurnResult(message, turn, result, runLog);
        // Stop may have landed while the result message was being sent.
        if (task.cancelled || run?.terminal) {
          throw Object.assign(new Error('stopped by owner'), { code: 'TASK_CANCELLED' });
        }
        next.state = INSERT_STATE.CONSUMED;
        console.log(`[work-insert] run=${run.id} continuation turn=${turn + 1} (same session, no new run)`);
        try { if (next.durableId) this.durableStore?.followUpRemove(next.durableId, { state: 'EXECUTED' }); } catch { /* audit-only */ }
        progress.setState(STATE.RUNNING, '继续执行插入的需求');
        await editor.flushNow(progress.render(), activeComponents());
        turnPrompt = next.prompt;
      }

      // Guard every terminal transition with the one-transition ledger so a run
      // can never emit DONE and then RUNNING, or STOPPED and then DONE.
      const finalState = result.isError ? STATE.FAILED : STATE.DONE;
      if (this.#markTerminal(run, finalState)) progress.setState(finalState);
      if (result.isError) this.limits?.noteFailure(channelId, result.text);
      else this.limits?.noteSuccess(channelId);
      console.log(`[task] done channel=${channelId} state=${progress.state} turns=${turn} tools=${result.tools.length} durationMs=${result.durationMs} tests=${progress.tests || '-'}`);
      const extras = [
        runLog.path ? `日志：\`${path.basename(runLog.path)}\`` : null,
      ].filter(Boolean).join(' · ');
      progress.costUsd = result.costUsd ?? 0;
      // progress.render() already carries the state, project, last action, test
      // result and tool histogram — reuse it instead of rebuilding the summary.
      const finalText = redact(result.text || '（无最终文本）');
      // The mutable progress card stays compact. A short final answer is shown
      // inline; a longer one is delivered in FULL as its own immutable message
      // (or attachment) so the card never truncates the real result (K3).
      const CARD_RESULT_BUDGET = 1200;
      const inline = finalText.length <= CARD_RESULT_BUDGET ? `\n\n${finalText}` : '';
      const body = [progress.render(), extras || null].filter((line) => line !== null).join('\n');
      await editor.flushNow(`${body}${inline}`, []);
      if (finalText.length > CARD_RESULT_BUDGET) {
        await this.#deliverResult(message, finalText, { runLog, label: 'work' });
      }
    } catch (error) {
      if (run) run.drainable = false;
      const detail = redact(error?.message || error);
      // A run that ends because the owner stopped it, the wall-clock cap fired,
      // or the agent died mid-flight must land on a terminal state. Leaving it
      // on RUNNING was the original bug: the channel stayed "busy" forever.
      const cancelled = task.cancelled || error?.code === 'TASK_CANCELLED';
      if (cancelled) {
        progress.clearStall();
        if (this.#markTerminal(run, STATE.CANCELLED)) progress.setState(STATE.CANCELLED, '已由 OWNER 停止');
        console.log(`[task] cancelled channel=${channelId} reason=${detail}`);
      } else if (error?.code === 'TASK_TIMEOUT') {
        progress.clearStall();
        if (this.#markTerminal(run, STATE.TIMEOUT)) progress.setState(STATE.TIMEOUT, '任务达到时间上限');
        const failures = this.limits?.noteFailure(channelId, error);
        console.log(`[task] timeout channel=${channelId} consecutiveFailures=${failures ?? '-'} error=${detail}`);
      } else {
        progress.clearStall();
        if (this.#markTerminal(run, STATE.FAILED)) progress.setState(STATE.FAILED, 'Agent 执行失败');
        const failures = this.limits?.noteFailure(channelId, error);
        console.log(`[task] failed channel=${channelId} consecutiveFailures=${failures ?? '-'} error=${detail}`);
      }
      await editor.flushNow(`${progress.render()}\n\n\`\`\`\n${clip(detail, 900)}\n\`\`\``, []);
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
    const receivedAt = Date.now();
    const isButton = typeof interaction.isButton === 'function' && interaction.isButton();
    const isModal = typeof interaction.isModalSubmit === 'function' && interaction.isModalSubmit();
    const isCommand = typeof interaction.isChatInputCommand === 'function' && interaction.isChatInputCommand();
    if (!isButton && !isModal && !isCommand) return;
    // Every panel/render/selection/command interaction is OWNER-only. Rendering
    // and selection interactions never call ChatRuntime or start an Agent.
    if (interaction.user.id !== this.config.ownerId) {
      await this.#ephemeral(interaction, '无权执行此操作。');
      return;
    }
    const label = this.#interactionLabel(interaction);
    const parts = String(interaction.customId ?? '').split(':');
    const prefix = parts[0];
    const id = parts[1];
    const action = parts[2];
    const channelId = interaction.channelId || interaction.message?.channelId;

    // These three respond by showing a Modal, which is its own immediate ACK
    // and cannot follow a defer. A rejected modal must NOT create a Work thread.
    if (isCommand && interaction.commandName === 'work') {
      const task = typeof interaction.options?.getString === 'function' ? interaction.options.getString('task') : null;
      if (!task || !String(task).trim()) {
        const modalAck = await this.#showModalAck(interaction, this.#newWorkModal(), { label, receivedAt });
        if (!modalAck.ok) this.#abortAfterFailedAck(label, modalAck, 'showModal (new Work)');
        return;
      }
    }
    if (isButton && prefix === 'panel' && id === 'newwork') {
      const modalAck = await this.#showModalAck(interaction, this.#newWorkModal(), { label, receivedAt });
      if (!modalAck.ok) this.#abortAfterFailedAck(label, modalAck, 'showModal (panel new Work)');
      return;
    }
    if (isButton && prefix === 'workctl' && id === 'append') {
      const run = this.workRuns.get(action);
      const chain = run ? this.workChains.get(run.channelId) : null;
      if (!run || !chain || chain.activeRunId !== action) {
        await this.#ephemeral(interaction, '该任务已结束。');
        return;
      }
      const modalAck = await this.#showModalAck(interaction, this.#appendModal(action), { label, receivedAt });
      if (!modalAck.ok) this.#abortAfterFailedAck(label, modalAck, 'showModal (append follow-up)');
      return;
    }

    // Immediate ACK before thread create / filesystem / Agent start / provider
    // check / workspace queue / network. A failed ACK aborts the interaction:
    // no thread, no Agent, no filesystem side effect.
    const ack = await this.#acknowledge(interaction, { label, receivedAt });
    if (!ack.ok) {
      this.#abortAfterFailedAck(label, ack, 'defer');
      return;
    }
    if (isCommand) { await this.#handleApplicationCommand(interaction); return; }
    if (isModal) { await this.#handleModalSubmit(interaction, parts); return; }
    if (prefix === 'panel') {
      await this.#handlePanelInteraction(interaction, id, channelId);
      return;
    }
    if (prefix === 'panelmodels') {
      await this.#edit(interaction, id === 'chat' ? this.#chatModelMenu(channelId) : this.#workModelMenu(channelId));
      return;
    }
    if (prefix === 'panelchat') {
      if (id === 'auto') {
        await this.#applyChatSelection(channelId, { providerId: 'auto', model: null });
        await this.#edit(interaction, this.#chatModelMenu(channelId));
        return;
      }
      await this.#edit(interaction, this.#chatModelMenu(channelId));
      return;
    }
    if (prefix === 'panelchatpnav') {
      await this.#edit(interaction, this.#chatModelMenu(channelId, Number(id) || 1));
      return;
    }
    if (prefix === 'panelchatp') {
      await this.#edit(interaction, await this.#chatProviderModels(channelId, parts.slice(1).join(':')));
      return;
    }
    if (prefix === 'panelchatmnav') {
      await this.#edit(interaction, await this.#chatProviderModels(channelId, parts[1], Number(parts[2]) || 1));
      return;
    }
    if (prefix === 'panelchatm') {
      const providerId = parts[1];
      const modelId = parts.slice(2).join(':');
      const result = await this.#applyChatSelection(channelId, { providerId, model: modelId });
      await this.#edit(interaction, result.ok
        ? {
          content: `✅ Chat 模型已固定为 \`${providerId} / ${modelId}\`（不会自动回退）。`,
          components: [panelBackRow()],
        }
        : { content: clip(result.message), components: [panelBackRow()] });
      return;
    }
    if (prefix === 'panelworkpnav') {
      await this.#edit(interaction, this.#workModelMenu(channelId, Number(id) || 1));
      return;
    }
    if (prefix === 'panelworkp') {
      const providerId = parts.slice(1).join(':');
      const switched = await this.#switchProvider(channelId, providerId);
      const models = await this.#workProviderModels(channelId, providerId);
      await this.#edit(interaction, { ...models, content: clip(`${switched}\n\n${models.content}`) });
      return;
    }
    if (prefix === 'panelworkmnav') {
      await this.#edit(interaction, await this.#workProviderModels(channelId, parts[1], Number(parts[2]) || 1));
      return;
    }
    if (prefix === 'panelworkm') {
      const providerId = parts[1];
      const modelId = parts.slice(2).join(':');
      const state = this.sessionManager.get(channelId);
      if (state.providerId !== providerId) {
        await this.#edit(interaction, { content: '❌ Provider 已变化，请重新选择。', components: [panelBackRow()] });
        return;
      }
      const result = await this.#selectModel(channelId, modelId);
      await this.#edit(interaction, { content: clip(result), components: [panelBackRow()] });
      return;
    }
    if (prefix === 'workctl') {
      // `id` is the action, `action` holds the run id. `append` was handled
      // before the ACK because it responds with a Modal.
      const runId = action;
      const run = this.workRuns.get(runId);
      const chain = run ? this.workChains.get(run.channelId) : null;
      const live = Boolean(run && chain && chain.activeRunId === runId);
      if (!live || id !== 'stop') {
        await this.#ephemeral(interaction, '该任务已结束。');
        return;
      }
      // Pass the card's run id so a stale Stop can never target a newer run.
      const text = await this.#stopChannel(run.channelId, { runId });
      // Clear the card controls; the outcome goes out as an ephemeral follow-up
      // so the terminal progress repaint cannot hide it.
      const base = interaction.message?.content ?? '';
      await this.#edit(interaction, { content: base, components: [] }).catch(() => {});
      await interaction.followUp({ content: clip(text), ephemeral: true }).catch(() => {});
      return;
    }
    if (prefix === 'set') {
      if (id === 'chatauto') {
        await this.#applyChatSelection(channelId, { providerId: 'auto', model: null });
        await this.#edit(interaction, this.#settingsPanel(channelId));
        return;
      }
      if (id === 'permission') {
        await this.#edit(interaction, this.#permissionMenu(channelId));
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
        await this.#edit(interaction, rows
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
        await this.#edit(interaction, rows
          ? { content: '🌐 选择 Provider', components: [...rows, settingsBackRow()] }
          : { content: this.#providersText(channelId), components: [settingsBackRow()] });
        return;
      }
      if (id === 'model') {
        await this.#edit(interaction, this.#settingsModelMenu(channelId));
        return;
      }
      if (id === 'reset') {
        // Destructive: show an explicit confirmation instead of resetting on one
        // accidental click.
        await this.#edit(interaction, { content: clip(this.#resetConfirmationText()), components: [resetConfirmButtons()] });
        return;
      }
      // refresh / back / unknown
      await this.#edit(interaction, this.#settingsPanel(channelId));
      return;
    }
    if (prefix === 'setreset') {
      if (id === 'cancel') {
        await this.#edit(interaction, { content: '已取消初始化，设置未改变。', components: [settingsBackRow()] });
        return;
      }
      if (id === 'confirm') {
        const result = await this.#factoryReset();
        await this.#edit(interaction, result.ok
          ? {
            content: clip(`${result.message}\n\n${this.#settingsPanel(channelId).content}`),
            components: settingsButtons({ workThread: this.#isWorkThread(channelId) }),
          }
          : { content: clip(result.message), components: [settingsBackRow()] });
        return;
      }
      return;
    }
    if (prefix === 'setmodelnav') {
      await this.#edit(interaction, this.#settingsModelMenu(channelId, Number(id) || 1));
      return;
    }
    if (prefix === 'setexec' || prefix === 'setprov' || prefix === 'setmodel') {
      const result = prefix === 'setexec'
        ? await this.#switchExecutor(channelId, id)
        : prefix === 'setprov'
          ? await this.#switchProvider(channelId, id)
          : await this.#selectModel(channelId, id);
      await this.#edit(interaction, {
        content: clip(`${result}\n\n${this.#settingsPanel(channelId).content}`),
        components: settingsButtons({ workThread: this.#isWorkThread(channelId) }),
      });
      return;
    }
    if (prefix === 'cfg') {
      if (id === 'executor') await this.#edit(interaction, { content: this.#executorText(channelId), components: [] });
      else if (id === 'provider') await this.#edit(interaction, { content: this.#providersText(channelId), components: [] });
      else if (id === 'model') await this.#edit(interaction, await this.#modelsPayload(channelId));
      else if (id === 'permission') await this.#edit(interaction, this.#permissionMenu(channelId));
      return;
    }
    if (prefix === 'models') {
      await this.#edit(interaction, await this.#modelsPayload(channelId, id));
      return;
    }
    if (prefix === 'apiproto') {
      const pending = this.apiOnboarding.get(channelId);
      if (!pending?.credentialRef) {
        await this.#ephemeral(interaction, 'API 添加请求已过期。');
        return;
      }
      try {
        const added = await this.providerManager.completePending(pending, id);
        this.apiOnboarding.delete(channelId);
        await this.#edit(interaction, this.#providerAdded(channelId, added, pending.deleted));
      } catch (error) {
        this.apiOnboarding.delete(channelId);
        await this.#edit(interaction, {
          content: `${providerErrorMessage(error)}${pending.deleted ? '' : '\n⚠️ Discord 未允许删除原消息，请立即手动删除。'}`,
          components: [],
        });
      }
      return;
    }
    if (prefix === 'apiuse') {
      await this.#edit(interaction, { content: await this.#switchProvider(channelId, id), components: [] });
      return;
    }
    if (prefix === 'apimodel') {
      await this.#edit(interaction, await this.#modelsPayload(channelId, 1, id));
      return;
    }
    if (prefix === 'perm') {
      if (id === 'menu') {
        await this.#edit(interaction, this.#permissionMenu(interaction.message.channelId));
        return;
      }
      if (!Object.values(LEVEL).includes(id)) return;
      const result = await this.#switchPermission(interaction.message.channelId, id);
      if (result.confirmation) {
        await this.#edit(interaction, {
          content: '⚠️ **全开放模式**\n\n普通工具调用将自动允许。OWNER 校验、凭据保护、超时、停止和后端校验仍然有效。',
          components: [fullConfirmationButtons()],
        });
        return;
      }
      await this.#edit(interaction, { content: `🔐 当前权限：${PERM_SHORT[result.current]}`, components: [permissionButtons()] });
      return;
    }
    if (prefix === 'permfull') {
      if (id === 'cancel') {
        await this.#edit(interaction, { content: `已取消。\n🔐 当前权限：${PERM_SHORT[this.permissionManager.getLevel(interaction.message.channelId)]}`, components: [permissionButtons()] });
        return;
      }
      if (id === 'confirm') {
        const result = await this.#switchPermission(interaction.message.channelId, LEVEL.FULL, { confirmed: true });
        await this.#edit(interaction, { content: `🔐 当前权限：${PERM_SHORT[result.current]}`, components: [permissionButtons()] });
      }
      return;
    }
    if (prefix !== 'ap') return;
    const ok = this.approvalManager.resolve(id, action);
    if (!ok) {
      await this.#ephemeral(interaction, '审批请求已过期或已处理。');
      return;
    }
    const decisionLabel = { 'allow-once': APPROVAL_BUTTONS.ALLOW_ONCE, 'allow-session': APPROVAL_BUTTONS.ALLOW_SESSION, deny: APPROVAL_BUTTONS.DENY }[action] || action;
    await this.#edit(interaction, {
      content: clip(`${interaction.message.content}\n\n**处理结果：${decisionLabel}** — <@${interaction.user.id}>`),
      components: [],
    });
  }
}
