# Active task

`docs/tasks/JARVIS_SETTINGS_PERSISTENCE_AND_FACTORY_RESET.md` — make owner settings
durable (persist explicit Work executor/provider/model, Chat pin, permission tier
and workspace as an owner default inherited by new scopes/threads/restarts) and add
an owner-facing `♻️ 初始化设置` control. Implemented and verified; owner-typed
Discord click confirmation remains owner-only.

## Evidence

- Deterministic: `tests/v4-owner-defaults-reset.test.mjs` (9 tests) plus the full
  `npm test` 397/0 and `npm run check` 123/0.
- Real machine: `npm run smoke:owner-settings` (`scripts/owner-settings-reset-e2e.mjs`)
  over a copy of the real state file, one NEW node process per phase, a real Agent
  run, and the real supervised bridge restart reading the persisted owner defaults
  (`logs/bridge.log` `[state] owner defaults: ...`).

## Previous task

`docs/tasks/HUNYUAN3D_LOCAL_REPAIR_AND_SMOKE.md` — separate, unrelated local task;
not touched by this branch.
