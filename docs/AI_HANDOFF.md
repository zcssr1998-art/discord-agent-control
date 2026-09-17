# AI handoff

## Branch

`jarvis-settings-persistence-reset-task`

## Active task

`docs/tasks/JARVIS_SETTINGS_PERSISTENCE_AND_FACTORY_RESET.md` — persistent owner
settings + `初始化设置`. Implemented and verified; owner-typed Discord click
confirmation is owner-only. Do **not** start P3.

## What changed

- `src/state.mjs`: `preferences.ownerDefaults` (schema v1) + `getOwnerDefaults` /
  `setOwnerDefaults` / `getOwnerDefaultPermission` / `resetOwnerSettings`;
  `getChannel()` layers owner defaults for a scope with no explicit override;
  `#seedOwnerDefaults` migrates from `lastWorkModel` only (permission/Chat pins are
  ambiguous and wait for the next explicit choice); `rememberWorkModel` updates the
  profile atomically. `productRoutingDefaults()` is the one canonical default table.
- `src/permission-manager.mjs`: `onChange(channelId, level, { explicit })`;
  `resetAll(defaultLevel)`.
- `src/session-manager.mjs`: owner model is the last saved candidate.
- `src/discord-ui.mjs`: explicit `#switchExecutor` / `#switchProvider` /
  `#applyChatSelection` persist the profile; `#startWorkThread` inherits the parent's
  effective route; `#factoryReset` refuses while Work is active; Settings shows the
  persisted default line and the `♻️ 初始化设置` confirmation flow.
- `src/discord/renderers.mjs`: `set:reset` + `resetConfirmButtons`.
- `src/index.mjs`: permission `defaultLevel`/persistence wired to the profile and
  a startup log line.
- `scripts/owner-settings-reset-e2e.mjs` + `npm run smoke:owner-settings`.

## Verified

- `npm test` 397/0; `npm run check` 123/0; `npm run smoke:owner-settings` 8/8
  (real state copy, new node process per phase, one real Agent run, real supervised
  bridge restart logged `[state] owner defaults: executor=claude provider=opencode-go
  model=deepseek-v4.1-flash`).
- Existing real-machine smoke `npm run smoke:p22-model` still 6/6 (no regression).

## Preserved invariants (do not regress)

- Channel override > workspace selection > durable owner default > product built-in;
  a saved model is still validated against the live provider and fails loudly.
- Trusted Work-thread permission inheritance never overwrites an explicit owner tier.
- `初始化设置` deletes no credentials/providers/Discord config/chat/task history/run
  database/logs/updater state/repo files and echoes no secrets.

## Next

Owner-only Discord confirmation, then merge to `main`. P3 requires a fresh explicit
task/branch.
