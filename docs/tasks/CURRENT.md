# Active task

`docs/tasks/JARVIS_V4_P3_0_TIMEOUT_POLICY_CLEANUP.md`

## Branch

`jarvis-v4-p3-ai-techlead-shadow`

## Status

P3.0 timeout-policy cleanup is the **priority blocker** before AI TechLead implementation.

The previously prepared TechLead task remains queued at:

`docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`

Do not start TechLead implementation until P3.0 passes.

## Objective

Remove/redesign Jarvis-owned elapsed-time limits that can make valid owner work fail merely because an internal timer fired.

Key product rule:

- Work/Chat/result delivery must not terminally fail because Jarvis waited N seconds;
- low-level per-attempt transport timeouts may remain only as internal failure detectors with durable state + automatic recovery;
- completed results must survive Discord/network timeout and must never require rerunning the Agent;
- preserve real Discord/platform deadlines, rate-limit pacing, retry backoff, cleanup TTLs, progress repaint timers and necessary safety controls that do not expire owner work.

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

Restore this pointer to:

`docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`

Then stop that Worker job. Do not implement TechLead in the same job.

## Do not

- do not work on `main` directly;
- do not blindly delete every timer;
- do not replace a timeout with a finite retry count that still permanently loses the operation;
- do not let Discord delivery failure become Worker execution failure;
- do not re-run a completed Work just to resend its result;
- do not add another daemon/database/queue framework;
- do not regress owner Stop/cancel, security, billing safeguards, permission controls or P2 lifecycle semantics.
