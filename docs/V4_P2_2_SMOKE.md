# Jarvis V4 P2.2 Smoke / Acceptance Evidence

Status: NOT RUN YET

This file records deterministic, real Windows, Discord, and owner reboot evidence for P2.2. Do not mark a real-world item PASS from unit tests alone.

## 1. Baseline regression

- [ ] `npm test`
- [ ] `npm run check`
- [ ] `npm run smoke:p2`

Record exact commit + counts.

## 2. Single-instance guard

- [ ] first bridge acquires instance ownership
- [ ] second launch fails before Discord login
- [ ] live instance remains healthy
- [ ] stale lock is recovered safely
- [ ] graceful shutdown releases ownership
- [ ] `/status` shows actual PID / uptime / branch / commit / instance id

Evidence:

```text
PENDING
```

## 3. Windows autostart

- [ ] install script creates exactly one Jarvis-owned current-user Task Scheduler entry
- [ ] re-running installer updates/reuses the same task (no duplicate)
- [ ] task action points at this checkout's `scripts/start-supervisor.ps1`
- [ ] task state/status can be queried without secrets
- [ ] manual scheduled-task start brings supervisor + Jarvis online
- [ ] LiteLLM still belongs to the supervisor lifecycle
- [ ] manual Jarvis launch while scheduled instance is alive is refused by single-instance guard
- [ ] uninstall removes only the exact Jarvis-owned task
- [ ] reinstall works

Evidence:

```text
PENDING
```

### Owner reboot smoke

**PENDING_OWNER_REBOOT_SMOKE** until the owner explicitly restarts Windows and confirms Jarvis comes back online after logon. The worker must never initiate the reboot automatically.

After owner confirmation record:

- reboot/logon timestamp
- time until Jarvis online
- live PID / branch / commit
- LiteLLM health
- duplicate-instance check

## 4. Durable store / restart semantics

- [ ] DB opens in WAL mode
- [ ] schema migration is idempotent
- [ ] run record persists across bridge restart
- [ ] prior live RUNNING work becomes INTERRUPTED (or equivalent), not falsely RUNNING
- [ ] pending queue/follow-up metadata remains auditable but does not silently auto-execute after restart
- [ ] secrets are not stored in the DB
- [ ] existing JSON configuration remains compatible

Evidence:

```text
PENDING
```

## 5. Parent Work summary card

Owner Discord smoke:

1. Start one guild Work task.
2. Parent channel remains Chat.
3. Parent gets/updates one compact Work summary card.
4. `打开 Work` opens the existing Work thread.
5. `追加需求` reaches the same P2.1 follow-up queue.
6. `Stop` stops the same active run/process tree.
7. An old/stale card cannot stop or append to a newer run.
8. Final card shows DONE/FAILED/CANCELLED without parent-channel spam.

Evidence:

```text
PENDING_OWNER_DISCORD_SMOKE
```

## 6. `/doctor`

- [ ] local/deterministic; no model call
- [ ] runtime/build identity
- [ ] Discord status
- [ ] LiteLLM health
- [ ] provider/executor status using existing health APIs
- [ ] hook status
- [ ] autostart task state
- [ ] durable-store/schema state
- [ ] no credentials/environment dump

Evidence:

```text
PENDING
```

## 7. CI

- [ ] Windows workflow exists
- [ ] no secrets required
- [ ] `npm ci`
- [ ] `npm test`
- [ ] `npm run check`
- [ ] workflow PASS for final commit

Evidence:

```text
PENDING
```

## 8. Refactor regression

After `discord-ui.mjs` extraction:

- [ ] Chat remains direct API only
- [ ] Work thread behavior unchanged
- [ ] native slash commands unchanged
- [ ] buttons/modals ACK correctly
- [ ] follow-ups FIFO / same session
- [ ] stop/approval/attachments/history/model/settings all remain green
- [ ] no parallel replacement state/control implementation introduced

Evidence:

```text
PENDING
```

## Final verdict

```text
P2.2: NOT RUN
commit: -
tests: -
windows-smoke: -
autostart: PENDING_OWNER_REBOOT_SMOKE
blocker: implementation not started
```
