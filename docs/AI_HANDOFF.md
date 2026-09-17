# AI handoff

## Branch

`main`

## Active task

None. P2 release merge / mainline closeout is complete
(`docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md`). Do **not** start P3.

## Current status

Jarvis V4 P2 is complete on `main`. PR #4 (`jarvis-v4-p2-control-context`, merge `507df36`)
landed first; PR #5 (`jarvis-v4-p2-2-hardening`) was reconciled against the new `main` and merged
as `f938e88`. `main` contains the P2/P2.1 control-panel/native-command work and every
P2.2.1–P2.2.6 hardening fix (P2.2.4 lifecycle `aa6dc27` verified ancestor).

## Verified on main

- `npm test` 386/0, `npm run check` 121/0.
- `smoke:p2` 11/11, `smoke:p22` 10/10, `smoke:p222` 25/25, `smoke:p22-insert` 14/14,
  `smoke:p223-full` 15/15, `smoke:p224-lifecycle` 21/21, `smoke:p225-limits` 23/23,
  `smoke:p226-update` 49/49, `verify:hook` 9/9.
- `scripts/smoke-supervisor-recovery.ps1` 22/23 — the miss is only the test's negative
  "supervisor really stopped" window; Task Scheduler restarted it faster than the 5s assertion.
  All substantive recovery checks passed.
- Live runtime: Task Scheduler -> Supervisor -> Bridge, one instance, checkout on `main`,
  running `f938e88`, updater `source=origin/main` `UP_TO_DATE`.
- Real Discord schema fetch-back (`npm run doctor:commands`): `/work task max_length == 6000`,
  0 mismatches.

## Preserved invariants (do not regress)

- Supervisor/LiteLLM/Task Scheduler recovery and exactly one Bridge;
- Chat default AUTO + manual pin semantics + model persistence; AUTO never silently spends on
  metered/unknown billing;
- pagination/ACK/help consistency; FULL persistent owner semantics; unlimited default Work
  duration; monotonic Work lifecycle, truthful insert accounting, one-shot Stop, stale-control
  safety; P2.2.5 full result delivery, auto-compact, visible cooldown;
- fast-forward-only safe self-update with rollback/quarantine and no second daemon;
- secret/credential protection (no token in logs, diffs, notifications or state).

## Owner acceptance

COMPLETE on build `e1d7a78` (real Discord Tiny Chat / Work / Stop / after-Stop recovery /
`!status`). `main` is a pure merge of that content; no post-acceptance code change.

## External limitation

WorkBuddy gateway `HTTP 403 request illegal` is external and must never block other providers,
the updater state or Bridge availability.

## Next

No active task. P3 requires a fresh explicit task/branch.
