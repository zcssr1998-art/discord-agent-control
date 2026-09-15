# Jarvis V4 P1 — evidence

Companion to `docs/V4_SMOKE.md` (P0/P0.5). This file records what was actually
executed and observed for P1 (workspace lock/queue, Work threads, settings UX).

No token, secret or credential value is recorded here.

## 1. Automated regression

```text
npm test      -> 195 passed / 0 failed
npm run check -> checked 76 file(s), 0 failed
```

New P1 coverage:

| Test file | Covers |
| --- | --- |
| `tests/workspace-scheduler.test.mjs` | one active task per canonical workspace; Windows case/trailing-separator collision; different workspaces in parallel; FIFO; release on success and failure; active hold until stop path; queued cancel; no runner before lock acquisition; snapshot |
| `tests/v4-p1-queue.test.mjs` | same-workspace second channel queues and starts no runner; queued `!stop` removes only the queued request; different workspaces overlap; `!status` shows `queued (#N)` |
| `tests/v4-p1-threads.test.mjs` | `work <task>` creates exactly one thread and leaves the parent Chat; thread has its own session and continues it; parent Chats while thread Work runs; `chat` in a Work thread refused; no nested thread; DM Work inline; thread-create failure starts nothing; thread inherits Work defaults + permission |
| `tests/v4-p1-settings.test.mjs` | `!settings` renders Chat + Work state; controls reuse the same persisted mutations as the text commands; no runner / no ChatRuntime call; running-task safety; queue state; Work thread cannot be flipped to Chat via settings |
| `tests/state-mode.test.mjs` | a UTF-8 BOM in `state.json` does not silently reset every channel to Chat defaults (regression test for the real-Discord finding below) |

P0/P0.5 invariants still covered by the unchanged suites: default Chat, `你好`
never creates a runner, local mode commands, LiteLLM-first AUTO + direct OpenCode
Go fallback, cooldown/fallback attribution, manual-pin no-fallback, WorkBuddy
quota cannot block Chat, Work permissions/approval, real `!stop` process-tree
kill, LiteLLM health failure non-fatal.

## 2. Real-machine P1 smoke — `npm run smoke:p1` (20/20)

`scripts/p1-e2e.mjs` drives the **real** `DiscordControlPlane`, the **real**
`WorkspaceScheduler`, the **real** `ExecutorManager` + local Anthropic↔OpenAI
adapter + Claude Code CLI against OpenCode Go (`deepseek-v4.1-flash`), a **real**
PreToolUse hook server, and **real** files/git. Only the Discord transport is
faked (`tests/helpers/fake-discord.mjs`), because the bridge deliberately ignores
bot-authored messages and therefore cannot send as the human owner.

```text
[executor] workbuddy=PASS 2.1.270 (Claude Code)
[executor] claude=PASS 2.1.270 (Claude Code)

Phase 1 — Work thread
[work-thread] created thread=thread-2 parent=chan-1
[task] start channel=thread-2 prompt=Create p1-ok.txt ... reply DONE
[task] done  channel=thread-2 state=DONE tools=2 durationMs=10758
PASS W1..W6 (thread created, parent stayed Chat, permanent Work thread,
     real Agent DONE in 10.1s, session bound, p1-ok.txt = P1_WORK_OK)

Phase 2 — Workspace queue (two channels, same cwd)
[task] start channel=chan-1 prompt=Read README.md ... reply FIRST
PASS Q1 running / Q2 chan-2 queued / Q3 no runner+no task for chan-2
PASS Q4 only chan-1 started a real Agent ["chan-1"]
PASS Q5 Workspace busy notice on chan-2
[task] done channel=chan-1 state=DONE tools=1 durationMs=7154
[task] start channel=chan-2 prompt=Create p1-second.txt ... reply DONE
PASS Q6 queued task started after release ["chan-1","chan-2"]
PASS Q7 second real Agent wrote p1-second.txt = SECOND

Phase 3 — Cancel semantics
PASS C1 chan-2 queued
PASS C2 queued !stop removed only the queued request (chan-2 idle)
PASS C3 active owner still running
PASS C4 queued cancellation notice
[task] cancelled channel=chan-1 reason=stopped by owner (!stop)
PASS C5 active !stop killed the real process tree
PASS C6 cancelled queued task never started an Agent ["chan-1"]
PASS C7 cancelled task wrote no file

=== summary: 20/20 passed ===
```

After the run: no `claude` process survived (`stopAll` reaped every tree).

## 3. Real Chat through the live LiteLLM gateway

Production `ChatRuntime` + `ProviderManager` against the running gateway
(`http://127.0.0.1:4000`, health `I'm alive!`):

```text
gateway health: {"ok":true,"detail":"healthy"}
{
  "providerId": "litellm",
  "model": "chat-fast",
  "upstreamModel": "opencode-go/deepseek-v4.1-flash",
  "fallback": false,
  "attempts": [],
  "durationMs": 2165,
  "text": "好的"
}
```

Chat primary route is intact: LiteLLM `chat-fast` → OpenCode Go, 2.2 s, first
safe route, no Agent.

## 4. Real Work smoke regression (Agent path unchanged)

`npm run verify:claude-opencode-chat` (Claude Code → local adapter → OpenCode Go
openai-chat, real tools): **16/16 passed** — Write/Read/Bash ran, `git status`
saw the file, upstream model field not swapped, STANDARD permissions needed no
prompt.

## 5. Environment blocker hit during real smoke (not a P1 regression)

`npm run smoke:discord` (WorkBuddy backend) failed its task because the WorkBuddy
account is out of quota. The agent CLI returned:

```text
429 Credits exhausted ...  (code 14018, category quota)
[task] done channel=chan-42 state=FAILED durationMs=96521
```

The bridge correctly surfaced `❌ 执行失败` instead of a silent success and never
crashed or left the channel stuck. This is the documented WorkBuddy quota limit,
not a P1 change.

## 6. Real Discord network smoke — PASS

Executed by the human owner in the real guild `Time`
(`1033760246755237899`), bridge `Jarvis.#8605` (pid 7956), real channels:

```text
#jarvis-p1-a  1549436553565044836  (guild text)
#jarvis-p1-b  1549436585739681843  (guild text)
Work thread   1549440915679092978  (parent #jarvis-p1-a)
workspace     D:\jarvis-p1-smoke   (disposable, git repo, slow npm test ~120s)
```

Live routing was verified from the running bridge's own startup log (not from the
file on disk):

```text
[state] channel=1549436553565044836 mode=work executor=claude provider=opencode-go model=deepseek-v4.1-flash cwd=D:\jarvis-p1-smoke
[state] channel=1549436585739681843 mode=work executor=claude provider=opencode-go model=deepseek-v4.1-flash cwd=D:\jarvis-p1-smoke
[state] channel=1549440915679092978 mode=work executor=claude provider=opencode-go model=deepseek-v4.1-flash cwd=D:\jarvis-p1-smoke workThread=parent:1549436553565044836
```

### A. same-workspace queue — PASS

`#jarvis-p1-a` started a real Agent task; `#jarvis-p1-b` was submitted seconds
later against the same `D:\jarvis-p1-smoke`.

```text
[queue] start channel=1549436553565044836 workspace=d:\jarvis-p1-smoke
[task] start channel=1549436553565044836 cwd=D:\jarvis-p1-smoke prompt=Run the shell command npm test ...
[queue] queued channel=1549436585739681843 workspace=D:\jarvis-p1-smoke position=1 active=1549436553565044836
[task] done  channel=1549436553565044836 state=DONE tools=2 durationMs=131356 tests=运行...
[queue] start channel=1549436585739681843 workspace=d:\jarvis-p1-smoke
[task] start channel=1549436585739681843 cwd=D:\jarvis-p1-smoke prompt=Create a file named p1-b.txt ...
[task] done  channel=1549436585739681843 state=DONE tools=1 durationMs=6529
```

- `#jarvis-p1-b` replied `⏳ Workspace busy: D:\jarvis-p1-smoke / Queue position: 1
  / Active task: #jarvis-p1-a` and started no Agent while A ran.
- B's real Agent (`claude.exe` 45312) first appears in the process-tree timeline
  at `23:39:55`, exactly when A finished; A's agent (`claude.exe` 48808) was the
  only active agent during the 131 s window.
- `D:\jarvis-p1-smoke\p1-b.txt` = `SECOND`.
- No `[chat] done` line exists for B: it never fell back to Chat.

### B. thread real Work + session continuation — PASS

```text
[queue] start channel=1549440915679092978 workspace=d:\jarvis-p1-smoke
[task] start channel=1549440915679092978 cwd=D:\jarvis-p1-smoke prompt=Create a file named p1-thread.txt ...
[task] done  channel=1549440915679092978 state=DONE tools=2 durationMs=8539
[queue] start channel=1549440915679092978 workspace=d:\jarvis-p1-smoke
[task] start channel=1549440915679092978 cwd=D:\jarvis-p1-smoke prompt=Reply with only THREAD_CONTINUE ...
[task] done  channel=1549440915679092978 state=DONE tools=0 durationMs=7369
```

- The thread ran a real `claude` + `deepseek-v4.1-flash` Agent (no WorkBuddy
  quota error) and created `D:\jarvis-p1-smoke\p1-thread.txt` = `THREAD_OK`.
- Thread `${sessionId}` bound: `5b3d752f-00bf-457e-912a-6a344b086725`; the second
  message continued the same session and reported the filename from the previous
  turn (`THREAD_CONTINUE ... p1-thread.txt`).
- Earlier real-Discord checks already passed and were not repeated: thread
  creation, parent stays Chat, parent Chat (`你好` via LiteLLM), and `chat`
  inside the Work thread refused with `这是 Work 线程。请到父频道使用 Chat。`

### Bug found by the real Discord smoke (fixed)

The first attempt showed `#jarvis-p1-b` answering as Chat and the thread using
WorkBuddy. Root cause: `data/state.json` had been written by Windows PowerShell
`Set-Content -Encoding UTF8`, which prepends a **UTF-8 BOM**; `JSON.parse` threw
and `StateStore` silently fell back to empty state, so every channel loaded the
Chat/WorkBuddy defaults. Fix: `StateStore.load()` strips a leading BOM, the
bridge now logs the effective per-channel routing on startup, and a regression
test (`tests/state-mode.test.mjs`) proves a BOM no longer resets channels.

## 7. P0/P0.5 invariants

Not regressed: default Chat, ordinary Chat never starts an Agent, LiteLLM primary
+ OpenCode Go direct fallback, fallback/cooldown attribution, manual Chat pin
never falls back, Work permissions/approval fail closed, real `!stop`
process-tree kill, no stale-hook 401, AUTO never silently spends METERED.
