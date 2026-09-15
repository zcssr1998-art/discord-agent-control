import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiscordControlPlane } from '../src/discord-ui.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager } from '../src/permission-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { RunLogger } from '../src/logger.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const CHAN_A = 'chan-1';
const CHAN_B = 'chan-2';

const provider = {
  id: 'opencode-go', displayName: 'OpenCode Go', protocol: 'opencode-go',
  baseUrl: 'https://opencode.ai/zen/go', billingType: 'SUBSCRIPTION', credentialRef: 'provider:opencode-go',
  models: [{ id: 'deepseek-v4.1-flash' }],
};

function makeQueuePlane({ sameWorkspace = true } = {}) {
  const fake = new FakeDiscord();
  fake.addChannel({ id: CHAN_B });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p1-queue-'));
  const dirA = path.join(root, 'a');
  const dirB = sameWorkspace ? dirA : path.join(root, 'b');
  fs.mkdirSync(dirA, { recursive: true });
  if (!sameWorkspace) fs.mkdirSync(dirB, { recursive: true });

  const state = new StateStore(path.join(root, 'state.json'));
  for (const [id, cwd] of [[CHAN_A, dirA], [CHAN_B, dirB]]) {
    state.patchChannel(id, {
      mode: 'work', cwd, executorId: 'claude', providerId: 'opencode-go', model: 'deepseek-v4.1-flash',
    }, cwd);
  }

  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: dirA, claudeCommand: 'claude',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 1000,
      allowPaidFallback: false, taskTimeoutMs: 5000,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 }),
    permissionManager: new PermissionManager(),
    logger: new RunLogger(path.join(root, 'logs')),
    backendState: { backend: { label: 'WorkBuddy', model: 'm', free: true }, allowPaidFallback: false },
    client: fake.client,
    autoLogin: false,
  });

  const gates = new Map();
  const started = [];
  plane.getRunner = async (channelId) => {
    started.push(channelId);
    const gate = {};
    gate.promise = new Promise((resolve) => { gate.resolve = resolve; });
    gates.set(channelId, gate);
    return {
      sessionId: `sess-${channelId}`, model: 'deepseek-v4.1-flash', busy: false, stopped: false, sent: [], idleMs: 0,
      async send(prompt) {
        this.busy = true;
        this.sent.push(prompt);
        plane.onRunnerEvent(channelId, { type: 'session', sessionId: this.sessionId });
        await gate.promise;
        this.busy = false;
        return { text: 'ok', sessionId: this.sessionId, durationMs: 1, tools: [], isError: false, costUsd: 0 };
      },
      async stop() { this.stopped = true; this.busy = false; gate.resolve(); },
    };
  };

  return { fake, plane, started, finish: (id) => gates.get(id)?.resolve(), dirA, dirB };
}

test('a second task on the same workspace queues and does not create a runner until the first finishes', async () => {
  const { fake, plane, started, finish } = makeQueuePlane();
  await plane.start();

  const first = fake.sendAsUser({ content: 'task one', channelId: CHAN_A });
  await tick(20);
  assert.equal(plane.scheduler.stateFor(CHAN_A).state, 'running');

  const second = fake.sendAsUser({ content: 'task two', channelId: CHAN_B });
  await tick(20);

  assert.deepEqual(started, [CHAN_A], 'the queued task must not start a runner');
  assert.equal(plane.scheduler.stateFor(CHAN_B).state, 'queued');
  assert.equal(plane.scheduler.stateFor(CHAN_B).position, 1);
  assert.ok(fake.messagesIn(CHAN_B).some((m) => /Workspace busy/.test(m.content)), 'the queued channel is told why');

  finish(CHAN_A);
  await first;
  await tick(20);

  assert.deepEqual(started, [CHAN_A, CHAN_B], 'the queued task starts exactly once after release');
  assert.ok(fake.messagesIn(CHAN_B).some((m) => /获得工作区锁|已开始/.test(m.content)), 'the queued channel is told it started');

  finish(CHAN_B);
  await second;
});

test('!stop on a queued task removes only that queued request and leaves the active owner alone', async () => {
  const { fake, plane, started, finish } = makeQueuePlane();
  await plane.start();

  const first = fake.sendAsUser({ content: 'task one', channelId: CHAN_A });
  await tick(20);
  const second = fake.sendAsUser({ content: 'task two', channelId: CHAN_B });
  await tick(20);
  assert.equal(plane.scheduler.stateFor(CHAN_B).state, 'queued');

  await fake.sendAsUser({ content: '!stop', channelId: CHAN_B });
  assert.equal(plane.scheduler.stateFor(CHAN_B).state, 'idle');
  assert.equal(plane.scheduler.stateFor(CHAN_A).state, 'running', 'the active owner must be untouched');
  assert.ok(fake.messagesIn(CHAN_B).some((m) => /已取消排队中/.test(m.content)));

  finish(CHAN_A);
  await first;
  await second;
  await tick(20);

  assert.deepEqual(started, [CHAN_A], 'the cancelled queued task must never start a runner');
});

test('different workspaces run concurrently', async () => {
  const { fake, plane, started, finish } = makeQueuePlane({ sameWorkspace: false });
  await plane.start();

  const first = fake.sendAsUser({ content: 'task one', channelId: CHAN_A });
  const second = fake.sendAsUser({ content: 'task two', channelId: CHAN_B });
  await tick(20);

  assert.equal(plane.scheduler.stateFor(CHAN_A).state, 'running');
  assert.equal(plane.scheduler.stateFor(CHAN_B).state, 'running');
  assert.deepEqual(started.sort(), [CHAN_A, CHAN_B].sort());

  finish(CHAN_A);
  finish(CHAN_B);
  await Promise.all([first, second]);
});

test('!status reports queued work with its queue position', async () => {
  const { fake, plane, finish } = makeQueuePlane();
  await plane.start();

  const first = fake.sendAsUser({ content: 'task one', channelId: CHAN_A });
  await tick(20);
  const second = fake.sendAsUser({ content: 'task two', channelId: CHAN_B });
  await tick(20);

  await fake.sendAsUser({ content: '!status', channelId: CHAN_B });
  const status = fake.messagesIn(CHAN_B).at(-1).content;
  assert.match(status, /Work 状态：queued \(#1\)/);

  finish(CHAN_A);
  await first;
  await tick(20);
  finish(CHAN_B);
  await second;
});
