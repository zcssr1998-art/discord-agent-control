# Current project state

## Branch

`jarvis-v4-p2-2-hardening`

## Current milestone

Jarvis V4 P2.2.6 — Runtime Freshness / Safe Self-Update: **complete**.

Authoritative completed task:

`docs/JARVIS_V4_P2_2_6_SAFE_SELF_UPDATE_TASK.md`

Next active task (do not execute in the P2.2.6 Worker):

`docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md`

## What P2.2.6 fixed

P2.2.5 source/tests passed, but the live Windows runtime and the Discord-registered Slash Command schema could drift from GitHub HEAD until the owner manually restarted the Bridge. P2.2.6 removes that drift class:

- a configured trusted remote/branch is checked automatically (production target after P2 merge: `origin/main`);
- `/status` and `/doctor` show running/local SHA vs fetched remote SHA and the full update state;
- updates never interrupt active/queued Work or a busy Agent: the state becomes `UPDATE_PENDING`;
- at a deterministic safe-idle boundary the candidate is verified in a throwaway `git worktree`, then the clean checkout is fast-forwarded;
- fast-forward only; dirty/diverged checkouts are `BLOCKED` (no auto stash/reset/merge/rebase);
- the previous known-good SHA is recorded; a bad SHA is quarantined so it cannot cause an update/restart loop;
- restart goes through the existing Task Scheduler -> Supervisor -> Bridge chain (dedicated exit code 74), exactly one Bridge;
- the Supervisor rolls back to the known-good SHA if a just-applied candidate keeps crashing;
- Discord application commands are re-synced and fetched back from Discord; `/doctor` reports schema PASS/FAIL and `/work task max_length` (verified live = 6000);
- owner controls: `/update status | now | pause | resume`;
- notifications only on pending/applied/verified/blocked/failed, never per poll;
- no secret/token/cookie/credential is logged or notified.

## Baselines preserved

- P2.2.1 Supervisor / LiteLLM / Task Scheduler watchdog recovery; one Bridge instance;
- P2.2.2 Chat default AUTO, manual pin, persistence, placeholder repair;
- P2.2.3 pagination, ACK hardening, help consistency, FULL semantics, unlimited default Work duration;
- P2.2.4 monotonic Work lifecycle, truthful insert accounting, one-shot Stop, stale-control safety;
- P2.2.5 owner-friendly limits cleanup, full result delivery, persistent permission tier, auto-compact, visible cooldown, no permanent channel lockout;
- AUTO never silently spends on metered/unknown billing; manual pins never silently switch; secrets protected.

## Existing evidence (deterministic)

```text
npm test                 -> 381 pass / 0 fail
npm run check            -> 120 file(s), 0 failed
npm run smoke:p226-update-> 45/45  (real temp git repos: fast-forward / dirty / diverged / rollback / quarantine / pause / schema / secrets)
npm run smoke:p225-limits-> 23/23
npm run smoke:p223-full  -> 15/15
npm run smoke:p224-lifecycle -> 21/21
npm run verify:hook      -> 9/9
```

## Next action

Execute `docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md` (PR #4/#5 merge + mainline closeout). Do **not** start P3.
