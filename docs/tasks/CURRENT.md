# Active task

`docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md`

## Branch

`jarvis-v4-p3-ai-techlead-shadow`

## Status

P3.0 and P3.1 are complete. **P3.1 owner acceptance PASS on real Discord.**

Observed owner acceptance:

- stable knowledge Chat answered without `Web` / `Sources`;
- current-info Chat used real web search and returned visible `Web` + real source links;
- P3.1 smoke verified no coding Agent / Work session is started for Chat search;
- OpenCode Go native `web_search` remains the recorded default backend, billing class `SUBSCRIPTION`;
- duplicate Bridge startup/provider-warning notifications are a non-blocking UX follow-up and are not part of the TechLead implementation.

## Current objective

Implement `docs/tasks/JARVIS_V4_P3_AI_TECHLEAD_SHADOW.md` exactly as specified:

- zero-token standby;
- deterministic monitoring first;
- compact ProgressFingerprint / incident detection / dedupe / cooldown;
- Grok 4.6 only on meaningful review events;
- hard per-Work wake budget;
- Shadow Mode is advisory only: no automatic inject/pause/stop/tool/file action;
- TechLead/provider/event failure must never block normal Work;
- preserve all P2, P3.0 and P3.1 behavior.

Do not create a second architecture plan. Read the existing task and implement the smallest compatible seam, then run the required deterministic and real-machine smoke tests and stop for owner acceptance.
