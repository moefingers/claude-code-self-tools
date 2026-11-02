# self-mcp

Lets a session reconnect one of its MCP servers once the current turn ends, as `/mcp reconnect <server>` does, then carry on by itself. Useful when a server's tools stop answering and a reconnect is all it needs: a browser extension that dropped its connection, a local server that crashed or timed out. Part of [claude-code-self-tools](../../README.md).

## Tool

`reconnect_mcp_after_turn` (Claude sees `mcp__self-mcp__reconnect_mcp_after_turn`):

- `server`: the server's name as `/mcp` lists it, or `all` for every server that isn't connected. For a tool named `mcp__<server>__<tool>`, the name is usually `<server>`.
- `resume` (optional): the message that starts the session's next turn once the reconnect has run, saying what to try again.

## How it behaves

- **The reconnect waits for the turn to end.** The call queues it; `/mcp reconnect <server>` runs once the turn ends with Claude's answer, and shows in the transcript as if you had typed it. That is the typed form of the `/mcp` menu's **Reconnect**, so no menu opens and nothing waits on you.
- **The outcome is Claude Code's own line.** `/mcp reconnect` prints whether it reconnected (for example `Successfully reconnected to claude-in-chrome`) in the transcript, where you and Claude both read it. It hands the plugin no text, so the toast and the resume point to that line. With `resume`, the session sends itself "MCP reconnect of <server> ran: … Resume: …", which starts a new turn. Without `resume`, Claude is told on its next turn and the session waits for your message.
- **A reconnect starts the server's session over.** Whatever the server kept for this session is gone. Claude in Chrome, for one, no longer knows the session's tab group: the group stays open in Chrome, and the session makes a new one.
- **It reconnects, nothing more.** A server that needs sign-in, or one you turned off, stays yours to handle in `/mcp`.
- **An interrupted turn cancels it**, with a notice.
- **Subagents can't use it.** A subagent that calls the tool is told to finish its piece and say which server needs a reconnect.

## Update check

When Claude calls one of this plugin's tools, and the last check is 30 minutes old or there hasn't been one, the plugin checks whether a newer version is published. It fetches this plugin's `plugin.json` from the `main` branch of the repository its installed `plugin.json` names, [`plugins/self-mcp/.claude-plugin/plugin.json`](https://raw.githubusercontent.com/moefingers/claude-code-self-tools/main/plugins/self-mcp/.claude-plugin/plugin.json), and compares its `version` with the installed one.

- **A plain GET of a public file, and nothing more.** The request carries no headers, no query and nothing about you, the session or the machine.
- **At most every 30 minutes.** The check's time and answer are kept in the plugin's own store, so a reload, or another session on this machine, uses that answer until it is 30 minutes old.
- **It never holds up the tool.** The check runs beside the call, which never waits on it. Offline, refused by policy, a 404, a rate limit, no answer within 5 seconds, or anything but a plain version such as `0.2.0` all mean no notice.
- **When a newer version is out**, a toast tells you, and the result of one of Claude's next calls ends with a line like this:

  > self-mcp 0.1.1 is out of date (0.2.0 is published). To update, the person runs: claude plugin marketplace update claude-code-self-tools, then claude plugin update self-mcp@claude-code-self-tools (once for each scope it is installed at, adding --scope project or --scope local for those), then /reload-plugins. Don't run these yourself unless the person asks.

  The line is fixed text. Only the two version numbers vary, and each must be three plain numbers. Nothing else from the fetched file reaches Claude. Claude is told once per check, not on every call, so at most once every 30 minutes in a session, and the toast follows the same rule. A call carries only what an earlier check found: the call that starts a check doesn't wait for its answer.
- **Turn it off** with the plugin's `updateCheck` setting: `off` never checks. It's in `/config`, or in settings.json under `pluginConfigs`, keyed by the plugin as installed (`self-mcp@claude-code-self-tools`). Nothing is checked while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, or for a subagent's call.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-mcp@claude-code-self-tools
```
