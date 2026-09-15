# Jarvis V4 P1 — evidence

Companion to `docs/V4_SMOKE.md` (P0/P0.5). This file records what was actually
executed and observed for P1 (workspace lock/queue, Work threads, settings UX).

No token, secret or credential value is recorded here.

## 1. Automated regression

```text
npm test      -> 194 passed / 0 failed
npm run check -> checked 76 file(s), 0 failed
```

New P1 coverage:

| Test file | Covers |
| --- | --- |
| `tests/workspace-scheduler.test.mjs` | one active task per canonical workspace; Windows case/trailing-separator collision; different workspaces in parallel; FIFO; release on success and failure; active hold until stop path; queued cancel; no runner before lock acquisition; snapshot |
| `tests/v4-p1-queue.test.mjs` | same-workspace second channel queues and starts no runner; queued `!stop` removes only the queued request; different workspaces overlap; `!status` shows `queued (#N)` |
| `tests/v4-p1-threads.test.mjs` | `work <task>` creates exactly one thread and leaves the parent Chat; thread has its own session and continues it; parent Chats while thread Work runs; `chat` in a Work thread refused; no nested thread; DM Work inline; thread-create failure starts nothing; thread inherits Work defaults + permission |
| `tests/v4-p1-settings.test.mjs` | `!settings` renders Chat + Work state; controls reuse the same persisted mutations as the text commands; no runner / no ChatRuntime call; running-task safety; queue state; Work thread cannot be flipped to Chat via settings |

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

## 6. Explicitly pending — real Discord network

These require the human owner in a **real** Discord client and cannot be
self-driven by the bridge (it ignores bot-authored messages by design):

- `PENDING_REAL_MULTI_CHANNEL_SMOKE` — two real Discord contexts against one
  workspace (the transport-faked machine smoke above covers the same behaviour
  with real Agent processes; the deterministic tests are the hard gate).
- `PENDING_REAL_GUILD_THREAD_SMOKE` — `work <task>` creating a real Discord guild
  thread. The thread path is exercised end-to-end against the real control plane
  and a real Agent in `smoke:p1` Phase 1; only Discord's own thread API hop is
  unverified on the wire.

## 7. P0/P0.5 invariants

Not regressed: default Chat, ordinary Chat never starts an Agent, LiteLLM primary
+ OpenCode Go direct fallback, fallback/cooldown attribution, manual Chat pin
never falls back, Work permissions/approval fail closed, real `!stop`
process-tree kill, no stale-hook 401, AUTO never silently spends METERED.
