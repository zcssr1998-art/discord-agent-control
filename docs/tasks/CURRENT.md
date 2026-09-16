# Active task

Current execution specification:

`docs/JARVIS_V4_P2_2_HARDENING_TASK.md`

Branch: `jarvis-v4-p2-2-hardening`

Status: **implementation complete and verified** at this commit. Evidence: `docs/V4_P2_2_SMOKE.md`. Compact state: `docs/CURRENT.md`.

Delivered (in the spec's order):

1. single-instance guard + PID/branch/commit/uptime/instance identity (`src/instance-guard.mjs`, `src/build-identity.mjs`, `/status`)
2. Windows logon autostart via Task Scheduler launching the existing supervisor, install/remove/status/idempotent
3. SQLite WAL durable store with safe restart/interrupted semantics (`src/durable-store.mjs`)
4. parent-channel compact Work summary/control card reusing the existing thread/follow-up/stop paths
5. incremental `discord-ui.mjs` extraction into `src/discord/renderers.mjs` (pure helpers only, no rewrite)
6. minimal Windows CI + deterministic local `/doctor` (and `!doctor`)
7. full regression `npm test` 274/0 · `npm run check` 96/0 · `npm run smoke:p2` 11/11 · `npm run smoke:p22` 10/10
8. Windows real-machine smoke: scheduled task → supervisor → LiteLLM UP → bridge online; second launch refused pre-login
9. interaction ACK hardening after a real `/work` FAIL (Discord "该应用程序未响应" while the thread was still created): failed ACK now aborts before any side effect, with real cause classification + timing log; `tests/v4-p22-ack.test.mjs`

Remaining (owner-only, do not fabricate):

- `PENDING_OWNER_DISCORD_SMOKE` — re-test `/work` once on the live bridge (expect `[interaction] /work ACK PASS <ms>ms method=deferReply`), plus parent card `打开 Work` / `追加需求` / `Stop`, live `/status` and `/doctor`.
- `PENDING_OWNER_REBOOT_SMOKE` — owner restarts Windows and confirms logon autostart brings Jarvis back.

Worker instructions:

- do not redo P2/P2.1 or re-implement P2.2
- the supervisor remains the only restart owner for Jarvis + LiteLLM
- never reboot the owner machine automatically
- keep runtime artifacts (`data/jarvis-instance.lock`, `data/jarvis.db*`) git-ignored
- final chat response must follow the short Worker response contract
