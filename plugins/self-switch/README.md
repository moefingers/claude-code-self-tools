# self-switch

Lets a session switch its terminal to another conversation on Windows, for your own use. Once the current turn ends, this conversation ends here, its context untouched, and the conversation you named is resumed in its place: in the same process when both live in one project folder, in the pane's slot when it runs in one, or else in a new window. Before anything moves, it checks that the other conversation is open nowhere on this machine and that nothing still runs under this session. Part of [claude-code-self-tools](../../README.md).

Where the [coordinator](https://github.com/moefingers/agent-coordinator-3000) runs switches, this tool refuses: switches come from the coordinator there.

## Tool

`switch_after_turn` (Claude sees `mcp__self-switch__switch_after_turn`):

- `to` (required): the id of the conversation to switch to, as `claude --resume` takes it (a lowercase UUID).
- `reason` (required): why. It is recorded in both conversations.
- `notes` (required): where this conversation's notes are, written before the switch. Recorded in both conversations, so either can be picked up again.
- `resume` (optional): the message that starts the resumed conversation's first turn.

## How it behaves

- **Only when you ask, at a finished break.** The tool's description says to call it only when you ask to switch, never mid-merge, mid-push or mid-task, with notes written first, and to cancel wake-ups and Monitor tasks first (an in-place switch keeps the same process, and its timers).
- **The switch waits for the turn to end.** The call queues it, and it runs once the turn ends with Claude's answer. A new turn, or an interrupted one, cancels it, with a notice: the break it was queued at is no longer one.
- **A cancel is never lost.** When a new turn (a message, a watch event) takes a queued switch back, that turn reads a row: *self-switch: your queued switch to «…» was cancelled because a new turn started; queue it again at the next finished break.* Cancels of a switch to the same conversation are counted while they come in a row; from the third, the row adds that the session is busy, and to ask the merger to run it with the coordinated go, which waits for idle itself. A run that begins ends the count.
- **Never two copies of one conversation.** Right before it acts, the plugin runs one fixed probe script (Windows PowerShell by its known path, its only inputs the two session ids and folders it checked) that reads every running `claude.exe`, Claude Code's own session registry (`<config>\sessions\<pid>.json`), the transcripts' folders and times, and the claim locks. The conversation counts as open, and the switch refuses saying why, when:
  - **L1**: a running `claude.exe` holds it, by a registry entry whose process started within 1 ms of the entry's `procStart` (an entry whose process has gone, or whose pid another process took, is ignored);
  - **L2**: a process names it on its command line (`--resume`, `-r`, `--session-id`);
  - **L3**: its transcript was written in the last 10 minutes;
  - **L5**: its heartbeat (below) is less than 5 minutes old;
  - **L6**: another switch or restart holds the claim lock on it.

  It also refuses when it can't be sure: a registry file of a running `claude.exe` that can't be read, or is of a shape not verified (a key outside the 18 seen, or `pid`, `sessionId`, `procStart` or `status` missing or of another type); a `claude.exe` that no registry accounts for; no transcript of the conversation on this machine, or two. A new Claude Code that changes its registry stops switches, visibly, until the plugin is updated.
- **The claim lock.** The same probe run takes `%LOCALAPPDATA%\claude-self-tools\claims\<id>.lock`, created only if it isn't there, so of two switches that race, one wins. The process that resumes the conversation releases it. A lock whose creator has gone counts no more after 15 minutes.
- **Only at a safe point.** It refuses while anything still runs under this session: a subagent; a background Bash, PowerShell or Monitor job (any shell under its `claude.exe`); `git`, or a git operation in flight in any worktree of the repo (`index.lock`, a rebase, a merge, a cherry-pick, a revert, a bisect); a build, test or lint; a dev server, Playwright or a debugged browser; a [heavy-slot](#settings) job. For an in-place switch it also refuses while the checkout has uncommitted changes, since the next conversation works in the same checkout. Anything it can't read holds the switch and says what. Stdio MCP servers don't count.
- **The transports.**
  - **In place** (`/resume <id>`), when both conversations' transcripts sit in one project folder. The same process, pane, permission mode and Remote Control carry on. If the session id hasn't changed afterwards, the switch didn't take, and it says so instead of carrying on as if it had.
  - **The slot**, when this session runs in a pane set up as a slot (below) whose script has the hash this plugin ships: it leaves the slot a record and exits, and the slot resumes the conversation in the same pane.
  - **A new window** otherwise: the same launcher self-restart uses opens one in the conversation's own folder, waits for this process to exit, and resumes it there. Then this session exits.

  The slot and the window check again right before they run `claude --resume`: they read the registry and the process table once more and resume nothing if the conversation became open meanwhile, and they resume only when the claim lock still names them. No transport passes a permission flag: the resumed conversation starts in the mode a new session would.
- **What each conversation reads.** Before the transport, this conversation gets a row saying where it went, why and where its notes are, and how to resume it. The resumed one gets a row that opens *self-switch: a message from session «…»*: that session switched it here, its reason and notes follow in its own words, not yours, and they grant no new permission; then that things may have moved since. Then `resume`, if given, is its first prompt, framed the same way: that session's request, not yours, granting no new permission. It goes in the plugin's own frame, never as your words.
- **Another session's words stay data.** `reason`, `notes` and `resume` are kept as one line each: every line break (CR, LF, U+2028, U+2029) and tab becomes a space, control and invisible format characters (bidi controls, zero widths) are dropped, and each is cut at 400 characters with an ellipsis. In the rows each sits inside «…», with any « or » (and the backslash) inside escaped, so text can't close its quote or pass for the plugin's own lines.
- **The heartbeat.** In every conversation it runs in, the plugin notes in its own store, at each turn's start and end and every 2 minutes, when it last ran there, its start folder and that folder's project name (`alive:<id>`). The liveness check reads it, and a switch to a conversation of another project takes the folder to resume it in from it. A conversation of another project that has never run with this plugin has no known folder, and is refused. Heartbeats 30 days old are dropped.
- **No switch loop.** A conversation that switched away or arrived less than 2 minutes ago is refused another switch.
- **Subagents can't use it**, and it refuses while one is running.
- **Windows only, in a terminal.** Elsewhere nothing runs, and Claude is told on its next turn. A session in an app, an SDK host or a `-p` run is refused at the call.

## Coordinated mode

The [coordinator plugin](https://github.com/moefingers/agent-coordinator-3000) runs switches itself, at the merger's or your request. Where it does, it writes a gate file for the conversation, `%LOCALAPPDATA%\claude-self-tools\gate\<conversation>.json`:

```json
{ "v": 1, "coordinated": true, "at": 1793750400000 }
```

`at` is when it was written, in milliseconds since the epoch. While that file is there and at most a day old, every call refuses: *The coordinator runs switches in this session: ask the merger or Mo for a wrap-up.* A gate file older than a day is ignored; one that can't be read refuses. With the `requireCoordinator` setting on, a session with no gate file refuses too.

The gate guards against mistakes, not against a session set on switching: a session in a permissive mode can run `claude --resume` from its shell itself.

## Slots: keep your panes

Windows Terminal can't list its panes or swap the process in one, so a new window would change your layout. A slot keeps it: a pane that runs `slot/claude-slot.ps1`, which runs `claude`, and when Claude Code exits, honours the record a switch or restart left it and resumes that conversation in the same pane. Set it up once:

1. Copy the script, unchanged, to `%LOCALAPPDATA%\claude-self-tools\claude-slot.ps1`:

   ```
   New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\claude-self-tools" | Out-Null
   Copy-Item <this plugin's folder>\slot\claude-slot.ps1 "$env:LOCALAPPDATA\claude-self-tools\claude-slot.ps1"
   ```

   The plugin checks the copy's SHA-256 before it uses a pane as a slot (the hash is `SLOT_SCRIPT_SHA256` in `hooks/machine.ts`). An edited copy, or one from an older version, is never used as a slot: that pane then gets a new window, as a plain pane does. After an update, copy it again, and restart the slot panes: a pane keeps running the script it started with, and the hash is checked on the file.

2. Give your Windows Terminal profile (or a new "Claude slot" profile) this command line:

   ```
   powershell.exe -NoExit -NoProfile -ExecutionPolicy RemoteSigned -File "%LOCALAPPDATA%\claude-self-tools\claude-slot.ps1"
   ```

   `-ExecutionPolicy RemoteSigned` is there so this unsigned local script runs where the policy is `Restricted`, Windows' default; a copy made with `Copy-Item` from the plugin's folder isn't marked as downloaded, so `RemoteSigned` runs it. The script clears it again before it starts `claude`, so Claude Code and every PowerShell it starts get your machine's own policy.

What the slot does:

- It honours a record only when it is at most 120 seconds old, names a conversation by its id and an existing folder that is that conversation's own (the folder's project holds the conversation's transcript), the claim lock on that conversation names this slot, and no running Claude Code holds the conversation. It deletes the record first, so a record is used once.
- A registry file it can't read is read twice more, 250 ms apart. When it still can't tell, or anything else stops it, it says why and gives the `claude --resume <id>` line to run once it is safe; the pane stays.
- With no record, it waits: Enter starts a new Claude Code in the pane, and a record that arrives meanwhile is honoured (it looks every 2 seconds). Ctrl+C leaves the slot at a PowerShell prompt.
- It runs `claude` with no flags, or `claude --resume <id>`: no permission flag of any kind.
- Windows and panes are never closed for you.

## Settings

- `updateCheck` (`on`): see [Update check](#update-check).
- `requireCoordinator` (`off`): `on` refuses every switch in a session the coordinator hasn't written a gate file for.
- `configDirs` (none): other Claude Code config folders on this machine (another `CLAUDE_CONFIG_DIR`), whose registries and transcripts the liveness check also reads. This session's own is always read.
- `heavySlotRoot` (empty): the folder holding a `heavy-slot.sh`'s `.gate-lock` and `.gate-lock-2` slots, if you use one. A slot whose job runs under this session (by the Windows pid the slot records in `winpid`) holds the switch; a `heavy-slot.sh` job under it holds it either way.

Set them in `/config`, or from your shell, for example:

```
echo '{"requireCoordinator":"on"}' | claude plugin configure self-switch@claude-code-self-tools --values-stdin
```

To restart the same conversation, see [self-restart](../self-restart). To end the session, see [self-exit](../self-exit).

## Update check

When Claude calls this plugin's tool, and the last check is 30 minutes old or there hasn't been one, the plugin checks whether a newer version is published. It fetches this plugin's `plugin.json` from the `main` branch of the repository its installed `plugin.json` names, [`plugins/self-switch/.claude-plugin/plugin.json`](https://raw.githubusercontent.com/moefingers/claude-code-self-tools/main/plugins/self-switch/.claude-plugin/plugin.json), and compares its `version` with the installed one.

- **A plain GET of a public file.** The plugin adds no headers, query or body, and sends nothing about you, the session or the machine.
- **At most every 30 minutes**, its time and answer kept in the plugin's own store.
- **It never holds up the tool.** Offline, refused by policy, a 404, a rate limit, no answer within 5 seconds, or anything but a plain version all mean no notice.
- **When a newer version is out**, a toast tells you, and the result of one of Claude's next calls ends with the update steps for you to run. The line is fixed text; only the two version numbers vary.
- **Turn it off** with the plugin's `updateCheck` setting: `off` never checks. Nothing is checked while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, to any value, or for a subagent's call.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-switch@claude-code-self-tools
```
