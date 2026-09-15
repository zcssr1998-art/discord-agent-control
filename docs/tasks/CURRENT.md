# Active task

Current execution specification:

`docs/JARVIS_V4_P1_TASK.md`

Status: P1A (workspace lock/queue), P1B (Work threads) and P1C (settings UX) are
implemented, tested and real-machine smoked on `jarvis-v4-p1-workflow`.

Execution order:

1. P1A workspace lock/queue — done
2. P1B Work threads — done
3. P1C compact settings UX — done
4. real smoke/evidence and final review — machine smoke done; two real-Discord
   network checks pending human interaction

Worker instructions:

- read `AGENTS.md`, `docs/CURRENT.md`, `docs/AI_HANDOFF.md`, then the task above
- do not rewrite the task into a second long plan unless a material contradiction/blocker is found
- use targeted tests while coding; run full `npm test` + `npm run check` at milestones
- preserve P0/P0.5 behavior and do not redesign LiteLLM/Chat routing
- update state/handoff/evidence, commit and push to `jarvis-v4-p1-workflow`
- final chat response must follow the short Worker response contract
