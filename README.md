# Discord Agent Control

Windows-first Discord control plane for a local Claude Code agent.

Primary target:

`iPhone Discord → Windows bridge → existing DeepSeek-backed Claude Code → real project execution → phone approval for risky actions → result back to Discord`

DeepSeek Claude Code is the default executor. Codex is an optional later escalation path, not part of the required V1 loop.

## Start here

- **Gemini 3.8 implementation task:** `docs/GEMINI_3_8_TASK.md`
- Windows setup: `docs/WINDOWS_SETUP.md`
- Original Chinese design brief: `docs/开发任务书.md`
- Architecture/task notes: `docs/TASKBOOK.md`

## Baseline verification

Before upload, the current codebase was run locally with:

```text
npm test       -> 10 passed / 0 failed
npm run check  -> passed
```

The remaining critical acceptance test is the real Windows/iPhone Discord end-to-end loop described in `docs/GEMINI_3_8_TASK.md`.
