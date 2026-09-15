# Current project state

Keep this file compact. It is the first project-state file a new worker should read.

## Branch

`jarvis-v4-foundation`

## Milestone

Jarvis V4 — default Chat + explicit Work + provider/agent decoupling.

## Current status

V4 foundation exists and is under Draft PR #2.

Implemented foundation:
- deterministic local Chat/Work mode parsing
- separate Chat vs Work persistent state
- direct ChatRuntime compatibility path
- provider health/circuit-breaker/cooldown
- safe AUTO fallback behavior
- initial V4 architecture and task specification
- LiteLLM promoted to the standard gateway target for normal providers, with OpenCode Go kept as a compatibility-sensitive path until real Windows smoke testing proves the gateway route

## Current task

See `docs/tasks/CURRENT.md`.

## Next action

Wire the V4 Chat path into the live Discord message flow, install/integrate LiteLLM per the active task, and complete real Windows/Discord smoke tests before merge.

## Acceptance gate

Do not merge the V4 PR until:
- ordinary Chat cannot enter an Agent runtime
- local mode/model controls cannot be interpreted as WorkBuddy prompts
- a healthy fallback model can answer when the preferred Chat model/provider is unavailable
- Work behavior/permissions/real stop semantics do not regress
- Windows/Discord smoke evidence exists
