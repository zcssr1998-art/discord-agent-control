import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

import { DiscordControlPlane } from '../src/discord-ui.mjs';
import { ChatRuntime } from '../src/chat-runtime.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager } from '../src/permission-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { RunLogger } from '../src/logger.mjs';
import { PROTOCOL, TRANSPORT } from '../src/provider-manager.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';
import { COMMAND_NAMES, buildCommandPayloads, syncApplicationCommands } from '../src/commands.mjs';

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await tick(stepMs);
  }
  return condition();
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}
function bytesResponse(bytes, contentType = 'text/plain') {
  return {
    ok: true,
    status: 200,
    headers: { get: (n) => (n.toLowerCase() === 'content-length' ? String(bytes.length) : n.toLowerCase() === 'content-type' ? contentType : null) },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    async json() { return {}; },
  };
}

const OPENCODE_GO = {
  id: 'opencode-go', displayName: 'OpenCode Go', protocol: PROTOCOL.OPENCODE_GO,
  baseUrl: 'https://opencode.ai/zen/go', billingType: 'SUBSCRIPTION', credentialRef: 'provider:opencode-go',
  models: [{ id: 'deepseek-v4.1-flash', transport: TRANSPORT.OPENAI_CHAT }],
};
const PROVIDERS = [
  { id: 'workbuddy-free', displayName: 'WorkBuddy Free', protocol: 'workbuddy', billingType: 'FREE', models: [] },
  OPENCODE_GO,
];
function fakeProviders() {
  return {
    list: () => PROVIDERS,
    get: (id) => PROVIDERS.find((item) => item.id === id) || null,
    hasCredential: () => true,
    listModels: async (id) => ({ models: PROVIDERS.find((item) => item.id === id)?.models || [] }),
  };
}

function makeWorkPlane({
  threadCapable = false, hold = true, maxFollowUps = 10, parentChat = false, attachmentFetch = null,
} = {}) {
  const fake = new FakeDiscord({ threadCapable });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p21-'));
  const state = new StateStore(path.join(dir, 'state.json'));
  const executionCwd = path.join(dir, 'ws');
  fs.mkdirSync(executionCwd, { recursive: true });
  state.patchChannel(fake.channelId, {
    mode: parentChat ? 'chat' : 'work', cwd: executionCwd, executorId: 'claude', providerId: 'opencode-go', model: 'deepseek-v4.1-flash',
  }, executionCwd);

  const providers = fakeProviders();
  const chatCalls = [];
  const chatRuntime = new ChatRuntime({
    providerManager: providers,
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async (url, options) => { chatCalls.push(JSON.parse(options.body)); return jsonResponse(200, { choices: [{ message: { content: 'chat answer' } }] }); },
    timeoutMs: 5000,
  });
  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: executionCwd, claudeCommand: 'claude',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 100000,
      allowPaidFallback: false, taskTimeoutMs: 5000, maxWorkFollowUps: maxFollowUps, autoRegisterCommands: false,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 }),
    permissionManager: new PermissionManager(),
    providerManager: providers,
    chatRuntime,
    logger: new RunLogger(path.join(dir, 'logs')),
    backendState: { backend: { label: 'opencode-go', model: 'deepseek-v4.1-flash' }, allowPaidFallback: false },
    client: fake.client,
    autoLogin: false,
  });
  plane.attachmentInbox = path.join(dir, 'inbox');
  if (attachmentFetch) plane.attachmentFetch = attachmentFetch;

  const runners = new Map();
  const pending = new Map();
  plane.getRunner = async (channelId) => {
    let runner = runners.get(channelId);
    if (!runner) {
      runner = {
        sessionId: `sess-${channelId}`, model: 'deepseek-v4.1-flash', busy: false, sent: [], stopped: false, idleMs: 0,
        async send(prompt) {
          this.busy = true;
          this.sent.push(prompt);
          plane.onRunnerEvent(channelId, { type: 'session', sessionId: this.sessionId });
          if (hold) await new Promise((resolve) => { pending.set(channelId, resolve); });
          this.busy = false;
          return { text: `done:${prompt}`, sessionId: this.sessionId, durationMs: 1, tools: [], isError: false, costUsd: 0 };
        },
        async stop() { this.stopped = true; this.busy = false; this.release(); },
        release() { const resolve = pending.get(channelId); if (resolve) { pending.delete(channelId); resolve(); } },
      };
      runners.set(channelId, runner);
      // Mirror the real getRunner, which registers the live runner so the
      // shared stop path can kill it.
      plane.runners.set(channelId, runner);
    }
    return runner;
  };
  return { fake, plane, dir, executionCwd, runners, chatCalls, release: (id) => runners.get(id)?.release() };
}

const cardMessage = (fake, channelId = fake.channelId, action = 'append') => {
  const prefix = `workctl:${action}:`;
  return [...fake.messagesIn(channelId)].reverse().find((m) => m.buttonIds.some((id) => id.startsWith(prefix)));
};
const runIdFromCard = (msg) => {
  const id = msg.buttonIds.find((v) => v.startsWith('workctl:append:')) || msg.buttonIds.find((v) => v.startsWith('workctl:'));
  return id.split(':')[2];
};

// ---------------------------------------------------------------- commands

test('native command definitions include every P2.1 command and embed no IDs', () => {
  const payloads = buildCommandPayloads();
  assert.deepEqual(payloads.map((c) => c.name), [...COMMAND_NAMES]);
  for (const name of ['panel', 'work', 'model', 'settings', 'permission', 'status', 'stop', 'new', 'compact', 'help']) {
    assert.ok(payloads.some((c) => c.name === name), `missing /${name}`);
  }
  const serialized = JSON.stringify(payloads);
  assert.ok(!/91\d{16,}/.test(serialized), 'no hard-coded Discord snowflake (owner/guild) may appear');
});

test('application-command registration is idempotent', async () => {
  const calls = [];
  let stored = [];
  const application = {
    commands: {
      fetch: async () => stored,
      set: async (defs) => { calls.push(defs); stored = defs; return defs; },
    },
  };
  const first = await syncApplicationCommands({ application });
  assert.equal(first.changed, COMMAND_NAMES.length);
  assert.equal(calls.length, 1);

  const second = await syncApplicationCommands({ application });
  assert.equal(second.changed, 0, 'a second sync must be a no-op');
  assert.equal(calls.length, 1, 'no redundant REST write');
});

test('/panel /model /settings /permission /status /help use local renderers and never touch Agent/Chat', async () => {
  const { fake, plane, runners, chatCalls } = makeWorkPlane();
  await plane.start();

  const panel = await fake.command('panel');
  assert.match(panel.replied.content, /Jarvis Control Panel/);
  assert.ok(panel.replied.components?.length, 'the panel reply carries buttons');

  const model = await fake.command('model');
  assert.ok(model.replied.components.some((row) => row.components.some((b) => b.data.custom_id === 'panelmodels:chat')));

  const settings = await fake.command('settings');
  assert.match(settings.replied.content, /Jarvis Settings/);

  const permission = await fake.command('permission');
  assert.match(permission.replied.content, /当前权限/);

  const status = await fake.command('status');
  assert.match(status.replied.content, /Jarvis 状态/);

  const help = await fake.command('help');
  assert.match(help.replied.content, /使用说明/);

  await fake.command('new');
  assert.equal(runners.size, 0, 'no command may start an Agent');
  assert.equal(chatCalls.length, 0, 'no local command may call ChatRuntime');
});

test('/work reuses the New Work thread behavior for a guild parent', async () => {
  const { fake, plane, runners, release } = makeWorkPlane({ threadCapable: true, hold: true, parentChat: true });
  await plane.start();
  const guildParent = fake.channelId;
  const pending = fake.command('work', { options: { task: 'do the thing' }, guildId: 'guild-1' });
  await waitFor(() => fake.threads.length === 1 && runners.has(fake.threads[0].id));
  assert.equal(fake.threads.length, 1, 'exactly one Work thread');
  assert.equal(plane.sessionManager.get(guildParent).mode, 'chat', 'the parent stays Chat');
  assert.deepEqual(runners.get(fake.threads[0].id).sent, ['do the thing']);
  release(fake.threads[0].id);
  await pending.catch(() => {});
  await tick(30);
});

test('/work without a task opens the New Work modal', async () => {
  const { fake, plane } = makeWorkPlane({ hold: false });
  await plane.start();
  await fake.command('work');
  assert.ok(fake.lastModal, 'a modal must be shown');
});

// ------------------------------------------------------- progress-card controls

test('an active Work card exposes 追加需求 + Stop controls; a queued card does too', async () => {
  const { fake, plane, release } = makeWorkPlane();
  await plane.start();
  const pending = fake.sendAsUser({ content: 'active task' });
  await waitFor(() => cardMessage(fake, fake.channelId, 'stop'));
  const card = cardMessage(fake, fake.channelId, 'stop');
  assert.ok(card.buttonIds.some((id) => id.startsWith('workctl:append:')));
  assert.ok(card.buttonIds.some((id) => id.startsWith('workctl:stop:')));
  const cardLabels = card.components.flatMap((row) => row.components.map((b) => b.data.label));
  assert.ok(cardLabels.includes('➕ 追加需求'));
  assert.ok(cardLabels.includes('⛔ Stop'));
  release(fake.channelId);
  await pending;

  // Queued card: hold channel A, queue channel B on the same workspace.
  const q = makeWorkPlane();
  q.fake.addChannel({ id: 'chan-2' });
  q.plane.state.patchChannel('chan-2', { mode: 'work', cwd: q.executionCwd }, q.executionCwd);
  await q.plane.start();
  const a = q.fake.sendAsUser({ content: 'task A', channelId: q.fake.channelId });
  await waitFor(() => q.plane.scheduler.stateFor(q.fake.channelId).state === 'running');
  const b = q.fake.sendAsUser({ content: 'task B', channelId: 'chan-2' });
  await waitFor(() => cardMessage(q.fake, 'chan-2', 'stop'));
  const queuedCard = cardMessage(q.fake, 'chan-2', 'stop');
  assert.ok(queuedCard.buttonIds.some((id) => id.startsWith('workctl:append:')));
  assert.ok(queuedCard.buttonIds.some((id) => id.startsWith('workctl:stop:')));
  q.release(q.fake.channelId);
  await a;
  await waitFor(() => q.plane.scheduler.stateFor('chan-2').state === 'running');
  q.release('chan-2');
  await b;
});

test('card Stop matches !stop for active and queued work and clears follow-ups', async () => {
  // Active + pending follow-ups.
  const { fake, plane, runners, release } = makeWorkPlane();
  await plane.start();
  const task = fake.sendAsUser({ content: 'long task' });
  await waitFor(() => cardMessage(fake, fake.channelId, 'stop'));
  await fake.sendAsUser({ content: 'follow-up one' });
  await fake.sendAsUser({ content: 'follow-up two' });
  assert.equal(plane.workChains.get(fake.channelId).followUps.length, 2);

  const card = cardMessage(fake, fake.channelId, 'stop');
  const stopId = card.buttonIds.find((id) => id.startsWith('workctl:stop:'));
  await fake.clickButton(stopId);
  assert.equal(runners.get(fake.channelId).stopped, true, 'the active agent tree is killed');
  assert.equal(plane.workChains.get(fake.channelId).followUps.length, 0, 'Stop clears pending follow-ups');
  const replies = fake.texts().join('\n');
  assert.match(replies, /已清空 2 条待执行的追加需求/);
  release(fake.channelId);
  await task;
  await tick(40);
  assert.deepEqual(runners.get(fake.channelId).sent, ['long task'], 'no follow-up may start after Stop');

  // Queued.
  const q = makeWorkPlane();
  q.fake.addChannel({ id: 'chan-2' });
  q.plane.state.patchChannel('chan-2', { mode: 'work', cwd: q.executionCwd }, q.executionCwd);
  await q.plane.start();
  const a = q.fake.sendAsUser({ content: 'task A' });
  await waitFor(() => q.plane.scheduler.stateFor(q.fake.channelId).state === 'running');
  const b = q.fake.sendAsUser({ content: 'task B', channelId: 'chan-2' });
  await waitFor(() => cardMessage(q.fake, 'chan-2', 'stop'));
  const queuedStop = cardMessage(q.fake, 'chan-2', 'stop').buttonIds.find((id) => id.startsWith('workctl:stop:'));
  await q.fake.clickButton(queuedStop);
  assert.equal(q.plane.scheduler.stateFor('chan-2').state, 'idle');
  assert.equal(q.plane.scheduler.stateFor(q.fake.channelId).state, 'running', 'the active owner is untouched');
  q.release(q.fake.channelId);
  await a;
  await b;
});

test('a stale card cannot control a newer run', async () => {
  const { fake, plane, runners, release } = makeWorkPlane();
  await plane.start();
  const first = fake.sendAsUser({ content: 'first task' });
  await waitFor(() => cardMessage(fake, fake.channelId, 'stop'));
  const staleRunId = runIdFromCard(cardMessage(fake, fake.channelId, 'stop'));
  release(fake.channelId);
  await first;
  await tick(30);

  const second = fake.sendAsUser({ content: 'second task' });
  await waitFor(() => cardMessage(fake, fake.channelId, 'stop'));
  const liveRunId = runIdFromCard(cardMessage(fake, fake.channelId, 'stop'));
  assert.notEqual(staleRunId, liveRunId);

  // Re-materialise a stale card (as if Discord still showed an old message).
  const stale = await fake.channel.send({
    content: 'stale card',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`workctl:stop:${staleRunId}`).setLabel('⛔ Stop').setStyle(ButtonStyle.Danger),
    )],
  });
  assert.ok(stale);
  const { interaction } = await fake.clickButton(`workctl:stop:${staleRunId}`);
  assert.match(interaction.replied.content, /该任务已结束/);
  assert.equal(runners.get(fake.channelId).stopped, false, 'the newer run must not be stopped by a stale card');
  assert.equal(plane.scheduler.stateFor(fake.channelId).state, 'running');
  release(fake.channelId);
  await second;
});

// --------------------------------------------------------------- follow-ups

test('the append modal queues a follow-up for the same session and drains FIFO', async () => {
  const { fake, plane, runners, release } = makeWorkPlane();
  await plane.start();
  const task = fake.sendAsUser({ content: 'base task' });
  await waitFor(() => cardMessage(fake, fake.channelId, 'stop'));
  const runId = runIdFromCard(cardMessage(fake, fake.channelId, 'stop'));

  await fake.clickButton(`workctl:append:${runId}`);
  assert.ok(fake.lastModal, 'append opens a modal');
  const submit = await fake.submitModal(`workappend:${runId}`, { values: { requirement: '补充 A' } });
  assert.match(submit.replied.content, /已追加/);
  assert.deepEqual(runners.get(fake.channelId).sent, ['base task'], 'appending must not start a concurrent Agent');
  assert.equal(plane.workChains.get(fake.channelId).followUps.length, 1);

  await fake.submitModal(`workappend:${runId}`, { values: { requirement: '补充 B' } });
  assert.equal(plane.workChains.get(fake.channelId).followUps.length, 2);

  release(fake.channelId);
  await waitFor(() => runners.get(fake.channelId).sent.length === 2);
  release(fake.channelId);
  await waitFor(() => runners.get(fake.channelId).sent.length === 3);
  release(fake.channelId);
  await task;
  await waitFor(() => runners.get(fake.channelId).sent.length === 3);

  assert.deepEqual(runners.get(fake.channelId).sent, ['base task', '补充 A', '补充 B']);
  const sessionId = plane.sessionManager.get(fake.channelId).sessionId;
  assert.equal(sessionId, runners.get(fake.channelId).sessionId, 'follow-ups reuse the same Agent session');
});

test('normal text in an active Work context queues through the same backend', async () => {
  const { fake, plane, runners, release } = makeWorkPlane();
  await plane.start();
  const task = fake.sendAsUser({ content: 'base task' });
  await waitFor(() => cardMessage(fake, fake.channelId, 'stop'));
  await fake.sendAsUser({ content: 'do this after' });
  assert.ok(fake.texts().some((t) => /已追加/.test(t)));
  assert.equal(plane.workChains.get(fake.channelId).followUps.length, 1);
  assert.deepEqual(runners.get(fake.channelId).sent, ['base task']);
  release(fake.channelId);
  await waitFor(() => runners.get(fake.channelId).sent.length === 2);
  release(fake.channelId);
  await task;
  assert.deepEqual(runners.get(fake.channelId).sent, ['base task', 'do this after']);
});

test('normal text in the parent Chat stays Chat while a child Work thread is active', async () => {
  const { fake, plane, chatCalls, release } = makeWorkPlane({ threadCapable: true, hold: true, parentChat: true });
  await plane.start();
  const pending = fake.sendAsUser({ content: 'work long child task', guildId: 'guild-1' });
  await waitFor(() => fake.threads.length === 1);
  const parentId = fake.channelId;
  assert.equal(plane.sessionManager.get(parentId).mode, 'chat');

  await fake.sendAsUser({ content: '你好', guildId: 'guild-1' });
  assert.equal(chatCalls.length, 1, 'the parent must answer in Chat, not queue Work');
  assert.equal(plane.workChains.has(parentId), false, 'no Work chain may be created on the parent');

  release(fake.threads[0].id);
  await pending.catch(() => {});
  await tick(30);
});

test('a same-workspace queued channel is not starved by a follow-up loop', async () => {
  const { fake, plane, runners, release } = makeWorkPlane();
  fake.addChannel({ id: 'chan-2' });
  plane.state.patchChannel('chan-2', { mode: 'work', cwd: plane.config.defaultCwd }, plane.config.defaultCwd);
  await plane.start();

  const a = fake.sendAsUser({ content: 'task A', channelId: fake.channelId });
  await waitFor(() => plane.scheduler.stateFor(fake.channelId).state === 'running');
  const b = fake.sendAsUser({ content: 'task B', channelId: 'chan-2' });
  await waitFor(() => plane.scheduler.stateFor('chan-2').state === 'queued');

  await fake.sendAsUser({ content: 'A follow-up', channelId: fake.channelId });
  release(fake.channelId);
  await waitFor(() => plane.scheduler.stateFor('chan-2').state === 'running');
  assert.deepEqual(runners.get(fake.channelId).sent, ['task A'], 'the follow-up waits for the already-queued channel');

  release('chan-2');
  await waitFor(() => runners.get(fake.channelId).sent.length === 2);
  release(fake.channelId);
  await a;
  await b;
  assert.deepEqual(runners.get(fake.channelId).sent, ['task A', 'A follow-up']);
});

test('the follow-up queue cap is enforced', async () => {
  const { fake, plane, release } = makeWorkPlane({ maxFollowUps: 2 });
  await plane.start();
  const task = fake.sendAsUser({ content: 'base' });
  await waitFor(() => cardMessage(fake, fake.channelId, 'stop'));
  await fake.sendAsUser({ content: 'f1' });
  await fake.sendAsUser({ content: 'f2' });
  await fake.sendAsUser({ content: 'f3' });
  assert.equal(plane.workChains.get(fake.channelId).followUps.length, 2);
  assert.ok(fake.texts().some((t) => /追加队列已满/.test(t)));
  await fake.clickButton(cardMessage(fake, fake.channelId, 'stop').buttonIds.find((id) => id.startsWith('workctl:stop:')));
  release(fake.channelId);
  await task;
});

test('a follow-up attachment is downloaded exactly once', async () => {
  let downloads = 0;
  const { fake, plane, runners, release } = makeWorkPlane({
    attachmentFetch: async (url) => {
      if (String(url).startsWith('https://cdn.discordapp.com/')) { downloads += 1; return bytesResponse(Buffer.from('file body'), 'text/plain'); }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  await plane.start();
  const task = fake.sendAsUser({ content: 'base' });
  await waitFor(() => cardMessage(fake, fake.channelId, 'stop'));
  await fake.sendAsUser({
    content: 'process this',
    attachments: [{ name: 'n.txt', url: 'https://cdn.discordapp.com/attachments/1/2/n.txt', size: 9, contentType: 'text/plain' }],
  });
  release(fake.channelId);
  await waitFor(() => runners.get(fake.channelId).sent.length === 2);
  release(fake.channelId);
  await task;
  assert.equal(downloads, 1);
  assert.match(runners.get(fake.channelId).sent[1], /n\.txt/);
  assert.match(runners.get(fake.channelId).sent[1], /inbox/);
  await tick(30);
});
