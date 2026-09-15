import test from 'node:test';
import assert from 'node:assert/strict';
import { CompatGateway } from '../src/compat-gateway.mjs';
import { PROTOCOL, TRANSPORT } from '../src/provider-manager.mjs';

const PROVIDER = { id: 'opencode-go', protocol: PROTOCOL.OPENCODE_GO, baseUrl: 'https://opencode.ai/zen/go' };

function events(sseText) {
  const out = [];
  for (const block of sseText.split('\n\n')) {
    const lines = block.split('\n');
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
    const data = lines.find((line) => line.startsWith('data:'))?.slice(5).trim();
    if (event) out.push({ event, data: data ? JSON.parse(data) : null });
  }
  return out;
}

async function post(gateway, body, headers = {}) {
  const response = await fetch(`${gateway.url}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': gateway.token, 'x-claude-code-session-id': 'sess-1', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text(), contentType: response.headers.get('content-type') };
}

test('gateway translates an Anthropic stream request into OpenAI chat and back', async (t) => {
  const calls = [];
  const gateway = new CompatGateway({
    provider: PROVIDER, credential: 'real-opencode-key', model: 'deepseek-v4.1-flash', transport: TRANSPORT.OPENAI_CHAT,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      const sse = [
        'data: {"choices":[{"delta":{"role":"assistant","content":"Wri"}}]}',
        'data: {"choices":[{"delta":{"content":"ting"}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"Write","arguments":"{\\"file_path\\":\\"a.txt\\"}"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  await gateway.start();
  t.after(() => gateway.close());

  const response = await post(gateway, {
    model: 'deepseek-v4.1-flash', stream: true, max_tokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'create a file' }] }],
    tools: [{ name: 'Write', description: 'write', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }],
  });

  assert.equal(response.status, 200);
  assert.match(response.contentType, /text\/event-stream/);
  const parsed = events(response.text);
  const deltas = parsed.filter((event) => event.event === 'content_block_delta');
  assert.equal(deltas.filter((event) => event.data.delta.type === 'text_delta').map((event) => event.data.delta.text).join(''), 'Writing');
  assert.equal(deltas.filter((event) => event.data.delta.type === 'input_json_delta').map((event) => event.data.delta.partial_json).join(''), '{"file_path":"a.txt"}');
  assert.equal(parsed.find((event) => event.event === 'content_block_start' && event.data.content_block.type === 'tool_use').data.content_block.name, 'Write');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://opencode.ai/zen/go/v1/chat/completions');
  assert.equal(calls[0].options.headers.authorization, 'Bearer real-opencode-key');
  assert.equal(calls[0].options.headers['x-opencode-session'], 'sess-1');
  assert.equal(calls[0].body.model, 'deepseek-v4.1-flash');
  assert.equal(calls[0].body.stream, true);
  assert.equal(calls[0].body.tools[0].function.name, 'Write');
  assert.equal(gateway.upstreamRequests.at(-1).model, 'deepseek-v4.1-flash');
});

test('gateway handles a non-stream Anthropic request', async (t) => {
  const gateway = new CompatGateway({
    provider: PROVIDER, credential: 'real-opencode-key', model: 'glm-5.3-flash', transport: TRANSPORT.OPENAI_CHAT,
    fetchImpl: async () => new Response(JSON.stringify({
      id: 'chatcmpl-2', model: 'glm-5.3-flash',
      choices: [{ finish_reason: 'stop', message: { content: 'done' } }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  await gateway.start();
  t.after(() => gateway.close());

  const response = await post(gateway, { model: 'glm-5.3-flash', stream: false, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(response.status, 200);
  const message = JSON.parse(response.text);
  assert.equal(message.type, 'message');
  assert.equal(message.content[0].text, 'done');
  assert.equal(message.stop_reason, 'end_turn');
});

test('gateway maps upstream errors and rejects a wrong local token', async (t) => {
  let called = 0;
  const gateway = new CompatGateway({
    provider: PROVIDER, credential: 'real-opencode-key', model: 'deepseek-v4.1-flash', transport: TRANSPORT.OPENAI_CHAT,
    fetchImpl: async () => { called += 1; return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 }); },
  });
  await gateway.start();
  t.after(() => gateway.close());

  const rejected = await fetch(`${gateway.url}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'not-the-token' }, body: '{}',
  });
  assert.equal(rejected.status, 401);
  assert.equal(called, 0, 'an unauthenticated request never reaches upstream');

  const response = await post(gateway, { model: 'deepseek-v4.1-flash', stream: true, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(response.status, 401);
  assert.equal(JSON.parse(response.text).error.type, 'authentication_error');
  assert.equal(called, 1);
});

test('gateway answers the Claude Code connectivity probe and count_tokens', async (t) => {
  const gateway = new CompatGateway({ provider: PROVIDER, credential: 'k', model: 'm', transport: TRANSPORT.OPENAI_CHAT });
  await gateway.start();
  t.after(() => gateway.close());

  const hello = await fetch(`${gateway.url}/api/hello`, { method: 'HEAD' });
  assert.equal(hello.status, 200);

  const count = await fetch(`${gateway.url}/v1/messages/count_tokens`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': gateway.token }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(count.status, 200);
  assert.ok(JSON.parse(await count.text()).input_tokens > 0);
});

test('gateway close() stops accepting connections', async (t) => {
  const gateway = new CompatGateway({ provider: PROVIDER, credential: 'k', model: 'm', transport: TRANSPORT.OPENAI_CHAT });
  await gateway.start();
  const url = gateway.url;
  await gateway.close();
  await assert.rejects(fetch(`${gateway.url ?? url}/api/hello`), /fetch failed|ECONNREFUSED/);
});
