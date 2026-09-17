# Active task

`docs/tasks/JARVIS_V4_P3_1_CHAT_WEB_SEARCH.md`

## Branch

`jarvis-v4-p3-ai-techlead-shadow`

## Status

P3.0 (`docs/tasks/JARVIS_V4_P3_0_TIMEOUT_POLICY_CLEANUP.md`) is implemented and
committed: arbitrary total-duration failures removed from the default path, a
durable result-delivery outbox separates Worker execution from Discord delivery,
and full results survive a connect timeout. Audit: `docs/P3_0_TIMEOUT_AUDIT.md`.

Now working P3.1 — native Chat web search.

After P3.1 passes, point this file at `docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`.

## Objective

Give Jarvis Chat a first-class web-search capability without routing ordinary
Chat through the Work/coding-agent runtime: a cheap deterministic freshness/intent
decision, a pluggable search service, compact evidence, visible sources, and
explicit billing classification (no silent metered spend).

## Do not

- do not start a coding Agent / Work session for a Chat search;
- do not silently use METERED/UNKNOWN search providers in AUTO;
- do not build a search engine or scrape Google/Bing HTML;
- do not add a second routing framework, daemon, database or queue;
- do not regress P3.0 timeout/retry semantics or P2 Chat/Work separation;
- do not start TechLead until P3.1 passes.
