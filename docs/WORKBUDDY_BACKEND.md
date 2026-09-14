# WorkBuddy free DSF backend — investigation and decision record

Goal: run the existing Discord control plane on the **WorkBuddy free DeepSeek
Flash** backend, with no paid API and no fallback, while keeping the Claude Code
agent workflow, tool calls, approval gate and commands unchanged.

Everything below was measured on this machine. Nothing is inferred.

## 1. What was investigated

### 1.1 Local listening ports

WorkBuddy runs several loopback services. Probing each one:

| Port | Identity | Verdict |
| --- | --- | --- |
| 18072 | `CodeBuddy Code Remote Control` (Web UI + REST) | agent-control API, `AUTH_REQUIRED` |
| 13304 | `CODEBUDDY_SERVICE_PROXY_URL` → `/internal/hooks/services/invoke` | internal hooks/services invoke |
| 18873 | MCP connector proxy | MCP tool transport, not a model API |
| 18488 | `{"ok":false,"error":"Not Found"}` | not a model API |
| 62805/62806 | 404 on every probe | not a model API |
| 56076 | the sandbox HTTP proxy (blocks discord.com) | not a model API |

`/v1/models` and `/health` on 18072/13304 both answer
`{"error":{"code":"AUTH_REQUIRED","message":"Authentication required"}}`. It is an
**agent control** API, and it authenticates with the Web UI's own session — not a
model endpoint that can be pointed at Claude Code.

### 1.2 CLI

No `wb` / `workbuddy` / `codebuddy` on `PATH`, but WorkBuddy ships one:

```text
D:\WorkBuddy\WorkBuddyAI\resources\app.asar.unpacked\cli\
  bin\codebuddy              launcher (requires dist/codebuddy.js)
  dist\codebuddy.js          runnable directly  -> version 2.137.1
  dist\codebuddy-headless.js headless bundle
  package.json               name: @genie/agent-cli, bins: codebuddy / codebuddy-code / cbc
```

Its `--help` documents the important parts:

- `-p, --print`, `--input-format stream-json`, `--output-format stream-json`, `--verbose`
- `--include-partial-messages`, `--session-id`, `-r/--resume`, `-c/--continue`
- `-y, --dangerously-skip-permissions`, `--permission-mode`
- `--model fast-model|balanced-model|primary-model|deep-model`
- `--serve` (HTTP server: Web UI, REST API, ACP over SSE) and `--acp`

That is the **Claude Code protocol**, because this CLI is a Claude Code fork.

### 1.3 Configuration

- `CODEBUDDY_BASE_URL` exists and overrides the model base URL, but there is no
  legitimate WorkBuddy-provided endpoint to point it at.
- `CODEBUDDY_AUTH_TOKEN` / `CODEBUDDY_API_KEY` are the WorkBuddy account
  credentials. Reading them out of the app's storage would be "extracting a
  private cloud auth token", which the task forbids.
- Config directory: `~/.codebuddy/` (settings, sessions, projects).

## 2. Decision

**Path chosen: the official WorkBuddy agent CLI as the agent shell.**

There is **no** externally callable, legitimately authenticated WorkBuddy model
API — so Phase 3A/3B (Anthropic-compatible / OpenAI-compatible endpoint) are not
available. Phase 3C (the official CLI) is available, and it happens to be a
Claude Code fork, which changes the shape of the answer:

```text
Discord
  -> discord-agent-control            (unchanged)
  -> WorkBuddy agent CLI              (Claude Code compatible shell: same
                                       stream-json protocol, same tools,
                                       same PreToolUse hook schema)
  -> WorkBuddy Free DSF               (apiKeySource = www.workbuddy.ai, cost 0)
  -> real files / commands / git
```

**Why not `claude` + an adapter in front of the CLI?** Because the CLI is itself a
complete agent, not a model. Wrapping an agent behind a model-shaped adapter would
put two agent loops in series — the outer Claude Code loop would issue tool calls
that the inner agent would interpret as instructions, producing duplicated tool
execution, duplicated approvals and contradictory state. That is a worse
architecture, not a simpler one.

Keeping the literal `claude` binary would require a WorkBuddy endpoint that does
not exist. The requirement that actually matters — *keep the Claude Code agent
workflow and tool calls, replace only the model backend* — is satisfied: the shell
is a Claude Code fork speaking the identical protocol, and the backend is the
free WorkBuddy DSF.

## 3. Verified compatibility (measured, not assumed)

| Property | Evidence |
| --- | --- |
| Same non-interactive protocol | `-p --input-format stream-json --output-format stream-json --verbose` produces `system/init`, `assistant.message.content[].tool_use`, `result` |
| Same event schema | `assistant` blocks are `thinking` / `tool_use` / `text`, exactly like Claude Code |
| Same hook system | `PreToolUse` fires with `hook_event_name`, `tool_name`, `tool_input`, `cwd`, `session_id`, `permission_mode`, `tool_use_id`; `permissionDecision` in `hookSpecificOutput` is honoured |
| Real tool execution | created `hello.txt` containing `WB_DSF_AGENT_OK`, read it back, ran `git status --short` |
| Free backend | `system/init.apiKeySource = "www.workbuddy.ai"`, `total_cost_usd: 0` |
| Backend identity is machine-checkable | `apiKeySource` is reported by the agent itself, so the bridge gates on it rather than guessing |

`--output-format json` uses a **different** schema (`function_call` instead of
`tool_use`). The bridge uses `stream-json`, so this does not matter — but it is
worth knowing before writing a new parser.

The CLI is invoked as `dist/codebuddy.js` rather than `bin/codebuddy`: it is a
plain `.js` entry, so the existing `buildSpawnPlan()` launches it with the current
Node binary. The extensionless launcher cannot be executed by `cmd.exe`.

## 4. Failure records

1. **The user's paid DeepSeek key stopped working mid-session.** `sk-b74f…8516`
   began returning `401 Authentication Fails, Your api key: ****8516 is invalid`
   on all three network paths (sandbox proxy, direct, Clash). Earlier smoke runs
   with the same key had succeeded, so the key was revoked or rotated between
   runs. This is why the paid path cannot be the answer even as a stopgap.

2. **`discord.com` is unreachable from Node.** All Discord hosts return `000`
   and DNS resolves them to bogus addresses. The machine's Clash
   (`127.0.0.1:7897`) reaches Discord fine, but Clash runs in **system-proxy
   mode** (no TUN adapter) and Node ignores the Windows system proxy entirely.
   Fixed by adding proxy support (`DISCORD_PROXY`, auto-detecting the Windows
   system proxy) that covers both transports — see below.

3. **The Gateway WebSocket needed a different fix from REST.** `@discordjs/rest`
   uses `undici.request`, so `setGlobalDispatcher(new ProxyAgent(...))` covers it.
   The gateway does not: `@discordjs/ws` only uses the global `WebSocket` on Deno
   and Bun (`shouldUseGlobalFetchAndWebSocket()` returns `false` on Node), so on
   Node it always uses the `ws` package, which ignores undici. `ws` reads
   `options.agent` but `@discordjs/ws` never forwards one, so the constructor is
   wrapped in `src/discord-proxy.mjs`.

4. **`undici` version skew would have silently broken REST proxying.** Adding
   `undici` as a direct dependency installed v8 while `@discordjs/rest` needed
   v6, giving two copies and two separate global dispatchers. Pinned to `^6` so
   there is a single shared instance.

5. **The installed global hook was written with a UTF-8 BOM.** PowerShell 5.1's
   `Set-Content -Encoding UTF8` prepends one, which makes the file invalid JSON
   and silently stops the agent from loading the hook. Fixed by writing with
   `System.IO.File.WriteAllText` and a BOM-less `UTF8Encoding`.

6. **A 401 storm looked like a hang.** The agent retries API failures 10 times
   with exponential backoff (about 3 minutes) and Discord showed nothing, so the
   run appeared frozen. `api_retry` events are now surfaced as
   `⚠️ Model request retry n/10 (401 authentication_failed)`.

## 5. Interface summary

| Question | Answer |
| --- | --- |
| Anthropic-compatible API? | No |
| OpenAI-compatible API? | No |
| Legit localhost model API? | No (localhost services are agent/MCP control APIs, auth required) |
| Official CLI? | **Yes** — `codebuddy` / `@genie/agent-cli`, Claude Code compatible |
| ACP? | Yes (`--acp`, `--serve` + ACP over SSE) — not needed, stream-json is simpler |
| MCP? | Present, but for tools, not models |
| Auth mechanism | WorkBuddy account session held by the app/CLI; never extracted |

## 6. Running it

```powershell
# .env
CLAUDE_COMMAND=workbuddy          # resolves the bundled CLI automatically
AGENT_BACKEND=workbuddy-free-dsf
ALLOW_PAID_FALLBACK=false

.\scripts\install-global-hook.ps1        # installs into ~/.claude AND ~/.codebuddy
npm run verify:workbuddy                 # proves backend + tool calls + no fallback
.\scripts\start-windows.ps1
```

`WORKBUDDY_CLI` overrides the CLI path if it is not in a standard location.

If the free backend is unavailable the bridge exits with
`ERROR: WorkBuddy free backend unavailable` and attempts no paid fallback.
