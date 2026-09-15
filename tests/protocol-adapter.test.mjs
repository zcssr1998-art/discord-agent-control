import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicToOpenAIRequest,
  openAIToAnthropicMessage,
  AnthropicStreamTranslator,
  openAIErrorToAnthropic,
  mapFinishReason,
  ADAPTER,
} from '../src/protocol-adapters/anthropic-to-openai-chat.mjs';

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

test('Anthropic text request becomes an OpenAI chat request (system + messages + limits)', () => {
  const request = anthropicToOpenAIRequest({
    model: 'deepseek-v4.1-flash',
    system: [{ type: 'text', text: 'You are an agent.' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: 'again' },
    ],
    max_tokens: 512,
    temperature: 0.2,
    stream: true,
  }, { model: 'deepseek-v4.1-flash' });

  assert.equal(request.model, 'deepseek-v4.1-flash');
  assert.equal(request.stream, true);
  assert.equal(request.max_tokens, 512);
  assert.equal(request.temperature, 0.2);
  assert.deepEqual(request.messages, [
    { role: 'system', content: 'You are an agent.' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'again' },
  ]);
});

test('Anthropic tools become OpenAI functions and tool_choice maps correctly', () => {
  const request = anthropicToOpenAIRequest({
    messages: [{ role: 'user', content: 'go' }],
    tools: [{ name: 'Bash', description: 'Run a command', input_schema: { $schema: 'x', type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }],
    tool_choice: { type: 'any' },
    stop_sequences: ['END'],
    stream: false,
  }, { model: 'glm-5.3-flash' });

  assert.equal(request.tools.length, 1);
  assert.equal(request.tools[0].type, 'function');
  assert.equal(request.tools[0].function.name, 'Bash');
  assert.equal(request.tools[0].function.parameters.$schema, undefined);
  assert.deepEqual(request.tools[0].function.parameters.required, ['command']);
  assert.equal(request.tool_choice, 'required');
  assert.deepEqual(request.stop, ['END']);
  assert.equal(anthropicToOpenAIRequest({ messages: [], tool_choice: { type: 'auto' } }, { model: 'm' }).tool_choice, 'auto');
  assert.deepEqual(
    anthropicToOpenAIRequest({ messages: [], tool_choice: { type: 'tool', name: 'Read' } }, { model: 'm' }).tool_choice,
    { type: 'function', function: { name: 'Read' } },
  );
});

test('assistant tool_use becomes tool_calls and user tool_result becomes a tool message', () => {
  const request = anthropicToOpenAIRequest({
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '...' },
          { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'file.txt' },
          { type: 'text', text: 'done' },
        ],
      },
    ],
  }, { model: 'm' });

  assert.deepEqual(request.messages[0], {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }],
  });
  assert.deepEqual(request.messages[1], { role: 'tool', tool_call_id: 'call_1', content: 'file.txt' });
  assert.deepEqual(request.messages[2], { role: 'user', content: 'done' });
});

test('OpenAI finish reasons map to Anthropic stop reasons', () => {
  assert.equal(mapFinishReason('tool_calls'), 'tool_use');
  assert.equal(mapFinishReason('stop'), 'end_turn');
  assert.equal(mapFinishReason('length'), 'max_tokens');
  assert.equal(mapFinishReason(undefined), 'end_turn');
});

test('OpenAI non-stream response becomes an Anthropic message with tool_use', () => {
  const message = openAIToAnthropicMessage({
    id: 'chatcmpl-1',
    model: 'deepseek-v4.1-flash',
    choices: [{
      finish_reason: 'tool_calls',
      message: { content: 'working', tool_calls: [{ id: 'call_9', function: { name: 'Write', arguments: '{"file_path":"a.txt"}' } }] },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }, { model: 'deepseek-v4.1-flash' });

  assert.equal(message.type, 'message');
  assert.equal(message.stop_reason, 'tool_use');
  assert.equal(message.usage.input_tokens, 10);
  assert.deepEqual(message.content[0], { type: 'text', text: 'working' });
  assert.deepEqual(message.content[1], { type: 'tool_use', id: 'call_9', name: 'Write', input: { file_path: 'a.txt' } });
});

test('OpenAI stream text chunks become Anthropic text_delta events', () => {
  const translator = new AnthropicStreamTranslator({ model: 'glm-5.3-flash', id: 'msg_test' });
  let out = translator.start().join('');
  out += translator.push({ choices: [{ delta: { role: 'assistant', content: 'Hel' } }] });
  out += translator.push({ choices: [{ delta: { content: 'lo' } }] });
  out += translator.push({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  out += translator.finish();

  const parsed = events(out);
  assert.deepEqual(parsed.map((event) => event.event), [
    'message_start', 'ping', 'content_block_start', 'content_block_delta', 'content_block_delta',
    'content_block_stop', 'message_delta', 'message_stop',
  ]);
  assert.equal(parsed[0].data.message.id, 'msg_test');
  assert.equal(parsed[2].data.content_block.type, 'text');
  assert.equal(parsed[3].data.delta.text + parsed[4].data.delta.text, 'Hello');
  assert.equal(parsed[6].data.delta.stop_reason, 'end_turn');
});

test('OpenAI streamed tool arguments become Anthropic input_json_delta events', () => {
  const translator = new AnthropicStreamTranslator({ model: 'deepseek-v4.1-flash', id: 'msg_tool' });
  let out = translator.start().join('');
  out += translator.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'Bash', arguments: '{"comm' } }] } }] });
  out += translator.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] });
  out += translator.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  out += translator.finish();

  const parsed = events(out);
  const start = parsed.find((event) => event.event === 'content_block_start');
  assert.equal(start.data.content_block.type, 'tool_use');
  assert.equal(start.data.content_block.id, 'call_a');
  assert.equal(start.data.content_block.name, 'Bash');
  const deltas = parsed.filter((event) => event.event === 'content_block_delta');
  assert.equal(deltas.map((event) => event.data.delta.partial_json).join(''), '{"command":"ls"}');
  assert.equal(parsed.at(-2).data.delta.stop_reason, 'tool_use');
  assert.equal(parsed.at(-1).event, 'message_stop');
});

test('an empty upstream stream still yields a valid Anthropic message', () => {
  const translator = new AnthropicStreamTranslator({ model: 'm', id: 'msg_empty' });
  const parsed = events(translator.start().join('') + translator.finish());
  assert.equal(parsed.filter((event) => event.event === 'content_block_start').length, 1);
  assert.equal(parsed.filter((event) => event.event === 'content_block_stop').length, 1);
  assert.equal(parsed.at(-1).event, 'message_stop');
});

test('upstream HTTP errors map to Anthropic errors with a safe status', () => {
  assert.deepEqual(openAIErrorToAnthropic(401, { error: { message: 'bad key' } }), {
    status: 401,
    body: { type: 'error', error: { type: 'authentication_error', message: 'bad key' } },
  });
  assert.equal(openAIErrorToAnthropic(429, { error: { message: 'slow down' } }).body.error.type, 'rate_limit_error');
  assert.equal(openAIErrorToAnthropic(503, { error: { message: 'down' } }).body.error.type, 'api_error');
  assert.equal(openAIErrorToAnthropic(400, { error: { message: 'bad' } }).body.error.type, 'invalid_request_error');
  assert.equal(ADAPTER.ANTHROPIC_TO_OPENAI_CHAT, 'anthropic-to-openai-chat');
});


