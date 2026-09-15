# Jarvis V4 P2 smoke evidence

This file is evidence, not a planning document. It records commands/results that actually ran on this machine (Windows, 2026-09-16).

## 1. Baseline

```text
main/P1 baseline (before P2 changes):
npm test      195 passed / 0 failed
npm run check 76 files / 0 failed
npm run smoke:p1 20/20
```

## 2. Deterministic regression

```text
npm test      -> 226 passed / 0 failed  (195 P0/P0.5/P1 + 31 new P2 tests)
npm run check -> 83 file(s), 0 failed
```

New P2 suites:

- `tests/v4-p2-panel.test.mjs` — 10 tests
- `tests/v4-p2-history.test.mjs` — 7 tests
- `tests/v4-p2-newcompact.test.mjs` — 6 tests
- `tests/v4-p2-attachments.test.mjs` — 8 tests

## 3. P2A control panel

Deterministic (`v4-p2-panel.test.mjs`):

- `!panel` renders the persistent main controls and calls neither ChatRuntime nor an Agent; the panel is pinned when Discord permits.
- Buttons include `panel:newwork`, `panel:models`, `panel:settings`, `panel:permission`, `panel:newchat`, `panel:compact`, `panel:status`, `panel:stop`, `panel:help`, `panel:refresh`.
- An old panel message still works after recreating `DiscordControlPlane` (stable custom ids -> restart resilience).
- `🛠 新建 Work` modal submit reuses the existing Work start path: guild parent -> one 🛠 Work thread (parent stays Chat), DM -> inline.
- Chat model selector: `AUTO` + `Provider -> model`, manual pin applied.
- Work model selector reaches OpenCode Go while the current Work provider is WorkBuddy.
- Settings / Permission reuse the existing flows; Status is local; usage guide is local/static.
- Panel Stop == `!stop` for queued (only that queued item cancelled, active owner untouched) and active (agent process tree killed).

## 4. P2B Chat history

Deterministic:

- consecutive Chat turns send the prior context (`user, assistant, user`);
- history survives a `ChatHistoryStore` reload (persisted to `data/chat-history.json`);
- a BOM-prefixed history file does not reset unrelated channels;
- AUTO fallback retries never duplicate the user turn (exactly one user + one assistant turn stored);
- a failed manual pin appends nothing;
- Work messages never enter Chat history;
- bounded history does not grow indefinitely (trimmed to the configured envelope).

## 5. P2C New / Compact

Deterministic:

- `!new` clears only the Chat context; Chat model and Work executor/provider/model are preserved;
- a permanent Work thread refuses `!new` / `!compact`;
- Compact keeps a recent tail (last 4 role messages) plus a persisted summary and reduces the replay size; the real summary path is exercised with a stub model;
- Compact on a tiny history reports `无需压缩` with no model call;
- a failed Compact leaves the original history intact and adds no summary;
- Compact never starts an Agent.

## 6. P2D attachments

Deterministic:

- Work attachment downloaded exactly once into `data/inbox/<channel>/<message>/...`; the Agent task receives a local-path manifest and the file exists on disk;
- `sanitizeFileName` strips traversal and reserved characters; only `https://cdn.discordapp.com` / `https://media.discordapp.net` URLs are trusted; an untrusted Work attachment is refused without downloading;
- a binary Chat attachment is not silently ignored (a "use Work" note is added to the turn);
- text Chat attachments are bounded (per-file + total char caps) and included in the turn, with only bounded text persisted to history;
- an image Chat turn builds an OpenAI/LiteLLM `image_url` data payload; the Anthropic mapping produces an `image` block with `source.type=base64`;
- a provider retry/fallback does not re-download the attachment or duplicate history.

## 7. Real-machine smoke (`npm run smoke:p2`)

`scripts/p2-e2e.mjs` drives the real `DiscordControlPlane` with the real LiteLLM gateway, the real OpenCode Go route, the real Claude Code agent, the real hook server, `ChatHistoryStore`, and the `WorkspaceScheduler`. Only the Discord transport is fake (the bridge ignores bot-authored messages, so it cannot send as the human owner).

```text
npm run smoke:p2 -> 11/11 passed
[gateway] enabled=true health=UP (healthy)
G1 the real LiteLLM gateway is reachable
C1 real Chat turn 1 answered  (LiteLLM chat-fast -> opencode-go/deepseek-v4.1-flash, 2.2s)
C2 turn 2 used turn-1 context (model recalled 7391)
C3 four role messages persisted
C4 Chat history survives a store reload
C5 !panel rendered with the P2 controls
C6 real vision route understood the image (opencode-go/deepseek-v4-flash-vision-exp -> "红色", 1.5s)
W1 the panel modal created exactly one Work thread
W2 the guild parent stayed Chat
W3 the real Agent completed in the panel Work thread (elapsed 8.9s)
W4 the real Agent created p2-panel-ok.txt with P2_PANEL_OK
```

Real vision route: `opencode-go / deepseek-v4-flash-vision-exp`, wired via `CHAT_VISION_PROVIDER_ID` / `CHAT_VISION_MODEL` (see `.env.example`). A 64x64 solid-red PNG was sent as a Discord image attachment through the integrated Chat path and the model answered `红色`. No fake evidence is recorded here.

## 8. Human real-Discord smoke

Status: **PENDING_OWNER_DISCORD_SMOKE**

The two real Discord contexts (a human tapping buttons and sending attachments in the real client) cannot be driven by the bridge itself, so the owner must run this checklist. The machine-side companion above already passed.

1. `!panel`, then pin it (or confirm the bot pinned it).
2. Restart the bridge; click `🔄 刷新` on the old panel and confirm it still works.
3. Click `📖 使用说明`.
4. Panel -> Work 模型 -> OpenCode Go -> `deepseek-v4.1-flash`.
5. Panel -> Chat 模型 -> AUTO.
6. Panel -> `🛠 新建 Work`, submit a tiny disposable file task; a guild parent should create a 🛠 Work thread.
7. Panel -> ⛔ Stop on an active disposable Work task.
8. Chat: send two related messages; the second answer must use the first turn's context.
9. `!new`; the next Chat turn must no longer have prior context.
10. Build enough Chat context, send `!compact`, confirm continuity remains with a shorter stored context.
11. Send a small text attachment in Chat and confirm it is understood.
12. Send a small image in Chat (AUTO now has a real vision route) and confirm it is understood.
13. Send a file to a disposable Work task and confirm the Agent reads the downloaded local file.

Do not mark this section PASS without real output from the owner.
