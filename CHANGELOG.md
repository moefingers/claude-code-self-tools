# Changelog

Each entry names a plugin and its version, as `version` in `plugins/<name>/.claude-plugin/plugin.json` has it.

## 2026-11-05: dev-run, new tool

- **[dev-run](tools/dev-run)**, a script, not a plugin: `node tools/dev-run/dev-run.mjs --name <label> --dir <folder> --port <n> -- <command>` runs one dev server in place of a `next dev` started by hand.
  - It starts the server at a free-memory floor (6 GiB, 9 before a compile) and restarts it every 10 minutes (at most 10) on the same port, once the port is free.
  - It stops the server under 4 GiB free and waits for the floor again, and stops for good after 20 minutes of server time with no request.
  - It kills only its own tree, by PID.
  - It claims a heavy-slot slot for each start's first compile (`--slot`; `=life` for the whole run, `=off` for none).
  - It writes a log and an atomic status file under `%LOCALAPPDATA%\claude-self-tools\dev-run\`.
  - A detached guard stops the server if the runner is killed outright.
  - Its tests, run by `scripts/test-all.mjs`, use a fake server and six planted faults.

## 2026-11-04: self-exit 0.1.2, self-restart 0.1.6, self-clear 0.2.0 and self-check 0.1.0, self-service: the exit pre-check, self-check, and a clear only with a why

- **self-exit 0.1.2**:
  - **The pre-check.** A queued `/exit` stopped at a confirmation dialog, over a session cron, and waited there for the person. Now `exit_after_turn` refuses while anything would make `/exit` ask, or end work still running, naming each with how to stop it: a session cron (*cron 7f3a9c21 (Every 5 minutes: «…») is set to wake this session: delete it with CronDelete (id 7f3a9c21)*), a background Bash, PowerShell or Monitor job, a build or a heavy-slot run under the session (*stop it with TaskStop …*), a subagent still running. Crons are read with the built-in `CronList` tool through `$.tool.call`, the call the engine makes for the model's, and only after `$.tool.check` says `allow`, so never a dialog; background jobs by the probe of the session's processes (S6), on Windows; subagents by `$.agent.list()`. Anything it can't read refuses too (*can't tell …*), never reads as none. It runs at the call, so nothing is queued while anything stands, and again when the exit is armed, right before `/exit`. Off Windows there is no probe; crons and subagents are still read.
  - **The pending marker.** While the exit is queued or armed, `%LOCALAPPDATA%\claude-self-tools\pending\<conversation>.json` holds `{ "v": 1, "kind": "exit", "at": <ms> }`, written at the call and when armed, and `{ "v": 1, "done": true }` right before `/exit` runs or when the exit is cancelled. Its path takes a session id only. The coordinator holds its deliveries while it says pending and is at most 15 minutes old; one dated more than a minute ahead reads as bad.
  - It carries a copy of the shared machine code.
- **self-restart 0.1.6**: the same pre-check at the call, and again when armed beside the safe point, on one probe: a session cron now holds a restart too, and the refusal says how to stop each blocker. Where the launch can't be planned (off Windows, an id `claude --resume` doesn't take), the call reads crons and subagents only, and the restart is refused when armed, as before. The pending marker, with `kind: "restart"`, done right before the exit or when the restart is cancelled or refused.
- **self-clear 0.2.0**: `clear_after_turn` requires `why`, `complete` or `contaminated`, exactly; anything else, or none, is refused at the call and nothing is queued: *A clear loses this session's memory of the whole story. Compact instead (compact_after_turn), or restart into the same conversation (restart_after_turn). …* The description leads with compacting and restarting. Right before `/clear`, a leaving row, the conversation's last, records why and the handoff; the toast says why. A minor version: a call without `why` that worked before is refused now.
- **self-check 0.1.0**, new: `tools_check()` checks that the session's own tools answer. Bash and PowerShell get `$.tool.check` first (no dialog; anything but `allow` is *not tested*), then `$.tool.call` with `echo selfcheck-<nonce>` and `Write-Output selfcheck-<nonce>`, each within 10 s: ok only when the output holds the nonce (*failed: no output*, *the output didn't hold the nonce*, the error, *timed out after 10 s*). MCP servers are listed by their tools, and exercised only through a probe named in the `probes` setting (`server=tool`): its permission verdict first (`$.tool.check` on `mcp__<server>__<tool>`; anything but `allow` is *not tested*), then `$.mcp.call`, within 10 s, ok unless `isError`. A hook's refusal, a tool's or a probe's error and unexpected output are each one quoted line («…»). One line per tool; on a failure, how a fresh process repairs it (restart_after_turn, or the merger's `next: 'restart'`). At a resume it runs the same check 10 s later, once no turn is running, and says only a failure: a toast and one row read with the next message, never a turn (`checkAtResume`, on). Each check writes `%LOCALAPPDATA%\claude-self-tools\selfcheck\<conversation>.json`, `{ "v": 1, "at", "failed" }`, names only, at most 8, for the coordinator's lane report.
- **The shared machine code**: `exitBlockers` (pure: crons, the probe's S6 jobs, agents, a wake-up, each `{ kind, id?, what, howToStop }`, an unreadable input a blocker of kind `unknown`), `blockersText`, and the reads behind it (`readCrons`, `readAgents`, `runProbe`, `readExit`, `within`, `cronJobs`); the pending marker (`pendingPath`, `pendingMarker`, `PENDING_DONE`, `readPending`, `markPending`, `PENDING_MS`) and the self-check record (`selfcheckPath`, `selfcheckRecord`, `readSelfcheck`), each path id-shaped; `AgentLike` takes an `id`. It is copied into self-exit and self-check too. Its SHA-256 changed, so a copy pinned outside this repository (the coordinator's) is updated on purpose.
- **Live checks** (Claude Code 2.1.318, in bypassPermissions mode, so the default mode's permission verdicts are untested): a session cron, a background Bash, a Monitor and a background subagent each, alone, make a queued `/exit` stop at its *Background work is running* dialog, and `/exit`'s answer doesn't say whether the dialog ended in an exit or a stay. `CronList` through `$.tool.call` (its arguments at the top level; `$.tool.check` takes them under `input`, and an `input:`-shaped call is an error result) answers `{ result: { jobs }, text }` in about 20 ms, mid-turn and from a timer at idle, with no transcript row, and lists ScheduleWakeup and `/loop` jobs. The Bash echo 10 s after a resume answered in 1.8 s, with no transcript row and nothing on screen.
- The update check knows self-check. Every plugin's copy of it changed for that, and self-switch's copy of the shared machine code changed with the new exports; neither changes how those plugins behave, so self-compact, self-context, self-mcp, self-reload, self-remote-control, self-switch and self-wake keep their versions.

## 2026-11-04: self-switch 0.1.2 and self-restart 0.1.5, S11 v2: named worktrees and a baseline

- **self-switch 0.1.2**:
  - **S11 per tree.** Uncommitted changes held a switch by the folder the session started in, which for lanes that start in a shared checkout and work in git worktrees was the wrong tree: the shared checkout's long-standing changes held everyone, and the worker's own were never looked at. Now `switch_after_turn` takes `trees`, the worktrees the session worked in (each a worktree of the start folder's repository, checked at the call and again at the run), and each must be clean. The folder the session works in, when it is another tree, must be clean too, named or not. The start folder (in place) holds only on changes made since the conversation started, against a fingerprint kept at a startup's SessionStart, carried unchanged across a `/clear` (never taken at a `/clear`, a resume or a fork, when the folder may hold the conversation's own changes), and dropped 30 days after its last use; with none, it holds as before and says there is no baseline. A broken worktree (listed, but git finds no repository there) holds.
  - Every S11 hold names the tree, the file count, and whether the changes are *dirty since this conversation started* or *dirty, no baseline*.
  - **The launch environment.** The window and the slot runner clear `NO_COLOR` with the session markers (a launched session drew no colour), and both set `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` before claude, which nested `claude` runs inherit; `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP`, `WT_SESSION` and `WT_PROFILE_ID` are left as they are (cleared, `WT_SESSION` cost the Unicode prompt and the links).
- **self-restart 0.1.5**: its copy of the shared machine code (S11 v2 is unused by it: a restart keeps its checkout). Its window clears `NO_COLOR` with the session markers, and sets `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`.
- **The shared machine code**: `checkTrees`, `fingerprintOf` (`FINGERPRINT_READS`, the coordinator's S5 reads with `-c core.fsmonitor=false`, and the diff with `--no-textconv`), `readGit` taking `{ start, trees, cwd, folders, dirty }` and giving per-tree `TreeState`s (path, role `start`, `named` or `cwd`, branch, head, dirty count, fingerprint), `safePoint` taking a `Baseline` (`usedAt` optional), `sameFolder`, `countStatus`; `SESSION_MARKERS` with `NO_COLOR`, `FORCE_PERSISTENCE`. The slot runner changed (its clear, and FORCE), so `SLOT_SCRIPT_SHA256` did too.

## 2026-11-04: self-switch 0.1.1 and self-restart 0.1.4, from the live checks

- **self-switch 0.1.1**:
  - **Claude Code 2.1.318's session registry is read again.** 2.1.318 writes two keys more (`asksForConvertedSkills`, `nameSince`) and `procStart` as a string of digits, so every switch was refused. What liveness reads stays strict: `pid` a whole number, the file's own; `sessionId` a session id; `procStart` a whole number or a string of digits, compared exactly. Missing or of another type, it refuses, naming the field; so does a key that marks a new format (`v`, `schema`, `schemaVersion`, `formatVersion`, `registryVersion`, or a `version` that isn't Claude Code's version as a string). Any other key is ignored, and logged once per process by its name.
  - **More looks when it can't tell.** A `claude.exe` that is starting or exiting reads as unknown for a moment (5 of 370 samples on a busy machine). An unknown verdict now gets up to 3 more probes, 2.5, 3.5 and 4 seconds apart, the claim lock given back before each wait, and refuses only if the last is unknown too.
  - **A Claude Code command is no conversation.** A `claude.exe` running `claude plugin …` (or `mcp`, `doctor`, `update`, `install`, `config`, `auth`, `--version`, `--help`), naming no conversation, and the `claude.exe` it starts, count as accounted: another lane's `claude plugin test` no longer makes every switch read unknown. A command line naming the conversation (L2) still holds it.
  - **The registry, named elsewhere.** A running `claude.exe`'s registry file that names the conversation in any key but `sessionId`, `cwd` and `name` makes the verdict unknown.
  - **A launch line is history.** A slot, a window or a restart starts claude as `claude --resume <id>`; once that process switched in place to another conversation, its command line no longer makes `<id>` read live, so a switch back is possible. That holds only while its own current registry entry names the other conversation, and only for a process started more than 60 seconds before the probe (a fresh one may not have written the conversation it resumes yet); otherwise the command line still counts.
  - **The last looks.** The window's and the slot's re-check refuses whenever a running `claude.exe`'s registry file names the conversation, whatever its `procStart`, and follows the probe's rules: `sessionId` without regard to case, a file naming the conversation in another key refused, a launch line that is history passed over. The in-place switch now takes the same last look (L1, L2) before `/resume`, beside the claim lock.
  - **A switch stays with its conversation.** A switch queued in one conversation doesn't run in another: a `/resume` or `/clear` before it runs takes it back, and in another conversation it says so and moves nothing. The coordinator's gate is read again after each wait. A session whose id can't be read is refused at the call.
  - **The slot is found from a Windows Terminal tab.** The probe hashed the slot runner with `Get-FileHash`, which Windows PowerShell 5.1 doesn't have when the tab's module path lists PowerShell 7's folders first; it hashes with .NET now.
  - **A slot passed over is said, never silent.** When this pane runs a slot runner that isn't used (its script can't be hashed, is over 64 KB, or has another hash; or the pane runs `claude-slot.ps1` some other way, such as with `pwsh.exe`), a new window opens as before, and the switch says why: in the leaving row, a toast and the log, and in the arrival row.
  - **A withdrawn slot record** (`{"v":1,"cancelled":true}`) is said as withdrawn by the slot runner, not as a record naming no conversation.
  - **Pending wake-ups are dropped, and it says so.** A self-wake wake-up pending in the process doesn't fire after a switch, in either conversation, whichever way the switch goes. The tool's description and result, the leaving row and the arrival row say so, so they can be set again where needed. The description no longer says an in-place switch carries the timers over.
  - **A conversation that arrived in place switches on.** `/resume` gives the process the resumed conversation's own plugin state, without the start folder, so its next switch was refused and its heartbeat stopped. The start folder is now the process's, and the resume beats the conversation that arrived at once, by the id its start names.
  - Log lines name the plugin once: the engine already draws them under its name.
  - **A claude.exe at its very end** reads an empty command line for a moment: the probe reads it again 300 ms later, and drops it if it has gone; still empty, it stays unaccounted.
  - The README quotes the rows as the plugin writes them.
- **self-restart 0.1.4**: its launcher hashes the slot runner with .NET too, and when it opens a window although this pane runs a slot runner, it says why, in the row the restarted session reads, a toast and the log. Its window's last look refuses whenever a running `claude.exe`'s registry file names the session, whatever its `procStart`.
- **Both: no script on a command line.** Every script the plugins run (the probe, the claim check, the release, the launchers) now goes on PowerShell's standard input under one fixed command line of 441 characters; as `-EncodedCommand` the probe's had passed the 32,767 characters Windows allows one, and the process never started, so every switch was refused. The window a launcher opens carries its script GZip-compressed in its own command line (8,589 characters at the largest inputs). Nothing is written to disk.
- **The shared machine code**: the registry rule above (`REGISTRY_FIELDS`, `REGISTRY_VERSION_MARKERS`, the extra keys and the mentions in the probe's answer), Claude Code commands (`cli`), the slot's hash by .NET with the reason a hash failed, a slot runner started another way (`slotSeen`), the transport's `fallback`, RECHECK refusing whatever the `procStart`, the in-place claim check carrying RECHECK, `powershellCall` and `STDIN_BOOTSTRAP` in place of `powershellArgv`, and `READ_BLANK_AGAIN`. The slot runner changed (its re-check, and the withdrawn record), so `SLOT_SCRIPT_SHA256` did too.

## 2026-11-03: self-switch 0.1.0, and self-restart 0.1.3 on the shared machine code

- **self-switch 0.1.0**, new, Windows only, for your own use:
  - `switch_after_turn({ to, reason, notes, resume? })` switches the terminal to conversation `to` once the turn ends: in place (`/resume`) when both conversations live in one project folder, else in the pane's slot, else in a new window. `reason` and `notes` are required and recorded in both conversations; `resume` is the resumed conversation's first prompt, in the plugin's frame.
  - **Another session's words stay data.** `reason`, `notes` and `resume` are kept as one line each (every line break and tab a space; every character a reader can't see dropped, in any Unicode plane: control and format characters, the tag characters that can carry hidden text among them, private-use, unassigned and default-ignorable code points; at most 400 characters), and the resumed conversation reads them quoted in «…», with any guillemet inside escaped, in a row that opens *self-switch: a message from session «…»* and says they are that session's words, not the person's, granting no new permission. The `resume` prompt is framed the same way.
  - **Never two copies of one conversation.** A fixed probe reads every running `claude.exe`, Claude Code's session registry, the transcripts' folders and times, and the claim locks. The switch refuses, naming the evidence, when `to` is held by a running Claude Code, named on a command line, written in the last 10 minutes, alive by its heartbeat, or claimed by another move; and when anything can't be read, a registry file is of a shape not verified (a key outside the 18 seen, or `pid`, `sessionId`, `procStart` or `status` missing or of another type), a `claude.exe` is accounted for by no registry, or `to` has no transcript here, or two.
  - **Only at a safe point.** It refuses while a subagent, a background Bash, PowerShell or Monitor job, git (or a git operation in flight in any worktree), a build, test or lint, a dev server, Playwright or a heavy-slot job runs under the session, and for an in-place switch while the checkout has uncommitted changes. Anything unreadable holds it.
  - **The claim lock** (`%LOCALAPPDATA%\claude-self-tools\claims\<id>.lock`) is taken with CreateNew in the probe run that judged, and released where the conversation arrives. A stale lock is taken over, and a lock released, through one handle that keeps every other writer out, never by a delete and a create; a release a reader blocks is tried again, then left in place and logged; an in-place switch reads the claim again right before `/resume`.
  - **Coordinated mode.** While the coordinator's gate file for the conversation says `coordinated: true` (at most a day old), every call refuses. `requireCoordinator: on` refuses where there is no gate file.
  - **The slot runner** (`slot/claude-slot.ps1`) keeps a Windows Terminal pane: it runs `claude`, and when it exits, resumes the conversation a switch or restart left it a record for, in the same pane, after checking it all again, the folder being the conversation's own project among it. The plugins use it only when its SHA-256 is the one they ship; the slot's id is compared as the exact string the probe prints. The pane's profile line uses `-ExecutionPolicy RemoteSigned`, and the runner clears it before `claude` starts.
  - **The last look.** A registry file that can't be read at the last moment is read twice more, 250 ms apart; still unknown, the window or slot says so and gives the `claude --resume <id>` line to run by hand.
  - No transport passes a permission flag: the resumed conversation starts in the mode a new session would.
  - It refuses subagents, outside a terminal, off Windows, within 2 minutes of a switch, and while subagents run. A new turn or an interrupted one cancels it; a new turn's cancel is told in a plugin row, and from the third in a row the row says the session is busy: queue it again when idle, or ask the merger or the owner.
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
