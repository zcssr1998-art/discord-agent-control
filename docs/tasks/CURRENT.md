# Active task

`docs/tasks/JARVIS_V4_P3_2_WORK_MODEL_LIBRARY_REGRESSION.md`

## Branch

`jarvis-v4-p3-ai-techlead-shadow`

## Status

P3.2 Work model library regression hotfix implemented and committed: the Work
model screen now discovers a runnable `executor + provider + model + transport`
route instead of filtering providers by the previously selected executor.
`npm test` 440/0, `npm run check` 141/0, `smoke:p2` 11/11, `smoke:p222` 25/25,
`smoke:p3-techlead` 12/12. **Real Discord owner smoke pending.**

P3 TechLead Shadow Mode remains implemented and committed (below) and is still
awaiting owner acceptance on a real Discord Work turn.

## P3.2 (implemented)

`#workProviderList` uses `#providerRunnable` (any ready compatible executor).
`#workRouteFor` / `#selectWorkRoute` persist executor + provider + model
atomically: current executor is retained when compatible, otherwise the first
ready compatible executor is chosen with a truthful confirmation, and models
with no runnable executor are disabled. Covered by
`tests/v4-p32-work-model-library.test.mjs`.

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
