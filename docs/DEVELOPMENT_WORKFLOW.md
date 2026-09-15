# Token-efficient agent development workflow

This repository is the source of truth for development work. Chat is a control plane, not a place to duplicate project state, long taskbooks, logs, or handoff summaries.

## Roles

- **User**: states goals, constraints, priorities and approves outcomes.
- **Architect/reviewer model**: clarifies the goal, inspects reusable upstream work, defines architecture and acceptance criteria, writes/updates repository task files, and reviews diffs/results.
- **Worker model**: implements the current task, runs tests, fixes ordinary failures, commits and pushes.
- **Deterministic tools/tests**: decide pass/fail whenever possible. A model should not replace an exit code, assertion, lint result or smoke-test result with prose judgment.

## Source-of-truth files

Read in this order unless the current task says otherwise:

1. `AGENTS.md` — stable repository rules only.
2. `docs/CURRENT.md` — current branch/milestone/status and next action.
3. `docs/AI_HANDOFF.md` — compact handoff from the previous worker.
4. `docs/tasks/CURRENT.md` — pointer to the active detailed task specification.
5. Only then inspect the minimum code/docs required for the task.

Do not rescan the whole repository by default.

## Task lifecycle

1. Architect/reviewer writes the full specification into the repository, including goal, constraints, non-goals and acceptance tests.
2. `docs/tasks/CURRENT.md` points to that specification.
3. `docs/CURRENT.md` and `docs/AI_HANDOFF.md` are updated with compact current state.
4. Worker reads the four source-of-truth files above and starts execution. Do not rewrite the task into a new plan unless a material contradiction is found.
5. Worker uses targeted search/diff/file reads instead of broad repository rereads.
6. Worker runs deterministic verification. Fix ordinary failures locally before escalating.
7. On completion, worker updates `docs/CURRENT.md` and `docs/AI_HANDOFF.md`, commits and pushes.
8. Final chat response is short. Architect/reviewer inspects commit/diff and verification evidence directly from the repository.

## Token-efficiency rules

- Do not paste long taskbooks into chat if they can live in the repository.
- Do not repeat project history that is already in `CURRENT.md` or `AI_HANDOFF.md`.
- Do not generate a second long implementation plan after an approved task specification already exists.
- Do not read the whole repo by default. Start from the current task, `git diff`, `git status`, targeted `rg`/search, and only the relevant files.
- Do not dump full logs into model context. First reduce them to failed command, exit code, relevant stack/error lines, and a short tail/context window. Expand only if necessary.
- Do not narrate successful deterministic steps. `PASS` is enough when the test already proves the result.
- Do not re-run a long task solely because the chat request timed out. Check process/job/session state first.
- Reuse the current agent session for follow-up work when safe; avoid paying context-recovery cost repeatedly.
- Keep stable instructions stable. Put temporary requirements in task files rather than bloating `AGENTS.md`.
- Prefer small patches/diffs over rewriting full files when the change is local.
- Search GitHub/upstream implementations before building a subsystem from scratch. Reuse the smallest proven component/pattern that fits.
- If a cheap worker can solve an implementation/debug task, do not escalate to an expensive model. Escalate only for architecture, unresolved hard debugging, high-risk changes or review.

## Logs and evidence

Detailed logs, benchmark output, debugging notes and smoke-test evidence belong in repository files under `docs/` or `logs/` (gitignored when appropriate), not in chat.

When a command fails, record only the high-information subset for model review:

```text
command
exit code
primary error/stack
relevant log tail
reproduction notes
```

## Worker final response contract

Default final response must be no longer than necessary and use this shape:

```text
PASS | FAIL
commit: <sha or none>
tests: <summary>
blocker: <none or one-line blocker>
```

Do not provide a chronological narrative of what was done unless explicitly requested.

## Handoff contract

Before stopping or switching models, update `docs/AI_HANDOFF.md` with only:

- current task
- branch
- last known good commit
- done
- pending
- blocker
- next action
- exact verification command(s)
- minimal relevant files

The handoff should allow a new model to resume without reading old chat transcripts.

## Review contract

The reviewer should normally inspect:

1. current task acceptance criteria
2. commit/diff
3. test/smoke summary
4. only the code needed to evaluate correctness or risk

Do not ask the worker to restate the entire implementation in prose before review.
