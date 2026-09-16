# AI handoff

Keep this file short and overwrite/update it at every meaningful handoff. Do not paste old chat transcripts here.

## Branch

`jarvis-v4-p2-2-hardening` (stacked on P2/P2.1; do not merge P2.2 yet).

## Active task

`docs/JARVIS_V4_P2_2_2_CHAT_MODEL_SELECTION_TASK.md`

## Current status

P2.2.1 Supervisor/autostart recovery is complete and should not be reworked. The owner performed a real reboot and Jarvis auto-started successfully.

That reboot exposed a separate Chat selection bug: a literal documentation placeholder persisted as `opencode-go / <model-id>`, so ordinary Chat was manually pinned to an impossible model and failed.

## Product semantics to implement

- fresh/default Chat = `AUTO` (`chatProviderId=auto`, `chatModel=null`);
- AUTO is a default routing mode, not a lock: owner can choose a real Provider + model from `/model` / panel / existing text command;
- manual real pin persists across restart and keeps existing no-silent-fallback semantics;
- owner can explicitly switch back to AUTO;
- reject obvious placeholder IDs at one shared persistence boundary;
- repair existing placeholder state automatically to AUTO/null while preserving unrelated channel/Work/workspace/session state;
- when real model discovery succeeds, require an exact model match before persisting; keep compatibility for providers that genuinely cannot enumerate models.

## Real smoke required

Prove on the live Jarvis:

1. historical `<model-id>` repairs automatically;
2. `你好` works in AUTO;
3. Chat model UI shows AUTO plus selectable Provider/model choices;
4. manual real model pin works and `/status` shows it;
5. switch back to AUTO works;
6. bridge restart preserves the selected mode correctly;
7. Supervisor/watchdog remains healthy and no duplicate bridge appears.

## Preserve

Do not regress P2.2.1 recovery, Work model persistence, Chat-vs-Work separation, safe AUTO billing policy, or manual-pin no-fallback behavior. Do not start P3. No secrets in repo/logs.

## Delivery

Update `docs/CURRENT.md`, this handoff, `docs/tasks/CURRENT.md` and relevant smoke evidence; commit + push to the active branch. Final response follows the short contract in the active task.
