# AI handoff

## Branch

`jarvis-v4-p2-2-hardening`

## Active task

`docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md` (P2.2.6 is complete; do not start P3)

## Current status

P2.2.6 Runtime Freshness / Safe Self-Update is implemented, tested and verified on the real
Windows/Discord machine. GitHub HEAD, the Windows live runtime SHA and the Discord registered
command schema now converge automatically instead of drifting until a manual restart.

Key mechanics (see `docs/JARVIS_V4_P2_2_6_SAFE_SELF_UPDATE_TASK.md`):

- `src/updater.mjs` is dependency-free so a candidate can be validated in a throwaway
  `git worktree` before the live checkout moves (`scripts/p226-update-smoke.mjs` is the gate).
- Fast-forward only. Dirty/diverged -> `BLOCKED`. Previous known-good SHA recorded; a failing
  SHA is quarantined until the remote SHA changes. Post-update crash loops are rolled back by
  `scripts/update-helper.mjs`, invoked by the existing Supervisor.
- The Bridge exits with code 74 after a verified apply; the Supervisor (Task Scheduler ->
  Supervisor -> Bridge) relaunches exactly one Bridge from the same checkout.
- `/update status|now|pause|resume` added; `/status` and `/doctor` show local/remote SHA and the
  command-schema fetch-back result (including real `/work task max_length`).

## Verified on the real machine

- bootstrap restart loaded the new runtime (`build=jarvis-v4-p2-2-hardening@496de33`);
- `npm run doctor:commands` fetched the real Discord schema back: `/work task max_length == 6000`,
  schema matches desired (0 mismatch);
- `logs/bridge.log` shows `[update] enabled source=origin/jarvis-v4-p2-2-hardening` and
  `check(startup) ... -> UP_TO_DATE`;
- deterministic gates green: `npm test` 381/0, `check` 120/0, `smoke:p226-update` 45/45,
  `smoke:p225-limits` 23/23, `smoke:p223-full` 15/15, `smoke:p224-lifecycle` 21/21, `verify:hook` 9/9.

## Preserve

- Supervisor/LiteLLM/Task Scheduler recovery and one bridge instance;
- Chat AUTO/manual selection and model persistence;
- pagination/ACK/help consistency;
- FULL persistent owner semantics; unlimited default Work duration;
- monotonic Work lifecycle, truthful insert accounting, one-shot Stop and stale-control safety;
- P2.2.5 full result delivery, auto-compact, visible cooldown, non-blocking failure diagnostics;
- AUTO billing safeguards, manual-pin semantics, secret/credential protection.

## External limitation

WorkBuddy gateway may still return `HTTP 403 request illegal`; documented as external. It must not
block other providers, updater state or Bridge availability.

## Do not do

- do not execute the deferred release merge in the P2.2.6 Worker (now the active task);
- do not start P3;
- do not rerun the long Hunyuan3D reproduction;
- do not kill an active Work to deploy an update (the updater marks `UPDATE_PENDING` instead);
- do not add another independent daemon: the existing Supervisor owns lifecycle/restart/rollback.

## Next

Execute `docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md`.
