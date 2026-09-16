# AI handoff

Keep this file short and overwrite/update it at every meaningful handoff. Do not paste old chat transcripts here.

## Branch

`jarvis-v4-p2-2-hardening` (stacked on P2/P2.1; do not merge P2.2 yet).

## Active task

None. P2.2.2 (`docs/JARVIS_V4_P2_2_2_CHAT_MODEL_SELECTION_TASK.md`) is complete.

## Current status

The post-reboot Chat bug is fixed and verified. Chat now defaults to `AUTO`, a
real manual pin is available and persists, placeholders are rejected at one
shared boundary, and an already-persisted `<model-id>` is auto-repaired to
`AUTO/null` on `StateStore.load()`.

Live evidence on this machine (2026-09-16): the real persisted
`opencode-go / <model-id>` was injected in a state copy and, separately, the real
`data/state.json` was re-seeded with it and the bridge restarted through the
supervisor. The log recorded
`[state] repaired invalid Chat selection for channel=1033760247598288908 -> AUTO`
and the on-disk state became `AUTO/null` while cwd/Work fields were preserved.
Real-provider smoke (`npm run smoke:p222`) proved AUTO chat (`你好` via LiteLLM
`chat-fast` → opencode-go/deepseek-v4.1-flash), a real OpenCode Go manual pin,
`/status` showing the pin, switch back to AUTO, and restart persistence across
separate processes.

## Preserve

Do not regress P2.2.1 recovery, Work model persistence, Chat-vs-Work separation,
safe AUTO billing policy, or manual-pin no-fallback behavior. Do not start P3.
No secrets in repo/logs.

## Delivery

`docs/CURRENT.md`, `docs/tasks/CURRENT.md`, `docs/V4_P2_2_SMOKE.md` updated;
committed and pushed to the active branch.
