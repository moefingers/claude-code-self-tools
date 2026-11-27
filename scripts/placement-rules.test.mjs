// The rules of slots v2, placement and the trampoline in the shared machine code, on fixtures, as plain
// checks; then every planted fault: the check run again against a copy of the machine code with the fault
// in it, which must fail. No script runs here (scripts/slot-live.test.mjs and placement.test.mjs run them).
// Run with `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { ROOT } from './sync-shared.mjs'

const SOURCE = join(ROOT, 'shared', 'hooks', 'machine.ts')
const sourceText = readFileSync(SOURCE, 'utf8')
const real = await import(pathToFileURL(SOURCE).href)

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const STATE = 'C:\\Users\\u x\\AppData\\Local\\claude-self-tools'
const CONFIG = 'C:\\Users\\u x\\.claude'
const T = '00000000-0000-4000-a000-000000000001'
const FRESH = '00000000-0000-4000-a000-000000000002'
const OTHER = '00000000-0000-4000-a000-000000000003'
const SLOT = '20-134062345678901240'
const NOW = 1_800_000_000_000
const GIB_KB = 1024 * 1024
const GIB = GIB_KB * 1024
const FLOOR_CHECKS = { floor: true, input: true }
const PERMISSION = ['--permission-mode', '--dangerously-skip-permissions', 'bypassPermissions', 'acceptEdits', '--allow-dangerously']

/** A probe's raw answer in slots mode: claude.exe 100 in a pane, the probe 300 under it. */
const raw = (change = {}) => ({
  v: 1,
  self: 300,
  session: { pid: 100, created: '134062345688901240' },
  slot: null,
  procs: [
    { pid: 20, ppid: 10, created: '134062345678901240', name: 'powershell.exe', cls: 'shell' },
    { pid: 100, ppid: 20, created: '134062345688901240', name: 'claude.exe', privateBytes: GIB },
    { pid: 300, ppid: 100, created: '134062355668901240', name: 'powershell.exe', cls: 'shell' },
  ],
  registry: [],
  transcripts: [],
  locks: [],
  claim: null,
  heavy: [],
  freeKb: 32 * GIB_KB,
  errors: [],
  slots: [],
  heavyChecked: true,
  heavyWaiters: 0,
  heavyBusy: 0,
  heavyCap: 2,
  room: 3,
  inputIdleSec: 600,
  holders: [],
  ...change,
})
const probeOf = (m, change) => {
  const parsed = m.parseProbe(`${JSON.stringify(raw(change))}\r\n`)
  if ('error' in parsed) throw new Error(parsed.error)
  return parsed
}
const idleRunner = (m, change = {}, beacon = {}) => ({ pid: 21, created: '134062345678901240', id: `21-134062345678901240`, sha256: m.SLOT_SCRIPT_SHA256, child: null, beacon: { state: 'idle', since: NOW - 60_000, configDir: CONFIG, sha256: m.SLOT_SCRIPT_SHA256, ...beacon }, ...change })
const PICK = { replacing: false, configCount: 1, needsLeft: false, configDir: CONFIG, now: NOW, workspace: 'default' }

const placementOf = (m, change = {}) => {
  const read = m.readPlacement(JSON.stringify({ v: 1, layout: [{ window: 'claude-4', pos: [960, 540], size: [160, 42], tabs: ['s10'], folder: 'C:\\work' }], launch: { prefer: ['slot', 'tab', 'window'], tab: { window: 'claude-4', maxTabs: 1 }, window: { name: 'claude-overflow', pos: [1920, 0], size: [140, 60] } }, restart: { prefer: ['slot', 'tab', 'window'], tab: { window: 'same' } }, workspaces: { 'claude-4': 'default' }, ...change }))
  if ('errors' in read) throw new Error(read.errors.join('; '))
  return read.placement
}

const launchInput = (change = {}) => ({ powershell: POWERSHELL, kind: 'resume', id: T, folder: 'C:\\work\\my repo\\', claim: `launch:${T}`, configDirs: [CONFIG, 'D:\\other cfg'], stateDir: STATE, where: { window: true }, waitForExit: { pid: 100, created: '134062345688901240' }, maxSessions: 12, heavySlotRoot: null, ...change })
/** One script per place, each with what it must ask for. */
const scriptsOf = m => ({
  slotStart: m.launchScriptText(launchInput({ kind: 'start', id: FRESH, name: 'lane-x', claim: `slot:${SLOT}`, where: { slot: SLOT }, waitForExit: undefined, checks: { ...FLOOR_CHECKS, fresh: true }, heavySlotRoot: 'O:\\heavy' })),
  slotResume: m.launchScriptText(launchInput({ claim: `slot:${SLOT}`, where: { slot: SLOT }, waitForExit: undefined, checks: { ...FLOOR_CHECKS, live: true }, heavySlotRoot: 'O:\\heavy', left: { size: 12, mtime: 34 } })),
  tabStart: m.launchScriptText(launchInput({ kind: 'start', id: FRESH, name: 'lane-x', claim: `launch:${FRESH}`, where: { tab: { window: 'claude-4', title: 'lane-x', pos: [960, 540], size: [160, 42] } }, waitForExit: undefined, checks: { ...FLOOR_CHECKS, fresh: true } })),
  tabResume: m.launchScriptText(launchInput({ where: { tab: { window: 'claude-1', title: 'lane-z' } } })),
  named: m.launchScriptText(launchInput({ where: { window: { name: 'claude-overflow', pos: [1920, 0], size: [140, 60] } } })),
  plain: m.launchScriptText(launchInput({ claim: `launch:${FRESH}` })),
})
const wtLineOf = script => /^\s*\$wtLine = '(.*)'\r?$/m.exec(script)?.[1]?.split("''").join("'")

/** Where the window's own script sits in a launch script: its single-quoted literal's first character and its closing quote. */
function innerAt(script) {
  const at = script.indexOf("$inner = '")
  if (at < 0) throw new Error('no window script in it')
  const from = at + "$inner = '".length
  for (let i = from; i < script.length; i += 1) {
    if (script[i] === "'" && script[i + 1] === "'") {
      i += 1
      continue
    }
    if (script[i] === "'") return { from, end: i }
  }
  throw new Error('the window script is not closed')
}
/** The window's own script, out of a launch script: its single-quoted literal, quotes undoubled. */
function innerOf(script) {
  const { from, end } = innerAt(script)
  return script.slice(from, end).split("''").join("'")
}
/** A launch script with its window's own script taken out: the caller's own lines alone. */
function outerOf(script) {
  const { from, end } = innerAt(script)
  return `${script.slice(0, from - 1)}<the window script>${script.slice(end + 1)}`
}

/**
 * The reviewed list (#5): every function the window's own C# (PLACE_CS) imports, as it imports it, and no other.
 * Two of them act on a window, SetWindowPos and ShowWindowAsync, each held below to the one call reviewed; the
 * rest read (and SetThreadDpiAwarenessContext sets the thread's own DPI awareness, put back as it was).
 * EnumWindows is the one listing of windows: it lists the top-level windows once, reads each one's class name, reads
 * the owner of those that are pseudoconsole windows, acts on none, and is there to refuse, never to choose a target
 * (no title is read); held below to its one declaration, its one call and its callback's exact text. #90 added two
 * reads, GetWindowRect and DwmGetWindowAttribute (DWMWA_EXTENDED_FRAME_BOUNDS, 9), each called once, by BorderOf, on
 * its own window alone: the rectangle and the drawn frame, whose difference is the overhang the clamp may take. No
 * acting call was added. An edit that adds, drops or changes one fails here until it is reviewed and this list changed
 * with it.
 */
const REVIEWED_IMPORTS = [
  '[DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();',
  '[DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint relation);',
  '[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr window, StringBuilder name, int size);',
  '[DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);',
  '[DllImport("user32.dll")] static extern bool IsZoomed(IntPtr window);',
  '[DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);',
  '[DllImport("user32.dll")] static extern IntPtr MonitorFromRect(ref Box rect, uint fallback);',
  '[DllImport("user32.dll")] static extern bool GetMonitorInfoW(IntPtr monitor, ref MonitorInfo info);',
  '[DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);',
  '[DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr window, int show);',
  '[DllImport("user32.dll")] static extern bool EnumWindows(EachWindow each, IntPtr data);',
  '[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Box box);',
  '[DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out Box value, int size);',
]

/**
 * What the window's C# never names: nothing that finds a window (any FindWindow name), lists windows any other way
 * than EnumWindows's one reviewed call, raises, focuses, closes or types into a window, reads a window's title, nor
 * reads a value from outside. A GetWindow loop is held off below: every GetWindow is GW_OWNER.
 */
const FORBIDDEN_IN_PLACE = ['FindWindow', 'EnumChildWindows', 'EnumDesktopWindows', 'GetWindowText', 'InternalGetWindowText', 'SwitchToThisWindow', 'AnimateWindow', 'DeferWindowPos', 'EndDeferWindowPos', 'SendNotifyMessage', 'PostThreadMessage', 'SetWindowRgn', 'FlashWindowEx', 'OpenIcon', 'System.Windows', 'VisualBasic', 'Automation', 'LoadLibrary', 'GetProcAddress', 'GetDelegateForFunctionPointer', 'unsafe', 'DllImportAttribute', 'EnumThreadWindows', 'GetTopWindow', 'GetDesktopWindow', 'WindowFromPoint', 'GetForegroundWindow', 'SetForegroundWindow', 'BringWindowToTop', 'SetActiveWindow', 'SetFocus', 'AttachThreadInput', 'SendMessage', 'PostMessage', 'MoveWindow', 'SetWindowPlacement', 'ShowWindow(', 'DestroyWindow', 'CloseWindow', 'SetWindowLong', 'SetParent', 'SendInput', 'keybd_event', 'mouse_event', 'Environment', 'System.IO', 'Process', 'Registry', 'Console.']

/** Fixed monitors for the clamp: a left-hand one at a negative origin, the primary, and a right-hand one with its taskbar along the top. Made up. */
const LEFT = { monitor: [-1920, 0, 0, 1080], work: [-1920, 0, 0, 1040] }
const PRIMARY = { monitor: [0, 0, 2560, 1440], work: [0, 0, 2560, 1400] }
const TOP_BAR = { monitor: [2560, 0, 4480, 1080], work: [2560, 48, 4480, 1080] }
/** A window's invisible border, as one machine read it at 100% scale (#90): 7 px on the left, the right and the bottom. */
const BORDER = [7, 7, 7]
/** Each row: what it shows, the rect asked for, where clampToMonitors puts it among LEFT, PRIMARY and TOP_BAR, and the window's border (none when left out). */
const CLAMP_ROWS = [
  ['inside the primary monitor: as asked', [100, 100, 1280, 800], [100, 100, 1280, 800]],
  ['wholly off every monitor, far right and down: onto the nearest, inside its work area', [30000, 30000, 800, 600], [3680, 480, 800, 600]],
  ['wholly off every monitor, far left: onto the left-hand monitor', [-30000, 100, 800, 600], [-1920, 100, 800, 600]],
  ['across the left-hand and the primary, more on the primary: wholly on the primary', [-300, 100, 1000, 600], [0, 100, 1000, 600]],
  ['across the left-hand and the primary, more on the left-hand: wholly on the left-hand', [-900, 100, 1000, 600], [-1000, 100, 1000, 600]],
  ['larger than the work area: the whole work area', [100, 100, 4000, 3000], [0, 0, 2560, 1400]],
  ['a negative origin on the left-hand monitor: as asked', [-1800, 50, 800, 600], [-1800, 50, 800, 600]],
  ["past the left-hand monitor's left edge: moved onto it", [-2100, 50, 800, 600], [-1920, 50, 800, 600]],
  ['under a taskbar along the top: just below it', [3000, 0, 800, 600], [3000, 48, 800, 600]],
  ["past the primary's work area at the bottom: up into it", [500, 1300, 800, 600], [500, 800, 800, 600]],
]

/** #90's made-up screen: one monitor of 1920 x 1080 whose work area stops at 1032, its taskbar below. */
const SCREEN = { monitor: [0, 0, 1920, 1080], work: [0, 0, 1920, 1032] }
/**
 * #90's rows, on SCREEN alone, with a border of 7 px on the left, the right and the bottom (BORDER), which the
 * rectangle may pass the work area by, and no more. The cells are made up: 4 x 2 of 480 x 516 drawn, so a cell's
 * rectangle is 494 x 523 at x -7, 473, 953 or 1433 and y 0 or 516.
 */
const OVERHANG_CLAMP_ROWS = [
  ['a left edge: the frame flush with it, the border past it', [-7, 100, 494, 523], [-7, 100, 494, 523], BORDER],
  ['a right edge: the frame flush with it', [1433, 100, 494, 523], [1433, 100, 494, 523], BORDER],
  ['a bottom edge: the frame flush with it', [500, 516, 494, 523], [500, 516, 494, 523], BORDER],
  ['the bottom-left corner: flush with both edges', [-7, 516, 494, 523], [-7, 516, 494, 523], BORDER],
  ['a border read of 0: wholly inside, as #89 placed it', [-7, 100, 494, 523], [0, 100, 494, 523], [0, 0, 0]],
  ['past the left edge by more than its border: by its border alone', [-20, 100, 800, 600], [-7, 100, 800, 600], BORDER],
  ['never past the top: the top has no border', [100, -7, 800, 600], [100, 0, 800, 600], BORDER],
  ['larger than the work area: the work area and the border', [100, 100, 4000, 3000], [-7, 0, 1934, 1039], BORDER],
  ['wholly off every monitor: onto the one there is, past its work area by its border alone', [30000, 30000, 800, 600], [1127, 439, 800, 600], BORDER],
]

/** Each row: a window's rectangle and its drawn frame ([left, top, right, bottom]), and the overhang read from them (overhangOf, PLACE_CS's Overhang). Made up. */
const OVERHANG_ROWS = [
  ['a border of 7 px on three sides, none at the top', [-7, 0, 967, 1039], [0, 0, 960, 1032], [7, 7, 7]],
  ['no border: the frame is the rectangle', [0, 0, 960, 1032], [0, 0, 960, 1032], [0, 0, 0]],
  ['1 px reads as none', [-1, 0, 961, 1033], [0, 0, 960, 1032], [0, 0, 0]],
  ['2 px and 64 px read as they are', [-2, 0, 1024, 1096], [0, 0, 960, 1032], [2, 64, 64]],
  ['the top is never read: a rectangle 5 px above its frame reads as the 7 px of the other three sides', [-7, -5, 967, 1039], [0, 0, 960, 1032], [7, 7, 7]],
  ['65 px is no border read', [-65, 0, 960, 1032], [0, 0, 960, 1032], [0, 0, 0]],
  ['a frame outside the rectangle is no border', [10, 0, 950, 1022], [0, 0, 960, 1032], [0, 0, 0]],
]

/** Each check takes a machine module: the real one, or a copy with a fault in it. */
const CHECKS = {
  launchArguments(m) {
    const s = scriptsOf(m)
    const line = wtLineOf(s.tabStart)
    assert.equal(line, `-w claude-4 --pos 960,540 --size 160,42 nt --title lane-x --suppressApplicationTitle -d "C:\\work\\my repo" -- ${POWERSHELL} -NoExit -NoProfile -ExecutionPolicy RemoteSigned -File "${STATE}\\claude-slot.ps1" -Start ${FRESH} -Name lane-x -ConfigDirs "${CONFIG}|D:\\other cfg" -Claim launch:${FRESH} -Launcher ${m.LAUNCH_SCRIPT_SHA256}`)
    assert.equal(wtLineOf(s.tabResume), `-w claude-1 nt --title lane-z --suppressApplicationTitle -d "C:\\work\\my repo" -- ${POWERSHELL} -NoExit -NoProfile -ExecutionPolicy RemoteSigned -File "${STATE}\\claude-slot.ps1" -Resume ${T} -WaitFor 100-134062345688901240 -ConfigDirs "${CONFIG}|D:\\other cfg" -Claim launch:${T} -Launcher ${m.LAUNCH_SCRIPT_SHA256}`)
    for (const script of Object.values(s)) {
      for (const flag of PERMISSION) assert.ok(!script.includes(flag), flag)
      const wt = wtLineOf(script)
      if (wt !== undefined) {
        assert.ok(!/-EncodedCommand/.test(wt), 'never a script on the line')
        assert.ok(wt.length < 24_000)
      }
    }
    // The largest inputs: 8 config folders of 240 characters, and a folder of 240.
    const long = tag => `C:\\${`${tag}\\${'x'.repeat(40)}\\`.repeat(6)}`.slice(0, 240).replace(/\\+$/, '')
    const line2 = m.wtTabLine({ powershell: POWERSHELL, stateDir: long('state'), window: 'w'.repeat(40), title: 't'.repeat(40), folder: long('work'), run: { resume: T, claim: `launch:${T}`, waitFor: { pid: 4294967295, created: '99999999999999999999' }, configDirs: Array.from({ length: 8 }, (_, i) => long(`c${i}`)), left: { size: 9007199254740991, mtime: 9007199254740991 } } })
    assert.ok(line2.length < 24_000)
  },
  quoting(m) {
    assert.equal(m.wtArgument('plain'), 'plain')
    assert.equal(m.wtArgument('a folder'), '"a folder"')
    for (const bad of ['a"b', 'a;b', 'a%b', '']) assert.throws(() => m.wtArgument(bad))
    assert.throws(() => m.wtArgument('C:\\a b\\'), /backslash/)
    assert.equal(m.wtFolder('C:\\a b\\'), 'C:\\a b')
    assert.equal(m.wtFolder('C:\\'), 'C:\\')
    const s = scriptsOf(m).tabStart
    assert.ok(s.includes('$window = Start-Process $wtExe -ArgumentList $wtLine -PassThru'), 'one string, never an array')
    // A folder and a slot path with a space come out quoted; a trailing backslash is stripped.
    assert.ok(wtLineOf(s).includes('-d "C:\\work\\my repo" --'))
    assert.ok(wtLineOf(s).includes(`-File "${STATE}\\claude-slot.ps1"`))
  },
  pinnedPaths(m) {
    const s = scriptsOf(m).tabStart
    assert.ok(s.includes(`$slotScript = '${STATE}\\claude-slot.ps1'`), 'the slot script from its one place')
    const hash = s.lastIndexOf(`if ((Get-Sha256 $slotScript) -cne '${m.SLOT_SCRIPT_SHA256}') { throw`)
    const start = s.indexOf('$window = Start-Process $wtExe')
    assert.ok(hash > 0 && hash < start, 'its hash checked in the same script, just before')
    assert.equal(s.slice(hash, start).split('\r\n').length, 2, 'right before')
    assert.ok(wtLineOf(s).includes(` -- ${POWERSHELL} `))
    assert.throws(() => m.launchScriptText(launchInput({ powershell: 'C:\\evil\\powershell.exe', where: { tab: { window: 'a', title: 'a' } } })))
  },
  folders(m) {
    assert.equal(m.wtFolderFault('C:\\ok folder'), undefined)
    assert.match(m.wtFolderFault('C:\\%TEMP%\\x'), /percent/)
    assert.match(m.wtFolderFault('C:\\a;b'), /semicolon/)
    assert.equal(m.launchFolderFault('C:\\a%b'), undefined, 'where no Windows Terminal reads it, a folder may hold one')
    const percent = { folder: 'C:\\a%b\\' }
    assert.throws(() => m.launchScriptText(launchInput({ ...percent, where: { tab: { window: 'a', title: 'a' } } })), /percent/)
    assert.throws(() => m.launchScriptText(launchInput({ ...percent, where: { window: { name: 'a' } } })), /percent/)
    assert.throws(() => m.launchScriptText(launchInput({ stateDir: 'C:\\a;b', where: { tab: { window: 'a', title: 'a' } } })))
    assert.ok(m.launchScriptText(launchInput(percent)).includes("$folder = 'C:\\a%b\\'"), 'the plain window takes it')
    assert.equal(m.isSafeFolder(`C:\\a${String.fromCharCode(0x85)}`), false, 'a C1 control is a control character (D2)')
    assert.match(m.folderFault(`C:\\a${String.fromCharCode(0x85)}`), /control/)
    // Special names, in a launch as in a file.
    for (const name of ['0', 'last', 'new', '-1', '12', 'a b', 'a;b']) {
      assert.throws(() => m.launchScriptText(launchInput({ where: { tab: { window: name, title: 'a' } } })), name)
      assert.throws(() => m.launchScriptText(launchInput({ where: { window: { name } } })), name)
    }
    assert.throws(() => m.launchScriptText(launchInput({ claim: `slot:${SLOT}`, where: { tab: { window: 'a', title: 'a' } } })), /launch's own claim/)
  },
  moduleReset(m) {
    for (const [name, script] of Object.entries(scriptsOf(m))) {
      const lines = script.split('\r\n')
      assert.equal(lines.indexOf(m.PSMODULEPATH_RESET), 2, name)
      const version = script.indexOf('Get-AppxPackage')
      if (version >= 0) assert.ok(script.indexOf(m.PSMODULEPATH_RESET) < version, name)
    }
    assert.equal(m.probeScript({ ids: [T], configDirs: [CONFIG], stateDir: STATE, slots: true, heavySlotRoot: null }).split('\r\n').indexOf(m.PSMODULEPATH_RESET), 2)
    assert.equal(m.relockScript({ stateDir: STATE, id: T, by: `launch:${T}`, holder: { pid: 1, created: '1' } }).split('\r\n').indexOf(m.PSMODULEPATH_RESET), 2)
  },
  inputIdle(m) {
    assert.equal(m.inputIdle(probeOf(m)), true)
    assert.equal(m.inputIdle(probeOf(m, { inputIdleSec: 59 })), false)
    assert.equal(m.inputIdle(probeOf(m, { inputIdleSec: null })), false, 'null is not idle')
    assert.equal(m.inputIdle(probeOf(m, { inputIdleSec: 60 })), true)
    const slots = [idleRunner(m)]
    for (const placement of [null, placementOf(m)]) {
      assert.equal(m.pickLaunchTransport(probeOf(m, { slots, inputIdleSec: null }), placement, PICK).wait, 'input')
      assert.equal(m.pickLaunchTransport(probeOf(m, { slots, inputIdleSec: 5 }), placement, PICK).wait, 'input')
    }
    // In the script: a reading that fails refuses, and so does one under 60 s.
    const s = scriptsOf(m).slotStart
    assert.ok(s.includes("if ($null -eq $inputIdleSec) { Refuse 'input'"))
    assert.ok(s.includes("if ($inputIdleSec -lt 60) { Refuse 'input'"))
    assert.ok(s.includes('GetLastInputInfo'))
  },
  floorRules(m) {
    assert.equal(m.floorOk(probeOf(m), 12), 'ok')
    // 6 GB governs while the largest is small; 4 GB + the largest past it.
    assert.equal(m.floorOk(probeOf(m, { freeKb: 6 * GIB_KB - 1 }), 12), 'memory', 'the 6 GB term')
    assert.equal(m.floorOk(probeOf(m, { freeKb: 6 * GIB_KB }), 12), 'ok')
    const large = raw().procs.map(p => (p.pid === 100 ? { ...p, privateBytes: 5 * GIB } : p))
    assert.equal(m.floorOk(probeOf(m, { procs: large, freeKb: 9 * GIB_KB - 1 }), 12), 'memory', 'the largest-private-bytes term')
    assert.equal(m.floorOk(probeOf(m, { procs: large, freeKb: 9 * GIB_KB }), 12), 'ok')
    // None read: the largest counts as 2 GB, under the 6 GB here.
    const unread = raw().procs.map(({ privateBytes, ...p }) => p)
    assert.equal(m.floorNeedKb(probeOf(m, { procs: unread })), 6 * GIB_KB)
    assert.equal(m.floorOk(probeOf(m, { freeKb: null }), 12), 'memory', 'unread')
    assert.equal(m.floorOk(probeOf(m, { heavyWaiters: 1 }), 12), 'heavy', 'a heavy waiter')
    assert.equal(m.floorOk(probeOf(m, { heavyBusy: 2 }), 12), 'heavy', 'both slots busy, at the default cap')
    assert.equal(m.floorOk(probeOf(m, { heavyBusy: 1 }), 12), 'ok', 'one slot busy')
    // #46: heavy-slot's cap, not 2: a launch waits while as many slots are busy as the cap, and a cap of 0 holds it.
    assert.equal(m.floorOk(probeOf(m, { heavyCap: 4, heavyBusy: 3 }), 12), 'ok', 'cap 4, three busy')
    assert.equal(m.floorOk(probeOf(m, { heavyCap: 4, heavyBusy: 4 }), 12), 'heavy', 'cap 4, all four busy')
    assert.equal(m.floorOk(probeOf(m, { heavyCap: 1, heavyBusy: 1 }), 12), 'heavy', 'cap 1, its one slot busy')
    assert.equal(m.floorOk(probeOf(m, { heavyCap: 1, heavyBusy: 0 }), 12), 'ok', 'cap 1, free')
    assert.equal(m.floorOk(probeOf(m, { heavyCap: 0, heavyBusy: 0 }), 12), 'heavy', 'cap 0 holds every job')
    assert.equal(m.floorOk(probeOf(m, { heavyCap: 2, heavyBusy: 3 }), 12), 'heavy', 'a cap lowered under the jobs still running')
    assert.equal(m.floorOk(probeOf(m, { errors: ['heavy:'] }), 12), 'heavy', "heavy-slot's folders unread")
    // D3: read, yet no count, is no reading that it's free; only a named none has none.
    for (const counts of [{ heavyWaiters: null, heavyBusy: null, heavyCap: null }, { heavyWaiters: null }, { heavyBusy: null }, { heavyCap: null }]) assert.equal(m.floorOk(probeOf(m, counts), 12), 'heavy', `read, with no count: ${JSON.stringify(counts)}`)
    assert.equal(m.floorOk(probeOf(m, { room: 12 }), 12), 'cap')
    assert.equal(m.floorOk(probeOf(m, { room: 11 }), 12), 'ok')
    assert.equal(m.floorOk(probeOf(m, { room: 6 }), 6), 'cap', 'the cap as placement names it')
    assert.throws(() => m.floorOk(probeOf(m)), /the cap/, 'never a default')
    assert.equal(m.floorOk(probeOf(m, { heavyChecked: undefined }), 12), 'heavy', 'a reading that does not say whether heavy-slot was looked at')
    assert.equal(m.floorOk(probeOf(m, { heavyChecked: false, heavy: null, heavyWaiters: null, heavyBusy: null, heavyCap: null }), 12), 'ok', 'named none: no heavy-slot on this machine')
    // Required: left out, a floor would skip heavy-slot and fall to the default cap without a word (F8).
    assert.throws(() => m.launchScriptText(launchInput({ claim: `slot:${SLOT}`, where: { slot: SLOT }, waitForExit: undefined, checks: { ...FLOOR_CHECKS, live: true }, heavySlotRoot: undefined })), /heavySlotRoot, maxSessions/)
    assert.throws(() => m.launchScriptText(launchInput({ claim: `slot:${SLOT}`, where: { slot: SLOT }, waitForExit: undefined, checks: { ...FLOOR_CHECKS, live: true }, maxSessions: undefined })), /heavySlotRoot, maxSessions/)
    assert.ok(!m.launchScriptText(launchInput({ claim: `slot:${SLOT}`, where: { slot: SLOT }, waitForExit: undefined, checks: { ...FLOOR_CHECKS, live: true } })).includes('$heavyRoot ='), 'null: this machine has none')
    assert.throws(() => m.probeScript({ ids: [T], configDirs: [CONFIG], stateDir: STATE, slots: true }), /heavySlotRoot/)
    assert.ok(m.probeScript({ ids: [T], configDirs: [CONFIG], stateDir: STATE, slots: true, heavySlotRoot: null }).includes('$result["heavyChecked"] = ($null -ne $heavyRoot)'))
    assert.equal(m.floorOk(probeOf(m, { room: null }), 12), 'cap', 'unread')
    assert.deepEqual(m.LIMITS_DEFAULT, { minFreeGb: 5, maxSessions: 12 })
    assert.deepEqual([m.INPUT_IDLE_MS, m.SLOT_IDLE_MIN_MS, m.FLOOR_MIN_GB, m.HEAVY_FLOOR_GB], [60_000, 10_000, 6, 4])
  },
  floorScript(m) {
    const s = scriptsOf(m).slotStart
    assert.ok(s.includes('$needBytes = [math]::Max([long]6 * 1073741824, [long]4 * 1073741824 + $largest)'), 'both terms')
    assert.ok(s.includes('if ($null -eq $largest) { $largest = [long]2 * 1073741824 }'))
    assert.ok(s.includes('PrivatePageCount'))
    assert.ok(s.includes("if ($heavyWaiters -gt 0) { Refuse 'heavy'"), 'a heavy waiter refuses')
    // #46: the busy slots of all four, against heavy-slot's cap from .gate-cap, read as heavy-slot reads it.
    assert.ok(s.includes("if ($heavyBusy -ge $heavyCap) { Refuse 'heavy' ('every heavy slot is busy (slots held: '"), 'busy at the cap refuses')
    assert.ok(s.includes("if ($heavyCap -eq 0) { Refuse 'heavy' 'heavy-slot holds every heavy job: its cap is 0' }"), 'a cap of 0 says so')
    assert.ok(s.includes(`if ($null -eq $heavyCap) { Refuse 'heavy' ("heavy-slot's .gate-cap could not be read: " + $heavyCapError) }`), 'a cap that could not be read refuses, naming .gate-cap')
    assert.ok(s.indexOf('if ($null -eq $heavyCap) {') < s.indexOf('if ($heavyCap -eq 0) {'), 'before the cap is compared')
    assert.ok(!s.includes('$heavyBusy -ge 2'), 'never two, whatever the cap')
    const probeText = m.probeScript({ ids: [T], configDirs: [CONFIG], stateDir: STATE, slots: true, heavySlotRoot: 'O:\\heavy' })
    for (const script of [s, probeText]) {
      assert.ok(script.includes('foreach ($s in ".gate-lock", ".gate-lock-2", ".gate-lock-3", ".gate-lock-4") {'), 'every slot heavy-slot can use')
      assert.ok(!script.includes('foreach ($s in ".gate-lock", ".gate-lock-2") {'), 'never only two')
      assert.ok(script.includes('$heavyCapFile = Join-Path $heavyRoot ".gate-cap"'), 'the file')
      // Review round 1, M1: the cap read in a try of its own; one that can't be read is null, never an error of the folders.
      assert.ok(script.includes('try { if (Test-Path -LiteralPath $heavyCapFile -PathType Leaf) { $heavyCapText = "$(Get-Content -LiteralPath $heavyCapFile -Raw)" } } catch { $heavyCapError = $_.Exception.Message }'), 'the file read, when it is one, in its own try')
      assert.ok(script.indexOf('if ($null -ne $heavyCapError) { $heavyCap = $null }') > script.indexOf('$heavyCapText = "$(Get-Content'), 'a cap that could not be read is null')
      // Review round 1, L1: heavy-slot's own reading of it, line for line (replayed against heavy-slot in scripts/slot-live.test.mjs).
      assert.ok(script.includes(m.HEAVY_CAP_PARSE.map(line => `  ${line}`).join('\r\n')), "the cap parsed as heavy-slot's slots() reads it")
      assert.ok(script.includes('$heavyCapDigits = "$heavyCapText" -replace "[^0-9]", ""'), "its digits alone, as tr -dc '0-9' keeps them")
      assert.ok(m.HEAVY_CAP_PARSE[0] === '$heavyCap = 2' && m.HEAVY_CAP_PARSE.some(line => line.includes('.TrimStart([char]48)')) && m.HEAVY_CAP_PARSE.some(line => line.includes('"9223372036854775807"')), 'the default, leading zeros, and the largest number bash reads')
      // Review round 1, L2: a slot held as heavy-slot's stale() reads it: its job running, and at most an hour old by its owner file's time.
      assert.ok(script.includes('$of = Join-Path $d "owner"'), "the owner file's time")
      assert.ok(script.includes('if (($heavyNow - $since).TotalSeconds -le 3600 -and ($null -eq $w -or $null -ne $table[[int]$w])) { $heavyBusy++ }'), 'held while its job runs and it is at most an hour old')
    }
    assert.ok(probeText.includes('$result["heavyCap"] = $heavyCap'), 'the probe answers the cap')
    assert.deepEqual([m.HEAVY_SLOTS, m.HEAVY_CAP_DEFAULT, m.HEAVY_CAP_MAX], [['.gate-lock', '.gate-lock-2', '.gate-lock-3', '.gate-lock-4'], 2, 4])
    // D3: a root that is no folder throws before anything is read, in the launch's own run and the probe's; each turns it into a refusal or an error.
    const noFolder = 'if (-not (Test-Path -LiteralPath $heavyRoot -PathType Container)) { throw ("no folder at " + $heavyRoot) }'
    const probe = m.probeScript({ ids: [T], configDirs: [CONFIG], stateDir: STATE, slots: true, heavySlotRoot: 'O:\\heavy' })
    for (const script of [s, probe]) assert.ok(script.includes(noFolder) && script.indexOf(noFolder) < script.indexOf('$heavyQueue = Join-Path $heavyRoot'), 'a wrong root is not read as free')
    assert.ok(s.indexOf('} catch { Refuse \'heavy\' (') > s.indexOf(noFolder), "in the launch's try: a refusal")
    assert.ok(probe.indexOf('[void]$errors.Add("heavy:") } } }') > probe.indexOf(noFolder), "in the probe's try: an error")
    assert.ok(s.includes("if ($room -ge 12) { Refuse 'cap'"), 'the cap')
    // The same run: floor, cap, input, slot, freshness, claim, record, each in this one script, in order.
    const order = ["Refuse 'memory'", "Refuse 'heavy'", "Refuse 'cap'", "Refuse 'input'", "$slotBeacon['state'] -cne 'idle'", "Refuse 'fresh'", '$taken = New-Claim', '[IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)\r\n']
    let at = -1
    for (const piece of order) {
      const next = s.indexOf(piece, at + 1)
      assert.ok(next > at, `${piece} comes in its place in the one script`)
      at = next
    }
    // A launch of another process can't leave them out.
    assert.throws(() => m.launchScriptText(launchInput({ waitForExit: undefined, checks: { live: true } })), /floor/)
    assert.throws(() => m.launchScriptText(launchInput({ waitForExit: undefined, checks: { floor: true, input: true } })), /NOT LIVE/)
    assert.throws(() => m.launchScriptText(launchInput({ maxSessions: 41 })), /cap/)
    // A launch replacing its caller adds no process.
    assert.ok(!scriptsOf(m).tabResume.includes("Refuse 'memory'"))
  },
  noBash(m) {
    const scripts = [...Object.values(scriptsOf(m)), m.probeScript({ ids: [T], configDirs: [], slots: false }), m.relockScript({ stateDir: STATE, id: T, by: `launch:${T}`, holder: { pid: 1, created: '1' } })]
    for (const script of scripts.slice(0, 6)) assert.ok(!/\bbash(\.exe)?\b|\bsh\.exe\b|msys|\/proc\//i.test(script), 'no generated launch names bash, sh, MSYS or /proc')
  },
  pickRules(m) {
    const place = placementOf(m)
    const slots = [idleRunner(m)]
    // A slot first; in the file's order.
    assert.deepEqual(m.pickLaunchTransport(probeOf(m, { slots }), place, PICK).where, { slot: slots[0].id })
    assert.deepEqual(m.pickLaunchTransport(probeOf(m, { slots }), null, PICK).where, { slot: slots[0].id })
    // No slot and no placement: today's window.
    assert.deepEqual(m.pickLaunchTransport(probeOf(m), null, PICK).where, { window: true })
    // Each that isn't idle is passed over.
    for (const [why, runner] of [
      ['running', idleRunner(m, { child: 100 })],
      ['a beacon that says running', idleRunner(m, {}, { state: 'running' })],
      ['idle under 10 s', idleRunner(m, {}, { since: NOW - 9000 })],
      ['no beacon', idleRunner(m, { beacon: null })],
      ['a wrong hash', idleRunner(m, { sha256: 'e'.repeat(64) })],
      ['another config folder', idleRunner(m, {}, { configDir: 'D:\\other' })],
    ]) {
      assert.deepEqual(m.idleSlots(probeOf(m, { slots: [runner] }), place, { configDir: CONFIG, now: NOW }), [], why)
    }
    // The window tag: untagged, or tagged with this workspace.
    const tagged = idleRunner(m, {}, { window: 'claude-4', tab: 's10' })
    assert.equal(m.idleSlots(probeOf(m, { slots: [tagged] }), place, { configDir: CONFIG, now: NOW, workspace: 'default' }).length, 1)
    assert.equal(m.idleSlots(probeOf(m, { slots: [tagged] }), place, { configDir: CONFIG, now: NOW, workspace: 'w_abcdefghijkl' }).length, 0, 'tagged with another')
    assert.equal(m.idleSlots(probeOf(m, { slots: [idleRunner(m, {}, { window: 'claude-1' })] }), place, { configDir: CONFIG, now: NOW, workspace: 'w_abcdefghijkl' }).length, 1, 'untagged')
    // A tab with room, by its name, in the window's own place; the next place after it.
    const noneIdle = [idleRunner(m, { child: 100 })]
    const picked = m.pickLaunchTransport(probeOf(m, { slots: noneIdle }), place, { ...PICK, title: 'lane-x' })
    assert.deepEqual(picked.where, { tab: { window: 'claude-4', title: 'lane-x', pos: [960, 540], size: [160, 42] } })
    assert.deepEqual(picked.then, [{ window: { name: 'claude-overflow', pos: [1920, 0], size: [140, 60] } }])
    // maxTabs: an overflow tab there (a slot stamped with the window, not of the layout's tabs) fills it: then the window.
    const overflow = [idleRunner(m, { child: 100 }, { window: 'claude-4', tab: 'overflow' })]
    assert.deepEqual(m.pickLaunchTransport(probeOf(m, { slots: overflow }), place, PICK).where, { window: { name: 'claude-overflow', pos: [1920, 0], size: [140, 60] } })
    // A window only if allowed: none named, and no tab: wait.
    const closed = placementOf(m, { launch: { prefer: ['slot', 'tab', 'window'] } })
    assert.equal(m.pickLaunchTransport(probeOf(m), closed, PICK).wait, 'slot')
    // `prefer` honoured: a tab before a slot.
    const tabFirst = placementOf(m, { launch: { prefer: ['tab', 'slot'], tab: { window: 'claude-4', maxTabs: 1 } } })
    assert.deepEqual(Object.keys(m.pickLaunchTransport(probeOf(m, { slots }), tabFirst, PICK).where), ['tab'])
    // A folder Windows Terminal would expand reaches no tab or named window.
    assert.equal(m.pickLaunchTransport(probeOf(m, { slots: noneIdle }), place, { ...PICK, folder: 'C:\\a%b' }).wait, 'slot')
    // A replacing launch: pane, slot, then the placement's tab by its stamp, the window, then the plain one.
    const mine = { replacing: true, using: 'restart', configCount: 1, needsLeft: false, stamp: { window: 'claude-1', tab: 'one' } }
    const own = m.pickLaunchTransport(probeOf(m), place, mine)
    assert.deepEqual(own.where, { tab: { window: 'claude-1', title: 'one' } })
    assert.deepEqual(own.then, [{ window: { name: 'claude-overflow', pos: [1920, 0], size: [140, 60] } }, { window: true }])
    // No stamp: past the tab.
    const hand = m.pickLaunchTransport(probeOf(m), place, { ...mine, stamp: {} })
    assert.deepEqual(hand.where, { window: { name: 'claude-overflow', pos: [1920, 0], size: [140, 60] } })
    assert.deepEqual(m.pickLaunchTransport(probeOf(m), null, { ...mine, stamp: {} }).where, { window: true })
    // A replacing launch's input rule only when it asks (PM6).
    assert.equal(m.pickLaunchTransport(probeOf(m, { inputIdleSec: 1 }), null, { ...mine, needsInput: true }).wait, 'input')
    assert.deepEqual(m.pickLaunchTransport(probeOf(m, { inputIdleSec: 1 }), null, mine).where, { window: true })
    assert.equal(m.claimOf({ slot: SLOT }), `slot:${SLOT}`)
    assert.equal(m.claimOf({ tab: { window: 'a', title: 'a' } }), undefined, 'a launch\'s own, fresh each time')
    assert.equal(m.claimOf({ window: { name: 'a' } }), undefined)
    assert.equal(m.claimOf({ window: true }), undefined)
  },
  slotRecord(m) {
    const s = scriptsOf(m)
    for (const script of [s.slotStart, s.slotResume]) {
      assert.ok(script.includes('$recordStream = [IO.File]::Open($final, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)'), 'CreateNew')
      assert.ok(script.includes(`$final = '${STATE}\\slots\\${SLOT}.next.json'`))
      assert.ok(script.includes(`$slotBeacon = Get-Beacon ([IO.File]::ReadAllText('${STATE}\\slots\\${SLOT}.state.json'`))
      assert.ok(/-lt 10000\) \{ Refuse 'slot'/.test(script), 'idle for at least 10 s')
      assert.ok(script.includes(`-cne '${m.SLOT_SCRIPT_SHA256}') { Refuse 'slot'`), 'of the shipped hash')
      assert.ok(script.includes("if ($p.Name -eq 'claude.exe' -and [long]$p.ParentProcessId -eq 20) { Refuse 'slot'"), 'childless')
    }
    assert.ok(s.slotStart.includes("start = $id; name = 'lane-x'; folder = $folder;"))
    // The launcher it runs: by this release's pin, whose copy the same run puts at that hash's name before the record.
    for (const script of [s.slotStart, s.slotResume]) {
      const named = script.indexOf(`launcher = '${m.LAUNCH_SCRIPT_SHA256}'`)
      assert.ok(named > 0, 'the record names the launcher')
      const installed = script.indexOf(`$installWhy = Install-Launcher $launchPath $launcherCopy '${m.LAUNCH_SCRIPT_SHA256}'`)
      assert.ok(installed > 0 && installed < named, 'the copy put in place before the record names it')
      assert.ok(script.includes(`$launchPath = '${STATE}\\claude-launch-${m.LAUNCH_SCRIPT_SHA256.slice(0, 8)}.ps1'`))
    }
    assert.ok(s.slotResume.includes('; left = [ordered]@{ size = 12; mtime = 34 } } | ConvertTo-Json -Compress -Depth 3'))
    assert.throws(() => m.launchScriptText(launchInput({ claim: `launch:${T}`, where: { slot: SLOT }, waitForExit: undefined, checks: { ...FLOOR_CHECKS, live: true } })), /slot's claim/)
  },
  beaconsOfRunners(m) {
    const p = m.probeScript({ ids: [T], configDirs: [CONFIG], stateDir: STATE, slots: true, heavySlotRoot: null })
    // A beacon is read only for a runner found running, by its own id: never by listing the folder.
    assert.ok(p.includes('$beaconFile = Join-Path $state ("slots\\" + $runnerId + ".state.json")'))
    assert.ok(!/Get-ChildItem[^\r\n]*slots/.test(p))
    assert.ok(p.indexOf('$runnerId = ') > p.indexOf('-notmatch "-File'))
    for (const name of ['heavyWaiters', 'heavyBusy', 'heavyCap', 'room', 'inputIdleSec', 'holders', 'slots']) assert.ok(p.includes(`$result["${name}"] = `), name)
    // Without slots, the answer is as it was.
    const plain = m.probeScript({ ids: [T], configDirs: [CONFIG], stateDir: STATE })
    assert.ok(!plain.includes('$result["slots"]') && !plain.includes('PrivatePageCount') && !plain.includes('GetLastInputInfo'))
    // Never a command line, a cwd or a name out.
    assert.ok(!/slots(Out)?[^\r\n]*CommandLine[^\r\n]*Add/.test(p))
    assert.ok(!p.includes('path = $slotPath; sha256 = $hashes'))
  },
  parsing(m) {
    const probe = probeOf(m, { slots: [idleRunner(m, {}, { window: 'claude-4', tab: 's1' })], holders: [{ id: T, pid: 100, created: '134062345688901240' }] })
    assert.equal(probe.slots[0].beacon.window, 'claude-4')
    assert.equal(probe.procs.find(p => p.pid === 100).privateBytes, GIB)
    assert.deepEqual(probe.holders, [{ id: T, pid: 100, created: '134062345688901240' }])
    // A bad beacon is dropped, the runner kept.
    for (const beacon of [{ state: 'left', since: 1, configDir: CONFIG }, { state: 'idle', since: 'x', configDir: CONFIG }, { state: 'idle', since: 1, configDir: 'relative' }, { state: 'idle', since: 1, configDir: CONFIG, window: 'last' }, { state: 'idle', since: 1, configDir: CONFIG, tab: 'a;b' }, { state: 'idle', since: 1, configDir: CONFIG, extra: 1 }, 'x', null]) {
      assert.equal(probeOf(m, { slots: [idleRunner(m, { beacon })] }).slots[0].beacon, null, JSON.stringify(beacon))
    }
    // The rest is checked as ever: an answer that isn't of its shape is no answer.
    for (const change of [{ slots: 'x' }, { slots: [{ pid: 'x' }] }, { slots: [idleRunner(m, { id: 'wrong' })] }, { slots: [idleRunner(m, { sha256: 'zz' })] }, { heavyWaiters: -1 }, { heavyBusy: 5 }, { heavyCap: 5 }, { heavyCap: -1 }, { heavy: [{ slot: '.gate-lock-5', winpid: null }] }, { heavy: [{ slot: 'gate-lock', winpid: null }] }, { room: 1.5 }, { inputIdleSec: 'x' }, { holders: [{ id: 'x', pid: 1, created: '1' }] }, { heavyChecked: true, heavy: null }, { heavyChecked: false, heavy: [] }]) {
      assert.ok('error' in m.parseProbe(JSON.stringify(raw(change))), JSON.stringify(change))
    }
    // D3: heavyChecked says what the heavy slots say.
    assert.equal(probeOf(m, { heavyChecked: true, heavy: [] }).heavyChecked, true)
    assert.equal(probeOf(m, { heavyChecked: false, heavy: null, heavyWaiters: null, heavyBusy: null, heavyCap: null }).heavyChecked, false)
    // #46: every slot heavy-slot can use, and its counts up to four.
    const four = probeOf(m, { heavy: m.HEAVY_SLOTS.map((slot, i) => ({ slot, winpid: 100 + i })), heavyBusy: 4, heavyCap: 4 })
    assert.deepEqual([four.heavy.map(h => h.slot), four.heavyBusy, four.heavyCap], [['.gate-lock', '.gate-lock-2', '.gate-lock-3', '.gate-lock-4'], 4, 4])
    assert.equal(probeOf(m, { heavyCap: 0 }).heavyCap, 0)
    // An old probe: no slots mode, all of it null.
    const { slots, heavyWaiters, heavyBusy, heavyCap, room, inputIdleSec, holders, ...old } = raw()
    const parsed = m.parseProbe(JSON.stringify(old))
    assert.deepEqual([parsed.slots, parsed.heavyWaiters, parsed.heavyBusy, parsed.heavyCap, parsed.room, parsed.inputIdleSec, parsed.holders], [null, null, null, null, null, null, null])
  },
  holders(m) {
    // claude.exe 500, under no registry: unknown for every other conversation, unless a lock names it.
    const stuck = [...raw().procs, { pid: 500, ppid: 21, created: '134062345700000000', name: 'claude.exe' }]
    const self = { pid: 100, ppid: 20, created: '134062345688901240' }
    const entry = { dir: 0, file: 100, ok: true, keys: ['pid', 'sessionId', 'procStart'], pid: 100, sessionId: OTHER, procStart: self.created }
    const transcripts = [{ id: T, dir: 0, project: 'p', mtime: NOW - 3_600_000 }, { id: FRESH, dir: 0, project: 'p', mtime: NOW - 3_600_000 }]
    const without = probeOf(m, { procs: stuck, registry: [entry], transcripts })
    assert.equal(m.liveness(without, T, NOW).verdict, 'unknown', 'unaccounted, it reads unknown')
    const held = probeOf(m, { procs: stuck, registry: [entry], transcripts, holders: [{ id: FRESH, pid: 500, created: '134062345700000000' }] })
    assert.equal(m.liveness(held, T, NOW).verdict, 'not-live', 'accounted: no unknown for another conversation')
    assert.equal(m.liveness(held, FRESH, NOW).verdict, 'live', 'live for its own id')
    // A holder gone, or of another start, accounts for nothing.
    const wrong = probeOf(m, { procs: stuck, registry: [entry], transcripts, holders: [{ id: FRESH, pid: 500, created: '1' }] })
    assert.equal(m.liveness(wrong, T, NOW).verdict, 'unknown')
    // A lock with a holder isn't stale while that one runs, however old; it is once it has gone.
    const lock = { id: FRESH, mtime: NOW - 3_600_000, ok: true, by: `launch:${FRESH}`, pid: 4, created: '1', at: NOW - 3_600_000, transport: 'tab', holder: { pid: 500, created: '134062345700000000' } }
    assert.equal(m.liveness(probeOf(m, { procs: stuck, registry: [entry], transcripts, locks: [lock] }), FRESH, NOW).verdict, 'live')
    assert.equal(m.liveness(probeOf(m, { registry: [entry], transcripts, locks: [lock] }), FRESH, NOW).verdict, 'not-live', 'stale once the holder has gone')
    // The claim's takeover respects it too, in PowerShell.
    assert.ok(m.probeScript({ ids: [T], take: T, configDirs: [CONFIG], stateDir: STATE }).includes('$holds = $table[[int]$old.holder.pid]'))
  },
  freshness(m) {
    const s = scriptsOf(m).slotStart
    assert.ok(s.includes('foreach ($dir in $configDirs) {\r\n  $projects = Join-Path $dir "projects"\r\n  if ($null -eq $fresh'), 'every config folder')
    assert.ok(s.indexOf("Refuse 'fresh'") < s.indexOf('$taken = New-Claim'))
  },
  relock(m) {
    const s = m.relockScript({ stateDir: STATE, id: T, by: `launch:${FRESH}`, holder: { pid: 77, created: '134062345678901240' } })
    assert.ok(s.includes(`if ($null -eq $lock -or $lock.by -cne 'launch:${FRESH}') { $answer = 'not-ours' }`), 'only a lock naming this launch')
    assert.ok(s.includes("holder = [ordered]@{ pid = 77; created = '134062345678901240' }"))
    assert.ok(s.includes('[IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)'))
    assert.throws(() => m.relockScript({ stateDir: STATE, id: '..\\x', by: `launch:${FRESH}`, holder: { pid: 1, created: '1' } }))
    assert.throws(() => m.relockScript({ stateDir: STATE, id: T, by: 'x', holder: { pid: 1, created: '1' } }))
    assert.throws(() => m.relockScript({ stateDir: STATE, id: T, by: `launch:${FRESH}`, holder: { pid: 'x', created: '1' } }))
  },
  windowRefusal(m) {
    // N2: a line that runs as printed. N5: a window that refuses gives the claim back. N6: one withdrawn is closed.
    const inner = (() => {
      const w = scriptsOf(m).plain
      const from = w.indexOf("$inner = '") + "$inner = '".length
      let end = from
      for (let i = from; i < w.length; i += 1) {
        if (w[i] === "'" && w[i + 1] === "'") {
          i += 1
          continue
        }
        if (w[i] === "'") {
          end = i
          break
        }
      }
      return w.slice(from, end).split("''").join("'")
    })()
    assert.ok(inner.includes(`$handPath = '${STATE}\\claude-launch.ps1'`))
    // F1: waited for by its handle and start time (WaitForExit, past the gap between the exit code and the signal), asked
    // whether it has gone, never looked for in the table; and a process that outlasts the first wait looked at again until it goes.
    assert.ok(/ {2}\$gone = Wait-Gone 100 '\d+' 30\r\n/.test(inner) && !inner.includes('Wait-Process') && !inner.includes('Get-Process -Id'), 'the old process waited for by its handle, look by look, and asked whether it has exited')
    assert.ok(inner.includes('[void]$h.WaitForExit([int]$seconds * 1000)'), 'WaitForExit, not Wait-Process')
    assert.ok(inner.includes('$other = $false; if ($created -and "$created" -ne "0") { try { $other = [math]::Abs($h.StartTime.ToFileTimeUtc() - [long]$created) -gt 10000 } catch { $other = $false } }; if ($other) { return $true }'), 'a pid given to another process is not the one waited for; an unread start time ("0") or one that can\'t be read waits by the pid')
    assert.ok(inner.includes('while (-not $gone) {\r\n'), 'a process that outlasts the first look: looked at again until it goes')
    // The claim read at every look: a move taken back ends the wait at once, said and recorded.
    const look = inner.indexOf('  if ($claimSays -eq "gone" -or $claimSays -eq "other") { $refusal = ')
    assert.ok(look > inner.indexOf('while (-not $gone) {') && inner.includes('  if (-not (Test-Path -LiteralPath $claimPath)) { $claimSays = "gone" } else { try { $held = Get-Content -LiteralPath $claimPath -Raw -Encoding UTF8 | ConvertFrom-Json; '), 'the claim read at every look')
    const cleared = inner.indexOf('$refusal = $null')
    assert.ok(cleared > 0 && cleared < inner.indexOf('while (-not $gone) {') && inner.split('$refusal = $null').length === 2, 'a refusal while waiting stands: it is not cleared after the wait')
    // The 10-minute line by the clock, never by the count of looks (a start time that can't be read makes each look short).
    assert.ok(inner.includes('  if (-not $toldLong -and $waitClock.Elapsed.TotalSeconds -ge 600) { $toldLong = $true; Write-Host '), 'the 10-minute line by the clock')
    // Exit 2 recorded as a refusal only at once: claude-launch.ps1's own refusal, never Claude Code's own exit code after a session.
    assert.ok(inner.includes('  if ($code -eq 2 -and -not $resumedHere -and ((Get-Date) - $started).TotalSeconds -lt 60) { Write-Refused '), 'exit 2 recorded only within a minute (the launcher\'s last look under load), and never once the window resumed another conversation')
    // R3 (delta): only a clear answer ends the wait: the claim gone, or naming another; one that can't be read is looked at again.
    assert.ok(inner.includes('  if ($claimSays -eq "gone" -or $claimSays -eq "other") { $refusal = '), 'only a clear answer ends the wait')
    assert.ok(inner.includes('  if ($claimSays -eq "unknown") { $unread++ } else { $unread = 0 }') && inner.includes('  if ($unread -ge 10) { $refusal = '), 'a claim unreadable for 10 looks in a row ends the wait, saying so')
    assert.ok(!inner.includes('The old process is still running'), 'no refusal for a process still running: it keeps waiting')
    // The refused record: every refusal and every error the window says is written for whoever comes looking.
    assert.ok(/Write-Refused \$refusal\r\n {2}Write-Host \$refusal/.test(inner), 'a refusal is recorded before it is said')
    assert.ok(inner.includes('  Write-Refused ("claude-launch.ps1 stopped on an error: " + $_.Exception.Message)'), 'an error is recorded')
    assert.ok(inner.includes(`$refusedPath = '${STATE}\\refused\\`), 'at its id-shaped path')
    assert.ok(inner.includes(`"& '" + $handPath + "' -Resume " + $id + " -Dir '" + $folder + "'"`), 'N2')
    assert.ok(/Write-Host \$refusal\r\n.*\r\n {2}Release-Claim\r\n {2}Read-Host/.test(inner), 'N5: the refusal gives the claim back before it waits')
    assert.ok(inner.includes('function Release-Claim {'))
    // D2: the launcher refusing or ending non-zero gives this launch's claim back, before the window waits; a normal end, even a short one, doesn't.
    assert.ok(/Claude Code ended \(exit code \$code\)\."\r\n.*\r\n {2}if \(\$code -ne 0\) \{ Release-Claim \}\r\n {2}Read-Host/.test(inner), 'D2')
    // D4: the delete tried again, and it never throws, so a window's words and its Enter are never lost to it.
    assert.ok(inner.includes('      for ($try = 0; $try -lt 3; $try++) {\r\n        if ($try -gt 0) { Start-Sleep -Milliseconds 250 }\r\n        try { [IO.File]::Delete($claimPath); break } catch { }\r\n'), 'D4: tried three times')
    assert.ok(inner.includes('  } catch { } finally { $stream.Dispose() }\r\n'), 'D4: never throws')
    const late = m.launchScriptText(launchInput({ deadline: NOW }))
    assert.ok(late.includes('if ($transport -eq "window" -and $null -ne $window) { try { $window.Kill() } catch { };'), 'N6')
  },
  async trampoline(m) {
    assert.equal(m.GO_VIA, 'direct', 'it ships as direct: the flip is one commit after M17a-d')
    const queued = []
    const fake = hang => ({ command: { run: command => (queued.push(command), hang && command.command !== 'x-go' ? new Promise(() => undefined) : Promise.resolve({})) } })
    const log = []
    const step = change => ({
      command: 'exit',
      conversation: T,
      holds: async () => T,
      agents: async () => [],
      failed: async () => log.push('failed'),
      withdraw: async said => log.push(`withdraw: ${said}`),
      after: async () => log.push('after'),
      before: async () => log.push('before'),
      runs: 'runs now',
      ...change,
    })
    const armed = async (go, s = step(), hang = false) => {
      queued.length = 0
      log.length = 0
      go.via = 'trampoline'
      const $ = fake(hang)
      await m.goRun($, go, s)
      assert.equal(queued.length, 1)
      assert.equal(queued[0].command, 'x-go')
      assert.match(queued[0].args, /^[0-9a-f]{16}$/)
      return { $, nonce: queued[0].args }
    }
    // Direct: the plain command, as before.
    {
      const go = m.goStep('x-go')
      assert.equal(go.via, m.GO_VIA)
      go.via = 'direct'
      queued.length = 0
      log.length = 0
      await m.goRun(fake(false), go, step())
      assert.deepEqual(queued, [{ command: 'exit' }])
      assert.deepEqual(log, ['before', 'after'])
    }
    // Through it: the inner command only at dequeue, unawaited: a command that never answers doesn't hold the handler.
    {
      const go = m.goStep('x-go')
      const { $, nonce } = await armed(go, step(), true)
      assert.deepEqual(queued.map(c => c.command), ['x-go'], 'not before it is dequeued')
      const answer = await Promise.race([m.goAnswer($, go, nonce), new Promise(resolve => setTimeout(() => resolve('held'), 500))])
      assert.notEqual(answer, 'held', 'the inner command is never awaited')
      assert.deepEqual(answer, { text: 'runs now' })
      assert.deepEqual(queued.map(c => c.command), ['x-go', 'exit'])
      assert.deepEqual(log, ['before'])
    }
    // A wrong nonce, or none armed, does nothing; the right one still goes.
    {
      const go = m.goStep('x-go')
      const { $, nonce } = await armed(go)
      assert.deepEqual(await m.goAnswer($, go, 'typed by a person'), { text: m.GO_NOTHING })
      assert.deepEqual(queued.map(c => c.command), ['x-go'])
      assert.deepEqual(log, [])
      assert.deepEqual(await m.goAnswer($, go, nonce), { text: 'runs now' })
      assert.deepEqual(await m.goAnswer($, go, nonce), { text: m.GO_NOTHING }, 'used once')
    }
    // A turn between arming and dequeue stands it down: withdrawn, the command never queued.
    {
      const go = m.goStep('x-go')
      const { $, nonce } = await armed(go)
      go.turnStarted()
      go.turnEnded()
      assert.match((await m.goAnswer($, go, nonce)).text, /stood down: a turn came first/)
      assert.deepEqual(queued.map(c => c.command), ['x-go'])
      assert.deepEqual(log, ['withdraw: a turn came first'])
    }
    // A turn still running.
    {
      const go = m.goStep('x-go')
      const { $, nonce } = await armed(go)
      go.turnStarted()
      await m.goAnswer($, go, nonce)
      assert.deepEqual(log, ['withdraw: a turn came first'])
    }
    // Another conversation by the event's id; a subagent; agents unread; a process under it.
    for (const [change, said] of [
      [{ holds: async () => OTHER }, /another conversation/],
      [{ agents: async () => [{ status: 'running', description: 'Lint' }] }, /a subagent is still running \(Lint\)/],
      [{ agents: async () => "can't" }, /subagents can't be read/],
      [{ probe: async () => 'it failed' }, /machine probe failed/],
      [{ probe: async () => probeOf(m, { procs: [...raw().procs, { pid: 400, ppid: 100, created: '134062355668901241', name: 'bash.exe', cls: 'shell' }] }) }, /S6: bash\.exe 400/],
    ]) {
      const go = m.goStep('x-go')
      const { $, nonce } = await armed(go, step(change))
      assert.match((await m.goAnswer($, go, nonce)).text, said)
      assert.ok(log[0].startsWith('withdraw:'), log[0])
      assert.deepEqual(queued.map(c => c.command), ['x-go'])
    }
    // A clear process tree goes ahead.
    {
      const go = m.goStep('x-go')
      const { $, nonce } = await armed(go, step({ probe: async () => probeOf(m) }))
      assert.deepEqual(await m.goAnswer($, go, nonce), { text: 'runs now' })
      assert.deepEqual(queued.at(-1), { command: 'exit' })
    }
    // Its queueing failing is said to `failed`, and leaves nothing armed.
    {
      const go = m.goStep('x-go')
      go.via = 'trampoline'
      // The step above left its command unawaited: its `after` lands first, not in this log.
      await new Promise(resolve => setImmediate(resolve))
      log.length = 0
      await m.goRun({ command: { run: () => Promise.reject(new Error('refused')) } }, go, step())
      assert.deepEqual(log, ['failed'])
    }
  },
  async wakeRead(m) {
    assert.equal(m.wakeStale({ armed: true, due: NOW - m.WAKE_STALE_GRACE_MS - 1, at: 1 }, NOW), true)
    assert.equal(m.wakeStale({ armed: true, due: NOW - m.WAKE_STALE_GRACE_MS, at: 1 }, NOW), false)
    assert.equal(m.wakeStale({ armed: false, at: 1 }, NOW), false)
    const $ = text => ({ tool: { list: async () => [{ name: m.SELF_WAKE_TOOL }] }, fs: { exists: async () => true, read: async () => text } })
    const past = m.wakeMarker({ armed: true, due: NOW - 3_600_000, at: 1 })
    // Its own session reads its own marker as it stands; another reader doesn't take a stale one's word.
    assert.equal((await m.readWake($(past), STATE, T)).wake, 'pending')
    const other = await m.readWake($(past), STATE, T, { now: NOW })
    assert.equal(other.wake, 'unknown')
    assert.match(other.why, /which has passed/)
    assert.equal((await m.readWake($(m.wakeMarker({ armed: true, due: NOW + 60_000, at: 1 })), STATE, T, { now: NOW })).wake, 'pending')
    // As exitBlockers takes it.
    assert.deepEqual(m.exitWake({ wake: 'pending', due: 5 }), { due: 5 })
    assert.equal(m.exitWake({ wake: 'none', why: 'x' }), null)
    assert.equal(m.exitWake({ wake: 'unknown', why: 'x' }), 'x')
  },
  async exitInputs(m) {
    // S1-9: readExit carries the wake-up, so exitBlockers names it. Tasks are not wired: no gating hook for them.
    const $ = {
      clock: { after: () => ({ cancel: () => undefined }) },
      tool: { check: async () => ({ decision: 'allow' }), call: async () => ({ result: { jobs: [] } }), list: async () => [{ name: m.SELF_WAKE_TOOL }] },
      agent: { list: async () => [] },
      fs: { exists: async () => true, read: async () => m.wakeMarker({ armed: true, due: NOW, at: 1 }) },
    }
    const read = await m.readExit($, undefined, { wake: { state: STATE, id: T } })
    const found = m.exitBlockers(read)
    assert.deepEqual(found.map(b => b.kind), ['wake'])
    assert.match(found[0].howToStop, /cancel_wake/)
  },
  perLaunchClaim(m) {
    // F1: two launches of one conversation name two claims, each on its own tab's line.
    const one = `launch:${FRESH}`
    const two = `launch:${OTHER}`
    const line = claim => wtLineOf(m.launchScriptText(launchInput({ claim, where: { tab: { window: 'a', title: 'a' } } })))
    assert.ok(line(one).includes(`-Claim ${one} `) && line(two).includes(`-Claim ${two} `))
    assert.ok(m.launchScriptText(launchInput({ claim: one, where: { window: { name: 'a' } } })).includes(`-Claim ${one} `))
    assert.throws(() => m.wtTabLine({ powershell: POWERSHELL, stateDir: STATE, window: 'a', title: 'a', folder: 'C:\\work', run: { resume: T, claim: `slot:${SLOT}` } }), /launch's own/)
    assert.throws(() => m.launchScriptText(launchInput({ claim: `slot:${SLOT}`, where: { window: { name: 'a' } } })), /names a launch's claim/)
  },
  slotLive(m) {
    // F4: the pane's slot by what it runs: the file's hash, and its own beacon, by its id, at that hash.
    const slot = live => ({ slot: { pid: 20, created: '134062345678901240', id: SLOT, path: `${STATE}\\claude-slot.ps1`, sha256: m.SLOT_SCRIPT_SHA256, ...(live === undefined ? {} : { live }) } })
    const pick = change => m.pickLaunchTransport(probeOf(m, change), null, { ...PICK, replacing: true })
    assert.deepEqual(pick(slot(true)).where, { slot: SLOT })
    for (const stale of [false, undefined]) {
      assert.deepEqual(pick(slot(stale)).where, { window: true })
      assert.equal(pick(slot(stale)).fallback, m.SLOT_NOT_LIVE)
    }
    const script = m.probeScript({ ids: [T], configDirs: [CONFIG], stateDir: STATE })
    assert.ok(script.includes(`if ($null -eq $slotLook -or $slotLook["sha256"] -cne '${m.SLOT_SCRIPT_SHA256}') { $slotOk = $false; $slotStale = $true }`))
    assert.ok(script.indexOf('function Get-Beacon') < script.indexOf('$slotLook = Get-Beacon'), 'defined before it is called')
    const auto = m.launchScriptText(launchInput({ where: 'auto' }))
    assert.ok(auto.includes('elseif ($slotStale) { $slotFallback ='), 'auto: a window, saying why')
    assert.ok(auto.indexOf('function Get-Beacon') < auto.indexOf('$slotLook = Get-Beacon'), 'defined before it is called')
    // A slot elsewhere: its beacon says what it runs, or it is passed over.
    const place = placementOf(m)
    assert.deepEqual(m.idleSlots(probeOf(m, { slots: [idleRunner(m, {}, { sha256: 'e'.repeat(64) })] }), place, { configDir: CONFIG, now: NOW }), [], 'older code still running')
    assert.ok(scriptsOf(m).slotStart.includes(`if ($slotBeacon['sha256'] -cne '${m.SLOT_SCRIPT_SHA256}') { Refuse 'slot'`))
  },
  workspaceTabs(m) {
    // F3: a tab or a named window tagged for another workspace is passed over, saying so.
    const read = m.readPlacement(JSON.stringify({ v: 1, layout: [], launch: { prefer: ['tab', 'window'], tab: { window: 'claude-4', maxTabs: 2 }, window: { name: 'claude-overflow' } }, workspaces: { 'claude-4': 'default', 'claude-overflow': 'default' } }))
    if ('errors' in read) throw new Error(read.errors.join('; '))
    const pick = workspace => m.pickLaunchTransport(probeOf(m, { slots: [] }), read.placement, { ...PICK, workspace, title: 't', folder: 'C:\\work' })
    assert.deepEqual(pick('default').where, { tab: { window: 'claude-4', title: 't' } }, 'its own')
    assert.equal(pick('w_abcdefghijkl').wait, 'slot', 'another workspace: neither')
    assert.match(pick('w_abcdefghijkl').why, /window claude-4 is tagged for another workspace; window claude-overflow is tagged for another workspace/)
    // D1: a launch of another process names one, with or without a placement: with none, it would land in tagged tabs and windows.
    assert.throws(() => pick(undefined), /names its workspace/)
    assert.throws(() => m.pickLaunchTransport(probeOf(m, { slots: [] }), null, { ...PICK, workspace: undefined }), /names its workspace/)
    // A launch that replaces its caller names none, and goes where it goes, tags or no.
    const moved = m.pickLaunchTransport(probeOf(m, { slots: [] }), read.placement, { replacing: true, configCount: 1, needsLeft: false, title: 't', folder: 'C:\\work' })
    assert.deepEqual(moved.where, { tab: { window: 'claude-4', title: 't' } }, 'a caller that names no workspace is not held to one')
  },
  wtByItsPath(m) {
    // N2: never a bare name, which would search the conversation's own folder too.
    const s = scriptsOf(m).tabStart
    assert.ok(s.includes("$wtExe = Join-Path (Split-Path -Parent $state) 'Microsoft\\WindowsApps\\wt.exe'"))
    assert.ok(s.includes('-or -not (Test-Path -LiteralPath $wtExe -PathType Leaf)'))
    assert.ok(!/Start-Process wt/.test(s))
    // N4: a plain window keeps no tab's stamp.
    assert.ok(scriptsOf(m).plain.includes("$env:CLAUDE_SELF_TOOLS_WT_WINDOW = $null") && scriptsOf(m).plain.includes("$env:CLAUDE_SELF_TOOLS_WT_TAB = $null"))
    // N1: reserved for quake mode.
    assert.equal(m.isWindowName('_quake'), false)
  },
  relockHolder(m) {
    // N12: a different holder, still running, stays.
    const s = m.relockScript({ stateDir: STATE, id: T, by: `launch:${FRESH}`, holder: { pid: 77, created: '134062345678901240' } })
    assert.ok(s.includes("if ($held) { $answer = 'held' } else {"))
    assert.equal(m.RELOCKED.exec('held\r\n')?.[1], 'held')
  },
  windowFile(m) {
    // The window's own script: a file of its own, named by the launch's claim, written whole with a byte order
    // mark, run by -File, and deleted by the window first. Never a self-unpacking -EncodedCommand (GZip, base64,
    // [scriptblock]::Create), which an antivirus hooked into AMSI blocks before a line of it runs.
    const s = scriptsOf(m).plain
    const file = m.windowScriptPath(STATE, FRESH)
    assert.ok(s.includes(`$windowPath = '${file}'`), "the launch's own file")
    assert.ok(s.includes(`$window = Start-Process -FilePath $windowShell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $windowFile + '"') -PassThru`), '-File, the path quoted')
    assert.ok(!/GZipStream|\$unpack|\$encoded|'-EncodedCommand'|\[scriptblock\]::Create/.test(s), 'no self-unpacking bootstrap')
    // SW-L-2: its bytes with a byte order mark, a temporary created for this run alone, written and flushed, then
    // moved to its name; a temporary of its own deleted on a failure; and the file this run's own only once in place.
    const bom = s.indexOf('[byte[]]$windowBytes = [Text.UTF8Encoding]::new($true).GetPreamble() + [Text.UTF8Encoding]::new($true).GetBytes($inner)')
    const open = s.indexOf('$windowStream = [IO.File]::Open($windowTemp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)')
    const flush = s.indexOf('try { $windowStream.Write($windowBytes, 0, $windowBytes.Length); $windowStream.Flush($true) } finally { $windowStream.Dispose() }')
    const move = s.indexOf('[IO.File]::Move($windowTemp, $windowPath)')
    const cleaned = s.indexOf('} catch { try { [IO.File]::Delete($windowTemp) } catch { }; throw }')
    const own = s.indexOf('$windowFile = $windowPath')
    const start = s.indexOf('$window = Start-Process -FilePath')
    assert.ok(bom > 0 && open > bom && flush > open && move > flush && cleaned > move && own > cleaned && start > own, "with a byte order mark, created anew, written and flushed, moved, and only then the run's own, before the window starts")
    assert.ok(s.includes(` } catch { }\r\ntry { [IO.File]::Delete(''${file}'') } catch { }\r\n$ErrorActionPreference = "Stop"\r\n`), 'the window deletes its own file right after its start signal, before anything else')
    assert.ok(s.includes(`.TotalMilliseconds -gt ${m.CLAIM_STALE_MS}) { try { [IO.File]::Delete($staleFile) } catch { } }`), 'only a file older than a stale claim is swept')
    assert.ok(s.includes(`-cmatch '${m.LAUNCH_ID.source.replace(/\$$/, '')}\\.ps1(\\.[0-9a-f]{32}\\.tmp)?\\z'`), "only names of LAUNCH_ID's shape are swept")
    // A file the window never read: deleted with a place that failed, and with a window withdrawn once it has gone.
    assert.ok(s.includes("} catch { $placeWhy = $_.Exception.Message; if ($null -ne $windowFile) { try { [IO.File]::Delete($windowFile) } catch { } }; Refuse 'place'"), 'a place that failed deletes the file')
    const late = m.launchScriptText(launchInput({ claim: `launch:${FRESH}`, deadline: NOW }))
    assert.ok(late.includes('try { $window.Kill() } catch { }; if ($null -ne $windowFile) { try { [void]$window.WaitForExit(2000) } catch { }; try { [IO.File]::Delete($windowFile) } catch { } } }'), 'a withdrawn window deletes the file')
  },
  windowPolicy(m) {
    // A Group Policy execution policy that runs no unsigned script file: read for whichever PowerShell the window
    // would run in (PowerShell 7's own key, or Windows PowerShell's where it defers), before anything is written or
    // claimed, refused as `policy`; and only where a window opens ('auto' going to the window, a named window
    // falling back to the plain one).
    const s = scriptsOf(m).plain
    const pwsh = s.indexOf("if ($pwshOk) { $pwshPolicy = Read-GroupPolicy 'Software\\Policies\\Microsoft\\PowerShellCore' $true; if ($pwshPolicy -eq 'AllSigned' -or $pwshPolicy -eq 'Restricted') { $pwshOk = $false } }")
    assert.ok(pwsh > 0, "PowerShell 7's own policy read, and it passed over when it runs no unsigned file")
    const refused = s.indexOf("if (-not $pwshOk) { $windowsPolicy = Read-GroupPolicy 'Software\\Policies\\Microsoft\\Windows\\PowerShell' $false; if ($windowsPolicy -eq 'AllSigned' -or $windowsPolicy -eq 'Restricted') {")
    assert.ok(refused > pwsh && s.indexOf("Refuse 'policy'", refused) > refused, "Windows PowerShell's policy read when PowerShell 7 isn't the window's, and refused on")
    assert.ok(s.indexOf("Refuse 'policy'") < s.indexOf('$installWhy = Install-Launcher') && s.indexOf("Refuse 'policy'") < s.indexOf('$taken = New-Claim'), 'refused before anything is written or claimed')
    assert.ok(s.includes("if ($defer -is [int] -and $defer -eq 1) { $key.Dispose(); $key = $null; $key = $root.OpenSubKey('Software\\Policies\\Microsoft\\Windows\\PowerShell') }"), "PowerShell 7's key defers to Windows PowerShell's")
    assert.ok(s.includes("} catch { $policy = 'Undefined' } finally {"), 'a read that fails is Undefined, never refused on')
    const auto = m.launchScriptText(launchInput({ claim: `launch:${FRESH}`, where: 'auto' }))
    assert.ok(auto.includes("\r\nif ($transport -eq 'window') {\r\n  try { $pwsh = "), "'auto' reads it only when it goes to the window")
    assert.ok(scriptsOf(m).named.includes('\r\nif ($null -ne $slotFallback) {\r\n  try { $pwsh = '), 'a named window reads it only when it falls back to the plain one')
    for (const [name, script] of Object.entries(scriptsOf(m)).filter(([name]) => name.startsWith('slot') || name.startsWith('tab'))) assert.ok(!script.includes("Refuse 'policy'"), `${name} opens no window and is never refused for it`)
  },
  windowSignal(m) {
    // WF-M-1: the window's start signal, which nothing but the window can give: an event created for this launch
    // alone once its file is in place and before Start-Process (one already there refuses the place), disposed on
    // every path; the window's first line sets it, then it deletes its file.
    const s = scriptsOf(m).plain
    const name = m.windowSignalName(FRESH)
    assert.equal(name, `Local\\claude-self-tools-window-${FRESH}`, 'in this session, by the claim')
    assert.throws(() => m.windowSignalName(`launch:${FRESH}`), 'a launch id alone')
    const lines = s.split('\r\n').map(line => line.trim())
    const own = lines.indexOf('$windowFile = $windowPath')
    const named = lines.indexOf(`$windowSignalName = '${name}'`)
    const created = lines.indexOf('$windowSignal = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, $windowSignalName, [ref]$windowSignalNew)')
    const ours = lines.findIndex(line => line.startsWith('if (-not $windowSignalNew) { throw ('))
    const start = lines.findIndex(line => line.startsWith('$window = Start-Process -FilePath'))
    const disposed = lines.indexOf('} finally { $windowSignal.Dispose() }')
    const placed = lines.indexOf('$placed = "window - " + $window.Id')
    assert.ok(own > 0 && named > own && created > named && ours === created + 2 && start === ours + 1 && disposed > start && placed === disposed + 1, 'created once the file is in place, refused when not its own, before the window; disposed before placed')
    assert.ok(s.includes(`$inner = 'try { $launchSignal = [Threading.EventWaitHandle]::OpenExisting(''${name}''); try { [void]$launchSignal.Set() } finally { $launchSignal.Dispose() } } catch { }\r\ntry { [IO.File]::Delete(''${m.windowScriptPath(STATE, FRESH)}'') } catch { }\r\n`), 'the window sets it as its first line, then deletes its file')
  },
  windowStart(m) {
    // WF-M-1, WF-M-2: the window watched until its start signal: its handle taken at once; at each look its end read
    // before the signal, so one that ended without it never began, and is thrown on; at the bound (WINDOW_START_MS, or
    // the deadline when that comes first) one not begun is ended through its handle, and thrown on all the same with
    // none held. The place's catch turns each into `refused place`. Never placed without its signal.
    const late = m.launchScriptText(launchInput({ claim: `launch:${FRESH}`, deadline: NOW }))
    const lines = late.split('\r\n').map(line => line.trim())
    const start = lines.findIndex(line => line.startsWith('$window = Start-Process -FilePath'))
    const held = lines.indexOf('try { $windowHeld = $null -ne $window.Handle } catch { $windowHeld = $false }')
    const limit = lines.indexOf(`$windowLimit = ${m.WINDOW_START_MS}`)
    const capped = lines.indexOf(`$windowLimit = [math]::Min($windowLimit, [math]::Max(0, ${NOW} - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()))`)
    const ended = lines.indexOf('try { $windowEnded = $true -eq $window.HasExited } catch { $windowEnded = $false }')
    const signal = lines.indexOf('if ($windowSignal.WaitOne(0)) { break }')
    const thrown = lines.findIndex(line => line.startsWith('if ($windowEnded) {') && line.includes('throw ("the window ended before its first line ran'))
    const bound = lines.indexOf('if ($windowWatch.ElapsedMilliseconds -ge $windowLimit) {')
    const kill = lines.indexOf('if ($windowHeld) { try { $window.Kill() } catch { }; try { [void]$window.WaitForExit(2000) } catch { }; try { $windowGone = $true -eq $window.HasExited } catch { $windowGone = $false } }')
    const wait = lines.indexOf('[void]$windowSignal.WaitOne(100)')
    const placed = lines.indexOf('$placed = "window - " + $window.Id')
    assert.ok(start > 0 && held === start + 2 && limit > held && capped === limit + 1 && ended > capped && signal === ended + 1 && thrown === signal + 1 && bound === thrown + 1 && lines[bound + 2] === '$windowGone = $false' && kill === bound + 3 && wait > kill && placed > wait, 'the handle at once; the bound, capped at the deadline; at each look its end, then the signal, then the throw, then the bound; at the bound the Kill, then whether it has gone; a wait on the signal; placed after')
    // R2-I-2: "ended" only once it has gone; else (no handle, a Kill that failed, not gone after the wait) refused all the same, saying it could not be ended.
    assert.ok(lines[kill + 1].startsWith('if ($windowGone) { throw ("the window had not begun ') && lines[kill + 1].includes('so it was ended;'), 'said ended only once gone')
    assert.ok(lines[kill + 2].startsWith('throw ("the window had not begun ') && lines[kill + 2].includes('and could not be ended; its claim is given back, so it resumes nothing;'), 'else refused all the same, saying it could not be ended')
    assert.ok(!late.includes('Start-Sleep -Milliseconds 100'), 'between looks it waits on the signal, not a sleep')
    assert.ok(!m.launchScriptText(launchInput({ claim: `launch:${FRESH}` })).includes('[math]::Min($windowLimit'), 'no deadline: the bound alone')
    assert.ok(m.WINDOW_START_MS >= 1000 && m.WINDOW_START_MS * 2 <= m.LAUNCH_DEADLINE_MS, 'seconds, well inside the deadline')
  },
  leftAtLastLook(m) {
    // D1: every stat a window takes, claude-launch.ps1 takes.
    assert.ok(m.LAUNCH_SCRIPT_TEXT.includes("$Whole = '^\\d{1,16}\\z'"))
    assert.ok(String(2 ** 53).length <= 16)
    // A slot's record carries the stat; the tab's arguments do.
    assert.ok(wtLineOf(m.launchScriptText(launchInput({ where: { tab: { window: 'a', title: 'a' } }, left: { size: 12, mtime: 34 } }))).includes('-LeftSize 12 -LeftMtime 34'))
    assert.ok(wtLineOf(m.launchScriptText(launchInput({ where: { tab: { window: 'a', title: 'a' } }, left: { exitAt: 56 } }))).includes('-LeftExitAt 56'))
  },
  placeFile(m) {
    // #5: a window with no name is the plain window, at its place; a named window and a layout window take maximized.
    const read = file => m.readPlacement(JSON.stringify(file))
    const plain = read({ v: 1, layout: [], launch: { prefer: ['window'], window: { rect: [-1920, 0, 1280, 800] } }, restart: { prefer: ['window'], window: { maximized: true } } })
    assert.deepEqual(plain.placement.launch.window, { rect: [-1920, 0, 1280, 800] }, 'no name: the plain window, at its rect')
    assert.deepEqual(plain.placement.restart.window, { maximized: true })
    const named = read({ v: 1, layout: [{ window: 'w1', pos: [2100, 300], maximized: true, tabs: ['t'], folder: 'C:\\work' }], launch: { prefer: ['window'], window: { name: 'w2', maximized: true } } })
    assert.equal(named.placement.layout[0].maximized, true)
    assert.deepEqual(named.placement.launch.window, { name: 'w2', maximized: true })
    // A file valid before reads as it read: nothing added to a named window that names no new key.
    assert.deepEqual(read({ v: 1, layout: [], launch: { prefer: ['window'], window: { name: 'w2', pos: [1, 2], size: [100, 30] } } }).placement.launch.window, { name: 'w2', pos: [1, 2], size: [100, 30] })
    // Each refusal says what is wrong: a named window's rect as not built, naming pos and size.
    const said = window => (read({ v: 1, layout: [], launch: { prefer: ['window'], window } }).errors ?? []).join('; ')
    assert.match(said({ name: 'w1', rect: [0, 0, 800, 600] }), /^launch\.window has a rect, which a named window does not take \(not built\): give it pos, in pixels, and size, in columns and rows$/)
    assert.match((read({ v: 1, layout: [{ window: 'a', rect: [0, 0, 800, 600], tabs: ['t'], folder: 'C:\\work' }] }).errors ?? []).join('; '), /^layout\[0\] has a rect, which a named window does not take \(not built\)/)
    assert.match(said({ pos: [0, 0], maximized: true }), /^launch\.window has no name, so it is the plain window, which takes rect and maximized: pos and size are a named window's$/)
    assert.match(said({}), /^launch\.window has no name and no rect or maximized: name a window, or give the plain window its place$/)
    assert.match(said({ maximized: false }), /maximized that is not true/)
    assert.match(said({ rect: [0, 0, 319, 600] }), /rect that is not four whole numbers \[x, y, width, height\]: x and y within 32768, a width of 320 to 32768 and a height of 200 to 32768/)
    assert.match(said({ name: 'w1', maximized: 'true' }), /maximized that is not true/)
    assert.match(said({ rect: [0, 0, 800, 600], colour: 'red' }), /launch\.window has an unknown key colour/)
    // isRect's edges, as RECT_LIMITS says them.
    assert.deepEqual(m.RECT_LIMITS, { coordinate: 32768, minWidth: 320, minHeight: 200, max: 32768 })
    for (const good of [[-32768, 32768, 320, 200], [32768, -32768, 32768, 32768]]) assert.equal(m.isRect(good), true, JSON.stringify(good))
    for (const bad of [[0, 0, 319, 200], [0, 0, 320, 199], [32769, 0, 320, 200], [0, -32769, 320, 200], [0, 0, 32769, 200], [0, 0, 320, 32769], [0, 0, 320.5, 200], [0, 0, 320], [0, 0, 320, 200, 1], '0,0,320,200', null]) assert.equal(m.isRect(bad), false, JSON.stringify(bad))
  },
  gridFile(m) {
    // #91: the grid, read; each refusal says what is wrong.
    const read = file => m.readPlacement(JSON.stringify(file))
    const windows = [{ window: 'a-1', rect: [-7, 0, 494, 523], tabs: ['alpha', 'beta'] }, { window: 'a-2', rect: [473, 0, 494, 523] }, { window: 'b-1', maximized: true }]
    assert.deepEqual(read({ v: 1, layout: [], grid: { windows } }).placement.grid, { windows }, 'a fixed slot, a free cell and a maximized free cell, as written')
    assert.equal(read({ v: 1, layout: [] }).placement.grid, undefined, 'no grid: none')
    assert.deepEqual(m.GRID_LIMITS, { windows: 16, tabs: 16 })
    const said = grid => (read({ v: 1, layout: [], grid }).errors ?? []).join('; ')
    const rows = [
      [{ windows: [{ window: 'a', rect: [0, 0, 800, 600], maximized: true }] }, 'grid.windows[0] has both a rect and maximized: a grid window takes one of them'],
      [{ windows: [{ window: 'a' }] }, 'grid.windows[0] has neither a rect nor maximized: a grid window takes one of them'],
      [{ windows: [{ window: 'a', maximized: true, tabs: ['x'] }, { window: 'b', maximized: true, tabs: ['x'] }] }, 'grid.windows[1].tabs names a session that a grid window names already'],
      [{ windows: [{ window: 'a', maximized: true, tabs: ['x', 'x'] }] }, 'grid.windows[0].tabs names a session that a grid window names already'],
      [{ windows: [{ window: 'a', maximized: true, tabs: ['X'] }] }, 'grid.windows[0].tabs holds something that is not a session name (lowercase letters, digits and hyphens, as --name takes)'],
      [{ windows: [{ window: 'a', maximized: true }, { window: 'A', maximized: true }] }, 'grid.windows[1].window names a window twice'],
      [{ windows: [] }, 'grid.windows is not a list of 1 to 16 windows'],
      [{ windows: [{ window: 'a', maximized: true, tabs: [] }] }, 'grid.windows[0].tabs is not a list of 1 to 16 session names'],
      [{ windows: [{ window: 'a', maximized: true, colour: 'red' }] }, 'grid.windows[0] has an unknown key colour'],
      [{ windows: [{ window: 'a', maximized: true }], rows: 2 }, 'grid has an unknown key rows'],
      [{ windows: [{ window: 'a', rect: [0, 0, 319, 600] }] }, 'grid.windows[0] has a rect that is not four whole numbers [x, y, width, height]: x and y within 32768, a width of 320 to 32768 and a height of 200 to 32768'],
    ]
    const wrong = rows.map(([grid, want]) => [grid, want, said(grid)]).filter(([, want, got]) => got !== want)
    assert.deepEqual(wrong.map(([grid, want, got]) => `${JSON.stringify(grid)}: ${JSON.stringify(got)}, not ${JSON.stringify(want)}`), [])
    // The rule for a session's name in a grid window's tabs is --name's own (AREA_NAME), and lanes.json's.
    for (const name of ['alpha', 'a', '0-cell', 'x'.repeat(40), 'Alpha', '-a', 'a b', 'a.b', 'x'.repeat(41)]) assert.equal(said({ windows: [{ window: 'a', maximized: true, tabs: [name] }] }) === '', m.AREA_NAME.test(name), name)
    // A named window of layout[], launch and restart still refuses a rect (not built there): only a grid window takes one.
    assert.match((read({ v: 1, layout: [], launch: { prefer: ['window'], window: { name: 'w1', rect: [0, 0, 800, 600] } } }).errors ?? []).join(), /a named window does not take \(not built\)/)
  },
  gridPlan(m) {
    // #91: planGrid, a pure function of the list, the grid and the windows open now, every row compared in one run.
    const grid = { windows: [{ window: 'c1', rect: [-7, 0, 494, 523], tabs: ['alpha', 'beta'] }, { window: 'c2', rect: [473, 0, 494, 523] }, { window: 'c3', rect: [953, 0, 494, 523] }, { window: 'm1', maximized: true, tabs: ['gamma'] }] }
    const freeOnly = { windows: [{ window: 'c-1', maximized: true }] }
    const idOf = n => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`
    const listOf = names => names.map((name, i) => ({ name, folder: 'C:\\path\\to\\work', ...(i % 2 === 0 ? { id: idOf(i + 1) } : {}) }))
    /** A step as `<name>><window>:<new|join>:<by>[:rect|:max]`. */
    const short = s => `${s.session.name}>${s.window}:${s.opens}:${s.by}${s.place === undefined ? '' : 'rect' in s.place ? ':rect' : ':max'}`
    const rows = [
      ['fixed first, in the tabs order, whatever the list order', grid, ['beta', 'alpha'], new Set(), ['alpha>c1:new:fixed:rect', 'beta>c1:join:fixed'], [], 0],
      ['free cells in file order, one session each, in the list order', grid, ['delta', 'epsilon'], new Set(), ['delta>c2:new:free:rect', 'epsilon>c3:new:free:rect'], [], 0],
      ['fixed, then free, then overflow in turn into the free cells', grid, ['delta', 'alpha', 'epsilon', 'zeta', 'eta', 'gamma', 'theta'], new Set(), ['alpha>c1:new:fixed:rect', 'gamma>m1:new:fixed:max', 'delta>c2:new:free:rect', 'epsilon>c3:new:free:rect', 'zeta>c2:join:overflow', 'eta>c3:join:overflow', 'theta>c2:join:overflow'], [], 0],
      ['a free cell whose window holds a live slot is taken; a fixed window open already gets a tab, unplaced', grid, ['alpha', 'delta', 'epsilon'], new Set(['c1', 'c2']), ['alpha>c1:join:fixed', 'delta>c3:new:free:rect', 'epsilon>c3:join:overflow'], [], 0],
      ['no free cell: overflow in turn into the fixed windows, and a note says so', grid, ['delta', 'epsilon', 'zeta'], new Set(['c2', 'c3']), ['delta>c1:new:overflow:rect', 'epsilon>m1:new:overflow:max', 'zeta>c1:join:overflow'], [], 1],
      ['no free cell and no fixed window: refused, never an unplaced window', freeOnly, ['delta', 'epsilon'], new Set(['c-1']), [], ['delta', 'epsilon'], 1],
      ['an empty list: nothing', grid, [], new Set(), [], [], 0],
      ['a window name open only in another case is not taken: the grid window opens new', grid, ['delta'], new Set(['C2']), ['delta>c2:new:free:rect'], [], 0],
    ]
    const wrong = rows.flatMap(([name, g, names, open, steps, refused, notes]) => {
      const plan = m.planGrid(listOf(names), g, open)
      const got = [plan.steps.map(short), plan.refused.map(r => r.session.name), plan.notes.length]
      return JSON.stringify(got) === JSON.stringify([steps, refused, notes]) ? [] : [`${name}: ${JSON.stringify(got)}, not ${JSON.stringify([steps, refused, notes])}`]
    })
    assert.deepEqual(wrong, [])
    // The notes, in words; and a plan's lines.
    assert.match(m.planGrid(listOf(['delta', 'epsilon', 'zeta']), grid, new Set(['c2', 'c3'])).notes[0], /^no free cell is left, so 3 sessions go as further tabs into the fixed windows, in turn$/)
    assert.match(m.planGrid(listOf(['delta']), freeOnly, new Set(['c-1'])).refused[0].why, /never goes into a window the grid does not name/)
    const lines = m.planGrid([{ name: 'alpha', id: idOf(1), folder: 'C:\\path\\to\\work', prompt: 'Resume the next piece.' }, { name: 'zeta', folder: 'C:\\path\\to\\work' }, { name: 'gamma', folder: 'C:\\path\\to\\work' }], grid, new Set(['c2'])).steps.map(m.gridPlanLine)
    assert.deepEqual(lines, [`alpha: opens window c1 at [-7, 0, 494, 523] (its fixed slot), tab alpha, resumes ${idOf(1)}, with a first prompt`, 'gamma: opens window m1 maximized (its fixed slot), tab gamma, starts a new session', 'zeta: opens window c3 at [953, 0, 494, 523] (a free cell), tab zeta, starts a new session'])
    // Of another shape: thrown, never planned.
    assert.throws(() => m.planGrid(listOf(['alpha', 'alpha']), grid, new Set()), /names alpha twice/)
    assert.throws(() => m.planGrid([{ name: 'a', id: idOf(1), folder: 'C:\\w' }, { name: 'b', id: idOf(1), folder: 'C:\\w' }], grid, new Set()), /conversation .+ twice/)
    assert.throws(() => m.planGrid(listOf(['x']), { windows: [{ window: 'a', maximized: true, tabs: ['x'] }, { window: 'b', maximized: true, tabs: ['x'] }] }, new Set()), /two fixed slots/)
    assert.throws(() => m.planGrid(listOf(Array.from({ length: 17 }, (_, i) => `s${i}`)), grid, new Set()), /at most 16/)
    // The windows open now come from the live slot runners' beacons, by their window stamp; unread runners: none known.
    const runners = [idleRunner(m, {}, { window: 'c2' }), idleRunner(m, { pid: 22, id: '22-134062345678901240' }, {}), idleRunner(m, { pid: 23, id: '23-134062345678901240', beacon: null })]
    assert.deepEqual([...m.openWindows(probeOf(m, { slots: runners }))], ['c2'])
    // A probe whose answer holds no slot runners at all (JSON drops the undefined key): none could be read.
    assert.equal(m.openWindows(probeOf(m, { slots: undefined })), undefined)
    // Windows Terminal, read as a tab's launch reads it, two reads of one thing each: 1.19 or later; and wt.exe there.
    assert.deepEqual(['wt 1.24.10921.0', 'wt 1.19.1', 'wt 1.18.3', 'wt none', 'garbled'].map(m.wtVersionFault), [undefined, undefined, 'Windows Terminal is 1.18.3, older than the 1.19 a tab needs', 'Windows Terminal 1.19 or later is not installed (no version could be read)', "Windows Terminal's version could not be read"])
    assert.deepEqual(['wtexe yes', 'wtexe no', 'garbled'].map(m.wtExeFault), [undefined, 'wt.exe is not at %LOCALAPPDATA%\\Microsoft\\WindowsApps, where a launch runs it from', 'whether wt.exe is there could not be read'])
    for (const script of [m.wtVersionScript(), m.wtExeScript(STATE)]) assert.ok(!/wt\.exe['"]?\s|Start-Process|&\s*\$wtExe/.test(script), 'neither read runs wt')
    assert.ok(!m.wtVersionScript().includes('wt.exe') && !m.wtExeScript(STATE).includes('Get-AppxPackage'), 'each reads one thing')
  },
  plainLegs(m) {
    // The plain window at its place, as a leg: for a launch of another process, and for a restart.
    const placed = placementOf(m, { launch: { prefer: ['slot', 'window'], window: { rect: [0, 0, 1280, 800] } }, restart: { prefer: ['window'], window: { maximized: true } } })
    assert.deepEqual(m.pickLaunchTransport(probeOf(m, { slots: [] }), placed, PICK).where, { window: { rect: [0, 0, 1280, 800] } }, 'no slot idle: the plain window at its rect')
    const mine = { replacing: true, using: 'restart', configCount: 1, needsLeft: false, stamp: {} }
    const restart = m.pickLaunchTransport(probeOf(m), placed, mine)
    assert.deepEqual([restart.where, restart.then], [{ window: { maximized: true } }, [{ window: true }]], 'a restart: the plain window maximized, then the plain window as it opens')
    // A window a launch opened keeps its session ahead of the plain window's place: it is a plain window already.
    const hosted = { token: T, pane: { pid: 20, started: '134062345678901240', v: 3, hosted: true } }
    assert.deepEqual(m.pickLaunchTransport(probeOf(m), placed, { ...mine, pane: hosted }), { where: { pane: { token: T } } }, 'no new window each move')
    // A named window still comes before it.
    assert.deepEqual(m.pickLaunchTransport(probeOf(m), placementOf(m), { ...mine, pane: hosted }), { where: { window: { name: 'claude-overflow', pos: [1920, 0], size: [140, 60] } }, then: [{ pane: { token: T } }] })
    // A layout window's maximized rides on its tab, for wt to create it maximized when it isn't there.
    const max = placementOf(m, { layout: [{ window: 'claude-4', maximized: true, tabs: ['s10'], folder: 'C:\\work' }] })
    assert.deepEqual(m.pickLaunchTransport(probeOf(m, { slots: [idleRunner(m, { child: 100 })] }), max, { ...PICK, title: 'lane-x' }).where, { tab: { window: 'claude-4', title: 'lane-x', maximized: true } })
    // Which places are the plain window.
    assert.deepEqual([{ window: true }, { window: { rect: [0, 0, 800, 600] } }, { window: { maximized: true } }, { window: { name: 'a' } }, { window: { name: 'a', maximized: true } }, 'auto', { slot: SLOT }, { tab: { window: 'a', title: 'a' } }, { pane: { token: T } }].map(m.isPlainWindow), [true, true, true, false, false, false, false, false, false])
  },
  placeLaunch(m) {
    // The plain window, placed: today's window script, with exactly the placing lines right after its module path.
    const plainIn = launchInput({ claim: `launch:${FRESH}` })
    const unplaced = innerOf(m.launchScriptText(plainIn))
    const lines = unplaced.split('\r\n')
    const at = lines.findIndex(line => line.startsWith('if ($PSVersionTable.PSEdition -ne "Core") {')) + 1
    assert.equal(at, 5, 'after the start signal, the file, the two preferences and the module path')
    for (const place of [{ rect: [-1600, 120, 1200, 800] }, { maximized: true }, { rect: [2100, 300, 900, 600], maximized: true }]) {
      const placed = innerOf(m.launchScriptText({ ...plainIn, where: { window: place } }))
      assert.equal(placed, [...lines.slice(0, at), ...m.windowPlaceLines(place), ...lines.slice(at)].join('\r\n'), `${JSON.stringify(place)}: the placing lines, and nothing else`)
      assert.ok(placed.indexOf('[ClaudeSelfToolsPlace]::Place(') < placed.indexOf('$env:CLAUDE_SELF_TOOLS_WT_WINDOW = $null'), 'before anything else, and before the wait')
    }
    assert.ok(!unplaced.includes('ClaudeSelfToolsPlace') && !unplaced.includes('Add-Type'), 'an unplaced window has none of it')
    // A failure is said in one line, and the session goes on: all of it in one try, whose catch says why.
    const block = m.windowPlaceLines({ maximized: true })
    assert.deepEqual([block.length, block[0], block[1], block[4].startsWith('} catch { $placeSaid = "it could not be placed (" + $_.Exception.Message'), block[5]], [6, '$placeSaid = "not tried"', 'try {', true, 'if ($placeSaid -cne "placed") { Write-Host ("This window is not where placement.json puts it: " + $placeSaid + ". The session goes on here.") }'])
    assert.ok(!block.some(line => /\bexit\b|\bthrow\b|Read-Host|Start-Sleep/.test(line)), 'nothing in it stops or holds the window')
    // The place is checked again in the launch: numbers within RECT_LIMITS, maximized true, at least one, nothing else.
    for (const bad of [{ rect: [0, 0, 319, 600] }, { rect: [0, 0, 800] }, { rect: ['0', '0', '800', '600'] }, { maximized: false }, {}, { pos: [0, 0] }, { rect: [0, 0, 800, 600], extra: 1 }]) {
      assert.throws(() => m.launchScriptText({ ...plainIn, where: { window: bad } }), /plain window/, JSON.stringify(bad))
    }
    // Remote Control and a first prompt go to it as to the plain window; a start in it may wait, as in the plain one.
    assert.ok(innerOf(m.launchScriptText({ ...plainIn, where: { window: { maximized: true } }, remoteControl: 'lane-y' })).includes(' -RemoteControl $rcName'))
    assert.ok(m.launchScriptText({ ...plainIn, kind: 'start', id: FRESH, name: 'lane-x', checks: { fresh: true }, where: { window: { maximized: true } } }).includes('$inner = '))
    // A named window maximized: -M on wt's line, before --pos; its fallback plain window is not placed.
    const named = m.launchScriptText(launchInput({ where: { window: { name: 'claude-overflow', pos: [2100, 300], maximized: true } } }))
    assert.ok(wtLineOf(named).startsWith('-w claude-overflow -M --pos 2100,300 nt '), wtLineOf(named))
    assert.ok(!innerOf(named).includes('ClaudeSelfToolsPlace'), "a named window's fallback is the plain window unplaced")
    assert.ok(wtLineOf(m.launchScriptText(launchInput({ where: { tab: { window: 'claude-4', title: 't', maximized: true } } }))).startsWith('-w claude-4 -M nt '))
    assert.throws(() => m.wtTabLine({ powershell: POWERSHELL, stateDir: STATE, window: 'a', title: 'a', folder: 'C:\\work', maximized: false, run: { idle: true } }), /maximized/)
    assert.throws(() => m.launchScriptText(launchInput({ kind: 'start', id: FRESH, name: 'lane-x', checks: { fresh: true }, where: { window: { name: 'a', maximized: true } } })), /a start in a tab waits for nothing/, 'a named window is still a tab')
    // Nothing on the caller's side acts on a window: outside the window's own script, the launch has none of it.
    for (const where of [{ window: { rect: [0, 0, 800, 600], maximized: true } }, { window: true }, 'auto']) {
      const outer = outerOf(m.launchScriptText({ ...plainIn, where }))
      assert.ok(outer.includes('$inner = <the window script>'), 'the window script taken out')
      assert.ok(!/SetWindowPos|ShowWindow|ClaudeSelfToolsPlace|MoveWindow|SetForegroundWindow|SetWindowPlacement|FindWindow|EnumWindows/.test(outer), `${JSON.stringify(where)}: the caller's lines act on no window, and list none`)
    }
  },
  tabPlace(m) {
    // #91: the first tab of a new grid window places its own window (-Place); a tab joining one places nothing.
    const first = launchInput({ kind: 'start', id: FRESH, name: 'alpha', claim: `launch:${FRESH}`, where: { tab: { window: 'a-1', title: 'alpha', rect: [-7, 0, 494, 523] } }, waitForExit: undefined, checks: { ...FLOOR_CHECKS, fresh: true }, deadline: NOW + 20_000 })
    const s = m.launchScriptText(first)
    assert.equal(wtLineOf(s), `-w a-1 nt --title alpha --suppressApplicationTitle -d "C:\\work\\my repo" -- ${POWERSHELL} -NoExit -NoProfile -ExecutionPolicy RemoteSigned -File "${STATE}\\claude-slot.ps1" -Start ${FRESH} -Name alpha -ConfigDirs "${CONFIG}|D:\\other cfg" -Claim launch:${FRESH} -Launcher ${m.LAUNCH_SCRIPT_SHA256} -Place r-7,0,494,523`, 'its place for its runner alone: no --pos, --size or -M for wt')
    const join = m.launchScriptText(launchInput({ claim: `launch:${OTHER}`, where: { tab: { window: 'a-1', title: 'beta' } }, waitForExit: undefined, checks: { ...FLOOR_CHECKS, live: true } }))
    assert.equal(wtLineOf(join), `-w a-1 nt --title beta --suppressApplicationTitle -d "C:\\work\\my repo" -- ${POWERSHELL} -NoExit -NoProfile -ExecutionPolicy RemoteSigned -File "${STATE}\\claude-slot.ps1" -Resume ${T} -ConfigDirs "${CONFIG}|D:\\other cfg" -Claim launch:${OTHER} -Launcher ${m.LAUNCH_SCRIPT_SHA256}`, 'a tab joining a window: no place')
    assert.ok(!join.includes('$placedSignal') && !join.includes('"place " + $placeSaid'), 'a joining tab waits for nothing')
    assert.equal(m.placeArgument([-7, 0, 494, 523]), 'r-7,0,494,523')
    assert.throws(() => m.placeArgument([0, 0, 100, 100]), /not a rect/)
    // The two events, made before wt starts the tab (the slot runner's hash still right before it), then the wait, bounded by the deadline.
    const made = s.indexOf(`$placedSignal = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, '${m.placeSignalName(FRESH, 'placed')}', [ref]$placedNew)`)
    const madeToo = s.indexOf(`$unplacedSignal = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, '${m.placeSignalName(FRESH, 'unplaced')}', [ref]$unplacedNew)`)
    const refuseOld = s.indexOf('if (-not $placedNew -or -not $unplacedNew) { throw (')
    const started = s.indexOf('$window = Start-Process $wtExe -ArgumentList $wtLine -PassThru')
    const waited = s.indexOf('$placeSeen = [Threading.WaitHandle]::WaitAny([Threading.WaitHandle[]]@($placedSignal, $unplacedSignal), [int]$placeLimit)')
    assert.ok(made > 0 && made < madeToo && madeToo < refuseOld && refuseOld < started && started < waited, 'made, checked as its own, then wt, then the wait')
    assert.ok(s.includes(`$placeLimit = [math]::Min($placeLimit, [math]::Max(0, ${NOW + 20_000} - ${m.PLACE_DEADLINE_MARGIN_MS} - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()))`), 'never nearer the deadline than its margin')
    assert.ok(s.includes(`$placeLimit = ${m.PLACE_WAIT_MS}`) && m.PLACE_WAIT_MS === 10_000)
    assert.ok(s.indexOf('[Console]::Out.WriteLine("place " + $placeSaid)') < s.indexOf('[Console]::Out.WriteLine("launched " + $placed)'), 'it says which, before launched')
    assert.deepEqual(m.PLACE_SIGNAL_PREFIX, { placed: 'Local\\claude-self-tools-placed-', unplaced: 'Local\\claude-self-tools-unplaced-' })
    assert.deepEqual(m.parseLaunch('claim x\r\nplace unconfirmed its first tab did not say within 7 s that it had tried\r\nlaunched tab a-1\r\n').place, { said: 'unconfirmed', why: 'its first tab did not say within 7 s that it had tried' })
    assert.deepEqual(m.parseLaunch('place placed\r\nlaunched tab a-1\r\n').place, { said: 'placed' })
    assert.equal(m.parseLaunch('launched tab a-1\r\n').place, undefined)
    // Nothing on the caller's side acts on a window: the launch makes two events and waits; it calls no window function.
    assert.ok(!/SetWindowPos|ShowWindow|ClaudeSelfToolsPlace|MoveWindow|SetForegroundWindow|SetWindowPlacement|FindWindow|EnumWindows/.test(s), 'the launch acts on no window, and lists none (its one Add-Type is the input idle read, ClaudeSelfToolsInput)')
    // One place, set one way; a named window's rect is still not built.
    assert.throws(() => m.launchScriptText({ ...first, where: { tab: { window: 'a-1', title: 'alpha', rect: [-7, 0, 494, 523], maximized: true } } }), /takes no pos, size or maximized/)
    assert.throws(() => m.launchScriptText({ ...first, where: { tab: { window: 'a-1', title: 'alpha', rect: [0, 0, 100, 100] } } }), /rect is not four whole numbers/)
    assert.throws(() => m.launchScriptText(launchInput({ where: { window: { name: 'a-1', rect: [0, 0, 800, 600] } } })), /a named window takes no rect \(not built\)/)
    // A first prompt as text: a tab alone; written by the launch to its own file, checked there as Windows PowerShell hands it on; never on a line.
    const PROMPT = "Pick up the next piece: it's in notes\\next.md, then say \"done\"."
    const p = m.launchScriptText({ ...first, prompt: PROMPT })
    assert.ok(wtLineOf(p).endsWith(' -Place r-7,0,494,523 -Prompt') && !wtLineOf(p).includes('next piece'), "the tab is told -Prompt; the text is on no line")
    assert.ok(p.includes(`$promptFile = '${m.promptPath(STATE, FRESH)}'`) && m.promptPath(STATE, FRESH) === `${STATE}\\prompts\\${FRESH}.txt`)
    assert.ok(p.includes(`$promptText = '${PROMPT.split("'").join("''")}'`), 'the text as a single-quoted literal on standard input')
    // Created new (CreateNew), as the window's file is: never over a file already there, which is no file of this run's.
    const wrote = p.indexOf('$promptStream = [IO.File]::Open($promptFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None); $promptMade = $promptFile')
    const checked = p.indexOf('$promptRead = Read-Prompt $promptFile $true')
    assert.ok(wrote > 0 && wrote < checked && checked < p.indexOf('function New-Claim('), 'written, then read back as Windows PowerShell hands it on, before the claim')
    assert.ok(p.includes('  if ($null -ne $promptMade) { try { [IO.File]::Delete($promptMade) } catch { } }'), 'a refusal deletes the file it wrote')
    assert.ok(p.includes("[IO.Path]::GetFileName($staleFile) -cmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.txt\\z'"), 'old prompt files swept, by their shape')
    assert.ok(!s.includes('$promptText') && !s.includes('$promptMade'), 'no prompt: none of it')
    // Every tab's launch sweeps the prompt files no tab read, a prompt of its own or not (Low 5).
    for (const tab of [s, join, p]) assert.ok(tab.includes("[IO.Path]::GetFileName($staleFile) -cmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.txt\\z'"), 'swept in every tab launch')
    assert.ok(!scriptsOf(m).plain.includes('.txt\\z'), "a plain window's launch has no prompt folder to sweep")
    assert.throws(() => m.launchScriptText(launchInput({ claim: `launch:${FRESH}`, prompt: PROMPT })), /goes to a tab alone/)
    assert.throws(() => m.launchScriptText({ ...first, prompt: PROMPT, promptFile: 'C:\\x\\p.md' }), /a plain window|not both/)
    const faults = [['', 'empty'], ['  \n ', 'empty'], ['/compact now', 'starts with /'], ['!rm x', 'starts with !'], ['update', 'one bare word'], ['a\u0007b c', 'control character'], ['\ufeffhello there', 'byte order mark'], ['x '.repeat(7501), 'over the 15000'], [3, 'not text']]
    const misjudged = faults.map(([text, want]) => [want, m.promptTextFault(text)]).filter(([want, got]) => got === undefined || !got.includes(want))
    assert.deepEqual(misjudged, [])
    for (const good of ['Resume the billing piece.', 'two words', 'tabs\tand\r\nline breaks are fine']) assert.equal(m.promptTextFault(good), undefined, good)
    assert.throws(() => m.launchScriptText({ ...first, prompt: '/exit' }), /the first prompt starts with \//)
  },
  actingCalls(m) {
    // #5's limits, held as text: the window's C# imports the reviewed list and no more; the two acting calls are
    // each made once, with the reviewed arguments, on the window of its own console; its inputs are checked numbers.
    const cs = m.PLACE_CS
    assert.deepEqual(cs.match(/\[DllImport\([^\]]*\)\] static extern [^;]+;/g), REVIEWED_IMPORTS)
    assert.equal(cs.split('[DllImport(').length - 1, REVIEWED_IMPORTS.length, 'no import of another shape')
    // However it is spelled (System.Runtime.InteropServices.DllImport, DllImportAttribute): every import is one of the reviewed list.
    assert.equal((cs.match(/\bextern\b/g) ?? []).length, REVIEWED_IMPORTS.length, 'every extern is a reviewed import')
    assert.equal((cs.match(/DllImport/g) ?? []).length, REVIEWED_IMPORTS.length, 'every DllImport is a reviewed import')
    assert.deepEqual(cs.match(/\bSetWindowPos\([^)]*\)/g), ['SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags)', 'SetWindowPos(own, IntPtr.Zero, at[0], at[1], at[2], at[3], 0x4214)'])
    assert.deepEqual(cs.match(/\bShowWindowAsync\([^)]*\)/g), ['ShowWindowAsync(IntPtr window, int show)', 'ShowWindowAsync(own, 3)'], 'SW_MAXIMIZE alone')
    assert.deepEqual(cs.match(/\bown = [^;]+;/g), ['own = IntPtr.Zero;', 'own = console;', 'own = GetWindow(console, 4);'], 'its own window: its console window, or that window\'s owner (GW_OWNER)')
    assert.deepEqual(cs.match(/\bconsole = [^;]+;/g), ['console = GetConsoleWindow();'])
    assert.deepEqual(cs.match(/\bat = [^;]+;/g), ['at = Clamp(x, y, width, height, info.Work.Left, info.Work.Top, info.Work.Right, info.Work.Bottom, border[0], border[1], border[2]);'])
    // #90: the border is its own window's, read by two reads of that window alone, after the thread is per-monitor aware and
    // before the clamp; a read that fails is no overhang; the clamp passes the work area by it on the left, the right and the bottom.
    assert.deepEqual(cs.match(/\bborder = [^;]+;/g), ['border = BorderOf(own);'])
    assert.deepEqual(cs.match(/\bBorderOf\([^)]*\)/g), ['BorderOf(IntPtr window)', 'BorderOf(own)'], 'declared once, called once, on its own window')
    assert.deepEqual(cs.match(/\bGetWindowRect\([^)]*\)/g), ['GetWindowRect(IntPtr window, out Box box)', 'GetWindowRect(window, out rect)'])
    assert.deepEqual(cs.match(/\bDwmGetWindowAttribute\([^)]*\)/g), ['DwmGetWindowAttribute(IntPtr window, uint attribute, out Box value, int size)', 'DwmGetWindowAttribute(window, 9, out frame, Marshal.SizeOf(typeof(Box)'], 'DWMWA_EXTENDED_FRAME_BOUNDS (9) alone')
    assert.ok(cs.includes('if (!GetWindowRect(window, out rect) || DwmGetWindowAttribute(window, 9, out frame, Marshal.SizeOf(typeof(Box))) != 0) return new int[] { 0, 0, 0 };'), 'a read that fails is no overhang')
    assert.ok(cs.includes(`static int Side(int d) { return d >= ${m.BORDER_LIMITS.min} && d <= ${m.BORDER_LIMITS.max} ? d : 0; }`), 'a side outside 2 to 64 px reads as none')
    assert.ok(cs.includes('return new int[] { Side(frameLeft - left), Side(right - frameRight), Side(bottom - frameBottom) };'), 'the left, the right and the bottom; never the top')
    assert.ok(cs.includes('left = left - borderLeft; right = right + borderRight; bottom = bottom + borderBottom; int w = Math.Min(width, right - left);'), 'the clamp passes the work area by the border alone, never at the top')
    const bordered = cs.indexOf('int[] border = BorderOf(own);')
    assert.ok(bordered > cs.indexOf('IntPtr before = SetThreadDpiAwarenessContext(new IntPtr(-4));') && bordered < cs.indexOf('int[] at = Clamp(') && bordered > cs.indexOf('int hosted = Hosted(own, console);'), 'read per-monitor aware, after the count, before the clamp')
    assert.ok(cs.includes('if (kind == "ConsoleWindowClass") own = console; else if (kind == "PseudoConsoleWindow") { own = GetWindow(console, 4); if (own == IntPtr.Zero || ClassOf(own) != "CASCADIA_HOSTING_WINDOW_CLASS") return '), 'the classic console\'s window, or the Windows Terminal window that owns the pseudoconsole; else nothing')
    // Asked only to be maximized, a window maximized already is where it is asked: "placed", nothing done, nothing said;
    // with a rect too, it is left as it is (the rect was not applied), as before.
    const already = cs.indexOf('if (!hasRect && maximized && IsZoomed(own) && !IsIconic(own)) return "placed"; if (IsIconic(own) || IsZoomed(own)) return "it opened minimized or maximized, so it is left as it is";')
    assert.ok(already > cs.indexOf('int hosted = Hosted(own, console);') && already < cs.indexOf('SetThreadDpiAwarenessContext(new IntPtr(-4))'), 'after the count, before anything acts: a maximized-only ask of a maximized window is placed, and nothing else short of the rule below')
    const iconic = cs.indexOf('if (IsIconic(own) || IsZoomed(own)) return ')
    assert.ok(iconic > 0 && iconic < cs.indexOf('SetWindowPos(own'), 'a window minimized or maximized as it opened is left as it is')
    const aware = cs.indexOf('IntPtr before = SetThreadDpiAwarenessContext(new IntPtr(-4)); if (before == IntPtr.Zero) return ')
    assert.ok(aware > 0 && aware < cs.indexOf('MonitorFromRect(ref asked'), 'per-monitor DPI awareness before any coordinate is read, and nothing placed without it')
    assert.ok(cs.includes('} finally { SetThreadDpiAwarenessContext(before); }'), "the thread's awareness put back")
    // Its own window only when that window is its own alone (round 2, Fix A; round 3, by EnumWindows): under a
    // pseudoconsole, the consoles its window owns are counted, and anything but exactly one, its own, leaves it where
    // it is, before any acting call. The listing is EnumWindows, once: its page calls it "more reliable than calling the
    // GetWindow function in a loop".
    assert.ok(cs.includes('public delegate bool EachWindow(IntPtr found, IntPtr data);'), "the callback's delegate type")
    assert.ok(cs.includes('public static int Hosted(IntPtr window, IntPtr console) { int count = 0; bool seen = false; EachWindow each = delegate(IntPtr found, IntPtr data) { if (ClassOf(found) == "PseudoConsoleWindow" && Same(GetWindow(found, 4), window)) { count++; if (Same(found, console)) seen = true; } return true; }; bool listed = EnumWindows(each, IntPtr.Zero); GC.KeepAlive(each); if (!listed) return -1; return seen ? count : -1; }'), "Hosted and its callback, as reviewed: each top-level window's class read, the owner read only of a pseudoconsole window, counted when it is this window, -1 unless its own console is among them or when the listing fails; the delegate held alive across the call")
    assert.ok(cs.includes('static bool Same(IntPtr a, IntPtr b) { return (a.ToInt64() & 0xffffffffL) == (b.ToInt64() & 0xffffffffL); }'), 'handles compared by their low 32 bits')
    assert.deepEqual(cs.match(/\bEnumWindows\([^)]*\)/g), ['EnumWindows(EachWindow each, IntPtr data)', 'EnumWindows(each, IntPtr.Zero)'], 'EnumWindows declared once and called once, by Hosted')
    assert.deepEqual(cs.match(/\bGetWindow\([^)]*\)/g), ['GetWindow(IntPtr window, uint relation)', 'GetWindow(found, 4)', 'GetWindow(console, 4)'], 'every GetWindow is GW_OWNER: no GetWindow walk')
    assert.equal(cs.split('Hosted(').length - 1, 2, 'Hosted declared once and called once, by Place')
    assert.equal(cs.split('delegate(').length - 1, 1, 'one callback')
    const guard = cs.indexOf('if (own == IntPtr.Zero || ClassOf(own) != "CASCADIA_HOSTING_WINDOW_CLASS") return "its console is a pseudoconsole that no Windows Terminal window owns"; int hosted = Hosted(own, console); if (hosted != 1) return "its Windows Terminal window holds other tabs or panes, or its own console could not be counted among them (" + hosted + "), so it is left where it is"; }')
    assert.ok(guard > 0, 'counted right after its owner is found, in the pseudoconsole branch, and refused on anything but 1')
    for (const acting of ['SetThreadDpiAwarenessContext(new IntPtr(-4))', 'SetWindowPos(own', 'ShowWindowAsync(own']) assert.ok(cs.indexOf(acting) > guard, `the count comes before ${acting}`)
    assert.ok(cs.includes('if (kind == "ConsoleWindowClass") own = console; else if'), 'a classic console window holds one console, and is not counted')
    assert.equal(m.PLACE_SWP_FLAGS, 0x0004 | 0x0010 | 0x0200 | 0x4000, 'SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_ASYNCWINDOWPOS, and nothing that shows, hides or reframes')
    for (const name of FORBIDDEN_IN_PLACE) assert.ok(!cs.includes(name), name)
    assert.ok(!/['\u2018-\u201b]/.test(cs), 'no single quote: it sits in a single-quoted literal')
    // Its PowerShell passes only checked numbers, as [int] literals, and two flags: never a string or a variable.
    for (const place of [{ rect: [-32768, 32768, 320, 200] }, { rect: [0, 0, 32768, 32768], maximized: true }, { maximized: true }]) {
      const calls = m.windowPlaceLines(place).filter(line => line.includes('::Place('))
      assert.equal(calls.length, 1)
      assert.match(calls[0], /^ {2}\$placeSaid = \[ClaudeSelfToolsPlace\]::Place\(\[int\]-?\d{1,5}, \[int\]-?\d{1,5}, \[int\]\d{1,5}, \[int\]\d{1,5}, \$(true|false), \$(true|false)\)$/, calls[0])
    }
    for (const bad of [{ rect: [0, 0, 100, 100] }, { rect: [0, 0, 800, 600.5] }, { rect: ['0', '0', '800', '600'] }, { maximized: false }, {}]) assert.throws(() => m.windowPlaceLines(bad), JSON.stringify(bad))
    const inner = innerOf(m.launchScriptText(launchInput({ claim: `launch:${FRESH}`, where: { window: { rect: [0, 0, 800, 600] } } })))
    assert.equal(inner.split('Add-Type').length, 2, 'one Add-Type')
    assert.equal(inner.split('[ClaudeSelfToolsPlace]::').length, 2, 'Place called once; nothing else of the type')
  },
  clampRule(m) {
    // The clamp as a pure function, every row in one run, each that differs listed.
    const monitors = [LEFT, PRIMARY, TOP_BAR]
    // #89's rows among three monitors, with no border; #90's on a screen of their own, with one: every row of both in one run.
    const tables = [...CLAMP_ROWS.map(row => [monitors, ...row]), ...OVERHANG_CLAMP_ROWS.map(([name, ...row]) => [[SCREEN], `#90, ${name}`, ...row])]
    const wrong = tables.map(([screens, name, rect, want, border]) => [name, rect, want, border === undefined ? m.clampToMonitors(rect, screens) : m.clampToMonitors(rect, screens, border)]).filter(([, , want, got]) => JSON.stringify(got) !== JSON.stringify(want))
    assert.deepEqual(wrong.map(([name, rect, want, got]) => `${name}: ${JSON.stringify(rect)} gave ${JSON.stringify(got)}, not ${JSON.stringify(want)}`), [])
    // Wherever it was asked for, the window ends wholly inside one monitor's work area, passed by its border alone (#90).
    for (const [screens, name, rect, , border = [0, 0, 0]] of tables) {
      const [x, y, w, h] = m.clampToMonitors(rect, screens, border)
      assert.ok(screens.some(({ work: [l, t, r, b] }) => x >= l - border[0] && y >= t && x + w <= r + border[1] && y + h <= b + border[2]), name)
    }
    assert.throws(() => m.clampToMonitors([0, 0, 800, 600], []), /no monitor/)
    assert.deepEqual(m.clampToWork([5000, -5000, 800, 600], [0, 0, 1920, 1040]), [1120, 0, 800, 600])
    // #90's own example: a window snapped to the left half of a 1920 x 1032 work area is drawn at 0, its rectangle at -7.
    assert.deepEqual(m.clampToWork([-7, 0, 974, 1039], [0, 0, 1920, 1032], BORDER), [-7, 0, 974, 1039], 'flush: as asked')
    assert.deepEqual(m.clampToWork([-7, 0, 974, 1039], [0, 0, 1920, 1032]), [0, 0, 974, 1032], 'with no border, as #89 placed it')
    assert.deepEqual(m.NO_OVERHANG, [0, 0, 0])
    assert.deepEqual(m.BORDER_LIMITS, { min: 2, max: 64 })
    // The border read: every row in one run, each that differs listed.
    const misread = OVERHANG_ROWS.map(([name, rect, frame, want]) => [name, want, m.overhangOf(rect, frame)]).filter(([, want, got]) => JSON.stringify(got) !== JSON.stringify(want))
    assert.deepEqual(misread.map(([name, want, got]) => `${name}: ${JSON.stringify(got)}, not ${JSON.stringify(want)}`), [])
  },
}

for (const [name, check] of Object.entries(CHECKS)) test(`the rules: ${name}`, () => check(real))

test('a tab runs the slot runner, never claude: no claude flag on its line', () => {
  // A generated tab or window runs the slot runner, never claude; the window runs claude-launch.ps1.
  const s = scriptsOf(real)
  for (const script of [s.tabStart, s.tabResume]) assert.ok(!wtLineOf(script).includes('claude.exe') && !/--resume|--session-id/.test(wtLineOf(script)))
})

/** Each planted fault: the check it must fail, and the text of machine.ts it changes. */
const FAULTS = [
  ['a --permission-mode added to the wt string', 'launchArguments', "    '--suppressApplicationTitle',\n", "    '--suppressApplicationTitle',\n    '--permission-mode',\n    'bypassPermissions',\n"],
  ['a script back on -EncodedCommand in the wt string', 'launchArguments', '    ...doing,\n', "    '-EncodedCommand',\n    'AAAA',\n    ...doing,\n"],
  ['an array passed to -ArgumentList', 'quoting', '$window = Start-Process $wtExe -ArgumentList $wtLine -PassThru', '$window = Start-Process $wtExe -ArgumentList ($wtLine -split " ") -PassThru'],
  ['the quoting removed', 'quoting', '  return `"${element}"`\n', '  return element\n'],
  ['the trailing-backslash strip removed', 'quoting', "(folder.length > 3 ? folder.replace(/\\\\+$/, '') : folder)", 'folder'],
  ["the slot path taken from a parent's command line", 'pinnedPaths', '`$slotScript = ${literal(slotScriptPath(v.state))}`,', "'$slotScript = $Matches[\"path\"]',"],
  ['the hash check moved out of the launching script', 'pinnedPaths', '          `if ((Get-Sha256 $slotScript) -cne \'${SLOT_SCRIPT_SHA256}\') { throw ("the slot runner is not at " + $slotScript + " with the SHA-256 this plugin ships") }`,\n', ''],
  ['a percent sign let through to wt', 'folders', "((path as string).includes('%') ? 'holds a percent sign (%), which Windows Terminal expands' : undefined)", 'undefined'],
  ['`last` taken as a window name', 'folders', '!/^(?:new|last|_quake)$/i.test(name)', '!/^(?:new|_quake)$/i.test(name)'],
  ['a C1 control let through', 'folders', '\\u007f-\\u009f]/\n\n/**\n * Whether `path` is fit', '\\u007f]/\n\n/**\n * Whether `path` is fit'],
  ['the PSModulePath reset removed from the launch', 'moduleReset', "    PSMODULEPATH_RESET,\n    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',\n    `$tool = ", "    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',\n    `$tool = "],
  ['null read as idle', 'inputIdle', 'probe.inputIdleSec !== null && probe.inputIdleSec * 1000 >= INPUT_IDLE_MS', 'probe.inputIdleSec === null || probe.inputIdleSec * 1000 >= INPUT_IDLE_MS'],
  ['null read as idle, in the script', 'inputIdle', "  `if ($null -eq $inputIdleSec) { Refuse 'input' 'the machine''s input idle could not be read, and that is not idle' }`,\n", ''],
  ['the input rule dropped for slots', 'inputIdle', '  if (!inputIdle(probe)) return notIdle\n  if (opts.configDir', '  if (opts.configDir'],
  ['the 6 GB term dropped', 'floorRules', 'Math.max(FLOOR_MIN_GB * 1024 * 1024, HEAVY_FLOOR_GB * 1024 * 1024 + largestKb)', 'HEAVY_FLOOR_GB * 1024 * 1024 + largestKb'],
  ['the largest-private-bytes term dropped', 'floorRules', 'Math.max(FLOOR_MIN_GB * 1024 * 1024, HEAVY_FLOOR_GB * 1024 * 1024 + largestKb)', 'FLOOR_MIN_GB * 1024 * 1024'],
  ['the heavy-waiter check removed', 'floorRules', "  if ((probe.heavyWaiters ?? 0) > 0) return 'heavy'\n", ''],
  ['the 6 GB term dropped, in the script', 'floorScript', '`$needBytes = [math]::Max([long]${FLOOR_MIN_GB} * 1073741824, [long]${HEAVY_FLOOR_GB} * 1073741824 + $largest)`', '`$needBytes = [long]${HEAVY_FLOOR_GB} * 1073741824 + $largest`'],
  ['the largest-private-bytes term dropped, in the script', 'floorScript', '`$needBytes = [math]::Max([long]${FLOOR_MIN_GB} * 1073741824, [long]${HEAVY_FLOOR_GB} * 1073741824 + $largest)`', '`$needBytes = [long]${FLOOR_MIN_GB} * 1073741824`'],
  ['the heavy-waiter check removed, in the script', 'floorScript', `          "if ($heavyWaiters -gt 0) { Refuse 'heavy' ($heavyWaiters.ToString() + ' heavy jobs are waiting, and they go first') }",\n`, ''],
  ['the record written by a second script run: no floor in this one', 'floorScript', '...(v.checks.floor === true ? [...GET_CLI, ...floorLines(v.heavyRoot, v.maxSessions)] : []),', ''],
  ['a launch of another process that skips the floor', 'floorScript', "if (waitFor === undefined && (checks.floor !== true || checks.input !== true)) throw new Error('a launch of another process checks the floor and the input idle (checks.floor, checks.input)')", ''],
  ['a bash call added', 'noBash', "  '$room = 0',\n", "  'bash -c true',\n  '$room = 0',\n"],
  ['a running slot counted idle', 'pickRules', 'slot.child !== null || ', ''],
  ['the 10 s removed, in the pick', 'pickRules', '  if (opts.now - beacon.since < SLOT_IDLE_MIN_MS) return false\n'.replace('  if', '      if'), ''],
  ['the workspace tag ignored', 'pickRules', 'return tag === undefined || tag === opts.workspace', 'return true'],
  ['a tab with no room', 'pickRules', '(probe.slots === null || overflowTabs(probe, placement, window) >= maxTabs)', 'false'],
  ['CreateNew swapped for Create', 'slotRecord', "'$recordStream = [IO.File]::Open($final, [IO.FileMode]::CreateNew,", "'$recordStream = [IO.File]::Open($final, [IO.FileMode]::Create,"],
  ['the 10 s removed, in the script', 'slotRecord', "    `if (([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$slotBeacon['since']) -lt ${SLOT_IDLE_MIN_MS}) { Refuse 'slot' 'that slot went idle less than ${SLOT_IDLE_MIN_MS / 1000} seconds ago' }`,\n", ''],
  ["the beacon's runner-alive check removed: read by listing the folder", 'beaconsOfRunners', '("slots\\\\" + $runnerId + ".state.json")', '("slots\\\\*.state.json")'],
  ['a bad beacon kept', 'parsing', "if ((state !== 'idle' && state !== 'running') || !isCount(since) || !isSafeFolder(configDir)) return null\n", ''],
  ['a lock holder left unaccounted: every verdict unknown', 'holders', 'isAccounted = current.has(at.pid) || holdersIds.has(at.pid)', 'isAccounted = current.has(at.pid)'],
  ['a holder not live for its own id', 'holders', 'for (const h of holders) if (h.id === id && !isSelf(h.pid)) live.push(', 'for (const h of holders) if (false) live.push('],
  ['a holder not stopping a takeover of its lock', 'holders', "  '      $holds = $table[[int]$old.holder.pid]',\n", "  '      $holds = $null',\n"],
  ['the projects scan limited to one config folder', 'freshness', "  'foreach ($dir in $configDirs) {',\n  '  $projects = Join-Path $dir \"projects\"',\n  '  if ($null -eq $fresh", "  'foreach ($dir in @($configDirs[0])) {',\n  '  $projects = Join-Path $dir \"projects\"',\n  '  if ($null -eq $fresh"],
  ["relock's by check removed", 'relock', "`    if ($null -eq $lock -or $lock.by -cne '${by}') { $answer = 'not-ours' }`,", "`    if ($null -eq $lock) { $answer = 'not-ours' }`,"],
  ['the by-hand line back to a bare name', 'windowRefusal', `\`"& '" + $handPath + "' -Resume " + $id + " -Dir '" + $folder + "'"\``, `'"claude-launch.ps1 -Resume " + $id + " -Dir " + $folder'`],
  ['F1: the old process waited for by Wait-Process again, in the window', 'windowRefusal', "`  $gone = Wait-Gone ${v.waitFor.pid} '${v.waitFor.created}' ${WAIT_POLL_SECONDS}`,", "`  Wait-Process -Id ${v.waitFor.pid} -Timeout ${WAIT_POLL_SECONDS} -ErrorAction SilentlyContinue; $gone = -not (Get-Process -Id ${v.waitFor.pid} -ErrorAction SilentlyContinue)`,"],
  ['F1: WaitForExit swapped for a wait that stops at the exit code', 'windowRefusal', "[void]$h.WaitForExit([int]$seconds * 1000)", "Wait-Process -Id $processId -Timeout $seconds -ErrorAction SilentlyContinue"],
  ['F1: the start time not checked: a reused pid waited for', 'windowRefusal', "$other = $false; if ($created -and \"$created\" -ne \"0\") { try { $other = [math]::Abs($h.StartTime.ToFileTimeUtc() - [long]$created) -gt 10000 } catch { $other = $false } }; if ($other) { return $true }; ", ''],
  ['R9: an unread start time ("0") read as another process: no wait at all', 'windowRefusal', ' -and "$created" -ne "0"', ''],
  ['S3: a window that gives up after its first look', 'windowRefusal', "          'while (-not $gone) {',", "          'if (-not $gone) {',"],
  ['R4: the claim not read while waiting', 'windowRefusal', "          '  if (-not (Test-Path -LiteralPath $claimPath)) { $claimSays = \"gone\" } else { try { $held = ", "          '  if ($false) { $claimSays = \"gone\" } else { try { $held = "],
  ['R4: a refusal while waiting cleared after the wait', 'windowRefusal', "    '$refusal = $null',\n    ...(v.waitFor === undefined", "    ...(v.waitFor === undefined"],
  ['R5: exit 2 after a long session recorded as a refusal', 'windowRefusal', "`  if ($code -eq 2 -and -not $resumedHere -and ((Get-Date) - $started).TotalSeconds -lt ${LAUNCH_REFUSED_SECONDS}) {", "`  if ($code -eq 2 -and -not $resumedHere) {"],
  ['R3: a claim that cannot be read now ends the wait', 'windowRefusal', "'  if ($claimSays -eq \"gone\" -or $claimSays -eq \"other\") { $refusal = ", "'  if ($claimSays -ne \"ours\") { $refusal = "],
  ['R5 (final): a claim unreadable for ever holds the wait for ever', 'windowRefusal', "  if ($unread -ge ${CLAIM_UNREAD_LOOKS}) {", "  if ($false) {"],
  ['S3: a refusal no one but the window hears of', 'windowRefusal', "    '  Write-Refused $refusal',\n", ''],
  ['S3: an error no one but the window hears of', 'windowRefusal', "    `  Write-Refused (\"claude-launch.ps1 stopped on an error: \" + $_.Exception.Message)`,\n", ''],
  ['a refusing window keeping the claim', 'windowRefusal', "  `  Write-Host (\"Once it is safe, resume it yourself: \" + ${byHand})`,\n    '  Release-Claim',\n".replace('  `  Write', '    `  Write'), "    `  Write-Host (\"Once it is safe, resume it yourself: \" + ${byHand})`,\n"],
  ['a window withdrawn left waiting', 'windowRefusal', '{ try { $window.Kill() } catch { }; if ($null -ne $windowFile)', '{ if ($null -ne $windowFile)'],
  ['GO_VIA shipped as the trampoline', 'trampoline', "export const GO_VIA: 'trampoline' | 'direct' = 'direct'", "export const GO_VIA: 'trampoline' | 'direct' = 'trampoline'"],
  ["the handler's epoch check removed", 'trampoline', "const fresh = (): string | undefined => (go.epoch !== at.epoch || go.running ? 'a turn came first' : undefined)", 'const fresh = (): string | undefined => undefined'],
  ['the inner command awaited', 'trampoline', '  void queueIt($, at.step)\n', '  await queueIt($, at.step)\n'],
  ['a wrong nonce acting', 'trampoline', 'if (at === undefined || args.trim() !== at.nonce) return { text: GO_NOTHING }', 'if (at === undefined) return { text: GO_NOTHING }'],
  ['a withdraw that leaves the record and the lock behind', 'trampoline', '    await at.step.withdraw(said)\n', ''],
  ['the conversation not checked at dequeue', 'trampoline', "  if ((await at.step.holds()) !== at.step.conversation) return 'this session became another conversation'\n", ''],
  ['the process tree not probed at dequeue', 'trampoline', '  if (at.step.probe !== undefined) {', '  if (false) {'],
  ['a stale wake-up read as pending by another session', 'wakeRead', 'marker.due < now - WAKE_STALE_GRACE_MS', 'false'],
  ['readExit dropping the wake-up', 'exitInputs', '...(wake === undefined ? {} : { wake }) }', '}'],
  ['a start record naming no launcher', 'slotRecord', "configDirs = [object[]]$configDirs; launcher = '${LAUNCH_SCRIPT_SHA256}' } | ConvertTo-Json -Compress`", 'configDirs = [object[]]$configDirs } | ConvertTo-Json -Compress`'],
  ['a resume record naming no launcher', 'slotRecord', "configDirs = [object[]]$configDirs; launcher = '${LAUNCH_SCRIPT_SHA256}'${leftField} } | ConvertTo-Json -Compress -Depth 3`", 'configDirs = [object[]]$configDirs${leftField} } | ConvertTo-Json -Compress -Depth 3`'],
  ['a tab starting with no -Launcher', 'launchArguments', "'-Name', run.name, ...named, ...claim(run.claim), '-Launcher', LAUNCH_SCRIPT_SHA256, ...extra(run)]", "'-Name', run.name, ...named, ...claim(run.claim), ...extra(run)]"],
  ['a tab resuming with no -Launcher', 'launchArguments', "...named, ...left, ...claim(run.claim), '-Launcher', LAUNCH_SCRIPT_SHA256, ...extra(run)]", '...named, ...left, ...claim(run.claim), ...extra(run)]'],
  ['F1: a tab line with no -Claim', 'launchArguments', "...named, ...left, ...claim(run.claim), '-Launcher', LAUNCH_SCRIPT_SHA256, ...extra(run)]", "...named, ...left, '-Launcher', LAUNCH_SCRIPT_SHA256, ...extra(run)]"],
  ['F1: any claim let through to a tab', 'perLaunchClaim', 'if (!LAUNCH_CLAIM.test(by)) throw', 'if (false) throw'],
  ['F1: claimOf back to one per conversation', 'pickRules', "return where !== 'auto' && 'slot' in where ? `slot:${where.slot}` : undefined", "return where !== 'auto' && 'slot' in where ? `slot:${where.slot}` : where !== 'auto' && 'tab' in where ? 'launch:x' : undefined"],
  ['F3: the workspace tag ignored on tabs and named windows', 'workspaceTabs', 'return opts.workspace !== undefined && tag !== undefined && tag !== opts.workspace', 'return false'],
  ['F3: a caller naming no workspace held to one', 'workspaceTabs', 'return opts.workspace !== undefined && tag !== undefined && tag !== opts.workspace', 'return tag !== undefined && tag !== opts.workspace'],
  ["F4: this pane's slot by the file's hash alone", 'slotLive', 'slot.sha256 === SLOT_SCRIPT_SHA256 && slot.live === true', 'slot.sha256 === SLOT_SCRIPT_SHA256'],
  ["F4: this pane's slot by the file's hash alone, in the script", 'slotLive', "$slotOk = $false; $slotStale = $true }`", "$slotStale = $true }`"],
  ['F4: a slot elsewhere running older code', 'slotLive', " || beacon.sha256 !== SLOT_SCRIPT_SHA256) return false", ') return false'],
  ['F4: a slot elsewhere running older code, in the script', 'slotLive', "if ($slotBeacon['sha256'] -cne '${SLOT_SCRIPT_SHA256}') { Refuse 'slot'", "if ($false) { Refuse 'slot'"],
  ['F8: a floor with its heavy-slot folder and cap left out', 'floorRules', 'if (checks.floor === true && (input.heavySlotRoot === undefined || input.maxSessions === undefined)) throw', 'if (false) throw'],
  ['F8: the slots mode with no word on heavy-slot', 'floorRules', 'if (input.slots === true && input.heavySlotRoot === undefined) throw', 'if (false) throw'],
  ['F8: floorOk reading no word as none', 'floorRules', "if (probe.heavyChecked === undefined) return 'heavy'", ''],
  ['D1: a launch of another process naming no workspace', 'workspaceTabs', 'if (opts.workspace === undefined) throw new Error(', 'if (false) throw new Error('],
  ['D2: a window whose launcher refused keeping the claim', 'windowRefusal', "    '  if ($code -ne 0) { Release-Claim }',\n", ''],
  ['D2: a window giving the claim back on a normal end too', 'windowRefusal', "'  if ($code -ne 0) { Release-Claim }',", "'  Release-Claim',"],
  ['D3: a heavy-slot root that is no folder read as free', 'floorScript', "  'if (-not (Test-Path -LiteralPath $heavyRoot -PathType Container)) { throw (\"no folder at \" + $heavyRoot) }',\n", ''],
  ['D3: floorOk passing a reading with no counts', 'floorRules', "if (probe.heavyChecked && (probe.heavyWaiters === null || probe.heavyBusy === null || probe.heavyCap === null)) return 'heavy'", ''],
  ['#46: floorOk passing a reading with no cap', 'floorRules', ' || probe.heavyCap === null)) return', ')) return'],
  ['#46: floorOk waiting at two slots again, whatever the cap', 'floorRules', 'probe.heavyBusy >= probe.heavyCap)', 'probe.heavyBusy >= 2)'],
  ['#46: the launch waiting at two slots again, whatever the cap', 'floorScript', 'if ($heavyBusy -ge $heavyCap) {', 'if ($heavyBusy -ge 2) {'],
  ['#46: only the first two slots read', 'floorScript', "export const HEAVY_SLOTS = ['.gate-lock', '.gate-lock-2', '.gate-lock-3', '.gate-lock-4'] as const", "export const HEAVY_SLOTS = ['.gate-lock', '.gate-lock-2'] as const"],
  ['#46: the cap file never read', 'floorScript', "  'try { if (Test-Path -LiteralPath $heavyCapFile -PathType Leaf) {", "  'try { if ($false) {"],
  ['#46: the cap read past its digits', 'floorScript', "  '$heavyCapDigits = \"$heavyCapText\" -replace \"[^0-9]\", \"\"',", "  '$heavyCapDigits = \"$heavyCapText\" -replace \"[^0-9 ]\", \"\"',"],
  ['round 1, M1: a cap that could not be read taken as the default', 'floorScript', "  'if ($null -ne $heavyCapError) { $heavyCap = $null }',\n", ''],
  ['round 1, M1: a cap that could not be read let through by the launch', 'floorScript', "          `if ($null -eq $heavyCap) { Refuse 'heavy' (\"heavy-slot's .gate-cap could not be read: \" + $heavyCapError) }`,\n", ''],
  ['round 1, M1: the cap read in the folders\' try again', 'floorScript', "  'try { if (Test-Path -LiteralPath $heavyCapFile -PathType Leaf) { $heavyCapText = \"$(Get-Content -LiteralPath $heavyCapFile -Raw)\" } } catch { $heavyCapError = $_.Exception.Message }',", "  'if (Test-Path -LiteralPath $heavyCapFile -PathType Leaf) { $heavyCapText = \"$(Get-Content -LiteralPath $heavyCapFile -Raw)\" }',"],
  ['round 1, L2: a slot held at any age while its job runs', 'floorScript', '(($heavyNow - $since).TotalSeconds -le ${HEAVY_STALE_SECS} -and ', '(('],
  ['#46: the cap not answered by the probe', 'beaconsOfRunners', "'$result[\"heavyCap\"] = $heavyCap', ", ''],
  ['#46: a third or fourth slot refused by the parse', 'parsing', 'if (!(HEAVY_SLOTS as readonly unknown[]).includes(h.slot)) bad(', "if (h.slot !== '.gate-lock' && h.slot !== '.gate-lock-2') bad("],
  ['#46: busy counted to two by the parse', 'parsing', "countOrNull('heavyBusy', 'the heavy slots busy', HEAVY_SLOTS.length)", "countOrNull('heavyBusy', 'the heavy slots busy', 2)"],
  ['D3: floorOk passing a reading with one count missing', 'floorRules', 'probe.heavyWaiters === null || probe.heavyBusy === null', 'probe.heavyWaiters === null && probe.heavyBusy === null'],
  ['D3: heavyChecked taken against its heavy slots', 'parsing', "if (typeof top.heavyChecked === 'boolean' && top.heavyChecked !== (heavy !== null)) bad(", 'if (false) bad('],
  ['D4: the delete tried once', 'windowRefusal', "'      for ($try = 0; $try -lt 3; $try++) {',", "'      for ($try = 0; $try -lt 1; $try++) {',"],
  ['D4: Release-Claim that can throw', 'windowRefusal', "'  } catch { } finally { $stream.Dispose() }',", "'  } finally { $stream.Dispose() }',"],
  ['N2: wt by its bare name', 'wtByItsPath', '$window = Start-Process $wtExe -ArgumentList', '$window = Start-Process wt.exe -ArgumentList'],
  ["N12: a live holder's lock taken", 'relockHolder', "if ($held) { $answer = 'held' } else {", "if ($false) { $answer = 'held' } else {"],
  ['the left stat left off a tab', 'leftAtLastLook', "...(input.left === undefined ? {} : { left: input.left }), ...tabExtra(place) }\n  const tabOf", "...tabExtra(place) }\n  const tabOf"],
  ['the window back on -EncodedCommand', 'windowFile', `'-File', ('"' + $windowFile + '"')`, "'-EncodedCommand', $encoded"],
  ['the window script written without its byte order mark', 'windowFile', '[Text.UTF8Encoding]::new($true).GetPreamble() + ', ''],
  ['the window script written in place', 'windowFile', "  '  [IO.File]::Move($windowTemp, $windowPath)',\n", ''],
  ['SW-L-2: the temporary opened over a file already there (Create, not CreateNew)', 'windowFile', '[IO.File]::Open($windowTemp, [IO.FileMode]::CreateNew,', '[IO.File]::Open($windowTemp, [IO.FileMode]::Create,'],
  ["the window's file named this run's own before it is in place (a failure would delete one already there)", 'windowFile', '          `$windowPath = ${literal(windowed.file)}`,\n', "          `$windowPath = ${literal(windowed.file)}`,\n          '$windowFile = $windowPath',\n"],
  ['a window keeping its script file', 'windowFile', '    `try { [IO.File]::Delete(${literal(v.file)}) } catch { }`,\n', ''],
  ['a fresh window script swept', 'windowFile', '.TotalMilliseconds -gt ${CLAIM_STALE_MS})', '.TotalMilliseconds -gt 0)'],
  ['a failed place leaving its window script', 'windowFile', "if ($null -ne $windowFile) { try { [IO.File]::Delete($windowFile) } catch { } }; Refuse 'place'", "Refuse 'place'"],
  ['a withdrawn window leaving its script', 'windowFile', '; try { [IO.File]::Delete($windowFile) } catch { } } }', ' } }'],
  ["PowerShell 7's policy left unread", 'windowPolicy', "if ($pwshPolicy -eq 'AllSigned' -or $pwshPolicy -eq 'Restricted') { $pwshOk = $false }", 'if ($false) { $pwshOk = $false }'],
  ["Windows PowerShell's policy let through to the window", 'windowPolicy', "if ($windowsPolicy -eq 'AllSigned' -or $windowsPolicy -eq 'Restricted') {", 'if ($false) {'],
  ['the policy read after the claim (or not at all)', 'windowPolicy', '    ...chooseShell,\n', ''],
  ['the policy refusal left out', 'windowPolicy', '    ...refusePolicy,\n', ''],
  ['PowerShell 7 deferring to no one', 'windowPolicy', 'if ($defer -is [int] -and $defer -eq 1)', 'if ($false)'],
  ['a policy that could not be read refused on', 'windowPolicy', "} catch { $policy = 'Undefined' } finally {", "} catch { $policy = 'Restricted' } finally {"],
  ["'auto' refused for the policy when it goes to this pane's slot", 'windowPolicy', `transport === 'auto' ? "$transport -eq 'window'" :`, "transport === 'auto' ? undefined :"],
  ['a named window refused for the policy when Windows Terminal opens it', 'windowPolicy', "'$null -ne $slotFallback' : undefined", 'undefined : undefined'],
  ['WF-M-1: a window that ended without its start signal taken as placed', 'windowStart', 'throw ("the window ended before its first line ran', 'break; ("the window ended before its first line ran'],
  ['WF-M-1: the signal read before the end (a window that began, then ended at once, refused)', 'windowStart', "    '  try { $windowEnded = $true -eq $window.HasExited } catch { $windowEnded = $false }',\n    '  if ($windowSignal.WaitOne(0)) { break }',\n", "    '  if ($windowSignal.WaitOne(0)) { break }',\n    '  try { $windowEnded = $true -eq $window.HasExited } catch { $windowEnded = $false }',\n"],
  ['WF-M-1: the file going taken as the window begun again', 'windowStart', "    '  if ($windowSignal.WaitOne(0)) { break }',\n", "    '  if (-not [IO.File]::Exists($windowFile)) { break }',\n"],
  ['WF-M-2: a window not begun by the bound placed anyway', 'windowStart', 'throw ("the window had not begun " + $windowSecs + " s after it started, so it was ended', 'break; ("the window had not begun " + $windowSecs + " s after it started, so it was ended'],
  ['R2-I-2: "ended" said without reading that the window has gone', 'windowStart', 'try { $windowGone = $true -eq $window.HasExited } catch { $windowGone = $false }', '$windowGone = $true'],
  ['R2-I-2: a window that could not be ended placed anyway', 'windowStart', `'    throw ("the window had not begun " + $windowSecs + " s after it started, and could not be ended;`, `'    break; ("the window had not begun " + $windowSecs + " s after it started, and could not be ended;`],
  ['WF-M-2: a watch with no bound', 'windowStart', "    '  if ($windowWatch.ElapsedMilliseconds -ge $windowLimit) {',\n", ''],
  ['WF-M-2: the watch not ended at the deadline (a run that could outlast LAUNCH_RUN_MS)', 'windowStart', '[math]::Min($windowLimit, [math]::Max(0, ${deadline} - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()))', '$windowLimit'],
  ["WF-M-2: the window's handle not taken at once (its end and exit code may be another process's)", 'windowStart', "    'try { $windowHeld = $null -ne $window.Handle } catch { $windowHeld = $false }',\n", ''],
  ['WF-M-2: a bound past the deadline', 'windowStart', 'export const WINDOW_START_MS = 8000', 'export const WINDOW_START_MS = 30000'],
  ['WF-M-1: the window not setting its start signal', 'windowSignal', '    `try { $launchSignal = [Threading.EventWaitHandle]::OpenExisting(${literal(v.signal)}); try { [void]$launchSignal.Set() } finally { $launchSignal.Dispose() } } catch { }`,\n', ''],
  ["WF-M-1: a start signal already there taken as this launch's own", 'windowSignal', "'  if (-not $windowSignalNew) { throw (", "'  if ($false) { throw ("],
  ['WF-M-1: the start signal never disposed', 'windowSignal', "          '} finally { $windowSignal.Dispose() }',\n", "          '}',\n"],
  ['#5: a rect let through on a named window', 'placeFile', "    if (value.rect !== undefined) errors.push(`${where} has a rect, which a named window does not take (not built): give it pos, in pixels, and size, in columns and rows`)\n", ''],
  ['#5: maximized false taken', 'placeFile', '      if (value.maximized === true) out.maximized = true\n      else errors.push(', '      out.maximized = true\n      if (false) errors.push('],
  ['#5: the plain window taken with no place', 'placeFile', '    if (value.rect === undefined && value.maximized === undefined) errors.push(', '    if (false) errors.push('],
  ['#5: pos taken on the plain window', 'placeFile', '    if (value.pos !== undefined || value.size !== undefined) errors.push(', '    if (false) errors.push('],
  ['#5: a window with no name read as a named one', 'placeFile', '    if (value.name === undefined) return plainOf(value, `${where}.window`)\n', ''],
  ['#5: a rect past its bounds taken', 'placeFile', '(width as number) >= RECT_LIMITS.minWidth && ', ''],
  ['#5: the placing lines in an unplaced window too', 'placeLaunch', '    ...(v.place === undefined ? [] : windowPlaceLines(v.place)),', '    ...windowPlaceLines(v.place ?? { maximized: true }),'],
  ['#5: the placing lines dropped from a placed window', 'placeLaunch', "...(v.place === undefined ? {} : { place: v.place }) })", '})'],
  ["#5: a named window's maximized not reaching wt", 'placeLaunch', "    ...(input.maximized === true ? ['-M'] : []),\n", ''],
  ['#5: a bad rect let through the launch', 'placeLaunch', "  if (value.rect !== undefined && !isRect(value.rect)) throw new Error(`the plain window's rect", "  if (false) throw new Error(`the plain window's rect"],
  ["#5: the caller's side acting on a window", 'placeLaunch', '          ...SWEEP_WINDOW_FILES,\n', "          ...SWEEP_WINDOW_FILES,\n          '[void]SetWindowPos',\n"],
  ['#5: a failure to place that stops the window', 'placeLaunch', `'} catch { $placeSaid = "it could not be placed (" + $_.Exception.Message + ")" }',`, `'} catch { throw },',`],
  ["#5: another import in the window's C#", 'actingCalls', `  '[DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr window, int show);',\n`, `  '[DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr window, int show);',\n  '[DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);',\n`],
  ['#5: SetWindowPos activating the window', 'actingCalls', 'export const PLACE_SWP_FLAGS = 0x4214', 'export const PLACE_SWP_FLAGS = 0x4204'],
  ['#5: SetWindowPos changing the Z order', 'actingCalls', 'export const PLACE_SWP_FLAGS = 0x4214', 'export const PLACE_SWP_FLAGS = 0x4210'],
  ['#5: the window found by its title', 'actingCalls', "  'IntPtr console = GetConsoleWindow();',", `  'IntPtr console = FindWindow(null, "claude");',`],
  ['#5: another window taken as its own', 'actingCalls', 'if (kind == "ConsoleWindowClass") own = console;', 'if (kind == "ConsoleWindowClass") own = GetWindow(console, 2);'],
  ['#5: a pseudoconsole owner taken whatever its class', 'actingCalls', ' || ClassOf(own) != "CASCADIA_HOSTING_WINDOW_CLASS")', ')'],
  ['#5: a window that opened maximized moved all the same', 'actingCalls', "  'if (IsIconic(own) || IsZoomed(own)) return \"it opened minimized or maximized, so it is left as it is\";',\n", ''],
  ['#5: the place read DPI-unaware', 'actingCalls', 'IntPtr before = SetThreadDpiAwarenessContext(new IntPtr(-4));', 'IntPtr before = new IntPtr(1);'],
  ['#5: maximize swapped for another show command', 'actingCalls', 'ShowWindowAsync(own, 3)', 'ShowWindowAsync(own, 1)'],
  ['#5: a string reaching the call', 'actingCalls', '`  $placeSaid = [ClaudeSelfToolsPlace]::Place([int]${rect[0]}, ', "`  $placeSaid = [ClaudeSelfToolsPlace]::Place('${rect[0]}', "],
  ['#5: windowPlaceLines taking an unchecked rect', 'actingCalls', '  if (place.rect !== undefined && !isRect(place.rect)) throw new Error(`not a rect: ${JSON.stringify(place.rect)}`)\n', ''],
  ['#5: the clamp not shrinking a window', 'clampRule', '  const w = Math.min(width, right - left)\n', '  const w = width\n'],
  ['#5: a rect off every monitor left there (no nearest monitor)', 'clampRule', '  if (overlap(best.monitor) === 0) for (const m of monitors) if (gap(m.monitor) < gap(best.monitor)) best = m\n', ''],
  ['#5: the monitor that holds less of the rect taken', 'clampRule', '  for (const m of monitors) if (overlap(m.monitor) > overlap(best.monitor)) best = m\n', '  for (const m of monitors) if (overlap(m.monitor) > 0 && overlap(m.monitor) < overlap(best.monitor)) best = m\n'],
  ['#5: the clamp moving past the work area on the left', 'clampRule', '  return [Math.max(left, Math.min(x, right - w)), Math.max(top, Math.min(y, bottom - h)), w, h]', '  return [Math.min(x, right - w), Math.max(top, Math.min(y, bottom - h)), w, h]'],
  ['#5: a hosted window opening a new plain window each move', 'plainLegs', '.legs.filter(leg => !isPlainWindow(leg))', '.legs'],
  ["#5: a layout window's maximized dropped from its tab", 'plainLegs', ', ...(home?.maximized === undefined ? {} : { maximized: home.maximized })', ''],
  ['#5: the plain window read as a named one', 'plainLegs', "where.window === true || !('name' in where.window)", 'where.window === true'],
  ['#5 Fix A: the window moved without its consoles counted (the guard removed)', 'actingCalls', ' int hosted = Hosted(own, console); if (hosted != 1) return "its Windows Terminal window holds other tabs or panes, or its own console could not be counted among them (" + hosted + "), so it is left where it is";', ''],
  ['#5 Fix A: the count compared to another number', 'actingCalls', 'if (hosted != 1) return "its Windows Terminal window', 'if (hosted < 1) return "its Windows Terminal window'],
  ['#5 Fix A: every top-level window counted (the class comparison dropped)', 'actingCalls', 'if (ClassOf(found) == "PseudoConsoleWindow" && Same(GetWindow(found, 4), window)) {', 'if (Same(GetWindow(found, 4), window)) {'],
  ['#5 Fix A: another class counted', 'actingCalls', 'ClassOf(found) == "PseudoConsoleWindow" &&', 'ClassOf(found) == "ConsoleWindowClass" &&'],
  ['#5 Fix A: a variable taken as the class', 'actingCalls', 'ClassOf(found) == "PseudoConsoleWindow" &&', 'ClassOf(found) == kind &&'],
  ['#5 Fix A: every pseudoconsole counted, whoever owns it (the owner comparison dropped)', 'actingCalls', ' && Same(GetWindow(found, 4), window)) {', ') {'],
  ['#5 Fix A: its own console not looked for among them', 'actingCalls', 'if (Same(found, console)) seen = true;', 'seen = true;'],
  ['#5 Fix A: a failed listing taken as a count', 'actingCalls', ' if (!listed) return -1;', ''],
  ['#5 Fix A: the listing stopped at the first window (the callback answering false)', 'actingCalls', ' seen = true; } return true; };', ' seen = true; } return false; };'],
  ['#5 Fix A: the delegate let go before the listing ends', 'actingCalls', ' GC.KeepAlive(each);', ''],
  ['#5 Fix A: handles compared in full, not by their low 32 bits', 'actingCalls', 'return (a.ToInt64() & 0xffffffffL) == (b.ToInt64() & 0xffffffffL);', 'return a == b;'],
  [
    '#5 Fix A: a FindWindow walk put back',
    'actingCalls',
    "  '[DllImport(\"user32.dll\")] static extern bool EnumWindows(EachWindow each, IntPtr data);',\n",
    "  '[DllImport(\"user32.dll\")] static extern bool EnumWindows(EachWindow each, IntPtr data);',\n  '[DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string className, string title);',\n",
    [['bool listed = EnumWindows(each, IntPtr.Zero);', 'IntPtr after = IntPtr.Zero; while ((after = FindWindowExW(IntPtr.Zero, after, "PseudoConsoleWindow", null)) != IntPtr.Zero) each(after, IntPtr.Zero); bool listed = true;']],
  ],
  ['#5 Fix A: a GetWindow loop put back', 'actingCalls', 'bool listed = EnumWindows(each, IntPtr.Zero);', 'for (IntPtr next = GetWindow(console, 0); next != IntPtr.Zero; next = GetWindow(next, 2)) each(next, IntPtr.Zero); bool listed = true;'],
  [
    '#5 review WP-L-3: an import by the namespace-qualified attribute',
    'actingCalls',
    "  '[DllImport(\"user32.dll\")] static extern bool EnumWindows(EachWindow each, IntPtr data);',\n",
    "  '[DllImport(\"user32.dll\")] static extern bool EnumWindows(EachWindow each, IntPtr data);',\n  '[System.Runtime.InteropServices.DllImport(\"user32.dll\")] static extern bool SwitchToThisWindow(IntPtr w, bool b);',\n",
  ],
  [
    '#5 review WP-L-3: an import by DllImportAttribute',
    'actingCalls',
    "  '[DllImport(\"user32.dll\")] static extern bool EnumWindows(EachWindow each, IntPtr data);',\n",
    "  '[DllImport(\"user32.dll\")] static extern bool EnumWindows(EachWindow each, IntPtr data);',\n  '[DllImportAttribute(\"user32.dll\")] static extern bool OpenIcon(IntPtr w);',\n",
  ],
  ['#91: fixed slots after the free cells', 'gridPlan', '  // 1. Fixed slots.\n', '  if (false) // 1. Fixed slots.\n'],
  ['#91: a free cell taken though its window is open', 'gridPlan', 'const free = grid.windows.filter(w => w.tabs === undefined && !open.has(w.window))', 'const free = grid.windows.filter(w => w.tabs === undefined)'],
  ['#91: overflow all into the first free cell', 'gridPlan', "step(session, ring[k % ring.length] as GridWindow, 'overflow')", "step(session, ring[0] as GridWindow, 'overflow')"],
  ['#91: overflow into an unplaced window when no cell is left', 'gridPlan', "if (ring.length === 0) refused.push({ session, why:", "if (ring.length === 0) steps.push({ session, window: 'overflow', opens: 'new', by: 'overflow' }); else if (false) refused.push({ session, why:"],
  ['#91: a joining tab placing its window again', 'gridPlan', 'const place = !isNew ? undefined : w.rect', 'const place = false ? undefined : w.rect'],
  ['#91: window names open compared by case', 'gridPlan', 'slot.beacon?.window === undefined ? [] : [slot.beacon.window]', 'slot.beacon?.window === undefined ? [] : [slot.beacon.window, slot.beacon.window.toUpperCase()]'],
  ['#91: an old Windows Terminal taken', 'gridPlan', 'if (major < needMajor || (major === needMajor && minor < needMinor)) return', 'if (false) return'],
  ['#91 round 2: prompt files swept only by a launch that carries one', 'tabPlace', '...(launchUuid === undefined ? [] : [`$promptDir = [IO.Path]::GetDirectoryName(', '...(v.prompt === undefined || launchUuid === undefined ? [] : [`$promptDir = [IO.Path]::GetDirectoryName('],
  ['#91 round 2: the prompt file written over one already there', 'tabPlace', '[IO.File]::Open($promptFile, [IO.FileMode]::CreateNew,', '[IO.File]::Open($promptFile, [IO.FileMode]::Create,'],
  ['#91 round 2: the version read checking wt.exe too', 'gridPlan', "    ...READ_WT_VERSION,\n    \"[Console]::Out.WriteLine('wt ' + ", "    ...READ_WT_VERSION,\n    \"$wtExe = 'wt.exe'\",\n    \"[Console]::Out.WriteLine('wt ' + "],
  ['#91: a tab told to place its window with --pos as well', 'tabPlace', "  if (!('idle' in run) && run.place !== undefined && (input.pos !== undefined || input.size !== undefined || input.maximized !== undefined)) throw", '  if (false) throw'],
  ['#91: the place events made after wt starts the tab', 'tabPlace', '          ...makePlaceEvents,\n', '', [["          '$window = Start-Process $wtExe -ArgumentList $wtLine -PassThru',\n          ...waitPlace,", "          '$window = Start-Process $wtExe -ArgumentList $wtLine -PassThru',\n          ...makePlaceEvents,\n          ...waitPlace,"]]],
  ['#91: an event already there taken as this launch\'s own', 'tabPlace', "'if (-not $placedNew -or -not $unplacedNew) { throw (", "'if ($false) { throw ("],
  ['#91: the wait for the place past the deadline', 'tabPlace', '[math]::Max(0, ${v.deadline} - ${PLACE_DEADLINE_MARGIN_MS} - [DateTimeOffset]', '[math]::Max(0, ${v.deadline} - [DateTimeOffset]'],
  ['#91: a joining tab told to place its window', 'tabPlace', 'run: tabRun(tab.rect) })', 'run: tabRun(tab.rect ?? [0, 0, 800, 600]) })'],
  ['#91: a prompt on the tab\'s line', 'tabPlace', "...(r.prompt === true ? ['-Prompt'] : [])", "...(r.prompt === true ? ['-Prompt', 'x'] : [])"],
  ['#91: a prompt read as 7 reads it, not 5.1', 'tabPlace', "'$promptRead = Read-Prompt $promptFile $true',", "'$promptRead = Read-Prompt $promptFile $false',"],
  ['#91: a refusal leaving the prompt file', 'tabPlace', "['  if ($null -ne $promptMade) { try { [IO.File]::Delete($promptMade) } catch { } }']", '[]'],
  ['#91: a prompt to a plain window as text', 'tabPlace', "if (typeof where !== 'object' || !('tab' in where)) throw new Error(\"a first prompt's text", "if (false) throw new Error(\"a first prompt's text"],
  ['#91: a slash command let through as a prompt', 'tabPlace', "if (lead.startsWith('/') || lead.startsWith('!')) return", "if (lead.startsWith('!')) return"],
  ['#91: a named window taking a rect after all', 'tabPlace', "      if ('rect' in named) throw new Error(", "      if (false) throw new Error("],
  ['#91: a grid window taking both a rect and maximized', 'gridFile', 'if (value.rect !== undefined && value.maximized !== undefined) errors.push(`${here} has both', 'if (false) errors.push(`${here} has both'],
  ['#91: a grid window taking neither', 'gridFile', 'else if (value.rect === undefined && value.maximized === undefined) errors.push(`${here} has neither', 'else if (false) errors.push(`${here} has neither'],
  ['#91: a session named in two grid windows taken', 'gridFile', 'else if (sessions.has(tab)) errors.push(', 'else if (false) errors.push('],
  ['#91: a grid tab held to the tab-label rule, not the session-name rule', 'gridFile', "typeof tab !== 'string' || !AREA_NAME.test(tab)", "typeof tab !== 'string' || !TAB_LABEL.test(tab)"],
  ['#91: grid window names compared by case', 'gridFile', 'names.has(value.window.toLowerCase())', 'names.has(value.window)'],
  ['#91: an unknown key in a grid window taken', 'gridFile', "keys(value, ['window', 'rect', 'maximized', 'tabs'], here)", "keys(value, ['window', 'rect', 'maximized', 'tabs', 'colour'], here)"],
  ['#90: the overhang dropped from the clamp', 'clampRule', '[work[0] - border[0], work[1], work[2] + border[1], work[3] + border[2]]', 'work'],
  ['#90: the top overhanging too', 'clampRule', '[work[0] - border[0], work[1], work[2] + border[1]', '[work[0] - border[0], work[1] - border[0], work[2] + border[1]'],
  ['#90: a 1 px border taken as one', 'clampRule', 'd >= BORDER_LIMITS.min && d <= BORDER_LIMITS.max ? d : 0', 'd > 0 ? d : 0'],
  ['#90: no limit on a border read', 'clampRule', 'd >= BORDER_LIMITS.min && d <= BORDER_LIMITS.max ? d : 0', 'd >= BORDER_LIMITS.min ? d : 0'],
  ["#90: the console window's border read, not its own window's", 'actingCalls', "'int[] border = BorderOf(own);',", "'int[] border = BorderOf(console);',"],
  ['#90: a failed border read taken as a border', 'actingCalls', ' return new int[] { 0, 0, 0 }; return Overhang(', ' return Overhang('],
  ['#90: the C# clamp not passing the work area on the left', 'actingCalls', 'left = left - borderLeft; ', ''],
  ['#90: the border read before the thread is per-monitor aware', 'actingCalls', "  'int[] border = BorderOf(own);',\n", '', [["'IntPtr console = GetConsoleWindow();',", "'IntPtr console = GetConsoleWindow(); int[] border = BorderOf(console);',"]]],
  ['#5 review WP-L-4: a maximized-only ask of a maximized window said as not placed again', 'actingCalls', "  'if (!hasRect && maximized && IsZoomed(own) && !IsIconic(own)) return \"placed\";',\n", ''],
  ['#5 review WP-L-4: a maximized window taken as placed when a rect is asked too', 'actingCalls', 'if (!hasRect && maximized && IsZoomed(own)', 'if (maximized && IsZoomed(own)'],
  [
    '#5 Fix A: the count moved after an acting call',
    'actingCalls',
    ' int hosted = Hosted(own, console); if (hosted != 1) return "its Windows Terminal window holds other tabs or panes, or its own console could not be counted among them (" + hosted + "), so it is left where it is";',
    '',
    [['return "SetWindowPos failed with error " + Marshal.GetLastWin32Error();', 'return "SetWindowPos failed with error " + Marshal.GetLastWin32Error(); int hosted = Hosted(own, console); if (hosted != 1) return "its Windows Terminal window holds other tabs or panes, or its own console could not be counted among them (" + hosted + "), so it is left where it is";']],
  ],
]

describe("the window script sweep's names follow LAUNCH_ID", () => {
  const work = mkdtempSync(join(tmpdir(), 'machine-launch-id-'))
  after(() => rmSync(work, { recursive: true, force: true }))
  test('a copy of the machine code with another LAUNCH_ID sweeps by that shape, never a pattern of its own', async () => {
    const from = 'export const LAUNCH_ID = SESSION_ID'
    assert.equal(sourceText.split(from).length, 2, 'LAUNCH_ID is defined once')
    const path = join(work, 'machine-launch-id.ts')
    writeFileSync(path, sourceText.split(from).join('export const LAUNCH_ID = /^[0-9a-f-]{36}$/'))
    const copy = await import(pathToFileURL(path).href)
    const s = copy.launchScriptText(launchInput({ claim: `launch:${FRESH}` }))
    assert.ok(s.includes("-cmatch '^[0-9a-f-]{36}\\.ps1(\\.[0-9a-f]{32}\\.tmp)?\\z'"), 'the sweep follows LAUNCH_ID')
    assert.ok(!s.includes("-cmatch '^[0-9a-f]{8}-"), 'no uuid pattern of its own')
  })
})

describe('planted faults in a copy of the machine code, each caught by its check', () => {
  const work = mkdtempSync(join(tmpdir(), 'machine-faults-'))
  after(() => rmSync(work, { recursive: true, force: true }))
  // A fault is one replacement, and at times more, each made after the one before (`more`: [from, to] pairs).
  FAULTS.forEach(([name, check, from, to, more = []], at) => {
    test(`${name} (caught by: ${check})`, async () => {
      let faulty = sourceText.split(from).join(to)
      assert.notEqual(faulty, sourceText, `the fault changed nothing: ${from.slice(0, 80)}`)
      for (const [also, into] of more) {
        assert.ok(faulty.includes(also), `the fault's next part finds nothing: ${also.slice(0, 80)}`)
        faulty = faulty.split(also).join(into)
      }
      const path = join(work, `machine-${at}.ts`)
      writeFileSync(path, faulty)
      const copy = await import(pathToFileURL(path).href)
      await assert.rejects(async () => CHECKS[check](copy), `${check} still passes with the fault in it`)
    })
  })
})
