import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiscordControlPlane } from '../src/discord-ui.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager } from '../src/permission-manager.mjs';
import { StateStore, workspaceKey } from '../src/state.mjs';
import { RunLogger } from '../src/logger.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';

const MODEL = 'deepseek-v4.1-flash';
const OTHER = 'glm-5.3-flash';
const PROVIDER = {
  id: 'opencode-go', displayName: 'OpenCode Go', protocol: 'opencode-go',
  baseUrl: 'https://opencode.ai/zen/go', billingType: 'SUBSCRIPTION', credentialRef: 'provider:opencode-go',
  models: [{ id: MODEL, transport: 'openai-chat' }, { id: OTHER, transport: 'openai-chat' }],
};

/**
 * A control plane over a REAL state file. `createRunner` records the model it was
 * asked to launch, which is exactly what the bug was about.
 */
function makePlane(stateFile, cwd, { models = PROVIDER.models } = {}) {
  const fake = new FakeDiscord();
  const state = new StateStore(stateFile);
  const provider = { ...PROVIDER, models };
  const launched = [];
  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: cwd, claudeCommand: 'claude',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 1000,
      allowPaidFallback: false, taskTimeoutMs: 5000, maxWorkFollowUps: 10,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 500 }),
    permissionManager: new PermissionManager(),
    providerManager: { list: () => [provider], get: (id) => (id === provider.id ? provider : null), hasCredential: () => true },
    credentialStore: { get: () => 'key', set: () => {}, remove: () => {} },
    executorManager: {
      list: () => [], get: () => null,
      compatible: () => true, compatibleExecutors: () => [], resolveTransport: () => 'openai-chat', adapterLabel: () => null,
      createRunner: async ({ model }) => {
        launched.push(model);
        return {
          sessionId: 'sess-1', model, busy: false, sent: [], idleMs: 0,
          async send(prompt) {
            this.busy = true;
            plane.onRunnerEvent(fake.channelId, { type: 'session', sessionId: this.sessionId });
            this.busy = false;
            return { text: `done:${prompt}`, sessionId: this.sessionId, durationMs: 1, tools: [], isError: false, costUsd: 0 };
          },
          async stop() { this.busy = false; },
        };
      },
    },
    modelManager: { list: async () => ({ models }), select: async () => {} },
    chatRuntime: { send: async () => ({ text: 'x' }) },
    logger: new RunLogger(path.join(path.dirname(stateFile), 'logs')),
    backendState: { backend: { label: 'OpenCode Go', model: MODEL }, allowPaidFallback: false },
    client: fake.client,
    autoLogin: false,
  });
  return { fake, plane, state, launched };
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-model-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setupChannel(plane, fake, cwd, patch = {}) {
  plane.state.patchChannel(fake.channelId, {
    mode: 'work', cwd, executorId: 'claude', providerId: 'opencode-go', ...patch,
  }, cwd);
}

test('selecting a model persists it at channel, workspace and last-known scope', async (t) => {
  const dir = tmpDir(t);
  const ws = path.join(dir, 'proj');
  fs.mkdirSync(ws, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const { fake, plane, state } = makePlane(stateFile, ws);
  setupChannel(plane, fake, ws);
  await plane.start();
  await fake.sendAsUser({ content: '!model ' + MODEL });

  assert.equal(state.getChannel(fake.channelId, ws).model, MODEL);
  assert.equal(state.getWorkspaceModel(ws).model, MODEL, 'the workspace must remember the model');
  assert.equal(state.getLastWorkModel().model, MODEL, 'the last selection must be remembered');
  // The on-disk file must contain it (not just memory).
  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(raw.workspaces[workspaceKey(ws)].model, MODEL);
  assert.equal(raw.preferences.lastWorkModel.model, MODEL);
});

test('a fresh process restores the selected model and launches the Agent with it (no !model)', async (t) => {
  const dir = tmpDir(t);
  const ws = path.join(dir, 'proj');
  fs.mkdirSync(ws, { recursive: true });
  const stateFile = path.join(dir, 'state.json');

  // Turn 1: the owner selects a model, then the process "restarts".
  const first = makePlane(stateFile, ws);
  setupChannel(first.plane, first.fake, ws);
  await first.plane.start();
  await first.fake.sendAsUser({ content: '!model ' + MODEL });

  // Turn 2: a brand-new StateStore + control plane over the same file. No !model.
  const second = makePlane(stateFile, ws);
  setupChannel(second.plane, second.fake, ws);
  await second.plane.start();
  const runner = await second.plane.getRunner(second.fake.channelId);
  assert.equal(runner.model, MODEL, 'the restored model must be used to launch the Agent');
  assert.deepEqual(second.launched, [MODEL]);
});

test('a brand-new Work thread in the same workspace restores the model (per-channel state is ephemeral)', async (t) => {
  const dir = tmpDir(t);
  const ws = path.join(dir, 'proj');
  fs.mkdirSync(ws, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const { fake, plane, state } = makePlane(stateFile, ws, { models: [] }); // provider model list unknown
  setupChannel(plane, fake, ws);
  state.rememberWorkModel({ channelId: fake.channelId, cwd: ws, providerId: 'opencode-go', executorId: 'claude', model: MODEL });

  // A NEW Discord thread id that has never been configured.
  fake.addChannel({ id: 'new-thread-1' });
  state.patchChannel('new-thread-1', { mode: 'work', cwd: ws, executorId: 'claude', providerId: 'opencode-go', workThread: true }, ws);

  const runner = await plane.getRunner('new-thread-1');
  assert.equal(runner.model, MODEL);
});

test('switching the model persists the new one across a restart (not the old one)', async (t) => {
  const dir = tmpDir(t);
  const ws = path.join(dir, 'proj');
  fs.mkdirSync(ws, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const first = makePlane(stateFile, ws);
  setupChannel(first.plane, first.fake, ws);
  await first.plane.start();
  await first.fake.sendAsUser({ content: '!model ' + MODEL });
  await first.fake.sendAsUser({ content: '!model ' + OTHER });

  const second = makePlane(stateFile, ws);
  setupChannel(second.plane, second.fake, ws);
  await second.plane.start();
  const runner = await second.plane.getRunner(second.fake.channelId);
  assert.equal(runner.model, OTHER, 'the latest selection must win after restart');
});

test('a saved model the provider no longer offers fails loudly and never silently switches', async (t) => {
  const dir = tmpDir(t);
  const ws = path.join(dir, 'proj');
  fs.mkdirSync(ws, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const { fake, plane, state } = makePlane(stateFile, ws, { models: [{ id: OTHER, transport: 'openai-chat' }] });
  setupChannel(plane, fake, ws);
  // Persist a model that is NOT in the provider's current list.
  state.rememberWorkModel({ channelId: fake.channelId, cwd: ws, providerId: 'opencode-go', executorId: 'claude', model: MODEL });

  await assert.rejects(
    () => plane.getRunner(fake.channelId),
    (error) => {
      assert.equal(error.code, 'MODEL_UNAVAILABLE');
      assert.match(error.message, /已保存模型 .* 当前不可用，请重新使用 !model 选择模型。/);
      return true;
    },
  );
});

test('a saved model for a DIFFERENT provider is not applied to the current route', async (t) => {
  const dir = tmpDir(t);
  const ws = path.join(dir, 'proj');
  fs.mkdirSync(ws, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const { fake, plane, state } = makePlane(stateFile, ws);
  setupChannel(plane, fake, ws);
  state.rememberWorkModel({ channelId: null, cwd: ws, providerId: 'some-other-provider', executorId: 'claude', model: MODEL });

  // WorkBuddy is the only provider with an intrinsic fallback in this setup;
  // with opencode-go and no channel model the bridge must ask for a selection
  // rather than borrow another provider's model.
  await assert.rejects(() => plane.getRunner(fake.channelId), (error) => error.code === 'MODEL_REQUIRED');
});

test('a never-configured workspace can use an explicit configured default model', async (t) => {
  const dir = tmpDir(t);
  const ws = path.join(dir, 'proj');
  fs.mkdirSync(ws, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const { fake, plane } = makePlane(stateFile, ws, { models: [{ id: OTHER, transport: 'openai-chat' }] });
  // Inject the configured default (normally from DEFAULT_WORK_MODEL).
  plane.config.defaultWorkModel = OTHER;
  setupChannel(plane, fake, ws);
  const runner = await plane.getRunner(fake.channelId);
  assert.equal(runner.model, OTHER);
});

test('state backfill derives workspace + last model from an existing state file (upgrade path)', (t) => {
  const dir = tmpDir(t);
  const ws = path.join(dir, 'proj');
  fs.mkdirSync(ws, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    channels: {
      'chan-old': { mode: 'work', cwd: ws, executorId: 'claude', providerId: 'opencode-go', model: MODEL, sessionId: null },
    },
  }, null, 2));

  const state = new StateStore(stateFile);
  assert.equal(state.getWorkspaceModel(ws).model, MODEL, 'existing selections must be upgraded into workspace scope');
  assert.equal(state.getLastWorkModel().model, MODEL);
  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(raw.workspaces[workspaceKey(ws)].model, MODEL);
});

test('workspace scope is per cwd: another project does not inherit a different workspace model', async (t) => {
  const dir = tmpDir(t);
  const wsA = path.join(dir, 'a');
  const wsB = path.join(dir, 'b');
  fs.mkdirSync(wsA, { recursive: true });
  fs.mkdirSync(wsB, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const { fake, plane, state } = makePlane(stateFile, wsA);
  setupChannel(plane, fake, wsA);
  state.rememberWorkModel({ channelId: fake.channelId, cwd: wsA, providerId: 'opencode-go', executorId: 'claude', model: MODEL });

  // Workspace B was never configured for this workspace, but the last-known
  // selection is valid for the provider, so it is restored (owner intent).
  fake.addChannel({ id: 'chan-b' });
  state.patchChannel('chan-b', { mode: 'work', cwd: wsB, executorId: 'claude', providerId: 'opencode-go' }, wsB);
  const runner = await plane.getRunner('chan-b');
  assert.equal(runner.model, MODEL);
  assert.equal(state.getWorkspaceModel(wsA).model, MODEL);
  assert.equal(state.getWorkspaceModel(wsB), null, 'workspace B itself must stay unconfigured');
});
