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

P2.2.1 recovery and P2.2.2 Chat selection are complete and preserved. The P2.2.3
stabilization pass (main taskbook + runtime-policy addendum) is code-complete:

- K1 fake many-model placeholder → real pagination;
- K2 interaction ACK matrix + removed the synchronous `policy.mjs` git scan that
  blocked the bridge event loop (likely cause of intermittent timeouts);
- K3 help view now carries the controls its copy references;
- K4 FULL is a real no-routine-approval policy and Work threads inherit FULL
  exactly (`PermissionManager.inheritLevel`); hard secret guards still apply;
- K5 production Work has no default wall-clock cap (`TASK_TIMEOUT_MS=0`);
  explicit positive operator limit optional; startup preflight separately bounded.

Ledger with repro/root cause/fix/verification: `docs/P2_2_3_BUG_BASH.md`.

Real-machine evidence in this pass: `npm test` 350 pass, `check` clean,
`smoke:p2` 11/11, `smoke:p22` 10/10, `smoke:p222` 25/25, `smoke:p22-insert`
14/14, `smoke:p22-model` 6/6, `smoke:p22-workspace` 8/8, `smoke:p223-full` 15/15
(real FULL Work, 0 prompts, real Stop), `verify:hook` 9/9, `doctor:discord`
login OK, supervisor recovery 23/23.

Remaining: owner real-Discord click/typing confirmation; WorkBuddy gateway 403 is
an external blocker for WorkBuddy-executor agent smokes only.

## Resume order (if continuing)

1. Pull latest branch/state and read `docs/P2_2_3_BUG_BASH.md`.
2. Do not redo K1–K5; only owner real-Discord validation remains for P2.2.3.
3. Do not start P3.

## Preserve

- P2.2.1 persistent Supervisor/LiteLLM/Task Scheduler watchdog/one bridge instance;
- P2.2.2 default AUTO, selectable manual Chat pin, no silent manual fallback, placeholder repair;
- Chat/Work separation and workspace/model persistence;
- Stop must kill the real process tree;
- safe AUTO billing policy;
- no secrets in repo/logs/evidence.

## Completion

Do not mark PASS until the main taskbook + blocking addendum are satisfied, all reproducible in-scope bugs are fixed or explicitly externally blocked, deterministic + focused real-machine E2E are green, state/evidence are updated, and verified remote HEAD is pushed. Do not start P3.
