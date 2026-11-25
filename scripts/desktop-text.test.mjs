// self-desktop as text: what can be shown from the text its code ships, without reading a window. Run with
// `node --test "scripts/*.test.mjs"`.
// - Nothing acts: no file of the plugin's hooks names a call that makes input, reads keys or the clipboard, brings a
//   window forward, moves, sizes, shows, hides or closes one, reads the screen rather than one window, writes to a
//   console or sets its state, changes a control, changes the system, or starts or ends a process. Each kind of fault,
//   planted on a line of its own in a copy of the helper, is found on that line, and the unplanted text has none.
//   Comments count: a shipped file doesn't name one even to say it isn't used.
// - The helper's imported entry points, the .NET calls it makes and the types it builds are held equal to a reviewed
//   list: a new one fails here until someone reviews it and adds it.
// - Its few lines of PowerShell plumbing are the shared machine code's, so a fix there is seen here.
// - On Windows: every script it builds parses in Windows PowerShell with no error; the helper compiles under Add-Type;
//   and its pure rules (the ancestor check, who may share the console, whether a console is a pane, which window is the
//   session's own, which names a tree gives, how much of a pane is kept, the deny list, whether a picture is taken)
//   give the answers below for fixed values. That runs PowerShell and the C# compiler and calls only those pure rules:
//   no window is read and no console is attached to.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
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
  ['a console handle opened for writing', /GENERIC_WRITE|0x40000000|0xC0000000|3221225472/i],
  ['a console setting from PowerShell', /\[Console\]::(?:OutputEncoding|InputEncoding|Title|CursorLeft|CursorTop|CursorVisible|BackgroundColor|ForegroundColor|WindowWidth|WindowHeight|BufferWidth|BufferHeight|TreatControlCAsInput)\s*=|RawUI|Write-Host|Clear-Host/],
  [
    'a UI Automation pattern object, or a method that acts',
    /\b(?:GetCurrentPattern|TryGetCurrentPattern|GetCachedPattern|TryGetCachedPattern|InvokePattern|ValuePattern|WindowPattern|TransformPattern|ScrollItemPattern|ScrollPattern|ExpandCollapsePattern|LegacyIAccessiblePattern|TextPattern\b|TogglePattern\b|SelectionItemPattern\b|DoDefaultAction|ScrollIntoView|SetWindowVisualState|AddToSelection|RemoveFromSelection)|\.(?:Invoke|Toggle|Select|Expand|Collapse|Realize|SetValue|Move|Resize|Rotate|SetView|Close|Kill|SetFocus)\(/,
  ],
  ['a change of the system', /\b(?:SystemParametersInfo|LockWorkStation|ExitWindowsEx|InitiateSystemShutdown|ChangeDisplaySettings|SetSystemCursor)/],
  ['a process started or ended', /Stop-Process|taskkill|Start-Process|ShellExecute|CreateProcess|WinExec|TerminateProcess|Invoke-Expression|\biex\b|Process\]::Start\(|Process\.Start\(|\bwt\.exe|Invoke-Item|\bcmd\.exe|\.Kill\(|CloseMainWindow/i],
]

/**
 * The helper's imports, as dll!entry, reviewed: each a read, or an act on this script's own process, thread or bitmap
 * (FreeConsole and AttachConsole move this process alone; SetThreadDpiAwarenessContext sets this thread's alone;
 * PrintWindow has a window render itself into this process's bitmap).
 */
const REVIEWED_IMPORTS = [
  'dwmapi.dll!DwmGetWindowAttribute',
  'dwmapi.dll!DwmGetWindowAttribute',
  'kernel32.dll!AttachConsole',
  'kernel32.dll!CloseHandle',
  'kernel32.dll!CreateFileW',
  'kernel32.dll!CreateToolhelp32Snapshot',
  'kernel32.dll!FreeConsole',
  'kernel32.dll!GetConsoleProcessList',
  'kernel32.dll!GetConsoleScreenBufferInfo',
  'kernel32.dll!GetConsoleWindow',
  'kernel32.dll!Process32FirstW',
  'kernel32.dll!Process32NextW',
  'kernel32.dll!ReadConsoleOutputCharacterW',
  'shcore.dll!GetDpiForMonitor',
  'user32.dll!EnumChildWindows',
  'user32.dll!EnumDisplayMonitors',
  'user32.dll!EnumWindows',
  'user32.dll!GetClassNameW',
  'user32.dll!GetForegroundWindow',
  'user32.dll!GetMonitorInfoW',
  'user32.dll!GetWindow',
  'user32.dll!GetWindowRect',
  'user32.dll!GetWindowTextW',
  'user32.dll!GetWindowThreadProcessId',
  'user32.dll!IsIconic',
  'user32.dll!IsWindow',
  'user32.dll!IsWindowVisible',
  'user32.dll!IsZoomed',
  'user32.dll!MonitorFromWindow',
  'user32.dll!PrintWindow',
  'user32.dll!SetThreadDpiAwarenessContext',
]

/**
 * The helper's qualified .NET calls, reviewed: reads, its own collections and strings, and the writes it makes to its
 * own capture alone (Directory.CreateDirectory and part.Save in the plugin's folder; File.Delete of the picture it took).
 */
const REVIEWED_CALLS = [
  'Array.Copy', 'Array.IndexOf', 'AutomationElement.FromHandle', 'CAPTURE_NAME.IsMatch', 'Columns.ToString', 'CutChars.ToString', 'CutRows.ToString',
  'Directory.CreateDirectory', 'Dpi.ToString', 'File.Delete', 'GC.KeepAlive', 'Graphics.FromImage', 'Height.ToString', 'Marshal.GetLastWin32Error',
  'Marshal.SizeOf', 'Math.Min', 'Math.Round', 'Path.Combine', 'Path.IsPathRooted', 'Process.GetCurrentProcess', 'Process.GetProcessById',
  'ProgrammaticName.Replace', 'Rectangle.Intersect', 'Rows.ToString', 'StartTime.ToUniversalTime', 'Width.ToString', 'Window.ToInt64', 'all.TryGetValue',
  'b.Append', 'depth.ToString', 'double.IsInfinity', 'double.IsNaN', 'element.GetCurrentPropertyValue', 'element.GetRuntimeId', 'fields.Add',
  'fields.ToArray', 'found.Add', 'front.ToInt64', 'graphics.GetHdc', 'graphics.ReleaseHdc', 'handle.ToString', 'ids.Add', 'ids.Contains', 'ids.ToArray',
  'lines.Add', 'lines.ToArray', 'listed.Add', 'listed.ToArray', 'monitors.Add', 'monitors.ToArray', 'name.ToString', 'nodes.Add', 'nodes.ToArray',
  'part.Save', 'part.ToString', 'parts.Add', 'parts.ToArray', 'programs.Add', 'programs.ToArray', 'roots.Add', 'roots.AddRange', 'roots.ToArray',
  'rows.Add', 'rows.GetRange', 'string.Equals', 'string.Join', 'text.Substring', 'text.ToString', 'walker.GetFirstChild', 'walker.GetNextSibling',
  'whole.Clone', 'window.ToInt64', 'windows.Add',
]

/** The types the helper builds, reviewed: its own records, collections, strings, a bitmap of its own and a rectangle. */
const REVIEWED_BUILT = ['Bitmap', 'Box', 'Dictionary', 'IntPtr', 'List', 'MonitorInfo', 'Own', 'Pane', 'ProcessEntry', 'Rectangle', 'Regex', 'Screen', 'Shot', 'StringBuilder', 'Table', 'char', 'int', 'long', 'string', 'uint']

/** What the helper's text imports, calls and builds, as the reviewed lists name them. */
function helperUses(cs) {
  const imports = cs
    .split('\n')
    .filter(line => line.includes('[DllImport('))
    .map(line => `${/DllImport\("([^"]+)"/.exec(line)?.[1]}!${/EntryPoint = "([^"]+)"/.exec(line)?.[1] ?? /static extern \S+ (\w+)\(/.exec(line)?.[1]}`)
    .sort()
  const calls = [...new Set([...cs.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Z][A-Za-z0-9]*)\s*\(/g)].map(m => `${m[1]}.${m[2]}`))].sort()
  const built = [...new Set([...cs.matchAll(/\bnew\s+([A-Za-z_][A-Za-z0-9_.]*)/g)].map(m => m[1]))].sort()
  return { imports, calls, built }
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

test("nothing in the plugin's shipped hooks acts: no input, no keys or clipboard read, no window brought forward, moved, sized, shown, hidden or closed, no screen read, no console written to or set, no control changed, no system change, no process started or ended", () => {
  const files = hookFiles(HOOKS)
  assert.ok(files.some(f => f.endsWith('desktop.ts')) && files.some(f => f.endsWith('register.ts')), 'the hooks were found')
  const found = files.flatMap(path => acting(readFileSync(path, 'utf8')).map(f => `${path}:${f.line}: ${f.what}: ${f.text}`))
  assert.deepEqual(found, [])
})

test('each kind of acting call, planted on a line of its own in a copy of the helper, is found on that line, and the unplanted helper has none', () => {
  assert.deepEqual(acting(desktop.HELPER_CS), [], 'the helper as shipped names nothing that acts')
  const anchor = 'public static class SelfDesktop {'
  const lines = desktop.HELPER_CS.split('\n')
  const at = lines.indexOf(anchor)
  assert.ok(at >= 0, 'the place to plant is found')
  const planted = at + 2
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
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
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
    const text = [...lines.slice(0, at + 1), `  ${plant}`, ...lines.slice(at + 1)].join('\n')
    const found = acting(text)
    assert.ok(found.length > 0, `the scan finds: ${plant}`)
    assert.deepEqual([...new Set(found.map(f => f.line))], [planted], `the scan finds ${plant} on its own line, and nowhere else`)
  }
})

test("the helper imports, calls and builds only what was reviewed: a new entry point, call or type fails here until it is reviewed and added", () => {
  const uses = helperUses(desktop.HELPER_CS)
  assert.deepEqual(uses.imports, [...REVIEWED_IMPORTS].sort())
  assert.deepEqual(uses.calls, [...REVIEWED_CALLS].sort())
  assert.deepEqual(uses.built, [...REVIEWED_BUILT].sort())
  // A screen read planted in a copy is a new call, and fails the list.
  const planted = desktop.HELPER_CS.replace('using (Graphics graphics = Graphics.FromImage(whole)) {', 'using (Graphics graphics = Graphics.FromImage(whole)) { graphics.CopyFromScreen(0, 0, 0, 0, whole.Size);')
  assert.notDeepEqual(helperUses(planted).calls, [...REVIEWED_CALLS].sort())
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
  const file = { folder: 'C:\\path\\to\\data\\captures', name: 'capture-0b6f3a52-1c2d-4e5f-8a9b-0c1d2e3f4a5b.png' }
  return {
    'list, own window': desktop.listScript(4242),
    'list, no own window': desktop.listScript(undefined),
    'read, own window': desktop.readScript({ own: 4242 }),
    'read, a test window': desktop.readScript({ window: 777 }),
    'capture, own window': desktop.captureScript({ own: 4242 }, file),
    'capture, a test window': desktop.captureScript({ window: 777 }, file),
    'deletion of old captures': desktop.deleteScript([`${file.folder}\\${file.name}`]),
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
  ['window: that class, another program', "[SelfDesktop]::WindowKind('PseudoConsoleWindow', $true, 'CASCADIA_HOSTING_WINDOW_CLASS', 'other.exe')", ''],
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
  ['sharing: an unrelated program', `[SelfDesktop]::SharingWhy(10, 20, [uint32[]]@(10, 20, 60), ${TABLE}, ${NAMES})`, /^another program \(cmd\.exe, process 60\) shares this session's console/],
  ['sharing: another Claude Code under claude', `[SelfDesktop]::SharingWhy(10, 20, [uint32[]]@(10, 20, 12), ${TABLE}, ${NAMES})`, /^another Claude Code process \(claude\.exe, process 12\)/],
  [
    'sharing: another Claude Code above claude',
    "[SelfDesktop]::SharingWhy(10, 20, [uint32[]]@(10, 20, 30), [uint32[]]@(10, 20, 30), [uint32[]]@(20, 30, 0), [long[]]@(500, 400, 100), [string[]]@('powershell.exe', 'claude.exe', 'CLAUDE.EXE'))",
    /^another Claude Code process \(CLAUDE\.EXE, process 30\)/,
  ],
  ['sharing: a process that can\'t be placed', `[SelfDesktop]::SharingWhy(10, 20, [uint32[]]@(10, 20, 99), ${TABLE}, ${NAMES})`, /can't be placed \(process 99\)/],
  ['sharing: no list of the processes', `[SelfDesktop]::SharingWhy(10, 20, $null, ${TABLE}, ${NAMES})`, /couldn't be told apart/],
  [
    'sharing: this script itself may carry the image name of the process Claude Code names',
    "[SelfDesktop]::SharingWhy(10, 20, [uint32[]]@(10, 20), [uint32[]]@(10, 20), [uint32[]]@(20, 0), [long[]]@(500, 400), [string[]]@('powershell.exe', 'powershell.exe'))",
    null,
  ],
  // How much of a pane is kept, the deny list, whether a picture is taken.
  ['kept: the bottom 2 of 3 rows', '[SelfDesktop]::KeepFrom([int[]]@(5, 5, 5), 2, 100)', 1],
  ['kept: the bottom rows within 9 characters', '[SelfDesktop]::KeepFrom([int[]]@(5, 5, 5), 10, 9)', 2],
  ['kept: 30 rows of 1,000 within 20,000 characters', `[SelfDesktop]::KeepFrom([int[]]@(${Array.from({ length: 30 }, () => 1000).join(', ')}), 200, 20000)`, 10],
  ['kept: no rows', '[SelfDesktop]::KeepFrom([int[]]@(), 200, 20000)', 0],
  ['denied: a password manager among a window and its children', "[SelfDesktop]::DeniedOf([string[]]@('WindowsTerminal.exe', 'KeePassXC.exe'), [string[]]@('keepassxc.exe'))", 'KeePassXC.exe'],
  ['denied: none', "[SelfDesktop]::DeniedOf([string[]]@('WindowsTerminal.exe'), [string[]]@('keepassxc.exe'))", null],
  ['picture: a Windows Terminal window is not built', '[SelfDesktop]::CaptureRefusal(\'terminal\', $null)', 'terminal'],
  ['picture: a classic console window may be pictured', '[SelfDesktop]::CaptureRefusal(\'console\', $null)', null],
  ['picture: refused with the finding when the console is shared', "[SelfDesktop]::CaptureRefusal('console', 'another program shares it')", 'why'],
  ['picture: refused when no window was found', "[SelfDesktop]::CaptureRefusal('', 'no window')", 'why'],
  ['picture: refused for any other kind', '[SelfDesktop]::CaptureRefusal(\'app\', $null)', 'why'],
]

test("the helper's pure rules answer as the privacy rules say, for fixed values: no window read, no console attached", { skip: ON_WINDOWS }, () => {
  const lines = ['$answers = New-Object System.Collections.ArrayList', ...RULES.map(([, expression]) => `[void]$answers.Add(${expression})`), '[Console]::Out.Write((ConvertTo-Json -InputObject @($answers.ToArray()) -Compress))']
  const answers = JSON.parse(afterCompile(lines).trim())
  assert.equal(answers.length, RULES.length)
  for (const [i, [name, , expected]] of RULES.entries()) {
    const got = answers[i]
    if (expected instanceof RegExp) assert.match(String(got), expected, name)
    else assert.deepEqual(got === undefined ? null : got, expected, name)
  }
})
