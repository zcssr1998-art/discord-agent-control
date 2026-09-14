# Windows setup

1. Create a Discord application/bot, enable **Message Content Intent**, invite it to your private server (DM also works), and copy the bot token.
2. Copy `.env.example` to `.env` and fill `DISCORD_TOKEN` and your numeric `DISCORD_OWNER_ID`.
3. Keep `CLAUDE_COMMAND=claude` if your existing DeepSeek-backed Claude Code already works from a normal terminal. Otherwise set the full path to `claude.cmd`.
4. Set `DEFAULT_CWD` to your default projects directory.
5. In PowerShell, from this project:

```powershell
npm install
.\scripts\install-global-hook.ps1
.\scripts\start-windows.ps1
```

The hook is global but inert for ordinary Claude Code. It only activates when this bridge launches Claude with `DISCORD_BRIDGE_ACTIVE=1`.

Discord commands:

- normal message: run task
- `!status`: cwd/session/backend
- `!cwd D:\\path\\to\\repo`: bind current Discord channel/DM to project
- `!stop`: kill current agent process
- `!reset`: clear Claude session for that channel

Before using a real repo, first bind a disposable test repository and deliberately test Allow once / Allow session / Deny.
