# Current project state

## Branch

`main`

## Current milestone

Jarvis V4 P2 is **complete and merged to `main`**. No active task.

Release merge / closeout task (complete):

`docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md`

## Merge result

- PR #4 `jarvis-v4-p2-control-context` -> `main`: merge commit `507df36`.
- PR #5 `jarvis-v4-p2-2-hardening` -> `main`, reconciled against the new `main`: merge commit
  `f938e88`.
- Final `main` contains the P2/P2.1 content (`6d7f60a`) and every P2.2.1–P2.2.6 fix
  (P2.2.4 lifecycle `aa6dc27` verified as an ancestor).
- The remote P2 feature branches are intentionally preserved. Safe cleanup candidates for a later
  explicit owner action: `jarvis-v4-p2-control-context`, `jarvis-v4-p2-2-hardening`,
  `jarvis-v4-p1-1-control-panel`, `jarvis-v4-p1-workflow`, `jarvis-v4-foundation`.

## What P2 delivered (all merged)

- P2: control panel, chat history / new / compact, attachments, native Work UX.
- P2.1: native slash commands + interactive Work controls with ACK hardening.
- P2.2.1: Supervisor / LiteLLM / Task Scheduler recovery; one Bridge instance.
- P2.2.2: Chat default AUTO, manual pin, persistence, placeholder repair.
- P2.2.3: pagination, ACK hardening, help consistency, FULL semantics, unlimited Work duration.
- P2.2.4: monotonic Work lifecycle, truthful insert accounting, one-shot Stop, stale-control safety.
- P2.2.5: owner-friendly limits cleanup, full result delivery, persistent permission tier,
  auto-compact, visible cooldown.
- P2.2.6: runtime freshness / fast-forward-only safe self-update, rollback + quarantine,
  Discord command-schema fetch-back, `/update status|now|pause|resume`.

## Verified on new `main` (release merge, 2026-09-17)

```text
npm test                 -> 386 pass / 0 fail
npm run check            -> 121 file(s), 0 failed
npm run smoke:p2         -> 11/11
npm run smoke:p22        -> 10/10
npm run smoke:p222       -> 25/25
npm run smoke:p22-insert -> 14/14
npm run smoke:p223-full  -> 15/15
npm run smoke:p224-lifecycle -> 21/21
npm run smoke:p225-limits    -> 23/23
npm run smoke:p226-update    -> 49/49
npm run verify:hook      -> 9/9
scripts/smoke-supervisor-recovery.ps1 -> 23/23
```

G4 now asserts that the killed supervisor process actually exited instead of racing a fixed
observation window, so the Task Scheduler restart semantics are verified deterministically.

## Live runtime

- Existing chain only: Task Scheduler -> `scripts/start-supervisor.ps1` -> Bridge.
- One Supervisor + one Bridge; live checkout on `main`, running SHA `086899e`.
- Updater live: `[update] enabled source=origin/main` and
  `check(startup) ... UP_TO_DATE`.
- Real Discord command fetch-back: `/work task max_length == 6000`, schema matches (0 mismatch).

## Owner acceptance

COMPLETE — real-Discord acceptance on build `e1d7a78` (Tiny Chat / Work / Stop / after-Stop
recovery / `!status` all PASS). `main` is a pure merge of that verified content; no
post-acceptance code change was made.

## External limitation

WorkBuddy gateway still returns `HTTP 403 request illegal` (`WorkBuddy status=FAIL`). It is
external and does not block other providers, the updater or Bridge availability.

## Next action

None. Do **not** start P3 until an explicit new task/branch is created.
