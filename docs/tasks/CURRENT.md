# Active task

Current execution specification:

`docs/JARVIS_V4_P2_2_3_REPOSITORY_STABILIZATION_TASK.md`

Branch: `jarvis-v4-p2-2-hardening`

## Why this task is active

P2.2.1 recovery and P2.2.2 Chat selection are complete, but owner validation still exposed adjacent user-facing bugs immediately afterward. The current pattern of one-off fixes is no longer acceptable; this task performs one structured repository-wide stabilization pass over all implemented Jarvis surfaces.

Known mandatory issues include:

1. `/model` for a many-model provider still tells the owner to run a fake placeholder command such as `!chatmodel opencode-go <model-id>`, which the new validator correctly rejects;
2. slash-command ACK reliability (`该应用程序未响应`) must be systematically exercised across every command/button/modal path;
3. help/control-panel navigation must not describe emoji controls as if they are clickable when they are not present in that view.

## Scope

Execute the complete audit matrix in the taskbook. Fix every reproducible in-scope bug found during the pass, add focused regression coverage, run real Windows/Discord/provider smokes where deterministic tests are insufficient, and keep a compact bug ledger at `docs/P2_2_3_BUG_BASH.md`.

Do not start P3 or add new product architecture.

## Preserve

- P2.2.1 Supervisor/Task Scheduler/watchdog recovery;
- P2.2.2 AUTO/manual Chat semantics and placeholder repair;
- Work model persistence independent from Chat;
- Chat never starts an Agent;
- safe AUTO billing policy;
- single-instance/process cleanup/permissions/approval invariants;
- no secrets in repo/logs.

## Completion

Only mark complete after the taskbook's audit matrix, regression suite, real-machine E2E and bug-ledger requirements are satisfied. Commit + push and verify remote HEAD.
