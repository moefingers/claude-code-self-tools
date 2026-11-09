// The left record's two scripts, run for real on Windows against temporary folders only: leftScript
// writes a record under a key it finds in place (a canary, built here at run time) and never replaces
// that key (LR14); leftReadScript checks the record's MAC inside the script and says only whether it
// matched; a record changed on disk no longer matches (LR1); and the canary never reaches any output,
// the record or an error (LR13). leftScript finds the claude.exe it runs under by walking up its
// parents: it runs here under the stub claude.exe (scripts/stub.mjs), as under Claude Code, so it finds
// one in every run, and nothing is skipped. Run with `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { compileStub, underStub, stubWork, withoutClaude } from './stub.mjs'
import { ROOT } from './sync-shared.mjs'

const machine = await import(pathToFileURL(join(ROOT, 'shared', 'hooks', 'machine.ts')).href)
const isWindows = process.platform === 'win32'
const POWERSHELL = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

let work
let stub

before(() => {
  if (!isWindows) return
  work = stubWork('left-record-test-')
  stub = compileStub(work)
})

after(() => {
  if (work !== undefined) rmSync(work, { recursive: true, force: true })
})

/** One script run as the plugins run it: powershellCall, the script on standard input. Output and errors both kept. */
function run(script) {
  const call = machine.powershellCall(POWERSHELL, script)
  return new Promise(resolve => {
    const child = spawn(call.argv[0], call.argv.slice(1), { windowsHide: true, env: withoutClaude({ ...process.env, LOCALAPPDATA: join(work, 'local'), USERPROFILE: join(work, 'home') }) })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    const timer = setTimeout(() => child.kill(), 60_000)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(call.stdin)
  })
}

/** leftScript run as self-switch runs it, under its session's claude.exe: here the stub's. Output and errors both kept. */
async function write(script) {
  const ran = await underStub({ stub, work, env: withoutClaude({ ...process.env, LOCALAPPDATA: join(work, 'local'), USERPROFILE: join(work, 'home') }), script })
  assert.ok(!ran.stdout.includes('refused session'), 'the stub is the claude.exe above the script')
  return { code: 0, stdout: ran.stdout, stderr: ran.stderr }
}

/** A state folder, a config folder with conversation `id`'s transcript, and the canary key in place. */
function lab() {
  const root = mkdtempSync(join(work, 'run-'))
  const state = join(root, 'state')
  const config = join(root, 'config')
  const id = randomUUID()
  const project = machine.projectName(join(root, 'work'))
  mkdirSync(join(config, 'projects', project), { recursive: true })
  writeFileSync(join(config, 'projects', project, `${id}.jsonl`), '{"type":"user"}\n')
  mkdirSync(state, { recursive: true })
  // The canary: 32 random bytes, made now, so no test file ever holds a key.
  const key = randomBytes(32)
  writeFileSync(join(state, 'left.key'), key)
  return { root, state, config, id, project, key }
}

/** Every way the canary could be written out: hex either case, base64, the bytes as decimals. */
const canaryForms = key => [key.toString('hex'), key.toString('hex').toUpperCase(), key.toString('base64'), [...key].join(' '), [...key].join(','), [...key].map(b => b.toString(16).padStart(2, '0')).join('-').toUpperCase()]

describe('the left record, written and read for real', { skip: !isWindows && 'Windows only', concurrency: false }, () => {
  test('written under the key in place, which it never replaces (LR14); read back with its MAC matched; the key nowhere in any output (LR13)', async () => {
    const dirs = lab()
    const written = await write(machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'exit', configDirs: [dirs.config], by: 'self-switch' }))
    assert.equal(written.code, 0, written.stderr)
    assert.equal(machine.LEFT_WRITTEN.exec(written.stdout)?.[1], dirs.id, written.stdout)
    // The key is the canary still: CreateNew found it there and left it.
    assert.deepEqual(readFileSync(join(dirs.state, 'left.key')), dirs.key)
    const recordText = readFileSync(join(dirs.state, 'left', `${dirs.id}.json`), 'utf8')
    const record = JSON.parse(recordText)
    assert.equal(record.v, 1)
    assert.equal(record.id, dirs.id)
    assert.equal(record.how, 'exit')
    assert.equal(record.by, 'self-switch')
    assert.equal(record.transcript.dir, dirs.config)
    assert.equal(record.transcript.project, dirs.project)
    assert.equal(record.transcript.size, String('{"type":"user"}\n'.length))
    assert.match(record.mac, /^[0-9a-f]{64}$/)

    const read = await run(machine.leftReadScript({ stateDir: dirs.state, ids: [dirs.id], configDirs: [dirs.config] }))
    assert.equal(read.code, 0, read.stderr)
    const parsed = machine.parseLeftRead(read.stdout)
    assert.ok(!('error' in parsed), JSON.stringify(parsed))
    assert.equal(parsed.unreadable, false)
    assert.equal(parsed.left.length, 1)
    const [entry] = parsed.left
    assert.equal(entry.ok, true)
    assert.equal(entry.macOk, true)
    assert.equal(entry.id, dirs.id)
    assert.equal(entry.transcript.dir, 0)
    assert.equal(entry.transcript.size, '{"type":"user"}\n'.length)

    for (const form of canaryForms(dirs.key)) {
      for (const [name, text] of [['the writer\'s output', written.stdout + written.stderr], ['the reader\'s output', read.stdout + read.stderr], ['the record', recordText]]) {
        assert.ok(!text.includes(form), `the canary key reached ${name}`)
      }
    }

    // A second record: the key stays the canary (LR14, a second creation never replaces it).
    const again = await write(machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'in-place', configDirs: [dirs.config], by: 'self-switch' }))
    assert.equal(again.code, 0, again.stderr)
    assert.deepEqual(readFileSync(join(dirs.state, 'left.key')), dirs.key)
  })

  test('a record changed on disk no longer matches its MAC (LR1); one under another key neither; no key at all: none matches', async () => {
    const dirs = lab()
    const written = await write(machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'exit', configDirs: [dirs.config], by: 'self-switch' }))
    const path = join(dirs.state, 'left', `${dirs.id}.json`)
    const record = JSON.parse(readFileSync(path, 'utf8'))
    const readOne = async () => {
      const read = await run(machine.leftReadScript({ stateDir: dirs.state, ids: [dirs.id], configDirs: [dirs.config] }))
      const parsed = machine.parseLeftRead(read.stdout)
      assert.ok(!('error' in parsed), JSON.stringify(parsed))
      return parsed.left[0]
    }
    // Its transcript's size made larger: the MAC no longer matches.
    writeFileSync(path, JSON.stringify({ ...record, transcript: { ...record.transcript, size: String(Number(record.transcript.size) + 1) } }))
    assert.equal((await readOne()).macOk, false)
    // Back as written: it matches again.
    writeFileSync(path, JSON.stringify(record))
    assert.equal((await readOne()).macOk, true)
    // Another key in place: it doesn't.
    writeFileSync(join(dirs.state, 'left.key'), randomBytes(32))
    assert.equal((await readOne()).macOk, false)
    // A key of another length: no key, nothing matches.
    writeFileSync(join(dirs.state, 'left.key'), randomBytes(16))
    assert.equal((await readOne()).macOk, false)
    // A record not of its shape: reported as such, no field of it.
    writeFileSync(path, JSON.stringify({ ...record, how: 'gone' }))
    assert.deepEqual(await readOne(), { asked: dirs.id, ok: false })
  })

  test('no transcript of it, or two: nothing written', async () => {
    const dirs = lab()
    const second = join(dirs.root, 'config2')
    mkdirSync(join(second, 'projects', 'C--elsewhere'), { recursive: true })
    writeFileSync(join(second, 'projects', 'C--elsewhere', `${dirs.id}.jsonl`), '')
    const two = await write(machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'exit', configDirs: [dirs.config, second], by: 'self-switch' }))
    assert.match(two.stdout, /refused transcript 2 transcripts of it are on this machine, not one/)
    assert.ok(!existsSync(join(dirs.state, 'left', `${dirs.id}.json`)))
    const none = await write(machine.leftScript({ stateDir: dirs.state, id: randomUUID(), how: 'exit', configDirs: [dirs.config], by: 'self-switch' }))
    assert.match(none.stdout, /refused transcript 0 transcripts/)
  })

  test('no key yet: one is made, 32 bytes, whole under another name and moved in; nothing else left (S1-11)', async () => {
    const dirs = lab()
    rmSync(join(dirs.state, 'left.key'))
    const written = await write(machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'exit', configDirs: [dirs.config], by: 'self-switch' }))
    assert.equal(machine.LEFT_WRITTEN.exec(written.stdout)?.[1], dirs.id, written.stdout + written.stderr)
    assert.equal(readFileSync(join(dirs.state, 'left.key')).length, 32)
    assert.deepEqual(readdirSync(dirs.state).filter(name => name.endsWith('.tmp')), [])
  })

  test('a key cut short when it was made: refused, saying to delete it, and never replaced (S1-11)', async () => {
    const dirs = lab()
    writeFileSync(join(dirs.state, 'left.key'), randomBytes(16))
    const written = await write(machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'exit', configDirs: [dirs.config], by: 'self-switch' }))
    assert.match(written.stdout, /refused key the left key \(.+left\.key\) can not be read as 32 bytes: .+delete it, and the next record makes a new one/)
    assert.equal(readFileSync(join(dirs.state, 'left.key')).length, 16)
    assert.ok(!existsSync(join(dirs.state, 'left', `${dirs.id}.json`)))
  })
})

describe('#81: two writers of one move, the coordinator and self-switch', { skip: !isWindows && 'Windows only', concurrency: false }, () => {
  /** Both scripts run one after the other, or at once, each in its own Windows PowerShell under the one stub claude.exe: one process left the conversation. */
  async function both(dirs, first, second, together, between = '') {
    const a = join(dirs.root, 'first.ps1')
    const b = join(dirs.root, 'second.ps1')
    writeFileSync(a, first)
    writeFileSync(b, second)
    const ps = POWERSHELL
    const start = file => `Start-Ps '${file}'`
    const begin = [
      "$ProgressPreference = 'SilentlyContinue'",
      `function Start-Ps($file) { $i = New-Object Diagnostics.ProcessStartInfo('${ps}', ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $file + '"')); $i.UseShellExecute = $false; $i.CreateNoWindow = $true; $i.RedirectStandardOutput = $true; $i.RedirectStandardError = $true; return [Diagnostics.Process]::Start($i) }`,
    ]
    const script = together
      ? [...begin, `$pa = ${start(a)}`, `$pb = ${start(b)}`, between, '$oa = $pa.StandardOutput.ReadToEnd(); $ea = $pa.StandardError.ReadToEnd(); $pa.WaitForExit()', '$ob = $pb.StandardOutput.ReadToEnd(); $eb = $pb.StandardError.ReadToEnd(); $pb.WaitForExit()', '"A:" + $pa.ExitCode + ":" + $oa.Trim() + ":" + ([regex]::Matches($ea, "S=.Error.")).Count', '"B:" + $pb.ExitCode + ":" + $ob.Trim() + ":" + ([regex]::Matches($eb, "S=.Error.")).Count'].join('\r\n')
      : [...begin, `$pa = ${start(a)}`, '$oa = $pa.StandardOutput.ReadToEnd(); $ea = $pa.StandardError.ReadToEnd(); $pa.WaitForExit()', between, `$pb = ${start(b)}`, '$ob = $pb.StandardOutput.ReadToEnd(); $eb = $pb.StandardError.ReadToEnd(); $pb.WaitForExit()', '"A:" + $pa.ExitCode + ":" + $oa.Trim() + ":" + ([regex]::Matches($ea, "S=.Error.")).Count', '"B:" + $pb.ExitCode + ":" + $ob.Trim() + ":" + ([regex]::Matches($eb, "S=.Error.")).Count'].join('\r\n')
    const ran = await write(script)
    const line = tag => ran.stdout.split(/\r?\n/).find(l => l.startsWith(`${tag}:`)) ?? ''
    return { a: line('A'), b: line('B'), all: ran.stdout + ran.stderr }
  }
  const GO = 'wu_abc123'

  test("the coordinator's record first, then self-switch's for the same move: both say written, and the coordinator's stands, its go kept", async () => {
    const dirs = lab()
    const coordinator = machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'in-place', configDirs: [dirs.config], by: 'coordinator', go: GO })
    const selfSwitch = machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'in-place', configDirs: [dirs.config], by: 'self-switch' })
    const ran = await both(dirs, coordinator, selfSwitch, false)
    assert.equal(ran.a, `A:0:left ${dirs.id}:0`, ran.all)
    assert.equal(ran.b, `B:0:left ${dirs.id}:0`, ran.all)
    const record = JSON.parse(readFileSync(join(dirs.state, 'left', `${dirs.id}.json`), 'utf8'))
    assert.equal(record.by, 'coordinator')
    assert.equal(record.go, GO)
  })

  /**
   * Both scripts held at one gate right after their first look (no record there yet for either), then let go at once,
   * so their writes really race: the move of one fails on the file the other just made.
   */
  const gated = (script, gate, ready) => {
    const at = script.indexOf('\r\n$leftLockPath = ')
    assert.ok(at > 0, 'before the lock: both race for it')
    const hold = [`New-Item -ItemType File -Path '${ready}' -Force | Out-Null`, `$gate = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, '${gate}')`, '[void]$gate.WaitOne(60000)'].join('\r\n')
    return `${script.slice(0, at)}\r\n${hold}${script.slice(at)}`
  }

  for (let rep = 1; rep <= 3; rep += 1) {
    test(`R8: both at once, their writes racing (${rep} of 3): each says written, nothing on its error stream, and the coordinator's record stands, its go kept and its MAC good`, async () => {
      const dirs = lab()
      const gate = `left-race-${randomUUID()}`
      const readyA = join(dirs.root, 'ready-a')
      const readyB = join(dirs.root, 'ready-b')
      const coordinator = gated(machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'in-place', configDirs: [dirs.config], by: 'coordinator', go: GO }), gate, readyA)
      const selfSwitch = gated(machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'in-place', configDirs: [dirs.config], by: 'self-switch' }), gate, readyB)
      const open = [`$gate = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, '${gate}')`, `$until = (Get-Date).AddSeconds(60); while (-not ((Test-Path '${readyA}') -and (Test-Path '${readyB}')) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 20 }`, '[void]$gate.Set()'].join('\r\n')
      const ran = await both(dirs, coordinator, selfSwitch, true, open)
      assert.equal(ran.a, `A:0:left ${dirs.id}:0`, ran.all)
      assert.equal(ran.b, `B:0:left ${dirs.id}:0`, ran.all)
      const record = JSON.parse(readFileSync(join(dirs.state, 'left', `${dirs.id}.json`), 'utf8'))
      assert.equal(record.by, 'coordinator', ran.all)
      assert.equal(record.go, GO)
      const read = await run(machine.leftReadScript({ stateDir: dirs.state, ids: [dirs.id], configDirs: [dirs.config] }))
      const parsed = machine.parseLeftRead(read.stdout)
      assert.ok(!('error' in parsed) && parsed.left.length === 1 && parsed.left[0].ok === true && parsed.left[0].macOk === true, read.stdout)
    })
  }

  for (let rep = 1; rep <= 3; rep += 1) {
    test(`R1 (delta): an earlier record already in place, both writers racing (${rep} of 3): one at a time, and the coordinator's go stands`, async () => {
      const dirs = lab()
      // The usual case: a record of an earlier move of this conversation, by another process.
      const stale = await write(machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'exit', configDirs: [dirs.config], by: 'self-switch' }))
      assert.equal(machine.LEFT_WRITTEN.exec(stale.stdout)?.[1], dirs.id, stale.stdout + stale.stderr)
      const gate = `left-race-${randomUUID()}`
      const readyA = join(dirs.root, 'ready-a')
      const readyB = join(dirs.root, 'ready-b')
      const coordinator = gated(machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'in-place', configDirs: [dirs.config], by: 'coordinator', go: GO }), gate, readyA)
      const selfSwitch = gated(machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'in-place', configDirs: [dirs.config], by: 'self-switch' }), gate, readyB)
      const open = [`$gate = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, '${gate}')`, `$until = (Get-Date).AddSeconds(60); while (-not ((Test-Path '${readyA}') -and (Test-Path '${readyB}')) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 20 }`, '[void]$gate.Set()'].join('\r\n')
      const ran = await both(dirs, coordinator, selfSwitch, true, open)
      assert.equal(ran.a, `A:0:left ${dirs.id}:0`, ran.all)
      assert.equal(ran.b, `B:0:left ${dirs.id}:0`, ran.all)
      const record = JSON.parse(readFileSync(join(dirs.state, 'left', `${dirs.id}.json`), 'utf8'))
      assert.equal(record.how, 'in-place', ran.all)
      assert.equal(record.by, 'coordinator', ran.all)
      assert.equal(record.go, GO)
      assert.ok(!existsSync(join(dirs.state, 'left', `${dirs.id}.lock`)), 'the lock is gone with its last holder')
    })
  }

  test('R8: a record of the same move whose MAC is not good is no record of it: replaced', async () => {
    const dirs = lab()
    const coordinator = machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'in-place', configDirs: [dirs.config], by: 'coordinator', go: GO })
    const selfSwitch = machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'in-place', configDirs: [dirs.config], by: 'self-switch' })
    const path = join(dirs.state, 'left', `${dirs.id}.json`)
    const spoil = `$r = Get-Content -LiteralPath '${path}' -Raw | ConvertFrom-Json; $r.mac = ('0' * 64); [IO.File]::WriteAllText('${path}', ($r | ConvertTo-Json -Compress -Depth 4))`
    const ran = await both(dirs, coordinator, selfSwitch, false, spoil)
    assert.equal(ran.b, `B:0:left ${dirs.id}:0`, ran.all)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).by, 'self-switch')
  })

  test("R8: the same writer's record of the same move is replaced by its newer one, never taken as the other writer's", async () => {
    const dirs = lab()
    const first = machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'in-place', configDirs: [dirs.config], by: 'self-switch' })
    const path = join(dirs.state, 'left', `${dirs.id}.json`)
    const keep = `Copy-Item -LiteralPath '${path}' -Destination '${join(dirs.root, 'after-a.json')}'`
    const ran = await both(dirs, first, first, false, keep)
    assert.equal(ran.b, `B:0:left ${dirs.id}:0`, ran.all)
    const before = JSON.parse(readFileSync(join(dirs.root, 'after-a.json'), 'utf8'))
    assert.notEqual(JSON.parse(readFileSync(path, 'utf8')).at, before.at, 'the second write replaced the first')
  })

  test('both at once, unheld: each says written, with nothing on its error stream, and one whole record stands that reads back with its MAC', async () => {
    const dirs = lab()
    const coordinator = machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'in-place', configDirs: [dirs.config], by: 'coordinator', go: GO })
    const selfSwitch = machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'in-place', configDirs: [dirs.config], by: 'self-switch' })
    const ran = await both(dirs, coordinator, selfSwitch, true)
    assert.equal(ran.a, `A:0:left ${dirs.id}:0`, ran.all)
    assert.equal(ran.b, `B:0:left ${dirs.id}:0`, ran.all)
    const read = await run(machine.leftReadScript({ stateDir: dirs.state, ids: [dirs.id], configDirs: [dirs.config] }))
    const parsed = machine.parseLeftRead(read.stdout)
    assert.ok(!('error' in parsed) && parsed.left.length === 1 && parsed.left[0].ok === true && parsed.left[0].macOk === true, read.stdout)
  })

  test('a record of another move (how exit, then in place) is replaced, as it always was', async () => {
    const dirs = lab()
    const exit = machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'exit', configDirs: [dirs.config], by: 'self-switch' })
    const inPlace = machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'in-place', configDirs: [dirs.config], by: 'coordinator', go: GO })
    const ran = await both(dirs, exit, inPlace, false)
    assert.equal(ran.b, `B:0:left ${dirs.id}:0`, ran.all)
    const record = JSON.parse(readFileSync(join(dirs.state, 'left', `${dirs.id}.json`), 'utf8'))
    assert.equal(record.how, 'in-place')
    assert.equal(record.by, 'coordinator')
  })
})

describe('the left record lock (S3 final)', { skip: !isWindows && 'Windows only', concurrency: false }, () => {
  const GO = 'wu_abc123'
  const lockOf = dirs => join(dirs.state, 'left', `${dirs.id}.lock`)
  /** Holds writer A right after it has taken the lock, before it stats the transcript: a file says it holds it. */
  const heldAfterLock = (script, gate, holding) => {
    const line = "if ($null -eq $leftLock) { 'refused lock another writer held this record for 10 seconds'; exit 0 }"
    const at = script.indexOf(line)
    assert.ok(at > 0, 'the lock, taken')
    const end = at + line.length
    const hold = [`New-Item -ItemType File -Path '${holding}' -Force | Out-Null`, `$gate = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, '${gate}')`, '[void]$gate.WaitOne(60000)'].join('\r\n')
    return `${script.slice(0, end)}\r\n${hold}${script.slice(end)}`
  }

  test("R2 (final): while writer A holds the lock, writer B waits, writing nothing: the earlier record stays; once A lets go, both say written and the coordinator's go stands", async () => {
    const dirs = lab()
    const stale = await write(machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'exit', configDirs: [dirs.config], by: 'self-switch' }))
    assert.equal(machine.LEFT_WRITTEN.exec(stale.stdout)?.[1], dirs.id, stale.stdout + stale.stderr)
    const gate = `left-held-${randomUUID()}`
    const holding = join(dirs.root, 'holding')
    const a = join(dirs.root, 'a.ps1')
    const b = join(dirs.root, 'b.ps1')
    writeFileSync(a, heldAfterLock(machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'in-place', configDirs: [dirs.config], by: 'self-switch' }), gate, holding))
    writeFileSync(b, machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'in-place', configDirs: [dirs.config], by: 'coordinator', go: GO }))
    const record = join(dirs.state, 'left', `${dirs.id}.json`)
    const script = [
      "$ProgressPreference = 'SilentlyContinue'",
      `function Start-Ps($file) { $i = New-Object Diagnostics.ProcessStartInfo('${POWERSHELL}', ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $file + '"')); $i.UseShellExecute = $false; $i.CreateNoWindow = $true; $i.RedirectStandardOutput = $true; $i.RedirectStandardError = $true; return [Diagnostics.Process]::Start($i) }`,
      `$gate = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, '${gate}')`,
      `$pa = Start-Ps '${a}'`,
      `$until = (Get-Date).AddSeconds(60); while (-not (Test-Path '${holding}') -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 20 }`,
      `$pb = Start-Ps '${b}'`,
      'Start-Sleep -Seconds 4',
      '"B-WAITING:" + (-not $pb.HasExited)',
      `"RECORD:" + (Get-Content -LiteralPath '${record}' -Raw | ConvertFrom-Json).how`,
      '[void]$gate.Set()',
      '$oa = $pa.StandardOutput.ReadToEnd(); $ea = $pa.StandardError.ReadToEnd(); $pa.WaitForExit()',
      '$ob = $pb.StandardOutput.ReadToEnd(); $eb = $pb.StandardError.ReadToEnd(); $pb.WaitForExit()',
      '"A:" + $pa.ExitCode + ":" + $oa.Trim() + ":" + ([regex]::Matches($ea, "S=.Error.")).Count',
      '"B:" + $pb.ExitCode + ":" + $ob.Trim() + ":" + ([regex]::Matches($eb, "S=.Error.")).Count',
    ].join('\r\n')
    const ran = await write(script)
    const all = ran.stdout + ran.stderr
    assert.match(ran.stdout, /^B-WAITING:True\r?$/m, all)
    assert.match(ran.stdout, /^RECORD:exit\r?$/m, all)
    assert.match(ran.stdout, new RegExp(`^A:0:left ${dirs.id}:0\\r?$`, 'm'), all)
    assert.match(ran.stdout, new RegExp(`^B:0:left ${dirs.id}:0\\r?$`, 'm'), all)
    const final = JSON.parse(readFileSync(record, 'utf8'))
    assert.equal(final.by, 'coordinator', all)
    assert.equal(final.go, GO)
    assert.ok(!existsSync(lockOf(dirs)), 'the lock is gone with its last holder')
  })

  /** Holds the lock from outside, sharing nothing, for `seconds`; resolves once it is held. */
  async function hold(dirs, seconds) {
    const held = join(dirs.root, `held-${randomUUID()}`)
    mkdirSync(join(dirs.state, 'left'), { recursive: true })
    const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `$s = [IO.FileStream]::new('${lockOf(dirs)}', 'OpenOrCreate', 'ReadWrite', 'None'); New-Item -ItemType File -Path '${held}' -Force | Out-Null; Start-Sleep -Seconds ${seconds}; $s.Dispose()`], { windowsHide: true, stdio: 'ignore' })
    const until = Date.now() + 30_000
    while (!existsSync(held) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(existsSync(held), 'the outside holder took the lock')
    return child
  }

  test('R2 (final): a holder that never lets go: the writer waits about 10 seconds, then answers refused lock, writing nothing', async () => {
    const dirs = lab()
    const child = await hold(dirs, 30)
    try {
      const started = Date.now()
      const ran = await write(machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'in-place', configDirs: [dirs.config], by: 'self-switch' }))
      const took = Date.now() - started
      assert.match(ran.stdout, /^refused lock another writer held this record for 10 seconds\s*$/m, ran.stdout + ran.stderr)
      assert.ok(took > 8000, `it waited for the lock (${took} ms)`)
      assert.ok(!existsSync(join(dirs.state, 'left', `${dirs.id}.json`)), 'nothing written')
    } finally {
      child.kill()
    }
  })

  test('R2 (final): a holder that lets go within the wait: the writer takes the lock then, and writes', async () => {
    const dirs = lab()
    const child = await hold(dirs, 3)
    try {
      const ran = await write(machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'in-place', configDirs: [dirs.config], by: 'self-switch' }))
      assert.equal(machine.LEFT_WRITTEN.exec(ran.stdout)?.[1], dirs.id, ran.stdout + ran.stderr)
    } finally {
      child.kill()
    }
  })

  test('R1 (final): a lock file an OS crash left behind, held by no one, is opened at once and deleted on close, never waited out', async () => {
    const dirs = lab()
    mkdirSync(join(dirs.state, 'left'), { recursive: true })
    writeFileSync(lockOf(dirs), '')
    const started = Date.now()
    const ran = await write(machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'in-place', configDirs: [dirs.config], by: 'self-switch' }))
    assert.equal(machine.LEFT_WRITTEN.exec(ran.stdout)?.[1], dirs.id, ran.stdout + ran.stderr)
    assert.ok(Date.now() - started < 8000, 'no wait for a lock no one holds')
    assert.ok(!existsSync(lockOf(dirs)), 'the leftover is gone')
  })
})
