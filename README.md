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
| [self-check](plugins/self-check) | `tools_check` | Echoes a nonce through the Bash and PowerShell tools as Claude calls them, each within 10 seconds, and lists the MCP servers, exercising one only through a probe you name; on Windows, says how much room the session env leaves a Bash command. Quietly again when the session is resumed, saying only what failed. Dedupes Bash's session env after each session start, against Git Bash's 8,186-character cut. Read-only but for its own record and that dedupe. | When a tool seems dead (an empty result, a call that never answers), before working around it. |
| [self-wake](plugins/self-wake) | `wake_after`, `cancel_wake` | Some minutes after the turn ends, sends the session a note that starts a turn of its own. | When it has to wait on something slow (a deploy, a long job) that won't report back by itself. |
| [self-remote-control](plugins/self-remote-control) | `remote_control` | Reports whether this session's Remote Control is connected, connects it under a title, and renames the session. After a login change it reconnects Remote Control on its own and resumes a turn the change cut off. | When you ask whether you can reach the session from your phone, to make it reachable before you step away, or to give it a title you'll recognise in the app's session list. |
| [self-clear](plugins/self-clear) | `clear_after_turn` | Runs `/clear` once the turn ends, then sends the handoff it was given as the cleared conversation's first prompt. Only with `why`: `complete` or `contaminated`. | Only when its work is complete and its notes are written down, or its context is contaminated. Otherwise it compacts, or restarts into the same conversation. |
| [self-exit](plugins/self-exit) | `exit_after_turn` | Runs `/exit` once the turn ends, its reason (and a note for whoever resumes it) recorded in the transcript first. Refuses while a session cron, a background job or a subagent would make `/exit` ask, saying how to stop each. | When you asked it to end the session, or its instructions say to close once its work is done or handed off. Only at a finished break, never mid-merge, mid-push or mid-task. |
| [self-restart](plugins/self-restart) | `restart_after_turn` | On Windows: exits, and the same conversation resumes once the old process has gone, then can resume on its own: in the same tab when Claude Code was started through the [claude wrapper](tools/claude-wrapper/claude-wrapper.ps1), in a slot pane's slot, or else in a new terminal window. | After an account switch, a setting that takes effect at startup, or a plugin that won't reload. Only at a finished break, never mid-merge, mid-push or mid-task. |
| [self-switch](plugins/self-switch) | `switch_after_turn` | On Windows: switches the terminal to another conversation, only when that one is open nowhere on this machine and nothing runs under this session: in place, in the pane's slot, in the same tab through the claude wrapper, or in a new window. For your own use; it refuses where the coordinator runs switches. | When you ask it to switch to another conversation, at a finished break, its notes written first. |

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
- **One launcher.** Every restart and switch out of the session (a slot's record, the tab's ticket, a window) is placed by one function, `launch()` in the shared machine code, in one script run that checks, takes the claim and places it; see [The launcher API](#the-launcher-api). The window it opens runs [`claude-launch.ps1`](plugins/self-switch/slot/claude-launch.ps1), the one script that starts `claude`.
- **The window.** The launch finds the session's own `claude.exe` and opens a new console window with `Start-Process`. `cmd /c start` would hand the plugin's output pipes on to the new session, and hold the plugin's call open for as long as that session runs.
- **The wait, and the last look.** The window waits for the old `claude.exe` to exit, then reads the registry and the process table once more, and runs `claude-launch.ps1 -Resume <id>` only if nothing else holds the conversation and the claim still names it; `claude-launch.ps1` takes the same last look again right before `claude`, with every config folder the launch read. So two copies never write one session, and Remote Control, which a second copy would leave off, connects in the new one.
- **A top-level session, in the mode a new one starts in.** `claude-launch.ps1` sets [the launch environment](#the-launch-environment) right before `claude`, and passes it no permission flag of any kind.
- **Slots keep your panes.** A Windows Terminal pane can run self-switch's `claude-slot.ps1`, which runs `claude` and, when it exits, resumes the conversation a switch or restart left it a record for, in the same pane. The plugins use a pane as a slot only when its script has the hash they ship. See [self-switch](plugins/self-switch#slots-keep-your-panes).
- **The same tab, through the claude wrapper.** Nothing outside a terminal tab can type into it once `claude` has exited, so the tab's own PowerShell has to be the one that resumes. [`tools/claude-wrapper/claude-wrapper.ps1`](tools/claude-wrapper/claude-wrapper.ps1) is a `claude` function for your PowerShell profile: you go on typing `claude`, and it runs the real `claude.exe` with your arguments. It gives each run a token (`CLAUDE_PANE_TOKEN`) and a pane file naming the PowerShell that runs it. A restart or a switch out of that session, when that PowerShell is the session's own parent and its pane file is of version 3, leaves the tab a ticket naming the claim it took and every config folder the move reads, and exits; the function deletes the ticket, checks it (this tab's token, a session id and a launch's claim, at most 120 seconds old, an existing folder whose project holds the conversation's transcript, its config folders absolute folders, its left record's stat, when it carries one, whole numbers, and the claim lock on the conversation still naming the ticket's claim), takes the window's and the slot's last look right before claude runs (no running Claude Code holds the conversation, read again from the session registry of its own config folder and of each the ticket names, and every command line), and runs `claude --resume <id>` in the same tab, with Claude Code's markers cleared as a window clears them. A wrapper of version 2 (before this one) reads its own config folder alone, so it gets a ticket only for a move that reads that one alone; copy the current one into place for the rest. The token is no secret (it names the pane file, and every process under claude has it), so the claim and the last look are what keep a ticket from putting a second process on a conversation. At most 10 resumes per `claude` typed, and never a fourth within 30 seconds. A ticket it doesn't use is said in one line, and you are back at the prompt. To use it, copy the file to `%LOCALAPPDATA%\claude-self-tools\claude-wrapper.ps1` and add `. "$env:LOCALAPPDATA\claude-self-tools\claude-wrapper.ps1"` to your `$PROFILE`. Without it, a restart or a switch opens a new window, as before.
- **The first prompt** waits in the plugin's own store, never on a command line, and the resumed session's copy of the plugin sends it.
- **A pending wake-up holds a switch (S10w).** self-switch reads self-wake's [wake marker](#wake-markers) for its own conversation: a wake-up armed holds the switch, and so does self-wake being on with no marker it can read.
- **Return trips.** A conversation a process has just left reads as live for about ten minutes (its transcript and its heartbeat are fresh). self-switch writes a [left record](#return-trips-the-left-record) when it moves its own process off one, and a switch back to it soon after goes ahead once the record shows nothing touched it since.
- **Windows only** for now.

### The launcher API

`launch(input)` and `parseLaunch(stdout)`, in [`shared/hooks/machine.ts`](shared/hooks/machine.ts), are how every plugin (these and the coordinator's) starts a Claude Code process. `launch` returns `{ argv, stdin }` for `$.process.run`: Windows PowerShell by its known path, a fixed bootstrap on the command line, and the script on standard input, so the command line is the same few hundred characters whatever the script. Its input, each field checked before anything is spliced into the script (a bad one throws):

| Field | What |
| :- | :- |
| `powershell` | `powershellPath(SystemRoot)`. |
| `kind`, `id`, `name` | `resume` (`claude --resume <id>`) or `start` (`claude --session-id <id> --name <name>`; `name` lowercase letters, digits and hyphens). |
| `folder` | The conversation's own folder: absolute, no quote, control character or `;`. |
| `claim` | The claimant the claim lock names: `launch:<uuid>`, or `slot:<id>` for that slot. |
| `configDirs`, `stateDir` | The config folders the checks read (1 to 8), and `%LOCALAPPDATA%\claude-self-tools`. |
| `where` | `{ pane: { token } }` (this tab, through the claude wrapper's ticket; a ticket naming more than one config folder, or carrying `left`, needs the wrapper of pane file version 3, which the launch reads itself and refuses otherwise), `{ slot: id }` (this pane's slot runner), `{ window: true }` (a new window), or `'auto'` (this pane's slot when its runner is verified and takes the folder, else a window: self-restart's). |
| `checks` | `live` (NOT LIVE now, for a launch that doesn't wait), `fresh` (a start's id is new: required for a start). `floor` and `input` come with slots v2 and throw until then. |
| `left` | A left record's stat (`{ size, mtime }` or `{ exitAt }`): the window's last look refuses if the transcript changed since. |
| `waitForExit` | `{ pid, created }`: the caller's own claude.exe, which the tab, the slot or the window waits out before it resumes. |
| `now`, `deadline` | The ticket's time; and the last moment the launch may be placed (callers give `LAUNCH_DEADLINE_MS`, 20 s, under a 30 s run): past it, nothing is placed, and a launch found past it once placed is taken back. |
| `tool` | Who launches, as a refusal names it. |

The script, in one run: resets `PSModulePath`; finds the caller's own `claude.exe` (and checks it is `waitForExit`); for a tab whose ticket needs it, reads the pane file's version; for a window, puts `claude-launch.ps1` in place at its own name, `claude-launch-<first 8 hex digits of its SHA-256>.ps1`, when it is missing or has another SHA-256 than this release ships (the copy the launch carries, `LAUNCH_SCRIPT_TEXT`: written whole under another name, checked, moved over, read back), and is refused only when that fails, then keeps the copy for use by hand (below); makes the checks asked for; takes the claim lock (`CreateNew`, as the probe does); and places the launch. The window runs under `-ExecutionPolicy Bypass`: it runs `claude-launch.ps1` only with the SHA-256 it pins, checked right before, a stronger check than `RemoteSigned`'s, under which a downloaded file's mark would make the run fail after the old process has gone. A run that stops on an error (a Group Policy execution policy, a `claude.exe` an update holds) is caught: the window says so and how to resume by hand, and waits for Enter. It answers one of:

```
claim launch:<uuid>
launched window - 17716          # or: launched pane <token> | launched slot <pid>-<created>
fallback <why this pane's slot runner wasn't used>   # 'auto' only, when it went to the window

refused <code> <why>             # session, wait, slot, pane, launcher, live, fresh, claim, place, late
```

A refusal after the claim gives the claim back first. `pickLaunchTransport(probe, { replacing, pane, configCount, needsLeft })` picks `where` for a launch that replaces its caller, in order: this tab, this pane's slot, a window. `configCount` (how many config folders the launch reads, 1 to 8) and `needsLeft` (whether the verdict rests on a left record: `live.waived` set and the verdict without the record not `not-live`) are required, never defaulted: a tab of pane file version 2 takes neither more than one folder nor a left record. Examples:

```ts
// A restart (self-restart's): this tab when the wrapper runs it, else 'auto'.
launch({ powershell, kind: 'resume', id: own, folder: startFolder, claim: `launch:${crypto.randomUUID()}`, configDirs, stateDir,
  where: { pane: { token } }, waitForExit: { pid, created }, now, deadline: now + LAUNCH_DEADLINE_MS, tool: 'self-restart' })
// A switch's window to another project's conversation, its left record checked at the last look.
launch({ ..., id: to, folder: toFolder, claim: probeClaim, where: { window: true }, left: live.waived, waitForExit, deadline, tool: 'self-switch' })
// A start in a new window, its id checked new.
launch({ ..., kind: 'start', id: crypto.randomUUID(), name: 'dealerwrap', where: { window: true }, checks: { fresh: true } })
```

### The launch environment

[`claude-launch.ps1`](plugins/self-switch/slot/claude-launch.ps1) is the one script that runs `claude` for a launch. After its checks, the module path, the folder and finding `claude`, it takes the last look a launch's window and the claude wrapper take, the same lines (`RECHECK`, and `LEFT_RECHECK` with a left record's stat), for `-Resume`, `-Lane` and `-Start`, by hand too: no running Claude Code holds the conversation, read from the session registry of its config folder and of each `-ConfigDir`, and every command line; held, or unreadable, it starts nothing and says why. Right before it runs `claude`, it:

- removes `LAUNCH_ENV_CLEAR`: the variables Claude Code sets in the processes it starts (`CLAUDE_CODE_CHILD_SESSION` and the rest of `SESSION_MARKERS`; a `claude` that inherits them is nested, and saves no transcript), `NO_COLOR` among them (Claude Code sets it in its tool shells, so a tab launched from one draws no colour); and `LAUNCH_ENV_DROP`: `PSExecutionPolicyPreference`, and `CLAUDE_PANE_TOKEN` (the claude wrapper's token for the tab a session ran in; a session resumed in a window has no tab of its own);
- sets `LAUNCH_ENV_SET`: `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` (transcripts on, whatever marker a later Claude Code adds) and `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1` (Mo's choice: the page file carries the load rather than shells being reaped);
- never touches `WT_SESSION` or `WT_PROFILE_ID`: Claude Code reads `WT_SESSION` to draw its prompt and its links.

`claude` is `%USERPROFILE%\.local\bin\claude.exe` when it is there, else the first `claude` application on `PATH`. It is also the hand tool:

```
claude-launch.ps1 -Resume <session id> [-Dir <folder>]
claude-launch.ps1 -Start <session id> -Name <name> [-Dir <folder>]
claude-launch.ps1 -Lane <name>              # the name's current conversation and folder, from lanes.json; says which
claude-launch.ps1 [-Dir <folder>]           # a new session
  -ConfigDir <folder>[,<folder>...]         # other config folders whose registries the last look reads too
  -LeftSize <bytes> -LeftMtime <ms> | -LeftExitAt <ms>   # with -Resume: a left record's stat, checked
```

By hand, the last look reads your own config folder (`CLAUDE_CONFIG_DIR`, else `%USERPROFILE%\.claude`) and each `-ConfigDir`, and every command line on the machine; a launch's window hands it every config folder the launch read, and the left record's stat when its move rests on one. An argument given empty refuses, and a folder is held to the plugins' own rule.

It lives beside the slot runner, in `%LOCALAPPDATA%\claude-self-tools`, and nobody copies it there. Every launch that opens a window first puts its own copy there under its own name, `claude-launch-<first 8 hex digits of its SHA-256>.ps1`, when that file is missing or has another SHA-256 (`LAUNCH_SCRIPT_SHA256`), and the window runs it only from there, only with that hash, checked again right before it runs. Each version of the plugins has its own file, so sessions of two versions running side by side never overwrite each other's. A launch is refused only when the file can't be put in place (the folder can't be written, say), saying why. An edited copy is replaced at the next launch. The same launch keeps `claude-launch.ps1` there for you to run by hand: the highest version any launch has carried (its `# claude-launch version <n>` line, `LAUNCH_SCRIPT_VERSION`), written when it is missing or of a lower version, never one of the same or a higher; a window never runs it. The slot runner and the claude wrapper keep the same list of their own until slots v2 (a test holds them equal); the wrapper sets `LAUNCH_ENV_SET` too, and the slot runner sets the persistence variable alone until then.

### Return trips: the left record

When self-switch moves its own process off a conversation W (in place, from the arriving conversation's SessionStart, 3 s after it; or right before its own `/exit`), it writes `%LOCALAPPDATA%\claude-self-tools\left\<W>.json`: which process left W and when, and W's transcript as it stood (its config folder, project, size and time), with an HMAC-SHA256 under `left.key`, 32 random bytes made once and read only inside the fixed scripts. A switch to W reads the record with its probe, and it waives two of the liveness signals, W's fresh transcript and heartbeat, and only those, when all of these hold: the MAC matches and the record names W; it is at most 10 minutes old; W's one transcript is in the folder and project it names and is unchanged since (in place: the same size and time; on exit: no write more than 10 s after); the process that left it is gone, or holds another conversation; and no heartbeat came after it. A running Claude Code that holds W, a command line naming it, a claim lock and anything unreadable still refuse. The last look checks the transcript again: in place, in the window and in a tab of the claude wrapper (pane file version 3, the ticket carrying the record's stat), each refusing if W's transcript changed since. This pane's slot runner doesn't check it until slots v2, nor does an older wrapper: a move that rests on a record goes to a new window instead, saying why. No record is written for an `/exit` you type, a crash or a kill. self-restart writes none: it resumes its own conversation. The MAC stops stray or torn writes; it is no defence against another process of your own user, which could as well run `claude --resume`.

### Wake markers

self-wake writes `%LOCALAPPDATA%\claude-self-tools\wake\<conversation>.json`, `{ "v": 1, "armed": true|false, "due"?: <ms>, "at": <ms> }`: at the start of each conversation its process holds, when a wake-up is armed or replaced, when it fires, and when it is cancelled. `armed` is true only while the process holds a timer for that conversation's wake-up; the wake-up keeps the conversation it was armed in, so a reload arms it again for that one. The armed marker is written before the turn's end returns, and once more when that fails; failing twice, the marker is removed before the turn's end returns (it then reads as unknown, which holds) and a toast says so. self-switch and the coordinator read it (S10w): armed holds a switch or a go; self-wake on with no marker, or one that doesn't read, holds too, saying to update self-wake to 0.2.0 or later, or, when it is that already, to run `/reload-plugins` or `cancel_wake`; without self-wake in the session, nothing holds. self-switch reads the marker of the conversation its last SessionStart named (within 15 seconds of it; past that, or where none reached it, the one `$.session.id()` reads), at the call, at the run and once more right before its final command.

### lanes.json

`<config folder>\lanes.json` maps each session name to its current conversation: `{ "v": 1, "at", "lanes": { "<name>": { "session", "folder", "window"?, "tab"?, "ws", "at" } } }`. The coordinator plugin writes one entry at a time with `lanesUpdateScript` (a lock held as a handle, a temporary file, `[IO.File]::Replace`; names compared exactly, one that isn't a session's name dropped); a writer of its own would need this same script, since another lock would not keep this one's writers out. A file not of its shape is left as it is, and the refusal says how to start again. `readLanes` reads it strictly, dropping a malformed entry and keeping the rest; `claude-launch.ps1 -Lane <name>` says which conversation the name resolves to and resumes it in the entry's folder. It is a map, not an authority: the launch takes its last look at the conversation as any launch does, and starts nothing if it is open elsewhere. [`tools/lanes-seed`](tools/lanes-seed/lanes-seed.mjs) prints a proposed file from a session inventory, and writes nothing.

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
> - **A tool seems dead:** when Bash or PowerShell answers with nothing, or a call never answers, call `tools_check` before working around it; if it says a tool failed, follow the repair it gives: for a dead Bash whose env is too long, move the PowerShell tool's directory and back in two calls, then try Bash again; for any other dead tool, restart (`restart_after_turn`) at the next finished break.
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

The test fails when a copy differs from `shared/`, or is left over from a file removed from it or kept in a plugin its `Copies:` line leaves out. `scripts/slot-runner.test.mjs` checks the slot runner against the hash the plugins ship. `scripts/claude-wrapper.test.mjs` runs the claude wrapper in Windows PowerShell 5.1 and PowerShell 7 against a stub `claude.exe` (`scripts/claude-wrapper-stub.cs`, compiled into a temporary folder), never a real Claude Code, then plants faults in copies of it and checks each is caught; it takes about five minutes, most of it the 10-resume cap. Each plugin's `tests/update-check.fixture.ts` gives the shared test that plugin's name and a call of one of its tools.

To run every check at once (the copies, then each plugin's `validate --strict` and `test`, then the marketplace file):

```
node scripts/test-all.mjs
```

To try a plugin from your working copy, start a session with `claude --plugin-dir plugins/<name>`.

Each plugin's `tsconfig.json` extends `.claude-plugin/types/tsconfig.json` inside that plugin. Claude Code writes that folder, with type definitions for the version you run, when it loads the plugin from `--plugin-dir` in an interactive session. The folder is not committed.

## Tools

Not plugins: scripts a session runs on the machine.

- [dev-run](tools/dev-run): runs a dev server in place of a `next dev` started by hand. It restarts the server every 10 minutes, starts it only at a free-memory floor, stops it under a lower one, stops it for good when idle, and claims a [heavy-slot](tools/dev-run#heavy-slots) slot for each first compile. Its tests run in `node scripts/test-all.mjs`.

## License

[MIT](LICENSE)
