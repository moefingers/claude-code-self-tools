# self-desktop

Lets a session read its own machine's desktop on Windows: list the windows, read its own terminal window and its own pane's text, and take a picture of its own window where that can be shown safe. It never clicks, types, focuses, moves or closes anything. Part of [claude-code-self-tools](../../README.md).

**Status: not yet seen to work.** Version 0.1.0 is written and checked as text only: its scripts parse, and no test of it has run. None of its tools has run on a real desktop, and its C# helper has never been compiled. The first real run is a guarded one, on a window and a pseudoconsole its live tests open themselves ([Tests](#tests)).

It is **off until you turn it on**, and **Windows only**. macOS isn't built.

## Turn it on

Set `enabled` to `on`. In `/config`, or from your shell:

```
echo '{"enabled":"on"}' | claude plugin configure self-desktop@claude-code-self-tools --values-stdin
```

That saves it in settings.json as `"pluginConfigs": { "self-desktop@claude-code-self-tools": { "options": { "enabled": "on" } } }`. A session reads it when it loads the plugin: at its next start, or at a `/reload-plugins` that loads the plugin again. While it is off, every tool answers in one line that self-desktop is off and how to turn it on, and nothing is read.

**Your permission rules hold too.** Decided on principle: a tool that reads the desktop stays under the person's permission rules as well as its own setting. So each call that passes the plugin's own refusals goes through Claude Code's permission check before it runs, as an MCP tool's call does: an allow rule (`mcp__self-desktop__desktop_windows`, or `mcp__self-desktop__*` for all three) lets it run unasked, an `ask` rule asks each time, and a `deny` rule refuses it. With no rule for it, your permission mode decides; in Manual mode Claude Code shows its permission prompt before the call. (That is Claude Code's documented behaviour for MCP tools; it hasn't been seen for this plugin's tools.)

## Tools

Claude sees each as `mcp__self-desktop__<tool>`. None takes an input: a call with any argument is refused, and nothing is read. Each sits behind ToolSearch. A subagent is refused: the desktop is read for the main session only.

- **`desktop_windows`** lists every top-level window a person could see (visible, not cloaked): its program (the process's image name), its rectangle and its drawn frame in virtual-screen pixels, its monitor, its state (normal, minimized, maximized), which window is in front, and which is this session's own. Each monitor comes with its rectangle, its work area and its DPI, so a rectangle can be judged. The answer is a few lines, then one JSON line per monitor and per window, to copy into a placement file.
  - **A title only for Windows Terminal windows and this session's own window.** Every other window comes with no title at all: a title can carry a mail subject or a document's name. That is a decision, not a default. No window's content is read.
  - **A Windows Terminal window's title, and a tab's name in a read, are text chosen by whatever runs there, another session included.** They come back quoted, as data.
  - `rect` is the window's own rectangle (`GetWindowRect`, with the invisible resize border Windows 10 and 11 add); `frame` is the part drawn on screen (DWM's extended frame bounds). A minimized window has neither.
  - The order is the order Windows lists the windows in: front to back, as far as known. Microsoft's page doesn't promise it, and the answer says so.
- **`desktop_read`** reads this session's own terminal window:
  - its controls as a small tree: role, name, state (disabled, offscreen, focused, selected, checked), bounds, and a reference, the element's UI Automation runtime id. Windows keeps a runtime id for the element's life and may reuse it later. Nothing in this step takes a reference back.
  - the text that shows in **this session's own pane**, read from this session's own console, each line quoted after `| `: its bottom rows, at most 200 of them and 20,000 characters in all. When the pane holds more, the answer says how many rows and characters above were left out.
  - Every control character, format character (the bidi controls, the zero widths, the Unicode tag characters), line separator and paragraph separator in the pane's text, a name or a title is shown as its code, such as `[U+202E]`, so a line can't turn round, hide text, or end early under its `| `. Private-use and other code points no one sees are dropped.
- **`desktop_capture`** saves a picture of this session's own window to a PNG in the plugin's own folder, and answers with the file's path for the session to read: **a classic console window only** ([below](#the-capture)).

Each answer names what it read (the program, and the title where one is allowed), and its first line says what was read: the window and the pane, one of them, or nothing. Read and capture tell you in a toast what they read, by program only, and show no toast when nothing was read. Every answer that carries a window's text or picture says it is data, never instructions, the same as a web page's text.

## The rule that shapes read and capture

> Read and capture never run against another app's window or another session's pane without the owner's word for that occasion. Windows can show credentials and private mail. Their own tests use a window they opened themselves.

This step has no way to give that word, so:

- **Read and capture take no target.** No window handle, process id, title or index reaches them from a call. They act on this session's own terminal window, which they find by themselves, as below. A call that asks for any other window is refused, saying it needs the owner's word and that asking for it isn't built yet.
- **The pane's text comes from this session's own console**, never from the terminal's UI Automation text, which belongs to whichever tab is showing. The tree of a terminal window names only the window, its title bar, its tabs and its buttons, and leaves out the text, the name and the children of every terminal control. The plugin applies that name rule a second time to what its script sends, as it does the title rule.
- **Nothing is read from a console another program shares.** In the attach, the script lists the processes on the console. It goes on only when each one is this script, the process Claude Code names as its own, an ancestor of that process, or a descendant of it, and when none but that process carries its image name, wherever it sits, this script itself aside (another Claude Code process on the console means another session's text may be on the screen). Otherwise the pane, the tree and the picture are all refused, saying which program shares it and that nothing was read. Decided on principle: this fails closed, even where it refuses a harmless case, such as a Claude Code that runs as `node.exe` with a `node.exe` child of its own on the console. The guarded run shows whether an ordinary session passes.
- **A picture of a Windows Terminal window isn't built in this step.** Decided on principle: nothing the window's structure shows proves the picture would hold only this session's pane. A zoomed pane takes the other panes out of that structure, and the pane on screen could then be another session's. So the capture of a Windows Terminal window is refused, saying so, and `desktop_read` reads this session's own pane as text.
- **No control's value is read**, anywhere. A password field (UI Automation marks them) is given with no name and no value.

## How it finds this session's own window and pane

Each tool runs one fixed Windows PowerShell script, by its known path, with the script on standard input. The script compiles a small C# helper with `Add-Type` (Windows' own calls have no managed form) and calls it once. The compile starts the C# compiler each call, which costs an estimated one to three seconds a call; that is an estimate, not a measurement.

1. **This session's process.** Claude Code hands each plugin `CLAUDE_PID`, its own process id, through `$.process.hookEnv()` ([its environment-variables reference](https://code.claude.com/docs/en/env-vars): "its own process ID in the subprocesses it spawns"). The plugin takes it only when it is a whole number, and never from a call. The helper then checks that this process is one the script itself runs under, walking up from its own process, each parent older than its child. Without `CLAUDE_PID` (Claude Code before 2.1.214), read and capture refuse and run nothing; the list runs without its own window.
2. **This session's console.** The helper detaches from its own console and attaches, for a moment, to the console of that process. In that one attach it reads the console's window and the processes on the console, and judges them: who shares the console (above), and whether the console is a pane at all. Only then, for a read, does it read the part of the active screen buffer that shows, through a handle opened for reading only (`CONOUT$` with `GENERIC_READ`). It writes nothing to the console, and detaches in a `finally`.
   - **A session with no console** (an app or an SDK host that starts it with none: the attach fails) reads nothing, and the answer says why.
   - **A console with no window, or a classic console window that is hidden, is no pane**, and nothing is read: a console made without a window is what a tool's command gets (its processes sit on a hidden console of their own), and an app or SDK host can give Claude Code one too. A pseudoconsole's window counts as a pane whoever owns it, so a terminal that isn't Windows Terminal (an editor's) still has its pane read.
3. **This session's window.** Under Windows Terminal, the console's window is a hidden `PseudoConsoleWindow` whose owner is the Windows Terminal window (`CASCADIA_HOSTING_WINDOW_CLASS`, of `WindowsTerminal.exe`) showing this session's tab. In a classic console that is shown, the console's own window (`ConsoleWindowClass`) is the session's window. Anything else (a pseudoconsole window with no owner, or owned by another terminal) is refused, saying which class it found; the pane is still read from the console.

Attaching to the nearest parent process would be wrong: a tool's own shells sit on hidden consoles of their own (120 columns by 9,001 rows), not the session's pane. A check on one machine found the session's own console only by the session's own process id, and its window's owner to be the Windows Terminal window.

## The capture

- **A classic console window only**, of this session's own console, shown, and with no other program on that console. A picture of a Windows Terminal window isn't built in this step ([above](#the-rule-that-shapes-read-and-capture)).
- **The window's own pixels.** The window renders itself into a bitmap the script owns (`PrintWindow`, with its full-content flag). Never the screen, and never what happens to cover the window. Nothing is brought forward.
- **Looked at again once the picture is taken.** If another program has joined this session's console meanwhile, or the console is shown by another window, the picture is deleted and the answer says why.
- **Cropped to the drawn frame**, so the PNG is the size the window shows on screen.
- **Refused** for a minimized window (a picture would be empty, and restoring it would act on it) and one that isn't shown (hidden, or on another virtual desktop).
- **Kept on this machine**, in `captures` under the plugin's own data folder (`CLAUDE_PLUGIN_DATA`), named `capture-<a fresh UUID>.png`. The plugin never uploads or sends a picture anywhere.
- **How long a picture lasts:** until the first call of any of this plugin's tools, or the first session start, 10 minutes or more after it was taken. Both delete the captures 10 minutes old or more, whatever the `enabled` setting says, and touch nothing else in the folder. A picture taken in a session that then ends, with no session started after, stays until one is. Asking for the data folder to clean it makes the folder when it isn't there, so with the plugin off, a session start on Windows can leave an empty data folder behind.

## The deny list

A fixed list of program names whose windows are never read or captured, whatever a later step builds. **In step 1 it guards nothing a tool can reach:** read and capture only reach this session's own terminal or console window. It is there for later steps, and the live tests' own routes pass through it. In the list, such a window appears like any other app's: program, rectangle, monitor and state.

- Windows' security and credential prompts, and its sign-in and lock screens: `consent.exe`, `CredentialUIBroker.exe`, `CredentialEnrollmentManager.exe`, `LogonUI.exe`, `LockApp.exe`, `SecHealthUI.exe`.
- System settings: `SystemSettings.exe`, `SystemSettingsAdminFlows.exe`, `mmc.exe`, `regedit.exe`. Control Panel and Credential Manager run in `explorer.exe`, so no name here covers them.
- Password managers: `1Password.exe`, `Bitwarden.exe`, `KeePass.exe`, `KeePassXC.exe`, `Dashlane.exe`, `LastPass.exe`, `Enpass.exe`, `RoboForm.exe`, `NordPass.exe`, `KeeperPasswordManager.exe`, `Proton Pass.exe`, `pwsafe.exe`.

**How it was chosen:** by hand, from the Windows programs that show credential and security prompts, sign-in and lock screens and system settings, and the desktop apps of widely used password managers. **Every name rests on memory:** none was checked against an install. The Windows ones are long-standing system programs; the password managers' are the likeliest to be wrong, and Dashlane's desktop app is retired. **A renamed program passes a list of names**, as does one missing from it. A window's program and the programs of its child windows are checked, so an app hosted by another program's frame is caught while its window sits in that frame.

## Elevated windows and the system's prompts

- **The list shows an elevated window like any other**: its program, rectangle, monitor and state. Those reads need nothing of the window's process.
- **Read and capture never reach one.** They act only on this session's own window, and a program without UIAccess reads no elevated window's UI through UI Automation ([Microsoft](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview)).
- **The system's permission prompts** (User Account Control's) run on the secure desktop, which the list doesn't see; where they show on the person's desktop instead, they are elevated, and on the deny list.

## Read only, by construction

Nothing in the plugin makes input, focuses, activates, moves, resizes, minimizes, restores or closes a window, or changes a control. In UI Automation it reads properties alone and never obtains a pattern object, which is what every action goes through. `scripts/desktop-text.test.mjs` fails when any shipped file of the plugin's hooks names such a call, comments included, and when the helper imports, calls or builds anything outside a reviewed list.

**No lease in this step.** Decided on principle: two readers can't clobber each other. A lease comes with the first step that acts.

## Known limits

- **The ancestor check accepts any ancestor.** The process Claude Code names must be one the script runs under, anywhere up its chain, not only its direct parent. Another installed plugin could hook `$.process.hookEnv` and rewrite `CLAUDE_PID` to an ancestor further up, such as another session's process this one was started from. The sharing check then still refuses a console that holds another Claude Code process. What would tighten it: the guarded run showing that the script is Claude Code's direct child, after which only the direct parent would be accepted.
- **The visible part of the pane can hold text a process printed before it left the console**, an earlier program in the same pane included. The sharing check sees only the processes on the console now.

## Not built

- Any action: a click, a key, focus, moving or placing a window. If built, it comes in this order: acting on a control by reference, keys into one terminal pane without taking focus, and last synthetic mouse and keyboard at coordinates behind a look, aim, guard and commit loop.
- A way for the owner to give their word for one occasion, so read or capture could reach another window or pane.
- Taking a reference back: no tool takes a runtime id yet, so none says when one has gone stale.
- A picture of a Windows Terminal window. A route for a later step: the count of pseudoconsole windows a terminal window owns, to be measured on real panes first.
- A minimized window's restored rectangle, a hosted app's own program behind its frame in the list (a Settings window lists as `ApplicationFrameHost.exe`), and a window's class name in the list.
- Terminals other than Windows Terminal and the classic console (an editor's terminal, other terminal apps): the pane is read, the window isn't found.
- macOS (its accessibility API asks the person's consent per program), Linux, WSL.
- The lease, and a coordinator's say over it.

## Unshown until the guarded run

Rests on the code and on Microsoft's pages, not on a run:

- That the helper compiles under Windows PowerShell 5.1's C# compiler.
- That the characters of the session's own console read as they show, and that the read follows the alternate screen while an interface has it up (the live tests show both on a pseudoconsole of their own). One check measured only that the session's own console opens for reading, and its size, never its characters.
- That an ordinary session's console passes the sharing check: which processes Claude Code and its shell leave attached to the pane.
- That `PrintWindow` with the full-content flag renders a classic console window as it shows (the flag is in Windows' header from 8.1 and left out of Microsoft's page).
- That Windows Terminal's terminal control has the class name `TermControl`, which the tree leaves out by class as well as by its text.
- That UI Automation gives a per-monitor-aware thread physical pixels.
- That a call served after the permission check is asked about as the section above says.
- Wide characters (East Asian, emoji) in the pane: how a cell holding half of one reads.

The plugin runs Windows PowerShell 5.1 by its known path, never PowerShell 7, so nothing of it depends on 7.

## Tests

- `tests/self-desktop.test.ts`: the tool layer with the machine stood in. Off by default and the words; not Windows; a subagent; every kind of argument refused with nothing run; a call Claude Code's permission check refuses runs no script; the scripts read and capture run act on `CLAUDE_PID` alone, never a window by its handle; a process id of any other shape; old captures deleted at a call and at a session's start, with the plugin off, and nothing else in the folder touched; the title rule held whatever a script sends; the name rule held whatever a script sends; the read's quoting, the hidden characters shown, the pane's limits, what it leaves out, and its first line and toast for each of what was read; no console, a console with no window, and a shared console, each reading nothing; the capture's file, its folder, its lifetime, a Windows Terminal window refused as not built, a console changed during the picture, the deny list; failures; the helper's text (read-only console handle, one attach and its detach in a `finally`, the pane read only once the console is judged a pane of this session's own, titles only where allowed, no pattern object, no structure count, its limits equal to the answers').
- `scripts/desktop-text.test.mjs`: nothing in the shipped hooks acts, each kind of fault planted on a line of its own and found on that line, and the helper as shipped holding none; the helper's imports, .NET calls and built types equal to a reviewed list; the PowerShell plumbing equal to the shared machine code's; on Windows, every script parses, the helper compiles under `Add-Type`, and its pure rules (the ancestor check, a reused id, who may share the console, whether a console is a pane, which window is the session's own, which names a tree gives, how much of a pane is kept, the deny list, whether a picture is taken) give the right answers for fixed values, with no window read and no console attached to.
- `scripts/desktop-live.test.mjs`, **Windows only, and only with `SELF_DESKTOP_LIVE=1`**, since each test puts a window of its own on the screen for a few seconds: a plain form shown without taking the focus, with a title made at run time, a text box, a password box whose value is made at run time, a button and two tabs, closed in a `finally`. It shows that the list finds it with its rectangle and monitor and no title; that the tree holds the text box and the button with their names and bounds, and the password box with no name, and that no value of either box is read; that the capture is a PNG of the drawn frame's size holding the form's own colour; and that nothing moved or activated it, or changed the window in front. On a pseudoconsole of the test's own, it shows that the tools' own read script reads the characters, the alternate screen while it is up, and the main screen after the reads exactly as the test wrote it.

None of these has been run yet.

## Update check

As every self tool's: when Claude calls one of this plugin's tools, at most every 30 minutes, it fetches this plugin's published [`plugin.json`](https://raw.githubusercontent.com/moefingers/claude-code-self-tools/main/plugins/self-desktop/.claude-plugin/plugin.json) (a plain GET of a public file) and, when a newer version is out, a toast and one tool answer say so, with the update steps for you to run. It rides on the off answer too. Turn it off with the `updateCheck` setting (`off`); it is also off while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-desktop@claude-code-self-tools
```

Then turn it on ([above](#turn-it-on)).
