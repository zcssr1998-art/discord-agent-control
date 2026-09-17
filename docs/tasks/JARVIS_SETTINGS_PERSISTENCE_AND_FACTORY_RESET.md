# Jarvis — Persistent Owner Settings + Initialize Settings

## Objective

Make Jarvis behave like a single-owner persistent tool rather than a fresh per-channel configuration every time.

Once the owner explicitly selects normal Jarvis settings, those choices must become durable defaults and be inherited automatically after:

- Bridge/Supervisor restart;
- Windows reboot;
- a new Discord Work thread;
- a new Discord channel/DM scope where no explicit local override exists;
- a new Agent session caused by model/provider/executor/workspace changes.

The owner should not need to repeatedly reopen Permission or Model settings just because Jarvis restarted or a new Work thread was created.

Also add an owner-facing **“初始化设置”** control that restores Jarvis configuration to product defaults without deleting credentials, history, task records, or other user data.

## Existing implementation to reuse

Do not rewrite the settings/state subsystem.

Current code already has most required primitives:

- `src/state.mjs`
  - persistent `channels`, `workspaces`, `preferences`, `permissions`;
  - `preferences.lastWorkModel`;
  - persistent global workspace;
  - persisted per-channel permission level.
- `src/session-manager.mjs`
  - restores Work model candidates from workspace + last selection;
  - keeps session invalidation separate from persistent product configuration.
- `src/permission-manager.mjs`
  - persisted owner permission tiers;
  - trusted inheritance path for child Work threads;
  - session reset already preserves explicit permission choice.
- `src/discord/renderers.mjs`
  - central Settings UI rows.

Extend these mechanisms. Do not introduce a second configuration database or a parallel settings engine.

## Product semantics

### 1. Add one durable owner-default settings profile

Add a persisted owner-default profile under the existing StateStore preferences, e.g. conceptually:

`preferences.ownerDefaults`

The exact internal shape may differ, but it must be schema-version-safe and backwards-compatible.

Persist only stable owner configuration. At minimum support:

- Work executor;
- Work provider;
- Work model;
- Permission tier;
- Chat provider;
- Chat model;
- persistent workspace/default cwd selection where the existing global-workspace mechanism applies.

Do **not** treat the following as owner defaults:

- `sessionId` / executor session ids;
- current run/busy/queue state;
- pending approvals;
- one-shot approval grants;
- cooldowns / health state;
- transient progress/status messages;
- task-local temporary cwd changes unless they were explicitly saved through the normal global workspace control.

### 2. Explicit owner changes become future defaults

When the owner explicitly changes a setting through the Settings/Model/Permission UI or equivalent command path, Jarvis must:

1. apply it to the current scope;
2. persist it as the owner default for future scopes;
3. keep it across restart/reboot.

Do not rely only on in-memory maps.

A restart must never silently revert an explicitly chosen model/provider/executor/permission tier to hard-coded defaults when the saved selection is still valid.

### 3. Inheritance precedence

Use the smallest predictable precedence model:

1. explicit current channel/thread override, if one exists and is valid;
2. relevant existing workspace-specific saved selection, where already supported;
3. durable owner default;
4. product built-in default.

Do not silently apply a saved model to an incompatible provider/executor. Existing validation/fail-closed behavior must remain.

For a freshly created Work thread, inherit the effective parent/owner settings immediately so the first Work turn already uses the expected executor/provider/model/permission tier.

### 4. Permission behavior

Permission is product configuration, not Agent-session state.

If the owner explicitly confirms `FULL`, that confirmed value may be persisted and inherited by future trusted scopes/restarts without asking for the same confirmation every time.

The existing owner-facing transition into FULL must still require confirmation. Do not create a new path that bypasses the confirmation for an unconfirmed user action.

### 5. Backwards-compatible migration

Existing state must remain usable.

On upgrade:

- preserve current channel/workspace settings;
- preserve `preferences.lastWorkModel` and global workspace;
- preserve persisted per-channel permission levels;
- do not overwrite ambiguous existing settings with guessed values;
- seed owner defaults only from existing state where the meaning is unambiguous, otherwise wait for the next explicit owner choice.

No existing credentials or provider configuration may be lost.

## “初始化设置” control

### UI

Add a button in the normal Settings screen:

`♻️ 初始化设置`

This is a destructive configuration reset, so it must use a confirmation step such as:

- `确认初始化`
- `取消`

Do not perform the reset from a single accidental click.

### Reset scope

After confirmation, reset Jarvis **settings only** to product defaults, including persisted owner defaults and stale channel/workspace overrides that would otherwise immediately reapply the old configuration.

Expected resulting defaults should be derived from the existing canonical product defaults, not duplicated as a second hard-coded table.

The reset should cover the user-configurable routing/settings layer, including as applicable:

- Chat provider/model pin -> default/AUTO behavior;
- Work executor/provider/model -> canonical defaults;
- permission -> `STANDARD`;
- saved global workspace -> canonical configured default;
- persisted owner default profile;
- saved workspace/channel settings whose only purpose is to override these values.

### Must NOT delete

Initialization must not remove or corrupt:

- API keys / tokens / credentials;
- provider account definitions unless the current product already defines them as disposable settings;
- Discord token/configuration;
- chat history;
- Work/task history;
- run database records;
- logs;
- updater state unrelated to user settings;
- repository/worktree files.

Do not echo secrets in logs or confirmation messages.

### Running task safety

Do not mutate routing/permission/model state underneath an active Work run.

If any affected Work is active, refuse the initialization cleanly and tell the owner to stop/wait for the task. Do not auto-kill a Work task merely because the reset button was pressed.

## UX requirements

The Settings screen should display the effective current values and make persistence understandable without verbose copy.

A short status line is enough, e.g. indicating that the shown settings are persistent/default settings.

Do not add extra setup screens or a new settings framework.

## Acceptance criteria

All acceptance is runtime/deterministic; code inspection alone is not PASS.

### A. Restart persistence

1. Select a non-default Work model/provider/executor combination that is valid on the real machine.
2. Select a non-default permission tier; test FULL as well if the existing real-machine flow can safely do so.
3. Restart Bridge/Supervisor.
4. Re-open Settings/Status.
5. Exact effective selections remain; no repeated model or permission setup is required.

PASS only if the persisted state is read after a real process restart.

### B. New Work thread inheritance

1. With the above saved owner settings, create a brand-new Work thread.
2. Before manually changing anything in the new thread, inspect its effective config.
3. The new thread uses the inherited executor/provider/model/permission tier.
4. Start one minimal safe Work task and verify the actual runtime route matches the displayed inherited selection.

### C. New scope inheritance

Create a new eligible channel/DM scope with no explicit local override and confirm it falls back to the saved owner defaults rather than hard-coded defaults.

### D. Initialization button

1. Open Settings and press `♻️ 初始化设置`.
2. Verify no reset occurs before confirmation.
3. Cancel once and verify no state changed.
4. Confirm once with no Work running.
5. Verify all affected settings return to canonical product defaults.
6. Restart Jarvis and verify the reset state persists.
7. Create a new Work thread and verify it inherits the reset defaults.

### E. Data-preservation check

Before and after initialization, verify:

- credentials/providers still exist;
- chat/task history is intact;
- run database remains readable;
- no secret material appears in logs/output.

### F. Active-run protection

While a safe Work task is active, attempt initialization and verify:

- reset is refused;
- the running task is not killed;
- persisted settings remain unchanged.

## Minimum verification

Run focused tests for the changed state/session/permission/UI logic plus the repository baseline required by `AGENTS.md`.

At minimum:

```text
npm test
npm run check
```

Add focused deterministic tests for:

- owner-default persistence/load;
- inheritance precedence;
- FULL permission inheritance after prior confirmation;
- factory-reset data scope;
- reset confirmation/cancel path;
- active-Work refusal;
- restart reload behavior from a real temporary state file.

Then perform the real Discord/Windows smoke required by the acceptance criteria above.

## Scope guardrails

- Do not rewrite StateStore, SessionManager, PermissionManager, or the Discord control plane from scratch.
- Do not introduce Redis/Postgres/cloud state.
- Do not weaken fail-closed provider/model validation.
- Do not delete credentials to implement “初始化设置”.
- Do not change unrelated timeout/P3 tech-lead behavior.
- Stop when the acceptance criteria pass.

## Expected final report

```text
PASS | FAIL
commit: <sha or none>
tests: <compact deterministic + real Discord restart/inheritance/reset result>
blocker: <none or one key blocker>
```
