# Current project state

Keep this file compact. It is the first project-state file a new worker should read.

## Branch

`jarvis-v4-p2-control-context`

## Milestone

Jarvis V4 P2 — persistent control panel + Work launcher + Chat history + New/Compact + attachments.

Status: **implemented on this branch, not merged to `main`.** Deterministic suite and machine-side real smoke pass; the human real-Discord smoke is pending the owner (`docs/V4_P2_SMOKE.md` §8).

## Stable baseline

P0/P0.5 and P1 are merged to `main` and are the rollback point.

Preserve these invariants:

- ordinary Chat never starts an Agent
- LiteLLM primary + OpenCode Go direct fallback
- manual Chat pin never silently falls back
- AUTO never surprises the owner with metered routes
- guild `work <task>` creates a permanent Work thread; parent remains Chat
- one canonical workspace has at most one active Jarvis Work task; same-workspace tasks FIFO
- queued Work never starts an Agent before lock acquisition
- real `!stop` kills active process trees / cancels queued work correctly
- permission/approval/session safety remains intact

P1 real Discord smoke passed for cross-channel workspace queue and Work-thread session continuation. Evidence: `docs/V4_P1_SMOKE.md`.

P2 machine-side evidence: `npm test` 226/0, `npm run check` 83/0, `npm run smoke:p2` 11/11 (real LiteLLM + OpenCode Go + real vision + real Agent). Evidence: `docs/V4_P2_SMOKE.md`.

## Current task

`docs/JARVIS_V4_P2_TASK.md` — implemented. Remaining: owner-run human real-Discord smoke (`docs/V4_P2_SMOKE.md` §8).

The earlier P1.1 control-panel task was folded into P2; do not implement it separately.

## P2 scope

1. persistent `!panel` control panel
2. `🛠 新建 Work` modal that reuses existing Work paths
3. Chat/Work Provider -> model selectors
4. Settings / Permission / Status / Stop / Usage Guide from the panel
5. bounded persistent channel-scoped Chat history
6. New Chat (`!new`, panel; `/new` where supported)
7. Compact context (`!compact`, panel; `/compact` where supported)
8. Discord attachments: Work files + Chat text/images with safe limits

## Key architecture decisions

- no second settings/model/work implementation: panel delegates to existing managers and P1 Work paths
- no SQLite/Redis; small local JSON/JSONL runtime state is enough
- Chat history is separate from Work Agent sessions
- failed Chat fallback attempts must not duplicate history
- explicit Compact may call the Chat model; no surprise background summarization calls
- Work attachments download once to a safe runtime inbox and are passed to Agent as local paths
- Chat binary files are not silently ignored; unsupported files should be redirected to Work

## Next action

Owner runs the human real-Discord smoke in `docs/V4_P2_SMOKE.md` §8, then final review. Do not merge to `main` until that review.

## P2 implementation map

- `src/discord-ui.mjs` — persistent `!panel`, New Work modal, Chat/Work model selectors, panel status/stop/help, `!new`/`/new`, `!compact`/`/compact`, history-aware Chat, attachment handling.
- `src/chat-history.mjs` — bounded channel-scoped Chat history (`data/chat-history.json`, git-ignored).
- `src/attachments.mjs` — safe Discord attachment download/read + inbox TTL cleanup (`data/inbox/`, git-ignored).
- `src/chat-runtime.mjs` — message-array sends + neutral multimodal content mapping (OpenAI/Responses/Anthropic) + vision-route resolution.
- `src/config.mjs` / `src/index.mjs` — `CHAT_VISION_PROVIDER_ID` / `CHAT_VISION_MODEL`, history/inbox wiring, startup inbox cleanup.

## Verification baseline

Before P2 changes, stable P1 baseline was:

```text
npm test      -> 195 passed / 0 failed
npm run check -> 76 file(s), 0 failed
npm run smoke:p1 -> 20/20
Real Discord queue/thread smoke -> PASS
```
