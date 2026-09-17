# AI handoff

## Branch

`jarvis-v4-p2-2-hardening`

## Active task

`docs/JARVIS_V4_P2_2_5_USER_HOSTILE_LIMITS_CLEANUP_TASK.md`

## Current status

P2.2.1–P2.2.4 fixes are complete and owner P2.2.4 real-Discord validation is PASS.

Before release merge, source inspection found a final class of owner-hostile hidden limits that must be cleaned up: artificial Work input caps, silent Chat/Work output truncation, permission tier resets, permanent channel lockout from historical failures/restarts, aggressive Chat timeout, opaque provider cooldowns, silent Chat-history trimming, approval expiry, follow-up queue cap and hard-coded Anthropic output ceiling.

The previous release-integration task `docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md` is deferred until P2.2.5 passes. Do not merge PR #4/#5 in this Worker job.

## Execute

1. Read the active P2.2.5 task and inspect only the relevant limit/config/UI/history/runtime code.
2. Create/update `docs/P2_2_5_LIMIT_AUDIT.md` and classify every meaningful user-facing limit as PLATFORM / SECURITY / RESOURCE / POLICY.
3. Implement the mandatory fixes and focused `smoke:p225-limits` coverage.
4. Run required regression gates and one short real-Discord smoke where possible.
5. Commit/push/verify remote head.
6. Point the next active task back to `docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md`, then stop. Do not execute that merge in the same job.

## Preserve

- Supervisor/LiteLLM/Task Scheduler recovery and one bridge instance;
- Chat AUTO/manual selection and model persistence;
- model pagination/ACK/help consistency;
- Work duration unlimited by default;
- monotonic Work lifecycle, truthful insert accounting, one-shot Stop and stale-control safety;
- AUTO must not silently spend on metered/unknown providers;
- manual pins must not silently switch;
- secrets/credentials remain protected.

## External limitation

WorkBuddy gateway may still return `HTTP 403 request illegal`; keep it documented as external if unchanged. It must not block other providers or the bridge.
