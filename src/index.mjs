// MUST be the first import: it patches the `ws` WebSocket constructor before
// discord.js (and therefore @discordjs/ws) is evaluated. See src/discord-proxy.mjs.
import './discord-proxy.mjs';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { ApprovalManager } from './approval-manager.mjs';
import { createHookServer, ensureHookSecret } from './hook-server.mjs';
import { ensureGlobalHook } from './global-hook.mjs';
import { StateStore } from './state.mjs';
import { RunLogger } from './logger.mjs';
import { RunLimits } from './limits.mjs';
import { resolveRoutingEnv, describeRouting, redactForLog, resolveDiscordProxy } from './win-env.mjs';
import { configureDiscordProxy } from './discord-proxy.mjs';
import { explainDiscordLoginError } from './discord-errors.mjs';
import { stripPaidCredentials, probeBackend, billingRoute, assertBackendAllowed } from './backend.mjs';
import { DiscordControlPlane } from './discord-ui.mjs';
import { killAllChildrenSync } from './kill-tree.mjs';
import { PermissionManager } from './permission-manager.mjs';
import { CredentialStore } from './credential-store.mjs';
import { ProviderManager } from './provider-manager.mjs';
import { ModelManager } from './model-manager.mjs';
import { ExecutorManager } from './executor-manager.mjs';
import { ChatRuntime } from './chat-runtime.mjs';
import { ChatHistoryStore } from './chat-history.mjs';
import { ProviderHealthRegistry } from './provider-health.mjs';
import { WorkspaceScheduler } from './workspace-scheduler.mjs';
import { loadLiteLLMConfig, checkLiteLLMHealth, readOpenCodeGoKey } from './litellm.mjs';
import { cleanupInbox } from './attachments.mjs';
import { redactSecrets } from './secrets.mjs';
import { InstanceGuard } from './instance-guard.mjs';
import { resolveBuildIdentity, describeBuild } from './build-identity.mjs';
import { DurableStore } from './durable-store.mjs';
import { Updater, RESTART_EXIT_CODE, shortSha as shortUpdateSha } from './updater.mjs';
import { resolveDataDir } from './paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

async function main() {
  const buildIdentity = resolveBuildIdentity(root);
  const dataDir = resolveDataDir(root);
  // The lock lives under git-ignored runtime data. A test/harness may isolate it
  // with JARVIS_INSTANCE_LOCK (or JARVIS_DATA_DIR) so the real entry point can
  // be exercised without fighting a real running bridge.
  const lockFile = process.env.JARVIS_INSTANCE_LOCK
    ? path.resolve(process.env.JARVIS_INSTANCE_LOCK)
    : (process.env.JARVIS_DATA_DIR ? path.join(dataDir, 'jarvis-instance.lock') : null);
  const guard = new InstanceGuard({ root, build: buildIdentity, lockFile });
  const lockResult = guard.acquire();
  if (!lockResult.ok) {
    const holder = lockResult.holder;
    if (lockResult.reason === 'already-running' && holder) {
      console.error(`[instance] another live Jarvis bridge already holds the instance lock (pid=${holder.pid}, started=${holder.startedAt}${holder.branch ? ` ${holder.branch}@${String(holder.commit).slice(0, 7)}` : ''}).`);
      console.error('[instance] Refusing to start a second bridge. Stop the existing instance first, or run scripts/uninstall-autostart.ps1 if a scheduled launch is stale. The other process was NOT killed.');
    } else {
      console.error(`[instance] could not acquire the instance lock: ${lockResult.reason}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`[instance] acquired lock pid=${process.pid} build=${describeBuild(buildIdentity)} instance=${lockResult.info.instanceId}`);

  const config = loadConfig();
  // The Jarvis checkout root is the last-resort default workspace; it is never
  // inferred from process.cwd() or a model/history directory.
  config.repoRoot = config.repoRoot || root;
  config.defaultWorkspace = config.defaultWorkspace || config.repoRoot;
  console.log(`[workspace] default=${config.defaultWorkspace} (repoRoot=${config.repoRoot})`);

  const stateFile = path.join(dataDir, 'state.json');
  const state = new StateStore(stateFile);
  // Log the effective per-channel routing on startup so the live bridge state is
  // verifiable from logs instead of assumed from the file on disk.
  const knownChannels = Object.keys(state.data.channels ?? {});
  console.log(`[state] file=${stateFile} configuredChannel(s)=${knownChannels.length}`);
  for (const channelId of knownChannels) {
    const channel = state.getChannel(channelId, config.defaultCwd);
    console.log(`[state] channel=${channelId} mode=${channel.mode} executor=${channel.executorId} provider=${channel.providerId} model=${channel.model ?? 'none'} cwd=${channel.cwd}${channel.workThread ? ` workThread=parent:${channel.parentChannelId}` : ''}`);
  }
  const credentials = new CredentialStore(path.join(dataDir, 'credentials.json'));

  // P2.2 model persistence: the restored model selection is logged so a
  // post-restart run is verifiable from the bridge log instead of assumed.
  {
    const lastModel = state.getLastWorkModel();
    const workspaces = state.savedWorkspaceModelCount();
    console.log(`[state] restored model selection: workspaces=${workspaces} lastWorkModel=${lastModel ? `${lastModel.providerId ?? '?'}/${lastModel.model}` : 'none'}`);
  }

  // ---- P2.2D durable operational store (SQLite WAL) -------------------------
  const durableStore = new DurableStore({ file: path.join(dataDir, 'jarvis.db') });
  try {
    durableStore.open();
  } catch (error) {
    console.warn(`[store] durable store unavailable (${redactSecrets(error?.message || error)}); run history this session is memory-only`);
  }
  const providers = new ProviderManager({
    file: path.join(dataDir, 'providers.json'),
    credentialStore: credentials,
  });
  const approvals = new ApprovalManager({ timeoutMs: config.approvalTimeoutMs });
  // The owner's explicit permission tier is durable product configuration, so it
  // survives a bridge restart and is never reset by a model/provider/workspace
  // change or a new Agent session.
  const permissions = new PermissionManager({
    initialLevels: state.allPermissionLevels(),
    onChange: (channelId, level) => state.setPermissionLevel(channelId, level),
  });
  const secret = ensureHookSecret();
  // Repair a stale global hook (a hook installed from a different checkout
  // reads a different data/hook-secret and 401s every tool call). The hook
  // script itself also prefers the secret the bridge injects into the agent
  // child, so this is defense in depth, not the only guard.
  if (config.autoInstallHook) {
    const hook = ensureGlobalHook({ root });
    const changed = hook.results.filter((r) => r.changed).map((r) => r.target);
    console.log(`[hook] global hook ${hook.installed ? 'ready' : 'unavailable'}${changed.length ? ` (updated: ${changed.join(', ')})` : ''}`);
  }
  const logger = new RunLogger(config.logDir || path.join(root, 'logs'));
  const limits = new RunLimits({
    maxConsecutiveFailures: config.maxConsecutiveFailures,
    maxProcessRestarts: config.maxProcessRestarts,
  });

  // ---- crash containment ---------------------------------------------------
  // The Discord control plane and the agent task live in the same process.
  // A fatal error in the agent must not leave orphan processes behind, and the
  // control plane must not pretend it is healthy after an uncaught exception.
  // Strategy: log → notify owner → reap children → close Discord/hook → EXIT.
  // Exiting is what lets the supervisor (scripts/start-supervisor.ps1) restart
  // the bridge after a short backoff. Staying alive with a destroyed Discord
  // client would look UP to the supervisor while serving nothing, so the exit
  // is forced even if teardown hangs.
  let discord = null;
  let hookServer = null;
  let updater = null;
  let shuttingDown = false;

  const fatalShutdown = async (label, error) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Force the exit even if async teardown hangs (e.g. a wedged runner).
    const forceExit = setTimeout(() => {
      try { guard.release(); } catch { /* best effort */ }
      process.exit(1);
    }, 8000);
    try { forceExit.unref?.(); } catch { /* ignore */ }
    const detail = redactSecrets(error?.stack || String(error?.message || error));
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
    try { guard.release(); } catch { /* best effort: stale-lock reclaim covers the rest */ }
    clearTimeout(forceExit);
    process.exit(1);
  };

  process.on('uncaughtException', (error) => { fatalShutdown('uncaughtException', error).catch(() => process.exit(1)); });
  process.on('unhandledRejection', (reason) => { fatalShutdown('unhandledRejection', reason).catch(() => process.exit(1)); });

  // A verified self-update must NOT become two bridges: the live bridge exits
  // with a dedicated code and the existing Supervisor relaunches it from the
  // same (now fast-forwarded) checkout. Children are reaped first so no Agent
  // tree survives the restart.
  const shutdownForUpdate = async ({ sha, previousSha } = {}) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[update] restarting bridge for verified update ${shortUpdateSha(previousSha)} -> ${shortUpdateSha(sha)}`);
    try { await discord?.stopAll?.({ reason: 'update deploy' }); } catch { /* best effort */ }
    try { hookServer?.close?.(); } catch { /* best effort */ }
    try { await discord?.client?.destroy?.(); } catch { /* best effort */ }
    try { updater?.stop?.(); } catch { /* best effort */ }
    guard.release();
    process.exit(RESTART_EXIT_CODE);
  };

  // Owner-visible update notices: only meaningful transitions, never per-poll.
  const updateNoticeText = (event) => {
    if (event.type === 'update-pending') {
      return `⬆️ **更新可用，等待空闲部署**\n\`${shortUpdateSha(event.previousSha)} → ${shortUpdateSha(event.sha)}\`\n`
        + `当前有运行中的任务，更新保持 pending，不会中断 Work。任务完成后会自动部署。`;
    }
    if (event.type === 'update-applied') {
      return `✅ **更新已应用**\n\`${shortUpdateSha(event.previousSha)} → ${shortUpdateSha(event.sha)}\`\nSupervisor 正在重启 Jarvis（单实例）。`;
    }
    if (event.type === 'update-verified') {
      return `✅ **更新已验证**\n运行 SHA：\`${shortUpdateSha(event.sha)}\``;
    }
    if (event.type === 'update-blocked') {
      return `⛔ **更新已阻止**${event.reason ? `\n原因：${event.reason}` : ''}`;
    }
    if (event.type === 'update-failed') {
      return `⚠️ **更新失败/已回滚**\n\`${shortUpdateSha(event.sha)}\`${event.reason ? `\n原因：${event.reason}` : ''}`;
    }
    return null;
  };

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

  const executors = new ExecutorManager({
    workbuddyCommand: config.claudeCommand,
    workbuddyEnv: childEnv,
    bridgeEnv: {
      APPROVAL_HOST: config.approvalHost,
      APPROVAL_PORT: String(config.approvalPort),
      // The hook client prefers this over its local data/hook-secret so a
      // globally installed hook can never use a stale secret.
      DISCORD_BRIDGE_SECRET: secret,
    },
  });
  await executors.discover();
  for (const executor of executors.list()) {
    console.log(`[executor] ${executor.id}=${executor.status}${executor.version ? ` version=${executor.version}` : ''}`);
  }
  const models = new ModelManager(providers);

  // ---- LiteLLM gateway -----------------------------------------------------
  // Primary standard model gateway. It is one OpenAI-compatible endpoint on
  // 127.0.0.1; Jarvis keeps mode/session/permission/billing policy and only
  // delegates provider normalization, retry/fallback and cost metadata here.
  // A missing/unhealthy gateway must never strand Chat: candidates without a
  // reachable model list are simply skipped and OpenCode Go direct takes over.
  const litellmConfig = loadLiteLLMConfig(process.env, { root });
  let gatewayStatus = { ok: false, detail: 'disabled' };
  if (litellmConfig.enabled) {
    if (litellmConfig.masterKey) credentials.set('provider:litellm', litellmConfig.masterKey);
    providers.registerLitellm({ baseUrl: litellmConfig.baseUrl, billingType: litellmConfig.billingType });
    gatewayStatus = await checkLiteLLMHealth({
      healthUrl: litellmConfig.healthUrl, masterKey: litellmConfig.masterKey, timeoutMs: litellmConfig.timeoutMs,
    });
    console.log(`[litellm] baseUrl=${litellmConfig.baseUrl} billing=${litellmConfig.billingType} health=${gatewayStatus.ok ? 'UP' : 'DOWN'} (${gatewayStatus.detail})`);
  } else {
    console.log('[litellm] disabled by configuration; Chat uses direct providers only');
  }
  const gatewayHealth = litellmConfig.enabled
    ? () => checkLiteLLMHealth({
      healthUrl: litellmConfig.healthUrl, masterKey: litellmConfig.masterKey, timeoutMs: litellmConfig.timeoutMs,
    })
    : null;

  // Direct OpenCode Go escape hatch. LiteLLM is primary, but a validated direct
  // route must still serve a configured subscription model if the gateway is
  // down. The key is only read, never printed.
  const opencodeGo = providers.get('opencode-go');
  if (opencodeGo && !providers.hasCredential(opencodeGo)) {
    const key = readOpenCodeGoKey();
    if (key) {
      credentials.set('provider:opencode-go', key);
      console.log('[chat] seeded OpenCode Go direct credential from the local OpenCode auth store');
    }
  }

  // ---- chat runtime --------------------------------------------------------
  // Ordinary messages go here and only here: a direct model API call with its own
  // health/cooldown state. It deliberately reuses the same ProviderManager and
  // CredentialStore as the Agent path so there is a single provider database and
  // a single secret store. It never starts an Agent, a workspace scan or a hook.
  const chatHealth = new ProviderHealthRegistry();
  // Vision route for AUTO image turns: an explicit env pin wins, otherwise a
  // LiteLLM `vision` alias is used when the gateway exposes one.
  let visionRoute = null;
  if (config.chatVisionProviderId) {
    visionRoute = { providerId: config.chatVisionProviderId, model: config.chatVisionModel || null };
  } else {
    const litellmProfile = providers.get('litellm');
    if (litellmProfile?.models?.some((model) => model.id === 'vision')) {
      visionRoute = { providerId: 'litellm', model: 'vision' };
    } else {
      // No explicit pin and no LiteLLM vision alias: use a credentialed
      // provider's cached vision model if one is already known. This is a
      // detection, not a hardcoded model id.
      const provider = providers.list().find((profile) => profile.protocol !== 'workbuddy'
        && providers.hasCredential(profile)
        && profile.models?.some((model) => /vision/i.test(model.id)));
      if (provider) visionRoute = { providerId: provider.id, model: provider.models.find((model) => /vision/i.test(model.id)).id };
    }
  }
  const chatRuntime = new ChatRuntime({
    providerManager: providers,
    credentialStore: credentials,
    health: chatHealth,
    timeoutMs: config.chatTimeoutMs,
    maxOutputTokens: config.chatMaxOutputTokens,
    allowMeteredFallback: config.allowMeteredChatFallback,
    visionRoute,
  });
  if (visionRoute) console.log(`[chat] vision route provider=${visionRoute.providerId} model=${visionRoute.model || 'auto'}`);

  // Bounded, channel-scoped Chat history plus a git-ignored attachment inbox.
  const chatHistory = new ChatHistoryStore({ file: path.join(dataDir, 'chat-history.json') });
  const attachmentInbox = path.join(dataDir, 'inbox');
  const reaped = cleanupInbox(attachmentInbox, { ttlMs: 48 * 60 * 60 * 1000 });
  if (reaped.length) console.log(`[attachments] cleaned ${reaped.length} expired inbox file(s)`);

  // Preflight: prove the free backend answers before accepting any work.
  console.log(`[backend] probing executor "${config.claudeCommand}" ...`);
  const workbuddyProbeEnv = executors.buildEnvironment('workbuddy', providers.get('workbuddy-free'), null, null);
  const probe = await probeBackend({
    command: config.claudeCommand,
    cwd: config.defaultCwd,
    extraEnv: workbuddyProbeEnv.env,
    envUnset: workbuddyProbeEnv.envUnset,
    inheritEnv: false,
    // Bounded independently: taskTimeoutMs may be 0 (unlimited Work), but the
    // startup preflight must never hang forever on a wedged CLI.
    timeoutMs: config.backendProbeTimeoutMs,
  });
  const verdict = assertBackendAllowed(probe.backend, { allowPaidFallback: config.allowPaidFallback, expected: config.agentBackend });
  const probeDetail = `${probe.text || ''} ${probe.error || ''}`;
  const workbuddyStatus = probe.ok && verdict.ok ? 'PASS'
    : /quota|额度|余额|insufficient|\b402\b|\b429\b/i.test(probeDetail) ? 'BLOCKED_BY_QUOTA' : 'FAIL';
  providers.setWorkbuddyHealth(workbuddyStatus, probe.error || probe.text || verdict.reason);
  console.log(`[backend] probe ok=${probe.ok} ${probe.error ? `error=${probe.error}` : ''}`);
  console.log(`[backend] observed: ${probe.backend?.label ?? 'unknown'} model=${probe.backend?.model ?? 'unknown'}`);
  if (workbuddyStatus !== 'PASS') {
    console.warn(`[backend] WorkBuddy status=${workbuddyStatus}; the shared control plane will remain available for other configured providers.`);
    console.warn('[backend] No provider fallback attempted.');
  } else {
    console.log('[backend] WorkBuddy Free DSF confirmed. Paid fallback: DISABLED.');
  }
  providers.noteWorkbuddyModel(probe.backend?.model);

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
    workbuddyStatus,
  };

  // Serialises Jarvis-managed Work per canonical workspace. In-memory on
  // purpose: an active Agent does not survive a bridge restart, so persisting a
  // queued-but-not-started task would add complexity without recovery value.
  const workspaceScheduler = new WorkspaceScheduler();

  // ---- safe self-update (P2.2.6) ------------------------------------------
  // Detection only: the updater fast-forwards the clean checkout after a
  // staging-worktree candidate gate, then asks the Supervisor to restart. It
  // never hot-swaps modules and never kills active Work.
  updater = new Updater({
    root,
    enabled: config.autoUpdateEnabled,
    remote: config.autoUpdateRemote,
    branch: config.autoUpdateBranch,
    intervalMs: config.autoUpdateIntervalMs,
    stateFile: path.join(dataDir, 'update-state.json'),
    // The SHA this process actually loaded decides freshness, not the checkout.
    runningSha: buildIdentity.commit,
    safeToRestart: async () => (discord ? discord.runtimeActivity() : { safe: false, reasons: ['bridge starting'] }),
    onReconcileSchema: async () => (discord ? discord.reconcileCommandSchema() : null),
    onRequestRestart: (info) => shutdownForUpdate(info),
    onNotify: async (event) => {
      try {
        const text = updateNoticeText(event);
        if (!text) return;
        const owner = await discord?.client?.users?.fetch?.(config.ownerId);
        await owner?.send?.(text);
      } catch { /* notifications are best-effort */ }
    },
    logger: console,
  });
  if (config.autoUpdateEnabled && config.autoUpdateBranch !== buildIdentity.branch) {
    console.warn(`[update] live checkout branch '${buildIdentity.branch}' != AUTO_UPDATE_BRANCH '${config.autoUpdateBranch}'; the updater will report BLOCKED until they match.`);
  }

  discord = new DiscordControlPlane({
    config,
    state,
    approvalManager: approvals,
    permissionManager: permissions,
    logger,
    limits,
    backendState,
    credentialStore: credentials,
    providerManager: providers,
    modelManager: models,
    executorManager: executors,
    chatRuntime,
    chatHistory,
    gatewayHealth,
    workspaceScheduler,
    attachmentInbox,
    runtimeIdentity: { guard, build: buildIdentity, describe: describeBuild(buildIdentity) },
    durableStore,
    updater,
    extraEnv: { ...childEnv, DISCORD_BRIDGE_SECRET: secret },
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
  console.log(`[chat] mode=CHAT(default) route=AUTO meteredFallback=${config.allowMeteredChatFallback ? 'ENABLED' : 'DISABLED'} timeoutMs=${config.chatTimeoutMs > 0 ? config.chatTimeoutMs : 'unlimited'} maxOutputTokens=${config.chatMaxOutputTokens}`);
  console.log(`[discord] control plane ready | log dir=${config.logDir || path.join(root, 'logs')} default cwd=${config.defaultCwd}`);

  // Only now that Discord is online can the updater's notifications/schema
  // reconcile reach the owner. reconcileAfterRestart() proves the running SHA
  // and the fetched Discord command schema.
  await updater.start().catch((error) => console.warn(`[update] startup check failed: ${error?.message || error}`));

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[bridge] shutting down (${signal})`);
    try { updater.stop(); } catch { /* best effort */ }
    // Kill every agent tree before we go, so a Ctrl+C can never leave orphan
    // PowerShell / cmd / node processes behind.
    try { await discord.stopAll({ reason: `bridge shutdown (${signal})` }); } catch { /* best effort */ }
    try { hookServer.close(); } catch { /* best effort */ }
    try { await discord.client.destroy(); } catch { /* best effort */ }
    guard.release();
    process.exitCode = 0;
  };
  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(0)); });
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(0)); });
}

main().catch((error) => {
  console.error(`[fatal] ${redactSecrets(error?.message || error)}`);
  process.exitCode = 1;
});
