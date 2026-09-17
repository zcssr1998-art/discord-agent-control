/**
 * P3.1 — native Chat web search.
 *
 * Chat stays lightweight: a deterministic policy decides whether to search, a
 * pluggable search service retrieves real evidence, and the selected Chat model
 * answers from it. No coding Agent / Work session is ever started.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiscordControlPlane } from '../src/discord-ui.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager } from '../src/permission-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { RunLogger } from '../src/logger.mjs';
import { PROTOCOL, TRANSPORT } from '../src/provider-manager.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';
import { decideSearch, deriveQuery, SEARCH_MODE } from '../src/web-search/search-policy.mjs';
import { buildEvidencePacket, formatSourcesBlock, dedupeSources } from '../src/web-search/evidence-packet.mjs';
import {
  WebSearchService, WebSearchUnavailable, isPublicHttpUrl, extractTextFromHtml,
} from '../src/web-search/web-search-service.mjs';
import { parseResponses, createOpenCodeWebSearchProvider } from '../src/web-search/providers/opencode-websearch.mjs';

// ------------------------------------------------------------------ policy

test('P3.1 policy: current-info questions require search, stable questions do not', () => {
  const search = (text, mode = 'auto') => decideSearch(text, { mode }).search;
  assert.equal(search('今天最新的 OpenCode Go 模型有哪些'), true);
  assert.equal(search('什么是 exponential backoff'), false);
  assert.equal(search('不要联网，解释 TCP'), false);
  assert.equal(search('GPT-5.6 Sol 是什么？联网查官方资料'), true);
  assert.equal(search('帮我查一下最新版 CUDA'), true);
  assert.equal(search('联网比较 Grok 4.6 和 Sol'), true);
  assert.equal(search('1+1 等于多少？'), false);
  assert.equal(search('帮我改写这句话'), false);
  assert.equal(search('解释一下闭包'), false);
});

test('P3.1 policy: explicit no-search wins even in always mode; mode off/always behave', () => {
  assert.equal(decideSearch('解释 TCP', { mode: SEARCH_MODE.OFF }).search, false);
  assert.equal(decideSearch('解释 TCP', { mode: SEARCH_MODE.ALWAYS }).search, true);
  assert.equal(decideSearch('不要联网，解释 TCP', { mode: SEARCH_MODE.ALWAYS }).search, false);
  assert.equal(decideSearch('不要联网，解释 TCP', { mode: SEARCH_MODE.ALWAYS }).explicit, true);
  assert.match(deriveQuery('帮我查一下 最新版 CUDA'), /CUDA/);
});

// ------------------------------------------------------------- evidence packet

test('P3.1 evidence: sources are deduped, bounded and only real sources are shown', () => {
  const packet = buildEvidencePacket({
    providerId: 'p', billingType: 'SUBSCRIPTION',
    queries: ['q1', 'q1', 'q2'],
    sources: [
      { title: 'A', url: 'https://a.example/1' },
      { title: 'A dup', url: 'https://a.example/1' },
      { title: 'B', url: 'https://b.example/2' },
      { title: '', url: 'https://c.example/3' },
    ],
    text: 'x'.repeat(9000),
    maxSources: 2,
  });
  assert.equal(packet.sources.length, 2);
  assert.deepEqual(packet.sources.map((s) => s.url), ['https://a.example/1', 'https://b.example/2']);
  assert.equal(packet.queries.length, 2);
  assert.ok(packet.text.length <= 6000);
  const block = formatSourcesBlock(packet);
  assert.match(block, /Sources:/);
  assert.doesNotMatch(block, /c\.example/, 'the source cap must drop the extra source');
});

test('P3.1 evidence: no sources means no fabricated Sources block', () => {
  assert.equal(formatSourcesBlock(buildEvidencePacket({ sources: [] })), null);
  assert.equal(dedupeSources([], 5).length, 0);
});

// -------------------------------------------------------------- web service

test('P3.1 service: AUTO never silently uses a METERED provider', async () => {
  let meteredCalls = 0;
  const metered = { id: 'metered', displayName: 'Metered', billingType: 'METERED', search: async () => { meteredCalls += 1; return { sources: [{ url: 'https://m.example' }], text: 'm' }; } };
  const service = new WebSearchService({ providers: [metered], allowMetered: false });
  await assert.rejects(() => service.search({ query: 'q' }), (error) => error.code === 'SEARCH_UNAVAILABLE');
  assert.equal(meteredCalls, 0, 'AUTO must not spend on a metered provider');
});

test('P3.1 service: default OpenCode provider is SUBSCRIPTION and preferred', async () => {
  const subscription = { id: 'opencode-websearch', displayName: 'OpenCode', billingType: 'SUBSCRIPTION', search: async () => ({ sources: [{ url: 'https://ok.example' }], text: 'ok', queries: ['q'] }) };
  const metered = { id: 'metered', displayName: 'Metered', billingType: 'METERED', search: async () => ({ sources: [], text: '' }) };
  const service = new WebSearchService({ providers: [metered, subscription], allowMetered: true });
  const result = await service.search({ query: 'q' });
  assert.equal(result.providerId, 'opencode-websearch');
});

test('P3.1 service: a 429 cools down the provider and AUTO falls back to another allowed route', async () => {
  let firstCalls = 0;
  const first = { id: 'first', displayName: 'First', billingType: 'FREE', search: async () => { firstCalls += 1; throw Object.assign(new Error('rate limited'), { code: 'RATE_LIMIT' }); } };
  const second = { id: 'second', displayName: 'Second', billingType: 'SUBSCRIPTION', search: async () => ({ sources: [{ url: 'https://second.example' }], text: 'ok' }) };
  const service = new WebSearchService({ providers: [first, second] });
  const result = await service.search({ query: 'q' });
  assert.equal(result.providerId, 'second');
  assert.equal(firstCalls, 1);
  assert.ok(service.status().cooldowns.some((item) => item.providerId === 'first'), 'the 429 provider enters cooldown');
});

test('P3.1 service: an explicit pinned provider fails loud and never silently switches', async () => {
  const pinned = { id: 'pinned', displayName: 'Pinned', billingType: 'SUBSCRIPTION', search: async () => { throw Object.assign(new Error('boom'), { code: 'PROVIDER_ERROR' }); } };
  const other = { id: 'other', displayName: 'Other', billingType: 'SUBSCRIPTION', search: async () => ({ sources: [{ url: 'https://o.example' }], text: 'o' }) };
  const service = new WebSearchService({ providers: [pinned, other] });
  await assert.rejects(() => service.search({ query: 'q', providerId: 'pinned' }), (error) => error.code === 'SEARCH_UNAVAILABLE');
});

test('P3.1 security: SSRF guard blocks private hosts and rewards public ones; html is textified', () => {
  assert.equal(isPublicHttpUrl('https://example.com/a'), true);
  assert.equal(isPublicHttpUrl('http://localhost:8080'), false);
  assert.equal(isPublicHttpUrl('http://127.0.0.1/'), false);
  assert.equal(isPublicHttpUrl('http://192.168.1.5/'), false);
  assert.equal(isPublicHttpUrl('file:///etc/passwd'), false);
  assert.equal(extractTextFromHtml('<html><script>evil()</script><style>x{}</style><p>Hello&nbsp;world</p></html>'), 'Hello world');
});

// ------------------------------------------------------- opencode provider

test('P3.1 provider: OpenCode responses payload parses queries, sources and text', () => {
  const parsed = parseResponses({
    output: [
      { type: 'web_search_call', action: { type: 'search', query: 'q1', sources: [{ type: 'url', url: 'https://s1.example' }] } },
      { type: 'message', content: [{ type: 'output_text', text: 'answer text', annotations: [{ type: 'url_citation', url: 'https://s2.example', title: 'S2' }] }] },
    ],
  });
  assert.deepEqual(parsed.queries, ['q1']);
  assert.equal(parsed.text, 'answer text');
  assert.deepEqual(parsed.sources.map((s) => s.url), ['https://s1.example', 'https://s2.example']);
});

test('P3.1 provider: sends the web_search tool with the OpenCode session header', async () => {
  let seen = null;
  const fetchImpl = async (url, options) => {
    seen = { url, options };
    return { ok: true, status: 200, json: async () => ({ output: [{ type: 'web_search_call', action: { type: 'search', query: 'q', sources: [{ url: 'https://s.example' }] } }] }) };
  };
  const provider = createOpenCodeWebSearchProvider({ fetchImpl, getCredential: () => 'secret', baseUrl: 'https://opencode.ai/zen/go', model: 'grok-4.6', sessionId: () => 'sess-1' });
  const result = await provider.search({ query: 'q' });
  assert.match(seen.url, /\/v1\/responses$/);
  assert.equal(seen.options.headers['x-opencode-session'], 'sess-1');
  const body = JSON.parse(seen.options.body);
  assert.deepEqual(body.tools, [{ type: 'web_search' }]);
  assert.equal(result.sources[0].url, 'https://s.example');
});

// ---------------------------------------------------------------- integration

const OPENCODE_GO = {
  id: 'opencode-go', displayName: 'OpenCode Go', protocol: PROTOCOL.OPENCODE_GO,
  baseUrl: 'https://opencode.ai/zen/go', billingType: 'SUBSCRIPTION', credentialRef: 'provider:opencode-go',
  models: [{ id: 'deepseek-v4.1-flash', transport: TRANSPORT.OPENAI_CHAT }],
};

function makePlane({ webSearch = null, webSearchMode = 'auto' } = {}) {
  const fake = new FakeDiscord({ threadCapable: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p31-plane-'));
  const state = new StateStore(path.join(dir, 'state.json'));
  const chatCalls = [];
  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: dir, claudeCommand: 'claude',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 1000,
      allowPaidFallback: false, taskTimeoutMs: 0, maxWorkFollowUps: 10,
      webSearchMode, webSearchProvider: 'auto',
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 }),
    permissionManager: new PermissionManager(),
    providerManager: {
      list: () => [OPENCODE_GO], get: (id) => (id === OPENCODE_GO.id ? OPENCODE_GO : null), hasCredential: () => true,
    },
    modelManager: { select: async () => {}, list: async () => ({ models: OPENCODE_GO.models }) },
    executorManager: {
      list: () => [], get: () => null, compatible: () => true, compatibleExecutors: () => [],
      resolveTransport: () => TRANSPORT.OPENAI_CHAT, adapterLabel: () => null,
    },
    chatRuntime: {
      send: async (args) => { chatCalls.push(args); return { text: 'CHAT_ANSWER', providerId: 'litellm', providerName: 'LiteLLM', model: 'chat-fast' }; },
      health: { list: () => [], snapshot: () => ({ status: 'healthy' }) },
    },
    webSearch,
    logger: new RunLogger(path.join(dir, 'logs')),
    backendState: { backend: { label: 'opencode-go', model: 'deepseek-v4.1-flash' }, allowPaidFallback: false },
    client: fake.client,
    autoLogin: false,
  });
  return { fake, plane, chatCalls };
}

function fakeSearch() {
  const queries = [];
  return {
    queries,
    status: () => ({ providers: [{ id: 'opencode-websearch', displayName: 'OpenCode', billingType: 'SUBSCRIPTION' }], cooldowns: [], allowMetered: false, maxResults: 5 }),
    search: async ({ query }) => {
      queries.push(query);
      return {
        ok: true,
        packet: buildEvidencePacket({
          providerId: 'opencode-websearch', providerName: 'OpenCode Go Web Search', billingType: 'SUBSCRIPTION',
          queries: [query], sources: [{ title: 'OpenCode Docs', url: 'https://opencode.ai/docs/go/' }], text: 'current info: X',
        }),
      };
    },
  };
}

test('P3.1 integration: a current-info Chat turn searches, answers from evidence, and cites real sources', async (t) => {
  const search = fakeSearch();
  const { fake, plane, chatCalls } = makePlane({ webSearch: search });
  t.after(() => plane.delivery.stop());
  await plane.start();
  plane.sessionManager.setMode(fake.channelId, 'chat');

  await fake.sendAsUser({ content: '今天最新的 OpenCode Go 模型有哪些？' });

  assert.equal(search.queries.length, 1, 'search must run exactly once');
  assert.equal(chatCalls.length, 1, 'exactly one answer phase');
  assert.match(chatCalls[0].system || '', /联网证据/);
  assert.match(chatCalls[0].system || '', /https:\/\/opencode\.ai\/docs\/go\//);
  const text = fake.texts().join('\n');
  assert.match(text, /Sources:/);
  assert.match(text, /https:\/\/opencode\.ai\/docs\/go\//);
  assert.match(text, /Web/, 'footer marks the turn as web-backed');
  // Chat search never starts a Work/Agent session.
  assert.equal(plane.tasks.size, 0);
  assert.equal(plane.runners.size, 0);
});

test('P3.1 integration: stable questions and explicit no-search never call the search service', async (t) => {
  const search = fakeSearch();
  const { fake, plane } = makePlane({ webSearch: search });
  t.after(() => plane.delivery.stop());
  await plane.start();
  plane.sessionManager.setMode(fake.channelId, 'chat');

  await fake.sendAsUser({ content: '什么是 exponential backoff' });
  await fake.sendAsUser({ content: '不要联网，解释 TCP' });
  assert.equal(search.queries.length, 0);
});

test('P3.1 integration: search failure degrades gracefully and never fails Chat', async (t) => {
  const failing = {
    status: () => ({ providers: [], cooldowns: [], allowMetered: false, maxResults: 5 }),
    search: async () => { throw new WebSearchUnavailable('provider down', { attempted: [] }); },
  };
  const { fake, plane, chatCalls } = makePlane({ webSearch: failing });
  t.after(() => plane.delivery.stop());
  await plane.start();
  plane.sessionManager.setMode(fake.channelId, 'chat');

  await fake.sendAsUser({ content: '今天最新的 CUDA 版本是多少？联网核实' });
  assert.equal(chatCalls.length, 1, 'the model still answers');
  const text = fake.texts().join('\n');
  assert.match(text, /搜索不可用/);
  assert.match(text, /CHAT_ANSWER/);
});

test('P3.1 integration: the search query is redacted before it leaves Jarvis', async (t) => {
  const search = fakeSearch();
  const { fake, plane } = makePlane({ webSearch: search });
  t.after(() => plane.delivery.stop());
  await plane.start();
  plane.sessionManager.setMode(fake.channelId, 'chat');

  const fixture = 'sk-ABCDEFGH1234567890';
  await fake.sendAsUser({ content: `今天最新的消息 ${fixture}` });
  assert.equal(search.queries.length, 1);
  assert.ok(!search.queries[0].includes(fixture), 'the secret must not be sent to the search provider');
  assert.match(search.queries[0], /sk-\*\*\*\*7890/);
});

test('P3.1 integration: !search reports provider/billing and toggles the runtime mode', async (t) => {
  const search = fakeSearch();
  const { fake, plane } = makePlane({ webSearch: search });
  t.after(() => plane.delivery.stop());
  await plane.start();

  await fake.sendAsUser({ content: '!search' });
  assert.ok(fake.texts().some((text) => /联网搜索状态/.test(text) && /SUBSCRIPTION/.test(text)));
  await fake.sendAsUser({ content: '!search on' });
  assert.equal(plane.webSearchMode, 'always');
  await fake.sendAsUser({ content: '!search off' });
  assert.equal(plane.webSearchMode, 'off');
});
