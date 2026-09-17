# Jarvis V4 P3 — AI TechLead Shadow Mode

## Goal

Add a low-token, event-driven AI technical lead to Jarvis Work mode. The TechLead watches a Work task at key checkpoints, detects likely stagnation or risky divergence, and recommends a corrective action. P3 is **Shadow Mode only**: it must never automatically change files, run shell commands, stop a Worker, pause a Worker, or inject requirements into the active Worker.

The intended production behavior after Shadow validation is:

`Work -> Worker executes -> local deterministic monitor -> incident -> AI TechLead wakes -> CONTINUE / INJECT / PAUSE_REPLAN / ASK_OWNER`

P3 builds and validates the observation/review path while preserving existing P2 behavior.

## Why now

P2 is complete and merged. Jarvis already owns Work lifecycle, persistent sessions, approvals, cancellation, watchdog/runaway protection, truthful insert accounting, and process recovery. Do not create another orchestration framework. Extend the existing control plane with a small sidecar-style review subsystem.

The AI TechLead is distinct from the existing process Supervisor:

- existing Supervisor: keeps Jarvis/Bridge alive;
- AI TechLead: evaluates Worker progress and technical direction.

Use the name `TechLead` in new code/docs to avoid collision with the existing process Supervisor.

## Core design principles

1. **Zero-token standby.** No polling model call. If nothing interesting happens, the TechLead sleeps.
2. **One Worker remains authoritative.** The TechLead must not become a second coding Agent.
3. **Deterministic checks first.** Tests, exit codes, lifecycle state, repeated failures, timeouts, diff scope, process state and hard safety limits are handled locally.
4. **Model only for judgment.** Wake the TechLead only when a compact incident requires reasoning.
5. **Delta, not replay.** Never feed full logs or whole session history by default.
6. **Fail open in Shadow Mode.** TechLead/provider failure must never block a Work task.
7. **No silent paid fallback.** Reuse Jarvis billing safety. A TechLead route must not silently move to METERED/unknown billing.
8. **Preserve P2.** No rewrite of ExecutorManager, runner/session lifecycle, approval hook, cancellation, Work insert accounting, updater or process Supervisor.

## Provider / model policy

Use the existing model/provider infrastructure and OpenCode Go route where compatible.

Default desired reviewer model: **Grok 4.6** from the user's OpenCode Go model library.

Implementation rules:

- do not hardcode an assumed remote model ID if the existing discovery layer can resolve it;
- expose a logical TechLead model selection/config value;
- persist/report the actual provider/model used;
- if Grok 4.6 is unavailable, mark TechLead `DEGRADED` and continue the Work task;
- do not silently spend through a metered fallback;
- keep the TechLead model independent from the Worker's selected Agent/model.

## Runtime architecture

Add the minimum required modules; exact filenames may be adjusted to match current repository conventions.

Suggested shape:

```text
src/techlead/
  techlead-controller.mjs
  work-contract.mjs
  progress-fingerprint.mjs
  incident-detector.mjs
  incident-deduper.mjs
  incident-packet.mjs
  techlead-reviewer.mjs
```

Do not introduce LangGraph, AutoGen, CrewAI, Redis, Postgres, Kubernetes, a second daemon, or another routing framework.

### Internal event boundary

Do not make TechLead depend directly on one OpenCode hook API.

Define a small normalized internal `WorkEvent` representation sourced from existing Jarvis Work lifecycle/runner signals. Use OpenCode structured events/hooks only as an enrichment path.

Representative event types:

```text
WORK_STARTED
WORK_PHASE_CHANGED
TOOL_STARTED
TOOL_FINISHED
COMMAND_FAILED
COMMAND_SUCCEEDED
TEST_RESULT
FILE_CHANGED
WORKER_MESSAGE
WORKER_PLAN_CHANGED
WORK_COMPLETED
WORK_FAILED
WORK_STOPPED
```

Only add event types that are actually available or cheaply derivable from current code. Do not build a speculative event bus larger than P3 needs.

### OpenCode capability probe

OpenCode plugin/hook event names have changed across versions, so do not assume hook compatibility.

At startup or TechLead initialization:

1. detect whether the expected structured event integration is available;
2. run a safe capability/probe path where practical;
3. report `FULL`, `PARTIAL`, or `DEGRADED` event visibility;
4. fall back to Jarvis-owned lifecycle/runner signals when OpenCode-specific events are unavailable;
5. never let hook failure break Work execution.

The probe itself must not perform destructive or external side effects.

## Work Contract

Every Work gets a compact machine-readable contract used by TechLead.

The contract should be derived from the user Work request / repository task specification and contain only high-information fields, for example:

```json
{
  "objective": "...",
  "constraints": ["..."],
  "acceptance": ["..."],
  "do_not": ["..."],
  "risk": "low|medium|high",
  "watch": ["..."],
  "owner_required": ["..."]
}
```

Do not copy the global rulebook or full repository history into this object.

### Startup review

On each explicit Work start, TechLead may perform **at most one startup review call**.

Input should be:

- compact stable TechLead policy;
- Work Contract;
- minimal project/runtime metadata actually needed.

The startup review returns a compact watch profile / missing-risk note. It must not re-plan the whole task and must not create a second implementation plan.

If TechLead is unavailable, Work proceeds normally.

## Progress Fingerprint

Maintain a compact progress fingerprint from cheap/local state. Use only fields that can be obtained reliably.

Candidate fields:

```text
changed_files / diff_stat hash
last meaningful file-change time
last successful action
last error signature
same-error count
same-action count
test pass/fail state
worker phase / lifecycle state
artifact/output existence when known
process state
```

The fingerprint exists to answer one question: **did the task materially progress since the previous incident window?**

Do not recursively scan large workspaces just to compute the fingerprint. Reuse existing events/state and cheap targeted Git queries.

## Incident detection

Do not wake TechLead merely because an action repeats.

A stagnation incident should generally require a combination such as:

`repeated action + same failure signature + no new evidence + no meaningful progress`

Initial incident classes:

### 1. STAGNATION

Examples:

- same command/action repeatedly fails with the same normalized error;
- progress fingerprint remains materially unchanged;
- Worker keeps retrying without collecting new evidence.

### 2. PLAN_THRASH

Worker repeatedly flips between approaches without new evidence or measurable progress.

### 3. SCOPE_DRIFT

Changed files/actions materially leave the expected task scope when scope can be established reliably.

Do not flag ordinary adjacent fixes that are required for acceptance.

### 4. RISKY_NEXT_ACTION

Worker announces/intends a materially destructive or high-blast-radius action such as broad environment reset/reinstall, destructive Git operation, large deletion, credential/auth change, or equivalent.

Existing approval/safety controls remain authoritative. TechLead is advisory in P3.

### 5. REPEATED_TEST_FAILURE

Same deterministic acceptance/test failure repeats after repair attempts with no new evidence.

### 6. COMPLETION_REVIEW_NEEDED

Only when acceptance contains subjective/high-risk judgment that deterministic verification cannot establish. Do **not** call TechLead merely to restate a deterministic PASS.

Thresholds must be configurable and conservative. Prefer fewer high-quality incidents over noisy alerts.

## Incident dedupe and cooldown

Each incident gets a stable signature/hash based on the smallest sufficient tuple, e.g.:

`task/session + incident class + normalized action + normalized error + progress fingerprint`

Rules:

- duplicate incident within cooldown -> suppress model wake;
- state/progress change -> new incident may be evaluated;
- record suppressed count for diagnostics;
- default incident cooldown: choose a conservative value around several minutes, configurable;
- do not wake repeatedly for the same unresolved condition.

## Token / call budget

Primary success metric is **model call count**, because it is deterministic even when provider token accounting is incomplete.

Required behavior:

- standby with no event: **0 model calls**;
- normal Work with no incidents: **<= 1 TechLead call** (startup review only);
- duplicate incident during cooldown: **0 additional calls**;
- maximum TechLead wakes per Work: configurable hard cap, default **6**;
- when cap is exceeded: mark TechLead `BUDGET_EXHAUSTED`, stop further TechLead calls, continue deterministic monitoring/Worker execution;
- incident packets must be bounded/truncated before model invocation;
- never send complete stdout/session logs by default.

Suggested target for incident payload: usually ~500-1500 tokens worth of high-information context, not tens of thousands.

If actual input/output token usage is exposed by the provider, record it. Otherwise record call count, payload characters/bytes and latency without inventing token numbers.

## Incident packet

The reviewer should receive a small packet similar to:

```text
TASK/SESSION
WORK CONTRACT
INCIDENT CLASS
ELAPSED / INCIDENT WINDOW
LAST RELEVANT ACTIONS
NORMALIZED ERROR SIGNATURE
PROGRESS DELTA
WORKER PROPOSED NEXT ACTION
RELEVANT TEST/DIFF SUMMARY
```

Sanitize secrets before persistence, Discord display, or model submission.

Do not include API keys, tokens, cookies, auth headers, full environment dumps, unrelated logs or whole repository content.

## TechLead response schema

P3 must parse a strict bounded response. Recommended semantic actions:

```text
CONTINUE
SUGGEST_INJECT
SUGGEST_PAUSE_REPLAN
ASK_OWNER
```

Response should also carry only:

- short reason;
- compact suggested instruction when applicable;
- confidence/uncertainty only if useful for policy, not verbose chain-of-thought.

Do not request or expose private chain-of-thought. Store only concise decision rationale.

### Shadow Mode safety

In P3:

- `CONTINUE` -> record only;
- `SUGGEST_INJECT` -> record/show suggestion only;
- `SUGGEST_PAUSE_REPLAN` -> record/show suggestion only;
- `ASK_OWNER` -> record/show owner-facing suggestion only;
- **never automatically call existing insert/pause/stop APIs from TechLead output**.

The existing user/owner controls remain unchanged.

The implementation may define a clean future action interface, but the Shadow policy must enforce zero automated side effects.

## Discord UX

Keep noise low.

Add compact TechLead state to the existing Work/status surface where practical:

```text
TechLead: SHADOW / Grok 4.6 / SLEEPING
TechLead: REVIEWING incident=STAGNATION
TechLead: DEGRADED provider unavailable
TechLead: BUDGET_EXHAUSTED wakes=6/6
```

When Shadow Mode finds a material issue, show one concise advisory, preferably by updating/using the existing Work status flow rather than flooding the channel.

Example:

```text
TechLead Shadow: SUGGEST_PAUSE_REPLAN
Reason: same xformers failure repeated with no progress; proposed full CUDA reinstall is unsupported by current evidence.
Suggested instruction: preserve current CUDA; verify torch/xformers ABI compatibility first.
```

Do not expose verbose internal reasoning.

## Persistence / restart

Persist only the minimum required state so a Jarvis/Bridge restart does not reset incident dedupe and immediately re-bill the same unresolved incident.

Persist at least, if compatible with current state architecture:

- TechLead mode/config;
- Work Contract or compact derived form;
- wake count/budget state;
- latest incident signature/time;
- latest advisory summary;
- event capability status.

Do not create a new database solely for P3 if current JSON/state storage is sufficient.

## Configuration

Follow existing config conventions. Required concepts:

```text
TechLead enabled
mode = shadow
provider/model or logical model selector
max wakes per Work (default 6)
incident cooldown
bounded packet size
```

Defaults must preserve safe behavior. Missing/invalid TechLead config must not break Work.

Do not put secrets in repository config.

## Observability

Capture compact metrics per Work:

```text
startup_review_calls
incident_review_calls
duplicate_incidents_suppressed
wake_budget_used
techlead_latency
actual provider/model
event_visibility = FULL|PARTIAL|DEGRADED
provider/token usage if actually reported
```

No high-volume telemetry framework is required.

## Non-goals for P3

Do not:

- let TechLead edit files or execute tools;
- let TechLead automatically inject/pause/stop/abort Work;
- add a second Worker;
- create autonomous recursive Agent loops;
- continuously stream logs to Grok;
- poll Grok on a timer;
- reimplement existing approval/watchdog/cancel/insert/lifecycle systems;
- rewrite Jarvis routing;
- migrate state to a new database solely for this feature;
- add large third-party orchestration frameworks;
- silently use paid APIs;
- modify P2 behavior unrelated to the TechLead integration.

## Implementation order

1. Inspect current Work lifecycle, runner event/output path, insert accounting, watchdog/runaway protection, state persistence and status rendering.
2. Add a normalized minimal WorkEvent/TechLead observation seam without changing Worker semantics.
3. Implement Work Contract extraction/representation.
4. Implement ProgressFingerprint, incident detection, dedupe/cooldown and wake budget with unit tests.
5. Implement provider/model reviewer adapter using existing provider/OpenCode Go infrastructure; default target Grok 4.6 when discovered/available.
6. Implement bounded sanitized incident packet + strict response parser.
7. Implement Shadow Mode controller; prove model output cannot cause Worker side effects.
8. Add compact Discord/status observability.
9. Add event capability probe/fallback behavior.
10. Run deterministic tests, targeted smoke, then real Windows/Discord/OpenCode Go smoke where available.
11. Update CURRENT/AI_HANDOFF with actual evidence and remaining limitations.

Stop when acceptance passes. Do not expand into auto-intervention in this task.

## Acceptance criteria

### A. Regression safety

- existing `npm test` passes;
- existing `npm run check` passes;
- existing relevant P2 smoke suites remain green;
- Work start/execute/stop/insert behavior is unchanged when TechLead is disabled or unavailable;
- process Supervisor / one-Bridge invariant remains intact.

### B. Zero-token standby

Automated test proves:

- with TechLead enabled and no review-triggering event, no recurring/polling model calls occur;
- simulated long idle time does not increase TechLead call count.

### C. Startup review

- explicit Work start triggers at most one TechLead startup review;
- failure/timeout/unavailable reviewer does not block Work;
- actual provider/model and latency are attributable;
- no silent METERED/unknown fallback.

### D. Stagnation detection

Deterministic test sequence:

1. same representative failing action/error repeats;
2. no meaningful progress fingerprint change;
3. incident threshold is crossed;
4. exactly one TechLead review is requested;
5. repeated identical incident inside cooldown causes no additional call.

Control case:

- repeated action with new evidence/progress must not be classified as stagnation solely because the command/action repeats.

### E. Budget

- default max wakes per Work = 6 (or documented equivalent if repository config conventions require another value);
- after budget is exhausted, no further TechLead model calls occur;
- Worker remains operational;
- status clearly reports budget exhaustion.

### F. Shadow safety

Automated test proves every valid TechLead action is advisory only:

- no auto insert;
- no auto pause;
- no auto stop/kill;
- no shell/tool execution;
- no file mutation attributable to TechLead.

### G. Packet hygiene

- incident packet is bounded;
- only relevant tail/delta/evidence is included;
- secret-like fixtures are redacted;
- full raw logs are not sent by default.

### H. Event compatibility

- capability status is surfaced as `FULL|PARTIAL|DEGRADED` or equivalent;
- missing/broken OpenCode-specific hook/event integration falls back safely;
- Work continues normally in degraded visibility.

### I. Persistence / restart

- restart does not reset an unresolved incident in a way that causes immediate duplicate model wake;
- budget/dedupe state resumes correctly enough to avoid repeat billing;
- stale completed Work state does not leak into a new Work.

### J. Real-machine smoke

On the user's Windows environment where OpenCode Go is available:

- start one safe Work through Discord;
- confirm startup review attribution to the selected TechLead model, preferably Grok 4.6 if available;
- trigger or inject a safe synthetic stagnation event for validation rather than deliberately corrupting the environment;
- confirm one advisory appears;
- confirm Worker remains untouched by the advisory in Shadow Mode;
- confirm duplicate incident is suppressed;
- confirm normal Work can complete;
- report actual calls/wakes and provider/model.

If OpenCode Go/Grok is externally unavailable, do not fake a live-provider PASS. Mark the external smoke pending while keeping deterministic/local tests authoritative for implementation correctness.

## Suggested new smoke command

Add one focused smoke script/command following repository conventions, for example:

```text
npm run smoke:p3-techlead
```

It should cover the P3-specific deterministic acceptance path without requiring a destructive real Worker loop.

## Completion report

Use the project/global compact format:

```text
PASS | FAIL
commit: <sha or none>
tests: <compact result>
blocker: <none or one key blocker>
```

Add only these P3 facts when material:

```text
techlead: <provider/model, SHADOW>
wakes: <startup + incident count>
events: <FULL|PARTIAL|DEGRADED>
real-smoke: <PASS|PENDING + reason>
```

## Future task — explicitly out of scope

Only after Shadow Mode has been exercised on real Work tasks and false-positive/false-negative behavior is acceptable should a separate task enable automatic actions.

Likely first auto-action scope:

- allow bounded `INJECT` / `PAUSE_REPLAN` only;
- keep destructive stop/abort and high-risk actions under deterministic safety/OWNER approval;
- preserve incident dedupe and hard wake budget.
