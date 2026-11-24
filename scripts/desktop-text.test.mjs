// self-desktop as text: what can be shown from the text its code ships, without reading a window. Run with
// `node --test "scripts/*.test.mjs"`.
// - Nothing acts: no file of the plugin's hooks names a call that makes input, brings a window forward, moves, sizes,
//   shows, hides or closes one, writes to a console, sets a console's state, or changes a control (a UI Automation
//   pattern object, or a method that acts), nor starts or ends a process. Then each kind of fault, planted in a copy,
//   is found. Comments count: a shipped file doesn't name one even to say it isn't used.
// - Its few lines of PowerShell plumbing are the shared machine code's, so a fix there is seen here.
// - On Windows: every script it builds parses in Windows PowerShell with no error, and its helper compiles under
//   Add-Type. That runs PowerShell and the C# compiler, and no method of the helper: no window is read.
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
const POWERSHELL = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

/** What would act, by kind: each pattern a name or a shape no shipped file of the plugin may hold. */
const ACTS = [
  [
    'a Windows call that acts on a window',
    /\b(?:SetWindowPos|MoveWindow|ShowWindow|SetForegroundWindow|BringWindowToTop|SetActiveWindow|SetFocus|SetWindowPlacement|CloseWindow|DestroyWindow|EndTask|SwitchToThisWindow|AllowSetForegroundWindow|LockSetForegroundWindow|SetParent|SetWindowLong|SetLayeredWindowAttributes|FlashWindow|EnableWindow|SetWindowText|AnimateWindow|DwmSetWindowAttribute|SetWindowRgn|SetWindowDisplayAffinity|SetCapture|OpenIcon|TileWindows|CascadeWindows|ArrangeIconicWindows|SetMenu|UpdateLayeredWindow)/,
  ],
  ['a message sent or posted to a window', /\b(?:PostMessage|SendMessage|SendNotifyMessage|SendMessageTimeout|PostThreadMessage|BroadcastSystemMessage)/],
  ['input made up', /\b(?:SendInput|keybd_event|mouse_event|SetCursorPos|BlockInput|ClipCursor|AttachThreadInput|SendKeys|AppActivate|SendWait)/],
  ['a write to a console, or a change of its state', /\b(?:WriteConsole|WriteFile|FillConsoleOutput|SetConsole|ScrollConsoleScreenBuffer|GenerateConsoleCtrlEvent|AllocConsole|SetStdHandle|SetCurrentConsoleFont)/],
  ["a read of a console's input, which takes keys from the person", /\b(?:ReadConsoleInput|PeekConsoleInput|FlushConsoleInputBuffer|ReadConsoleW?\b)|CONIN\$/],
  ['a console handle opened for writing', /GENERIC_WRITE|0x40000000|0xC0000000|3221225472/i],
  ['a console setting from PowerShell', /\[Console\]::(?:OutputEncoding|InputEncoding|Title|CursorLeft|CursorTop|CursorVisible|BackgroundColor|ForegroundColor|WindowWidth|WindowHeight|BufferWidth|BufferHeight|TreatControlCAsInput)\s*=|RawUI|Write-Host|Clear-Host/],
  [
    'a UI Automation pattern object, or a method that acts',
    /\b(?:GetCurrentPattern|TryGetCurrentPattern|GetCachedPattern|TryGetCachedPattern|InvokePattern|ValuePattern|WindowPattern|TransformPattern|ScrollItemPattern|ScrollPattern|ExpandCollapsePattern|LegacyIAccessiblePattern|TextPattern\b|TogglePattern\b|SelectionItemPattern\b|DoDefaultAction|ScrollIntoView|SetWindowVisualState|AddToSelection|RemoveFromSelection)|\.(?:Invoke|Toggle|Select|Expand|Collapse|Realize|SetValue|Move|Resize|Rotate|SetView|Close|Kill|SetFocus)\(/,
  ],
  ['a process started or ended', /Stop-Process|taskkill|Start-Process|ShellExecute|Process\]::Start\(|Process\.Start\(|\bwt\.exe|Invoke-Item|\bcmd\.exe|\.Kill\(|CloseMainWindow/i],
]

/** The shipped files of the plugin's hooks, every one: the module, its helper's text, the shared copies, hooks.json. */
const hookFiles = dir => readdirSync(dir).map(name => join(dir, name)).filter(path => statSync(path).isFile())

/** What a file's text names that would act, one line per finding. */
function acting(path, text) {
  const found = []
  for (const [what, pattern] of ACTS) {
    for (const [i, line] of text.split('\n').entries()) if (pattern.test(line)) found.push(`${path}:${i + 1}: ${what}: ${line.trim().slice(0, 160)}`)
  }
  return found
}

test("nothing in the plugin's shipped hooks acts: no input, no window brought forward, moved, sized, shown, hidden or closed, no console written to or set, no control changed, no process started or ended", () => {
  const files = hookFiles(HOOKS)
  assert.ok(files.some(f => f.endsWith('desktop.ts')) && files.some(f => f.endsWith('register.ts')), 'the hooks were found')
  const found = files.flatMap(path => acting(path, readFileSync(path, 'utf8')))
  assert.deepEqual(found, [])
})

test('each kind of acting call, planted in a copy of the helper, is found', () => {
  const plants = [
    'SetForegroundWindow(window);',
    'ShowWindow(window, 9);',
    'SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, 0);',
    'PostMessage(window, 16, IntPtr.Zero, IntPtr.Zero);',
    'SendMessage(window, 16, IntPtr.Zero, IntPtr.Zero);',
    'SendInput(1, inputs, 40);',
    'keybd_event(13, 0, 0, UIntPtr.Zero);',
    'mouse_event(2, 0, 0, 0, UIntPtr.Zero);',
    'WriteConsoleW(output, text, 1, out written, IntPtr.Zero);',
    'SetConsoleOutputCP(65001);',
    'ReadConsoleInputW(input, records, 1, out read);',
    'CreateFileW("CONOUT$", 0x40000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'object pattern = element.GetCurrentPattern(InvokePattern.Pattern);',
    'element.SetFocus();',
    '((InvokePattern)pattern).Invoke();',
    'Stop-Process -Id 1',
    'Start-Process wt.exe',
  ]
  for (const plant of plants) {
    const text = desktop.HELPER_CS.replace('public static class SelfDesktop {', `public static class SelfDesktop {\n  ${plant}`)
    assert.notDeepEqual(acting('planted', text), [], `the scan finds: ${plant}`)
  }
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

/** Every script the plugin builds, by name: the tools' and the live tests' own. */
function scripts() {
  const file = { folder: 'C:\\path\\to\\data\\captures', name: 'capture-0b6f3a52-1c2d-4e5f-8a9b-0c1d2e3f4a5b.png' }
  return {
    'list, own window': desktop.listScript(4242),
    'list, no own window': desktop.listScript(undefined),
    'read, own window': desktop.readScript({ own: 4242 }),
    'read, a test window': desktop.readScript({ window: 777 }),
    'capture, own window': desktop.captureScript({ own: 4242 }, file),
    'capture, a test window': desktop.captureScript({ window: 777 }, file),
    'structure rule, a test window': desktop.gateScript(777),
  }
}

test('every script parses in Windows PowerShell with no error', { skip: isWindows ? false : 'Windows PowerShell runs on Windows only' }, () => {
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

test("the helper compiles under Windows PowerShell's Add-Type, and nothing of it is called", { skip: isWindows ? false : 'Windows PowerShell runs on Windows only' }, () => {
  // The read script up to its last line, which is the call: the preferences, the module path, the compile, the deny list.
  const lines = desktop.readScript({ own: 4242 }).split('\r\n')
  assert.match(lines.at(-1), /^\[Console\]::Out\.Write\(\[SelfDesktop\]::ReadOwn\(/)
  const compileOnly = [...lines.slice(0, -1), "[Console]::Out.Write('compiled ' + [string]([SelfDesktop].GetMethods().Count -gt 0))"].join('\r\n')
  const call = desktop.powershellCall(POWERSHELL, compileOnly)
  const run = spawnSync(call.argv[0], call.argv.slice(1), { input: call.stdin, encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout.trim(), 'compiled True')
})
