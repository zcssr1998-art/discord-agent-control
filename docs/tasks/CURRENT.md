# Active task

`docs/tasks/LEVEL.md` — **CORE-first capability upgrade**.

## Execution order

1. **CORE first:** use OpenClaw's existing Tool Search/tool policy/Skill gating/direct command dispatch to make capability growth scale without adding routing-model calls or bulk-loading every tool schema.
2. **LEVEL second:** install, integrate, enable and real-smoke the selected non-financial Discord-first capabilities: Tavily, Firecrawl, browser automation, Composio, observability/token accounting, additive security guard and durable memory.

Do not start mass LEVEL installation until the CORE acceptance gate in `LEVEL.md` passes, except for a minimal capability needed to prove deferred discovery.

## Product requirement

Discord remains the owner-facing control surface. Normal use must not require opening an OpenClaw/plugin WebUI.

Do not build a second capability registry/router if OpenClaw's own catalog/policy can do the job. Trivial Chat must not gain an extra routing-model call.

## Required closeout

Do not report PASS from package installation or mocked tests alone. Each available capability must be enabled and exercised through the real Discord Jarvis path, then rechecked after a normal Jarvis/OpenClaw restart. Missing third-party credentials/authorization are external blockers and must never be fabricated.

## Explicit exclusion

No finance/Longbridge/market/news-engine work in this task. Finance remains the separate `money` work.

## Previous task

`docs/tasks/HUNYUAN3D_LOCAL_REPAIR_AND_SMOKE.md`.
