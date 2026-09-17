# Current project state

Keep this file compact. It is the first project-state file a new worker should read.

## Branch

`jarvis-v4-p2-2-hardening`

Stacked on P2/P2.1. Do not merge P2.2 yet.

## Current milestone

Jarvis V4 P2.2.3 — repository-wide stabilization / full bug bash.

Authoritative execution specs:

- `docs/JARVIS_V4_P2_2_3_REPOSITORY_STABILIZATION_TASK.md`
- `docs/JARVIS_V4_P2_2_3_RUNTIME_POLICY_ADDENDUM.md` (mandatory K4/K5 blockers discovered by real Work)

## Newly confirmed release blockers

### FULL permission mismatch

Owner set the parent channel to `全开放`, then created a Work thread. The Work still repeatedly requested approval for `unclassified shell command` and `sensitive file access`.

Confirmed code causes:

- `src/policy.mjs` evaluates sensitive-file/sensitive-shell approval checks before the `permissionLevel === 'full'` allow branch;
- Work-thread inheritance calls `permissionManager.switchLevel(thread.id, parentLevel)`. When parent level is FULL, `switchLevel()` returns `needsConfirm` and does not apply it; the ignored result leaves the new thread at default STANDARD.

Required invariant: after the owner confirms FULL, normal Agent tool execution must not keep prompting; a child Work thread must inherit FULL exactly. Keep hard secret-leak/secret-commit protections.

### Arbitrary 15-minute Work kill

`src/config.mjs` defaults `TASK_TIMEOUT_MS` to `900000`; `src/discord-ui.mjs` wraps each Agent turn with `withTimeout(...taskTimeoutMs...)` and kills the Agent at expiry. A real task was therefore stopped at 15m01s while still doing legitimate work.

Required invariant: production default has no hard Work wall-clock limit. A healthy task runs until result, explicit Stop, actual process/runtime failure, or an explicitly configured positive operator timeout. Stall notices/heartbeat are visibility only, not kill conditions.

## Other mandatory findings already reproduced

- `/model` many-model UI still emits a fake runnable placeholder (`!chatmodel opencode-go <model-id>`).
- previously observed Discord `该应用程序未响应` requires full ACK/defer verification across slash/button/modal paths.
- Help/control-panel text must not reference controls as clickable when not present in that view.

## Baselines to preserve

P2.2.1 recovery:

- persistent Supervisor with unlimited bounded-backoff recovery;
- Bridge process isolation;
- LiteLLM continuous health/recovery;
- Task Scheduler AtLogOn + 1-minute watchdog recovery;
- single-instance/process cleanup invariants.

P2.2.2 Chat selection:

- fresh/default Chat = AUTO/null;
- AUTO is selectable default, not a lock;
- real manual Provider/model pin persists and never silently falls back;
- explicit switch back to AUTO;
- placeholder IDs cannot persist and old bad state repairs to AUTO/null;
- Chat and Work model selections remain independent.

## Audit scope

The active task covers existing product behavior only: native/text commands, control-panel/button/modal UX, Chat routing, Work orchestration, permissions/approvals, workspace/session/state persistence, attachments/context controls, queue/stop/live insert, startup/recovery/LiteLLM/process lifecycle, failure handling and help/status/diagnostics consistency.

Every reproducible in-scope bug found by the matrix must be fixed, explicitly externally blocked, or proven to be a new out-of-scope feature request. K4/K5 may not be deferred.

## Required evidence

Maintain `docs/P2_2_3_BUG_BASH.md` as the compact bug ledger. Run deterministic regression plus focused real Windows/Discord/provider E2E as defined by the main taskbook and runtime-policy addendum. Do not fabricate owner-only Discord interaction evidence.

## Preserve

- ordinary Chat never starts an Agent;
- Work model selection/persistence independent from Chat;
- LiteLLM primary + OpenCode Go direct architecture;
- AUTO does not unexpectedly use disallowed metered routes;
- Stop controls the real session/process;
- no secrets in repo/logs/evidence.

## Non-goals

No P3 finance/market monitoring, Longbridge/Futu, new provider architecture, voice, web dashboard, Agent-swarm product feature, Redis/Postgres, Windows Service/NSSM/PM2/Docker, or speculative rewrite.

## Next action

Resume/execute P2.2.3 using both authoritative specs. Fix K4/K5 first because the current permission and timeout behavior prevents a trustworthy long bug-bash run; then continue the full matrix, commit + push, and stop when all release blockers are closed.
