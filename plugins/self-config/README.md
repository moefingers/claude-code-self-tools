# self-config

Lets a session switch its own effort level and model, and nothing else. Part of [claude-code-self-tools](../../README.md).

## Tools

`set_effort` (Claude sees `mcp__self-config__set_effort`):

- `level` (required): `low`, `medium`, `high`, `xhigh`, `max`, or `auto` (the model's default). These are Claude Code's effort levels, and `auto` is what `/effort` takes to go back to the default. A model takes only the levels it supports; `/effort` says which.

`set_model` (Claude sees `mcp__self-config__set_model`):

- `model` (required): one of the options of the `/config` menu's Model row, such as `default`, `sonnet`, `opus` or `haiku`. Any other name is refused, with the list.

## How it behaves

- **Two settings only.** The effort level goes through `/effort <level>`, the model through the `/config` Model row. self-config names no other row and runs no other command, whatever the input; its tests check this.
- **The switch waits for the turn to end.** A switch takes effect from the next turn, so the call queues it, and it runs once the turn ends with Claude's answer. When both are queued, the model switches first, since the levels `/effort` takes depend on the model.
- **Announced from the old value to the new.** The tool result tells Claude, for example "Queued: effort from medium to low", and a toast tells you when it runs. The old model is the Model row's value. The old effort level is the one Claude Code reported for the main conversation at the end of the last turn; when there is none yet (or the model just changed), the result says "its current level" and the toast reads it from `/effort status`.
- **Kept as Claude Code keeps them.** As when you type a level after `/effort`, any level but `max` also becomes your default for new sessions. A model change is kept as any change made in `/config` is.
- **A refused switch is reported.** If Claude Code refuses the command or the setting, a toast says why, and Claude is told on its next turn.
- **An interrupted turn cancels it**, with a notice.
- **Subagents can't use it.** Effort and model belong to the main conversation.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-config@claude-code-self-tools
```
