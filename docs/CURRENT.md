# Current project state

Keep this file compact. It is the first project-state file a new worker should read.

## Branch

`jarvis-v4-p2-2-hardening`

Stacked on P2/P2.1. Do not merge P2.2 yet.

## Current milestone

Jarvis V4 P2.2.2 — Chat model selection + invalid placeholder repair.

Authoritative spec:

`docs/JARVIS_V4_P2_2_2_CHAT_MODEL_SELECTION_TASK.md`

## P2.2.1 recovery baseline

Supervisor/autostart recovery is implemented and real-machine verified at/after `c83751b`:

- persistent Supervisor, unlimited production retries with bounded backoff;
- Bridge isolated in its own hidden console;
- LiteLLM continuously health-checked/recovered;
- Task Scheduler AtLogOn + 1-minute watchdog trigger recovers Supervisor;
- real kill/recovery smoke passed for Bridge, LiteLLM, Supervisor and >5 startup failures.

The owner then performed the real reboot. Jarvis **did auto-start successfully**, so keep the P2.2.1 recovery implementation intact.

## New real post-reboot failure

After reboot, ordinary Chat failed with a persisted literal documentation placeholder:

```text
provider=opencode-go model=<model-id>
```

Current Chat selection persistence can accept arbitrary model text, so `<model-id>` survived reboot and pinned Chat to an impossible manual route.

Owner-required Chat semantics:

- default = `AUTO`;
- AUTO remains safe automatic routing, not a hardcoded model;
- owner can explicitly choose a real Provider/model from Discord;
- manual choice persists and remains a true no-fallback pin;
- owner can switch back to AUTO at any time;
- placeholder/example IDs must never persist;
- existing bad persisted placeholder state must repair automatically to `AUTO/null` without deleting unrelated state.

## Acceptance focus

P2.2.2 is complete only when:

- fresh Chat defaults to AUTO/null;
- `<model-id>` / `<provider-id>` style placeholders are rejected at one shared persistence boundary;
- existing persisted bad pin is automatically repaired and persisted as AUTO/null;
- `/model` / panel offers AUTO plus actual eligible Providers and actual models;
- manual real pin works, survives restart, and does not silently fallback;
- switch back to AUTO works;
- `/status` clearly distinguishes AUTO vs manual pin;
- live Discord smoke proves AUTO chat → manual pin → switch back AUTO;
- P2.2.1 recovery regressions remain green.

## Preserve

- ordinary Chat never starts an Agent;
- Work model selection/persistence is independent from Chat;
- LiteLLM primary + OpenCode Go direct architecture;
- AUTO does not unexpectedly use disallowed metered routes;
- single-instance/recovery/watchdog behavior remains intact;
- no secrets in repo/logs/state evidence.

## Non-goals

No P3/finance/Longbridge, Supervisor redesign, new provider architecture, web dashboard, Agent teams, or broad Discord UI refactor.

## Next action

Execute `docs/JARVIS_V4_P2_2_2_CHAT_MODEL_SELECTION_TASK.md`, run deterministic + live Discord smoke, update evidence/state, commit + push, then stop.
