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
    this.extraEnv = extraEnv;
    this.envUnset = envUnset;
    this.autoLogin = autoLogin;
    this.runners = new Map();
    this.tasks = new Map();
    this.channelBySession = new Map();
    this.backendVerdictByChannel = new Map();
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
    this.client.on('messageCreate', (m) => this.onMessage(m).catch((e) => console.error('[discord] message handler', e)));
    this.client.on('interactionCreate', (i) => this.onInteraction(i).catch((e) => console.error('[discord] interaction handler', e)));
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
    const permLabel = PERM_SHORT[this.permissionManager.getLevel(null)] || PERM_SHORT.standard;
    const text = readyText({
      backend: backend?.label ?? 'unknown',
      model: backend?.model ?? 'unknown',
      billingRoute: backend ? billingRoute(backend) : 'unknown',
      paidFallback: this.config.allowPaidFallback,
      defaultCwd: this.config.defaultCwd,
      permissionLabel: permLabel,
    });
    try { await owner.send(text); } catch (error) { console.warn(`[discord] could not send the ready DM: ${error?.message}`); }
  }

  allowedMessage(message) {
    if (message.author?.bot) return false;
    if (message.author?.id !== this.config.ownerId) return false;
    if (!message.guildId) return true;
    if (this.config.guildId && message.guildId !== this.config.guildId) return false;
    if (this.config.channelId && message.channelId !== this.config.channelId) return false;
    return true;
  }

  getRunner(channelId) {
    const existing = this.runners.get(channelId);
    if (existing) return existing;

    const chState = this.state.getChannel(channelId, this.config.defaultCwd);
    const runner = new ClaudeRunner({
      command: this.config.claudeCommand,
      cwd: chState.cwd,
      sessionId: chState.sessionId,
      includePartialMessages: this.config.includePartialMessages,
      extraEnv: this.extraEnv,
      envUnset: this.envUnset,
      onLog: (entry) => this.tasks.get(channelId)?.runLog?.log(entry),
      onEvent: (e) => this.onRunnerEvent(channelId, e),
      onExit: () => this.runners.delete(channelId),
    });
    this.runners.set(channelId, runner);
    return runner;
  }

  onRunnerEvent(channelId, event) {
    if (event.type === 'session') {
      this.state.patchChannel(channelId, { sessionId: event.sessionId }, this.config.defaultCwd);
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
    const s = this.state.getChannel(channelId, this.config.defaultCwd);
    const runner = this.runners.get(channelId);
    const backend = this.backendState?.backend ?? null;
    const blocked = this.limits?.blocked(channelId);
    const permLabel = PERM_SHORT[this.permissionManager.getLevel(channelId)] || PERM_SHORT.standard;
    return formatStatus({
      executor: this.config.claudeCommand,
      backend: backend?.label ?? 'unknown',
      model: runner?.model || s.model || backend?.model || 'unknown',
      billingRoute: backend ? billingRoute(backend) : 'unknown',
      paidFallback: this.config.allowPaidFallback,
      apiKeySource: backend?.apiKeySource ?? 'unknown',
      cwd: s.cwd,
      sessionId: s.sessionId,
      state: runner?.busy ? '忙碌' : '空闲',
      idleSec: runner?.busy ? Math.round((runner.idleMs ?? 0) / 1000) : null,
      pendingApprovals: this.approvalManager.pending.size,
      permissionLabel: permLabel,
      blocked: blocked?.blocked ? blocked.reason : null,
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

  async onMessage(message) {
    if (!this.allowedMessage(message)) return;
    const text = message.content.trim();
    if (!text) return;

    if (text === '!help') {
      await message.reply(helpText());
      return;
    }
    if (text === '!status') {
      await message.reply({ content: clip(this.#statusLine(message.channelId)), components: [permissionMenuButton()] });
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
      const cancelled = this.approvalManager.cancelForSession(sessionId, 'stopped from Discord');
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
      const sessionId = this.state.getChannel(message.channelId, this.config.defaultCwd).sessionId;
      if (task) task.cancelled = true;
      if (runner) await runner.stop({ reason: 'session reset (!reset)' });
      this.runners.delete(message.channelId);
      if (task) await task.finish();
      this.approvalManager.cancelForSession(sessionId, 'session reset');
      this.approvalManager.clearSessionAllows(sessionId);
      if (sessionId) this.channelBySession.delete(sessionId);
      this.permissionManager.reset(message.channelId, 'reset');
      this.limits?.reset(message.channelId);
      this.backendVerdictByChannel.delete(message.channelId);
      this.state.patchChannel(message.channelId, { sessionId: null }, this.config.defaultCwd);
      await message.reply('✅ 会话已重置。下一个任务将使用新会话，权限已恢复为 🛡️ 标准，失败/重启计数已清零。');
      return;
    }
    if (text === '!handoff') {
      const s = this.state.getChannel(message.channelId, this.config.defaultCwd);
      const runner = this.runners.get(message.channelId);
      const last = this.tasks.get(message.channelId);
      const lines = [
        '```text',
        `目标: <填写>`,
        `项目: ${s.cwd}`,
        `执行器: ${this.config.claudeCommand} (${runner?.model || 'unknown model'})`,
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
      const oldSessionId = this.state.getChannel(message.channelId, this.config.defaultCwd).sessionId;
      const old = this.runners.get(message.channelId);
      if (old) await old.stop();
      this.runners.delete(message.channelId);
      this.approvalManager.cancelForSession(oldSessionId, 'project changed');
      this.approvalManager.clearSessionAllows(oldSessionId);
      if (oldSessionId) this.channelBySession.delete(oldSessionId);
      this.permissionManager.reset(message.channelId, 'cwd');
      this.state.patchChannel(message.channelId, { cwd: requested, sessionId: null, model: null }, this.config.defaultCwd);
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
    const chState = this.state.getChannel(channelId, this.config.defaultCwd);

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

    const runner = this.getRunner(channelId);
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
    console.log(`[approval] requested tool=${req.toolName} rule=${req.ruleKey} channel=${channelId || 'dm'} reason=${clip(req.reason, 80)}`);

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
    console.log(`[approval] resolved decision=${answer.decision} rule=${meta.ruleKey} reason=${answer.reason}`);
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
