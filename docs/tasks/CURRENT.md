# Active task

Current execution specification:

`docs/JARVIS_V4_P2_2_HARDENING_TASK.md`

Branch: `jarvis-v4-p2-2-hardening`

Status: task prepared and branch created from verified P2/P2.1 head `6d7f60af241ef65b226b6ebfc602593b797b5231`. Implementation not yet started on this branch. [PREPARED 2026-09-16]

Execution order:

1. single-instance runtime guard + PID/branch/commit/uptime/instance identity
2. Windows Task Scheduler autostart using the existing supervisor; install/remove/status/idempotency; no automatic reboot
3. SQLite WAL durable operational store + safe restart/interrupted semantics
4. parent-channel compact Work summary/control card reusing existing thread/follow-up/stop paths
5. incrementally split `discord-ui.mjs` without a behavior rewrite
6. minimal Windows CI + deterministic `/doctor`
7. targeted tests -> full `npm test` + `npm run check` + existing `npm run smoke:p2`
8. Windows real-machine smoke + minimal owner Discord smoke; real reboot remains owner-only

Worker instructions:

- read `AGENTS.md`, `docs/CURRENT.md`, `docs/AI_HANDOFF.md`, then the active spec
- do not redo P2/P2.1; this branch is stacked on their verified head
- use the supervisor as the only restart owner for Jarvis + LiteLLM
- autostart means current-user logon via Task Scheduler, not a Windows service
- second live Jarvis instance must fail before Discord login; never auto-kill another process
- do not silently auto-resume stale Agent work after a bridge/OS restart
- SQLite is local operational persistence only; do not move secrets into it
- parent summary card must reuse the same runId/follow-up/stop logic and must not duplicate verbose thread progress
- `/doctor`, status, autostart checks and persistence are deterministic: no LLM calls
- use targeted tests while coding; full regression at milestone boundaries
- never reboot the owner machine automatically; use `PENDING_OWNER_REBOOT_SMOKE` until the owner explicitly restarts
- preserve all P0/P1/P2/P2.1 routing, security, permissions, queue, thread, attachment and Chat-history behavior
- update state/handoff/evidence, commit and push to `jarvis-v4-p2-2-hardening`
- final chat response must follow the short Worker response contract
