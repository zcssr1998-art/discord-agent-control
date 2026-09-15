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

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

const OPENCODE_GO = {
  id: 'opencode-go', displayName: 'OpenCode Go', protocol: PROTOCOL.OPENCODE_GO,
  baseUrl: 'https://opencode.ai/zen/go', billingType: 'SUBSCRIPTION', credentialRef: 'provider:opencode-go',
  models: [
    { id: 'deepseek-v4.1-flash', transport: TRANSPORT.OPENAI_CHAT },
    { id: 'glm-5.3-flash', transport: TRANSPORT.OPENAI_CHAT },
  ],
};

function fakeProviders(profiles = [OPENCODE_GO]) {
  return {
    list: () => profiles,
    get: (id) => profiles.find((profile) => profile.id === id) || null,
    hasCredential: () => true,
    listModels: async (id) => ({ models: profiles.find((profile) => profile.id === id)?.models || [] }),
  };
}

function makePlane({ fetchImpl, profiles, mode = 'chat', workbuddyStatus = null, runner = null } = {}) {
  const fake = new FakeDiscord();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-v4-chat-'));
  const state = new StateStore(path.join(dir, 'state.json'));
  if (mode !== 'chat') state.patchChannel(fake.channelId, { mode }, dir);

  const providers = fakeProviders(profiles);
  const chatRuntime = new ChatRuntime({
    providerManager: providers,
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: fetchImpl ?? (async () => jsonResponse(200, { choices: [{ message: { content: '你好，我是 Jarvis。' } }] })),
    timeoutMs: 5000,
  });

  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: dir, claudeCommand: 'workbuddy.js',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1,
      allowPaidFallback: false, agentBackend: 'workbuddy-free-dsf', taskTimeoutMs: 1000, stallNoticeMs: 1000,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 }),
    permissionManager: new PermissionManager(),
    providerManager: providers,
    chatRuntime,
    logger: new RunLogger(path.join(dir, 'logs')),
    backendState: {
      backend: { id: 'workbuddy-free-dsf', label: 'WorkBuddy Free DSF', apiKeySource: 'www.workbuddy.ai', model: 'fast-model', free: true },
      allowPaidFallback: false, workbuddyStatus,
    },
    client: fake.client,
    autoLogin: false,
  });

  // The Agent path must be reachable only from Work mode. If Chat ever calls it,
  // the spy makes the regression loud instead of silently spawning an Agent.
  const agentCalls = [];
  plane.getRunner = async (channelId) => {
    agentCalls.push(channelId);
    if (!runner) throw new Error('AGENT_PATH_USED_FROM_CHAT');
    return runner;
  };
  return { fake, plane, chatRuntime, providers, agentCalls, dir };
}

function scriptedRunner(plane, fake, { text = 'work done' } = {}) {
  const runner = {
    sessionId: 'sess-work', model: 'deepseek-v4.1-flash', busy: false, stopped: false, sent: [], idleMs: 0,
    async send(prompt) {
      this.busy = true;
      this.sent.push(prompt);
      plane.onRunnerEvent(fake.channelId, { type: 'session', sessionId: this.sessionId });
      this.busy = false;
      return { text, sessionId: this.sessionId, durationMs: 5, tools: [], isError: false, costUsd: 0 };
    },
    async stop() { this.stopped = true; this.busy = false; },
    onEvent: (event) => plane.onRunnerEvent(fake.channelId, event),
  };
  return runner;
}

const lastText = (fake) => fake.messages.at(-1)?.content ?? '';

test('default channel is Chat: 你好 goes to the model API and never touches the Agent path', async () => {
  const calls = [];
  const { fake, plane, agentCalls } = makePlane({
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body).model);
      return jsonResponse(200, { choices: [{ message: { content: '你好！' } }] });
    },
  });
  await plane.start();
  assert.equal(plane.sessionManager.get(fake.channelId).mode, 'chat');

  await fake.sendAsUser({ content: '你好' });

  assert.equal(agentCalls.length, 0, 'Chat must not create a runner');
  assert.equal(plane.runners.size, 0, 'no agent runner may be registered');
  assert.equal(plane.tasks.size, 0, 'no Agent task may be created');
  assert.deepEqual(calls, ['deepseek-v4.1-flash'], 'the fastest preferred chat model answers');
  assert.match(lastText(fake), /你好！/);
  assert.match(lastText(fake), /💬 Chat · OpenCode Go · deepseek-v4\.1-flash · \d+\.\d+s/);
});

test('mode commands are local and deterministic; inline prompts switch and execute', async () => {
  const calls = [];
  const { fake, plane, agentCalls } = makePlane({
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body).model);
      return jsonResponse(200, { choices: [{ message: { content: 'chat answer' } }] });
    },
  });
  const runner = scriptedRunner(plane, fake);
  plane.getRunner = async (channelId) => { agentCalls.push(channelId); return runner; };
  await plane.start();

  await fake.sendAsUser({ content: 'work' });
  assert.equal(plane.sessionManager.get(fake.channelId).mode, 'work');
  assert.equal(calls.length, 0, 'a bare mode command never calls a model');

  await fake.sendAsUser({ content: '/chat' });
  assert.equal(plane.sessionManager.get(fake.channelId).mode, 'chat');
  await fake.sendAsUser({ content: '!work' });
  assert.equal(plane.sessionManager.get(fake.channelId).mode, 'work');
  await fake.sendAsUser({ content: '/work' });
  assert.equal(plane.sessionManager.get(fake.channelId).mode, 'work');
  await fake.sendAsUser({ content: '!chat' });
  assert.equal(plane.sessionManager.get(fake.channelId).mode, 'chat');
  assert.equal(calls.length, 0, 'no mode command called a model');

  await fake.sendAsUser({ content: 'chat explain the build' });
  assert.equal(calls.length, 1, 'chat <prompt> executes as Chat');
  assert.match(lastText(fake), /chat answer/);

  await fake.sendAsUser({ content: 'work fix the failing test' });
  assert.equal(plane.sessionManager.get(fake.channelId).mode, 'work');
  assert.deepEqual(runner.sent, ['fix the failing test'], 'work <prompt> executes the inline prompt through the Agent');
});

test('a normal sentence containing "work" is not mistaken for a mode command', async () => {
  const calls = [];
  const { fake, plane } = makePlane({
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body).model);
      return jsonResponse(200, { choices: [{ message: { content: 'chat' } }] });
    },
  });
  await plane.start();
  await fake.sendAsUser({ content: 'what is work stealing?' });
  assert.equal(plane.sessionManager.get(fake.channelId).mode, 'chat');
  assert.equal(calls.length, 1, 'the question is answered in Chat, not parsed as a mode command');
});

test('Work mode still routes ordinary messages through the existing Agent path', async () => {
  const { fake, plane, agentCalls } = makePlane({ mode: 'work' });
  const runner = scriptedRunner(plane, fake, { text: 'agent finished' });
  plane.getRunner = async (channelId) => { agentCalls.push(channelId); return runner; };
  await plane.start();

  await fake.sendAsUser({ content: 'create a health endpoint' });
  assert.equal(agentCalls.length, 1);
  assert.deepEqual(runner.sent, ['create a health endpoint']);
  assert.ok(fake.texts().some((text) => /agent finished/.test(text)));
});

test('AUTO falls back DeepSeek -> GLM, hides the raw error, and cools down the failed model', async () => {
  const seen = [];
  const { fake, plane } = makePlane({
    fetchImpl: async (_url, options) => {
      const model = JSON.parse(options.body).model;
      seen.push(model);
      if (model === 'deepseek-v4.1-flash') return jsonResponse(429, { error: { message: 'rate limited 429' } });
      return jsonResponse(200, { choices: [{ message: { content: 'GLM answer' } }] });
    },
  });
  await plane.start();

  await fake.sendAsUser({ content: '你好' });
  assert.deepEqual(seen, ['deepseek-v4.1-flash', 'glm-5.3-flash']);
  assert.match(lastText(fake), /GLM answer/);
  assert.match(lastText(fake), /glm-5\.3-flash · fallback/);
  assert.ok(fake.texts().every((text) => !/rate limited/.test(text)), 'the raw failed-provider error must not reach Discord');

  seen.length = 0;
  await fake.sendAsUser({ content: '你好 again' });
  assert.deepEqual(seen, ['glm-5.3-flash'], 'the cooled-down model must not be retried on the next message');
});

test('a manual Chat pin never silently falls back', async () => {
  const seen = [];
  const { fake, plane } = makePlane({
    fetchImpl: async (_url, options) => {
      seen.push(JSON.parse(options.body).model);
      return jsonResponse(429, { error: { message: 'rate limited' } });
    },
  });
  await plane.start();

  await fake.sendAsUser({ content: '!chatmodel opencode-go deepseek-v4.1-flash' });
  assert.match(lastText(fake), /已固定/);

  await fake.sendAsUser({ content: '你好' });
  assert.deepEqual(seen, ['deepseek-v4.1-flash'], 'a pinned model must be the only one tried');
  assert.match(lastText(fake), /不会自动切换/);

  await fake.sendAsUser({ content: '!chatmodel auto' });
  assert.match(lastText(fake), /AUTO/);
  assert.equal(plane.sessionManager.get(fake.channelId).chatProviderId, 'auto');
});

test('WorkBuddy quota cannot block Chat', async () => {
  const { fake, plane, agentCalls } = makePlane({ workbuddyStatus: 'BLOCKED_BY_QUOTA' });
  await plane.start();
  await fake.sendAsUser({ content: '你好' });
  assert.equal(agentCalls.length, 0);
  assert.match(lastText(fake), /你好，我是 Jarvis。/);
});

test('!status shows separate CHAT and WORK configuration', async () => {
  const { fake, plane } = makePlane();
  await plane.start();
  await fake.sendAsUser({ content: '你好' });
  await fake.sendAsUser({ content: '!status' });
  const status = lastText(fake);
  assert.match(status, /🧭 模式：💬 Chat/);
  assert.match(status, /💬 \*\*CHAT\*\*/);
  assert.match(status, /路由：AUTO/);
  assert.match(status, /实际：OpenCode Go · deepseek-v4\.1-flash/);
});
