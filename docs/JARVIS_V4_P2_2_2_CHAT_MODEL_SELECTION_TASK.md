# Jarvis V4 P2.2.2 — Chat Model Selection + Invalid Placeholder Repair

## Objective

Fix the post-reboot Chat routing bug and make Chat model selection behave exactly like this:

- **Default = AUTO**. A fresh channel/session uses AUTO without requiring owner setup.
- **Owner can override AUTO** from Discord and choose a real Provider + real model.
- **Owner can switch back to AUTO at any time**.
- A manual pin remains a true pin: if that specific route later becomes unavailable, Jarvis reports it instead of silently switching to another model.
- Placeholder/example values such as `<model-id>` / `<provider-id>` can never become persisted runtime configuration.

This is a focused P2.2.2 correctness/UX fix. Do not modify Supervisor/autostart unless needed to run the smoke. Do not start P3.

## Read first

Follow the repository startup order in `AGENTS.md`, then read:

- `docs/CURRENT.md`
- `docs/AI_HANDOFF.md`
- `docs/tasks/CURRENT.md`
- this task
- current branch/HEAD/status/relevant diff only

Preserve all P2.2.1 recovery work at commit `c83751b` or later.

## Real owner-reported failure

After the first successful post-P2.2.1 reboot, Jarvis auto-started, but ordinary Chat returned:

```text
❌ 指定的 Chat 模型不可用（provider=opencode-go model=<model-id>）。手动选择不会自动切换。
```

The persisted Chat model was literally the documentation placeholder `<model-id>`.

Current code path allows `!chatmodel <provider> <model>` to persist an arbitrary model string after only validating provider/credential presence. A placeholder therefore survived reboot and pinned Chat to an impossible route.

The owner also clarified the intended product behavior: **Chat must default to AUTO, but AUTO must not be the only usable choice. The owner must be able to choose and persist a specific model from Discord UI/commands.**

## Required product semantics

### 1. AUTO is the default, not a lock

For a fresh channel / channel with no explicit Chat selection:

```text
chatProviderId = auto
chatModel = null
```

AUTO keeps using the existing safe Chat routing policy (healthy allowed free/subscription routes, current LiteLLM/OpenCode-Go behavior, no surprise metered fallback).

Do not convert AUTO into a hardcoded single model.

### 2. Manual model selection must remain available

`/model` → Chat model (and the equivalent control-panel path) must visibly offer:

1. `AUTO` as the first/default option;
2. each currently configured + credentialed Chat-capable Provider;
3. after choosing a Provider, the available real models for that Provider;
4. selecting a model persists `{ providerId, model }` for that channel;
5. selecting AUTO clears the manual pin and persists `{ chatProviderId: 'auto', chatModel: null }`.

A user must never be forced to stay on AUTO.

Do not add a second model-selection system. Reuse `SessionManager`, `ProviderManager`, `ModelManager`, existing panel renderers and existing Chat runtime.

### 3. Manual pin semantics

When the owner explicitly selects a real model:

- that exact Provider/model is used;
- the selection survives bridge/Windows restart;
- no silent fallback to another model if the pinned route is temporarily unavailable;
- UI/status clearly shows the current manual pin;
- switching back to AUTO is one explicit action.

This preserves the existing safety principle; the bug is invalid configuration being accepted, not the no-fallback rule.

## Invalid placeholder protection

Introduce one small shared validator/normalizer for user-supplied Provider/model IDs. Do not scatter regexes across handlers.

At minimum reject values that are obviously documentation placeholders, including case-insensitive equivalents of:

- `<model-id>`
- `<provider-id>`
- `<model>`
- `<provider>`
- angle-bracket placeholder-shaped values such as `<...>`
- empty/whitespace-only IDs

Do not reject legitimate model IDs merely because they contain hyphens, dots, slashes, colons, version numbers, brackets used legitimately by a provider, etc. Keep validation intentionally narrow: block obvious placeholders, not arbitrary provider naming conventions.

### Entry points that must use the same validation

At minimum:

- `!chatmodel <provider-id> <model-id>`
- Discord panel/model button persistence path (`panelchatm:*`)
- any slash-command/model-selection route that reaches the same Chat persistence API
- the low-level `SessionManager.setChatSelection()` or an equivalent single persistence boundary, so a new caller cannot bypass validation later

Panel-generated IDs should already be real values, but the persistence boundary still must fail closed for placeholder input.

## Repair already-persisted bad state

The owner currently has a persisted bad pin, so fixing only future writes is insufficient.

On state/session load or the first resolution of a Chat selection:

- detect an invalid placeholder-like `chatProviderId` or `chatModel`;
- atomically repair that channel to:

```text
chatProviderId = auto
chatModel = null
```

- persist the repaired state so the bug does not reappear after the next reboot;
- log only a compact non-secret message such as:

```text
[state] repaired invalid Chat selection for channel=<id> -> AUTO
```

Do not mass-delete unrelated channel state, Work model state, history, workspace or permissions.

## Real-model validation

For owner-entered manual pins:

- if `ModelManager` can successfully obtain a real model list for the selected Provider, require an exact model-id match before persisting;
- panel buttons must only be built from the discovered/cached model list;
- if a provider genuinely cannot expose a model list, do not incorrectly claim the model is nonexistent solely because discovery is unsupported. Placeholder syntax is still always rejected. Preserve compatibility with custom OpenAI/Anthropic-compatible providers.

Return a useful error and do not mutate persisted selection on failed validation.

## Discord UX

### Chat model menu

The Chat model screen should make the distinction obvious:

```text
💬 Chat 模型
当前：AUTO（自动选择）

[AUTO ✓]
[OpenCode Go]
[LiteLLM]
[other eligible providers...]
```

After choosing a Provider, show the actual selectable models as buttons where the existing Discord component limits allow it.

When manually pinned, show for example:

```text
当前：OpenCode Go / deepseek-v4.1-flash（手动固定）
```

with an obvious `AUTO（恢复自动选择）` action still available.

Do not present Chat as “AUTO only”.

### Status

`/status` / panel status should clearly distinguish:

- `Chat：AUTO` + latest actual route/model when available;
- or `Chat：手动固定 · provider/model`.

No placeholder should ever appear as a valid current model after repair.

## Regression constraints

Do not change these existing behaviors:

- ordinary Chat never launches an Agent;
- Work model selection remains independent of Chat model selection;
- Work model persistence from P2.2 remains intact;
- AUTO safe-billing/fallback policy remains intact;
- manually pinned Chat route does not silently fallback;
- OpenCode Go direct fallback / LiteLLM primary architecture remains intact;
- P2.2.1 Supervisor/autostart/watchdog behavior remains intact.

## Tests

Add focused deterministic tests covering at least:

1. fresh Chat selection defaults to AUTO/null;
2. owner can select a real Provider/model and it persists;
3. owner can switch from manual pin back to AUTO;
4. `<model-id>` is rejected and not persisted;
5. `<provider-id>` is rejected and not persisted;
6. existing persisted `opencode-go / <model-id>` is automatically repaired to AUTO/null;
7. repair preserves unrelated channel fields (cwd, Work provider/model, permissions/session fields as applicable);
8. panel Chat menu contains AUTO plus eligible provider choices;
9. selecting a panel model uses the same validated persistence boundary;
10. when a model list is available, an unknown model is rejected without changing the previous valid selection;
11. manual real pin remains no-fallback;
12. AUTO path still chooses an allowed healthy route.

Run the smallest relevant suite first, then required regression gates.

## Real smoke on current Windows machine

After deterministic tests pass, update/restart the live Jarvis through the existing safe Supervisor path and verify in Discord/runtime evidence:

1. historical `<model-id>` pin is repaired automatically — do not manually edit `state.json` as the primary fix;
2. ordinary `你好` succeeds in default AUTO mode;
3. `/model` → Chat model displays AUTO **and** selectable Provider/model options;
4. select `opencode-go / deepseek-v4.1-flash` (or another currently real discovered subscription model) and send a Chat message successfully;
5. `/status` shows the manual pin;
6. switch back to AUTO and send another Chat message successfully;
7. `/status` shows AUTO and, if available, latest actual route/model;
8. restart only the Jarvis bridge (not Windows) and confirm the chosen mode persists correctly;
9. no duplicate bridge and Supervisor/watchdog remains healthy.

Do not reboot the owner's PC automatically.

## Required regression gates

- `npm test` PASS
- `npm run check` PASS
- existing `npm run smoke:p2` PASS
- existing `npm run smoke:p22` PASS
- P2.2.1 recovery tests remain PASS or at minimum the focused Supervisor regression proving no change to that subsystem
- new focused Chat-selection tests PASS
- live Chat smoke above PASS

## Repository state/evidence

On completion update compactly:

- `docs/CURRENT.md`
- `docs/AI_HANDOFF.md`
- `docs/tasks/CURRENT.md`
- relevant P2.2 smoke/evidence document

Commit + push to `jarvis-v4-p2-2-hardening` unless a concrete conflict requires a small stacked branch.

## Non-goals

Do not work on:

- P3 / finance / Longbridge;
- Supervisor redesign;
- new providers/models unrelated to this fix;
- web dashboard;
- Agent teams;
- broad Discord UI refactor;
- unrelated `/help` cleanup unless it directly blocks model selection.

## Stop condition

Once invalid placeholders are repaired/rejected, AUTO is the default, manual Chat model selection works and all required gates pass, stop.

## Final worker response

```text
PASS | FAIL
commit: <sha or none>
tests: <compact result>
chat-auto: <default/repair smoke>
chat-manual: <provider/model pin + switch-back smoke>
regression: <p2/p22/supervisor>
blocker: <none or one key blocker>
```
