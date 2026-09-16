# Jarvis V4 P2.2.3 — Repository Stabilization / Full Bug Bash

## Objective

Run one deliberate, repository-wide stabilization pass over the current Jarvis V4 implementation. The goal is to stop the pattern of fixing one visible bug at a time and then discovering another adjacent bug immediately afterward.

This task is intentionally broader than the previous focused fixes, but it is still a **stabilization task, not a feature expansion**.

Success means:

- all currently implemented user-facing paths are systematically exercised;
- reproducible bugs found during this pass are fixed before completion;
- known edge cases are converted into deterministic regression tests where practical;
- real Windows/Discord/runtime paths are exercised where unit tests cannot establish correctness;
- no P3/finance/new-product work is started;
- the repository is left in a state where routine Chat/Work/control-panel/restart use no longer exposes obvious broken or contradictory UX.

## Read first

Follow the repository startup order exactly:

1. `AGENTS.md`
2. central `GLOBAL_AI_RULES.md`
3. `docs/CURRENT.md`
4. `docs/AI_HANDOFF.md`
5. `docs/tasks/CURRENT.md`
6. this task
7. current branch / HEAD / `git status` / relevant diff
8. inspect existing processes/jobs before starting duplicate long-running work

Do not re-read the entire git history or old chat transcripts.

## Branch / scope

Target branch:

`jarvis-v4-p2-2-hardening`

Keep P2.2.1 Supervisor recovery and P2.2.2 Chat-selection behavior intact unless a real regression is proven.

This pass covers the existing Jarvis product surface only:

- Discord native slash commands
- text commands
- control-panel buttons/modals
- Chat routing/model/provider selection
- Work/Agent orchestration
- permissions/approvals
- workspace/session/state persistence
- attachments/context controls
- queue/stop/live-insert behavior
- startup/restart/watchdog/supervisor/LiteLLM lifecycle
- error handling, ACK timing and recovery
- user-facing help/status/diagnostics consistency

## Known bugs that MUST be addressed

These are already reproduced by the owner and are mandatory, not optional findings.

### K1. `/model` still emits a fake actionable placeholder

Current real Discord behavior:

```text
⚠️ OpenCode Go 模型较多，请使用 !chatmodel opencode-go <model-id>。
```

The placeholder validator correctly rejects `<model-id>`, so the product currently instructs the owner to run a command that is guaranteed to fail.

Fix the UX, not the validator.

Required behavior:

- never present literal placeholders such as `<model-id>` / `<provider-id>` as if they were directly runnable commands;
- when a provider exposes many models, give a real selectable/paginated/searchable path in Discord, or another concrete path that surfaces actual model IDs;
- `/model` → Chat must remain sufficient for normal use without requiring the owner to already know model IDs;
- if Discord component limits require pagination, implement minimal pagination rather than falling back to a fake placeholder instruction;
- all user-facing examples must be clearly examples, never copy-paste traps.

### K2. Slash-command `该应用程序未响应` must be treated as a release blocker if reproducible

Owner previously saw `/status` return Discord `该应用程序未响应` while other commands later worked.

P2.2 added ACK hardening, but this broad pass must verify every slash command and button/modal path against Discord's interaction ACK deadline.

Required:

- ACK happens before slow I/O or model/provider/network work;
- failed ACK aborts side effects;
- no command creates a task/thread after Discord already reports timeout;
- repeated `/status`, `/doctor`, `/model`, `/panel`, `/settings`, `/permission`, `/help`, `/new`, `/compact`, `/stop`, `/work` must not intermittently timeout under normal local conditions;
- record ACK latency in the focused smoke evidence.

### K3. Help/control-panel UX must not reference controls that are not actually visible/available

The help page currently says things such as “点 ⚙️ 设置 / 🔐 权限 / 🛠 新建 Work” while the `/help` view itself may expose only a Back button.

Fix one of these ways, whichever is simpler and consistent with current architecture:

- add the relevant real control buttons to the help response; or
- phrase help as navigation instructions (`先打开 /panel → 设置`) rather than pretending emoji text is a button.

Do not duplicate a second control-panel implementation.

## Audit strategy

This is a broad stabilization pass, so a structured audit is justified. Do not perform random full-repo reading.

Use a feature matrix, drive each path, record only FAILs and high-value PASS evidence, and stop expanding once the matrix is covered.

The lead Agent owns integration and final review. Focused workers may be used for repetitive domain sweeps, but:

- no two workers independently re-plan or re-scan the whole repo;
- each worker gets one domain and returns only findings + reproduction + patch/test evidence;
- deterministic tests decide PASS/FAIL;
- durable findings live in the repository, not chat.

Suggested domains if delegation is useful:

1. Discord UI/interactions/ACK/help/model menus
2. Chat/provider/model/state persistence/routing
3. Work/queue/permissions/stop/live insert/workspace
4. Windows supervisor/autostart/LiteLLM/process recovery

Delegation is optional; do not create workers if one executor can complete the matrix efficiently.

## Required audit matrix

### A. Native slash commands

Exercise every registered native command:

- `/panel`
- `/work`
- `/model`
- `/settings`
- `/permission`
- `/status`
- `/doctor`
- `/stop`
- `/new`
- `/compact`
- `/help`

For each:

- ACK succeeds within Discord deadline;
- returned content/components are internally consistent;
- buttons/modals actually work;
- Back/Refresh/navigation returns to the correct view;
- stale button/run IDs fail safely;
- no duplicate reply / already-acknowledged error;
- no side effect after failed ACK.

### B. Text command parity

Exercise current supported text forms and ensure they are consistent with slash/UI behavior:

- `chat`, `work`
- `!chatmodel`
- `!model`, `!models`
- `!provider`, `!providers`
- `!executor`
- `!permission` / `!perm`
- `!status`
- `!doctor` if supported
- `!stop`
- `!reset`
- `!cwd`
- `!workspace`
- `!handoff`
- `!help`

Audit for stale docs, contradictory wording, unreachable paths and placeholders.

### C. Chat routing / model selection

Verify:

- fresh/default = AUTO/null;
- AUTO uses only allowed healthy FREE/SUBSCRIPTION routes under current billing policy;
- AUTO remains user-changeable;
- manual Provider/model selection through Discord UI works;
- many-model providers are browsable without placeholder copy-paste traps;
- manual pin persists across bridge restart;
- manual pin does not silently fall back;
- switching back to AUTO works and persists;
- invalid placeholders are rejected and existing bad persisted state repairs safely;
- stale real model becomes a clear actionable error, not corruption;
- provider missing credential / provider unavailable / model discovery unavailable produce honest UX;
- Chat never starts an Agent.

### D. Work / Agent path

Verify real Work behavior:

- parent channel remains Chat;
- Work thread creation is correct;
- correct workspace is used;
- correct executor/provider/model is used;
- same-workspace serialization/FIFO still works;
- distinct workspaces can run independently where intended;
- live insert uses same run/session and no second Agent;
- queued follow-up semantics remain correct;
- Stop kills the actual process tree and clears pending inserts/follow-ups;
- old cards cannot control newer runs;
- terminal card reaches exactly one terminal state;
- interrupted bridge restart never falsely restores a RUNNING task;
- Work model persistence is independent of Chat model persistence.

### E. Permission / approval path

Verify every permission tier and transition:

- strict
- standard
- relaxed
- full

Check:

- full confirmation cannot be accidentally bypassed;
- session allows are scoped correctly;
- reset clears intended permissions only;
- approval timeout/deny/allow-once/allow-session behavior;
- stale approval cannot approve a newer/different session;
- no dangerous command executes before required approval;
- permission UI and status labels agree.

Use safe observable commands only; do not perform destructive tests.

### F. Workspace / state / restart persistence

Test state recovery from:

- clean/fresh state;
- existing normal state;
- malformed/partial JSON where current recovery policy permits safe repair;
- invalid Chat placeholder state;
- stale model/provider selection;
- historical cwd/run data;
- bridge restart;
- supervisor restart;
- Windows logon autostart state.

Verify:

- no unrelated fields are lost during repair;
- workspace resolution never falls back to previous run history incorrectly;
- startup card, `/status` and actual task launch resolve the same effective workspace/model/provider;
- exactly one bridge owns the single-instance lock.

### G. Attachments / Chat context

Exercise:

- text attachment into Chat;
- image attachment with a valid vision route when available;
- honest error when no vision route exists;
- Work attachment manifest/path flow;
- attachment cleanup/TTL path;
- `/new` clears only current Chat context;
- `/compact` actually compacts intended history and does not destroy model/Work configuration;
- oversized/unsupported attachments fail clearly and safely.

Do not burn model tokens on large fixtures; use minimal test files/images.

### H. Provider / network failure behavior

Safely simulate or fixture-test:

- LiteLLM temporarily down;
- OpenCode Go route unavailable;
- provider model-list failure;
- Discord REST/Gateway transient failure where practical;
- proxy unavailable at startup;
- recovery after the condition is restored.

Requirements:

- no silent metered fallback that violates policy;
- no permanent offline state after temporary failure;
- no infinite tight retry loop;
- error text is actionable and does not expose secrets.

Do not destructively change the owner's real network/proxy settings when an isolated fixture can prove the same behavior.

### I. Windows process / supervisor regression

Re-run focused P2.2.1 recovery gates:

- scheduled task starts Supervisor → LiteLLM + Bridge;
- kill Bridge only → automatic Bridge recovery, Supervisor preserved;
- kill LiteLLM only → automatic recovery;
- kill Supervisor only → Task Scheduler watchdog recovers it;
- exactly one bridge instance after recovery;
- no orphan Node/PowerShell/LiteLLM processes from tests.

Do not reboot the owner's machine automatically.

### J. User-facing copy consistency sweep

Search user-visible strings for:

- `<model-id>` / `<provider-id>` / other placeholder traps;
- stale command names;
- buttons that no longer exist;
- incorrect claims about AUTO/manual fallback;
- incorrect provider/model names;
- stale workspace paths;
- mojibake / broken Unicode;
- English/Chinese inconsistencies that materially confuse operation;
- instructions that tell the owner to perform an impossible action.

Only fix real product-facing inconsistencies. Do not spend time polishing internal comments.

## Bug handling rules

Every reproducible bug discovered during this audit must be handled in one of three ways before PASS:

1. **Fix now** — default for current Jarvis functionality;
2. **Explicitly blocked** — only when a real external dependency/credential/platform limitation prevents a fix;
3. **Out of scope feature request** — only when the finding is genuinely a new capability rather than a bug.

Do not silently leave a reproducible current-feature bug because it was not listed in this taskbook.

For every fixed bug:

- add the smallest deterministic regression test that would have caught it, when practical;
- run the real failure path if unit tests cannot establish correctness;
- avoid unrelated refactor.

Maintain one compact bug ledger during execution, e.g. `docs/P2_2_3_BUG_BASH.md`, containing only:

- ID
- severity
- reproduction
- root cause
- fix commit/file
- verification
- status

Do not paste giant logs into the ledger.

## Severity / stop rules

Treat as release blockers:

- data/state corruption;
- security/credential leakage;
- unauthorized tool execution;
- duplicate Agent/bridge processes;
- permanent Jarvis offline condition under recoverable circumstances;
- Discord command interaction timeout under normal conditions;
- wrong provider/model/workspace actually used relative to displayed state;
- Stop/permission controls not controlling the real process/session;
- user-facing instructions that necessarily lead to failure (e.g. fake runnable placeholders).

Minor cosmetic issues may be fixed only when trivial and adjacent; do not turn this into a design rewrite.

## Verification commands

At minimum, after fixes:

```text
npm test
npm run check
npm run smoke:p2
npm run smoke:p22
npm run smoke:p222
npm run verify:hook
npm run doctor:discord
```

Also run the existing focused smokes relevant to touched areas, including where applicable:

```text
npm run smoke:p22-insert
npm run smoke:p22-model
npm run smoke:p22-workspace
npm run verify:opencode-go
npm run verify:claude-opencode-chat
```

Run the Windows supervisor recovery smoke / equivalent focused checks when runtime/process code is touched or at final stabilization verification.

Do not run expensive real-model tests repeatedly after each tiny edit. Use deterministic focused tests during repair, then one real end-to-end pass near completion.

## Required end-to-end acceptance

Before declaring PASS, prove one clean end-to-end owner workflow on the real machine:

1. Jarvis is ONLINE under the scheduled Supervisor.
2. `/panel` loads without timeout.
3. `/model` → Chat shows AUTO + real selectable providers/models, including a usable path for a many-model provider.
4. Select a real manual Chat model; ordinary `你好` succeeds.
5. `/status` reports the same manual model and effective workspace.
6. Switch Chat back to AUTO; ordinary `你好` succeeds.
7. Start a real small Work task in a Work thread.
8. Insert one live requirement while RUNNING.
9. Stop or let it finish and verify one terminal state.
10. `/doctor` succeeds without model use.
11. Kill Bridge and confirm Supervisor restores it.
12. After recovery, `/status` + ordinary Chat work again.

If the worker cannot impersonate the owner's Discord account, automate everything possible with the real local bridge/provider/runtime and mark only the final owner-click/typing confirmation as owner validation. Do not fabricate human interaction PASS.

## Security / secrets

Never print, commit, snapshot or include in fixtures:

- API keys
- Discord token
- cookies
- session tokens
- passwords
- signed credentials

Use existing credential stores/env and redact logs.

## Non-goals

Do not add:

- P3 finance/market monitoring;
- Longbridge/Futu;
- new provider architecture;
- voice;
- web dashboard;
- Agent swarm as a product feature;
- Redis/Postgres;
- Windows Service/NSSM/PM2/Docker;
- unrelated architecture rewrites.

## Repository deliverables

On completion:

- fix all reproducible in-scope bugs discovered by the audit;
- add/update focused tests;
- create/update `docs/P2_2_3_BUG_BASH.md` as the compact ledger;
- update `docs/CURRENT.md`;
- update `docs/AI_HANDOFF.md` only with information not already obvious from CURRENT;
- update `docs/tasks/CURRENT.md`;
- update relevant smoke evidence;
- commit coherent verified work;
- push to `jarvis-v4-p2-2-hardening`;
- verify remote HEAD.

## Stop condition

Stop immediately when:

- the entire audit matrix has been exercised at the required level;
- every reproducible in-scope bug is fixed or has one explicit unavoidable blocker;
- deterministic regression suite is green;
- one real-machine end-to-end pass is green except owner-only steps that cannot be impersonated;
- no release-blocking finding remains open.

Do not continue into P3, cosmetic redesign or speculative cleanup.

## Final worker response

Return only:

```text
PASS | FAIL
commit: <sha or none>
bugs: <found/fixed/open counts; release blockers open must be explicit>
tests: <compact deterministic + smoke results>
real-e2e: <Chat/Work/Discord/recovery summary>
owner-check: <none or exact remaining owner-only interaction>
blocker: <none or one key blocker>
```
