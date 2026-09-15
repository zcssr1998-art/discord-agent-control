# Jarvis development workflow overlay

Cross-project workflow and Token/context-efficiency rules are defined in:

`https://github.com/zcssr1998-art/AI-Development-Rules/blob/main/GLOBAL_AI_RULES.md`

This file contains only Jarvis-specific workflow state and overrides.

## Project source-of-truth files

Read after `AGENTS.md` + global rules:

1. `docs/CURRENT.md` — current branch/milestone/status and next action.
2. `docs/AI_HANDOFF.md` — compact handoff only when it adds information not already in `CURRENT.md`.
3. `docs/tasks/CURRENT.md` — pointer to the active task specification.
4. active task file.
5. relevant diff/files only.

Do not make `CURRENT.md` and `AI_HANDOFF.md` duplicate the same state. Consolidate if redundancy grows.

## Jarvis task lifecycle

1. Architect/reviewer defines goal, constraints, non-goals, acceptance checks, and reusable upstream references in the repository task file.
2. `docs/tasks/CURRENT.md` points to the active task.
3. Compact current state is updated.
4. Worker pulls latest branch state and executes the active task rather than generating a second plan.
5. Worker runs deterministic verification and fixes ordinary failures locally.
6. Windows/Discord real-machine smoke is required where the task changes routing, process control, permissions, networking, or Agent execution.
7. Worker updates compact state, commits, and pushes.
8. Reviewer inspects task criteria + diff + verification evidence directly from GitHub.

## Jarvis-specific evidence

When relevant, capture only the high-information evidence needed for review:

- Chat mode used;
- actual provider/model;
- end-to-end latency;
- fallback path actually exercised;
- whether an Agent child process was or was not created;
- Work/Agent runner used;
- cancel/stop result;
- Windows/Discord smoke result;
- exact blocker when real-machine verification cannot be completed.

Detailed logs belong in repository logs/docs or local ignored artifacts, not chat.

## Worker completion contract

Use the global concise completion format:

```text
PASS | FAIL
commit: <sha or none>
tests: <compact result>
blocker: <none or one-line blocker>
```

Jarvis may add one compact line for actual model/latency or Windows smoke when material to the task.

## Review contract

Reviewer should normally inspect:

1. active task acceptance criteria;
2. commit/diff;
3. automated tests/checks;
4. Windows/Discord smoke evidence when required;
5. only then expand into wider code if correctness/risk requires it.

Do not ask the Worker to restate the implementation in prose before review.
