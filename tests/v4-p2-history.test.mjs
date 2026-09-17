import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiscordControlPlane } from '../src/discord-ui.mjs';
import { ChatRuntime } from '../src/chat-runtime.mjs';
import { ChatHistoryStore } from '../src/chat-history.mjs';
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

function makePlane({ fetchImpl, mode = 'chat', runner = null } = {}) {
  const fake = new FakeDiscord();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p2-history-'));
  const historyFile = path.join(dir, 'chat-history.json');
  const state = new StateStore(path.join(dir, 'state.json'));
  if (mode !== 'chat') state.patchChannel(fake.channelId, { mode }, dir);
  const providers = fakeProviders();
  const chatHistory = new ChatHistoryStore({ file: historyFile });
  const chatRuntime = new ChatRuntime({
    providerManager: providers,
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: fetchImpl ?? (async () => jsonResponse(200, { choices: [{ message: { content: '好的' } }] })),
    timeoutMs: 5000,
  });
  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: dir, claudeCommand: 'workbuddy.js',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 1000,
      allowPaidFallback: false, taskTimeoutMs: 5000,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 }),
    permissionManager: new PermissionManager(),
    providerManager: providers,
    chatRuntime,
    chatHistory,
    logger: new RunLogger(path.join(dir, 'logs')),
    backendState: { backend: { label: 'WorkBuddy', model: 'm', free: true }, allowPaidFallback: false },
    client: fake.client,
    autoLogin: false,
  });
  const agentCalls = [];
  plane.getRunner = async (channelId) => {
    agentCalls.push(channelId);
    if (!runner) throw new Error('AGENT_PATH_USED_FROM_CHAT');
    return runner;
  };
  return { fake, plane, chatHistory, chatRuntime, historyFile, agentCalls };
}

const lastText = (fake) => fake.messages.at(-1)?.content ?? '';

test('successful consecutive Chat turns send the prior context', async () => {
  const bodies = [];
  const { fake, plane, chatHistory } = makePlane({
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return jsonResponse(200, { choices: [{ message: { content: '回答' } }] });
    },
  });
  await plane.start();
  await fake.sendAsUser({ content: '第一句' });
  await fake.sendAsUser({ content: '第二句' });

  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].messages.map((m) => m.role), ['user']);
  assert.deepEqual(bodies[1].messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(bodies[1].messages[0].content, '第一句');
  assert.equal(bodies[1].messages[1].content, '回答');
  assert.equal(bodies[1].messages[2].content, '第二句');
  assert.equal(chatHistory.stats(fake.channelId).messages, 4);
});

test('Chat history survives a store reload (bridge restart)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p2-history-reload-'));
  const file = path.join(dir, 'chat-history.json');
  const first = new ChatHistoryStore({ file });
  first.appendTurn('chan-1', { user: '你好', assistant: '你好，我能帮你什么？' });

  const second = new ChatHistoryStore({ file });
  const restored = second.get('chan-1');
  assert.deepEqual(restored.messages, [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好，我能帮你什么？' },
  ]);
});

test('a malformed BOM file does not silently reset unrelated channels', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p2-history-bom-'));
  const file = path.join(dir, 'chat-history.json');
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({
    version: 1,
    channels: { good: { messages: [{ role: 'user', content: 'keep me' }], summary: null, updatedAt: null } },
  }));
  const store = new ChatHistoryStore({ file });
  assert.equal(store.get('good').messages[0].content, 'keep me');
});

test('AUTO fallback retries never duplicate the user turn', async () => {
  let call = 0;
  const { fake, plane, chatHistory } = makePlane({
    fetchImpl: async (_url, options) => {
      const model = JSON.parse(options.body).model;
      call += 1;
      if (model === 'deepseek-v4.1-flash') return jsonResponse(429, { error: { message: 'rate limited' } });
      return jsonResponse(200, { choices: [{ message: { content: 'GLM 回答' } }] });
    },
  });
  await plane.start();
  await fake.sendAsUser({ content: '你好' });
  assert.equal(call, 2, 'the failed candidate was retried once');
  const stored = chatHistory.get(fake.channelId).messages;
  assert.deepEqual(stored.map((m) => m.role), ['user', 'assistant']);
  assert.equal(stored[0].content, '你好');
  assert.equal(stored[1].content, 'GLM 回答');
});

test('a manual Chat pin never silently falls back and appends no history', async () => {
  const { fake, plane, chatHistory } = makePlane({
    fetchImpl: async () => jsonResponse(429, { error: { message: 'rate limited' } }),
  });
  await plane.start();
  await fake.sendAsUser({ content: '!chatmodel opencode-go deepseek-v4.1-flash' });
  await fake.sendAsUser({ content: '你好' });
  assert.match(lastText(fake), /不会自动切换/);
  assert.equal(chatHistory.stats(fake.channelId).messages, 0, 'a failed pinned turn must not enter history');
});

test('Work messages never enter Chat history', async () => {
  const runner = {
    sessionId: 'sess-work', model: 'deepseek-v4.1-flash', busy: false, sent: [], idleMs: 0,
    async send(prompt) {
      this.busy = true;
      this.sent.push(prompt);
      this.busy = false;
      return { text: 'work done', sessionId: this.sessionId, durationMs: 1, tools: [], isError: false, costUsd: 0 };
    },
    async stop() { this.busy = false; },
  };
  const { fake, plane, chatHistory } = makePlane({ mode: 'work', runner });
  plane.getRunner = async () => runner;
  await plane.start();
  await fake.sendAsUser({ content: 'create a file' });
  assert.deepEqual(runner.sent, ['create a file']);
  assert.equal(chatHistory.stats(fake.channelId).messages, 0);
});

test('bounded history does not grow indefinitely', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p2-history-bound-'));
  const store = new ChatHistoryStore({ file: path.join(dir, 'chat-history.json') });
  for (let i = 0; i < 50; i += 1) store.appendTurn('chan-1', { user: `u${i}`, assistant: `a${i}` });
  const stats = store.stats('chan-1');
  assert.ok(stats.messages <= 40, `messages=${stats.messages}`);
  const messages = store.get('chan-1').messages;
  assert.equal(messages.at(-1).content, 'a49', 'the newest turn must be kept');
  assert.ok(!messages.some((m) => m.content === 'u0'), 'the oldest turn was trimmed');
});
