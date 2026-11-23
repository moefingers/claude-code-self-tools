# self-update

Keeps the plugins this machine already has from the marketplaces you name current, with Claude Code's own `claude plugin` commands, and reloads each session behind an update at its next idle moment. Part of [claude-code-self-tools](../../README.md).

It is **off until you name a marketplace**: with its `autoUpdate` setting empty, the default, nothing of it runs, reads or writes, and an update stays a `claude plugin update` someone runs. Windows only in this release.

## Turn it on

Set `autoUpdate` to the marketplaces to keep current, comma-separated. In `/config`, or from your shell:

```
echo '{"autoUpdate":"claude-code-self-tools, example-marketplace"}' | claude plugin configure self-update@claude-code-self-tools --values-stdin
```

That saves it in settings.json as `"pluginConfigs": { "self-update@claude-code-self-tools": { "options": { "autoUpdate": "claude-code-self-tools, example-marketplace" } } }`. A session reads it when its plugins load: at its next start or `/reload-plugins`. Empty it, or remove it, to turn it off. Naming `claude-code-self-tools` keeps self-update itself current too.

- **A name** is letters, digits, dots, dashes and underscores, a letter or a digit first, 64 characters at most, matched exactly (capitals included); 16 names at most. A value with any entry of another shape turns the whole feature off, the entries that fit too, and the session says why in its transcript, once.
- **A name no installed plugin comes from** (a misspelt one, say) does nothing, and the session whose look finds it says so in its transcript, once.
- **Whom you trust by naming a marketplace.** Whoever can publish to it, and more: a marketplace's entry can point a plugin at another repository or package, so the trust reaches whoever can publish each listed plugin's own source. And self-update follows whatever the marketplace's name points to on this machine now: a marketplace added again under the same name from a fork is followed to the fork. What they publish runs here with no review in between. Name only marketplaces whose code, and whose plugins' sources, you trust as they land.

`reloadAfterUpdate` (`on`, the default, or `off`) says whether a session behind an update reloads itself. Off, self-update only installs, and a session loads what it installed at its next start or `/reload-plugins`.

## What it does

- **When it looks.** At a session's start and at each main-loop turn's end, in a session a person is at (`claude -p` and SDK hosts don't look); never from a timer of its own. A look is made only when the machine's last one is a whole interval old: 5 minutes while looks reach every named marketplace. Its time is in one file per plugins folder, beside the lock (`%LOCALAPPDATA%\claude-self-tools\auto-update\<key>.self-update.json`, `<key>` standing for Claude Code's plugins folder, since each plugins folder has its own install records), so ten sessions make one look per interval, not ten. A look under way writes that time before its first command and after each, so it reads as fresh for as long as it runs.
- **One at a time.** The look takes a lock first (`…\auto-update\<key>.lock`), with the two scripts self-remote-control's Remote Control lock uses, byte for byte: the file made exclusively, and one a process that died left taken over once it is 90 s old. It reads the time again under the lock, and gives the lock back at its end.
- **What it runs.** Claude Code's own commands, their words fixed in one script: for each named marketplace that has a plugin installed here, `claude plugin marketplace update <marketplace>`; then, for every install record of it, `claude plugin update <plugin>@<marketplace> --scope <scope>`: the user's scope from the home folder, a project's or a local one from that record's own folder (one on a drive, never a network share; skipped while the folder is gone). What the marketplace has is installed at the next look, with no settling delay. The names that reach a command are checked to the name's shape twice, in the plugin and in the script.
- **Which `claude`.** `%USERPROFILE%\.local\bin\claude.exe`, else the first `claude` on `PATH` that Windows can start (an npm install's `claude.cmd` too), and never one the folder the command runs from could supply. For a project's or a local scope (run from that project's folder, a repository), that is any `claude` anywhere under the folder, however `PATH` names it (a relative `node_modules\.bin`, say), compared without regard to case. For the steps run from the home folder it is only one directly in it: an npm install's `claude.cmd` lives under the home folder, and is the one to run. When the only `claude` found sits inside, that one step fails, saying so, and nothing is run for it. The command gets `NoDefaultCurrentDirectoryInExePath=1`, so `cmd.exe` never looks in that folder for a program a `claude.cmd` names bare, `node` say.
- **A command never outlives its look.** The script starts the command as a child of its own. Its 75 s count from the script's own first line, so a cold PowerShell or a slow search for `claude` comes out of them: the command gets what is left, and with less than 5 s left it is never started. One that hasn't ended when the 75 s are up is ended with every process it started (Windows' own `taskkill /T /F`, the one other program self-update runs: claude, and the git or node under it), the script says so, and the look counts it as a failure and leaves that marketplace's other steps for the next look. The plugin's own timeout on the script (90 s) is only the backstop.
- **What it never does.** Add a marketplace; install a plugin that has no install record; touch a marketplace the setting doesn't name (a named one with nothing installed here gets no command at all); name a version (so it never asks for an older one: `claude plugin update` alone picks it, from what the marketplace lists); pass `--force`; update a managed install. It reads Claude Code's install records (`installed_plugins.json`: names, scopes, folders, versions) before and after, whether a record's project folder is there, its own state file, and of each command its exit code and its last line; nothing else in Claude Code's folders is opened.
- **What it says.** One transcript line and one toast per install, a record that names another version or folder after the commands than before: `self-update: updated self-wake 0.4.0 to 0.4.1 from claude-code-self-tools; sessions reload at their next idle moment` (with `reloadAfterUpdate` off it ends `reloadAfterUpdate is off, so a session loads it at its next start or /reload-plugins`). Nothing when nothing changed. Nothing leaves the machine but what the commands themselves fetch.

## Sessions pick an update up

A look that installed something leaves the time in its state file. A session whose plugins were loaded before that time is behind: one `/reload-plugins` loads what was installed. With `reloadAfterUpdate` on, it runs that reload itself:

- **Only at idle.** At a main-loop turn's end, a beat after it, and only while nothing holds it, all read again right before it runs: no turn running; nothing typed in the prompt box (the read says only whether a draft stands; nothing of it is kept or logged); no subagent at work (any status but `idle`, `completed`, `failed` or `killed`); no look of this session's under way; no reload of this plugin's still out; and none in the last 15 minutes. Held, it waits for the next turn's end; it never interrupts a turn, and Claude Code runs a plugin's command only once the session is idle anyway. As it runs, the transcript and a toast say `self-update: running /reload-plugins: a plugin was updated on this machine after this session loaded its plugins.`
- **Never a loop.** A try counts right before `/reload-plugins` runs, kept in the plugin's session state by the install's time. A reload that took starts a plugin loaded after the install, which is behind no more. One that left the session as it was (Claude Code skipped it, say) is tried once more, 15 minutes on at the soonest, then never again for that install, and the person reads one line in the transcript, once: `self-update: a plugin was updated on this machine after this session loaded its plugins, and two reloads left this session as it was, so it reloads no more for that update; a restart of this session, or a new one, loads it.` Nothing is added to the conversation for it. A later install starts its own two tries. Never `/reload-plugins --force`: forcing a held reload re-reads the whole conversation without the prompt cache, which is the person's to choose.
- **A reload and a look never overlap.** A reload replaces the plugin's code, the look's among it. So the reload waits while this session's look is under way, and the look's end asks for it again; and no look starts while a reload of this plugin's is out.
- **Every session reloads for any install**, one in another project too (a local scope's update of project A reloads a session in project B, once), and a session that started while the look ran reloads once more than it needed.

## Failures

- **A command that fails** (its exit code, its time run out, or one that couldn't be started) is recorded and tried again at the next look, never sooner. A marketplace whose refresh failed has its plugins left for that next look too.
- **The wait to the next look stretches only when a look couldn't reach a named marketplace**: its refresh (`claude plugin marketplace update`) failed, ran out of time or couldn't be started. Each such look in a row doubles it: 10 minutes after one, then 20, then 40, then an hour, until a look reaches every named marketplace and the 5 minutes come back. The count is in the state file, so it holds for the whole machine: a machine whose marketplace login lapsed tries 24 times a day, not 288.
- **A plugin's own update failing never stretches it** (a retired plugin's record, a half-deleted worktree's local one): it is recorded and tried again at every look, five minutes apart, and the other plugins go on being updated at that pace.
- **Three looks in a row with a failure get one toast**, with the command and its last line: `self-update: failed 3 looks in a row; it goes on trying at every look; the last: claude plugin update … : …`, or, when a marketplace wasn't reached three looks in a row, `self-update: couldn't reach a marketplace 3 looks in a row; it goes on trying, less often (once an hour at the least), until a look reaches them all; the last: claude plugin marketplace update … : …`. A command's last line is kept with the secrets of the shapes a failing command can print masked: a URL's user and password, the word after Bearer or Basic, a value given by a secret's name (`access_token=…`), a git host's token, and a run of characters that reads as random.
- **No `claude` that Windows can start**: the session says so once in its transcript, and runs nothing more.

## Beside another plugin that keeps plugins current

Another plugin can keep plugins current the same way, with its own setting. On a machine with both, they take the same lock file (`…\auto-update\<key>.lock`) the same way, so they never run commands at once, and each keeps a state file of its own beside it, which the other never reads or writes. With both set for the same marketplace, each looks on its own interval, never at the same time, and a look that finds nothing newer changes nothing. Each one's sessions reload for the installs its own looks made.

## Where it doesn't run

- **Windows only**: the lock's scripts and the command's script are Windows PowerShell's. Elsewhere, or where the machine's folders can't be placed, it does nothing and says so once in the debug log.
- **Headless sessions** (`claude -p`, SDK hosts) don't look and don't reload.
- **While a look runs**, its PowerShell (and the claude and git under it) are processes of this session: self-exit, self-restart or self-switch, checking the session in those seconds, can see a running shell or a git operation and refuse, naming a background job with no task to stop. It passes once the look ends; each command is bounded at 75 s.

## Known limits

- When a command runs out of time, `taskkill /T` follows parent process ids: a process the command started whose own parent has already ended is not in that tree and is left running, and in the rare case that Windows has given one of the tree's ids to an unrelated process that still names it as its parent, that one is ended too.
- A plugin's update that runs out of its time at every look ends that marketplace's remaining updates at every look, and the order is fixed, so the plugins after it in that marketplace wait while it hangs.
- On a machine with only an npm `claude`, a local or project install recorded at the home folder (or a folder above it) never updates: its step finds the only `claude` under the folder it runs from.
- A `/reload-plugins` that a person or another plugin runs in the middle of a look is not held: that look's lock goes stale in 90 s, and what it installed is recorded by no one, so other sessions load it at their next start or reload.
- With one plugin's update failing for good, the toast for a marketplace that couldn't be reached three looks in a row comes again each time that happens after a look that reached it.

## Tool

`update_status` (Claude sees `mcp__self-update__update_status`): what self-update does on this machine and in this session. The marketplaces `autoUpdate` names (or why it is off), when the machine last looked and when the next look comes, the failures in a row and the last one, the looks in a row that couldn't reach a marketplace, when a look last installed something, and whether this session is behind it and reloads at its next idle moment. Read-only: it runs no command and changes nothing; with the setting empty it reads nothing at all. A subagent is refused: the status is the main session's.

## Update check

When Claude calls this plugin's tool, and the last check is 30 minutes old or there hasn't been one, the plugin checks whether a newer version is published, as every self tool does. It fetches this plugin's `plugin.json` from the `main` branch of the repository its installed `plugin.json` names, [`plugins/self-update/.claude-plugin/plugin.json`](https://raw.githubusercontent.com/moefingers/claude-code-self-tools/main/plugins/self-update/.claude-plugin/plugin.json), and compares its `version` with the installed one: a plain GET of a public file, at most every 30 minutes, never holding up the tool. When a newer version is out, a toast tells you, and one of Claude's next answers from the tool ends with the update steps for you to run. Turn it off with the plugin's `updateCheck` setting (`off`); it is also off while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set. With `autoUpdate` naming `claude-code-self-tools`, self-update installs its own newer version at the next look.

## Tests

`tests/self-update.test.ts` runs the plugin in the engine's test kit, with the commands and the lock's scripts stood in (no real `claude`, PowerShell or network); `tests/update-logic.test.ts` tests the pure side; `scripts/self-update.test.mjs` holds the lock's scripts equal to self-remote-control's and the PowerShell call equal to the shared machine code's, and, on Windows only, runs the command's script by a real Windows PowerShell against a stand-in `claude.cmd`. No test runs a real `claude plugin update`.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-update@claude-code-self-tools
```
