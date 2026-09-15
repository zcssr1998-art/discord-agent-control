# AI handoff

Keep this file short and overwrite/update it at every meaningful handoff. Do not paste old chat transcripts here.

## Branch

`jarvis-v4-p2-control-context` (PR #4, Draft; do not merge yet).

## Active specs

- `docs/JARVIS_V4_P2_TASK.md` — P2 implementation complete; human Discord smoke not closed.
- `docs/JARVIS_V4_P2_1_NATIVE_COMMANDS_TASK.md` — P2.1 implementation complete; human Discord smoke not closed.

## Last known good state

P0/P0.5 + P1 are merged on `main`.

P2 + P2.1 on this branch are implemented and machine-verified:

- `npm test` 244/0 (P2.1 adds `tests/v4-p2-native.test.mjs`, 18 tests incl. the ACK lifecycle)
- `npm run check` 85/0
- `npm run smoke:p2` 11/11
- real LiteLLM Chat context recall PASS
- real vision PASS
- real Agent file task from P2 panel-created Work thread PASS

Human Discord: `!panel` was confirmed handled locally by the live bridge. Final combined P2/P2.1 owner smoke is not closed.

## P2.1 implementation note

- `src/commands.mjs`: application-command payloads + idempotent registration (no hard-coded IDs).
- `src/discord-ui.mjs`: chat-input command handler; `workctl:append|stop:<runId>` card controls; `workappend:<runId>` modal; one shared `#stopChannel` (also clears follow-ups); `#appendFollowUp` + `#drainFollowUps` re-enter `runTask`/`WorkspaceScheduler`; natural text in an active Work context queues the same follow-up.
- Interaction ACK lifecycle: `#acknowledge` (deferReply/deferUpdate) runs before any slow work; `showModal` cases ACK via the modal before that; `#edit`/`#ephemeral` respect deferred/replied and never double-reply; `#interactionContext` uses the same path. This fixed the real `/work` "该应用程序未响应" smoke failure.
- `src/progress.mjs`: `TaskProgress.setFollowUps` + `ThrottledEditor` optional components so active cards keep buttons.
- Behaviour change: the legacy test `a second task is refused while one is running` now asserts P2.1 follow-up queuing (intentional).
- Registration defaults to global; `DISCORD_COMMANDS_GUILD_ID` optionally enables instant guild-scoped propagation (never hard-coded). `DISCORD_AUTO_REGISTER_COMMANDS=0` disables.

## Architecture constraints

- reuse existing P2 panel/model/settings/status/help renderers
- reuse existing New Work path for `/work`
- one shared stop path for text command, panel, slash command, and progress card
- no parallel config/state system
- no mid-process stdin injection
- no market-data/P3 work in this branch
- preserve P0/P1/P2 routing, history, attachments, permissions, queue and Work-thread invariants

## Minimal files first

- `src/discord-ui.mjs`
- `src/commands.mjs`
- `src/progress.mjs`
- `tests/v4-p2-native.test.mjs`
- `tests/helpers/fake-discord.mjs`

## Verification

```text
npm test
npm run check
npm run smoke:p2
```

Human Discord evidence goes into `docs/V4_P2_SMOKE.md` §9.

## Blocker

None known. Human P2/P2.1 smoke is the only open item (owner-run).

## Delivery

Update `CURRENT`, this handoff, `docs/tasks/CURRENT.md`, and `docs/V4_P2_SMOKE.md`; commit + push to `jarvis-v4-p2-control-context`. Final worker reply stays short.
