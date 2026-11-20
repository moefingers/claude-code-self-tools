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

- `profile` (optional): the profile folder a start opens, by its folder's name (`Default`, `Profile 2`), never an account. It must be one of Chrome's profile folders ([below](#the-profile)). Used only when Chrome isn't running. Left out: the `profile` setting, else none, and Chrome opens the profile it used last.
- `reconnect` (optional, default `true`): queue `/mcp reconnect claude-in-chrome` for when the turn ends.
- `resume` (optional): the message that starts the session's next turn once the reconnect has run, as [self-mcp](../self-mcp)'s `resume`.

## What it does

1. **It looks for your Chrome**: the browser process of the configured Chrome (the one that is no child of another, with no `--type=`), of your own login, on Chrome's default user data folder. A test or isolated Chrome, started with a `--user-data-dir` of its own (Playwright's, say), isn't yours: it is counted apart, and never touched. It says whether Chrome runs, whether it started with the flag, and the profile folder its command line names, if any.
   - **Chrome in the background counts as running.** A Chrome with no window (`--no-startup-window`, as Chrome starts at login when it keeps running in the background) is said plainly to run in the background with no window. A start would only hand off to it, and it took its flags when it started.
   - **A Chrome whose command line can't be read** (an elevated Chrome, run as administrator) leaves the look unable to say that Chrome isn't running. So it says it can't tell, and starts nothing.
2. **If Chrome isn't running, it starts it**, detached, with `--restore-last-session`, the flag when you opted in, and `--profile-directory=<profile>` only when the call or the `profile` setting names one. The launch is short: it returns at once, and looks of their own then wait up to 20 seconds for the browser process. It says the PID, and whether the flag took.
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

**Decided on principle: when nothing names a profile, the plugin names none.** With no `profile` in the call and no `profile` setting, a start passes no `--profile-directory`, and Chrome opens the profile it used last, restoring the profiles it had open. Chrome knows its last profile better than any guess the plugin could make. So the plugin reads nothing of Chrome's Local State.

A profile that is named must be one of Chrome's profile folders: a folder of exactly that name in Chrome's user data folder, with its `Preferences` file. Given any other name, Chrome would make a new, empty profile of that name, without Claude in Chrome, and leave it in your profile picker. So the plugin starts nothing, and lists the profile folders that are there, by folder name only (`"Default", "Profile 3"`), never their display names or accounts. It never repeats the name it was given, which may be an account's.

`--restore-last-session` reopens the last session of each profile Chrome opens, whatever that profile's own "On startup" setting says.

## What it doesn't do

- **It never quits, kills or restarts Chrome.** That would close every session's tabs and tab groups. A restart is your call.
- **It never signs in, and never types anything into Chrome.** Starting Chrome and reconnecting are all it does.
- **Decided on principle: it never opens a profile in a Chrome that is running.** A launch of `chrome.exe --profile-directory=<profile>` at a running Chrome would hand off to it and open that profile's window, as the profile menu does. But when the running Chrome doesn't answer a handed-off launch in time, Chrome ends the browser it takes for hung, and every session's tabs and tab groups with it. So the profile applies only to a start, and opening another profile in a running Chrome stays yours.
- **It acts only on Windows and macOS**, on the machine Chrome runs on. On Linux, WSL or a hosted server it says so, and does nothing.
- **Known limits.** It doesn't see a Chrome whose install path holds a quote, such as a per-user install under a Windows profile folder with an apostrophe: it says Chrome isn't running, and a start then hands off to the running one. The macOS path is tested on fixtures only, not yet on a real Mac.

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
| `profile` | empty | The profile folder a start opens, by its folder's name; it must be one of Chrome's profile folders ([above](#the-profile)). Empty: none, and Chrome opens the profile it used last. A value that isn't a folder's name (letters, digits, spaces, `_` and `-`) starts nothing; the answer says how long it is, never what it says. |
| `chromePath` | empty | Chrome's executable, as an absolute path, with no `[`, `]` or backtick. Empty: the standard installs. On Windows, `chrome.exe` under Program Files, then Program Files (x86), then the per-user install under your local application data folder, each as Windows names that folder, never from an environment variable. On macOS, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, then the same under your home folder's Applications; a binary whose name has no `Chrome` in it is refused. |
| `updateCheck` | `on` | See [Update check](#update-check). |

Set them in `/config`, or with `claude plugin configure self-chrome@claude-code-self-tools --values-stdin`.

## Privacy

- **It reads process command lines, Chrome's alone, of your own login.** On Windows, a fixed Windows PowerShell script, run by its known path as the shared machine code runs its scripts, reads the `chrome.exe` processes of its own Windows session with `Get-CimInstance`. It passes on only those that are no child of another (no `--type=`): a child's command line never leaves the script. On macOS, `pgrep -U <your uid>` finds your processes whose command starts with Chrome's executable, and `ps` reads those alone. Of each command line the plugin keeps whether it has the flag and `--no-startup-window`, its `--profile-directory` and its `--user-data-dir`, and nothing else.
- **It reads nothing of Chrome's Local State.** When a profile is named, it checks that folder in Chrome's user data folder. When it isn't there, it lists the folder names there that have a `Preferences` file: directory names only.
- **It prints folder names only**: a profile folder's name (`Profile 3`), never a path, an account or a command line. A profile folder whose name isn't plain (letters, digits, spaces, `_`, `-`) is said to be there, and not shown. A `profile` setting that isn't a folder's name is said to be invalid, with its length, and never repeated.
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
