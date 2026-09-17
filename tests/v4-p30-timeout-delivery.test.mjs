/**
 * P3.0 — timeout / result-delivery semantics.
 *
 * The invariant: time alone is never a failure condition for valid owner work.
 * A Discord connect timeout must not lose a completed result, must not fail the
 * Worker execution, and must be recoverable without rerunning the Work.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiscordControlPlane } from '../src/discord-ui.mjs';
import { DurableStore } from '../src/durable-store.mjs';
import { ResultDelivery, DELIVERY } from '../src/result-delivery.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager } from '../src/permission-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { RunLogger } from '../src/logger.mjs';
import { PROTOCOL, TRANSPORT } from '../src/provider-manager.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

const connectTimeout = () => Object.assign(
  new Error('Connect Timeout Error (attempted addresses: 162.159.128.233:443, timeout: 10000ms)'),
  { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' },
);

/** Deterministic timer seam: nothing fires unless the test fires it. */
function manualTimers() {
  const timers = [];
  return {
    setTimer: (fn, ms) => { const entry = { fn, ms, cleared: false }; timers.push(entry); return entry; },
    clearTimer: (entry) => { if (entry) entry.cleared = true; },
    pending: () => timers.filter((entry) => !entry.cleared).length,
    async fireNext() {
      const entry = timers.find((item) => !item.cleared);
      if (!entry) return false;
      entry.cleared = true;
      await entry.fn();
      return true;
    },
  };
}

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p30-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'jarvis.db') };
}

const deliveryState = (store, id) => store.db.prepare('SELECT state, attempts, delivered_parts, content FROM result_deliveries WHERE id = ?').get(id);

// ---------------------------------------------------------------- unit: result delivery

test('P3.0: full result is persisted before the first send and survives a connect timeout', async (t) => {
  const { file } = tmpStore(t);
  const store = new DurableStore({ file, logger: null });
  store.open();
  const timers = manualTimers();
  const delivery = new ResultDelivery({ store, setTimer: timers.setTimer, clearTimer: timers.clearTimer, maxAttempts: 5, backoffMs: [10, 20, 30] });

  const content = `FULL_RESULT ${'x'.repeat(200)}`;
  const record = delivery.prepare({ channelId: 'c1', label: 'work', content });
  // Persisted BEFORE any send.
  const row = deliveryState(store, record.id);
  assert.equal(row.state, DELIVERY.PENDING);
  assert.equal(row.content, content);

  const sent = [];
  let attempts = 0;
  const send = async (payload) => {
    attempts += 1;
    if (attempts === 1) throw connectTimeout();
    sent.push(payload.content);
  };
  const first = await delivery.deliver(record, { send, resolveSend: async () => send });
  assert.equal(first.ok, false);
  assert.equal(record.state, DELIVERY.PENDING, 'a transport fault must not be a delivery failure');
  assert.equal(deliveryState(store, record.id).state, DELIVERY.PENDING);
  assert.equal(sent.length, 0, 'nothing was delivered yet');

  // The scheduled retry recovers the SAME result without any rerun.
  assert.equal(await timers.fireNext(), true);
  assert.equal(record.state, DELIVERY.DELIVERED);
  assert.equal(attempts, 2);
  assert.deepEqual(sent, [content]);
  assert.equal(deliveryState(store, record.id).state, DELIVERY.DELIVERED);
  assert.equal(delivery.pending().length, 0);
  store.close();
});

test('P3.0: repeated failure is bounded and stays recoverable (no infinite hot loop)', async (t) => {
  const { file } = tmpStore(t);
  const store = new DurableStore({ file, logger: null });
  store.open();
  const timers = manualTimers();
  const delivery = new ResultDelivery({ store, setTimer: timers.setTimer, clearTimer: timers.clearTimer, maxAttempts: 3, backoffMs: [1, 1, 1] });
  const record = delivery.prepare({ channelId: 'c1', label: 'work', content: 'RESULT' });

  let attempts = 0;
  const failing = async () => { attempts += 1; throw connectTimeout(); };
  await delivery.deliver(record, { send: failing, resolveSend: async () => failing });
  await timers.fireNext();
  await timers.fireNext();
  assert.equal(attempts, 3, 'attempts must be bounded');
  assert.equal(record.state, DELIVERY.DEGRADED);
  assert.equal(timers.pending(), 0, 'no timer remains after the budget is spent');
  assert.equal(deliveryState(store, record.id).state, DELIVERY.DEGRADED);
  // DEGRADED is recoverable, not a terminal loss.
  assert.equal(store.pendingDeliveries().length, 1);
  store.close();
});

test('P3.0: a partial chunk delivery resumes and never re-sends delivered chunks', async (t) => {
  const { file } = tmpStore(t);
  const store = new DurableStore({ file, logger: null });
  store.open();
  const timers = manualTimers();
  const delivery = new ResultDelivery({ store, setTimer: timers.setTimer, clearTimer: timers.clearTimer, maxAttempts: 5, backoffMs: [1] });
  // 4999 chars -> 3 ordered chunks (each <= Discord limit).
  const content = 'A'.repeat(4999);
  const record = delivery.prepare({ channelId: 'c1', label: 'work', content });

  const sent = [];
  let calls = 0;
  const send = async (payload) => {
    calls += 1;
    if (calls === 3) throw connectTimeout();
    sent.push(payload.content);
  };
  await delivery.deliver(record, { send, resolveSend: async () => send });
  assert.equal(record.state, DELIVERY.PENDING);
  assert.equal(record.deliveredParts, 2, 'the two delivered chunks are recorded');
  const afterFirst = [...sent];

  await timers.fireNext();
  assert.equal(record.state, DELIVERY.DELIVERED);
  // Only the missing third chunk was sent on retry.
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.slice(0, 2), afterFirst);
  assert.equal(afterFirst.join('') + sent[2], content);
  store.close();
});

test('P3.0: an attachment delivery is reconstructed and resumed after a restart', async (t) => {
  const { file } = tmpStore(t);
  const first = new DurableStore({ file, logger: null });
  first.open();
  const timers = manualTimers();
  const delivery = new ResultDelivery({ store: first, setTimer: timers.setTimer, clearTimer: timers.clearTimer, maxAttempts: 5, backoffMs: [1] });
  const big = 'B'.repeat(12000); // > max chunks -> attachment
  const record = delivery.prepare({ channelId: 'c9', label: 'work', content: big });
  const failing = async () => { throw connectTimeout(); };
  await delivery.deliver(record, { send: failing, resolveSend: async () => failing });
  assert.equal(record.state, DELIVERY.PENDING);
  first.close();

  // "Bridge restart": a fresh store + manager over the same DB resumes the row.
  const second = new DurableStore({ file, logger: null });
  second.open();
  const timers2 = manualTimers();
  const delivery2 = new ResultDelivery({ store: second, setTimer: timers2.setTimer, clearTimer: timers2.clearTimer, maxAttempts: 5, backoffMs: [1] });
  const payloads = [];
  const resumed = await delivery2.resumePending({ resolveSend: async () => async (payload) => { payloads.push(payload); } });
  assert.equal(resumed.length, 1);
  await timers2.fireNext();
  assert.equal(delivery2.status().delivered, 1);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].file.content, big, 'the full result is recovered from the outbox');
  assert.match(payloads[0].content, /完整内容见附件/);
  second.close();
});

// ------------------------------------------------------------- integration: Work + Discord

const OPENCODE_GO = {
  id: 'opencode-go', displayName: 'OpenCode Go', protocol: PROTOCOL.OPENCODE_GO,
  baseUrl: 'https://example.invalid/v1', billingType: 'SUBSCRIPTION', credentialRef: 'provider:opencode-go',
  models: [{ id: 'deepseek-v4.1-flash', transport: TRANSPORT.OPENAI_CHAT }],
};

function makePlane({ resultText = 'done', sendDelayMs = 0, taskTimeoutMs = 0, deliverySend = null, timers = null, stallNoticeMs = 50 } = {}) {
  const fake = new FakeDiscord({ threadCapable: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p30-plane-'));
  const store = new DurableStore({ file: path.join(dir, 'jarvis.db'), logger: null });
  store.open();
  const state = new StateStore(path.join(dir, 'state.json'));
  const calls = { send: 0 };
  const providers = {
    list: () => [OPENCODE_GO], get: (id) => (id === OPENCODE_GO.id ? OPENCODE_GO : null), hasCredential: () => true,
  };
  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: dir, claudeCommand: 'claude',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs,
      allowPaidFallback: false, taskTimeoutMs, maxWorkFollowUps: 10,
      deliverySend,
      deliverySetTimer: timers?.setTimer,
      deliveryClearTimer: timers?.clearTimer,
      deliveryBackoffMs: [1],
      deliveryMaxAttempts: 5,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 }),
    permissionManager: new PermissionManager(),
    providerManager: providers,
    modelManager: { select: async () => {}, list: async () => ({ models: OPENCODE_GO.models }) },
    executorManager: {
      list: () => [], get: () => null, compatible: () => true, compatibleExecutors: () => [],
      resolveTransport: () => TRANSPORT.OPENAI_CHAT, adapterLabel: () => null,
    },
    logger: new RunLogger(path.join(dir, 'logs')),
    backendState: { backend: { label: 'opencode-go', model: 'deepseek-v4.1-flash' }, allowPaidFallback: false },
    durableStore: store,
    client: fake.client,
    autoLogin: false,
  });
  plane.getRunner = async (channelId) => {
    const runner = {
      sessionId: `sess-${channelId}`, model: 'deepseek-v4.1-flash', busy: false, idleMs: 0,
      async send(prompt) {
        calls.send += 1;
        this.busy = true;
        // Periodic progress keeps the stall watchdog as a notice, never a failure.
        const timer = setInterval(() => plane.onRunnerEvent(channelId, { type: 'text', text: '.' }), Math.max(1, Math.floor(sendDelayMs / 4)));
        try {
          if (sendDelayMs) await tick(sendDelayMs);
          return { text: resultText, sessionId: this.sessionId, durationMs: sendDelayMs, tools: [], isError: false, costUsd: 0 };
        } finally {
          clearInterval(timer);
          this.busy = false;
        }
      },
      async stop() { this.busy = false; },
    };
    plane.runners.set(channelId, runner);
    return runner;
  };
  return { fake, plane, store, calls, dir };
}

test('P3.0: a Discord connect timeout does not lose a completed Work result or rerun the Agent', async (t) => {
  const timers = manualTimers();
  const big = `WORK_RESULT ${'W'.repeat(1300)}`;
  let failFirst = true;
  const sent = [];
  const { fake, plane, store, calls } = makePlane({
    resultText: big,
    deliverySend: async (body) => {
      if (failFirst) { failFirst = false; throw connectTimeout(); }
      sent.push(body.content);
    },
    timers,
  });
  t.after(() => { plane.delivery.stop(); store.close(); });
  await plane.start();
  state_MODE_WORK(plane, fake.channelId);

  await fake.sendAsUser({ content: 'do the long work', channelId: fake.channelId });

  // Execution succeeded exactly once.
  assert.equal(calls.send, 1, 'the Agent must run exactly once');
  const run = store.recentRuns(1)[0];
  assert.equal(run.state, 'DONE', 'a transport failure must not fail the Worker execution');
  // Delivery is pending, with the full result durably stored.
  const pending = store.pendingDeliveries();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].content.includes('WORK_RESULT'), true);
  assert.equal(plane.delivery.status().pending, 1);

  // Status surfaces the separation truthfully.
  await fake.sendAsUser({ content: '!status', channelId: fake.channelId });
  assert.ok(fake.texts().some((text) => /Result delivery: PENDING x1/.test(text)), '!status must show PENDING delivery');

  // A retry (no rerun) delivers the full result.
  await fake.sendAsUser({ content: '!redeliver', channelId: fake.channelId });
  assert.equal(plane.delivery.status().delivered, 1);
  assert.ok(sent.some((text) => text.includes(big)), 'the full result is delivered once');
  assert.equal(calls.send, 1, 'redelivery must never rerun the Work');
  assert.equal(store.pendingDeliveries().length, 0);
});

test('P3.0: an unlimited Work with a long silent phase is not failed by elapsed time', async (t) => {
  const timers = manualTimers();
  const { fake, plane, store } = makePlane({ resultText: 'LONG_DONE', sendDelayMs: 160, taskTimeoutMs: 0, stallNoticeMs: 10, timers });
  t.after(() => { plane.delivery.stop(); store.close(); });
  await plane.start();
  state_MODE_WORK(plane, fake.channelId);

  await fake.sendAsUser({ content: 'long task', channelId: fake.channelId });
  const run = store.recentRuns(1)[0];
  assert.equal(run.state, 'DONE', 'duration alone must never fail an otherwise live task');
  assert.ok(fake.texts().some((text) => /LONG_DONE|已完成/.test(text)), 'the result is reported');
  assert.ok(!fake.texts().some((text) => /达到时间上限/.test(text)), 'no timer-only timeout state');
});

test('P3.0: an explicit operator duration cap is still honored (opt-in only)', async (t) => {
  const timers = manualTimers();
  const { fake, plane, store } = makePlane({ resultText: 'TOO_LATE', sendDelayMs: 200, taskTimeoutMs: 40, timers });
  t.after(() => { plane.delivery.stop(); store.close(); });
  await plane.start();
  state_MODE_WORK(plane, fake.channelId);

  await fake.sendAsUser({ content: 'capped task', channelId: fake.channelId });
  const run = store.recentRuns(1)[0];
  assert.equal(run.state, 'TIMEOUT', 'an explicitly configured positive cap still stops the task');
  await tick(250); // let the capped runner settle before teardown
});

function state_MODE_WORK(plane, channelId) {
  plane.sessionManager.setMode(channelId, 'work');
}
