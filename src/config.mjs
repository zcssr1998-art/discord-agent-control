import 'dotenv/config';
import path from 'node:path';

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function int(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig() {
  const required = ['DISCORD_TOKEN', 'DISCORD_OWNER_ID'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing required env: ${missing.join(', ')}`);

  return {
    discordToken: process.env.DISCORD_TOKEN,
    ownerId: process.env.DISCORD_OWNER_ID,
    guildId: process.env.DISCORD_GUILD_ID || null,
    channelId: process.env.DISCORD_CHANNEL_ID || null,
    claudeCommand: process.env.CLAUDE_COMMAND || 'claude',
    defaultCwd: path.resolve(process.env.DEFAULT_CWD || process.cwd()),
    approvalHost: process.env.APPROVAL_HOST || '127.0.0.1',
    approvalPort: int('APPROVAL_PORT', 37911),
    approvalTimeoutMs: int('APPROVAL_TIMEOUT_MS', 540000),
    autoAllowWorkspaceWrites: bool('AUTO_ALLOW_WORKSPACE_WRITES', true),
    autoAllowTestCommands: bool('AUTO_ALLOW_TEST_COMMANDS', true),
    // `--include-partial-messages` mostly emits thinking-token noise; off by default.
    includePartialMessages: bool('CLAUDE_PARTIAL_MESSAGES', false),
    // Minimum gap between edits of the single live Discord status message.
    progressThrottleMs: int('PROGRESS_THROTTLE_MS', 1500),
    logDir: process.env.LOG_DIR || null,
  };
}
