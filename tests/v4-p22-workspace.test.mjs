import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiscordControlPlane } from '../src/discord-ui.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager } from '../src/permission-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { RunLogger } from '../src/logger.mjs';
import { DurableStore } from '../src/durable-store.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';

const MODEL = 'deepseek-v4.1-flash';
const PROVIDER = {
  id: 'opencode-go', displayName: 'OpenCode Go', protocol: 'opencode-go',
  baseUrl: 'https://opencode.ai/zen/go', billingType: 'SUBSCRIPTION', credentialRef: 'provider:opencode-go',
  models: [{ id: MODEL, transport: 'openai-chat' }],
};

function makePlane(stateFile, { repoRoot, defaultWorkspace, durableStore = null, channelCwd = null } = {}) {
  const fake = new FakeDiscord();
  const state = new StateStore(stateFile);
  const launched = [];
  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: defaultWorkspace ?? repoRoot, claudeCommand: 'claude',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 1000,
      allowPaidFallback: false, taskTimeoutMs: 5000, maxWorkFollowUps: 10,
      defaultWorkspace: defaultWorkspace ?? null, repoRoot: repoRoot ?? null, autoRegisterCommands: false,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 500 }),
    permissionManager: new PermissionManager(),
    providerManager: { list: () => [PROVIDER], get: (id) => (id === PROVIDER.id ? PROVIDER : null), hasCredential: () => true },
    credentialStore: { get: () => 'key', set: () => {}, remove: () => {} },
    executorManager: {
      list: () => [], get: (id) => ({ id, displayName: 'Claude Code', available: true, adapterReady: true }),
      compatible: () => true, compatibleExecutors: () => [], resolveTransport: () => 'openai-chat', adapterLabel: () => null,
      createRunner: async ({ model, cwd }) => {
        launched.push({ model, cwd });
        return {
          sessionId: 's1', model, busy: false, sent: [], idleMs: 0,
          async send() { return { text: 'ok', sessionId: 's1', durationMs: 1, tools: [], isError: false, costUsd: 0 }; },
          async stop() {},
        };
      },
    },
    modelManager: { list: async () => ({ models: PROVIDER.models }), select: async () => {} },
    chatRuntime: { send: async () => ({ text: 'x' }) },
    logger: new RunLogger(path.join(path.dirname(stateFile), 'logs')),
    backendState: { backend: { label: 'x', model: MODEL } },
    durableStore,
    client: fake.client,
    autoLogin: false,
  });
  plane.state.patchChannel(fake.channelId, { mode: 'work', cwd: channelCwd ?? defaultWorkspace ?? repoRoot, executorId: 'claude', providerId: 'opencode-go' }, defaultWorkspace ?? repoRoot);
  return { fake, plane, state, launched };
}

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ws-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a previous run in another directory never becomes the workspace', (t) => {
  const dir = tmp(t);
  const repo = path.join(dir, 'repo');
  const temp = path.join(dir, 'temp-run');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(temp, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const dbFile = path.join(dir, 'jarvis.db');
  const store = new DurableStore({ file: dbFile, logger: null });
  store.open();
  // A past run executed in a temporary folder.
  store.runStart({ runId: 'r1', channelId: 'c9', workspace: temp, model: MODEL, providerId: 'opencode-go' });
  store.runFinish('r1', { state: 'DONE' });

  const { plane } = makePlane(stateFile, { repoRoot: repo, defaultWorkspace: repo, durableStore: store });
  const state = plane.effectiveRuntimeState({});
  assert.equal(state.workspace, repo, 'the workspace must come from config/repo, not the old run directory');
  assert.equal(state.workspaceSource, 'config');
  store.close();
});

test('workspace priority: saved user selection beats the config default', (t) => {
  const dir = tmp(t);
  const repo = path.join(dir, 'repo');
  const chosen = path.join(dir, 'chosen');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(chosen, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const { plane, state } = makePlane(stateFile, { repoRoot: repo, defaultWorkspace: repo });
  assert.equal(plane.effectiveRuntimeState({}).workspaceSource, 'config');

  state.setGlobalWorkspace(chosen);
  const effective = plane.effectiveRuntimeState({});
  assert.equal(effective.workspace, chosen);
  assert.equal(effective.workspaceSource, 'saved');
});

test('a channel with its own cwd wins over the global selection', (t) => {
  const dir = tmp(t);
  const repo = path.join(dir, 'repo');
  const chosen = path.join(dir, 'chosen');
  const channelDir = path.join(dir, 'channel');
  for (const p of [repo, chosen, channelDir]) fs.mkdirSync(p, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const { fake, plane, state } = makePlane(stateFile, { repoRoot: repo, defaultWorkspace: repo, channelCwd: channelDir });
  state.setGlobalWorkspace(chosen);
  const effective = plane.effectiveRuntimeState({ channelId: fake.channelId });
  assert.equal(effective.workspace, channelDir);
  assert.equal(effective.workspaceSource, 'channel');
});

test('repo root is the last-resort fallback when nothing is configured', (t) => {
  const dir = tmp(t);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const { plane } = makePlane(stateFile, { repoRoot: repo, defaultWorkspace: null });
  const effective = plane.effectiveRuntimeState({});
  assert.equal(effective.workspace, repo);
  assert.equal(effective.workspaceSource, 'repo-fallback');
});

test('!workspace shows, sets (validated) and persists the directory', async (t) => {
  const dir = tmp(t);
  const repo = path.join(dir, 'repo');
  const target = path.join(dir, 'target');
  const file = path.join(dir, 'afile.txt');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(file, 'x');
  const stateFile = path.join(dir, 'state.json');
  const { fake, plane, state, launched } = makePlane(stateFile, { repoRoot: repo, defaultWorkspace: repo });
  await plane.start();

  await fake.sendAsUser({ content: '!workspace' });
  let reply = fake.messagesIn(fake.channelId).at(-1).content;
  assert.match(reply, new RegExp(`当前工作目录：\`${repo.replace(/\\/g, '\\\\')}\``));
  assert.match(reply, /来源：channel/, 'the channel view reports the directory a task would actually use');
  assert.match(reply, /持久化：no/);

  await fake.sendAsUser({ content: `!workspace ${target}` });
  reply = fake.messagesIn(fake.channelId).at(-1).content;
  assert.match(reply, /已切换并持久化工作目录/);
  assert.equal(state.getGlobalWorkspace().path, target, 'the selection must be persisted');
  assert.equal(plane.sessionManager.get(fake.channelId).cwd, target, 'the channel must switch immediately');

  // A real task now runs in the selected directory.
  state.rememberWorkModel({ channelId: fake.channelId, cwd: target, providerId: 'opencode-go', executorId: 'claude', model: MODEL });
  await plane.getRunner(fake.channelId);
  assert.equal(launched.at(-1).cwd, target);

  await fake.sendAsUser({ content: '!workspace' });
  reply = fake.messagesIn(fake.channelId).at(-1).content;
  assert.match(reply, /来源：channel/);
  assert.match(reply, /持久化：yes/);
});

test('!workspace rejects missing paths, files and relative paths without changing state', async (t) => {
  const dir = tmp(t);
  const repo = path.join(dir, 'repo');
  const file = path.join(dir, 'afile.txt');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(file, 'x');
  const stateFile = path.join(dir, 'state.json');
  const { fake, plane, state } = makePlane(stateFile, { repoRoot: repo, defaultWorkspace: repo });
  await plane.start();

  for (const [arg, pattern] of [
    ['X:\\definitely-not-exist', /工作目录不存在/],
    [file, /不是目录/],
    ['relative\\dir', /绝对路径/],
  ]) {
    await fake.sendAsUser({ content: `!workspace ${arg}` });
    const reply = fake.messagesIn(fake.channelId).at(-1).content;
    assert.match(reply, pattern);
    assert.equal(state.getGlobalWorkspace(), null, 'a rejected path must not be persisted');
    assert.equal(plane.sessionManager.get(fake.channelId).cwd, repo, 'a rejected path must not change the workspace');
  }
});

test('!workspace reset clears the selection and restores the default', async (t) => {
  const dir = tmp(t);
  const repo = path.join(dir, 'repo');
  const target = path.join(dir, 'target');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const { fake, plane, state } = makePlane(stateFile, { repoRoot: repo, defaultWorkspace: repo });
  await plane.start();
  await fake.sendAsUser({ content: `!workspace ${target}` });
  assert.equal(state.getGlobalWorkspace().path, target);

  await fake.sendAsUser({ content: '!workspace reset' });
  const reply = fake.messagesIn(fake.channelId).at(-1).content;
  assert.match(reply, /已恢复默认工作目录/);
  assert.equal(state.getGlobalWorkspace(), null);
  assert.equal(plane.sessionManager.get(fake.channelId).cwd, repo);
  assert.equal(plane.effectiveRuntimeState({}).workspaceSource, 'config');
});

test('a new process restores the explicitly selected workspace', async (t) => {
  const dir = tmp(t);
  const repo = path.join(dir, 'repo');
  const target = path.join(dir, 'target');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  const stateFile = path.join(dir, 'state.json');

  const first = makePlane(stateFile, { repoRoot: repo, defaultWorkspace: repo });
  await first.plane.start();
  await first.fake.sendAsUser({ content: `!workspace ${target}` });

  // "Restart": a new StateStore + plane over the same file.
  const second = makePlane(stateFile, { repoRoot: repo, defaultWorkspace: repo });
  const effective = second.plane.effectiveRuntimeState({});
  assert.equal(effective.workspace, target, 'the selection must survive a restart');
  assert.equal(effective.workspaceSource, 'saved');
});

test('a temporary run directory does not rewrite the saved workspace', async (t) => {
  const dir = tmp(t);
  const repo = path.join(dir, 'repo');
  const saved = path.join(dir, 'saved');
  const temp = path.join(dir, 'temp');
  for (const p of [repo, saved, temp]) fs.mkdirSync(p, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const dbFile = path.join(dir, 'jarvis.db');
  const store = new DurableStore({ file: dbFile, logger: null });
  store.open();
  const { plane, state } = makePlane(stateFile, { repoRoot: repo, defaultWorkspace: repo, durableStore: store });
  state.setGlobalWorkspace(saved);

  // A task runs in a temporary directory (recorded for audit only).
  store.runStart({ runId: 'temp-run', channelId: 'c1', workspace: temp, model: MODEL, providerId: 'opencode-go' });
  store.runFinish('temp-run', { state: 'DONE' });

  assert.equal(store.latestRun().workspace, temp, 'the run itself is audited');
  assert.equal(state.getGlobalWorkspace().path, saved, 'the persistent workspace must be untouched');
  assert.equal(plane.effectiveRuntimeState({}).workspace, saved, 'and the effective workspace must not move');
  store.close();
});
