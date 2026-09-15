# AI handoff

Keep this file short and overwrite/update it at every meaningful handoff. Do not paste old chat transcripts here.

## Current task

Jarvis V4 Chat/Work + LiteLLM integration. P0/P0.5 acceptance is complete and
verified on the real machine. Next work is P1 (Work threads, workspace
lock/queue, settings UX).

## Branch

`jarvis-v4-foundation` (Draft PR #2; do not merge `main` yet).

## Last known good repository state

All V4 work is committed and pushed. `npm test` 166/0, `npm run check` 70/0.
Real evidence in `docs/V4_SMOKE.md`.

## Done

- ChatRuntime wired into `src/index.mjs` and `DiscordControlPlane`; ordinary
  messages route by mode (`chat` -> `runChat`, `work` -> `runTask`)
- deterministic local mode commands incl. inline `work <task>` / `chat <q>`
- `!chatmodel` and CHAT/WORK sections in `!status`
- LiteLLM 1.101.0 installed in `data/litellm/venv`, pinned in
  `scripts/litellm/VERSION`, loopback-only, supervised, health in status
- OpenCode Go compatibility through LiteLLM proven with `x-opencode-session`;
  DS -> GLM fallback proven; direct OpenCode Go kept as escape hatch
- fallback + cooldown attribution fixed (cooled primary still shows `fallback`)
- stale global approval-hook 401 fixed (env secret + startup self-repair)
- real Windows/Discord smoke: Chat 1.7 s, Work DONE with real Write+Read,
  `!stop` killed the real `claude.exe` tree, Chat never started an Agent

## Pending

- P1: Work threads (`work <task>` creates a thread), workspace lock/queue,
  settings/status UX
- P2: attachments, chat history, `/new` `/compact`
- optional `vision` alias (not added; unused)

## Blocker

None.

## Next action

Read `docs/tasks/CURRENT.md`, then implement P1 items from
`docs/JARVIS_V4_TASK.md`. Keep LiteLLM as the standard gateway; do not route the
Agent lifecycle through it.

## Verification

```text
npm test
npm run check
```

For real-machine checks: `scripts/start-windows.ps1` (starts LiteLLM + bridge),
`npm run doctor:discord`, then the Discord smoke steps in `docs/V4_SMOKE.md`.

## Minimal relevant files

- `AGENTS.md`
- `docs/CURRENT.md`
- `docs/tasks/CURRENT.md`
- `docs/JARVIS_V4_TASK.md`
- `docs/V4_SMOKE.md`
- `src/discord-ui.mjs`
- `src/chat-runtime.mjs`
- `src/litellm.mjs`
- `src/global-hook.mjs`
- `src/provider-manager.mjs`
- `scripts/start-litellm.ps1`, `scripts/start-supervisor.ps1`
