/**
 * P3.1 deterministic web-search decision.
 *
 * Cheap, testable and model-free: it only decides whether a Chat turn should
 * retrieve current web evidence. It never runs a coding Agent and never makes a
 * network call. Obvious cases are decided here; ambiguous cases simply skip
 * search (the task prefers a small, predictable policy over a giant keyword list).
 */

export const SEARCH_MODE = Object.freeze({ AUTO: 'auto', OFF: 'off', ALWAYS: 'always' });

const EXPLICIT_NO_SEARCH = [
  /不要联网/, /不用联网/, /别联网/, /不要搜索/, /不用搜索/, /别搜/, /无需搜索/, /不联网/,
  /\bno\s+search\b/i, /without\s+searching/i, /don'?t\s+search/i, /\bsearch\s+off\b/i,
];

const EXPLICIT_SEARCH = [
  /联网/, /搜一下/, /搜索一下/, /帮我搜/, /帮我查/, /查一下/, /查找一下/, /查查/, /搜搜/,
  /最新/, /今天/, /今日/, /现在/, /当前/, /近期/, /近来/, /刚刚?发布/, /刚出/, /官网/, /官方资料/, /官方公告/, /实时/,
  /\bsearch\b/i, /\blook\s*up\b/i, /\bbrowse\b/i, /\blatest\b/i, /\bcurrent\b/i, /\btoday\b/i,
  /\bnow\b/i, /\bnews\b/i, /\brelease[sd]?\b/i, /\bversion\b/i, /\bprice[sd]?\b/i, /\bweather\b/i,
  /股价/, /天气/, /版本/, /发布/, /价格/, /新闻/, /赛程/, /比分/,
];

const STABLE_TASK = [
  /^翻译/, /^把.+翻译/, /^rewrite\b/i, /^summari[sz]e\b/i, /^改写/, /^润色/, /^总结(下面|以上|这段|这篇)/,
  /^解释一下/, /^解释下/, /^什么是/, /^什么叫/, /^define\b/i, /^explain\b/i,
  /^[\d\s+\-*/().]+=?[\d\s+\-*/().]*$/,
];

export function normalizeMode(mode) {
  const value = String(mode ?? '').trim().toLowerCase();
  if (value === SEARCH_MODE.OFF || value === 'false' || value === '0') return SEARCH_MODE.OFF;
  if (value === SEARCH_MODE.ALWAYS || value === 'on' || value === 'true' || value === '1') return SEARCH_MODE.ALWAYS;
  return SEARCH_MODE.AUTO;
}

/**
 * Strip the explicit search/opt-out phrasing and assistant mention so the public
 * search query is the user's question, not the internal prompt. Bounded so a
 * huge pasted prompt never becomes the query.
 */
export function deriveQuery(prompt, { maxLength = 400 } = {}) {
  const cleaned = String(prompt ?? '')
    .replace(/<@!?\d+>/g, ' ')
    .replace(/(联网|搜索一下|搜一下|帮我搜|帮我查|查一下|查找一下|搜搜|查查|不要联网|不用联网|别联网|不要搜索|不用搜索|别搜|无需搜索|不联网)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || String(prompt ?? '').trim()).slice(0, maxLength);
}

export function decideSearch(text, { mode = SEARCH_MODE.AUTO } = {}) {
  const prompt = String(text ?? '').trim();
  const normalized = normalizeMode(mode);
  if (!prompt) return { search: false, reason: 'empty', explicit: false, query: null };
  // An explicit per-turn opt-out always wins, even when search is forced.
  if (EXPLICIT_NO_SEARCH.some((pattern) => pattern.test(prompt))) {
    return { search: false, reason: 'explicit-no-search', explicit: true, query: null };
  }
  if (normalized === SEARCH_MODE.OFF) return { search: false, reason: 'mode-off', explicit: false, query: null };

  const explicit = EXPLICIT_SEARCH.some((pattern) => pattern.test(prompt));
  if (normalized === SEARCH_MODE.ALWAYS) {
    return { search: true, reason: 'mode-always', explicit, query: deriveQuery(prompt) };
  }
  // AUTO: stable self-contained tasks skip search unless the user explicitly
  // asked for it.
  if (!explicit && STABLE_TASK.some((pattern) => pattern.test(prompt))) {
    return { search: false, reason: 'stable-task', explicit: false, query: null };
  }
  if (explicit) return { search: true, reason: 'explicit-intent', explicit: true, query: deriveQuery(prompt) };
  return { search: false, reason: 'auto-stable', explicit: false, query: null };
}
