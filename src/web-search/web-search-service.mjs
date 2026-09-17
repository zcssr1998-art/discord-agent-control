import { ProviderHealthRegistry, classifyProviderFailure } from '../provider-health.mjs';
import { buildEvidencePacket } from './evidence-packet.mjs';
import { createOpenCodeWebSearchProvider } from './providers/opencode-websearch.mjs';
import { createTavilyProvider } from './providers/tavily.mjs';

/**
 * P3.1 WebSearchService.
 *
 * A small, pluggable search layer for Chat. It owns provider selection, billing
 * gating, health/cooldown and the bounded evidence packet. It never starts a
 * coding Agent and never touches the Work runtime.
 */

export const SEARCH_BILLING = Object.freeze({ FREE: 'FREE', SUBSCRIPTION: 'SUBSCRIPTION', METERED: 'METERED', UNKNOWN: 'UNKNOWN' });

export class WebSearchUnavailable extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'WebSearchUnavailable';
    this.code = 'SEARCH_UNAVAILABLE';
    Object.assign(this, meta);
  }
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0$|\[::1\]$)/i;

/** AUTO preference: FREE > SUBSCRIPTION > METERED > UNKNOWN. */
export function billingRank(billingType) {
  if (billingType === SEARCH_BILLING.FREE) return 0;
  if (billingType === SEARCH_BILLING.SUBSCRIPTION) return 1;
  if (billingType === SEARCH_BILLING.METERED) return 2;
  return 3;
}

/** SSRF guard for any future page fetch: only public http(s) hosts. */
export function isPublicHttpUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (!host || PRIVATE_HOST.test(host) || host.endsWith('.local') || host.endsWith('.internal')) return false;
    return true;
  } catch { return false; }
}

export function extractTextFromHtml(html, { maxChars = 4000 } = {}) {
  const body = String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return body.slice(0, maxChars);
}

export class WebSearchService {
  constructor({ providers = [], health = null, allowMetered = false, maxResults = 5, logger = console } = {}) {
    this.providers = providers;
    this.health = health || new ProviderHealthRegistry();
    this.allowMetered = Boolean(allowMetered);
    this.maxResults = Math.max(1, Math.min(10, Number(maxResults) || 5));
    this.logger = logger;
  }

  list() {
    return this.providers.map((provider) => ({
      id: provider.id, displayName: provider.displayName, billingType: provider.billingType, model: provider.model ?? null,
    }));
  }

  /** AUTO prefers FREE/SUBSCRIPTION; METERED/UNKNOWN only when explicitly allowed. */
  #isAllowed(provider, { providerId }) {
    if (providerId && providerId !== 'auto') return provider.id === providerId;
    if (provider.billingType === SEARCH_BILLING.FREE || provider.billingType === SEARCH_BILLING.SUBSCRIPTION) return true;
    return this.allowMetered;
  }

  async search({ query, providerId = 'auto' } = {}) {
    const q = String(query ?? '').trim();
    if (!q) throw new WebSearchUnavailable('empty search query', { attempted: [] });
    const explicit = Boolean(providerId && providerId !== 'auto');
    const allowed = this.providers
      .filter((provider) => this.#isAllowed(provider, { providerId }))
      .sort((a, b) => billingRank(a.billingType) - billingRank(b.billingType));
    const attempted = [];
    if (!allowed.length) {
      throw new WebSearchUnavailable(
        explicit ? `search provider ${providerId} is not available or not allowed` : 'no allowed search provider is configured',
        { attempted, providerId },
      );
    }
    for (const provider of allowed) {
      if (provider.available === false) { attempted.push({ providerId: provider.id, reason: 'unavailable' }); continue; }
      if (!this.health.canTry(provider.id)) { attempted.push({ providerId: provider.id, reason: 'cooldown' }); continue; }
      try {
        const raw = await provider.search({ query: q, maxResults: this.maxResults });
        this.health.noteSuccess(provider.id);
        const packet = buildEvidencePacket({
          providerId: provider.id,
          providerName: provider.displayName,
          billingType: provider.billingType,
          queries: raw.queries ?? [q],
          sources: raw.sources ?? [],
          text: raw.text ?? '',
          maxSources: this.maxResults,
        });
        return { ok: true, packet, attempted, providerId: provider.id };
      } catch (error) {
        const failure = this.health.noteFailure(provider.id, '*', error);
        attempted.push({ providerId: provider.id, reason: classifyProviderFailure(error), cooldownMs: failure.cooldownMs });
        // An explicit pin fails loud instead of silently switching backends.
        if (explicit) {
          throw new WebSearchUnavailable(`search provider ${providerId} failed: ${error?.message || error}`, { attempted, cause: error });
        }
      }
    }
    throw new WebSearchUnavailable('all search providers are cooling down or failed', { attempted, providerId });
  }

  /** Bounded, SSRF-guarded page read for providers that need page content. */
  async fetchPage(url, { fetchImpl = fetch, maxBytes = 300_000, timeoutMs = 15000 } = {}) {
    if (!isPublicHttpUrl(url)) throw Object.assign(new Error('refusing to fetch a non-public URL'), { code: 'BLOCKED_URL' });
    const signal = Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const response = await fetchImpl(url, { redirect: 'follow', ...(signal ? { signal } : {}) });
    if (!response.ok) throw Object.assign(new Error(`page fetch HTTP ${response.status}`), { code: 'HTTP_ERROR', status: response.status });
    const text = await response.text();
    return extractTextFromHtml(text.slice(0, maxBytes));
  }

  status() {
    return {
      providers: this.list(),
      cooldowns: this.health.list()
        .filter((item) => item.remainingMs > 0)
        .map((item) => ({ providerId: item.providerId, remainingMs: item.remainingMs, lastErrorCode: item.lastErrorCode })),
      allowMetered: this.allowMetered,
      maxResults: this.maxResults,
    };
  }
}

/**
 * Build the service from the existing provider/credential registries.
 *
 * Default backend is the OpenCode Go native `web_search` tool (SUBSCRIPTION, no
 * extra key). A Tavily adapter is added only when TAVILY_API_KEY is configured
 * (METERED, gated behind ALLOW_METERED_WEB_SEARCH).
 */
export function buildWebSearchService({ config = {}, providerManager = null, credentialStore = null, fetchImpl = fetch, logger = console } = {}) {
  const providers = [];
  const opencode = providerManager?.get?.('opencode-go');
  if (opencode) {
    const responsesModels = (opencode.models ?? []).filter((model) => model.transport === 'openai-responses').map((model) => model.id);
    const preferred = config.webSearchModel
      || (responsesModels.includes('grok-4.6') ? 'grok-4.6' : responsesModels[0] || null);
    if (preferred) {
      providers.push(createOpenCodeWebSearchProvider({
        fetchImpl,
        baseUrl: opencode.baseUrl,
        model: preferred,
        getCredential: () => credentialStore?.get?.(opencode.credentialRef) || null,
      }));
    }
  }
  if (process.env.TAVILY_API_KEY) {
    providers.push(createTavilyProvider({ fetchImpl, apiKey: process.env.TAVILY_API_KEY }));
  }
  return new WebSearchService({ providers, allowMetered: config.allowMeteredWebSearch, maxResults: config.webSearchMaxResults, logger });
}
