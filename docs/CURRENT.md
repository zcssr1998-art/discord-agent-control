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

## P2.2.3 status: fixes complete, awaiting owner real-Discord click validation

All reproducible in-scope blockers are fixed with deterministic regression and
real-machine evidence. Compact ledger: `docs/P2_2_3_BUG_BASH.md`.

Closed release blockers:

- K1 many-model Chat UI fake `<model-id>` placeholder → real pagination;
- K2 interaction ACK reliability → full ACK matrix + removed the synchronous
  `policy.mjs` git scan that could block the bridge event loop for up to 3s;
- K3 help view referenced controls it did not show → real controls added;
- K4 FULL was not FULL (policy ordering + Work-thread inheritance via
  `switchLevel`) → hard guards first, FULL allows routine calls, trusted
  `inheritLevel()` copies FULL exactly;
- K5 arbitrary 900s Work kill → production default unlimited
  (`TASK_TIMEOUT_MS=0`), explicit positive operator limit optional, startup
  preflight separately bounded.

Verification (real machine):

- `npm test` 350 pass; `npm run check` clean;
- `smoke:p2` 11/11, `smoke:p22` 10/10, `smoke:p222` 25/25, `smoke:p22-insert`
  14/14, `smoke:p22-model` 6/6, `smoke:p22-workspace` 8/8, `verify:hook` 9/9,
  `doctor:discord` login OK;
- `smoke:p223-full` 15/15 (real FULL Work with 0 approval prompts; real `!stop`);
- supervisor recovery `23/23` (kill bridge/LiteLLM/supervisor auto-recovered,
  one bridge instance; machine not rebooted).

## Remaining / external

- Owner-only: real Discord click/typing of `/panel`, `/model`, `/status`,
  `/doctor` after the final commit.
- WorkBuddy gateway `403 request illegal` (external, documented in
  `docs/WINDOWS_SMOKE.md`) still blocks WorkBuddy-executor agent smokes such as
  `smoke:local`; the bridge reports it unavailable and keeps other providers.

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

Commit/push the verified stabilization work and verify remote HEAD. Then the
owner performs the final real-Discord interaction confirmation. Do not start P3.
