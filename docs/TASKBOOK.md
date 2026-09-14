# Discord Agent Control — Development Taskbook

## 1. Real goal

Turn an iPhone Discord client into the remote control plane for the user's Windows development machine:

`iPhone Discord -> local Windows bridge -> Claude Code (existing DeepSeek provider) -> real file/tool execution -> live progress -> remote approvals -> final result back to Discord`.

Codex is a **fallback/escalation path**, not a mandatory hop. ChatGPT online is a **planner/reviewer** for non-agent work; ChatGPT Plus chat is not an externally invokable API, so V1 uses manual handoff rather than brittle browser automation.

## 2. Existing assets to preserve

- Windows Claude Code is already configured to route through DeepSeek via user-level environment variables.
- Existing Claude Code executable is expected to be `claude`/`claude.cmd`; bridge inherits the same environment instead of duplicating API/provider config.
- DeepSeek remains the default executor. Do not route to Codex merely because it is available.
- Codex Plus is reserved for hard failures, compatibility issues, or explicit user escalation.
- ChatGPT online is used for architecture, research, task decomposition, review, and generating handoff instructions.

## 3. MVP acceptance criteria

1. Owner sends a normal Discord DM/message from iPhone.
2. Windows launches/reuses local Claude Code in the bound project directory.
3. The existing DeepSeek-backed Claude Code performs real reads/edits/tests.
4. Discord receives live tool/progress updates without log spam.
5. Read-only operations and normal in-workspace edits proceed automatically.
6. Risky shell/network/destructive/sensitive-file actions pause and send Discord buttons: Allow once / Allow session / Deny.
7. Approval from iPhone unblocks the exact Claude tool call.
8. `!stop`, `!reset`, `!status`, and `!cwd <absolute path>` work.
9. Only the configured Discord owner can execute tasks or approve actions.
10. Approval bridge fails closed for bridge-launched sessions; ordinary local Claude Code remains unaffected.

## 4. Security model

- Discord owner allowlist is mandatory.
- Optional guild/channel allowlist.
- Claude Code is launched with bypass permissions only for bridge sessions, but **PreToolUse hook still gates every tool call**.
- Global hook activates only when `DISCORD_BRIDGE_ACTIVE=1` is injected by this bridge.
- Hook client talks only to `127.0.0.1` with a local secret file.
- If approval service is unreachable, the hook denies the tool call rather than allowing it.
- Sensitive files (`.env`, SSH keys, credentials) always require approval.
- Git push, destructive shell commands, network/install/publish actions require approval.

## 5. Why this architecture

Claude Code officially supports `PreToolUse` hooks in non-interactive `-p` mode. This avoids trying to scrape terminal permission prompts. A command hook can call the local bridge, wait for a Discord button decision, then return a structured `permissionDecision` to Claude Code. This is more robust than UI automation and does not depend on the existing WebUI implementation.

## 6. Phase plan

### Phase 1 — DeepSeek Claude Code control plane (current)
- Discord transport
- Persistent channel session
- Stream-json progress
- project cwd binding
- remote approval gate
- Windows setup script
- local tests

### Phase 2 — Codex fallback
Only after Phase 1 passes on the real Windows host:
- add adapter interface
- authenticate through existing Codex/ChatGPT Plus local login
- `/agent codex` or button-based escalation
- preserve project cwd and handoff context
- reuse Discord approval UI where Codex app-server exposes approval events

### Phase 3 — ChatGPT handoff
No browser automation. Add a command that writes/returns a compact handoff package containing objective, current failure, changed files, git diff summary, tests, and open question. User pastes that into ChatGPT online, then returns the answer to the worker if needed.

## 7. Non-goals for MVP

- multi-user tenancy
- cloud server
- public web dashboard
- database beyond a small local JSON state file
- voice/image/music features
- auto-switching to Codex without a concrete failure signal
- invoking ChatGPT Plus chat through unofficial browser automation

## 8. Definition of done

A real Windows smoke test must prove: Discord phone message -> local DeepSeek Claude Code edits a disposable test repo -> runs a test -> Discord shows progress -> a deliberately risky command triggers phone approval -> allow executes / deny blocks -> final result returns to Discord.
