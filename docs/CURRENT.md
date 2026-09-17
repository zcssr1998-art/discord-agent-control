# Current project state

## Branch

`jarvis-v4-p2-2-hardening`

## Current milestone

Jarvis V4 P2.2.5 — user-hostile limits cleanup. **DONE.** Ready for the deferred
P2 release merge.

Spec: `docs/JARVIS_V4_P2_2_5_USER_HOSTILE_LIMITS_CLEANUP_TASK.md`.
Audit: `docs/P2_2_5_LIMIT_AUDIT.md`.

## What changed

- K1/K2 real Discord input maxima: `/work` slash 6000, modal 4000.
- K3 one long-result delivery path (message / ordered chunks / preview + `.md`);
  Chat and Work final/intermediate answers are fully recoverable, never silently
  truncated; `clip()` stays for compact cards only.
- K4 owner permission tier persisted in `state.permissions`; survives restart,
  session/model/provider/executor/workspace change; Work threads inherit exactly.
- K5 failure/restart counters no longer lock the channel; episode-scoped
  diagnostics only.
- K6 `CHAT_TIMEOUT_MS` default 120000, operator-configurable, `0` = unlimited.
- K7 cooldowns visible in `/status`, `/doctor`, `!cooldown`; `!cooldown clear`
  retries immediately and scopes the reset.
- K8 Chat history auto-compacts into the summary before any destructive trim; a
  failed compact preserves history and warns.
- K9 `APPROVAL_TIMEOUT_MS` default 0 (no auto-deny); positive values still expire.
- K10 `MAX_WORK_FOLLOWUPS` default 0 (unlimited), finite cap shown truthfully.
- K11 `CHAT_MAX_OUTPUT_TOKENS` default 8192 replaces the hard-coded Anthropic 4096.

## Baselines preserved

- P2.2.1 Supervisor / LiteLLM / Task Scheduler watchdog recovery; one bridge instance.
- P2.2.2 Chat default AUTO, manual pin, persistence, placeholder repair.
- P2.2.3 pagination, ACK hardening, help consistency, FULL semantics, unlimited
  default Work duration (`TASK_TIMEOUT_MS=0`).
- P2.2.4 monotonic Work lifecycle, truthful insert accounting, one-shot Stop,
  stale-control safety, no terminal live controls.
- AUTO never silently spends on metered/unknown billing; manual pins never switch;
  secrets/credentials protected.

## Evidence

- `npm test` 372/372; `npm run check` 114 files / 0 failed.
- `smoke:p225-limits` 23/23; `smoke:p2` 11/11, `smoke:p22` 10/10, `smoke:p222` 25/25,
  `smoke:p22-insert` 14/14, `smoke:p223-full` 15/15, `smoke:p224-lifecycle` 21/21.

## Next action

`docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md` — P2 PR merge + mainline closeout.
Do not start P3. The live real-Discord owner smoke remains `PENDING_OWNER`.
