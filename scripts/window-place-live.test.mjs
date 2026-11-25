// The plain window placing itself (#5), on Windows. Two parts.
//
// 1. No window (Windows only): the window's own C# (machine.PLACE_CS) compiled by Add-Type in a hidden Windows
//    PowerShell 5.1, and in PowerShell 7 where it is installed, and its Clamp held to clampToWork row for row:
//    every row compared in one run, each that differs listed. Only Clamp, and Hosted (a read), are called: nothing
//    acts on a window. A hidden shell is started with no console window (windowsHide), so, as expected, Hosted has
//    nothing to count there; the test records what it found. This is also the first time the C# is compiled through
//    a script block, so an antivirus that blocks it through AMSI shows here first, with its message.
//
// 2. Live (Windows only, and only with SELF_PLACE_LIVE=1, in a run arranged for it): four tests, each opening ONE
//    plain window of its own, one at a time: a new console started by CreateProcess (CREATE_NEW_CONSOLE), which
//    Windows hands to the default terminal as it hands a launch's window. The window runs in the shell a launch's
//    window would get on this machine, decided by the shipped rule's own lines (machine.WINDOW_SHELL_RULE, read as a
//    launch reads it), and each record names it. It runs only a script of this test's, which ends by itself: it
//    loads the test's C# from a DLL compiled once, before the run, in that same shell (Add-Type -Path, no compile);
//    records as its first act whether its pseudoconsole has an owner yet, and when; finds its own window as the
//    shipped code does; runs the shipped placing lines (machine.windowPlaceLines, byte for byte) when the test gives
//    a place; waits, polling every POLL_MS up to SETTLE_LIMIT_MS, for the state the test asks for, and records how
//    long that took; reads back where its window is; writes that to a file; and exits. The test confirms the window
//    is gone.
//    Never wt.exe, never a named window, never the person's own windows: a window the script finds that was open
//    before it started (a terminal that put it in a tab of an existing window) is left alone, nothing placed. That
//    guard is the test's own, and comes before the placing lines; it records there what the shipped count (Hosted, a
//    pure read; never Place) says of that window, and fails when the count is 1, which would have let the shipped
//    code move it. The shipped code's own guard: it places a Windows Terminal window only when it holds this console
//    alone (Hosted, which lists the top-level windows once, reads each one's class name, reads the owner of those
//    that are pseudoconsole windows, acts on none, and is there to refuse, never to choose a target; no title is
//    read). Each fresh window records that count, and is held to 1. The test's own listing (TopWindows, to know
//    which windows were open before) is in its starter, and serves the test alone.
//    Focus: the window is asked to open without being activated (STARTUPINFO's wShowWindow = SW_SHOWNOACTIVATE,
//    with STARTF_USESHOWWINDOW). Whether the default terminal honours that is not known; the test records the
//    window in front before the window starts, as it begins, and after its place, as a reported fact, never a
//    failure. A maximized window is activated by SW_MAXIMIZE, as ShowWindow's page says.
//    Read back with GetWindowRect (the frame SetWindowPos sets, invisible resize borders included), per-monitor
//    DPI aware, within POS_TOLERANCE pixels for x and y and SIZE_TOLERANCE for width and height: estimates, the
//    second for a classic console that may round its size to whole character cells.
//    What a pass still does not show: any count but 1, or the shipped refusal (no window with two consoles is made,
//    unless the terminal puts a test's console in one that has them, which the guard records); the count's blind
//    spots (tabs with no console, a tab still arriving, a tab arriving between the count and the place); the
//    classic console's path, unless this machine's default terminal is the console host; the shipped window's own
//    timing to the place exactly (this window loads a DLL and runs its guard first: the record gives the owner at
//    its first look and at its place); the restore rectangle of a maximized window (recorded, not asserted); a move
//    later than the unplaced test's observation window; monitors at different scales; a full-screen window.
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

/** How many windows part 2 opens, and how long each may take at most (an estimate: the DLL's load, the place's compile, the wait, the close). */
const LIVE_WINDOWS = 4
const LIVE_EACH_MS = 25_000
/** The window is ended by the test's starter if it hasn't ended by itself by then (it ends itself within about 12 s). */
const WINDOW_LIMIT_MS = 20_000
/** How long a placed window waits for the state its test asks for, looking every POLL_MS. */
const SETTLE_LIMIT_MS = 5000
const POLL_MS = 50
/** How long the unplaced window is watched for a move: a stated window, not a wait for a state; a move later than it is not seen. */
const WATCH_MS = 2000
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
    test(`${name}: PLACE_CS compiles, every row of Clamp is clampToWork's; Hosted is read for this hidden shell's console, which, started with no console window, it is expected to have none of, so nothing is counted`, t => {
      if (!existsSync(shell)) return t.skip(`${name} is not installed here`)
      const calls = CLAMP_PAIRS.map(([[x, y, w, h], [l, tp, r, b]]) => `@([ClaudeSelfToolsPlace]::Clamp([int]${x}, [int]${y}, [int]${w}, [int]${h}, [int]${l}, [int]${tp}, [int]${r}, [int]${b}))`)
      const script = [
        `Add-Type -ErrorAction Stop -TypeDefinition ${psq(machine.PLACE_CS)}`,
        `Add-Type -ErrorAction Stop -TypeDefinition ${psq(TEST_CS)}`,
        // Hosted, a pure read, only where this hidden shell has a Windows Terminal window over its console (expected: none).
        '$kind = [ClaudeSelfToolsPlaceTest]::OwnKind()',
        '$owner = [long][ClaudeSelfToolsPlaceTest]::OwnLow()',
        '$hosted = $null',
        'if ($owner -ne 0) { $hosted = [ClaudeSelfToolsPlace]::Hosted([IntPtr]::new($owner), [IntPtr]::new([long][ClaudeSelfToolsPlaceTest]::ConsoleLow())) }',
        `[Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 4 -InputObject ([ordered]@{ clamp = @(${calls.join(', ')}); kind = $kind; hosted = $hosted })))`,
      ].join('\r\n')
      const ran = hidden(script, shell)
      assert.equal(ran.code, 0, `${ran.out}${ran.err}`)
      const answer = JSON.parse(ran.out.trim().split(/\r?\n/).at(-1))
      t.diagnostic(answer.kind === 'no console window' ? 'this hidden shell has no console window, so nothing is counted here' : `this hidden shell's console: ${answer.kind}; Hosted: ${answer.hosted ?? 'not counted (no Windows Terminal window owns it)'}`)
      assert.ok(answer.hosted === null || (Number.isInteger(answer.hosted) && answer.hosted >= -1), `Hosted answers a count or -1: ${JSON.stringify(answer)}`)
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
  '[StructLayout(LayoutKind.Sequential)] public struct Placement { public int Length; public int Flags; public int ShowCmd; public int MinX; public int MinY; public int MaxX; public int MaxY; public Box Normal; }',
  '[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct StartupInfo { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }',
  '[StructLayout(LayoutKind.Sequential)] public struct ProcessInfo { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }',
  'public delegate bool EachWindow(IntPtr window, IntPtr data);',
  'public delegate bool EachMonitor(IntPtr monitor, IntPtr dc, ref Box box, IntPtr data);',
  '[DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();',
  '[DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint relation);',
  '[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr window, StringBuilder name, int size);',
  '[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Box box);',
  '[DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr window, ref Placement place);',
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
  'public static long OwnerLow() { IntPtr console = GetConsoleWindow(); return console == IntPtr.Zero ? 0 : Low(GetWindow(console, 4)); }',
  'public static int[] OwnRect() { IntPtr before = SetThreadDpiAwarenessContext(new IntPtr(-4)); try { Box box; if (!GetWindowRect(Own(), out box)) return new int[0]; return new int[] { box.Left, box.Top, box.Right - box.Left, box.Bottom - box.Top }; } finally { if (before != IntPtr.Zero) SetThreadDpiAwarenessContext(before); } }',
  'public static int[] OwnNormal() { IntPtr before = SetThreadDpiAwarenessContext(new IntPtr(-4)); try { Placement place = new Placement(); place.Length = Marshal.SizeOf(typeof(Placement)); if (!GetWindowPlacement(Own(), ref place)) return new int[0]; return new int[] { place.Normal.Left, place.Normal.Top, place.Normal.Right - place.Normal.Left, place.Normal.Bottom - place.Normal.Top }; } finally { if (before != IntPtr.Zero) SetThreadDpiAwarenessContext(before); } }',
  'public static bool OwnZoomed() { return IsZoomed(Own()); }',
  'public static int[] OwnWork() { IntPtr before = SetThreadDpiAwarenessContext(new IntPtr(-4)); try { MonitorInfo info = new MonitorInfo(); info.Size = (uint)Marshal.SizeOf(typeof(MonitorInfo)); if (!GetMonitorInfoW(MonitorFromWindow(Own(), 2), ref info)) return new int[0]; return new int[] { info.Work.Left, info.Work.Top, info.Work.Right, info.Work.Bottom }; } finally { if (before != IntPtr.Zero) SetThreadDpiAwarenessContext(before); } }',
  'public static long Foreground() { return Low(GetForegroundWindow()); }',
  'public static bool Alive(long low) { return IsWindow(new IntPtr(low)); }',
  'public static long[] TopWindows() { List<long> all = new List<long>(); EachWindow each = delegate(IntPtr window, IntPtr data) { all.Add(Low(window)); return true; }; EnumWindows(each, IntPtr.Zero); GC.KeepAlive(each); return all.ToArray(); }',
  'public static string Monitors() { IntPtr before = SetThreadDpiAwarenessContext(new IntPtr(-4)); try { List<string> all = new List<string>(); EachMonitor each = delegate(IntPtr monitor, IntPtr dc, ref Box box, IntPtr data) { MonitorInfo info = new MonitorInfo(); info.Size = (uint)Marshal.SizeOf(typeof(MonitorInfo)); if (GetMonitorInfoW(monitor, ref info)) all.Add(info.Whole.Left + "," + info.Whole.Top + "," + info.Whole.Right + "," + info.Whole.Bottom + "," + info.Work.Left + "," + info.Work.Top + "," + info.Work.Right + "," + info.Work.Bottom + "," + (info.Flags & 1)); return true; }; EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, each, IntPtr.Zero); GC.KeepAlive(each); return string.Join(";", all.ToArray()); } finally { if (before != IntPtr.Zero) SetThreadDpiAwarenessContext(before); } }',
  'public static string Start(string app, string line, uint limitMs) { StartupInfo startup = new StartupInfo(); startup.cb = Marshal.SizeOf(typeof(StartupInfo)); startup.dwFlags = 1; startup.wShowWindow = 4; ProcessInfo process; if (!CreateProcessW(app, new StringBuilder(line), IntPtr.Zero, IntPtr.Zero, false, 0x10, IntPtr.Zero, null, ref startup, out process)) return "not started, error " + Marshal.GetLastWin32Error(); try { bool ended = WaitForSingleObject(process.hProcess, limitMs) == 0; if (!ended) { TerminateProcess(process.hProcess, 1); WaitForSingleObject(process.hProcess, 5000); } uint code; GetExitCodeProcess(process.hProcess, out code); return (ended ? "ended " : "ended by the test ") + code; } finally { CloseHandle(process.hThread); CloseHandle(process.hProcess); } }',
  '}',
].join(' ')

/**
 * The shell a launch's window would run in on this machine, decided by the shipped rule's own lines: Windows
 * PowerShell's Group Policy read (READ_GROUP_POLICY), then WINDOW_SHELL_RULE from `$windowShell` set to Windows
 * PowerShell by its known path, in Windows PowerShell, as a launch runs them. Its path, or why it couldn't be read.
 */
function shippedWindowShell() {
  const ran = hidden([...machine.READ_GROUP_POLICY, `$windowShell = ${psq(WINDOWS_POWERSHELL)}`, ...machine.WINDOW_SHELL_RULE, '[Console]::Out.WriteLine($windowShell)'].join('\r\n'))
  const shell = ran.out.trim().split(/\r?\n/).at(-1) ?? ''
  return ran.code === 0 && existsSync(shell) ? { shell } : { why: `the shipped shell rule gave no shell (exit ${ran.code}): ${ran.out}${ran.err}` }
}

const near = (got, want, tolerance) => Math.abs(got - want) <= tolerance
const rectNear = (got, want) => Array.isArray(got) && got.length === 4 && near(got[0], want[0], POS_TOLERANCE) && near(got[1], want[1], POS_TOLERANCE) && near(got[2], want[2], SIZE_TOLERANCE) && near(got[3], want[3], SIZE_TOLERANCE)
/** Whether a window's frame covers a work area ([left, top, right, bottom]): a maximized frame reaches past it by its borders. */
const covers = ([x, y, w, h], [l, t, r, b]) => x <= l + POS_TOLERANCE && y <= t + POS_TOLERANCE && x + w >= r - POS_TOLERANCE && y + h >= b - POS_TOLERANCE

/** The whole record of a window, for every assertion's message. */
const seen = opened => JSON.stringify(opened)

/** The test's C# type, as the scripts name it. */
const T = '[ClaudeSelfToolsPlaceTest]'

const liveWanted = isWindows && process.env.SELF_PLACE_LIVE === '1'
/** Read once, only for a live run: the shell its windows run in. */
const LIVE = liveWanted ? shippedWindowShell() : undefined
const liveSkip = !isWindows ? 'Windows only' : !liveWanted ? 'opens real windows on the screen: only in a run arranged for it, with SELF_PLACE_LIVE=1' : LIVE?.shell === undefined ? false : policySkip(LIVE.shell)

let work
/** The test's C#, compiled once to a DLL, in the shell that loads it. */
let dll

/**
 * Opens one window of this test's, which runs only these lines and ends by itself, and waits for it to end and its
 * window to be gone. `plan`: `{ place, until }` (the shipped placing lines for `place`, then a wait for the PowerShell
 * condition `until`); `{ variants, until }` (one variant of the shipped lines per monitor, `{ work, place }`, of which
 * the window runs the first for a monitor it did not open on, else the first); or `{ watch: true }` (no place, watched
 * for WATCH_MS). `prelude`: PowerShell functions `until` may call. Its answer: what the window wrote, and the starter's record.
 */
function openWindow(plan) {
  const dir = mkdtempSync(join(work, 'window-'))
  const files = { script: join(dir, 'window.ps1'), result: join(dir, 'result.json'), existing: join(dir, 'existing.json') }
  for (const path of [...Object.values(files), dll]) assert.ok(!/['"]/.test(path), 'no quote in a path the scripts name')
  const variantLines = variants => [
    `$opened = (@(${T}::OwnWork()) -join ",")`,
    '$chosen = $null',
    ...variants.flatMap(({ work: w, place }) => [
      `if ($null -eq $chosen -and $opened -ne '${w.join(',')}') {`,
      `$chosen = '${w.join(',')}'`,
      '$result.monitorChoice = "shown: another monitor than the one it opened on"',
      // The shipped lines, byte for byte, unindented.
      ...machine.windowPlaceLines(place),
      '}',
    ]),
    'if ($null -eq $chosen) {',
    `$chosen = '${variants[0].work.join(',')}'`,
    '$result.monitorChoice = "not shown: it opened on the one monitor there is"',
    ...machine.windowPlaceLines(variants[0].place),
    '}',
    '$result.chosenWork = $chosen',
  ]
  const lines = [
    '$ErrorActionPreference = "Stop"',
    '$result = [ordered]@{}',
    '$clock = [Diagnostics.Stopwatch]::StartNew()',
    `function Test-Near($got, $want) { $got = @($got); $want = @($want); if ($got.Count -ne 4 -or $want.Count -ne 4) { return $false }; return ([math]::Abs($got[0] - $want[0]) -le ${POS_TOLERANCE} -and [math]::Abs($got[1] - $want[1]) -le ${POS_TOLERANCE} -and [math]::Abs($got[2] - $want[2]) -le ${SIZE_TOLERANCE} -and [math]::Abs($got[3] - $want[3]) -le ${SIZE_TOLERANCE}) }`,
    ...(plan.prelude ?? []),
    'try {',
    `  Add-Type -ErrorAction Stop -Path ${psq(dll)}`,
    // Its first act (WP-M-2): whether its pseudoconsole has an owner yet, and when, from this script's first line and from its process's start.
    `  $result.ownerAtFirstLook = ${T}::OwnerLow()`,
    '  $result.firstLookMs = $clock.ElapsedMilliseconds',
    '  $result.firstLookAfterStartMs = [long]([DateTime]::Now - [Diagnostics.Process]::GetCurrentProcess().StartTime).TotalMilliseconds',
    '  $result.shell = "" + $PSVersionTable.PSEdition + " " + $PSVersionTable.PSVersion + " (" + [Diagnostics.Process]::GetCurrentProcess().Path + ")"',
    `  $result.own = ${T}::OwnLow()`,
    `  $result.console = ${T}::ConsoleLow()`,
    `  $result.kind = ${T}::OwnKind()`,
    `  $result.frontAtStart = ${T}::Foreground()`,
    // Windows PowerShell 5.1's ConvertFrom-Json hands a JSON array on as one object: @() of the variable, not of the pipeline.
    `  $existing = [IO.File]::ReadAllText(${psq(files.existing)}) | ConvertFrom-Json`,
    '  if ($result.own -eq 0) { $result.skipped = "no window of its own was found: its console is " + $result.kind }',
    '  elseif (@($existing) -contains $result.own) {',
    '    $result.skipped = "its window was open before it started (the terminal put it in a tab of an existing window), so nothing is placed"',
    '    $result.existingWindow = $true',
    // The shipped count of that window, a pure read (never Place): what the shipped code would have decided.
    `    if ($result.kind -like "PseudoConsoleWindow*") { Add-Type -ErrorAction Stop -TypeDefinition ${psq(machine.PLACE_CS)}; $result.hosted = [ClaudeSelfToolsPlace]::Hosted([IntPtr]::new([long]$result.own), [IntPtr]::new([long]$result.console)) }`,
    '  }',
    '  else {',
    `    $result.rectBefore = @(${T}::OwnRect())`,
    `    $result.workBefore = @(${T}::OwnWork())`,
    `    $result.ownerAtPlace = ${T}::OwnerLow()`,
    '    $result.placeStartMs = $clock.ElapsedMilliseconds',
    ...(plan.watch === true
      ? [`    Start-Sleep -Milliseconds ${WATCH_MS}`, `    $result.watchedMs = ${WATCH_MS}`]
      : [
          ...(plan.variants !== undefined ? variantLines(plan.variants) : machine.windowPlaceLines(plan.place)),
          '    $result.placeEndMs = $clock.ElapsedMilliseconds',
          '    $result.placeSaid = $placeSaid',
          // SetWindowPos and ShowWindowAsync are posted to the window's own thread: polled until the state asked for, at most SETTLE_LIMIT_MS.
          '    $result.settledMs = $null',
          `    $result.settleLimitMs = ${SETTLE_LIMIT_MS}`,
          '    $settle = [Diagnostics.Stopwatch]::StartNew()',
          `    while ($settle.ElapsedMilliseconds -lt ${SETTLE_LIMIT_MS}) { if (${plan.until}) { $result.settledMs = $settle.ElapsedMilliseconds; break }; Start-Sleep -Milliseconds ${POLL_MS} }`,
        ]),
    // The consoles its own window holds, by the shipped Hosted (1 in a fresh window), for a pseudoconsole's window alone.
    `    if (-not ("ClaudeSelfToolsPlace" -as [type])) { Add-Type -ErrorAction Stop -TypeDefinition ${psq(machine.PLACE_CS)} }`,
    '    if ($result.kind -like "PseudoConsoleWindow*") { $result.hosted = [ClaudeSelfToolsPlace]::Hosted([IntPtr]::new([long]$result.own), [IntPtr]::new([long]$result.console)) }',
    `    $result.rectAfter = @(${T}::OwnRect())`,
    `    $result.zoomed = ${T}::OwnZoomed()`,
    `    $result.work = @(${T}::OwnWork())`,
    // The restore rectangle, a read: GetWindowPlacement's normal rectangle, in its own coordinates (workspace ones, from memory).
    `    $result.normal = @(${T}::OwnNormal())`,
    `    $result.frontAfter = ${T}::Foreground()`,
    '  }',
    '} catch { $result.error = $_.Exception.Message }',
    `[IO.File]::WriteAllText(${psq(files.result)}, (ConvertTo-Json -Compress -Depth 4 -InputObject $result))`,
    'exit 0',
  ]
  // UTF-8 with its byte order mark, as the launch writes a window's script: Windows PowerShell reads it as UTF-8.
  writeFileSync(files.script, `\ufeff${lines.join('\r\n')}`)
  const line = `"${LIVE.shell}" -NoProfile -ExecutionPolicy Bypass -File "${files.script}"`
  const starter = [
    `Add-Type -ErrorAction Stop -Path ${psq(dll)}`,
    `[IO.File]::WriteAllText(${psq(files.existing)}, (ConvertTo-Json -Compress -InputObject @(${T}::TopWindows())))`,
    `$frontBefore = ${T}::Foreground()`,
    `$started = ${T}::Start(${psq(LIVE.shell)}, ${psq(line)}, [uint32]${WINDOW_LIMIT_MS})`,
    '$gone = $null',
    `if (Test-Path -LiteralPath ${psq(files.result)}) { $own = [long](([IO.File]::ReadAllText(${psq(files.result)}) | ConvertFrom-Json).own); if ($own -ne 0) { $gone = $false; for ($look = 0; $look -lt 50; $look++) { if (-not ${T}::Alive($own)) { $gone = $true; break }; Start-Sleep -Milliseconds 100 } } }`,
    '[Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject ([ordered]@{ frontBefore = $frontBefore; started = $started; gone = $gone })))',
  ].join('\r\n')
  const ran = hidden(starter, LIVE.shell, LIVE_EACH_MS + 10_000)
  assert.equal(ran.code, 0, `${ran.out}${ran.err}`)
  const record = JSON.parse(ran.out.trim().split(/\r?\n/).at(-1))
  assert.ok(existsSync(files.result), `the window wrote nothing (${record.started})`)
  const result = JSON.parse(readFileSync(files.result, 'utf8').replace(/^\ufeff/, ''))
  return { result, record }
}

/** The facts every window reports: the shell, the owner's timing, the place's, the wait's, the count, the window in front. */
function sayFacts(t, { result, record }) {
  const what = handle => (handle === result.own ? 'the new window' : handle === record.frontBefore ? 'the one in front before' : handle === 0 ? 'none' : 'another window')
  t.diagnostic(`shell: ${result.shell}`)
  t.diagnostic(`its pseudoconsole's owner at its first look: ${result.ownerAtFirstLook === 0 ? 'not set yet' : 'set'}, ${result.firstLookMs} ms into its script, ${result.firstLookAfterStartMs} ms after its process started; at its place: ${result.ownerAtPlace === 0 ? 'not set' : 'set'}`)
  if (result.placeStartMs !== undefined) t.diagnostic(`its place began ${result.placeStartMs} ms into its script${result.placeEndMs === undefined ? '' : ` and its lines ended at ${result.placeEndMs} ms`}; the state asked for came ${result.settledMs === null || result.settledMs === undefined ? `not within ${result.settleLimitMs} ms` : `${result.settledMs} ms later`}`)
  if (result.hosted !== undefined) t.diagnostic(`the consoles its window holds (Hosted): ${result.hosted}`)
  t.diagnostic(`the window in front: before it started ${record.frontBefore}; as it began ${result.frontAtStart} (${what(result.frontAtStart)}); after its place ${result.frontAfter} (${what(result.frontAfter)})`)
}

/** The checks every live window gets: it ended by itself, and its window is gone; a window that was open before is a skip, unless the shipped count would have let it be moved. */
function settled(t, opened) {
  const { result, record } = opened
  assert.equal(result.error, undefined, seen(opened))
  assert.match(record.started, /^ended /, `the window ended: ${seen(opened)}`)
  assert.ok(!record.started.startsWith('ended by the test'), `the window did not end by itself within ${WINDOW_LIMIT_MS / 1000} s, so the test ended it: ${seen(opened)}`)
  // A window that was open before (not this test's) is never asked to be gone, and never placed.
  if (result.skipped !== undefined) {
    if (result.existingWindow === true && typeof result.kind === 'string' && result.kind.startsWith('PseudoConsoleWindow')) {
      assert.notEqual(result.hosted, 1, `the shipped code would have moved this window, which was open before the test started: its count of consoles is 1 (${seen(opened)})`)
    }
    t.skip(`${result.skipped}${result.hosted === undefined ? '' : `; the shipped count of that window's consoles: ${result.hosted}, so the shipped code leaves it too`}`)
    return false
  }
  assert.equal(record.gone, true, `its window is gone (Windows Terminal's closeOnExit, "automatic" by default, closes a handed-off process's tab as "always" does, whatever its exit code; under "never" it stays, and must be closed by hand): ${seen(opened)}`)
  sayFacts(t, opened)
  // A pseudoconsole's window: the consoles it holds, counted by the shipped Hosted; in a fresh window, 1.
  if (typeof result.kind === 'string' && result.kind.startsWith('PseudoConsoleWindow')) assert.equal(result.hosted, 1, `a fresh window holds its own console alone: ${seen(opened)}`)
  // A terminal set to open its windows maximized (Windows Terminal's launchMode): the shipped code leaves such a window as it is when a rect is asked.
  if (typeof result.placeSaid === 'string' && result.placeSaid.startsWith('it opened minimized or maximized')) {
    t.skip(`the window opened maximized or minimized, so the shipped code left it as it is: ${result.placeSaid}`)
    return false
  }
  return true
}

describe('the plain window places itself, live (#5)', { skip: liveSkip, concurrency: 1 }, () => {
  let screens
  before(() => {
    assert.ok(LIVE?.shell !== undefined, LIVE?.why ?? 'the shipped shell rule was not read')
    process.stdout.write(`window-place-live: opens ${LIVE_WINDOWS} windows, one at a time, each in ${LIVE.shell} (the shell a launch's window would get here), each running only this test's script, which ends by itself (the test ends it at ${WINDOW_LIMIT_MS / 1000} s); about ${LIVE_EACH_MS / 1000} s each at most, ${(LIVE_WINDOWS * LIVE_EACH_MS) / 1000} s in all.\n`)
    work = mkdtempSync(join(tmpdir(), 'window-place-'))
    dll = join(work, 'place-test.dll')
    const compiled = hidden(`Add-Type -ErrorAction Stop -TypeDefinition ${psq(TEST_CS)} -OutputAssembly ${psq(dll)}`, LIVE.shell)
    assert.ok(compiled.code === 0 && existsSync(dll), `the test's C# compiled to ${dll} in ${LIVE.shell}: ${compiled.out}${compiled.err}`)
    const read = hidden([`Add-Type -ErrorAction Stop -Path ${psq(dll)}`, `[Console]::Out.WriteLine(${T}::Monitors())`].join('\r\n'), LIVE.shell)
    assert.equal(read.code, 0, `${read.out}${read.err}`)
    screens = read.out
      .trim()
      .split(/\r?\n/)
      .at(-1)
      .split(';')
      .map(row => row.split(',').map(Number))
      .map(n => ({ monitor: n.slice(0, 4), work: n.slice(4, 8), primary: n[8] === 1 }))
    assert.ok(screens.length > 0 && screens.some(s => s.primary), `the monitors read: ${read.out}`)
  })
  after(() => {
    if (work !== undefined) rmSync(work, { recursive: true, force: true })
  })

  test('a placed window: its frame moved to the rectangle asked for (GetWindowRect, within the tolerances, polled to a bound)', t => {
    const primary = screens.find(s => s.primary)
    const rect = [primary.work[0] + 120, primary.work[1] + 90, 640, 400]
    const target = machine.clampToWork(rect, primary.work)
    const opened = openWindow({ place: { rect }, until: `Test-Near @(${T}::OwnRect()) @(${target.join(', ')})` })
    if (!settled(t, opened)) return
    const { result } = opened
    assert.equal(result.placeSaid, 'placed', seen(opened))
    assert.notEqual(result.settledMs, null, `the frame reached the rectangle within ${SETTLE_LIMIT_MS} ms: ${seen(opened)}`)
    assert.notDeepEqual(result.rectAfter, result.rectBefore, `it moved: ${seen(opened)}`)
    assert.ok(rectNear(result.rectAfter, target), `at ${JSON.stringify(target)}: ${seen(opened)}`)
  })

  test('maximized with a rectangle: maximized on the monitor that holds the rectangle, another than the one it opened on where there are two', t => {
    // One variant of the shipped lines per monitor: the window runs one for a monitor it did not open on.
    const variants = screens.map(s => ({ work: s.work, place: { rect: [s.work[0] + 100, s.work[1] + 100, 640, 400], maximized: true } }))
    const opened = openWindow({ variants, until: `${T}::OwnZoomed() -and ((@(${T}::OwnWork()) -join ",") -eq $chosen)` })
    if (!settled(t, opened)) return
    const { result } = opened
    const chosen = String(result.chosenWork).split(',').map(Number)
    t.diagnostic(`monitor choice: ${result.monitorChoice}; opened on ${JSON.stringify(result.workBefore)}, placed on ${JSON.stringify(chosen)}`)
    t.diagnostic(`restore rectangle (GetWindowPlacement's normal one, recorded, not asserted): ${JSON.stringify(result.normal)}`)
    assert.equal(result.placeSaid, 'placed', seen(opened))
    assert.notEqual(result.settledMs, null, `maximized on that monitor within ${SETTLE_LIMIT_MS} ms: ${seen(opened)}`)
    assert.equal(result.zoomed, true, `maximized: ${seen(opened)}`)
    assert.deepEqual(result.work, chosen, `on the monitor that holds the rectangle: ${seen(opened)}`)
    if (screens.length > 1) assert.notDeepEqual(chosen, result.workBefore, `another monitor than the one it opened on: ${seen(opened)}`)
    assert.ok(covers(result.rectAfter, chosen), `its frame covers that monitor's work area: ${seen(opened)}`)
  })

  test('a rectangle off every monitor: moved, wholly onto the work area of the monitor Windows picked', t => {
    const rect = [30000, 30000, 640, 400]
    const [x, y, w, h] = rect
    if (screens.some(({ monitor: [l, top, r, b] }) => x < r && x + w > l && y < b && y + h > top)) return t.skip('a monitor reaches 30000,30000 here, so the rectangle is not off every monitor')
    // The target once Windows has picked the monitor: Clamp onto the work area the window is on, as PLACE_CS computes it.
    const prelude = [`function Get-Target { $w = @(${T}::OwnWork()); if ($w.Count -ne 4) { return @() }; return @([ClaudeSelfToolsPlace]::Clamp([int]${x}, [int]${y}, [int]${w}, [int]${h}, $w[0], $w[1], $w[2], $w[3])) }`]
    const opened = openWindow({ place: { rect }, prelude, until: `((@(${T}::OwnRect()) -join ",") -ne ($result.rectBefore -join ",")) -and (Test-Near @(${T}::OwnRect()) @(Get-Target))` })
    if (!settled(t, opened)) return
    const { result } = opened
    assert.equal(result.placeSaid, 'placed', seen(opened))
    assert.notEqual(result.settledMs, null, `moved onto its work area within ${SETTLE_LIMIT_MS} ms: ${seen(opened)}`)
    assert.notDeepEqual(result.rectAfter, result.rectBefore, `it moved: ${seen(opened)}`)
    assert.ok(rectNear(result.rectAfter, machine.clampToWork(rect, result.work)), `at clampToWork(${JSON.stringify(rect)}, ${JSON.stringify(result.work)}): ${seen(opened)}`)
    t.diagnostic(`Windows put it on the work area ${JSON.stringify(result.work)}; the model's choice (clampToMonitors) is ${JSON.stringify(machine.clampToMonitors(rect, screens))}`)
  })

  test(`an unplaced window is not moved (watched for ${WATCH_MS / 1000} s)`, t => {
    const opened = openWindow({ watch: true })
    if (!settled(t, opened)) return
    const { result } = opened
    assert.equal(result.placeSaid, undefined, `no placing line ran: ${seen(opened)}`)
    assert.deepEqual(result.rectAfter, result.rectBefore, `where it opened, ${WATCH_MS / 1000} s later: ${seen(opened)}`)
  })
})
