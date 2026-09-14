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

function clip(text, n = 1500) {
  const s = String(text || '');
  return s.length <= n ? s : s.slice(0, n - 20) + '\n…(truncated)';
}

function formatTool(toolName, toolInput) {
  const raw = JSON.stringify(toolInput ?? {});
  return `**${toolName}**\n\`\`\`json\n${clip(raw, 900)}\n\`\`\``;
}

export class DiscordControlPlane {
  constructor({ config, state, approvalManager }) {
    this.config = config;
    this.state = state;
    this.approvalManager = approvalManager;
    this.runners = new Map();
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
      partials: [Partials.Channel],
    });
  }

  async start() {
    this.approvalManager.setPresenter((req) => this.presentApproval(req));
    this.client.on('messageCreate', (m) => this.onMessage(m));
    this.client.on('interactionCreate', (i) => this.onInteraction(i));
    await this.client.login(this.config.discordToken);
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
    if (this.runners.has(channelId)) return this.runners.get(channelId);
    const chState = this.state.getChannel(channelId, this.config.defaultCwd);
    const runner = new ClaudeRunner({
      command: this.config.claudeCommand,
      cwd: chState.cwd,
      sessionId: chState.sessionId,
      onEvent: (e) => {
        if (e.type === 'session') this.state.patchChannel(channelId, { sessionId: e.sessionId }, this.config.defaultCwd);
      },
      onExit: () => this.runners.delete(channelId),
    });
    this.runners.set(channelId, runner);
    return runner;
  }

  async onMessage(message) {
    if (!this.allowedMessage(message)) return;
    const text = message.content.trim();
    if (!text) return;

    if (text === '!status') {
      const s = this.state.getChannel(message.channelId, this.config.defaultCwd);
      await message.reply(`cwd: \`${s.cwd}\`\nsession: \`${s.sessionId || 'new'}\`\nbackend: DeepSeek via your existing Claude Code environment`);
      return;
    }
    if (text === '!stop') {
      const r = this.runners.get(message.channelId);
      if (r) await r.stop();
      this.runners.delete(message.channelId);
      await message.reply('Stopped current local agent process.');
      return;
    }
    if (text === '!reset') {
      const r = this.runners.get(message.channelId);
      if (r) await r.stop();
      this.runners.delete(message.channelId);
      this.state.patchChannel(message.channelId, { sessionId: null }, this.config.defaultCwd);
      await message.reply('Session reset.');
      return;
    }
    if (text.startsWith('!cwd ')) {
      const requested = text.slice(5).trim().replace(/^"|"$/g, '');
      if (!path.isAbsolute(requested) || !fs.existsSync(requested)) {
        await message.reply('Path must be an existing absolute path on the Windows machine running the bridge.');
        return;
      }
      const old = this.runners.get(message.channelId);
      if (old) await old.stop();
      this.runners.delete(message.channelId);
      this.state.patchChannel(message.channelId, { cwd: requested, sessionId: null }, this.config.defaultCwd);
      await message.reply(`Bound this Discord channel to \`${requested}\`.`);
      return;
    }

    const status = await message.reply('⏳ Agent started…');
    const runner = this.getRunner(message.channelId);
    const progress = [];
    let scheduled = null;
    const originalHandler = runner.onEvent;
    runner.onEvent = (e) => {
      originalHandler(e);
      if (e.type === 'tool') progress.push(`🔧 ${e.tool.name} ${clip(JSON.stringify(e.tool.input), 250)}`);
      if (e.type === 'stderr') progress.push(`⚠️ ${clip(e.text, 250)}`);
      if (progress.length > 8) progress.splice(0, progress.length - 8);
      if (!scheduled) {
        scheduled = setTimeout(async () => {
          scheduled = null;
          try { await status.edit(`⏳ Working…\n${clip(progress.join('\n'), 1700)}`); } catch {}
        }, 900);
      }
    };

    try {
      const result = await runner.send(text);
      if (scheduled) clearTimeout(scheduled);
      const finalText = result.text || '(task completed with no final text)';
      await status.edit(`✅ Done in ${(result.durationMs / 1000).toFixed(1)}s\n${clip(finalText, 1700)}`);
      this.state.patchChannel(message.channelId, { sessionId: result.sessionId }, this.config.defaultCwd);
    } catch (error) {
      if (scheduled) clearTimeout(scheduled);
      await status.edit(`❌ Agent failed\n${clip(error?.stack || error, 1700)}`);
    } finally {
      runner.onEvent = originalHandler;
    }
  }

  async presentApproval(req) {
    const user = await this.client.users.fetch(this.config.ownerId);
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ap:${req.id}:allow-once`).setLabel('Allow once').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`ap:${req.id}:allow-session`).setLabel('Allow session').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`ap:${req.id}:deny`).setLabel('Deny').setStyle(ButtonStyle.Danger),
    );
    await user.send({
      content: `🔐 **Approval required**\nReason: ${req.reason}\nCWD: \`${req.cwd}\`\n${formatTool(req.toolName, req.toolInput)}`,
      components: [buttons],
    });
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
    await interaction.update({ content: `${interaction.message.content}\n\nDecision: **${action}**`, components: [] });
  }
}
