# LEVEL — CORE-first Discord capability upgrade

## Goal

Upgrade Jarvis/OpenClaw so capabilities can keep growing **without making ordinary Discord use slower or fatter**, then install and real-smoke the selected non-financial capabilities.

This is one delivery with two gated phases:

1. **CORE** — use OpenClaw's existing tool/skill policy, deferred discovery and direct command dispatch instead of building another registry/router.
2. **LEVEL** — install/integrate the selected reusable capabilities on top of that foundation.

Finance/Longbridge/market/news-engine work stays out of this task and remains a separate `money` task.

## Non-negotiable product contract

- Discord remains the owner-facing control surface.
- Do not create a second Discord bot/control plane.
- Do not require a WebUI for normal use; admin UIs are diagnostics only.
- Preserve the existing Jarvis mode/session/permission/stop/cancel/task-card behavior.
- Preserve the existing approval flow. New tools must never bypass it.
- Prefer official OpenClaw mechanisms and mature upstream integrations over custom wrappers.
- Do not build a custom capability registry, custom universal router, or duplicate accounting/memory/security subsystem unless the existing stack demonstrably cannot satisfy the acceptance criteria.
- Never commit or echo secrets.

## Read first

Follow:

- `AGENTS.md`
- central `GLOBAL_AI_RULES.md`
- `docs/CURRENT.md`
- `docs/AI_HANDOFF.md`
- `docs/tasks/CURRENT.md`

Before changing anything, inspect the real Windows/OpenClaw installation, enabled Skills/plugins/MCP/tools, current config, process chain and relevant local changes. Reuse what already works.

Current OpenClaw references to verify against the installed version before implementation:

- https://docs.openclaw.ai/tools/tool-search
- https://docs.openclaw.ai/gateway/config-tools/tool-policy
- https://docs.openclaw.ai/tools/skills-config
- https://docs.openclaw.ai/tools/slash-commands
- https://docs.openclaw.ai/tools/code-mode/configuration

Do not blindly copy config from documentation if the installed version differs.

---

# Phase A — CORE: scalable capability routing

## A1. Do not add another registry/router

Use OpenClaw's effective tool catalog/policy as the source of truth.

Required direction:

- OpenClaw tool catalog/policy remains authoritative for OpenClaw tools, plugin tools, MCP and client tools.
- Jarvis may keep only the minimum deterministic routing/context needed by its Discord UX and existing mode contract.
- No parallel `CapabilityRegistry` that mirrors OpenClaw metadata.
- No per-turn scan of every installed Skill/MCP schema.
- No extra LLM call merely to classify every normal message.

If the current implementation already has overlapping routing logic, simplify only where necessary; do not rewrite stable paths.

## A2. Deferred tool exposure / Tool Search

Evaluate the installed OpenClaw version and active models/providers, then enable the **smallest compatible deferred-tool mechanism**.

Preferred order:

1. OpenClaw Tool Search when compatible with the real runtime/model path.
2. Structured/directory Tool Search mode when the code bridge is unreliable for a model.
3. Existing normal tool exposure only for a small bounded hot set when deferred discovery is not compatible.

Rules:

- unrelated full tool schemas must not all be injected into normal runs;
- policy filtering happens before discovery;
- search/describe/call remains inside the existing permission boundary;
- do not create a second search index if OpenClaw's catalog already works;
- keep OpenClaw's catalog/snapshot caching behavior intact;
- Tool Search queries generated internally must be compatible with OpenClaw's search behavior.

Because OpenClaw Tool Search is version/model sensitive, **real compatibility smoke decides**, not architectural preference.

## A3. Tool profiles / scoped visibility

Use existing OpenClaw `tools.profile`, allow/deny groups and agent Skill allowlists where they materially reduce irrelevant capability exposure.

Do not treat visibility as authorization. Existing Jarvis approval/security policy remains authoritative.

Use Discord channel/context as a cheap hint only when the current architecture can express it cleanly. Do **not** build a new channel-routing subsystem just for this task.

Examples of desired scoping:

- development context: GitHub/files/shell/test/web-related capabilities;
- browser/research context: search/extraction/browser capabilities;
- finance remains excluded from this task.

## A4. Skill prompt hygiene

For every installed Skill:

- keep descriptions short and specific;
- use OpenClaw gating/allowlists so unavailable or irrelevant Skills do not load;
- use `disable-model-invocation: true` for owner-invoked/diagnostic Skills that do not need autonomous model selection;
- avoid stuffing large static instructions into every normal prompt;
- preserve Skill snapshot/cache behavior rather than rebuilding Skill state each turn.

## A5. Deterministic direct commands

For commands that map deterministically to one tool/action, prefer OpenClaw native Skill/slash-command dispatch and `command-dispatch: tool` where supported.

Examples: status/usage/capability diagnostics and other unambiguous management actions.

Acceptance requirement:

- a deterministic direct command must not need an LLM round trip merely to choose its tool;
- authorization/confirmation checks still apply.

Natural-language requests may continue through the model when interpretation is actually needed.

## A6. Code Mode: conditional only

Do **not** globally force Code Mode.

OpenClaw Tool Search and Code Mode are mutually exclusive for a run. Use Code Mode only when the installed OpenClaw/model metadata recommends it or real smoke proves it is the better compatible path.

Preferred policy:

- `tools.codeMode: "auto"` only if supported and verified;
- never force it across DSF/GLM/Luna/other providers without per-route evidence;
- a model that fails the Code Mode smoke must fall back cleanly without disabling the capability set.

## A7. Fast-path invariants

CORE must not make trivial use slower by adding planning/model hops.

The following must remain true:

- ordinary Chat does not start Work/Agent unless the existing product contract explicitly says it should;
- explicit local/native commands stay local/direct when possible;
- no Qwen/planner/secondary model call solely to classify every trivial message;
- simple messages do not trigger tool discovery when no tool is needed;
- Stop/Insert/approval controls remain responsive while tools run.

## A8. CORE acceptance

Before Phase B, prove on the real runtime:

1. **Plain Chat smoke** — several trivial messages complete with no unnecessary planner/secondary-router/tool-search call.
2. **Direct-command smoke** — one deterministic slash/Skill command dispatches without a model-selection round trip.
3. **Deferred-tool smoke** — one request that needs a tool discovers/loads the relevant capability without exposing unrelated full schemas.
4. **Permission smoke** — one harmless tool path and one safe synthetic risky path prove existing approvals cannot be bypassed.
5. **Restart smoke** — configuration survives the normal Jarvis/OpenClaw restart path.
6. Record compact before/after evidence for routing overhead/tool exposure using available logs/metrics. Do not invent latency numbers if the runtime cannot measure them reliably.

Do not start mass capability installation until CORE is green, except for a minimal capability needed to prove the mechanism.

Create a coherent CORE commit/checkpoint before continuing.

---

# Phase B — LEVEL: selected non-financial capabilities

Install/integrate only after Phase A passes. Reuse already-installed working components where present.

## B1. Web search — Tavily

- Mature official/MCP/plugin/SDK route that best fits installed OpenClaw.
- Natural-language Discord request can use it.
- Results + usable sources return to Discord.
- No dashboard required for normal use.

## B2. Extraction/crawl — Firecrawl

- Use the least-complex supported integration.
- Direct URL extraction and post-search retrieval both work.
- Prefer Tavily for discovery + Firecrawl for extraction rather than duplicate search logic where appropriate.
- Structured result returns to Discord.

## B3. Browser automation

Use Browser Use or the current better-supported compatible upstream equivalent.

- Discord can launch browser work.
- Existing task card/progress surface shows meaningful state.
- Screenshots/files/final result return to Discord when relevant.
- Existing stop/cancel/approval path remains functional.
- No browser WebUI as the primary owner workflow.

## B4. External-app integration — Composio

- Prefer supported OpenClaw/MCP/SDK integration.
- Do not write a one-off adapter per service when Composio already solves it.
- Use existing authorized connections if available.
- Real smoke with a harmless read-only action.
- If authorization is absent, finish safe wiring and mark only that smoke externally blocked.

## B5. Observability — OpenTelemetry + Langfuse where compatible

Capture at least:

- run/task identity;
- provider/model;
- latency;
- tool calls;
- token usage when reported;
- errors/status.

Keep traces out of normal Discord chatter. Provide a concise Discord-facing status path proving telemetry is alive. Never log keys/tokens/auth headers/cookies.

## B6. Token/usage accounting

First inspect existing Jarvis provider/billing/usage code. Extend it if possible.

Evaluate DeepClaw/Tokenomics/current maintained equivalent only if it adds value without creating a second ledger.

Discord status/command must show when available:

- provider/model;
- input/output/total tokens;
- reliable cost only when a trustworthy rate exists;
- unavailable metrics as unavailable, never as zero.

A real Discord-triggered run must appear in the usage data.

## B7. Additive security guard

Preserve current Jarvis approval system.

Evaluate Agent Permissions/Security Guard/ClawGuard/current maintained equivalent and add only genuine extra protection, such as prompt-injection/tool-call risk checks.

Required:

- `Allow once / Allow session / Deny` remains authoritative;
- unknown/new MCP tools fail closed or enter existing approval;
- no duplicate approval UI;
- one harmless allowed smoke;
- one safe synthetic risky/denied-or-approval-required smoke.

## B8. Durable memory — Mem0 only if it fits cleanly

Do not replace or create a conflicting source of truth for existing session/context memory.

If integrated:

- durable cross-session recall works from Discord;
- clear debug/disable path exists;
- secrets are excluded.

Real smoke:

1. remember a harmless unique fact;
2. reset/end short-term session context;
3. ask for it again;
4. prove durable memory, not retained chat context, supplied it.

If clean integration would create two competing memory truths, do not force Mem0; document the conflict and use the existing durable-memory mechanism if it already satisfies the product goal.

---

# Capability status surface

Extend one existing Discord status/control surface rather than adding many commands.

It should report, without secrets:

- Tool Search/deferred discovery mode;
- effective tool profile / relevant capability scope;
- Tavily;
- Firecrawl;
- browser automation;
- Composio;
- telemetry;
- token accounting;
- security guard;
- durable memory;

using states such as `enabled`, `disabled`, `blocked: authorization`, `incompatible`.

---

# Real acceptance

Package installation, config files and mocked tests are not enough.

After implementation:

1. restart through the normal Jarvis/OpenClaw supervisor path;
2. confirm Jarvis returns online;
3. run the relevant existing deterministic tests/checks;
4. run a real Discord smoke for every available capability;
5. run at least one post-restart capability invocation;
6. verify no unrelated capability bulk-loads into trivial Chat;
7. verify no new integration bypasses approval/stop/cancel;
8. verify no secrets entered Git/logs/status output.

Minimum repository gates:

```powershell
npm test
npm run check
```

Also use the current real Discord/runtime smoke covering modified paths. Reuse existing scripts; do not create a parallel test framework without need.

## Per-capability real smoke

- **Tavily:** current public-info search returns sources to Discord.
- **Firecrawl:** supplied public URL is really extracted and returned.
- **Browser:** harmless public page is opened and a visible fact or screenshot is returned.
- **Composio:** one existing-authorized read-only action, or explicit external-auth blocker.
- **Telemetry:** a real Discord run produces a trace/span with expected metadata.
- **Usage:** the same real run appears with provider/model/token data where supplied.
- **Security:** harmless + synthetic risky paths behave correctly.
- **Memory:** cross-session unique-fact recall succeeds if durable-memory integration is enabled.

---

# Performance / scaling acceptance

With all available LEVEL capabilities enabled:

- trivial Chat adds **zero extra routing-model calls**;
- deterministic direct commands add **zero tool-selection model calls**;
- no full-schema dump of every installed capability into ordinary runs;
- a tool-using request resolves a small relevant set through the chosen OpenClaw discovery mechanism;
- unrelated installed capabilities do not change ordinary Chat behavior;
- no second catalog/index/registry is maintained by Jarvis;
- no repeated full Skill/MCP discovery is performed every turn when OpenClaw can reuse its catalog/snapshots.

Measure what the runtime can measure reliably. Do not fabricate absolute millisecond targets; compare before/after and report real observed overhead.

---

# Scope limits

Do not:

- add finance/Longbridge/market/news-engine capabilities;
- implement the separate `money` task;
- replace Discord with OpenClaw WebUI;
- add a second bot;
- rewrite stable Jarvis runtime/mode/session/permission UI;
- force Code Mode across all models;
- create a custom capability registry that duplicates OpenClaw;
- stack duplicate memory/security/token systems;
- perform unrelated refactors;
- destroy local state to get a clean install;
- commit credentials.

# Stop condition

Stop when CORE + all locally achievable LEVEL acceptance gates pass, or when remaining failures are genuinely external authorization/service blockers and all safe local work is complete.

Do not continue plugin hunting or broad cleanup after acceptance.

# Delivery / commits

Prefer two coherent checkpoints:

1. `CORE: scalable capability discovery/routing`
2. `LEVEL: non-financial capability integrations`

Do not split further unless required for safe recovery.

# Final report

```text
PASS | FAIL
commit: <sha(s) or none>
tests: <compact deterministic + real Discord smoke result>
core: <tool-search/profile/direct-dispatch/code-mode policy actually active>
enabled: <capabilities>
blocked: none | <external blockers only>
blocker: none | <one key blocker>
```
