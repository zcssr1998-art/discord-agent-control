# Active task

Current execution specification:

`docs/JARVIS_V4_P2_2_2_CHAT_MODEL_SELECTION_TASK.md`

Branch: `jarvis-v4-p2-2-hardening`

## Why this task is active

The owner rebooted after P2.2.1 and Jarvis auto-started successfully, so the Supervisor/autostart recovery path is now materially improved. The reboot exposed a separate Chat correctness bug:

- persisted Chat route was literally `opencode-go / <model-id>`;
- ordinary Chat failed because the documentation placeholder had been accepted as a real manual pin;
- owner clarified intended UX: Chat defaults to AUTO, but AUTO must not be the only option — owner must be able to select/persist a real Provider + model and switch back to AUTO.

## Scope

Execute only `docs/JARVIS_V4_P2_2_2_CHAT_MODEL_SELECTION_TASK.md`:

1. reject obvious placeholder Provider/model IDs at one shared persistence boundary;
2. automatically repair already-persisted invalid Chat selection to `AUTO/null` without deleting unrelated state;
3. keep fresh/default Chat on AUTO;
4. keep manual Provider/model selection available in `/model` / panel / text command;
5. validate real model IDs when provider model discovery is available;
6. manual pin remains no-fallback; AUTO remains safe automatic routing;
7. live Discord smoke: AUTO chat, manual pin, `/status`, switch back AUTO, restart persistence.

## Preserve

- P2.2.1 Supervisor/Task Scheduler/watchdog recovery implementation;
- Work model selection/persistence independent from Chat;
- ordinary Chat never starts an Agent;
- LiteLLM primary + OpenCode Go direct architecture;
- AUTO does not silently use disallowed metered routes;
- no secrets in repo/logs.

## Completion

Update `docs/CURRENT.md`, `docs/AI_HANDOFF.md`, this file and relevant smoke evidence; commit + push. Stop after the task acceptance gates pass.
