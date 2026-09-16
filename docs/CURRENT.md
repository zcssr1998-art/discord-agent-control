# Current project state

Keep this file compact. It is the first project-state file a new worker should read.

## Branch

`jarvis-v4-p2-2-hardening`

Stacked on P2/P2.1. Do not merge P2.2 yet.

## Current milestone

Jarvis V4 P2.2.2 — Chat model selection + invalid placeholder repair: **COMPLETE**.

Spec: `docs/JARVIS_V4_P2_2_2_CHAT_MODEL_SELECTION_TASK.md`
Evidence: `docs/V4_P2_2_SMOKE.md` (section 9).

## What changed (P2.2.2)

- `src/model-selection.mjs` — the one shared placeholder validator/normalizer
  (`isPlaceholderId` / `normalizeChatSelection` / `needsChatSelectionRepair`).
- `SessionManager.setChatSelection()` is now the fail-closed persistence
  boundary (placeholder input throws `INVALID_CHAT_SELECTION`); new
  `resolveChatSelection()` additionally requires an exact match against the
  provider's real model list when one is available.
- `StateStore.load()` auto-repairs a persisted placeholder Chat selection to
  `AUTO/null` and persists it; only chat fields are touched.
- Discord `/model` → Chat, `!chatmodel`, the panel and settings buttons all
  funnel through one `#applyChatSelection`; `/status` shows `AUTO` or
  `手动固定 · provider/model`.

## P2.2.1 recovery baseline (unchanged, must stay intact)

Supervisor/autostart recovery is implemented and real-machine verified at/after
`c83751b`; the owner's reboot auto-started successfully. `npm test` still runs
`tests/v4-p221-recovery.test.mjs` green. The P2.2.2 live smoke also recovered the
bridge through the supervisor after a hard kill.

## Owner-required Chat semantics (now implemented)

- fresh/default Chat = `AUTO` (`chatProviderId=auto`, `chatModel=null`);
- AUTO is safe automatic routing, not a lock: a real Provider/model can be
  chosen from `/model` / panel / `!chatmodel`;
- a manual real pin persists across restart and stays a true no-fallback pin;
- switching back to AUTO is one explicit action;
- placeholder/example IDs (`<model-id>` / `<provider-id>` / ...) can never be
  persisted;
- an existing bad persisted placeholder is repaired automatically to `AUTO/null`
  without deleting unrelated state.

## Preserve

- ordinary Chat never starts an Agent;
- Work model selection/persistence is independent from Chat;
- LiteLLM primary + OpenCode Go direct architecture;
- AUTO does not unexpectedly use disallowed metered routes;
- single-instance/recovery/watchdog behavior remains intact;
- no secrets in repo/logs/state evidence.

## Non-goals

No P3/finance/Longbridge, Supervisor redesign, new provider architecture, web
dashboard, Agent teams, or broad Discord UI refactor.

## Next action

P2.2.2 is done. Await the owner's next task; do not start P3.
