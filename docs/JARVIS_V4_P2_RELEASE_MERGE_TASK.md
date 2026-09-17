# Jarvis V4 P2 — Release Merge / Mainline Closeout Task

## Objective

Close the P2 development stack cleanly by merging the already-verified P2/P2.1 and P2.2–P2.2.4 work into `main`, then prove the resulting `main` still works on the real Windows/Discord runtime.

This is a **release/merge task**, not a feature-development task.

Do not start P3 in this task.

## Repository

`zcssr1998-art/discord-agent-control`

Current stacked branches / PRs:

- PR #4: `jarvis-v4-p2-control-context` -> `main`
  - title: `Jarvis V4 P2: control panel, chat context, attachments + native Work UX`
  - currently Draft
- PR #5: `jarvis-v4-p2-2-hardening` -> `jarvis-v4-p2-control-context`
  - title: `Jarvis V4 P2.2: hardening, autostart, durable runtime`
  - currently Draft
  - head includes P2.2.1–P2.2.4 through commit `aa6dc27521527b86f1122292abe5d97179623915`,
    plus P2.2.5 limits cleanup and P2.2.6 runtime freshness / safe self-update.
  - P2.2.6 baseline: `npm run smoke:p226-update` 45/45; real Discord command fetch-back
    `/work task max_length == 6000`; bootstrap restart loaded the new runtime.

Both PRs were reported mergeable before this task was created; re-check live state before acting.

## Owner validation already completed

Do not redo the long Hunyuan3D incident reproduction.

Owner real-Discord validation has now passed the P2.2.4 critical paths:

### Insert/lifecycle owner smoke — PASS

A real Work created and verified:

- `D:\jarvis-owner-smoke\step1.txt`
- `step2.txt`
- `step3.txt`
- live inserted requirement created `inserted.txt = INSERT_CONSUMED_OK`

Observed behavior:

- no false intermediate terminal DONE;
- live insert executed in the same Work;
- final result remained visible;
- exactly one final completion.

### Stop owner smoke — PASS

A real long-running Work was stopped once by the owner.

Observed behavior:

- one Stop settled the Work;
- real Agent process tree was killed;
- zero false pending-insert accounting;
- STOPPED remained terminal;
- terminal card exposed no active Insert/Stop controls.

Treat these as final owner evidence for P2.2.4.

## Mandatory startup order

Before any merge action:

1. Read `AGENTS.md`.
2. Read central `GLOBAL_AI_RULES.md`.
3. Read `docs/CURRENT.md`.
4. Read `docs/AI_HANDOFF.md`.
5. Read `docs/tasks/CURRENT.md`.
6. Read this file.
7. Inspect `git status`, current branch/HEAD, remotes, and existing processes/jobs.
8. Fetch remote refs and re-read live PR #4/#5 status/base/head/mergeability.

Do not re-scan the whole repository or re-plan P2.

## Guardrails

- Preserve all P0/P0.5/P1/P2/P2.1/P2.2.x behavior already verified.
- No new features.
- No speculative refactor.
- No dependency upgrades unless strictly required to resolve a merge/build failure caused by the merge itself.
- Do not reboot the owner's PC.
- Do not rotate credentials or touch secrets.
- Do not delete remote feature branches in this task; successful merged branches can be cleaned up later after the new `main` has been used normally.
- Stop immediately on any unresolved release-blocking regression.

## Phase A — Reconcile remote state

Confirm:

- PR #4 head is still `jarvis-v4-p2-control-context`.
- PR #5 head is still `jarvis-v4-p2-2-hardening`.
- PR #5 contains commit `aa6dc27521527b86f1122292abe5d97179623915` or a verified descendant.
- no unexpected commits have landed on either branch since the verified P2.2.4 state.
- working tree is clean or any pre-existing work is understood and preserved.

If unexpected remote changes exist, inspect only the relevant diff and reconcile before proceeding.

## Phase B — Final pre-merge verification

On the latest `jarvis-v4-p2-2-hardening` head, run the minimum sufficient release suite:

```text
npm test
npm run check
npm run smoke:p2
npm run smoke:p22
npm run smoke:p222
npm run smoke:p22-insert
npm run smoke:p223-full
npm run smoke:p224-lifecycle
npm run smoke:p225-limits
npm run smoke:p226-update
```

Also run:

```text
npm run verify:hook
npm run doctor:discord
```

Do not rerun expensive long model-install workflows.

PASS requirement: all deterministic/focused smokes green except already-documented external WorkBuddy gateway `403 request illegal`, which must remain explicitly external and must not break the other providers/bridge.

If any new regression appears, stop the merge and fix only that regression on the appropriate branch, add focused coverage, then re-run the impacted gates.

## Phase C — Merge PR #4 first

PR #4 must land before PR #5 because #5 is stacked on #4.

Steps:

1. Refresh PR #4 metadata and mergeability.
2. Ensure its diff is still the intended P2/P2.1 scope.
3. Mark PR #4 Ready for Review if still Draft.
4. Wait for/inspect required checks if the repository has them.
5. Merge PR #4 into `main` using the repository's normal merge method.
6. Fetch remote `main` and verify the expected PR #4 content is present.

Do not merge PR #5 first.

## Phase D — Rebase/retarget PR #5 onto the new main

After PR #4 is merged:

1. Fetch the new `origin/main`.
2. Retarget PR #5 base from `jarvis-v4-p2-control-context` to `main`.
3. Re-check PR #5 diff.

The resulting PR #5 diff should contain only the P2.2/P2.2.1/P2.2.2/P2.2.3/P2.2.4 hardening work, not duplicate P2/P2.1 content.

If GitHub reports conflicts or duplicate history after retarget:

- resolve by rebasing/merging the feature branch onto the new `main` using the lowest-risk method;
- do not rewrite public history unnecessarily;
- verify no verified fix is dropped;
- rerun focused tests after conflict resolution.

## Phase E — Verify PR #5 against new main

With PR #5 now based on the merged `main`, run at least:

```text
npm test
npm run check
npm run smoke:p22
npm run smoke:p222
npm run smoke:p22-insert
npm run smoke:p223-full
npm run smoke:p224-lifecycle
npm run smoke:p225-limits
npm run smoke:p226-update
```

If merge/rebase touched runtime/autostart/supervisor files, also run the supervisor recovery smoke.

PASS requirement:

- no duplicate bridge/process;
- FULL still produces no routine approval prompts;
- default Work duration remains unlimited;
- Chat default AUTO/manual pin behavior preserved;
- model pagination/ACK/help fixes preserved;
- lifecycle/insert/Stop tests stay green.

## Phase F — Merge PR #5

Once Phase E is green:

1. Mark PR #5 Ready for Review if still Draft.
2. Re-check mergeability/checks.
3. Merge PR #5 into `main`.
4. Fetch `origin/main`.
5. Verify `main` contains the P2.2.4 lifecycle commit content and current docs/tests.

## Phase G — Final mainline real-machine smoke

Run from the **new `main`**, not the feature branch.

Minimum real-machine checks:

1. start/use the existing scheduled Supervisor path; do not create a second Jarvis instance;
2. confirm Jarvis Discord ONLINE;
3. `/status` responds;
4. `/doctor` responds;
5. ordinary Chat in AUTO works;
6. create one tiny Work that writes a disposable file and completes;
7. run one tiny Work and Stop it once; verify terminal STOPPED and process-tree death;
8. confirm exactly one bridge instance remains.

No long install task is needed.

If the current Task Scheduler installation points to a branch-specific checkout and the merge changes the intended runtime checkout, update/reinstall the canonical scheduled task only if required by the existing installer design. Verify the effective task points to the intended live checkout before PASS.

## Phase H — Repository closeout

After final `main` smoke passes:

Update on `main`:

- `docs/CURRENT.md` -> P2/P2.1/P2.2.x complete and merged to main; no active task;
- `docs/AI_HANDOFF.md` -> concise final P2 state and preserved invariants;
- `docs/tasks/CURRENT.md` -> none, last completed release-merge task;
- relevant smoke evidence with the final main SHA and owner-smoke note.

Commit/push these closeout docs only if they are not already included by the merge.

Do **not** start a P3 task automatically. P3 gets a fresh task/branch only after this release closeout is accepted.

## Branch cleanup

Do not delete remote P2 branches automatically in this task.

After `main` has passed the final smoke, report that #4/#5 are merged and list the old branches as safe cleanup candidates. Branch deletion can be a later explicit owner action.

## Acceptance criteria

PASS only if all are true:

- PR #4 merged to `main` first;
- PR #5 retargeted/reconciled against the resulting `main` and merged second;
- final `main` contains all P2.2.1–P2.2.4 fixes;
- final deterministic/focused regression green;
- real mainline Discord/Chat/Work/Stop smoke green;
- one bridge instance only;
- scheduled runtime still recovers correctly / points at the intended checkout;
- no release-blocking bug open;
- WorkBuddy 403, if still present, is documented as external only;
- repo state docs reflect P2 complete on main;
- no P3 implementation started.

## Stop conditions

Stop and report FAIL if:

- a PR has unexpected/unreviewed changes;
- a merge conflict cannot be resolved without risking verified behavior;
- tests or mainline real smoke regress;
- main runtime would point at the wrong checkout;
- any secret/credential appears in diff/logs.

Do not force-merge around a failing gate.

## Final worker response

Return only:

```text
PASS | FAIL
pr4: <merged sha/state>
pr5: <retarget/merged sha/state>
main: <final main sha>
tests: <compact result>
real-smoke: <Discord/Chat/Work/Stop/single-instance>
runtime: <scheduled task checkout/status>
external: <WorkBuddy 403 or none>
blocker: <none or key blocker>
```
