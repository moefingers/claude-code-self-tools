# self-compact

A [Claude Code](https://code.claude.com/docs) plugin that lets a session compact its own conversation. It gives Claude one tool, `compact_after_turn`, to call when it finishes one piece of work and moves to the next. The compaction runs as soon as the turn ends, and the session can then carry on by itself.

## Why

A long session fills its context window. Claude Code compacts on its own near the limit, which can happen in the middle of a task, or you type `/compact` yourself, which means watching for the right moment. With this plugin the session compacts at the break between two pieces of work:

- Claude, which knows the work, decides what the summary has to keep.
- The next piece starts with room in the context window.
- With `resume`, the session goes on to the next piece without waiting for you.

## Install

You need Claude Code v2.1.287 or later (v2.1.286 in the Desktop app). Those are the versions that run mods, the plugins with a hooks module, and this plugin is one.

In a Claude Code session:

```
/plugin marketplace add moefingers/claude-code-self-compact-plugin
/plugin install self-compact@claude-code-self-compact-plugin
```

The second command opens the plugin in the `/plugin` panel, where you choose a scope and install it.

Or from your shell:

```
claude plugin marketplace add moefingers/claude-code-self-compact-plugin
claude plugin install self-compact@claude-code-self-compact-plugin
```

A session that is already open loads the plugin after `/reload-plugins`. New sessions load it when they start.

A mod runs inside Claude Code with your permissions. To see what this one hooks and calls before you install it, clone the repository and run `claude plugin validate .` in it.

## How it behaves

Claude sees the tool as `mcp__self-compact__compact_after_turn`. It takes two arguments:

- `keep` (required): what the summary must hold on to, such as open threads, decisions and where the session's notes are. It works like the text you type after `/compact`.
- `resume` (optional): the message that starts the session's next turn once it has compacted, naming the next piece of work and where its details are.

What happens after a call:

- **The compaction waits for the turn to end.** Claude Code can't compact while a turn is running, so the call only queues it. If a message you sent starts a new turn first, the compaction waits for that turn to end as well.
- **With `resume`, the session carries on.** Once compacted, the session sends itself the `resume` message, which starts a new turn. Claude reads it as a message from the plugin, not from you. It waits until the session is idle, so a message you sent earlier is answered first. If Claude Code skips the compaction, the message is still sent and says the compaction was skipped.
- **Without `resume`, the session waits** for your next message.
- **One resume per compaction.** A resumed turn compacts again only if it calls the tool again.
- **An interrupted turn cancels it.** If you stop the turn (Esc or **Stop**), or it ends any way other than with Claude's answer, the queued compaction and its resume are dropped, and a notice says so.
- **Subagents can't use it.** Only the main conversation can compact on demand; a subagent compacts on its own near its context limit. A subagent that calls the tool is refused and told to finish its piece and return its result, so the main session can start a fresh agent for the next piece.

The tool is always loaded rather than deferred behind tool search, so Claude sees its description, which says when to call it, on every turn.

## Tell sessions when to use it

The tool's description already tells Claude to call it when a piece of work is finished, and never in the middle of one. To make it a habit, add a line like this to your `CLAUDE.md`:

> When you close one piece of work and move to the next, write your notes first, then call `compact_after_turn` with `keep`, and with `resume` naming the next piece. Leave `resume` out only when the next step waits on me, another session or a check.

## Develop

```
claude plugin validate .
claude plugin test .
```

`validate` checks the manifests and lists the events the hooks module handles and the calls it makes. `test` runs `tests/*.test.ts` with no session, sign-in or network.

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`. Claude Code writes that folder, with type definitions for the version you run, when it loads the plugin from `--plugin-dir` in an interactive session (`claude --plugin-dir .`). The folder is not committed.

## License

[MIT](LICENSE)
