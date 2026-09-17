import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiscordControlPlane, formatUptime, wsStatusText } from '../src/discord-ui.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager } from '../src/permission-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { RunLogger } from '../src/logger.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

function makePlane({ threadCapable = true, hold = false } = {}) {
  const fake = new FakeDiscord({ threadCapable });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p22-ctl-'));
  const state = new StateStore(path.join(dir, 'state.json'));
  const providers = {
    id: 'opencode-go', list: () => [], get: () => null, hasCredential: () => true, listModels: async () => ({ models: [] }),
  };
  const executorManager = {
    list: () => [{ id: 'claude', displayName: 'Claude Code', available: true, adapterReady: true, status: 'PASS', version: '1' }],
    get: () => ({ id: 'claude', displayName: 'Claude Code', available: true, adapterReady: true, status: 'PASS', version: '1' }),
    compatible: () => true,
    compatibleExecutors: () => [],
    resolveTransport: () => null,
    adapterLabel: () => null,
  };
  const calls = { chat: 0, runner: 0 };
  const gate = {};
  gate.promise = new Promise((resolve) => { gate.resolve = resolve; });

  const runtimeIdentity = {
    describe: 'jarvis-v4-p2-2-hardening@3fc0c35',
    guard: { acquired: true, info: { instanceId: 'a1b2c3d4:9999' } },
  };
  const durableStore = {
    status: () => ({ open: true, file: 'x', schemaVersion: 1, runCount: 3, pendingFollowups: 1 }),
    runStart: () => {}, runFinish: () => {}, followUpAdd: () => {}, followUpClear: () => {},
    followUpRemove: () => {}, followUpsClear: () => {},
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
    providerManager: providers,
    executorManager,
    modelManager: { list: async () => ({ models: [] }), select: async () => {} },
    chatRuntime: { send: async () => { calls.chat += 1; return { text: 'x', providerId: 'p', model: 'm' }; } },
    logger: new RunLogger(path.join(dir, 'logs')),
    backendState: { backend: { label: 'WorkBuddy', model: 'm', free: true }, allowPaidFallback: false },
    runtimeIdentity,
    durableStore,
    client: fake.client,
    autoLogin: false,
  });

  plane.getRunner = async (channelId) => {
    calls.runner += 1;
    return {
      sessionId: `sess-${channelId}`, model: 'deepseek-v4.1-flash', busy: false, stopped: false, sent: [], idleMs: 0,
      async send(prompt) {
        this.busy = true;
        plane.onRunnerEvent(channelId, { type: 'session', sessionId: this.sessionId });
        if (hold) await gate.promise;
        this.busy = false;
        return { text: `done:${prompt}`, sessionId: this.sessionId, durationMs: 3, tools: [], isError: false, costUsd: 0 };
      },
      async stop() { this.stopped = true; this.busy = false; gate.resolve(); },
    };
  };

  return { fake, plane, dir, calls, gate };
}

test('!status shows real runtime/build/instance identity plus autostart state', async () => {
  const { fake, plane } = makePlane();
  await plane.start();
  await fake.sendAsUser({ content: '!status' });
  const text = fake.messagesIn(fake.channelId).at(-1).content;
  assert.match(text, /Build: jarvis-v4-p2-2-hardening@3fc0c35/);
  assert.match(text, /Runtime: PID \d+ · uptime /);
  assert.match(text, /Instance: a1b2c3d4/);
});

test('!doctor is local/deterministic, reports identity/store/gateway and never calls a model', async () => {
  const { fake, plane, calls } = makePlane();
  await plane.start();
  await fake.sendAsUser({ content: '!doctor' });
  const text = fake.messagesIn(fake.channelId).at(-1).content;
  assert.match(text, /Doctor/);
  assert.match(text, /Instance: PID \d+/);
  assert.match(text, /Instance lock: yes/);
  assert.match(text, /Durable store: open \(v1, 3 runs, 1 pending/);
  assert.match(text, /Discord: /);
  assert.match(text, /Executors: /);
  assert.match(text, /Autostart: /);
  assert.equal(calls.chat, 0, 'doctor must not call the model runtime');
  assert.equal(calls.runner, 0, 'doctor must not start an agent');
});

test('formatUptime / wsStatusText are deterministic', () => {
  assert.equal(formatUptime(0), '0s');
  assert.equal(formatUptime(3 * 1000), '3s');
  assert.equal(formatUptime(2 * 3600 * 1000 + 13 * 60 * 1000), '2h13m');
  assert.equal(wsStatusText(1), 'connected');
});

test('guild Work posts one compact parent card bound to the live runId, then clears controls', async () => {
  const { fake, plane, gate } = makePlane({ threadCapable: true, hold: true });
  await plane.start();

  const pending = fake.sendAsUser({ content: 'work fix the flaky test', guildId: 'guild-1' });
  await tick(200);

  const thread = fake.threads[0];
  assert.ok(thread, 'a Work thread is created');
  const parentMessages = fake.messagesIn(fake.channelId);
  const card = parentMessages.find((m) => /🛠 Work ·/.test(m.content));
  assert.ok(card, 'the parent gets a compact Work summary card');
  assert.match(card.content, /fix the flaky test/);
  assert.match(card.content, /RUNNING|QUEUED/);
  const ids = card.buttonIds;
  assert.ok(ids.includes('workctl:append:' + plane.workChains.get(thread.id).activeRunId), 'append is bound to the live runId');
  assert.ok(ids.includes('workctl:stop:' + plane.workChains.get(thread.id).activeRunId), 'stop is bound to the live runId');
  assert.ok(ids.some((id) => id.startsWith('workctl:')), 'card exposes Work controls');

  gate.resolve();
  await pending;
  await tick(30);
  assert.match(card.content, /DONE/);
  assert.equal(card.buttonIds.filter((id) => id.startsWith('workctl:')).length, 0,
    'a finished card must not keep controls that could affect a newer run');
});
