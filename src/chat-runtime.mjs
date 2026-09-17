import { randomUUID } from 'node:crypto';
import { PROTOCOL, TRANSPORT, openCodeGoTransport } from './provider-manager.mjs';
import { ProviderHealthRegistry, classifyProviderFailure } from './provider-health.mjs';

const DEFAULT_MODEL_PATTERNS = Object.freeze([
  // LiteLLM logical alias for the safe AUTO route. The gateway owns the
  // DeepSeek -> GLM fallback behind this alias.
  /^chat-fast$/i,
  /^chat-smart$/i,
  // Direct-provider preference, most specific first.
  /^deepseek-v4\.1-flash$/i,
  /^deepseek-v4-flash$/i,
  /^deepseek.*flash/i,
  /^glm-5\.3-flash$/i,
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

/**
 * Message content is transport-neutral in Jarvis:
 *   - a plain string, or
 *   - an array of `{ type: 'text', text }` / `{ type: 'image', mediaType, data }`.
 * Each transport maps that to its own multimodal shape. This keeps Chat history,
 * OpenAI Chat Completions, OpenAI Responses, Anthropic Messages and LiteLLM on
 * one representation instead of branching at every call site.
 */
export function hasImageContent(messages) {
  return (messages ?? []).some((message) => Array.isArray(message?.content)
    && message.content.some((part) => part?.type === 'image'));
}

function toOpenAIContent(content) {
  if (typeof content === 'string') return content;
  return (content ?? []).map((part) => (part?.type === 'image'
    ? { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } }
    : { type: 'text', text: String(part?.text ?? '') }));
}

function toResponsesContent(content) {
  if (typeof content === 'string') return content;
  return (content ?? []).map((part) => (part?.type === 'image'
    ? { type: 'input_image', image_url: `data:${part.mediaType};base64,${part.data}` }
    : { type: 'input_text', text: String(part?.text ?? '') }));
}

function toAnthropicContent(content) {
  if (typeof content === 'string') return content;
  return (content ?? []).map((part) => (part?.type === 'image'
    ? { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } }
    : { type: 'text', text: String(part?.text ?? '') }));
}

function hasContent(messages) {
  if (!messages.length) return false;
  return messages.some((message) => {
    if (typeof message.content === 'string') return message.content.trim().length > 0;
    return Array.isArray(message.content) && message.content.length > 0;
  });
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

/**
 * Provider preference for AUTO. Lower is better:
 *   0 LiteLLM gateway (primary standard route)
 *   1 OpenCode Go direct (special/escape hatch)
 *   2 other FREE, 3 other SUBSCRIPTION, 4 metered/unknown
 */
function providerRank(profile) {
  if (profile?.id === 'litellm') return 0;
  if (profile?.id === 'opencode-go') return 1;
  if (profile?.billingType === 'FREE') return 2;
  if (profile?.billingType === 'SUBSCRIPTION') return 3;
  return 4;
}

function modelOnlyRank(profile, model, patterns) {
  // A provider with no model information (unreachable gateway) is treated as
  // its top preference so a skipped primary still counts as a downgrade.
  if (!model) return providerRank(profile) * 1000 + 0;
  return providerRank(profile) * 1000 + rankModel(model.id, patterns);
}

export class ChatRuntime {
  constructor({
    providerManager,
    credentialStore,
    fetchImpl = fetch,
    health = null,
    timeoutMs = 120000,
    maxOutputTokens = 8192,
    preferredModelPatterns = DEFAULT_MODEL_PATTERNS,
    allowMeteredFallback = false,
    visionRoute = null,
  }) {
    this.providers = providerManager;
    this.credentials = credentialStore;
    this.fetchImpl = fetchImpl;
    this.health = health || new ProviderHealthRegistry();
    this.timeoutMs = timeoutMs;
    // Only transports that require an explicit output ceiling (Anthropic
    // Messages) use this. OpenAI-compatible transports stay uncapped.
    this.maxOutputTokens = maxOutputTokens;
    this.preferredModelPatterns = [...preferredModelPatterns];
    this.allowMeteredFallback = allowMeteredFallback;
    // A configured image-capable route (e.g. a LiteLLM `vision` alias). AUTO
    // image turns must never be sent to a known text-only alias blindly.
    this.visionRoute = visionRoute;
  }

  async candidates({ providerId = 'auto', model = null, image = false } = {}) {
    return (await this.#resolveCandidates({ providerId, model, image })).candidates;
  }

  async #resolveCandidates({ providerId = 'auto', model = null, image = false }) {
    const profiles = providerId && providerId !== 'auto'
      ? [this.providers.get(providerId)].filter(Boolean)
      : this.providers.list()
        .filter((profile) => profile.protocol !== PROTOCOL.WORKBUDDY)
        .filter((profile) => this.providers.hasCredential(profile))
        .filter((profile) => usableBilling(profile, this.allowMeteredFallback))
        .sort((a, b) => providerRank(a) - providerRank(b));

    const output = [];
    const skipped = [];
    for (const profile of profiles) {
      if (!profile || profile.protocol === PROTOCOL.WORKBUDDY || !this.providers.hasCredential(profile)) continue;
      let models = Array.isArray(profile.models) ? profile.models : [];
      if (!models.length) {
        try { models = (await this.providers.listModels(profile.id)).models || []; }
        catch {
          // An unreachable gateway has no alias list; record it so a reply served
          // by a lower route is still attributed as a fallback.
          skipped.push({ providerId: profile.id, model: null, reason: 'unavailable', rank: modelOnlyRank(profile, null, this.preferredModelPatterns) });
          continue;
        }
      }
      const selected = model
        ? models.filter((item) => item.id === model || item.displayName === model)
        : [...models].sort((a, b) => rankModel(a.id, this.preferredModelPatterns) - rankModel(b.id, this.preferredModelPatterns));
      // The gateway owns its own fallback behind the primary AUTO alias
      // (chat-fast). Other aliases are manual pins only, so AUTO must not fan
      // out across them and hammer a dead gateway.
      const chosen = !model && providerId === 'auto' && profile.id === 'litellm' ? selected.slice(0, 1) : selected;
      for (const item of chosen) {
        if (this.health.canTry(profile.id, item.id)) output.push({ profile, model: item });
        else skipped.push({ providerId: profile.id, model: item.id, reason: 'cooldown', rank: modelOnlyRank(profile, item, this.preferredModelPatterns) });
      }
    }

    // An image turn must not be sent to a text-only AUTO candidate. When a
    // vision route is configured, AUTO narrows to it; otherwise AUTO refuses
    // rather than silently dropping the image.
    if (image && providerId === 'auto') {
      const route = this.visionRoute;
      const vision = route
        ? output.filter((candidate) => candidate.profile.id === route.providerId
          && (!route.model || candidate.model.id === route.model))
        : [];
      if (!vision.length) {
        throw Object.assign(new Error('no image-capable chat route is configured'), { code: 'NO_VISION_ROUTE' });
      }
      return { candidates: vision, skipped };
    }

    return { candidates: output, skipped };
  }

  async send({ prompt = null, messages = null, providerId = 'auto', model = null, system = null } = {}) {
    const history = Array.isArray(messages) && messages.length
      ? messages
      : (String(prompt ?? '').trim() ? [{ role: 'user', content: String(prompt).trim() }] : []);
    if (!hasContent(history)) throw Object.assign(new Error('chat prompt is empty'), { code: 'EMPTY_PROMPT' });
    const { candidates, skipped } = await this.#resolveCandidates({ providerId, model, image: hasImageContent(history) });
    if (!candidates.length) throw Object.assign(new Error('no healthy chat provider/model is available'), { code: 'NO_CHAT_PROVIDER' });

    const attempts = [];
    for (const candidate of candidates) {
      const startedAt = Date.now();
      try {
        const result = await this.#request({ ...candidate, messages: history, system });
        this.health.noteSuccess(candidate.profile.id, candidate.model.id);
        // A reply is a fallback when a failed attempt happened in this turn OR
        // when a more-preferred route was skipped (unreachable gateway or its
        // cooldown). Without the second case, a direct answer while the primary
        // gateway is down would look like a normal route.
        const servedRank = modelOnlyRank(candidate.profile, candidate.model, this.preferredModelPatterns);
        const downgraded = skipped.some((entry) => entry.rank < servedRank);
        return {
          ...result,
          providerId: candidate.profile.id,
          providerName: candidate.profile.displayName,
          model: candidate.model.id,
          durationMs: Date.now() - startedAt,
          attempts,
          skipped,
          fallback: attempts.length > 0 || downgraded,
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

  async #request({ profile, model, messages, system }) {
    const secret = profile.credentialRef ? this.credentials.get(profile.credentialRef) : null;
    if (!secret) throw Object.assign(new Error('credential missing'), { code: 'INVALID_CREDENTIAL' });

    let transport = null;
    if (profile.protocol === PROTOCOL.OPENCODE_GO) transport = model.transport || openCodeGoTransport(model.id);
    else if (profile.protocol === PROTOCOL.OPENAI) transport = TRANSPORT.OPENAI_CHAT;
    else if (profile.protocol === PROTOCOL.ANTHROPIC) transport = TRANSPORT.ANTHROPIC_MESSAGES;
    if (!transport || transport === TRANSPORT.UNKNOWN) throw Object.assign(new Error('unsupported chat transport'), { code: 'INCOMPATIBLE' });

    const headers = { accept: 'application/json', 'content-type': 'application/json' };
    if (profile.protocol === PROTOCOL.OPENAI) headers.authorization = `Bearer ${secret}`;
    else if (profile.protocol === PROTOCOL.OPENCODE_GO && transport !== TRANSPORT.ANTHROPIC_MESSAGES) {
      // OpenCode Go authenticates /v1/chat/completions and /v1/responses with a
      // bearer token; only /v1/messages uses x-api-key (verified on the real
      // account). Using x-api-key here returns 401 Missing API key.
      headers.authorization = `Bearer ${secret}`;
    } else headers['x-api-key'] = secret;
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
          ...messages.map((message) => ({ role: message.role, content: toOpenAIContent(message.content) })),
        ],
        stream: false,
      };
      parse = textFromOpenAIChat;
    } else if (transport === TRANSPORT.OPENAI_RESPONSES) {
      url = endpoint(profile.baseUrl, '/v1/responses');
      body = {
        model: model.id,
        input: [
          ...(system ? [{ role: 'system', content: String(system) }] : []),
          ...messages.map((message) => ({ role: message.role, content: toResponsesContent(message.content) })),
        ],
      };
      parse = textFromResponses;
    } else {
      url = endpoint(profile.baseUrl, '/v1/messages');
      body = {
        model: model.id,
        ...(Number.isFinite(this.maxOutputTokens) && this.maxOutputTokens > 0
          ? { max_tokens: this.maxOutputTokens }
          : {}),
        ...(system ? { system: String(system) } : {}),
        messages: messages.map((message) => ({ role: message.role, content: toAnthropicContent(message.content) })),
      };
      parse = textFromAnthropic;
    }

    // CHAT_TIMEOUT_MS=0 means no client-side deadline: never pass an invalid
    // timeout into AbortSignal.timeout (that would throw synchronously).
    const signal = Number.isFinite(this.timeoutMs) && this.timeoutMs > 0
      ? AbortSignal.timeout(this.timeoutMs)
      : undefined;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
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
    // When the reply came through LiteLLM, the alias (chat-fast) is what Jarvis
    // asked for; this header carries the concrete upstream deployment/model for
    // attribution without Jarvis reimplementing the router.
    const upstreamModel = typeof response.headers?.get === 'function'
      ? response.headers.get('x-litellm-model-id')
      : null;
    return { text: output, raw: data, ...(upstreamModel ? { upstreamModel } : {}) };
  }
}
