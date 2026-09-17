import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiscordControlPlane } from '../src/discord-ui.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager, LEVEL } from '../src/permission-manager.mjs';
import { StateStore, workspaceKey } from '../src/state.mjs';
import { SessionManager } from '../src/session-manager.mjs';
import { RunLogger } from '../src/logger.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';

const MODEL = 'deepseek-v4.1-flash';
const OTHER = 'glm-5.3-flash';

const PROVIDERS = [
  {
    id: 'opencode-go', displayName: 'OpenCode Go', protocol: 'opencode-go',
    billingType: 'SUBSCRIPTION', credentialRef: 'provider:opencode-go',
    models: [{ id: MODEL, transport: 'openai-chat' }, { id: OTHER, transport: 'openai-chat' }],
  },
  { id: 'workbuddy-free', displayName: 'WorkBuddy Free', protocol: 'workbuddy', billingType: 'FREE', models: [] },
];

const EXECUTORS = [
  { id: 'workbuddy', displayName: 'WorkBuddy', available: true, adapterReady: true, status: 'PASS' },
  { id: 'claude', displayName: 'Claude Code', available: true, adapterReady: true, status: 'PASS' },
];

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A control plane over a REAL state file, wired exactly like index.mjs: the
 * permission tier persists per channel and, when the owner chose it explicitly,
 * as the durable owner default.
 */
function makePlane(stateFile, cwd, { hold = false, threadCapable = false, ownerDefaults = null } = {}) {
  const fake = new FakeDiscord({ threadCapable });
  const state = new StateStore(stateFile);
  if (ownerDefaults) state.setOwnerDefaults(ownerDefaults);
  const launched = [];
  const gate = {};
  gate.promise = new Promise((resolve) => { gate.resolve = resolve; });
  const permissions = new PermissionManager({
    defaultLevel: state.getOwnerDefaultPermission(),
    initialLevels: state.allPermissionLevels(),
    onChange: (channelId, level, meta) => {
      state.setPermissionLevel(channelId, level);
      if (meta?.explicit) state.setOwnerDefaults({ permission: level });
    },
  });
  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: cwd, claudeCommand: 'claude',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 1000,
      allowPaidFallback: false, taskTimeoutMs: 5000, maxWorkFollowUps: 10,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 500 }),
    permissionManager: permissions,
    providerManager: {
      list: () => PROVIDERS,
      get: (id) => PROVIDERS.find((item) => item.id === id) || null,
      hasCredential: () => true,
      health: async () => ({ ok: true }),
    },
    credentialStore: { get: () => 'key', set: () => {}, remove: () => {} },
    executorManager: {
      list: () => EXECUTORS,
      get: (id) => EXECUTORS.find((item) => item.id === id) || null,
      compatible: () => true,
      compatibleExecutors: () => EXECUTORS,
      resolveTransport: () => 'openai-chat',
      adapterLabel: () => null,
      createRunner: async ({ model }) => {
        launched.push(model);
        return {
          sessionId: 'sess-1', model, busy: false, sent: [], idleMs: 0,
          async send(prompt) {
            this.busy = true;
            plane.onRunnerEvent(fake.channelId, { type: 'session', sessionId: this.sessionId });
            if (hold) await gate.promise;
            this.busy = false;
            return { text: `done:${prompt}`, sessionId: this.sessionId, durationMs: 1, tools: [], isError: false, costUsd: 0 };
          },
          async stop() { this.busy = false; },
        };
      },
    },
    modelManager: { list: async () => ({ models: PROVIDERS[0].models }), select: async () => {} },
    chatRuntime: { send: async () => ({ text: 'x' }), health: { list: () => [], reset: () => {} } },
    logger: new RunLogger(path.join(path.dirname(stateFile), 'logs')),
    backendState: { backend: { label: 'OpenCode Go', model: MODEL }, allowPaidFallback: false },
    client: fake.client,
    autoLogin: false,
  });
  return { fake, plane, state, permissions, launched, gate };
}

test('an explicit owner selection is durable and reloads from the real state file', async (t) => {
  const dir = tmpDir(t);
  const ws = path.join(dir, 'proj');
  fs.mkdirSync(ws, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const { fake, plane, state } = makePlane(stateFile, ws);
  state.patchChannel(fake.channelId, { mode: 'work', cwd: ws, executorId: 'claude', providerId: 'opencode-go' }, ws);
  await plane.start();

  await fake.sendAsUser({ content: '!executor claude' });
  await fake.sendAsUser({ content: '!provider opencode-go' });
  await fake.sendAsUser({ content: '!model ' + MODEL });
  await fake.sendAsUser({ content: '!chatmodel opencode-go ' + OTHER });

  const owner = state.getOwnerDefaults();
  assert.equal(owner.executorId, 'claude');
  assert.equal(owner.providerId, 'opencode-go');
  assert.equal(owner.model, MODEL);
  assert.equal(owner.chatProviderId, 'opencode-go');
  assert.equal(owner.chatModel, OTHER);
  // On disk, not just in memory.
  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(raw.preferences.ownerDefaults.executorId, 'claude');
  assert.equal(raw.preferences.ownerDefaults.providerId, 'opencode-go');

  // A brand-new process reads the same durable profile.
  const reloaded = new StateStore(stateFile).getOwnerDefaults();
  assert.equal(reloaded.executorId, 'claude');
  assert.equal(reloaded.providerId, 'opencode-go');
  assert.equal(reloaded.model, MODEL);
  assert.equal(reloaded.chatProviderId, 'opencode-go');
  assert.equal(reloaded.chatModel, OTHER);
});

test('a scope with no local override inherits the owner defaults (not hard-coded values)', (t) => {
  const dir = tmpDir(t);
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const state = new StateStore(path.join(dir, 'state.json'));
  state.setOwnerDefaults({
    executorId: 'claude', providerId: 'opencode-go', model: MODEL,
    chatProviderId: 'opencode-go', chatModel: OTHER, permission: LEVEL.RELAXED,
    workspace: ws,
  });

  const fresh = state.getChannel('never-configured', path.join(dir, 'fallback'));
  assert.equal(fresh.executorId, 'claude');
  assert.equal(fresh.providerId, 'opencode-go');
  assert.equal(fresh.chatProviderId, 'opencode-go');
  assert.equal(fresh.chatModel, OTHER);
  assert.equal(fresh.cwd, ws, 'the saved owner workspace applies to a new scope');
  // The Work model is resolved later so a workspace selection can still win.
  assert.equal(fresh.model, null);
  assert.equal(state.getOwnerDefaultPermission(), LEVEL.RELAXED);
});

test('model inheritance precedence: channel override > workspace > owner default', (t) => {
  const dir = tmpDir(t);
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const state = new StateStore(path.join(dir, 'state.json'));
  state.setOwnerDefaults({ executorId: 'claude', providerId: 'opencode-go', model: OTHER });
  // A workspace-specific selection exists for ws.
  state.data.workspaces[workspaceKey(ws)] = { providerId: 'opencode-go', executorId: 'claude', model: MODEL };
  state.save();

  const sessions = new SessionManager({
    state,
    permissionManager: { getLevel: () => LEVEL.STANDARD },
    approvalManager: { cancelForSession() {}, clearSessionAllows() {} },
    defaultCwd: ws,
  });
  const candidates = sessions.savedModelCandidatesForCwd(ws);
  assert.equal(candidates[0].model, MODEL, 'the workspace selection outranks the owner default');
  assert.ok(candidates.some((entry) => entry.model === OTHER), 'the owner default is the last-resort candidate');

  // An explicit channel override outranks both.
  state.patchChannel('c-explicit', { providerId: 'opencode-go', executorId: 'claude', model: 'channel-model' }, ws);
  assert.equal(state.getChannel('c-explicit', ws).model, 'channel-model');
  assert.equal(state.getChannel('c-fresh', ws).model, null, 'a fresh scope has no channel model override');
});

test('FULL permission persists after confirmation and is inherited without re-confirmation', async (t) => {
  const dir = tmpDir(t);
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const { fake, plane, state, permissions } = makePlane(stateFile, ws);
  await plane.start();

  await fake.sendAsUser({ content: '!perm full' });
  assert.equal(permissions.getLevel(fake.channelId), LEVEL.STANDARD, 'FULL must not apply before confirmation');
  await fake.clickButton('permfull:confirm');
  assert.equal(permissions.getLevel(fake.channelId), LEVEL.FULL);
  assert.equal(state.getOwnerDefaults().permission, LEVEL.FULL, 'a confirmed FULL is a durable owner default');
  assert.equal(state.getPermissionLevel(fake.channelId), LEVEL.FULL);

  // Restart: a fresh manager seeded from the file gives FULL to a never-seen scope.
  const reloaded = new StateStore(stateFile);
  const freshPermissions = new PermissionManager({
    defaultLevel: reloaded.getOwnerDefaultPermission(),
    initialLevels: reloaded.allPermissionLevels(),
  });
  assert.equal(freshPermissions.getLevel('brand-new-scope'), LEVEL.FULL, 'no repeated confirmation for a trusted scope');
  // Trusted thread inheritance must never overwrite the durable owner default.
  freshPermissions.inheritLevel('child', LEVEL.STANDARD);
  assert.equal(reloaded.getOwnerDefaults().permission, LEVEL.FULL);
});

test('factory reset restores canonical settings and preserves user data', (t) => {
  const dir = tmpDir(t);
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const credentialsFile = path.join(dir, 'credentials.json');
  const providersFile = path.join(dir, 'providers.json');
  const historyFile = path.join(dir, 'chat-history.json');
  const dbFile = path.join(dir, 'jarvis.db');
  fs.writeFileSync(credentialsFile, '{"secret":"PLACEHOLDER"}');
  fs.writeFileSync(providersFile, '{"providers":["opencode-go"]}');
  fs.writeFileSync(historyFile, '{"channels":{"c1":{"messages":[]}}}');
  fs.writeFileSync(dbFile, 'sqlite-bytes');

  const state = new StateStore(stateFile);
  state.setOwnerDefaults({ executorId: 'claude', providerId: 'opencode-go', model: MODEL, chatProviderId: 'opencode-go', chatModel: OTHER, permission: LEVEL.FULL, workspace: ws });
  state.rememberWorkModel({ channelId: 'c1', cwd: ws, providerId: 'opencode-go', executorId: 'claude', model: MODEL });
  state.setPermissionLevel('c1', LEVEL.FULL);
  state.patchChannel('c1', { mode: 'work', workThread: true, parentChannelId: 'p1', sessionId: 's1' }, ws);

  const reset = state.resetOwnerSettings();
  assert.equal(reset.executorId, 'workbuddy');
  assert.equal(reset.providerId, 'workbuddy-free');
  assert.equal(reset.model, null);
  assert.equal(reset.chatProviderId, 'auto');
  assert.equal(reset.chatModel, null);
  assert.equal(reset.permission, LEVEL.STANDARD);
  assert.equal(reset.workspace, null);

  assert.equal(state.getLastWorkModel(), null);
  assert.deepEqual(state.allPermissionLevels(), {});
  assert.equal(state.savedWorkspaceModelCount(), 0);

  const channel = state.getChannel('c1', 'C:/fallback');
  assert.equal(channel.mode, 'work', 'mode is not a routing setting');
  assert.equal(channel.workThread, true);
  assert.equal(channel.parentChannelId, 'p1');
  assert.equal(channel.sessionId, 's1', 'session bookkeeping is not a routing setting');
  assert.equal(channel.providerId, 'workbuddy-free');
  assert.equal(channel.model, null);
  assert.equal(channel.cwd, 'C:/fallback');

  // Data that initialization must not touch.
  assert.equal(fs.readFileSync(credentialsFile, 'utf8'), '{"secret":"PLACEHOLDER"}');
  assert.equal(fs.readFileSync(providersFile, 'utf8'), '{"providers":["opencode-go"]}');
  assert.equal(fs.readFileSync(historyFile, 'utf8'), '{"channels":{"c1":{"messages":[]}}}');
  assert.equal(fs.readFileSync(dbFile, 'utf8'), 'sqlite-bytes');
});

test('the reset button requires confirmation; cancel changes nothing', async (t) => {
  const dir = tmpDir(t);
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const { fake, plane, state } = makePlane(stateFile, ws, {
    ownerDefaults: { executorId: 'claude', providerId: 'opencode-go', model: MODEL, permission: LEVEL.FULL },
  });
  await plane.start();

  await fake.sendAsUser({ content: '!settings' });
  assert.ok(fake.messages.at(-1).buttonIds.includes('set:reset'), 'the Settings screen exposes 初始化设置');

  await fake.clickButton('set:reset');
  assert.match(fake.messages.at(-1).content, /初始化设置/);
  assert.match(fake.messages.at(-1).content, /确认初始化/);
  // Showing the confirmation must not mutate anything.
  assert.equal(state.getOwnerDefaults().providerId, 'opencode-go');
  assert.equal(state.getOwnerDefaults().permission, LEVEL.FULL);

  await fake.clickButton('setreset:cancel');
  assert.equal(state.getOwnerDefaults().providerId, 'opencode-go', 'cancel leaves settings unchanged');
  assert.equal(state.getOwnerDefaults().permission, LEVEL.FULL);

  // A second visit plus explicit confirmation performs the reset.
  await fake.sendAsUser({ content: '!settings' });
  await fake.clickButton('set:reset');
  await fake.clickButton('setreset:confirm');
  const owner = state.getOwnerDefaults();
  assert.equal(owner.providerId, 'workbuddy-free');
  assert.equal(owner.executorId, 'workbuddy');
  assert.equal(owner.model, null);
  assert.equal(owner.permission, LEVEL.STANDARD);
  assert.equal(plane.permissionManager.getLevel(fake.channelId), LEVEL.STANDARD);
  assert.equal(plane.sessionManager.get(fake.channelId).providerId, 'workbuddy-free');

  // The reset state is durable, not just in memory.
  const reloaded = new StateStore(stateFile).getOwnerDefaults();
  assert.equal(reloaded.providerId, 'workbuddy-free');
  assert.equal(reloaded.permission, LEVEL.STANDARD);
});

test('initialization is refused while a Work task is active and never kills it', async (t) => {
  const dir = tmpDir(t);
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const { fake, plane, state, gate } = makePlane(stateFile, ws, {
    hold: true,
    ownerDefaults: { executorId: 'claude', providerId: 'opencode-go', model: MODEL, permission: LEVEL.FULL },
  });
  await plane.start();

  const task = fake.sendAsUser({ content: 'work long safe task' });
  await tick(30);
  assert.equal(plane.scheduler.stateFor(fake.channelId).state, 'running');

  await fake.sendAsUser({ content: '!settings' });
  await fake.clickButton('set:reset');
  await fake.clickButton('setreset:confirm');

  assert.ok(fake.texts().some((text) => /初始化被拒绝/.test(text)), 'the reset must be refused cleanly');
  assert.equal(state.getOwnerDefaults().providerId, 'opencode-go', 'settings remain unchanged');
  assert.equal(state.getOwnerDefaults().permission, LEVEL.FULL);
  assert.equal(plane.scheduler.stateFor(fake.channelId).state, 'running', 'the running task is not killed');

  gate.resolve();
  await task;
});

test('a new Work thread inherits the durable owner route before its first turn', async (t) => {
  const dir = tmpDir(t);
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const { fake, plane, state } = makePlane(stateFile, ws, {
    threadCapable: true,
    ownerDefaults: { executorId: 'claude', providerId: 'opencode-go', model: MODEL, permission: LEVEL.RELAXED },
  });
  await plane.start();

  await fake.sendAsUser({ content: 'work safe inherited task', guildId: 'guild-1' });
  const thread = fake.threadFor(fake.channelId);
  assert.ok(thread, 'a Work thread must be created');

  const channel = state.getChannel(thread.id, ws);
  assert.equal(channel.executorId, 'claude');
  assert.equal(channel.providerId, 'opencode-go');
  assert.equal(plane.permissionManager.getLevel(thread.id), LEVEL.RELAXED);

  const effective = plane.effectiveRuntimeState({ channelId: thread.id });
  assert.equal(effective.provider?.id, 'opencode-go');
  assert.equal(effective.model, MODEL, 'the first Work turn uses the inherited model');
});

test('a reloaded bridge uses the persisted owner defaults for a new scope', async (t) => {
  const dir = tmpDir(t);
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const stateFile = path.join(dir, 'state.json');

  const first = makePlane(stateFile, ws);
  await first.plane.start();
  await first.fake.sendAsUser({ content: '!executor claude' });
  await first.fake.sendAsUser({ content: '!provider opencode-go' });
  await first.fake.sendAsUser({ content: '!model ' + MODEL });

  // A brand-new process over the same file, no reconfiguration.
  const second = makePlane(stateFile, ws);
  await second.plane.start();
  const effective = second.plane.effectiveRuntimeState({ channelId: 'fresh-scope' });
  assert.equal(effective.executor?.id, 'claude');
  assert.equal(effective.provider?.id, 'opencode-go');
  assert.equal(effective.model, MODEL);
});
