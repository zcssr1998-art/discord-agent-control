# Current project state

## Branch

`openclaw-native-bootstrap`

## Current task

`docs/tasks/OPENCLAW_NATIVE_BOOTSTRAP.md`

Install and verify upstream OpenClaw `v2026.9.4` on the real Windows machine as a side-by-side
native product. This phase is installation only.

## Preserved self-built Jarvis

The pre-OpenClaw implementation remains intact on `main` and is frozen at commit
`fc984954cc83e4d3ee5b305b5de2717b13adffda` on:

`archive/self-built-jarvis-pre-openclaw-20260918`

Do not delete, rewrite, stop, or migrate that runtime during this task.

## Scope boundary

Do not onboard OpenClaw, move the Discord bot, configure providers/models, import memory, or add
Jarvis-specific OpenClaw plugins in this phase.

## Acceptance

Real Windows execution must prove:

- `npm run openclaw:install` exits 0;
- `npm run openclaw:verify` prints PASS and OpenClaw `2026.9.4`;
- `npm test` passes;
- `npm run check` passes;
- existing Jarvis remains available;
- no secrets enter git.

Stop after those gates pass.
