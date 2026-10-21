# self-reload

Lets a session reload its own plugins once the current turn ends, as `/reload-plugins` does, then carry on by itself. Useful when the session edits a plugin and needs the change live, for example to try a tool it just changed. Part of [claude-code-self-tools](../../README.md).

## Tool

`reload_plugins_after_turn` (Claude sees `mcp__self-reload__reload_plugins_after_turn`):

- `resume` (optional): the message that starts the session's next turn once the plugins have reloaded, saying what to check or do next.

## How it behaves

- **The reload waits for the turn to end.** The call queues it; `/reload-plugins` runs once the turn ends with Claude's answer, and shows in the transcript as if you had typed it.
- **With `resume`, the session carries on**: it sends itself "Plugins reloaded. Resume: …", which starts a new turn. Without `resume`, it waits for your next message.
- **Sent once, through its own reload.** The reload replaces this plugin's code too, so the `resume` is written to session state before the command runs. Whichever copy of the plugin is running when the reload is done sends it, once. A resume that no reload picks up within ten minutes is dropped, with a notice, rather than sent late.
- **A refused or skipped reload is reported.** If Claude Code refuses to run `/reload-plugins` for a plugin, or the command skips the reload (it does when the reload would change which MCP tools are loaded, until it is run with `--force`, which this plugin leaves to you), a toast says so, and the resume, if there is one, is sent saying the reload didn't happen. Without a resume, Claude is told on its next turn.
- **An interrupted turn cancels it**, with a notice.
- **Subagents can't use it.** A subagent that calls the tool is told to finish its piece and say a reload is needed.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-reload@claude-code-self-tools
```
