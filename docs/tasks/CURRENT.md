# Active task

`docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`

## Branch

`jarvis-v4-p3-ai-techlead-shadow`

## Status

P3 task specification is complete. Implementation has **not** started yet.

P2/P2.1/P2.2.1–P2.2.6 remain complete and merged to `main`. Preserve that verified baseline.

## Objective

Implement the P3 **AI TechLead Shadow Mode** exactly as specified in the active task file:

- one compact startup review per explicit Work at most;
- zero-token/model-call standby;
- deterministic ProgressFingerprint + incident detection + dedupe/cooldown;
- bounded low-context TechLead wakeups only for meaningful incidents;
- default reviewer target Grok 4.6 through the existing safe provider/OpenCode Go path when available;
- Shadow Mode is advisory only and must not auto-inject, auto-pause, auto-stop, run tools or edit files;
- provider/event failure must not block normal Work.

## Required startup order

Read:

1. `AGENTS.md`
2. global `GLOBAL_AI_RULES.md`
3. `docs/CURRENT.md`
4. `docs/AI_HANDOFF.md`
5. this file
6. `docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`
7. current branch/HEAD/status/relevant diff
8. only the existing Work lifecycle/watchdog/state/provider/status code needed for P3

Do not generate a second architecture plan. The task file is authoritative.

## Do not

- do not work on `main` directly;
- do not rewrite P2 systems;
- do not add LangGraph/AutoGen/CrewAI or another daemon/router/database;
- do not enable automatic TechLead intervention in P3;
- do not silently use metered/unknown-billing providers;
- do not continuously stream logs or poll the model.
