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
  models: [{ id: 'deepseek-v4.1-flash', transport: TRANSPORT.OPENAI_CHAT }],
};

function fakeProviders() {
  return {
    list: () => [OPENCODE_GO],
    get: (id) => (id === 'opencode-go' ? OPENCODE_GO : null),
    hasCredential: () => true,
    listModels: async () => ({ models: OPENCODE_GO.models }),
  };
}

function makePlane({ fetchImpl } = {}) {
  const fake = new FakeDiscord();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p2-compact-'));
  const state = new StateStore(path.join(dir, 'state.json'));
  const chatHistory = new ChatHistoryStore({ file: path.join(dir, 'chat-history.json') });
  const chatRuntime = new ChatRuntime({
    providerManager: fakeProviders(),
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: fetchImpl ?? (async () => jsonResponse(200, { choices: [{ message: { content: 'SUMMARY_TEXT' } }] })),
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
    providerManager: fakeProviders(),
    chatRuntime,
    chatHistory,
    logger: new RunLogger(path.join(dir, 'logs')),
    backendState: { backend: { label: 'WorkBuddy', model: 'm', free: true }, allowPaidFallback: false },
    client: fake.client,
    autoLogin: false,
  });
  const calls = { getRunner: 0 };
  plane.getRunner = async () => { calls.getRunner += 1; throw new Error('AGENT_PATH_USED'); };
  return { fake, plane, chatHistory, calls, dir };
}

const lastText = (fake) => fake.messages.at(-1)?.content ?? '';

test('!new clears only the Chat context and preserves model/work configuration', async () => {
  const { fake, plane, chatHistory, dir } = makePlane();
  await plane.start();
  await fake.sendAsUser({ content: '!chatmodel opencode-go deepseek-v4.1-flash' });
  plane.state.patchChannel(fake.channelId, { cwd: dir, executorId: 'claude', providerId: 'opencode-go', model: 'deepseek-v4.1-flash' }, dir);
  await fake.sendAsUser({ content: '记住我叫 Alice' });
  assert.ok(chatHistory.stats(fake.channelId).messages > 0);

  await fake.sendAsUser({ content: '!new' });
  assert.match(lastText(fake), /新对话/);
  assert.equal(chatHistory.stats(fake.channelId).messages, 0, 'Chat context must be cleared');
  const selection = plane.sessionManager.get(fake.channelId);
  assert.equal(selection.chatProviderId, 'opencode-go', 'Chat model selection is preserved');
  assert.equal(selection.chatModel, 'deepseek-v4.1-flash');
  assert.equal(selection.executorId, 'claude', 'Work executor is preserved');
  assert.equal(selection.providerId, 'opencode-go', 'Work provider is preserved');
  assert.equal(selection.model, 'deepseek-v4.1-flash', 'Work model is preserved');
});

test('a permanent Work thread refuses !new and !compact', async () => {
  const { fake, plane } = makePlane();
  const threadId = 'thread-9';
  fake.addChannel({ id: threadId });
  plane.state.patchChannel(threadId, { mode: 'work', workThread: true, parentChannelId: fake.channelId }, plane.config.defaultCwd);
  await plane.start();

  await fake.sendAsUser({ content: '!new', channelId: threadId });
  assert.match(lastText(fake, threadId), /Work 线程/);
  await fake.sendAsUser({ content: '!compact', channelId: threadId });
  assert.match(lastText(fake, threadId), /Work 线程/);
});

test('Compact keeps a recent tail plus summary and reduces the replay size', async () => {
  const { fake, plane, chatHistory, calls } = makePlane();
  await plane.start();
  for (let i = 0; i < 12; i += 1) {
    chatHistory.appendTurn(fake.channelId, { user: `用户消息 ${i}。这是一些需要保留的上下文。`, assistant: `助手回答 ${i}。` });
  }
  const before = chatHistory.stats(fake.channelId);
  assert.ok(before.chars > 200);

  await fake.sendAsUser({ content: '!compact' });
  assert.match(lastText(fake), /已压缩/);
  const after = chatHistory.stats(fake.channelId);
  assert.equal(after.hasSummary, true);
  assert.equal(after.messages, 4, 'the last four role messages are kept verbatim');
  assert.ok(after.chars < before.chars, `expected ${after.chars} < ${before.chars}`);
  assert.equal(chatHistory.summary(fake.channelId), 'SUMMARY_TEXT');
  assert.equal(calls.getRunner, 0, 'Compact must never start an Agent');
});

test('Compact on a tiny history reports 无需压缩 without a model call', async () => {
  let calls = 0;
  const { fake, plane, chatHistory } = makePlane({
    fetchImpl: async () => { calls += 1; return jsonResponse(200, { choices: [{ message: { content: 'x' } }] }); },
  });
  await plane.start();
  chatHistory.appendTurn(fake.channelId, { user: 'hi', assistant: 'hello' });
  await fake.sendAsUser({ content: '!compact' });
  assert.match(lastText(fake), /无需压缩/);
  assert.equal(calls, 0);
});

test('a failed Compact leaves the original history intact', async () => {
  const { fake, plane, chatHistory } = makePlane({
    fetchImpl: async () => jsonResponse(429, { error: { message: 'rate limited' } }),
  });
  await plane.start();
  for (let i = 0; i < 10; i += 1) chatHistory.appendTurn(fake.channelId, { user: `u${i}`, assistant: `a${i}` });
  const before = chatHistory.get(fake.channelId).messages;
  await fake.sendAsUser({ content: '!compact' });
  assert.match(lastText(fake), /压缩失败/);
  assert.deepEqual(chatHistory.get(fake.channelId).messages, before, 'history must be unchanged on failure');
  assert.equal(chatHistory.stats(fake.channelId).hasSummary, false);
});

test('the panel 🆕 新对话 button clears the same Chat context as !new', async () => {
  const { fake, plane, chatHistory } = makePlane();
  await plane.start();
  chatHistory.appendTurn(fake.channelId, { user: 'a', assistant: 'b' });
  await fake.sendAsUser({ content: '!panel' });
  await fake.clickButton('panel:newchat');
  assert.equal(chatHistory.stats(fake.channelId).messages, 0);
});
