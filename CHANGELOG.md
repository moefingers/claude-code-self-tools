# Changelog

Each entry names a plugin and its version, as `version` in `plugins/<name>/.claude-plugin/plugin.json` has it.

## 2026-11-03: self-switch 0.1.0, and self-restart 0.1.3 on the shared machine code

- **self-switch 0.1.0**, new, Windows only, for your own use:
  - `switch_after_turn({ to, reason, notes, resume? })` switches the terminal to conversation `to` once the turn ends: in place (`/resume`) when both conversations live in one project folder, else in the pane's slot, else in a new window. `reason` and `notes` are required and recorded in both conversations; `resume` is the resumed conversation's first prompt, in the plugin's frame.
  - **Another session's words stay data.** `reason`, `notes` and `resume` are kept as one line each (every line break and tab a space, control and invisible format characters dropped, at most 400 characters), and the resumed conversation reads them quoted in «…», with any guillemet inside escaped, in a row that opens *self-switch: a message from session «…»* and says they are that session's words, not the person's, granting no new permission. The `resume` prompt is framed the same way.
  - **Never two copies of one conversation.** A fixed probe reads every running `claude.exe`, Claude Code's session registry, the transcripts' folders and times, and the claim locks. The switch refuses, naming the evidence, when `to` is held by a running Claude Code, named on a command line, written in the last 10 minutes, alive by its heartbeat, or claimed by another move; and when anything can't be read, a registry file is of a shape not verified (a key outside the 18 seen, or `pid`, `sessionId`, `procStart` or `status` missing or of another type), a `claude.exe` is accounted for by no registry, or `to` has no transcript here, or two.
  - **Only at a safe point.** It refuses while a subagent, a background Bash, PowerShell or Monitor job, git (or a git operation in flight in any worktree), a build, test or lint, a dev server, Playwright or a heavy-slot job runs under the session, and for an in-place switch while the checkout has uncommitted changes. Anything unreadable holds it.
  - **The claim lock** (`%LOCALAPPDATA%\claude-self-tools\claims\<id>.lock`) is taken with CreateNew in the probe run that judged, and released where the conversation arrives. A stale lock is taken over, and a lock released, through one handle that keeps every other writer out, never by a delete and a create; an in-place switch reads the claim again right before `/resume`.
  - **Coordinated mode.** While the coordinator's gate file for the conversation says `coordinated: true` (at most a day old), every call refuses. `requireCoordinator: on` refuses where there is no gate file.
  - **The slot runner** (`slot/claude-slot.ps1`) keeps a Windows Terminal pane: it runs `claude`, and when it exits, resumes the conversation a switch or restart left it a record for, in the same pane, after checking it all again, the folder being the conversation's own project among it. The plugins use it only when its SHA-256 is the one they ship; the slot's id is compared as the exact string the probe prints. The pane's profile line uses `-ExecutionPolicy RemoteSigned`, and the runner clears it before `claude` starts.
  - **The last look.** A registry file that can't be read at the last moment is read twice more, 250 ms apart; still unknown, the window or slot says so and gives the `claude --resume <id>` line to run by hand.
  - No transport passes a permission flag: the resumed conversation starts in the mode a new session would.
  - It refuses subagents, outside a terminal, off Windows, within 2 minutes of a switch, and while subagents run. A new turn or an interrupted one cancels it; a new turn's cancel is told in a plugin row, and from the third in a row the row says the session is busy and points to the coordinated go.
  - Where the coordinator runs switches, it refuses: *ask the merger or the owner for a wrap-up*.
- **self-restart 0.1.3**: its launcher is now the shared one, version 2.
  - It takes the claim lock on the conversation, with CreateNew, and the resumed session releases it, so a switch moving the same conversation can't resume it too.
  - After the wait, right before `claude --resume`, the window reads the registry and the process table again and resumes nothing if another process holds the conversation, or if the claim no longer names it.
  - In a pane set up as a slot, it leaves the slot a record instead of opening a window, when the start folder is one the runner takes.
  - Right before the launch it runs the full safe point, as a switch does: a background job, git, a build, a dev server or a heavy-slot job under the session, git in flight, or anything unreadable holds it.
  - A new turn's cancel is told in a plugin row, counted as for self-switch.
  - The scrub of Claude Code's markers adds `CLAUDE_CODE_SSE_PORT`; no permission flag is passed.
- **The shared machine code**, `shared/hooks/machine.ts`, copied into self-restart and self-switch only: the probe, liveness, the safe point, the transports, the launcher, the claim lock, the gate and the slot runner's hash. It imports nothing but the engine's types, so the coordinator can vendor it byte for byte.
- **sync-shared**: a shared file with a line `Copies: <plugin>, ...` is copied only into those plugins, and a copy anywhere else is stale. `scripts/slot-runner.test.mjs` checks the slot runner, as text and by its hash.
- The update check knows self-switch.

## 2026-11-03: self-restart 0.1.2, the restarted session saves its transcript

- **self-restart 0.1.2**: the new window inherited the old session's environment, `CLAUDE_CODE_CHILD_SESSION` included. That marker makes a claude count as nested, and a nested interactive session saves no transcript and is left out of `--resume`. So a restarted session could have carried on with transcript saving off.
- **The fix:** the window now clears a fixed list of the markers Claude Code sets in the processes it starts, right before it runs `claude --resume`:
  - from the environment-variables reference: `CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_REMOTE`, `CLAUDE_CODE_REMOTE_SESSION_ID`, `CLAUDE_JOB_DIR`;
  - and four that Claude Code sets in its tools' processes though that reference doesn't list them: `AI_AGENT`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_SESSION_ATTENDED`.
- **Nothing else changes:** no other variable is touched, `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE` and the rest of yours included.
- self-clear and self-exit start no process, so they have nothing to clear.

## 2026-11-03: exit and restart only at a finished break

- **self-exit 0.1.1**: `exit_after_turn`'s description says to call it only at a finished break, never mid-merge, mid-push or mid-task, the same rule as compacting. Its behaviour is unchanged.
- **self-restart 0.1.1**: the same line in `restart_after_turn`'s description. Its behaviour is unchanged.
- The two plugins' READMEs and the top README's entries for them say the same.

## 2026-11-03: a session clears, exits and restarts itself

Three new plugins. Each queues its action at the call and runs it once the turn ends with an answer. Each cancels it when the turn is interrupted, and refuses subagents, as the others do.

Each also requires the parameter that makes its action safe to take unattended (`handoff` or `reason`), and refuses while a subagent is pending, running or waiting. That is checked at the call and again right before the action. None of them changes a setting, a permission, CLAUDE.md or any other configuration.

- **self-clear 0.1.0**, new:
  - `clear_after_turn` runs `/clear`, then sends `handoff`, which is required, as the cleared conversation's first prompt.
  - A clear starts a conversation under a new session id. If the id hasn't changed, the clear didn't take, and the handoff isn't sent as if it had.
  - A handoff Claude Code drops is kept as a note for the next message.
- **self-exit 0.1.0**, new:
  - `exit_after_turn` runs `/exit`. `reason` is required; an optional `note` is for whoever resumes the session.
  - Before the exit, both are recorded as a conversation row, which a later `claude --resume` loads, and as a transcript line the person sees.
  - It is refused where no one is at the prompt (`-p`, an SDK host).
  - A refused exit, or a session still open a few seconds after `/exit`, is told to the person and the model.
- **self-restart 0.1.0**, new, Windows only:
  - **The launch.** `restart_after_turn` runs Windows PowerShell, by its known path under the Windows folder, on one fixed script whose only variable is the session's id, which must be a UUID. That script opens a new console window with `Start-Process`. Then the session runs `/exit`. Nothing from the tool's input reaches the launch.
  - **The wait.** The window waits for the session's own `claude.exe` to exit, then runs `claude --resume <id>` from PATH in the folder the session started in. After 10 minutes it gives up and says so.
  - **The process walk** takes a parent only while it is older than its child, so a process that reused a gone parent's id is never taken for the session.
  - **A failed resume.** A Claude Code that ends with an error, or within 10 seconds, leaves the window open on the manual `claude --resume <id>` until Enter.
  - **No restart loop.** A second restart of a session within 2 minutes of the last is refused.
  - **The first prompt.** `resume` waits in the plugin's store under the session's id, and the resumed session's copy of the plugin sends it once. One older than 15 minutes is dropped.
- **The update check's list of names** gains the three. The other plugins' copies of the shared file change by that line alone and behave as before, so their versions stand.

## 2026-11-01: the plugins say when they're out of date

Every plugin gets the same update check. Nothing else in them changed.

- When the main session calls one of a plugin's tools, and its last check is 30 minutes old or there hasn't been one, the plugin fetches its own `plugin.json` from the repository's `main` branch: a plain GET of a public file on raw.githubusercontent.com. The plugin adds no headers, query or body, and nothing about the person, the session or the machine; GitHub sees what it sees of any web request (the address, the time, the headers Claude Code sends on its own). It compares the `version` there with the installed one, number by number. The check's time and answer are kept in the plugin's own store, so a reload or another session on the machine uses that answer for the rest of the 30 minutes. Sessions that come due at the same moment each make their one request.
- The tool call never waits on the check. A failure is silence: offline, refused by policy, a 404, a rate limit, no answer within 5 seconds, bad JSON, or a version that isn't three plain numbers.
- When a newer version is out, a toast tells the person, and one of the session's next tool results ends with a fixed line: the plugin's name, the installed and the published versions, and the update steps for the person to run (`claude plugin marketplace update`, `claude plugin update`, then `/reload-plugins` or a new session), closing with "Don't run these yourself unless the person asks." Nothing else from the fetched file reaches the session. A session is told of each check once, and at most once every 30 minutes, kept across reloads, rather than on every call: these tools are called again and again in a long session, and the same line on every call would cost context and get tuned out. The toast follows the same rule.
- New `updateCheck` setting, `on` by default; `off` never checks. Nothing is checked while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, to any value, or for a subagent's call.

The versions with it:

- **self-compact 0.2.3**: the update check, on `compact_after_turn`.
- **self-context 0.1.1**: the update check, on `context_usage`.
- **self-mcp 0.1.1**: the update check, on `reconnect_mcp_after_turn`.
- **self-reload 0.1.1**: the update check, on `reload_plugins_after_turn`.
- **self-remote-control 0.2.1**: the update check, on `remote_control`.
- **self-wake 0.1.1**: the update check, on `wake_after` and `cancel_wake`.

## self-remote-control 0.2.0 (2026-10-30)

Remote Control sessions get titles. The app takes a session's title as it connects, so a session connected with a bare `/remote-control` and no `/rename` title showed up as `<hostname>-<adjective>-<noun>`.

- `connect` takes an optional `name` and runs `/remote-control <name>`. Without one, it connects under the session's own title (its `/rename` or `--name` title, which the plugin reads from the SessionStart and UserPromptSubmit hook inputs), and bare if the session has none.
- New `rename` action, `name` required: once the turn ends it runs `/rename <name>`, and nothing else. A `/rename` while connected updated the title in the app too on Claude Code 2.1.314; if the app doesn't show it, the session needs reconnecting, or renaming in the app. `rename` and `connect` in one turn rename, then connect under the new title.
- New optional `resume`, as in self-mcp and self-reload: the message that starts the session's next turn once `connect` or `rename` has run, after what happened. A connect that doesn't take then starts a turn that says so. Without it, the toast and the note on Claude's next turn stay as they were.
- Corrected: run while the session is connected, `/remote-control` doesn't disconnect. In the interactive terminal it opens the Remote Control panel and waits for the person. The plugin never runs it then, as before.
- `status` also reports the session's title.
- The queued action is kept in session state under a new key, `queued`, in place of `connectQueued`.

## self-mcp 0.1.0 (2026-10-22)

New: `reconnect_mcp_after_turn` runs `/mcp reconnect <server>`, or `/mcp reconnect all`, once the turn ends: the typed form of the `/mcp` menu's Reconnect, so it runs unattended. Its outcome is Claude Code's own transcript line; the toast and the optional `resume`, or a note Claude reads on its next turn, point to it. It refuses subagents, and an interrupted turn cancels it.

## 2026-10-21: a marketplace of plugins

The repository is now `claude-code-self-tools`: a marketplace of separate plugins under `plugins/`, each installed by name, so you install only the ones you want.

- **self-compact 0.2.2** moves to `plugins/self-compact`, its behaviour unchanged. Its marketplace is now named `claude-code-self-tools`, so it installs as `self-compact@claude-code-self-tools`. If you installed it from the marketplace `claude-code-self-compact-plugin`, remove that marketplace (`claude plugin marketplace remove claude-code-self-compact-plugin`, which also uninstalls the plugin), then add this one and install again.
- **self-reload 0.1.0**, new: `reload_plugins_after_turn` runs `/reload-plugins` once the turn ends. An optional `resume` is written to session state before the reload and sent once, after it, by whichever copy of the plugin is running.
- **self-context 0.1.0**, new: `context_usage` reports the tokens used, the window, the percentage and whether auto-compact is on, for deciding at a break whether to compact. Read-only.
- **self-wake 0.1.0**, new: `wake_after` sends the session "Wake-up: <note>" some minutes after the turn ends, one wake-up at a time, armed again after a reload of the plugin; `cancel_wake` takes it back.
- **self-remote-control 0.1.0**, new: `remote_control` reports whether this session's Remote Control is connected, and connects it only when it reads as not connected, so it never toggles a live connection off.

Every new tool refuses subagents, and every action queued by a turn that is interrupted is cancelled.

## self-compact 0.2.2 (2026-10-21)

First public release.

- The `compact_after_turn` tool: the session queues a compaction of its own conversation, with `keep` as the summary instructions. It runs once the current turn ends, one compaction per call, so a session compacts per piece of work.
- Optional `resume`: once compacted, the session sends itself that message and carries on. One resume per compaction. If Claude Code skips the compaction, the resume is still sent and says so.
- An interrupted turn cancels the queued compaction and its resume.
- Subagents are refused, because only the main conversation can compact on demand. The refusal tells the subagent to finish its piece and return its result instead.
