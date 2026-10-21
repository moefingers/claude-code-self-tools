# self-context

Lets a session read how full its context window is, so at the break between two pieces of work it can decide whether to compact now, rather than have auto-compact run in the middle of the next piece. Part of [claude-code-self-tools](../../README.md).

## Tool

`context_usage` (Claude sees `mcp__self-context__context_usage`), with no arguments. It answers with one line, such as:

> Context: 123,456 of 200,000 tokens (62%). Auto-compact is on. To compact at this break, call compact_after_turn.

- The figures are the ones the status line shows: the input tokens of the model's last response, against the model's window. A new or just-compacted conversation has no reading until the model's next response, and the tool says so.
- Whether auto-compact is on comes from the `/config` menu's `autoCompact` row.
- The last sentence appears only when [self-compact](../self-compact)'s `compact_after_turn` is available.

## How it behaves

- **Read-only.** It changes no setting and runs no command.
- **Subagents are refused.** The figures are the main conversation's, and Claude Code has no reading of a subagent's own window, so a subagent is told so rather than handed figures that aren't its own.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-context@claude-code-self-tools
```
