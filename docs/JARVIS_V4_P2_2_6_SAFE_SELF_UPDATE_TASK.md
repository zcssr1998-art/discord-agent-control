# Jarvis V4 P2.2.6 — Runtime Freshness / Safe Self-Update

## 0. Why this task exists

A real owner smoke exposed a release/runtime freshness bug after P2.2.5:

- repository source had already changed `/work task` from `max_length: 1500` to `6000`;
- deterministic tests passed and the commit was pushed;
- the live Discord Jarvis process was still running the old build and Discord still advertised the old 1500-character Slash Command schema;
- the owner therefore saw `输入 1500 个或更少的字符` even though GitHub contained the fix.

Root product problem: **GitHub HEAD, the code running on Windows, and the Discord-registered command schema can drift apart with no automatic convergence or obvious status.**

The owner also requested automatic receipt of repository updates.

This task must solve the real problem with **safe self-deploy + restart**, not in-process module hot swapping.

## 1. Objective

Make Jarvis able to keep its live Windows runtime on a configured trusted Git branch automatically, without interrupting active Work and without requiring the owner to remember to restart the bridge after each verified update.

Target lifecycle:

```text
remote branch advances
    -> detect new commit
    -> show UPDATE_AVAILABLE / UPDATE_PENDING
    -> never interrupt active Work
    -> reach a safe idle boundary
    -> validate that the update is fast-forward/safe
    -> deploy the candidate
    -> restart through the existing Supervisor
    -> new runtime reports the new SHA
    -> reconcile + verify Discord application-command schema
    -> PASS, or roll back to the previous known-good SHA
```

The steady-state production target after P2 release merge is `origin/main`.

## 2. Non-goals / forbidden approaches

Do **not**:

- hot-swap imported Node modules inside a live process;
- mutate code while an Agent Work is active;
- `git pull` blindly on a timer;
- auto-merge, auto-rebase, force-push, or resolve conflicts automatically;
- stash/discard an unknown dirty worktree;
- follow an arbitrary branch supplied by Discord text without validation;
- auto-update from untrusted remotes;
- create a second Bridge instance during deploy;
- bypass the existing Supervisor / Task Scheduler single-instance design;
- reintroduce a Work wall-clock timeout;
- weaken AUTO billing, manual model pin, FULL permission, Stop/lifecycle or secret protections;
- start P3 or execute the deferred PR #4/#5 release merge in this job.

## 3. Architecture principle

Prefer the existing validated runtime ownership hierarchy:

`Task Scheduler -> Supervisor -> Bridge -> Agent children`

The **Supervisor owns process replacement**. Jarvis may detect and request an update, but the live Bridge must not try to become two versions of itself.

A clean implementation may use an explicit restart/update exit code and an update helper owned by the Supervisor, or an equivalent design that preserves the same ownership and single-instance guarantees.

Use the minimum new machinery required. No new service/database/container stack.

## 4. Required behavior

### K1 — Build freshness is first-class and observable

Jarvis must expose, at minimum:

- running/local SHA;
- configured update remote + branch;
- fetched remote SHA;
- `UP_TO_DATE | UPDATE_AVAILABLE | UPDATE_PENDING | UPDATING | PAUSED | BLOCKED | LAST_UPDATE_FAILED`;
- last successful update time/SHA;
- last failed update reason when relevant.

Surface this in `/status` and `/doctor` without a model call.

A stale runtime must be obvious. Do not make the owner infer it from source code.

### K2 — Configured trusted update source

Add explicit config/env for the updater. Recommended semantics:

```text
AUTO_UPDATE_ENABLED=true|false
AUTO_UPDATE_REMOTE=origin
AUTO_UPDATE_BRANCH=main
AUTO_UPDATE_INTERVAL_MS=300000
```

Requirements:

- remote and branch are configuration, not arbitrary per-message shell text;
- default production branch after P2 release is `main`;
- the current feature branch may be used only for deterministic/owner smoke through explicit config;
- invalid/missing remote or branch => updater is BLOCKED, Bridge stays online;
- no secret is logged.

### K3 — Check automatically, apply only at a safe boundary

Periodic check may `git fetch`, but it must not modify the checkout merely because a remote commit exists.

When remote is ahead:

- if Work/queue/continuation/approval/other critical runtime activity is active, mark `UPDATE_PENDING` and continue serving normally;
- once safe-to-restart conditions are true, apply automatically if auto-update is enabled and not paused;
- a long-running Work must be allowed to finish; duration alone is never a reason to kill it for an update.

Define a deterministic `safeToRestart` boundary. At minimum it must consider active/queued Work and real Agent processes. Include other in-flight state if needed to avoid losing an acknowledged operation.

### K4 — Fast-forward only; dirty/diverged checkout must fail closed

Before deployment:

- fetch the configured remote/branch;
- verify the live checkout is the intended Git repository;
- verify worktree/index is clean except explicitly documented runtime-generated ignored files;
- verify remote candidate is a descendant of current HEAD (fast-forward path);
- if dirty/diverged/conflicted, set BLOCKED and notify/report; do not stash/reset/merge/rebase automatically.

No update may overwrite owner/source changes silently.

### K5 — Candidate verification and known-good rollback

Record `previous_sha` before applying.

Before accepting a candidate as live, run the minimum deterministic release gate appropriate for this repo. At minimum:

```text
npm run check
focused update/deploy smoke
```

Run broader tests only when justified by changed files or the existing release task.

If dependency lock/config changed, install dependencies using the existing package manager in a deterministic way. Do not run install on every poll.

Prefer validating a candidate without corrupting the known-good checkout (e.g. temporary worktree/staging) when practical. If the chosen minimal implementation updates the live clean checkout first, rollback must be deterministic and proven.

On candidate/deploy/startup failure:

- restore the previous known-good SHA;
- restore dependencies if the update changed them;
- restart the known-good Bridge;
- record `LAST_UPDATE_FAILED` with a redacted reason;
- do not enter an infinite update/restart loop against the same bad SHA.

A failed candidate should be quarantined until remote SHA changes or the owner explicitly retries.

### K6 — Supervisor integration; no duplicate Bridge

Use the existing Supervisor as the restart authority.

Acceptance requires:

- update/restart leaves exactly one Bridge;
- Task Scheduler/Supervisor continue pointing to the intended live checkout;
- Agent children are not orphaned;
- update request cannot race into two supervisors/bridges;
- normal crash recovery remains unchanged.

### K7 — Discord command schema reconciliation and verification

Fix the specific owner-visible failure class.

Startup command registration currently syncs definitions, but a stale running build means Discord can still expose an old schema. After a successful self-update/restart:

1. register/sync desired application commands;
2. fetch the actual Discord command definitions back;
3. compare normalized desired vs actual schema;
4. expose PASS/FAIL in `/doctor` and logs.

For current P2.2.5, the real check must prove:

```text
/work task max_length == 6000
```

Do not claim success from the local constant alone.

If Discord REST registration fails transiently:

- Bridge stays online;
- status/doctor shows command schema out-of-sync;
- retry reconciliation safely with bounded backoff or an explicit owner retry path;
- do not roll back otherwise-good source code solely because Discord REST is temporarily unreachable.

### K8 — Owner controls

Add a small native control surface. Prefer `/update` with subcommands or an equivalently clear panel flow:

```text
/update status
/update now
/update pause
/update resume
```

Semantics:

- `status`: no side effects; show local/remote SHA and updater state;
- `now`: fetch/check immediately; if busy, queue `UPDATE_PENDING` rather than killing Work;
- `pause`: persist pause state;
- `resume`: persist auto-update behavior and re-check;
- no hidden force-kill option by default.

Owner-only, same as the rest of Jarvis controls.

### K9 — Durable update state

Persist enough state to survive restart and explain what happened:

- enabled/paused;
- configured source if product config permits persistence (do not duplicate env secrets);
- last check time;
- last remote SHA;
- pending SHA;
- previous known-good SHA;
- last applied SHA/time;
- last failure/quarantined SHA + redacted reason.

Do not persist ephemeral process objects.

### K10 — Bootstrap the current live machine once

This feature cannot auto-update the process that does not yet contain the updater.

Therefore this task must perform/verify **one controlled bootstrap deployment/restart** on the real Windows machine after implementation, using the existing Supervisor path.

After that bootstrap, the updater owns future verified updates.

The bootstrap must also close the currently observed gap by proving the live runtime reports the new SHA and the Discord `/work` schema reports 6000.

### K11 — User-visible deploy notification, low noise

Notify the owner only for meaningful transitions:

- update available/pending (one notice, not every poll);
- update applied successfully (`oldSHA -> newSHA`);
- update blocked/failed/rolled back.

Do not spam on every `UP_TO_DATE` check.

## 5. Correctness / safety invariants

1. **Repository HEAD != runtime SHA is never invisible.**
2. **No active Work is killed merely to deploy an update.**
3. **Only fast-forward updates from the configured trusted source are automatic.**
4. **Dirty/diverged live checkout is never auto-overwritten.**
5. **At most one Bridge owns Discord at any time.**
6. **A failed candidate cannot brick Jarvis; last known good restarts.**
7. **A bad SHA cannot create an infinite update/restart loop.**
8. **Discord schema success means remote registered schema was fetched and matched, not just local code changed.**
9. **No secrets in Git/update logs/Discord notices.**
10. **P2.2.1–P2.2.5 validated behavior remains intact.**

## 6. Deterministic tests to add

Add focused tests/smoke rather than re-running the whole repository for every case.

Create a deterministic update test harness, preferably using temporary local/bare Git repositories, covering at least:

- UP_TO_DATE;
- remote fast-forward available;
- active Work => UPDATE_PENDING, no restart/apply;
- idle => update applies;
- dirty worktree => BLOCKED, no mutation;
- diverged history => BLOCKED, no mutation;
- candidate verification failure => rollback to previous SHA;
- failed SHA quarantine prevents restart loop;
- new remote SHA allows retry;
- pause/resume persistence;
- exactly one restart request for one candidate;
- command schema normalized match/mismatch detection;
- `/work task max_length=6000` verified against fetched remote Discord command JSON in the real integration path or a faithful fake;
- no secrets printed in updater logs.

Add a package script such as:

```text
smoke:p226-update
```

Use the existing project naming/pattern instead if there is a better validated fit.

## 7. Regression gates

Minimum before commit/push:

```text
npm test
npm run check
npm run smoke:p225-limits
npm run smoke:p224-lifecycle
npm run smoke:p223-full
npm run smoke:p226-update
npm run verify:hook
```

Run additional focused gates only when the diff touches those systems.

Do not rerun the long Hunyuan3D reproduction.

## 8. Real Windows / Discord acceptance

Perform a short real-machine smoke; do not impersonate an owner click where impossible.

Required objective evidence:

1. start from an older live SHA or a controlled test candidate;
2. updater detects a newer configured remote SHA;
3. while a tiny Work is active, update stays PENDING and the Work finishes normally;
4. after idle, updater deploys and Supervisor restarts exactly one Bridge;
5. `/status` or equivalent runtime evidence shows the new running SHA;
6. Supervisor/Task Scheduler still own the correct live checkout;
7. Discord command definitions are fetched back and report `/work task max_length=6000`;
8. `/doctor` reports command schema sync PASS;
9. run one tiny Chat and one tiny Work after update;
10. Stop still kills one tiny Work in one press;
11. no duplicate Bridge/process tree remains.

If an owner-only UI action cannot be automated, mark only that narrow check `PENDING_OWNER`; do not call the whole task PASS without objective runtime/schema evidence.

## 9. Files/state/documentation

Update only what is needed. Expected areas may include:

- updater/update-state module(s);
- Supervisor/update helper scripts;
- config + `.env.example`;
- `src/discord-ui.mjs` / `src/commands.mjs` for `/update` and schema status;
- build/runtime identity integration;
- focused tests/smoke;
- `docs/WINDOWS_SMOKE.md`;
- `docs/CURRENT.md`;
- `docs/AI_HANDOFF.md`;
- `docs/tasks/CURRENT.md`.

At completion:

- mark P2.2.6 complete;
- add P2.2.6 baseline to the deferred release-merge task if needed;
- restore active task pointer to `docs/JARVIS_V4_P2_RELEASE_MERGE_TASK.md`;
- **do not execute PR #4/#5 merge in this same Worker**;
- do not start P3.

## 10. Stop condition

Stop immediately when:

- required deterministic tests pass;
- real runtime deploy/restart/schema evidence passes or only explicitly owner-only checks remain;
- changes are committed/pushed;
- remote HEAD is verified;
- state/handoff points back to Release Merge.

Do not continue with unrelated refactors.

## 11. Final Worker report

Return only:

```text
PASS / FAIL
commit: <sha or none>
update: <local->remote/apply/rollback/single-instance result>
schema: </work max_length + remote schema verification>
tests: <compact deterministic result>
real-smoke: <PASS | PENDING_OWNER | FAIL>
blocker: <none or one key blocker>
```
