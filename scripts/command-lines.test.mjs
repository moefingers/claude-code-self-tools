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

const window = machine.launcherScript(T, { folder: resumeIn, claim: BY, configDirs, stateDir: state })
const restart = machine.launcherScript(T)
const scripts = [
  ["self-switch's probe: two ids, the claim, 8 config folders, a heavy-slot root", machine.probeScript({ ids: [W, T], take: T, configDirs, stateDir: state, heavySlotRoot: folder('F', 'heavy') })],
  ["self-restart's probe", machine.probeScript({ ids: [W], configDirs: [], stateDir: state })],
  ["the exit pre-check's probe (runProbe, for self-exit and self-restart)", machine.probeScript({ ids: [W], configDirs: [] })],
  ['the in-place claim check, 8 config folders', machine.claimCheckScript({ stateDir: state, id: T, by: BY, configDirs })],
  ['the release', machine.releaseScript({ stateDir: state, id: T, by: BY })],
  ["a switch's launcher, 8 config folders", window],
  ["self-restart's launcher", restart],
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
 * The window's inner script, as the launcher builds it at run time: each element of its `$inner = @(`
 * list, single-quoted ones as they are, double-quoted ones with PowerShell's expansion of the values
 * the launcher reads (each at its largest), joined with CRLF.
 */
function innerOf(script) {
  const lines = script.split('\r\n')
  const from = lines.indexOf('$inner = @(')
  const to = lines.indexOf(') -join [Environment]::NewLine')
  assert.ok(from > 0 && to > from, 'the inner script is built from a list')
  const values = {
    wait: '4294967295',
    id: T,
    by: BY,
    exe: folder('C', 'claude').slice(0, 225) + `${B}claude.exe`,
    folderText: resumeIn,
    stateText: state,
    configText: configDirs.map(d => `'${d}'`).join(', '),
  }
  return lines
    .slice(from + 1, to)
    .map(line => line.trim().replace(/,$/, ''))
    .map(element => {
      if (element.startsWith("'")) return element.slice(1, -1).split("''").join("'")
      assert.ok(element.startsWith('"'), `an element is a quoted string: ${element}`)
      return element
        .slice(1, -1)
        .replace(/`\$/g, '\u0000')
        .replace(/\$([A-Za-z]+)/g, (all, name) => (name in values ? values[name] : all))
        .replace(/\u0000/g, '$')
        .replace(/`"/g, '"')
    })
    .join('\r\n')
}

test("the window's own command line: the inner script GZip-compressed in a fixed unpacking bootstrap, under 24,000 characters", () => {
  for (const [name, script] of [["a switch's window", window], ["self-restart's window", restart]]) {
    const inner = innerOf(script)
    assert.ok(inner.includes(`$id = '${T}'`) && inner.includes(`--resume '${T}'`), `${name}: the inner script`)
    // The window is started with the unpacking bootstrap, never the inner script itself.
    assert.ok(script.includes('$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($unpack))'), name)
    const unpackLine = script.split('\r\n').find(line => line.startsWith('$unpack = "'))
    assert.ok(unpackLine !== undefined, `${name}: the unpacking bootstrap`)
    const payload = gzipSync(Buffer.from(inner, 'utf8')).toString('base64')
    const unpack = unpackLine.slice('$unpack = "'.length, -1).replace('$payload', payload)
    const encoded = Buffer.from(unpack, 'utf16le').toString('base64')
    const length = commandLine([`C:${B}Windows${B}System32${B}WindowsPowerShell${B}v1.0${B}powershell.exe`, '-NoProfile', '-EncodedCommand', encoded]).length
    assert.ok(length < LIMIT, `${name}: ${length} characters (the inner script ${inner.length})`)
    // Left on the command line as it was, it would have been far longer.
    assert.ok(Buffer.from(inner, 'utf16le').toString('base64').length > length, name)
  }
})

test("every run of a script passes it on standard input: the bootstrap never reads the engine's default stdin", () => {
  for (const plugin of ['self-switch', 'self-restart']) {
    const text = readFileSync(join(ROOT, 'plugins', plugin, 'hooks', 'register.ts'), 'utf8')
    const calls = text.split('powershellCall(').length - 1
    const runs = text.split('$.process.run(').length - 1
    const withStdin = (text.match(/\$\.process\.run\(call\.argv, \{\s*stdin: call\.stdin,/g) ?? []).length
    assert.ok(calls > 0, `${plugin} runs its scripts through powershellCall`)
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

test('self-exit and self-check start no process of their own: the probe runs through the machine code, the tools through $.tool.call', () => {
  for (const plugin of ['self-exit', 'self-check']) {
    const text = readFileSync(join(ROOT, 'plugins', plugin, 'hooks', 'register.ts'), 'utf8')
    assert.equal(text.includes('$.process.run('), false, `${plugin} runs no process itself`)
    assert.equal(text.includes('$.process.spawn('), false, `${plugin} spawns no process itself`)
  }
})
