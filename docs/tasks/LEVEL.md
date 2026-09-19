# LEVEL — Discord-first capability upgrade

## Objective

Upgrade the existing Jarvis/OpenClaw stack with the **non-financial** reusable capabilities selected by the owner, using the minimum necessary changes and mature upstream components.

The finished product must be usable from the existing **Discord Jarvis**. Installing packages or proving that a WebUI opens is not acceptance.

This task explicitly excludes all finance/market/Longbridge work. Finance is being handled separately.

## Product contract

The owner-facing surface is Discord.

For every capability added in this task:

- it must be invokable from the existing Jarvis Discord entrypoint;
- useful output must return to Discord as text/card/table/file/image as appropriate;
- normal use must **not** require the owner to open a separate WebUI;
- backend/admin UIs are allowed only for maintenance/debugging;
- it must survive a normal Jarvis/OpenClaw process restart;
- it must be enabled/configured after installation, not merely present on disk;
- it must not create a second competing Discord bot or duplicate control plane.

Prefer official OpenClaw plugin/Skill/MCP integration mechanisms and mature upstream projects over custom wrappers.

## Required capability set

### 1. Web search — Tavily

Add Tavily as a general web-search capability for Jarvis.

Requirements:

- use the current official/mature OpenClaw/MCP/SDK route that best fits the installed stack;
- natural-language Jarvis requests must be able to invoke it;
- search results and citations/sources return to Discord;
- do not require the owner to open Tavily's dashboard for normal use.

### 2. Web extraction / crawl — Firecrawl

Add Firecrawl for full-page extraction, site crawl and structured content retrieval.

Requirements:

- integrate through the least-complex supported OpenClaw/MCP/plugin route;
- Jarvis must be able to use it after search or directly from a supplied URL;
- extracted/structured result must return to Discord;
- reuse Tavily for discovery and Firecrawl for retrieval where that is the simpler route rather than duplicating search logic.

### 3. Browser automation — Browser Use

Add a mature browser-control capability using Browser Use or the currently recommended compatible upstream equivalent if the installed OpenClaw version has a better official route.

Requirements:

- a Discord task can launch browser work;
- browser work must report meaningful progress/status through the existing task UI;
- screenshots/files/final result must come back to Discord when relevant;
- existing Jarvis stop/cancel and approval controls must still work;
- do not make a browser WebUI the primary interface.

### 4. App integration bus — Composio

Add Composio as the general external-app/tool integration layer where it reduces one-off connector code.

Requirements:

- integrate the supported OpenClaw/MCP/SDK path;
- expose available connected actions to Jarvis without hard-coding a new custom adapter for every service;
- do not create or commit credentials;
- use existing authorized connections if present;
- smoke with a harmless read-only action from one already-authorized service if available;
- if no authorized external account exists, complete installation/routing and report the missing authorization as the only external blocker rather than fabricating a PASS.

### 5. Observability — Langfuse + OpenTelemetry

Add observability for real Jarvis/agent/tool runs.

Requirements:

- capture at least model/provider, latency, token usage when available, tool calls, task/run identity and error status;
- prefer the OpenClaw-supported OpenTelemetry path and Langfuse as the trace/analysis backend if compatible;
- keep traces/logs out of normal Discord chatter;
- expose a concise Discord-facing status/usage command or existing status surface so the owner can see that telemetry is working without opening the dashboard;
- never log secrets, API keys, auth headers, cookies or raw credential payloads.

A separate Langfuse UI may exist for deep diagnostics, but it is **not** the primary owner workflow.

### 6. Token/cost monitoring — DeepClaw / Tokenomics class

Add a real token/usage accounting capability.

First inspect the current Jarvis/OpenClaw implementation because the project already has some provider/model/billing information. Do not build a second unrelated accounting system if an existing one can be extended.

Evaluate the mature compatible options previously identified (DeepClaw, Tokenomics, or the current best-maintained equivalent). Choose the smallest robust solution.

Required Discord behavior:

- an owner command such as `!usage`, `/usage`, or an existing equivalent shows current/recent usage;
- show at minimum model/provider, input/output/total tokens when the provider reports them;
- show cost only when a reliable pricing source/rate is available; do not invent cost;
- distinguish unavailable provider metrics from zero usage;
- usage data must reflect a real Discord-triggered run.

If two candidate tools substantially overlap, install **one** good implementation rather than two competing ledgers.

### 7. Security / tool-call guard

The repository already has a working approval/policy system. Preserve it.

Evaluate the OpenClaw security/permission plugins previously identified (Agent Permissions, Security Guard, ClawGuard or current maintained equivalents) and add only the layer that gives real additive protection without replacing the proven Discord approval flow.

Requirements:

- existing `Allow once / Allow session / Deny` Discord flow remains authoritative for risky actions;
- new security layer may add prompt-injection/tool-call/risk checks, but must not silently auto-approve an action that current Jarvis would gate;
- unknown/new MCP tools fail closed or go through the existing approval policy;
- no duplicate approval UIs;
- prove one harmless auto-allowed action and one deliberately risky/denied test path.

If the candidate security plugins duplicate the existing policy with no additional value, integrate only the additive guard capability and document why the redundant plugin was not stacked.

### 8. Long-term memory — Mem0

Add Mem0 as a long-term memory provider only if it can be integrated cleanly behind the current Jarvis/OpenClaw memory/context model.

Requirements:

- do not delete or bypass existing session/context memory;
- avoid maintaining two independent user-memory truths;
- use Mem0 for durable cross-session recall where appropriate;
- memory must be accessible through normal Discord conversation;
- add a clear way to inspect/disable the integration for debugging;
- never store secrets or credential material.

Real smoke:

1. from Discord, ask Jarvis to remember a harmless unique test fact;
2. end/reset the normal chat session in a way that removes short-term context but not durable memory;
3. ask for the fact again;
4. verify the value was actually retrieved from durable memory rather than retained chat context.

## Installation strategy

Before installing anything:

1. pull the latest repository state and inspect `git status` / relevant diff;
2. read project `AGENTS.md` if present and the central `GLOBAL_AI_RULES.md`;
3. inspect the current local OpenClaw/Jarvis installation and enabled plugins/Skills/MCP servers;
4. check whether each requested capability already exists or is partially implemented;
5. check current official docs/upstream repositories for compatibility with the installed OpenClaw version;
6. reuse existing working integrations instead of reinstalling or replacing them.

Do not blindly install every package name from an old recommendation. If an upstream component has been renamed/deprecated/replaced, use the current official or clearly maintained equivalent while preserving the capability contract above.

## Secrets / credentials

Never commit or echo:

- API keys;
- tokens;
- OAuth secrets;
- cookies;
- passwords;
- signing material.

Use the project's existing secret/env/credential storage mechanism.

If Tavily, Firecrawl, Composio, Langfuse or another service requires credentials that are not already available:

- finish all code/plugin wiring that can be completed safely;
- do not invent a credential;
- do not paste a secret into Git;
- report the exact missing authorization/credential as a blocker for that one real smoke.

Prefer local/self-hosted/open-source operation when it is mature and materially reduces external credentials **without** adding large maintenance burden.

## Discord integration requirements

Do not scatter these into separate bots or unrelated command systems.

Use the existing Jarvis task/card/progress/approval UI.

At minimum provide or extend one capability/status surface, e.g. `!tools` / `!capabilities` / existing control panel, that can show:

- Tavily: enabled/disabled/blocked;
- Firecrawl: enabled/disabled/blocked;
- Browser automation: enabled/disabled/blocked;
- Composio: enabled/disabled/authorization-needed;
- OpenTelemetry/Langfuse: enabled/disabled;
- token accounting: enabled/disabled;
- security guard: enabled/disabled;
- Mem0: enabled/disabled.

Do not expose secret values in this status.

Natural-language tool routing is preferred for actual use. Commands are primarily for status/diagnostics, not a requirement that the owner memorize a new command for every tool.

## Real acceptance smoke

Package install, unit tests and mocked Discord tests are necessary but not sufficient.

After implementation, restart the real Jarvis/OpenClaw runtime and execute a minimal real Discord smoke for each enabled capability.

### Search smoke

From Discord, request current public information that requires web search.

PASS evidence:

- Tavily/tool invocation occurred;
- answer returned to Discord with usable source information.

### Firecrawl smoke

From Discord, give a public webpage and request structured extraction/summary.

PASS evidence:

- the page was actually fetched/extracted through the configured capability;
- result returned to Discord.

### Browser smoke

From Discord, ask Jarvis to open a harmless public page and extract one visible fact or create a screenshot.

PASS evidence:

- real browser session ran;
- progress/result visible through Discord;
- screenshot/result returned;
- stop/cancel path remains functional.

### Composio smoke

Use one existing authorized read-only integration if present.

PASS evidence:

- real external tool call ran from a Discord-triggered request;
- read-only result returned to Discord.

If no external account is authorized, mark only this smoke blocked on authorization.

### Observability smoke

Use one of the real Discord tool runs above.

PASS evidence:

- a trace/span exists for that run;
- provider/model/tool/latency/error state are recorded;
- token fields are recorded when supplied by provider;
- Discord status can confirm observability is active.

### Token smoke

Run one short Discord model/tool task.

PASS evidence:

- usage command/status reflects that run;
- token numbers come from real runtime/provider instrumentation, not estimates unless explicitly labeled estimate.

### Security smoke

Perform:

- one harmless action expected to auto-allow;
- one safe synthetic action classified as risky/denied/approval-required.

PASS evidence:

- current Discord approval behavior is preserved;
- new tool/MCP routes cannot bypass policy.

Do **not** perform a destructive real action merely to test denial.

### Memory smoke

Use the cross-session unique-fact test defined above.

PASS evidence:

- durable recall succeeds after short-term session reset;
- evidence indicates Mem0/durable memory supplied the recall.

## Regression verification

Run the smallest deterministic suite that covers the changed areas first.

Because this touches shared Jarvis/OpenClaw routing, permissions and runtime configuration, final verification must also include the repository's current core gates that are still applicable, such as:

```powershell
npm test
npm run check
```

Also run the project's current Discord/runtime smoke that covers the actual modified path. Prefer existing scripts over inventing a parallel test harness.

If command names have changed in the latest repo, use the current equivalents.

Do not dump successful full logs into the model context; preserve concise evidence and failing excerpts only.

## Restart / enablement requirement

Before PASS:

1. all selected integrations are configured as enabled where credentials/authorization permit;
2. restart the real Jarvis/OpenClaw process using the project's normal supervisor/start path;
3. verify Jarvis returns online;
4. verify the capability/status surface still reports integrations correctly;
5. perform at least one post-restart real Discord invocation.

Do not require a full Windows reboot unless the existing project acceptance process specifically needs one.

## Scope limits

Do not:

- add Longbridge, market feeds, stock analysis, financial news engines or finance channels;
- modify the separate `money` work;
- replace the working Jarvis Discord UI with an OpenClaw WebUI;
- introduce a second Discord bot;
- build custom substitutes for mature working upstream integrations without evidence;
- duplicate existing approval/memory/token subsystems when extension is sufficient;
- change model-selection/workflow-classification behavior unless required to route these tools;
- perform unrelated refactors;
- destroy current local OpenClaw/Jarvis state to obtain a clean install;
- commit secrets.

## Acceptance criteria

PASS only when:

- [ ] latest local/repo state was inspected before changes;
- [ ] finance-related integrations were not added;
- [ ] Tavily capability is installed/wired/enabled and real Discord smoke passes;
- [ ] Firecrawl capability is installed/wired/enabled and real Discord smoke passes;
- [ ] browser automation is installed/wired/enabled and real Discord smoke passes;
- [ ] Composio is installed/wired/enabled; a real read-only smoke passes if an authorized connection exists;
- [ ] OpenTelemetry/Langfuse observability is active on a real Discord-triggered run;
- [ ] token/usage accounting reflects a real run and is queryable from Discord;
- [ ] additive security guard is active without breaking/bypassing existing approvals;
- [ ] Mem0 durable-memory smoke passes across a short-term session reset;
- [ ] user-facing normal operation stays inside Discord;
- [ ] no integration requires a WebUI for normal daily use;
- [ ] integrations remain enabled after a normal Jarvis/OpenClaw process restart;
- [ ] core deterministic tests/checks are green;
- [ ] no secrets were committed or printed;
- [ ] no unrelated subsystem was rewritten.

If a required external credential/authorization is genuinely absent, do not falsely report full PASS. Return the single blocked integration(s) clearly, while still completing and verifying every capability that can be finished without that missing external authorization.

## Stop condition

Stop when the acceptance gates above pass or when the remaining blocker is genuinely external (missing credential/account authorization/service outage) and all safe local work is complete.

Do not continue broad cleanup, refactoring or plugin hunting after acceptance.

## Final report

Keep the execution history in the repository/logs. Return only:

```text
PASS | FAIL
commit: <sha or none>
tests: <compact deterministic + real Discord smoke summary>
enabled: <comma-separated capabilities>
blocked: none | <only externally blocked capability/reason>
blocker: none | <one key blocker>
```
