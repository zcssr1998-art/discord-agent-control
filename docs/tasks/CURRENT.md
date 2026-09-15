# Active task

Current execution specification:

`docs/JARVIS_V4_P2_1_NATIVE_COMMANDS_TASK.md`

Status: P2 core is implemented and machine-verified on `jarvis-v4-p2-control-context`; P2.1 is now the active implementation before combined human Discord acceptance and final PR #4 review.

Execution order:

1. native Discord application commands reusing existing P2 handlers
2. progress-card `追加需求` + `Stop` controls with stale-run safety
3. one shared follow-up queue for Modal submit + normal active-Work text
4. scheduler/session-safe FIFO drain + attachment reuse + stop cleanup
5. targeted tests -> full `npm test` + `npm run check` + existing `smoke:p2`
6. minimal human Discord P2.1 smoke; append evidence to `docs/V4_P2_SMOKE.md`

Worker instructions:

- read `AGENTS.md`, `docs/CURRENT.md`, `docs/AI_HANDOFF.md`, then the active spec
- do not rebuild or re-plan P2; extend the verified current implementation
- no adapter-specific stdin injection; append requirements become later Work turns
- slash commands/card buttons must reuse existing model/settings/status/help/work/stop/new/compact logic
- normal text in guild parent remains Chat; only an active Work thread or explicit Work-mode DM/channel may queue follow-ups
- bind task controls to a run/task ID so old cards cannot affect newer runs
- targeted tests while coding; full regression at milestone
- preserve all P0/P1/P2 behavior
- update state/handoff/evidence, commit and push to `jarvis-v4-p2-control-context`
- final chat response must follow the short Worker response contract
