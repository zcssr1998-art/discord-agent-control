# Jarvis V4 P2 — Daily UX + Chat Context + Attachments

## Goal

Turn the verified P0/P1 foundation into a Jarvis that is comfortable to use every day from Discord without memorizing commands.

P2 combines the previously planned Chat-context work with the owner's newly requested persistent control panel:

1. persistent button control panel
2. direct Work creation from the panel
3. Provider -> model switching for both Chat and Work
4. settings / permissions / status / stop / usage guide from the panel
5. bounded persistent Chat history
6. New Chat (`/new` / `!new` / panel button)
7. Compact Chat context (`/compact` / `!compact` / panel button)
8. Discord attachments for Chat and Work

P2 must preserve all P0/P0.5/P1 invariants: Chat/Work separation, LiteLLM primary + direct fallback, manual Chat pin no silent fallback, Work-thread isolation, workspace FIFO queue, real `!stop`, permission/approval semantics, and no surprise metered AUTO usage.

---

# 0. Scope and implementation order

Implement in this order so failures stay isolated:

- **P2A — Persistent Control Panel + Work launcher**
- **P2B — ChatHistoryStore + history-aware ChatRuntime**
- **P2C — New Chat + Compact**
- **P2D — Attachments**
- **P2E — real Discord smoke + evidence**

Do not start P2D until P2B/P2C deterministic tests are green.

Do not add SQLite/Redis/web dashboard/LLM router. JSON/JSONL/local files are sufficient for a single-user personal deployment.

---

# P2A — Persistent Control Panel

## A1. Entry point

Add:

```text
!panel
```

Jarvis sends one durable control-panel message. Use stable interaction custom IDs so an old panel remains usable after a bridge restart. No panel database/registry is required.

Best-effort pin the panel when Discord permits. Pin failure must not fail panel creation; reply once that the owner may pin it manually.

Main panel target:

```text
🤖 Jarvis Control Panel

Chat: AUTO / <actual if known>
Work: <executor> · <provider> · <model>
Permission: <level>
Workspace: <cwd>

[🛠 新建 Work] [🧠 换模型] [⚙️ 设置]
[🔐 权限] [🆕 新对话] [🧹 压缩上下文]
[📊 状态] [⛔ Stop] [📖 使用说明]
[🔄 刷新]
```

All panel interactions are OWNER-only. Rendering/selection buttons must not invoke ChatRuntime or start an Agent.

## A2. `🛠 新建 Work`

This is important: the owner should not need to remember `work <task>`.

Clicking `🛠 新建 Work` opens a Discord modal with one required multiline field:

```text
任务内容
```

On submit, reuse the **existing Work start path**, not a second implementation:

- normal guild parent channel -> create the existing permanent `🛠` Work thread and run there; parent remains Chat
- DM -> run inline because DMs cannot have threads
- permanent Work thread -> run in that same Work thread, never create nested threads
- busy/queued/blocked/permission/provider checks remain identical
- workspace FIFO still applies before Agent start

Do not add cwd/provider/model inputs to the modal. Those belong to Settings and the panel.

## A3. `🧠 换模型`

First level:

```text
[💬 Chat 模型]
[🛠 Work 模型]
[⬅️ 返回]
```

### Chat model selector

- `AUTO` shown first.
- AUTO reuses existing `setChatSelection(... providerId=auto ...)`.
- manual path is **Provider -> model**.
- exclude WorkBuddy-native-only providers from Chat.
- only show providers with usable credentials and allowed Chat billing semantics.
- manual Chat pin preserves current behavior: **no silent cross-model/provider fallback**.

### Work model selector

- path is **Provider -> model**.
- do not trap the UI on the current WorkBuddy provider's `fast-model`.
- Provider page shows credentialed providers compatible with the current executor.
- model page calls/reuses existing ModelManager list/cache logic for the chosen provider.
- selecting provider/model reuses existing SessionManager mutation rules; no second config store.
- changing Work provider/model keeps the existing safety behavior: new Agent session + permission reset where current text commands already do that.
- if a provider cannot list models automatically, show a clear manual-ID fallback instead of pretending the list is complete.

Respect Discord component limits. Paginate or fall back to existing `!models` / `!model` without building a new UI framework.

## A4. `⚙️ 设置`

Open the existing P1 `!settings` renderer and mutation handlers. Do not duplicate settings logic.

## A5. `🔐 权限`

Open the existing permission menu:

- strict
- standard
- relaxed
- full

`full` still requires explicit confirmation. OWNER/credential/timeout/stop protections remain active.

## A6. `📊 状态`

Show the same facts as `!status`, preferably by updating the current panel message or a concise interaction response:

- Chat route + last actual route/model
- Work executor/provider/model
- workspace
- Work queue/running state
- permission
- LiteLLM health when available

No LLM/Agent call.

## A7. `⛔ Stop`

Refactor/reuse one shared stop function so button Stop and `!stop` cannot drift.

Semantics stay exactly P1:

- queued -> cancel only that queued request
- active -> kill Agent process tree, cancel approvals, release task/workspace
- idle -> concise no-active-Agent response

## A8. `📖 使用说明`

Static/local help card, no model call. It must explain how to use Jarvis without assuming prior knowledge.

Minimum content:

```text
Chat = 普通问答，不启动 Agent
Work = Agent，可读写文件、执行 Shell、测试
```

How to create Work:

```text
服务器父频道：work <任务>
→ 自动创建 🛠 Work 线程，父频道继续 Chat

私聊：work <任务>
→ 私聊内直接运行 Work
```

Also document:

```text
work     -> 当前频道切到 Work，下一条普通消息作为任务
chat     -> 切回 Chat（永久 Work 线程里禁止切 Chat）
!cwd <绝对路径> -> 绑定项目目录
```

Quick start:

```text
1. 点 ⚙️ 设置：Work = Claude Code + OpenCode Go + deepseek-v4.1-flash
2. 点 🔐 权限：standard / relaxed
3. 点 🛠 新建 Work，直接输入任务
4. 在自动创建的 🛠 线程看进度
5. 要中止：点 ⛔ Stop 或 !stop
```

Also explain the new P2 controls:

- `🆕 新对话` clears Chat context only
- `🧹 压缩上下文` summarizes older Chat context to save tokens
- attachments: text/images can be Chat input; arbitrary project files are better sent to Work

Every submenu has `⬅️ 返回`; `🔄 刷新` returns to a freshly rendered main panel.

---

# P2B — Bounded persistent Chat history

## B1. Why

Current ChatRuntime is stateless: every ordinary Chat message is sent as one isolated prompt. P2 adds channel-scoped continuity without contaminating Work Agent sessions.

## B2. New ChatHistoryStore

Add a small dedicated module, e.g.:

```text
src/chat-history.mjs
```

Persist under ignored runtime data, e.g.:

```text
data/chat-history.json
```

or an equally simple per-channel JSON/JSONL layout. Do not use SQLite.

Requirements:

- history is keyed by Discord channel/thread ID
- Chat history is separate from Work/Agent `sessionId`
- survives bridge restart
- atomic/best-effort-safe writes; malformed/BOM data must not silently reset unrelated channels
- schema/version field if useful
- never store API keys/tokens/secrets
- do not store giant binary attachment bodies

## B3. Bounded context

Do not replay an unbounded Discord transcript into every model call.

Use a simple bounded policy without adding a tokenizer dependency. Recommended default envelope:

- roughly 20 turns / 40 role messages maximum
- roughly 48k-64k characters maximum before local trimming/compaction is required
- keep the newest messages first; never exceed a hard context cap

Make constants configurable in code/env if trivial, but do not build a settings UI for every number.

## B4. ChatRuntime messages

Extend ChatRuntime so it can accept a history/message array while preserving backward compatibility with the current single `prompt` API.

For a Chat turn:

1. load existing Chat history
2. build provider request with history + current user turn
3. run the existing AUTO/manual route logic
4. only after a successful final response, append **one** user turn + **one** assistant turn to history
5. failed provider attempts/fallback retries must not duplicate the user turn in history

Transport mapping must remain correct for:

- OpenAI Chat Completions
- OpenAI Responses where used
- Anthropic Messages
- LiteLLM aliases
- OpenCode Go special transports

Do not let Chat history start/get an Agent runner.

## B5. Selection changes

Changing Chat provider/model does **not** erase Chat history. `New Chat` is the explicit boundary.

Changing Work provider/model continues to affect only Work Agent state.

---

# P2C — New Chat and Compact

## C1. New Chat

Support from the panel (`🆕 新对话`) and command aliases:

```text
!new
/new
```

If native Discord application-command registration is easy and compatible with the existing bot installation, register `/new`; otherwise the panel + `!new` are mandatory and `/new` may remain a parsed text alias when Discord delivers it. Do not turn P2 into a slash-command framework migration.

Semantics:

- clear only current channel's Chat history/summary
- clear last-actual Chat attribution if appropriate
- preserve Chat route/model selection
- preserve Work provider/model/workspace config
- do not stop unrelated Work threads
- permanent Work thread: refuse with “这是 Work 线程；新对话请在父频道 Chat 使用”

No model call.

## C2. Compact

Support from the panel (`🧹 压缩上下文`) and:

```text
!compact
/compact
```

Compact is explicit: **do not add surprise background summarization calls.**

Behavior:

- if history is already small, report “无需压缩” and do nothing
- summarize older history through the current Chat route/model (AUTO respects existing fallback/billing policy; manual pin remains manual)
- keep a small recent tail verbatim (e.g. last 4-6 role messages)
- persist a concise summary plus recent tail
- future Chat turns include the summary as context before the recent tail
- report a compact result such as `20 turns -> summary + 3 recent turns`, not a huge transcript
- if summarization fails, leave original history intact

Hard-cap protection may locally trim oldest context to prevent oversized calls, but it must not trigger an unrequested LLM summarization.

## C3. Compact prompt quality

Summary should preserve durable facts useful for future dialogue:

- user goal/intent
- decisions already made
- important constraints
- unresolved questions
- referenced file names/attachment facts

Do not preserve verbose greetings, repeated assistant prose, or raw tool logs.

---

# P2D — Discord attachments

## D1. General security

Never trust attachment names/URLs blindly.

- accept only HTTPS Discord attachment/CDN URLs from the real Discord message attachment object
- sanitize filenames; no `..`, absolute path escape, or control characters
- bounded file count/size; fail clearly when over limit
- never auto-execute an attachment
- never log attachment bodies or secrets
- runtime attachment directories are ignored by git

A practical default is max 10 attachments and max ~25 MB per attachment for Work; Chat may use tighter text/image limits. Exact constants can be conservative.

## D2. Work attachments

This is the most important attachment path because Agents can inspect arbitrary project files.

When a Work task includes Discord attachments:

1. download them before Agent start into a safe runtime inbox, e.g.
   `data/inbox/<channel-id>/<message-id>/...`
2. keep workspace locking semantics unchanged
3. prepend/append a concise attachment manifest to the Agent task with local file paths
4. Agent decides how to read/use them; Jarvis does not execute them
5. later messages in the same Work thread may add more attachments
6. clean old inbox directories with a simple TTL/startup cleanup (e.g. 24-72h) without deleting currently referenced files during an active task

This must work with both `work <task>` and the new `🛠 新建 Work` modal flow.

## D3. Chat text attachments

Support safe bounded text-like attachments in Chat:

- `.txt`, `.md`, `.json`, `.csv`, `.log`, source-code/plain-text MIME where decoding is safe
- read UTF-8 text with a strict per-file/total character cap
- include filename + bounded content in the current user turn
- history may retain bounded extracted text/metadata, never an unbounded original file

If a file is binary/unsupported, tell the user to use Work instead of silently ignoring it.

## D4. Chat image attachments

Support common image types at minimum:

- PNG
- JPEG
- WEBP

Extend ChatRuntime message content so image-bearing turns can be expressed in the provider transport:

- OpenAI Chat-style multimodal content
- Anthropic image blocks when that transport is used
- LiteLLM path compatible with its upstream vision route

For AUTO image turns, prefer the configured LiteLLM `vision` alias if available rather than sending an image to known text-only `chat-fast` blindly. If no usable image-capable route exists, return a clear error and do not drop the image.

For a manually pinned Chat model, preserve manual-pin semantics: try the pinned route/model only; if it does not support the image, fail clearly rather than silently changing models.

Do not persist large base64 image bodies in Chat history. Persist only attachment metadata and any concise textual description returned by the model/compact summary.

## D5. Attachment + fallback correctness

A provider retry/fallback must reuse the same logical user turn/attachments without:

- redownloading the same attachment for every candidate
- duplicating history
- adding duplicate user messages

Download/normalize once, then route.

---

# P2E — Tests and real smoke

## E1. Deterministic tests

Add focused tests for at least:

### Control panel

1. `!panel` renders persistent main controls without ChatRuntime/Agent.
2. buttons include New Work, model, settings, permission, New Chat, Compact, status, Stop, help.
3. old panel stable custom IDs still work after recreating DiscordControlPlane (restart simulation).
4. `🛠 新建 Work` modal submit reuses existing guild-thread/DM Work behavior.
5. Chat model selector has AUTO + Provider -> model.
6. Work model selector can reach OpenCode Go models even when current provider is WorkBuddy.
7. settings/permission reuse existing flows.
8. panel Stop == `!stop` for queued + active.
9. usage guide is local/static and explains Work creation.

### Chat history

10. successful consecutive Chat turns send prior context.
11. history survives ChatHistoryStore reload/restart.
12. fallback retries do not duplicate a user turn.
13. manual Chat pin still never cross-falls-back.
14. Work messages never enter Chat history.
15. bounded history does not grow indefinitely.

### New / Compact

16. New Chat clears only Chat context, preserving model/work config.
17. New Chat is refused in permanent Work thread.
18. Compact keeps recent tail + summary and reduces replay size.
19. failed compact leaves original history unchanged.
20. Compact does not start an Agent.

### Attachments

21. Work attachment is downloaded once to safe inbox and task receives local path manifest.
22. filename traversal is sanitized/rejected.
23. unsupported/binary Chat attachment is not silently ignored.
24. text Chat attachment content is bounded and included in the turn.
25. image Chat turn builds correct multimodal payload for at least the supported OpenAI/LiteLLM path; Anthropic mapping gets a unit test if implemented.
26. attachment fallback does not duplicate history or downloads.

Run all existing P0/P0.5/P1 tests unchanged.

## E2. Real Discord smoke

Use a disposable workspace and the real bot. Minimum human smoke:

1. `!panel`, pin or manually pin it.
2. restart bridge; click old panel `刷新` and confirm it still works.
3. click `📖 使用说明`.
4. panel -> Work model -> OpenCode Go -> `deepseek-v4.1-flash`.
5. panel -> Chat model -> AUTO.
6. panel -> `🛠 新建 Work`, submit a tiny disposable file task; guild parent should create a Work thread.
7. panel -> Stop an active disposable Work task.
8. Chat: send two related messages; second answer must use first-turn context.
9. New Chat; verify the next Chat turn no longer has prior context.
10. create enough Chat context; Compact; verify continuity remains with shorter stored context.
11. send one small text attachment in Chat and verify it is understood.
12. send one small image in Chat through a configured vision route and verify it is understood, or record a precise blocker if the account has no image-capable route.
13. send one file to a disposable Work task and verify Agent reads the downloaded local file.

Do not invent PASS evidence. If a real vision route is unavailable, all deterministic tests may pass but record `PENDING_REAL_VISION_SMOKE` rather than faking it.

---

# Token / execution discipline

Follow the repo's normal AI-development rules:

- read task/current/handoff + relevant diff, not the entire repo repeatedly
- reuse existing SessionManager, PermissionManager, ModelManager, ChatRuntime routing and P1 Work start/stop paths
- targeted tests during implementation, full suite at milestones
- raw logs to files; model sees only failures/tails
- no repeated long progress narration
- if two attempts produce the same error with no new code/environment change, stop grinding and escalate/document blocker

---

# Delivery

Update before final delivery:

- `docs/CURRENT.md`
- `docs/AI_HANDOFF.md`
- `docs/tasks/CURRENT.md`
- add concise `docs/V4_P2_SMOKE.md` with deterministic + real evidence

Commit + push to:

```text
jarvis-v4-p2-control-context
```

Do not merge to `main` until final review.

Final worker chat response only:

```text
PASS/FAIL
commit: <sha>
tests: <summary>
real-smoke: <summary>
blocker: <none|reason>
```
