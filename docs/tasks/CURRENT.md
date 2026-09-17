# Active task

Current execution specification:

`docs/JARVIS_V4_P2_2_6_SAFE_SELF_UPDATE_TASK.md`

Branch: `jarvis-v4-p2-2-hardening`

## Scope

Close the runtime freshness gap exposed by owner smoke:

1. make running SHA vs configured remote SHA observable;
2. automatically check the trusted update source;
3. defer deployment while Work is active/queued;
4. deploy only at a safe idle boundary;
5. fast-forward only; dirty/diverged checkout blocks safely;
6. verify candidate + rollback/quarantine bad SHA;
7. restart through existing Supervisor with exactly one Bridge;
8. reconcile and fetch-back verify Discord command schema;
9. prove real `/work task max_length=6000` after bootstrap restart;
10. add owner update status/now/pause/resume controls;
11. add focused `smoke:p226-update` and real Windows/Discord evidence.

## Why before Release Merge

P2.2.5 source/tests passed, but the live Discord bot remained on an old process/schema until manual restart. Release integration should not ship a system where code delivery and live runtime silently drift.

`docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md` is deferred until P2.2.6 passes.

## Preserve

Do not regress P2.2.1–P2.2.5, AUTO billing safeguards, manual pin semantics, secret protection, one-active-Work-per-workspace, unlimited default Work duration, lifecycle/Stop correctness or Supervisor single-instance behavior.

Do not start P3. Do not merge PR #4/#5 in this task. Do not rerun the long Hunyuan3D reproduction.
