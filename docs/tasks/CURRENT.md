# Active task

`docs/tasks/JARVIS_INITIAL_SETUP_OWNER_DEFAULTS_FIX.md` — fix the product semantics
of `初始化设置`: it must **configure & save durable owner defaults**, not factory
reset. The destructive reset is now a separate advanced action
`⚠️ 恢复出厂设置` (plus the `!reset-settings` text alias). Prior task:
`docs/tasks/JARVIS_SETTINGS_RESET_LIVE_DISCORD_REPAIR.md` (ACK/control-plane
repair, preserved).

## Implemented

- `src/discord/renderers.mjs`: settings row now exposes `♻️ 初始化设置` (`set:init`)
  and a separate advanced `⚠️ 恢复出厂设置` (`set:reset`); new `initButtons()`
  (`init:save` / `init:settings` / `init:back`).
- `src/discord-ui.mjs`:
  - `#initializationPanel` + `#initializeOwnerDefaults` validate executor /
    provider / model / Chat pin and **refuse to write a partial or incompatible
    profile**, then persist the whole profile to `preferences.ownerDefaults`,
    sync the current scope, and update the in-process permission default.
  - `#factoryReset` (`⚠️ 恢复出厂设置`) is now separate, keeps its confirmation,
    Work-active refusal and data-preservation guarantees.
  - Settings shows the explanatory line; success shows the saved-defaults summary.
  - `!init-settings` / `!init-settings save` text aliases (local, no model).
- `src/state.mjs`: `getChannel()` layers owner defaults **under** explicit channel
  fields, so an existing entry (e.g. only a Chat pin) still inherits the durable
  Work route.
- `src/permission-manager.mjs`: `setDefaultLevel()` so a saved tier is inherited
  by new scopes immediately.
- `tests/v4-owner-defaults-reset.test.mjs` (15 tests) + `scripts/owner-settings-reset-e2e.mjs` (9/9).

## Evidence

- `npm test` 403/0, `npm run check` 123/0, `npm run smoke:owner-settings` 9/9,
  `npm run smoke:p222` 25/25, `npm run smoke:p2` 11/11.
- Remaining: owner real-Discord acceptance (7 steps in the task file).
