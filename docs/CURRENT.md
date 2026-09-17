# Current project state

## Branch

`jarvis-v4-p3-ai-techlead-shadow`

## Current milestone

Jarvis V4 P3 — **AI TechLead Shadow Mode**.

Active task:

`docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`

Task specification and branch setup are complete. Implementation has not started.

## Baseline to preserve

P2/P2.1/P2.2.1–P2.2.6 are complete and merged to `main`.

Verified release baseline before P3:

```text
npm test                 -> 386 pass / 0 fail
npm run check            -> 121 file(s), 0 failed
npm run smoke:p2         -> 11/11
npm run smoke:p22        -> 10/10
npm run smoke:p222       -> 25/25
npm run smoke:p22-insert -> 14/14
npm run smoke:p223-full  -> 15/15
npm run smoke:p224-lifecycle -> 21/21
npm run smoke:p225-limits    -> 23/23
npm run smoke:p226-update    -> 49/49
npm run verify:hook      -> 9/9
scripts/smoke-supervisor-recovery.ps1 -> 23/23
```

P2 real-Discord acceptance was complete. Existing Task Scheduler -> process Supervisor -> one Bridge runtime remains the production baseline on `main` until P3 is implemented, verified and explicitly promoted.

## P3 objective

Add an event-driven, extremely low-token AI TechLead to Work mode:

- at most one compact startup review per explicit Work;
- standby performs zero model calls;
- local deterministic monitoring detects stagnation/risk first;
- only compact incidents wake the TechLead;
- duplicate incidents are suppressed;
- hard per-Work wake budget prevents runaway model usage;
- default desired reviewer is Grok 4.6 through the existing safe OpenCode Go/provider path when available;
- Shadow Mode is advisory only: no automatic insert/pause/stop/tool/file action.

## Important constraints

- Use `TechLead` for the AI reviewer; do not overload the existing process `Supervisor` name.
- Reuse current Work lifecycle, persistent sessions, watchdog/runaway protection, approval hook, insert accounting, cancellation, provider/model discovery and state/status surfaces.
- Do not add another orchestration framework, daemon, router or database.
- OpenCode-specific structured events are optional enrichment; Jarvis-owned Work/runner events are the canonical fallback.
- Event capability must degrade safely if hooks change or disappear.
- TechLead/provider failure must never block normal Work in P3.
- AUTO/billing safety remains authoritative: no silent METERED/unknown fallback.

## Live runtime

Production/live runtime is still the already-verified P2 `main` chain. P3 branch is not live and must not be presented as accepted before implementation + tests + real smoke.

## External limitation

WorkBuddy gateway may still return `HTTP 403 request illegal`; that remains external and must not block other providers or P3 implementation.

## Next action

Execute `docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md` on this branch. Do not create a second plan; inspect only the relevant existing subsystems, implement minimally, verify, commit and push.
