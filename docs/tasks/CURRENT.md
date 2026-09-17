# Active task

`docs/tasks/CHAT_TIMEOUT_UNLIMITED_FIX.md` — remove Jarvis's default client-side Chat wall-clock timeout and make `CHAT_TIMEOUT_MS=0` the default/effective runtime policy.

## Status

Implemented and verified. Default `CHAT_TIMEOUT_MS=0` (no Jarvis client-side Chat timeout) with
explicit positive overrides preserved; `npm test` 388/388 and `npm run check` green; live bridge
restarted and a real pinned OpenCode Go grok-4.6 Chat request succeeded (`timeoutMs=unlimited`).

## Last completed release task

`docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md` — P2 release merge / mainline closeout.

Result: PR #4 (`jarvis-v4-p2-control-context`) merged to `main` first (`507df36`), then PR #5
(`jarvis-v4-p2-2-hardening`) reconciled against the new `main` and merged (`f938e88`). All
P2.2.1–P2.2.6 fixes are on `main`; deterministic and real-machine (Agent, only Discord transport
faked) gates are green; the scheduled Supervisor runtime runs `main` with one Bridge and the
updater source is `origin/main`.

## Do not

Do not start P3. Complete the active Chat-timeout fix first; keep scope limited to the referenced task.
