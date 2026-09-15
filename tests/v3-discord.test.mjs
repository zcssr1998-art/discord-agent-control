import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DiscordControlPlane } from '../src/discord-ui.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager } from '../src/permission-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { CredentialStore } from '../src/credential-store.mjs';
import { ProviderManager } from '../src/provider-manager.mjs';
import { ModelManager } from '../src/model-manager.mjs';
import { ExecutorManager } from '../src/executor-manager.mjs';
import { RunLogger } from '../src/logger.mjs';

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

class FakeExecutorRunner {
  constructor(options) {
    Object.assign(this, options);
    this.busy = false;
    this.idleMs = 0;
  }
  async send() {
    this.busy = true;
    this.sessionId ||= 'v3-session';
    this.onEvent({ type: 'session', sessionId: this.sessionId });
    this.onEvent({ type: 'init', model: this.model, apiKeySource: 'custom-api', tools: ['Write'] });
    this.onEvent({ type: 'tool', tool: { name: 'Write', input: { file_path: 'v3-proof.txt' } } });
    fs.writeFileSync(path.join(this.cwd, 'v3-proof.txt'), 'V3_OK');
    this.busy = false;
    return { text: '完成', sessionId: this.sessionId, durationMs: 1, tools: [{ name: 'Write' }], isError: false, costUsd: 0 };
  }
  async stop() { this.busy = false; return { killed: false, pid: null }; }
}

test('Discord OWNER can add an API without leaking its key, then select and run it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dac-discord-v3-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = new FakeDiscord();
  const state = new StateStore(path.join(dir, 'state.json'));
  const credentials = new CredentialStore(path.join(dir, 'credentials.json'));
  const secret = 'sk-discord-onboarding-7F2A';
  const providers = new ProviderManager({
    file: path.join(dir, 'providers.json'), credentialStore: credentials, timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      if (options.headers['x-api-key'] === secret && url.endsWith('/v1/models')) {
        return json(200, { data: [{ id: 'model-a' }, { id: 'model-b' }] });
      }
      return json(404, { message: 'not this protocol' });
    },
  });
  providers.noteWorkbuddyModel('fast-model');
  const executors = new ExecutorManager({
    workbuddyCommand: 'workbuddy.js', RunnerClass: FakeExecutorRunner,
    probeVersion: async (command) => ({ 'workbuddy.js': '2.137.1', claude: '2.1.270', codex: '0.154.0' })[command] || null,
  });
  await executors.discover();
  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: dir, claudeCommand: 'workbuddy.js',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1,
      allowPaidFallback: false, agentBackend: 'workbuddy-free-dsf', taskTimeoutMs: 1000, stallNoticeMs: 1000,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 }),
    permissionManager: new PermissionManager(),
    credentialStore: credentials,
    providerManager: providers,
    modelManager: new ModelManager(providers),
    executorManager: executors,
    logger: new RunLogger(path.join(dir, 'logs')),
    client: fake.client,
    autoLogin: false,
  });
  await plane.start();

  await fake.sendAsUser({ content: '!api', authorId: 'intruder' });
  assert.equal(providers.list().filter((provider) => provider.source === 'discord').length, 0, 'non-owner cannot enter API mode');

  await fake.sendAsUser({ content: '!api' });
  const keyMessage = await fake.sendAsUser({ content: `https://anthropic.example.test/v1\n${secret}` });
  assert.equal(keyMessage.deleted, true, 'the key-bearing Discord message is deleted');
  const added = providers.list().find((provider) => provider.source === 'discord');
  assert.ok(added);
  assert.equal(added.protocol, 'anthropic-compatible');
  assert.ok(fake.texts().some((text) => /API 已添加/.test(text)));
  assert.ok(fake.texts().every((text) => !text.includes(secret)), 'bot replies never contain the full key');
  assert.equal(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8').includes(secret), true, 'only CredentialStore holds the key');
  assert.equal(fs.readFileSync(path.join(dir, 'providers.json'), 'utf8').includes(secret), false);

  await fake.sendAsUser({ content: '!executor claude' });
  assert.equal(plane.sessionManager.get(fake.channelId).executorId, 'claude');
  await fake.sendAsUser({ content: `!provider ${added.id}` });
  assert.equal(plane.sessionManager.get(fake.channelId).providerId, added.id);
  await fake.sendAsUser({ content: '!models' });
  assert.ok(fake.texts().some((text) => /model-a/.test(text)));
  await fake.sendAsUser({ content: '!model model-a' });
  assert.equal(plane.sessionManager.get(fake.channelId).model, 'model-a');
  await fake.sendAsUser({ content: '创建验证文件' });
  assert.equal(fs.readFileSync(path.join(dir, 'v3-proof.txt'), 'utf8'), 'V3_OK');
  assert.ok(fake.texts().some((text) => /✅ 已完成/.test(text)));

  await fake.sendAsUser({ content: '!status' });
  const status = fake.messages.at(-1).content;
  assert.match(status, /执行器：Claude Code/);
  assert.match(status, /提供商：自定义 API/);
  assert.match(status, /协议：Anthropic Compatible/);
  assert.match(status, /模型：model-a/);

  for (const file of [path.join(dir, 'providers.json'), path.join(dir, 'state.json'), ...fs.readdirSync(path.join(dir, 'logs')).map((name) => path.join(dir, 'logs', name))]) {
    assert.equal(fs.readFileSync(file, 'utf8').includes(secret), false, `${path.basename(file)} must not contain the key`);
  }
});

test('OWNER can select OpenCode Go, see transports, and only run a transport-compatible model', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dac-discord-og-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = new FakeDiscord();
  const state = new StateStore(path.join(dir, 'state.json'));
  const credentials = new CredentialStore(path.join(dir, 'credentials.json'));
  credentials.set('provider:opencode-go', 'opencode-secret');
  const providers = new ProviderManager({
    file: path.join(dir, 'providers.json'), credentialStore: credentials, timeoutMs: 1000,
    fetchImpl: async (url) => (url === 'https://opencode.ai/zen/go/v1/models'
      ? json(200, { data: [{ id: 'minimax-m3' }, { id: 'glm-5.2' }, { id: 'omen-alpha' }] })
      : json(404, { error: { message: 'not this endpoint' } })),
  });
  const executors = new ExecutorManager({
    workbuddyCommand: 'workbuddy.js', RunnerClass: FakeExecutorRunner,
    probeVersion: async (command) => ({ 'workbuddy.js': '2.137.1', claude: '2.1.270' })[command] || null,
  });
  await executors.discover();
  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: dir, claudeCommand: 'workbuddy.js',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1,
      allowPaidFallback: false, agentBackend: 'workbuddy-free-dsf', taskTimeoutMs: 1000, stallNoticeMs: 1000,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 }),
    permissionManager: new PermissionManager(),
    credentialStore: credentials,
    providerManager: providers,
    modelManager: new ModelManager(providers),
    executorManager: executors,
    client: fake.client,
    autoLogin: false,
  });
  await plane.start();

  await fake.sendAsUser({ content: '!provider opencode-go' });
  assert.match(fake.messages.at(-1).content, /当前执行器不支持此 Provider 协议/);
  await fake.sendAsUser({ content: '!executor claude' });
  await fake.sendAsUser({ content: '!provider opencode-go' });
  assert.equal(plane.sessionManager.get(fake.channelId).providerId, 'opencode-go');
  assert.match(fake.messages.at(-1).content, /OpenCode Go/);

  await fake.sendAsUser({ content: '!models' });
  const modelsText = fake.messages.at(-1).content;
  assert.match(modelsText, /minimax-m3/);
  assert.match(modelsText, /anthropic-messages/);
  assert.match(modelsText, /openai-chat/);
  assert.match(modelsText, /unknown/);
  assert.match(modelsText, /Anthropic → OpenAI Chat/, 'openai-chat models show the adapter');

  // openai-chat is reachable through the local adapter; an unknown transport is not.
  await fake.sendAsUser({ content: '!model glm-5.2' });
  assert.match(fake.messages.at(-1).content, /已切换模型/);
  assert.equal(plane.sessionManager.get(fake.channelId).model, 'glm-5.2');
  await fake.sendAsUser({ content: '!status' });
  assert.match(fake.messages.at(-1).content, /协议：openai-chat/);
  assert.match(fake.messages.at(-1).content, /兼容层：Anthropic → OpenAI Chat/);

  await fake.sendAsUser({ content: '!model omen-alpha' });
  assert.match(fake.messages.at(-1).content, /当前执行器不支持此模型协议/);
  await fake.sendAsUser({ content: '!model minimax-m3' });
  assert.equal(plane.sessionManager.get(fake.channelId).model, 'minimax-m3');

  await fake.sendAsUser({ content: '创建验证文件' });
  assert.equal(fs.readFileSync(path.join(dir, 'v3-proof.txt'), 'utf8'), 'V3_OK');

  await fake.sendAsUser({ content: '!status' });
  const status = fake.messages.at(-1).content;
  assert.match(status, /执行器：Claude Code/);
  assert.match(status, /提供商：OpenCode Go/);
  assert.match(status, /协议：anthropic-messages/);
  assert.match(status, /模型：minimax-m3/);
  assert.match(status, /计费：订阅/);
});

test('!api is rejected outside a DM', async (t) => {
  const fake = new FakeDiscord();
  const stateFile = path.join(os.tmpdir(), `dac-guild-${Date.now()}.json`);
  t.after(() => { try { fs.rmSync(stateFile, { force: true }); } catch { /* absent */ } });
  const plane = new DiscordControlPlane({
    config: { ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: process.cwd(), claudeCommand: 'claude', notifyOnStart: false },
    state: new StateStore(stateFile),
    approvalManager: new ApprovalManager({ timeoutMs: 1000 }), client: fake.client, autoLogin: false,
  });
  await plane.start();
  await fake.sendAsUser({ content: '!api', guildId: 'guild-1' });
  assert.match(fake.messages.at(-1).content, /仅允许.*私聊/);
});
