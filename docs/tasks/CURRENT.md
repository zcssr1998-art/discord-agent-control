# Active task

Current execution specification:

`docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md`

Branch: `jarvis-v4-p2-2-hardening`

## Status

P2.2.4, P2.2.5 and P2.2.6 are complete and verified.

- P2.2.6 (Runtime Freshness / Safe Self-Update) is complete:
  `docs/JARVIS_V4_P2_2_6_SAFE_SELF_UPDATE_TASK.md`.

## Scope of the active task

Merge PR #4 then PR #5 into `main`, verify the new `main` on the real Windows/Discord runtime,
and close out P2. Do **not** start P3.

## Preserve

Do not regress P2.2.1–P2.2.6, AUTO billing safeguards, manual pin semantics, secret protection,
one-active-Work-per-workspace, unlimited default Work duration, lifecycle/Stop correctness,
Supervisor single-instance behavior, or safe self-update (fast-forward-only + rollback).

Do not start P3. Do not rerun the long Hunyuan3D reproduction.
