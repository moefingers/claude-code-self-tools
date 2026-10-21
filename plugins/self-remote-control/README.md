# self-remote-control

Lets a session report on its own [Remote Control](https://code.claude.com/docs/en/remote-control), the link that lets you follow and steer it from a phone or a browser, and turn it on. Part of [claude-code-self-tools](../../README.md).

## Tool

`remote_control` (Claude sees `mcp__self-remote-control__remote_control`):

- `action` (required): `status` or `connect`.
  - `status` answers with whether this session is connected, the value of the `/config` setting for all sessions (`remoteControl`), and the clients attached now.
  - `connect` connects this session once the turn ends, if it isn't connected.

## How it behaves

- **It never disconnects.** `/remote-control` is a toggle: run while connected, it disconnects. So `connect` runs it only when the session reads as not connected, and reads again right before it runs. If the session connected in the meantime, nothing runs.
- **How it reads the connection.** Claude Code gives no other signal of whether this session is connected, so the plugin reads the `/remote-control` command's own description, which Claude Code works out from the connection each time it lists the command: `Disconnect Remote Control` while connected, `Control this session from your phone or claude.ai/code` while not. Any other description reads as unknown, and `connect` refuses rather than risk the toggle. The attached clients don't tell you either: a connected session with no phone open shows only the terminal.
- **It waits for the turn to end.** The command runs once the turn ends with Claude's answer, and shows in the transcript as if you had typed it. A few seconds later a toast says whether the session reads as connected; if it doesn't, Claude is told on its next turn.
- **Unavailable sessions are refused.** Without a claude.ai subscription, or where a policy turns Remote Control off, there is no command to run, and `connect` says so.
- **An interrupted turn cancels a queued connect**, with a notice.
- **Subagents can't use it.**

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-remote-control@claude-code-self-tools
```
