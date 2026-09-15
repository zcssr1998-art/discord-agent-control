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
import { PermissionManager } from './permission-manager.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

async function main() {
  const config = loadConfig();
  const state = new StateStore(path.join(root, 'data', 'state.json'));
  const approvals = new ApprovalManager({ timeoutMs: config.approvalTimeoutMs });
  const permissions = new PermissionManager();
  const secret = ensureHookSecret();
  const logger = new RunLogger(config.logDir || path.join(root, 'logs'));
  const limits = new RunLimits({
    maxConsecutiveFailures: config.maxConsecutiveFailures,
    maxProcessRestarts: config.maxProcessRestarts,
  });

  // ---- crash containment ---------------------------------------------------
  // The Discord control plane and the agent task live in the same process.
  // A fatal error in the agent must not leave orphan processes behind, and the
  // control plane must not pretend it is healthy after an uncaught exception.
  // Strategy: log → notify owner → reap children → close Discord/hook → exit.
  // A supervisor script (scripts/start-supervisor.ps1) watches the exit code
  // and restarts the bridge after a short backoff, so the control plane comes
  // back online automatically.
  let discord = null;
  let hookServer = null;
  let shuttingDown = false;

  const fatalShutdown = async (label, error) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const detail = error?.stack || String(error?.message || error);
    console.error(`[${label}] ${detail}`);

    // Best-effort owner notification before we tear everything down.
    if (discord) {
      try {
        await Promise.race([
          (async () => {
            const owner = await discord.client?.users?.fetch?.(config.ownerId);
            await owner?.send?.(
              `🔴 **Bridge is crashing** (\`${label}\`)\n\`\`\`\n${String(detail).slice(0, 900)}\n\`\`\`\n`
              + 'Reaping children and exiting. Supervisor will restart shortly.',
            );
          })(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('notify timeout')), 5000)),
        ]).catch(() => {});
      } catch { /* never let the reporter itself fail */ }
    }

    // Reap every child tree so a crash never leaves orphan PowerShell/cmd/node.
    try { await discord?.stopAll?.({ reason: `bridge crash (${label})` }); } catch { /* best effort */ }
    try { hookServer?.close?.(); } catch { /* best effort */ }
    try { await discord?.client?.destroy?.(); } catch { /* best effort */ }
    const pids = killAllChildrenSync();
    if (pids.length) console.error(`[bridge] reaped ${pids.length} orphan child tree(s): ${pids.join(', ')}`);
    process.exitCode = 1;
  };

  process.on('uncaughtException', (error) => { fatalShutdown('uncaughtException', error); });
  process.on('unhandledRejection', (reason) => { fatalShutdown('unhandledRejection', reason); });

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

  hookServer = createHookServer({ config, approvalManager: approvals, permissionManager: permissions, secret });
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
    permissionManager: permissions,
    logger,
    limits,
    backendState,
    extraEnv: childEnv,
    envUnset,
  });

  try {
    await discord.start();
  } catch (error) {
    try { await discord.stopAll({ reason: 'Discord startup failed' }); } catch { /* best effort */ }
    try { await discord.client.destroy(); } catch { /* best effort */ }
    await new Promise((resolve) => hookServer.close(resolve));
    throw new Error(`Discord startup failed: ${error?.message || error} ${explainDiscordLoginError(error?.message)}`);
  }

  console.log('[bridge] Executor: Claude Code compatible shell (CodeBuddy CLI)');
  console.log(`[bridge] Backend: ${backendState.backend?.label ?? 'unknown'}`);
  console.log(`[bridge] Model: ${backendState.backend?.model ?? 'unknown'}`);
  console.log(`[bridge] Billing route: ${backendState.billingRoute}`);
  console.log(`[bridge] Paid fallback: ${config.allowPaidFallback ? 'ENABLED' : 'DISABLED'}`);
  console.log(`[discord] control plane ready | log dir=${config.logDir || path.join(root, 'logs')} default cwd=${config.defaultCwd}`);

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[bridge] shutting down (${signal})`);
    // Kill every agent tree before we go, so a Ctrl+C can never leave orphan
    // PowerShell / cmd / node processes behind.
    try { await discord.stopAll({ reason: `bridge shutdown (${signal})` }); } catch { /* best effort */ }
    try { hookServer.close(); } catch { /* best effort */ }
    try { await discord.client.destroy(); } catch { /* best effort */ }
    process.exitCode = 0;
  };
  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(0)); });
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(0)); });
}

main().catch((error) => {
  console.error(`[fatal] ${error?.message || error}`);
  process.exitCode = 1;
});
