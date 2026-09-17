# Jarvis V4 P3.1 — Native Chat Web Search

## Goal

Give Jarvis Chat a first-class web-search capability similar to modern consumer AI chat products: normal chat stays lightweight, but questions that depend on current information can automatically search the public web, retrieve relevant pages, and answer with source links/citations.

This must **not** route ordinary Chat through the Work/coding-agent runtime.

Target architecture:

```text
Discord Chat
  -> Jarvis Chat Orchestrator
      -> freshness/search decision
          -> no search needed -> existing ChatRuntime -> model
          -> search needed    -> WebSearchService -> compact evidence
                              -> existing ChatRuntime -> model + evidence
```

The search layer is a Chat product capability, not a coding Agent.

## Why this design

Current Jarvis Chat calls the OpenCode Go/model API directly. The selected model can say it wants to search, but the ChatRuntime currently does not expose a web-search tool or perform retrieval on the model's behalf.

Modern chat products use the same broad pattern:

- ChatGPT can automatically search when current information would help, while stable questions are answered directly.
- Claude can be given a web-search server tool and then decides whether to search during the same chat turn.
- DeepSeek's consumer search mode retrieves public internet information and then has the model synthesize an answer.
- Doubao/Volcengine supports both always-on and on-demand web search, including built-in Web Search through Responses-style APIs.

Jarvis should copy the **product pattern**, not any vendor-specific implementation.

## Ordering

This task runs **after** `JARVIS_V4_P3_0_TIMEOUT_POLICY_CLEANUP.md` passes and before `JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`.

Reason: P3.0 and P3.1 both touch Chat/network behavior. Finish the timeout/recovery semantics first so P3.1 does not build on an unstable request path.

## Core product behavior

### 1. AUTO web search is the default

Jarvis Chat should behave like a normal modern AI chat:

- stable/general knowledge -> answer directly, no search;
- current/recent/changing facts -> search automatically;
- explicit search intent such as `联网`, `搜一下`, `查一下`, `最新`, `今天`, `当前`, `现在`, `官方资料`, `官网`, `刚发布` -> search;
- explicit `不要联网` / `不用搜索` -> do not search for that turn;
- follow-up questions inherit conversation context but search is still decided per turn.

Do **not** perform a web search on every message.

### 2. No coding Agent startup

A normal Chat web-search turn must not:

- create a Work session;
- start Claude Code/OpenCode/Codex as a coding Agent;
- scan a workspace;
- initialize coding tools;
- use approval hooks intended for Work;
- change files or run shell commands.

Search is a lightweight Chat service.

### 3. Search decision must be cheap

Preferred order:

1. deterministic freshness/explicit-intent rules;
2. model-assisted search decision only when ambiguity materially matters;
3. no separate expensive model call for obvious cases.

Examples that should deterministically trigger search:

```text
今天 MU 为什么涨？
GPT-5.6 Sol 是什么？
OpenCode Go 现在有哪些模型？
帮我查一下最新版 CUDA
联网比较 Grok 4.6 和 Sol
```

Examples that should normally skip search:

```text
什么是指数退避？
帮我改写这句话
1+1 等于多少？
解释一下闭包
```

### 4. Search provider is pluggable

Create a small provider abstraction, for example:

```text
WebSearchService
  -> search(query)
  -> fetch(url)
```

Do not hard-wire Jarvis to one search vendor.

Supported/considered backends should include the smallest practical subset of:

- OpenCode Websearch / hosted Websearch when available through the installed OpenCode environment;
- Exa;
- Tavily;
- Parallel;
- Firecrawl;
- another existing provider only if it is already available and lower-complexity.

Reuse mature upstream search capability; do not build a search engine or scrape Google/Bing HTML.

### 5. Prefer existing OpenCode search capability, but verify it

OpenCode already exposes `websearch`/`webfetch` and its current docs provide programmatic server/SDK access. Prefer reusing this when the real Windows/OpenCode installation exposes a stable supported API **without starting a coding Agent per message**.

Important:

- verify the installed OpenCode version and actual supported API on the real machine;
- do not assume old and new OpenCode websearch docs have identical billing/auth behavior;
- OpenCode hosted Websearch may be separately metered in newer Console versions;
- if a search route is metered, it must be explicitly classified and visible;
- never silently enable a paid search backend merely because the model wants fresher data.

If the installed OpenCode search capability cannot be used safely/cheaply outside a full Agent session, use the smallest supported direct search-provider adapter instead.

### 6. Billing safety

Add search billing metadata similar to the existing model-provider policy:

```text
FREE
SUBSCRIPTION
METERED
UNKNOWN
```

Rules:

- explicit user request to search may use a configured/allowed search route;
- AUTO search must prefer FREE/SUBSCRIPTION routes;
- AUTO must not silently use METERED/UNKNOWN unless owner explicitly enables it;
- if no allowed search provider is available, answer from model knowledge with a visible `Web search unavailable` note instead of silently spending;
- never expose API keys/tokens in logs, Discord or repository.

### 7. Evidence, not raw web dumps

Do not pass entire pages/search dumps into the model by default.

For each search turn:

1. search with one concise query or a bounded small set of queries;
2. keep top relevant results;
3. fetch only pages needed to answer;
4. extract title, URL, date/time when available, and the smallest relevant content;
5. dedupe repeated domains/results;
6. construct a bounded Evidence Packet;
7. provide that packet to the selected Chat model.

Suggested budget target:

```text
normal search turn evidence: <= 4k–8k tokens
simple current-fact lookup: much smaller
```

Do not recursively browse dozens of pages for normal Chat. Deep-research behavior is a separate future capability.

### 8. Sources must be visible

When web search was used, the final Discord response must make that visible and preserve useful source attribution.

Minimum UX:

```text
回答正文...

Sources:
- <title> — <domain/url>
- <title> — <domain/url>

💬 Chat · OpenCode Go · grok-4.6 · Web · 4.2s
```

Exact renderer may match current Jarvis style.

Do not fabricate citations. Only show sources actually returned/fetched by the search path.

### 9. Failure semantics

Search failure must be distinct from model failure.

Examples:

```text
Search: DEGRADED (provider unavailable)
Model answer: delivered from built-in knowledge
```

or, when the user explicitly required live verification:

```text
Search unavailable; current fact could not be verified.
```

Do not make an otherwise healthy Chat session unusable because one search provider is down.

Do not create infinite retry loops. Reuse P3.0 network/retry semantics.

### 10. Search state and cooldown

Keep compact health/cooldown state per search provider:

- recent 401/403 -> credential/config issue;
- 429 -> honor Retry-After/cooldown;
- timeout/network -> short bounded backoff;
- repeated provider failure -> cooldown;
- owner can see current search provider/health in status/doctor surfaces.

Do not build a second general routing framework. Reuse current health/provider patterns where practical.

## Suggested implementation seam

Exact filenames may follow repository conventions. Prefer something like:

```text
src/web-search/
  web-search-service.mjs
  search-policy.mjs
  evidence-packet.mjs
  providers/
    opencode-websearch.mjs
    <fallback-provider>.mjs
```

Integrate into Chat only at a narrow seam before `ChatRuntime.send()`.

Do not rewrite `ChatRuntime`, `ProviderManager`, LiteLLM routing, Work runtime or Discord UI architecture.

## Search policy

Implement a small deterministic policy first.

Representative signals:

### Strong AUTO-search signals

- explicit user command: 搜/查/联网/search/look up/browse
- relative/current time: today/current/latest/recent/now/this week
- market/news/sports/weather/prices/releases/versions/status/outages
- named product/model/API whose current availability/version materially affects correctness
- user explicitly asks for source/official announcement/confirmation

### Strong NO-search signals

- rewrite/translation/summarization of provided text
- pure arithmetic/logic from prompt
- creative writing
- stable conceptual explanation
- explicit no-search instruction

Do not overfit a giant keyword list. Keep policy small and testable.

## Model prompt contract

When evidence exists, pass a compact system/developer instruction that states:

- use the supplied web evidence for current claims;
- distinguish verified current facts from model background knowledge;
- do not claim a source says something not present in evidence;
- if evidence conflicts, state the conflict rather than invent certainty;
- include source attribution in the final answer;
- do not request another search unless the orchestrator explicitly supports another bounded search cycle.

For P3.1, prefer **one search phase + one answer phase**. Multi-hop autonomous research can come later.

## Configuration / controls

Add minimal controls only:

```text
WEB_SEARCH_MODE=auto|off|always
WEB_SEARCH_PROVIDER=<auto/provider-id>
ALLOW_METERED_WEB_SEARCH=false
WEB_SEARCH_MAX_RESULTS=<small bounded default>
```

Avoid adding a dozen timeout knobs; P3.0 owns network timeout policy.

Discord owner controls may be added to existing settings/status surfaces if low-cost:

```text
/search auto
/search on
/search off
/search status
```

Do not require a new control panel framework.

## Privacy/security

- never send secrets, `.env`, credentials, private repository content or local file contents to a public search provider;
- web query should be derived from the user's public-information question, not the full internal prompt/context when unnecessary;
- redact known secret patterns before search logging;
- do not automatically fetch arbitrary local/intranet URLs;
- block non-http(s), localhost/private-network fetches unless a future explicit feature requires them;
- preserve existing owner-only controls.

## Tests

### Deterministic tests

Add focused tests for at least:

1. `今天最新的 OpenCode Go 模型有哪些` -> search required.
2. `什么是 exponential backoff` -> no search.
3. `不要联网，解释 TCP` -> no search.
4. Search provider returns 3 results -> compact evidence passed to model.
5. Sources shown in final result only when actually used.
6. Search provider 429 -> cooldown; next AUTO uses another allowed provider or degrades safely.
7. Search provider network failure -> Chat does not start a Work Agent and does not crash.
8. Metered search provider is not silently used in AUTO when disabled.
9. Explicit search with no available provider -> clear unverified/search-unavailable response.
10. Search query/logs contain no configured secret fixture.
11. No workspace scan/file mutation/Work session created during a search Chat turn.
12. Existing Chat AUTO/manual model pin/fallback behavior remains intact.
13. Long result delivery still uses existing full-result path.
14. P3.0 timeout/retry semantics are not regressed.

### Real-machine smoke

On Windows + Discord + real OpenCode Go setup:

1. Ask a stable question; verify no search call.
2. Ask `OpenCode Go 现在有哪些模型？请联网核实`; verify real search occurs and answer cites current sources.
3. Ask `GPT-5.6 Sol 是什么？联网查官方资料`; verify search occurs and the selected model receives current evidence.
4. Footer/status shows actual model and Web usage.
5. Verify no coding Agent process/session was created for these Chat turns.
6. Disable/interrupt search provider and verify graceful degraded behavior.
7. Verify model/search credentials never appear in Discord/logs/diff.

## Acceptance

PASS requires:

- normal Chat remains lightweight;
- current-info questions can actually retrieve live web evidence;
- the selected Chat model can answer from that evidence;
- source links are visible;
- no coding Agent is started for Chat web search;
- AUTO search is selective, not every-turn;
- search provider billing is explicit and no METERED/UNKNOWN route is silently used;
- deterministic tests pass;
- `npm test` and `npm run check` pass;
- relevant P2/P3.0 regression smokes pass;
- real Windows/Discord/OpenCode Go smoke proves the end-to-end path.

## Upstream references

Use current official docs as implementation references, not copied code:

- OpenAI ChatGPT search: Chat can automatically search when current information is useful.
- Anthropic web search: model decides when to search once the tool is available.
- DeepSeek consumer web search / Claude Code integration: public-web retrieval is a product/tool layer around the model.
- Volcengine/Doubao Responses tools: built-in Web Search extends normal model responses.
- OpenCode Websearch + SDK/server: reuse supported search infrastructure where it avoids a new search stack.

Relevant URLs:

```text
https://help.openai.com/en/articles/9237897-searching-the-web-with-chatgpt
https://docs.anthropic.com/zh-CN/docs/agents-and-tools/tool-use/web-search-tool
https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code/
https://www.volcengine.com/docs/82379/1958524
https://opencode.ai/v2/docs/websearch
https://opencode.ai/docs/sdk/
```

## After completion

When P3.1 passes:

1. update `docs/tasks/CURRENT.md` to `JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`;
2. record the actual search backend and billing classification in compact project state;
3. stop and return for owner acceptance unless the owner explicitly asked to continue TechLead in the same job.

## Worker final report

```text
PASS | FAIL
commit: <sha or none>
tests: <compact result>
search: <actual backend / billing class>
auto-policy: <PASS|FAIL>
agent-started-for-chat-search: <NO required>
real-smoke: <PASS|PENDING + reason>
blocker: <none or one key blocker>
```
