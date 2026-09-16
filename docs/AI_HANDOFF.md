# AI handoff

Keep this file short and only add facts that help a successor resume without reconstructing chat history.

## Branch

`jarvis-v4-p2-2-hardening` (stacked on P2/P2.1; do not merge P2.2 yet).

## Active task

`docs/JARVIS_V4_P2_2_3_REPOSITORY_STABILIZATION_TASK.md`

## Current status

P2.2.1 Supervisor recovery and P2.2.2 Chat model selection are complete and must be preserved. The owner has requested one repository-wide stabilization pass because adjacent bugs continued surfacing after focused fixes.

Already reproduced mandatory findings:

- many-model Chat UI still emits a fake runnable placeholder (`!chatmodel opencode-go <model-id>`) even though placeholders are now rejected;
- previous `/status` Discord `该应用程序未响应` means ACK timing/reply semantics need matrix coverage across every slash/button/modal path;
- help text can reference emoji controls that are not actually present in the help view.

## Execution model

Use the active taskbook's feature matrix. Fix every reproducible in-scope current-feature bug discovered. Keep a compact ledger at `docs/P2_2_3_BUG_BASH.md`; do not dump logs there. Focused workers are allowed only by domain and must not duplicate whole-repo scans/replanning.

## Preserve

- P2.2.1: persistent Supervisor, LiteLLM recovery, Task Scheduler watchdog, one bridge instance;
- P2.2.2: default AUTO/null, selectable manual Chat pin, no silent manual fallback, switch back to AUTO, placeholder repair;
- Chat/Work separation, workspace/model persistence, permission/approval/stop semantics;
- safe AUTO billing policy;
- no secrets in repo/logs.

## Completion

Do not mark PASS until the audit matrix has been exercised, all reproducible in-scope bugs are fixed or explicitly externally blocked, regression and focused real-machine E2E are green, state/evidence are updated, and the verified commit is pushed. Do not start P3.
