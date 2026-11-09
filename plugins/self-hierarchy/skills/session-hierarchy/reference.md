# Session hierarchy: reference

The long form of [SKILL.md](SKILL.md): each self tool in detail, how to launch a session, and checklists for briefing subagents. Each plugin's own README is the authority on its tool; this page says how a hierarchy uses it.

## What every self tool shares

- **It acts on the session that calls it.** No self tool acts on another session. To restart a lane, the coordinator asks it to, and the lane calls the tool.
- **Subagents are refused.** A subagent that calls one is told to finish its piece and say what it needs. The session that launched it calls the tool.
- **It waits for the turn to end.** The `_after_turn` tools and `wake_after` queue their action, and it runs once the turn ends with Claude's answer. End the turn after calling one.
- **An interrupted turn cancels it.** Stopping the turn drops what that turn queued, with a notice.
- **A new turn cancels a queued restart, switch, exit or clear.** A message from a peer starts a new turn. A restart or a switch cancelled this way leaves a row the next turn reads; from the third cancel in a row, the row says the session is busy, and to queue it again when it is idle or ask the merger or the owner.
- **Commands run when the session is idle.** Claude Code queues a plugin's command (`/exit`, `/clear`, `/resume`, `/reload-plugins`, `/mcp`, `/rename`) behind anything already waiting. Under a steady stream of messages and notifications, it can wait a long time. Only a compaction can run between turns, ahead of what is queued.
- **A pending marker.** While an exit or a restart is queued, self-exit and self-restart keep a pending marker for the conversation. A coordinator plugin that reads it holds its deliveries, so no message starts a turn that cancels the exit or restart.
- **A tool that takes a `resume` carries on by itself.** The `resume` message starts the next turn once the action has run. Leave it out only when the next step waits on someone else.

## The tools, one by one

Claude sees each tool as `mcp__<plugin>__<tool>`.

### `compact_after_turn` (self-compact)

- Inputs: `keep` (required: what the summary must hold on to), `resume` (optional), `when` (`between-turns`, the default, or `idle`).
- Keeps a summary and loses detail. The process and the conversation go on.
- `between-turns` compacts as the turn ends, ahead of anything queued; what was queued then runs on the compacted conversation. `idle` waits half a second after the turn ends, so anything queued goes first.
- In a hierarchy: put your area's open threads, PR numbers and heads, decisions, and where your notes are in `keep`. Put the next piece in `resume`.

### `context_usage` (self-context)

- No inputs. Read-only.
- Says the tokens used, the window, the percentage, and whether auto-compact is on.
- Call it at a break, to decide whether to compact before the next piece starts.

### `restart_after_turn` (self-restart)

- Inputs: `reason` (required, recorded in the transcript), `resume` (optional: the first prompt after the restart).
- A fresh process on the same conversation (`claude --resume <id>`). The context stays.
- Windows only, in a terminal. It resumes in the same tab through the `claude` wrapper, in a slot pane when the session runs in one, or else in a new window.
- It needs a safe point. It refuses while anything runs under the session (a background job, git, a build, a test or a lint, a dev server, a heavy job), while a git operation is in flight in the repository, while a session cron is set, while a subagent hasn't ended, and while a wake-up is pending. Each refusal names what holds it and how to stop it.
- It refuses a second restart within 2 minutes of the last.
- In a hierarchy: the usual repair for a dead tool, and the way to load a new plugin version with a clean process. The coordinator asks a lane to restart at its next finished break.

### `clear_after_turn` (self-clear)

- Inputs: `why` (required: `complete` or `contaminated`, nothing else) and `handoff` (required: the first prompt of the cleared conversation).
- Loses the whole story. Only the `handoff` survives. A leaving row records why.
- It refuses while a subagent is pending, running or waiting.
- Plugins, their tools and their timers carry on through a clear.
- In a hierarchy: rare. A lane's long story of how its piece fits the whole is worth keeping, so compact or restart instead.

### `switch_after_turn` (self-switch)

- Inputs: `to` (required: the conversation's id), `reason` and `notes` (required, recorded in both conversations), `resume` (optional), `trees` (optional: the worktrees the session worked in, each of which must be clean).
- Moves the terminal to another conversation: in place when both share a project folder, in the pane's slot, in the same tab through the wrapper, or else in a new window. This conversation's context is kept, to resume later.
- It checks that the other conversation is open nowhere on this machine, and that nothing runs under this session.
- Wake-ups pending in the process are dropped. Set them again where they are still needed.
- Windows only. For the owner's own use: call it only when the owner asks.
- Where a coordinator plugin runs switches for the session, every call refuses: switches there come from the coordinator plugin.
- The arriving conversation reads the reason, notes and resume as that session's words, not the owner's. They grant no new permission.

### `exit_after_turn` (self-exit)

- Inputs: `reason` (required), `note` (optional: for whoever resumes the session).
- Ends the session. Remote Control ends with it. The reason and the note are recorded for whoever resumes it.
- It refuses while a session cron is set, a background job runs under the session, or a subagent hasn't ended, naming each with how to stop it. A pending wake-up holds it.
- Only with a person at the prompt: a `-p` run or an SDK host is refused.
- In a hierarchy: when the coordinator retires a session, the session writes its notes, then exits.

### `wake_after` and `cancel_wake` (self-wake)

- Inputs: `minutes` (1 to 1440) and `note` (what to check on waking). `cancel_wake` takes no input.
- Sends the session "Wake-up: <note>" some minutes after the turn ends, starting a turn of its own. If a turn is running then, it waits until the session is idle.
- One wake-up at a time: a new one replaces the old.
- It survives a plugin reload. A `/clear` carries it to the new conversation. A switch, or a `/resume` to another conversation, drops it. Quitting Claude Code drops it.
- A wake-up pending holds a restart, an exit and a switch. Cancel it first if it was only for this process.

### `reload_plugins_after_turn` (self-reload)

- Inputs: `resume` (optional).
- Runs `/reload-plugins` once the turn ends. Plugin code is replaced; plugin session state stays; plugin timers and variables start over.
- When the reload would change which MCP tools are loaded, Claude Code skips it until it is run with `--force`, which is left to the owner. The tool says so.
- In a hierarchy: a plugin rollout reaches each session through a reload or a restart, at that session's next finished break. The coordinator says which, and when.

### `reconnect_mcp_after_turn` (self-mcp)

- Inputs: `server` (its name as `/mcp` lists it, or `all`), `resume` (optional).
- Runs `/mcp reconnect <server>`. The server's session starts over: what it kept for this session is gone.
- A server that needs sign-in, or one turned off, stays the owner's to handle.

### `tools_check` (self-check)

- No inputs.
- Echoes a fresh nonce through the Bash and PowerShell tools as Claude calls them, each within 10 seconds, and lists the MCP servers (exercised only through probes the owner names). On Windows it says how much room the session's env leaves a Bash command.
- Its answer ends with the repair for what failed: most often a restart for a dead tool, or a reconnect for a failed MCP server.
- It writes a small record of which tools failed. A coordinator plugin can read it to see a lane whose tools died.

### `remote_control` (self-remote-control)

- Inputs: `action` (`status`, `connect` or `rename`), `name` (the title; required for `rename`), `resume` (optional).
- `status` reports. `connect` connects the session under a title, once the turn ends, only if it isn't connected. `rename` sets the session's title. It never disconnects: that is the owner's.
- In a hierarchy: rename each session for its role, so the owner finds it in the app's session list.

## Launching a session

Start each session in its own terminal tab, in PowerShell with the `claude` wrapper loaded. Then its later restarts come back to the same tab.

1. Copy `tools/claude-wrapper/claude-wrapper.ps1` from the claude-code-self-tools repository to `%LOCALAPPDATA%\claude-self-tools\claude-wrapper.ps1`.
2. Dot-source it in the tab, or once in your PowerShell profile (`$PROFILE`), so `claude` runs the wrapper's function:

   ```powershell
   . "$env:LOCALAPPDATA\claude-self-tools\claude-wrapper.ps1"
   ```

3. Clear Claude Code's session markers. A shell that Claude Code started carries them, and a tab opened from one inherits them. `CLAUDE_CODE_CHILD_SESSION` makes the new session nested: it saves no transcript, and `--resume` leaves it out. The full list is `SESSION_MARKERS` in the repository's `shared/hooks/machine.ts`; the wrapper keeps the same list.

   ```powershell
   foreach ($name in 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_EFFORT',
       'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_REMOTE',
       'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_JOB_DIR', 'AI_AGENT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
       'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_SSE_PORT', 'NO_COLOR') {
     Remove-Item "Env:$name" -ErrorAction SilentlyContinue
   }
   ```

4. Turn transcripts on for good. `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` keeps them on even if a marker a later Claude Code adds slips through. Everything the session starts inherits it, so a `claude` run nested in it saves a transcript too.

   ```powershell
   $env:CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1'
   ```

5. Start the session under its role's name, in the folder it works in:

   ```powershell
   claude --name lane-a
   ```

The wrapper resumes a restarted session in the same tab with the same environment rules: markers cleared, transcripts forced on. A restart or a switch out of a session started any other way opens a new window instead, or uses a slot pane where one is set up.

## Briefing a builder

A brief is all the context a subagent has. Give it:
- the goal, and the context it needs;
- each acceptance criterion, with the proof it needs: a test, or an observable check;
- its bounds: the files it may touch, and what it must not do;
- where the standing rules are.

The builder:
- works in its own worktree and branch, never the main checkout or another session's worktree;
- proves a fix with a test that fails before the change and passes after, and breaks the fix once to watch the test fail;
- fixes the class, not the instance: a defect is a sample, so it looks for the rest of its family;
- runs heavy commands through the slot script;
- never skips hooks and never force-pushes; a bad push is fixed by a commit on top;
- stops and reports when a gate refuses it, and never routes around a refusal;
- says what it verified by reading, what by running, and what only the running system can settle;
- reports in under 200 words: the commit or PR, each criterion met or not, anything unverified, and any decision that belongs to the owner.

## Briefing a reviewer

Give it the diff or the head, the acceptance criteria and your questions. Never give it the builder's conclusions, or your own.

The reviewer:
- is read-only; any test or type check it runs goes through the slot script;
- verifies by reading, the way a proof is checked, and names what reading can't settle and whether the PR showed it;
- looks hardest for what would break production or lock a person out; then for names that don't keep their promise, features that look done but aren't, and an instance fixed where a class exists;
- reports concrete findings only, ranked: file and line, the failure scenario, and a severity (Blocker, High, Medium, Low or Info);
- says plainly when there are none, and lists any problem it noticed nearby.

A confirming read after a fix gets the same brief, limited to the delta since the last read.

## Habits on a shared machine

- **Temp files carry your name** when sessions share a folder: `lane-a-pr-body.md`, never `pr-body.md`.
- **`git stash` is one list shared by every worktree** of a repository. Never `git stash pop` blind; copy a file aside instead.
- **Use absolute paths.** A tool's shell may start each call in another folder.
- **A stopped background job may still run.** Find it by its command line before you call it stopped.
