import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChatRuntime } from '../src/chat-runtime.mjs';
import { loadLiteLLMConfig, checkLiteLLMHealth, LITELLM_PROVIDER_ID } from '../src/litellm.mjs';
import { ProviderManager, PROTOCOL, TRANSPORT } from '../src/provider-manager.mjs';
import { CredentialStore } from '../src/credential-store.mjs';

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
  };
}

const LITELLM_PROFILE = {
  id: 'litellm', displayName: 'LiteLLM Gateway', protocol: PROTOCOL.OPENAI,
  baseUrl: 'http://127.0.0.1:4000/v1', billingType: 'SUBSCRIPTION', credentialRef: 'provider:litellm',
  models: [{ id: 'chat-fast', displayName: 'chat-fast' }],
};

const OPENCODE_GO = {
  id: 'opencode-go', displayName: 'OpenCode Go', protocol: PROTOCOL.OPENCODE_GO,
  baseUrl: 'https://opencode.ai/zen/go', billingType: 'SUBSCRIPTION', credentialRef: 'provider:opencode-go',
  models: [
    { id: 'deepseek-v4.1-flash', transport: TRANSPORT.OPENAI_CHAT },
    { id: 'glm-5.3-flash', transport: TRANSPORT.OPENAI_CHAT },
  ],
};

function fixture(fetchImpl, profiles = [LITELLM_PROFILE, OPENCODE_GO]) {
  const providerManager = {
    list: () => profiles,
    get: (id) => profiles.find((profile) => profile.id === id) || null,
    hasCredential: () => true,
    listModels: async (id) => ({ models: profiles.find((profile) => profile.id === id)?.models || [] }),
  };
  return new ChatRuntime({ providerManager, credentialStore: { get: () => 'secret' }, fetchImpl, timeoutMs: 3000 });
}

test('LiteLLM config defaults to a local-only subscription gateway', () => {
  const config = loadLiteLLMConfig({}, { root: os.tmpdir() });
  assert.equal(config.enabled, true);
  assert.equal(config.baseUrl, 'http://127.0.0.1:4000/v1');
  assert.equal(config.healthUrl, 'http://127.0.0.1:4000/health/liveliness');
  assert.equal(config.billingType, 'SUBSCRIPTION');
  const disabled = loadLiteLLMConfig({ LITELLM_ENABLED: 'false' });
  assert.equal(disabled.enabled, false);
});

test('a LiteLLM health failure is reported, never thrown', async () => {
  const down = await checkLiteLLMHealth({
    healthUrl: 'http://127.0.0.1:4000/health/liveliness',
    fetchImpl: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' }); },
  });
  assert.equal(down.ok, false);
  assert.equal(down.detail, 'unreachable');

  const bad = await checkLiteLLMHealth({ healthUrl: 'http://x/health', fetchImpl: async () => jsonResponse(503, {}) });
  assert.equal(bad.ok, false);
  assert.equal(bad.detail, 'HTTP 503');

  const up = await checkLiteLLMHealth({ healthUrl: 'http://x/health', fetchImpl: async () => jsonResponse(200, { status: 'healthy' }) });
  assert.equal(up.ok, true);
});

test('AUTO prefers the LiteLLM gateway and still reports the upstream model', async () => {
  const seen = [];
  const runtime = fixture(async (url, options) => {
    seen.push({ url, model: JSON.parse(options.body).model });
    assert.match(url, /^http:\/\/127\.0\.0\.1:4000\/v1\/chat\/completions$/);
    return jsonResponse(200, { choices: [{ message: { content: 'gateway answer' } }] }, { 'x-litellm-model-id': 'deepseek-v4.1-flash' });
  });
  const result = await runtime.send({ prompt: '你好' });
  assert.equal(result.providerId, LITELLM_PROVIDER_ID);
  assert.equal(result.model, 'chat-fast');
  assert.equal(result.upstreamModel, 'deepseek-v4.1-flash');
  assert.deepEqual(seen.map((entry) => entry.model), ['chat-fast'], 'only the gateway alias is called');
});

test('a LiteLLM outage does not strand Chat: OpenCode Go direct takes over', async () => {
  const seen = [];
  const runtime = fixture(async (url, options) => {
    const model = JSON.parse(options.body).model;
    seen.push(model);
    if (url.startsWith('http://127.0.0.1:4000')) throw Object.assign(new Error('fetch failed'), { code: 'UNREACHABLE' });
    return jsonResponse(200, { choices: [{ message: { content: 'direct answer' } }] });
  });
  const result = await runtime.send({ prompt: '你好' });
  assert.equal(result.providerId, 'opencode-go');
  assert.equal(result.model, 'deepseek-v4.1-flash');
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].code, 'UNREACHABLE');
  assert.deepEqual(seen, ['chat-fast', 'deepseek-v4.1-flash']);
});

test('safe billing policy keeps a METERED gateway out of AUTO', async () => {
  const metered = { ...LITELLM_PROFILE, billingType: 'METERED' };
  const seen = [];
  const runtime = fixture(async (url, options) => {
    seen.push(JSON.parse(options.body).model);
    return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
  }, [metered, OPENCODE_GO]);
  const result = await runtime.send({ prompt: '你好' });
  assert.equal(result.providerId, 'opencode-go');
  assert.ok(!seen.includes('chat-fast'), 'a metered alias must never be used silently');
});

test('registerLitellm adds one OpenAI-compatible local provider', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-litellm-'));
  const credentials = new CredentialStore(path.join(dir, 'credentials.json'));
  const providers = new ProviderManager({ file: path.join(dir, 'providers.json'), credentialStore: credentials });
  providers.registerLitellm({ baseUrl: 'http://127.0.0.1:4000/v1/', billingType: 'subscription' });
  const profile = providers.get('litellm');
  assert.equal(profile.protocol, PROTOCOL.OPENAI);
  assert.equal(profile.baseUrl, 'http://127.0.0.1:4000/v1');
  assert.equal(profile.billingType, 'SUBSCRIPTION');
  assert.ok(providers.list().some((item) => item.id === 'litellm'));
  assert.equal(profile.removable, false);
});
