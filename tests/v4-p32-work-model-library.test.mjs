/**
 * P3.2 — Work model library regression.
 *
 * The Work model screen must be a model-selection surface, not a dead end
 * created by the previously selected executor. From `workbuddy / workbuddy-free
 * / null`, the owner must still reach OpenCode Go and its discovered model list,
 * and selecting a model must produce a valid executable tuple
 * (executor + provider + model + transport) atomically.
 *
 * These tests use the REAL ExecutorManager compatibility logic (with a fake
 * version probe) so the failure seam that caused the regression is actually
 * exercised, not stubbed away.
 */
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
import { ExecutorManager } from '../src/executor-manager.mjs';
import { PROTOCOL, TRANSPORT } from '../src/provider-manager.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';

const WORKBUDDY = {
  id: 'workbuddy-free', displayName: 'WorkBuddy Free', protocol: PROTOCOL.WORKBUDDY,
  billingType: 'FREE', credentialRef: null, models: [],
};
const OPENCODE = {
  id: 'opencode-go', displayName: 'OpenCode Go', protocol: PROTOCOL.OPENCODE_GO,
  baseUrl: 'https://opencode.ai/zen/go', billingType: 'SUBSCRIPTION', credentialRef: 'provider:opencode-go',
  models: [
    { id: 'deepseek-v4.1-flash', displayName: 'deepseek-v4.1-flash', transport: TRANSPORT.OPENAI_CHAT },
    { id: 'minimax-m3', displayName: 'minimax-m3', transport: TRANSPORT.ANTHROPIC_MESSAGES },
    { id: 'grok-4.6', displayName: 'grok-4.6', transport: TRANSPORT.OPENAI_RESPONSES },
    { id: 'union-alpha', displayName: 'union-alpha', transport: TRANSPORT.UNKNOWN },
  ],
};
// A provider with a protocol no ready executor supports: it must not appear.
const ORPHAN = {
  id: 'orphan-openai', displayName: 'Orphan OpenAI', protocol: PROTOCOL.OPENAI,
  baseUrl: 'https://orphan.invalid/v1', billingType: 'UNKNOWN', credentialRef: 'provider:orphan',
  models: [{ id: 'x', transport: TRANSPORT.OPENAI_CHAT }],
};

const PROVIDERS = [WORKBUDDY, OPENCODE, ORPHAN];

async function makePlane({ executorId = 'workbuddy', providerId = 'workbuddy-free', model = null, cwd = null, permission = null } = {}) {
  const fake = new FakeDiscord();
  const dir = cwd || fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p32-work-'));
  const state = new StateStore(path.join(dir, 'state.json'));
  state.patchChannel(fake.channelId, { mode: 'work', cwd: dir, executorId, providerId, model }, dir);

  const providerManager = {
    list: () => PROVIDERS,
    get: (id) => PROVIDERS.find((item) => item.id === id) || null,
    hasCredential: () => true,
    listModels: async (id) => ({ models: PROVIDERS.find((item) => item.id === id)?.models ?? [] }),
  };
  const modelManager = {
    select: async () => {},
    list: async (id) => ({ models: PROVIDERS.find((item) => item.id === id)?.models ?? [] }),
  };
  // REAL compatibility logic: workbuddy + claude installed; opencode/codex are not.
  const executorManager = new ExecutorManager({
    workbuddyCommand: 'workbuddy.js',
    probeVersion: async (command) => ({ 'workbuddy.js': '2.137.1', claude: '2.1.270' })[command] || null,
  });
  const permissions = new PermissionManager();
  if (permission) permissions.switchLevel(fake.channelId, permission);

  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: dir, claudeCommand: 'workbuddy.js',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 1000,
      allowPaidFallback: false, taskTimeoutMs: 0, maxWorkFollowUps: 10,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 }),
    permissionManager: permissions,
    providerManager,
    modelManager,
    executorManager,
    credentialStore: { get: () => 'secret', has: () => true },
    chatRuntime: { send: async () => ({ text: 'chat', providerId: 'opencode-go', providerName: 'OpenCode Go', model: 'deepseek-v4.1-flash', attempts: [] }) },
    logger: new RunLogger(path.join(dir, 'logs')),
    backendState: { backend: { label: 'WorkBuddy', model: 'm' }, workbuddyStatus: 'PASS', allowPaidFallback: false },
    client: fake.client,
    autoLogin: false,
  });
  await plane.executorManager.discover();
  return { fake, plane, dir, permissions };
}

async function openWorkMenu(fake, plane) {
  await plane.start();
  await fake.sendAsUser({ content: '!panel' });
  await fake.clickButton('panel:models');
  await fake.clickButton('panelmodels:work');
  return fake.messages.at(-1);
}

// 1 + 11: reachable from the broken WorkBuddy-bound state.

test('P3.2: OpenCode Go is reachable from workbuddy/workbuddy-free/null', async () => {
  const { fake, plane } = await makePlane();
  assert.equal(plane.executorManager.compatible('workbuddy', PROTOCOL.OPENCODE_GO, null), false,
    'precondition: the real workbuddy executor cannot run OpenCode Go');
  const menu = await openWorkMenu(fake, plane);
  assert.ok(menu.buttonIds.includes('panelworkp:opencode-go'), 'OpenCode Go must be reachable');
  assert.ok(menu.buttonIds.includes('panelworkp:workbuddy-free'), 'WorkBuddy must remain reachable');
  assert.ok(!menu.buttonIds.includes('panelworkp:orphan-openai'), 'a provider with no runnable executor is hidden');
});

// 2: the discovered model list is reachable and transport-aware.

test('P3.2: the OpenCode Go model list is populated with transport + compatibility marks', async () => {
  const { fake, plane } = await makePlane();
  await openWorkMenu(fake, plane);
  await fake.clickButton('panelworkp:opencode-go');
  const list = fake.messages.at(-1);
  assert.match(list.content, /deepseek-v4\.1-flash/);
  assert.match(list.content, /minimax-m3/);
  assert.match(list.content, /openai-chat/);
  assert.match(list.content, /anthropic-messages/);
  assert.match(list.content, /Anthropic → OpenAI Chat/, 'openai-chat models show the adapter');
  assert.ok(list.buttonIds.includes('panelworkm:opencode-go:deepseek-v4.1-flash'));
  // grok-4.6 (responses) has no ready executor on this install: shown disabled.
  const buttons = list.components.flatMap((row) => row.components);
  const disabled = buttons.find((button) => button.data.custom_id === 'panelworkm:opencode-go:grok-4.6');
  assert.equal(disabled.data.disabled, true, 'a model with no runnable executor is not selectable');
  assert.match(list.content, /无可用执行器/);
});

// 3 + 5: incompatible current executor is replaced, atomically and truthfully.

test('P3.2: selecting an OpenCode Go model switches to a compatible executor with truthful text', async () => {
  const { fake, plane, permissions } = await makePlane({ permission: LEVEL.RELAXED });
  await openWorkMenu(fake, plane);
  await fake.clickButton('panelworkp:opencode-go');
  await fake.clickButton('panelworkm:opencode-go:deepseek-v4.1-flash');

  const selection = plane.sessionManager.get(fake.channelId);
  assert.equal(selection.providerId, 'opencode-go');
  assert.equal(selection.model, 'deepseek-v4.1-flash');
  assert.equal(selection.executorId, 'claude', 'the incompatible workbuddy executor is replaced');
  assert.equal(selection.cwd, plane.config.defaultCwd, 'workspace is preserved');
  assert.equal(permissions.getLevel(fake.channelId), LEVEL.RELAXED, 'permission tier is preserved');

  const confirmation = fake.messages.at(-1).content;
  assert.match(confirmation, /✅ Work 已切换：Claude Code · OpenCode Go · deepseek-v4\.1-flash/);
  assert.match(confirmation, /自动选择可运行的执行器/);

  // The persisted route resolves to a runnable runtime state.
  const effective = plane.effectiveRuntimeState({ channelId: fake.channelId });
  assert.equal(effective.executor.id, 'claude');
  assert.equal(effective.provider.id, 'opencode-go');
  assert.equal(effective.model, 'deepseek-v4.1-flash');
  assert.equal(effective.ok, true, 'the selected tuple is executable');
});

// 4: the current executor is retained when already compatible.

test('P3.2: a compatible current executor is retained', async () => {
  const { fake, plane } = await makePlane({ executorId: 'claude' });
  await openWorkMenu(fake, plane);
  await fake.clickButton('panelworkp:opencode-go');
  await fake.clickButton('panelworkm:opencode-go:minimax-m3');
  const selection = plane.sessionManager.get(fake.channelId);
  assert.equal(selection.executorId, 'claude', 'claude natively runs anthropic-messages');
  assert.equal(selection.model, 'minimax-m3');
  assert.doesNotMatch(fake.messages.at(-1).content, /自动选择可运行的执行器/);
});

// 6: no runnable executor -> nothing persisted, UI explains why.

test('P3.2: a model with no runnable executor cannot be selected into broken state', async () => {
  const { fake, plane } = await makePlane();
  await openWorkMenu(fake, plane);
  await fake.clickButton('panelworkp:opencode-go');
  await fake.clickButton('panelworkm:opencode-go:union-alpha');
  const selection = plane.sessionManager.get(fake.channelId);
  assert.equal(selection.providerId, 'workbuddy-free', 'the provider is not changed on failure');
  assert.equal(selection.model, null, 'no broken model is persisted');
  assert.equal(selection.executorId, 'workbuddy');
  assert.match(fake.messages.at(-1).content, /没有可运行的执行器/);
});

// 7: WorkBuddy remains selectable from a non-WorkBuddy route.

test('P3.2: the WorkBuddy route remains selectable', async () => {
  const { fake, plane } = await makePlane({ executorId: 'claude', providerId: 'opencode-go', model: 'deepseek-v4.1-flash' });
  await openWorkMenu(fake, plane);
  await fake.clickButton('panelworkp:workbuddy-free');
  const selection = plane.sessionManager.get(fake.channelId);
  assert.equal(selection.providerId, 'workbuddy-free');
  assert.equal(selection.executorId, 'workbuddy', 'the WorkBuddy-native executor is selected');
  assert.match(fake.messages.at(-1).content, /Work 已切换：WorkBuddy · WorkBuddy Free/);
});

// 8: Chat selection is untouched by the Work route change.

test('P3.2: Chat model selection is unchanged and independent', async () => {
  const { fake, plane } = await makePlane();
  await plane.start();
  plane.sessionManager.setChatSelection(fake.channelId, { providerId: 'opencode-go', model: 'deepseek-v4.1-flash' });

  await fake.sendAsUser({ content: '!panel' });
  await fake.clickButton('panel:models');
  await fake.clickButton('panelmodels:work');
  await fake.clickButton('panelworkp:opencode-go');
  await fake.clickButton('panelworkm:opencode-go:minimax-m3');

  const selection = plane.sessionManager.get(fake.channelId);
  assert.equal(selection.chatProviderId, 'opencode-go');
  assert.equal(selection.chatModel, 'deepseek-v4.1-flash', 'Chat selection is not modified by a Work change');
  assert.equal(selection.model, 'minimax-m3');
});

// 10: a Work start actually uses the selected tuple.

test('P3.2: a Work started after selection runs through the selected executor/provider/model', async () => {
  const { fake, plane } = await makePlane();
  await openWorkMenu(fake, plane);
  await fake.clickButton('panelworkp:opencode-go');
  await fake.clickButton('panelworkm:opencode-go:deepseek-v4.1-flash');

  const captured = [];
  const runner = {
    sessionId: 'sess-p32', model: 'deepseek-v4.1-flash', busy: false, idleMs: 0, sent: [],
    async send(prompt) { this.busy = true; this.sent.push(prompt); this.busy = false; return { text: 'done', sessionId: this.sessionId, durationMs: 1, tools: [], isError: false, costUsd: 0 }; },
    async stop() { return { killed: false, pid: null }; },
  };
  plane.executorManager.createRunner = async (args) => { captured.push(args); return runner; };

  await fake.sendAsUser({ content: 'work safe task' });
  assert.equal(captured.length, 1, 'exactly one runner is created');
  assert.equal(captured[0].executorId, 'claude');
  assert.equal(captured[0].provider.id, 'opencode-go');
  assert.equal(captured[0].model, 'deepseek-v4.1-flash');
  assert.deepEqual(runner.sent, ['safe task']);
});
