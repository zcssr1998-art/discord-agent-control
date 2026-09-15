# AI handoff

Keep this file short and overwrite/update it at every meaningful handoff. Do not paste old chat transcripts here.

## Current task

Jarvis V4 P2: persistent control panel + Work launcher + Chat history + New/Compact + attachments.

## Branch

`jarvis-v4-p2-control-context` (do not merge `main`).

## Active spec

`docs/JARVIS_V4_P2_TASK.md`

`docs/JARVIS_V4_P1_1_CONTROL_PANEL_TASK.md` is superseded and only points here.

## Last known good baseline

P0/P0.5 + P1 are merged on `main`.

Verified P1 baseline:

- `npm test` 195/0
- `npm run check` 76/0
- `npm run smoke:p1` 20/20
- real Discord same-workspace queue PASS
- real guild Work thread + same-session continuation PASS
- Chat via LiteLLM remains Agent-free

Evidence: `docs/V4_P1_SMOKE.md`.

## P2 status (this branch)

Implemented: `!panel` control panel + New Work modal, Chat/Work model selectors, panel settings/permission/status/stop/help, bounded persistent Chat history, `!new`/`!compact`, Discord attachments (Work local inbox + Chat text/image with a real vision route).

Verified on this machine:

- `npm test` 226/0
- `npm run check` 83/0
- `npm run smoke:p2` 11/11 (real LiteLLM chat-fast, real chat context recall, real vision `deepseek-v4-flash-vision-exp` -> 红色, real Agent file task in a panel-created Work thread)

Only remaining: owner-run human real-Discord smoke (`docs/V4_P2_SMOKE.md` §8). Evidence: `docs/V4_P2_SMOKE.md`.

Key P2 files: `src/chat-history.mjs`, `src/attachments.mjs`, `src/discord-ui.mjs`, `src/chat-runtime.mjs`, `scripts/p2-e2e.mjs`.

## P2 architecture decisions

- Persistent panel uses stable interaction IDs; no panel registry/database.
- Panel actions reuse existing SessionManager/PermissionManager/ModelManager and shared Work start/stop paths.
- `🛠 新建 Work` uses one modal task field; guild parent -> existing Work thread path, DM -> inline, Work thread -> same thread.
- Chat and Work model selectors are separate and use Provider -> model; Work selector must not be trapped on WorkBuddy `fast-model`.
- Chat history is channel-scoped, persistent, bounded, and separate from Work Agent session IDs.
- A successful Chat turn appends history once; provider retries/fallbacks must not duplicate it.
- New Chat clears Chat context only; it preserves model/work configuration.
- Compact is explicit and model-assisted; failed compact leaves original history intact. No surprise background summarization calls.
- Work attachments download once to a safe runtime inbox and are passed to Agent as local file paths.
- Chat supports bounded text attachments and common images; unsupported binaries are rejected with a Work hint rather than ignored.
- Image AUTO should use a configured LiteLLM vision route when available; manual pinned Chat stays pinned.

## Execution order

1. P2A persistent panel + Work launcher — done
2. P2B ChatHistoryStore + history-aware ChatRuntime — done
3. P2C New Chat + Compact — done
4. P2D attachments — done
5. P2E deterministic full suite + machine-side real smoke — done; human real-Discord smoke pending owner

## Minimal relevant files to inspect first

- `src/discord-ui.mjs`
- `src/chat-runtime.mjs`
- `src/session-manager.mjs`
- `src/state.mjs`
- `src/provider-manager.mjs`
- `src/model-manager.mjs`
- `src/workspace-scheduler.mjs`
- `tests/helpers/fake-discord.mjs`

Do not rescan the whole repository before these.

## Blocker

None technical. The human real-Discord smoke (`docs/V4_P2_SMOKE.md` §8) is `PENDING_OWNER_DISCORD_SMOKE` because the bridge cannot act as the human owner. A real vision route exists (`opencode-go / deepseek-v4-flash-vision-exp`) and passed the machine-side image smoke.

## Delivery

Update `CURRENT`, this handoff, `docs/tasks/CURRENT.md`, and `docs/V4_P2_SMOKE.md`; commit and push to the P2 branch. Final worker reply stays short.
