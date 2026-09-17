# Active task

Current execution specification:

`docs/JARVIS_V4_P2_2_3_REPOSITORY_STABILIZATION_TASK.md`

Mandatory blocking addendum discovered by the first real P2.2.3 Work run:

`docs/JARVIS_V4_P2_2_3_RUNTIME_POLICY_ADDENDUM.md`

Branch: `jarvis-v4-p2-2-hardening`

## Status

Code-complete. K1–K5 are fixed with deterministic regression and real-machine
E2E; see `docs/P2_2_3_BUG_BASH.md`. Final step before completion: owner
real-Discord interaction confirmation, then stop (no P3).

Fixed blockers:

1. `/model` many-model placeholder → real pagination;
2. ACK reliability → full ACK matrix + removed the synchronous hook-path git scan
   that could block the bridge event loop;
3. help view ↔ referenced controls aligned;
4. **K4 FULL**: hard guards first, FULL allows routine calls, Work thread inherits
   FULL exactly via `PermissionManager.inheritLevel`;
5. **K5 timeout**: production default unlimited (`TASK_TIMEOUT_MS=0`), explicit
   positive operator limit optional, startup preflight bounded separately.

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
