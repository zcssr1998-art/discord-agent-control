# Agent instructions

Primary execution spec: `docs/GEMINI_3_8_TASK.md`.

Principles:
- Do not rewrite from scratch; inspect and extend the existing implementation.
- Default executor is the user's existing DeepSeek-backed Claude Code.
- Codex is optional fallback only after the DeepSeek V1 works.
- Reuse the user's existing Claude/DeepSeek environment; do not create a second provider configuration unless required by an observed incompatibility.
- Run real tests. The task is not done until the Windows Discord -> Claude Code -> tool execution -> phone approval -> result loop is proven on a disposable repo.
- Keep chat reports short; persist detailed debugging/results in this repository.
- Never commit secrets.
