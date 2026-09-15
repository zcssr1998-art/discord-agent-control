# Active task

Current execution specification:

`docs/JARVIS_V4_P2_TASK.md`

Status: implemented on `jarvis-v4-p2-control-context`. P0/P0.5/P1 are merged and verified on `main`. P2 deterministic suite + machine-side real smoke pass (`docs/V4_P2_SMOKE.md`); the human real-Discord smoke is the only remaining item (owner-run). [VERIFIED 2026-09-16]

Execution order:

1. P2A persistent control panel + New Work modal + model/settings/permission/status/stop/help
2. P2B bounded persistent Chat history
3. P2C New Chat + Compact
4. P2D Discord attachments for Work + Chat
5. P2E full regression + real Discord smoke/evidence

Worker instructions:

- read `AGENTS.md`, `docs/CURRENT.md`, `docs/AI_HANDOFF.md`, then the task above
- the former P1.1 panel task is superseded; do not create a second implementation
- do not rewrite the task into another long plan unless a material contradiction/blocker is found
- reuse existing managers and P1 Work start/stop/thread/queue paths
- targeted tests while coding; full `npm test` + `npm run check` at milestones
- preserve all P0/P0.5/P1 behavior
- do not add SQLite/Redis/dashboard/LLM router
- update state/handoff/evidence, commit and push to `jarvis-v4-p2-control-context`
- final chat response must follow the short Worker response contract
