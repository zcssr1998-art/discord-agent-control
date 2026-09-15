/**
 * Local compatibility gateway.
 *
 * Claude Code always speaks the Anthropic Messages protocol. When the selected
 * OpenCode Go model is served over OpenAI Chat Completions, this gateway sits on
 * 127.0.0.1 between them:
 *
 *   Claude Code --(Anthropic Messages)--> CompatGateway --(OpenAI Chat)--> OpenCode Go
 *
 * It is a protocol translator only. It never runs tools and never drives an
 * agent loop; Claude Code keeps doing that.
 *
 * Security properties:
 *  - binds 127.0.0.1 on an ephemeral port only, never 0.0.0.0;
 *  - the real OpenCode Go credential stays inside this process. The Claude Code
 *    child only ever sees a random per-gateway local token, so the upstream key
 *    is never in the agent's environment;
 *  - only a small allowlist of headers is forwarded upstream;
 *  - in-flight upstream requests are aborted when the gateway closes, so `!stop`
 *    leaves no dangling fetch.
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  anthropicToOpenAIRequest,
  openAIToAnthropicMessage,
  AnthropicStreamTranslator,
  openAIErrorToAnthropic,
  estimateTokens,
} from './protocol-adapters/anthropic-to-openai-chat.mjs';
import { redactSecrets } from './secrets.mjs';

function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) { reject(new Error('request body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

export class CompatGateway {
  constructor({ provider, credential, model, transport, fetchImpl = fetch, timeoutMs = 0 }) {
    this.provider = provider;
    this.credential = credential;
    this.model = model;
    this.transport = transport;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.token = `local-${randomBytes(18).toString('hex')}`;
    this.sessionFallback = `dac-${randomBytes(12).toString('hex')}`;
    this.server = null;
    this.port = null;
    this.controllers = new Set();
    /** Every upstream call, for the model-truth assertions in tests/E2E. */
    this.upstreamRequests = [];
  }

  get url() {
    if (!this.port) throw new Error('gateway has not been started');
    return `http://127.0.0.1:${this.port}`;
  }

  async start() {
    if (this.server) return this.url;
    this.server = http.createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        if (!res.headersSent) writeJson(res, 500, { type: 'error', error: { type: 'api_error', message: redactSecrets(error?.message || String(error)) } });
        else res.end();
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
    return this.url;
  }

  async close() {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(resolve));
  }

  async #handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/hello') {
      // Claude Code probes connectivity here before sending messages.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hello: 'compat-gateway' }));
      return;
    }
    if (req.method !== 'POST' || (url.pathname !== '/v1/messages' && url.pathname !== '/v1/messages/count_tokens')) {
      writeJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: `no route for ${req.method} ${url.pathname}` } });
      return;
    }
    if (req.headers['x-api-key'] !== this.token && req.headers.authorization !== `Bearer ${this.token}`) {
      writeJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid local gateway credential' } });
      return;
    }

    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw || '{}'); } catch {
      writeJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } });
      return;
    }

    if (url.pathname === '/v1/messages/count_tokens') {
      writeJson(res, 200, { input_tokens: estimateTokens(body) });
      return;
    }

    if (body.stream) await this.#stream(req, res, body);
    else await this.#complete(res, body);
  }

  #upstreamHeaders(req) {
    const session = req.headers['x-claude-code-session-id']
      || req.headers['x-session-id']
      || req.headers['x-opencode-session']
      || this.sessionFallback;
    return {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${this.credential}`,
      // OpenCode Go needs a stable session identity for routing/prompt cache.
      'x-opencode-session': session,
      'x-claude-code-session-id': session,
      'user-agent': 'discord-agent-control/0.1 (claude-code adapter)',
    };
  }

  async #openUpstream(body, { stream, req }) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const signal = this.timeoutMs ? AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeoutMs)]) : controller.signal;
    this.upstreamRequests.push({ url: `${this.provider.baseUrl}/v1/chat/completions`, model: body.model, stream });
    try {
      const response = await this.fetchImpl(`${this.provider.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: this.#upstreamHeaders(req),
        body: JSON.stringify(body),
        signal,
      });
      return { response, controller };
    } catch (error) {
      this.controllers.delete(controller);
      throw error;
    }
  }

  async #complete(res, anthropicBody) {
    const request = anthropicToOpenAIRequest(anthropicBody, { model: this.model });
    request.stream = false;
    let upstream;
    try {
      upstream = await this.#openUpstream(request, { stream: false, req: { headers: {} } });
    } catch (error) {
      writeJson(res, 502, { type: 'error', error: { type: 'api_error', message: redactSecrets(error?.message || String(error)) } });
      return;
    }
    const { response, controller } = upstream;
    try {
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const mapped = openAIErrorToAnthropic(response.status, data);
        writeJson(res, mapped.status, mapped.body);
        return;
      }
      writeJson(res, 200, openAIToAnthropicMessage(data, { model: this.model }));
    } finally {
      this.controllers.delete(controller);
    }
  }

  async #stream(req, res, anthropicBody) {
    const request = anthropicToOpenAIRequest(anthropicBody, { model: this.model });
    request.stream = true;

    let upstream;
    try {
      upstream = await this.#openUpstream(request, { stream: true, req });
    } catch (error) {
      writeJson(res, 502, { type: 'error', error: { type: 'api_error', message: redactSecrets(error?.message || String(error)) } });
      return;
    }
    const { response, controller } = upstream;

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      const mapped = openAIErrorToAnthropic(response.status, parsed);
      this.controllers.delete(controller);
      writeJson(res, mapped.status, mapped.body);
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const translator = new AnthropicStreamTranslator({ model: this.model });
    res.write(translator.start().join(''));

    let aborted = false;
    res.on('close', () => {
      if (!res.writableEnded) { aborted = true; controller.abort(); }
    });

    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let chunk;
          try { chunk = JSON.parse(payload); } catch { continue; }
          res.write(translator.push(chunk));
        }
      }
      if (!aborted) {
        res.write(translator.finish());
        res.end();
      }
    } catch (error) {
      if (!aborted && !res.writableEnded) {
        res.write(translator.finish());
        res.end();
      }
    } finally {
      this.controllers.delete(controller);
    }
  }
}

export function createCompatGateway(options) {
  return new CompatGateway(options);
}
