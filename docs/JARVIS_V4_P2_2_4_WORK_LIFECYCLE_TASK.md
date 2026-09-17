# Jarvis V4 P2.2.4 — Work Lifecycle / Insert / Terminal-State Correctness

## Objective

Fix the remaining Work-run lifecycle bugs exposed by the owner's real Hunyuan3D installation task after P2.2.3.

This task is narrow and release-blocking: a Work must have one truthful lifecycle, one authoritative terminal state, and exact accounting of inserted requirements. The UI must never claim DONE while the same run is still executing, must never erase a completed turn's useful result just because a continuation starts, and must never claim an already-consumed insert is still unprocessed.

Do not start P3 and do not redesign the Agent architecture.

## Read first

Follow the repository read order from `AGENTS.md`, then read:

1. `docs/CURRENT.md`
2. `docs/AI_HANDOFF.md`
3. `docs/tasks/CURRENT.md`
4. `docs/P2_2_3_BUG_BASH.md`
5. this task
6. current branch / HEAD / `git status` / relevant diff

Preserve all P2.2.1–P2.2.3 fixes.

## Real owner reproduction

A real long-running Hunyuan3D Work exposed all of the following:

### L1. Intermediate turn was rendered as final DONE

The Agent returned a large result payload and the Work card changed to `✅ 已完成` around 67–68 minutes.

However an inserted requirement still belonged to the same Work/session, so the control plane then started another turn and the same card resumed executing commands.

Result: the UI said DONE while the Work was not terminal.

### L2. Completed result content disappeared/was overwritten

The Agent's completed turn had already returned useful output/data. When the continuation began, the same mutable progress card was edited back into RUNNING and the previously-visible result effectively disappeared from the owner view.

Result: useful completed-turn output is not durably presented.

### L3. Insert accounting became false

The owner inserted a requirement to change the install path. That requirement was in fact applied successfully during the task.

Later Stop reported:

`已清空 1 条未处理的插入需求。`

That statement was false: the requirement had already affected execution. The runtime bookkeeping kept the delivered insert in `run.injected` until run end/stop instead of transitioning it to a consumed/acknowledged state.

### L4. Stop required repeated interaction / stale terminal controls

The owner had to press Stop multiple times before the task visibly settled.

Observed sequence included:

- first Stop changed card to `已停止`;
- later another Stop message reported the Agent process tree PID and cleared inserts;
- later interaction returned `该任务已结束`.

This indicates stale cards and/or a race between runner shutdown, task finalization, active run cleanup, and control-button validity.

A single valid Stop against the live run must be sufficient and idempotent.

### L5. Terminal state and controls were inconsistent

The card showed `已停止` while the old `插入需求` and `Stop` controls remained visible/clickable. A terminal card must not expose controls that imply a live run still exists.

## Product invariants

### One Work = one lifecycle

A Work may contain multiple Agent turns due to:

- live inserts;
- continuation turns;
- queued follow-ups that are intentionally part of the same Work chain.

But the outer Work must not reach a terminal state until all work belonging to that Work is resolved.

Allowed terminal states:

- DONE
- STOPPED
- FAILED

Exactly one terminal transition per run/Work.

### Intermediate turn != terminal Work

An Agent `result` event ends one Agent turn, not necessarily the Work.

If a continuation remains, render a non-terminal transition such as:

`🟡 阶段完成，继续处理插入需求…`

Never render `✅ 已完成` before the continuation decision has been made.

### Durable result presentation

Completed-turn output must not vanish when the next continuation begins.

Use the lowest-complexity correct UX, preferably:

- keep the mutable progress card for current runtime status;
- send completed-turn textual result as an immutable/normal Discord message (chunked safely if needed);
- final Work summary/card becomes terminal only after all continuation/follow-up work is finished.

Do not create a second parallel control panel.

### Exact insert state machine

Replace ambiguous bookkeeping with explicit states or equivalent semantics.

At minimum distinguish:

- RECEIVED
- DELIVERED_LIVE
- QUEUED_CONTINUATION
- CONSUMED / EXECUTED
- CANCELLED

A delivered live insert must not remain forever counted as "unprocessed".

If exact tool-level consumption cannot be observed from the underlying Claude-compatible protocol, use honest semantics:

- `DELIVERED_LIVE` means delivered into the running Agent stdin/session;
- once the turn completes successfully after delivery, mark it consumed/settled;
- do not later tell the owner it was unprocessed.

For queued continuation, mark executed when that continuation turn actually starts/completes according to the chosen invariant.

### Stop semantics

One valid Stop action on the active run must:

1. atomically mark stop requested;
2. disable further inserts/follow-ups for that run;
3. clear only genuinely pending/unconsumed work;
4. kill the actual Agent process tree once;
5. settle the active task/run exactly once;
6. update progress/parent cards to STOPPED exactly once;
7. remove/disable active controls on terminal cards;
8. make repeated Stop presses idempotent and harmless (`任务已结束` is acceptable after the first successful Stop).

Do not require the owner to press Stop repeatedly to finish cleanup.

## Required code audit

Focus only on the lifecycle path around:

- `#beginRun`
- `#insertRequirement`
- `injectRequirement`
- `run.injected`
- `run.continuations`
- `#appendFollowUp`
- `#drainFollowUps`
- Agent `result` handling
- `runTask` turn loop
- task finalization / `task.finish()`
- `#endRun`
- Stop handler / `#stopWork`
- progress card / parent card terminal rendering
- durable follow-up/insert store records

Do not broadly refactor unrelated Chat/provider/runtime code.

## Required fixes

### F1. Decide continuation before rendering terminal DONE

The control plane must inspect continuation/follow-up state before any terminal DONE transition.

Regression: first turn returns a result while `run.continuations.length > 0` → card never enters DONE between turns.

### F2. Preserve completed turn output

A useful result from turn N must remain visible after turn N+1 starts.

Regression must prove the result message is not overwritten by subsequent progress-card edits.

### F3. Correct live-insert accounting

A live-delivered insert that was accepted and the turn subsequently completes must not be reported as "unprocessed" during Stop/final cleanup.

Regression should reproduce the owner's path:

- run active;
- insert requirement live;
- Agent performs further work / returns result;
- Stop later;
- cleanup count for unprocessed insert = 0.

### F4. Correct continuation accounting

A queued continuation must transition out of pending when actually executed. Durable-store state must match runtime state.

### F5. Single-press Stop

Create a deterministic race test where Stop lands while:

- a tool call is active;
- an insert exists;
- a continuation may be pending.

PASS only if one Stop settles the run and kills the process tree with no second owner action.

### F6. Stale controls fail safely

After STOPPED/DONE/FAILED:

- terminal card contains no active insert/stop controls, or they are disabled/non-actionable;
- stale old button IDs cannot mutate a new run;
- old Stop against ended run returns a short idempotent terminal message.

### F7. Exactly-one terminal state

Add an assertion/event ledger so a run cannot emit DONE then RUNNING, or STOPPED then DONE.

A terminal state is monotonic.

## Required deterministic tests

Add a focused suite (name as appropriate) covering:

1. result + continuation → no intermediate DONE;
2. result message persists while continuation starts;
3. live insert → settled → Stop reports zero unprocessed inserts;
4. queued continuation → executed → no stale pending record;
5. Stop during active tool/insert → one press settles;
6. repeated Stop is idempotent;
7. terminal card has no live controls;
8. stale control from prior run cannot control current run;
9. DONE/STOPPED/FAILED are mutually exclusive and monotonic;
10. no duplicate Agent process/run created by insert/continuation.

## Real-machine smoke

Use the current Windows machine and current working provider/runtime, but keep the smoke small and cheap.

Required real smoke:

1. start one small real Work;
2. while running, live-insert a simple observable requirement;
3. allow first turn boundary / continuation as needed;
4. verify no false intermediate DONE;
5. verify completed-turn result remains visible;
6. verify insert is not later reported unprocessed;
7. run a second small Work and press Stop once while active;
8. verify real process tree is gone and terminal state is STOPPED;
9. verify pressing stale/second Stop cannot affect another/new run.

Do not repeat a 60-minute install task just to test lifecycle logic.

## Regression gates

At minimum:

- `npm test`
- `npm run check`
- `npm run smoke:p2`
- `npm run smoke:p22`
- `npm run smoke:p222`
- `npm run smoke:p22-insert`
- `npm run smoke:p223-full`
- relevant Stop/process-tree tests
- supervisor recovery regression if bridge/process lifecycle code is touched

## Bug ledger / docs

Append this finding as K6 (and split sub-findings if useful) to:

`docs/P2_2_3_BUG_BASH.md`

Update:

- `docs/CURRENT.md`
- `docs/AI_HANDOFF.md`
- `docs/tasks/CURRENT.md`
- focused smoke evidence

Do not duplicate the full taskbook into those files.

## Non-goals

Do not add:

- P3 finance/market features;
- new provider architecture;
- new Agent framework;
- web dashboard;
- database redesign;
- generic tool timeout system;
- speculative UI redesign.

This task is only lifecycle correctness for existing Work/insert/Stop behavior.

## Acceptance

PASS only if all are true:

- no intermediate DONE before the Work is truly terminal;
- completed result content never disappears because a continuation starts;
- successful live insert is not later counted as unprocessed;
- queued continuation state is consumed correctly;
- one Stop is sufficient;
- terminal controls cannot mutate ended runs;
- exactly one terminal state per Work;
- real Agent process tree is actually stopped;
- regression suite green;
- real small Work smoke green;
- commit + push + remote HEAD verified.

## Final worker response

Return only:

```text
PASS | FAIL
commit: <sha or none>
work-lifecycle: <intermediate/final-state result>
insert-accounting: <live/continuation state result>
stop: <single-press/process-tree/idempotency result>
tests: <compact regression + real smoke>
blocker: <none or key blocker>
```
