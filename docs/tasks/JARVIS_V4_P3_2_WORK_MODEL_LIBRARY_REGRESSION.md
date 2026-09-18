# Jarvis V4 P3.2 — Work Model Library Regression Hotfix

## Goal

Restore the Work model library in Discord immediately. The owner currently opens `🛠 Work 模型` and sees only:

```text
当前：WorkBuddy · workbuddy-free · 未选择
[WorkBuddy Free]
```

OpenCode Go and its discovered model library are no longer reachable from the Work model UI. This is a regression/blocker and must be fixed before final P3 TechLead acceptance/commit.

## Known likely failure seam

Current `DiscordControlPlane.#workProviderList(channelId)` filters providers by the **currently selected executor**:

```js
.filter((provider) => !this.executorManager || this.executorManager.compatible(selection.executorId, provider.protocol, null))
```

When persisted/default executor is `workbuddy`, that makes the Work model menu expose only the WorkBuddy-native provider, trapping the owner in the current route.

Do not assume this is the only cause. Reproduce first and inspect the smallest relevant diff/history, but do not rescan unrelated subsystems.

## Product requirement

The Work model screen must be a model-selection surface, not a dead end created by the previously selected executor.

From the exact state:

```text
executor = workbuddy
provider = workbuddy-free
model = null
```

`/model -> Work 模型` / panel Work model selector must still allow the owner to reach configured, credentialed, runnable OpenCode Go models.

### Required UX

1. WorkBuddy remains available.
2. OpenCode Go appears whenever at least one installed/ready executor can run at least one of its models.
3. Choosing an OpenCode Go model must result in a valid executable tuple:

```text
executor + provider + model + transport
```

4. Prefer the current executor if it is compatible with the chosen model.
5. If the current executor is incompatible, select a known available compatible executor through existing `ExecutorManager` compatibility logic. In the current installation this will commonly be Claude Code for supported OpenCode Go transports/adapters.
6. The switch must be explicit in the confirmation/status text, e.g.:

```text
✅ Work 已切换：Claude Code · OpenCode Go · grok-4.6
```

Do not silently leave an impossible executor/provider/model combination.
7. If multiple compatible ready executors exist and there is no existing deterministic preference, use a tiny executor chooser rather than guessing.
8. Providers/models with no runnable executor may be hidden or shown disabled with a truthful reason; they must not be selectable into broken state.
9. Keep provider -> model pagination and real model discovery. Do not hardcode model IDs.
10. Work model selection remains independent from Chat model selection.

## Atomic state mutation

Selecting a Work route must update the needed Work selection fields atomically enough that an intermediate invalid combination is not persisted.

Reuse existing `SessionManager`, `ProviderManager`, `ModelManager`, `ExecutorManager` and runner compatibility logic. Do not create a second model/config store.

Preserve:

- selected permission tier persistence;
- workspace;
- Chat route/model;
- Work lifecycle safety;
- P3.0 delivery semantics;
- P3.1 Chat web search;
- P3 TechLead Shadow implementation currently present in the working tree.

Changing Work executor/provider/model may create a fresh Agent session according to existing safety semantics, but must not reset unrelated owner configuration.

## Important working-tree constraint

The current P3 TechLead implementation is still uncommitted while awaiting owner acceptance.

**Do not reset, clean, checkout-overwrite, stash-and-forget, or discard the current working tree.**

Implement this hotfix on top of the current working tree. Do not revert TechLead files. Do not run broad formatting/refactors.

If this task file exists only on `origin/jarvis-v4-p3-ai-techlead-shadow`, fetch it without resetting the local branch.

## Focused implementation guidance

Prefer a small route-discovery helper that answers:

```text
For this provider/model, which ready executors can actually run it?
```

The UI should discover/select a runnable route instead of filtering the entire provider library by the executor that happened to be selected before the menu opened.

Do not weaken `ExecutorManager.compatible()` or bypass transport checks merely to make buttons appear.

## Deterministic tests

Add/fix focused tests proving at minimum:

1. Starting from `workbuddy / workbuddy-free / null`, Work model provider screen includes OpenCode Go when a compatible ready executor exists.
2. OpenCode Go real model list is reachable from that state.
3. Selecting a supported OpenCode Go model produces a compatible executor/provider/model tuple.
4. Current executor is retained when already compatible.
5. Incompatible current executor is replaced by a compatible ready executor, with truthful UI confirmation.
6. No compatible executor -> model cannot be persisted as runnable; UI explains why.
7. WorkBuddy route remains selectable.
8. Chat model selection is unchanged.
9. Permission/workspace are preserved.
10. Existing Work start actually uses the selected executor/provider/model after selection.
11. Existing P2 model-selection regression expectation remains true: Work model selector can reach OpenCode Go even when current Work state is WorkBuddy-bound.

## Required regression gates

Run the smallest focused test first, then at least:

```text
npm test
npm run check
npm run smoke:p2
npm run smoke:p222
npm run smoke:p3-techlead
```

Run other touched-path smoke only if needed by the actual diff.

## Real Discord smoke

On the real owner Discord environment:

1. Open `/model` -> Work model from the currently broken state.
2. Verify OpenCode Go is visible.
3. Open OpenCode Go and verify the discovered model list is populated/paginated.
4. Select one known supported model.
5. Verify status shows a runnable executor + OpenCode Go + selected model.
6. Start one harmless Work and verify it actually launches through that selected route.
7. Switch back to WorkBuddy once and confirm it remains available.
8. Confirm Chat and P3.1 web search still work.

Do not fake owner smoke.

## Stop condition

Stop after the Work model library is restored, focused + regression tests pass, and real Discord smoke proves the model library and selected route actually work.

Do not continue into any new P3 feature in the same job.

## Final report

```text
PASS | FAIL
commit: <sha or none>
root-cause: <one line>
tests: <compact result>
work-model-library: <PASS|FAIL>
real-smoke: <PASS|PENDING + reason>
blocker: <none or one key blocker>
```
