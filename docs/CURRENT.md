# Current project state

Keep this file compact. It is the first project-state file a new worker should read.

## Branch

`jarvis-v4-p2-2-hardening`

Stacked on P2/P2.1. Do not merge P2.2 yet.

## Current milestone

Jarvis V4 P2.2.3 — repository-wide stabilization / full bug bash.

Authoritative spec:

`docs/JARVIS_V4_P2_2_3_REPOSITORY_STABILIZATION_TASK.md`

## Why this milestone exists

P2.2.1 Supervisor/autostart recovery and P2.2.2 Chat model selection are complete and verified, but owner validation immediately exposed further adjacent product bugs. Instead of continuing one-off fixes, P2.2.3 is one structured pass across every implemented Jarvis surface with a feature matrix, regression tests, real-machine smoke and a compact bug ledger.

Known mandatory findings already reproduced:

- `/model` on a provider with many models still instructs `!chatmodel opencode-go <model-id>` even though `<model-id>` is intentionally rejected; this must become a real selectable/paginated model path.
- previously observed Discord `该应用程序未响应` requires systematic ACK/defer verification for all slash/button/modal interactions.
- Help/control-panel text must not reference controls as clickable when the controls are not actually present in the current view.

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

The active task covers existing product behavior only: native commands, text commands, control-panel/button/modal UX, Chat routing, Work orchestration, permissions/approvals, workspace/session/state persistence, attachments/context controls, queue/stop/live insert, startup/recovery/LiteLLM/process lifecycle, failure handling, help/status/diagnostics consistency.

Every reproducible in-scope bug found by the matrix must be fixed, explicitly blocked by an external limitation, or proven to be a new out-of-scope feature request. Release-blocking bugs may not be silently deferred.

## Required evidence

Maintain `docs/P2_2_3_BUG_BASH.md` as the compact bug ledger. Run deterministic regression plus focused real Windows/Discord/provider E2E as defined by the taskbook. Do not fabricate owner-only Discord interaction evidence if the worker cannot impersonate the owner.

## Preserve

- ordinary Chat never starts an Agent;
- Work model selection/persistence independent from Chat;
- LiteLLM primary + OpenCode Go direct architecture;
- AUTO does not unexpectedly use disallowed metered routes;
- permissions/approval/stop control the real session/process;
- no secrets in repo/logs/evidence.

## Non-goals

No P3 finance/market monitoring, Longbridge/Futu, new provider architecture, voice, web dashboard, Agent-swarm product feature, Redis/Postgres, Windows Service/NSSM/PM2/Docker, or speculative rewrite.

## Next action

Execute `docs/JARVIS_V4_P2_2_3_REPOSITORY_STABILIZATION_TASK.md`, fix all reproducible in-scope bugs, verify the complete matrix, commit + push, then stop.
