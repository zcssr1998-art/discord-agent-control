# Current project state

## Branch

`jarvis-settings-persistence-reset-task`

## Current milestone

`初始化设置` semantics fix (implemented and verified deterministically on this
branch; owner real-Discord acceptance is the only remaining check). Task:
`docs/tasks/JARVIS_INITIAL_SETUP_OWNER_DEFAULTS_FIX.md`, on top of the live
Discord ACK repair `docs/tasks/JARVIS_SETTINGS_RESET_LIVE_DISCORD_REPAIR.md`.

- `♻️ 初始化设置` (`set:init`) now opens a local, zero-model flow that validates and
  **saves the effective Chat/Work/permission/workspace configuration as durable
  owner defaults**, syncs the current scope, and shows the saved summary. It never
  factory-resets.
- `⚠️ 恢复出厂设置` (`set:reset` + `!reset-settings`) is now a separate advanced
  action with confirmation, Work-active refusal and the same data-preservation
  guarantees.
- Validation refuses executor/provider/model/Chat-pin combinations that are
  missing or incompatible: a partial profile is never written.
- `StateStore.getChannel()` layers owner defaults under explicit channel fields on
  pre-existing entries; `PermissionManager.setDefaultLevel()` makes a saved tier
  inherited by new scopes immediately.
- Preserved live-repair invariants: control commands defer before work, a failed
  ACK produces an owner-visible recovery message, and `/status` / `/settings` /
  init never touch Chat/Work/LLM.

### Prior milestone (preserved)

Live-Discord repair of the settings/reset regression found after `cb3ed4d`:

- Root cause: `/status` / `/settings` failed with real Discord `10062 Unknown
  interaction` (deferred ACK arrived after the 3s window during a REST transport
  stall; same process logged a 10s ready-DM timeout with `proxy source=none`).
  The Chat failure was the channel's explicit manual pin `opencode-go/grok-4.6`
  (valid model, momentarily unreachable), not owner-default inheritance.
- Fix: failed ACKs emit an owner-visible recovery message; deterministic text
  aliases (`!settings`, `!reset-settings`, `!init-settings`) never call a model;
  `#switchExecutor`/`#switchProvider` persist only a validated pair.

### Verification (this branch)

- `npm test` 403/0, `npm run check` 123/0, `npm run smoke:owner-settings` 9/9,
  `npm run smoke:p222` 25/25, `npm run smoke:p2` 11/11.
- Real-machine: single supervised bridge; `doctor:discord` login OK,
  `doctor:commands` 0 mismatch, `verify:opencode-go` 17/17.

The `StateStore.preferences.ownerDefaults` (schema v1) profile remains the single
durable owner profile (Work executor/provider/model, Chat pin, permission tier,
workspace). Precedence stays explicit channel field > workspace > owner default >
product built-in; the Work model is resolved as a lower-priority candidate.

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
  `jarvis-settings-persistence-reset-task` (semantics fix committed) with the
  single supervised Bridge reloaded from it.
- The updater reports BLOCKED because the live branch is not
  `AUTO_UPDATE_BRANCH=main` (expected until this branch is merged).
- Real Discord command fetch-back: `/work task max_length == 6000`, schema matches (0 mismatch).

## Owner acceptance

PENDING — the 7-step real-Discord acceptance in
`docs/tasks/JARVIS_INITIAL_SETUP_OWNER_DEFAULTS_FIX.md` has not been run by the
owner yet. Deterministic + real-machine smokes are green.

## External limitation

WorkBuddy gateway still returns `HTTP 403 request illegal` (`WorkBuddy status=FAIL`). It is
external and does not block other providers, the updater or Bridge availability.

## Next action

Owner real-Discord acceptance on the live bridge (7 steps in
`docs/tasks/JARVIS_INITIAL_SETUP_OWNER_DEFAULTS_FIX.md`): `/settings` opens; `♻️ 初始化设置`
enters the configure/save flow and must **not** reset to WorkBuddy; save a non-default route;
`/status` shows it; restart Bridge and re-check; a new Work thread inherits
route/permission/workspace; `⚠️ 恢复出厂设置` is verified separately. Do **not** merge this
branch to `main` and do **not** start P3 until that passes.
