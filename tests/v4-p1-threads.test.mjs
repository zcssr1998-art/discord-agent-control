import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiscordControlPlane } from '../src/discord-ui.mjs';
import { ChatRuntime } from '../src/chat-runtime.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager } from '../src/permission-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { RunLogger } from '../src/logger.mjs';
import { PROTOCOL, TRANSPORT } from '../src/provider-manager.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

const OPENCODE_GO = {
  id: 'opencode-go', displayName: 'OpenCode Go', protocol: PROTOCOL.OPENCODE_GO,
  baseUrl: 'https://opencode.ai/zen/go', billingType: 'SUBSCRIPTION', credentialRef: 'provider:opencode-go',
  models: [{ id: 'deepseek-v4.1-flash', transport: TRANSPORT.OPENAI_CHAT }],
};

function fakeProviders(profiles = [OPENCODE_GO]) {
  return {
    list: () => profiles,
    get: (id) => profiles.find((profile) => profile.id === id) || null,
    hasCredential: () => true,
    listModels: async (id) => ({ models: profiles.find((profile) => profile.id === id)?.models || [] }),
  };
}

function makeThreadPlane({ threadCapable = true, threadFailure = false, chatCalls = [], hold = false } = {}) {
  const fake = new FakeDiscord({ threadCapable, threadFailure });
  const holder = {};
  holder.promise = new Promise((resolve) => { holder.resolve = resolve; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p1-thread-'));
  const state = new StateStore(path.join(dir, 'state.json'));
  const providers = fakeProviders();
  const chatRuntime = new ChatRuntime({
    providerManager: providers,
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async (_url, options) => {
      chatCalls.push(JSON.parse(options.body).model);
      return jsonResponse(200, { choices: [{ message: { content: 'chat answer' } }] });
    },
    timeoutMs: 5000,
  });
  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: dir, claudeCommand: 'workbuddy.js',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 1000,
      allowPaidFallback: false, agentBackend: 'workbuddy-free-dsf', taskTimeoutMs: 5000,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 }),
    permissionManager: new PermissionManager(),
    providerManager: providers,
    chatRuntime,
    logger: new RunLogger(path.join(dir, 'logs')),
    backendState: {
      backend: { id: 'workbuddy-free-dsf', label: 'WorkBuddy Free DSF', apiKeySource: 'workbuddy', model: 'm', free: true },
      allowPaidFallback: false,
    },
    client: fake.client,
    autoLogin: false,
  });

  // Scripted runners: one per channel/thread, so "thread has its own session"
  // is observable rather than assumed.
  const runners = new Map();
  const runnerHistory = [];
  const getRunnerCalls = [];
  plane.getRunner = async (channelId) => {
    getRunnerCalls.push(channelId);
    const runner = {
      sessionId: `sess-${channelId}`, model: 'deepseek-v4.1-flash', busy: false, stopped: false, sent: [], idleMs: 0,
      async send(prompt) {
        this.busy = true;
        this.sent.push(prompt);
        plane.onRunnerEvent(channelId, { type: 'session', sessionId: this.sessionId });
        if (hold) await holder.promise;
        this.busy = false;
        return { text: `done:${prompt}`, sessionId: this.sessionId, durationMs: 5, tools: [], isError: false, costUsd: 0 };
      },
      async stop() { this.stopped = true; this.busy = false; },
    };
    runners.set(channelId, runner);
    runnerHistory.push({ channelId, runner });
    return runner;
  };

  return { fake, plane, dir, runners, runnerHistory, getRunnerCalls, holder };
}

const lastText = (fake, channelId = null) => {
  const messages = channelId ? fake.messagesIn(channelId) : fake.messages;
  return messages.at(-1)?.content ?? '';
};

test('work <task> in a thread-capable Chat parent creates exactly one thread and leaves the parent in Chat', async () => {
  const { fake, plane, runners } = makeThreadPlane();
  await plane.start();

  await fake.sendAsUser({ content: 'work fix the flaky test', guildId: 'guild-1' });

  assert.equal(fake.threads.length, 1, 'exactly one Work thread');
  const thread = fake.threads[0];
  assert.equal(plane.sessionManager.get(fake.channelId).mode, 'chat', 'the parent must stay Chat');
  assert.equal(plane.state.getChannel(thread.id, process.cwd()).workThread, true);
  assert.equal(plane.state.getChannel(thread.id, process.cwd()).mode, 'work');
  assert.equal(plane.state.getChannel(thread.id, process.cwd()).parentChannelId, fake.channelId);
  assert.deepEqual(runners.get(thread.id).sent, ['fix the flaky test'], 'the task runs inside the thread');
  assert.ok(fake.messagesIn(fake.channelId).some((m) => /Work 线程/.test(m.content)), 'the parent gets one concise confirmation');
});

test('the thread gets its own Work session and later messages continue it without touching the parent', async () => {
  const { fake, plane, runnerHistory, getRunnerCalls } = makeThreadPlane();
  await plane.start();
  await fake.sendAsUser({ content: 'work first task', guildId: 'guild-1' });
  const thread = fake.threads[0];

  assert.equal(plane.state.getChannel(thread.id, process.cwd()).sessionId, `sess-${thread.id}`);
  assert.equal(plane.state.getChannel(fake.channelId, process.cwd()).sessionId, null, 'the parent session must stay untouched');

  await fake.sendAsUser({ content: 'continue please', channelId: thread.id, guildId: 'guild-1' });

  const threadRuns = runnerHistory.filter((entry) => entry.channelId === thread.id);
  assert.deepEqual(threadRuns.map((entry) => entry.runner.sent), [['first task'], ['continue please']]);
  assert.deepEqual(
    threadRuns.map((entry) => entry.runner.sessionId),
    [`sess-${thread.id}`, `sess-${thread.id}`],
    'both thread turns share one session key',
  );
  assert.ok(!getRunnerCalls.includes(fake.channelId), 'ordinary thread messages must not start a parent Agent');
});

test('the parent can Chat while a thread Work task is still running', async () => {
  const chatCalls = [];
  const { fake, plane, holder } = makeThreadPlane({ chatCalls, hold: true });
  await plane.start();

  const task = fake.sendAsUser({ content: 'work long task', guildId: 'guild-1' });
  await tick(20);
  const thread = fake.threads[0];
  assert.equal(plane.scheduler.stateFor(thread.id).state, 'running', 'the thread holds the workspace');

  await fake.sendAsUser({ content: '你好', guildId: 'guild-1' });
  assert.deepEqual(chatCalls, ['deepseek-v4.1-flash'], 'the parent Chat answers while Work runs');
  assert.match(lastText(fake, fake.channelId), /chat answer/);

  holder.resolve();
  await task;
});

test('chat inside a permanent Work thread is refused and never flips it to Chat', async () => {
  const { fake, plane } = makeThreadPlane();
  await plane.start();
  await fake.sendAsUser({ content: 'work something', guildId: 'guild-1' });
  const thread = fake.threads[0];

  await fake.sendAsUser({ content: 'chat', channelId: thread.id, guildId: 'guild-1' });
  assert.equal(plane.sessionManager.get(thread.id).mode, 'work');
  assert.match(lastText(fake, thread.id), /Work 线程/);
});

test('a Work thread never nests another thread', async () => {
  const { fake, plane } = makeThreadPlane();
  await plane.start();
  await fake.sendAsUser({ content: 'work outer', guildId: 'guild-1' });
  const thread = fake.threads[0];

  await fake.sendAsUser({ content: 'work inner', channelId: thread.id, guildId: 'guild-1' });
  assert.equal(fake.threads.length, 1, 'no nested thread may be created');
});

test('DM work <task> still runs inline without creating a thread', async () => {
  const { fake, plane, runners } = makeThreadPlane();
  await plane.start();

  await fake.sendAsUser({ content: 'work dm task', guildId: null });

  assert.equal(fake.threads.length, 0, 'DMs cannot have threads');
  assert.equal(plane.sessionManager.get(fake.channelId).mode, 'work', 'DM keeps the existing inline Work behavior');
  assert.deepEqual(runners.get(fake.channelId).sent, ['dm task']);
});

test('a thread-creation failure does not run the task in the parent by accident', async () => {
  const { fake, plane, getRunnerCalls } = makeThreadPlane({ threadFailure: true });
  await plane.start();

  await fake.sendAsUser({ content: 'work must not leak', guildId: 'guild-1' });

  assert.equal(fake.threads.length, 0);
  assert.equal(getRunnerCalls.length, 0, 'no Agent may be started when thread creation fails');
  assert.equal(plane.sessionManager.get(fake.channelId).mode, 'chat', 'the parent must stay Chat');
  assert.match(lastText(fake), /无法创建 Work 线程/);
});

test('the thread inherits the parent Work defaults and permission level', async () => {
  const { fake, plane } = makeThreadPlane();
  await plane.start();
  plane.permissionManager.switchLevel(fake.channelId, 'relaxed');

  await fake.sendAsUser({ content: 'work inherit', guildId: 'guild-1' });
  const thread = fake.threads[0];

  assert.equal(plane.sessionManager.get(thread.id).cwd, plane.sessionManager.get(fake.channelId).cwd);
  assert.equal(plane.sessionManager.get(thread.id).executorId, plane.sessionManager.get(fake.channelId).executorId);
  assert.equal(plane.permissionManager.getLevel(thread.id), 'relaxed');
});
