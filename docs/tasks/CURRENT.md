# Active task

Current execution specification:

`docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md`

Branch: `jarvis-v4-p2-2-hardening`

P2.2.5 (`docs/JARVIS_V4_P2_2_5_USER_HOSTILE_LIMITS_CLEANUP_TASK.md`) is complete and
the active-task pointer is returned to the deferred P2 release merge. Do not run the
merge in the same Worker job that completed P2.2.5.

## Evidence to carry into the merge

- `docs/P2_2_5_LIMIT_AUDIT.md` — 33 audited limits, 11 changed, 22 retained.
- `npm test` 372/372; `npm run check` 114 files / 0 failed.
- `smoke:p225-limits` 23/23 plus P2/P2.2 smokes all green.
- Real-Discord owner smoke remains `PENDING_OWNER`.

## Do not redo

- P2.2.1 Supervisor/autostart/watchdog recovery;
- P2.2.2 Chat AUTO/manual selection;
- P2.2.3 K1–K5 fixes;
- P2.2.4 K6 lifecycle fixes;
- P2.2.5 limits cleanup.

Do not start P3.
