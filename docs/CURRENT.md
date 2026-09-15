# Current project state

Keep this file compact. It is the first project-state file a new worker should read.

## Branch

`jarvis-v4-foundation`

## Milestone

Jarvis V4 — default Chat + explicit Work + LiteLLM standard gateway.

## Current status

V4 integration is implemented, tested and smoke-verified on the real
Windows/Discord machine. It is on Draft PR #2; `main` is not merged.

Working:

- default mode is Chat; ordinary messages go to `ChatRuntime` and never start an
  Agent, hook, workspace scan or session
- deterministic local `chat` / `work` commands and inline `work <task>` /
  `chat <question>`
- Chat AUTO prefers the LiteLLM alias `chat-fast`, then OpenCode Go direct, then
  other FREE/SUBSCRIPTION routes; METERED needs `ALLOW_METERED_CHAT_FALLBACK=1`
- per-route cooldown/circuit breaker; a failed route is not retried every message
- fallback is attributed in the reply footer, including when the primary route
  was skipped because it is cooling down
- Work mode and the existing Agent path are unchanged: permissions, approval
  hook, `!stop` process-tree kill, watchdog, credential isolation
- LiteLLM 1.101.0 pinned, loopback-only on `127.0.0.1:4000`, supervised with the
  bridge, health shown in `!status`
- OpenCode Go proxied through LiteLLM is proven (per-deployment
  `x-opencode-session`); DeepSeek -> GLM fallback proven
- the bridge self-repairs the user-level approval hook and passes the hook
  secret via the Agent child env (no stale-hook 401)

## Current task

See `docs/tasks/CURRENT.md`. The P0/P0.5 acceptance targets in
`docs/JARVIS_V4_TASK.md` are met.

## Next action

P1 work: Work threads, workspace lock/queue, richer settings/status UX. Then P2
attachments and chat history.

## Verification

```text
npm test      -> 166 passed / 0 failed
npm run check -> 70 file(s), 0 failed
```

Real-machine evidence: `docs/V4_SMOKE.md`.

## Acceptance gate

Do not merge the V4 PR until the real Windows/Discord Chat, fallback, Work and
stop evidence is in place. That evidence now exists in `docs/V4_SMOKE.md`.
