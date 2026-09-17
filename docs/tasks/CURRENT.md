# Active task

Current execution specification:

`docs/JARVIS_V4_P2_2_5_USER_HOSTILE_LIMITS_CLEANUP_TASK.md`

Branch: `jarvis-v4-p2-2-hardening`

## Scope

Pre-release cleanup of Jarvis-imposed user-hostile limits:

1. audit meaningful caps/timeouts/cooldowns/lockouts/truncation/reset behavior;
2. use real Discord limits for `/work` slash + modal input;
3. stop silently truncating Chat/Work final results;
4. persist owner-selected permission tier across restart/session/model/provider/workspace changes;
5. remove permanent historical failure/restart channel lockout;
6. make Chat timeout practical/configurable;
7. expose/override provider cooldown;
8. auto-compact Chat history instead of silently dropping oldest context;
9. make approval expiry and follow-up caps owner-configurable/non-surprising;
10. replace hard-coded Anthropic `max_tokens: 4096` with documented config;
11. add focused deterministic smoke and short real-Discord verification.

## Preserve

Do not regress P2.2.1–P2.2.4, AUTO billing safeguards, manual-pin semantics, secret protection, one-active-Work-per-workspace, or unlimited default Work duration.

Do not start P3. Do not merge PR #4/#5 during this task. The release merge task resumes only after P2.2.5 passes.
