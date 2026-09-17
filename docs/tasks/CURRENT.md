# Active task

Current execution specification:

`docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md`

Branch: `jarvis-v4-p2-2-hardening`

## Scope

Close P2 cleanly into `main`:

1. verify latest hardening head and release gates;
2. merge PR #4 (`jarvis-v4-p2-control-context` -> `main`) first;
3. retarget/reconcile PR #5 (`jarvis-v4-p2-2-hardening`) onto the new `main`;
4. verify PR #5 against new main and merge it second;
5. run final short real-machine smoke from `main`;
6. update repository closeout state and stop.

Owner P2.2.4 insert/lifecycle + single-Stop real-Discord smoke is already PASS. Do not redo the long Hunyuan3D reproduction.

## Do not redo / regress

- P2.2.1 Supervisor/autostart/watchdog recovery;
- P2.2.2 Chat AUTO/manual selection;
- P2.2.3 pagination, ACK, help, FULL semantics, unlimited Work duration;
- P2.2.4 monotonic lifecycle, insert accounting, one-shot Stop, stale-control safety.

Do not start P3 and do not delete remote P2 branches automatically in this task.
