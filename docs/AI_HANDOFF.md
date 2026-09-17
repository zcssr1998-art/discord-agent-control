# AI handoff

Keep this file short and only add facts that help a successor resume without reconstructing chat history.

## Branch

`jarvis-v4-p2-2-hardening` (stacked on P2/P2.1; do not merge P2.2 yet).

## Active task

Main:
`docs/JARVIS_V4_P2_2_3_REPOSITORY_STABILIZATION_TASK.md`

Mandatory blocking addendum:
`docs/JARVIS_V4_P2_2_3_RUNTIME_POLICY_ADDENDUM.md`

## Current status

P2.2.1 Supervisor recovery and P2.2.2 Chat model selection are complete and must be preserved. The owner requested a repository-wide stabilization pass because adjacent bugs kept surfacing.

The first real P2.2.3 Work run exposed two additional release blockers:

1. **FULL is not really FULL.** `policy.mjs` asks on sensitive paths before reaching the FULL allow branch. Separately, Work-thread creation inherits permission with `switchLevel(thread.id, parentLevel)`; FULL returns `needsConfirm` and is not applied, so the child silently executes as STANDARD.
2. **Work is hard-killed after 900s.** `TASK_TIMEOUT_MS` defaults to `900000` and `runTask` kills the Agent on wall-clock expiry. The owner explicitly rejects arbitrary duration caps.

Required semantics are in the addendum: confirmed FULL means no routine approval prompts and exact child-thread inheritance (hard secret-leak/secret-commit guards remain); default Work duration is unlimited, with explicit Stop/process failure/optional positive operator timeout as termination paths. Stall/heartbeat is visibility only.

Other already-reproduced mandatory findings:

- many-model Chat UI emits fake runnable `<model-id>` placeholder text;
- previous `/status` `该应用程序未响应` requires complete interaction ACK coverage;
- help text can reference controls not actually visible in that view.

## Resume order

1. Pull latest branch/state.
2. Check whether the previous timed-out Worker/process/session still exists; resume if possible rather than starting duplicate work.
3. Fix K4/K5 first because they block a trustworthy long stabilization run.
4. Continue the main taskbook matrix and write findings to `docs/P2_2_3_BUG_BASH.md`.

## Preserve

- P2.2.1 persistent Supervisor/LiteLLM/Task Scheduler watchdog/one bridge instance;
- P2.2.2 default AUTO, selectable manual Chat pin, no silent manual fallback, placeholder repair;
- Chat/Work separation and workspace/model persistence;
- Stop must kill the real process tree;
- safe AUTO billing policy;
- no secrets in repo/logs/evidence.

## Completion

Do not mark PASS until the main taskbook + blocking addendum are satisfied, all reproducible in-scope bugs are fixed or explicitly externally blocked, deterministic + focused real-machine E2E are green, state/evidence are updated, and verified remote HEAD is pushed. Do not start P3.
