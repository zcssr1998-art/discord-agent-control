# Jarvis V4 P1 — Work isolation, workspace queue, settings UX

## Mission

Build the next usability/safety layer on top of the already-merged V4 P0/P0.5 baseline.

Repository: `zcssr1998-art/discord-agent-control`
Branch: `jarvis-v4-p1-workflow`
Base: latest `main` after PR #2 merge (`db405b9...`)

P0/P0.5 is a stable baseline. Do **not** redesign Chat/LiteLLM/fallback/approval-hook unless a P1 change exposes a real regression.

Real user goal:

- ordinary Discord conversation stays fast Chat;
- a Work task gets its own isolated place when Discord supports threads;
- two Jarvis Work tasks must never write the same workspace concurrently;
- different workspaces may run in parallel;
- common settings should be understandable from Discord without memorizing many commands;
- preserve the existing real `!stop` process-tree kill, permissions, billing safety, provider/model separation and concise reporting.

Priority order:

1. workspace serialization / queue (safety)
2. Work-thread UX (clean separation)
3. settings UX (convenience)

## Read first

1. `AGENTS.md`
2. `docs/CURRENT.md`
3. `docs/AI_HANDOFF.md`
4. `docs/V4_SMOKE.md`
5. this file
6. only then the relevant implementation files

Minimum likely files:

- `src/discord-ui.mjs`
- `src/session-manager.mjs`
- `src/state.mjs`
- `src/executor-manager.mjs`
- `tests/helpers/fake-discord.mjs`
- existing Discord/control-plane tests

Do not re-scan the whole repo unless a concrete dependency requires it.

## Research already done — reuse patterns, do not copy whole projects

Useful public references:

- `atou42/agents-in-discord`
  - workspace serialization / lock patterns
  - per-channel/session settings patterns
  - queue/busy runtime behavior
- `adam-paterson/codex-opencode-notifier`
  - Discord/agent notification flow
- `comeran/discord-codex-bridge`
  - Discord work/session patterns

Important lesson from `agents-in-discord`: workspace-bound sessions need serialization; settings/session state should remain channel/thread scoped. Reuse concepts only. Do not vendor another bot framework into Jarvis.

# P1A — WorkspaceScheduler: one writable workspace, one active task

## Required behavior

Introduce the smallest dedicated scheduler/lock abstraction needed to keep workspace concurrency out of `DiscordControlPlane`.

Recommended shape (names may change if a cleaner fit exists):

```text
WorkspaceScheduler
  canonicalKey(cwd)
  submit({ workspace, channelId, run, onQueued? })
  cancelQueued(channelId)
  snapshot(workspace?)
  release(...)
```

Do not build a generic distributed job system.

### Workspace identity

Two paths referring to the same Windows workspace must map to the same key.

Preferred normalization:

1. `path.resolve(cwd)`
2. where safely available, resolve the real path (`fs.realpathSync.native` or equivalent)
3. normalize trailing separators
4. on Windows, compare case-insensitively

Do not recursively inspect the workspace just to lock it.

### Scheduling rules

- At most **one active Jarvis Work task per canonical workspace**.
- A second task for the same workspace enters a FIFO queue instead of starting an Agent.
- Work on a different workspace may run concurrently.
- The lock is acquired before the Agent begins meaningful work and released in `finally` on every exit path:
  - success
  - model/backend error
  - timeout
  - `!stop`
  - runner startup failure
- Releasing a workspace starts the next queued item exactly once.
- A queued item must not create an Agent/runner until it actually reaches the front and acquires the workspace.
- `!stop` on an active task keeps the existing process-tree kill semantics and releases the lock after the task is actually stopped.
- `!stop` on a channel/thread that is queued but not active removes that queued item and reports cancellation; it must not affect the active owner.
- Queue state is in-memory for P1. Do not add SQLite/Redis/lock daemons. A bridge restart may drop queued-but-not-started items; active Agent processes already do not survive a bridge restart cleanly, so persistence would add complexity without real recovery value.
- The lock covers **Jarvis-managed Work** only. Do not pretend it can serialize unrelated external editors/terminals.

### User-facing queue feedback

When queued, reply concisely with:

```text
⏳ Workspace busy: D:\project
Queue position: 2
Active task: <thread/channel short label>
```

When the item starts, edit or reply once with `▶️ started` and continue normal progress reporting. Do not spam periodic queue updates.

`!status` should show Work state as one of:

```text
idle / running / queued (#N)
```

and, when relevant, the canonical/current workspace.

## P1A tests

Add deterministic tests proving:

1. same canonical workspace never runs two callbacks concurrently;
2. `D:\Repo` and equivalent case/trailing-separator forms collide on Windows semantics;
3. different workspaces can run concurrently;
4. FIFO order for same workspace;
5. success releases and starts next;
6. failure releases and starts next;
7. active `!stop` releases only after stop path;
8. queued `!stop` removes only that queued request and never starts an Agent;
9. no queued request creates a runner before lock acquisition.

# P1B — Work threads

## Reality constraint: Discord DMs do not support threads

Jarvis is currently used heavily through bot DMs. Do not design a feature that breaks DM Work just to satisfy a thread abstraction.

Therefore:

- **thread-capable guild text channel:** `work <task>` creates a dedicated Discord thread;
- **DM / non-thread-capable channel:** preserve the existing inline/current-channel Work behavior;
- thread support must be an enhancement, not a requirement for Work.

Do not attempt self-bots, fake DM threads, or auto-create guilds/channels.

## Guild parent-channel behavior

When the parent channel is currently Chat and receives:

```text
work <task>
```

and the channel supports thread creation:

1. parent channel **remains Chat**;
2. create one thread with a short sanitized task-derived title (Discord length limits respected);
3. initialize the thread as a **permanent Work context**;
4. copy/snapshot the parent's current Work defaults into the new thread:
   - cwd/workspace
   - executor
   - provider
   - model
   - permission level (or STANDARD if inheritance is unsafe; choose one behavior and test/document it)
5. start `<task>` inside that thread;
6. parent gets one concise link/confirmation to the new Work thread;
7. subsequent ordinary messages in the thread continue the same Agent session;
8. parent continues ordinary Chat while Work is running.

Do not create nested Work threads from inside an existing Work thread.

### Permanent Work semantics inside a Work thread

A created Work thread is Work-scoped. `chat`, `/chat`, or `!chat` inside it must not silently turn the thread into Chat.

Reply with a concise explanation such as:

```text
This is a Work thread. Use the parent channel for Chat.
```

Existing `!reset` may reset the Agent session, but the thread remains Work.

### Existing behavior compatibility

- bare `work` in a normal channel may keep the current explicit mode-switch behavior;
- inline `work <task>` only gets the new thread-first behavior when the current channel supports threads and is not already a Work thread;
- DM behavior must keep working exactly enough that the current V4 real smoke can still be repeated;
- if thread creation fails because of Discord permission/API error, fail clearly and **do not lose/start the task in an unexpected place**. Do not silently turn the parent Chat channel into Work.

### State

Persist only the minimum metadata needed for deterministic behavior/restart:

```text
workThread: true
parentChannelId: <id>
mode: work
```

Use the existing channel/thread ID as the primary session key. Do not add a second session database.

## P1B tests

Extend `FakeDiscord` only as much as needed to model a thread-capable parent and a thread channel.

Prove:

1. `work <task>` in thread-capable Chat parent creates exactly one thread;
2. parent stays Chat;
3. thread is Work and receives the task;
4. thread gets its own runner/session key;
5. second ordinary message in thread resumes/reuses that session path rather than creating a parent Agent;
6. parent can Chat while the thread task is active;
7. `chat` inside Work thread does not change it to Chat;
8. no nested thread from a Work thread;
9. DM `work <task>` remains supported without thread creation;
10. thread-create failure does not execute the task in the parent by accident.

# P1C — Settings/status UX (minimum useful version)

Do not build a dashboard. Keep existing text commands as a stable fallback.

Add a compact `!settings` Discord panel that reuses the same state mutation logic as existing commands instead of implementing a second configuration system.

Minimum panel:

```text
Jarvis Settings

CHAT
Route: AUTO / pinned provider+model
Last actual: ...

WORK
Executor: ...
Provider: ...
Model: ...
Workspace: ...
Permission: ...
State: idle/running/queued
```

Interactive controls should cover only high-value actions that are safe and fit Discord component limits:

- reset Chat route to AUTO;
- choose/switch Work executor from discovered executors;
- choose Work provider from available compatible providers;
- choose Work model when the option count fits safely; if too many, keep the existing text command instead of building pagination in P1;
- permission button/menu (reuse existing permission logic);
- refresh/status action.

Workspace path editing may remain `!cwd <absolute-path>` in P1. Do not add a modal merely for completeness.

Rules:

- settings interactions are local/deterministic and must not invoke any LLM/Agent;
- changing executor/provider/model while a Work task is running must continue to fail safely using existing `SessionManager.change` semantics;
- inside a permanent Work thread, do not offer a control that flips mode to Chat;
- do not show secrets, raw provider credentials or verbose gateway diagnostics.

## P1C tests

Prove at minimum:

1. `!settings` renders current Chat + Work state;
2. UI mutation updates the same persisted state as the corresponding command;
3. settings actions do not create runners or call ChatRuntime;
4. running-task safety is preserved;
5. Work-thread mode cannot be flipped to Chat through settings;
6. queue state appears correctly.

# Integration rules

## Keep these P0/P0.5 invariants

Must not regress:

- default mode = Chat;
- ordinary Chat never starts an Agent;
- LiteLLM primary route + direct OpenCode Go fallback;
- fallback attribution/cooldown;
- manual Chat pin never silently falls back;
- Work permissions/approval fail closed;
- `!stop` real Windows process-tree kill;
- hook ownership marker / no stale-secret 401;
- AUTO never silently spends on METERED/UNKNOWN billing.

## Concurrency ownership

Do not put workspace locking into LiteLLM or provider routing. It belongs to the Work orchestration layer.

Do not use the Discord channel's busy flag as the workspace lock: two different threads/channels can target the same `cwd`.

Do not use the filesystem `.git/index.lock` as a scheduler. Git locks are not a task-level concurrency contract.

## No unnecessary infrastructure

Do not add:

- SQLite solely for the queue;
- Redis/Postgres;
- a second bot process;
- a new routing framework;
- a generic distributed scheduler;
- multi-agent teams;
- RAG/vector DB;
- P2 attachments/history in this PR.

# Recommended implementation order

Use small coherent commits:

1. `feat(p1): add workspace scheduler and queue tests`
2. `feat(p1): add thread-scoped work sessions`
3. `feat(p1): add compact settings panel`
4. `test(p1): real smoke fixes and evidence`
5. `docs(p1): update current handoff and evidence`

Do not wait until the end to test all three layers together.

# Verification

At every logical stage:

```text
npm test
npm run check
```

Run targeted tests during implementation; run full tests before every milestone commit.

## Real smoke — minimum

### DM regression (required on current machine)

1. ordinary `你好` -> Chat, no Agent child;
2. DM `work <disposable task>` still runs real Work;
3. `!stop` still kills the real child tree;
4. `chat` returns to Chat;
5. fallback route still works if touched by P1 changes.

### Workspace queue (required)

Use two independent channel/thread test contexts targeting the same disposable workspace:

- first holds a safe Work task active;
- second becomes queued and does not start a child;
- stop/finish first;
- second starts exactly once;
- repeat with different workspaces and confirm they can overlap.

If the available real Discord environment cannot provide two suitable contexts, deterministic tests are the hard gate and record `PENDING_REAL_MULTI_CHANNEL_SMOKE` rather than faking evidence.

### Guild thread smoke (conditional on an available thread-capable guild channel)

If a real guild channel is available:

- `work <task>` creates a thread;
- parent remains Chat;
- thread remains Work and continues session;
- parent Chat works while thread Work runs.

If not available, record `PENDING_REAL_GUILD_THREAD_SMOKE`. Do **not** block the DM-safe implementation or invent a fake real-world PASS.

# Acceptance gate

P1 is PASS only when:

- same workspace cannot execute two Jarvis Work tasks concurrently;
- FIFO queue/cancel/release behavior is deterministic;
- different workspaces can run concurrently;
- thread-capable parents isolate inline Work into a Work thread without changing parent Chat;
- DM Work remains functional;
- permanent Work threads cannot accidentally become Chat;
- `!stop` still kills the correct active process tree and releases scheduling state;
- `!settings` is useful without duplicating config logic;
- `npm test` + `npm run check` pass;
- P0/P0.5 Chat/LiteLLM/fallback smoke does not regress;
- detailed evidence is written to repo docs, not dumped into chat.

# Completion / reporting

Update:

- `docs/CURRENT.md`
- `docs/AI_HANDOFF.md`
- `docs/tasks/CURRENT.md`
- create/update `docs/V4_P1_SMOKE.md` with real evidence and any explicitly pending human/environment smoke

Commit and push to `jarvis-v4-p1-workflow`.

Final Worker chat response only:

```text
PASS | FAIL
commit: <sha>
tests: <summary>
real-smoke: <summary>
blocker: <none or one key blocker>
```

Do not merge `main`. Open/update a P1 PR and leave it unmerged for final review.