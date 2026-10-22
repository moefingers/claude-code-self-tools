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

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-mcp@claude-code-self-tools
```
