# Jarvis V4 — HANDOFF

How to bring the V4 stack up on the user's Windows machine and where to look.

## 1. Prerequisites

- Node 22+ and `npm install` in the repo root.
- Python 3.10+ for the LiteLLM venv (no `uv`/Docker required).
- A Discord bot token with **Message Content Intent** enabled and the owner's
  numeric user ID.
- An OpenCode Go key. It is read from `OPENCODE_GO_API_KEY`, or from the local
  OpenCode auth store (`~/.local/share/opencode/auth.json`, key `opencode-go`).

## 2. First-time setup

```powershell
Copy-Item .env.example .env      # fill DISCORD_TOKEN + DISCORD_OWNER_ID
npm install
.\scripts\install-litellm.ps1    # installs the pinned LiteLLM[proxy] into data\litellm\venv
```

`scripts/litellm/VERSION` pins the validated version (`1.101.0`). Nothing under
`data\litellm\` is committed.

## 3. Run

```powershell
.\scripts\start-windows.ps1       # starts LiteLLM, then the bridge
# or supervised (restarts the bridge and keeps the gateway alive):
.\scripts\start-supervisor.ps1
```

Supervisor notes:

- owns the gateway lifecycle (starts it, waits for `/health/liveliness`, stops it
  on exit); `-NoGateway` runs the bridge without LiteLLM.
- `DISCORD_AUTO_HOOK=0` disables the automatic global-hook repair.

## 4. What to check

```powershell
npm run doctor:discord                 # token, owner, proxy, DM
Invoke-WebRequest http://127.0.0.1:4000/health/liveliness   # "I'm alive!"
```

In Discord:

- `!status` -> mode, `LiteLLM 🟢/🔴`, separate CHAT and WORK blocks, actual route.
- `!chatmodel auto` / `!chatmodel <provider> <model>` -> Chat route.
- `chat` / `work` switch mode; ordinary messages follow the current mode.

## 5. Troubleshooting

| Symptom | Check |
| --- | --- |
| Chat shows a Work/Agent card | The channel is in `work` mode. Send `chat` first: mode is explicit by design. |
| Tools fail with `HTTP 401` | Stale global hook. The bridge auto-repairs it on start; verify `~/.claude/settings.json` points at this repo, or run `scripts\install-global-hook.ps1`. |
| Chat always `fallback` | LiteLLM is down or cooling down. Check `/health/liveliness`, `data\litellm\gateway.err.log`, and that `OPENCODE_GO_API_KEY` resolved. |
| `EADDRINUSE 37911` | Another bridge is running. Stop it before starting V4. |
| Gateway not used at all | `LITELLM_ENABLED` must not be `false`; the alias cache is in `data\providers.json`. |

## 6. Key files

```text
src/mode-router.mjs      deterministic chat/work parser
src/chat-runtime.mjs     direct/gateway Chat route, health, fallback attribution
src/provider-health.mjs  cooldown / circuit breaker
src/litellm.mjs          gateway config, health probe, OpenCode Go key
src/global-hook.mjs      self-repair of the user-level approval hook
scripts/litellm/config.yaml   chat-fast / chat-fast-glm / chat-smart aliases
scripts/start-litellm.ps1     loopback gateway launcher
scripts/approval-hook.mjs     hook client (env secret preferred)
```

## 7. Not done yet

P1 thread-based Work sessions, workspace lock/queue, settings UX; P2 attachments
and chat history. See `docs/V4_CURRENT.md`.
