# claude-code-self-tools

Small [Claude Code](https://code.claude.com/docs) plugins that let a session act on itself. Each one gives Claude a tool or two for something you would otherwise do by hand from the prompt: compact the conversation, reload plugins, reconnect an MCP server, check the context window, come back to a task later, turn on Remote Control.

Each plugin is separate. Install only the ones you want.

## The plugins

| Plugin | Tools | What it does | When a session uses it |
| :- | :- | :- | :- |
| [self-compact](plugins/self-compact) | `compact_after_turn` | Compacts the conversation once the turn ends, keeping what the call says, then can resume on its own. | At the break between two pieces of work, so the next piece starts with room in the context window. |
| [self-reload](plugins/self-reload) | `reload_plugins_after_turn` | Runs `/reload-plugins` once the turn ends, then can resume on its own. | After it has edited a plugin and needs the change live, for example to try a tool it just changed. |
| [self-mcp](plugins/self-mcp) | `reconnect_mcp_after_turn` | Runs `/mcp reconnect <server>` (or `all`) once the turn ends, then can resume on its own. | When an MCP server's tools stop answering and a reconnect is all it needs, such as a browser extension that dropped. |
| [self-context](plugins/self-context) | `context_usage` | Reports the tokens used, the window, the percentage and whether auto-compact is on. Read-only. | At a break between pieces of work, to decide whether to compact now. |
| [self-wake](plugins/self-wake) | `wake_after`, `cancel_wake` | Some minutes after the turn ends, sends the session a note that starts a turn of its own. | When it has to wait on something slow (a deploy, a long job) that won't report back by itself. |
| [self-remote-control](plugins/self-remote-control) | `remote_control` | Reports whether this session's Remote Control is connected, and connects it if it isn't. | When you ask whether you can reach the session from your phone, or to make it reachable before you step away. |

Claude sees each tool as `mcp__<plugin>__<tool>`, for example `mcp__self-wake__wake_after`.

## Install

You need Claude Code v2.1.287 or later (v2.1.286 in the Desktop app). Those are the versions that run mods, the plugins with a hooks module, and these plugins are mods.

In a Claude Code session, add the marketplace once:

```
/plugin marketplace add moefingers/claude-code-self-tools
```

Then install each plugin you want by name:

```
/plugin install self-compact@claude-code-self-tools
/plugin install self-reload@claude-code-self-tools
/plugin install self-mcp@claude-code-self-tools
/plugin install self-context@claude-code-self-tools
/plugin install self-wake@claude-code-self-tools
/plugin install self-remote-control@claude-code-self-tools
```

Each install opens the plugin in the `/plugin` panel, where you choose a scope.

Or from your shell:

```
claude plugin marketplace add moefingers/claude-code-self-tools
claude plugin install self-compact@claude-code-self-tools
claude plugin install self-reload@claude-code-self-tools
claude plugin install self-mcp@claude-code-self-tools
claude plugin install self-context@claude-code-self-tools
claude plugin install self-wake@claude-code-self-tools
claude plugin install self-remote-control@claude-code-self-tools
```

The install says whether the plugin is already active in the open session or needs `/reload-plugins` there. New sessions load it when they start.

A mod runs inside Claude Code with your permissions. To see what one hooks and calls before you install it, clone the repository and run `claude plugin validate plugins/<name>`.

## How they behave

What they have in common:

- **Actions wait for the turn to end.** A compaction, a reload, an MCP reconnect, a wake-up and a Remote Control connect are all queued by the tool call and run once the turn ends with Claude's answer. Claude Code can't run them while the turn is running. Claude should end its turn after calling one of these tools.
- **An interrupted turn cancels what it queued.** If you stop the turn (Esc or **Stop**), or it ends any way other than with Claude's answer, what that turn queued is dropped, and a notice says so. Something set in an earlier turn, such as an armed wake-up, stands.
- **Subagents are refused.** These tools act on the main conversation. A subagent that calls one is told why it can't, and to finish its piece and return its result so the main session can act. `context_usage` refuses a subagent too, because the figures it reports are the main conversation's.
- **Each change is announced.** A toast tells you what ran, and the tool result tells Claude. When Claude Code refuses an action (a command a plugin may not run), a toast says why, and Claude is told on its next turn.
- **Built-in commands run as if you typed them.** self-reload runs `/reload-plugins`, self-mcp runs `/mcp reconnect <server>`, and self-remote-control runs `/remote-control`. Their lines show in the transcript, as yours would. A command that asks for confirmation shows you its dialog and waits for your answer, as it would if you had typed it.

### Reloads

A reload replaces each plugin's code. What a plugin keeps in Claude Code's session state survives; its variables and timers don't. The plugins are built for that:

- self-reload writes its `resume` message to session state before it runs `/reload-plugins`, and sends it once, from whichever copy of itself is running when the reload is done.
- self-wake keeps the armed wake-up in session state and arms it again when its code reloads, for the time left, or at once if that time has passed.
- A wake-up lasts as long as the session. It doesn't survive quitting Claude Code.

### Remote Control

`/remote-control` is a toggle: run while the session is connected, it disconnects. self-remote-control reads whether the session is connected from the command's own description, which Claude Code works out from the session's connection each time it lists the command. It recognises two descriptions: `Disconnect Remote Control` (connected) and `Control this session from your phone or claude.ai/code` (not connected). It runs the command only on the second, read again right before it runs, and refuses on any description it doesn't recognise, so a future Claude Code that rewords it gets a refusal, not a disconnect. It never disconnects.

The attached clients that `status` lists are the screens drawing the session now. A connected session with no phone open shows only the terminal, so that list doesn't tell you whether the session is connected.

### Why there is no effort or model switch

Claude Code asks you to confirm a change of effort level partway through a conversation, because the next message then re-processes the whole history. A plugin that runs `/effort` gets the same dialog, so the switch can't run unattended. Effort and model stay yours to change with `/effort` and `/model`.

## Tell sessions when to use them

The tool descriptions say when to call each tool and when not to. To make it a habit, add the lines for the plugins you installed to your `CLAUDE.md`:

> - **Between pieces of work:** when you close one piece and move to the next, write your notes first. Check `context_usage`; if the window is filling, call `compact_after_turn` with `keep` and with `resume` naming the next piece. Leave `resume` out only when the next step waits on me, another session or a check.
> - **After editing a plugin:** call `reload_plugins_after_turn` with `resume` saying what to try next, and end the turn.
> - **An MCP server stopped answering:** when a server's tools fail in a way a reconnect fixes (the browser extension dropped, the server crashed or timed out), call `reconnect_mcp_after_turn` with the server's name and `resume` saying what to try again, and end the turn.
> - **Waiting on something slow:** when a deploy, a long job or a check will take a while and nothing will tell you it's done, call `wake_after` with the minutes and a note saying what to check, and end the turn. Cancel it with `cancel_wake` if the answer comes first.
> - **Remote Control:** when I say I'm stepping away, call `remote_control` with `connect`. Never try to disconnect it.

## Develop

Each plugin is a folder under `plugins/`. Check one with:

```
claude plugin validate plugins/self-wake
claude plugin test plugins/self-wake
```

`validate` checks the manifest and lists the events the hooks module handles and the calls it makes. `test` runs the plugin's `tests/*.test.ts` with no session, sign-in or network. `claude plugin validate .` at the top checks the marketplace file.

To try a plugin from your working copy, start a session with `claude --plugin-dir plugins/<name>`.

Each plugin's `tsconfig.json` extends `.claude-plugin/types/tsconfig.json` inside that plugin. Claude Code writes that folder, with type definitions for the version you run, when it loads the plugin from `--plugin-dir` in an interactive session. The folder is not committed.

## License

[MIT](LICENSE)
