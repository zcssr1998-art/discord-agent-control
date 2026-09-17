# Current project state

## Branch

`jarvis-v4-p3-ai-techlead-shadow`

## Current milestone

Jarvis V4 P3 — **AI TechLead Shadow Mode active**.

Active task:

`docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`

P3.0 timeout-policy cleanup and P3.1 native Chat web search are complete. P3.1 passed owner acceptance on real Discord.

## Completed baseline

### P3.0

- no arbitrary total-duration failure in the default Chat/Work/result-delivery path;
- durable result outbox persists the full result before Discord delivery;
- execution success is separate from delivery pending/degraded state;
- transport retry never reruns a completed Work;
- audit: `docs/P3_0_TIMEOUT_AUDIT.md`.

### P3.1

- lightweight native Chat web search, not the coding-Agent runtime;
- default backend: OpenCode Go native `web_search`, `grok-4.6`, billing `SUBSCRIPTION`;
- AUTO search for current-info/explicit-search turns; stable questions can skip search;
- compact evidence + real visible Sources + `Web` footer;
- no silent metered search fallback;
- verified: `npm test` 411/0, `npm run check` 130/0, `smoke:p31-search` 7/7, `smoke:p222` 25/25, `smoke:p2` 11/11;
- owner acceptance: stable Discord Chat without Web and current-info Discord Chat with real Web/Sources both observed.

## Active P3 objective

Implement AI TechLead Shadow Mode with minimum complexity:

- zero model calls while idle;
- deterministic monitoring first;
- cheap ProgressFingerprint for meaningful state progress;
- incident detection based on repeated action/error plus no new evidence/progress;
- incident dedupe/cooldown;
- bounded per-Work TechLead wake budget;
- Grok 4.6 only for compact judgment packets;
- advisory decisions only in P3; no automatic intervention;
- TechLead/provider/event degradation must never block Work.

Do not add a new orchestration framework, daemon, router or database. Reuse the existing Work lifecycle, watchdog, provider/model discovery, state, approval and status surfaces.

## Preserve

P2/P2.1/P2.2.1–P2.2.6 plus P3.0/P3.1 behavior must stay green, including one Supervisor + one Bridge, Work lifecycle/session persistence, truthful insert accounting, owner Stop/cancellation, permissions, billing safety, updater rollback/quarantine, secret redaction and Chat/Work separation.

Duplicate Bridge startup/provider-warning notifications observed during development are a non-blocking UX follow-up and not a blocker for TechLead.

## Next action

Execute `docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`. Do not create a second architecture plan. Implement minimally, run the required deterministic and real-machine tests, commit/push, then stop for owner acceptance.
