import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiscordControlPlane } from '../src/discord-ui.mjs';
import { ChatRuntime } from '../src/chat-runtime.mjs';
import { ChatHistoryStore } from '../src/chat-history.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager, LEVEL } from '../src/permission-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { RunLogger } from '../src/logger.mjs';
import { PROTOCOL, TRANSPORT } from '../src/provider-manager.mjs';
import { buildCommandPayloads, SLASH_TASK_MAX_LENGTH, MODAL_TASK_MAX_LENGTH } from '../src/commands.mjs';
import { planResultDelivery, chunkDiscordText } from '../src/discord/renderers.mjs';
import { ProviderHealthRegistry } from '../src/provider-health.mjs';
import { RunLimits } from '../src/limits.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';

const OPENCODE_GO = {
  id: 'opencode-go', displayName: 'OpenCode Go', protocol: PROTOCOL.OPENCODE_GO,
  baseUrl: 'https://opencode.ai/zen/go', billingType: 'SUBSCRIPTION', credentialRef: 'provider:opencode-go',
  models: [
    { id: 'deepseek-v4.1-flash', transport: TRANSPORT.OPENAI_CHAT },
    { id: 'glm-5.3-flash', transport: TRANSPORT.OPENAI_CHAT },
  ],
};

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function fakeProviders(profiles = [OPENCODE_GO]) {
  return {
    list: () => profiles,
    get: (id) => profiles.find((profile) => profile.id === id) || null,
    hasCredential: () => true,
    listModels: async (id) => ({ models: profiles.find((profile) => profile.id === id)?.models || [] }),
  };
}

function makeRunner({ text = 'done', hold = null } = {}) {
  return {
    sessionId: 'sess-1', model: 'deepseek-v4.1-flash', busy: false, sent: [], idleMs: 0,
    async send(prompt) {
      this.busy = true;
      this.sent.push(prompt);
      if (hold) await new Promise((resolve) => hold.set(prompt, resolve));
      this.busy = false;
      return { text, sessionId: 'sess-1', durationMs: 1, tools: [], isError: false, costUsd: 0 };
    },
    async stop() { this.busy = false; return { killed: false, pid: null }; },
  };
}

/** Delayed fetch that honours the AbortSignal so a real timeout can be proven. */
function delayedFetch(ms, body) {
  return async (_url, options) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      const signal = options?.signal;
      if (!signal) return;
      if (signal.aborted) { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })); return; }
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
      }, { once: true });
    });
    return jsonResponse(200, body);
  };
}

function makePlane({
  mode = 'chat', runner = null, fetchImpl = null, chatRuntime = null, chatHistory = null,
  maxWorkFollowUps = 0, threadCapable = false, state = null, permissionManager = null,
} = {}) {
  const fake = new FakeDiscord({ threadCapable });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p225-'));
  const store = state ?? new StateStore(path.join(dir, 'state.json'));
  if (mode !== 'chat') store.patchChannel(fake.channelId, { mode }, dir);
  const providers = fakeProviders();
  const runtime = chatRuntime ?? new ChatRuntime({
    providerManager: providers,
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: fetchImpl ?? (async () => jsonResponse(200, { choices: [{ message: { content: 'ok' } }] })),
    timeoutMs: 120000,
  });
  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: dir, claudeCommand: 'claude',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 600000,
      allowPaidFallback: false, taskTimeoutMs: 0, maxWorkFollowUps, autoRegisterCommands: false,
      chatTimeoutMs: 120000,
    },
    state: store,
    approvalManager: new ApprovalManager({ timeoutMs: 0 }),
    permissionManager: permissionManager ?? new PermissionManager(),
    providerManager: providers,
    chatRuntime: runtime,
    chatHistory,
    limits: new RunLimits(),
    logger: new RunLogger(path.join(dir, 'logs')),
    backendState: { backend: { label: 'opencode-go', model: 'deepseek-v4.1-flash' }, allowPaidFallback: false },
    client: fake.client,
    autoLogin: false,
  });
  plane.getRunner = async (channelId) => {
    if (!runner) throw new Error('AGENT_PATH_UNEXPECTED');
    plane.runners.set(channelId, runner);
    return runner;
  };
  return { fake, plane, dir, state: store, chatRuntime: runtime, dirPath: dir };
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await tick(5);
  }
  return false;
}

// --------------------------------------------------------------------------- K1

test('K1: /work slash option uses the real 6000-char Discord maximum', async () => {
  const work = buildCommandPayloads().find((command) => command.name === 'work');
  assert.equal(work.options[0].max_length, 6000);
  assert.equal(SLASH_TASK_MAX_LENGTH, 6000);

  const runner = makeRunner();
  const { fake, plane } = makePlane({ mode: 'work', runner });
  await plane.start();
  const task = 'B'.repeat(5200);
  await fake.command('work', { options: { task } });
  assert.equal(runner.sent[0], task, 'a 5000+ char slash task must reach the runtime intact');
});

// --------------------------------------------------------------------------- K2

test('K2: a near-4000-char task survives the new Work modal extraction intact', async () => {
  assert.equal(MODAL_TASK_MAX_LENGTH, 4000);
  const runner = makeRunner();
  const { fake, plane } = makePlane({ mode: 'work', runner });
  await plane.start();
  const task = 'M'.repeat(3999);
  await fake.submitModal('workmodal:task', { values: { task } });
  assert.equal(runner.sent[0], task, 'the modal must not cut a near-4000 char task');
});

// --------------------------------------------------------------------------- K3

test('K3: ~8k Chat output is delivered/recoverable in full with no truncation marker', async () => {
  const big = 'Z'.repeat(8192);
  const plan = planResultDelivery(big);
  assert.equal(plan.totalChars, 8192);
  if (plan.mode === 'chunks') {
    assert.equal(plan.chunks.join(''), big, 'chunks must reconstruct the exact text');
  } else {
    assert.equal(plan.mode, 'attachment');
    assert.equal(plan.attachment.content, big, 'the attachment must carry the exact text');
  }

  const { fake, plane } = makePlane({
    fetchImpl: async () => jsonResponse(200, { choices: [{ message: { content: big } }] }),
  });
  await plane.start();
  await fake.sendAsUser({ content: 'long answer please' });
  const replies = fake.messagesIn(fake.channelId).map((m) => m.content).join('');
  assert.ok(replies.includes(big), 'the full 8k Chat answer must be recoverable');
  assert.ok(!replies.includes('(truncated)'), 'a real answer must never be presented as truncated');
});

test('K3: ~8k Work output is delivered in full while the progress card stays compact', async () => {
  const big = 'W'.repeat(8192);
  const runner = makeRunner({ text: big });
  const { fake, plane } = makePlane({ mode: 'work', runner });
  await plane.start();
  await fake.sendAsUser({ content: 'do the long work' });

  const all = fake.messages.map((m) => m.content).join('');
  assert.ok(all.includes(big), 'the full 8k Work result must be delivered');
  const card = fake.messages.find((m) => m.content.includes('✅ 已完成'));
  assert.ok(card, 'the run must render a terminal card');
  assert.ok(card.content.length < 2000, `the card must stay compact (len=${card.content.length})`);
  assert.ok(!card.content.includes('W'.repeat(1300)), 'the card must not embed the full long result');
});

test('K3: chunker never drops or rewrites a character', () => {
  const sample = `${'a'.repeat(500)}\n${'b'.repeat(3000)}\n${'c'.repeat(2500)}`;
  assert.equal(chunkDiscordText(sample).join(''), sample);
});

// --------------------------------------------------------------------------- K4

test('K4: FULL persists across restarts and session/model changes, and Work threads inherit it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p225-perm-'));
  const stateFile = path.join(dir, 'state.json');
  const state = new StateStore(stateFile);
  const permissions = new PermissionManager({
    initialLevels: state.allPermissionLevels(),
    onChange: (channelId, level) => state.setPermissionLevel(channelId, level),
  });

  const runner = makeRunner();
  const { fake, plane } = makePlane({ threadCapable: true, state, permissionManager: permissions, runner });
  await plane.start();

  permissions.confirmFull(fake.channelId);
  assert.equal(state.getPermissionLevel(fake.channelId), LEVEL.FULL, 'the tier must be persisted');

  // Bridge restart: a fresh manager restored from durable state is still FULL.
  const restored = new PermissionManager({ initialLevels: new StateStore(stateFile).allPermissionLevels() });
  assert.equal(restored.getLevel(fake.channelId), LEVEL.FULL);

  // A model/provider/session change must not silently downgrade.
  await plane.sessionManager.change(fake.channelId, { model: 'glm-5.3-flash' }, 'model changed');
  assert.equal(plane.permissionManager.getLevel(fake.channelId), LEVEL.FULL);

  // A new Work thread inherits the effective parent tier exactly, including FULL.
  await fake.sendAsUser({ content: 'work threaded task', guildId: 'guild-1' });
  const thread = fake.threadFor(fake.channelId);
  assert.ok(thread, 'a Work thread must be created');
  assert.equal(plane.permissionManager.getLevel(thread.id), LEVEL.FULL);
  assert.equal(state.getPermissionLevel(thread.id), LEVEL.FULL, 'the inherited tier is persisted too');
});

// --------------------------------------------------------------------------- K5

test('K5: historical failures/restarts never block a later valid Work', async () => {
  const runner = makeRunner();
  const { fake, plane } = makePlane({ mode: 'work', runner });
  await plane.start();

  for (let i = 0; i < 4; i += 1) plane.limits.noteFailure(fake.channelId, new Error('boom'));
  for (let i = 0; i < 6; i += 1) plane.limits.noteProcessRestart(fake.channelId);
  assert.equal(plane.limits.blocked(fake.channelId).blocked, false);

  await fake.sendAsUser({ content: 'a known-good task' });
  assert.deepEqual(runner.sent, ['a known-good task'], 'a later valid Work is accepted without !reset');
  assert.equal(plane.limits.blocked(fake.channelId).warning, null, 'a success clears the episode diagnostic');
});

// --------------------------------------------------------------------------- K6

test('K6: default Chat timeout is practical; a slow response survives and a short override times out', async () => {
  const providers = fakeProviders();
  const runtime = (timeoutMs) => new ChatRuntime({
    providerManager: providers,
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: delayedFetch(60, { choices: [{ message: { content: 'slow-ok' } }] }),
    timeoutMs,
  });

  // The 120s default comfortably covers a 45s-class response.
  assert.equal((await runtime(120000).send({ prompt: 'hi' })).text, 'slow-ok');
  // 0 means no client-side timeout at all.
  assert.equal((await runtime(0).send({ prompt: 'hi' })).text, 'slow-ok');
  // An explicit tiny override still aborts (a manual pin rethrows the real code).
  await assert.rejects(
    runtime(20).send({ prompt: 'hi', providerId: 'opencode-go', model: 'deepseek-v4.1-flash' }),
    (error) => error.code === 'TIMEOUT',
  );
});

// --------------------------------------------------------------------------- K7

test('K7: cooldowns are observable and owner clear resets only the intended entry', async () => {
  const { fake, plane, chatRuntime } = makePlane();
  await plane.start();
  chatRuntime.health.noteFailure('opencode-go', 'deepseek-v4.1-flash', Object.assign(new Error('rate'), { code: 'RATE_LIMIT' }));
  chatRuntime.health.noteFailure('litellm', 'chat-fast', Object.assign(new Error('boom'), { code: 'PROVIDER_ERROR' }));

  await fake.sendAsUser({ content: '!cooldown' });
  const listing = fake.messages.at(-1).content;
  assert.match(listing, /opencode-go/);
  assert.match(listing, /剩余/);

  await fake.sendAsUser({ content: '!chatmodel opencode-go deepseek-v4.1-flash' });
  await fake.sendAsUser({ content: '!status' });
  assert.match(fake.messages.at(-1).content, /冷却/, 'status must surface the pinned route cooldown');

  await fake.sendAsUser({ content: '!cooldown clear opencode-go deepseek-v4.1-flash' });
  assert.equal(chatRuntime.health.canTry('opencode-go', 'deepseek-v4.1-flash'), true, 'the intended entry is cleared');
  assert.equal(chatRuntime.health.canTry('litellm', 'chat-fast'), false, 'unrelated providers stay untouched');
});

test('provider health list reports reason and remaining cooldown time', () => {
  let now = 1000;
  const health = new ProviderHealthRegistry({ now: () => now, cooldownsMs: { RATE_LIMIT: 100 } });
  health.noteFailure('p', 'm', Object.assign(new Error('rate'), { code: 'RATE_LIMIT' }));
  const [entry] = health.list();
  assert.equal(entry.providerId, 'p');
  assert.equal(entry.modelId, 'm');
  assert.equal(entry.lastErrorCode, 'RATE_LIMIT');
  assert.equal(entry.remainingMs, 100);
  now += 60;
  assert.equal(health.list()[0].remainingMs, 40);
});

// --------------------------------------------------------------------------- K8

test('K8: crossing the old history caps auto-compacts instead of silently dropping context', async () => {
  const calls = [];
  const chatRuntime = {
    health: new ProviderHealthRegistry(),
    async send({ prompt, system }) {
      calls.push({ prompt, system });
      if (String(system).includes('摘要')) return { text: 'SUMMARY-KEEPS-FACT-OLD', model: 'm', providerId: 'p', providerName: 'P' };
      return { text: 'reply', model: 'm', providerId: 'p', providerName: 'P' };
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p225-history-'));
  const chatHistory = new ChatHistoryStore({ file: path.join(dir, 'chat-history.json') });
  chatHistory.appendTurn('chan-1', { user: 'FACT-OLD', assistant: 'ack' });
  for (let i = 1; i < 20; i += 1) chatHistory.appendTurn('chan-1', { user: `u${i}`, assistant: `a${i}` });
  assert.equal(chatHistory.stats('chan-1').messages, 40);

  const { fake, plane } = makePlane({ chatRuntime, chatHistory });
  await plane.start();
  await fake.sendAsUser({ content: 'a new question' });

  assert.ok(String(chatHistory.summary('chan-1')).includes('SUMMARY-KEEPS-FACT-OLD'), 'older context is compacted into the summary');
  assert.ok(chatHistory.get('chan-1').messages.length <= 40, 'history stays bounded');
  assert.ok(calls.some((call) => String(call.prompt).includes('FACT-OLD')), 'older facts are sent to the compactor');
});

test('K8: a failed auto-compact preserves history and warns instead of dropping it', async () => {
  const chatRuntime = {
    health: new ProviderHealthRegistry(),
    async send({ system }) {
      if (String(system).includes('摘要')) throw Object.assign(new Error('compactor down'), { code: 'PROVIDER_ERROR' });
      return { text: 'reply', model: 'm', providerId: 'p', providerName: 'P' };
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p225-history-fail-'));
  const chatHistory = new ChatHistoryStore({ file: path.join(dir, 'chat-history.json') });
  for (let i = 0; i < 20; i += 1) chatHistory.appendTurn('chan-1', { user: `u${i}`, assistant: `a${i}` });

  const { fake, plane } = makePlane({ chatRuntime, chatHistory });
  await plane.start();
  await fake.sendAsUser({ content: 'another question' });

  assert.equal(chatHistory.get('chan-1').messages.length, 40, 'the stored context must not be dropped');
  assert.equal(chatHistory.summary('chan-1'), null, 'no fake summary is invented');
  assert.match(fake.messages.at(-1).content, /自动压缩未成功|未写入历史/);
});

test('ChatHistoryStore.wouldTrim mirrors the destructive trim decision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p225-wouldtrim-'));
  const store = new ChatHistoryStore({ file: path.join(dir, 'h.json'), maxMessages: 4, maxChars: 100000 });
  store.appendTurn('c', { user: 'u1', assistant: 'a1' });
  store.appendTurn('c', { user: 'u2', assistant: 'a2' });
  assert.equal(store.wouldTrim('c', { extraMessages: [] }), false);
  assert.equal(store.wouldTrim('c', { extraMessages: [{ role: 'user', content: 'u3' }] }), true);
});

// --------------------------------------------------------------------------- K9

test('K9: no approval auto-expiry by default; a positive value still expires', async () => {
  const forever = new ApprovalManager({ timeoutMs: 0 });
  forever.setPresenter(() => { /* hold forever */ });
  const pending = forever.request({ sessionId: 's', ruleKey: 'r' });
  await tick(10);
  assert.equal(forever.pending.size, 1, 'APPROVAL_TIMEOUT_MS=0 must not arm any timer');
  forever.cancelForSession('s', 'cleanup');
  assert.equal((await pending).decision, 'deny', 'stop/reset still settles outstanding approvals');

  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const bounded = new ApprovalManager({ timeoutMs: 540000 });
    bounded.setPresenter(() => { /* hold */ });
    const p = bounded.request({ sessionId: 's2', ruleKey: 'r' });
    mock.timers.tick(540001);
    const answer = await p;
    assert.equal(answer.decision, 'deny');
    assert.match(answer.reason, /timed out/, 'a positive override still enforces expiry');
  } finally {
    mock.timers.reset();
  }
});

// --------------------------------------------------------------------------- K10

test('K10: >10 follow-ups are accepted when the cap is unlimited (default 0)', async () => {
  const fake = new FakeDiscord();
  fake.addChannel({ id: 'chan-2' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p225-follow-'));
  const state = new StateStore(path.join(dir, 'state.json'));
  const providers = fakeProviders();
  const release = new Map();
  const runners = new Map();
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
    logger: new RunLogger(path.join(dir, 'logs')),
    backendState: { backend: { label: 'opencode-go', model: 'deepseek-v4.1-flash' }, allowPaidFallback: false },
    client: fake.client,
    autoLogin: false,
  });
  for (const id of [fake.channelId, 'chan-2']) {
    state.patchChannel(id, { mode: 'work', cwd: dir, executorId: 'claude', providerId: 'opencode-go', model: 'deepseek-v4.1-flash' }, dir);
  }
  plane.getRunner = async (channelId) => {
    let runner = runners.get(channelId);
    if (!runner) {
      runner = {
        sessionId: `sess-${channelId}`, model: 'deepseek-v4.1-flash', busy: false, sent: [], idleMs: 0,
        async send(prompt) {
          this.busy = true;
          this.sent.push(prompt);
          await new Promise((resolve) => release.set(channelId, resolve));
          this.busy = false;
          return { text: `done:${prompt}`, sessionId: this.sessionId, durationMs: 1, tools: [], isError: false, costUsd: 0 };
        },
        async stop() { this.busy = false; release.get(channelId)?.(); return { killed: false, pid: null }; },
      };
      runners.set(channelId, runner);
      plane.runners.set(channelId, runner);
    }
    return runner;
  };

  await plane.start();
  const a = fake.sendAsUser({ content: 'task A', channelId: fake.channelId });
  await waitFor(() => plane.scheduler.stateFor(fake.channelId).state === 'running');
  const b = fake.sendAsUser({ content: 'task B', channelId: 'chan-2' });
  await waitFor(() => plane.scheduler.stateFor('chan-2').state === 'queued');

  for (let i = 1; i <= 12; i += 1) await fake.sendAsUser({ content: `f${i}`, channelId: 'chan-2' });
  assert.equal(plane.workChains.get('chan-2').followUps.length, 12, 'unlimited follow-ups must all be accepted');
  assert.ok(!fake.texts().some((text) => /追加队列已满/.test(text)), 'no hidden 10-item rejection');

  release.get(fake.channelId)?.();
  await waitFor(() => plane.scheduler.stateFor('chan-2').state === 'running');
  release.get('chan-2')?.();
  await a;
  await b;
});
