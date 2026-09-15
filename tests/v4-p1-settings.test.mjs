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

const EXECUTORS = [
  { id: 'workbuddy', displayName: 'WorkBuddy', available: true, adapterReady: true, status: 'PASS', version: '1.0' },
  { id: 'claude', displayName: 'Claude Code', available: true, adapterReady: true, status: 'PASS', version: '2.0' },
];

const PROVIDERS = [
  { id: 'workbuddy-free', displayName: 'WorkBuddy Free', protocol: 'workbuddy', billingType: 'FREE', models: [] },
  { id: 'opencode-go', displayName: 'OpenCode Go', protocol: 'opencode-go', billingType: 'SUBSCRIPTION', credentialRef: 'provider:opencode-go', models: [{ id: 'deepseek-v4.1-flash' }, { id: 'glm-5.3-flash' }] },
];

function makeSettingsPlane({ hold = false } = {}) {
  const fake = new FakeDiscord();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p1-settings-'));
  const state = new StateStore(path.join(dir, 'state.json'));

  const providerManager = {
    list: () => PROVIDERS,
    get: (id) => PROVIDERS.find((item) => item.id === id) || null,
    hasCredential: () => true,
    listModels: async (id) => ({ models: PROVIDERS.find((item) => item.id === id)?.models || [] }),
  };
  const executorManager = {
    list: () => EXECUTORS,
    get: (id) => EXECUTORS.find((item) => item.id === id) || null,
    compatible: () => true,
    compatibleExecutors: () => EXECUTORS,
    resolveTransport: () => null,
    adapterLabel: () => null,
  };
  const modelManager = { select: async () => {}, list: async () => ({ models: [] }) };

  const chatRuntime = { send: async () => ({ text: 'chat', providerId: 'opencode-go', providerName: 'OpenCode Go', model: 'deepseek-v4.1-flash', attempts: [] }) };

  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: dir, claudeCommand: 'claude',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 1000,
      allowPaidFallback: false, taskTimeoutMs: 5000,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 }),
    permissionManager: new PermissionManager(),
    providerManager,
    executorManager,
    modelManager,
    chatRuntime,
    logger: new RunLogger(path.join(dir, 'logs')),
    backendState: { backend: { label: 'WorkBuddy', model: 'm', free: true }, allowPaidFallback: false },
    client: fake.client,
    autoLogin: false,
  });

  const calls = { getRunner: 0, chat: 0 };
  const gate = {};
  gate.promise = new Promise((resolve) => { gate.resolve = resolve; });
  plane.getRunner = async (channelId) => {
    calls.getRunner += 1;
    return {
      sessionId: `sess-${channelId}`, model: 'deepseek-v4.1-flash', busy: false, sent: [], idleMs: 0,
      async send() {
        this.busy = true;
        if (hold) await gate.promise;
        this.busy = false;
        return { text: 'ok', sessionId: `sess-${channelId}`, durationMs: 1, tools: [], isError: false, costUsd: 0 };
      },
      async stop() { this.busy = false; },
    };
  };
  const originalChatSend = chatRuntime.send;
  chatRuntime.send = async (...args) => { calls.chat += 1; return originalChatSend(...args); };

  return { fake, plane, dir, calls, gate };
}

const lastText = (fake) => fake.messages.at(-1)?.content ?? '';

test('!settings renders current Chat and Work state', async () => {
  const { fake, plane } = makeSettingsPlane();
  await plane.start();

  await fake.sendAsUser({ content: '!settings' });
  const text = lastText(fake);
  assert.match(text, /Jarvis Settings/);
  assert.match(text, /CHAT/);
  assert.match(text, /Route: AUTO/);
  assert.match(text, /WORK/);
  assert.match(text, /Executor: WorkBuddy/);
  assert.match(text, /Provider: WorkBuddy Free/);
  assert.match(text, /State: idle/);

  const menu = fake.messages.at(-1);
  assert.ok(menu.buttonIds.includes('set:chatauto'));
  assert.ok(menu.buttonIds.includes('set:executor'));
});

test('settings controls mutate the same persisted state as the text commands', async () => {
  const { fake, plane } = makeSettingsPlane();
  await plane.start();

  // Chat route reset reuses setChatSelection.
  await fake.sendAsUser({ content: '!chatmodel opencode-go deepseek-v4.1-flash' });
  assert.equal(plane.sessionManager.get(fake.channelId).chatProviderId, 'opencode-go');
  await fake.sendAsUser({ content: '!settings' });
  await fake.clickButton('set:chatauto');
  assert.equal(plane.sessionManager.get(fake.channelId).chatProviderId, 'auto');

  // Executor choice reuses #switchExecutor.
  await fake.sendAsUser({ content: '!settings' });
  await fake.clickButton('set:executor');
  await fake.clickButton('setexec:claude');
  assert.equal(plane.sessionManager.get(fake.channelId).executorId, 'claude');

  // Provider choice reuses #switchProvider.
  await fake.sendAsUser({ content: '!settings' });
  await fake.clickButton('set:provider');
  await fake.clickButton('setprov:opencode-go');
  assert.equal(plane.sessionManager.get(fake.channelId).providerId, 'opencode-go');

  // Model choice reuses #selectModel.
  await fake.sendAsUser({ content: '!settings' });
  await fake.clickButton('set:model');
  await fake.clickButton('setmodel:glm-5.3-flash');
  assert.equal(plane.sessionManager.get(fake.channelId).model, 'glm-5.3-flash');
});

test('settings interactions never create a runner or call ChatRuntime', async () => {
  const { fake, plane, calls } = makeSettingsPlane();
  await plane.start();

  await fake.sendAsUser({ content: '!settings' });
  await fake.clickButton('set:refresh');
  await fake.clickButton('set:executor');
  await fake.clickButton('setexec:workbuddy');
  await fake.sendAsUser({ content: '!settings' });
  await fake.clickButton('set:chatauto');
  await fake.sendAsUser({ content: '!settings' });
  await fake.clickButton('set:permission');

  assert.equal(calls.getRunner, 0, 'settings must not start an Agent');
  assert.equal(calls.chat, 0, 'settings must not call ChatRuntime');
});

test('changing executor while a Work task runs fails safely without mutating state', async () => {
  const { fake, plane, gate } = makeSettingsPlane({ hold: true });
  await plane.start();

  const task = fake.sendAsUser({ content: 'work long task' });
  await tick(20);
  assert.equal(plane.scheduler.stateFor(fake.channelId).state, 'running');

  await fake.sendAsUser({ content: '!settings' });
  await fake.clickButton('set:executor');
  await fake.clickButton('setexec:claude');

  assert.equal(plane.sessionManager.get(fake.channelId).executorId, 'workbuddy', 'a running task must not be reconfigured');
  assert.ok(fake.texts().some((t) => /当前任务正在执行/.test(t)));

  gate.resolve();
  await task;
});

test('queue state is shown in !settings', async () => {
  const { fake, plane, gate } = makeSettingsPlane();
  await plane.start();

  // Hold the workspace with an unrelated active entry, then queue this channel.
  plane.scheduler.submit({ workspace: plane.sessionManager.get(fake.channelId).cwd, channelId: 'other', run: async () => { await gate.promise; } });
  const queued = plane.scheduler.submit({ workspace: plane.sessionManager.get(fake.channelId).cwd, channelId: fake.channelId, run: async () => {} });
  assert.equal(plane.scheduler.stateFor(fake.channelId).state, 'queued');

  await fake.sendAsUser({ content: '!settings' });
  assert.match(lastText(fake), /State: queued \(#1\)/);

  gate.resolve();
  await queued.done;
});

test('a permanent Work thread cannot be flipped to Chat through settings or the chat command', async () => {
  const { fake, plane } = makeSettingsPlane();
  const threadId = 'thread-9';
  fake.addChannel({ id: threadId });
  plane.state.patchChannel(threadId, { mode: 'work', workThread: true, parentChannelId: fake.channelId }, plane.config.defaultCwd);
  await plane.start();

  await fake.sendAsUser({ content: '!settings', channelId: threadId });
  const menu = fake.messages.at(-1);
  assert.ok(!menu.buttonIds.some((id) => /chat/i.test(id)), 'no settings control may flip the thread to Chat');

  await fake.sendAsUser({ content: 'chat', channelId: threadId });
  assert.equal(plane.sessionManager.get(threadId).mode, 'work');
  assert.match(lastText(fake), /Work 线程/);
});
