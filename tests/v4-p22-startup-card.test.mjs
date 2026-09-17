import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiscordControlPlane } from '../src/discord-ui.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager, LEVEL } from '../src/permission-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { RunLogger } from '../src/logger.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';

const MODEL = 'deepseek-v4.1-flash';
const WS = 'D:\\proj\\alpha';

const OPENCODE = {
  id: 'opencode-go', displayName: 'OpenCode Go', protocol: 'opencode-go',
  baseUrl: 'https://opencode.ai/zen/go', billingType: 'SUBSCRIPTION', credentialRef: 'provider:opencode-go',
  models: [{ id: MODEL, transport: 'openai-chat' }],
};
const WORKBUDDY = { id: 'workbuddy-free', displayName: 'WorkBuddy Free', protocol: 'workbuddy', billingType: 'FREE', models: [{ id: 'fast-model', transport: 'workbuddy' }] };

function makePlane(stateFile, { providers = [OPENCODE], credentials = { 'provider:opencode-go': 'key' }, backendState = null } = {}) {
  const fake = new FakeDiscord();
  const state = new StateStore(stateFile);
  const launched = [];
  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: WS, claudeCommand: 'claude',
      notifyOnStart: true, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 1000,
      allowPaidFallback: true, taskTimeoutMs: 5000, maxWorkFollowUps: 10, autoRegisterCommands: false,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 500 }),
    permissionManager: new PermissionManager(),
    providerManager: {
      list: () => providers,
      get: (id) => providers.find((p) => p.id === id) ?? null,
      hasCredential: (p) => Boolean(credentials[p.credentialRef]),
      health: async () => ({ ok: true }),
    },
    credentialStore: { get: (ref) => credentials[ref] ?? null, set: () => {}, remove: () => {} },
    executorManager: {
      list: () => [], get: (id) => ({ id, displayName: id === 'claude' ? 'Claude Code' : id, available: true, adapterReady: true }),
      compatible: () => true, compatibleExecutors: () => [], resolveTransport: () => 'openai-chat',
      adapterLabel: () => 'Anthropic→OpenAI Chat',
      createRunner: async ({ model, executorId }) => {
        launched.push({ model, executorId });
        return {
          sessionId: 's1', model, busy: false, sent: [], idleMs: 0,
          async send() { return { text: 'ok', sessionId: 's1', durationMs: 1, tools: [], isError: false, costUsd: 0 }; },
          async stop() {},
        };
      },
    },
    modelManager: { list: async () => ({ models: OPENCODE.models }), select: async () => {} },
    chatRuntime: { send: async () => ({ text: 'x' }) },
    logger: new RunLogger(path.join(path.dirname(stateFile), 'logs')),
    backendState: backendState ?? { backend: { label: 'WorkBuddy Free DSF', model: 'fast-model', free: true }, workbuddyStatus: 'FAIL', allowPaidFallback: true },
    client: fake.client,
    autoLogin: false,
  });
  return { fake, plane, state, launched };
}

function tmpState(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ready-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'state.json');
}

function setupRestoredSelection(state, ws = WS) {
  state.rememberWorkModel({ channelId: null, cwd: ws, providerId: 'opencode-go', executorId: 'claude', model: MODEL });
}

function readyDm(fake) {
  return fake.messagesIn(`dm:${fake.ownerId}`).map((m) => m.content).join('\n');
}

test('startup card is built from the restored runtime state, not WorkBuddy/stale defaults', async (t) => {
  const stateFile = tmpState(t);
  const { fake, plane, state } = makePlane(stateFile);
  setupRestoredSelection(state);
  await plane.start();

  const card = readyDm(fake);
  assert.match(card, /✅ \*\*Bridge 已就绪\*\*/);
  assert.match(card, new RegExp(`模型：${MODEL}`), 'the card must show the restored model');
  assert.match(card, /Provider：OpenCode Go/);
  assert.match(card, /执行器：Claude Code/);
  assert.match(card, /协议：openai-chat/);
  assert.doesNotMatch(card, /fast-model/, 'a stale WorkBuddy probe model must never appear');
  assert.doesNotMatch(card, /WorkBuddy Free · 当前不可用/, 'an unused provider health must not pollute the card');
  assert.match(card, /工作目录：`D:\\proj\\alpha`/);
  // WorkBuddy-only concepts are omitted for a non-WorkBuddy route.
  assert.doesNotMatch(card, /付费回退/);
});

test('startup card fields equal the fields the real Agent launch uses', async (t) => {
  const stateFile = tmpState(t);
  const { fake, plane, state, launched } = makePlane(stateFile);
  setupRestoredSelection(state);
  plane.state.patchChannel(fake.channelId, { mode: 'work', cwd: WS, executorId: 'claude', providerId: 'opencode-go' }, WS);
  await plane.start();

  const runner = await plane.getRunner(fake.channelId);
  const card = readyDm(fake);
  assert.equal(runner.model, launched[0].model);
  assert.match(card, new RegExp(`模型：${launched[0].model}`));
  assert.match(card, /执行器：Claude Code/);
});

test('permission on the card reflects the current effective level', async (t) => {
  const stateFile = tmpState(t);
  const { fake, plane, state } = makePlane(stateFile);
  setupRestoredSelection(state);
  plane.permissionManager.switchLevel(null, LEVEL.RELAXED);
  await plane.start();
  assert.match(readyDm(fake), /权限：/);
  assert.doesNotMatch(readyDm(fake), /权限：🛡️ 标准/);
});

test('WorkBuddy route still shows its real billing and paid-fallback values', async (t) => {
  const stateFile = tmpState(t);
  const { fake, plane, state } = makePlane(stateFile, {
    providers: [WORKBUDDY],
    credentials: { undefined: 'x' },
    backendState: { backend: { label: 'WorkBuddy Free DSF', model: 'fast-model', free: true }, workbuddyStatus: 'PASS', allowPaidFallback: true },
  });
  state.rememberWorkModel({ channelId: null, cwd: WS, providerId: 'workbuddy-free', executorId: 'claude', model: 'fast-model' });
  await plane.start();
  const card = readyDm(fake);
  assert.match(card, /Provider：WorkBuddy Free/);
  assert.match(card, /付费回退：已启用/);
  assert.match(card, /计费：免费/);
});

test('when the active route cannot work, the card warns instead of pretending to be ready', async (t) => {
  const stateFile = tmpState(t);
  const { fake, plane, state } = makePlane(stateFile, { credentials: {} }); // missing credential
  setupRestoredSelection(state);
  await plane.start();
  const card = readyDm(fake);
  assert.match(card, /⚠️ \*\*Bridge 已启动，但当前 Provider 不可用\*\*/);
  assert.doesNotMatch(card, /✅ \*\*Bridge 已就绪\*\*/);
});

test('a stale saved model is reported on the card and never silently replaced', async (t) => {
  const stateFile = tmpState(t);
  const { fake, plane, state } = makePlane(stateFile, {
    providers: [{ ...OPENCODE, models: [{ id: 'only-other', transport: 'openai-chat' }] }],
  });
  state.rememberWorkModel({ channelId: null, cwd: WS, providerId: 'opencode-go', executorId: 'claude', model: MODEL });
  await plane.start();
  const card = readyDm(fake);
  assert.match(card, /⚠️/);
  assert.doesNotMatch(card, /模型：only-other/);
  assert.match(card, /已保存模型 .* 当前不可用/);
});

test('!status and the startup card agree on model/provider/executor/workspace', async (t) => {
  const stateFile = tmpState(t);
  const { fake, plane, state } = makePlane(stateFile);
  setupRestoredSelection(state);
  plane.state.patchChannel(fake.channelId, { mode: 'work', cwd: WS, executorId: 'claude', providerId: 'opencode-go' }, WS);
  await plane.start();
  await fake.sendAsUser({ content: '!status' });

  const card = readyDm(fake);
  const status = fake.messagesIn(fake.channelId).map((m) => m.content).join('\n');
  // Card and /status use different labels for the same resolved values.
  for (const field of [`模型：${MODEL}`, '执行器：Claude Code', 'OpenCode Go']) {
    assert.ok(card.includes(field), `card must contain ${field}`);
    assert.ok(status.includes(field), `!status must contain ${field}`);
  }
  assert.match(card, /Provider：OpenCode Go/);
  assert.match(status, /提供商：OpenCode Go/);
  assert.doesNotMatch(status, /fast-model/);
});

test('a model selection cwd never becomes the workspace; only !workspace does', async (t) => {
  const stateFile = tmpState(t);
  const modelCwd = 'D:\\proj\\model-selection-dir';
  const { fake, plane, state } = makePlane(stateFile);
  // The model selection records a cwd for audit, but it is not a workspace choice.
  setupRestoredSelection(state, modelCwd);
  await plane.start();
  const card = readyDm(fake);
  assert.match(card, new RegExp(`工作目录：\`${WS.replace(/\\/g, '\\\\')}\``), 'the card must use the configured default workspace');
  assert.doesNotMatch(card, /model-selection-dir/);

  // An explicit !workspace selection is what persists and shows up.
  state.setGlobalWorkspace(modelCwd);
  assert.equal(plane.effectiveRuntimeState({}).workspace, modelCwd);
  assert.equal(plane.effectiveRuntimeState({}).workspaceSource, 'saved');
});
