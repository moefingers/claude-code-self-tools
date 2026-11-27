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

/** `text` with its placeholders put in: `folder` and `file`, each JSON-escaped. */
const fill = (text, folder, file) => text.split('{{FOLDER}}').join(JSON.stringify(folder).slice(1, -1)).split('{{FILE}}').join(JSON.stringify(file).slice(1, -1))

/**
 * The folder and the .ps1 file readPlacement gets, of the shape it takes on every platform. readPlacement checks a
 * folder's shape alone (it is pure; the layout script checks the folder is there), and takes only a drive-absolute
 * Windows path: on Linux the test's own temporary folder is a POSIX path, which it refuses, so a good file with a
 * folder in it would read as bad there for a reason that is no row's.
 */
const SHAPED_FOLDER = 'C:\\path\\to\\a folder'
const SHAPED_FILE = 'C:\\path\\to\\flt.ps1'

/** A fixture file's text for the layout script, which checks its folder and its script are there: the test's own. */
const textOf = file => fill(JSON.stringify(file), join(work, 'a folder'), join(work, 'flt.ps1'))

/** A fixture file's text for readPlacement: the folder and the script of the shape it takes, on every platform. */
const shapedOf = file => fill(JSON.stringify(file), SHAPED_FOLDER, SHAPED_FILE)

/** A raw fixture file's text as written, for the layout script: never rewritten through JSON.stringify. */
const rawOf = text => fill(text, join(work, 'a folder'), join(work, 'flt.ps1'))

/** A raw fixture file's text as written, for readPlacement, as shapedOf. */
const shapedRawOf = text => fill(text, SHAPED_FOLDER, SHAPED_FILE)

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

/** The PowerShell validator's verdict on a raw fixture file's text, written as it is. */
function psTakesRaw(text, script = LAYOUT, tag = 'raw') {
  const path = join(work, `${tag}-${createHash('sha256').update(rawOf(text)).digest('hex').slice(0, 16)}.json`)
  writeFileSync(path, rawOf(text))
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
    const read = machine.readPlacement(shapedOf(file))
    assert.ok('placement' in read, `${name}: ${JSON.stringify(read.errors)}`)
  }
  for (const { name, file } of fixture.bad) {
    const read = machine.readPlacement(shapedOf(file))
    assert.ok('errors' in read && read.errors.length > 0, `${name} was taken`)
  }
})

test('readPlacement takes and refuses each raw file as JSON writes it: 100.0 and 1e3 are whole numbers, 100.5, 1e400 and "100" are not', () => {
  assert.ok(fixture.raw.length >= 10 && fixture.raw.some(c => c.good) && fixture.raw.some(c => !c.good))
  const wrong = fixture.raw.filter(({ good, text }) => ('placement' in machine.readPlacement(shapedRawOf(text))) !== good).map(({ name, good }) => `${name}: ${good ? 'refused' : 'taken'}`)
  assert.deepEqual(wrong, [], 'every row, in one run')
})

test('an unknown key is refused by its name; a BOM is read past; not JSON says so', () => {
  assert.ok(machine.readPlacement(JSON.stringify({ v: 1, layout: [], extra: 1 })).errors.some(e => e.includes('unknown key extra')))
  assert.ok('placement' in machine.readPlacement(`\uFEFF${JSON.stringify({ v: 1, layout: [] })}`))
  assert.deepEqual(machine.readPlacement('{').errors, ['it is not JSON'])
})

test('the shipped presets are four windows of generic lanes, and read: claude-1 lane-a and lane-b, claude-2 lane-c, claude-3 lane-d, lane-e and lane-f, claude-4 overflow', () => {
  const read = machine.readPlacement(readFileSync(join(ROOT, 'plugins', 'self-switch', 'slot', 'placement.example.json'), 'utf8'))
  assert.ok('placement' in read, JSON.stringify(read.errors))
  const tabs = Object.fromEntries(read.placement.layout.map(w => [w.window, w.tabs]))
  assert.deepEqual(Object.keys(tabs), ['claude-1', 'claude-2', 'claude-3', 'claude-4'])
  for (const name of ['lane-a', 'lane-b']) assert.ok(tabs['claude-1'].includes(name))
  assert.ok(tabs['claude-2'].includes('lane-c'))
  for (const name of ['lane-d', 'lane-e', 'lane-f']) assert.ok(tabs['claude-3'].includes(name))
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
  // The same raw text readPlacement reads: how ConvertFrom-Json types a number (5.1 and 7 differ) changes nothing.
  for (const { name, good, text } of [...(fixture.raw ?? [])]) {
    test(`${good ? 'takes' : 'refuses'}, as written: ${name}`, () => {
      const ran = psTakesRaw(text)
      assert.equal(ran.code, good ? 0 : 2, ran.out)
      if (!good) assert.ok(!ran.out.includes('wt.exe'), 'prints no command for a bad file')
    })
  }
  test('a pos and a size written 0.0 and 1.2e2 reach wt as 0 and 120, as wtTabLine writes them', () => {
    const { text } = fixture.raw.find(c => c.name === 'a pos and a size written 0.0, 1.2e2 and 30.0')
    const ran = psTakesRaw(text, LAYOUT, 'written')
    assert.equal(ran.code, 0, ran.out)
    const line = machine.wtTabLine({ powershell: WINDOWS_POWERSHELL, stateDir: join(work, 'local', 'claude-self-tools'), window: 'a', title: 't', pos: [0, 0], size: [120, 30], folder: join(work, 'a folder'), run: { idle: true } })
    assert.ok(line.includes(' --pos 0,0 --size 120,30 nt '), line)
    assert.ok(ran.out.includes(`[a / t] wt.exe ${line}`), `${line}\nin:\n${ran.out}`)
  })
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
        const line = machine.wtTabLine({ powershell: WINDOWS_POWERSHELL, stateDir: state, window: w.window, title: tab, ...(i === 0 ? { pos: w.pos, size: w.size, maximized: w.maximized } : {}), folder, run: { idle: true } })
        assert.ok(ran.out.includes(`[${w.window} / ${tab}] wt.exe ${line}`), `${line}\nin:\n${ran.out}`)
      })
    }
    assert.match(ran.out, /--pos 0,0 --size 160,42 nt/)
    assert.equal(ran.out.match(/--pos/g).length, 2, 'one per window')
    // The slot runner isn't in the temporary folder: it says so, and -Apply would refuse.
    assert.match(ran.out, /note: the slot runner is not at /)
  })

  test('a maximized window (#5): -M on its first tab only, before --pos, by the same string the machine code builds', () => {
    const file = fixture.good.find(c => c.name === 'a maximized layout window and a maximized named window').file
    const path = join(work, 'maximized.json')
    writeFileSync(path, textOf(file))
    const ran = runLayout(['-Placement', path])
    assert.equal(ran.code, 0, ran.out)
    const state = join(work, 'local', 'claude-self-tools')
    const line = machine.wtTabLine({ powershell: WINDOWS_POWERSHELL, stateDir: state, window: 'w1', title: 't', pos: [2100, 300], maximized: true, folder: join(work, 'a folder'), run: { idle: true } })
    assert.ok(line.startsWith('-w w1 -M --pos 2100,300 nt '), line)
    assert.ok(ran.out.includes(`[w1 / t] wt.exe ${line}`), `${line}\nin:\n${ran.out}`)
  })

  test('no placement.json: it says where the presets are, and runs nothing', () => {
    const ran = runLayout([])
    assert.equal(ran.code, 2, ran.out)
    assert.match(ran.out, /there is no .*placement\.json: copy placement\.example\.json there/)
  })
})

/**
 * The module path line claude-slot.ps1 and claude-layout.ps1 keep this release, as at 5b4f138 (the layout
 * script's pin moved for #5's keys; its module path line did not): one path made of three, harmless in Windows
 * PowerShell 5.1, which loads its core modules from $PSHOME whatever the path. PSMODULEPATH_RESET is the fixed
 * line; these two take it in a release that re-vendors the coordinator.
 */
const KEPT_RESET = '$env:PSModulePath = @([Environment]::GetFolderPath("MyDocuments") + "\\WindowsPowerShell\\Modules", [Environment]::GetFolderPath("ProgramFiles") + "\\WindowsPowerShell\\Modules", [Environment]::GetFolderPath("System") + "\\WindowsPowerShell\\v1.0\\Modules") -join ";"'

/** What the layout script must be, as text: each problem found. A fault planted in a copy must show up here. */
function layoutProblems(text) {
  const problems = []
  const need = (ok, what) => {
    if (!ok) problems.push(what)
  }
  const code = text.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')
  const reset = code.indexOf(KEPT_RESET)
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
  // #91: the grid is checked, and nothing is opened from it: the one loop that builds commands reads layout[] alone.
  need(code.includes("Test-Has $doc 'grid'") && !/foreach \(\$\w+ in \$doc\.grid/.test(code) && (code.match(/\$commands\.Add\(/g) ?? []).length === 1, 'the grid checked, never opened')
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
    const { text } = copyWith('reset', KEPT_RESET, '')
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
    assert.ok('errors' in machine.readPlacement(shapedOf(lastCase.file)), 'readPlacement still refuses it')
  })

  test("#5: a named window's rect accepted by the PowerShell validator alone: the two then disagree on the shared list", () => {
    const { path } = copyWith('rect', "if (Test-Has $value 'rect') { Add-Fault ($where + ' has a rect, which", "if ($false) { Add-Fault ($where + ' has a rect, which")
    const rectCase = fixture.bad.find(c => c.name === 'a rect on a named window')
    assert.equal(psTakes(rectCase.file, path, 'fault').code, 0, 'the copy takes it')
    assert.ok('errors' in machine.readPlacement(shapedOf(rectCase.file)), 'readPlacement still refuses it')
  })

  test('#91: a session named in two grid windows accepted by the PowerShell validator alone: the two then disagree on the shared list', () => {
    const { path } = copyWith('grid-twice', 'elseif ($gridSessions.ContainsKey($t)) { Add-Fault', 'elseif ($false) { Add-Fault')
    const twice = fixture.bad.find(c => c.name === 'a session named in two grid windows')
    assert.equal(psTakes(twice.file, path, 'fault').code, 0, 'the copy takes it')
    assert.ok('errors' in machine.readPlacement(shapedOf(twice.file)), 'readPlacement still refuses it')
  })

  test('#91: a grid window with both a rect and maximized accepted by the PowerShell validator alone: the two then disagree', () => {
    const { path } = copyWith('grid-both', "if ((Test-Has $w 'rect') -and (Test-Has $w 'maximized')) { Add-Fault", "if ($false) { Add-Fault")
    const both = fixture.bad.find(c => c.name === 'a grid window with both a rect and maximized')
    assert.equal(psTakes(both.file, path, 'fault').code, 0, 'the copy takes it')
    assert.ok('errors' in machine.readPlacement(shapedOf(both.file)), 'readPlacement still refuses it')
  })

  test('#5: a key given as null read as absent again by the PowerShell validator: the two then disagree', () => {
    const { path } = copyWith('null', 'function Test-Has($value, $name) { return ($null -ne $value.PSObject.Properties[$name]) }', 'function Test-Has($value, $name) { return ($null -ne $value.$name) }')
    const nullCase = fixture.bad.find(c => c.name === 'a pos of null')
    assert.equal(psTakes(nullCase.file, path, 'fault').code, 0, 'the copy takes it')
    assert.ok('errors' in machine.readPlacement(shapedOf(nullCase.file)), 'readPlacement still refuses it')
  })

  test('#5: a whole number read by its type again (Int32 and Int64 alone): 100.0 and 1e3 refused by the copy, taken by readPlacement', () => {
    const { path } = copyWith('whole', "@('System.Int32', 'System.Int64', 'System.Decimal', 'System.Double', 'System.Numerics.BigInteger') -cnotcontains", "@('System.Int32', 'System.Int64') -cnotcontains")
    const { text } = fixture.raw.find(c => c.name === 'a rect written with a zero fraction and with exponents')
    assert.equal(psTakesRaw(text, path, 'fault').code, 2, 'the copy refuses it')
    assert.ok('placement' in machine.readPlacement(shapedRawOf(text)), 'readPlacement takes it')
  })

  test('#5: a whole number read as a fraction (no floor): 100.5 taken by the copy, refused by readPlacement', () => {
    const { path } = copyWith('floor', ' -and [math]::Floor($number) -eq $number', '')
    const { text } = fixture.raw.find(c => c.name === 'a rect with a half')
    assert.equal(psTakesRaw(text, path, 'fault').code, 0, 'the copy takes it')
    assert.ok('errors' in machine.readPlacement(shapedRawOf(text)), 'readPlacement refuses it')
  })

  test('#5: a pos written 0.0 handed to wt as written: its line no longer the machine code\'s', () => {
    const { path } = copyWith('format', "('{0},{1}' -f [long][double]$w.pos[0], [long][double]$w.pos[1])", "('{0},{1}' -f $w.pos[0], $w.pos[1])")
    const { text } = fixture.raw.find(c => c.name === 'a pos and a size written 0.0, 1.2e2 and 30.0')
    const ran = psTakesRaw(text, path, 'fault')
    assert.equal(ran.code, 0, ran.out)
    assert.ok(!ran.out.includes(' --pos 0,0 '), `the copy writes the number as JSON gave it:\n${ran.out}`)
  })

  test("#5: -M left off a maximized window's first tab: its line no longer the machine code's", () => {
    const { path } = copyWith('max', "    if ($first -and $w.maximized -eq $true) { $elements += @('-M') }\n", '')
    const file = fixture.good.find(c => c.name === 'a maximized layout window and a maximized named window').file
    const placementFile = join(work, 'maximized-fault.json')
    writeFileSync(placementFile, textOf(file))
    const ran = runLayout(['-Placement', placementFile], path)
    assert.equal(ran.code, 0, ran.out)
    assert.ok(!ran.out.includes(' -M '), 'the copy prints no -M')
    assert.ok(machine.wtTabLine({ powershell: WINDOWS_POWERSHELL, stateDir: join(work, 'local', 'claude-self-tools'), window: 'w1', title: 't', pos: [2100, 300], maximized: true, folder: join(work, 'a folder'), run: { idle: true } }).includes(' -M '), 'the machine code builds one')
  })

  test('`last` accepted by readPlacement alone: the two then disagree on the shared list', async () => {
    const text = readFileSync(MACHINE, 'utf8')
    const faulty = text.split('!/^(?:new|last|_quake)$/i.test(name)').join('!/^(?:new|_quake)$/i.test(name)')
    assert.notEqual(faulty, text)
    const path = join(work, 'machine-last.ts')
    writeFileSync(path, faulty)
    const copy = await import(pathToFileURL(path).href)
    const lastCase = fixture.bad.find(c => c.name === 'a window called last')
    assert.ok('placement' in copy.readPlacement(shapedOf(lastCase.file)), 'the copy takes it')
    assert.equal(psTakes(lastCase.file).code, 2, 'the validator still refuses it')
  })
})
