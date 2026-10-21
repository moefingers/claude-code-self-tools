# self-compact

Lets a session compact its own conversation at the break between two pieces of work, then carry on by itself. Part of [claude-code-self-tools](../../README.md).

## Tool

`compact_after_turn` (Claude sees `mcp__self-compact__compact_after_turn`):

- `keep` (required): what the summary must hold on to, such as open threads, decisions and where the session's notes are. It works like the text you type after `/compact`.
- `resume` (optional): the message that starts the session's next turn once it has compacted, naming the next piece of work and where its details are.

## How it behaves

- **The compaction waits for the turn to end.** Claude Code can't compact while a turn is running, so the call queues it. If a message you sent starts a new turn first, the compaction waits for that turn to end as well.
- **With `resume`, the session carries on.** Once compacted, it sends itself the `resume` message, which starts a new turn. If Claude Code skips the compaction, the message is still sent and says so. Without `resume`, the session waits for your next message.
- **One resume per compaction.** A resumed turn compacts again only if it calls the tool again.
- **An interrupted turn cancels it**, with a notice.
- **Subagents can't use it.** A subagent compacts on its own near its context limit; one that calls the tool is told to finish its piece and return its result instead.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-compact@claude-code-self-tools
```

Pairs with [self-context](../self-context), whose `context_usage` tells the session how full the window is before it decides.
