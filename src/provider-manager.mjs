import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { maskSecret, redactSecrets } from './secrets.mjs';

export const PROTOCOL = {
  WORKBUDDY: 'workbuddy',
  OPENAI: 'openai-compatible',
  ANTHROPIC: 'anthropic-compatible',
  OPENCODE_GO: 'opencode-go',
};

export const TRANSPORT = {
  ANTHROPIC_MESSAGES: 'anthropic-messages',
  OPENAI_CHAT: 'openai-chat',
  OPENAI_RESPONSES: 'openai-responses',
  UNKNOWN: 'unknown',
};

const WORKBUDDY = {
  id: 'workbuddy-free', displayName: 'WorkBuddy Free', protocol: PROTOCOL.WORKBUDDY,
  baseUrl: null, billingType: 'FREE', credentialRef: null, models: [], modelsFetchedAt: null,
  source: 'built-in', removable: false,
};

const OPENCODE_GO = {
  id: 'opencode-go', displayName: 'OpenCode Go', protocol: PROTOCOL.OPENCODE_GO,
  baseUrl: 'https://opencode.ai/zen/go', modelsEndpoint: 'https://opencode.ai/zen/go/v1/models',
  billingType: 'SUBSCRIPTION', credentialRef: 'provider:opencode-go', models: [], modelsFetchedAt: null,
  source: 'built-in-special', removable: false,
};

/**
 * Transport is a property of the *model*, not the provider: OpenCode Go serves
 * different model families over different protocols. The families below come
 * from the official endpoint table at
 * https://opencode.ai/docs/go/#endpoints (retrieved 2026-09-15):
 *
 *   /v1/messages         anthropic-messages -> minimax-*, qwen3.x
 *   /v1/chat/completions openai-chat        -> glm-*, kimi-*, longcat-*, deepseek-*, mimo-*, hy*
 *   /v1/responses        openai-responses   -> gpt-*, grok-*, muse-*
 *
 * Verified against the live model list on 2026-09-15 (37 models). A model that
 * matches no documented family stays `unknown` on purpose: the bridge never
 * guesses a protocol it cannot verify, and an `unknown` model can never be
 * selected for a real Executor.
 */
const OPENCODE_GO_TRANSPORT_FAMILIES = [
  { transport: TRANSPORT.ANTHROPIC_MESSAGES, match: /^(?:minimax-|qwen)/ },
  { transport: TRANSPORT.OPENAI_RESPONSES, match: /^(?:gpt-|grok-|muse-)/ },
  { transport: TRANSPORT.OPENAI_CHAT, match: /^(?:glm-|kimi-|longcat-|deepseek-|mimo-|hy\d)/ },
];

export function openCodeGoTransport(modelId) {
  const id = String(modelId || '').toLowerCase();
  for (const family of OPENCODE_GO_TRANSPORT_FAMILIES) {
    if (family.match.test(id)) return family.transport;
  }
  return TRANSPORT.UNKNOWN;
}

/** Anthropic `/v1/messages` path per transport, used for real minimal probes. */
const TRANSPORT_PROBE = {
  [TRANSPORT.ANTHROPIC_MESSAGES]: { path: '/v1/messages', body: (model) => ({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }) },
  [TRANSPORT.OPENAI_CHAT]: { path: '/v1/chat/completions', body: (model) => ({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }) },
  [TRANSPORT.OPENAI_RESPONSES]: { path: '/v1/responses', body: (model) => ({ model, input: 'ping', max_output_tokens: 16 }) },
};

function isOpenCodeGoUrl(baseUrl) {
  const url = new URL(baseUrl);
  return url.hostname.toLowerCase() === 'opencode.ai' && /^\/zen\/go(?:\/v1)?\/?$/i.test(url.pathname);
}

export function normalizeBaseUrl(raw) {
  let url;
  try { url = new URL(String(raw ?? '').trim()); } catch { throw Object.assign(new Error('invalid Base URL'), { code: 'INVALID_URL' }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw Object.assign(new Error('invalid Base URL'), { code: 'INVALID_URL' });
  }
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function endpoint(baseUrl, suffix) {
  const url = new URL(baseUrl);
  let basePath = url.pathname.replace(/\/+$/, '');
  let tail = suffix;
  if (basePath.endsWith('/v1') && tail.startsWith('/v1/')) tail = tail.slice(3);
  url.pathname = `${basePath}${tail}`.replace(/\/{2,}/g, '/');
  return url.toString();
}

function endpoints(baseUrl, suffix) {
  return [...new Set([endpoint(baseUrl, `/v1${suffix}`), endpoint(baseUrl, suffix)])];
}

function authHeaders(protocol, secret) {
  return protocol === PROTOCOL.OPENAI
    ? { authorization: `Bearer ${secret}` }
    : { 'x-api-key': secret, 'anthropic-version': '2023-06-01' };
}

function extractModels(body, transportForModel = null) {
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null;
  if (!rows) return null;
  return rows.map((model) => {
    if (typeof model === 'string') return { id: model, displayName: model, metadata: {} };
    const id = model?.id || model?.name;
    return id ? {
      id,
      displayName: model.display_name || model.displayName || id,
      ...(transportForModel ? { transport: transportForModel(id) } : {}),
      metadata: redactSecrets({ ...model }),
    } : null;
  }).filter(Boolean);
}

function providerIdentity(baseUrl) {
  const host = new URL(baseUrl).hostname.toLowerCase();
  if (host === 'api.deepseek.com' || host.endsWith('.deepseek.com')) return 'DeepSeek';
  if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) return 'OpenRouter';
  if (host.includes('minimax')) return 'MiniMax';
  if (host.endsWith('bigmodel.cn') || host.endsWith('z.ai')) return 'GLM';
  if (host.includes('opencode')) return 'OpenCode Go';
  return null;
}

async function request(fetchImpl, url, { method = 'GET', headers = {}, body, timeoutMs }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const code = error?.name === 'TimeoutError' ? 'TIMEOUT' : 'UNREACHABLE';
    throw Object.assign(new Error(code === 'TIMEOUT' ? 'provider request timed out' : 'provider is unreachable'), { code });
  }
  let data = null;
  try { data = await response.json(); } catch { /* A non-JSON 404 is simply not this protocol. */ }
  return { response, data };
}

function protocolError(protocol, body, status) {
  const error = body?.error;
  const looksRight = protocol === PROTOCOL.ANTHROPIC
    ? body?.type === 'error' && Boolean(error?.type || error?.message)
    : Boolean(error && (error.message || error.type || error.code));
  if (!looksRight) return false;
  return status !== 404 || /model/i.test(`${error?.code || ''} ${error?.type || ''} ${error?.message || ''}`);
}

function errorDetails(data) {
  const item = data?.error ?? data ?? {};
  return {
    providerCode: item?.code || item?.type || null,
    providerMessage: redactSecrets(item?.message || ''),
  };
}

function httpError(response, data) {
  const details = errorDetails(data);
  const code = response.status === 401 || response.status === 403 ? 'INVALID_CREDENTIAL'
    : response.status === 402 ? 'QUOTA'
      : response.status === 429 ? 'RATE_LIMIT'
        : response.status >= 500 ? 'PROVIDER_ERROR' : 'HTTP_ERROR';
  return Object.assign(new Error(details.providerMessage || `HTTP ${response.status}`), {
    code, status: response.status, providerCode: details.providerCode,
  });
}

async function probeProtocol(fetchImpl, baseUrl, secret, protocol, timeoutMs) {
  let authFailed = false;
  for (const url of endpoints(baseUrl, '/models')) {
    const { response, data } = await request(fetchImpl, url, { headers: authHeaders(protocol, secret), timeoutMs });
    const models = response.ok ? extractModels(data) : null;
    if (models) return { valid: true, models };
    if (response.status === 401 || response.status === 403) authFailed = true;
  }

  const isOpenAI = protocol === PROTOCOL.OPENAI;
  const url = endpoint(baseUrl, isOpenAI ? '/v1/chat/completions' : '/v1/messages');
  const body = isOpenAI
    ? { model: '__discord_agent_control_probe__', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
    : { model: '__discord_agent_control_probe__', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
  const { response, data } = await request(fetchImpl, url, {
    method: 'POST', headers: authHeaders(protocol, secret), body, timeoutMs,
  });
  if (response.ok || protocolError(protocol, data, response.status)) {
    if (response.status === 401 || response.status === 403) return { valid: false, authFailed: true };
    return { valid: true, models: [] };
  }
  return { valid: false, authFailed };
}

export function providerErrorMessage(error) {
  const suffix = [error?.status ? `HTTP ${error.status}` : null, error?.providerCode].filter(Boolean).join(' · ');
  const detail = suffix ? `（${suffix}）` : '';
  const messages = {
    INVALID_URL: '❌ Base URL 无效。',
    UNREACHABLE: '❌ 无法连接 API。',
    TIMEOUT: '❌ Provider 请求超时。',
    INVALID_CREDENTIAL: '❌ API 凭据无效。',
    QUOTA: '❌ Provider 余额或额度不足。',
    RATE_LIMIT: '❌ Provider 达到频率或额度限制。',
    PROVIDER_ERROR: '❌ Provider 服务异常。',
    MODEL_INVALID: '❌ Model ID 无效或真实调用失败。',
    INCOMPATIBLE: '❌ 当前执行器不支持此模型协议。',
    WORKBUDDY_QUOTA: '❌ WorkBuddy 当前额度不足。',
    WORKBUDDY_UNAVAILABLE: '❌ WorkBuddy 当前不可用。',
  };
  return `${messages[error?.code] || '❌ Provider 请求失败。'}${detail}`;
}

export class ProviderManager {
  constructor({ file, credentialStore, fetchImpl = fetch, cacheMs = 45 * 60 * 1000, timeoutMs = 10000, now = () => Date.now() }) {
    this.file = file;
    this.credentialStore = credentialStore;
    this.fetchImpl = fetchImpl;
    this.cacheMs = cacheMs;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.profiles = new Map([
      [WORKBUDDY.id, { ...WORKBUDDY }],
      [OPENCODE_GO.id, { ...OPENCODE_GO }],
    ]);
    let stored = [];
    try { stored = JSON.parse(fs.readFileSync(file, 'utf8'))?.providers ?? []; }
    catch { /* first run or a corrupt user file: built-ins remain available */ }
    for (const profile of stored) {
      if (!profile?.id || String(profile.source).startsWith('built-in')) continue;
      this.profiles.set(profile.id, profile);
    }
    // Built-in-special providers keep their definition in code but may reuse the
    // last successful dynamic model cache from disk.
    for (const profile of stored) {
      const builtin = profile?.id ? this.profiles.get(profile.id) : null;
      if (!builtin || profile.source !== 'built-in-special') continue;
      if (Array.isArray(profile.models) && profile.models.length) {
        builtin.models = profile.models;
        builtin.modelsFetchedAt = profile.modelsFetchedAt ?? null;
      }
    }
  }

  list() { return [...this.profiles.values()]; }

  get(id) { return this.profiles.get(id) ?? null; }

  hasCredential(profile) { return !profile?.credentialRef || this.credentialStore.has(profile.credentialRef); }

  noteWorkbuddyModel(model) {
    if (!model) return;
    const profile = this.get(WORKBUDDY.id);
    profile.models = [{ id: model, displayName: model, metadata: {} }];
    profile.modelsFetchedAt = new Date(this.now()).toISOString();
  }

  setWorkbuddyHealth(status, error = null) {
    const profile = this.get(WORKBUDDY.id);
    profile.healthStatus = status;
    profile.healthError = error ? redactSecrets(error) : null;
  }

  nextId() {
    let number = 1;
    while (this.profiles.has(`custom-${number}`)) number += 1;
    return `custom-${number}`;
  }

  async addGeneric({ baseUrl: rawBaseUrl, secret }) {
    const baseUrl = normalizeBaseUrl(rawBaseUrl);
    if (String(secret ?? '').trim().length < 8) throw Object.assign(new Error('credential is too short'), { code: 'INVALID_CREDENTIAL' });
    const id = this.nextId();
    const credentialRef = `provider:${id}`;
    this.credentialStore.set(credentialRef, secret);
    try {
      const detected = await this.detect(baseUrl, secret);
      if (!detected) return { needsProtocol: true, pending: { id, baseUrl, credentialRef } };
      return this.#finish({ id, baseUrl, credentialRef, ...detected });
    } catch (error) {
      this.credentialStore.remove(credentialRef);
      throw error;
    }
  }

  async completePending(pending, protocol) {
    const secret = this.credentialStore.get(pending?.credentialRef);
    if (!secret) throw Object.assign(new Error('credential missing'), { code: 'INVALID_CREDENTIAL' });
    try {
      const result = await probeProtocol(this.fetchImpl, pending.baseUrl, secret, protocol, this.timeoutMs);
      if (!result.valid) {
        const code = result.authFailed ? 'INVALID_CREDENTIAL' : 'UNREACHABLE';
        throw Object.assign(new Error('protocol validation failed'), { code });
      }
      return this.#finish({ ...pending, protocol, models: result.models });
    } catch (error) {
      this.credentialStore.remove(pending.credentialRef);
      throw error;
    }
  }

  async detect(baseUrl, secret) {
    const openai = await probeProtocol(this.fetchImpl, baseUrl, secret, PROTOCOL.OPENAI, this.timeoutMs);
    if (openai.valid) return { protocol: PROTOCOL.OPENAI, models: openai.models };
    const anthropic = await probeProtocol(this.fetchImpl, baseUrl, secret, PROTOCOL.ANTHROPIC, this.timeoutMs);
    if (anthropic.valid) return { protocol: PROTOCOL.ANTHROPIC, models: anthropic.models };
    if (openai.authFailed || anthropic.authFailed) throw Object.assign(new Error('credential rejected'), { code: 'INVALID_CREDENTIAL' });
    return null;
  }

  #finish({ id, baseUrl, credentialRef, protocol, models }) {
    const knownName = providerIdentity(baseUrl);
    const profile = {
      id,
      displayName: knownName || `自定义 API #${id.split('-').at(-1)}`,
      protocol,
      baseUrl,
      billingType: 'UNKNOWN',
      credentialRef,
      models,
      modelsFetchedAt: models.length ? new Date(this.now()).toISOString() : null,
      source: 'discord',
      removable: true,
      metadata: knownName ? { identifiedBy: 'domain' } : {},
    };
    this.profiles.set(id, profile);
    this.save();
    return { profile, credentialMask: maskSecret(this.credentialStore.get(credentialRef)), modelsMissing: models.length === 0 };
  }

  async listModels(providerId, { force = false } = {}) {
    const profile = this.get(providerId);
    if (!profile) throw Object.assign(new Error('provider not found'), { code: 'PROVIDER_NOT_FOUND' });
    if (profile.protocol === PROTOCOL.WORKBUDDY) return { models: profile.models ?? [], stale: false, missing: !profile.models?.length };
    const fetchedAt = Date.parse(profile.modelsFetchedAt || 0);
    if (!force && profile.models?.length && this.now() - fetchedAt < this.cacheMs) {
      return { models: profile.models, stale: false, missing: false };
    }
    const secret = this.credentialStore.get(profile.credentialRef);
    if (!secret) throw Object.assign(new Error('credential missing'), { code: 'INVALID_CREDENTIAL' });
    const transportForModel = profile.protocol === PROTOCOL.OPENCODE_GO ? openCodeGoTransport : null;
    const urls = profile.modelsEndpoint ? [profile.modelsEndpoint] : endpoints(profile.baseUrl, '/models');
    try {
      for (const url of urls) {
        const { response, data } = await request(this.fetchImpl, url, {
          headers: authHeaders(profile.protocol, secret), timeoutMs: this.timeoutMs,
        });
        if ([401, 402, 403, 429].includes(response.status) || response.status >= 500) throw httpError(response, data);
        const models = response.ok ? extractModels(data, transportForModel) : null;
        if (!models) continue;
        profile.models = models;
        profile.modelsFetchedAt = new Date(this.now()).toISOString();
        this.save();
        return { models, stale: false, missing: models.length === 0 };
      }
      throw Object.assign(new Error('models endpoint unavailable'), { code: 'MODELS_UNAVAILABLE' });
    } catch (error) {
      if (profile.models?.length) return { models: profile.models, stale: true, missing: false, error };
      if (error.code === 'MODELS_UNAVAILABLE') return { models: [], stale: false, missing: true, error };
      throw error;
    }
  }

  async validateModel(providerId, modelId) {
    const profile = this.get(providerId);
    const secret = profile && this.credentialStore.get(profile.credentialRef);
    if (!profile || !secret || !modelId) throw Object.assign(new Error('model validation input missing'), { code: 'MODEL_INVALID' });

    if (profile.protocol === PROTOCOL.OPENCODE_GO) {
      // Verify with a real minimal request on the model's own transport. An
      // `unknown` transport cannot be verified, so it is refused instead of
      // being selected on faith.
      const transport = openCodeGoTransport(modelId);
      const probe = TRANSPORT_PROBE[transport];
      if (!probe) throw Object.assign(new Error('unsupported model transport'), { code: 'MODEL_INVALID' });
      const { response, data } = await request(this.fetchImpl, endpoint(profile.baseUrl, probe.path), {
        method: 'POST',
        headers: { ...authHeaders(profile.protocol, secret), 'x-opencode-session': `dac-validate-${randomUUID()}` },
        timeoutMs: this.timeoutMs,
        body: probe.body(modelId),
      });
      if (!response.ok) {
        const error = httpError(response, data);
        if (error.code === 'HTTP_ERROR') error.code = 'MODEL_INVALID';
        throw error;
      }
      this.#rememberModel(profile, { id: modelId, displayName: modelId, transport, metadata: { source: 'manual' } });
      return true;
    }

    const openai = profile.protocol === PROTOCOL.OPENAI;
    const { response, data } = await request(this.fetchImpl, endpoint(profile.baseUrl, openai ? '/v1/chat/completions' : '/v1/messages'), {
      method: 'POST', headers: authHeaders(profile.protocol, secret), timeoutMs: this.timeoutMs,
      body: { model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
    });
    if (!response.ok) {
      const error = httpError(response, data);
      if (error.code === 'HTTP_ERROR') error.code = 'MODEL_INVALID';
      throw error;
    }
    this.#rememberModel(profile, { id: modelId, displayName: modelId, metadata: { source: 'manual' } });
    return true;
  }

  #rememberModel(profile, model) {
    if (profile.models.some((existing) => existing.id === model.id)) return;
    profile.models.push(model);
    profile.modelsFetchedAt = new Date(this.now()).toISOString();
    this.save();
  }

  async health(providerId) {
    const profile = this.get(providerId);
    if (!profile) return { ok: false, error: Object.assign(new Error('provider not found'), { code: 'PROVIDER_NOT_FOUND' }) };
    if (profile.protocol === PROTOCOL.WORKBUDDY) {
      const status = profile.healthStatus || 'PASS';
      return status === 'PASS'
        ? { ok: true }
        : { ok: false, error: Object.assign(new Error(profile.healthError || status), {
          code: status === 'BLOCKED_BY_QUOTA' ? 'WORKBUDDY_QUOTA' : 'WORKBUDDY_UNAVAILABLE',
        }) };
    }
    try { await this.listModels(providerId, { force: true }); return { ok: true }; }
    catch (error) { return { ok: false, error }; }
  }

  remove(id) {
    const profile = this.get(id);
    if (!profile) return false;
    if (!profile.removable) throw Object.assign(new Error('built-in provider cannot be removed'), { code: 'BUILTIN_PROVIDER' });
    this.credentialStore.remove(profile.credentialRef);
    this.profiles.delete(id);
    this.save();
    return true;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    const providers = this.list().filter((profile) => !String(profile.source).startsWith('built-in'));
    const cached = this.list().filter((profile) => profile.source === 'built-in-special');
    fs.writeFileSync(temporary, JSON.stringify({ providers: redactSecrets([...providers, ...cached]) }, null, 2), 'utf8');
    fs.renameSync(temporary, this.file);
  }
}
