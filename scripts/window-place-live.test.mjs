// The plain window placing itself (#5), on Windows. Two parts.
//
// 1. No window (Windows only): the window's own C# (machine.PLACE_CS) compiled by Add-Type in a hidden Windows
//    PowerShell 5.1, and in PowerShell 7 where it is installed, and its Clamp held to clampToWork row for row:
//    every row compared in one run, each that differs listed. Only Clamp is called: nothing acts on a window.
//
// 2. Live (Windows only, and only with SELF_PLACE_LIVE=1, in a run arranged for it): each test opens ONE plain
//    window of its own, a new console started by CreateProcess (CREATE_NEW_CONSOLE), which Windows hands to the
//    default terminal as it hands a launch's window. It runs only a script of this test's, which ends by itself:
//    it finds its own window as the shipped code does, runs the shipped placing lines (machine.windowPlaceLines)
//    when the test gives a place, reads back where its window is, writes that to a file, and exits. The test then
//    confirms the window is gone. Never wt.exe, never a named window, never the person's own windows: a window
//    the script finds that was open before it started (a terminal that put it in a tab of an existing window) is
//    left alone, nothing placed, and the test says so and skips. That guard is the test's own, and a second one:
//    the shipped code itself places a Windows Terminal window only when it holds this console alone (PLACE_CS's
//    Hosted, which lists the top-level windows once, reads each one's class name, reads the owner of those that
//    are pseudoconsole windows, acts on none, and is there to refuse, never to choose a target; no title is read).
//    Each window records that count (1 in a fresh window, which this run is what shows). The test's own listing
//    (TopWindows, to know which windows were open before) is in its starter, and serves the test alone.
//    Focus: the window is asked to open without being activated (STARTUPINFO's wShowWindow = SW_SHOWNOACTIVATE,
//    with STARTF_USESHOWWINDOW). Whether the default terminal honours that is not known; the test records the
//    window in front before the window starts, as it begins, and after its place, as a reported fact, never a
//    failure. A maximized window is activated by SW_MAXIMIZE, as ShowWindow's page says.
//    Read back with GetWindowRect (the frame SetWindowPos sets, invisible resize borders included), per-monitor
//    DPI aware, within POS_TOLERANCE pixels for x and y and SIZE_TOLERANCE for width and height: estimates, the
//    second for a classic console that may round its size to whole character cells.
//
// Run with `node --test "scripts/*.test.mjs"`; part 2 with SELF_PLACE_LIVE=1 set as well.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { policySkip, WINDOWS_POWERSHELL } from './stub.mjs'
import { ROOT } from './sync-shared.mjs'

const machine = await import(pathToFileURL(join(ROOT, 'shared', 'hooks', 'machine.ts')).href)
const isWindows = process.platform === 'win32'
const PWSH = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')

/** How many windows part 2 opens, and how long each may take at most (an estimate: two compiles, the place, its read-back, the close). */
const LIVE_WINDOWS = 4
const LIVE_EACH_MS = 25_000
/** The window is ended by the test's starter if it hasn't ended by itself by then (it ends itself within about 10 s). */
const WINDOW_LIMIT_MS = 20_000
const POS_TOLERANCE = 2
const SIZE_TOLERANCE = 24

/** `text` as a single-quoted PowerShell literal. */
const psq = text => `'${String(text).split("'").join("''")}'`

/** Runs `script` in a hidden Windows PowerShell (or `shell`), on standard input under the plugins' own bootstrap (powershellCall: no command-line limit); its standard output. */
function hidden(script, shell = WINDOWS_POWERSHELL, timeout = 60_000) {
  const call = machine.powershellCall(shell, script)
  const run = spawnSync(call.argv[0], call.argv.slice(1), { input: call.stdin, encoding: 'utf8', windowsHide: true, timeout })
  return { code: run.status, out: `${run.stdout ?? ''}`, err: `${run.stderr ?? ''}` }
}

/** Each row: a rect and a work area ([left, top, right, bottom]): what PLACE_CS's Clamp and clampToWork must agree on. */
const CLAMP_PAIRS = [
  [[100, 100, 1280, 800], [0, 0, 2560, 1400]],
  [[30000, 30000, 800, 600], [2560, 48, 4480, 1080]],
  [[-30000, 100, 800, 600], [-1920, 0, 0, 1040]],
  [[-900, 100, 1000, 600], [-1920, 0, 0, 1040]],
  [[100, 100, 4000, 3000], [0, 0, 2560, 1400]],
  [[-2100, 50, 800, 600], [-1920, 0, 0, 1040]],
  [[3000, 0, 800, 600], [2560, 48, 4480, 1080]],
  [[5000, -5000, 800, 600], [0, 0, 1920, 1040]],
  [[0, 0, 32768, 32768], [-1920, 0, 0, 1040]],
]

describe('the window\'s own C#, compiled, its Clamp held to clampToWork (no window)', { skip: !isWindows && 'Windows only: Add-Type compiles the C# of a Windows window' }, () => {
  for (const [name, shell] of [['Windows PowerShell 5.1', WINDOWS_POWERSHELL], ['PowerShell 7', PWSH]]) {
    test(`${name}: PLACE_CS compiles, every row of Clamp is clampToWork's, and Hosted counts for the console this test runs in`, t => {
      if (!existsSync(shell)) return t.skip(`${name} is not installed here`)
      const calls = CLAMP_PAIRS.map(([[x, y, w, h], [l, tp, r, b]]) => `@([ClaudeSelfToolsPlace]::Clamp([int]${x}, [int]${y}, [int]${w}, [int]${h}, [int]${l}, [int]${tp}, [int]${r}, [int]${b}))`)
      const script = [
        `Add-Type -ErrorAction Stop -TypeDefinition ${psq(machine.PLACE_CS)}`,
        `Add-Type -ErrorAction Stop -TypeDefinition ${psq(TEST_CS)}`,
        // Hosted, a pure read, for whatever console this hidden PowerShell has: under a Windows Terminal tab, the consoles its window holds.
        '$kind = [ClaudeSelfToolsPlaceTest]::OwnKind()',
        '$owner = [long][ClaudeSelfToolsPlaceTest]::OwnLow()',
        '$hosted = $null',
        'if ($owner -ne 0) { $hosted = [ClaudeSelfToolsPlace]::Hosted([IntPtr]::new($owner), [IntPtr]::new([long][ClaudeSelfToolsPlaceTest]::ConsoleLow())) }',
        `[Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 4 -InputObject ([ordered]@{ clamp = @(${calls.join(', ')}); kind = $kind; hosted = $hosted })))`,
      ].join('\r\n')
      const ran = hidden(script, shell)
      assert.equal(ran.code, 0, `${ran.out}${ran.err}`)
      const answer = JSON.parse(ran.out.trim().split(/\r?\n/).at(-1))
      t.diagnostic(`the console this test runs in: ${answer.kind}; Hosted for it: ${answer.hosted ?? 'not counted (not a Windows Terminal pseudoconsole)'}`)
      assert.ok(answer.hosted === null || (Number.isInteger(answer.hosted) && answer.hosted >= -1), `Hosted answers a count or -1: ${answer.hosted}`)
      const got = answer.clamp
      const wrong = CLAMP_PAIRS.map(([rect, work], i) => [rect, work, got[i], machine.clampToWork(rect, work)]).filter(([, , cs, ts]) => JSON.stringify(cs) !== JSON.stringify(ts))
      assert.deepEqual(wrong.map(([rect, work, cs, ts]) => `${JSON.stringify(rect)} in ${JSON.stringify(work)}: C# ${JSON.stringify(cs)}, TypeScript ${JSON.stringify(ts)}`), [])
    })
  }
})

/**
 * The test's own C#: reads alone, but for Start, which starts the test's own window and may end that one process
 * by the handle it holds. Never in the shipped code. Handles are compared and printed by their low 32 bits, the
 * part of a window handle that is significant (Programming Guide for 64-bit Windows, "Interprocess communication").
 */
const TEST_CS = [
  'using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;',
  'public static class ClaudeSelfToolsPlaceTest {',
  '[StructLayout(LayoutKind.Sequential)] public struct Box { public int Left; public int Top; public int Right; public int Bottom; }',
  '[StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public uint Size; public Box Whole; public Box Work; public uint Flags; }',
  '[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct StartupInfo { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }',
  '[StructLayout(LayoutKind.Sequential)] public struct ProcessInfo { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }',
  'public delegate bool EachWindow(IntPtr window, IntPtr data);',
  'public delegate bool EachMonitor(IntPtr monitor, IntPtr dc, ref Box box, IntPtr data);',
  '[DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();',
  '[DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint relation);',
  '[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr window, StringBuilder name, int size);',
  '[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Box box);',
  '[DllImport("user32.dll")] static extern bool IsZoomed(IntPtr window);',
  '[DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);',
  '[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint fallback);',
  '[DllImport("user32.dll")] static extern bool GetMonitorInfoW(IntPtr monitor, ref MonitorInfo info);',
  '[DllImport("user32.dll")] static extern bool EnumWindows(EachWindow each, IntPtr data);',
  '[DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, EachMonitor each, IntPtr data);',
  '[DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);',
  '[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string app, StringBuilder line, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string folder, ref StartupInfo startup, out ProcessInfo process);',
  '[DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);',
  '[DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);',
  '[DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);',
  '[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);',
  'static long Low(IntPtr window) { return window.ToInt64() & 0xffffffffL; }',
  'static string ClassOf(IntPtr window) { StringBuilder name = new StringBuilder(256); return GetClassNameW(window, name, name.Capacity) > 0 ? name.ToString() : ""; }',
  'static IntPtr Own() { IntPtr console = GetConsoleWindow(); if (console == IntPtr.Zero) return IntPtr.Zero; string kind = ClassOf(console); if (kind == "ConsoleWindowClass") return console; if (kind == "PseudoConsoleWindow") { IntPtr owner = GetWindow(console, 4); if (owner != IntPtr.Zero && ClassOf(owner) == "CASCADIA_HOSTING_WINDOW_CLASS") return owner; } return IntPtr.Zero; }',
  'public static string OwnKind() { IntPtr console = GetConsoleWindow(); if (console == IntPtr.Zero) return "no console window"; IntPtr owner = GetWindow(console, 4); return ClassOf(console) + (owner == IntPtr.Zero ? "" : " owned by " + ClassOf(owner)); }',
  'public static long OwnLow() { return Low(Own()); }',
  'public static long ConsoleLow() { return Low(GetConsoleWindow()); }',
  'public static int[] OwnRect() { IntPtr before = SetThreadDpiAwarenessContext(new IntPtr(-4)); try { Box box; if (!GetWindowRect(Own(), out box)) return new int[0]; return new int[] { box.Left, box.Top, box.Right - box.Left, box.Bottom - box.Top }; } finally { if (before != IntPtr.Zero) SetThreadDpiAwarenessContext(before); } }',
  'public static bool OwnZoomed() { return IsZoomed(Own()); }',
  'public static int[] OwnWork() { IntPtr before = SetThreadDpiAwarenessContext(new IntPtr(-4)); try { MonitorInfo info = new MonitorInfo(); info.Size = (uint)Marshal.SizeOf(typeof(MonitorInfo)); if (!GetMonitorInfoW(MonitorFromWindow(Own(), 2), ref info)) return new int[0]; return new int[] { info.Work.Left, info.Work.Top, info.Work.Right, info.Work.Bottom }; } finally { if (before != IntPtr.Zero) SetThreadDpiAwarenessContext(before); } }',
  'public static long Foreground() { return Low(GetForegroundWindow()); }',
  'public static bool Alive(long low) { return IsWindow(new IntPtr(low)); }',
  'public static long[] TopWindows() { List<long> all = new List<long>(); EachWindow each = delegate(IntPtr window, IntPtr data) { all.Add(Low(window)); return true; }; EnumWindows(each, IntPtr.Zero); GC.KeepAlive(each); return all.ToArray(); }',
  'public static string Monitors() { IntPtr before = SetThreadDpiAwarenessContext(new IntPtr(-4)); try { List<string> all = new List<string>(); EachMonitor each = delegate(IntPtr monitor, IntPtr dc, ref Box box, IntPtr data) { MonitorInfo info = new MonitorInfo(); info.Size = (uint)Marshal.SizeOf(typeof(MonitorInfo)); if (GetMonitorInfoW(monitor, ref info)) all.Add(info.Whole.Left + "," + info.Whole.Top + "," + info.Whole.Right + "," + info.Whole.Bottom + "," + info.Work.Left + "," + info.Work.Top + "," + info.Work.Right + "," + info.Work.Bottom + "," + (info.Flags & 1)); return true; }; EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, each, IntPtr.Zero); GC.KeepAlive(each); return string.Join(";", all.ToArray()); } finally { if (before != IntPtr.Zero) SetThreadDpiAwarenessContext(before); } }',
  'public static string Start(string app, string line, uint limitMs) { StartupInfo startup = new StartupInfo(); startup.cb = Marshal.SizeOf(typeof(StartupInfo)); startup.dwFlags = 1; startup.wShowWindow = 4; ProcessInfo process; if (!CreateProcessW(app, new StringBuilder(line), IntPtr.Zero, IntPtr.Zero, false, 0x10, IntPtr.Zero, null, ref startup, out process)) return "not started, error " + Marshal.GetLastWin32Error(); try { bool ended = WaitForSingleObject(process.hProcess, limitMs) == 0; if (!ended) { TerminateProcess(process.hProcess, 1); WaitForSingleObject(process.hProcess, 5000); } uint code; GetExitCodeProcess(process.hProcess, out code); return (ended ? "ended " : "ended by the test ") + code; } finally { CloseHandle(process.hThread); CloseHandle(process.hProcess); } }',
  '}',
].join(' ')

/** The monitors, as the test's C# reads them, DPI aware: each `{ monitor, work, primary }`. */
function monitors() {
  const ran = hidden([`Add-Type -ErrorAction Stop -TypeDefinition ${psq(TEST_CS)}`, '[Console]::Out.WriteLine([ClaudeSelfToolsPlaceTest]::Monitors())'].join('\r\n'))
  assert.equal(ran.code, 0, `${ran.out}${ran.err}`)
  return ran.out
    .trim()
    .split(';')
    .map(row => row.split(',').map(Number))
    .map(n => ({ monitor: n.slice(0, 4), work: n.slice(4, 8), primary: n[8] === 1 }))
}

const near = (got, want, tolerance) => Math.abs(got - want) <= tolerance
const rectNear = (got, want) => Array.isArray(got) && got.length === 4 && near(got[0], want[0], POS_TOLERANCE) && near(got[1], want[1], POS_TOLERANCE) && near(got[2], want[2], SIZE_TOLERANCE) && near(got[3], want[3], SIZE_TOLERANCE)

let work

/**
 * Opens one window of this test's, which runs only `windowScript`'s lines and ends by itself, and waits for it to
 * end and its window to be gone. Its answer: what the window wrote, and the starter's own record.
 */
function openWindow(place) {
  const dir = mkdtempSync(join(work, 'window-'))
  const files = { script: join(dir, 'window.ps1'), result: join(dir, 'result.json'), existing: join(dir, 'existing.json') }
  for (const path of Object.values(files)) assert.ok(!/['"]/.test(path), 'no quote in a path the scripts name')
  const lines = [
    '$ErrorActionPreference = "Stop"',
    '$result = [ordered]@{}',
    'try {',
    `  Add-Type -ErrorAction Stop -TypeDefinition ${psq(TEST_CS)}`,
    '  $result.own = [ClaudeSelfToolsPlaceTest]::OwnLow()',
    '  $result.console = [ClaudeSelfToolsPlaceTest]::ConsoleLow()',
    '  $result.kind = [ClaudeSelfToolsPlaceTest]::OwnKind()',
    '  $result.frontAtStart = [ClaudeSelfToolsPlaceTest]::Foreground()',
    // Windows PowerShell 5.1's ConvertFrom-Json hands a JSON array on as one object: @() of the variable, not of the pipeline.
    `  $existing = [IO.File]::ReadAllText(${psq(files.existing)}) | ConvertFrom-Json`,
    '  if ($result.own -eq 0) { $result.skipped = "no window of its own was found: its console is " + $result.kind }',
    '  elseif (@($existing) -contains $result.own) { $result.skipped = "its window was open before it started (the terminal put it in a tab of an existing window), so nothing is placed" }',
    '  else {',
    '    $result.rectBefore = [ClaudeSelfToolsPlaceTest]::OwnRect()',
    ...(place === undefined
      ? ['    Start-Sleep -Milliseconds 2000']
      : [
          ...machine.windowPlaceLines(place).map(line => `    ${line}`),
          '    $result.placeSaid = $placeSaid',
          // SetWindowPos and ShowWindowAsync are posted to the window's own thread: looked at until it moved or maximized, at most 3 s.
          '    for ($look = 0; $look -lt 30; $look++) { if ([ClaudeSelfToolsPlaceTest]::OwnZoomed() -or (@([ClaudeSelfToolsPlaceTest]::OwnRect()) -join ",") -ne ($result.rectBefore -join ",")) { break }; Start-Sleep -Milliseconds 100 }',
          '    Start-Sleep -Milliseconds 300',
        ]),
    // The consoles its own window holds, by the shipped Hosted (1 in a fresh window), for a pseudoconsole's window alone.
    `    if (-not ("ClaudeSelfToolsPlace" -as [type])) { Add-Type -ErrorAction Stop -TypeDefinition ${psq(machine.PLACE_CS)} }`,
    '    if ($result.kind -like "PseudoConsoleWindow*") { $result.hosted = [ClaudeSelfToolsPlace]::Hosted([IntPtr]::new([long]$result.own), [IntPtr]::new([long]$result.console)) }',
    '    $result.rectAfter = [ClaudeSelfToolsPlaceTest]::OwnRect()',
    '    $result.zoomed = [ClaudeSelfToolsPlaceTest]::OwnZoomed()',
    '    $result.work = [ClaudeSelfToolsPlaceTest]::OwnWork()',
    '    $result.frontAfter = [ClaudeSelfToolsPlaceTest]::Foreground()',
    '  }',
    '} catch { $result.error = $_.Exception.Message }',
    `[IO.File]::WriteAllText(${psq(files.result)}, (ConvertTo-Json -Compress -Depth 4 -InputObject $result))`,
    'exit 0',
  ]
  // UTF-8 with its byte order mark, as the launch writes a window's script: Windows PowerShell reads it as UTF-8.
  writeFileSync(files.script, `\ufeff${lines.join('\r\n')}`)
  const line = `"${WINDOWS_POWERSHELL}" -NoProfile -ExecutionPolicy Bypass -File "${files.script}"`
  const starter = [
    `Add-Type -ErrorAction Stop -TypeDefinition ${psq(TEST_CS)}`,
    `[IO.File]::WriteAllText(${psq(files.existing)}, (ConvertTo-Json -Compress -InputObject @([ClaudeSelfToolsPlaceTest]::TopWindows())))`,
    '$frontBefore = [ClaudeSelfToolsPlaceTest]::Foreground()',
    `$started = [ClaudeSelfToolsPlaceTest]::Start(${psq(WINDOWS_POWERSHELL)}, ${psq(line)}, [uint32]${WINDOW_LIMIT_MS})`,
    '$gone = $null',
    `if (Test-Path -LiteralPath ${psq(files.result)}) { $own = [long](([IO.File]::ReadAllText(${psq(files.result)}) | ConvertFrom-Json).own); if ($own -ne 0) { $gone = $false; for ($look = 0; $look -lt 50; $look++) { if (-not [ClaudeSelfToolsPlaceTest]::Alive($own)) { $gone = $true; break }; Start-Sleep -Milliseconds 100 } } }`,
    '[Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject ([ordered]@{ frontBefore = $frontBefore; started = $started; gone = $gone })))',
  ].join('\r\n')
  const ran = hidden(starter, WINDOWS_POWERSHELL, LIVE_EACH_MS + 10_000)
  assert.equal(ran.code, 0, `${ran.out}${ran.err}`)
  const record = JSON.parse(ran.out.trim().split(/\r?\n/).at(-1))
  assert.ok(existsSync(files.result), `the window wrote nothing (${record.started})`)
  const result = JSON.parse(readFileSync(files.result, 'utf8').replace(/^\ufeff/, ''))
  return { result, record }
}

/** The window in front, said as a fact for the report: before the window started, as it began, and after its place. */
function sayFront(t, { result, record }) {
  const what = handle => (handle === result.own ? 'the new window' : handle === record.frontBefore ? 'the one in front before' : handle === 0 ? 'none' : 'another window')
  t.diagnostic(`the window in front: before it started ${record.frontBefore}; as it began ${result.frontAtStart} (${what(result.frontAtStart)}); after its place ${result.frontAfter} (${what(result.frontAfter)})`)
}

/** The checks every live window gets: it ended by itself, and its window is gone; a window that was open before is a skip. */
function settled(t, opened) {
  const { result, record } = opened
  assert.equal(result.error, undefined, result.error)
  assert.match(record.started, /^ended /, 'the window ended')
  assert.ok(!record.started.startsWith('ended by the test'), `the window did not end by itself within ${WINDOW_LIMIT_MS / 1000} s, so the test ended it`)
  // A window that was open before (not this test's) is never asked to be gone.
  if (result.skipped !== undefined) {
    t.skip(result.skipped)
    return false
  }
  assert.equal(record.gone, true, 'its window is gone (Windows Terminal closes a tab whose process ends with 0 when closeOnExit is automatic; if it stays, close it by hand)')
  sayFront(t, opened)
  // A pseudoconsole's window: the consoles it holds, counted by the shipped Hosted, as a fact; in a fresh window, 1.
  if (typeof result.kind === 'string' && result.kind.startsWith('PseudoConsoleWindow')) {
    t.diagnostic(`the consoles its window holds (Hosted): ${result.hosted}`)
    assert.equal(result.hosted, 1, 'a fresh window holds its own console alone')
  }
  // A terminal set to open its windows maximized (Windows Terminal's launchMode): the shipped code leaves such a window as it is.
  if (typeof result.placeSaid === 'string' && result.placeSaid.startsWith('it opened minimized or maximized')) {
    t.skip(`the window opened maximized or minimized, so the shipped code left it as it is: ${result.placeSaid}`)
    return false
  }
  return true
}

const liveSkip = !isWindows ? 'Windows only' : process.env.SELF_PLACE_LIVE !== '1' ? 'opens real windows on the screen: only in a run arranged for it, with SELF_PLACE_LIVE=1' : policySkip(WINDOWS_POWERSHELL)

describe('the plain window places itself, live (#5)', { skip: liveSkip, concurrency: 1 }, () => {
  let screens
  before(() => {
    process.stdout.write(`window-place-live: opens ${LIVE_WINDOWS} windows, one at a time, each running only this test's script, which ends by itself (at most ${WINDOW_LIMIT_MS / 1000} s, when the test ends it); about ${LIVE_EACH_MS / 1000} s each at most, ${(LIVE_WINDOWS * LIVE_EACH_MS) / 1000} s in all.\n`)
    work = mkdtempSync(join(tmpdir(), 'window-place-'))
    screens = monitors()
    assert.ok(screens.length > 0 && screens.some(s => s.primary), 'the monitors read')
  })
  after(() => {
    if (work !== undefined) rmSync(work, { recursive: true, force: true })
  })

  test('a placed window: its frame at the rectangle asked for (GetWindowRect, within the tolerances)', t => {
    const [l, top] = screens.find(s => s.primary).work
    const rect = [l + 120, top + 90, 640, 400]
    const opened = openWindow({ rect })
    if (!settled(t, opened)) return
    assert.equal(opened.result.placeSaid, 'placed')
    assert.ok(rectNear(opened.result.rectAfter, rect), `${JSON.stringify(opened.result.rectAfter)} for ${JSON.stringify(rect)}`)
  })

  test('maximized with a rectangle: maximized on the monitor that holds the rectangle', t => {
    const primary = screens.find(s => s.primary)
    const rect = [primary.work[0] + 100, primary.work[1] + 100, 640, 400]
    const opened = openWindow({ rect, maximized: true })
    if (!settled(t, opened)) return
    assert.equal(opened.result.placeSaid, 'placed')
    assert.equal(opened.result.zoomed, true, 'maximized')
    assert.deepEqual(opened.result.work, primary.work, "on the primary's work area, which holds the rectangle")
  })

  test('a rectangle off every monitor: brought wholly onto one', t => {
    const rect = [30000, 30000, 640, 400]
    const [x, y, w, h] = rect
    if (screens.some(({ monitor: [l, top, r, b] }) => x < r && x + w > l && y < b && y + h > top)) return t.skip('a monitor reaches 30000,30000 here, so the rectangle is not off every monitor')
    const opened = openWindow({ rect })
    if (!settled(t, opened)) return
    assert.equal(opened.result.placeSaid, 'placed')
    const [gx, gy, gw, gh] = opened.result.rectAfter
    const [wl, wt, wr, wb] = opened.result.work
    assert.ok(gx >= wl - POS_TOLERANCE && gy >= wt - POS_TOLERANCE && gx + gw <= wr + POS_TOLERANCE && gy + gh <= wb + POS_TOLERANCE, `${JSON.stringify(opened.result.rectAfter)} inside ${JSON.stringify(opened.result.work)}`)
    t.diagnostic(`Windows put it on the work area ${JSON.stringify(opened.result.work)}; the model's choice (clampToMonitors) is ${JSON.stringify(machine.clampToMonitors(rect, screens))}`)
  })

  test('an unplaced window is not moved', t => {
    const opened = openWindow(undefined)
    if (!settled(t, opened)) return
    assert.equal(opened.result.placeSaid, undefined, 'no placing line ran')
    assert.deepEqual(opened.result.rectAfter, opened.result.rectBefore, 'where it opened, 2 s later')
  })
})
