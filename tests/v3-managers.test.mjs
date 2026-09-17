import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialStore } from '../src/credential-store.mjs';
import { ProviderManager, PROTOCOL, TRANSPORT, openCodeGoTransport, normalizeBaseUrl, providerErrorMessage } from '../src/provider-manager.mjs';
import { ModelManager } from '../src/model-manager.mjs';
import { ExecutorManager, normalizeExecutorEvent } from '../src/executor-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { SessionManager } from '../src/session-manager.mjs';
import { PermissionManager } from '../src/permission-manager.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { redactSecrets } from '../src/secrets.mjs';

function stores(fetchImpl, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dac-v3-'));
  const credentials = new CredentialStore(path.join(dir, 'credentials.json'));
  const providers = new ProviderManager({
    file: path.join(dir, 'providers.json'), credentialStore: credentials, fetchImpl, timeoutMs: 1000, ...options,
  });
  return { dir, credentials, providers };
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('OpenAI-compatible detection normalizes /v1 and discovers models dynamically', async (t) => {
  const seen = [];
  const ctx = stores(async (url, options) => {
    seen.push({ url, authorization: options.headers.authorization });
    return url.endsWith('/v1/models') && options.headers.authorization === 'Bearer openai-secret'
      ? json(200, { data: [{ id: 'alpha' }, { id: 'beta', name: 'ignored' }] })
      : json(404, { error: { message: 'not found' } });
  });
  t.after(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));
  const added = await ctx.providers.addGeneric({ baseUrl: 'https://api.example.test/v1/', secret: 'openai-secret' });
  assert.equal(normalizeBaseUrl('https://api.example.test/v1/'), 'https://api.example.test/v1');
  assert.equal(added.profile.protocol, PROTOCOL.OPENAI);
  assert.deepEqual(added.profile.models.map((model) => model.id), ['alpha', 'beta']);
  assert.equal(seen[0].url, 'https://api.example.test/v1/models');
  assert.equal(ctx.credentials.has(added.profile.credentialRef), true);
});

test('Anthropic-compatible detection uses x-api-key and discovers models', async (t) => {
  const ctx = stores(async (url, options) => {
    if (options.headers['x-api-key'] === 'anthropic-secret' && url.endsWith('/v1/models')) {
      return json(200, { data: [{ id: 'claude-compatible', display_name: 'Claude Compatible' }] });
    }
    return json(404, { type: 'not_found' });
  });
  t.after(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));
  const added = await ctx.providers.addGeneric({ baseUrl: 'https://anthropic.example.test', secret: 'anthropic-secret' });
  assert.equal(added.profile.protocol, PROTOCOL.ANTHROPIC);
  assert.equal(added.profile.models[0].displayName, 'Claude Compatible');
});

test('generic 404 errors are not guessed as a protocol, and reliable domains identify providers', async (t) => {
  const ambiguous = stores(async () => json(404, { error: { message: 'route not found' } }));
  t.after(() => fs.rmSync(ambiguous.dir, { recursive: true, force: true }));
  const pending = await ambiguous.providers.addGeneric({ baseUrl: 'https://unknown.example.test', secret: 'ambiguous-secret' });
  assert.equal(pending.needsProtocol, true);
  ambiguous.credentials.remove(pending.pending.credentialRef);

  const deepseek = stores(async () => json(200, { data: [{ id: 'deepseek-model' }] }));
  t.after(() => fs.rmSync(deepseek.dir, { recursive: true, force: true }));
  const added = await deepseek.providers.addGeneric({ baseUrl: 'https://api.deepseek.com', secret: 'deepseek-secret' });
  assert.equal(added.profile.displayName, 'DeepSeek');
  assert.equal(added.profile.metadata.identifiedBy, 'domain');
});

test('invalid credentials and invalid URLs fail without leaving credentials behind', async (t) => {
  const ctx = stores(async () => json(401, { error: { code: 'invalid_api_key', message: 'bad key' } }));
  t.after(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));
  await assert.rejects(ctx.providers.addGeneric({ baseUrl: 'https://api.example.test', secret: 'invalid-secret' }), { code: 'INVALID_CREDENTIAL' });
  assert.deepEqual(ctx.credentials.data, {});
  await assert.rejects(ctx.providers.addGeneric({ baseUrl: 'ftp://wrong', secret: 'invalid-secret' }), { code: 'INVALID_URL' });
  assert.match(providerErrorMessage({ code: 'RATE_LIMIT', status: 429 }), /达到频率.*HTTP 429/);
});

test('missing models endpoint falls back to a manual model ID with a real validation call', async (t) => {
  const ctx = stores(async (url, options) => {
    if (url.includes('/models')) return json(404, { error: { message: 'missing' } });
    const body = JSON.parse(options.body);
    if (body.model === '__discord_agent_control_probe__') return json(400, { error: { type: 'invalid_request_error', message: 'model not found' } });
    if (body.model === 'manual-model') return json(200, { id: 'response-1' });
    return json(404, { error: { code: 'model_not_found', message: 'unknown model' } });
  });
  t.after(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));
  const added = await ctx.providers.addGeneric({ baseUrl: 'https://api.example.test', secret: 'manual-secret' });
  assert.equal(added.modelsMissing, true);
  const models = new ModelManager(ctx.providers);
  assert.equal(await models.select(added.profile.id, 'manual-model'), 'manual-model');
  assert.equal(ctx.providers.get(added.profile.id).models[0].id, 'manual-model');
  await assert.rejects(models.select(added.profile.id, 'bad-model'), { code: 'MODEL_INVALID' });
});

test('model cache expires, and refresh failure keeps the last successful list as stale', async (t) => {
  let now = 1000;
  let fail = false;
  let calls = 0;
  const ctx = stores(async (url) => {
    calls += 1;
    if (fail) throw new Error('offline');
    return url.includes('/models') ? json(200, { data: [{ id: 'cached-model' }] }) : json(404, {});
  }, { cacheMs: 100, now: () => now });
  t.after(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));
  const added = await ctx.providers.addGeneric({ baseUrl: 'https://api.example.test', secret: 'cache-secret' });
  const afterAdd = calls;
  await ctx.providers.listModels(added.profile.id);
  assert.equal(calls, afterAdd, 'fresh cache must avoid a request');
  now += 101;
  fail = true;
  const stale = await ctx.providers.listModels(added.profile.id);
  assert.equal(stale.stale, true);
  assert.equal(stale.models[0].id, 'cached-model');
});

test('provider delete removes the profile and its credential', async (t) => {
  const ctx = stores(async () => json(200, { data: [{ id: 'model' }] }));
  t.after(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));
  const added = await ctx.providers.addGeneric({ baseUrl: 'https://api.example.test', secret: 'delete-secret' });
  assert.equal(ctx.providers.remove(added.profile.id), true);
  assert.equal(ctx.providers.get(added.profile.id), null);
  assert.equal(ctx.credentials.has(added.profile.credentialRef), false);
  assert.throws(() => ctx.providers.remove('workbuddy-free'), { code: 'BUILTIN_PROVIDER' });
});

test('WorkBuddy health reports quota without affecting generic providers', async (t) => {
  const ctx = stores(async () => json(200, { data: [{ id: 'model' }] }));
  t.after(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));
  ctx.providers.setWorkbuddyHealth('BLOCKED_BY_QUOTA', 'quota exceeded');
  const health = await ctx.providers.health('workbuddy-free');
  assert.equal(health.ok, false);
  assert.equal(health.error.code, 'WORKBUDDY_QUOTA');
  assert.match(providerErrorMessage(health.error), /额度不足/);
  assert.equal((await ctx.providers.addGeneric({ baseUrl: 'https://api.example.test', secret: 'generic-secret' })).profile.id, 'custom-1');
});

test('executor discovery reports installed, missing and adapter-not-ready honestly', async () => {
  class FakeRunner { constructor(options) { this.options = options; } }
  const versions = { 'wb.js': '2.1', claude: '2.2', codex: '0.154' };
  const sourceEnv = { PATH: 'bin', OPENAI_API_KEY: 'other-secret', DISCORD_TOKEN: 'discord-secret' };
  const executors = new ExecutorManager({
    workbuddyCommand: 'wb.js',
    env: sourceEnv, workbuddyEnv: sourceEnv,
    probeVersion: async (command) => versions[command] || null,
    RunnerClass: FakeRunner,
  });
  await executors.discover();
  assert.equal(executors.get('workbuddy').status, 'PASS');
  assert.equal(executors.get('claude').status, 'PASS');
  assert.equal(executors.get('opencode').status, 'NOT_INSTALLED');
  assert.equal(executors.get('codex').status, 'ADAPTER_NOT_READY');
  assert.deepEqual(executors.compatibleExecutors(PROTOCOL.ANTHROPIC).map((item) => item.id), ['claude']);
  const provider = { protocol: PROTOCOL.ANTHROPIC, baseUrl: 'https://api.example.test' };
  const runner = await executors.createRunner({ executorId: 'claude', provider, credential: 'current-secret', model: 'model', cwd: 'C:\\repo' });
  assert.equal(runner.options.extraEnv.ANTHROPIC_API_KEY, 'current-secret');
  assert.equal(runner.options.extraEnv.ANTHROPIC_AUTH_TOKEN, 'current-secret');
  assert.equal(runner.options.extraEnv.OPENAI_API_KEY, undefined);
  assert.equal(runner.options.extraEnv.DISCORD_TOKEN, undefined);
  assert.equal(runner.options.inheritEnv, false);
  const workbuddy = executors.buildEnvironment('workbuddy', { protocol: PROTOCOL.WORKBUDDY }, null, 'fast');
  assert.equal(workbuddy.env.OPENAI_API_KEY, undefined);
  assert.equal(workbuddy.env.DISCORD_TOKEN, undefined);
  assert.equal(normalizeExecutorEvent({ type: 'tool', tool: { name: 'Bash', input: { command: 'npm test' } } }).kind, 'TEST');
  assert.equal(normalizeExecutorEvent({ type: 'tool', tool: { name: 'Read', input: {} } }).kind, 'READ');
});

test('session changes stop the old executor, clear its id and keep the explicit tier', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dac-session-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = new StateStore(path.join(dir, 'state.json'));
  const permissions = new PermissionManager();
  const approvals = new ApprovalManager({ timeoutMs: 1000 });
  let stopped = 0;
  const sessions = new SessionManager({
    state, permissionManager: permissions, approvalManager: approvals, defaultCwd: 'C:\\repo',
    stopRunner: async () => { stopped += 1; },
  });
  state.patchChannel('c', { executorId: 'workbuddy', providerId: 'workbuddy-free', model: 'fast', sessionId: 'old' }, 'C:\\repo');
  permissions.syncSession('old', 'c');
  permissions.confirmFull('c');
  await sessions.change('c', { providerId: 'custom-1', model: null }, 'provider changed');
  assert.equal(stopped, 1);
  assert.equal(sessions.get('c').sessionId, null);
  assert.equal(sessions.get('c').providerId, 'custom-1');
  assert.deepEqual(sessions.snapshot('c'), {
    cwd: 'C:\\repo', executorId: 'workbuddy', providerId: 'custom-1', model: null,
    sessionId: null, executorSessionId: null, permission: 'full',
    mode: 'chat', chatProviderId: 'auto', chatModel: null,
  });
  // P2.2.5 K4: an explicit FULL tier is product configuration, not session
  // state, so a provider/session change must not silently downgrade it.
  assert.equal(permissions.getLevel('c'), 'full');
  const running = new SessionManager({ state, permissionManager: permissions, approvalManager: approvals, defaultCwd: 'C:\\repo', isRunning: () => true });
  await assert.rejects(running.change('c', { model: 'x' }, 'model changed'), { code: 'RUNNING' });
});

test('registered secrets are redacted everywhere with only the last four visible', async (t) => {
  const ctx = stores(async () => json(200, { data: [{ id: 'm' }] }));
  t.after(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));
  ctx.credentials.set('provider:test', 'sk-super-secret-7F2A');
  ctx.credentials.set('provider:test-2', 'sk-super-secret-7F2A');
  ctx.credentials.remove('provider:test');
  const output = redactSecrets('Authorization: Bearer sk-super-secret-7F2A');
  assert.equal(output.includes('sk-super-secret-7F2A'), false);
  assert.match(output, /sk-\*\*\*\*7F2A/);
});

test('OpenCode Go model transports follow the official endpoint families, unknown stays unknown', () => {
  assert.equal(openCodeGoTransport('minimax-m3'), TRANSPORT.ANTHROPIC_MESSAGES);
  assert.equal(openCodeGoTransport('qwen3.6-plus'), TRANSPORT.ANTHROPIC_MESSAGES);
  assert.equal(openCodeGoTransport('glm-5.2'), TRANSPORT.OPENAI_CHAT);
  assert.equal(openCodeGoTransport('kimi-k3'), TRANSPORT.OPENAI_CHAT);
  assert.equal(openCodeGoTransport('deepseek-v4.1-flash'), TRANSPORT.OPENAI_CHAT);
  assert.equal(openCodeGoTransport('hy4-preview'), TRANSPORT.OPENAI_CHAT);
  assert.equal(openCodeGoTransport('grok-4.6'), TRANSPORT.OPENAI_RESPONSES);
  assert.equal(openCodeGoTransport('gpt-5.6-luna'), TRANSPORT.OPENAI_RESPONSES);
  assert.equal(openCodeGoTransport('muse-spark-1.2-contributor'), TRANSPORT.OPENAI_RESPONSES);
  assert.equal(openCodeGoTransport('omen-alpha'), TRANSPORT.UNKNOWN);
});

test('OpenCode Go is built-in and its model list is fetched dynamically with per-model transport', async (t) => {
  const seen = [];
  const ctx = stores(async (url) => {
    seen.push(url);
    if (url === 'https://opencode.ai/zen/go/v1/models') {
      return json(200, { data: [
        { id: 'minimax-m3', object: 'model' },
        { id: 'glm-5.2', object: 'model' },
        { id: 'grok-4.6', object: 'model' },
        { id: 'omen-alpha', object: 'model' },
      ] });
    }
    return json(404, { error: { message: 'not this endpoint' } });
  });
  t.after(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));
  const profile = ctx.providers.get('opencode-go');
  assert.equal(profile.displayName, 'OpenCode Go');
  assert.equal(profile.protocol, PROTOCOL.OPENCODE_GO);
  assert.equal(profile.billingType, 'SUBSCRIPTION');
  assert.equal(profile.source, 'built-in-special');
  assert.equal(ctx.providers.hasCredential(profile), false, 'a credential is required');
  assert.throws(() => ctx.providers.remove('opencode-go'), { code: 'BUILTIN_PROVIDER' });

  ctx.credentials.set('provider:opencode-go', 'opencode-secret');
  const result = await ctx.providers.listModels('opencode-go');
  assert.deepEqual(result.models.map((model) => model.id), ['minimax-m3', 'glm-5.2', 'grok-4.6', 'omen-alpha']);
  assert.deepEqual(result.models.map((model) => model.transport), [
    TRANSPORT.ANTHROPIC_MESSAGES, TRANSPORT.OPENAI_CHAT, TRANSPORT.OPENAI_RESPONSES, TRANSPORT.UNKNOWN,
  ]);
  assert.ok(seen.includes('https://opencode.ai/zen/go/v1/models'));

  const raw = fs.readFileSync(path.join(ctx.dir, 'providers.json'), 'utf8');
  assert.equal(raw.includes('opencode-secret'), false, 'the model cache never contains the key');
  assert.match(raw, /built-in-special/);
});

test('OpenCode Go keeps its code definition while reusing the persisted model cache', async (t) => {
  const ctx = stores(async () => json(200, { data: [{ id: 'minimax-m3' }, { id: 'qwen3.6-plus' }] }));
  t.after(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));
  ctx.credentials.set('provider:opencode-go', 'opencode-secret');
  await ctx.providers.listModels('opencode-go');
  const reloaded = new ProviderManager({
    file: path.join(ctx.dir, 'providers.json'), credentialStore: ctx.credentials, timeoutMs: 1000,
    fetchImpl: async () => { throw new Error('should not fetch while the cache is fresh'); },
  });
  const profile = reloaded.get('opencode-go');
  assert.equal(profile.displayName, 'OpenCode Go');
  assert.equal(profile.baseUrl, 'https://opencode.ai/zen/go');
  assert.deepEqual(profile.models.map((model) => model.id), ['minimax-m3', 'qwen3.6-plus']);
});

test('OpenCode Go model validation uses the model transport and refuses unknown ones', async (t) => {
  const requests = [];
  const ctx = stores(async (url, options) => {
    requests.push({ url, headers: options.headers });
    if (url.endsWith('/v1/messages')) return json(200, { id: 'msg_1', type: 'message' });
    return json(404, { error: { message: 'wrong endpoint' } });
  });
  t.after(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));
  ctx.credentials.set('provider:opencode-go', 'opencode-secret');
  const models = new ModelManager(ctx.providers);
  assert.equal(await models.select('opencode-go', 'minimax-m3'), 'minimax-m3');
  assert.equal(requests.at(-1).url, 'https://opencode.ai/zen/go/v1/messages');
  assert.equal(requests.at(-1).headers['x-api-key'], 'opencode-secret');
  assert.ok(requests.at(-1).headers['x-opencode-session'], 'the gateway requires a session header');
  assert.equal(ctx.providers.get('opencode-go').models[0].transport, TRANSPORT.ANTHROPIC_MESSAGES);
  await assert.rejects(models.select('opencode-go', 'omen-alpha'), { code: 'MODEL_INVALID' });
});

test('OpenCode Go compatibility is per model transport, and its child env is credential-isolated', async () => {
  class FakeRunner {
    constructor(options) { this.options = options; }
    async stop() { if (this.options.onDispose) await this.options.onDispose(); return { killed: false, pid: null }; }
  }
  const sourceEnv = {
    PATH: 'bin', OPENAI_API_KEY: 'other-secret', ANTHROPIC_AUTH_TOKEN: 'deepseek-secret', DISCORD_TOKEN: 'discord-secret',
  };
  const executors = new ExecutorManager({
    workbuddyCommand: 'wb.js', env: sourceEnv, workbuddyEnv: sourceEnv,
    probeVersion: async (command) => ({ 'wb.js': '2.137.1', claude: '2.1.270' })[command] || null,
    RunnerClass: FakeRunner,
  });
  await executors.discover();
  const provider = { id: 'opencode-go', protocol: PROTOCOL.OPENCODE_GO, baseUrl: 'https://opencode.ai/zen/go' };

  assert.equal(executors.compatible('claude', PROTOCOL.OPENCODE_GO, TRANSPORT.ANTHROPIC_MESSAGES), true);
  assert.equal(executors.compatible('claude', PROTOCOL.OPENCODE_GO, TRANSPORT.OPENAI_CHAT), true, 'via the local adapter');
  assert.equal(executors.compatible('claude', PROTOCOL.OPENCODE_GO, TRANSPORT.OPENAI_RESPONSES), false, 'responses is not adapted yet');
  assert.equal(executors.compatible('claude', PROTOCOL.OPENCODE_GO, TRANSPORT.UNKNOWN), false);
  assert.deepEqual(executors.compatibleExecutors(PROTOCOL.OPENCODE_GO).map((executor) => executor.id), ['claude']);
  assert.equal(executors.adapterLabel(PROTOCOL.OPENCODE_GO, TRANSPORT.OPENAI_CHAT), 'Anthropic → OpenAI Chat');
  assert.equal(executors.adapterLabel(PROTOCOL.OPENCODE_GO, TRANSPORT.ANTHROPIC_MESSAGES), null);

  const direct = await executors.createRunner({ executorId: 'claude', provider, credential: 'opencode-key', model: 'minimax-m3', cwd: 'C:\\repo' });
  assert.equal(direct.options.extraEnv.ANTHROPIC_BASE_URL, 'https://opencode.ai/zen/go');
  assert.equal(direct.options.extraEnv.ANTHROPIC_API_KEY, 'opencode-key');
  assert.equal(direct.options.extraEnv.ANTHROPIC_AUTH_TOKEN, undefined, 'Bearer is rejected by OpenCode Go');
  assert.equal(direct.options.extraEnv.OPENAI_API_KEY, undefined);
  assert.equal(direct.options.extraEnv.DISCORD_TOKEN, undefined);
  assert.equal(direct.options.inheritEnv, false);
  assert.equal(direct.adapter, undefined, 'anthropic-messages is a direct route');

  const adapted = await executors.createRunner({ executorId: 'claude', provider, credential: 'opencode-key', model: 'glm-5.2', cwd: 'C:\\repo' });
  try {
    assert.equal(adapted.adapter, 'anthropic-to-openai-chat');
    assert.equal(adapted.adapterLabel, 'Anthropic → OpenAI Chat');
    assert.match(adapted.options.extraEnv.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(adapted.options.extraEnv.ANTHROPIC_API_KEY, adapted.gateway.token, 'the child only sees the local token');
    assert.notEqual(adapted.options.extraEnv.ANTHROPIC_API_KEY, 'opencode-key', 'the real key never reaches the child env');
    assert.equal(adapted.gateway.credential, 'opencode-key');
    assert.equal(adapted.options.extraEnv.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(adapted.options.extraEnv.OPENAI_API_KEY, undefined);
    assert.equal(adapted.options.inheritEnv, false);
    assert.equal(adapted.gateway.upstreamRequests.length, 0, 'no upstream call before a task runs');
  } finally {
    await adapted.stop({ reason: 'test cleanup' });
  }

  await assert.rejects(
    () => executors.createRunner({ executorId: 'claude', provider, credential: 'opencode-key', model: 'grok-4.6', cwd: 'C:\\repo' }),
    { code: 'INCOMPATIBLE' },
  );
  assert.match(providerErrorMessage({ code: 'INCOMPATIBLE' }), /不支持此模型协议/);
});
