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
import { TaskProgress, ThrottledEditor, STATE, describeToolCall } from './progress.mjs';
import { describeRouting } from './win-env.mjs';

const DISCORD_LIMIT = 1900;

function clip(text, n = DISCORD_LIMIT) {
  const s = String(text ?? '');
  return s.length <= n ? s : `${s.slice(0, n - 20)}\n…(truncated)`;
}

export class DiscordControlPlane {
  constructor({
    config,
    state,
    approvalManager,
    routing = { env: {}, source: 'process-env', added: [] },
    logger = null,
    // Injectable so the whole control plane can be driven without a live
    // Discord connection (tests + the pre-token end-to-end smoke).
    client = null,
    autoLogin = true,
  }) {
    this.config = config;
    this.state = state;
    this.approvalManager = approvalManager;
    this.routing = routing;
    this.logger = logger;
    this.autoLogin = autoLogin;
    this.runners = new Map();
    this.tasks = new Map();
    this.channelBySession = new Map();
    this.client = client || new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });
  }

  async start() {
    this.approvalManager.setPresenter((req) => this.presentApproval(req));
    this.approvalManager.setSettledHandler(({ answer, meta }) => this.onApprovalSettled(answer, meta));
    this.client.on('messageCreate', (m) => this.onMessage(m).catch((e) => console.error('[discord] message handler', e)));
    this.client.on('interactionCreate', (i) => this.onInteraction(i).catch((e) => console.error('[discord] interaction handler', e)));
    if (this.autoLogin) await this.client.login(this.config.discordToken);
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
      extraEnv: this.routing.env,
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
    }
    if (event.type === 'model') {
      const chState = this.state.getChannel(channelId, this.config.defaultCwd);
      if (chState.model !== event.model) this.state.patchChannel(channelId, { model: event.model }, this.config.defaultCwd);
    }

    const task = this.tasks.get(channelId);
    if (!task) return;
    if (event.type === 'tool') {
      task.progress.recordTool(event.tool);
      task.schedule();
    } else if (event.type === 'text') {
      task.progress.recordText(event.text);
      task.schedule();
    }
  }

  #statusLine(channelId) {
    const s = this.state.getChannel(channelId, this.config.defaultCwd);
    const runner = this.runners.get(channelId);
    const routing = describeRouting({ ...process.env, ...this.routing.env });
    return [
      `cwd: \`${s.cwd}\``,
      `session: \`${s.sessionId || 'new'}\``,
      `executor: \`${this.config.claudeCommand}\``,
      `backend: \`${routing.base}\``,
      `model: \`${runner?.model || s.model || routing.model}\``,
      `routing source: \`${this.routing.source}\``,
      `state: ${runner?.busy ? 'busy' : 'idle'}`,
      `pending approvals: ${this.approvalManager.pending.size}`,
    ].join('\n');
  }

  async onMessage(message) {
    if (!this.allowedMessage(message)) return;
    const text = message.content.trim();
    if (!text) return;

    if (text === '!help') {
      await message.reply([
        '**Commands**',
        '`!status` — cwd / session / executor / routing',
        '`!cwd <absolute path>` — bind this channel to a project',
        '`!stop` — kill the running agent process',
        '`!reset` — stop + clear Claude session and session approvals',
        '`!handoff` — print a compact handoff package',
        '',
        'Anything else is sent to the local agent as a task.',
      ].join('\n'));
      return;
    }
    if (text === '!status') {
      await message.reply(clip(this.#statusLine(message.channelId)));
      return;
    }
    if (text === '!stop') {
      const runner = this.runners.get(message.channelId);
      const sessionId = this.state.getChannel(message.channelId, this.config.defaultCwd).sessionId;
      const cancelled = this.approvalManager.cancelForSession(sessionId, 'stopped from Discord');
      if (runner) await runner.stop();
      this.runners.delete(message.channelId);
      const task = this.tasks.get(message.channelId);
      if (task) {
        task.progress.setState(STATE.FAILED, 'stopped by owner');
        await task.finish();
      }
      await message.reply(`Stopped the local agent process. Cancelled ${cancelled} pending approval(s).`);
      return;
    }
    if (text === '!reset') {
      const runner = this.runners.get(message.channelId);
      const sessionId = this.state.getChannel(message.channelId, this.config.defaultCwd).sessionId;
      if (runner) await runner.stop();
      this.runners.delete(message.channelId);
      this.approvalManager.cancelForSession(sessionId, 'session reset');
      this.approvalManager.clearSessionAllows(sessionId);
      if (sessionId) this.channelBySession.delete(sessionId);
      this.state.patchChannel(message.channelId, { sessionId: null }, this.config.defaultCwd);
      await message.reply('Session reset. Next task starts a fresh Claude session.');
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
        `最近错误: ${runner?.lastError?.message || '-'}`,
        '需要判断: <填写>',
        '```',
      ];
      await message.reply(clip(lines.join('\n')));
      return;
    }
    if (text.startsWith('!cwd ')) {
      const requested = text.slice(5).trim().replace(/^"(.*)"$/s, '$1');
      if (!path.isAbsolute(requested) || !fs.existsSync(requested)) {
        await message.reply('Path must be an existing absolute path on the Windows machine running the bridge.');
        return;
      }
      const old = this.runners.get(message.channelId);
      if (old) await old.stop();
      this.runners.delete(message.channelId);
      this.state.patchChannel(message.channelId, { cwd: requested, sessionId: null, model: null }, this.config.defaultCwd);
      await message.reply(`Bound this Discord channel to \`${requested}\`.\nSession cleared so the previous project's context cannot leak in.`);
      return;
    }

    if (this.tasks.has(message.channelId) || this.runners.get(message.channelId)?.busy) {
      await message.reply('A task is already running in this channel. Use `!stop` first.');
      return;
    }

    await this.runTask(message, text);
  }

  async runTask(message, prompt) {
    const channelId = message.channelId;
    const chState = this.state.getChannel(channelId, this.config.defaultCwd);

    const progress = new TaskProgress({ cwd: chState.cwd });
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
      schedule: () => editor.submit(progress.render()),
      finish: async () => {
        editor.dispose();
        runLog.close();
        this.tasks.delete(channelId);
      },
    };
    this.tasks.set(channelId, task);

    const runner = this.getRunner(channelId);
    if (runner.sessionId) this.channelBySession.set(runner.sessionId, channelId);
    progress.setState(STATE.PLANNING);

    try {
      const result = await runner.send(prompt);
      progress.recordText(result.text);
      progress.setState(result.isError ? STATE.FAILED : STATE.DONE);
      if (result.sessionId) {
        this.state.patchChannel(channelId, { sessionId: result.sessionId }, this.config.defaultCwd);
        this.channelBySession.set(result.sessionId, channelId);
      }
      const extras = [
        result.costUsd != null ? `Cost: $${result.costUsd.toFixed(4)}` : null,
        runLog.path ? `Log: \`${path.basename(runLog.path)}\`` : null,
      ].filter(Boolean).join(' · ');
      // progress.render() already carries the state, project, last action, test
      // result and tool histogram — reuse it instead of rebuilding the summary.
      const body = [
        progress.render(),
        extras || null,
        '',
        clip(result.text || '(no final text)', 1200),
      ].filter((line) => line !== null).join('\n');
      await editor.flushNow(body);
    } catch (error) {
      progress.setState(STATE.FAILED, 'agent process failed');
      const detail = String(error?.message || error);
      await editor.flushNow(`${progress.render()}\n\n\`\`\`\n${clip(detail, 900)}\n\`\`\``);
    } finally {
      await task.finish();
    }
  }

  async presentApproval(req) {
    const channelId = this.channelBySession.get(req.sessionId) || req.channelId || null;
    const task = channelId ? this.tasks.get(channelId) : null;
    if (task) {
      task.progress.setApproval(req);
      await task.editor.flushNow(task.progress.render());
    }

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ap:${req.id}:allow-once`).setLabel('Allow once').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`ap:${req.id}:allow-session`).setLabel('Allow session').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`ap:${req.id}:deny`).setLabel('Deny').setStyle(ButtonStyle.Danger),
    );

    const body = [
      '🔐 **Agent requests permission**',
      `Tool: **${req.toolName}**`,
      `Project: \`${req.cwd}\``,
      `Reason: ${req.reason}`,
      '',
      '```json',
      clip(JSON.stringify(req.toolInput ?? {}, null, 2), 700),
      '```',
    ].join('\n');

    const target = channelId ? await this.client.channels.fetch(channelId).catch(() => null) : null;
    const message = target?.isTextBased?.()
      ? await target.send({ content: body, components: [buttons] })
      : await (await this.client.users.fetch(this.config.ownerId)).send({ content: body, components: [buttons] });
    return message;
  }

  onApprovalSettled(answer, meta) {
    const channelId = this.channelBySession.get(meta.sessionId) || null;
    const task = channelId ? this.tasks.get(channelId) : null;
    if (!task) return;
    task.progress.clearApproval(answer.decision === 'allow' ? 'allowed' : 'denied');
    task.editor.submit(task.progress.render());
  }

  async onInteraction(interaction) {
    if (!interaction.isButton()) return;
    if (interaction.user.id !== this.config.ownerId) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true });
      return;
    }
    const [prefix, id, action] = interaction.customId.split(':');
    if (prefix !== 'ap') return;
    const ok = this.approvalManager.resolve(id, action);
    if (!ok) {
      await interaction.reply({ content: 'Approval request expired or already handled.', ephemeral: true });
      return;
    }
    const label = { 'allow-once': '✅ Allow once', 'allow-session': '✅ Allow session', deny: '⛔ Deny' }[action] || action;
    await interaction.update({
      content: clip(`${interaction.message.content}\n\n**Decision: ${label}** — by <@${interaction.user.id}>`),
      components: [],
    });
  }
}
