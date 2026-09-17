# Active task

`docs/tasks/JARVIS_V4_P3_0_TIMEOUT_POLICY_CLEANUP.md`

## Branch

`jarvis-v4-p3-ai-techlead-shadow`

## Status

P3.0 timeout-policy cleanup is the current priority blocker.

Queued sequence after P3.0:

1. `docs/tasks/JARVIS_V4_P3_1_CHAT_WEB_SEARCH.md`
2. `docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`

Do not skip P3.1 and do not start TechLead until both P3.0 and P3.1 pass.

## Objective

Remove/redesign Jarvis-owned elapsed-time limits that can make valid owner work fail merely because an internal timer fired.

Key invariant:

- time alone must not terminally fail valid Chat/Work/result delivery;
- transport timeouts may only be recoverable per-attempt safety mechanisms;
- completed results must survive network failure without rerunning the Agent.

## Required startup order

Read:

1. `AGENTS.md`
2. global `GLOBAL_AI_RULES.md`
3. `docs/CURRENT.md`
4. `docs/AI_HANDOFF.md`
5. this file
6. `docs/tasks/JARVIS_V4_P3_0_TIMEOUT_POLICY_CLEANUP.md`
7. current branch / HEAD / git status / relevant diff
8. only timeout/result-delivery/Work-lifecycle/Discord-transport code required by the task

Do not generate a second architecture plan. The task file is authoritative.

## After P3.0 passes

Set this pointer to:

`docs/tasks/JARVIS_V4_P3_1_CHAT_WEB_SEARCH.md`

Then stop that Worker job. Do not implement P3.1 or TechLead in the same job unless explicitly requested.

## Do not

- do not work on `main` directly;
- do not blindly delete every timer;
- do not replace a timeout with a finite retry count that still permanently loses the operation;
- do not let Discord delivery failure become Worker execution failure;
- do not re-run a completed Work just to resend its result;
- do not add another daemon/database/queue framework;
- do not regress owner Stop/cancel, security, billing safeguards, permission controls or P2 lifecycle semantics.
