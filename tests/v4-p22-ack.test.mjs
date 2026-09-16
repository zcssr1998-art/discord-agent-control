import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiscordControlPlane, classifyInteractionError } from '../src/discord-ui.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager } from '../src/permission-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { RunLogger } from '../src/logger.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';

const UNKNOWN_INTERACTION = () => Object.assign(new Error('Unknown interaction'), {
  name: 'DiscordAPIError', code: 10062, status: 404,
});

function makePlane({ ackFailure = null, threadCapable = true } = {}) {
  const fake = new FakeDiscord({ threadCapable, ackFailure });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p22-ack-'));
  const state = new StateStore(path.join(dir, 'state.json'));
  const executorManager = {
    list: () => [], get: () => null, compatible: () => true, compatibleExecutors: () => [],
    resolveTransport: () => null, adapterLabel: () => null,
  };
  const calls = { runner: 0, chat: 0 };
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
    chatRuntime: { send: async () => { calls.chat += 1; return { text: 'x', providerId: 'p', model: 'm' }; } },
    logger: new RunLogger(path.join(dir, 'logs')),
    backendState: { backend: { label: 'WorkBuddy', model: 'm', free: true }, allowPaidFallback: false },
    client: fake.client,
    autoLogin: false,
  });
  plane.getRunner = async (channelId) => {
    calls.runner += 1;
    return {
      sessionId: `sess-${channelId}`, model: 'm', busy: false, stopped: false, sent: [], idleMs: 0,
      async send(prompt) {
        this.busy = true;
        plane.onRunnerEvent(channelId, { type: 'session', sessionId: this.sessionId });
        this.busy = false;
        return { text: `done:${prompt}`, sessionId: this.sessionId, durationMs: 1, tools: [], isError: false, costUsd: 0 };
      },
      async stop() { this.stopped = true; this.busy = false; },
    };
  };
  // Capture stderr so the abort log is assertable without spamming the test run.
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => { errors.push(args.join(' ')); };
  plane.__restoreConsole = () => { console.error = originalError; };
  return { fake, plane, calls, errors };
}

test('classifyInteractionError names the real Discord cause', () => {
  assert.equal(classifyInteractionError(UNKNOWN_INTERACTION()).type, 'UnknownInteraction');
  assert.equal(classifyInteractionError(Object.assign(new Error('x'), { name: 'DiscordAPIError', code: 40060 })).type, 'InteractionAlreadyAcknowledged');
  assert.equal(classifyInteractionError(Object.assign(new Error('x'), { name: 'InteractionAlreadyReplied' })).type, 'InteractionAlreadyReplied');
  assert.equal(classifyInteractionError(new Error('boom')).type, 'Error');
  assert.equal(classifyInteractionError(UNKNOWN_INTERACTION()).code, 10062);
});

test('/work with a task: a rejected deferReply creates no thread and starts no Agent', async () => {
  const { fake, plane, calls, errors } = makePlane({ ackFailure: { method: 'deferReply', error: UNKNOWN_INTERACTION() } });
  try {
    await plane.start();
    const { interaction } = await fake.command('work', { options: { task: 'do the thing' }, guildId: 'guild-1' });

    assert.equal(fake.threads.length, 0, 'no Work thread may be created when the ACK failed');
    assert.equal(calls.runner, 0, 'no Agent may be started when the ACK failed');
    assert.equal(plane.workChains.size, 0, 'no Work chain state may be created');
    assert.equal(interaction.deferred, false);
    assert.equal(plane.lastAck.result, 'FAIL');
    assert.equal(plane.lastAck.reason.type, 'UnknownInteraction');
    assert.match(plane.lastAck.label, /^\/work$/);
    assert.ok(errors.some((line) => /ACK FAIL/.test(line) && /code=10062/.test(line)), 'the failure must be logged with the real code');
    assert.ok(errors.some((line) => /no Work thread, no filesystem write, no Agent start/.test(line)));
  } finally {
    plane.__restoreConsole();
  }
});

test('/work with a task: a successful ACK logs PASS with latency, then creates the thread', async () => {
  const { fake, plane, calls } = makePlane();
  try {
    await plane.start();
    await fake.command('work', { options: { task: 'do the thing' }, guildId: 'guild-1' });
    assert.equal(fake.threads.length, 1, 'a successful ACK allows the Work thread');
    assert.equal(calls.runner, 1, 'the Agent starts only after a successful ACK');
    assert.equal(plane.lastAck.result, 'PASS');
    assert.equal(plane.lastAck.label, '/work');
    assert.ok(Number.isFinite(plane.lastAck.latencyMs));
    // Timing observation required for real-machine smoke:
    // receivedAt → ackStartedAt → ackCompletedAt → latencyMs.
    assert.ok(Number.isFinite(plane.lastAck.requestReceivedAt));
    assert.ok(Number.isFinite(plane.lastAck.ackStartedAt));
    assert.ok(Number.isFinite(plane.lastAck.ackCompletedAt));
    assert.ok(plane.lastAck.ackCompletedAt >= plane.lastAck.ackStartedAt);
    assert.equal(plane.lastAck.latencyMs, plane.lastAck.ackCompletedAt - plane.lastAck.ackStartedAt);
  } finally {
    plane.__restoreConsole();
  }
});

test('/work without a task: a rejected showModal performs no side effect', async () => {
  const { fake, plane, calls, errors } = makePlane({ ackFailure: { method: 'showModal', error: UNKNOWN_INTERACTION() } });
  try {
    await plane.start();
    const { interaction } = await fake.command('work', { options: {}, guildId: 'guild-1' });
    assert.equal(fake.threads.length, 0, 'showModal failure must not create a thread');
    assert.equal(calls.runner, 0);
    assert.equal(interaction.deferred, false);
    assert.equal(plane.lastAck.result, 'FAIL');
    assert.equal(plane.lastAck.method, 'showModal');
    assert.ok(errors.some((line) => /showModal/.test(line) && /ABORTED/.test(line)));
  } finally {
    plane.__restoreConsole();
  }
});

test('/work without a task: a successful showModal is the ACK (PASS) and shows the modal', async () => {
  const { fake, plane } = makePlane();
  try {
    await plane.start();
    const { modal } = await fake.command('work', { options: {}, guildId: 'guild-1' });
    assert.ok(modal, 'the new-Work modal is shown');
    assert.equal(plane.lastAck.result, 'PASS');
    assert.equal(plane.lastAck.method, 'showModal');
    assert.equal(fake.threads.length, 0, 'showing the modal never starts Work by itself');
  } finally {
    plane.__restoreConsole();
  }
});

test('modal submit: a rejected deferReply creates no thread and starts no Agent', async () => {
  const { fake, plane, calls, errors } = makePlane({ ackFailure: { method: 'deferReply', error: UNKNOWN_INTERACTION() } });
  try {
    await plane.start();
    const { interaction } = await fake.submitModal('workmodal:task', {
      values: { task: 'from the modal' }, guildId: 'guild-1',
    });
    assert.equal(fake.threads.length, 0, 'a failed modal ACK must not create the Work thread');
    assert.equal(calls.runner, 0, 'no Agent may start after a failed modal ACK');
    assert.equal(interaction.deferred, false);
    assert.equal(plane.lastAck.result, 'FAIL');
    assert.equal(plane.lastAck.method, 'deferReply(ephemeral)');
    assert.ok(errors.some((line) => /modal:workmodal:task/.test(line) && /ABORTED/.test(line)));
  } finally {
    plane.__restoreConsole();
  }
});

test('modal submit: a successful deferReply allows the Work thread', async () => {
  const { fake, plane, calls } = makePlane();
  try {
    await plane.start();
    await fake.submitModal('workmodal:task', { values: { task: 'from the modal' }, guildId: 'guild-1' });
    assert.equal(plane.lastAck.result, 'PASS');
    assert.equal(plane.lastAck.method, 'deferReply(ephemeral)');
    assert.equal(fake.threads.length, 1, 'the thread is created only after a successful modal ACK');
    assert.equal(calls.runner, 1);
  } finally {
    plane.__restoreConsole();
  }
});

test('an already acknowledged interaction is skipped, not treated as a failure', async () => {
  const { fake, plane } = makePlane();
  try {
    await plane.start();
    const { interaction } = await fake.command('status', { guildId: 'guild-1' });
    // First ACK was a real deferReply; re-running #acknowledge semantics is
    // observable through the recorded SKIP path.
    assert.equal(plane.lastAck.result, 'PASS');
    interaction.deferred = true;
    const again = await plane.onInteraction(interaction).then(() => plane.ackLog.at(-1));
    assert.equal(again.result, 'SKIP');
  } finally {
    plane.__restoreConsole();
  }
});
