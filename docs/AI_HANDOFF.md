# AI handoff

## Branch

`jarvis-v4-p2-2-hardening`

## Active task

`docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md` — P2 PR merge + mainline closeout.

## Current status

P2.2.5 user-hostile limits cleanup is complete. The limit audit
(`docs/P2_2_5_LIMIT_AUDIT.md`) classifies every user-facing cap/timeout/cooldown/
lockout/truncation/reset: 33 audited, 11 changed, 22 retained platform/security/
resource. No silent data-loss boundary remains for user-visible results.

Delivered behavior: real Discord input maxima, full long-result delivery, persisted
permission tier, non-blocking failure/restart diagnostics, practical configurable
Chat timeout, observable/overridable cooldowns, auto-compacting Chat history,
non-expiring approvals by default, unlimited follow-ups by default, configurable
Anthropic output ceiling.

## Preserve

- Supervisor/LiteLLM/Task Scheduler recovery and one bridge instance;
- Chat AUTO/manual selection and model persistence;
- model pagination/ACK/help consistency;
- Work duration unlimited by default; monotonic Work lifecycle, truthful insert
  accounting, one-shot Stop, stale-control safety;
- AUTO never silently spends on metered/unknown providers; manual pins never switch;
- secret/credential protection.

## External limitation

WorkBuddy gateway may still return `HTTP 403 request illegal`; keep documented as
external if unchanged. It must not block other providers or the bridge.

## Delivery

Implementation, focused regression `tests/v4-p225-limits.test.mjs`, deterministic
smoke `smoke:p225-limits`, and state/handoff updates are committed and pushed.
The live real-Discord owner smoke (P2.2.5 section E) was not performed and is
`PENDING_OWNER`.

## Next

Run `docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md`. Do not start P3.
