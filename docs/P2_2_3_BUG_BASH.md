# P2.2.3 Bug Bash Ledger

Compact ledger for the repository-wide stabilization pass
(`docs/JARVIS_V4_P2_2_3_REPOSITORY_STABILIZATION_TASK.md` +
`docs/JARVIS_V4_P2_2_3_RUNTIME_POLICY_ADDENDUM.md`).

Status legend: `FIXED` (code + deterministic regression), `BLOCKED` (external
dependency), `OWNER` (only the owner can perform the interaction).

No secrets are recorded here. Real-machine evidence is summarized; full logs are
in `logs/` and the focused smoke scripts.

---

## K1 — many-model Chat UI emitted a fake runnable placeholder

- **Severity:** release blocker (instructions that necessarily fail).
- **Repro:** `/model` → Chat → provider with many models (OpenCode Go = 37) →
  `⚠️ … 请使用 !chatmodel opencode-go <model-id>`; the validator correctly
  rejects `<model-id>`, so the product told the owner to run a command that
  always fails. Same pattern in the settings Work-model list, `!models` empty
  state, `!providers`, `!executor`, vision route, provider removal and help text.
- **Root cause:** model/provider lists larger than one Discord component page
  degraded to literal placeholder instructions instead of paginating.
- **Fix:** minimal pagination for model and provider menus
  (`providerModelRows`, `pagedChoiceRows`, new nav custom ids
  `panelchatmnav/panelworkmnav/panelchatpnav/panelworkpnav/setmodelnav`), plus
  concrete, real-ID examples for every remaining instruction.
  `!chatmodel` with no argument and `!chatmodel <provider>` now open the real
  selectable menu.
- **Files:** `src/discord/renderers.mjs`, `src/discord-ui.mjs`,
  `src/provider-manager.mjs`, `src/i18n.mjs`.
- **Tests:** `tests/v4-p223-stabilization.test.mjs` (pagination page math,
  `/model` → Chat paging + selection, `!chatmodel` menu path, Work/settings
  paging, "no placeholder" sweep over every model-selection surface).
- **Status:** FIXED.

## K2 — Discord interaction `该应用程序未响应`

- **Severity:** release blocker (interaction timeout under normal conditions).
- **Repro:** owner previously saw `/status` timeout while other commands worked.
  Not reliably reproducible after the P2.2 ACK work, so the pass verified the
  ACK contract deterministically instead of guessing.
- **Root cause (found by this audit):** the PreToolUse hook server runs inside
  the bridge process, and `policy.mjs` used `spawnSync('git', ['diff','--cached'])`
  for the staged-secret guard. A `git commit` tool call could therefore block the
  bridge event loop for up to 3s — the same class of stall that makes Discord
  report "该应用程序未响应" and miss the ACK deadline.
- **Fix:** `policy.mjs` secret scan is now async (`execFile`), and
  `PermissionManager.classify` / `hook-server` await it. The permission tier is
  resolved first so the FULL invariant is preserved.
- **Files:** `src/policy.mjs`, `src/permission-manager.mjs`, `src/hook-server.mjs`.
- **Tests:** every registered slash command ACKs PASS with recorded latency; every
  panel control ACKs with the right method (deferUpdate / showModal); a failed ACK
  performs no side effect; a static guard asserts `policy.mjs` contains no
  `spawnSync`. `tests/v4-p223-stabilization.test.mjs`, `tests/policy.test.mjs`.
- **Status:** FIXED (deterministic). OWNER: real `/status` click confirmation.

## K3 — help view referenced controls that were not visible

- **Severity:** medium (contradictory UX).
- **Repro:** `/help` / `panel:help` showed quick-start text "点 ⚙️ 设置 / 🔐 权限 /
  🛠 新建 Work / ⛔ Stop" while the view only exposed a Back button.
- **Fix:** the help view now exposes the real controls it references
  (`panelHelpRows()`: 新建 Work / 设置 / 权限 / Stop + 返回) through the existing
  `panel:*` handlers; stale config-default claim removed.
- **Files:** `src/discord/renderers.mjs`, `src/discord-ui.mjs`.
- **Tests:** help view exposes `panel:newwork|settings|permission|stop|refresh`;
  the referenced Stop button runs the shared stop path.
- **Status:** FIXED.

## K4 — FULL permission was not actually FULL

- **Severity:** release blocker (displayed policy != execution policy; owner
  repeatedly re-prompted after choosing 全开放).
- **Repro:** set the parent channel to 全开放, create a Work thread, run a
  multi-step repo task → approval requests for `unclassified shell command` and
  `sensitive file access`.
- **Root causes:**
  1. `src/policy.mjs` evaluated sensitive-path / sensitive-shell / unknown-tool
     approval checks before the `permissionLevel === 'full'` allow branch.
  2. Work-thread inheritance called `permissionManager.switchLevel(thread.id,
     parentLevel)`; for FULL that returns `needsConfirm` and does not apply, so
     the child silently executed as STANDARD.
- **Fix:**
  - the two hard fail-closed guards (secret `git add` / staged-secret commit)
    run first for every tier; then FULL returns allow for all routine calls
    (unclassified shell, sensitive-by-name paths, outside-workspace writes,
    MCP/unknown tools);
  - new trusted `PermissionManager.inheritLevel()` copies the parent's effective
    level exactly (including FULL) without a second confirmation; the user-facing
    `switchLevel('full')` still requires confirmation.
- **Files:** `src/policy.mjs`, `src/permission-manager.mjs`, `src/discord-ui.mjs`.
- **Tests:** `tests/v4-p223-runtime-policy.test.mjs` (FULL parent → FULL thread,
  session bound FULL, zero prompts at the real hook gate, hard secret guard still
  denies, user switch still confirms); `tests/policy.test.mjs` FULL matrix.
- **Real E2E:** `npm run smoke:p223-full` → 15/15 on the real machine (real
  credential + Claude Code + real hook server; multi-step task with 0 prompts).
- **Status:** FIXED.

## K5 — arbitrary 900s Work wall-clock kill

- **Severity:** release blocker (a healthy real task was force-killed at 15m01s).
- **Root cause:** `src/config.mjs` defaulted `TASK_TIMEOUT_MS=900000`;
  `runTask` wrapped each Agent turn in `withTimeout(...)` and killed the process
  at expiry.
- **Fix:** production default is now unlimited (`0`). `runTask` branches
  explicitly between unlimited and an explicit positive operator limit; the
  startup backend preflight gets its own bounded timeout
  (`BACKEND_PROBE_TIMEOUT_MS`, default 180s) so it never becomes unbounded.
  Stall notices stay observability only. `.env`/`.env.example` updated.
- **Files:** `src/config.mjs`, `src/discord-ui.mjs`, `src/index.mjs`,
  `.env.example` (local `.env` set to `TASK_TIMEOUT_MS=0`, not tracked).
- **Tests:** `tests/config.test.mjs` (default 0, explicit positive honored,
  probe bound), `tests/v4-p223-runtime-policy.test.mjs` (slow healthy task not
  killed; explicit limit still fires; owner Stop still works).
- **Real E2E:** `smoke:p223-full` phase K5.2 stops a real 45s sleep task via
  `!stop`; no wall-clock kill under the default.
- **Status:** FIXED.

---

## K6 — Work lifecycle / insert / Stop state inconsistency (P2.2.4)

- **Severity:** release blocker (displayed lifecycle != actual lifecycle; insert
  accounting != actual execution).
- **Repro (owner real Hunyuan3D install):** an intermediate Agent turn was shown
  as `✅ 已完成` although the same Work still had a queued continuation; the
  completed turn's result disappeared when the continuation repainted the mutable
  progress card; Stop later reported `已清空 1 条未处理的插入需求` for a live insert
  that had in fact changed the install path; Stop needed several presses; a
  terminal STOPPED card still exposed Insert/Stop controls.
- **Root causes:**
  1. the terminal DONE transition was rendered from the turn result without a
     durable notion of "the Work is still non-terminal"; `run.continuations` was
     consumed in a window that could be missed, and completed-turn output lived
     only in the mutable progress card body;
  2. `run.injected` records were never settled: a live insert stayed "pending"
     until `#endRun`, so Stop counted an already-applied requirement as
     unprocessed;
  3. Stop had no single terminal ledger and no stale-run guard, so late/duplicate
     interactions could race the runner shutdown; queued `run.continuations`
     durable ids (`continuation:${runId}:${turn}`) never matched the row that was
     actually inserted;
  4. terminal rendering relied on the run's own `finally` to clear controls.
- **Fix:**
  - explicit insert state machine (`INSERT_STATE`: RECEIVED / DELIVERED_LIVE /
    QUEUED_CONTINUATION / CONSUMED / CANCELLED); a successful turn settles every
    live delivery as CONSUMED and an executed continuation as EXECUTED, so Stop's
    "unprocessed" count is truthful;
  - one monotonic terminal ledger per run (`#markTerminal`): DONE / FAILED /
    CANCELLED are mutually exclusive; a late event can never flip a terminal card
    back to RUNNING, and a finished DONE run cannot become STOPPED;
  - continuation decision happens before any terminal render, and the completed
    turn result is posted as its own immutable message (`#postTurnResult`) before
    the next turn repaints the card;
  - Stop is one-shot, idempotent and stale-safe (`#stopChannel(channelId,
    { runId })`): it freezes the run, cancels only genuinely pending demands,
    kills the real process tree once, renders STOPPED once, and a stale `workctl`
    id returns `该任务已结束` without touching a newer run;
  - terminal cards never carry live controls (`activeComponents`, parent card).
- **Files:** `src/discord-ui.mjs`, `scripts/p224-lifecycle-e2e.mjs`,
  `package.json` (`smoke:p224-lifecycle`).
- **Tests:** `tests/v4-p224-work-lifecycle.test.mjs` (10 required scenarios:
  no intermediate DONE; durable result; live-insert settle; continuation
  execute; single-press Stop; idempotent Stop; control-free terminal card;
  stale-control isolation; monotonic terminal; no duplicate Agent/lock).
  Adjusted `tests/v4-p22-insert.test.mjs` for the new durable intermediate
  result message.
- **Real E2E:** `npm run smoke:p224-lifecycle` → 21/21 on the real machine (real
  credential + Claude Code + real hook server + real Windows process tree):
  false-DONE monitor clean, turn-1 result preserved, live insert CONSUMED and
  continuation EXECUTED, Stop after DONE reports no unprocessed insert, one Stop
  press kills the pid tree, terminal card control-free, stale Stop rejected.
- **Status:** FIXED.

## Adjacent defects found by the matrix

### P223-B1 — staged-secret scan blocked the bridge event loop

- Same root cause as K2; fixed by the async `policy.mjs` change. Tests:
  `tests/policy.test.mjs` async/no-`spawnSync` guard. **FIXED.**

### P223-B2 — settings Work-model menu degraded for >20 models

- `set:model` showed "模型数量较多或未缓存…`!model <model-id>`". Now paginated
  (`setmodelnav`). Test: settings pagination in
  `tests/v4-p223-stabilization.test.mjs`. **FIXED.**

### P223-B3 — `resolveTransport()` silently returned `unknown` for a model object

- `ExecutorManager.resolveTransport(provider, model)` passed a model object into
  `openCodeGoTransport()` (which expects an id), yielding `unknown`. Hardened to
  accept `{ id }` or a string. **FIXED.**

### P223-B4 — stale placeholder copy across user-facing strings

- `!model <model-id>`, `!provider <id>`, `!executor <id>`, `!chatmodel
  <provider-id> <model-id>`, `!cwd <绝对路径>`, `work <任务>` and the vision
  message. Replaced with concrete examples (`!provider opencode-go`) or
  instruction phrasing. **FIXED.**

### P223-B5 — `verify:hook` could not verify the hook on the real machine

- The script used only the stale Windows-user routing env, so the real hook run
  failed with 401/403 even though the bridge route works. It now builds the
  bridge-equivalent environment (real credential, real provider, local adapter)
  and falls back to the old path only when that is unavailable. Real run:
  9/9 checks. **FIXED.**

---

## Explicitly blocked / not a repo fix

- **WorkBuddy gateway 403 (`request illegal`, provider code 11140).**
  `npm run smoke:local` agent-driven checks (A1/A3/A5/B1/C1/E2) and WorkBuddy
  executor Work tasks fail because the service rejects tool calls. This is the
  external condition already recorded in `docs/WINDOWS_SMOKE.md`; the bridge
  correctly reports WorkBuddy as unavailable and keeps other providers usable.
  Status: BLOCKED (external).
- **Discord proxy source intermittently `none`.** `doctor:discord` can report
  `proxy none` while direct login still succeeds; the bridge degrades to direct
  and stays online. Environmental (local proxy availability), not product code.
- **`[DEP0190]` shell-args deprecation warning.** Deliberate `shell:true` with
  hand-quoted args per `AGENTS.md`; informational only.

## Owner-only confirmation

- Real Discord click/typing of `/panel`, `/model`, `/status`, `/doctor` after the
  final commit (the worker cannot impersonate the owner's Discord account).
