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
import { SessionManager } from '../src/session-manager.mjs';
import { RunLogger } from '../src/logger.mjs';
import { PROTOCOL, TRANSPORT } from '../src/provider-manager.mjs';
import { isPlaceholderId, normalizeChatSelection, needsChatSelectionRepair } from '../src/model-selection.mjs';
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

const LITELLM = {
  id: 'litellm', displayName: 'LiteLLM Gateway', protocol: PROTOCOL.OPENAI,
  baseUrl: 'http://127.0.0.1:4000/v1', billingType: 'SUBSCRIPTION', credentialRef: 'provider:litellm',
  models: [{ id: 'chat-fast', displayName: 'chat-fast' }],
};

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p222-'));
}

function sessionManager(store, { chatModelResolver = null } = {}) {
  return new SessionManager({
    state: store,
    permissionManager: { getLevel: () => 'standard', syncSession() {}, reset() {} },
    approvalManager: { cancelForSession() {}, clearSessionAllows() {} },
    defaultCwd: 'C:/repo',
    chatModelResolver,
  });
}

function makePlane({ dir, stateFile, profiles = [OPENCODE_GO], fetchImpl = null } = {}) {
  const fake = new FakeDiscord();
  const baseDir = dir || tmpDir();
  const file = stateFile || path.join(baseDir, 'state.json');
  const state = new StateStore(file);
  const providers = {
    list: () => profiles,
    get: (id) => profiles.find((profile) => profile.id === id) || null,
    hasCredential: () => true,
    listModels: async (id) => ({ models: profiles.find((profile) => profile.id === id)?.models || [] }),
  };
  const modelManager = {
    select: async () => {},
    list: async (id) => ({ models: profiles.find((profile) => profile.id === id)?.models || [] }),
  };
  const calls = { chat: 0, seen: [] };
  const chatRuntime = new ChatRuntime({
    providerManager: providers,
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: fetchImpl ?? (async (_url, options) => {
      calls.seen.push(JSON.parse(options.body).model);
      return jsonResponse(200, { choices: [{ message: { content: '你好，我是 Jarvis。' } }] });
    }),
    timeoutMs: 5000,
  });
  const originalSend = chatRuntime.send.bind(chatRuntime);
  chatRuntime.send = async (...args) => { calls.chat += 1; return originalSend(...args); };

  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: baseDir, claudeCommand: 'claude',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 1000,
      allowPaidFallback: false, taskTimeoutMs: 5000,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 }),
    permissionManager: new PermissionManager(),
    providerManager: providers,
    modelManager,
    chatRuntime,
    logger: new RunLogger(path.join(baseDir, 'logs')),
    backendState: { backend: { label: 'WorkBuddy', model: 'm', free: true }, allowPaidFallback: false },
    client: fake.client,
    autoLogin: false,
  });
  return { fake, plane, state, file, calls, chatRuntime };
}

const lastText = (fake) => fake.messages.at(-1)?.content ?? '';

// ---------------------------------------------------------------- validator

test('placeholder validator is narrow: rejects placeholders, accepts real IDs', () => {
  for (const bad of ['<model-id>', '<provider-id>', '<model>', '<provider>', '<anything>', '', '   ', null, 'model', 'model-id', 'PROVIDER_ID']) {
    assert.equal(isPlaceholderId(bad), true, `${JSON.stringify(bad)} must be a placeholder`);
  }
  for (const good of ['deepseek-v4.1-flash', 'glm-5.3-flash', 'gpt-5.6-luna', 'claude-3-5-sonnet', 'custom-1', 'provider/v1', 'a:b', 'omni-2.5-analyst', 'model-v2-preview']) {
    assert.equal(isPlaceholderId(good), false, `${good} must be accepted`);
  }
  assert.equal(normalizeChatSelection({ providerId: 'auto', model: null }).providerId, 'auto');
  assert.equal(normalizeChatSelection({ providerId: 'opencode-go', model: 'deepseek-v4.1-flash' }).model, 'deepseek-v4.1-flash');
  assert.throws(() => normalizeChatSelection({ providerId: 'opencode-go', model: '<model-id>' }), { code: 'INVALID_CHAT_SELECTION' });
  assert.equal(needsChatSelectionRepair({ providerId: 'opencode-go', model: '<model-id>' }), true);
  assert.equal(needsChatSelectionRepair({ providerId: 'auto', model: null }), false);
});

// ------------------------------------------------------------- persistence

test('fresh Chat selection defaults to AUTO/null and manual selection persists to disk', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'state.json');
  const store = new StateStore(file);
  const sessions = sessionManager(store);
  assert.equal(sessions.get('c1').chatProviderId, 'auto');
  assert.equal(sessions.get('c1').chatModel, null);

  sessions.setChatSelection('c1', { providerId: 'opencode-go', model: 'deepseek-v4.1-flash' });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.channels.c1.chatProviderId, 'opencode-go');
  assert.equal(raw.channels.c1.chatModel, 'deepseek-v4.1-flash');

  sessions.setChatSelection('c1', { providerId: 'auto', model: null });
  const back = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(back.channels.c1.chatProviderId, 'auto');
  assert.equal(back.channels.c1.chatModel, null);
});

test('the persistence boundary fails closed for placeholder provider/model input', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'state.json');
  const store = new StateStore(file);
  const sessions = sessionManager(store);
  assert.throws(() => sessions.setChatSelection('c1', { providerId: 'opencode-go', model: '<model-id>' }), { code: 'INVALID_CHAT_SELECTION' });
  assert.throws(() => sessions.setChatSelection('c1', { providerId: '<provider-id>', model: 'deepseek-v4.1-flash' }), { code: 'INVALID_CHAT_SELECTION' });
  assert.throws(() => sessions.setChatSelection('c1', { providerId: 'opencode-go', model: '   ' }), { code: 'INVALID_CHAT_SELECTION' });
  const value = sessions.get('c1');
  assert.equal(value.chatProviderId, 'auto');
  assert.equal(value.chatModel, null);
});

test('a persisted placeholder pin is repaired to AUTO/null on load and preserves unrelated fields', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({
    channels: {
      bad: {
        mode: 'chat', chatProviderId: 'opencode-go', chatModel: '<model-id>',
        cwd: 'D:/deepseeek', executorId: 'claude', providerId: 'opencode-go', model: 'deepseek-v4.1-flash',
        sessionId: 'sess-keep',
      },
      badProvider: { chatProviderId: '<provider-id>', chatModel: 'deepseek-v4.1-flash', cwd: 'D:/x' },
    },
  }));
  const store = new StateStore(file);
  const bad = store.getChannel('bad', 'C:/repo');
  assert.equal(bad.chatProviderId, 'auto');
  assert.equal(bad.chatModel, null);
  assert.equal(bad.cwd, 'D:/deepseeek', 'cwd must survive the repair');
  assert.equal(bad.providerId, 'opencode-go', 'Work provider must survive the repair');
  assert.equal(bad.model, 'deepseek-v4.1-flash', 'Work model must survive the repair');
  assert.equal(bad.sessionId, 'sess-keep', 'Agent session must survive the repair');
  assert.equal(store.getChannel('badProvider', 'C:/repo').chatProviderId, 'auto');
  // The repair must be persisted, not memory-only.
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.channels.bad.chatProviderId, 'auto');
  assert.equal(raw.channels.bad.chatModel, null);
  assert.equal(raw.channels.bad.cwd, 'D:/deepseeek');
  assert.equal(raw.channels.bad.model, 'deepseek-v4.1-flash');
});

// ------------------------------------------------------------------- discord

test('!chatmodel rejects placeholders and does not persist them', async () => {
  const { fake, plane, state } = makePlane();
  await plane.start();

  await fake.sendAsUser({ content: '!chatmodel opencode-go <model-id>' });
  assert.match(lastText(fake), /无效的 Chat 模型选择/);
  assert.equal(state.getChannel(fake.channelId, plane.config.defaultCwd).chatProviderId, 'auto');

  await fake.sendAsUser({ content: '!chatmodel <provider-id> deepseek-v4.1-flash' });
  assert.match(lastText(fake), /无效的 Chat 模型选择/);
  assert.equal(state.getChannel(fake.channelId, plane.config.defaultCwd).chatProviderId, 'auto');
});

test('!chatmodel pins a real model, persists it, /status shows the manual pin, and switch-back works', async () => {
  const { fake, plane, file } = makePlane();
  await plane.start();

  await fake.sendAsUser({ content: '!chatmodel opencode-go deepseek-v4.1-flash' });
  assert.match(lastText(fake), /已固定/);
  assert.equal(plane.sessionManager.get(fake.channelId).chatProviderId, 'opencode-go');
  assert.equal(plane.sessionManager.get(fake.channelId).chatModel, 'deepseek-v4.1-flash');

  await fake.sendAsUser({ content: '!status' });
  assert.match(lastText(fake), /路由：手动固定 · OpenCode Go \/ deepseek-v4\.1-flash/);

  await fake.sendAsUser({ content: '!chatmodel auto' });
  assert.match(lastText(fake), /AUTO/);
  assert.equal(plane.sessionManager.get(fake.channelId).chatProviderId, 'auto');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.channels[fake.channelId].chatProviderId, 'auto');
  assert.equal(raw.channels[fake.channelId].chatModel, null);
});

test('/model -> Chat offers AUTO plus eligible providers and the real model list', async () => {
  const { fake, plane } = makePlane({ profiles: [OPENCODE_GO, LITELLM] });
  await plane.start();
  await fake.command('model');
  assert.ok(fake.messages.at(-1).buttonIds.includes('panelmodels:chat'));

  await fake.clickButton('panelmodels:chat');
  const chatMenu = fake.messages.at(-1);
  assert.ok(chatMenu.buttonIds.includes('panelchat:auto'), 'AUTO must be the first option');
  assert.ok(chatMenu.buttonIds.includes('panelchatp:opencode-go'));
  assert.ok(chatMenu.buttonIds.includes('panelchatp:litellm'));
  assert.match(chatMenu.content, /AUTO（自动选择）/);

  await fake.clickButton('panelchatp:opencode-go');
  const models = fake.messages.at(-1);
  assert.ok(models.buttonIds.includes('panelchatm:opencode-go:deepseek-v4.1-flash'));
  assert.ok(models.buttonIds.includes('panelchatm:opencode-go:glm-5.3-flash'));

  await fake.clickButton('panelchatm:opencode-go:deepseek-v4.1-flash');
  const selection = plane.sessionManager.get(fake.channelId);
  assert.equal(selection.chatProviderId, 'opencode-go');
  assert.equal(selection.chatModel, 'deepseek-v4.1-flash');

  // A stale panel message from before the fix can carry a placeholder id; the
  // persistence boundary must still fail closed and keep the valid pin.
  const legacyId = 'panelchatm:opencode-go:<model-id>';
  await fake.channel.send({
    content: 'legacy chat model button',
    components: [{ components: [{ data: { custom_id: legacyId } }] }],
  });
  await fake.clickButton(legacyId);
  assert.match(fake.messages.at(-1).content, /无效的 Chat 模型选择/);
  assert.equal(plane.sessionManager.get(fake.channelId).chatModel, 'deepseek-v4.1-flash', 'previous valid pin must survive a rejected write');
});

test('an unknown model is rejected when the provider list is available and the previous pin is kept', async () => {
  const { fake, plane } = makePlane();
  await plane.start();
  await fake.sendAsUser({ content: '!chatmodel opencode-go deepseek-v4.1-flash' });
  await fake.sendAsUser({ content: '!chatmodel opencode-go model-that-does-not-exist' });
  assert.match(lastText(fake), /无效的 Chat 模型选择/);
  const selection = plane.sessionManager.get(fake.channelId);
  assert.equal(selection.chatProviderId, 'opencode-go');
  assert.equal(selection.chatModel, 'deepseek-v4.1-flash');
});

test('a provider that cannot enumerate models still accepts a non-placeholder id', async () => {
  const { fake, plane } = makePlane();
  plane.modelManager.list = async () => ({ models: [] });
  await plane.start();
  await fake.sendAsUser({ content: '!chatmodel opencode-go custom-manual-model' });
  assert.match(lastText(fake), /已固定/);
  assert.equal(plane.sessionManager.get(fake.channelId).chatModel, 'custom-manual-model');
});

test('AUTO chat succeeds through the healthy automatic route and never starts an Agent', async () => {
  const { fake, plane, calls } = makePlane();
  await plane.start();
  await fake.sendAsUser({ content: '你好' });
  assert.deepEqual(calls.seen, ['deepseek-v4.1-flash'], 'AUTO must pick the preferred healthy model');
  assert.match(lastText(fake), /你好，我是 Jarvis。/);
  assert.match(lastText(fake), /💬 Chat · OpenCode Go · deepseek-v4\.1-flash/);
  assert.equal(plane.runners.size, 0);
});

test('a manual real pin stays a true no-fallback pin', async () => {
  const seen = [];
  const { fake, plane } = makePlane({
    fetchImpl: async (_url, options) => {
      seen.push(JSON.parse(options.body).model);
      return jsonResponse(429, { error: { message: 'rate limited' } });
    },
  });
  await plane.start();
  await fake.sendAsUser({ content: '!chatmodel opencode-go deepseek-v4.1-flash' });
  await fake.sendAsUser({ content: '你好' });
  assert.deepEqual(seen, ['deepseek-v4.1-flash'], 'only the pinned model may be tried');
  assert.match(lastText(fake), /不会自动切换/);
});

test('AUTO prefers the LiteLLM gateway alias', async () => {
  const seen = [];
  const { fake, plane } = makePlane({ profiles: [LITELLM, OPENCODE_GO] });
  plane.chatRuntime.fetchImpl = async (url, options) => {
    seen.push(JSON.parse(options.body).model);
    if (!url.startsWith('http://127.0.0.1:4000')) throw Object.assign(new Error('fetch failed'), { code: 'UNREACHABLE' });
    return jsonResponse(200, { choices: [{ message: { content: 'gateway answer' } }] });
  };
  await plane.start();
  await fake.sendAsUser({ content: '你好' });
  assert.deepEqual(seen, ['chat-fast'], 'AUTO must try the gateway alias first');
  assert.match(lastText(fake), /gateway answer/);
  assert.match(lastText(fake), /LiteLLM Gateway · chat-fast/);
});
