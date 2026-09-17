/**
 * P2.2.4 Work lifecycle / insert / terminal-state regression.
 *
 * Deterministic, no model, no network. Drives the real DiscordControlPlane
 * lifecycle:
 *   1. result + continuation -> no intermediate DONE;
 *   2. a completed turn's result stays visible while the continuation starts;
 *   3. a consumed live insert is never later reported unprocessed;
 *   4. an executed continuation is removed from the durable pending store;
 *   5. one Stop press settles an active tool/insert run;
 *   6. a repeated Stop is idempotent;
 *   7. terminal cards expose no live controls;
 *   8. a stale control from a prior run cannot control the current run;
 *   9. DONE/STOPPED/FAILED are mutually exclusive and monotonic;
 *  10. insert/continuation never create a second Agent or workspace lock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiscordControlPlane, INSERT_STATE } from '../src/discord-ui.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager } from '../src/permission-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { RunLogger } from '../src/logger.mjs';
import { WorkspaceScheduler } from '../src/workspace-scheduler.mjs';
import { workControlRows } from '../src/discord/renderers.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await tick(10);
  }
  return false;
}

function defer() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function makePlane() {
  const fake = new FakeDiscord({ threadCapable: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p224-life-'));
  const state = new StateStore(path.join(dir, 'state.json'));
  state.patchChannel(fake.channelId, {
    mode: 'work', cwd: dir, executorId: 'claude', providerId: 'opencode-go', model: 'deepseek-v4.1-flash',
  }, dir);
  const scheduler = new WorkspaceScheduler();
  const calls = { runner: 0, submit: 0 };
  const durable = { adds: [], removes: [] };
  const durableStore = {
    runStart: () => {}, runFinish: () => {},
    followUpAdd: (row) => { durable.adds.push({ ...row }); },
    followUpRemove: (id, { state } = {}) => { durable.removes.push({ id, state }); },
    followUpsClear: (channelId, { state } = {}) => { durable.removes.push({ id: `clear:${channelId}`, state }); },
  };
  const gates = new Map();
  const results = new Map();
  let turn = 0;

  const runner = {
    sessionId: 'sess-fixed', model: 'deepseek-v4.1-flash', busy: false, stopped: 0, sent: [], idleMs: 0, injected: [],
    injectRequirement(prompt) {
      if (!this.busy) return { ok: false, delivered: false, reason: 'not-busy' };
      this.injected.push(prompt);
      return { ok: true, delivered: true, bytes: prompt.length + 40 };
    },
    async send(prompt) {
      turn += 1;
      this.busy = true;
      this.sent.push(prompt);
      const gate = gates.get(turn);
      if (gate) await gate.promise;
      this.busy = false;
      return results.get(turn) ?? {
        text: `done:${prompt}`, sessionId: this.sessionId, durationMs: 1, tools: [], isError: false, costUsd: 0,
      };
    },
    async stop() {
      this.stopped += 1;
      this.busy = false;
      for (const gate of gates.values()) gate.resolve?.();
      return { killed: true, pid: 4242 };
    },
  };

  const executorManager = {
    list: () => [], get: () => null, compatible: () => true, compatibleExecutors: () => [],
    resolveTransport: () => null, adapterLabel: () => null, supportsLiveSteering: () => true,
  };

  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: dir, claudeCommand: 'claude',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 600000,
      allowPaidFallback: false, taskTimeoutMs: 0, maxWorkFollowUps: 10,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 }),
    permissionManager: new PermissionManager(),
    providerManager: { list: () => [], get: () => null, hasCredential: () => true },
    executorManager,
    modelManager: { list: async () => ({ models: [] }), select: async () => {} },
    chatRuntime: { send: async () => ({ text: 'x' }) },
    logger: new RunLogger(path.join(dir, 'logs')),
    backendState: { backend: { label: 'opencode-go', model: 'deepseek-v4.1-flash' }, allowPaidFallback: false },
    workspaceScheduler: scheduler,
    durableStore,
    client: fake.client,
    autoLogin: false,
  });
  const originalSubmit = scheduler.submit.bind(scheduler);
  scheduler.submit = (options) => { calls.submit += 1; return originalSubmit(options); };
  plane.getRunner = async (channelId) => {
    calls.runner += 1;
    plane.runners.set(channelId, runner);
    return runner;
  };
  return { fake, plane, runner, scheduler, calls, durable, gates, results, dir };
}

const channel = (fake) => fake.channelId;
const activeRun = (plane, ch) => {
  const chain = plane.workChains.get(ch);
  return chain?.activeRunId ? plane.workRuns.get(chain.activeRunId) : null;
};
const cardsText = (fake, ch) => fake.messagesIn(ch).map((m) => m.content).join('\n');

async function startWork(fake, plane, runner, gates, task = 'long task') {
  const gate = defer();
  gates.set(1, gate);
  const pending = fake.sendAsUser({ content: `work ${task}` });
  assert.ok(await waitFor(() => plane.tasks.has(channel(fake)) && runner.busy), 'the run must reach RUNNING');
  const status = plane.tasks.get(channel(fake)).statusMessage;
  const run = activeRun(plane, channel(fake));
  assert.ok(run, 'a live run exists');
  return { pending, gate, status, run };
}

// --------------------------------------------------------------------- 1 + 2

test('P2.2.4: a result with a pending continuation never renders an intermediate DONE and preserves the turn result', async () => {
  const { fake, plane, runner, calls, gates } = makePlane();
  await plane.start();
  const ch = channel(fake);
  const { pending, gate, status, run } = await startWork(fake, plane, runner, gates, 'long task');

  // The owner inserts while the turn just ended: it becomes a same-run continuation.
  runner.busy = false;
  const inserted = await fake.submitModal(`workinsert:${run.id}`, {
    values: { requirement: 'second requirement' }, channelId: ch,
  });
  assert.match(inserted.followedUp.map((p) => p.content).join('\n'), /当前轮刚结束，已转为同 Session 继续执行/);
  assert.equal(run.continuations.length, 1);

  // Gate the continuation so the intermediate state is observable.
  const gate2 = defer();
  gates.set(2, gate2);
  gate.resolve();
  assert.ok(await waitFor(() => runner.sent.length === 2), 'the continuation turn must start');

  // 1: no false DONE while the same Work is still running.
  assert.doesNotMatch(status.content, /✅ 已完成/, 'the card must not claim DONE between turns');
  // 2: the completed turn result is preserved on its own message.
  assert.ok(
    fake.messagesIn(ch).some((m) => /第 1 轮已完成/.test(m.content) && /done:long task/.test(m.content)),
    'the turn 1 result must remain visible as its own message',
  );

  gate2.resolve();
  await pending;
  await tick(30);
  assert.match(status.content, /✅ 已完成/, 'the final turn renders DONE');
  const doneTokens = (cardsText(fake, ch).match(/✅ 已完成/g) ?? []).length;
  assert.equal(doneTokens, 1, 'exactly one terminal DONE is ever shown');
  // 10: no duplicate Agent/run/lock.
  assert.equal(calls.runner, 1, 'one Agent');
  assert.equal(calls.submit, 1, 'one workspace lock');
  assert.deepEqual(runner.sent, ['long task', 'second requirement']);
});

// --------------------------------------------------------------------------- 4

test('P2.2.4: an executed continuation leaves no stale pending durable record', async () => {
  const { fake, plane, runner, durable, gates } = makePlane();
  await plane.start();
  const ch = channel(fake);
  const { pending, gate, run } = await startWork(fake, plane, runner, gates, 'task');

  runner.busy = false;
  await fake.submitModal(`workinsert:${run.id}`, { values: { requirement: 'continuation demand' }, channelId: ch });
  const queuedAdd = durable.adds.find((row) => row.state === INSERT_STATE.QUEUED_CONTINUATION);
  assert.ok(queuedAdd, 'the continuation is recorded as QUEUED_CONTINUATION');
  assert.equal(durable.adds.length, 1);

  gate.resolve();
  await pending;
  await tick(30);
  assert.ok(
    durable.removes.some((row) => row.id === queuedAdd.id && row.state === 'EXECUTED'),
    'the executed continuation transitions out of pending in the durable store',
  );
  assert.equal(run.continuations.length, 0, 'no stale runtime pending record');
  assert.equal(run.injected.length, 0);
});

// --------------------------------------------------------------------------- 3

test('P2.2.4: a live insert consumed by the completed turn is never reported unprocessed', async () => {
  const { fake, plane, runner, durable, gates } = makePlane();
  await plane.start();
  const ch = channel(fake);
  const { pending, gate, status, run } = await startWork(fake, plane, runner, gates, 'install task');

  const inserted = await fake.submitModal(`workinsert:${run.id}`, {
    values: { requirement: 'change the install path' }, channelId: ch,
  });
  assert.match(inserted.followedUp.map((p) => p.content).join('\n'), /已插入当前任务/);
  assert.equal(run.injected.length, 1);
  assert.equal(run.injected[0].state, INSERT_STATE.DELIVERED_LIVE);

  gate.resolve();
  await pending;
  await tick(30);

  // The delivery was consumed by the turn that completed after it.
  assert.equal(run.injected.length, 0, 'the live insert is no longer pending');
  assert.equal(run.settledInserts.length, 1);
  assert.equal(run.settledInserts[0].state, INSERT_STATE.CONSUMED);
  assert.ok(
    durable.removes.some((row) => row.state === INSERT_STATE.CONSUMED),
    'the durable record is settled as CONSUMED',
  );

  // A later Stop must not claim the applied requirement was unprocessed.
  await fake.sendAsUser({ content: '!stop' });
  const stopText = fake.messagesIn(ch).at(-1).content;
  assert.doesNotMatch(stopText, /未处理的插入需求/, 'a consumed insert must not be counted as unprocessed');
  assert.match(status.content, /✅ 已完成/);
});

// --------------------------------------------------------------------------- 5 + 6 + 7

test('P2.2.4: a single Stop press kills the run, clears controls, and repeats are idempotent', async () => {
  const { fake, plane, runner, scheduler, gates } = makePlane();
  await plane.start();
  const ch = channel(fake);
  const { gate, status, run } = await startWork(fake, plane, runner, gates, 'stop-me task');

  // A tool call is active and a live insert exists when Stop lands.
  await fake.submitModal(`workinsert:${run.id}`, { values: { requirement: 'live requirement' }, channelId: ch });
  assert.equal(run.injected.length, 1);
  const runId = run.id;

  const card = fake.messagesIn(ch).find((m) => m.buttonIds.some((id) => id.startsWith('workctl:stop:')));
  const stopId = card.buttonIds.find((id) => id.startsWith('workctl:stop:'));
  await fake.clickButton(stopId);
  await tick(30);

  // One press settles everything.
  assert.equal(runner.stopped, 1, 'the process tree is killed exactly once');
  assert.equal(plane.workRuns.has(runId), false, 'the run is settled');
  assert.equal(scheduler.stateFor(ch).state === 'running', false, 'the workspace lock is released');
  assert.equal(run.terminal, 'CANCELLED', 'the run reached the STOPPED terminal state');
  const stopReply = fake.messagesIn(ch).map((m) => m.content).join('\n');
  assert.match(stopReply, /已停止 Agent 进程树（pid 4242）/, 'the real kill is reported');
  // 7: terminal card has no live controls.
  assert.equal(status.buttonIds.filter((id) => id.startsWith('workctl:')).length, 0, 'STOPPED card has no controls');

  // 6: a repeated Stop is harmless and does not touch anything.
  await fake.sendAsUser({ content: '!stop' });
  assert.match(fake.messagesIn(ch).at(-1).content, /任务已结束/);
  assert.equal(runner.stopped, 1, 'a second Stop does not kill again');
  void gate;
});

// --------------------------------------------------------------------------- 8

test('P2.2.4: a stale Stop control from a finished run cannot stop the current run', async () => {
  const { fake, plane, runner, gates } = makePlane();
  await plane.start();
  const ch = channel(fake);

  // First run completes.
  const first = await startWork(fake, plane, runner, gates, 'first task');
  const staleRunId = first.run.id;
  first.gate.resolve();
  await first.pending;
  await tick(30);
  assert.equal(plane.workRuns.has(staleRunId), false);

  // Second run is active.
  const secondGate = defer();
  gates.set(2, secondGate);
  const second = fake.sendAsUser({ content: 'work second task' });
  assert.ok(await waitFor(() => runner.sent.length === 2 && runner.busy));
  const liveRun = activeRun(plane, ch);
  assert.notEqual(liveRun.id, staleRunId);
  const stoppedBefore = runner.stopped;

  // Re-materialise the stale card, exactly like an old Discord message.
  await fake.channel.send({ content: 'stale card', components: workControlRows(staleRunId) });
  const click = await fake.clickButton(`workctl:stop:${staleRunId}`);
  assert.match(String(click.interaction.replied?.content ?? ''), /该任务已结束/);
  assert.equal(runner.stopped, stoppedBefore, 'the stale control must not kill the newer run');
  assert.equal(plane.workRuns.has(liveRun.id), true, 'the newer run is untouched');

  secondGate.resolve();
  await second;
});

// --------------------------------------------------------------------------- 9

test('P2.2.4: DONE / STOPPED / FAILED are mutually exclusive and terminal state is monotonic', async () => {
  const { fake, plane, runner, gates, results } = makePlane();
  await plane.start();
  const ch = channel(fake);

  // Run A completes DONE, then a late Stop must not turn it into STOPPED.
  const a = await startWork(fake, plane, runner, gates, 'done task');
  a.gate.resolve();
  await a.pending;
  await tick(30);
  assert.equal(a.run.terminal, 'DONE');
  await fake.sendAsUser({ content: '!stop' });
  assert.equal(a.run.terminal, 'DONE', 'a finished DONE run cannot become STOPPED');
  assert.equal((cardsText(fake, ch).match(/已停止/g) ?? []).length, 0, 'no STOPPED label appears for a DONE run');

  // Run B fails: FAILED is terminal and cannot become DONE.
  const bGate = defer();
  gates.set(2, bGate);
  results.set(2, { text: 'boom', sessionId: 'sess-fixed', durationMs: 1, tools: [], isError: true, costUsd: 0 });
  const b = fake.sendAsUser({ content: 'work failing task' });
  assert.ok(await waitFor(() => runner.sent.length === 2));
  const runB = activeRun(plane, ch);
  bGate.resolve();
  await b;
  await tick(30);
  assert.equal(runB.terminal, 'FAILED');
  await fake.sendAsUser({ content: '!stop' });
  assert.equal(runB.terminal, 'FAILED', 'FAILED is monotonic');
});
