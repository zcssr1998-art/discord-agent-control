import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { ApprovalManager } from './approval-manager.mjs';
import { createHookServer, ensureHookSecret } from './hook-server.mjs';
import { StateStore } from './state.mjs';
import { RunLogger } from './logger.mjs';
import { resolveRoutingEnv, describeRouting, redactForLog } from './win-env.mjs';
import { DiscordControlPlane } from './discord-ui.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

async function main() {
  const config = loadConfig();
  const state = new StateStore(path.join(root, 'data', 'state.json'));
  const approvals = new ApprovalManager({ timeoutMs: config.approvalTimeoutMs });
  const secret = ensureHookSecret();
  const logger = new RunLogger(config.logDir || path.join(root, 'logs'));

  // Make sure the Claude child really talks to the user's existing DeepSeek
  // endpoint instead of silently falling back to the official Anthropic API.
  const routing = await resolveRoutingEnv();
  const effective = { ...process.env, ...routing.env };
  console.log(`[routing] source=${routing.source} ${JSON.stringify(redactForLog(effective))}`);
  if (routing.source === 'unavailable') {
    console.warn('[routing] ANTHROPIC_BASE_URL not found in process env or Windows user env.');
    console.warn('[routing] The agent will use whatever Claude Code falls back to. Run ~/claude-deepseek/use-deepseek-claude.ps1 or start the bridge from a fresh shell.');
  }

  // Start the approval service first so a Claude process can never be launched
  // into a state where its hook would have nothing to talk to.
  const hookServer = createHookServer({ config, approvalManager: approvals, secret });
  await new Promise((resolve, reject) => {
    hookServer.once('error', reject);
    hookServer.listen(config.approvalPort, config.approvalHost, resolve);
  });
  console.log(`[hook] listening at http://${config.approvalHost}:${config.approvalPort}/pre-tool-use`);

  const discord = new DiscordControlPlane({ config, state, approvalManager: approvals, routing, logger });
  try {
    await discord.start();
  } catch (error) {
    hookServer.close();
    throw new Error(
      `Discord startup failed: ${error?.message || error}. `
      + 'Check DISCORD_TOKEN / DISCORD_OWNER_ID in .env (run `npm run doctor:discord`).',
    );
  }

  const r = describeRouting(effective);
  console.log(`[discord] control plane ready | executor=${config.claudeCommand} base=${r.base} model=${r.model} token=${r.hasToken ? 'set' : 'unset'}`);
  console.log(`[discord] log dir=${config.logDir || path.join(root, 'logs')} default cwd=${config.defaultCwd}`);

  const shutdown = () => {
    console.log('\n[bridge] shutting down');
    hookServer.close();
    discord.client.destroy().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(`[fatal] ${error?.message || error}`);
  process.exit(1);
});
