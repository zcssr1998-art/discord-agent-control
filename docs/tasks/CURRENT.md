# Active task

Current execution specification:

`docs/JARVIS_V4_TASK.md`

Status: P0 (Chat/Work split) and P0.5 (LiteLLM) acceptance is complete and
smoke-verified. Remaining work is P1 (Work threads, workspace lock/queue,
settings UX) and P2 (attachments, chat history).

Worker instructions:
- read `AGENTS.md`, `docs/CURRENT.md`, `docs/AI_HANDOFF.md`, then the task above
- do not rewrite the task into a second long plan unless a material contradiction/blocker is found
- implement, test, update handoff/state, commit and push
- final chat response must follow the short worker response contract in `docs/DEVELOPMENT_WORKFLOW.md`
