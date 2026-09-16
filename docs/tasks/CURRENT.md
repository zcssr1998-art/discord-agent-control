# Active task

None.

## Last completed task

`docs/JARVIS_V4_P2_2_2_CHAT_MODEL_SELECTION_TASK.md` — **COMPLETE** on branch
`jarvis-v4-p2-2-hardening`.

Delivered:

1. one shared placeholder validator/normalizer (`src/model-selection.mjs`);
2. fail-closed Chat persistence at `SessionManager.setChatSelection()` plus
   real-model matching in `SessionManager.resolveChatSelection()`;
3. automatic repair of a persisted placeholder Chat selection to `AUTO/null`
   on `StateStore.load()` (chat fields only);
4. fresh/default Chat = `AUTO`;
5. real Provider/model selection from `/model` → Chat, panel buttons, settings
   and `!chatmodel`;
6. manual pin persistence + no-fallback; one-action switch back to AUTO;
7. `/status` distinguishes `AUTO` vs `手动固定 · provider/model`;
8. real-provider + restart smoke (`npm run smoke:p222`) and a live supervised
   bridge restart proving the repair.

## Preserve

- P2.2.1 Supervisor/Task Scheduler/watchdog recovery;
- Work model selection/persistence independent from Chat;
- ordinary Chat never starts an Agent;
- LiteLLM primary + OpenCode Go direct architecture;
- AUTO does not silently use disallowed metered routes;
- no secrets in repo/logs.

## Next

Await the owner's next task; do not start P3.
