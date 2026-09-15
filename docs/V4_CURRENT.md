# Jarvis V4 — CURRENT status

Branch: `jarvis-v4-foundation` (do not merge `main` yet; PR #2 tracks this work).

## What works now

- **Default mode is Chat.** Ordinary Discord messages call a model API directly
  and never create an Agent, workspace scan, approval hook or Agent session.
- **Deterministic local mode control**: `chat`/`/chat`/`!chat`,
  `work`/`/work`/`!work`, and `work <task>` / `chat <question>`. No model call.
- **Chat routing**: AUTO prefers the LiteLLM gateway alias `chat-fast`, then the
  OpenCode Go direct route (special/escape hatch), then other FREE/SUBSCRIPTION
  routes. METERED/unknown routes need `ALLOW_METERED_CHAT_FALLBACK=1`.
- **Fallback + cooldown**: a failed route is cooled down and not retried every
  message; successful fallbacks are attributed in the reply footer. A cooled
  primary still shows `fallback` (it is not mislabelled as a normal route).
- **Work unchanged**: explicit Work mode still uses the existing Agent path
  (Claude Code / WorkBuddy / OpenCode / Codex adapters), permissions, approval
  hook, `!stop` process-tree kill, watchdog and credential isolation.
- **LiteLLM 1.101.0** runs loopback-only on `127.0.0.1:4000`, is started/supervised
  with the bridge, and its health is shown in `!status`.
- **Global approval hook self-repair**: the bridge repoints the user-level
  `~/.claude` / `~/.codebuddy` hook at its own checkout and passes the hook
  secret via the Agent child env, so a moved checkout cannot 401 fail-closed.

## Verification

```text
npm test      -> 166 passed / 0 failed
npm run check -> 70 file(s), 0 failed
```

Real Windows/Discord evidence: `docs/V4_SMOKE.md`.

## Pending / next

- P1: Work threads (`work <task>` creates a thread; parent channel stays Chat).
- P1: workspace lock / queue for concurrent Work tasks.
- P1: richer settings/status UX (buttons/selects).
- P2: attachments, chat history + `/new` `/compact`.
- `vision` alias intentionally not added yet (unused).

## Known constraints

- WorkBuddy gateway on this machine currently returns quota/403 before tool
  calls; Chat is unaffected because it never uses WorkBuddy.
- LiteLLM needs a valid OpenCode Go key (`OPENCODE_GO_API_KEY` or the local
  OpenCode auth store). Without it, only direct routes with credentials work.
