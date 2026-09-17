# P2.2.6 auto-deploy rollout probe

This commit was written and pushed from a **separate clone** while the live
Windows checkout was still at `a6eb2c3`. Its purpose is to exercise the
safe-self-update path end to end on the real machine:

1. the live updater (configured `origin/jarvis-v4-p2-2-hardening`, 30s interval)
   detects that the configured remote advanced;
2. it verifies the candidate in a throwaway `git worktree` (`npm run check` +
   `smoke:p226-update`) without touching the live checkout;
3. it fast-forwards the clean live checkout and records the previous known-good SHA;
4. it exits with code 74 so the existing Supervisor relaunches exactly one Bridge;
5. the new runtime reports the new SHA and re-verifies the Discord command schema.

Already verified before this probe:

- bootstrap restart loaded `build=jarvis-v4-p2-2-hardening@496de33`;
- `npm run doctor:commands` fetched the real Discord schema back:
  `/work task max_length == 6000`, 0 mismatches.

This probe was applied automatically by the live updater, and the subsequent owner-side Discord
acceptance (Tiny Chat / Work / Stop / after-Stop recovery / `!status`) PASSED on the resulting
runtime. `PENDING_OWNER` is cleared.

No secret is stored in this file.
