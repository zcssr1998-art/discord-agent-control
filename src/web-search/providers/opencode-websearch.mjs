/**
 * OpenCode Go native web search (P3.1 default provider).
 *
 * The installed OpenCode CLI has no standalone search API for Node, but the
 * OpenCode Go Responses transport accepts the OpenAI `web_search` tool on our
 * existing SUBSCRIPTION credential. That gives real web results + source URLs
 * without any extra search key and without starting a coding Agent.
 *
 * Verified on the real account (2026-09-18): POST `/v1/responses` with
 * `tools:[{type:'web_search'}]` returns `web_search_call` actions carrying the
 * query + source URLs and a final `message` with the answer text.
 */

const RESPONSES_PATH = '/v1/responses';

const SEARCH_PROMPT = (query) => [
  '请联网搜索并核实下面的问题。',
  '只输出简明的要点事实（不要长篇大论），并在要点中标注 [n] 对应来源序号。',
  '不要编造；如果搜索没有找到相关信息，直接说明没有找到。',
  '',
  `问题：${query}`,
].join('\n');

export function parseResponses(data) {
  const queries = [];
  const sources = [];
  let text = '';
  for (const item of data?.output ?? []) {
    if (item?.type === 'web_search_call' && item.action?.type === 'search') {
      if (item.action.query) queries.push(item.action.query);
      for (const source of item.action.sources ?? []) {
        if (source?.url) sources.push({ url: source.url, title: source.title || null });
      }
    }
    if (item?.type === 'message') {
      for (const part of item.content ?? []) {
        if (typeof part?.text === 'string' && part.text.trim()) {
          text += `${text ? '\n' : ''}${part.text}`;
        }
        for (const annotation of part?.annotations ?? []) {
          const citation = annotation?.url_citation ?? annotation;
          const url = annotation?.url || citation?.url;
          if (url) sources.push({ url, title: annotation?.title || citation?.title || null });
        }
      }
    }
  }
  return { queries, sources, text: text.trim() };
}

export function createOpenCodeWebSearchProvider({
  fetchImpl = fetch,
  getCredential,
  baseUrl,
  model = 'grok-4.6',
  // Per-attempt safety deadline only (P3.0 policy). A multi-query native web
  // search can legitimately take tens of seconds; this bounds a stalled socket,
  // it is not a total task cap.
  timeoutMs = 60000,
  sessionId = () => `jarvis-search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
} = {}) {
  return {
    id: 'opencode-websearch',
    displayName: 'OpenCode Go Web Search',
    billingType: 'SUBSCRIPTION',
    model,
    async search({ query } = {}) {
      const secret = getCredential?.();
      if (!secret) throw Object.assign(new Error('OpenCode Go credential missing'), { code: 'INVALID_CREDENTIAL' });
      const body = {
        model,
        tools: [{ type: 'web_search' }],
        input: [{ role: 'user', content: SEARCH_PROMPT(String(query ?? '').trim()) }],
      };
      // Per-attempt safety deadline only (P3.0 policy): a stalled search never
      // hangs the Chat turn forever, and its failure degrades gracefully.
      const signal = Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
      const url = `${String(baseUrl ?? '').replace(/\/+$/, '')}${RESPONSES_PATH}`;
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${secret}`,
            'x-opencode-session': sessionId(),
          },
          body: JSON.stringify(body),
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
        throw Object.assign(new Error(data?.error?.message || `HTTP ${status}`), { code, status });
      }
      const parsed = parseResponses(data);
      if (!parsed.sources.length && !parsed.text) {
        throw Object.assign(new Error('web search returned no evidence'), { code: 'EMPTY_RESPONSE' });
      }
      return parsed;
    },
  };
}
