import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ClaudeRunner } from '../src/claude-runner.mjs';
import { ExecutorManager } from '../src/executor-manager.mjs';
import { DiscordControlPlane, insertMessage } from '../src/discord-ui.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager } from '../src/permission-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { RunLogger } from '../src/logger.mjs';
import { WorkspaceScheduler } from '../src/workspace-scheduler.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';

// ---- ClaudeRunner: injectRequirement writes stdin, not the pending queue -----

function makeRunnerWithFakeChild() {
  const runner = new ClaudeRunner({ command: 'claude', cwd: process.cwd(), onEvent: () => {} });
  const writes = [];
  const stdin = new EventEmitter();
  stdin.write = (chunk) => { writes.push(chunk); return true; };
  runner.child = { pid: 999999, stdin, exitCode: null, killed: false };
  runner.current = { resolve: () => {}, reject: () => {}, textParts: [], tools: [], started: Date.now() };
  return { runner, writes };
}

test('ClaudeRunner.injectRequirement writes a stream-json user message to stdin while busy (not pending)', () => {
  const { runner, writes } = makeRunnerWithFakeChild();
  const result = runner.injectRequirement('also create inserted.txt');
  assert.equal(result.ok, true);
  assert.equal(result.delivered, true);
  assert.equal(writes.length, 1, 'the message must be written immediately');
  const parsed = JSON.parse(writes[0].trim());
  assert.equal(parsed.type, 'user');
  assert.equal(parsed.message.role, 'user');
  assert.equal(parsed.message.content, 'also create inserted.txt');
  assert.equal(runner.pending.length, 0, 'live insert must never enter the pending (next turn) queue');
  assert.equal(runner.injections, 1);
});

test('ClaudeRunner.injectRequirement refuses honestly when idle or dead (fallback triggers)', () => {
  const { runner } = makeRunnerWithFakeChild();
  runner.current = null; // idle
  assert.deepEqual(
    { ok: runner.injectRequirement('x').ok, reason: runner.injectRequirement('x').reason },
    { ok: false, reason: 'not-busy' },
  );
  runner.current = { resolve: () => {}, reject: () => {} };
  runner.child = null; // process gone
  assert.equal(runner.injectRequirement('x').reason, 'not-running');
});

test('ClaudeRunner.send keeps its next-turn semantics and is separate from inject', async () => {
  const { runner } = makeRunnerWithFakeChild();
  const queued = runner.send('second turn');
  // current is still set, so send() queues instead of writing.
  assert.equal(runner.pending.length, 1, 'send() while busy queues a next turn');
  runner.current.resolve({ text: 'first' });
  const queuedRecord = runner.pending[0];
  assert.equal(typeof queuedRecord.prompt, 'string');
  assert.equal(queuedRecord.prompt, 'second turn');
  void queued;
  assert.equal(runner.injections, undefined);
});

// ---- Executor capability ----------------------------------------------------

test('executor capability: Claude-compatible executors advertise live steering, others do not', () => {
  const manager = new ExecutorManager({ workbuddyCommand: 'workbuddy.js' });
  assert.equal(manager.supportsLiveSteering('workbuddy'), true);
  assert.equal(manager.supportsLiveSteering('claude'), true);
  assert.equal(manager.supportsLiveSteering('opencode'), false);
  assert.equal(manager.supportsLiveSteering('codex'), false);
  assert.equal(manager.supportsLiveSteering('nope'), false);
});

// ---- Control plane: same run, same session, no second Agent, no new lock ----

function makePlane({ executorSupportsSteering = true, busy = true } = {}) {
  const fake = new FakeDiscord({ threadCapable: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p22-insert-'));
  const state = new StateStore(path.join(dir, 'state.json'));
  const scheduler = new WorkspaceScheduler();
  const calls = { runner: 0, submit: 0, sends: [], injections: [] };
  const originalSubmit = scheduler.submit.bind(scheduler);

  const runner = {
    sessionId: 'sess-fixed', model: 'deepseek-v4.1-flash', busy, stopped: false, sent: [], idleMs: 0, injected: [],
    injectRequirement(prompt) {
      calls.injections.push(prompt);
      if (!this.busy) return { ok: false, delivered: false, reason: 'not-busy' };
      this.injected.push(prompt);
      return { ok: true, delivered: true, bytes: prompt.length + 40 };
    },
    async send(prompt) {
      this.busy = true;
      this.sent.push(prompt);
      calls.sends.push(prompt);
      plane.onRunnerEvent(this.currentChannelId, { type: 'session', sessionId: this.sessionId });
      if (this.gate) await this.gate;
      this.busy = false;
      return { text: `done:${prompt}`, sessionId: this.sessionId, durationMs: 1, tools: [], isError: false, costUsd: 0 };
    },
    async stop() { this.stopped = true; this.busy = false; if (this.gateResolve) this.gateResolve(); },
  };

  const executorManager = {
    list: () => [], get: () => null,
    compatible: () => true, compatibleExecutors: () => [],
    resolveTransport: () => null, adapterLabel: () => null,
    supportsLiveSteering: () => executorSupportsSteering,
  };

  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: dir, claudeCommand: 'claude',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 1000,
      allowPaidFallback: false, taskTimeoutMs: 5000, maxWorkFollowUps: 10,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 }),
    permissionManager: new PermissionManager(),
    providerManager: { list: () => [], get: () => null, hasCredential: () => true },
    executorManager,
    modelManager: { list: async () => ({ models: [] }), select: async () => {} },
    chatRuntime: { send: async () => ({ text: 'x' }) },
    logger: new RunLogger(path.join(dir, 'logs')),
    backendState: { backend: { label: 'WorkBuddy', model: 'm', free: true }, allowPaidFallback: false },
    workspaceScheduler: scheduler,
    client: fake.client,
    autoLogin: false,
  });
  scheduler.submit = (options) => { calls.submit += 1; return originalSubmit(options); };
  plane.getRunner = async (channelId) => {
    calls.runner += 1;
    runner.currentChannelId = channelId;
    plane.runners.set(channelId, runner); // production getRunner also registers the live runner
    return runner;
  };
  return { fake, plane, runner, scheduler, calls, dir };
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

test('insert while RUNNING: same runId/sessionId, one Agent, one workspace lock, single DONE', async () => {
  const { fake, plane, runner, calls } = makePlane({ busy: true });
  let release;
  runner.gate = new Promise((resolve) => { release = resolve; });
  runner.gateResolve = release;

  await plane.start();
  const pending = fake.sendAsUser({ content: 'work long task', guildId: 'guild-1' });
  await tick(60);

  const thread = fake.threads[0];
  const chain = plane.workChains.get(thread.id);
  const runIdBefore = chain.activeRunId;
  const sessionBefore = plane.sessionManager.get(thread.id).sessionId;

  const inserted = await plane.modalSubmitForTest?.();
  // The owner inserts through the progress-card modal.
  const { followedUp } = await fake.submitModal(`workinsert:${runIdBefore}`, {
    values: { requirement: 'also create inserted.txt' }, channelId: thread.id, guildId: 'guild-1',
  });

  assert.deepEqual(calls.injections, ['also create inserted.txt'], 'the insert must reach injectRequirement');
  assert.deepEqual(runner.injected, ['also create inserted.txt']);
  assert.equal(runner.sent.length, 1, 'no second turn was started');
  assert.equal(calls.runner, 1, 'no second Agent was created');
  assert.equal(calls.submit, 1, 'the workspace lock was acquired exactly once');
  assert.equal(chain.activeRunId, runIdBefore, 'runId must not change');
  assert.equal(plane.sessionManager.get(thread.id).sessionId, sessionBefore, 'sessionId must not change');
  assert.ok(followedUp.some((p) => /已插入当前任务/.test(p.content)), 'the UI must confirm a live insert');
  assert.ok(!followedUp.some((p) => /Queue|队列/.test(p.content)), 'no queue position for a live insert');
  assert.equal(fake.threads.length, 1);

  release();
  await pending;
  await tick(30);
  assert.equal(plane.tasks.size, 0, 'the single run finished');
});

test('insert while RUNNING but turn just ended: continues in the same run/session and is never dropped', async () => {
  const { fake, plane, runner, calls } = makePlane({ busy: true });
  let release;
  runner.gate = new Promise((resolve) => { release = resolve; });
  runner.gateResolve = release;
  await plane.start();
  const pending = fake.sendAsUser({ content: 'work task', guildId: 'guild-1' });
  await tick(60);
  const thread = fake.threads[0];
  const runId = plane.workChains.get(thread.id).activeRunId;

  // Simulate the race: the insert arrives exactly in the instant the turn's
  // process/pipe has finished, while the Work run is still active.
  runner.busy = false;
  const { followedUp } = await fake.submitModal(`workinsert:${runId}`, {
    values: { requirement: 'late requirement' }, channelId: thread.id, guildId: 'guild-1',
  });
  assert.ok(followedUp.some((p) => /当前轮刚结束，已转为同 Session 继续执行/.test(p.content)));
  assert.equal(plane.workRuns.get(runId).continuations.length, 1, 'the demand is not lost');

  release();
  await pending;
  await tick(30);
  assert.equal(calls.runner, 1, 'still one Agent');
  assert.equal(calls.submit, 1, 'no new workspace lock');
  assert.deepEqual(calls.sends, ['task', 'late requirement'], 'executed as turn 2 of the same run');
  assert.equal(plane.tasks.size, 0, 'one final DONE');
});

test('continuation demands not deliverable live run as an extra turn in the SAME task (no new run)', async () => {
  const { fake, plane, runner, calls } = makePlane({ busy: true });
  let release;
  runner.gate = new Promise((resolve) => { release = resolve; });
  runner.gateResolve = release;
  await plane.start();
  const pending = fake.sendAsUser({ content: 'work task', guildId: 'guild-1' });
  await tick(60);
  const thread = fake.threads[0];
  const runId = plane.workChains.get(thread.id).activeRunId;

  // Push a continuation directly (the race/unsupported path) while the run lives.
  plane.workRuns.get(runId).continuations.push({ prompt: 'continuation demand', at: Date.now() });

  release();
  await pending;
  await tick(40);

  assert.deepEqual(calls.sends, ['task', 'continuation demand'], 'the continuation runs as turn 2 of the same task');
  assert.equal(calls.runner, 1, 'no second Agent');
  assert.equal(calls.submit, 1, 'no second workspace lock');
  assert.equal(plane.tasks.size, 0, 'one task, one final DONE');
  assert.match(fake.messagesIn(thread.id).at(-1).content, /done:continuation demand/);
});

test('unsupported executor degrades honestly instead of pretending to insert', async () => {
  const { fake, plane, runner } = makePlane({ executorSupportsSteering: false, busy: true });
  let release;
  runner.gate = new Promise((resolve) => { release = resolve; });
  runner.gateResolve = release;
  await plane.start();
  const pending = fake.sendAsUser({ content: 'work task', guildId: 'guild-1' });
  await tick(60);
  const thread = fake.threads[0];
  const runId = plane.workChains.get(thread.id).activeRunId;

  const { followedUp } = await fake.submitModal(`workinsert:${runId}`, {
    values: { requirement: 'x' }, channelId: thread.id, guildId: 'guild-1',
  });
  assert.ok(followedUp.some((p) => /当前执行器不支持运行中插入，将在当前轮后继续/.test(p.content)));
  assert.equal(plane.workRuns.get(runId).continuations.length, 1, 'the demand is kept as a same-session continuation');
  release();
  await pending;
  await tick(30);
});

test('Stop clears unconsumed inserts/continuations of the stopped Work', async () => {
  const { fake, plane, runner } = makePlane({ busy: true });
  let release;
  runner.gate = new Promise((resolve) => { release = resolve; });
  runner.gateResolve = release;
  await plane.start();
  const pending = fake.sendAsUser({ content: 'work task', guildId: 'guild-1' });
  await tick(60);
  const thread = fake.threads[0];
  const runId = plane.workChains.get(thread.id).activeRunId;
  plane.workRuns.get(runId).continuations.push({ prompt: 'pending demand', at: Date.now() });
  plane.workRuns.get(runId).injected.push({ prompt: 'inserted demand', at: Date.now() });

  const { updated } = await fake.clickButton(`workctl:stop:${runId}`);
  await pending;
  await tick(30);
  assert.equal(plane.workRuns.get(runId) ?? null, null, 'the run is gone');
  assert.equal(runner.stopped, true, 'the real process tree is stopped');
  assert.equal((plane.workChains.get(thread.id)?.followUps ?? []).length, 0);
  void updated;
});

test('insertMessage wording matches the three honest outcomes', () => {
  assert.match(insertMessage('inserted'), /已插入当前任务，Agent 将在下一个安全执行边界读取/);
  assert.match(insertMessage('continued'), /当前轮刚结束，已转为同 Session 继续执行/);
  assert.match(insertMessage('unsupported'), /当前执行器不支持运行中插入，将在当前轮后继续/);
});
