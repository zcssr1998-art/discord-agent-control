# AI handoff

Keep this file short and overwrite/update it at every meaningful handoff. Do not paste old chat transcripts here.

## Branch

`jarvis-v4-p2-2-hardening` (stacked on P2/P2.1 head `6d7f60af241ef65b226b6ebfc602593b797b5231`). Do not merge to `main` until P2/P2.1 PR #4 is accepted/merged.

## Status

P2.2 implementation is complete and verified. Evidence: `docs/V4_P2_2_SMOKE.md`. Compact state: `docs/CURRENT.md` (do not duplicate it here).

## What a next worker must know

- `➕ 插入需求` is live steering, not a queued turn: `ClaudeRunner.injectRequirement()` writes into the RUNNING child's stdin (`send()` remains next-turn). Keep them separate; an insert must never start a second Agent/run/lock or invent a queue position. Unsupported executors must degrade visibly (`⚠️ 当前执行器不支持运行中插入…`), and a race at the turn boundary becomes a same-session continuation, never a dropped demand.
- Interaction ACK failures are never swallowed: `#acknowledge()`/`#showModalAck()` in `src/discord-ui.mjs` return a result, `onInteraction` aborts on failure, and every interaction logs `[interaction] <label> ACK PASS|FAIL|SKIP <ms>ms method=…` with `requestReceivedAt/ackStartedAt/ackCompletedAt`. Do not re-introduce a bare `catch {}` around defer/showModal: that caused Discord "该应用程序未响应" while the backend still created the Work thread.

- The single-instance lock is `data/jarvis-instance.lock` (git-ignored). A live holder is never killed; a second instance exits 1 before Discord login. `JARVIS_INSTANCE_LOCK` isolates the lock for tests.
- Autostart is a per-user Task Scheduler task (`Jarvis Discord Agent Control`) running `scripts/start-supervisor-autostart.cmd` → `scripts/start-supervisor.ps1`. The supervisor stays the only restart owner for the bridge and LiteLLM. The task must never call `node src/index.mjs` directly.
- `scripts/start-supervisor.ps1` resolves `$LogDir`/`$Entry` independently of `$PSScriptRoot`, because Task Scheduler contexts can leave `$PSScriptRoot` empty (that bug silently swallowed early logs once).
- The durable store is `data/jarvis.db` (WAL, `node:sqlite`, schema v1 via `PRAGMA user_version`). Startup marks stale active runs `INTERRUPTED`; nothing auto-resumes.
- `discord-ui.mjs` now imports pure rows/labels from `src/discord/renderers.mjs`. Keep one source of truth in `DiscordControlPlane`; do not add a parallel state manager.
- `/status` appends `Build/Runtime/Instance` lines; `/doctor` and `!doctor` are local/deterministic (no model calls, no secrets).

## Verification used

```text
npm test         284/0
npm run check    97/0
npm run smoke:p2 11/11
npm run smoke:p22 10/10
```

## Remaining (owner-only)

`PENDING_OWNER_REBOOT_SMOKE` (owner reboots Windows and confirms Jarvis returns at logon) and `PENDING_OWNER_DISCORD_SMOKE` (parent card controls, live `/status` + `/doctor`). Never reboot automatically.

## Non-goals

No Longbridge/Futu/P3, web dashboard, Redis/Postgres, Agent swarm/worktree, new Codex/OpenCode adapter, voice.

## Delivery

Commit + push to `jarvis-v4-p2-2-hardening`; update `docs/CURRENT.md`, this file, `docs/tasks/CURRENT.md`, `docs/V4_P2_2_SMOKE.md`. Final worker reply stays short (`PASS/FAIL`, commit, tests, windows-smoke, autostart, blocker).
