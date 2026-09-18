# Active task

`docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`

## Branch

`jarvis-v4-p3-ai-techlead-shadow`

## Status

P3.0, P3.1 and P3 AI TechLead Shadow Mode are implemented and committed.
**Awaiting owner acceptance — real Discord Work turn pending.**

## P3 TechLead (implemented)

`src/techlead/` advisory Shadow Mode: deterministic incident detection first,
one startup review per Work, dedupe/cooldown, hard wake budget, bounded
sanitized packets, strict response parser, reviewer via OpenCode Go
`grok-4.6` when discovered. Shadow safety: no automated insert/pause/stop/tool
side effect. State persisted in `data/state.json` (`preferences.techLead`).

## After owner acceptance

If Shadow false-positive/false-negative behavior is acceptable, a separate
future task may enable bounded `INJECT` / `PAUSE_REPLAN` only; keep destructive
stop/abort under deterministic safety/OWNER approval.

## Do not

- do not start a coding Agent / Work session for a Chat search;
- do not silently use METERED/UNKNOWN search providers in AUTO;
- do not add a second routing framework, daemon, database or queue;
- do not regress P3.0 timeout/retry semantics or P2 Chat/Work separation.
