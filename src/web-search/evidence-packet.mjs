/**
 * P3.1 evidence packet.
 *
 * Chat must answer from a compact packet, never a raw page/search dump:
 * bounded results, deduped by URL, small snippets, and real sources only.
 */

export const EVIDENCE_TEXT_LIMIT = 6000;
export const EVIDENCE_SNIPPET_LIMIT = 400;

export function domainOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return String(url ?? '').slice(0, 80); }
}

export function dedupeSources(sources = [], maxSources = 5) {
  const seen = new Set();
  const out = [];
  for (const source of sources) {
    const url = String(source?.url ?? '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: String(source?.title ?? '').trim() || domainOf(url),
      url,
      ...(source?.snippet ? { snippet: String(source.snippet).slice(0, EVIDENCE_SNIPPET_LIMIT) } : {}),
    });
    if (out.length >= maxSources) break;
  }
  return out;
}

export function buildEvidencePacket({
  providerId = null, providerName = null, billingType = 'UNKNOWN',
  queries = [], sources = [], text = '', maxSources = 5,
} = {}) {
  return {
    providerId,
    providerName,
    billingType,
    queries: [...new Set((queries ?? []).map((q) => String(q).trim()).filter(Boolean))].slice(0, 3),
    sources: dedupeSources(sources, maxSources),
    text: String(text ?? '').trim().slice(0, EVIDENCE_TEXT_LIMIT),
  };
}

/** The compact system instruction handed to the selected Chat model. */
export function formatEvidenceForModel(packet) {
  if (!packet) return null;
  const lines = [
    '联网证据（来自真实搜索结果，仅可使用以下内容作为“当前事实”）：',
    ...(packet.queries.length ? [`检索词：${packet.queries.join(' | ')}`] : []),
    ...(packet.text ? [`证据摘要：\n${packet.text}`] : []),
    '来源：',
    ...packet.sources.map((source) => `- ${source.title} — ${source.url}`),
    '',
    '要求：',
    '- 对“当前/最新”类问题必须依据上述证据回答；',
    '- 不要把模型背景知识说成证据来源；不要编造来源；',
    '- 证据冲突时明确说明冲突；',
    '- 回答末尾保留来源（由 Jarvis 统一附加 Sources 列表）。',
  ];
  return lines.join('\n');
}

/** The user-visible Sources footer. Only real, returned sources are shown. */
export function formatSourcesBlock(packet) {
  if (!packet?.sources?.length) return null;
  return ['Sources:', ...packet.sources.map((source) => `- ${source.title} — ${source.url}`)].join('\n');
}
