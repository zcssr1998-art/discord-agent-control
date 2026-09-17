# P2.2.5 — User-hostile limits audit

Date: 2026-09-17
Branch: `jarvis-v4-p2-2-hardening`
Task: `docs/JARVIS_V4_P2_2_5_USER_HOSTILE_LIMITS_CLEANUP_TASK.md`

Product rule applied:

> Jarvis may enforce real Discord/API/platform limits, security boundaries and
> bounded resource-safety controls. It must not invent hidden user-hostile caps,
> silently throw away data, or permanently lock the owner out when an
> observable/recoverable design is available.

Classification: `PLATFORM` (Discord/provider/API hard constraint),
`SECURITY` (credential/data-loss/destructive boundary),
`RESOURCE` (necessary local memory/disk/network protection),
`POLICY` (Jarvis product choice — removable or owner-configurable).

Decision: `RETAINED` (correct as-is) or `CHANGED` (owner-hostile policy
removed/redesigned).

## Summary

- Audited items: **33**
- Changed items: **11** (K1–K11)
- Retained PLATFORM/SECURITY/RESOURCE items: **22**
- Policy items removed/locked-out by mistake: **0**
- Silent data-loss boundaries remaining for user-visible results: **0**

## Changed (11)

| # | Item / symbol | Class | Before | After | Why |
|---|---------------|-------|--------|-------|-----|
| 1 | `/work task` slash option `max_length` — `src/commands.mjs` | POLICY→PLATFORM | 1500 | 6000 (real Discord application-command STRING max) | The 1500 was Jarvis inventing a cap far below the platform limit. Slash and modal limits differ and are no longer presented as equal. |
| 2 | New Work modal task field `maxLength` — `src/discord-ui.mjs #newWorkModal` | POLICY→PLATFORM | 1500 | 4000 (real Discord Text Input max) | Same class of invented cap on the modal path. |
| 3 | `clip()` used as a delivery boundary for Chat/Work answers — `src/discord/renderers.mjs`, `src/discord-ui.mjs` | POLICY | Chat cut ~1900; Work final cut 1200; intermediate turns cut 1800 | One long-result path: message / ordered chunks / preview + `.md` attachment; every character preserved; failure reported and full text written to the run log | A successful answer must never be silently discarded. `clip()` now stays only for status cards, labels and bounded log previews. |
| 4 | Permission tier reset on session/model/provider/executor/workspace change and restart — `src/permission-manager.mjs`, `src/state.mjs`, `src/session-manager.mjs` | POLICY | In-memory; `SessionManager.change()` and bridge restart returned the owner to STANDARD | Persisted per channel in `state.permissions`; only an explicit `switchLevel`/`confirmFull` changes it; new Work threads inherit exactly (incl. FULL); legacy state migrates to STANDARD | FULL is owner configuration, not ephemeral Agent session state. |
| 5 | `MAX_CONSECUTIVE_FAILURES=3` / `MAX_PROCESS_RESTARTS=5` permanent channel lockout — `src/limits.mjs` | POLICY | `blocked()` refused new Work and demanded `!reset` | `blocked()` is always false; counters are non-blocking diagnostics; a new Work (`beginWork`) and a success reset the episode | Historical failures must not poison the channel; no infinite restart loop (counters stay visible). |
| 6 | `CHAT_TIMEOUT_MS` direct Chat HTTP timeout — `src/config.mjs`, `src/chat-runtime.mjs` | POLICY | 25000 ms | 120000 ms default; operator-configurable; `0` = no client-side timeout (no invalid `AbortSignal.timeout`) | A legitimate slow model response must not be aborted. Work wall-clock timeout stays `0` (unchanged). |
| 7 | Provider/model health cooldowns — `src/provider-health.mjs`, `src/discord-ui.mjs` | POLICY | Silent multi-second-to-hour suppression | Still bounded (≤1 h, escalation factor ≤8) but now listed with provider/model/reason/remaining in `!status`, `!doctor`, `!cooldown`; `!cooldown clear [provider] [model]` retries immediately and resets only the intended entry | Protect against hammering a dead backend without hiding it from the owner; no second routing subsystem. |
| 8 | Chat history silent trim at 40 messages / ~56k chars — `src/chat-history.mjs`, `src/discord-ui.mjs` | POLICY | `#trim()` dropped the oldest messages with no event | `wouldTrim()` detects the boundary; the chat path auto-compacts older context into the existing summary and keeps a recent tail; if compaction fails it preserves the stored state and warns instead of dropping | Bounded context is kept, but old facts survive and nothing is discarded silently; no recursive compact loop; compacts only when needed, on the same route/billing policy. |
| 9 | `APPROVAL_TIMEOUT_MS` non-FULL approval auto-deny — `src/config.mjs`, `src/approval-manager.mjs` | POLICY | 540000 ms (9 min) auto-deny | Default `0` = no automatic expiry; positive values still expire; `!stop`/`!reset` still settle pending approvals immediately | Unattended work must not terminate because the owner did not tap in time. |
| 10 | `MAX_WORK_FOLLOWUPS` follow-up queue cap — `src/config.mjs`, `src/discord-ui.mjs` | POLICY | 10 (rejected further owner follow-ups) | Default `0` = unlimited for this single-owner bridge; positive values remain enforced and the card shows `n / cap` | No concrete memory/safety reason for a hidden 10; a configured finite cap is now visible. P2.2.4 insert/continuation semantics unchanged. |
| 11 | Anthropic Chat `max_tokens: 4096` — `src/chat-runtime.mjs`, `src/config.mjs` | POLICY | Hard-coded 4096 | `CHAT_MAX_OUTPUT_TOKENS` default 8192; OpenAI-compatible transports stay uncapped; unsupported configured values surface as provider errors | One documented, configurable output ceiling instead of an invisible truncation source. |

## Retained (22)

| # | Item / symbol | Class | Value / behavior | Why retained |
|---|---------------|-------|------------------|--------------|
| 1 | Discord message content limit — `DISCORD_LIMIT=1900`, `chunkDiscordText` | PLATFORM | 2000 real; 1900 safety | Discord hard limit; adapted around, never pretended away. |
| 2 | Discord component limits — `MODEL_PAGE_SIZE=15`, `SETTINGS_MODEL_LIMIT=20`, 5 rows | PLATFORM | ≤5 action rows / 25 components | Discord hard limit; pagination adapts. |
| 3 | Thread name length — `sanitizeThreadName` (`THREAD_NAME_MAX=90`) | PLATFORM | 100 real; 90 safe | Discord hard limit. |
| 4 | Button label length — `providerModelRows`/`choiceRows` (`.slice(0,80)`) | PLATFORM | 80 | Discord hard limit. |
| 5 | Attachment upload size — generated result `.md` | PLATFORM | Discord upload cap | Full text is still kept in the run log if the attachment cannot be sent; failure is explicit. |
| 6 | Provider/model context and output maxima | PLATFORM | Provider-specific | Not invented by Jarvis; surfaced as clear provider errors. |
| 7 | Owner-only interaction guard — `discord-ui.mjs onInteraction` | SECURITY | `interaction.user.id !== ownerId` rejected | Credential/destructive-action boundary. |
| 8 | Secret redaction — `src/secrets.mjs`, `redact()` | SECURITY | Applied to all logs/UI | Never regress. |
| 9 | Credential isolation — `stripPaidCredentials`, per-provider `CredentialStore` | SECURITY | Fail-closed backend/credential separation | Never regress. |
| 10 | Approval gate — `approval-manager.mjs` fail-closed with no presenter | SECURITY | Deny when UI unavailable | Stop/reset still cancel all pending gates. |
| 11 | Attachment trust checks — `src/attachments.mjs` | SECURITY | URL/scheme/size validation | Prevent unsafe fetches. |
| 12 | AUTO metered/unknown billing safeguard — `chat-runtime.mjs usableBilling` | POLICY/SECURITY | `ALLOW_METERED_CHAT_FALLBACK=false` default | AUTO must not silently spend; unchanged. |
| 13 | Manual Chat/Work pin — no silent model/provider switch | POLICY | Pin fails clearly instead of switching | Unchanged; preserved by tests. |
| 14 | `PROGRESS_THROTTLE_MS=1500` — `src/config.mjs` | RESOURCE | 1500 | One live status message; protects Discord rate limits. |
| 15 | `STALL_NOTICE_MS=30000` — `src/config.mjs` | RESOURCE | 30000 | Model-free liveness repaint only. |
| 16 | `BACKEND_PROBE_TIMEOUT_MS=180000` — `src/config.mjs` | RESOURCE | 180000 | Bounds the startup preflight independently of unlimited Work. |
| 17 | One active Work per canonical workspace — `WorkspaceScheduler` | RESOURCE | FIFO per workspace | Protects the same checkout from concurrent writers; different workspaces still parallel. |
| 18 | Chat history bounds — `ChatHistoryStore` (40 msgs / 56000 chars / 6000 summary) | RESOURCE | Bounded store | Bound is kept; destruction is replaced by auto-compaction (item 8, changed). |
| 19 | Provider cooldown escalation cap — `provider-health.mjs` (factor ≤8, ≤1 h) | RESOURCE | Bounded backoff | Kept; now observable/overridable (item 7, changed). |
| 20 | Attachment inbox retention — `cleanupInbox` TTL 48 h | RESOURCE | 48 h | Disk protection; not user-visible data loss for results. |
| 21 | Model/choice pagination page sizes — `CHOICE_PAGE_SIZE=10` | PLATFORM | 10/page | Adapts to Discord component limits. |
| 22 | Inline result budget on the mutable Work card — `CARD_RESULT_BUDGET=1200` | POLICY | Card stays compact | Not a data-loss boundary: longer results are delivered in full via the long-result path (item 3). |

## Verification

- `npm test` 372/372 · `npm run check` 114 files / 0 failed.
- `npm run smoke:p225-limits` 23/23 (deterministic; covers K1–K11).
- `npm run smoke:p2` 11/11 · `smoke:p22` 10/10 · `smoke:p222` 25/25 ·
  `smoke:p22-insert` 14/14.
- `smoke:p223-full` 15/15 · `smoke:p224-lifecycle` 21/21 (real Agent + real
  Windows process tree; Discord transport faked).

## Notes / external

- The live real-Discord owner smoke (section E) was not performed by this
  Worker; it is reported as `PENDING_OWNER`, not manufactured.
- WorkBuddy `HTTP 403 request illegal` remains external (documented in
  `docs/AI_HANDOFF.md`) and does not block other providers.
- No secrets are stored, logged or committed; `.env` stays git-ignored.
