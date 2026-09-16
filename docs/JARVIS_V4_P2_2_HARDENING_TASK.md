# Jarvis V4 P2.2 — Hardening, durable runtime, autostart, and maintainability

## 0. Goal

Turn the verified P2/P2.1 personal Discord Agent console into a long-running Windows service-like personal platform without adding a web dashboard, Redis/PostgreSQL, swarm orchestration, or market-data/P3 features.

P2.2 must preserve all P0/P1/P2/P2.1 behavior and focus on operational maturity:

1. only one live Jarvis bridge for this checkout/bot identity;
2. Windows logon autostart through the existing supervisor, including LiteLLM;
3. visible live build/runtime identity;
4. durable run/session metadata with SQLite WAL;
5. parent-channel Work summary/control card;
6. split the oversized Discord control-plane module without changing behavior;
7. CI + local `/doctor` diagnostics.

This milestone is complete only after deterministic tests, Windows real-machine smoke, and owner Discord smoke. Do not fake reboot evidence.

---

## 1. Non-negotiable invariants

Preserve:

- ordinary Chat never starts an Agent;
- LiteLLM primary + OpenCode Go direct fallback;
- manual Chat pin never silently falls back;
- AUTO never silently uses metered/unknown billing;
- guild Work runs in a permanent Work thread; parent remains Chat;
- one canonical workspace has at most one active Work run; same-workspace work is FIFO;
- queued work never starts an Agent before acquiring the workspace lock;
- progress-card `追加需求` and `Stop` semantics from P2.1;
- `Stop` kills the real process tree and clears pending follow-ups;
- stale buttons/runIds cannot affect a newer run;
- permission/approval/session/secret isolation remains fail-closed;
- no model call for local control commands, status, panel, doctor, autostart, queue bookkeeping, or persistence;
- no background retry loop that can burn tokens unattended.

Do not redesign the P2 control panel, provider/model system, Chat history, attachment pipeline, or Agent protocol adapters unless required for this milestone.

---

## 2. P2.2A — Single-instance runtime guard + build identity

### Problem

A stale/old bridge and a new bridge can otherwise use the same Discord bot token at the same time, producing routing ambiguity and making smoke evidence unreliable.

### Required behavior

Add a small runtime-instance component, preferably dependency-free.

- On startup, acquire an exclusive local instance lock under git-ignored runtime data.
- Lock metadata must include at least: PID, startedAt, repoRoot, branch, commit, instanceId.
- If a live owner process already holds the lock, the second bridge must fail fast with a clear message and non-zero exit; it must not log into Discord.
- If the lock is stale because the old PID no longer exists, safely reclaim it.
- Graceful shutdown removes/releases the lock; hard-kill/crash may leave stale metadata, which the next startup must recover.
- Never kill another process automatically merely because a lock exists.

Expose live identity in `/status` and `!status`:

```text
Runtime: PID 12345 · uptime 2h13m
Build: main@abc1234
Instance: <short-id>
Autostart: enabled/disabled + task state when known
```

Use real runtime information. If git metadata is unavailable, show `unknown`; do not invent a branch/commit.

### Tests

- first instance acquires;
- second instance is refused before Discord login;
- stale lock recovery;
- cleanup on graceful close;
- status identity rendering.

---

## 3. P2.2B — Windows autostart via Task Scheduler

### User intent

After Windows restarts and the owner logs in, Jarvis should come back online automatically without manually opening OpenCode/PowerShell. This is a user-logon autostart, not a pre-login Windows service.

### Architecture

Use **Windows Task Scheduler** rather than Startup-folder shortcuts.

The scheduled task must start the existing `scripts/start-supervisor.ps1`, not `node src/index.mjs`, because the supervisor already owns bridge restart/backoff and LiteLLM lifecycle.

Recommended task name: `Jarvis Discord Agent Control` (one canonical per Windows user). Re-running the installer must update the task to the current checkout rather than create duplicates.

### Required scripts

Add:

- `scripts/install-autostart.ps1`
- `scripts/uninstall-autostart.ps1`
- optional small bootstrap/helper only if needed for delayed start/hidden execution.

Installer requirements:

- current-user logon trigger; no stored password and no administrator requirement for the normal path;
- use absolute paths resolved from the installer checkout;
- start hidden/non-interactive where practical;
- launch `start-supervisor.ps1` from this checkout;
- optional short startup delay (about 10–20s) is acceptable so network/proxy/user profile are ready;
- idempotent: install twice = one task pointing at the latest checkout;
- print/query the effective task name, action path, arguments, and enabled state without secrets;
- support a safe `-DryRun`/preview path if practical;
- uninstall only the exact Jarvis-owned scheduled task;
- do not modify unrelated scheduled tasks.

Add npm convenience commands if useful, e.g. `autostart:install`, `autostart:status`, `autostart:remove`, but do not force npm if PowerShell is clearer.

### Runtime interaction

- Autostart + manual launch must be safe because P2.2A single-instance protection refuses the duplicate.
- Supervisor remains the only owner of bridge/LiteLLM restart loops. Do not introduce a second restart loop in the scheduled task.
- A failed bridge start should remain visible in supervisor logs.

### Smoke

Machine-side smoke may install/query/start the scheduled task, but **must never reboot the owner's PC automatically**.

Final reboot verification is owner-run and recorded as `PENDING_OWNER_REBOOT_SMOKE` until the owner explicitly restarts Windows and confirms Jarvis returns online.

---

## 4. P2.2C — Parent-channel Work summary/control card

Keep the Work thread as the detailed work site. Add/update one compact parent-channel summary card per Work chain so the owner can control a job without opening the Discord thread.

Suggested card:

```text
🛠 Work · <short task title>
🟡 RUNNING · 1m24s
🤖 deepseek-v4.1-flash
📁 <project/workspace>

[打开 Work] [➕ 追加需求] [⛔ Stop]
```

Requirements:

- parent remains Chat;
- `打开 Work` links/navigates to the existing Work thread; no duplicate run;
- `追加需求` delegates to the same P2.1 follow-up queue/modal;
- `Stop` delegates to the same shared stop path;
- bind controls to run/chain identity; stale parent cards cannot affect newer work;
- update/throttle the summary rather than spamming new parent messages;
- final card shows DONE/FAILED/CANCELLED and remains useful as a compact history pointer.

Do not duplicate the full verbose task progress already shown inside the Work thread.

---

## 5. P2.2D — Durable Store (SQLite WAL) for operational metadata

### Why now

JSON remains acceptable for small static configuration, but P2.2 needs durable run history and operational metadata. Use one local SQLite database, not Redis/PostgreSQL.

### Scope

Introduce a narrow store abstraction (name is flexible, e.g. `DurableStore` / `RunStore`) backed by `data/jarvis.db` in WAL mode.

Persist at minimum:

- Run records: runId/chainId, channel/thread, workspace, task title/prompt summary, executor/provider/model, permission, startedAt/finishedAt, final state, duration, cost/usage when available, tests/result summary, session id, error code/message (redacted).
- Session metadata needed to browse/diagnose Work continuity.
- Queue/follow-up metadata sufficient to explain what was pending when a bridge stopped.

Safety on restart:

- never silently resume an Agent process that died with the bridge;
- prior `RUNNING` rows become `INTERRUPTED` (or equivalent) on startup;
- pending queued/follow-up work must not auto-execute hours later without an explicit, already-defined safe resume policy. Preserve it for visibility/audit, or mark it interrupted/cancelled-with-restart reason.

Do not migrate secret material into SQLite. Credentials remain in the existing credential store unless a separate security-reviewed migration is justified.

### SQLite implementation choice

First check the actual Node runtime used on the Windows host. Prefer the lowest-maintenance mature option compatible with that runtime. Built-in `node:sqlite` is acceptable if the installed Node version/API is suitable; otherwise use a mature SQLite package. Do not add a native dependency blindly if it makes Windows deployment fragile.

### Compatibility

- Existing `state.json` / provider configuration must continue to load.
- Add explicit schema version/migrations for the new DB.
- Migration/initialization must be idempotent and recoverable.

### UX

Add `/runs` only if it can be done cleanly in this milestone; otherwise persist the data and expose recent run lines via `/status`/`/doctor`, leaving the full Runs Center to P4. Do not inflate scope for a fancy browser UI.

---

## 6. P2.2E — Split the Discord God module without a rewrite

`src/discord-ui.mjs` has grown into a very large mixed-responsibility module. Refactor incrementally with tests, preserving public behavior.

Target separation (exact filenames may vary):

```text
src/discord/
  interaction-router.mjs
  command-handlers.mjs
  renderers.mjs

src/chat/
  chat-controller.mjs

src/work/
  work-controller.mjs
  followup-controller.mjs
```

Rules:

- no big-bang rewrite;
- extract pure render/parse helpers first, then controllers;
- keep one source of truth for stop/model/settings/permissions;
- do not create parallel state managers;
- existing tests must remain green throughout;
- avoid circular imports and hidden global singletons.

The final `DiscordControlPlane` should primarily route Discord events/interactions to focused components, not own every business rule.

---

## 7. P2.2F — CI + `/doctor`

### GitHub CI

Add a minimal GitHub Actions workflow with **Windows as a required job** because Jarvis is Windows-first.

No secrets required. At minimum run:

```text
npm ci
npm test
npm run check
```

If a Linux job is cheap and does not require platform-specific fake setup, it may be added as an extra portability signal, not as a reason to over-engineer.

### `/doctor`

Register a Discord-native `/doctor` command (and optional `!doctor` compatibility) that is local/deterministic and does not call an LLM.

It should summarize actionable health only, for example:

- runtime instance/build/PID/uptime;
- Discord connection;
- LiteLLM health;
- Provider/model route health where already available;
- Executor discovery status;
- approval hook ownership/reachability;
- autostart scheduled-task state;
- durable-store open/schema status;
- duplicate-instance warning if detectable.

Never print credentials, tokens, full environment dumps, or sensitive local file contents.

---

## 8. Token/cost discipline

Follow repository-wide AI rules:

- do not re-scan the whole repository after reading CURRENT/HANDOFF/task and relevant diffs;
- use targeted tests during implementation, full suite at milestones;
- raw logs stay in files; only relevant tail/errors enter model context;
- no LLM for deterministic health/status/persistence/autostart decisions;
- do not run redundant parallel Agents on the same subtask;
- after deterministic PASS, stop re-verifying without a concrete reason.

---

## 9. Suggested execution order

1. P2.2A single-instance + runtime/build identity.
2. P2.2B autostart installer/uninstaller + supervisor integration smoke.
3. P2.2D durable SQLite store + restart/interrupted semantics.
4. P2.2C parent Work summary card.
5. P2.2E module extraction/refactor.
6. P2.2F CI + `/doctor`.
7. Full regression + Windows smoke + minimal owner Discord smoke.
8. Owner reboot smoke for autostart only when explicitly requested; never reboot automatically.

This order secures the runtime before refactoring it and gives later smoke tests strong build/instance identity.

---

## 10. Acceptance criteria

Deterministic:

- all existing P0/P1/P2/P2.1 tests remain green;
- new single-instance, durable-store, parent-card, doctor and autostart-generation tests are green;
- `npm run check` green;
- `npm run smoke:p2` remains green;
- no secret is committed/logged;
- CI workflow passes on Windows.

Real Windows machine:

- a second Jarvis launch is refused before Discord login;
- `/status` reports the actual PID/build/instance and autostart state;
- autostart task installs idempotently and points at the current checkout's supervisor;
- scheduled-task manual start brings the supervisor/bridge online without creating duplicates;
- LiteLLM lifecycle still belongs to the supervisor;
- parent summary card controls the existing Work thread/run;
- bridge restart marks stale active work interrupted rather than pretending it survived;
- `/doctor` reports actionable health with no model call.

Owner smoke:

- parent Chat remains usable while Work thread runs;
- parent summary `打开 Work` / `追加需求` / `Stop` work correctly;
- `/status` and `/doctor` show the expected live identity;
- after owner-approved real Windows restart, Jarvis returns online automatically. Until that reboot is actually performed, record `PENDING_OWNER_REBOOT_SMOKE`, not PASS.

---

## 11. Explicit non-goals

Not in P2.2:

- Longbridge/Futu/market monitoring (P3);
- Project/Session/Artifact/Usage Center UI (P4, except persistence groundwork);
- parallel worktrees / Agent team / real Codex/OpenCode adapters (P5);
- web dashboard;
- Redis/PostgreSQL/Kubernetes;
- voice;
- multi-user enterprise RBAC;
- autonomous self-update unless it falls out trivially from CI/autostart work (otherwise defer).

---

## 12. Worker delivery contract

Update:

- `docs/CURRENT.md`
- `docs/AI_HANDOFF.md`
- `docs/tasks/CURRENT.md`
- create/update `docs/V4_P2_2_SMOKE.md`

Commit + push to `jarvis-v4-p2-2-hardening`.

Final worker reply only:

```text
PASS/FAIL
commit: <sha>
tests: <summary>
windows-smoke: <summary>
autostart: <installed/status/PENDING_OWNER_REBOOT_SMOKE>
blocker: <none or one key blocker>
```
