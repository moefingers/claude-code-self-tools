# self-remote-control

Lets a session report on its own [Remote Control](https://code.claude.com/docs/en/remote-control), the link that lets you follow and steer it from a phone or a browser, turn it on, and give itself a title the session list shows. Part of [claude-code-self-tools](../../README.md).

## Tool

`remote_control` (Claude sees `mcp__self-remote-control__remote_control`):

- `action` (required): `status`, `connect` or `rename`.
  - `status` answers with whether this session is connected, its title, the value of the `/config` setting for all sessions (`remoteControl`), and the clients attached now.
  - `connect` connects this session once the turn ends, if it isn't connected.
  - `rename` sets the session's title once the turn ends, with `/rename`, and does nothing else.
- `name`: the title. `rename` requires it. For `connect` it's optional: without it, the session connects under its own title (its `/rename` title) if it has one, and with no title if it doesn't. One line, at most 200 characters, the most `/rename` keeps.
- `resume` (optional, for `connect` and `rename`): the message that starts the session's next turn once the action has run, after what happened, saying what to do next.

## How it behaves

- **The title is set when the session connects.** The app's session list takes a session's title from `/remote-control <name>`, or else from its `/rename` title, at the moment it connects. With neither, the app titles the session from its last message, or with a name like `<hostname>-<adjective>-<noun>`. So `connect` passes a title.
- **`rename` runs `/rename` and nothing else.** A `/rename` while connected updated the title in the app as well when we tried it (Claude Code 2.1.314). If the app doesn't show the new title, the session needs reconnecting, or renaming in the app. `rename` never connects either: to do both, call `rename`, then `connect`, in the same turn, and the session is renamed, then connects under the new title.
- **How it knows the session's title.** Claude Code passes the session's custom title (set with `--name`, `/rename`, a hook's `sessionTitle`, or a rename from the app) to the SessionStart and UserPromptSubmit hooks as `session_title`. The plugin keeps the latest one, so `connect` knows the title as of the prompt that started the turn. A title Claude Code generated isn't a custom title and isn't passed on. With no title, `connect` runs `/remote-control` bare, as you would.
- **It never runs `/remote-control` while connected.** Run while the session is connected, `/remote-control` doesn't disconnect: in the interactive terminal it opens the Remote Control panel (the session's link, **Disconnect this session**, **Show QR code**, **Continue**) and waits for you. So `connect` runs it only when the session reads as not connected, and reads again right before it runs. If the session connected in the meantime, nothing runs. Disconnecting is yours, from that panel.
- **How it reads the connection.** Claude Code gives no other signal of whether this session is connected, so the plugin reads the `/remote-control` command's own description, which Claude Code works out from the connection each time it lists the command: `Disconnect Remote Control` while connected, `Control this session from your phone or claude.ai/code` while not. Any other description reads as unknown, and `connect` refuses rather than risk opening the panel. The attached clients don't tell you either: a connected session with no phone open shows only the terminal.
- **It waits for the turn to end.** The commands run once the turn ends with Claude's answer, and show in the transcript as if you had typed them. A few seconds later a toast says how it went. With `resume`, the session then sends itself what happened followed by "Resume: <resume>", which starts a new turn. Without it, the session waits for your message, and if the action didn't take, Claude is told on its next turn. If Claude Code doesn't take the resume, a toast says so and Claude gets that note instead.
- **Unavailable sessions are refused.** Without a claude.ai subscription, or where a policy turns Remote Control off, there is no command to run, and `connect` says so. `rename` still renames the session.
- **An interrupted turn cancels what it queued**, its resume included, with a notice.
- **Subagents can't use it.**

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-remote-control@claude-code-self-tools
```
