# claude-code-self-tools

Small [Claude Code](https://code.claude.com/docs) plugins that let a session act on itself. Each one gives Claude a tool or two for something you would otherwise do by hand from the prompt: compact or clear the conversation, reload plugins, reconnect an MCP server, check the context window, check that its own tools answer, come back to a task later, turn on Remote Control under a title, exit or restart, or switch to another conversation.

Each plugin is separate. Install only the ones you want.

## The plugins

| Plugin | Tools | What it does | When a session uses it |
| :- | :- | :- | :- |
| [self-compact](plugins/self-compact) | `compact_after_turn` | Compacts the conversation once the turn ends, keeping what the call says, then can resume on its own. | At the break between two pieces of work, so the next piece starts with room in the context window. |
| [self-reload](plugins/self-reload) | `reload_plugins_after_turn` | Runs `/reload-plugins` once the turn ends, then can resume on its own. | After it has edited a plugin and needs the change live, for example to try a tool it just changed. |
| [self-mcp](plugins/self-mcp) | `reconnect_mcp_after_turn` | Runs `/mcp reconnect <server>` (or `all`) once the turn ends, then can resume on its own. | When an MCP server's tools stop answering and a reconnect is all it needs, such as a browser extension that dropped. |
| [self-context](plugins/self-context) | `context_usage` | Reports the tokens used, the window, the percentage and whether auto-compact is on. Read-only. | At a break between pieces of work, to decide whether to compact now. |
| [self-check](plugins/self-check) | `tools_check` | Echoes a nonce through the Bash and PowerShell tools as Claude calls them, each within 10 seconds, and lists the MCP servers, exercising one only through a probe you name. Quietly again when the session is resumed, saying only what failed. Read-only but for its own record. | When a tool seems dead (an empty result, a call that never answers), before working around it. |
| [self-wake](plugins/self-wake) | `wake_after`, `cancel_wake` | Some minutes after the turn ends, sends the session a note that starts a turn of its own. | When it has to wait on something slow (a deploy, a long job) that won't report back by itself. |
| [self-remote-control](plugins/self-remote-control) | `remote_control` | Reports whether this session's Remote Control is connected, connects it under a title, and renames the session. After a login change it reconnects Remote Control on its own and resumes a turn the change cut off. | When you ask whether you can reach the session from your phone, to make it reachable before you step away, or to give it a title you'll recognise in the app's session list. |
| [self-clear](plugins/self-clear) | `clear_after_turn` | Runs `/clear` once the turn ends, then sends the handoff it was given as the cleared conversation's first prompt. Only with `why`: `complete` or `contaminated`. | Only when its work is complete and its notes are written down, or its context is contaminated. Otherwise it compacts, or restarts into the same conversation. |
| [self-exit](plugins/self-exit) | `exit_after_turn` | Runs `/exit` once the turn ends, its reason (and a note for whoever resumes it) recorded in the transcript first. Refuses while a session cron, a background job or a subagent would make `/exit` ask, saying how to stop each. | When you asked it to end the session, or its instructions say to close once its work is done or handed off. Only at a finished break, never mid-merge, mid-push or mid-task. |
| [self-restart](plugins/self-restart) | `restart_after_turn` | On Windows: opens a new terminal window (or, in a slot pane, leaves the slot a record), exits, and the same conversation resumes once the old process has gone, then can resume on its own. | After an account switch, a setting that takes effect at startup, or a plugin that won't reload. Only at a finished break, never mid-merge, mid-push or mid-task. |
| [self-switch](plugins/self-switch) | `switch_after_turn` | On Windows: switches the terminal to another conversation, only when that one is open nowhere on this machine and nothing runs under this session: in place, in the pane's slot, or in a new window. For your own use; it refuses where the coordinator runs switches. | When you ask it to switch to another conversation, at a finished break, its notes written first. |

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
/plugin install self-check@claude-code-self-tools
/plugin install self-wake@claude-code-self-tools
/plugin install self-remote-control@claude-code-self-tools
/plugin install self-clear@claude-code-self-tools
/plugin install self-exit@claude-code-self-tools
/plugin install self-restart@claude-code-self-tools
/plugin install self-switch@claude-code-self-tools
```

Each install opens the plugin in the `/plugin` panel, where you choose a scope.

Or from your shell:

```
claude plugin marketplace add moefingers/claude-code-self-tools
claude plugin install self-compact@claude-code-self-tools
claude plugin install self-reload@claude-code-self-tools
claude plugin install self-mcp@claude-code-self-tools
claude plugin install self-context@claude-code-self-tools
claude plugin install self-check@claude-code-self-tools
claude plugin install self-wake@claude-code-self-tools
claude plugin install self-remote-control@claude-code-self-tools
claude plugin install self-clear@claude-code-self-tools
claude plugin install self-exit@claude-code-self-tools
claude plugin install self-restart@claude-code-self-tools
claude plugin install self-switch@claude-code-self-tools
```

The install says whether the plugin is already active in the open session or needs `/reload-plugins` there. New sessions load it when they start.

A mod runs inside Claude Code with your permissions. To see what one hooks and calls before you install it, clone the repository and run `claude plugin validate plugins/<name>`.

## How they behave

What they have in common:

- **Actions wait for the turn to end.** A compaction, a clear, a reload, an MCP reconnect, a wake-up, a Remote Control connect, an exit and a restart are all queued by the tool call and run once the turn ends with Claude's answer. Claude Code can't run them while the turn is running. Claude should end its turn after calling one of these tools.
- **An interrupted turn cancels what it queued.** If you stop the turn (Esc or **Stop**), or it ends any way other than with Claude's answer, what that turn queued is dropped, and a notice says so. Something set in an earlier turn, such as an armed wake-up, stands.
- **Subagents are refused.** These tools act on the main conversation. A subagent that calls one is told why it can't, and to finish its piece and return its result so the main session can act. `context_usage` and `tools_check` refuse a subagent too, because what they report is the main session's.
- **Each change is announced.** A toast tells you what ran, and the tool result tells Claude. When Claude Code refuses an action (a command a plugin may not run), a toast says why, and Claude is told on its next turn.
- **Built-in commands run as if you typed them.** self-reload runs `/reload-plugins`, self-mcp runs `/mcp reconnect <server>`, self-remote-control runs `/remote-control` and `/rename`, self-clear runs `/clear`, self-exit and self-restart run `/exit`, and self-switch runs `/resume <id>` or `/exit`. Their lines show in the transcript, as yours would. A command that asks for confirmation shows you its dialog and waits for your answer, as it would if you had typed it.
- **What can't be undone needs a reason.** A clear keeps nothing of the conversation but its `handoff`, and an exit, a restart or a switch ends the process or the conversation, so each of those tools requires its `handoff` or `reason` (and a switch its `notes`). A clear also needs its `why`: the work is `complete`, or the context is `contaminated`; anything else should compact or restart instead. Each refuses while a subagent is still running, whose result or work would be lost. They act only on the session itself: none changes a setting, a permission, CLAUDE.md or any other configuration.
- **An exit never stops at a dialog it could have seen coming.** Before queuing `/exit`, self-exit and self-restart check for what would make it ask, or end work still running: a session cron (read with `CronList`, only after the permission check says `allow`), a background job under the session, a subagent. They refuse while any stands, naming each with how to stop it, at the call and again right before the exit; anything they can't read refuses too. While an exit or restart is queued, a pending marker tells a coordinator to hold its deliveries, so that none starts a turn that cancels it.
- **Each says when it's out of date.** When Claude calls one of a plugin's tools, at most every 30 minutes, the plugin fetches its own published `plugin.json` from this repository and compares versions, without holding up the tool. The request is a plain GET of a public file: the plugin adds no headers, query or body, and GitHub sees what it sees of any web request (the address, the time, the headers Claude Code sends on its own). If a newer version is out, a toast tells you, and a tool result tells Claude the update steps for you to run, at most once every 30 minutes in a session. Turn it off with the plugin's `updateCheck` setting; it is also off while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set. Each plugin's README has the details.

### Reloads

A reload replaces each plugin's code. What a plugin keeps in Claude Code's session state survives; its variables and timers don't. The plugins are built for that:

- self-reload writes its `resume` message to session state before it runs `/reload-plugins`, and sends it once, from whichever copy of itself is running when the reload is done.
- self-wake keeps the armed wake-up in session state and arms it again when its code reloads, for the time left, or at once if that time has passed.
- A wake-up lasts as long as the session. It doesn't survive quitting Claude Code.

### Remote Control

Run while the session is connected, `/remote-control` doesn't disconnect it: in the interactive terminal it opens the Remote Control panel (the session's link, **Disconnect this session**, **Show QR code**, **Continue**) and waits for you. self-remote-control never runs it then. It reads whether the session is connected from the command's own description, which Claude Code works out from the session's connection each time it lists the command. It recognises two descriptions: `Disconnect Remote Control` (connected) and `Control this session from your phone or claude.ai/code` (not connected). It runs the command only on the second, read again right before it runs, and refuses on any description it doesn't recognise, so a future Claude Code that rewords it gets a refusal, not a panel waiting on you. It never disconnects; that is yours, from the panel.

The app's session list takes a session's title as the session connects: the name given to `/remote-control <name>`, or else its `/rename` title. A session with neither shows its last message or a name like `<hostname>-<adjective>-<noun>`. So `connect` passes a title: the `name` Claude gives, or else the session's own `/rename` title, which Claude Code passes to the SessionStart and UserPromptSubmit hooks. `rename` runs `/rename` and nothing else. A `/rename` while connected updated the title in the app too when we tried it (Claude Code 2.1.314); if the app doesn't show the new title, the session needs reconnecting, or renaming in the app.

The attached clients that `status` lists are the screens drawing the session now. A connected session with no phone open shows only the terminal, so that list doesn't tell you whether the session is connected.

### Restarts and switches

self-restart and self-switch share one module of machine code (`shared/hooks/machine.ts`): a probe of the machine, the rules that judge it, and the launcher. self-exit uses it for its pre-check, and self-check for its record's path. Each script runs in Windows PowerShell, by its known path under the Windows folder, as one fixed script whose only inputs are session ids and folders the plugin checked.

- **Never two copies of one conversation.** Before a switch, a probe reads every running `claude.exe`, Claude Code's own session registry, the transcripts' folders and times, and the claim locks; the switch goes ahead only when the conversation is open nowhere on this machine, and refuses when it can't be sure. The same run takes a claim lock on the conversation, so of two moves that race, one wins.
- **The window.** The launcher finds the session's own `claude.exe` and opens a new console window with `Start-Process`. `cmd /c start` would hand the plugin's output pipes on to the new session, and hold the plugin's call open for as long as that session runs.
- **The wait, and the last look.** The window waits for the old `claude.exe` to exit, then reads the registry and the process table once more, and runs `claude --resume <id>` only if nothing else holds the conversation and the claim still names it. So two copies never write one session, and Remote Control, which a second copy would leave off, connects in the new one.
- **A top-level session, in the mode a new one starts in.** The window clears the markers Claude Code sets in the processes it starts, which would make the resumed session count as nested, and passes `claude` no permission flag of any kind.
- **Slots keep your panes.** A Windows Terminal pane can run self-switch's `claude-slot.ps1`, which runs `claude` and, when it exits, resumes the conversation a switch or restart left it a record for, in the same pane. The plugins use a pane as a slot only when its script has the hash they ship. See [self-switch](plugins/self-switch#slots-keep-your-panes).
- **The first prompt** waits in the plugin's own store, never on a command line, and the resumed session's copy of the plugin sends it.
- **Windows only** for now.

### Why there is no effort, model or permission switch

- **Effort.** Claude Code asks you to confirm a change of effort level partway through a conversation, because the next message then re-processes the whole history. A plugin that runs `/effort` gets the same dialog, so the switch can't run unattended.
- **Model.** `/model` also sets your default for new sessions, which is a settings change.
- **Permissions.** A session that raises its own permission mode, or widens its own file access, would be taking a decision that is yours.

Effort, model and permissions stay yours to change.

## Tell sessions when to use them

The tool descriptions say when to call each tool and when not to. To make it a habit, add the lines for the plugins you installed to your `CLAUDE.md`:

> - **Between pieces of work:** when you close one piece and move to the next, write your notes first. Check `context_usage`; if the window is filling, call `compact_after_turn` with `keep` and with `resume` naming the next piece. Leave `resume` out only when the next step waits on me, another session or a check.
> - **After editing a plugin:** call `reload_plugins_after_turn` with `resume` saying what to try next, and end the turn.
> - **An MCP server stopped answering:** when a server's tools fail in a way a reconnect fixes (the browser extension dropped, the server crashed or timed out), call `reconnect_mcp_after_turn` with the server's name and `resume` saying what to try again, and end the turn.
> - **Waiting on something slow:** when a deploy, a long job or a check will take a while and nothing will tell you it's done, call `wake_after` with the minutes and a note saying what to check, and end the turn. Cancel it with `cancel_wake` if the answer comes first.
> - **Remote Control:** when I say I'm stepping away, call `remote_control` with `connect` and a `name` saying what this session is working on. When the work changes, retitle it with `rename`, with a `resume` naming your next step. Never try to disconnect it.
> - **A fresh start, rarely:** keep the context healthy by compacting; restart into the same conversation for a fresh process. Clear only when the work is complete and its notes are written (`why: 'complete'`), or the context is contaminated (`why: 'contaminated'`): write your notes, then call `clear_after_turn` with the `why` and a `handoff` naming the next piece and where its notes are.
> - **A tool seems dead:** when Bash or PowerShell answers with nothing, or a call never answers, call `tools_check` before working around it; if it says a tool failed, restart (`restart_after_turn`) at the next finished break.
> - **Ending, restarting or switching:** only at a finished break, never mid-merge, mid-push or mid-task. Call `exit_after_turn` only when I ask you to end the session or your brief says to close it when done, with the `reason`. After I switch accounts or change a setting that needs a restart, call `restart_after_turn` with the `reason` and a `resume` naming the next step. Call `switch_after_turn` only when I ask you to switch to another conversation, with `to`, the `reason` and where your `notes` are, written first; where the coordinator runs, it starts switches, and the tool refuses.

## Develop

Each plugin is a folder under `plugins/`. Check one with:

```
claude plugin validate plugins/self-wake
claude plugin test plugins/self-wake
```

`validate` checks the manifest and lists the events the hooks module handles and the calls it makes. `test` runs the plugin's `tests/*.test.ts` with no session, sign-in or network. `claude plugin validate .` at the top checks the marketplace file.

Code the plugins share lives once under `shared/`: the update check (`shared/hooks/update-check.ts`) and its tests (`shared/tests/update-check.test.ts`), which every plugin carries, and the machine code (`shared/hooks/machine.ts`), which only self-restart and self-switch carry. The plugins install separately, so each carries a copy at the same path in its own folder. A shared file with a line `Copies: <plugin>, <plugin>` goes only to the plugins it names, and a copy anywhere else is stale. Edit the files under `shared/`, then write the copies (which also removes the copies of files no longer in `shared/`) and check them, with Node:

```
node scripts/sync-shared.mjs
node --test "scripts/*.test.mjs"
```

The test fails when a copy differs from `shared/`, or is left over from a file removed from it or kept in a plugin its `Copies:` line leaves out. `scripts/slot-runner.test.mjs` checks the slot runner against the hash the plugins ship. Each plugin's `tests/update-check.fixture.ts` gives the shared test that plugin's name and a call of one of its tools.

To run every check at once (the copies, then each plugin's `validate --strict` and `test`, then the marketplace file):

```
node scripts/test-all.mjs
```

To try a plugin from your working copy, start a session with `claude --plugin-dir plugins/<name>`.

Each plugin's `tsconfig.json` extends `.claude-plugin/types/tsconfig.json` inside that plugin. Claude Code writes that folder, with type definitions for the version you run, when it loads the plugin from `--plugin-dir` in an interactive session. The folder is not committed.

## License

[MIT](LICENSE)
