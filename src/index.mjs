// MUST be the first import: it patches the `ws` WebSocket constructor before
// discord.js (and therefore @discordjs/ws) is evaluated. See src/discord-proxy.mjs.
import './discord-proxy.mjs';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { ApprovalManager } from './approval-manager.mjs';
import { createHookServer, ensureHookSecret } from './hook-server.mjs';
import { StateStore } from './state.mjs';
import { RunLogger } from './logger.mjs';
import { RunLimits } from './limits.mjs';
import { resolveRoutingEnv, describeRouting, redactForLog, resolveDiscordProxy } from './win-env.mjs';
import { configureDiscordProxy } from './discord-proxy.mjs';
import { explainDiscordLoginError } from './discord-errors.mjs';
import { stripPaidCredentials, probeBackend, classifyBackend, billingRoute, assertBackendAllowed } from './backend.mjs';
import { DiscordControlPlane } from './discord-ui.mjs';
import { killAllChildrenSync } from './kill-tree.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

async function main() {
  const config = loadConfig();
  const state = new StateStore(path.join(root, 'data', 'state.json'));
  const approvals = new ApprovalManager({ timeoutMs: config.approvalTimeoutMs });
  const secret = ensureHookSecret();
  const logger = new RunLogger(config.logDir || path.join(root, 'logs'));
  const limits = new RunLimits({
    maxConsecutiveFailures: config.maxConsecutiveFailures,
    maxProcessRestarts: config.maxProcessRestarts,
  });

  // ---- crash containment ---------------------------------------------------
  // The Discord control plane and the agent task live in the same process. That
  // is only acceptable if a single stray error cannot take the process down:
  // losing the bridge means the phone can no longer send `!status` or `!stop`
  // to the very task that is misbehaving. So every unexpected error is logged
  // and survived rather than fatal.
  //
  // This is the fix for the real outage: the run wedged on a blocked tool call,
  // the process died silently (no `[fatal]`, no `[task] done`, no shutdown
  // line), and the control plane went with it.
  let discord = null;

  const reportCrash = (label, error) => {
    const detail = error?.stack || String(error?.message || error);
    console.error(`[${label}] ${detail}`);
    if (!discord) return;
    // Best effort only — the notification must never be able to throw.
    try {
      Promise.resolve(discord.client?.users?.fetch?.(config.ownerId))
        .then((owner) => owner?.send?.(
          `⚠️ **Bridge survived an internal error** (\`${label}\`)\n\`\`\`\n${String(detail).slice(0, 900)}\n\`\`\`\n`
          + 'The control plane is still online. `!status` / `!stop` still work.',
        ))
        .catch(() => {});
    } catch { /* never let the reporter itself fail */ }
  };

  process.on('uncaughtException', (error) => reportCrash('uncaughtException', error));
  process.on('unhandledRejection', (reason) => reportCrash('unhandledRejection', reason));

  // Last-resort orphan reap. `exit` can only run synchronous code, so this is
  // the one place a blocking taskkill is correct — see src/kill-tree.mjs for why
  // the usual "never use spawnSync" rule does not apply here.
  process.on('exit', () => {
    const pids = killAllChildrenSync();
    if (pids.length) console.error(`[bridge] reaped ${pids.length} orphan child tree(s): ${pids.join(', ')}`);
  });

  // ---- agent backend -------------------------------------------------------
  // Paid fallback is off by default, so a metered credential must not even be
  // visible to the agent process. When it is off we also skip injecting the
  // user's paid provider routing entirely: there is nothing to reuse.
  const childEnv = { ...process.env };
  if (config.allowPaidFallback) {
    const routing = await resolveRoutingEnv();
    Object.assign(childEnv, routing.env);
    const r = describeRouting(childEnv);
    console.log(`[routing] source=${routing.source} ${JSON.stringify(redactForLog(childEnv))}`);
    if (routing.source === 'unavailable') console.warn('[routing] no ANTHROPIC_BASE_URL found; the agent will use its own default.');
  } else {
    console.log('[routing] paid provider routing not used (ALLOW_PAID_FALLBACK=false); the agent uses the WorkBuddy backend');
  }

  const envUnset = config.allowPaidFallback ? [] : stripPaidCredentials(childEnv);
  console.log(`[backend] expected=${config.agentBackend} paidFallback=${config.allowPaidFallback ? 'ENABLED' : 'disabled'}`);
  console.log(`[backend] blocked credential vars: ${envUnset.length ? envUnset.join(', ') : '(none)'}`);

  // Preflight: prove the free backend answers before accepting any work.
  console.log(`[backend] probing executor "${config.claudeCommand}" ...`);
  const probe = await probeBackend({
    command: config.claudeCommand,
    cwd: config.defaultCwd,
    extraEnv: childEnv,
    envUnset,
    timeoutMs: config.taskTimeoutMs,
  });
  const verdict = assertBackendAllowed(probe.backend, { allowPaidFallback: config.allowPaidFallback, expected: config.agentBackend });
  console.log(`[backend] probe ok=${probe.ok} ${probe.error ? `error=${probe.error}` : ''}`);
  console.log(`[backend] observed: ${probe.backend?.label ?? 'unknown'} model=${probe.backend?.model ?? 'unknown'}`);
  if (!verdict.ok) {
    console.error('[backend] ERROR: WorkBuddy free backend unavailable or wrong backend.');
    console.error(`[backend] ${verdict.reason}`);
    console.error('[backend] No paid fallback attempted.');
    process.exit(2);
  }
  console.log('[backend] WorkBuddy Free DSF confirmed. Paid fallback: DISABLED.');

  // ---- discord -------------------------------------------------------------
  const proxy = await resolveDiscordProxy(config.discordProxy);
  if (proxy.proxyUrl) {
    configureDiscordProxy(proxy.proxyUrl);
    console.log(`[proxy] discord via ${proxy.proxyUrl} (source=${proxy.source})`);
  } else {
    console.log(`[proxy] discord connects directly (source=${proxy.source})`);
  }

  const hookServer = createHookServer({ config, approvalManager: approvals, secret });
  await new Promise((resolve, reject) => {
    hookServer.once('error', reject);
    hookServer.listen(config.approvalPort, config.approvalHost, resolve);
  });
  console.log(`[hook] listening at http://${config.approvalHost}:${config.approvalPort}/pre-tool-use`);

  const backendState = {
    backend: probe.backend,
    allowPaidFallback: config.allowPaidFallback,
    billingRoute: billingRoute(probe.backend),
    executor: config.claudeCommand,
  };

  discord = new DiscordControlPlane({
    config,
    state,
    approvalManager: approvals,
    logger,
    limits,
    backendState,
    extraEnv: childEnv,
    envUnset,
  });

  try {
    await discord.start();
  } catch (error) {
    hookServer.close();
    throw new Error(`Discord startup failed: ${error?.message || error} ${explainDiscordLoginError(error?.message)}`);
  }

  console.log('[bridge] Executor: Claude Code compatible shell (CodeBuddy CLI)');
  console.log(`[bridge] Backend: ${backendState.backend?.label ?? 'unknown'}`);
  console.log(`[bridge] Model: ${backendState.backend?.model ?? 'unknown'}`);
  console.log(`[bridge] Billing route: ${backendState.billingRoute}`);
  console.log(`[bridge] Paid fallback: ${config.allowPaidFallback ? 'ENABLED' : 'DISABLED'}`);
  console.log(`[discord] control plane ready | log dir=${config.logDir || path.join(root, 'logs')} default cwd=${config.defaultCwd}`);

  const shutdown = async (signal) => {
    console.log(`\n[bridge] shutting down (${signal})`);
    // Kill every agent tree before we go, so a Ctrl+C can never leave orphan
    // PowerShell / cmd / node processes behind.
    try { await discord.stopAll({ reason: `bridge shutdown (${signal})` }); } catch { /* best effort */ }
    try { hookServer.close(); } catch { /* best effort */ }
    try { await discord.client.destroy(); } catch { /* best effort */ }
    process.exit(0);
  };
  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(0)); });
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(0)); });
}

main().catch((error) => {
  console.error(`[fatal] ${error?.message || error}`);
  process.exit(1);
});
