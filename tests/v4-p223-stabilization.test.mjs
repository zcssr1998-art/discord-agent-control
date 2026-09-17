/**
 * P2.2.3 stabilization regressions:
 *  - K1: a many-model provider must be browsable/selectable in Discord, never a
 *    fake `<model-id>` placeholder command;
 *  - K2: every registered slash command and panel control must ACK before slow
 *    work, with latency recorded;
 *  - K3: the help view must actually expose the controls its copy references.
 */
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
import { PROTOCOL, TRANSPORT } from '../src/provider-manager.mjs';
import { COMMAND_NAMES } from '../src/commands.mjs';
import { ExecutorManager } from '../src/executor-manager.mjs';
import { cleanupInbox } from '../src/attachments.mjs';
import { providerModelRows, pagedChoiceRows } from '../src/discord/renderers.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';

const PLACEHOLDER_RE = /<(model|provider|anything)[-_]?id?>/i;

function makeProvider(id, modelCount, { displayName = id } = {}) {
  return {
    id, displayName, protocol: PROTOCOL.OPENCODE_GO,
    baseUrl: 'https://example.invalid', billingType: 'SUBSCRIPTION', credentialRef: `provider:${id}`,
    models: Array.from({ length: modelCount }, (_, i) => ({ id: `${id}-model-${String(i + 1).padStart(2, '0')}`, transport: TRANSPORT.OPENAI_CHAT })),
  };
}

function makePlane({ profiles = [makeProvider('opencode-go', 2)], threadCapable = false, stateFile = null } = {}) {
  const fake = new FakeDiscord({ threadCapable });
  const dir = stateFile ? path.dirname(stateFile) : fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p223-'));
  const state = new StateStore(stateFile || path.join(dir, 'state.json'));
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
  const executorManager = {
    list: () => [], get: () => null, compatible: () => true, compatibleExecutors: () => [],
    resolveTransport: () => TRANSPORT.OPENAI_CHAT, adapterLabel: () => null,
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
    modelManager,
    executorManager,
    logger: new RunLogger(path.join(dir, 'logs')),
    backendState: { backend: { label: 'WorkBuddy', model: 'm', free: true }, allowPaidFallback: false },
    client: fake.client,
    autoLogin: false,
  });
  return { fake, plane, providers, modelManager };
}

// ------------------------------------------------------------------- renderers

test('providerModelRows paginates instead of refusing a large model list', () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, label: `m${i}` }));
  const page1 = providerModelRows('panelchatm', 'p', items, { page: 1 });
  assert.equal(page1.pages, 3);
  assert.equal(page1.page, 1);
  assert.equal(page1.rows.length, 4, '15 models = 3 rows + 1 nav row');
  const ids = page1.rows.flat().map((row) => row.components.map((c) => c.data.custom_id));
  assert.ok(ids.flat().includes('panelchatm:p:m0'));
  assert.ok(ids.flat().includes('panelchatmnav:p:2'));
  const page3 = providerModelRows('panelchatm', 'p', items, { page: 99 });
  assert.equal(page3.page, 3, 'an out-of-range page clamps to the last page');
});

test('pagedChoiceRows paginates provider lists and keeps nav ids in range', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ id: `p${i}`, label: `p${i}` }));
  const paged = pagedChoiceRows('panelchatp', items, { page: 1, pageSize: 10 });
  assert.equal(paged.pages, 3);
  const flat = paged.rows.flat().map((row) => row.components.map((c) => c.data.custom_id)).flat();
  assert.ok(flat.includes('panelchatp:p0'));
  assert.ok(flat.includes('panelchatpnav:0'), 'prev disabled on page 1 is still rendered');
  assert.ok(flat.includes('panelchatpnav:2'));
});

// ------------------------------------------------------------------ K1: chat

test('many-model Chat provider is paginated and directly selectable (no placeholder)', async () => {
  const profile = makeProvider('opencode-go', 40);
  const { fake, plane } = makePlane({ profiles: [profile] });
  await plane.start();

  await fake.command('model');
  await fake.clickButton('panelmodels:chat');
  await fake.clickButton('panelchatp:opencode-go');

  const page1 = fake.messages.at(-1);
  assert.match(page1.content, /第 1\/3 页/);
  assert.doesNotMatch(page1.content, PLACEHOLDER_RE);
  assert.ok(page1.buttonIds.includes('panelchatm:opencode-go:opencode-go-model-01'));
  assert.ok(page1.buttonIds.includes('panelchatmnav:opencode-go:2'), 'a real next-page control exists');

  await fake.clickButton('panelchatmnav:opencode-go:2');
  const page2 = fake.messages.at(-1);
  assert.match(page2.content, /第 2\/3 页/);
  const target = 'opencode-go-model-16';
  assert.ok(page2.buttonIds.includes(`panelchatm:opencode-go:${target}`));

  await fake.clickButton(`panelchatm:opencode-go:${target}`);
  const selection = plane.sessionManager.get(fake.channelId);
  assert.equal(selection.chatProviderId, 'opencode-go');
  assert.equal(selection.chatModel, target);
});

test('`!chatmodel` with no argument opens the real selectable menu', async () => {
  const { fake, plane } = makePlane({ profiles: [makeProvider('opencode-go', 4)] });
  await plane.start();
  await fake.sendAsUser({ content: '!chatmodel' });
  const menu = fake.messages.at(-1);
  assert.ok(menu.buttonIds.includes('panelchat:auto'));
  assert.ok(menu.buttonIds.includes('panelchatp:opencode-go'));
  assert.doesNotMatch(menu.content, PLACEHOLDER_RE);
});

test('`!chatmodel <provider>` with no model opens that provider model list', async () => {
  const { fake, plane } = makePlane({ profiles: [makeProvider('opencode-go', 4)] });
  await plane.start();
  await fake.sendAsUser({ content: '!chatmodel opencode-go' });
  const list = fake.messages.at(-1);
  assert.ok(list.buttonIds.includes('panelchatm:opencode-go:opencode-go-model-01'));
  assert.doesNotMatch(list.content, PLACEHOLDER_RE);
});

test('many-model Work menu is paginated as well', async () => {
  const { fake, plane } = makePlane({ profiles: [makeProvider('opencode-go', 40)] });
  await plane.start();
  await fake.command('model');
  await fake.clickButton('panelmodels:work');
  await fake.clickButton('panelworkp:opencode-go');
  const page1 = fake.messages.at(-1);
  assert.match(page1.content, /第 1\/3 页/);
  assert.ok(page1.buttonIds.includes('panelworkmnav:opencode-go:2'));
  assert.ok(!page1.buttonIds.includes('panelworkmnav:opencode-go:3'), 'page 1 must not offer a skip-ahead page');
  await fake.clickButton('panelworkmnav:opencode-go:2');
  await fake.clickButton('panelworkmnav:opencode-go:3');
  const page3 = fake.messages.at(-1);
  assert.ok(page3.buttonIds.includes('panelworkm:opencode-go:opencode-go-model-40'));
});

test('settings Work-model list paginates for a many-model provider', async () => {
  const { fake, plane } = makePlane({ profiles: [makeProvider('opencode-go', 40)] });
  plane.sessionManager.change(fake.channelId, { providerId: 'opencode-go' }, 'test setup');
  await plane.start();
  await fake.sendAsUser({ content: '!settings' });
  await fake.clickButton('set:model');
  const page1 = fake.messages.at(-1);
  assert.match(page1.content, /第 1\/4 页/);
  assert.ok(page1.buttonIds.includes('setmodelnav:2'));
  assert.ok(page1.buttonIds.includes('setmodel:opencode-go-model-01'));
  await fake.clickButton('setmodelnav:2');
  assert.ok(fake.messages.at(-1).buttonIds.includes('setmodel:opencode-go-model-11'));
});

test('resolveTransport understands both a model id and a model object', () => {
  const executors = new ExecutorManager({ workbuddyCommand: 'claude', probeVersion: async () => 'test' });
  const provider = { id: 'opencode-go', protocol: PROTOCOL.OPENCODE_GO };
  assert.equal(executors.resolveTransport(provider, 'deepseek-v4.1-flash'), TRANSPORT.OPENAI_CHAT);
  assert.equal(executors.resolveTransport(provider, { id: 'minimax-m3' }), TRANSPORT.ANTHROPIC_MESSAGES);
  assert.equal(executors.resolveTransport(provider, { id: 'no-family-match' }), TRANSPORT.UNKNOWN);
});

test('attachment inbox TTL cleanup removes only expired entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-inbox-'));
  const oldFile = path.join(root, 'chan', 'msg-old', 'old.txt');
  const newFile = path.join(root, 'chan', 'msg-new', 'new.txt');
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });
  fs.mkdirSync(path.dirname(newFile), { recursive: true });
  fs.writeFileSync(oldFile, 'old');
  fs.writeFileSync(newFile, 'new');
  const old = new Date(Date.now() - 72 * 60 * 60 * 1000);
  fs.utimesSync(oldFile, old, old);
  fs.utimesSync(path.dirname(oldFile), old, old);
  const removed = cleanupInbox(root, { ttlMs: 48 * 60 * 60 * 1000 });
  assert.equal(fs.existsSync(oldFile), false, 'an expired attachment must be removed');
  assert.equal(fs.existsSync(newFile), true, 'a fresh attachment must survive');
  assert.ok(removed.length >= 1);
  fs.rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------- K1: textual sweep

test('the model-selection surfaces never print a runnable-looking placeholder', async () => {
  const { fake, plane } = makePlane({ profiles: [makeProvider('opencode-go', 40)] });
  plane.modelManager.list = async () => ({ models: [] });
  await plane.start();

  const seen = [];
  await fake.sendAsUser({ content: '!chatmodel' });
  seen.push(fake.messages.at(-1).content);
  await fake.sendAsUser({ content: '!chatmodel opencode-go' });
  seen.push(fake.messages.at(-1).content);
  await fake.sendAsUser({ content: '!models' });
  seen.push(fake.messages.at(-1).content);
  await fake.sendAsUser({ content: '!providers' });
  seen.push(fake.messages.at(-1).content);
  await fake.sendAsUser({ content: '!help' });
  seen.push(fake.messages.at(-1).content);
  await fake.command('model');
  seen.push(fake.messages.at(-1).content);

  for (const text of seen) {
    assert.doesNotMatch(text, PLACEHOLDER_RE, `user-visible text must not contain a fake placeholder: ${text.slice(0, 120)}`);
  }
});

// ------------------------------------------------------------ K3: help view

test('help view exposes the controls its copy references', async () => {
  const { fake, plane } = makePlane();
  await plane.start();
  await fake.command('help');
  const help = fake.messages.at(-1);
  assert.match(help.content, /点 ⚙️ 设置/);
  for (const id of ['panel:newwork', 'panel:settings', 'panel:permission', 'panel:stop', 'panel:refresh']) {
    assert.ok(help.buttonIds.includes(id), `help view must expose ${id}`);
  }
  assert.doesNotMatch(PANEL_HELP_TEXT, /Work = Claude Code/);

  // The help-referenced Stop button must still be the real shared stop path.
  await fake.clickButton('panel:stop');
  assert.match(fake.messages.at(-1).content, /没有 Agent 进程|已停止|待执行/);
});

// ---------------------------------------------------------------- K2: ACK matrix

test('every registered slash command ACKs before slow work', async () => {
  assert.deepEqual([...COMMAND_NAMES].sort(), [
    'compact', 'doctor', 'help', 'model', 'new', 'panel', 'permission', 'settings', 'status', 'stop', 'work',
  ]);
  const { fake, plane } = makePlane({ threadCapable: true });
  plane.getRunner = async (channelId) => ({
    sessionId: `sess-${channelId}`, model: 'm', busy: false, stopped: false, sent: [], idleMs: 0,
    async send(prompt) {
      this.busy = true;
      plane.onRunnerEvent(channelId, { type: 'session', sessionId: this.sessionId });
      this.busy = false;
      return { text: `done:${prompt}`, sessionId: this.sessionId, durationMs: 1, tools: [], isError: false, costUsd: 0 };
    },
    async stop() { this.stopped = true; this.busy = false; },
  });
  await plane.start();

  const ackCountBefore = (plane.ackLog ?? []).length;
  for (const name of COMMAND_NAMES) {
    const options = name === 'work' ? { options: { task: 'ack matrix task' }, guildId: 'g1' } : {};
    await fake.command(name, options);
    const ack = plane.ackLog.at(-1);
    assert.equal(ack.result, 'PASS', `${name} must ACK PASS (${ack.result})`);
    assert.equal(ack.label, `/${name}`);
    assert.ok(Number.isFinite(ack.latencyMs), `${name} must record ACK latency`);
    assert.ok(ack.ackCompletedAt >= ack.ackStartedAt);
  }
  assert.equal(plane.ackLog.length, ackCountBefore + COMMAND_NAMES.length);
  assert.equal(plane.ackLog.at(-1).result, 'PASS');

  // /work without a task uses showModal as its ACK and starts no Agent.
  await fake.command('work', { guildId: 'g1' });
  assert.equal(plane.ackLog.at(-1).method, 'showModal');
  assert.equal(plane.ackLog.at(-1).result, 'PASS');
});

test('every panel control ACKs (button paths), including modal-opening buttons', async () => {
  const { fake, plane } = makePlane({ threadCapable: true });
  await plane.start();
  const targets = [
    ['panel:newwork', 'showModal'],
    ['panel:models', 'deferUpdate'],
    ['panel:settings', 'deferUpdate'],
    ['panel:permission', 'deferUpdate'],
    ['panel:newchat', 'deferUpdate'],
    ['panel:compact', 'deferUpdate'],
    ['panel:status', 'deferUpdate'],
    ['panel:stop', 'deferUpdate'],
    ['panel:help', 'deferUpdate'],
    ['panel:refresh', 'deferUpdate'],
  ];
  for (const [customId, method] of targets) {
    await fake.sendAsUser({ content: '!panel' });
    await fake.clickButton(customId);
    const ack = plane.ackLog.at(-1);
    assert.equal(ack.result, 'PASS', `${customId} must ACK (${ack.result} ${ack.reason?.type ?? ''})`);
    assert.equal(ack.method, method, `${customId} must use ACK method ${method}`);
    assert.equal(ack.label, `button:${customId}`);
  }
});

test('a panel interaction whose ACK fails performs no side effect', async () => {
  const fake = new FakeDiscord({
    threadCapable: true,
    ackFailure: { method: 'deferUpdate', error: Object.assign(new Error('Unknown interaction'), { name: 'DiscordAPIError', code: 10062, status: 404 }) },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p223-ack-'));
  const state = new StateStore(path.join(dir, 'state.json'));
  const providers = { list: () => [], get: () => null, hasCredential: () => true };
  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: dir, claudeCommand: 'claude',
      notifyOnStart: false, progressThrottleMs: 1, stallNoticeMs: 1000, taskTimeoutMs: 5000,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 }),
    permissionManager: new PermissionManager(),
    providerManager: providers,
    modelManager: { list: async () => ({ models: [] }), select: async () => {} },
    logger: new RunLogger(path.join(dir, 'logs')),
    client: fake.client,
    autoLogin: false,
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    await plane.start();
    await fake.sendAsUser({ content: '!panel' });
    await fake.clickButton('panel:newchat'); // would clear chat history if it ran
    assert.equal(plane.lastAck.result, 'FAIL');
    assert.equal(plane.lastAck.reason.type, 'UnknownInteraction');
  } finally {
    console.error = originalError;
  }
});
