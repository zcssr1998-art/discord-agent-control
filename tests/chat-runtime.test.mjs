import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatRuntime } from '../src/chat-runtime.mjs';
import { PROTOCOL, TRANSPORT } from '../src/provider-manager.mjs';

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function fixture(fetchImpl) {
  const profiles = [
    {
      id: 'opencode-go', displayName: 'OpenCode Go', protocol: PROTOCOL.OPENCODE_GO,
      baseUrl: 'https://opencode.ai/zen/go', billingType: 'SUBSCRIPTION', credentialRef: 'provider:opencode-go',
      models: [
        { id: 'deepseek-v4.1-flash', transport: TRANSPORT.OPENAI_CHAT },
        { id: 'glm-5.3-flash', transport: TRANSPORT.OPENAI_CHAT },
        { id: 'minimax-m3', transport: TRANSPORT.ANTHROPIC_MESSAGES },
      ],
    },
  ];
  const providerManager = {
    list: () => profiles,
    get: (id) => profiles.find((item) => item.id === id) || null,
    hasCredential: () => true,
    listModels: async (id) => ({ models: profiles.find((item) => item.id === id)?.models || [] }),
  };
  const credentialStore = { get: () => 'secret-key' };
  return new ChatRuntime({ providerManager, credentialStore, fetchImpl, timeoutMs: 5000 });
}

test('AUTO falls back from rate-limited DeepSeek to GLM without invoking an Agent', async () => {
  const seen = [];
  const runtime = fixture(async (_url, options) => {
    const body = JSON.parse(options.body);
    seen.push(body.model);
    if (body.model === 'deepseek-v4.1-flash') return response(429, { error: { message: 'rate limited' } });
    return response(200, { choices: [{ message: { content: 'GLM_OK' } }] });
  });
  const result = await runtime.send({ prompt: '你好' });
  assert.equal(result.text, 'GLM_OK');
  assert.equal(result.model, 'glm-5.3-flash');
  assert.deepEqual(seen, ['deepseek-v4.1-flash', 'glm-5.3-flash']);
  assert.equal(result.attempts[0].code, 'RATE_LIMIT');
});

test('cooldown skips a model that just failed', async () => {
  const seen = [];
  const runtime = fixture(async (_url, options) => {
    const body = JSON.parse(options.body);
    seen.push(body.model);
    if (body.model === 'deepseek-v4.1-flash') return response(429, { error: { message: 'rate limited' } });
    return response(200, { choices: [{ message: { content: 'OK' } }] });
  });
  await runtime.send({ prompt: 'one' });
  seen.length = 0;
  await runtime.send({ prompt: 'two' });
  assert.deepEqual(seen, ['glm-5.3-flash']);
});

test('manual provider/model pin never silently falls back', async () => {
  const runtime = fixture(async () => response(429, { error: { message: 'rate limited' } }));
  await assert.rejects(
    runtime.send({ prompt: 'x', providerId: 'opencode-go', model: 'deepseek-v4.1-flash' }),
    (error) => error.code === 'RATE_LIMIT' && error.attempts?.length === 1,
  );
});

test('OpenCode Go auth matches the transport: bearer for chat/responses, x-api-key for messages', async () => {
  const seen = [];
  const runtime = fixture(async (_url, options) => {
    seen.push(options.headers);
    return response(200, { choices: [{ message: { content: 'ok' } }], content: [{ type: 'text', text: 'ok' }] });
  });

  await runtime.send({ prompt: 'hi', model: 'deepseek-v4.1-flash' });
  assert.match(seen.at(-1).authorization || '', /^Bearer /);
  assert.equal(seen.at(-1)['x-api-key'], undefined);

  await runtime.send({ prompt: 'hi', model: 'minimax-m3' });
  assert.match(seen.at(-1)['x-api-key'], /^secret/);
  assert.equal(seen.at(-1).authorization, undefined);
});
