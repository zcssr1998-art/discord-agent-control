import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiscordControlPlane, PANEL_HELP_TEXT } from '../src/discord-ui.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager } from '../src/permission-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { RunLogger } from '../src/logger.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

const PROVIDERS = [
  { id: 'workbuddy-free', displayName: 'WorkBuddy Free', protocol: 'workbuddy', billingType: 'FREE', models: [] },
  {
    id: 'opencode-go', displayName: 'OpenCode Go', protocol: 'opencode-go', billingType: 'SUBSCRIPTION',
    credentialRef: 'provider:opencode-go', models: [{ id: 'deepseek-v4.1-flash' }, { id: 'glm-5.3-flash' }],
  },
];

const EXECUTORS = [
  { id: 'workbuddy', displayName: 'WorkBuddy', available: true, adapterReady: true, status: 'PASS', version: '1.0' },
  { id: 'claude', displayName: 'Claude Code', available: true, adapterReady: true, status: 'PASS', version: '2.0' },
];

function fakeProviders(profiles = PROVIDERS) {
  return {
    list: () => profiles,
    get: (id) => profiles.find((item) => item.id === id) || null,
    hasCredential: () => true,
    listModels: async (id) => ({ models: profiles.find((item) => item.id === id)?.models || [] }),
  };
}

function makePlane({
  threadCapable = false, threadFailure = false, stateFile = null, hold = false, executorCompatible = null,
} = {}) {
  const fake = new FakeDiscord({ threadCapable, threadFailure });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p2-panel-'));
  const file = stateFile || path.join(dir, 'state.json');
  const state = new StateStore(file);
  const providers = fakeProviders();
  const executorManager = {
    list: () => EXECUTORS,
    get: (id) => EXECUTORS.find((item) => item.id === id) || null,
    compatible: (executorId, protocol) => (executorCompatible ? executorCompatible(executorId, protocol) : true),
    compatibleExecutors: () => EXECUTORS,
    resolveTransport: () => null,
    adapterLabel: () => null,
  };
  const modelManager = { select: async () => {}, list: async (id) => ({ models: providers.get(id)?.models || [] }) };
  const calls = { chat: 0, getRunner: 0 };
  const chatRuntime = {
    send: async () => { calls.chat += 1; return { text: 'chat', providerId: 'opencode-go', providerName: 'OpenCode Go', model: 'deepseek-v4.1-flash', attempts: [] }; },
  };

  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: dir, claudeCommand: 'claude',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 1000,
      allowPaidFallback: false, taskTimeoutMs: 5000,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 }),
    permissionManager: new PermissionManager(),
    providerManager: providers,
    executorManager,
    modelManager,
    chatRuntime,
    logger: new RunLogger(path.join(dir, 'logs')),
    backendState: { backend: { label: 'WorkBuddy', model: 'm', free: true }, allowPaidFallback: false },
    client: fake.client,
    autoLogin: false,
  });
  plane.attachmentInbox = path.join(dir, 'inbox');

  const gate = {};
  gate.promise = new Promise((resolve) => { gate.resolve = resolve; });
  plane.getRunner = async (channelId) => {
    calls.getRunner += 1;
    return {
      sessionId: `sess-${channelId}`, model: 'deepseek-v4.1-flash', busy: false, stopped: false, sent: [], idleMs: 0,
      async send(prompt) {
        this.busy = true;
        this.sent.push(prompt);
        plane.onRunnerEvent(channelId, { type: 'session', sessionId: this.sessionId });
        if (hold) await gate.promise;
        this.busy = false;
        return { text: 'work done', sessionId: this.sessionId, durationMs: 1, tools: [], isError: false, costUsd: 0 };
      },
      async stop() { this.stopped = true; this.busy = false; gate.resolve(); },
    };
  };

  return { fake, plane, dir, file, calls, gate };
}

const lastText = (fake, channelId = null) => {
  const list = channelId ? fake.messagesIn(channelId) : fake.messages;
  return list.at(-1)?.content ?? '';
};

test('!panel renders the persistent main controls without ChatRuntime or an Agent', async () => {
  const { fake, plane, calls } = makePlane();
  await plane.start();
  await fake.sendAsUser({ content: '!panel' });

  const panel = fake.messages.at(-1);
  assert.match(panel.content, /Jarvis Control Panel/);
  assert.match(panel.content, /Chat: AUTO/);
  assert.match(panel.content, /Work: .*WorkBuddy Free/);
  assert.match(panel.content, /Permission:/);
  assert.match(panel.content, /Workspace:/);
  assert.equal(panel.pinned, true, 'the panel should be pinned when Discord allows it');
  assert.equal(calls.chat, 0, 'rendering the panel must not call ChatRuntime');
  assert.equal(calls.getRunner, 0, 'rendering the panel must not start an Agent');
});

test('panel buttons cover every P2 control', async () => {
  const { fake, plane } = makePlane();
  await plane.start();
  await fake.sendAsUser({ content: '!panel' });
  const ids = fake.messages.at(-1).buttonIds;
  for (const id of [
    'panel:newwork', 'panel:models', 'panel:settings', 'panel:permission',
    'panel:newchat', 'panel:compact', 'panel:status', 'panel:stop', 'panel:help', 'panel:refresh',
  ]) {
    assert.ok(ids.includes(id), `panel must expose ${id}`);
  }
});

test('an old panel keeps working after a bridge restart (stable custom ids)', async () => {
  const { fake: fake1, plane: plane1, file } = makePlane();
  await plane1.start();
  await fake1.sendAsUser({ content: '!panel' });
  const oldPanel = fake1.messages.at(-1);
  assert.match(oldPanel.content, /Jarvis Control Panel/);

  // Restart simulation: a brand-new control plane over the same state, with the
  // old panel message carried over into the new Discord transport.
  const { fake: fake2, plane: plane2 } = makePlane({ stateFile: file });
  fake2.messages.push(oldPanel);
  await plane2.start();

  const { updated } = await fake2.clickButton('panel:help');
  assert.match(updated.content, /Jarvis 使用说明/);
  assert.match(updated.content, /新建 Work/);
});

test('🛠 新建 Work runs in a Work thread for a guild parent and inline in a DM', async () => {
  const { fake, plane } = makePlane({ threadCapable: true });
  await plane.start();
  await fake.sendAsUser({ content: '!panel', guildId: 'guild-1' });
  await fake.clickButton('panel:newwork');
  assert.ok(fake.lastModal, 'the button must have opened the New Work modal');

  await fake.submitModal('workmodal:task', { values: { task: 'write a report' }, guildId: 'guild-1' });
  await tick(30);

  assert.equal(fake.threads.length, 1, 'a guild Work task must reuse the existing thread path');
  const thread = fake.threads[0];
  assert.equal(plane.sessionManager.get(fake.channelId).mode, 'chat', 'the parent must stay Chat');
  assert.equal(plane.state.getChannel(thread.id, plane.config.defaultCwd).workThread, true);

  const dm = makePlane();
  await dm.plane.start();
  await dm.fake.sendAsUser({ content: '!panel' });
  await dm.fake.clickButton('panel:newwork');
  await dm.fake.submitModal('workmodal:task', { values: { task: 'dm report' } });
  await tick(30);
  assert.equal(dm.fake.threads.length, 0, 'DMs cannot have threads');
  assert.equal(dm.plane.sessionManager.get(dm.fake.channelId).mode, 'work');
});

test('Chat model selector offers AUTO and Provider -> model and pins the manual choice', async () => {
  const { fake, plane } = makePlane();
  await plane.start();
  await fake.sendAsUser({ content: '!panel' });
  await fake.clickButton('panel:models');
  assert.ok(fake.messages.at(-1).buttonIds.includes('panelmodels:chat'));
  assert.ok(fake.messages.at(-1).buttonIds.includes('panelmodels:work'));

  await fake.clickButton('panelmodels:chat');
  const chatMenu = fake.messages.at(-1);
  assert.ok(chatMenu.buttonIds.includes('panelchat:auto'), 'AUTO must be offered');
  assert.ok(chatMenu.buttonIds.includes('panelchatp:opencode-go'), 'manual Provider -> model path');

  await fake.clickButton('panelchatp:opencode-go');
  await fake.clickButton('panelchatm:opencode-go:deepseek-v4.1-flash');
  const selection = plane.sessionManager.get(fake.channelId);
  assert.equal(selection.chatProviderId, 'opencode-go');
  assert.equal(selection.chatModel, 'deepseek-v4.1-flash');

  await fake.sendAsUser({ content: '!panel' });
  await fake.clickButton('panel:models');
  await fake.clickButton('panelmodels:chat');
  await fake.clickButton('panelchat:auto');
  assert.equal(plane.sessionManager.get(fake.channelId).chatProviderId, 'auto');
});

test('Work model selector can reach OpenCode Go while the current Work provider is WorkBuddy', async () => {
  const { fake, plane } = makePlane({ executorCompatible: (_executorId, protocol) => protocol !== 'workbuddy' });
  const dir = plane.config.defaultCwd;
  plane.state.patchChannel(fake.channelId, { executorId: 'claude', providerId: 'workbuddy-free', model: null }, dir);
  await plane.start();
  await fake.sendAsUser({ content: '!panel' });
  await fake.clickButton('panel:models');
  await fake.clickButton('panelmodels:work');

  const workMenu = fake.messages.at(-1);
  assert.ok(workMenu.buttonIds.includes('panelworkp:opencode-go'), 'OpenCode Go must be reachable from the Work menu');

  await fake.clickButton('panelworkp:opencode-go');
  await fake.clickButton('panelworkm:opencode-go:deepseek-v4.1-flash');
  const selection = plane.sessionManager.get(fake.channelId);
  assert.equal(selection.providerId, 'opencode-go');
  assert.equal(selection.model, 'deepseek-v4.1-flash');
});

test('panel Settings and Permission reuse the existing flows', async () => {
  const { fake, plane } = makePlane();
  await plane.start();
  await fake.sendAsUser({ content: '!panel' });
  await fake.clickButton('panel:settings');
  assert.match(fake.messages.at(-1).content, /Jarvis Settings/);

  await fake.clickButton('set:permission');
  await fake.clickButton('perm:relaxed');
  assert.equal(plane.permissionManager.getLevel(fake.channelId), 'relaxed');

  await fake.sendAsUser({ content: '!panel' });
  await fake.clickButton('panel:permission');
  assert.match(fake.messages.at(-1).content, /当前权限/);
});

test('panel Status is local and shows Chat/Work/queue facts', async () => {
  const { fake, plane, calls } = makePlane();
  await plane.start();
  await fake.sendAsUser({ content: '!panel' });
  await fake.clickButton('panel:status');
  const text = fake.messages.at(-1).content;
  assert.match(text, /Jarvis 状态/);
  assert.match(text, /模式：/);
  assert.match(text, /Work 状态：idle/);
  assert.equal(calls.chat, 0, 'status must not call ChatRuntime');
  assert.equal(calls.getRunner, 0, 'status must not start an Agent');
});

test('panel Stop matches !stop for queued and active work', async () => {
  // Active: the running channel is stopped by the panel button.
  const active = makePlane({ hold: true });
  const runner = await active.plane.getRunner(active.fake.channelId);
  active.plane.runners.set(active.fake.channelId, runner);
  active.plane.getRunner = async () => runner;
  await active.plane.start();
  const task = active.fake.sendAsUser({ content: 'work long', guildId: 'guild-1' });
  await tick(30);
  await active.fake.sendAsUser({ content: '!panel' });
  await active.fake.clickButton('panel:stop');
  assert.equal(runner.stopped, true, 'panel Stop must kill the active agent');
  active.gate.resolve();
  await task;

  // Queued: the panel Stop on the queued channel leaves the active owner alone.
  const queued = makePlane();
  const other = queued.fake.addChannel({ id: 'chan-2' });
  const dir = queued.plane.config.defaultCwd;
  queued.plane.state.patchChannel('chan-2', { cwd: dir, mode: 'work' }, dir);
  const held = queued.plane.scheduler.submit({ workspace: dir, channelId: 'other', run: async () => { await queued.gate.promise; } });
  await queued.plane.start();
  const queuedEntry = queued.plane.scheduler.submit({ workspace: dir, channelId: 'chan-2', run: async () => {} });
  assert.equal(queued.plane.scheduler.stateFor('chan-2').state, 'queued');
  await queued.fake.sendAsUser({ content: '!panel', channelId: 'chan-2' });
  await queued.fake.clickButton('panel:stop');
  assert.equal(queued.plane.scheduler.stateFor('chan-2').state, 'idle');
  assert.equal(queued.plane.scheduler.stateFor('other').state, 'running', 'the active owner must be untouched');
  queued.gate.resolve();
  await held;
  await queuedEntry.done;
  assert.ok(other);
});

test('usage guide is local/static and explains how to create Work', async () => {
  const { fake, plane, calls } = makePlane();
  await plane.start();
  await fake.sendAsUser({ content: '!panel' });
  await fake.clickButton('panel:help');
  const text = fake.messages.at(-1).content;
  assert.match(text, /普通问答，不启动 Agent/);
  assert.match(text, /可读写文件/);
  assert.match(text, /新建 Work/);
  assert.match(text, /新对话/);
  assert.equal(calls.chat, 0);
  assert.match(PANEL_HELP_TEXT, /`work` \+ 任务内容/);
  assert.doesNotMatch(PANEL_HELP_TEXT, /<(model|provider|任务)[-_]?id?>/i, 'help must not use fake runnable placeholders');
});
