# Active task

Current execution specification:

`docs/JARVIS_V4_P2_2_3_REPOSITORY_STABILIZATION_TASK.md`

Mandatory blocking addendum discovered by the first real P2.2.3 Work run:

`docs/JARVIS_V4_P2_2_3_RUNTIME_POLICY_ADDENDUM.md`

Branch: `jarvis-v4-p2-2-hardening`

## Why this task is active

P2.2.1 recovery and P2.2.2 Chat selection are complete, but owner validation continued to expose adjacent product bugs. P2.2.3 is one structured repository-wide stabilization pass; do not return to one-off fixes.

Known mandatory issues now include:

1. `/model` for a many-model provider emits a fake placeholder command such as `!chatmodel opencode-go <model-id>`;
2. slash-command ACK reliability (`该应用程序未响应`) must be systematically exercised across every command/button/modal path;
3. help/control-panel navigation must not describe controls as clickable when they are not present;
4. **FULL permission is not actually FULL**: sensitive-path checks run before the FULL allow rule, and a new Work thread attempts to inherit FULL through `switchLevel()`, which requires confirmation and silently leaves the child at STANDARD;
5. **the 15-minute Work wall-clock kill is unacceptable**: `TASK_TIMEOUT_MS` defaults to `900000` and `runTask` kills a healthy Agent at that boundary. Production default must be unlimited; duration alone is not failure.

## Required runtime-policy direction

Use the blocking addendum as authoritative for K4/K5:

- FULL / 全开放 = no routine approval prompts after the owner has confirmed it once; child Work threads inherit it exactly; keep only deterministic hard safety guards such as secret-leak/secret-commit protection.
- No arbitrary default Work duration limit. A healthy task runs until result, explicit Stop, actual process/runtime failure, or an explicitly configured positive operator timeout.
- Stall/heartbeat remains observability, not a reason to kill a live task.

## Scope

Execute the complete audit matrix in the main taskbook plus the blocking addendum. Fix every reproducible in-scope bug found during the pass, add focused regression coverage, run real Windows/Discord/provider smokes where deterministic tests are insufficient, and keep a compact bug ledger at `docs/P2_2_3_BUG_BASH.md`.

Do not start P3 or add unrelated architecture.

## Preserve

- P2.2.1 Supervisor/Task Scheduler/watchdog recovery;
- P2.2.2 AUTO/manual Chat semantics and placeholder repair;
- Work model persistence independent from Chat;
- Chat never starts an Agent;
- safe AUTO billing policy;
- single-instance/process cleanup and real Stop semantics;
- no secrets in repo/logs.

## Completion

Only mark complete after the main taskbook + blocking addendum audit/regression/E2E requirements are satisfied. K4/K5 are release blockers. Commit + push and verify remote HEAD.
