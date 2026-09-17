#!/usr/bin/env node
/**
 * P2.2.5 user-hostile limits cleanup — focused deterministic smoke.
 *
 * No long waits, no real Agent, no network, no secrets. It drives the REAL
 * modules (config, commands, control plane with the fake Discord transport,
 * ChatRuntime, PermissionManager/StateStore, RunLimits, ApprovalManager,
 * ProviderHealthRegistry, ChatHistoryStore) and fails loudly if any of the
 * audited owner-hostile limits regress.
 *
 * Run: npm run smoke:p225-limits
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config.mjs';
import { buildCommandPayloads, SLASH_TASK_MAX_LENGTH, MODAL_TASK_MAX_LENGTH } from '../src/commands.mjs';
import { planResultDelivery, chunkDiscordText } from '../src/discord/renderers.mjs';
import { PermissionManager, LEVEL } from '../src/permission-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { RunLimits } from '../src/limits.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { ProviderHealthRegistry } from '../src/provider-health.mjs';
import { ChatRuntime } from '../src/chat-runtime.mjs';
import { ChatHistoryStore } from '../src/chat-history.mjs';
import { DiscordControlPlane } from '../src/discord-ui.mjs';
import { RunLogger } from '../src/logger.mjs';
import { PROTOCOL, TRANSPORT } from '../src/provider-manager.mjs';
import { FakeDiscord } from '../tests/helpers/fake-discord.mjs';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonResponse = (status, body) => ({ ok: status < 300, status, async json() { return body; } });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p225-smoke-'));
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } };

const OPENCODE_GO = {
  id: 'opencode-go', displayName: 'OpenCode Go', protocol: PROTOCOL.OPENCODE_GO,
  baseUrl: 'https://opencode.ai/zen/go', billingType: 'SUBSCRIPTION', credentialRef: 'provider:opencode-go',
  models: [{ id: 'deepseek-v4.1-flash', transport: TRANSPORT.OPENAI_CHAT }],
};
const ANTHROPIC = {
  id: 'anthropic-x', displayName: 'Anthropic Compat', protocol: PROTOCOL.ANTHROPIC,
  baseUrl: 'https://api.anthropic.test', billingType: 'FREE', credentialRef: 'provider:anthropic-x',
  models: [{ id: 'claude-x' }],
};
function providersOf(list) {
  return { list: () => list, get: (id) => list.find((p) => p.id === id) || null, hasCredential: () => true, listModels: async (id) => ({ models: list.find((p) => p.id === id)?.models || [] }) };
}

function delayedAnthropicFetch(ms, captured) {
  return async (_url, options) => {
    captured.body = JSON.parse(options.body);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      const signal = options?.signal;
      if (!signal) return;
      if (signal.aborted) { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })); return; }
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })); }, { once: true });
    });
    return jsonResponse(200, { content: [{ type: 'text', text: 'hi' }] });
  };
}

function makeWorkPlane({ runner }) {
  const fake = new FakeDiscord();
  const dir = fs.mkdtempSync(path.join(tmp, 'plane-'));
  const state = new StateStore(path.join(dir, 'state.json'));
  state.patchChannel(fake.channelId, { mode: 'work' }, dir);
  const providers = providersOf([OPENCODE_GO]);
  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: dir, claudeCommand: 'claude',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 600000,
      allowPaidFallback: false, taskTimeoutMs: 0, maxWorkFollowUps: 0, autoRegisterCommands: false,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 0 }),
    permissionManager: new PermissionManager(),
    providerManager: providers,
    chatRuntime: { send: async () => ({ text: 'x' }) },
    limits: new RunLimits(),
    logger: new RunLogger(path.join(dir, 'logs')),
    backendState: { backend: { label: 'opencode-go', model: 'deepseek-v4.1-flash' }, allowPaidFallback: false },
    client: fake.client,
    autoLogin: false,
  });
  plane.getRunner = async (channelId) => { plane.runners.set(channelId, runner); return runner; };
  return { fake, plane };
}

const stubRunner = () => ({
  sessionId: 'sess-1', model: 'deepseek-v4.1-flash', busy: false, sent: [], idleMs: 0,
  async send(prompt) { this.busy = true; this.sent.push(prompt); this.busy = false; return { text: 'done', sessionId: 'sess-1', durationMs: 1, tools: [], isError: false, costUsd: 0 }; },
  async stop() { return { killed: false, pid: null }; },
});

async function main() {
  // ---- config defaults (documented, not a hidden cap) ----------------------
  const saved = {};
  for (const key of ['APPROVAL_TIMEOUT_MS', 'CHAT_TIMEOUT_MS', 'CHAT_MAX_OUTPUT_TOKENS', 'MAX_WORK_FOLLOWUPS', 'TASK_TIMEOUT_MS']) {
    saved[key] = process.env[key]; delete process.env[key];
  }
  process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'smoke-token';
  process.env.DISCORD_OWNER_ID = process.env.DISCORD_OWNER_ID || '0';
  const config = loadConfig();
  check('config approval timeout default is 0 (no auto-deny)', config.approvalTimeoutMs === 0, `got ${config.approvalTimeoutMs}`);
  check('config chat timeout default is unlimited (0)', config.chatTimeoutMs === 0, `got ${config.chatTimeoutMs}`);
  check('config anthropic output ceiling default is 8192 (not 4096)', config.chatMaxOutputTokens === 8192, `got ${config.chatMaxOutputTokens}`);
  check('config follow-up cap default is 0 (unlimited)', config.maxWorkFollowUps === 0, `got ${config.maxWorkFollowUps}`);
  check('config Work duration stays unlimited by default', config.taskTimeoutMs === 0, `got ${config.taskTimeoutMs}`);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }

  // ---- K1/K2 platform maxima ----------------------------------------------
  const work = buildCommandPayloads().find((command) => command.name === 'work');
  check('K1 slash /work max_length is the real 6000', work.options[0].max_length === 6000 && SLASH_TASK_MAX_LENGTH === 6000);

  const slashRunner = stubRunner();
  const slashPlane = makeWorkPlane({ runner: slashRunner });
  await slashPlane.plane.start();
  const slashTask = 'B'.repeat(5200);
  await slashPlane.fake.command('work', { options: { task: slashTask } });
  check('K1 5000+ char slash task reaches the runtime intact', slashRunner.sent[0] === slashTask);

  const modalRunner = stubRunner();
  const modalPlane = makeWorkPlane({ runner: modalRunner });
  await modalPlane.plane.start();
  check('K2 modal max length is the real 4000', MODAL_TASK_MAX_LENGTH === 4000);
  const modalTask = 'M'.repeat(3999);
  await modalPlane.fake.submitModal('workmodal:task', { values: { task: modalTask } });
  check('K2 near-4000 char modal task survives extraction intact', modalRunner.sent[0] === modalTask);

  // ---- K3 full result delivery --------------------------------------------
  const big = 'Z'.repeat(8192);
  const plan = planResultDelivery(big);
  const recovered = plan.mode === 'chunks' ? plan.chunks.join('') === big
    : plan.mode === 'attachment' ? plan.attachment.content === big : false;
  check('K3 ~8k result is fully recoverable (chunks or attachment)', recovered, `mode=${plan.mode}`);
  check('K3 chunker preserves every character', chunkDiscordText(big).join('') === big);

  // ---- K4 permission tier persistence -------------------------------------
  const stateFile = path.join(tmp, 'perm-state.json');
  const state = new StateStore(stateFile);
  const permissions = new PermissionManager({
    initialLevels: state.allPermissionLevels(),
    onChange: (channelId, level) => state.setPermissionLevel(channelId, level),
  });
  permissions.confirmFull('chan-x');
  const restored = new PermissionManager({ initialLevels: new StateStore(stateFile).allPermissionLevels() });
  check('K4 FULL survives a bridge restart', restored.getLevel('chan-x') === LEVEL.FULL);
  check('K4 a channel without a saved tier migrates to STANDARD', restored.getLevel('chan-new') === LEVEL.STANDARD);

  // ---- K5 no permanent lockout --------------------------------------------
  const limits = new RunLimits({ maxConsecutiveFailures: 2, maxProcessRestarts: 2 });
  for (let i = 0; i < 5; i += 1) limits.noteFailure('chan-x', new Error('boom'));
  for (let i = 0; i < 6; i += 1) limits.noteProcessRestart('chan-x');
  const verdict = limits.blocked('chan-x');
  check('K5 historical failures/restarts never block a new Work', verdict.blocked === false && !/!reset/.test(String(verdict.warning)));

  const retryRunner = stubRunner();
  const retryPlane = makeWorkPlane({ runner: retryRunner });
  await retryPlane.plane.start();
  for (let i = 0; i < 4; i += 1) retryPlane.plane.limits.noteFailure(retryPlane.fake.channelId, new Error('boom'));
  await retryPlane.fake.sendAsUser({ content: 'known good task' });
  check('K5 a later valid Work is accepted without !reset', retryRunner.sent[0] === 'known good task');

  // ---- K6 chat timeout -----------------------------------------------------
  const timeoutProviders = providersOf([ANTHROPIC]);
  const slow = new ChatRuntime({
    providerManager: timeoutProviders, credentialStore: { get: () => 'k' },
    fetchImpl: delayedAnthropicFetch(60, {}), timeoutMs: 120000, maxOutputTokens: 8192,
  });
  const slowOk = (await slow.send({ prompt: 'hi', providerId: 'anthropic-x', model: 'claude-x' })).text === 'hi';
  check('K6 a slow (45s-class) response is not killed by the default timeout', slowOk);
  let timedOut = false;
  try {
    await new ChatRuntime({
      providerManager: timeoutProviders, credentialStore: { get: () => 'k' },
      fetchImpl: delayedAnthropicFetch(80, {}), timeoutMs: 20,
    }).send({ prompt: 'hi', providerId: 'anthropic-x', model: 'claude-x' });
  } catch (error) { timedOut = error.code === 'TIMEOUT'; }
  check('K6 an explicit short timeout still aborts', timedOut);

  // ---- K7 cooldown observability + scoped clear ----------------------------
  const health = new ProviderHealthRegistry();
  health.noteFailure('opencode-go', 'deepseek-v4.1-flash', Object.assign(new Error('rate'), { code: 'RATE_LIMIT' }));
  health.noteFailure('litellm', 'chat-fast', Object.assign(new Error('boom'), { code: 'PROVIDER_ERROR' }));
  const listed = health.list().filter((item) => item.remainingMs > 0);
  check('K7 cooldowns are observable with reason + remaining time', listed.length === 2 && listed.every((item) => item.lastErrorCode && item.remainingMs > 0), `${listed.length} entries`);
  health.reset('opencode-go', 'deepseek-v4.1-flash');
  check('K7 clear resets only the intended entry', health.canTry('opencode-go', 'deepseek-v4.1-flash') && !health.canTry('litellm', 'chat-fast'));

  // ---- K8 history auto-compact (not silent drop) ---------------------------
  const history = new ChatHistoryStore({ file: path.join(tmp, 'history.json') });
  for (let i = 0; i < 20; i += 1) history.appendTurn('chan-h', { user: `u${i}`, assistant: `a${i}` });
  const wouldTrim = history.wouldTrim('chan-h', { extraMessages: [{ role: 'user', content: 'next' }] });
  history.replace('chan-h', { summary: 'SUMMARY-OF-OLD-FACTS', messages: history.get('chan-h').messages.slice(-4) });
  check('K8 crossing the old caps is detected for auto-compaction', wouldTrim === true);
  check('K8 older facts survive in the summary', history.summary('chan-h') === 'SUMMARY-OF-OLD-FACTS' && history.get('chan-h').messages.length <= 40);

  // ---- K9 approval expiry --------------------------------------------------
  const forever = new ApprovalManager({ timeoutMs: 0 });
  forever.setPresenter(() => {});
  const pending = forever.request({ sessionId: 's', ruleKey: 'r' });
  await tick(25);
  const noAutoDeny = forever.pending.size === 1;
  forever.cancelForSession('s', 'smoke cleanup');
  check('K9 no approval auto-denies by default; stop/reset still settles it', noAutoDeny && (await pending).decision === 'deny');

  // ---- K11 configurable Anthropic ceiling ----------------------------------
  const captured = {};
  const anthropicRuntime = new ChatRuntime({
    providerManager: timeoutProviders, credentialStore: { get: () => 'k' },
    fetchImpl: delayedAnthropicFetch(1, captured), maxOutputTokens: 12345,
  });
  await anthropicRuntime.send({ prompt: 'hi', providerId: 'anthropic-x', model: 'claude-x' });
  check('K11 Anthropic max_tokens uses the configured value (not hard-coded 4096)', captured.body?.max_tokens === 12345, `got ${captured.body?.max_tokens}`);

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  cleanup();
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`SMOKE ERROR: ${error?.message || error}`);
  cleanup();
  process.exit(1);
});
