import { randomUUID } from 'node:crypto';
import { PROTOCOL, TRANSPORT, openCodeGoTransport } from './provider-manager.mjs';
import { ProviderHealthRegistry, classifyProviderFailure } from './provider-health.mjs';

const DEFAULT_MODEL_PATTERNS = Object.freeze([
  /^deepseek-v4(?:\.1)?-flash$/i,
  /^deepseek.*flash/i,
  /^glm-5(?:\.3)?-flash$/i,
  /^glm.*flash/i,
  /^minimax/i,
  /^qwen/i,
  /^kimi/i,
  /^gemini.*flash/i,
  /^gpt-.*(?:mini|nano)/i,
]);

function endpoint(baseUrl, suffix) {
  const url = new URL(baseUrl);
  let basePath = url.pathname.replace(/\/+$/, '');
  let tail = suffix;
  if (basePath.endsWith('/v1') && tail.startsWith('/v1/')) tail = tail.slice(3);
  url.pathname = `${basePath}${tail}`.replace(/\/{2,}/g, '/');
  return url.toString();
}

function textFromOpenAIChat(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((item) => item?.text || item?.content || '').join('').trim();
  return '';
}

function textFromAnthropic(data) {
  return Array.isArray(data?.content)
    ? data.content.filter((item) => item?.type === 'text').map((item) => item.text || '').join('').trim()
    : '';
}

function textFromResponses(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  const output = Array.isArray(data?.output) ? data.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const text = part?.text ?? part?.content;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('').trim();
}

function httpError(response, data) {
  const status = Number(response?.status || 0);
  const code = status === 401 || status === 403 ? 'INVALID_CREDENTIAL'
    : status === 402 ? 'QUOTA'
      : status === 429 ? 'RATE_LIMIT'
        : status >= 500 ? 'PROVIDER_ERROR' : 'HTTP_ERROR';
  const message = data?.error?.message || data?.message || `HTTP ${status}`;
  return Object.assign(new Error(String(message)), { code, status });
}

function rankModel(modelId, patterns) {
  const id = String(modelId || '');
  const index = patterns.findIndex((pattern) => pattern.test(id));
  return index === -1 ? patterns.length + 1 : index;
}

function usableBilling(profile, allowMeteredFallback) {
  if (!profile) return false;
  // AUTO must never surprise the user with metered/unknown billing. Explicit
  // provider selection may still use those providers.
  if (['FREE', 'SUBSCRIPTION'].includes(profile.billingType)) return true;
  return Boolean(allowMeteredFallback);
}

export class ChatRuntime {
  constructor({
    providerManager,
    credentialStore,
    fetchImpl = fetch,
    health = null,
    timeoutMs = 25000,
    preferredModelPatterns = DEFAULT_MODEL_PATTERNS,
    allowMeteredFallback = false,
  }) {
    this.providers = providerManager;
    this.credentials = credentialStore;
    this.fetchImpl = fetchImpl;
    this.health = health || new ProviderHealthRegistry();
    this.timeoutMs = timeoutMs;
    this.preferredModelPatterns = [...preferredModelPatterns];
    this.allowMeteredFallback = allowMeteredFallback;
  }

  async candidates({ providerId = 'auto', model = null } = {}) {
    const profiles = providerId && providerId !== 'auto'
      ? [this.providers.get(providerId)].filter(Boolean)
      : this.providers.list()
        .filter((profile) => profile.protocol !== PROTOCOL.WORKBUDDY)
        .filter((profile) => this.providers.hasCredential(profile))
        .filter((profile) => usableBilling(profile, this.allowMeteredFallback))
        .sort((a, b) => {
          const score = (p) => p.id === 'opencode-go' ? 0 : p.billingType === 'FREE' ? 1 : p.billingType === 'SUBSCRIPTION' ? 2 : 3;
          return score(a) - score(b);
        });

    const output = [];
    for (const profile of profiles) {
      if (!profile || profile.protocol === PROTOCOL.WORKBUDDY || !this.providers.hasCredential(profile)) continue;
      let models = Array.isArray(profile.models) ? profile.models : [];
      if (!models.length) {
        try { models = (await this.providers.listModels(profile.id)).models || []; }
        catch { continue; }
      }
      const selected = model
        ? models.filter((item) => item.id === model || item.displayName === model)
        : [...models].sort((a, b) => rankModel(a.id, this.preferredModelPatterns) - rankModel(b.id, this.preferredModelPatterns));
      for (const item of selected) {
        if (this.health.canTry(profile.id, item.id)) output.push({ profile, model: item });
      }
    }
    return output;
  }

  async send({ prompt, providerId = 'auto', model = null, system = null } = {}) {
    const text = String(prompt ?? '').trim();
    if (!text) throw Object.assign(new Error('chat prompt is empty'), { code: 'EMPTY_PROMPT' });
    const candidates = await this.candidates({ providerId, model });
    if (!candidates.length) throw Object.assign(new Error('no healthy chat provider/model is available'), { code: 'NO_CHAT_PROVIDER' });

    const attempts = [];
    for (const candidate of candidates) {
      const startedAt = Date.now();
      try {
        const result = await this.#request({ ...candidate, prompt: text, system });
        this.health.noteSuccess(candidate.profile.id, candidate.model.id);
        return {
          ...result,
          providerId: candidate.profile.id,
          providerName: candidate.profile.displayName,
          model: candidate.model.id,
          durationMs: Date.now() - startedAt,
          attempts,
        };
      } catch (error) {
        const failure = this.health.noteFailure(candidate.profile.id, candidate.model.id, error);
        attempts.push({
          providerId: candidate.profile.id,
          model: candidate.model.id,
          code: classifyProviderFailure(error),
          cooldownMs: failure.cooldownMs,
        });
        // Manual pin means manual pin: never silently cross providers/models.
        if (providerId !== 'auto' || model) throw Object.assign(error, { attempts });
      }
    }
    throw Object.assign(new Error('all chat providers failed'), { code: 'ALL_CHAT_PROVIDERS_FAILED', attempts });
  }

  async #request({ profile, model, prompt, system }) {
    const secret = profile.credentialRef ? this.credentials.get(profile.credentialRef) : null;
    if (!secret) throw Object.assign(new Error('credential missing'), { code: 'INVALID_CREDENTIAL' });

    let transport = null;
    if (profile.protocol === PROTOCOL.OPENCODE_GO) transport = model.transport || openCodeGoTransport(model.id);
    else if (profile.protocol === PROTOCOL.OPENAI) transport = TRANSPORT.OPENAI_CHAT;
    else if (profile.protocol === PROTOCOL.ANTHROPIC) transport = TRANSPORT.ANTHROPIC_MESSAGES;
    if (!transport || transport === TRANSPORT.UNKNOWN) throw Object.assign(new Error('unsupported chat transport'), { code: 'INCOMPATIBLE' });

    const headers = { accept: 'application/json', 'content-type': 'application/json' };
    if (profile.protocol === PROTOCOL.OPENAI) headers.authorization = `Bearer ${secret}`;
    else headers['x-api-key'] = secret;
    if (profile.protocol === PROTOCOL.ANTHROPIC || transport === TRANSPORT.ANTHROPIC_MESSAGES) headers['anthropic-version'] = '2023-06-01';
    if (profile.protocol === PROTOCOL.OPENCODE_GO) headers['x-opencode-session'] = `jarvis-chat-${randomUUID()}`;

    let url;
    let body;
    let parse;
    if (transport === TRANSPORT.OPENAI_CHAT) {
      url = endpoint(profile.baseUrl, '/v1/chat/completions');
      body = {
        model: model.id,
        messages: [
          ...(system ? [{ role: 'system', content: String(system) }] : []),
          { role: 'user', content: prompt },
        ],
        stream: false,
      };
      parse = textFromOpenAIChat;
    } else if (transport === TRANSPORT.OPENAI_RESPONSES) {
      url = endpoint(profile.baseUrl, '/v1/responses');
      body = { model: model.id, input: system ? `${system}\n\n${prompt}` : prompt };
      parse = textFromResponses;
    } else {
      url = endpoint(profile.baseUrl, '/v1/messages');
      body = {
        model: model.id,
        max_tokens: 4096,
        ...(system ? { system: String(system) } : {}),
        messages: [{ role: 'user', content: prompt }],
      };
      parse = textFromAnthropic;
    }

    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const code = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE';
      throw Object.assign(new Error(code === 'TIMEOUT' ? 'chat provider timed out' : 'chat provider unreachable'), { code });
    }

    let data = null;
    try { data = await response.json(); } catch { /* handled below */ }
    if (!response.ok) throw httpError(response, data);
    const output = parse(data);
    if (!output) throw Object.assign(new Error('provider returned no assistant text'), { code: 'EMPTY_RESPONSE' });
    return { text: output, raw: data };
  }
}
