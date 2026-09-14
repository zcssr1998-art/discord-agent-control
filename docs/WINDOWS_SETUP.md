# Windows setup

1. Create a Discord application/bot, enable **Message Content Intent**, invite it
   to your private server (DM also works), and copy the bot token.
2. Copy `.env.example` to `.env` and fill `DISCORD_TOKEN` and your numeric
   `DISCORD_OWNER_ID`.
3. Keep `CLAUDE_COMMAND=claude` if your existing DeepSeek-backed Claude Code
   already works from a normal terminal. Otherwise set the full path to
   `claude.cmd`.
4. Set `DEFAULT_CWD` to your default projects directory.
5. In PowerShell, from this project:

```powershell
npm install
.\scripts\install-global-hook.ps1
npm run doctor:discord        # checks token, owner id, invite URL and DM channel
.\scripts\start-windows.ps1
```

The hook is global but inert for ordinary Claude Code. It only activates when
this bridge launches Claude with `DISCORD_BRIDGE_ACTIVE=1`.

To remove it later:

```powershell
.\scripts\install-global-hook.ps1 -Uninstall
```

## DeepSeek routing

Your DeepSeek switch lives in the Windows **user** environment (written by
`~/claude-deepseek/use-deepseek-claude.ps1`). A process only inherits that
environment at creation time, so a bridge started from a long-lived shell can
end up without it and silently talk to the official Anthropic endpoint.

The bridge therefore prints its routing source at startup:

```text
[routing] source=windows-user-env {"ANTHROPIC_BASE_URL":"https://api.deepseek.com/anthropic","ANTHROPIC_MODEL":"deepseek-flash[1m]","ANTHROPIC_AUTH_TOKEN":"<set:35>"}
```

`source=process-env` means the shell already had the variables;
`source=windows-user-env` means they were recovered from the user environment;
`source=unavailable` is a warning — run
`~/claude-deepseek/use-deepseek-claude.ps1` (or start the bridge from a fresh
shell) before continuing. `!status` in Discord shows the same information.

## Discord commands

- normal message: run task
- `!status`: cwd/session/executor/resolved backend+model
- `!cwd D:\path\to\repo`: bind current Discord channel/DM to project
- `!stop`: kill the current agent process and cancel pending approvals
- `!reset`: stop + clear the Claude session and session-scoped approvals
- `!handoff`: print a compact handoff package
- `!help`: command list

## Before using a real repo

Bind a disposable test repository first and deliberately test
Allow once / Allow session / Deny:

```powershell
npm run smoke:local
```

That runs the real Claude Code against a throwaway repo and verifies the whole
gate without needing Discord.
