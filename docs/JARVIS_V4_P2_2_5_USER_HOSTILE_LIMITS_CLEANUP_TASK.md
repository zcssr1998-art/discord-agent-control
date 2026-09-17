# Jarvis V4 P2.2.5 — User-hostile limits cleanup

Date: 2026-09-17
Branch: `jarvis-v4-p2-2-hardening`
Status: ACTIVE

## Objective

Remove or redesign Jarvis-imposed limits that unnecessarily block the owner, silently discard useful output/context, or require manual recovery for conditions that should recover automatically.

This is a focused pre-release hardening pass. Do **not** start P3 and do **not** merge PR #4/#5 to `main` until this task passes.

The product rule for this task is:

> Jarvis may enforce real Discord/API/platform limits, security boundaries, and bounded resource-safety controls. It must not invent hidden user-hostile caps, silently throw away data, or permanently lock the owner out when an observable/recoverable design is available.

## Read / preserve

Before implementation read only the normal startup set from `AGENTS.md`, then inspect the relevant limit/config/UI/history/runtime files and current diff. Do not rescan unrelated subsystems.

Preserve all already-validated behavior from P2.2.1–P2.2.4:

- Supervisor / Task Scheduler / one-bridge recovery;
- Chat AUTO + manual pin semantics;
- model pagination and ACK hardening;
- FULL Work thread inheritance;
- unlimited default Work duration;
- monotonic Work lifecycle, truthful insert accounting, one-shot Stop, stale-control safety;
- no silent use of metered/unknown-billing AUTO routes;
- secret redaction / credential isolation.

## A. Mandatory limit audit

Create/update `docs/P2_2_5_LIMIT_AUDIT.md` with every meaningful user-facing hard cap, timeout, cooldown, queue cap, truncation, lockout, auto-reset, or platform-driven limit found in the active source/config.

Classify each as one of:

- `PLATFORM` — Discord/provider/API hard constraint;
- `SECURITY` — credential/data-loss/destructive-action boundary;
- `RESOURCE` — necessary local memory/disk/network protection;
- `POLICY` — Jarvis product choice that may be removed or made owner-configurable.

For each item record: source path/symbol, current value/behavior, user impact, keep/change decision, and rationale.

Do not mechanically remove `PLATFORM`, `SECURITY`, or justified `RESOURCE` limits. The purpose is to eliminate arbitrary hidden `POLICY` limits and silent data loss.

## B. Required fixes

### K1 — `/work` task input must use the real Discord capability

Current problem: Slash `/work task` is artificially capped at 1500 characters.

Required behavior:

- Slash `/work task` string option: `max_length = 6000` (Discord application-command STRING maximum).
- Command registration/diff tests must detect and sync this change.
- A 5000+ character task must reach Jarvis intact in deterministic tests.

### K2 — New Work modal must use the real Discord modal capability

Current problem: the New Work modal is artificially capped at 1500.

Required behavior:

- New Work modal task field: `maxLength = 4000` (Discord Text Input maximum).
- A near-4000-character task must survive modal extraction intact.
- Do not claim 6000 in the modal; modal and slash paths have different platform limits.

### K3 — No silent truncation of Chat or Work final results

Current problem: `clip()` / 1900-message helpers are being used as data-loss boundaries. Chat output can be cut around 1900 characters; Work final result is explicitly clipped around 1200; intermediate results can also be clipped.

Required design:

1. Keep compact clipping for status cards, labels, diagnostics and bounded log previews.
2. Add one shared long-result delivery path for user-visible Chat/Work result text.
3. No successful model/Agent final answer may be silently discarded because it exceeds one Discord message.
4. Delivery strategy should be minimal and robust:
   - short content: one normal message;
   - medium content: ordered Discord chunks that preserve all text;
   - very long content: short preview + generated `.md`/`.txt` attachment is acceptable/preferred to dozens of messages, as long as the full text is delivered and no content is silently lost.
5. Chunking must respect Discord message limits and avoid breaking code fences where practical.
6. The mutable Work progress card stays compact; completed result content must be immutable/separate when needed.
7. If full delivery itself fails, report that failure explicitly and keep the complete result in the run log/artifact path. Never present a truncated message as if it were the full result.

Acceptance fixtures must prove at least an ~8k Chat response and ~8k Work final response are recoverable in full.

### K4 — Owner-selected permission tier must persist independently of Agent session lifecycle

Current problem: permission tiers are in-memory and `SessionManager.change()` resets permissions during model/provider/executor/workspace changes. Bridge restart also returns the owner to STANDARD.

Required behavior:

- Persist the owner-selected permission level in durable Jarvis state.
- Explicit permission choice is product configuration, not ephemeral Agent session state.
- Changing Work model, Provider, Executor, workspace, creating a new Agent session, or restarting the bridge must **not** silently change the selected tier.
- New Work threads inherit the effective parent tier exactly, including FULL.
- Session-scoped one-off approval grants may still be cleared when a session changes.
- Only an explicit permission action should change the persistent tier (or an explicitly documented administrative reset dedicated to permissions).
- Existing state without a persisted tier migrates safely to STANDARD.

Real/deterministic smoke must cover FULL -> bridge/session change -> still FULL -> new Work thread -> FULL with zero routine approval prompts.

### K5 — Remove permanent channel lockout after arbitrary failure counters

Current problem: `MAX_CONSECUTIVE_FAILURES=3` / `MAX_PROCESS_RESTARTS=5` can make the channel refuse future Work until manual `!reset`.

Required behavior:

- A failed run may fail; a crash loop may stop/restart the **current** run safely.
- Historical failures/restarts must not permanently poison the channel or require `!reset` before a later valid Work can run.
- If restart/failure limits are retained for runaway protection, scope them to the current run/recovery episode and reset automatically when that episode ends or a new Work starts.
- Surface warnings/diagnostics instead of owner lockout.
- Do not create an infinite automatic restart loop.

Acceptance: simulate >3 failed runs and/or >5 recovery events, then start a known-good Work without `!reset`; it must be accepted and complete.

### K6 — Chat provider request timeout must not be an aggressive hidden 25-second cap

Current problem: `CHAT_TIMEOUT_MS=25000` can abort a legitimate slow model response.

Required behavior:

- Raise the default to a practical value of **120000 ms**.
- Keep it operator-configurable via `CHAT_TIMEOUT_MS`.
- `0` may mean unlimited only if the implementation safely supports that without passing an invalid timeout to `AbortSignal.timeout`; otherwise document the positive configurable behavior and keep the 120s default.
- This is only the direct Chat provider HTTP timeout. Do not reintroduce any Work wall-clock timeout.
- AUTO may continue to its normal fallback after a timeout; a manual pin must remain pinned and fail clearly rather than silently switching.

Tests: a synthetic 45s-equivalent delayed provider path must not hit the default timeout; a deliberately tiny configured timeout must still work as an operator override.

### K7 — Provider cooldown must be observable and owner-overridable

Current problem: provider/model health cooldowns can silently suppress a route for seconds to an hour after failures.

Required behavior:

- Keep circuit-breaker cooldowns; they are useful protection against hammering a dead backend.
- Make current cooldown state visible in `/status`, `/doctor`, or the model/status UI with provider/model, reason and remaining time where relevant.
- Add an explicit owner action/command to clear/retry the affected Chat provider/model immediately without restarting Jarvis. Reuse existing control surfaces where possible; do not invent a second routing subsystem.
- Manual retry must reset only the intended health entry (or clearly scoped provider), not unrelated providers.
- AUTO billing safeguards remain unchanged.

### K8 — Chat history must not silently drop old context at its local cap

Current problem: the history store trims to 40 messages / ~56k chars by dropping oldest messages with no user-visible compaction event.

Required behavior:

- Keep bounded context; do not replay an unbounded transcript.
- Before an append/send would require destructive trimming, automatically compact older context into the existing summary mechanism and keep a recent tail.
- Auto-compact should happen only when needed, not every turn.
- Reuse the current selected Chat route and existing billing policy; do not enable metered fallback just to compact.
- If compaction cannot run, do **not** silently discard old history. Preserve the stored state and surface a clear warning/action (`/compact` or retry) rather than pretending full continuity remains.
- No recursive compact loop.
- Deterministic tests must prove older facts survive via summary after crossing the old 40-message/56k threshold.

### K9 — Approval expiry must be owner-configurable and non-surprising

Current problem: non-FULL approval requests auto-deny after 540000 ms (9 minutes), which can terminate unattended work simply because the owner did not tap quickly enough.

Required behavior:

- Support `APPROVAL_TIMEOUT_MS=0` as no automatic expiry.
- Make the default `0` unless a compelling existing invariant requires a bounded value; if so, document the blocker in the audit and use the longest safe default.
- Positive configured values continue to enforce expiry.
- Stop/reset must still settle/cancel outstanding approvals immediately.
- Use fake timers/unit tests; do not wait in real time.

### K10 — Follow-up queue cap must not be a hidden arbitrary 10

Current problem: `MAX_WORK_FOLLOWUPS=10` rejects additional owner follow-ups.

Required behavior:

- Support `MAX_WORK_FOLLOWUPS=0` as unlimited for this single-owner bridge, or replace the fixed cap with a clearly configurable resource-policy value whose default does not reject ordinary owner use.
- Prefer default `0` (unlimited) unless a concrete memory/safety reason is demonstrated in the audit.
- The UI must truthfully show a configured finite cap when one exists.
- Live inserts/continuations semantics from P2.2.4 must not regress.

### K11 — Remove the hard-coded Anthropic Chat output ceiling

Current problem: Anthropic-compatible Chat requests hard-code `max_tokens: 4096`.

Required behavior:

- Introduce one documented configurable Chat output-token setting (for transports that require it), e.g. `CHAT_MAX_OUTPUT_TOKENS`.
- Use a practical default no lower than 8192 unless the target provider/model requires less.
- Do not force OpenAI-compatible transports to an artificial output cap unless their protocol/model requires it.
- Provider/model errors caused by an unsupported configured value must be surfaced clearly.

## C. Limits that should remain unless evidence says otherwise

Do **not** remove these just to make the audit look cleaner:

- Discord/platform component/message/name/button limits — adapt around them, do not pretend they do not exist.
- Secret redaction, trusted attachment URL checks, credential isolation, owner-only control checks.
- AUTO refusal to silently spend on metered/unknown providers.
- Manual model pin = no silent model/provider switch.
- One active Work per canonical workspace. This protects the same checkout from concurrent writers; different workspaces may still run in parallel.
- Work default `TASK_TIMEOUT_MS=0` unlimited.
- Status-message progress throttling.
- Attachment/resource caps may remain if justified as RESOURCE limits, but they must be documented in the audit and failures must be explicit, never silent.

## D. Implementation constraints

- Prefer existing helpers/state store/renderers over new subsystems.
- Do not add Redis/Postgres/external services.
- Do not rewrite Discord UI or routing architecture.
- Keep deterministic tests as the primary acceptance mechanism.
- Do not expose or commit secrets.
- Do not run the long Hunyuan3D install reproduction.
- Do not merge PR #4/#5 during this task. The release-merge task resumes only after P2.2.5 passes.

## E. Verification

At minimum run the focused tests added/changed by this task plus the existing regression gates relevant to touched code:

```text
npm test
npm run check
npm run smoke:p2
npm run smoke:p22
npm run smoke:p222
npm run smoke:p22-insert
npm run smoke:p223-full
npm run smoke:p224-lifecycle
```

Also add a focused P2.2.5 smoke/test command (preferred name: `smoke:p225-limits`) covering the new behavior without long waits.

Required focused evidence:

1. `/work` accepts 5000+ chars via slash option definition/path.
2. New Work modal accepts near-4000 chars.
3. ~8k Chat output delivered/recoverable in full; no silent `(truncated)` result.
4. ~8k Work output delivered/recoverable in full; progress card remains compact.
5. FULL persists across bridge/session/model/workspace changes and new Work thread inheritance.
6. Historical failure/restart counts do not block a later valid Work.
7. default Chat timeout does not fail a simulated 45s response; explicit short override still times out.
8. cooldown appears in status/doctor/UI and explicit owner retry clears the intended health entry.
9. history crossing old caps auto-compacts; no silent oldest-message drop.
10. approval timeout default behavior and positive override verified with fake timers.
11. >10 follow-ups are accepted under default unlimited policy, or the audit provides a concrete reason and the configured finite behavior is visible.
12. Anthropic request uses configured output token ceiling, not hard-coded 4096.
13. No secrets in staged diff/logs.

Run one short real Discord owner smoke after deterministic gates:

- `/work` with a >1500-char task starts normally;
- FULL remains FULL after one harmless model/workspace/session change and a fresh Work thread does not prompt for routine approval;
- one long Chat response is delivered without silent truncation;
- `/status` or `/doctor` remains responsive.

Do not manufacture PASS for any owner-only check that was not actually performed; mark it `PENDING_OWNER`.

## F. Repository state updates

On completion:

- update `docs/P2_2_5_LIMIT_AUDIT.md` with final decisions/evidence;
- update `docs/CURRENT.md` and `docs/AI_HANDOFF.md` compactly;
- update `docs/tasks/CURRENT.md`;
- append only material smoke evidence to `docs/WINDOWS_SMOKE.md` if real-machine checks occurred;
- commit and push the verified changes on `jarvis-v4-p2-2-hardening`;
- verify remote HEAD;
- then set the next task back to `docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md` and stop. Do not execute the release merge in the same Worker job.

## Stop condition

Stop when all in-scope deterministic gates pass, required real smoke is complete or explicitly `PENDING_OWNER`, remote state is durable, and no in-scope blocker remains.

Final Worker report only:

```text
PASS / FAIL
commit: <sha or none>
limits: <audit count / changed count / retained platform-security-resource count>
tests: <compact deterministic result>
real-smoke: <PASS | PENDING_OWNER | FAIL>
blocker: <none or one key blocker>
```
