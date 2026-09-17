# P2.2.3 Blocking Addendum — Codex-style permission + long-run semantics

This addendum is mandatory for the active repository stabilization task. It records two owner-reproduced release blockers discovered during the first P2.2.3 real Work run.

Do not treat these as optional follow-ups. Fold the fixes and regression evidence into the main P2.2.3 bug ledger before PASS.

## K4 — FULL permission is not actually full

### Owner reproduction

The parent Discord channel showed:

`当前权限：全开放`

A Work thread was then created from that parent. During the run, the Agent repeatedly requested approval for Bash calls such as repository discovery, Git config/credential inspection and environment inspection, with reasons including:

- `unclassified shell command`
- `sensitive file access`

This contradicts the UI and owner intent.

### Confirmed root causes in current code

There are at least two independent defects.

1. `src/policy.mjs` performs sensitive-path / sensitive-shell approval checks **before** the `permissionLevel === 'full'` allow branch. Therefore FULL can still return `ask` for sensitive-file/system/credential classified calls.

2. Work-thread permission inheritance uses:

`permissionManager.switchLevel(thread.id, parentLevel)`

When `parentLevel === full`, `switchLevel()` intentionally returns `needsConfirm=true` instead of applying FULL. The result is ignored by thread creation, so a child Work thread silently falls back to the default `standard` tier even though the parent UI says FULL.

This is a release blocker: displayed permission and actual execution policy diverge.

## Required permission semantics

Adopt a simple Codex-style policy model: the user-selected permission mode is the execution policy, not a hint.

### STRICT

Ask for risky writes/shell/network according to the existing restrictive policy.

### STANDARD

Keep the existing normal safe-workspace behavior where practical.

### RELAXED

Allow ordinary local development actions; retain approval for genuinely destructive/irreversible actions where current semantics already do so.

### FULL / 全开放

FULL means **no routine approval prompts** for normal Agent tool execution.

When FULL is active, automatically allow:

- reads/writes inside and outside the selected workspace;
- ordinary Bash/Shell/PowerShell;
- network/tool installation commands;
- system/config inspection;
- files classified as sensitive by path name;
- MCP/tool calls that are otherwise only gated because they are unknown/unclassified.

Do not ask again merely because a command is `unclassified`, accesses `.config`, Git config, environment variables, or another path that the heuristic calls sensitive.

Keep only deterministic hard safety guards that must never be bypassed, especially:

- do not commit/print/store actual API keys, tokens, passwords, cookies or private credentials;
- existing secret-leak / secret-commit fail-closed protections may remain hard-deny guards;
- destructive actions still need to obey any explicit product-level hard safety rule that is independent of approval UI.

The key invariant is:

`FULL UI state == actual no-prompt execution policy`, except explicit hard-deny safety guards.

### Permission inheritance / persistence

- A Work thread created from a parent channel must inherit the parent's effective permission level exactly, including FULL.
- Internal inheritance must not run through a UI confirmation path that rejects FULL. Add a trusted/internal inherit/set method or persist the level and copy it directly.
- The UI confirmation is required when the owner manually switches into FULL; it is **not** required again when creating a child thread from an already-confirmed FULL parent.
- Session binding must retain the thread's effective permission for the whole run.
- `/status`, `/settings`, progress cards and approval-hook policy must all report/use the same effective level.
- If permission persistence already exists or is added, restart semantics must be explicit and tested. Do not silently show FULL while executing STANDARD.

## Required K4 tests

Add deterministic regression coverage proving at minimum:

1. parent FULL → new Work thread FULL, not STANDARD;
2. FULL + ordinary unclassified Bash → allow, no approval;
3. FULL + path classified `sensitive file access` → allow without interactive approval, while secret redaction/hard-deny protections remain intact;
4. STANDARD still asks for a representative command that should be gated;
5. owner FULL confirmation still cannot be bypassed through the user-facing control;
6. child thread inheritance does not ask for a second FULL confirmation;
7. live Work under FULL can execute a representative multi-step repo task without repeated approval cards.

Use safe commands/fixtures; never dump real credentials into test logs.

---

## K5 — 15-minute hard task timeout is invalid product behavior

### Owner reproduction

A real Work task ran for `15分01秒`, then Jarvis reported:

`task exceeded 900s and was stopped`

The task was forcibly terminated despite still doing legitimate repository investigation/work.

### Confirmed root cause in current code

`src/config.mjs` currently defines:

`taskTimeoutMs: int('TASK_TIMEOUT_MS', 900000)`

and labels it a hard wall-clock cap.

`src/discord-ui.mjs` wraps each Agent turn in:

`withTimeout(runner.send(...), this.config.taskTimeoutMs, ...)`

and on timeout explicitly kills the Agent process.

So the 15-minute stop is intentional current code, not a provider limitation.

## Required long-run semantics

Remove the arbitrary production wall-clock kill.

Use Codex-style long-running task behavior:

- a healthy Agent may continue as long as needed;
- duration alone is **not** a failure condition;
- the owner stops work explicitly through `Stop` / `!stop`;
- child process exit/failure remains a real failure;
- bridge shutdown still cleans up its children;
- supervisor/bridge recovery rules remain intact;
- heartbeat/stall visibility remains, but observation must not equal forced termination.

### Configuration

Production default must be **no hard task duration limit**.

Recommended compatibility semantics:

- `TASK_TIMEOUT_MS=0` or unset => unlimited;
- an explicit positive value may remain as an opt-in operator limit for testing/special deployments;
- code must not pass `0` into a timeout helper that fires immediately; branch explicitly between unlimited and timed execution.

Do not replace 15 minutes with another arbitrary default such as 30/60/120 minutes.

### Stall / hung-process handling

Keep `STALL_NOTICE_MS` only as observability unless deterministic evidence proves the child is dead.

A silent but alive model/tool call can legitimately take a long time. Therefore:

- show heartbeat / last-event age;
- optionally expose `可能较久，仍在运行`;
- do not kill solely for inactivity;
- rely on explicit Stop, actual process exit, broken pipe, unrecoverable runtime failure, or an explicitly configured positive operator timeout.

## Required K5 tests

Add regression coverage proving:

1. default production config has no hard Work wall-clock limit;
2. a simulated task lasting beyond 900s logical/test time is not auto-killed under default settings;
3. explicit positive `TASK_TIMEOUT_MS` still works as an opt-in limit if retained;
4. Stop still kills the real process tree promptly;
5. stall notices/heartbeat do not terminate the task;
6. long-running task status remains RUNNING rather than TIMEOUT until owner stop/result/process failure.

Use fake timers or a controlled fake runner; do not waste 15 real minutes on deterministic tests.

---

## Integration into P2.2.3

These defects must be added to `docs/P2_2_3_BUG_BASH.md` with reproduction, root cause, fix and verification.

P2.2.3 cannot PASS until K4 and K5 are fixed and the real-machine Work E2E includes:

1. set parent permission to FULL once;
2. start a new Work thread;
3. verify the thread/status/progress all show FULL;
4. run a representative multi-step repo task with no routine approval prompts;
5. verify it can remain alive beyond the old 900-second boundary (deterministic fake-time evidence is acceptable for the duration boundary; real task need not be deliberately kept open 15 minutes);
6. owner Stop still terminates it correctly;
7. no secret is printed or committed.

Do not redesign the whole permission system if a small trusted-inheritance path + policy ordering fix is sufficient. Do not add a new daemon, sandbox framework or unrelated feature.
