/**
 * Tavily search provider (P3.1 optional keyed backend).
 *
 * Billing class METERED: AUTO must never silently use it. It is only selected
 * when the owner explicitly allows metered search or pins this provider.
 */

export function createTavilyProvider({
  fetchImpl = fetch,
  apiKey = null,
  baseUrl = 'https://api.tavily.com',
  timeoutMs = 30000,
} = {}) {
  return {
    id: 'tavily',
    displayName: 'Tavily',
    billingType: 'METERED',
    async search({ query, maxResults = 5 } = {}) {
      if (!apiKey) throw Object.assign(new Error('Tavily API key missing'), { code: 'INVALID_CREDENTIAL' });
      const signal = Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
      let response;
      try {
        response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/search`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            query: String(query ?? ''),
            max_results: Math.max(1, Math.min(10, Number(maxResults) || 5)),
            include_answer: true,
            search_depth: 'basic',
          }),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        throw Object.assign(new Error(timeout ? 'web search timed out' : 'web search unreachable'), {
          code: timeout ? 'TIMEOUT' : 'UNREACHABLE',
        });
      }
      let data = null;
      try { data = await response.json(); } catch { /* handled below */ }
      if (!response.ok) {
        const status = Number(response?.status || 0);
        const code = status === 401 || status === 403 ? 'INVALID_CREDENTIAL'
          : status === 402 ? 'QUOTA'
            : status === 429 ? 'RATE_LIMIT'
              : status >= 500 ? 'PROVIDER_ERROR' : 'HTTP_ERROR';
        throw Object.assign(new Error(data?.detail || data?.message || `HTTP ${status}`), { code, status });
      }
      const sources = (data?.results ?? [])
        .map((result) => ({ title: result?.title, url: result?.url, snippet: result?.content }))
        .filter((source) => source.url);
      const text = data?.answer || sources.map((source) => source.snippet).filter(Boolean).join('\n').slice(0, 4000);
      if (!sources.length && !text) throw Object.assign(new Error('web search returned no evidence'), { code: 'EMPTY_RESPONSE' });
      return { queries: [String(query ?? '')], sources, text };
    },
  };
}
