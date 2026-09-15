# Jarvis V4 P1.1 — Persistent Control Panel UX

## Goal

Make Jarvis usable day-to-day without remembering `!` commands. Add one durable Discord control-panel message that exposes the common controls, especially model switching and settings.

P1.1 is UX only. Do not change P0/P1 routing, Agent, queue, thread, permission, fallback, or billing semantics.

## Primary UX

A user sends:

```text
!panel
```

Jarvis posts a durable control-panel message in that channel/DM. The message must remain usable after bridge restart because all buttons use stable interaction IDs. No database or panel registry is required for P1.1.

Main panel:

```text
🤖 Jarvis Control Panel

[🧠 换模型] [⚙️ 设置] [🔐 权限]
[📊 状态]   [⛔ Stop] [🔄 刷新]
```

If Discord allows pinning, best-effort pin the panel. Pin failure must not fail panel creation; tell the owner they may pin it manually.

All panel interactions remain OWNER-only and must never invoke an LLM/Agent unless the owner explicitly starts Work elsewhere.

## A. Model switching from the panel

Clicking `🧠 换模型` opens:

```text
[💬 Chat 模型]
[🛠 Work 模型]
[⬅️ 返回]
```

### A1. Chat model

- Show `AUTO` first.
- `AUTO` must reuse the existing `setChatSelection(... auto ...)` behavior.
- Manual Chat selection must be Provider -> model.
- Only show providers usable for Chat (no WorkBuddy-native-only provider).
- Only show providers with a usable credential and non-metered/free/subscription semantics already allowed by current Chat routing policy.
- Manual Chat model selection preserves the existing rule: pinned Chat does not silently fall back.
- Do not create a second Chat routing implementation.

### A2. Work model

- Work model switching must be Provider -> model, not “current Provider models only” with no context.
- Provider page shows all credentialed providers compatible with the current executor.
- After selecting Provider, fetch/list that Provider's models through the existing `ModelManager`.
- Selecting a model must reuse the existing provider/model/session mutation rules; no parallel config store.
- Existing safety remains: changing Work Provider/model resets the Work session/permission as current commands do.
- If a provider cannot auto-list models, show the existing manual-ID fallback instead of pretending the list is complete.

### A3. Discord component limits

Keep the implementation small. Reuse the existing model paging/button helpers where practical. Do not introduce a web dashboard or new UI framework. If a list cannot fit in one panel, paginate or fall back to the existing `!models` / `!model` flow with a clear message.

## B. Settings from the panel

Clicking `⚙️ 设置` must open the existing P1 `!settings` panel. Reuse the same renderer and mutation handlers. Do not create a second settings system.

The settings panel continues to expose:

- Chat -> AUTO
- executor
- provider
- model
- permission
- refresh/back

## C. Permission from the panel

Clicking `🔐 权限` opens the existing permission menu:

- strict
- standard
- relaxed
- full

`full` must keep the existing explicit confirmation step. Do not weaken OWNER/credential/timeout/stop protections.

## D. Status from the panel

Clicking `📊 状态` renders the same data as `!status`, including:

- Chat route + actual model
- Work executor/provider/model
- workspace
- queue/running state
- permission
- LiteLLM/gateway health when available

Prefer updating the panel message or sending one concise ephemeral-style response if supported by the current fake/real Discord abstraction. Do not invoke a model.

## E. Stop from the panel

Clicking `⛔ Stop` must reuse the exact same semantics as `!stop`:

- queued Work: cancel only that queued request
- active Work: kill the Agent process tree, cancel approvals, release task/workspace
- idle: report no active Agent

Refactor shared stop logic if necessary. Do not maintain two independent stop implementations.

## F. Refresh / Back

- `🔄 刷新` returns to a freshly rendered main control panel.
- Every submenu has `⬅️ 返回` to the main panel or previous selector.
- The panel should display current Chat and Work selection compactly so the owner can tell what is active without typing `!status`.

## G. Non-goals

Do not add in P1.1:

- P2 attachments/history/`/new`/`/compact`
- SQLite/Redis
- new provider router
- LLM-based router
- a browser dashboard
- persistent panel registry/database
- slash-command framework migration

Slash commands can be a later UX layer. This task is the durable button panel requested by the owner.

## Acceptance

Deterministic tests must cover at least:

1. `!panel` creates the main panel without starting Agent or ChatRuntime.
2. main panel includes `换模型`, `设置`, `权限`, `状态`, `Stop`, `刷新`.
3. Model -> Chat -> AUTO reuses existing Chat AUTO state.
4. Model -> Chat -> Provider -> model pins the requested Chat model.
5. Model -> Work -> Provider -> model updates existing Work state and creates a new safe session using current semantics.
6. Work model selector is not trapped on WorkBuddy `fast-model` when other configured providers exist.
7. Settings button opens the existing `!settings` panel.
8. Permission button opens existing permission flow; full still requires confirmation.
9. Stop button behaves exactly like `!stop` for queued and active Work.
10. Buttons do not call LLM/Agent unless Stop is acting on an already-running Agent.
11. Existing P0/P0.5/P1 tests remain green.

Real Discord smoke:

- create one panel in a normal guild channel or DM
- restart bridge and confirm the old panel buttons still work
- switch Work model to OpenCode Go / `deepseek-v4.1-flash` from buttons
- switch Chat to AUTO from buttons
- open Settings and Permission from buttons
- run a disposable Work task and stop it with the panel Stop button

## Verification

```text
npm test
npm run check
```

Add one focused P1.1 smoke only if deterministic Discord-fake tests cannot prove restart-safe stable interaction IDs. Avoid a large new smoke harness.

## Delivery

Update:

- `docs/CURRENT.md`
- `docs/AI_HANDOFF.md`
- `docs/tasks/CURRENT.md`
- concise P1.1 smoke/evidence note if real Discord is used

Commit + push to `jarvis-v4-p1-1-control-panel`.

Final worker report only:

```text
PASS/FAIL
commit: <sha>
tests: <summary>
real-smoke: <summary>
blocker: <none|reason>
```
