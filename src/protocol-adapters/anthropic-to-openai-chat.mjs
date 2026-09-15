/**
 * Anthropic Messages <-> OpenAI Chat Completions translation.
 *
 * This module is a pure protocol translator. It never decides which tool to run,
 * never executes a tool and never calls a model by itself: Claude Code remains
 * the only agent loop. Every function here is deterministic and unit-testable.
 *
 * The shapes were taken from a real capture of Claude Code 2.1.270 talking to
 * OpenCode Go (see docs/WINDOWS_SMOKE.md), not from memory.
 */
import { randomBytes } from 'node:crypto';

export const ADAPTER = Object.freeze({
  ANTHROPIC_TO_OPENAI_CHAT: 'anthropic-to-openai-chat',
});

export const ADAPTER_LABEL = Object.freeze({
  [ADAPTER.ANTHROPIC_TO_OPENAI_CHAT]: 'Anthropic → OpenAI Chat',
});

const FINISH_REASON = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  length: 'max_tokens',
  content_filter: 'end_turn',
};

export function mapFinishReason(reason) {
  return FINISH_REASON[reason] || 'end_turn';
}

/** Wrap one Anthropic SSE event. */
export function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function safeJson(text) {
  if (typeof text !== 'string' || !text.trim()) return {};
  try { return JSON.parse(text); } catch { return { __raw: text }; }
}

function messageId() {
  return `msg_${randomBytes(12).toString('hex')}`;
}

function imageDataUrl(block) {
  const source = block.source || {};
  if (source.type === 'base64') return `data:${source.media_type || 'image/png'};base64,${source.data}`;
  if (source.type === 'url') return source.url;
  return '';
}

/** Collapse text/image blocks into an OpenAI content value (string or parts). */
function collectContent(blocks) {
  let text = '';
  let hasImage = false;
  const parts = [];
  for (const block of blocks) {
    if (!block) continue;
    if (block.type === 'text') { text += block.text || ''; parts.push({ type: 'text', text: block.text || '' }); }
    else if (block.type === 'image') { const url = imageDataUrl(block); if (url) { hasImage = true; parts.push({ type: 'image_url', image_url: { url } }); } }
  }
  return hasImage ? parts : text;
}

export function toOpenAITool(tool) {
  const schema = tool?.input_schema ? { ...tool.input_schema } : { type: 'object', properties: {} };
  delete schema.$schema;
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description || '', parameters: schema },
  };
}

export function toOpenAIToolChoice(choice) {
  switch (choice?.type) {
    case 'auto': return 'auto';
    case 'any': return 'required';
    case 'none': return 'none';
    case 'tool': return { type: 'function', function: { name: choice.name } };
    default: return undefined;
  }
}

export function toolUseToOpenAICall(block) {
  return {
    id: block.id,
    type: 'function',
    function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
  };
}

export function toolResultToOpenAIMessage(block) {
  const content = typeof block.content === 'string'
    ? block.content
    : JSON.stringify(block.content ?? '');
  return { role: 'tool', tool_call_id: block.tool_use_id, content };
}

function normalizeRole(role) {
  return role === 'assistant' || role === 'system' ? role : 'user';
}

/**
 * Append one Anthropic message as one or more OpenAI messages.
 *
 * Anthropic carries `tool_use` inside assistant content and `tool_result` inside
 * user content; OpenAI wants separate `assistant.tool_calls` and `tool` messages.
 */
export function appendAnthropicMessage(out, message) {
  const role = message?.role || 'user';
  const content = message?.content;

  if (typeof content === 'string') {
    if (content.length) out.push({ role: normalizeRole(role), content });
    return;
  }
  if (!Array.isArray(content)) return;

  const textBlocks = [];
  const toolUses = [];
  const toolResults = [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === 'text' || block.type === 'image') textBlocks.push(block);
    else if (block.type === 'tool_use') toolUses.push(block);
    else if (block.type === 'tool_result') toolResults.push(block);
    // `thinking` / `redacted_thinking` are dropped: OpenAI chat has no equivalent.
  }

  if (role === 'assistant') {
    const content = collectContent(textBlocks);
    const assistant = { role: 'assistant', content: typeof content === 'string' ? (content || null) : content };
    if (toolUses.length) assistant.tool_calls = toolUses.map(toolUseToOpenAICall);
    out.push(assistant);
    return;
  }

  // A user turn may carry tool results and text. Tool results must become their
  // own `tool` messages before any plain user text.
  for (const block of toolResults) out.push(toolResultToOpenAIMessage(block));
  const userContent = collectContent(textBlocks);
  if (typeof userContent === 'string' ? userContent.length : userContent.length) {
    out.push({ role: normalizeRole(role), content: userContent });
  }
}

/** Anthropic Messages request body -> OpenAI Chat Completions request body. */
export function anthropicToOpenAIRequest(body, { model }) {
  const messages = [];

  if (typeof body?.system === 'string' && body.system.trim()) {
    messages.push({ role: 'system', content: body.system });
  } else if (Array.isArray(body?.system)) {
    const text = body.system
      .filter((block) => block?.type === 'text')
      .map((block) => block.text || '')
      .join('\n\n')
      .trim();
    if (text) messages.push({ role: 'system', content: text });
  }

  for (const message of body?.messages || []) appendAnthropicMessage(messages, message);

  const request = { model, messages, stream: Boolean(body?.stream) };
  if (Number.isFinite(body?.max_tokens)) request.max_tokens = body.max_tokens;
  if (Number.isFinite(body?.temperature)) request.temperature = body.temperature;
  if (Number.isFinite(body?.top_p)) request.top_p = body.top_p;
  if (Array.isArray(body?.stop_sequences) && body.stop_sequences.length) request.stop = body.stop_sequences;
  if (Array.isArray(body?.tools) && body.tools.length) request.tools = body.tools.map(toOpenAITool);
  const toolChoice = toOpenAIToolChoice(body?.tool_choice);
  if (toolChoice) request.tool_choice = toolChoice;
  return request;
}

function usageFrom(usage) {
  if (!usage) return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
  };
}

/** OpenAI Chat Completions response -> Anthropic Messages response (non-stream). */
export function openAIToAnthropicMessage(completion, { model }) {
  const choice = completion?.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];
  if (typeof message.content === 'string' && message.content.length) {
    content.push({ type: 'text', text: message.content });
  }
  for (const call of message.tool_calls || []) {
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function?.name,
      input: safeJson(call.function?.arguments),
    });
  }
  return {
    id: completion?.id || messageId(),
    type: 'message',
    role: 'assistant',
    model: completion?.model || model,
    content: content.length ? content : [{ type: 'text', text: '' }],
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: usageFrom(completion?.usage),
  };
}

/**
 * Stateful OpenAI chat stream -> Anthropic Messages SSE translator.
 *
 * Feed every parsed OpenAI chunk to `push()` and write the returned strings to
 * the client. Call `finish()` once the upstream stream ends.
 */
export class AnthropicStreamTranslator {
  constructor({ model, id = messageId() } = {}) {
    this.model = model;
    this.id = id;
    this.blockIndex = -1;
    this.openType = null;
    this.tools = new Map();
    this.stopReason = 'end_turn';
    this.outputTokens = 0;
    this.sawContent = false;
  }

  #start(event, data) { return sse(event, data); }

  start() {
    return [
      this.#start('message_start', {
        type: 'message_start',
        message: {
          id: this.id, type: 'message', role: 'assistant', model: this.model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
      this.#start('ping', { type: 'ping' }),
    ];
  }

  #closeOpen() {
    if (!this.openType) return '';
    const event = this.#start('content_block_stop', { type: 'content_block_stop', index: this.blockIndex });
    this.openType = null;
    return event;
  }

  #openText() {
    if (this.openType === 'text') return '';
    let out = this.#closeOpen();
    this.blockIndex += 1;
    this.openType = 'text';
    out += this.#start('content_block_start', {
      type: 'content_block_start', index: this.blockIndex,
      content_block: { type: 'text', text: '' },
    });
    return out;
  }

  #openTool(state) {
    if (state.opened) return '';
    let out = this.#closeOpen();
    this.blockIndex += 1;
    state.opened = true;
    state.blockIndex = this.blockIndex;
    this.openType = 'tool_use';
    out += this.#start('content_block_start', {
      type: 'content_block_start', index: this.blockIndex,
      content_block: { type: 'tool_use', id: state.id, name: state.name, input: {} },
    });
    if (state.args) {
      out += this.#start('content_block_delta', {
        type: 'content_block_delta', index: this.blockIndex,
        delta: { type: 'input_json_delta', partial_json: state.args },
      });
      state.args = '';
    }
    return out;
  }

  push(chunk) {
    let out = '';
    const choice = chunk?.choices?.[0];
    if (choice) {
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content.length) {
        this.sawContent = true;
        out += this.#openText();
        out += this.#start('content_block_delta', {
          type: 'content_block_delta', index: this.blockIndex,
          delta: { type: 'text_delta', text: delta.content },
        });
      }
      for (const call of delta.tool_calls || []) {
        const index = call.index ?? 0;
        const state = this.tools.get(index) || { id: null, name: null, args: '', opened: false, blockIndex: -1 };
        this.tools.set(index, state);
        if (call.id) state.id = call.id;
        if (call.function?.name) state.name = call.function.name;
        const piece = call.function?.arguments || '';
        if (!state.opened && state.id && state.name) out += this.#openTool(state);
        if (state.opened) {
          if (piece) {
            out += this.#start('content_block_delta', {
              type: 'content_block_delta', index: state.blockIndex,
              delta: { type: 'input_json_delta', partial_json: piece },
            });
          }
        } else {
          state.args += piece;
        }
      }
      if (choice.finish_reason) this.stopReason = mapFinishReason(choice.finish_reason);
    }
    if (chunk?.usage?.completion_tokens != null) this.outputTokens = chunk.usage.completion_tokens;
    return out;
  }

  finish() {
    let out = this.#closeOpen();
    if (this.blockIndex < 0 && !this.sawContent) {
      // Anthropic always returns at least one content block.
      out += this.#openText();
      out += this.#closeOpen();
    }
    out += this.#start('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: this.stopReason, stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    });
    out += this.#start('message_stop', { type: 'message_stop' });
    return out;
  }
}

/** Map an upstream OpenAI/HTTP error to an Anthropic error body + status. */
export function openAIErrorToAnthropic(status, body) {
  const detail = body?.error?.message || body?.message || (typeof body === 'string' ? body : '') || `HTTP ${status}`;
  const type = status === 401 || status === 403 ? 'authentication_error'
    : status === 429 ? 'rate_limit_error'
      : status >= 500 ? 'api_error'
        : 'invalid_request_error';
  return {
    status: status === 401 || status === 403 ? 401 : status,
    body: { type: 'error', error: { type, message: String(detail).slice(0, 800) } },
  };
}

/** Very rough token estimate for Claude Code's count_tokens probe. */
export function estimateTokens(body) {
  const text = JSON.stringify(body ?? {});
  return Math.max(1, Math.ceil(text.length / 4));
}
