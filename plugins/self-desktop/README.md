# self-desktop

Lets a session read its own machine's desktop on Windows: list the windows, read its own terminal window and the text showing in its own pane, and take a picture of its own window where that can be shown safe. It never clicks, types, focuses, moves or closes anything. Part of [claude-code-self-tools](../../README.md).

**Status: its tests pass, its scripts have read one real pane, and each tool has been served once through the loaded plugin, in a session outside Windows Terminal.** On Windows 11 its text test, its engine tests and its live tests pass, the live ones on a window and a pseudoconsole of their own; its list and read scripts have read one session's own Windows Terminal window and pane, once; and a session that loaded the plugin with `--plugin-dir` has called each tool once ([what ran](#what-ran) has each run and its counts). No session in a Windows Terminal pane has yet called a tool, and the plugin has not been installed from the marketplace, so [some things no run has shown](#not-shown-by-any-run).

It is **off until you turn it on**, and **Windows only**. macOS isn't built.

## Turn it on

Set `enabled` to `on`. In `/config`, or from your shell:

```
echo '{"enabled":"on"}' | claude plugin configure self-desktop@claude-code-self-tools --values-stdin
```

That saves it in settings.json as `"pluginConfigs": { "self-desktop@claude-code-self-tools": { "options": { "enabled": "on" } } }`. A session reads it when it loads the plugin: at its next start, or at a `/reload-plugins` that loads the plugin again. While it is off, every tool answers in one line that self-desktop is off and how to turn it on, and nothing is read.

**Your permission rules hold for the model's own calls.** Decided on principle: a tool that reads the desktop stays under the person's permission rules as well as its own setting. So each call the model makes that passes the plugin's own refusals goes through Claude Code's permission check before it runs, as an MCP tool's call does: an allow rule (`mcp__self-desktop__desktop_windows`, or `mcp__self-desktop__*` for all three) lets it run unasked, an `ask` rule asks each time, and a `deny` rule refuses it. With no rule for it, your permission mode decides; in Manual mode Claude Code shows its permission prompt before the call. That is documented for MCP tools, not seen for these tools.

- **Two kinds of call run with no rules**, as Claude Code's own documentation of `$.tool.call` says: a call another plugin makes through `$.tool.call`, and a script the REPL tool runs (where a session has one). There an `ask` rule asks nobody and a `deny` rule doesn't cover the call. The plugin's own refusals still hold for both: off, a subagent, any argument, not Windows, and everything the script itself refuses.

## Tools

Claude sees each as `mcp__self-desktop__<tool>`. None takes an input: a call with any argument is refused, and nothing is read. Each sits behind ToolSearch. A subagent is refused: the desktop is read for the main session only.

- **`desktop_windows`** lists every top-level window a person could see (visible, not cloaked): its program (the process's image name), its rectangle and its drawn frame in virtual-screen pixels, its monitor, its state (normal, minimized, maximized), which window is in front, and which is this session's own. Each monitor comes with its rectangle, its work area and its DPI, so a rectangle can be judged. The answer is a few lines, then one JSON line per monitor and per window, to copy into a placement file.
  - **A title only for Windows Terminal windows and this session's own window.** Every other window comes with no title at all: a title can carry a mail subject or a document's name. That is a decision, not a default. No window's content is read.
  - **A Windows Terminal window's title, and a tab's name in a read, are text chosen by whatever runs there, another session included.** They come back quoted, as data.
  - `rect` is the window's own rectangle (`GetWindowRect`, with the invisible resize border Windows 10 and 11 add); `frame` is the part drawn on screen (DWM's extended frame bounds). A minimized window has neither.
  - The order is the order Windows lists the windows in: front to back, as far as known. Microsoft's page doesn't promise it, and the answer says so.
- **`desktop_read`** reads this session's own terminal window:
  - its controls as a small tree: role, name, state (disabled, offscreen, focused, selected, checked), bounds, and a reference, the element's UI Automation runtime id. Windows keeps a runtime id for the element's life and may reuse it later. Nothing in this step takes a reference back.
  - **the text showing in this session's own pane**, whoever wrote it ([below](#the-rule-that-shapes-read-and-capture)), read from this session's own console, each line quoted after `| `: its bottom rows, at most 200 of them and 20,000 characters in all. When the pane holds more, the answer says how many rows and characters above were left out.
  - Every control character, format character (the bidi controls, the zero widths, the Unicode tag characters), line separator and paragraph separator in the pane's text, a name or a title is shown as its code, such as `[U+202E]`, so a line can't turn round, hide text, or end early under its `| `. Private-use and other code points no one sees are dropped.
- **`desktop_capture`** saves a picture of this session's own window to a PNG in the plugin's own folder, and answers with the file's path for the session to read: **a classic console window only** ([below](#the-capture)).

Each answer names what it read (the program, and the title where one is allowed), and its first line says what was read: the window and the text in the pane, one of them, or nothing. Read and capture tell you in a toast what they read, by program only, and show no toast when nothing was read. Every answer that carries a window's text or picture says it is data, never instructions, the same as a web page's text.

## The rule that shapes read and capture

> Read and capture never run against another app's window or another session's pane without the owner's word for that occasion. Windows can show credentials and private mail. Their own tests use a window they opened themselves.

This step has no way to give that word, so:

- **Read and capture take no target.** No window handle, process id, title or index reaches them from a call. They act on this session's own terminal window, which they find by themselves, as below. A call that asks for any other window is refused, saying it needs the owner's word and that asking for it isn't built yet.
- **The pane's text comes from this session's own console**, never from the terminal's UI Automation text, which belongs to whichever tab is showing. The tree of a terminal window names only the window, its title bar, its tabs and its buttons, and leaves out the text, the name and the children of every terminal control. The plugin applies that name rule a second time to what its script sends, as it does the title rule, to every tree it reads, a classic console window's included, and passes no tree at all when the script says it didn't find the window. The script's answer never decides which of the plugin's rules hold: the plugin also applies the deny list again to the window's program, and refuses again a picture of a Windows Terminal window, whatever the script sent with it.
- **Nothing is read from a console that a program not this session's own shares.** In the attach, the script lists the processes on the console. It goes on only when each one is this script, the process Claude Code names as its own, an ancestor of that process (its shell above it), or a descendant of it (its children below it), and when none but that process carries its image name, wherever it sits, this script itself aside (another Claude Code process on the console means another session's text may be on the screen). Otherwise the pane, the tree and the picture are all refused, saying which program it found and that nothing was read. Decided on principle: this fails closed, even where it refuses a harmless case, such as a Claude Code that runs as `node.exe` with a `node.exe` child of its own on the console. One session in a Windows Terminal pane passed it, in the one real read made so far ([what ran](#what-ran)); a session started another way may not.
- **The read gives the text showing in the pane this session runs in, whoever wrote it.** Decided on principle: the read says what it is. The rows on screen can have been written by an earlier program or session in this pane, which the check of the processes on the console now can't see. Two cases: a wrapper that starts the next conversation in the same tab, after the first one's `claude` has exited, leaves the first session's last screen in the rows above; and a finished `claude -p` whose output still shows. So every read that returns lines says, beside them, that rows may have been written by an earlier program or session in this pane, and that only the processes on the console now are checked. No answer calls the text this session's own.
- **A picture of a Windows Terminal window isn't built in this step.** Decided on principle: nothing the window's structure shows proves the picture would hold only this session's pane. A zoomed pane takes the other panes out of that structure, and the pane on screen could then be another session's. So the capture of a Windows Terminal window is refused, saying so, and `desktop_read` reads the text showing in this session's own pane.
- **No control's value is read**, anywhere. A password field (UI Automation marks them) is given with no name and no value.

## How it finds this session's own window and pane

Each tool runs one fixed Windows PowerShell script, by its known path, with the script on standard input. The script compiles a small C# helper with `Add-Type` (Windows' own calls have no managed form) and calls it once. The compile starts the C# compiler each call, which costs an estimated one to three seconds a call; that is an estimate, not a measurement.

1. **This session's process.** Claude Code hands each plugin `CLAUDE_PID`, its own process id, through `$.process.hookEnv()` ([its environment-variables reference](https://code.claude.com/docs/en/env-vars): "its own process ID in the subprocesses it spawns"). The plugin takes it only when it is a whole number, and never from a call. The helper then checks that this process is one the script itself runs under, walking up from its own process, each parent older than its child. Without `CLAUDE_PID` (Claude Code before 2.1.214), read and capture refuse and run nothing; the list runs without its own window, and takes no window as this session's own whatever its script answers, so none gets a title for being one.
2. **This session's console.** The helper detaches from its own console and attaches, for a moment, to the console of that process. In that one attach it reads the console's window and the processes on the console, and judges them: who shares the console (above), and whether the console is a pane at all. Only then, for a read, does it read the part of the active screen buffer that shows, through a handle opened for reading only (`CONOUT$` with `GENERIC_READ`). It writes nothing to the console, and detaches in a `finally`.
   - **A session with no console** (an app or an SDK host that starts it with none: the attach fails) reads nothing, and the answer says why.
   - **A console with no window, or a classic console window that is hidden, is no pane**, and nothing is read: a console made without a window is what a tool's command gets (its processes sit on a hidden console of their own), and an app or SDK host can give Claude Code one too. A pseudoconsole's window counts as a pane whoever owns it, so a terminal that isn't Windows Terminal (an editor's) still has the text in its pane read.
3. **This session's window.** Under Windows Terminal, the console's window is a hidden `PseudoConsoleWindow` whose owner is the Windows Terminal window (`CASCADIA_HOSTING_WINDOW_CLASS`, of `WindowsTerminal.exe`) showing this session's tab. In a classic console that is shown, the console's own window (`ConsoleWindowClass`) is the session's window. Anything else (a pseudoconsole window with no owner, or owned by another terminal) is refused, saying which class it found; the text in the pane is still read from the console.

Attaching to the nearest parent process would be wrong: a tool's own shells sit on hidden consoles of their own (120 columns by 9,001 rows), not the session's pane. A check on one machine found the session's own console only by the session's own process id, and its window's owner to be the Windows Terminal window.

## The capture

- **A classic console window only**, of this session's own console, shown, and with no program on that console that is not this session's own. A picture of a Windows Terminal window isn't built in this step ([above](#the-rule-that-shapes-read-and-capture)).
- **The window's own pixels.** The window renders itself into a bitmap the script owns (`PrintWindow`, with its full-content flag). Never the screen, and never what happens to cover the window. Nothing is brought forward.
- **Looked at again once the picture is taken.** If a program that is not this session's own has joined its console meanwhile, or the console is shown by another window, the picture is not kept: the helper deletes it and says whether that worked.
- **A picture that isn't handed back is deleted, and the answer says what became of it.** Every outcome but a picture handed back (a refusal, the second look's, a script that runs out of time or fails, an answer that can't be read, a throw) has the plugin delete the file name it chose for the call. The answer says the picture was deleted only when a delete worked. When neither delete worked, it says the picture couldn't be deleted, gives its path, and says the cleaning removes it at the first call of this plugin's tools, or the first session start, 10 minutes or more after it was taken. When whether a file is there can't be told, it says that, with the same path and the same time.
- **A picture is only the file the call asked for**: exactly the folder and the fresh name the plugin gave the script. An answer naming any other path, even another capture's name in the same folder, is no picture, and the name the call chose is deleted as for any other outcome.
- **Cropped to the drawn frame**, so the PNG is the size the window shows on screen.
- **Refused** for a minimized window (a picture would be empty, and restoring it would act on it) and one that isn't shown (hidden, or on another virtual desktop).
- **Kept on this machine**, in `captures` under the plugin's own data folder (`CLAUDE_PLUGIN_DATA`), named `capture-<a fresh UUID>.png`. The plugin never uploads or sends a picture anywhere.
- **How long a picture lasts:** until the first call of any of this plugin's tools, or the first session start, 10 minutes or more after it was taken. Both delete the captures 10 minutes old or more, whatever the `enabled` setting says, and touch nothing else in the folder: only files named as the plugin names its captures, never a link, and only inside its own captures folder, which the deletion builds itself from the plugin's data folder, so no other folder can be given to it. A picture taken in a session that then ends, with no session started after, stays until one is. Asking for the data folder to clean it makes the folder when it isn't there, so with the plugin off, a session start on Windows can leave an empty data folder behind.
- **Every session of the same user shares that folder**, so for a picture's lifetime another session's file tools can open it. The plugin can't stop a read by the same user.

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

Nothing in the plugin makes input, focuses, activates, moves, resizes, minimizes, restores or closes a window, or changes a control. In UI Automation it reads properties alone and never obtains a pattern object, which is what every action goes through. `scripts/desktop-text.test.mjs` fails when any shipped file of the plugin's hooks names such a call, comments included, or assigns to a console's property, plainly or by a compound assignment; when the helper declares, calls or builds anything outside a reviewed list, uses one listed more often than reviewed, or has a using directive outside its reviewed list (so a type under another name fails); and when a console is opened with any access but `GENERIC_READ`.

**No lease in this step.** Decided on principle: two readers can't clobber each other. A lease comes with the first step that acts.

## Known limits

- **The ancestor check accepts any ancestor.** The process Claude Code names must be one the script runs under, anywhere up its chain, not only its direct parent. Another installed plugin could hook `$.process.hookEnv` and rewrite `CLAUDE_PID` to an ancestor further up, such as another session's process this one was started from. The sharing check then still refuses a console that holds another Claude Code process. What would tighten it: a call through the installed plugin showing that the script is Claude Code's direct child, after which only the direct parent would be accepted. One run did show the check refusing: a script started under a job runner whose own parent process had exited, so that Windows' record of parents no longer led to the session, found no window of the session's own and read nothing.
- **A Claude Code of the other install kind passes the image-name rule.** The rule compares image names, so a `node.exe` Claude Code attached beside a `claude.exe` one, or the other way round, as its ancestor or its descendant, is taken for the session's own shell or child.
- **A process id reused between the console's process list and the snapshot is judged as its new owner.** The two are read one after the other, in the same attach; a process that ends and whose id is given to a new one in between is judged as the new one.
- **A guard that refuses the listing of the plugin's data folder stops the cleaning without a word.** Claude Code leaves where a path may go to `fs.*` hooks, so an `fs.*` hook (an organization's guard, say) that refuses to list the plugin's captures folder stops the cleaning, and a picture can then outlive the 10 minutes the answers promise. The cleaning can't tell that refusal from a folder that isn't there, which is the common case, so it says nothing of either.

## Not built

- Any action: a click, a key, focus, moving or placing a window. If built, it comes in this order: acting on a control by reference, keys into one terminal pane without taking focus, and last synthetic mouse and keyboard at coordinates behind a look, aim, guard and commit loop.
- A way for the owner to give their word for one occasion, so read or capture could reach another window or pane.
- Taking a reference back: no tool takes a runtime id yet, so none says when one has gone stale.
- A picture of a Windows Terminal window. A route for a later step: the count of pseudoconsole windows a terminal window owns, to be measured on real panes first.
- Clearing an earlier session's text from a pane. A route for a later step: the claude wrapper, `claude-launch.ps1` and the slot runner clear the screen and scrollback (`ESC[2J`, `ESC[3J`, `ESC[H`) before they start a different conversation in a pane. It changes other plugins' scripts and the person's scrollback, so it isn't in this plugin.
- A minimized window's restored rectangle, a hosted app's own program behind its frame in the list (a Settings window lists as `ApplicationFrameHost.exe`), and a window's class name in the list.
- Terminals other than Windows Terminal and the classic console (an editor's terminal, other terminal apps): the text in the pane is read, the window isn't found.
- macOS (its accessibility API asks the person's consent per program), Linux, WSL.
- The lease, and a coordinator's say over it.

## Not shown by any run

These rest on the code and on Microsoft's pages, not on a run ([what ran](#what-ran) is below):

- **Any tool called by a session in a Windows Terminal pane, and the plugin installed from the marketplace.** The one session that has called the tools loaded the plugin with `--plugin-dir` and ran in a pseudoconsole of another program's ([what ran](#what-ran)). So these are not shown: that `desktop_capture` in a Windows Terminal pane answers its refusal; that the script is Claude Code's direct child there; that a call the person allows in the permission dialog is then served (the one dialog seen was left unanswered); and that the cleaning lists the plugin's data folder on a machine with the person's own `fs.*` hooks, where one that refuses the listing stops it without a word ([Known limits](#known-limits)).
- **The capture's own route, past its first refusal.** The live tests take a picture of a plain form of their own, by its handle, which holds its own colour. The route a tool takes has run once, and stopped before any picture: the session's window was not found ([what ran](#what-ran)). So these have never run for real: the look at who shares the console before the picture, the second look after it, and the deletion of a picture not kept. Nor is it shown that `PrintWindow` with the full-content flag renders a classic console window as it shows (the flag is in Windows' header from 8.1 and left out of Microsoft's page).
- **A refusal on a real console.** That the sharing check refuses a real console a program not the session's own shares, and that a real console with no window is taken as no pane, rest on the fixed-value rows alone; the two real reads each passed that check. (Two refusals have happened for real: the ancestor check refused once, and a pseudoconsole whose window names no owner was reported as no window found: [what ran](#what-ran).)
- **Elevated windows.** What the section above says of them rests on Microsoft's page alone.
- **A session in a classic console, an editor's terminal, an app or an SDK host.** Which processes such a session leaves on its console, and whether the sharing check passes there, is not shown. One session outside Windows Terminal has run, in a pseudoconsole a Node program made: its pane was read there, which the sharing check comes before ([what ran](#what-ran)).
- **Which sign marks a terminal control.** The one real read marked 3 terminal controls in a Windows Terminal window and gave none a name; whether the class name `TermControl` or the control's text matched was not recorded.
- **Mixed DPI.** The live tests found each control's bounds where the form itself said they were, on one machine's monitors; that UI Automation gives a per-monitor-aware thread physical pixels on monitors of different scaling is not shown.
- **A real window handle with bit 31 set.** The fixed-value rows show the arithmetic (printed as its lower 32 bits, made again sign-extended, which Microsoft's [Interprocess communication](https://learn.microsoft.com/en-us/windows/win32/winprog64/interprocess-communication) page says is safe); no such handle has met it.
- That a link in the captures folder lists as the engine's types say (kind `other`, with `isLink`); the cleaning skips one by either.
- Wide characters (East Asian, emoji) in the pane: how a cell holding half of one reads.

The plugin runs Windows PowerShell 5.1 by its known path, never PowerShell 7, so nothing of it depends on 7.

## Tests

- `tests/self-desktop.test.ts`: the tool layer with the machine stood in. Off by default and the words; not Windows; a subagent; every kind of argument refused with nothing run; a call Claude Code's permission check refuses runs no script; the serving at `tool.run`, raised on its own, refusing a subagent and the setting off again; the scripts read and capture run act on `CLAUDE_PID` alone, never a window by its handle; a process id of any other shape, with the list taking no window as this session's own; a process id or a handle of any other shape building no script; old captures deleted at a call and at a session's start, with the plugin off, nothing else in the folder touched, no link; the title rule and the name rule held whatever a script sends; the read's quoting, the hidden characters shown, the sentence beside the lines on who wrote them, the pane's limits, what it leaves out, and its first line and toast for each of what was read; no console, a console with no window, and a shared console, each reading nothing; the capture's file, its folder, its lifetime, a Windows Terminal window refused as not built, a console changed during the picture with each way its deletion can go, a timeout, an unreadable answer, a failed script and a failed deletion, each deleting the name it chose and saying what became of it; an answer naming any file but the one chosen, even another capture's name in the same folder, taken as no picture; the deny list; failures; the helper's text (read-only console handle, one attach and its detach in a `finally`, the pane read only once the console is judged a pane of this session's own, an element's name read in one place behind the naming rule, the look after the picture through its own decision, titles only where allowed, no pattern object, no structure count, its limits equal to the answers').
- `scripts/desktop-text.test.mjs`: nothing in the shipped hooks acts, each kind of fault planted on a line of its own and found on that line, and the helper as shipped holding none (a console setting in C# as well as in PowerShell, by a plain or a compound assignment, included); every use the helper makes held to a reviewed count (each extern declaration, however its attribute is spelled, with its call sites; each qualified call; each type built; each using directive, so an alias of a type fails), a new one or another use of one reviewed failing on its own line; every console opened with `GENERIC_READ` by name; each serving at `tool.run` refusing again; the PowerShell plumbing equal to the shared machine code's; on Windows, every script parses, the helper compiles under `Add-Type`, and its pure rules (the ancestor check, a reused id, who may share the console, whether a console is a pane, which window is the session's own, which names a tree gives, how much of a pane is kept, the deny list, whether a picture is taken, whether a picture taken is kept) give the right answers for fixed values, with no window read and no console attached to.
- `scripts/desktop-live.test.mjs`, **Windows only, and only with `SELF_DESKTOP_LIVE=1`**, since each test puts a window of its own on the screen for a few seconds: a plain form shown without taking the focus, with a title made at run time, a text box, a password box whose value is made at run time, a button and two tabs, closed in a `finally`. It shows that the list finds it with its rectangle and monitor and no title; that the tree holds the text box and the button with their names and bounds, and the password box with no name, and that no value of either box is read; that the capture is a PNG of the drawn frame's size holding the form's own colour; and that nothing moved or activated it, or changed the window in front. On a pseudoconsole of the test's own, it shows that the tools' own read script reads the characters, the alternate screen while it is up, and the main screen after the reads exactly as the test wrote it.

## What ran

Each run names the commit it was on. `480b4e3` is the last commit that changes code or tests; what follows it changes these words only.

- **Linux (a cloud machine, Node 22, Claude Code 2.1.332), the repository's whole list (`scripts/test-all.mjs`, 37 steps), on `480b4e3`:**
  - `claude plugin validate plugins/self-desktop --strict` says "Validation passed".
  - `claude plugin test plugins/self-desktop` passes 75 of 75.
  - The script tests count 346: 296 pass, 49 are skipped (nearly all for want of Windows, this plugin's Windows-only tests among them), and 1 fails that is not this plugin's (`readPlacement…`, which fails there on `main` too).
  - Eight of the 37 steps fail there: the same eight, with the same failing tests, as in a run of `main`'s own files on the same kind of machine (that one on Claude Code 2.1.331).
- **Windows 11 (Windows PowerShell 5.1, Node 26, Claude Code 2.1.332), each once on the commit named:**
  - `node --test scripts/desktop-text.test.mjs` on `480b4e3`: 10 of 10. Every script parses in Windows PowerShell, the helper compiles under `Add-Type`, and its pure rules answer for every fixed-value row.
  - `claude plugin test plugins/self-desktop` on `01d1a69`: 75 of 75. The four commits after it change the text test's table and two comments in the helper.
  - `SELF_DESKTOP_LIVE=1 node --test scripts/desktop-live.test.mjs` on `480b4e3`: 5 of 5, in 17 seconds.
  - **One real read**, on `480b4e3`: the list script and the read script, run once from a session's own shell against that session's own Windows Terminal window and pane.
    - The list found and marked the session's own window, and gave a title to the Windows Terminal windows and to no other window.
    - The read gave the text showing in the pane (33 lines) with the sentence on who may have written the rows, and the window's controls: 22, of which 10 carry a name, each a window, title bar, tab, tab item or button; 3 terminal controls, none with a name.
    - What it read stays on that machine.
- **After the merge, on `main` (`daacca6`): two runs, each once, of a throwaway session that loaded the plugin with `--plugin-dir`** (not installed from the marketplace) and turned it on through `--settings`. Windows 11, Claude Code 2.1.332. The session ran in a pseudoconsole a Node program made, 200 columns by 60 rows, outside Windows Terminal.
  - **The first, in auto mode:** the model's call to `desktop_windows` was allowed with no dialog and served. The list reports the session's own window as not found, saying why (a pseudoconsole whose window names no owner), and marks no window as its own. A title came for the Windows Terminal windows and for no other window.
  - **The second, in manual mode, with `desktop_read` and `desktop_capture` allowed by flag:**
    - `desktop_read` was served. It gave the text showing in the pane (18 lines) with the sentence on who may have written the rows, and no controls, the window not being found. The toast telling the person what was read appeared.
    - `desktop_capture` was served. It refused for the same reason, and no picture was left.
    - The model's call to `desktop_windows`, not allowed by flag, brought Claude Code's permission dialog. Nothing was answered, and the tool did not run.
    - **The cleaning:** at the session's start it deleted a file with a capture's name written 11 minutes before, and kept one written seconds before and a file with another name.
  - What the tools read stays on that machine.
- **Two runs that failed first, and why:**
  - The text test's first Windows run, on `01d1a69`, failed 1 of 10. Its table handed the helper `$null` for a string, which Windows PowerShell passes to a .NET method as an empty string. The table was wrong, not the helper; `480b4e3` has it right.
  - The first try at the real read ran under a job runner whose own parent process had exited, so Windows' record of parents no longer led from the script to the session. The helper's ancestor check refused it: no window of the session's own was found and nothing was read.

## Update check

As every self tool's: when Claude calls one of this plugin's tools, at most every 30 minutes, it fetches this plugin's published [`plugin.json`](https://raw.githubusercontent.com/moefingers/claude-code-self-tools/main/plugins/self-desktop/.claude-plugin/plugin.json) (a plain GET of a public file) and, when a newer version is out, a toast and one tool answer say so, with the update steps for you to run. It rides on the off answer too. Turn it off with the `updateCheck` setting (`off`); it is also off while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-desktop@claude-code-self-tools
```

Then turn it on ([above](#turn-it-on)).
