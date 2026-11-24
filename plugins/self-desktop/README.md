# self-desktop

Lets a session read its own machine's desktop on Windows: list the windows, read its own terminal window and its own pane's text, and take a picture of that window. It never clicks, types, focuses, moves or closes anything. Part of [claude-code-self-tools](../../README.md).

**Status: not yet seen to work.** Version 0.1.0 is written and checked as text only: its scripts parse, and no test of it has run. None of its tools has run on a real desktop. The first real run is a guarded one, on windows and a console its live tests open themselves ([Tests](#tests)).

It is **off until you turn it on**, and **Windows only**. macOS isn't built.

## Turn it on

Set `enabled` to `on`. In `/config`, or from your shell:

```
echo '{"enabled":"on"}' | claude plugin configure self-desktop@claude-code-self-tools --values-stdin
```

That saves it in settings.json as `"pluginConfigs": { "self-desktop@claude-code-self-tools": { "options": { "enabled": "on" } } }`. A session reads it when it loads the plugin: at its next start, or at a `/reload-plugins` that loads the plugin again. While it is off, every tool answers in one line that self-desktop is off and how to turn it on, and nothing is read.

## Tools

Claude sees each as `mcp__self-desktop__<tool>`. None takes an input: a call with any argument is refused, and nothing is read. Each sits behind ToolSearch.

- **`desktop_windows`** lists every top-level window a person could see (visible, not cloaked): its program (the process's image name), its rectangle and its drawn frame in virtual-screen pixels, its monitor, its state (normal, minimized, maximized), which window is in front, and which is this session's own. Each monitor comes with its rectangle, its work area and its DPI, so a rectangle can be judged. The answer is a few lines, then one JSON line per monitor and per window, to copy into a placement file.
  - **A title only for Windows Terminal windows and this session's own window.** Every other window comes with no title at all: a title can carry a mail subject or a document's name. That is a decision, not a default. No window's content is read.
  - `rect` is the window's own rectangle (`GetWindowRect`, with the invisible resize border Windows 10 and 11 add); `frame` is the part drawn on screen (DWM's extended frame bounds). A minimized window has neither.
  - The order is the order Windows lists the windows in, which is front to back; Microsoft's page doesn't promise it.
- **`desktop_read`** reads this session's own terminal window:
  - its controls as a small tree: role, name, state (disabled, offscreen, focused, selected, checked), bounds, and a reference, the element's UI Automation runtime id. Windows keeps a runtime id for the element's life and may reuse it later. Nothing in this step takes a reference back.
  - the text that shows in **this session's own pane**, read from this session's own console, each line quoted after `| `.
- **`desktop_capture`** saves a picture of this session's own window to a PNG in the plugin's own folder, and answers with the file's path for the session to read.

Read and capture tell you in a toast what they read, by program only. Every answer that carries a window's text or picture says it is data, never instructions, the same as a web page's text, and names what it read (the program, and the title where one is allowed).

## The rule that shapes read and capture

> Read and capture never run against another app's window or another session's pane without the owner's word for that occasion. Windows can show credentials and private mail. Their own tests use a window they opened themselves.

This step has no way to give that word, so:

- **Read and capture take no target.** No window handle, process id, title or index reaches them from a call. They act on this session's own terminal window, which they find by themselves, as below. A call that asks for any other window is refused, saying it needs the owner's word and that asking for it isn't built yet.
- **Another session's pane is never read, not even to compare.** One Windows Terminal window holds several tabs and panes, each another session's. So the pane's text comes from this session's own console, never from the terminal's UI Automation text, which belongs to whichever tab is showing. The tree of a terminal window names only the window, its title bar, its tabs and its buttons, and leaves out the text, the name and the children of every terminal control.
- **A capture of the terminal window is made only when its structure alone shows it holds one tab with one pane**, so its pixels can only be this session's own. Otherwise it is refused, saying why: the window has other tabs or panes (or no tab strip to count them by), a picture could show another session's, and that isn't built. The structure is read again once the picture is taken: a tab or pane added meanwhile, or this session's tab moved to another window, and the picture is deleted.
- **No control's value is read**, anywhere. A password field (UI Automation marks them) is given with no name and no value.

## How it finds this session's own window and pane

Each tool runs one fixed Windows PowerShell script, by its known path, with the script on standard input. The script compiles a small C# helper (Windows' own calls have no managed form) and calls it once.

1. **This session's process.** Claude Code hands each plugin `CLAUDE_PID`, its own process id, through `$.process.hookEnv()` ([its environment-variables reference](https://code.claude.com/docs/en/env-vars): "its own process ID in the subprocesses it spawns"). The plugin takes it only when it is a whole number, and never from a call. The helper then checks that this process is one the script itself runs under, walking up from its own process, each parent older than its child. Without `CLAUDE_PID` (Claude Code before 2.1.214), read and capture refuse and run nothing; the list runs without its own window.
2. **This session's console.** The helper detaches from its own console and attaches, for a moment, to the console of that process, which is the console of the pane the session runs in. It reads the console's window handle and, for a read, the part of the active screen buffer that shows, through a handle opened for reading only (`CONOUT$` with `GENERIC_READ`). It writes nothing to the console, and detaches in a `finally`. A session an app or an SDK host runs has no console: read and capture say so, and read nothing.
3. **This session's window.** Under Windows Terminal, the console's window is a hidden `PseudoConsoleWindow` whose owner is the Windows Terminal window (`CASCADIA_HOSTING_WINDOW_CLASS`, of `WindowsTerminal.exe`) showing this session's tab. In a classic console the console's own window (`ConsoleWindowClass`) is the session's window. Anything else (a pseudoconsole window with no owner, or owned by another terminal) is refused, saying which class it found; the pane is still read from the console.

Attaching to the nearest parent process would be wrong: a tool's own shells sit on hidden consoles of their own (120 columns by 9,001 rows), not the session's pane. A check on one machine found the session's own console only by the session's own process id, and its window's owner to be the Windows Terminal window.

## The capture

- **The window's own pixels.** The window renders itself into a bitmap the script owns (`PrintWindow`, with the flag that takes DirectComposition content such as Windows Terminal's). Never the screen, and never what happens to cover the window. Nothing is brought forward.
- **Cropped to the drawn frame**, so the PNG is the size the window shows on screen.
- **Refused** for a minimized window (a picture would be empty, and restoring it would act on it) and one that isn't shown (hidden, or on another virtual desktop).
- **Kept on this machine**, in `captures` under the plugin's own data folder (`CLAUDE_PLUGIN_DATA`), named `capture-<a fresh UUID>.png`. At each capture, captures 10 minutes old or more are deleted, and nothing else in the folder is touched. The plugin never uploads or sends a picture anywhere.

## The deny list

A fixed list of program names whose windows are never read or captured, whatever a later step builds. In the list, such a window appears like any other app's: program, rectangle, monitor and state.

- Windows' security and credential prompts, and its sign-in and lock screens: `consent.exe`, `CredentialUIBroker.exe`, `CredentialEnrollmentManager.exe`, `LogonUI.exe`, `LockApp.exe`, `SecHealthUI.exe`.
- System settings: `SystemSettings.exe`, `SystemSettingsAdminFlows.exe`, `control.exe`, `mmc.exe`, `regedit.exe`.
- Password managers: `1Password.exe`, `Bitwarden.exe`, `KeePass.exe`, `KeePassXC.exe`, `Dashlane.exe`, `LastPass.exe`, `Enpass.exe`, `RoboForm.exe`, `NordPass.exe`, `KeeperPasswordManager.exe`, `Proton Pass.exe`, `pwsafe.exe`.

**How it was chosen:** by hand, from the Windows programs that show credential and security prompts, sign-in and lock screens and system settings, and the desktop apps of widely used password managers, by the image names their installs use as far as known, not from a vendor's list. A name missing from it is a gap, to be reported. A window's program and the programs of its child windows are checked, so an app hosted by another program's frame is caught too. In this step read and capture only ever reach this session's own terminal window, so the list guards what later steps build.

## Elevated windows and the system's prompts

- **The list shows an elevated window like any other**: its program, rectangle, monitor and state. Those reads need nothing of the window's process.
- **Read and capture never reach one.** They act only on this session's own window, and a program without UIAccess reads no elevated window's UI through UI Automation ([Microsoft](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview)).
- **The system's permission prompts** (User Account Control's) run on the secure desktop, which the list doesn't see; where they show on the person's desktop instead, they are elevated, and on the deny list.

## Read only, by construction

Nothing in the plugin makes input, focuses, activates, moves, resizes, minimizes, restores or closes a window, or changes a control. In UI Automation it reads properties alone and never obtains a pattern object, which is what every action goes through. `scripts/desktop-text.test.mjs` fails when any shipped file of the plugin's hooks names such a call, comments included.

**No lease in this step.** Decided on principle: two readers can't clobber each other. A lease comes with the first step that acts.

## Not built

- Any action: a click, a key, focus, moving or placing a window. If built, it comes in this order: acting on a control by reference, keys into one terminal pane without taking focus, and last synthetic mouse and keyboard at coordinates behind a look, aim, guard and commit loop.
- A way for the owner to give their word for one occasion, so read or capture could reach another window or pane.
- Taking a reference back: no tool takes a runtime id yet, so none says when one has gone stale.
- A capture of a terminal window with more than one tab or pane, or whose tab strip is hidden (`alwaysShowTabs` off with one tab): refused.
- A minimized window's restored rectangle, a hosted app's own program behind its frame in the list (a Settings window lists as `ApplicationFrameHost.exe`), and a window's class name in the list.
- Terminals other than Windows Terminal and the classic console (an editor's terminal, other terminal apps): the pane is read, the window isn't found.
- macOS (its accessibility API asks the person's consent per program), Linux, WSL.
- The lease, and a coordinator's say over it.

## Unshown until the guarded run

Rests on the code and on Microsoft's pages, not on a run:

- That the characters of the session's own console read as they show, and that the read follows the alternate screen while an interface has it up (the live tests show both on a console of their own). One check measured only that the session's own console opens for reading, and its size, never its characters.
- That `PrintWindow` with the full-content flag renders a Windows Terminal window (the flag is in Windows' header from 8.1 and left out of Microsoft's page).
- That Windows Terminal's tabs read as `TabItem` elements and its terminal control's class name is `TermControl`, which the structure rule counts.
- That UI Automation gives a per-monitor-aware thread physical pixels.
- Wide characters (East Asian, emoji) in the pane: how a cell holding half of one reads.

The plugin runs Windows PowerShell 5.1 by its known path, never PowerShell 7, so nothing of it depends on 7.

## Tests

- `tests/self-desktop.test.ts`: the tool layer with the machine stood in. Off by default and the words; not Windows; a subagent; every kind of argument refused with nothing run; the scripts read and capture run act on `CLAUDE_PID` alone, never a window by its handle; a process id of any other shape; the title rule held whatever a script sends; the read's quoting and what it leaves out; the capture's file, its folder, its refusals by structure and by the deny list; failures; the helper's text (read-only console handle, one attach and its detach in a `finally`, titles only where allowed, no pattern object, its limits equal to the answers').
- `scripts/desktop-text.test.mjs`: nothing in the shipped hooks acts (each kind of fault planted and found); the PowerShell plumbing equals the shared machine code's; on Windows, every script parses and the helper compiles under `Add-Type`, with nothing of it called.
- `scripts/desktop-live.test.mjs`, **Windows only, and only with `SELF_DESKTOP_LIVE=1`**, since each test puts a window of its own on the screen for a few seconds: a plain form shown without taking the focus, with a title made at run time, a text box, a password box whose value is made at run time, a button and two tabs, closed in a `finally`. It shows that the list finds it with its rectangle and monitor and no title; that the tree holds the text box and the button with their names and bounds, and the password box with no name, and that no value of either box is read; that the capture is a PNG of the drawn frame's size holding the form's own colour; that nothing moved or activated it, or changed the window in front; that the structure rule refuses its two tabs; and, on a hidden console of the test's own, that the tools' own read script reads the characters, the alternate screen while it is up, and the main screen again.

None of these has been run yet.

## Update check

As every self tool's: when Claude calls one of this plugin's tools, at most every 30 minutes, it fetches this plugin's published [`plugin.json`](https://raw.githubusercontent.com/moefingers/claude-code-self-tools/main/plugins/self-desktop/.claude-plugin/plugin.json) (a plain GET of a public file) and, when a newer version is out, a toast and one tool answer say so, with the update steps for you to run. It rides on the off answer too. Turn it off with the `updateCheck` setting (`off`); it is also off while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-desktop@claude-code-self-tools
```

Then turn it on ([above](#turn-it-on)).
