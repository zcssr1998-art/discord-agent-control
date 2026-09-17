# Jarvis V4 P3.0 — Remove Arbitrary User-Facing Time Limits

## Goal

Eliminate arbitrary elapsed-time limits that can make valid Chat/Work/Agent/result-delivery flows fail merely because they took longer than an internal timer.

The product rule after this task is:

> Long-running work is allowed to keep running as long as it is making progress or is still recoverable. A timer alone must not turn valid work into a failed task or discard a completed result.

This task is a priority preflight blocker before continuing `JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`.

## Why

A real Discord run produced:

```text
Connect Timeout Error (...:443, timeout: 10000ms)
完整结果投递失败
完整内容未能写入运行日志
```

This exposed a broader UX problem: fixed time limits exist in multiple layers, and the owner repeatedly encounters unrelated operations failing because an internal timeout fired.

Do not patch only the observed `10000ms` value. Audit the user-visible execution path and establish one coherent timeout policy.

## Non-negotiable product semantics

### 1. No total-duration timeout for Work

- Work tasks must not be killed, failed, cancelled, or marked errored merely because total elapsed wall-clock time exceeded a fixed duration.
- Preserve the already-intended unlimited Work duration behavior.
- Long installs, model downloads, builds, inference, package resolution, coding-agent reasoning and smoke tests may run for hours if they are still alive/recoverable.
- Owner `Stop` / cancellation remains authoritative and immediate.

### 2. No total-response timeout for model/Agent output

- Do not impose a fixed total wall-clock timeout such as 30s / 60s / 5m on an otherwise active model or Agent stream.
- If a stream is still producing bytes/events/progress, it must remain alive.
- A true stalled connection may still be detected by an inactivity/progress watchdog, but that is not the same as a total-duration limit.
- Any stall recovery must preserve resumable session/job state where supported.

### 3. Discord delivery timeout must never become task failure

A low-level TCP/HTTP connection attempt may still have an internal connect deadline so a dead socket cannot hang forever. However:

- a single connect timeout (including the observed 10s timeout) must not mark the completed Work as failed;
- a single Discord send timeout must not lose the full result;
- the full result must be durably persisted before network delivery is attempted;
- delivery failure is a transport state, separate from Worker execution state;
- retry with bounded per-attempt backoff;
- after retry attempts are exhausted, keep the message/result in a recoverable `PENDING_DELIVERY`/outbox state rather than failing or rerunning the Work;
- when connectivity returns, retry delivery without rerunning the original Work;
- delivery must be idempotent enough to avoid duplicate full-result spam after ambiguous retries.

### 4. Chat/command UX must acknowledge quickly, then continue asynchronously

Do not fight hard external protocol deadlines.

Examples:
- Discord interaction ACK/defer deadlines are protocol requirements and must remain satisfied;
- connection establishment, DNS, TLS handshake and similar low-level operations may retain per-attempt safety deadlines.

The correct pattern is:

```text
fast ACK/defer
  -> durable local state
  -> long-running operation with no arbitrary total duration cap
  -> delivery/retry state machine
```

Protocol-required timers must not be exposed to the user as an artificial limit on the actual task.

### 5. Distinguish four timer classes

Audit every relevant timer/timeout in Chat/Work/result-delivery paths and classify it as exactly one of:

1. `PROTOCOL_REQUIRED` — external protocol deadline (keep, handle correctly).
2. `PER_ATTEMPT_SAFETY` — prevents one socket/subprocess attempt from hanging forever (keep only if recovery exists).
3. `STALL_WATCHDOG` — no-progress detection based on inactivity/progress, not total elapsed time (allowed, must be recoverable where safe).
4. `ARBITRARY_TOTAL_LIMIT` — fixed total duration that fails otherwise valid work (remove from user-facing execution paths).

Do not blindly delete every `setTimeout()` in the repository. Remove the bad semantics, not necessary safety controls.

## Required audit scope

Inspect only code involved in the following paths; do not rescan/rewrite the whole repository:

- Discord REST send / reply / edit / full-result delivery;
- Discord interaction ACK/defer path;
- Work lifecycle / Agent runner / subprocess execution;
- result persistence / run log / full-result storage;
- Chat runtime/provider calls;
- OpenCode Go / Claude-compatible transport wrappers used by Work;
- watchdog / runaway protection;
- retry/backoff helpers;
- any config/env values that expose execution timeout, request timeout, result timeout, idle timeout or network timeout.

For each discovered timeout, record a compact audit table in the task completion evidence or a small repository doc if useful:

```text
location | current value | class | final behavior
```

No giant dump is needed.

## Required implementation behavior

### A. Completed result durability

Use or extend the existing state/log system. Do not introduce a database unless already necessary.

Before first Discord send attempt:

1. persist the full result locally;
2. persist Work terminal execution state independently from delivery state;
3. create/update a delivery record/outbox entry;
4. attempt Discord delivery.

Required state separation:

```text
workExecutionState: RUNNING | SUCCEEDED | FAILED | CANCELLED
resultDeliveryState: NOT_READY | PENDING | DELIVERED | DEGRADED
```

Exact names may follow current conventions.

Never convert `SUCCEEDED + PENDING` into `FAILED` just because Discord is temporarily unreachable.

### B. Network retry policy

- Retain a reasonable per-attempt connection deadline if required by the HTTP client.
- Do not solve this by setting a gigantic magic number such as 10 minutes or 24 hours.
- Prefer retry/backoff + durable pending state.
- Retry only safe/idempotent delivery operations or protect ambiguous sends with dedupe/idempotency logic.
- Avoid an infinite tight retry loop.
- Network outage must not burn model tokens.

### C. Progress-aware long-running operations

Where a watchdog exists:

- total elapsed duration alone is not failure evidence;
- update progress on meaningful events/output/state changes;
- repeated identical failure with no new evidence may be treated as stagnation;
- silent but valid long phases must not be killed solely because an arbitrary wall-clock timer elapsed unless the underlying tool/protocol has a documented hard requirement;
- existing runaway protection for truly pathological loops may remain, but document why it is not an arbitrary time limit.

### D. Configuration cleanup

- Remove/deprecate user-facing settings whose only purpose is to cap total Work duration.
- If legacy env/config keys must remain for compatibility, make unlimited/default semantics explicit and ensure old defaults cannot silently reintroduce the problem.
- Do not add more timeout knobs as a workaround.

### E. Status / diagnostics

Expose enough compact status to distinguish:

```text
Work: SUCCEEDED
Discord delivery: PENDING (network timeout; retry scheduled)
```

from:

```text
Work: FAILED
```

Do not flood Discord with retry messages.

## Explicit non-goals

- Do not remove mandatory Discord protocol ACK/defer timing behavior.
- Do not make dead TCP sockets hang forever.
- Do not disable owner Stop/cancel.
- Do not remove all runaway/stagnation protection.
- Do not change model/provider routing architecture.
- Do not add Redis/Postgres/queues-as-a-service/new daemon frameworks.
- Do not continue P3 AI TechLead implementation until this preflight task passes.

## Acceptance criteria

### Deterministic tests

Add focused tests covering at minimum:

1. **Long Work is not failed by elapsed duration**
   - simulate/drive a Work beyond any former arbitrary duration boundary;
   - verify no timer-only failure/cancel occurs.

2. **Active stream survives**
   - simulate a long-running stream with periodic progress/events;
   - verify it is not terminated by total duration.

3. **Discord connect timeout does not lose result**
   - force a send/connect timeout equivalent to the observed `10000ms` failure;
   - verify full result is already persisted;
   - Work remains `SUCCEEDED` if execution succeeded;
   - delivery becomes pending/degraded, not execution failed.

4. **Retry succeeds without rerunning Work**
   - first delivery attempt times out;
   - later retry succeeds;
   - Worker/Agent execution count remains exactly one;
   - user receives the full result once.

5. **Repeated delivery failure is bounded**
   - no infinite hot loop;
   - no model calls/token usage caused by transport retry;
   - recoverable pending state remains.

6. **Protocol deadline preserved**
   - Discord interaction still ACKs/defers within required protocol behavior.

7. **Stop remains authoritative**
   - owner stop still terminates an active Work correctly.

8. **Regression gates**
   - existing P2 lifecycle, insert, full-result, stop, updater, supervisor/bridge and permission tests remain green.

### Real-machine smoke

On the real Windows/Discord setup:

- run a normal Chat;
- run a Work that lasts long enough to prove no short total timeout is active;
- verify full result delivery;
- where practical, simulate or induce one Discord delivery failure/retry without rerunning Work;
- verify `!status`/relevant status reports execution vs delivery state truthfully;
- verify one Supervisor + one Bridge and no duplicate daemon/process.

If intentionally inducing a network failure is unsafe/unreliable, provide deterministic injected-failure evidence and one normal real Discord full-result run.

## Completion gate

Do not declare PASS by code inspection.

Required:

- focused new tests pass;
- `npm test` passes;
- `npm run check` passes;
- relevant existing P2 smoke/regression suites pass;
- real-machine smoke passes or has one explicit unavoidable external blocker;
- timeout audit has no remaining `ARBITRARY_TOTAL_LIMIT` in the user-facing Chat/Work/result-delivery path.

## After completion

Once this task passes:

1. update `docs/tasks/CURRENT.md` back to `JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`;
2. preserve this task as completed evidence;
3. continue P3 TechLead Shadow Mode from the same feature branch;
4. do not redo the timeout audit unless later code changes reintroduce one.

## Worker final report

```text
PASS | FAIL
commit: <sha or none>
tests: <compact result>
timeout-audit: <remaining arbitrary total limits: 0 | list blocker>
real-smoke: <PASS | PENDING + reason>
blocker: <none or one key blocker>
```
