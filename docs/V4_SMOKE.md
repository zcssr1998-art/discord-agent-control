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

## 9. Discord end-to-end smoke

Pending: requires `DISCORD_TOKEN` + `DISCORD_OWNER_ID` for the owner's bot,
which are not present on this machine (no `.env`). The sections below must be
run against the live bot:

- **A. Chat** — send `你好`; confirm a direct answer, no Agent child process for
  the turn, and record the real latency and route.
- **B. Fallback** — force the first safe route unavailable; the next safe route
  answers and the failed route is cooled down.
- **C. Work** — `work`, run a disposable-repo task with real read/write/command,
  confirm permissions and `!stop`.
- **D. Return** — `chat`, then an ordinary question returns to the direct Chat
  path.
