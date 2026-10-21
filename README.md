# claude-code-self-tools

Small [Claude Code](https://code.claude.com/docs) plugins that let a session act on itself. Each one gives Claude a tool or two for something you would otherwise do by hand from the prompt: compact the conversation, reload plugins, check the context window, switch the effort level or model, come back to a task later, turn on Remote Control.

Each plugin is separate. Install only the ones you want.

## The plugins

| Plugin | Tools | What it does | When a session uses it |
| :- | :- | :- | :- |
| [self-compact](plugins/self-compact) | `compact_after_turn` | Compacts the conversation once the turn ends, keeping what the call says, then can resume on its own. | At the break between two pieces of work, so the next piece starts with room in the context window. |
| [self-reload](plugins/self-reload) | `reload_plugins_after_turn` | Runs `/reload-plugins` once the turn ends, then can resume on its own. | After it has edited a plugin and needs the change live, for example to try a tool it just changed. |
| [self-context](plugins/self-context) | `context_usage` | Reports the tokens used, the window, the percentage and whether auto-compact is on. Read-only. | At a break between pieces of work, to decide whether to compact now. |
| [self-config](plugins/self-config) | `set_effort`, `set_model` | Switches the effort level (through `/effort`) or the model (through the `/config` Model row) once the turn ends, and nothing else. | When you ask for another effort level or model, or when its instructions let it choose one for the work ahead. |
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
/plugin install self-context@claude-code-self-tools
/plugin install self-config@claude-code-self-tools
/plugin install self-wake@claude-code-self-tools
/plugin install self-remote-control@claude-code-self-tools
```

Each install opens the plugin in the `/plugin` panel, where you choose a scope.

Or from your shell:

```
claude plugin marketplace add moefingers/claude-code-self-tools
claude plugin install self-compact@claude-code-self-tools
claude plugin install self-reload@claude-code-self-tools
claude plugin install self-context@claude-code-self-tools
claude plugin install self-config@claude-code-self-tools
claude plugin install self-wake@claude-code-self-tools
claude plugin install self-remote-control@claude-code-self-tools
```

The install says whether the plugin is already active in the open session or needs `/reload-plugins` there. New sessions load it when they start.

A mod runs inside Claude Code with your permissions. To see what one hooks and calls before you install it, clone the repository and run `claude plugin validate plugins/<name>`.

## How they behave

What they have in common:

- **Actions wait for the turn to end.** A compaction, a reload, a switch of effort or model, a wake-up and a Remote Control connect are all queued by the tool call and run once the turn ends with Claude's answer. Claude Code can't run them while the turn is running, and a switch takes effect from the next turn anyway. Claude should end its turn after calling one of these tools.
- **An interrupted turn cancels what it queued.** If you stop the turn (Esc or **Stop**), or it ends any way other than with Claude's answer, what that turn queued is dropped, and a notice says so. Something set in an earlier turn, such as an armed wake-up, stands.
- **Subagents are refused.** These tools act on the main conversation. A subagent that calls one is told why it can't, and to finish its piece and return its result so the main session can act. `context_usage` refuses a subagent too, because the figures it reports are the main conversation's.
- **Each change is announced.** A toast tells you what ran, and the tool result tells Claude. When Claude Code refuses an action (a command a plugin may not run, a setting that may not change), a toast says why, and Claude is told on its next turn.
- **Built-in commands run as if you typed them.** self-reload runs `/reload-plugins`, self-config runs `/effort`, and self-remote-control runs `/remote-control`. Their lines show in the transcript, as yours would.

### Reloads

A reload replaces each plugin's code. What a plugin keeps in Claude Code's session state survives; its variables and timers don't. The plugins are built for that:

- self-reload writes its `resume` message to session state before it runs `/reload-plugins`, and sends it once, from whichever copy of itself is running when the reload is done.
- self-wake keeps the armed wake-up in session state and arms it again when its code reloads, for the time left, or at once if that time has passed.
- A wake-up lasts as long as the session. It doesn't survive quitting Claude Code.

### Remote Control

`/remote-control` is a toggle: run while the session is connected, it disconnects. self-remote-control reads whether the session is connected from the command's own description, which Claude Code works out from the session's connection each time it lists the command. It recognises two descriptions: `Disconnect Remote Control` (connected) and `Control this session from your phone or claude.ai/code` (not connected). It runs the command only on the second, read again right before it runs, and refuses on any description it doesn't recognise, so a future Claude Code that rewords it gets a refusal, not a disconnect. It never disconnects.

The attached clients that `status` lists are the screens drawing the session now. A connected session with no phone open shows only the terminal, so that list doesn't tell you whether the session is connected.

### Effort and model

`set_effort` runs `/effort <level>`. As when you type a level after `/effort`, Claude Code also keeps it as your default for new sessions, except `max`, which applies to the current session only. A model takes only the levels it supports; the toast shows what `/effort` answered.

`set_model` changes the `/config` menu's Model row, so the change is kept as any change made in `/config` is. It takes only the names that row offers.

self-config changes nothing else: no other `/config` row, no other command. Its tests check this.

## Tell sessions when to use them

The tool descriptions say when to call each tool and when not to. To make it a habit, add the lines for the plugins you installed to your `CLAUDE.md`:

> - **Between pieces of work:** when you close one piece and move to the next, write your notes first. Check `context_usage`; if the window is filling, call `compact_after_turn` with `keep` and with `resume` naming the next piece. Leave `resume` out only when the next step waits on me, another session or a check.
> - **After editing a plugin:** call `reload_plugins_after_turn` with `resume` saying what to try next, and end the turn.
> - **Effort and model:** switch them with `set_effort` and `set_model` only when I ask. (Or: you may lower effort for routine work and raise it for hard problems; say so when you do.)
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
