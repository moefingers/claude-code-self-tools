// Every PowerShell command line the plugins build, with the largest inputs they take, must stay under
// 24,000 characters: Windows allows one 32,767, and past it the process never starts (every switch
// was refused when the probe reached 33,041). Run with `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { ROOT } from './sync-shared.mjs'

const machine = await import(pathToFileURL(join(ROOT, 'shared', 'hooks', 'machine.ts')).href)

const LIMIT = 24_000
const B = '\\'
/** A folder of 240 characters on `drive`, the longest the plugins take (projects are cut at 200). */
const folder = (drive, tag) => `${drive}:${B}${`${tag}${B}${'x'.repeat(40)}${B}`.repeat(6)}`.slice(0, 240)
const W = '3f6a2c1e-8b4d-4e9a-a7c2-5d1b9e0f4a6c'
const T = '9d2e7b4a-1c6f-4a3e-b8d5-0e7c2a9f1b3d'
const BY = 'launch:5e1a9c3b-7d2f-4b8e-a6c4-1f9d3e7b2a5c'
const POWERSHELL = `C:${B}Windows${B}System32${B}WindowsPowerShell${B}v1.0${B}powershell.exe`
const configDirs = Array.from({ length: 8 }, (_, i) => folder('C', `config${i}`))
const state = folder('D', 'state')
const resumeIn = folder('E', 'work')

/** A command line as Windows builds it from an argv: each argument with a space or a quote quoted. */
const commandLine = argv => argv.map(a => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ')

/** A launch through the shared launcher, with the largest inputs it takes. */
const launchFor = change => machine.launchScriptText({
  powershell: POWERSHELL,
  kind: 'resume',
  id: T,
  folder: resumeIn,
  claim: BY,
  configDirs,
  stateDir: state,
  where: { window: true },
  waitForExit: { pid: 4294967295, created: '99999999999999999999' },
  left: { size: 9007199254740991, mtime: 9007199254740991 },
  deadline: 9007199254740991,
  tool: 'self-restart',
  ...change,
})
const window = launchFor({})
const restart = launchFor({ where: 'auto', left: undefined })
const start = launchFor({ kind: 'start', name: 'a'.repeat(40), checks: { fresh: true, floor: true, input: true }, waitForExit: undefined, left: undefined })
const TOKEN = '00000000-0000-4000-a000-000000000001'
const scripts = [
  ["self-switch's probe: two ids, the claim, 8 config folders, a heavy-slot root", machine.probeScript({ ids: [W, T], take: T, configDirs, stateDir: state, heavySlotRoot: folder('F', 'heavy') })],
  ["self-restart's probe", machine.probeScript({ ids: [W], configDirs: [], stateDir: state })],
  ["the exit pre-check's probe (runProbe, for self-exit and self-restart)", machine.probeScript({ ids: [W], configDirs: [] })],
  ['the in-place claim check, 8 config folders', machine.claimCheckScript({ stateDir: state, id: T, by: BY, configDirs })],
  ['the release', machine.releaseScript({ stateDir: state, id: T, by: BY })],
  ["a switch's launcher, 8 config folders", window],
  ["self-restart's launcher", restart],
  ["self-restart's pane script, the claim and a ticket of the longest folder", machine.paneScript({ stateDir: state, ticket: { token: W, resume: T, by: BY, dir: resumeIn, at: Date.now() }, claim: true })],
  ["self-switch's pane script, a ticket of the longest folder", machine.paneScript({ stateDir: state, ticket: { token: W, resume: T, by: BY, dir: resumeIn, at: Date.now() } })],
  ['the launch to a window: 8 config folders, the longest folder, a left record, a deadline', window],
  ["the launch 'auto' (self-restart's): this pane's slot or a window", restart],
  ['the launch of a start: its id checked new in 8 config folders', start],
  ["the launch to this tab: a ticket naming 8 config folders", launchFor({ where: { pane: { token: TOKEN } }, now: Date.now(), left: undefined })],
  ["the launch to this pane's slot", launchFor({ where: { slot: '4294967295-99999999999999999999' }, claim: 'slot:4294967295-99999999999999999999', left: undefined })],
  ['the in-place check with a left record', machine.claimCheckScript({ stateDir: state, id: T, by: BY, configDirs, left: { size: 9007199254740991, mtime: 9007199254740991 } })],
  ['the left record, written', machine.leftScript({ stateDir: state, id: T, how: 'exit', configDirs, by: 'coordinator', go: `wu_${'a'.repeat(40)}`, process: { pid: 4294967295, created: '99999999999999999999' } })],
  ['the left records, read: 8 ids', machine.leftReadScript({ stateDir: state, ids: Array.from({ length: 8 }, () => T), configDirs })],
  ["the probe, reading 8 ids' left records", machine.probeScript({ ids: Array.from({ length: 8 }, () => T), take: T, configDirs, stateDir: state, heavySlotRoot: folder('F', 'heavy'), left: true })],
  ['the probe in slots mode', machine.probeScript({ ids: [T], configDirs, stateDir: state, heavySlotRoot: folder('F', 'heavy'), slots: true })],
  ['the relock', machine.relockScript({ stateDir: state, id: T, by: BY, holder: { pid: 4294967295, created: '99999999999999999999' } })],
  ['the launch to an idle slot elsewhere: its floor, its input, a start', launchFor({ kind: 'start', name: 'a'.repeat(40), checks: { fresh: true, floor: true, input: true }, waitForExit: undefined, left: undefined, where: { slot: '4294967295-99999999999999999999' }, claim: 'slot:4294967295-99999999999999999999', heavySlotRoot: folder('F', 'heavy') })],
  ['lanes.json, one entry of the longest folder', machine.lanesUpdateScript({ configDir: configDirs[0], name: 'a'.repeat(40), entry: { session: T, folder: resumeIn, window: 'w'.repeat(40), tab: 't'.repeat(40), ws: 'w_abcdefghijkl', at: 9007199254740991 } })],
]

test('each script runs from standard input: its command line is the fixed bootstrap, under 24,000 characters', () => {
  for (const [name, script] of scripts) {
    const call = machine.powershellCall(POWERSHELL, script)
    assert.equal(call.stdin, script, name)
    assert.deepEqual(call.argv.slice(0, 4), [POWERSHELL, '-NoProfile', '-NonInteractive', '-EncodedCommand'], name)
    assert.equal(Buffer.from(call.argv[4], 'base64').toString('utf16le'), machine.STDIN_BOOTSTRAP, name)
    const length = commandLine(call.argv).length
    assert.ok(length < LIMIT, `${name}: ${length} characters`)
  }
})

/**
 * The window's own script, as the launch script carries it: one single-quoted literal, `$inner = '...'`,
 * its own quotes doubled. It ends at the first single quote that isn't doubled.
 */
function innerOf(script) {
  const from = script.indexOf("$inner = '")
  assert.ok(from > 0, 'the window script is one literal')
  let i = from + "$inner = '".length
  const start = i
  for (; i < script.length; i += 1) {
    if (script[i] === "'" && script[i + 1] === "'") {
      i += 1
      continue
    }
    if (script[i] === "'") break
  }
  return script.slice(start, i).split("''").join("'")
}

test("the window's own command line, every argument Start-Process gives it: the inner script GZip-compressed in a fixed unpacking bootstrap, under 24,000 characters", () => {
  for (const [name, script, runs] of [
    ["a switch's window", window, '& $launchPath -Resume $id -Dir $folder -ConfigDir $configDirs'],
    ["self-restart's window", restart, '& $launchPath -Resume $id -Dir $folder -ConfigDir $configDirs'],
    ['a start, its name the longest', start, '& $launchPath -Start $id -Name $name -Dir $folder -ConfigDir $configDirs'],
  ]) {
    const inner = innerOf(script)
    assert.ok(inner.includes(`$id = '${T}'`) && inner.includes(runs), `${name}: the inner script`)
    // The arguments as Start-Process passes them, read off its own line (-ExecutionPolicy among them).
    const given = /-ArgumentList ((?:'[^']*', )+)\$encoded -PassThru/.exec(script)?.[1]
    assert.ok(given !== undefined, `${name}: the Start-Process line`)
    const args = given.split(', ').filter(Boolean).map(arg => arg.slice(1, -1))
    assert.deepEqual(args, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'], name)
    // The window is started with the unpacking bootstrap, never the inner script itself.
    assert.ok(script.includes('$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($unpack))'), name)
    const unpackLine = script
      .split('\r\n')
      .map(line => line.trimStart())
      .find(line => line.startsWith('$unpack = "'))
    assert.ok(unpackLine !== undefined, `${name}: the unpacking bootstrap`)
    const payload = gzipSync(Buffer.from(inner, 'utf8')).toString('base64')
    const unpack = unpackLine.slice('$unpack = "'.length, -1).replace('$payload', payload)
    const encoded = Buffer.from(unpack, 'utf16le').toString('base64')
    const length = commandLine([POWERSHELL, ...args, encoded]).length
    assert.ok(length < LIMIT, `${name}: ${length} characters (the inner script ${inner.length})`)
    // Left on the command line as it was, it would have been far longer.
    assert.ok(Buffer.from(inner, 'utf16le').toString('base64').length > length, name)
  }
})

test('a launch runs for LAUNCH_RUN_MS, the machine code\'s, 10 s past LAUNCH_DEADLINE_MS: no plugin keeps a number of its own (N10)', () => {
  assert.equal(machine.LAUNCH_RUN_MS - machine.LAUNCH_DEADLINE_MS, 10_000)
  for (const plugin of ['self-switch', 'self-restart']) {
    const text = readFileSync(join(ROOT, 'plugins', plugin, 'hooks', 'register.ts'), 'utf8')
    assert.ok(/timeoutMs: LAUNCH_RUN_MS\b/.test(text), `${plugin} runs the launch for LAUNCH_RUN_MS`)
    assert.ok(!/\bLAUNCH_MS\b/.test(text), `${plugin} keeps no LAUNCH_MS of its own`)
  }
})

test("every run of a script passes it on standard input: the bootstrap never reads the engine's default stdin", () => {
  for (const plugin of ['self-switch', 'self-restart']) {
    const text = readFileSync(join(ROOT, 'plugins', plugin, 'hooks', 'register.ts'), 'utf8')
    // A script built by powershellCall, or by launch(), the shared launcher, which is powershellCall too.
    const calls = text.split('powershellCall(').length - 1 + text.split('buildLaunch(').length - 1
    const runs = text.split('$.process.run(').length - 1
    const withStdin = (text.match(/\$\.process\.run\(call\.argv, \{\s*stdin: call\.stdin,/g) ?? []).length
    assert.ok(calls > 0, `${plugin} runs its scripts through powershellCall`)
    assert.ok(!text.includes('import { launch,') && !/\blaunch\(/.test(text.replace(/buildLaunch\(/g, '')), `${plugin} calls launch() only as buildLaunch`)
    assert.equal(runs, calls, `${plugin}: every $.process.run is of a powershellCall`)
    assert.equal(withStdin, calls, `${plugin}: every run passes the call's stdin`)
  }
})

test('the machine code runs PowerShell only through powershellCall with its stdin, and git by fixed argv', () => {
  const text = readFileSync(join(ROOT, 'shared', 'hooks', 'machine.ts'), 'utf8')
  const runs = text.split('$.process.run(').length - 1
  const git = (text.match(/\$\.process\.run\(\['git', /g) ?? []).length
  const withStdin = (text.match(/\$\.process\.run\(call\.argv, \{ stdin: call\.stdin,/g) ?? []).length
  const calls = (text.match(/const call = powershellCall\(/g) ?? []).length
  assert.equal(git, 1, 'one git runner (gitIn)')
  assert.ok(withStdin >= 1, 'the probe runs from the machine code (runProbe)')
  assert.equal(runs, git + withStdin, 'every other $.process.run in the machine code is a powershellCall with its stdin')
  assert.equal(calls, withStdin, 'each powershellCall is run with its stdin')
})

test('self-exit, self-check and self-wake start no process of their own: the probe runs through the machine code, the tools through $.tool.call', () => {
  for (const plugin of ['self-exit', 'self-check', 'self-wake']) {
    const text = readFileSync(join(ROOT, 'plugins', plugin, 'hooks', 'register.ts'), 'utf8')
    assert.equal(text.includes('$.process.run('), false, `${plugin} runs no process itself`)
    assert.equal(text.includes('$.process.spawn('), false, `${plugin} spawns no process itself`)
  }
})
