# AI handoff

## Branch

`jarvis-settings-persistence-reset-task`

## Active task

`docs/tasks/JARVIS_INITIAL_SETUP_OWNER_DEFAULTS_FIX.md` — fix `初始化设置` product
semantics (configure + save durable owner defaults, never factory reset) on top of
the preserved live Discord ACK repair
(`docs/tasks/JARVIS_SETTINGS_RESET_LIVE_DISCORD_REPAIR.md`). Owner real-Discord
acceptance is the only remaining check. Do **not** merge to `main`, do not start P3.

## Semantics fix (this task)

- `src/discord/renderers.mjs`: `♻️ 初始化设置` (`set:init`) is now the primary
  action; `⚠️ 恢复出厂设置` (`set:reset`) is a separate advanced row; new
  `initButtons()` (`init:save` / `init:settings` / `init:back`).
- `src/discord-ui.mjs`: `#initializationPanel` + `#initializeOwnerDefaults` validate
  executor/provider/model/Chat pin, refuse a partial/incompatible profile, persist
  the whole profile to `preferences.ownerDefaults`, sync the current scope, update
  the in-process permission default and show the saved summary. `#factoryReset`
  (`⚠️ 恢复出厂设置`) is separate. `!init-settings` / `!init-settings save` are
  local text aliases.
- `src/state.mjs`: `getChannel()` layers owner defaults UNDER explicit channel
  fields, so a pre-existing entry (e.g. only a Chat pin) still inherits the durable
  Work route.
- `src/permission-manager.mjs`: `setDefaultLevel()` makes a saved tier inherited by
  new scopes immediately.
- `scripts/owner-settings-reset-e2e.mjs`: phases cover init-save / factory-reset /
  init-refused / init-restart.

## Preserved live repair

Root cause was real Discord `10062 Unknown interaction` (deferred ACK arrived after
the 3s window during a REST stall), not handler ordering. The repair keeps: defer
first, owner-visible recovery message on failed ACK, and local aliases
(`!settings`, `!reset-settings`, `!init-settings`) that never touch
Chat/Work/LiteLLM. `#switchExecutor`/`#switchProvider` persist only a validated
executor/provider pair.

## Verified

- `npm test` 403/0; `npm run check` 123/0; `npm run smoke:owner-settings` 9/9;
  `npm run smoke:p222` 25/25; `npm run smoke:p2` 11/11.
- Real-machine: single supervised bridge; `doctor:discord` login OK;
  `doctor:commands` 0 mismatch; `verify:opencode-go` 17/17.

## Remaining (owner-only)

The 7 real-Discord steps in the task file: `/settings`; `♻️ 初始化设置` must open the
save flow (not reset to WorkBuddy); save a non-default route; `/status` shows it;
restart and re-check; new Work thread inherits route/permission/workspace;
`⚠️ 恢复出厂设置` verified separately.

## Preserved invariants (do not regress)

- Explicit channel field > workspace selection > durable owner default > product
  built-in; a saved model is still validated against the live provider and fails
  loudly.
- Trusted Work-thread permission inheritance never overwrites an explicit owner tier.
- `初始化设置` / `⚠️ 恢复出厂设置` delete no credentials/providers/Discord config/
  chat/task history/run database/logs/updater state/repo files and echo no secrets.
- Control-plane actions never route through Chat/Work/LiteLLM/LLM.

## Next

Owner real-Discord acceptance, then merge to `main`. P3 requires a fresh explicit
task/branch.
