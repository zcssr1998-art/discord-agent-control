import 'dotenv/config';
import path from 'node:path';
import { resolveWorkbuddyCli, WORKBUDDY_COMMAND_KEYWORD } from './backend.mjs';

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function int(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * `CLAUDE_COMMAND=workbuddy` selects the bundled WorkBuddy agent CLI without
 * hardcoding a machine-specific path in the repository.
 */
function resolveExecutor(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value === WORKBUDDY_COMMAND_KEYWORD) {
    const cli = resolveWorkbuddyCli();
    if (cli) return cli;
    if (value === WORKBUDDY_COMMAND_KEYWORD) {
      throw new Error(
        'CLAUDE_COMMAND=workbuddy but the WorkBuddy CLI could not be found. '
        + 'Set WORKBUDDY_CLI to the full path of cli/dist/codebuddy.js, or set CLAUDE_COMMAND explicitly.',
      );
    }
  }
  return value || 'claude';
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
    claudeCommand: resolveExecutor(process.env.CLAUDE_COMMAND),
    defaultCwd: path.resolve(process.env.DEFAULT_CWD || process.cwd()),
    // The default Agent task directory, resolved without ever relying on the
    // process cwd: DEFAULT_WORKSPACE → DEFAULT_CWD → repo root (set by index.mjs).
    defaultWorkspace: process.env.DEFAULT_WORKSPACE
      ? path.resolve(process.env.DEFAULT_WORKSPACE)
      : (process.env.DEFAULT_CWD ? path.resolve(process.env.DEFAULT_CWD) : null),
    // Set by index.mjs to the actual checkout root; the last-resort fallback.
    repoRoot: process.env.JARVIS_REPO_ROOT ? path.resolve(process.env.JARVIS_REPO_ROOT) : null,
    // Explicit proxy for Discord, or null to fall back to the Windows system
    // proxy (see win-env.resolveDiscordProxy). 'off' disables both.
    discordProxy: process.env.DISCORD_PROXY ?? null,
    approvalHost: process.env.APPROVAL_HOST || '127.0.0.1',
    approvalPort: int('APPROVAL_PORT', 37911),
    approvalTimeoutMs: int('APPROVAL_TIMEOUT_MS', 540000),
    // Keep the user-level agent hook pointing at this checkout on every start.
    // Disable with DISCORD_AUTO_HOOK=0 (e.g. test harnesses).
    autoInstallHook: bool('DISCORD_AUTO_HOOK', true),
    autoAllowWorkspaceWrites: bool('AUTO_ALLOW_WORKSPACE_WRITES', true),
    autoAllowTestCommands: bool('AUTO_ALLOW_TEST_COMMANDS', true),
    // `--include-partial-messages` mostly emits thinking-token noise; off by default.
    includePartialMessages: bool('CLAUDE_PARTIAL_MESSAGES', false),
    // Minimum gap between edits of the single live Discord status message.
    progressThrottleMs: int('PROGRESS_THROTTLE_MS', 1500),
    // DM the owner once when the bridge comes online.
    notifyOnStart: bool('NOTIFY_ON_START', true),
    logDir: process.env.LOG_DIR || null,

    // --- agent backend ---------------------------------------------------
    // The expected backend id (see src/backend.mjs). The bridge refuses to run
    // on anything else unless paid fallback is explicitly enabled.
    agentBackend: process.env.AGENT_BACKEND || 'workbuddy-free-dsf',
    allowPaidFallback: bool('ALLOW_PAID_FALLBACK', false),

    // --- chat (direct model API) -----------------------------------------
    // AUTO must never silently spend on METERED/unknown-billing providers. This
    // only enables those as a *last* AUTO candidate; a manual pin still works.
    allowMeteredChatFallback: bool('ALLOW_METERED_CHAT_FALLBACK', false),
    // Optional image-capable route for AUTO image turns. Without it, an AUTO
    // image turn fails clearly instead of being sent to a text-only alias.
    chatVisionProviderId: process.env.CHAT_VISION_PROVIDER_ID || null,
    chatVisionModel: process.env.CHAT_VISION_MODEL || null,
    // Optional explicit default Work model for a workspace that has never
    // selected one. Never inferred from a provider's model list.
    defaultWorkModel: process.env.DEFAULT_WORK_MODEL || process.env.JARVIS_DEFAULT_WORK_MODEL || null,
    // Wall-clock cap on one direct Chat request.
    chatTimeoutMs: int('CHAT_TIMEOUT_MS', 25000),

    // --- native Discord application commands (P2.1) -----------------------
    // Register the /-commands idempotently at startup (best effort).
    autoRegisterCommands: bool('DISCORD_AUTO_REGISTER_COMMANDS', true),
    // Optional guild-scoped registration for instant propagation during
    // development; null keeps production registration global. Never hard-coded.
    commandsGuildId: process.env.DISCORD_COMMANDS_GUILD_ID || null,

    // --- interactive Work follow-ups (P2.1) -------------------------------
    // Pending appended requirements per active Work chain.
    maxWorkFollowUps: int('MAX_WORK_FOLLOWUPS', 10),

    // --- runaway protection ----------------------------------------------
    // Hard wall-clock cap on one task. Hitting it kills the agent process.
    taskTimeoutMs: int('TASK_TIMEOUT_MS', 900000),
    // If the agent produces no event at all for this long, the control plane
    // repaints the status message with "仍在等待 …". It never calls the model, so
    // a silent agent is visible without spending tokens.
    stallNoticeMs: int('STALL_NOTICE_MS', 30000),
    maxConsecutiveFailures: int('MAX_CONSECUTIVE_FAILURES', 3),
    maxProcessRestarts: int('MAX_PROCESS_RESTARTS', 5),
  };
}
