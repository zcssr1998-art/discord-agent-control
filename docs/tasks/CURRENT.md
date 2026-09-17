# Active task

Current execution specification:

`docs/JARVIS_V4_P2_2_4_WORK_LIFECYCLE_TASK.md`

Branch: `jarvis-v4-p2-2-hardening`

## Why this task is active

Owner real-Discord validation after P2.2.3 exposed a remaining release-blocking Work lifecycle bug cluster during a long Hunyuan3D installation task.

Observed:

1. an intermediate Agent turn was rendered as `✅ 已完成`, then the same Work resumed executing because an inserted requirement/continuation still existed;
2. useful result output from the completed turn disappeared when the mutable progress card returned to RUNNING;
3. a live insert that had already successfully changed the installation path was later reported by Stop as `1 条未处理的插入需求`;
4. owner had to press Stop multiple times before the Work visibly settled;
5. terminal `已停止` cards still exposed active Insert/Stop controls and stale interactions.

These are lifecycle/accounting bugs, not new features.

## Scope

Execute only `docs/JARVIS_V4_P2_2_4_WORK_LIFECYCLE_TASK.md`.

Required outcomes:

- intermediate Agent result != terminal Work DONE;
- completed-turn result remains visible when continuation starts;
- live insert / continuation bookkeeping transitions to consumed/settled correctly;
- one valid Stop is sufficient and kills the real process tree;
- repeated/stale Stop is idempotent and cannot affect a newer run;
- terminal cards expose no live controls;
- exactly one monotonic terminal state per Work.

## Preserve

- P2.2.1 Supervisor/autostart/watchdog recovery;
- P2.2.2 Chat AUTO/manual selection;
- P2.2.3 K1–K5 fixes, especially FULL semantics and unlimited default Work duration;
- Chat/Work separation and workspace/model persistence;
- no secrets in repo/logs.

## Completion

Run deterministic lifecycle/insert/Stop regression plus one small real Work smoke. Append the finding/fix to `docs/P2_2_3_BUG_BASH.md`, update state/handoff/evidence, commit + push, verify remote HEAD, then stop. Do not start P3.
