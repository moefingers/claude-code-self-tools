// self-desktop as text: what can be shown from the text its code ships, without reading a window. Run with
// `node --test "scripts/*.test.mjs"`.
// - Nothing acts: no file of the plugin's hooks names a call that makes input, reads keys or the clipboard, brings a
//   window forward, moves, sizes, shows, hides or closes one, reads the screen rather than one window, writes to a
//   console or sets its state (in PowerShell or in C#, by a plain or a compound assignment), changes a control, changes
//   the system, or starts or ends a process. Each kind of fault, planted on a line of its own in a copy of the helper,
//   is found on that line, and the unplanted text has none. Comments count: a shipped file doesn't name one even to say
//   it isn't used.
// - The helper's every use is held to a reviewed count: each static extern declaration (however its attribute is
//   written, and its call sites), each qualified .NET call, each type it builds, each using directive (so a type under
//   another name fails). A new one, or another use of one listed, fails here until it is reviewed. Every CreateFileW
//   call passes GENERIC_READ, by name, as its access.
// - The serving at tool.run refuses a subagent and the setting off again, in each of the three handlers.
// - Its few lines of PowerShell plumbing are the shared machine code's, so a fix there is seen here.
// - On Windows: every script it builds parses in Windows PowerShell with no error; the helper compiles under Add-Type;
//   and its pure rules (the ancestor check, who may share the console, whether a console is a pane, which window is the
//   session's own, which names a tree gives, how much of a pane is kept, the deny list, whether a picture is taken,
//   whether a picture taken is kept) give the answers below for fixed values. That runs PowerShell and the C# compiler
//   and calls only those pure rules: no window is read and no console is attached to.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { ROOT } from './sync-shared.mjs'

const desktop = await import(pathToFileURL(join(ROOT, 'plugins', 'self-desktop', 'hooks', 'desktop.ts')).href)
const machine = await import(pathToFileURL(join(ROOT, 'shared', 'hooks', 'machine.ts')).href)
const HOOKS = join(ROOT, 'plugins', 'self-desktop', 'hooks')
const isWindows = process.platform === 'win32'
const ON_WINDOWS = isWindows ? false : 'Windows PowerShell runs on Windows only'
const POWERSHELL = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

/** What would act, by kind: each pattern a name or a shape no shipped file of the plugin may hold. */
const ACTS = [
  [
    'a Windows call that acts on a window',
    /\b(?:SetWindowPos|DeferWindowPos|BeginDeferWindowPos|EndDeferWindowPos|MoveWindow|ShowWindow|SetForegroundWindow|BringWindowToTop|SetActiveWindow|SetFocus|SetWindowPlacement|CloseWindow|DestroyWindow|EndTask|SwitchToThisWindow|AllowSetForegroundWindow|LockSetForegroundWindow|SetParent|SetWindowLong|SetLayeredWindowAttributes|FlashWindow|EnableWindow|SetWindowText|AnimateWindow|DwmSetWindowAttribute|SetWindowRgn|SetWindowDisplayAffinity|SetCapture|OpenIcon|TileWindows|CascadeWindows|ArrangeIconicWindows|SetMenu|UpdateLayeredWindow)/,
  ],
  ['a message sent or posted to a window', /\b(?:PostMessage|SendMessage|SendNotifyMessage|SendMessageTimeout|PostThreadMessage|BroadcastSystemMessage)/],
  ['input made up, or keys read', /\b(?:SendInput|keybd_event|mouse_event|SetCursorPos|BlockInput|ClipCursor|AttachThreadInput|SendKeys|AppActivate|SendWait|SetWindowsHookEx|GetAsyncKeyState|GetKeyState|GetKeyboardState|RegisterHotKey|RegisterRawInputDevices)/],
  ['the clipboard', /\b(?:OpenClipboard|GetClipboardData|SetClipboardData|EmptyClipboard)|\bClipboard\.|Get-Clipboard|Set-Clipboard/],
  ['the screen read rather than one window', /\b(?:CopyFromScreen|BitBlt|StretchBlt|GetDCEx|GetWindowDC|CreateDC|DwmRegisterThumbnail|GraphicsCaptureItem|IDXGIOutputDuplication|DuplicateOutput)|\bGetDC\(/],
  ['a write to a console, or a change of its state', /\b(?:WriteConsole|WriteFile|FillConsoleOutput|SetConsole|ScrollConsoleScreenBuffer|GenerateConsoleCtrlEvent|AllocConsole|SetStdHandle|SetCurrentConsoleFont)/],
  ["a read of a console's input, which takes keys from the person", /\b(?:ReadConsoleInput|PeekConsoleInput|FlushConsoleInputBuffer|ReadConsoleW?\b)|CONIN\$/],
  ['a console handle opened for writing', /GENERIC_WRITE|GENERIC_ALL|0x40000000|0xC0000000|0x10000000|3221225472|1073741824|268435456/i],
  [
    'a console setting, from PowerShell or from C#',
    // An assignment, plain or compound (+=, -=, ??=, <<= and the rest), to a Console property: PowerShell's [Console]::X,
    // and C#'s Console.X however it is spaced.
    /\[Console\]::(?:OutputEncoding|InputEncoding|Title|CursorLeft|CursorTop|CursorVisible|BackgroundColor|ForegroundColor|WindowWidth|WindowHeight|BufferWidth|BufferHeight|TreatControlCAsInput)\s*(?:\?\?|[-+*/%])?=|RawUI|Write-Host|Clear-Host|\bConsole\s*\.\s*\w+\s*(?:<<|>>|\?\?|[-+*/%&|^])?=(?!=)/,
  ],
  [
    'a UI Automation pattern object, or a method that acts',
    /\b(?:GetCurrentPattern|TryGetCurrentPattern|GetCachedPattern|TryGetCachedPattern|InvokePattern|ValuePattern|WindowPattern|TransformPattern|ScrollItemPattern|ScrollPattern|ExpandCollapsePattern|LegacyIAccessiblePattern|TextPattern\b|TogglePattern\b|SelectionItemPattern\b|DoDefaultAction|ScrollIntoView|SetWindowVisualState|AddToSelection|RemoveFromSelection)|\.(?:Invoke|Toggle|Select|Expand|Collapse|Realize|SetValue|Move|Resize|Rotate|SetView|Close|Kill|SetFocus)\(/,
  ],
  ['a change of the system', /\b(?:SystemParametersInfo|LockWorkStation|ExitWindowsEx|InitiateSystemShutdown|ChangeDisplaySettings|SetSystemCursor)/],
  ['a process started or ended', /Stop-Process|taskkill|Start-Process|ShellExecute|CreateProcess|WinExec|TerminateProcess|Invoke-Expression|\biex\b|Process\]::Start\(|Process\.Start\(|\bwt\.exe|Invoke-Item|\bcmd\.exe|\.Kill\(|CloseMainWindow/i],
]

// The reviewed counts. Each entry is a use the helper makes, reviewed as a read, or as an act on this script's own
// process, thread, bitmap or capture file alone (FreeConsole and AttachConsole move this process; SetThreadDpiAwareness-
// Context sets this thread; PrintWindow has a window render itself into this process's bitmap; Directory.CreateDirectory,
// part.Save, File.Delete and File.Exists touch only the plugin's own capture). When a count moves, or a new entry shows,
// the test fails. A reviewer then reads each new use in the diff, checks it reads, or acts only on the script's own
// process, thread, bitmap or capture file, and only then sets the count here, in the same commit, saying so in its
// message. A use that acts on anything else is refused, not counted.

/** Each static extern declaration (dll!entry, `as` the name it is called by when that differs), by its call sites. */
const REVIEWED_IMPORTS = {
  'dwmapi.dll!DwmGetWindowAttribute': 1,
  'dwmapi.dll!DwmGetWindowAttribute as DwmGetWindowAttributeInt': 1,
  'kernel32.dll!AttachConsole': 1,
  'kernel32.dll!CloseHandle': 2,
  'kernel32.dll!CreateFileW': 1,
  'kernel32.dll!CreateToolhelp32Snapshot': 1,
  'kernel32.dll!FreeConsole': 2,
  'kernel32.dll!GetConsoleProcessList': 2,
  'kernel32.dll!GetConsoleScreenBufferInfo': 1,
  'kernel32.dll!GetConsoleWindow': 1,
  'kernel32.dll!Process32FirstW': 1,
  'kernel32.dll!Process32NextW': 1,
  'kernel32.dll!ReadConsoleOutputCharacterW': 1,
  'shcore.dll!GetDpiForMonitor': 1,
  'user32.dll!EnumChildWindows': 1,
  'user32.dll!EnumDisplayMonitors': 1,
  'user32.dll!EnumWindows': 1,
  'user32.dll!GetClassNameW': 1,
  'user32.dll!GetForegroundWindow': 1,
  'user32.dll!GetMonitorInfoW': 1,
  'user32.dll!GetWindow': 1,
  'user32.dll!GetWindowRect': 2,
  'user32.dll!GetWindowTextW': 1,
  'user32.dll!GetWindowThreadProcessId': 1,
  'user32.dll!IsIconic': 2,
  'user32.dll!IsWindow': 2,
  'user32.dll!IsWindowVisible': 3,
  'user32.dll!IsZoomed': 1,
  'user32.dll!MonitorFromWindow': 1,
  'user32.dll!PrintWindow': 1,
  'user32.dll!SetThreadDpiAwarenessContext': 10,
}

/** Each qualified .NET call, by its uses. */
const REVIEWED_CALLS = {
  'Array.Copy': 1, 'Array.IndexOf': 1, 'AutomationElement.FromHandle': 1, 'CAPTURE_NAME.IsMatch': 1, 'Columns.ToString': 1, 'CutChars.ToString': 1,
  'CutRows.ToString': 1, 'Directory.CreateDirectory': 1, 'Dpi.ToString': 1, 'File.Delete': 1, 'File.Exists': 1, 'GC.KeepAlive': 3,
  'Graphics.FromImage': 1, 'Height.ToString': 1, 'Marshal.GetLastWin32Error': 4, 'Marshal.SizeOf': 4, 'Math.Min': 3, 'Math.Round': 4,
  'Path.Combine': 1, 'Path.IsPathRooted': 1, 'Process.GetCurrentProcess': 1, 'Process.GetProcessById': 1, 'ProgrammaticName.Replace': 1,
  'Rectangle.Intersect': 1, 'Rows.ToString': 1, 'StartTime.ToUniversalTime': 1, 'Width.ToString': 1, 'Window.ToInt64': 2, 'all.TryGetValue': 2,
  'b.Append': 4, 'depth.ToString': 1, 'double.IsInfinity': 2, 'double.IsNaN': 1, 'element.GetCurrentPropertyValue': 1, 'element.GetRuntimeId': 1,
  'fields.Add': 22, 'fields.ToArray': 1, 'found.Add': 1, 'graphics.GetHdc': 1, 'graphics.ReleaseHdc': 1,
  'ids.Add': 1, 'ids.Contains': 1, 'ids.ToArray': 1, 'lines.Add': 1, 'lines.ToArray': 1, 'listed.Add': 1, 'listed.ToArray': 1, 'monitors.Add': 1,
  'monitors.ToArray': 1, 'name.ToString': 1, 'nodes.Add': 1, 'nodes.ToArray': 1, 'part.Save': 1, 'part.ToString': 1, 'parts.Add': 1,
  'parts.ToArray': 1, 'programs.Add': 2, 'programs.ToArray': 1, 'roots.Add': 2, 'roots.AddRange': 1, 'roots.ToArray': 1, 'rows.Add': 1,
  'rows.GetRange': 1, 'string.Equals': 4, 'string.Join': 7, 'text.Substring': 1, 'text.ToString': 1, 'walker.GetFirstChild': 1,
  'walker.GetNextSibling': 1, 'whole.Clone': 1, 'window.ToInt64': 1, 'windows.Add': 1,
}

/** Each type the helper builds, by its uses: its own records, collections, strings, a bitmap of its own, rectangles. */
const REVIEWED_BUILT = {
  Bitmap: 1, Box: 1, Dictionary: 1, IntPtr: 3, List: 13, MonitorInfo: 1, Own: 1, Pane: 1, ProcessEntry: 1, Rectangle: 2, Regex: 1, Screen: 1,
  Shot: 1, StringBuilder: 3, Table: 1, char: 1, int: 1, long: 1, string: 2, uint: 5,
}

/**
 * Each using directive the helper has, by what follows `using` (whitespace made single), by its uses. A directive can
 * name a type under another name (`using C = System.Console;`) or bring in a type's members (`using static ...`), and a
 * use of either would pass the patterns and the call list unseen, so a directive not here fails until it is reviewed.
 */
const REVIEWED_USINGS = {
  System: 1,
  'System.Collections.Generic': 1,
  'System.Diagnostics': 1,
  'System.Drawing': 1,
  'System.Drawing.Imaging': 1,
  'System.IO': 1,
  'System.Runtime.InteropServices': 1,
  'System.Text': 1,
  'System.Text.RegularExpressions': 1,
  'System.Windows.Automation': 1,
}

/**
 * A using directive (not a using statement, whose `using` a parenthesis follows), across line breaks too: C# lets a
 * directive run over several lines, so `using C =` with `System.Console;` on the next line is one directive.
 */
const USING = /\busing\s+(?!\()([^;{}()]*);/g

/** A C# extern declaration's start: `static extern` or `extern static`, whatever its attribute is spelled like. */
const EXTERN = /\b(?:static\s+extern|extern\s+static)\b/g

/**
 * Every use the helper's text makes, each with its line: the static extern declarations (dll!entry, `as` the name it is
 * called by) with their call sites; the qualified calls; the types built. And how many times `extern` appears at all,
 * so a declaration this can't read can't pass unseen.
 */
function helperUses(cs) {
  const lineOf = at => cs.slice(0, at).split('\n').length
  const imports = []
  for (const m of cs.matchAll(EXTERN)) {
    const start = Math.max(cs.lastIndexOf(';', m.index), cs.lastIndexOf('{', m.index), cs.lastIndexOf('}', m.index)) + 1
    const end = cs.indexOf(';', m.index) + 1
    const declaration = cs.slice(start, end)
    const dll = /"([^"]+?\.dll)"/i.exec(declaration)?.[1] ?? '?'
    const name = /\b(?:static\s+extern|extern\s+static)\s+[\w.<>[\], ]+?\s+(\w+)\s*\(/.exec(declaration)?.[1] ?? '?'
    const entry = /EntryPoint\s*=\s*"([^"]+)"/.exec(declaration)?.[1] ?? name
    const sites = [...cs.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))].filter(c => c.index < start || c.index >= end).map(c => lineOf(c.index))
    imports.push({ key: `${dll}!${entry}${entry === name ? '' : ` as ${name}`}`, declared: lineOf(m.index), lines: sites })
  }
  const calls = [...cs.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Z][A-Za-z0-9]*)\s*\(/g)].map(m => ({ key: `${m[1]}.${m[2]}`, line: lineOf(m.index) }))
  const built = [...cs.matchAll(/\bnew\s+([A-Za-z_][A-Za-z0-9_.]*)/g)].map(m => ({ key: m[1], line: lineOf(m.index) }))
  const usings = [...cs.matchAll(USING)].map(m => ({ key: m[1].replace(/\s+/g, ' ').trim(), line: lineOf(m.index) }))
  return { imports, calls, built, usings, externs: [...cs.matchAll(/\bextern\b/g)].length }
}

/** The helper's uses, counted as the reviewed lists count them. */
function counted(cs) {
  const uses = helperUses(cs)
  const tally = list => {
    const out = {}
    for (const u of list) out[u.key] = (out[u.key] ?? 0) + 1
    return out
  }
  return {
    imports: Object.fromEntries(uses.imports.map(i => [i.key, i.lines.length])),
    calls: tally(uses.calls),
    built: tally(uses.built),
    usings: tally(uses.usings),
    externs: uses.externs,
    declared: uses.imports.length,
  }
}

/** What in `cs` differs from the reviewed counts, with the lines each differing entry is used on. */
function unreviewed(cs) {
  const uses = helperUses(cs)
  const counts = counted(cs)
  const found = []
  for (const [list, reviewed, entries] of [
    [counts.imports, REVIEWED_IMPORTS, uses.imports.map(i => ({ key: i.key, lines: [i.declared, ...i.lines] }))],
    [counts.calls, REVIEWED_CALLS, uses.calls.map(c => ({ key: c.key, lines: [c.line] }))],
    [counts.built, REVIEWED_BUILT, uses.built.map(b => ({ key: b.key, lines: [b.line] }))],
    [counts.usings, REVIEWED_USINGS, uses.usings.map(u => ({ key: u.key, lines: [u.line] }))],
  ]) {
    for (const key of new Set([...Object.keys(list), ...Object.keys(reviewed)])) {
      if (list[key] !== reviewed[key]) found.push({ key, lines: entries.filter(e => e.key === key).flatMap(e => e.lines) })
    }
  }
  if (counts.externs !== counts.declared) found.push({ key: 'an extern this test cannot read', lines: [] })
  return found
}

/** The access argument of each CreateFileW call in `cs` (not its declaration), with its line. */
function createFileAccess(cs) {
  const lineOf = at => cs.slice(0, at).split('\n').length
  return [...cs.matchAll(/\bCreateFileW\s*\(/g)]
    .filter(m => !/\bextern\b/.test(cs.slice(cs.lastIndexOf('\n', m.index), m.index)))
    .map(m => {
      const args = cs.slice(m.index + m[0].length, cs.indexOf(')', m.index)).split(',')
      return { access: (args[1] ?? '').trim(), line: lineOf(m.index) }
    })
}

/** The shipped files of the plugin's hooks, every one: the module, its helper's text, the shared copies, hooks.json. */
const hookFiles = dir => readdirSync(dir).map(name => join(dir, name)).filter(path => statSync(path).isFile())

/** What a file's text names that would act, as { line, what }, one per kind and line. */
function acting(text) {
  const found = []
  for (const [what, pattern] of ACTS) {
    for (const [i, line] of text.split('\n').entries()) if (pattern.test(line)) found.push({ line: i + 1, what, text: line.trim().slice(0, 160) })
  }
  return found
}

/** The helper with `plant` on a line of its own after its class's opening line, and that line's number. */
function planted(plant) {
  const lines = desktop.HELPER_CS.split('\n')
  const at = lines.indexOf('public static class SelfDesktop {')
  assert.ok(at >= 0, 'the place to plant is found')
  return { text: [...lines.slice(0, at + 1), `  ${plant}`, ...lines.slice(at + 1)].join('\n'), line: at + 2 }
}

test("nothing in the plugin's shipped hooks acts: no input, no keys or clipboard read, no window brought forward, moved, sized, shown, hidden or closed, no screen read, no console written to or set, no control changed, no system change, no process started or ended", () => {
  const files = hookFiles(HOOKS)
  assert.ok(files.some(f => f.endsWith('desktop.ts')) && files.some(f => f.endsWith('register.ts')), 'the hooks were found')
  const found = files.flatMap(path => acting(readFileSync(path, 'utf8')).map(f => `${path}:${f.line}: ${f.what}: ${f.text}`))
  assert.deepEqual(found, [])
})

test('each kind of acting call, planted on a line of its own in a copy of the helper, is found on that line, and the unplanted helper has none', () => {
  assert.deepEqual(acting(desktop.HELPER_CS), [], 'the helper as shipped names nothing that acts')
  const plants = [
    'SetForegroundWindow(window);',
    'ShowWindow(window, 9);',
    'SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, 0);',
    'DeferWindowPos(positions, window, IntPtr.Zero, 0, 0, 0, 0, 0);',
    'PostMessage(window, 16, IntPtr.Zero, IntPtr.Zero);',
    'SendMessage(window, 16, IntPtr.Zero, IntPtr.Zero);',
    'SendInput(1, inputs, 40);',
    'keybd_event(13, 0, 0, UIntPtr.Zero);',
    'mouse_event(2, 0, 0, 0, UIntPtr.Zero);',
    'SetWindowsHookEx(13, hook, IntPtr.Zero, 0);',
    'GetAsyncKeyState(16);',
    'OpenClipboard(IntPtr.Zero);',
    'string copied = Clipboard.GetText();',
    'graphics.CopyFromScreen(0, 0, 0, 0, size);',
    'BitBlt(dc, 0, 0, width, height, screen, 0, 0, 13369376);',
    'IntPtr screen = GetDC(IntPtr.Zero);',
    'WriteConsoleW(output, text, 1, out written, IntPtr.Zero);',
    'SetConsoleOutputCP(65001);',
    'ReadConsoleInputW(input, records, 1, out read);',
    'CreateFileW("CONOUT$", 0x40000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);',
    'CreateFileW("CONOUT$", 1073741824, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);',
    'CreateFileW("CONOUT$", 0x10000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Console.Title = "x";',
    'Console.OutputEncoding = Encoding.UTF8;',
    'System.Console . CursorVisible = false;',
    'Console.Title += " (read)";',
    'Console.CursorLeft -= 1;',
    'Console.Title ??= "x";',
    '[Console]::Title += \' (read)\'',
    'object pattern = element.GetCurrentPattern(InvokePattern.Pattern);',
    'element.SetFocus();',
    '((InvokePattern)pattern).Invoke();',
    'SystemParametersInfo(20, 0, path, 3);',
    'LockWorkStation();',
    'CreateProcessW(null, line, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref info, out process);',
    'WinExec("x", 0);',
    'TerminateProcess(handle, 1);',
    'Invoke-Expression $text',
    'Stop-Process -Id 1',
    'Start-Process wt.exe',
  ]
  for (const plant of plants) {
    const copy = planted(plant)
    const found = acting(copy.text)
    assert.ok(found.length > 0, `the scan finds: ${plant}`)
    assert.deepEqual([...new Set(found.map(f => f.line))], [copy.line], `the scan finds ${plant} on its own line, and nowhere else`)
  }
})

test('the helper makes exactly the uses reviewed, by count: each extern declaration and its call sites, each qualified call, each type built, each using directive', () => {
  assert.deepEqual(unreviewed(desktop.HELPER_CS), [])
  const counts = counted(desktop.HELPER_CS)
  assert.equal(counts.externs, counts.declared, 'every extern is a declaration this test reads')
})

test('a new entry point however its attribute is spelled, another use of one reviewed, or a using directive not reviewed (an alias of a type among them), fails the counts on its own line', () => {
  const plants = [
    // A new import, with a space before its attribute's parenthesis, and with its modifiers the other way round.
    '[DllImport ("user32.dll")] static extern bool ShowOwnedPopups(IntPtr window, bool show);',
    '[System.Runtime.InteropServices.DllImport("user32.dll")] extern static bool ShowOwnedPopups(IntPtr window, bool show);',
    // Another call of an import reviewed, and another use of a .NET call and of a type reviewed.
    'IntPtr other = CreateFileW("CONOUT$", GENERIC_READ, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);',
    'static void Again(string path) { File.Delete(path); }',
    'static void Folder(string path) { Directory.CreateDirectory(path); }',
    'static Bitmap Another() { return new Bitmap(1, 1); }',
    // A screen read through a call not reviewed.
    'static void Screen2(Graphics graphics) { graphics.CopyFromScreen(0, 0, 0, 0, new Size(1, 1)); }',
    // A type under another name, and a type's members brought in: each a using directive not reviewed.
    'using Con = System.Console;',
    'using static System.Console;',
    'using   Forms =  System.Windows.Forms ;',
    // A directive split over two lines: the alias on the next line. It is found on the line it starts on.
    'using SysCon =\n    System.Console;',
  ]
  for (const plant of plants) {
    const copy = planted(plant)
    const found = unreviewed(copy.text)
    assert.ok(found.length > 0, `the counts catch: ${plant}`)
    assert.ok(found.every(f => f.lines.includes(copy.line)), `each entry it moves is used on the planted line: ${plant} (${JSON.stringify(found)})`)
  }
})

test('every CreateFileW call in the helper opens for reading only: GENERIC_READ by name, defined once as 0x80000000; a number in its place fails', () => {
  const calls = createFileAccess(desktop.HELPER_CS)
  assert.ok(calls.length > 0, 'the calls were found')
  assert.deepEqual([...new Set(calls.map(c => c.access))], ['GENERIC_READ'])
  assert.equal((desktop.HELPER_CS.match(/\bGENERIC_READ\s*=(?!=)/g) ?? []).length, 1, 'GENERIC_READ is defined once')
  assert.ok(desktop.HELPER_CS.includes('const uint GENERIC_READ = 0x80000000;'))
  for (const access of ['1073741824', '0x10000000', '0x80000000', 'GENERIC_READ | 0x40000000', '(uint)-1']) {
    const copy = planted(`IntPtr other = CreateFileW("CONOUT$", ${access}, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);`)
    const bad = createFileAccess(copy.text).filter(c => c.access !== 'GENERIC_READ')
    assert.deepEqual(bad.map(c => c.line), [copy.line], `CreateFileW with ${access} is found on its own line`)
  }
})

test('each of the three servings at tool.run refuses a subagent and the setting off again before anything runs', () => {
  const register = readFileSync(join(HOOKS, 'register.ts'), 'utf8')
  const servings = [...register.matchAll(/on\('tool\.run', \{ tool: (\w+) \}, async \(\$, e\) => \{\s*const refused = servingRefusal\(e\.agentId, enabled\)\s*return withUpdateNotice\(\$, e, refused \?\? \{ result: await \w+\(\$\) \}\)/g)].map(m => m[1])
  assert.deepEqual(servings, ['LIST_TOOL', 'READ_TOOL', 'CAPTURE_TOOL'])
  assert.equal([...register.matchAll(/on\('tool\.run'/g)].length, 3, 'no other serving')
})

test("the plugin's PowerShell plumbing is the shared machine code's: the bootstrap, the call, the module path, the Windows folder, the folder check", () => {
  assert.equal(desktop.STDIN_BOOTSTRAP, machine.STDIN_BOOTSTRAP)
  assert.equal(desktop.PSMODULEPATH_RESET, machine.PSMODULEPATH_RESET)
  assert.equal(desktop.SYSTEM_ROOT.source, machine.SYSTEM_ROOT.source)
  assert.equal(desktop.powershellPath('C:\\Windows'), machine.powershellPath('C:\\Windows'))
  const script = "Write-Output 'a ' + \u2019b\u2019\r\n$x = 1"
  assert.deepEqual(desktop.powershellCall('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', script), machine.powershellCall('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', script))
  assert.equal(desktop.literal("it's \u2018here\u2019"), `'${machine.psQuote("it's \u2018here\u2019")}'`)
  for (const path of ['C:\\path\\to\\work', 'C:\\path\\to\\work\\', 'C:\\a\\..\\b', 'C:\\a\\.\\b', "C:\\a'b", 'C:/a', 'a\\b', 'C:\\a\\ b', `C:\\${'x'.repeat(240)}`, 'C:\\a:b', 'C:\\a\u0007']) {
    assert.equal(desktop.isSafeFolder(path), machine.isSafeFolder(path), path)
  }
})

/** Every script the plugin builds, by name: the tools', the cleaning's, and the live tests' own. */
function scripts() {
  const data = 'C:\\path\\to\\data'
  const file = { folder: desktop.capturesFolder(data), name: 'capture-0b6f3a52-1c2d-4e5f-8a9b-0c1d2e3f4a5b.png' }
  return {
    'list, own window': desktop.listScript(4242),
    'list, no own window': desktop.listScript(undefined),
    'read, own window': desktop.readScript({ own: 4242 }),
    'read, a test window': desktop.readScript({ window: 777 }),
    'capture, own window': desktop.captureScript({ own: 4242 }, file),
    'capture, a test window': desktop.captureScript({ window: 777 }, file),
    'deletion of captures': desktop.deleteScript(data, [file.name]),
  }
}

test('every script parses in Windows PowerShell with no error', { skip: ON_WINDOWS }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'self-desktop-parse-'))
  try {
    const named = Object.entries(scripts()).map(([name, text], i) => {
      const path = join(dir, `script-${i}.ps1`)
      writeFileSync(path, text)
      return { name, path }
    })
    const parse = named.map(({ path }) => `$t = $null; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile(${desktop.literal(path)}, [ref]$t, [ref]$e); [Console]::Out.WriteLine([string]$e.Count)`).join('\r\n')
    const run = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', '-'], { input: parse, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
    assert.equal(run.status, 0, run.stderr)
    const counts = run.stdout.trim().split(/\r?\n/)
    assert.deepEqual(
      named.map(({ name }, i) => `${name}: ${counts[i]}`),
      named.map(({ name }) => `${name}: 0`),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** The read script up to its last line, the call: the preferences, the module path, the compile, the deny list. */
function compileOnly() {
  const lines = desktop.readScript({ own: 4242 }).split('\r\n')
  assert.match(lines.at(-1), /^\[Console\]::Out\.Write\(\[SelfDesktop\]::ReadOwn\(/)
  return lines.slice(0, -1)
}

/** Runs `lines` after the helper's compile, in Windows PowerShell as the plugin does: its output. */
function afterCompile(lines) {
  const call = desktop.powershellCall(POWERSHELL, [...compileOnly(), ...lines].join('\r\n'))
  const run = spawnSync(call.argv[0], call.argv.slice(1), { input: call.stdin, encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  assert.equal(run.status, 0, run.stderr)
  return run.stdout
}

test("the helper compiles under Windows PowerShell's Add-Type, and nothing of it is called", { skip: ON_WINDOWS }, () => {
  assert.equal(afterCompile(["[Console]::Out.Write('compiled ' + [string]([SelfDesktop].GetMethods().Count -gt 0))"]).trim(), 'compiled True')
})

/**
 * The pure rules, each called with fixed values after the compile: [name, PowerShell expression, the answer, or a
 * pattern its text must match]. The process table: claude 20 (claude.exe) under its shell 30 (pwsh.exe), this script 10
 * (powershell.exe) and an MCP server 11 (node.exe) under claude, another claude 12 under claude, a cmd.exe 60 under 70.
 */
const TABLE = '[uint32[]]@(10, 11, 12, 20, 30, 60, 70), [uint32[]]@(20, 20, 20, 30, 0, 70, 0), [long[]]@(500, 500, 500, 400, 100, 300, 200)'
const NAMES = "[string[]]@('powershell.exe', 'node.exe', 'claude.exe', 'claude.exe', 'pwsh.exe', 'cmd.exe', 'explorer.exe')"
/**
 * A null string, as Windows PowerShell hands one to a .NET method. It converts $null to an empty string for a string
 * parameter, so a row that means "no reason" passes this instead. Microsoft, the NullString class
 * (learn.microsoft.com/en-us/dotnet/api/system.management.automation.language.nullstring): "This type is introduced to
 * provide a way to pass null into a .NET method that has a string parameter." An array parameter (uint[], string[])
 * is no string: $null reaches it as null, so the one row that means "no list" passes $null.
 */
const NULL_STRING = '[System.Management.Automation.Language.NullString]::Value'
const RULES = [
  // Which names a tree gives.
  ['named: a tab in a terminal window', "[SelfDesktop]::Named($true, 'TabItem', $false, $false)", true],
  ['named: the window itself in a terminal window', "[SelfDesktop]::Named($true, 'Window', $false, $false)", true],
  ['named: a list item in a terminal window', "[SelfDesktop]::Named($true, 'ListItem', $false, $false)", false],
  ['named: a list item in another window', "[SelfDesktop]::Named($false, 'ListItem', $false, $false)", true],
  ['named: a password field', "[SelfDesktop]::Named($false, 'Edit', $true, $false)", false],
  ['named: a terminal control', "[SelfDesktop]::Named($true, 'Button', $false, $true)", false],
  ['terminal control: by its class', "[SelfDesktop]::TerminalControl($true, 'TermControl', $false)", true],
  ['terminal control: anything that offers text', "[SelfDesktop]::TerminalControl($true, 'Other', $true)", true],
  ['terminal control: neither', "[SelfDesktop]::TerminalControl($true, 'Other', $false)", false],
  ['terminal control: never outside a terminal window', "[SelfDesktop]::TerminalControl($false, 'TermControl', $true)", false],
  // Whether a console is a pane, and which window is the session's own.
  ['pane: a pseudoconsole window, shown or not', "[SelfDesktop]::HasPane('PseudoConsoleWindow', $false)", true],
  ['pane: a classic console window that shows', "[SelfDesktop]::HasPane('ConsoleWindowClass', $true)", true],
  ['pane: a hidden classic console window', "[SelfDesktop]::HasPane('ConsoleWindowClass', $false)", false],
  ['pane: a console with no window', "[SelfDesktop]::HasPane('', $false)", false],
  ['pane: a window of another class', "[SelfDesktop]::HasPane('Other', $true)", false],
  ['window: owned by Windows Terminal', "[SelfDesktop]::WindowKind('PseudoConsoleWindow', $true, 'CASCADIA_HOSTING_WINDOW_CLASS', 'WindowsTerminal.exe')", 'terminal'],
  ['window: that class, of a program that is not Windows Terminal',"[SelfDesktop]::WindowKind('PseudoConsoleWindow', $true, 'CASCADIA_HOSTING_WINDOW_CLASS', 'other.exe')", ''],
  ['window: a pseudoconsole with no owner', "[SelfDesktop]::WindowKind('PseudoConsoleWindow', $true, '', '')", ''],
  ['window: a classic console that shows', "[SelfDesktop]::WindowKind('ConsoleWindowClass', $true, '', '')", 'console'],
  ['window: a hidden classic console', "[SelfDesktop]::WindowKind('ConsoleWindowClass', $false, '', '')", ''],
  ['why: no window', "[SelfDesktop]::NoWindowWhy('', $false, '', '')", /has no window, so it is no pane/],
  ['why: no owner', "[SelfDesktop]::NoWindowWhy('PseudoConsoleWindow', $true, '', '')", /names no owner/],
  // The ancestor check.
  ['ancestor: this script runs under claude', `[SelfDesktop]::AncestorWhy(10, 20, ${TABLE})`, null],
  ['ancestor: and under its shell', `[SelfDesktop]::AncestorWhy(10, 30, ${TABLE})`, null],
  ['ancestor: not under an unrelated process', `[SelfDesktop]::AncestorWhy(10, 60, ${TABLE})`, /is not one this script runs under/],
  ['ancestor: a parent that started after its child is a reused id', '[SelfDesktop]::AncestorWhy(10, 20, [uint32[]]@(10, 20), [uint32[]]@(20, 0), [long[]]@(500, 600))', /is not one this script runs under/],
  ['ancestor: a parent whose start is unknown ends the walk', '[SelfDesktop]::AncestorWhy(10, 20, [uint32[]]@(10, 20), [uint32[]]@(20, 0), [long[]]@(500, 0))', /is not one this script runs under/],
  // Who may share the console.
  ['sharing: this script, claude and its shell', `[SelfDesktop]::SharingWhy(10, 20, [uint32[]]@(10, 20, 30), ${TABLE}, ${NAMES})`, null],
  ['sharing: a descendant of claude of another name', `[SelfDesktop]::SharingWhy(10, 20, [uint32[]]@(10, 20, 11), ${TABLE}, ${NAMES})`, null],
  [
    'sharing: a program that is not this session\'s own',
    `[SelfDesktop]::SharingWhy(10, 20, [uint32[]]@(10, 20, 60), ${TABLE}, ${NAMES})`,
    /^a program that is not this session's own, not its shell above it nor its children below it \(cmd\.exe, process 60\), shares this session's console/,
  ],
  ['sharing: another Claude Code under claude', `[SelfDesktop]::SharingWhy(10, 20, [uint32[]]@(10, 20, 12), ${TABLE}, ${NAMES})`, /^another Claude Code process \(claude\.exe, process 12\)/],
  [
    'sharing: another Claude Code above claude',
    "[SelfDesktop]::SharingWhy(10, 20, [uint32[]]@(10, 20, 30), [uint32[]]@(10, 20, 30), [uint32[]]@(20, 30, 0), [long[]]@(500, 400, 100), [string[]]@('powershell.exe', 'claude.exe', 'CLAUDE.EXE'))",
    /^another Claude Code process \(CLAUDE\.EXE, process 30\)/,
  ],
  ['sharing: a process that can\'t be placed', `[SelfDesktop]::SharingWhy(10, 20, [uint32[]]@(10, 20, 99), ${TABLE}, ${NAMES})`, /can't be placed \(process 99\)/],
  // A uint[] parameter: $null reaches it as null, not as an empty array.
  ['sharing: no list of the processes', `[SelfDesktop]::SharingWhy(10, 20, $null, ${TABLE}, ${NAMES})`, /couldn't be told apart/],
  [
    'sharing: this script itself may carry the image name of the process Claude Code names',
    "[SelfDesktop]::SharingWhy(10, 20, [uint32[]]@(10, 20), [uint32[]]@(10, 20), [uint32[]]@(20, 0), [long[]]@(500, 400), [string[]]@('powershell.exe', 'powershell.exe'))",
    null,
  ],
  // How much of a pane is kept, the deny list, whether a picture is taken, whether a picture taken is kept.
  ['kept: the bottom 2 of 3 rows', '[SelfDesktop]::KeepFrom([int[]]@(5, 5, 5), 2, 100)', 1],
  ['kept: the bottom rows within 9 characters', '[SelfDesktop]::KeepFrom([int[]]@(5, 5, 5), 10, 9)', 2],
  ['kept: 30 rows of 1,000 within 20,000 characters', `[SelfDesktop]::KeepFrom([int[]]@(${Array.from({ length: 30 }, () => 1000).join(', ')}), 200, 20000)`, 10],
  ['kept: no rows', '[SelfDesktop]::KeepFrom([int[]]@(), 200, 20000)', 0],
  ['denied: a password manager among a window and its children', "[SelfDesktop]::DeniedOf([string[]]@('WindowsTerminal.exe', 'KeePassXC.exe'), [string[]]@('keepassxc.exe'))", 'KeePassXC.exe'],
  ['denied: none', "[SelfDesktop]::DeniedOf([string[]]@('WindowsTerminal.exe'), [string[]]@('keepassxc.exe'))", null],
  ['picture: a Windows Terminal window is not built', `[SelfDesktop]::CaptureRefusal('terminal', ${NULL_STRING})`, 'terminal'],
  ['picture: a classic console window may be pictured', `[SelfDesktop]::CaptureRefusal('console', ${NULL_STRING})`, null],
  ['picture: refused with the finding when the console is shared', "[SelfDesktop]::CaptureRefusal('console', 'a program that is not this session''s own shares it')", 'why'],
  ['picture: refused when no window was found', "[SelfDesktop]::CaptureRefusal('', 'no window')", 'why'],
  ['picture: refused for any other kind', `[SelfDesktop]::CaptureRefusal('app', ${NULL_STRING})`, 'why'],
  // An empty reason is a reason: it refuses, failing closed (what $null would have passed before).
  ['picture: an empty reason refuses too', "[SelfDesktop]::CaptureRefusal('console', '')", 'why'],
  ['after the picture: the same window, nothing found against it, kept', `[SelfDesktop]::AfterPicture(5, 5, ${NULL_STRING})`, null],
  ['after the picture: another window shows the console, not kept', `[SelfDesktop]::AfterPicture(5, 6, ${NULL_STRING})`, /shown by another window now/],
  ['after the picture: no window found again, not kept', `[SelfDesktop]::AfterPicture(5, 0, ${NULL_STRING})`, /shown by another window now/],
  // An empty reason found again is a reason: the picture is not kept (the reason comes back, not null).
  ['after the picture: an empty reason found again, not kept', "[SelfDesktop]::AfterPicture(5, 5, '')", ''],
  ['after the picture: what the look again found, not kept', "[SelfDesktop]::AfterPicture(5, 5, 'a program that is not this session''s own shares it')", "a program that is not this session's own shares it"],
  // A window handle as the helper prints it (its lower 32 bits) and makes it again (those 32 bits sign-extended). Each
  // number is cast to [long], the parameter's type, so none rests on how Windows PowerShell types a literal.
  ['handle printed: a small handle as it is', '[SelfDesktop]::HandleNumber([long]74565)', 74565],
  ['handle printed: one with bit 31 set, sign-extended, as its lower 32 bits', '[SelfDesktop]::HandleNumber([long]-2147483648)', 2147483648],
  ['handle printed: all 32 bits set, sign-extended', '[SelfDesktop]::HandleNumber([long]-1)', 4294967295],
  ['handle printed: upper bits set by any other means are dropped', '[SelfDesktop]::HandleNumber([long]4295041861)', 74565],
  ['handle made again: a small number as it is', '[SelfDesktop]::HandleValue([long]74565)', 74565],
  ['handle made again: bit 31 set, sign-extended', '[SelfDesktop]::HandleValue([long]2147483648)', -2147483648],
  ['handle made again: all 32 bits set, sign-extended', '[SelfDesktop]::HandleValue([long]4294967295)', -1],
  ['handle round trip: printed, then made again, is the sign-extended handle', '[SelfDesktop]::HandleValue([SelfDesktop]::HandleNumber([long]-2147483000))', -2147483000],
]

/** What a row that threw gives, in place of its answer: the error's message after this mark. */
const THREW = 'threw: '

test("the helper's pure rules answer as the privacy rules say, for fixed values: no window read, no console attached", { skip: ON_WINDOWS }, () => {
  // Every row is answered, one that throws included (its message in its place), and the whole table is compared at
  // once: one run lists every row that differs, with what it gave.
  const lines = [
    '$answers = New-Object System.Collections.ArrayList',
    ...RULES.map(([, expression]) => `try { [void]$answers.Add(${expression}) } catch { [void]$answers.Add(${desktop.literal(THREW)} + $_.Exception.Message) }`),
    '[Console]::Out.Write((ConvertTo-Json -InputObject @($answers.ToArray()) -Compress))',
  ]
  const answers = JSON.parse(afterCompile(lines).trim())
  const said = value => (value instanceof RegExp ? String(value) : JSON.stringify(value))
  const differ = RULES.flatMap(([name, expression, expected], i) => {
    const got = answers[i] ?? null
    const same = expected instanceof RegExp ? typeof got === 'string' && !got.startsWith(THREW) && expected.test(got) : isDeepStrictEqual(got, expected)
    return same ? [] : [`${name}: ${expression} gave ${said(got)}, expected ${said(expected)}`]
  })
  if (answers.length !== RULES.length) differ.push(`the table has ${RULES.length} rows, the answers ${answers.length}`)
  assert.deepEqual(differ, [], `${differ.length} of ${RULES.length} rows differ:\n${differ.join('\n')}`)
})
