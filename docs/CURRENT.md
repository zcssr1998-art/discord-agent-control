# Current project state

## Branch

`jarvis-settings-persistence-reset-task`

## Current milestone

Persistent owner settings + `初始化设置` (implemented and verified on this branch;
owner-typed Discord click confirmation is owner-only). Task:
`docs/tasks/JARVIS_SETTINGS_PERSISTENCE_AND_FACTORY_RESET.md`.

- `StateStore.preferences.ownerDefaults` (schema v1) is the single durable owner
  profile: Work executor/provider/model, Chat pin, permission tier and the saved
  workspace. `getChannel()` applies it to a scope with no explicit override; the
  Work model is resolved as a lower-priority candidate so channel > workspace >
  owner default > built-in still holds.
- Explicit choices persist it: `rememberWorkModel`, `#switchExecutor`,
  `#switchProvider`, `#applyChatSelection`, and an owner-facing permission switch
  (`onChange` meta `explicit`; trusted thread inheritance never overwrites it).
- `♻️ 初始化设置` in Settings uses `确认初始化`/`取消`; it resets settings only
  (owner profile, lastWorkModel, workspace, workspace model selections, persisted
  tiers and per-channel routing overrides) and refuses while Work is active.
- Verification: `npm test` 397/0, `npm run check` 123/0,
  `npm run smoke:owner-settings` 8/8 (real state copy, new process per phase, real
  Agent run); live supervised bridge restart logged
  `[state] owner defaults: executor=claude provider=opencode-go model=deepseek-v4.1-flash`.

Jarvis V4 P2 is complete and merged to `main`. Release merge / closeout task
(complete): `docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md`.

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
- One Supervisor + one Bridge; the live checkout is on
  `jarvis-settings-persistence-reset-task` (verification of this task).
- The live supervised bridge was restarted (bridge pid 45836) and logged the
  persisted owner defaults; the updater reports BLOCKED because the live branch is
  not `AUTO_UPDATE_BRANCH=main` (expected until this branch is merged).
- Real Discord command fetch-back: `/work task max_length == 6000`, schema matches (0 mismatch).

## Owner acceptance

COMPLETE — real-Discord acceptance on build `e1d7a78` (Tiny Chat / Work / Stop / after-Stop
recovery / `!status` all PASS). `main` is a pure merge of that verified content; no
post-acceptance code change was made.

## External limitation

WorkBuddy gateway still returns `HTTP 403 request illegal` (`WorkBuddy status=FAIL`). It is
external and does not block other providers, the updater or Bridge availability.

## Next action

Merge `jarvis-settings-persistence-reset-task` to `main` (not done here), then have
the owner confirm the Discord-only parts on the live bridge: select a non-default
setting, restart, reopen `/settings`, press `♻️ 初始化设置` (confirm/cancel), and
check a brand-new Work thread. Do **not** start P3 yet.
