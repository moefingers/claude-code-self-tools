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
  slotStart: m.launchScriptText(launchInput({ kind: 'start', id: FRESH, name: 'dealerwrap', claim: `slot:${SLOT}`, where: { slot: SLOT }, waitForExit: undefined, checks: { ...FLOOR_CHECKS, fresh: true }, heavySlotRoot: 'O:\\heavy' })),
  slotResume: m.launchScriptText(launchInput({ claim: `slot:${SLOT}`, where: { slot: SLOT }, waitForExit: undefined, checks: { ...FLOOR_CHECKS, live: true }, heavySlotRoot: 'O:\\heavy', left: { size: 12, mtime: 34 } })),
  tabStart: m.launchScriptText(launchInput({ kind: 'start', id: FRESH, name: 'dealerwrap', claim: `launch:${FRESH}`, where: { tab: { window: 'claude-4', title: 'dealerwrap', pos: [960, 540], size: [160, 42] } }, waitForExit: undefined, checks: { ...FLOOR_CHECKS, fresh: true } })),
  tabResume: m.launchScriptText(launchInput({ where: { tab: { window: 'claude-1', title: 'system-overhaul' } } })),
  named: m.launchScriptText(launchInput({ where: { window: { name: 'claude-overflow', pos: [1920, 0], size: [140, 60] } } })),
  plain: m.launchScriptText(launchInput({ claim: `launch:${FRESH}` })),
})
const wtLineOf = script => /^\s*\$wtLine = '(.*)'\r?$/m.exec(script)?.[1]?.split("''").join("'")

/** Each check takes a machine module: the real one, or a copy with a fault in it. */
const CHECKS = {
  launchArguments(m) {
    const s = scriptsOf(m)
    const line = wtLineOf(s.tabStart)
    assert.equal(line, `-w claude-4 --pos 960,540 --size 160,42 nt --title dealerwrap --suppressApplicationTitle -d "C:\\work\\my repo" -- ${POWERSHELL} -NoExit -NoProfile -ExecutionPolicy RemoteSigned -File "${STATE}\\claude-slot.ps1" -Start ${FRESH} -Name dealerwrap -ConfigDirs "${CONFIG}|D:\\other cfg" -Claim launch:${FRESH} -Launcher ${m.LAUNCH_SCRIPT_SHA256}`)
    assert.equal(wtLineOf(s.tabResume), `-w claude-1 nt --title system-overhaul --suppressApplicationTitle -d "C:\\work\\my repo" -- ${POWERSHELL} -NoExit -NoProfile -ExecutionPolicy RemoteSigned -File "${STATE}\\claude-slot.ps1" -Resume ${T} -WaitFor 100-134062345688901240 -ConfigDirs "${CONFIG}|D:\\other cfg" -Claim launch:${T} -Launcher ${m.LAUNCH_SCRIPT_SHA256}`)
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
    assert.equal(m.floorOk(probeOf(m, { heavyBusy: 2 }), 12), 'heavy', 'both slots busy')
    assert.equal(m.floorOk(probeOf(m, { heavyBusy: 1 }), 12), 'ok', 'one slot busy')
    assert.equal(m.floorOk(probeOf(m, { errors: ['heavy:'] }), 12), 'heavy', "heavy-slot's folders unread")
    // D3: read, yet no count, is no reading that it's free; only a named none has none.
    for (const counts of [{ heavyWaiters: null, heavyBusy: null }, { heavyWaiters: null }, { heavyBusy: null }]) assert.equal(m.floorOk(probeOf(m, counts), 12), 'heavy', `read, with no count: ${JSON.stringify(counts)}`)
    assert.equal(m.floorOk(probeOf(m, { room: 12 }), 12), 'cap')
    assert.equal(m.floorOk(probeOf(m, { room: 11 }), 12), 'ok')
    assert.equal(m.floorOk(probeOf(m, { room: 6 }), 6), 'cap', 'the cap as placement names it')
    assert.throws(() => m.floorOk(probeOf(m)), /the cap/, 'never a default')
    assert.equal(m.floorOk(probeOf(m, { heavyChecked: undefined }), 12), 'heavy', 'a reading that does not say whether heavy-slot was looked at')
    assert.equal(m.floorOk(probeOf(m, { heavyChecked: false, heavy: null, heavyWaiters: null, heavyBusy: null }), 12), 'ok', 'named none: no heavy-slot on this machine')
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
    assert.ok(s.includes("if ($heavyBusy -ge 2) { Refuse 'heavy'"), 'both slots busy refuse')
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
    const picked = m.pickLaunchTransport(probeOf(m, { slots: noneIdle }), place, { ...PICK, title: 'dealerwrap' })
    assert.deepEqual(picked.where, { tab: { window: 'claude-4', title: 'dealerwrap', pos: [960, 540], size: [160, 42] } })
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
    assert.ok(s.slotStart.includes("start = $id; name = 'dealerwrap'; folder = $folder;"))
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
    for (const name of ['heavyWaiters', 'heavyBusy', 'room', 'inputIdleSec', 'holders', 'slots']) assert.ok(p.includes(`$result["${name}"] = `), name)
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
    for (const change of [{ slots: 'x' }, { slots: [{ pid: 'x' }] }, { slots: [idleRunner(m, { id: 'wrong' })] }, { slots: [idleRunner(m, { sha256: 'zz' })] }, { heavyWaiters: -1 }, { heavyBusy: 3 }, { room: 1.5 }, { inputIdleSec: 'x' }, { holders: [{ id: 'x', pid: 1, created: '1' }] }, { heavyChecked: true, heavy: null }, { heavyChecked: false, heavy: [] }]) {
      assert.ok('error' in m.parseProbe(JSON.stringify(raw(change))), JSON.stringify(change))
    }
    // D3: heavyChecked says what the heavy slots say.
    assert.equal(probeOf(m, { heavyChecked: true, heavy: [] }).heavyChecked, true)
    assert.equal(probeOf(m, { heavyChecked: false, heavy: null, heavyWaiters: null, heavyBusy: null }).heavyChecked, false)
    // An old probe: no slots mode, all of it null.
    const { slots, heavyWaiters, heavyBusy, room, inputIdleSec, holders, ...old } = raw()
    const parsed = m.parseProbe(JSON.stringify(old))
    assert.deepEqual([parsed.slots, parsed.heavyWaiters, parsed.heavyBusy, parsed.room, parsed.inputIdleSec, parsed.holders], [null, null, null, null, null, null])
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
    assert.ok(inner.includes('if (-not (Test-Gone 100)) { $refusal = ') && !inner.includes('Get-Process -Id'), 'the old process asked whether it has exited')
    assert.ok(inner.includes(`"& '" + $handPath + "' -Resume " + $id + " -Dir '" + $folder + "'"`), 'N2')
    assert.ok(/Write-Host \$refusal\r\n.*\r\n {2}Release-Claim\r\n {2}Read-Host/.test(inner), 'N5: the refusal gives the claim back before it waits')
    assert.ok(inner.includes('function Release-Claim {'))
    // D2: the launcher refusing or ending non-zero gives this launch's claim back, before the window waits; a normal end, even a short one, doesn't.
    assert.ok(/Claude Code ended \(exit code \$code\)\."\r\n.*\r\n {2}if \(\$code -ne 0\) \{ Release-Claim \}\r\n {2}Read-Host/.test(inner), 'D2')
    // D4: the delete tried again, and it never throws, so a window's words and its Enter are never lost to it.
    assert.ok(inner.includes('      for ($try = 0; $try -lt 3; $try++) {\r\n        if ($try -gt 0) { Start-Sleep -Milliseconds 250 }\r\n        try { [IO.File]::Delete($claimPath); break } catch { }\r\n'), 'D4: tried three times')
    assert.ok(inner.includes('  } catch { } finally { $stream.Dispose() }\r\n'), 'D4: never throws')
    const late = m.launchScriptText(launchInput({ deadline: NOW }))
    assert.ok(late.includes('if ($transport -eq "window" -and $null -ne $window) { try { $window.Kill() } catch { } }'), 'N6')
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
  leftAtLastLook(m) {
    // D1: every stat a window takes, claude-launch.ps1 takes.
    assert.ok(m.LAUNCH_SCRIPT_TEXT.includes("$Whole = '^\\d{1,16}\\z'"))
    assert.ok(String(2 ** 53).length <= 16)
    // A slot's record carries the stat; the tab's arguments do.
    assert.ok(wtLineOf(m.launchScriptText(launchInput({ where: { tab: { window: 'a', title: 'a' } }, left: { size: 12, mtime: 34 } }))).includes('-LeftSize 12 -LeftMtime 34'))
    assert.ok(wtLineOf(m.launchScriptText(launchInput({ where: { tab: { window: 'a', title: 'a' } }, left: { exitAt: 56 } }))).includes('-LeftExitAt 56'))
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
  ['the heavy-waiter check removed', 'floorRules', '(probe.heavyWaiters ?? 0) > 0 || ', ''],
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
  ['the old process looked for in the table, in the window', 'windowRefusal', 'if (-not (Test-Gone ${v.waitFor.pid})) {', 'if (Get-Process -Id ${v.waitFor.pid} -ErrorAction SilentlyContinue) {'],
  ['a refusing window keeping the claim', 'windowRefusal', "  `  Write-Host (\"Once it is safe, resume it yourself: \" + ${byHand})`,\n    '  Release-Claim',\n".replace('  `  Write', '    `  Write'), "    `  Write-Host (\"Once it is safe, resume it yourself: \" + ${byHand})`,\n"],
  ['a window withdrawn left waiting', 'windowRefusal', `          '  if ($transport -eq "window" -and $null -ne $window) { try { $window.Kill() } catch { } }',\n`, ''],
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
  ['a tab starting with no -Launcher', 'launchArguments', "'-Name', run.name, ...named, ...claim(run.claim), '-Launcher', LAUNCH_SCRIPT_SHA256]", "'-Name', run.name, ...named, ...claim(run.claim)]"],
  ['a tab resuming with no -Launcher', 'launchArguments', "...named, ...left, ...claim(run.claim), '-Launcher', LAUNCH_SCRIPT_SHA256]", '...named, ...left, ...claim(run.claim)]'],
  ['F1: a tab line with no -Claim', 'launchArguments', "...named, ...left, ...claim(run.claim), '-Launcher', LAUNCH_SCRIPT_SHA256]", "...named, ...left, '-Launcher', LAUNCH_SCRIPT_SHA256]"],
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
  ['D3: floorOk passing a reading with no counts', 'floorRules', "if (probe.heavyChecked && (probe.heavyWaiters === null || probe.heavyBusy === null)) return 'heavy'", ''],
  ['D3: floorOk passing a reading with one count missing', 'floorRules', 'probe.heavyWaiters === null || probe.heavyBusy === null', 'probe.heavyWaiters === null && probe.heavyBusy === null'],
  ['D3: heavyChecked taken against its heavy slots', 'parsing', "if (typeof top.heavyChecked === 'boolean' && top.heavyChecked !== (heavy !== null)) bad(", 'if (false) bad('],
  ['D4: the delete tried once', 'windowRefusal', "'      for ($try = 0; $try -lt 3; $try++) {',", "'      for ($try = 0; $try -lt 1; $try++) {',"],
  ['D4: Release-Claim that can throw', 'windowRefusal', "'  } catch { } finally { $stream.Dispose() }',", "'  } finally { $stream.Dispose() }',"],
  ['N2: wt by its bare name', 'wtByItsPath', '$window = Start-Process $wtExe -ArgumentList', '$window = Start-Process wt.exe -ArgumentList'],
  ["N12: a live holder's lock taken", 'relockHolder', "if ($held) { $answer = 'held' } else {", "if ($false) { $answer = 'held' } else {"],
  ['the left stat left off a tab', 'leftAtLastLook', "...(input.left === undefined ? {} : { left: input.left }) }\n  const tabOf", "}\n  const tabOf"],
]

describe('planted faults in a copy of the machine code, each caught by its check', () => {
  const work = mkdtempSync(join(tmpdir(), 'machine-faults-'))
  after(() => rmSync(work, { recursive: true, force: true }))
  FAULTS.forEach(([name, check, from, to], at) => {
    test(`${name} (caught by: ${check})`, async () => {
      const faulty = sourceText.split(from).join(to)
      assert.notEqual(faulty, sourceText, `the fault changed nothing: ${from.slice(0, 80)}`)
      const path = join(work, `machine-${at}.ts`)
      writeFileSync(path, faulty)
      const copy = await import(pathToFileURL(path).href)
      await assert.rejects(async () => CHECKS[check](copy), `${check} still passes with the fault in it`)
    })
  })
})
