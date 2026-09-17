# Active task

`docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`

## Branch

`jarvis-v4-p3-ai-techlead-shadow`

## Status

P3.1 (`docs/tasks/JARVIS_V4_P3_1_CHAT_WEB_SEARCH.md`) is implemented and
committed; P3.0 is also complete. **Awaiting owner acceptance — do not start
TechLead implementation.**

Recorded backend: OpenCode Go native `web_search` (Responses transport, model
`grok-4.6`), billing class **SUBSCRIPTION** (no extra search key, no coding
Agent). Tavily is an optional METERED adapter used only when
`ALLOW_METERED_WEB_SEARCH=true` or explicitly pinned.

## After owner acceptance

Continue `docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md` (advisory Shadow Mode:
zero-token standby, deterministic incident detection first, Grok 4.6 only on
meaningful incidents).

## Do not

- do not start a coding Agent / Work session for a Chat search;
- do not silently use METERED/UNKNOWN search providers in AUTO;
- do not add a second routing framework, daemon, database or queue;
- do not regress P3.0 timeout/retry semantics or P2 Chat/Work separation.
