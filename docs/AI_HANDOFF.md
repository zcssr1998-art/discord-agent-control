# AI handoff

Keep this file short and overwrite/update it at every meaningful handoff. Do not paste old chat transcripts here.

## Branch

`jarvis-v4-p2-control-context` (PR #4, Draft; do not merge yet).

## Active specs

- `docs/JARVIS_V4_P2_TASK.md` — P2 implementation complete; human Discord smoke was in progress.
- `docs/JARVIS_V4_P2_1_NATIVE_COMMANDS_TASK.md` — **current task**.

## Last known good state

P0/P0.5 + P1 are merged on `main`.

P2 on this branch is implemented and machine-verified:

- `npm test` 226/0
- `npm run check` 83/0
- `npm run smoke:p2` 11/11
- real LiteLLM Chat context recall PASS
- real vision PASS
- real Agent file task from P2 panel-created Work thread PASS

Human Discord proved the live P2 `!panel` is now running; final P2 owner smoke is not yet closed.

## Current owner request (P2.1)

Make Jarvis native/easy to control from Discord and make a running Work task interactive:

1. register real application commands `/panel /work /model /settings /permission /status /stop /new /compact /help`
2. active/queued Work progress cards show `➕ 追加需求` + `⛔ Stop`
3. append button opens multiline Modal
4. while Work is active, normal owner text in the Work thread / Work-mode DM/channel queues through the same follow-up backend
5. follow-ups execute FIFO as later turns in the same Agent session; never start a concurrent Agent for the same active run
6. every follow-up re-enters existing `runTask` + `WorkspaceScheduler` after current turn releases the lock, preserving workspace fairness
7. guild parent normal text remains Chat
8. Stop reuses exact existing stop semantics and also clears pending follow-ups
9. stale progress-card controls bind to run ID and cannot affect a newer task

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
- `src/progress.mjs`
- `src/session-manager.mjs`
- `src/workspace-scheduler.mjs`
- `tests/helpers/fake-discord.mjs`
- existing P2 tests

Do not rescan the entire repository unless these are insufficient.

## Verification

Targeted tests while coding, then:

```text
npm test
npm run check
npm run smoke:p2
```

Add only a small focused smoke if needed for command registration/card component persistence. Human Discord evidence goes into `docs/V4_P2_SMOKE.md` as P2.1.

## Blocker

None known. Do not redo P2 implementation; extend it.

## Delivery

Update `CURRENT`, this handoff, `docs/tasks/CURRENT.md`, and `docs/V4_P2_SMOKE.md`; commit + push to `jarvis-v4-p2-control-context`. Final worker reply stays short.
