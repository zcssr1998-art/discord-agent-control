# Jarvis V4 — real-machine evidence

This file records what was actually executed and observed on the user's Windows
machine for the V4 Chat/Work split and the LiteLLM gateway integration. It is the
companion to `docs/WINDOWS_SMOKE.md` (V2/V3 evidence).

No token, secret or credential value is recorded here. Provider keys are read
from the environment or the local OpenCode auth store and are git-ignored.

## 1. Automated regression

```text
npm test      -> 160 passed / 0 failed
npm run check -> checked 68 file(s), 0 failed
```

New V4 coverage:

| Test file | Covers |
| --- | --- |
| `tests/v4-chat-flow.test.mjs` | default Chat; `你好` never creates a runner; local `chat`/`work`; `work <task>`/`chat <q>`; Work still calls the Agent path; DS->GLM fallback hides the raw error; cooldown; manual pin; WorkBuddy quota cannot block Chat; CHAT/WORK status; gateway-down status |
| `tests/litellm.test.mjs` | gateway config defaults; health failure is non-fatal; AUTO prefers LiteLLM and reports the upstream model; gateway outage falls back to OpenCode Go direct; METERED alias excluded from AUTO; `registerLitellm` |
| `tests/chat-runtime.test.mjs` | OpenCode Go auth header matches the transport (bearer for chat/responses, x-api-key for messages) |

## 2. LiteLLM gateway

Installed with the local Python 3.10 (no `uv`, no Docker on this machine) into an
isolated venv under the git-ignored `data/litellm/`:

```text
scripts/install-litellm.ps1 -> litellm[proxy]==1.101.0
venv                          -> data/litellm/venv
pinned version                -> scripts/litellm/VERSION = 1.101.0
listener                      -> http://127.0.0.1:4000 (loopback only)
health                        -> GET /health/liveliness -> HTTP 200 "I'm alive!"
master key                    -> data/litellm/master-key (generated, git-ignored)
```

Installing from PyPI directly stalled on the 51 MB `polars-runtime-32` wheel; the
Tsinghua PyPI mirror completed it. The venv is not committed.

Logical aliases (see `scripts/litellm/config.yaml`):

```text
chat-fast      -> OpenCode Go deepseek-v4.1-flash  -> fallback chat-fast-glm
chat-fast-glm  -> OpenCode Go glm-5.3-flash
chat-smart     -> OpenCode Go deepseek-v4-pro       (manual pin only)
```

`chat-fast` contains only subscription routes, so AUTO can use it safely.
`vision` was intentionally not added (unused).

## 3. OpenCode Go compatibility through LiteLLM — PROVEN

A plain `openai/<model>` route failed against OpenCode Go:

```text
HTTP 400
Error from provider (Console Go): Request is missing x-opencode-session and
cannot be routed efficiently. Received Model Group=chat-fast
Available Model Group Fallbacks=['chat-fast-glm']
```

This is exactly the special endpoint/header behavior the task warned about. It is
preserved in LiteLLM by declaring the header on each deployment:

```yaml
extra_headers:
  x-opencode-session: jarvis-litellm
```

After that, real requests through `http://127.0.0.1:4000/v1/chat/completions`:

| Alias | HTTP | finish_reason | Content |
| --- | --- | --- | --- |
| `chat-fast` | 200 | stop | `LITELLM_DS_OK` |
| `chat-fast-glm` | 200 | stop | `LITELLM_GLM_OK` |
| `chat-smart` | 200 | stop | `LITELLM_SMART_OK` |

Attribution header (stable because `model_info.id` is set):

```text
x-litellm-model-id = opencode-go/deepseek-v4.1-flash
```

## 4. DeepSeek -> GLM fallback inside LiteLLM — PROVEN

A temporary config (`data/litellm/config.fallback.yaml`, not committed) pointed
`chat-fast` at an unreachable endpoint so the gateway had to fall back:

```text
POST /v1/chat/completions  model=chat-fast
HTTP 200  model=glm-5.3-flash  content=[LITELLM_FALLBACK_OK]
```

The `model=glm-5.3-flash` response is the gateway reporting the real fallback
deployment. `router_settings.fallbacks: chat-fast -> [chat-fast-glm]`.

## 5. Jarvis ChatRuntime -> LiteLLM -> OpenCode Go — PROVEN

`ChatRuntime` (production code, not a mock) talking to the live gateway:

```json
{
  "providerId": "litellm",
  "model": "chat-fast",
  "upstreamModel": "opencode-go/deepseek-v4.1-flash",
  "attempts": [],
  "durationMs": 1338,
  "text": "JARVIS_LITELLM_OK"
}
```

`attempts: []` means the first safe route answered. Length was measured with the
Node `ChatRuntime` (the Discord hop adds only message send/edit time).

## 6. Gateway outage -> direct OpenCode Go escape hatch — PROVEN

With `LITELLM_BASE_URL` pointed at a dead port but the alias cached as a real
candidate:

```text
FIRST  providerId=opencode-go model=deepseek-v4-flash
       attempts=[{ providerId: litellm, model: chat-fast, code: UNREACHABLE, cooldownMs: 30000 }]
       text=JARVIS_DIRECT_OK
SECOND providerId=opencode-go model=deepseek-v4-flash attempts=[] text=JARVIS_DIRECT_OK_2
```

The first turn records the failed gateway attempt and still answers; the second
turn does not retry the cooled-down gateway.

## 7. Bug found by the real smoke (fixed)

The direct OpenCode Go `openai-chat` route used `x-api-key`, which the real
account rejects. Real evidence before the fix: every direct DeepSeek/GLM model
returned `INVALID_CREDENTIAL` (HTTP 401) while the anthropic-messages model
`minimax-m3` worked. Fix: `chat-runtime.mjs` now sends `Authorization: Bearer`
for `openai-chat`/`openai-responses` and keeps `x-api-key` only for
`anthropic-messages`. After the fix the direct route answered
`deepseek-v4-flash` successfully (section 6). Covered by
`tests/chat-runtime.test.mjs`.

## 8. Supervisor lifecycle — PROVEN

`scripts/start-supervisor.ps1` now owns the gateway lifecycle. Verified with a
throwaway entry point (no Discord, no real task):

```text
[20:10:27] Starter: LiteLLM started and healthy
[20:10:27] Starting bridge ...
[dummy] bridge started
[20:10:27] Stopping LiteLLM pid=62012
[20:10:28] Supervisor exited.
```

The gateway was started, reported healthy, and was stopped again on supervisor
exit. `scripts/start-windows.ps1` starts the gateway before the bridge as well.

## 9. Real Discord end-to-end smoke — PASS

Setup for this run:

```text
bot            Jarvis.#8605
owner          time6737 (resolved by doctor:discord)
gateway        LiteLLM 1.101.0 on http://127.0.0.1:4000 (health 200 "I'm alive!")
bridge         node src/index.mjs, chat mode = AUTO
channel        owner DM 1549026681224826962
Work defaults  executor=claude, provider=opencode-go, model=deepseek-v4.1-flash, cwd=D:\dac-smoke
```

A stale V2/V3 bridge held the hook port and was stopped; a global hook from an
older checkout was auto-repaired (see section 10.2).

### A. Chat primary route (LiteLLM UP)

`你好`:

```text
[chat] done channel=... provider=litellm model=chat-fast
       served=chat-fast → opencode-go/deepseek-v4.1-flash fallback=false durationMs=1729
```

Direct model answer, **1.7 s**, no Agent child process. (This is the ~55 s /
Agent-path bug eliminated.)

### B. Work (real read/write, STANDARD permissions)

```text
work 在 D:\dac-smoke 创建 v4-work.txt，写入 V4_WORK_OK，读取确认后只回复 DONE
[task] start channel=... cwd=D:\dac-smoke
[task] done  channel=... state=DONE tools=2 durationMs=15325 tests=-
```

Verified on disk after the run: `D:\dac-smoke\v4-work.txt` = `V4_WORK_OK`.
No approval prompt was needed for the in-workspace Write+Read (STANDARD
auto-allow), which is the intended "don't interrupt normal work" behaviour.

### C. `!stop` kills a real Agent process tree

The bridge's descendant tree was sampled every 2 s (`logs/v4-smoke/child-timeline.log`).
A real `claude.exe` (pid 25572) under `cmd.exe` (64136) was alive and, after
`!stop`:

```text
[task] cancelled channel=... reason=stopped by owner (!stop)
[21:24:39]  pid=64136 cmd.exe ... /  pid=25572 claude.exe ...
[21:24:42]  (no bridge descendants)
```

The whole tree disappeared within one sample; the channel was usable again.

### D. Work -> Chat, and ordinary Chat starts no Agent

After `chat`, ordinary messages produced `[chat] done` lines and the monitor
showed `(no bridge descendants)` for every sample — no `getRunner`, no Claude
Code, no hook, no Work task.

### E. Gateway outage -> direct fallback, with cooldown

LiteLLM was stopped (port 4000 closed, health unreachable) and the channel was
confirmed `mode=chat`. Real Discord replies:

```text
[chat] done provider=opencode-go model=deepseek-v4.1-flash fallback=true durationMs=17010
[chat] done provider=opencode-go model=deepseek-v4.1-flash fallback=true durationMs=13459
```

Footer observed on the phone: `💬 Chat · OpenCode Go · deepseek-v4.1-flash · fallback · 13.5s`.

Cooldown proof (second turn must not hammer the dead gateway, and must still be
attributed as a fallback) from the production `ChatRuntime` against the down
gateway:

```text
FIRST  providerId=opencode-go model=deepseek-v4.1-flash
       attempts=[{litellm, chat-fast, UNREACHABLE, cooldownMs=30000}] skipped=[] fallback=true
SECOND providerId=opencode-go model=deepseek-v4.1-flash
       attempts=[] skipped=[{litellm, chat-fast, reason=cooldown, rank=0}] fallback=true
```

### F. Recovery

LiteLLM restarted (`/health/liveliness` -> 200, pid 64496) and the production
`ChatRuntime` answered through it again:

```text
providerId=litellm model=chat-fast upstreamModel=opencode-go/deepseek-v4.1-flash attempts=[]
```

## 10. Bugs found by the real Discord smoke (fixed)

### 10.1 Direct OpenCode Go `openai-chat` auth

`ChatRuntime` used `x-api-key` for every OpenCode Go transport. The real account
accepts `x-api-key` only on `/v1/messages`; the `openai-chat`/`openai-responses`
endpoints need `Authorization: Bearer`. Before the fix every direct DeepSeek/GLM
model returned `INVALID_CREDENTIAL` (401). Fixed and covered by
`tests/chat-runtime.test.mjs`.

### 10.2 Stale global approval hook -> HTTP 401 fail-closed on every tool

Root cause: the user-level hook in `~/.claude/settings.json` was installed from a
different checkout (`...\WorkBuddy AI\2026-09-14-16-33-53\repo\...`). The hook
client resolved its secret from a file relative to its own location, so it sent
that checkout's stale `data/hook-secret` while the running bridge used its own.
Every Write/Read/Glob/Bash was answered `HTTP 401` and denied.

Fixes (defense in depth):

- the bridge injects `DISCORD_BRIDGE_SECRET` into the agent child; the hook
  client prefers it and only falls back to the file (`scripts/approval-hook.mjs`);
- on startup the bridge repoints `~/.claude` and `~/.codebuddy` `PreToolUse`
  hooks at this checkout, BOM-less, preserving other hooks and idempotently
  (`src/global-hook.mjs`, `DISCORD_AUTO_HOOK=0` to disable).

Deterministic verification:

```text
correct secret -> HTTP 200 decision=allow
wrong secret   -> HTTP 401
tests/approval-secret.test.mjs -> 4/4
```

### 10.3 Fallback attribution was hidden during cooldown

When the primary `chat-fast` was in cooldown, `ChatRuntime` skipped it entirely,
so `attempts=[]` and the direct reply looked like a normal route. Fixed:
`send()` now also reports `skipped` and computes `fallback` when a
more-preferred route was skipped, so the footer shows `fallback` even while the
gateway is cooling down (without retrying it). Covered by
`tests/litellm.test.mjs` and `tests/v4-chat-flow.test.mjs`.

## 11. Final automated state

```text
npm test      -> 166 passed / 0 failed
npm run check -> checked 70 file(s), 0 failed
```

