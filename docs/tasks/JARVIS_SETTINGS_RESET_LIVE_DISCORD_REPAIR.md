# Jarvis — Live Discord settings/reset regression repair

## Context

The owner acceptance on real Discord failed after commit `cb3ed4d`.

Observed on the live supervised bridge:

1. Native `/status` returned **“该应用程序未响应”**.
2. Immediately afterwards, typing `初始化设置` as a normal message went down the Chat path and returned:
   `指定的 Chat 模型调用失败: chat provider unreachable`.

Do not merge the settings-persistence branch to `main` until this live regression is fixed and re-accepted.

## Goal

Restore a reliable owner control path on real Discord while preserving the new durable owner-default settings feature.

The owner must be able to open Status/Settings and execute `♻️ 初始化设置` even when the currently pinned Chat provider/model is unhealthy. Control-plane actions must never depend on a model call.

## Required investigation

Use the current branch and existing logs/state. Do not rebuild the subsystem.

First determine independently:

- why `/status` did not acknowledge/respond on real Discord;
- whether the failure is command dispatch, interaction ACK timing, an exception before ACK, stale command schema, or bridge/runtime state;
- why the current persisted Chat selection is `provider unreachable`, and whether it is a legitimate unhealthy manual pin or an incorrect owner-default inheritance/migration side effect;
- whether the new owner-settings smoke missed this because it used fake Discord transport.

Check filtered `logs/bridge.log` / relevant runtime logs around the failing interaction time, not broad full-log dumps.

## Required behavior

### A. Native control commands must ACK deterministically

`/status`, `/settings`, `/panel`, `/permission`, `/model` and reset-related button interactions are control-plane operations.

- They must acknowledge Discord within the platform interaction window.
- If the handler performs async work that might exceed immediate reply time, defer/update first and then edit the response.
- A model/provider outage must not make these commands time out.
- Exceptions must produce an owner-visible concise error and a filtered log entry instead of silent “application did not respond”.

### B. Settings reset must be reachable without Chat

The canonical route remains:

`/settings` -> `♻️ 初始化设置` -> confirmation -> reset.

This entire flow must be local/deterministic and must not invoke Chat, Work, LiteLLM, OpenCode Go, or any external model/provider.

Add one deterministic recovery alias if the existing command framework supports it cheaply, e.g. `!settings` and/or `!reset-settings`, so an unhealthy Chat pin cannot lock the owner out of recovery. Do not route such aliases through the LLM.

Do not treat arbitrary natural-language messages as privileged reset actions unless an explicit deterministic command is implemented.

### C. Reset semantics

After confirmed initialization:

- Chat selection returns to product default (`AUTO`, no stale manual model pin) unless the project’s canonical defaults explicitly say otherwise;
- Work executor/provider/model return to product defaults;
- permission returns to product default;
- saved workspace/owner-default routing overrides are cleared according to the original taskbook;
- credentials/providers/chat history/task DB/logs/updater/repo files remain untouched;
- current active Work still blocks destructive reset as already designed.

### D. Owner-default inheritance must not brick Chat

Preserve explicit manual Chat pin semantics: if the owner explicitly pins a provider/model, failure may remain fail-loud rather than silently switching providers.

But verify that:

- a new scope inherits only a valid owner default;
- reset really clears the manual Chat pin everywhere it is supposed to;
- migration/backfill cannot accidentally turn a Work model selection into a Chat pin;
- restart cannot resurrect a cleared/stale Chat pin.

## Acceptance

Do not report PASS from unit/fake-Discord tests alone.

Required evidence:

1. Existing deterministic suites remain green:
   - `npm test`
   - `npm run check`
   - `npm run smoke:owner-settings`
   - focused existing Discord/control smoke(s) relevant to interactions.
2. Add/extend a regression test that proves control commands/reset do not call the Chat runtime when Chat provider is intentionally unreachable.
3. Real supervised Windows bridge, exactly one Bridge instance.
4. Real Discord owner acceptance:
   - `/status` responds normally;
   - `/settings` opens normally;
   - with an intentionally unavailable/manual Chat pin, Settings still opens;
   - `♻️ 初始化设置` -> Cancel is a no-op;
   - `♻️ 初始化设置` -> Confirm succeeds locally;
   - afterwards a normal Chat message no longer uses the stale manual pin and follows reset/default semantics;
   - restart Bridge and verify the reset/default state persists;
   - create a new Work thread and verify inherited Work model/permission behavior is still correct.

If real owner clicking cannot be automated, stop at a concise owner acceptance checklist instead of claiming full PASS.

## Scope

Keep the patch minimal. Prefer repairing the interaction/ACK and state precedence/reset logic. No unrelated P3 work, no routing rewrite, no new database, no broad refactor.

## Final report

```text
PASS | FAIL
commit: <sha or none>
tests: <compact deterministic + real Discord evidence>
blocker: <none or exact remaining owner-only check>
```
