// placement.json: readPlacement (shared/hooks/machine.ts) and the layout script's PowerShell validator
// (plugins/self-switch/slot/claude-layout.ps1) pass the same shared list of good and bad files
// (scripts/placement-fixture.json); the layout script as text and, -WhatIf only, run for real in a
// temporary folder: it prints each wt string and runs none. It is never run with -Apply here: wt.exe is
// never started by any test. Planted faults are made in a copy, each caught. Run with
// `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { fence, WINDOWS_POWERSHELL } from './stub.mjs'
import { ROOT } from './sync-shared.mjs'

const MACHINE = join(ROOT, 'shared', 'hooks', 'machine.ts')
const machine = await import(pathToFileURL(MACHINE).href)
const LAYOUT = join(ROOT, 'plugins', 'self-switch', 'slot', 'claude-layout.ps1')
const layoutBytes = readFileSync(LAYOUT)
const layout = layoutBytes.toString('utf8')
const fixture = JSON.parse(readFileSync(join(ROOT, 'scripts', 'placement-fixture.json'), 'utf8'))
const isWindows = process.platform === 'win32'

let work

before(() => {
  work = mkdtempSync(join(tmpdir(), 'placement-'))
  mkdirSync(join(work, 'a folder'), { recursive: true })
  writeFileSync(join(work, 'flt.ps1'), '# nothing\n')
})
after(() => rmSync(work, { recursive: true, force: true }))

/** A fixture file's text, its placeholders the test's own folder and script. */
const textOf = file =>
  JSON.stringify(file)
    .split('{{FOLDER}}')
    .join(JSON.stringify(join(work, 'a folder')).slice(1, -1))
    .split('{{FILE}}')
    .join(JSON.stringify(join(work, 'flt.ps1')).slice(1, -1))

/** The layout script, -WhatIf or as given: hidden, in the temporary folder. Never -Apply. */
function runLayout(args, script = LAYOUT) {
  assert.ok(!args.includes('-Apply'), 'no test runs the layout script with -Apply')
  const home = join(work, 'home')
  const local = join(work, 'local')
  mkdirSync(join(local, 'claude-self-tools'), { recursive: true })
  const env = { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', USERPROFILE: home, LOCALAPPDATA: local, PATH: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), NO_COLOR: '1' }
  fence(env, work)
  const run = spawnSync(WINDOWS_POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { env, encoding: 'utf8', windowsHide: true })
  return { code: run.status, out: `${run.stdout}${run.stderr}` }
}

/** The PowerShell validator's verdict on a fixture file: whether -WhatIf took it. */
function psTakes(file, script = LAYOUT, tag = 'case') {
  const path = join(work, `${tag}-${createHash('sha256').update(textOf(file)).digest('hex').slice(0, 16)}.json`)
  writeFileSync(path, textOf(file))
  return runLayout(['-WhatIf', '-Placement', path], script)
}

test('the layout script is pinned by a release hash, ASCII with LF line ends; nothing checks it at run time', () => {
  assert.equal(createHash('sha256').update(layoutBytes).digest('hex'), machine.LAYOUT_SCRIPT_SHA256)
  assert.ok(layoutBytes.every(b => b < 128))
  assert.ok(!layoutBytes.includes(13))
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  assert.ok(readme.includes(machine.LAYOUT_SCRIPT_SHA256), 'the README prints it for the person to compare')
  assert.ok(layout.includes(`$SlotSha = '${machine.SLOT_SCRIPT_SHA256}'`))
})

test('readPlacement takes each good file and refuses each bad one', () => {
  for (const { name, file } of fixture.good) {
    const read = machine.readPlacement(textOf(file))
    assert.ok('placement' in read, `${name}: ${JSON.stringify(read.errors)}`)
  }
  for (const { name, file } of fixture.bad) {
    const read = machine.readPlacement(textOf(file))
    assert.ok('errors' in read && read.errors.length > 0, `${name} was taken`)
  }
})

test('an unknown key is refused by its name; a BOM is read past; not JSON says so', () => {
  assert.ok(machine.readPlacement(JSON.stringify({ v: 1, layout: [], extra: 1 })).errors.some(e => e.includes('unknown key extra')))
  assert.ok('placement' in machine.readPlacement(`\uFEFF${JSON.stringify({ v: 1, layout: [] })}`))
  assert.deepEqual(machine.readPlacement('{').errors, ['it is not JSON'])
})

test("the shipped presets are this machine's four windows, and read: claude-1 agent-coordinator-3000 and system-overhaul, claude-2 video-lab, claude-3 olivia-work, ui-general and package-bumper, claude-4 overflow", () => {
  const read = machine.readPlacement(readFileSync(join(ROOT, 'plugins', 'self-switch', 'slot', 'placement.example.json'), 'utf8'))
  assert.ok('placement' in read, JSON.stringify(read.errors))
  const tabs = Object.fromEntries(read.placement.layout.map(w => [w.window, w.tabs]))
  assert.deepEqual(Object.keys(tabs), ['claude-1', 'claude-2', 'claude-3', 'claude-4'])
  for (const name of ['agent-coordinator-3000', 'system-overhaul']) assert.ok(tabs['claude-1'].includes(name))
  assert.ok(tabs['claude-2'].includes('video-lab'))
  for (const name of ['olivia-work', 'ui-general', 'package-bumper']) assert.ok(tabs['claude-3'].includes(name))
  assert.equal(read.placement.launch.tab.window, 'claude-4')
  assert.equal(read.placement.restart.tab.window, 'same')
})

describe('the validator in PowerShell', { skip: !isWindows && 'Windows only', concurrency: 4 }, () => {
  for (const { name, file } of [...(fixture.good ?? [])]) {
    test(`takes: ${name}`, () => {
      const ran = psTakes(file)
      assert.equal(ran.code, 0, ran.out)
    })
  }
  for (const { name, file } of [...(fixture.bad ?? [])]) {
    test(`refuses: ${name}`, () => {
      const ran = psTakes(file)
      assert.equal(ran.code, 2, ran.out)
      assert.match(ran.out, /Nothing was run\./)
      assert.ok(!ran.out.includes('wt.exe'), 'prints no command for a bad file')
    })
  }
})

describe('-WhatIf, the default, for the design\'s example', { skip: !isWindows && 'Windows only' }, () => {
  test('it prints every tab, by the same string the machine code builds, and runs none: each -Idle, the position on the first tab only', () => {
    const file = fixture.good[0].file
    const path = join(work, 'example.json')
    writeFileSync(path, textOf(file))
    const ran = runLayout(['-Placement', path])
    assert.equal(ran.code, 0, ran.out)
    assert.match(ran.out, /-WhatIf, the default: 6 tabs/)
    const state = join(work, 'local', 'claude-self-tools')
    const folder = join(work, 'a folder')
    const placement = machine.readPlacement(textOf(file)).placement
    for (const w of placement.layout) {
      w.tabs.forEach((tab, i) => {
        const line = machine.wtTabLine({ powershell: WINDOWS_POWERSHELL, stateDir: state, window: w.window, title: tab, ...(i === 0 ? { pos: w.pos, size: w.size } : {}), folder, run: { idle: true } })
        assert.ok(ran.out.includes(`[${w.window} / ${tab}] wt.exe ${line}`), `${line}\nin:\n${ran.out}`)
      })
    }
    assert.match(ran.out, /--pos 0,0 --size 160,42 nt/)
    assert.equal(ran.out.match(/--pos/g).length, 2, 'one per window')
    // The slot runner isn't in the temporary folder: it says so, and -Apply would refuse.
    assert.match(ran.out, /note: the slot runner is not at /)
  })

  test('no placement.json: it says where the presets are, and runs nothing', () => {
    const ran = runLayout([])
    assert.equal(ran.code, 2, ran.out)
    assert.match(ran.out, /there is no .*placement\.json: copy placement\.example\.json there/)
  })
})

/** What the layout script must be, as text: each problem found. A fault planted in a copy must show up here. */
function layoutProblems(text) {
  const problems = []
  const need = (ok, what) => {
    if (!ok) problems.push(what)
  }
  const code = text.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')
  const reset = code.indexOf(machine.PSMODULEPATH_RESET)
  need(reset > 0 && reset < code.indexOf('Get-AppxPackage'), 'PSModulePath is reset before Windows Terminal\'s version is read')
  const gate = code.indexOf('if (-not $Apply) {')
  const launch = code.indexOf('Start-Process $wtExe -ArgumentList $c.line')
  need(gate > 0 && launch > gate, 'nothing runs before the -Apply gate')
  need(/if \(-not \$Apply\) \{[\s\S]*?\n  exit 0\n\}/.test(code), 'without -Apply it exits having run nothing')
  need((code.match(/Start-Process/g) ?? []).length === 1, 'one Start-Process')
  need(!/&\s*['"]?wt(\.exe)?/.test(code), 'wt is never &-called')
  need(code.includes(`$Clear = ${machine.LAUNCH_ENV_CLEAR.map(name => `'${name}'`).join(', ')}\n`), 'it clears the launch environment\'s list in its own process')
  need(!code.includes('WT_SESSION') && !code.includes('WT_PROFILE_ID'), 'WT_SESSION and WT_PROFILE_ID untouched')
  need(code.includes("[version]'1.19'"), 'Windows Terminal 1.19 or later for -Apply')
  need(code.includes("Join-Path $state 'claude-slot.ps1'"), 'the slot script from its one place')
  const hash = code.indexOf('if ((Get-Sha256 $slotScript) -cne $SlotSha) { Stop-Layout')
  need(hash > gate && hash < launch, 'its hash checked before anything opens')
  need(!code.includes('Get-FileHash'), 'no Get-FileHash')
  need(code.includes('Start-Sleep -Seconds 2'), '2 seconds between calls')
  need(code.includes("'-Idle')"), 'every tab -Idle')
  need(!/\bclaude\.exe\b/.test(code.replace(/\$p\.Name/g, '')), 'it never starts claude')
  need(!/\bbash\b|\bmsys\b/i.test(code), 'no bash')
  return problems
}

test('wtArgument and the layout script refuse the same elements, and the layout checks every path it hands wt (N6); wt by its full path (N2)', () => {
  const code = readFileSync(join(ROOT, 'plugins', 'self-switch', 'slot', 'claude-layout.ps1'), 'utf8')
  assert.ok(code.includes("if ($element -eq '' -or $element.Contains('\"') -or $element.Contains(';') -or $element.Contains('%')) {"))
  for (const bad of ['', 'a"b', 'a;b', 'a%b']) assert.throws(() => machine.wtArgument(bad), bad)
  assert.ok(code.includes('if (-not (Test-WtFolder $powershell)) {'))
  assert.ok(code.includes("$wtExe = Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps\\wt.exe'"))
  assert.ok(code.includes('if (-not (Test-Path -LiteralPath $wtExe -PathType Leaf)) { Stop-Layout'))
  assert.ok(!code.split('\n').some(line => !line.trimStart().startsWith('#') && /Start-Process wt/.test(line)))
})

test('the layout script, as text: -WhatIf by default, wt by Start-Process with one string, the slot script pinned and hash-checked first', () => {
  assert.deepEqual(layoutProblems(layout), [])
})

describe('planted faults in the layout script and the validators, each caught', { skip: !isWindows && 'Windows only' }, () => {
  /** A copy of the layout script with `from` replaced by `to`. */
  const copyWith = (name, from, to) => {
    const text = layout.split(from).join(to)
    assert.notEqual(text, layout, `the fault ${name} changed nothing`)
    const path = join(work, `layout-${name}.ps1`)
    writeFileSync(path, text)
    return { path, text }
  }

  test('running without -Apply', () => {
    const { text } = copyWith('apply', 'if (-not $Apply) {', 'if ($false) {')
    assert.ok(layoutProblems(text).some(p => p.includes('-Apply')))
  })

  test('the PSModulePath reset removed', () => {
    const { text } = copyWith('reset', machine.PSMODULEPATH_RESET, '')
    assert.ok(layoutProblems(text).some(p => p.includes('PSModulePath')))
  })

  test('the slot script\'s hash check removed', () => {
    const { text } = copyWith('hash', "if ((Get-Sha256 $slotScript) -cne $SlotSha) { Stop-Layout", "if ($false) { Stop-Layout")
    assert.ok(layoutProblems(text).some(p => p.includes('hash')))
  })

  test('`last` accepted by the PowerShell validator alone: the two then disagree on the shared list', () => {
    const { path } = copyWith('last', "$name -notmatch '^(new|last|_quake)\\z'", "$name -notmatch '^(new|_quake)\\z'")
    const lastCase = fixture.bad.find(c => c.name === 'a window called last')
    assert.equal(psTakes(lastCase.file, path, 'fault').code, 0, 'the copy takes it')
    assert.ok('errors' in machine.readPlacement(textOf(lastCase.file)), 'readPlacement still refuses it')
  })

  test('`last` accepted by readPlacement alone: the two then disagree on the shared list', async () => {
    const text = readFileSync(MACHINE, 'utf8')
    const faulty = text.split('!/^(?:new|last|_quake)$/i.test(name)').join('!/^(?:new|_quake)$/i.test(name)')
    assert.notEqual(faulty, text)
    const path = join(work, 'machine-last.ts')
    writeFileSync(path, faulty)
    const copy = await import(pathToFileURL(path).href)
    const lastCase = fixture.bad.find(c => c.name === 'a window called last')
    assert.ok('placement' in copy.readPlacement(textOf(lastCase.file)), 'the copy takes it')
    assert.equal(psTakes(lastCase.file).code, 2, 'the validator still refuses it')
  })
})
