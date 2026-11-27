# self-chrome

Lets a session make sure Chrome runs for Claude in Chrome, then reconnect it, without asking you. A session sometimes decides Claude in Chrome isn't connected when all it needs is Chrome started, or the MCP reconnected. Part of [claude-code-self-tools](../../README.md).

## The flag's cost, first

The plugin can start Chrome with `--silent-debugger-extension-api`, which stops Chrome showing its "is debugging this browser" banner while Claude in Chrome drives a tab. That banner is how you see that an extension is using Chrome's debugger. The flag hides it:

- **for every extension**, not just Claude in Chrome;
- **for every profile** in that Chrome process, not just the one Claude in Chrome uses;
- **for as long as that Chrome runs.**

So the flag is opt-in, and off unless you turn it on. Some people want the banner. See [Turning the flag on](#turning-the-flag-on).

## Tool

`chrome_ensure` (Claude sees `mcp__self-chrome__chrome_ensure`):

- `profile` (optional): the profile folder a start opens, by its folder's name (`Default`, `Profile 2`), never an account. It must be one of Chrome's profile folders ([below](#the-profile)). Used only when Chrome isn't running. Left out: the `profile` setting, else the account match: the one profile folder whose Google account has the email of Claude Code's account ([below](#the-account-match)).
- `reconnect` (optional, default `true`): queue `/mcp reconnect claude-in-chrome` for when the turn ends.
- `resume` (optional): the message that starts the session's next turn once the reconnect has run, as [self-mcp](../self-mcp)'s `resume`.

## What it does

1. **It looks for your Chrome**: the browser process of the configured Chrome (the one that is no child of another, with no `--type=`), of your own login, on Chrome's default user data folder. A test or isolated Chrome, started with a `--user-data-dir` of its own (Playwright's, say), isn't yours: it is counted apart, and never touched. It says whether Chrome runs, whether it started with the flag, and the profile folder its command line names, if any. With nothing naming a profile, it says whether that is the account match's folder ([below](#when-chrome-runs)).
   - **Chrome in the background counts as running.** A Chrome with no window (`--no-startup-window`, as Chrome starts at login when it keeps running in the background) is said plainly to run in the background with no window. A start would only hand off to it, and it took its flags when it started.
   - **A Chrome whose command line can't be read** (an elevated Chrome, run as administrator) leaves the look unable to say that Chrome isn't running. So it says it can't tell, and starts nothing.
2. **If Chrome isn't running, it starts it**, detached, with `--profile-directory=<profile>` (the folder the call or the `profile` setting names, else the account match's: [the profile](#the-profile)), `--restore-last-session`, and the flag when you opted in. When no folder can be picked, it starts nothing, and says why. The launch is short: it returns at once, and looks of their own then wait up to 20 seconds for the browser process. It says the PID, and whether the flag took.
   - **Windows:** `chrome.exe` through ShellExecute (what `Start-Process -PassThru` calls), in Chrome's own folder, never the session's, which Chrome would hold open for its whole life. Chrome gets your login environment, as Windows builds it for a program you start (`CreateEnvironmentBlock`): the machine's and your own Environment keys in the registry, and the system's own variables. The swap to it is Windows' own calls, made in a small C# helper, so it is the same under any PowerShell. Then, right before the launch, the start checks that its environment is the login environment exactly; when it isn't, it launches nothing, and says so without naming any variable. None of the Claude Code session's environment reaches Chrome, or anything Chrome starts while it runs.
   - **macOS:** `open -a "<Google Chrome.app>" --args …`, so Chrome starts as it would from the Dock, with launchd's environment.
   - **A last look comes right before the launch.** A Chrome that came up meanwhile is never started again, and the answer says so.
   - **One start at a time on the machine.** A start takes a lock: a file made with an exclusive create, so of two starts at once only one makes it (`%LOCALAPPDATA%\claude-self-tools\chrome-start.lock` on Windows; on macOS a folder, `~/Library/Caches/claude-self-tools/chrome-start.lock`, which `mkdir` makes or finds there). There is one per user, whatever Claude Code config folder a session runs under. A call that finds the lock held launches nothing: it looks, and says what the other session's start came to. The start lets its lock go once its wait is over; one older than 90 seconds is taken over.
   - **What takes time comes first.** On Windows the start compiles its helper and reads the login environment before it takes the lock, so the last look, the swap and the launch run back to back.
   - **A launch that handed off** to a Chrome that was already starting is said: Windows names the launched process, and the browser found is another.
   - **A launch whose answer never came** (a timeout under load) isn't taken for a failed one. The looks still run, and say whether Chrome came up.
3. **If Chrome runs without the flag while you opted in**, it says so, and how you fix it (below). It does nothing to Chrome.
4. **It queues `/mcp reconnect claude-in-chrome`** for when the turn ends, as [self-mcp](../self-mcp) does, whenever Chrome runs (found, or started). A Claude in Chrome server that dropped lists no tools, and it is the one that needs the reconnect most, so the plugin doesn't look for them. Once the reconnect has run, the session resumes with `resume`, or Claude is told on its next turn and the session waits for your message. A message of yours after the reconnect was queued turns the `resume` into a note, as with self-mcp.
   - **At most 3 reconnects in 10 minutes** a session. Past that, the answer says to ask you rather than call the tool again: reconnects that keep not helping usually mean Claude in Chrome is off, or signed out, in the profile Chrome opened.
   - **A reconnect starts Claude in Chrome's session over.** The session's tab group stays open in Chrome, and the session makes a new one.
   - **Claude goes idle once it is queued.** The description ends with the words every self tool that queues for the idle moment ends with (`hooks/at-idle.ts`, the same in each): when the answer says the reconnect is queued, go idle at once (end the turn), and do nothing more until it has run; then carry on in the turn that follows it, started by its resume message when it sends one, else by the next message. What it queues runs only once the turn has ended and the session is idle, so anything done meanwhile pushes it back.
5. **It answers** with one line each: what it found, the flag, what it did, the reconnect, and what is left for you.

## The profile

A start opens one profile folder, the first of:

1. **The call's `profile`.**
2. **The `profile` setting**: a pin, for a machine where the account match below doesn't hold.
3. **The account match**: the one profile folder whose Google account has the email of Claude Code's account ([below](#the-account-match)).

Nothing comes after the account match. When it picks no folder, the start starts nothing, and says why.

**Decided on principle: the profile Chrome used last is started by naming it.** Before 0.2.0, with nothing named, a start passed no `--profile-directory`, and Chrome opened the profile it used last. That never followed Claude Code's account, so it is gone. To start the profile Chrome used last, name its folder, in the call or in the setting. From memory, not tested: a start on a named folder opens that profile alone, where a start with no `--profile-directory` reopened every profile Chrome had open.

A profile that is named, or matched, must be one of Chrome's profile folders: a folder of exactly that name in Chrome's user data folder, with its `Preferences` file. Given any other name, Chrome would make a new, empty profile of that name, without Claude in Chrome, and leave it in your profile picker. So the plugin starts nothing, and lists the profile folders that are there, by folder name only (`"Default", "Profile 3"`), never their display names or accounts. It never repeats the name it was given, which may be an account's.

`--restore-last-session` reopens the last session of each profile Chrome opens, whatever that profile's own "On startup" setting says.

### The account match

Claude in Chrome pairs with Claude Code only from a Chrome profile whose Claude in Chrome is signed in to Claude Code's own account, and that account can change (a weekly limit, a `/login`). No file says which profile's Claude in Chrome is signed in to which account. So the plugin matches what it can read, at the moment of the call: each profile's **Google account** (`user_name` in Chrome's Local State) against the email of Claude Code's **Claude account** (`oauthAccount` in Claude Code's `.claude.json`). The match stands in for "the profile whose Claude in Chrome is signed in to Claude Code's account". It holds where you sign in to Claude with the same address as that profile's Google account. Where you don't, pin the profile with the setting.

- Both emails are trimmed and lower-cased, then compared whole.
- **Exactly one folder matches:** the start opens it.
- **No folder matches:** it starts nothing. It says so, lists the profile folders there by folder name, and says how to pin one (the call's `profile`, or the `profile` setting).
- **Several match:** it starts nothing. It says how many, lists the matching folders by folder name, and says how to pin one.
- **Claude Code's account unknown** (no Claude account in `.claude.json`: an API key, a cloud provider, logged out; or a `.claude.json` that doesn't read as JSON, caught mid-write) **or Local State unreadable:** it starts nothing, says which, and says how to pin one.
- **Decided on principle: a folder Local State lists without its `Preferences` file doesn't count** (a profile being deleted, say). Chrome would make it anew, empty, as with a named folder that isn't there.
- `.claude.json` is read at `<CLAUDE_CONFIG_DIR>/.claude.json` when `CLAUDE_CONFIG_DIR` is set and not blank, else at `.claude.json` in your home folder, beside the `.claude` folder, not in it (Claude Code's own layout, [the .claude directory](https://code.claude.com/docs/en/claude-directory.md)). The home folder is `USERPROFILE` on Windows (else `HOME`), and `HOME` on macOS. A folder that can't be placed for sure is not read: a relative path, a network or device path, a path on Windows with no drive, spaces around it.
- Local State is read in Chrome's user data folder, the one the plugin already knows. That `profile.info_cache` is Chromium's map of profile folders to their attributes, and `user_name` a profile's signed-in account, is from Chromium's source (`chrome/common/pref_names.h`, `chrome/browser/profiles/profile_attributes_entry.cc`). That the map is in Local State, and that `user_name` is the Google account's email, is from memory.

### When Chrome runs

It opens no profile in a Chrome that runs ([below](#what-it-doesnt-do)). With nothing naming a profile, the answer adds a `Profile:` line, as far as the browser process's command line shows:

- Chrome was started on the account match's folder.
- Chrome was started on another folder: it names both, and says that opening the matched profile is yours, from Chrome's profile menu. A window opened from the profile menu shows on no command line, so that profile may be open already.
- Chrome was started with no `--profile-directory` (the profile it used last), so the command line can't tell.
- The account match picked no folder, or a read failed: it says it can't tell, and why. The tool answers as ever, and the reconnect is queued as ever.

With a profile named in the call or the setting, it says nothing of this.

## What it doesn't do

- **It never quits, kills or restarts Chrome.** That would close every session's tabs and tab groups. A restart is your call.
- **It never signs in, and never types anything into Chrome.** Starting Chrome and reconnecting are all it does.
- **Decided on principle: it never opens a profile in a Chrome that is running.** A launch of `chrome.exe --profile-directory=<profile>` at a running Chrome would hand off to it and open that profile's window, as the profile menu does. But when the running Chrome doesn't answer a handed-off launch in time, Chrome ends the browser it takes for hung, and every session's tabs and tab groups with it. So the profile applies only to a start, and opening another profile in a running Chrome stays yours.
- **It acts only on Windows and macOS**, on the machine Chrome runs on. On Linux, WSL or a hosted server it says so, and does nothing.
- **Known limits.** It doesn't see a Chrome whose install path holds a quote, such as a per-user install under a Windows profile folder with an apostrophe: it says Chrome isn't running, and a start then hands off to the running one. The macOS path is tested on fixtures only, not yet on a real Mac. The account match is tested on fixtures only: it has not yet been seen to pick a profile on a real machine. With Chrome's user data folder unknown (a home folder that can't be placed), no folder can be checked, so it starts nothing: start Chrome by hand.

## Flags apply only when Chrome starts

Chrome reads command-line flags only when its browser process starts. Run while Chrome is already running, `chrome.exe` (or `open`) hands the launch to the running process, and the flags are dropped. So when Chrome runs without the flag you opted in to, the tool tells Claude to tell you, and you choose one of:

- **Quit Chrome fully**, then have the session call `chrome_ensure` again. On Windows that is every window, and Chrome in the notification area if it keeps running in the background; on macOS, Cmd+Q.
- **On Windows, add the flag to Chrome's shortcut**: the shortcut's Properties, then add ` --silent-debugger-extension-api` at the end of its Target, so every start from it has the flag.
- **On macOS, start Chrome with it by hand**: `open -a "Google Chrome" --args --silent-debugger-extension-api`.

## Turning the flag on

The `silentDebugger` setting has three values:

- `auto` (the default): on only when the environment variable `CLAUDE_CHROME_SILENT_DEBUGGER` is `1`, `true` or `on` (any case). Otherwise off.
- `on`: always, whatever the variable says.
- `off`: never, whatever the variable says.

**Decided on principle: three values, not two.** Claude Code fills an unset option in with its default before the plugin sees it, so a plugin can't tell "left alone" from "set to the default". A plain on/off with default off could never let the variable apply. With `auto` as the default, the variable is the machine-wide opt-in, and `on` and `off` are your per-plugin override. The variable is the one other plugins of yours can read too, so one opt-in covers every tool that starts Chrome for Claude in Chrome.

To opt in on a machine, set the variable in the environment Claude Code starts in, for example in your settings.json's `env`:

```json
{ "env": { "CLAUDE_CHROME_SILENT_DEBUGGER": "1" } }
```

or set the plugin's own setting:

```
echo '{"silentDebugger":"on"}' | claude plugin configure self-chrome@claude-code-self-tools --values-stdin
```

Either applies to the next Chrome the plugin starts, not to one running now.

## Settings

| Setting | Default | What |
| :- | :- | :- |
| `silentDebugger` | `auto` | Whether a Chrome the plugin starts gets the flag: `auto`, `on` or `off` (above). |
| `profile` | empty | A pin: the profile folder a start opens, by its folder's name; it must be one of Chrome's profile folders ([above](#the-profile)). Empty: the account match ([above](#the-account-match)). Set it where your Claude account's email isn't the profile's Google account, or to start the profile Chrome used last. A value that isn't a folder's name (letters, digits, spaces, `_` and `-`) starts nothing; the answer says how long it is, never what it says. |
| `chromePath` | empty | Chrome's executable, as an absolute path, with no `[`, `]` or backtick. Empty: the standard installs. On Windows, `chrome.exe` under Program Files, then Program Files (x86), then the per-user install under your local application data folder, each as Windows names that folder, never from an environment variable. On macOS, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, then the same under your home folder's Applications; a binary whose name has no `Chrome` in it is refused. |
| `updateCheck` | `on` | See [Update check](#update-check). |

Set them in `/config`, or with `claude plugin configure self-chrome@claude-code-self-tools --values-stdin`.

## Privacy

- **It reads process command lines, Chrome's alone, of your own login.** On Windows, a fixed Windows PowerShell script, run by its known path as the shared machine code runs its scripts, reads the `chrome.exe` processes of its own Windows session with `Get-CimInstance`. It passes on only those that are no child of another (no `--type=`): a child's command line never leaves the script. On macOS, `pgrep -U <your uid>` finds your processes whose command starts with Chrome's executable, and `ps` reads those alone. Of each command line the plugin keeps whether it has the flag and `--no-startup-window`, its `--profile-directory` and its `--user-data-dir`, and nothing else.
- **For the account match, it reads one field of each of two files**, and only when nothing names a profile. Of Claude Code's `.claude.json`: `oauthAccount.emailAddress`, once it has checked that `oauthAccount.accountUuid` is a plain id (letters, digits and `-`, 8 to 64), which it doesn't keep. Of Chrome's Local State: each profile folder's `profile.info_cache.<folder>.user_name`, and no other key (never `os_crypt`). Each file is read only when its stat shows a plain file, no link, of at most 4 MiB (`$.fs.read`'s own limit). Its text is dropped once the field is taken. The two emails are compared, and never kept, logged or shown: not masked, not hashed, not their length or their domain. It never opens `.credentials.json`.
- **It checks profile folders by name.** For a named or a matched folder, it checks that folder in Chrome's user data folder. When none can be started, it lists the folder names there that have a `Preferences` file: directory names only.
- **It prints folder names only**: a profile folder's name (`Profile 3`), never a path, an account, an email or a command line. A profile folder whose name isn't plain (letters, digits, spaces, `_`, `-`) is said to be there, and not shown. A `profile` setting that isn't a folder's name is said to be invalid, with its length, and never repeated.
- **Chrome never gets the session's environment.** On Windows it starts with your login environment, which Windows rebuilds from the registry; on macOS, LaunchServices starts it with its own.
- **It writes nothing** but its own session state (the queued reconnect, and the times of its recent reconnects) and the start's lock, which names a random id and the time, and goes once the start is over. It sends nothing anywhere but the update check below.

## Update check

When Claude calls one of this plugin's tools, and the last check is 30 minutes old or there hasn't been one, the plugin checks whether a newer version is published. It fetches this plugin's `plugin.json` from the `main` branch of the repository its installed `plugin.json` names, [`plugins/self-chrome/.claude-plugin/plugin.json`](https://raw.githubusercontent.com/moefingers/claude-code-self-tools/main/plugins/self-chrome/.claude-plugin/plugin.json), and compares its `version` with the installed one.

- **A plain GET of a public file.** The plugin adds no headers, query or body, and sends nothing about you, the session or the machine. GitHub sees the request as it sees any web request: the address it comes from, the time, and the headers Claude Code sends on its own.
- **At most every 30 minutes.** The check's time and answer are kept in the plugin's own store, so a reload, or another session on this machine, uses that answer until it is 30 minutes old. Sessions that come due at the same moment each make their one request.
- **It never holds up the tool.** The check runs beside the call, which never waits on it. Offline, refused by policy, a 404, a rate limit, no answer within 5 seconds, or anything but a plain version such as `0.2.0` all mean no notice.
- **When a newer version is out**, a toast tells you, and the result of one of Claude's next calls ends with a line like this:

  > self-chrome 0.1.2 is out of date (0.2.0 is published). To update, the person runs: claude plugin marketplace update claude-code-self-tools, then claude plugin update self-chrome@claude-code-self-tools, then /reload-plugins in each open session (a new session loads the update on its own). Don't run these yourself unless the person asks.

  The line is fixed text. Only the two version numbers vary, and each must be three plain numbers. Nothing else from the fetched file reaches Claude. A session is told of each check once, and at most once every 30 minutes, not on every call, and the toast follows the same rule. A call carries only what an earlier check found: the call that starts a check doesn't wait for its answer.
- **Turn it off** with the plugin's `updateCheck` setting: `off` never checks. Set it in `/config`, or from your shell:

  ```
  echo '{"updateCheck":"off"}' | claude plugin configure self-chrome@claude-code-self-tools --values-stdin
  ```

  which saves it in settings.json as `"pluginConfigs": { "self-chrome@claude-code-self-tools": { "options": { "updateCheck": "off" } } }`. Nothing is checked while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, to any value, or for a subagent's call.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-chrome@claude-code-self-tools
```

Then, on a machine whose owner opts in to the flag, set `silentDebugger` to `on`, or `CLAUDE_CHROME_SILENT_DEBUGGER=1` (see [Turning the flag on](#turning-the-flag-on)). Without either, the plugin starts Chrome without the flag, and the banner shows as it always has.
