#!/usr/bin/env node
/**
 * P3.1 real-machine smoke: native Chat web search on the real OpenCode Go setup.
 *
 * Real: the OpenCode Go credential/provider, `WebSearchService` (native
 * `web_search` tool), `ChatRuntime` (real model answer). No Discord transport and
 * no coding Agent / Work session.
 *
 *   node scripts/p31-chat-websearch-e2e.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChatRuntime } from '../src/chat-runtime.mjs';
import { buildWebSearchService } from '../src/web-search/web-search-service.mjs';
import { decideSearch, deriveQuery } from '../src/web-search/search-policy.mjs';
import { formatEvidenceForModel, formatSourcesBlock } from '../src/web-search/evidence-packet.mjs';
import { readOpenCodeGoKey } from '../src/litellm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
};

const raw = JSON.parse(fs.readFileSync(path.join(root, 'data', 'providers.json'), 'utf8'));
const container = raw.providers ?? raw;
const opencode = Object.values(container).find((provider) => provider?.id === 'opencode-go');
if (!opencode) { console.log('FAIL no opencode-go provider configured'); process.exit(1); }
const key = readOpenCodeGoKey();
if (!key) { console.log('FAIL no OpenCode Go credential available'); process.exit(1); }

const providerManager = {
  get: (id) => (id === 'opencode-go' ? opencode : null),
  list: () => [opencode],
  hasCredential: (provider) => provider?.id === 'opencode-go',
  listModels: async () => ({ models: opencode.models ?? [] }),
};
const credentialStore = { get: (ref) => (ref === 'provider:opencode-go' ? key : null) };

const config = { webSearchModel: 'grok-4.6', allowMeteredWebSearch: false, webSearchMaxResults: 5 };
const webSearch = buildWebSearchService({ config, providerManager, credentialStore });
const chatRuntime = new ChatRuntime({ providerManager, credentialStore, timeoutMs: 0, allowMeteredFallback: false });

const prompt = 'OpenCode Go 现在有哪些模型？请联网核实并给出当前信息。';
const decision = decideSearch(prompt, { mode: 'auto' });
check('policy: current-info question requires search', decision.search, `reason=${decision.reason}`);
check('policy: explicit no-search is honored', decideSearch('不要联网，解释 TCP', { mode: 'always' }).search === false);

let packet = null;
try {
  const outcome = await webSearch.search({ query: deriveQuery(prompt), providerId: 'auto' });
  packet = outcome.packet;
  check('search: real backend returned evidence', Boolean(packet), `provider=${packet.providerId} billing=${packet.billingType}`);
  check('search: billing is not metered in AUTO', packet.billingType !== 'METERED', `billing=${packet.billingType}`);
  check('search: real sources returned', packet.sources.length > 0, `${packet.sources.length} source(s)`);
} catch (error) {
  check('search: real backend returned evidence', false, `${String(error?.message || error)} attempted=${JSON.stringify(error?.attempted ?? [])}`);
  if (error?.cause) console.log('cause:', String(error.cause?.message || error.cause).slice(0, 300));
}

if (packet) {
  console.log('sources:');
  for (const source of packet.sources.slice(0, 5)) console.log(`  - ${source.title} — ${source.url}`);
  const system = formatEvidenceForModel(packet);
  const answer = await chatRuntime.send({
    messages: [{ role: 'user', content: prompt }],
    system,
    providerId: 'opencode-go',
    model: 'deepseek-v4.1-flash',
  });
  const sourcesBlock = formatSourcesBlock(packet);
  const delivered = [answer.text, sourcesBlock].filter(Boolean).join('\n\n');
  check('chat: model answered from evidence', /.{20,}/.test(answer.text || ''), `${(answer.durationMs / 1000).toFixed(1)}s model=${answer.model}`);
  check('chat: delivered answer carries real sources', delivered.includes('Sources:') && delivered.includes(packet.sources[0].url));
  console.log('\n--- delivered (truncated) ---');
  console.log(delivered.slice(0, 900));
}

const failed = results.filter((result) => !result.ok);
console.log(`\nP3.1 chat web search smoke: ${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;
