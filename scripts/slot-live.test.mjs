// The slot runner v2 and what a launch hands it, run for real on Windows against the stub claude.exe
// (scripts/stub.mjs), hidden, its USERPROFILE, LOCALAPPDATA and CLAUDE_CONFIG_DIR temporary folders (the
// harness refuses anything else), never a window, never wt.exe, never a real claude. It covers what text
// can't: a beacon as written, a `start` record and a `resume` record honoured, -Start and -Resume, the
// runner's own floor and cap, the left record at its last look, two runs in a row through
// claude-launch.ps1, by the hash a record or an argument names, never the hand copy; the probe's slots
// mode against a running runner; and the launch script's own run (an idle slot elsewhere, CreateNew) with
// its floor and input checks. Run with
// `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { freemem, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { compileStub, fence, holder, underStub, WINDOWS_POWERSHELL } from './stub.mjs'
import { ROOT } from './sync-shared.mjs'

const machine = await import(pathToFileURL(join(ROOT, 'shared', 'hooks', 'machine.ts')).href)
const RUNNER = join(ROOT, 'plugins', 'self-switch', 'slot', 'claude-slot.ps1')
const isWindows = process.platform === 'win32'

let work
let stub

before(() => {
  if (!isWindows) return
  work = mkdtempSync(join(tmpdir(), 'slot-live-'))
  stub = compileStub(work)
})
after(() => {
  if (work !== undefined) rmSync(work, { recursive: true, force: true })
})

/** A hand copy that says so if a slot runner ever runs it: a file beside it, and no claude. Of a version no launch replaces. */
const HAND_COPY = "# claude-launch version 999\nparam()\nSet-Content -LiteralPath (Join-Path $PSScriptRoot 'hand-copy-ran') -Value 'it ran'\n"
const handCopyRan = dirs => existsSync(join(dirs.state, 'hand-copy-ran'))
const sha256Of = text => createHash('sha256').update(text).digest('hex')
/** A launcher that isn't the release's, at the name its own hash gives, saying so if it runs. */
function otherLauncher(dirs, version, mark) {
  const text = `# claude-launch version ${version}\nparam()\nSet-Content -LiteralPath (Join-Path $PSScriptRoot '${mark}') -Value 'it ran'\n`
  const sha = sha256Of(text)
  const path = machine.launchScriptPath(dirs.state, sha)
  writeFileSync(path, text)
  return { path, sha, ran: () => existsSync(join(dirs.state, mark)) }
}
/** The argument a launch's tab carries: this release's pin. */
const PIN = ['-Launcher', machine.LAUNCH_SCRIPT_SHA256]

/** One run's folders: a home whose .local\bin holds the stub, the state folder with the launcher at its hash's name, a hand copy no runner may run, and the runner, a config folder, the conversation's folder. */
function lab() {
  const root = mkdtempSync(join(work, 'run-'))
  const dirs = { root, home: join(root, 'home'), local: join(root, 'local'), config: join(root, 'config'), other: join(root, 'config two'), folder: join(root, 'work folder') }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  mkdirSync(join(dirs.home, '.local', 'bin'), { recursive: true })
  copyFileSync(stub, join(dirs.home, '.local', 'bin', 'claude.exe'))
  const state = join(dirs.local, 'claude-self-tools')
  for (const sub of ['claims', 'slots']) mkdirSync(join(state, sub), { recursive: true })
  writeFileSync(machine.launchScriptPath(state), machine.LAUNCH_SCRIPT_TEXT)
  writeFileSync(machine.launchHandPath(state), HAND_COPY)
  copyFileSync(RUNNER, join(state, 'claude-slot.ps1'))
  // Limits no real machine's sessions or memory get in the way of: the tests that need others write their own.
  writeFileSync(machine.placementPath(state), JSON.stringify({ v: 1, layout: [], limits: { minFreeGb: 1, maxSessions: 40 } }))
  return { ...dirs, state, script: join(state, 'claude-slot.ps1') }
}

function envOf(dirs, extra = {}) {
  const keep = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'CommonProgramFiles']
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const env = {
    ...Object.fromEntries(keep.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])),
    PATH: [join(root, 'System32'), root, join(root, 'System32', 'WindowsPowerShell', 'v1.0')].join(';'),
    USERPROFILE: dirs.home,
    APPDATA: join(dirs.home, 'AppData', 'Roaming'),
    LOCALAPPDATA: dirs.local,
    CLAUDE_CONFIG_DIR: dirs.config,
    STUB_LOG: join(dirs.root, 'claude-runs.jsonl'),
    STUB_EXIT: '0',
    ...Object.fromEntries(machine.LAUNCH_ENV_CLEAR.map(name => [name, 'marker-test'])),
    ...extra,
  }
  fence(env, work)
  return env
}

const runsOf = dirs => {
  const log = join(dirs.root, 'claude-runs.jsonl')
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}

/** The runner, started hidden with `args` in `cwd` (its stdin a pipe: no console, so no key is ever pending). */
function startRunner(dirs, args, { cwd = dirs.folder, env = {} } = {}) {
  const child = spawn(WINDOWS_POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', dirs.script, ...args], { env: envOf(dirs, env), cwd, windowsHide: true })
  let out = ''
  child.stdout.on('data', chunk => (out += chunk))
  child.stderr.on('data', chunk => (out += chunk))
  const stops = () => child.kill()
  return { child, stop: stops, out: () => out, id: () => beaconId(dirs, child.pid) }
}

/** The runner's id, off the beacon file it wrote: `<pid>-<created>`. */
function beaconId(dirs, pid) {
  const file = readdirSync(join(dirs.state, 'slots')).find(name => name.startsWith(`${pid}-`) && name.endsWith('.state.json'))
  return file === undefined ? undefined : file.slice(0, -'.state.json'.length)
}

const beaconOf = (dirs, id) => JSON.parse(readFileSync(machine.slotBeaconPath(dirs.state, id), 'utf8'))

/** Waits for `check` to be true, up to `ms`. */
async function until(check, what, ms = 30_000) {
  const end = Date.now() + ms
  for (;;) {
    let ok = false
    try {
      ok = await check()
    } catch {
      ok = false
    }
    if (ok) return
    if (Date.now() > end) throw new Error(`never came: ${what}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

const lockText = (by, pid = 4) => JSON.stringify({ v: 1, by, pid, created: '1', at: Date.now(), transport: 'slot' })
const claim = (dirs, id, by) => writeFileSync(machine.claimPath(dirs.state, id), lockText(by))
/** Writes conversation `id`'s transcript under `folder`'s project. */
function transcript(dirs, id, folder = dirs.folder, config = dirs.config) {
  const project = join(config, 'projects', machine.projectName(folder))
  mkdirSync(project, { recursive: true })
  const path = join(project, `${id}.jsonl`)
  writeFileSync(path, '{}\n')
  return path
}
/** Writes a record for slot `id`, naming this release's launcher as a launch does; `bare` names none. */
const record = (dirs, id, value, { bare = false } = {}) => writeFileSync(machine.slotRecordPath(dirs.state, id), JSON.stringify(bare ? value : { launcher: machine.LAUNCH_SCRIPT_SHA256, ...value }))
/** Placement limits no machine meets, or a cap that's no bar. */
const placement = (dirs, limits) => writeFileSync(machine.placementPath(dirs.state), JSON.stringify({ v: 1, layout: [], limits }))

describe('the slot runner, run for real against the stub', { skip: !isWindows && 'Windows only', concurrency: 3 }, () => {
  test('-Idle: starts nothing; its beacon says idle, with its stamp and config folder; a bad stamp is left out', async () => {
    const dirs = lab()
    const runner = startRunner(dirs, ['-Idle'], { env: { CLAUDE_SELF_TOOLS_WT_WINDOW: 'claude-4', CLAUDE_SELF_TOOLS_WT_TAB: 'bad;tab' } })
    try {
      await until(() => runner.id() !== undefined, 'the beacon')
      const beacon = beaconOf(dirs, runner.id())
      assert.equal(beacon.state, 'idle')
      assert.equal(beacon.window, 'claude-4')
      assert.ok(!('tab' in beacon), 'a bad stamp is dropped')
      assert.equal(beacon.configDir, dirs.config)
      assert.match(beacon.claude, /claude\.exe$/)
      await new Promise(resolve => setTimeout(resolve, 1500))
      assert.equal(runsOf(dirs).length, 0, runner.out())
    } finally {
      runner.stop()
    }
  })

  test('a `start` record: deleted, then claude --session-id --name in its folder, through claude-launch.ps1, with the launch environment (REAP among it); a `resume` record after it, the launcher runs again', async () => {
    const dirs = lab()
    const runner = startRunner(dirs, ['-Idle'])
    try {
      await until(() => runner.id() !== undefined, 'the beacon')
      const slot = runner.id()
      const fresh = randomUUID()
      claim(dirs, fresh, `slot:${slot}`)
      record(dirs, slot, { v: 1, start: fresh, name: 'dealerwrap', folder: dirs.folder, at: Date.now(), configDirs: [dirs.config] })
      await until(() => runsOf(dirs).length === 1, `the first run\n${runner.out()}`)
      const [first] = runsOf(dirs)
      assert.deepEqual(first.args, ['--session-id', fresh, '--name', 'dealerwrap'])
      assert.equal(first.cwd, dirs.folder)
      assert.equal(first.forceIsOne, true)
      assert.equal(first.reapIsOne, true)
      for (const name of [...machine.LAUNCH_ENV_CLEAR, ...machine.LAUNCH_ENV_DROP]) assert.ok(!first.env.includes(name), `${name} is cleared`)
      assert.ok(!existsSync(machine.slotRecordPath(dirs.state, slot)), 'the record is gone')
      await until(() => beaconOf(dirs, slot).state === 'idle', 'idle again')

      const old = randomUUID()
      transcript(dirs, old)
      claim(dirs, old, `slot:${slot}`)
      record(dirs, slot, { v: 1, resume: old, folder: dirs.folder, at: Date.now(), configDirs: [dirs.config, dirs.other] })
      await until(() => runsOf(dirs).length === 2, `the second run\n${runner.out()}`)
      assert.deepEqual(runsOf(dirs)[1].args, ['--resume', old])
    } finally {
      runner.stop()
    }
  })

  test('a record refused: too old, a bad name, a folder with a semicolon, no claim, a claim naming another, not new (a transcript in another config folder it names), held; each said, none run', async () => {
    const dirs = lab()
    const runner = startRunner(dirs, ['-Idle'])
    try {
      await until(() => runner.id() !== undefined, 'the beacon')
      const slot = runner.id()
      const by = `slot:${slot}`
      const seen = (text, n) => until(() => (runner.out().match(text) ?? []).length >= n, `${text}\n${runner.out()}`)
      const old = randomUUID()
      claim(dirs, old, by)
      record(dirs, slot, { v: 1, start: old, name: 'x', folder: dirs.folder, at: Date.now() - 121_000 })
      await seen(/it is more than 120 seconds old/g, 1)
      const named = randomUUID()
      claim(dirs, named, by)
      record(dirs, slot, { v: 1, start: named, name: 'Not A Name', folder: dirs.folder, at: Date.now() })
      await seen(/it names no session name/g, 1)
      const semi = join(dirs.root, 'a;b')
      mkdirSync(semi)
      record(dirs, slot, { v: 1, start: named, name: 'x', folder: semi, at: Date.now() })
      await seen(/its folder is not an existing folder with no quote or semicolon/g, 1)
      const free = randomUUID()
      record(dirs, slot, { v: 1, start: free, name: 'x', folder: dirs.folder, at: Date.now() })
      await seen(/the claim lock on that conversation does not name this slot/g, 1)
      claim(dirs, free, `launch:${randomUUID()}`)
      record(dirs, slot, { v: 1, start: free, name: 'x', folder: dirs.folder, at: Date.now() })
      await seen(/the claim lock on that conversation does not name this slot/g, 2)
      const known = randomUUID()
      transcript(dirs, known, dirs.folder, dirs.other)
      claim(dirs, known, by)
      record(dirs, slot, { v: 1, start: known, name: 'x', folder: dirs.folder, at: Date.now(), configDirs: [dirs.other] })
      await seen(/a transcript of it is already in the projects of /g, 1)
      assert.equal(runsOf(dirs).length, 0, runner.out())
    } finally {
      runner.stop()
    }
  })

  test("its own floor: a `start` record under limits.minFreeGb is refused, a `resume` record isn't, which checks the cap only; the cap refuses both", async () => {
    if (freemem() >= 64 * 2 ** 30) return
    const dirs = lab()
    placement(dirs, { minFreeGb: 64, maxSessions: 40 })
    const runner = startRunner(dirs, ['-Idle'])
    const other = await holder({ stub, work, env: envOf(dirs) })
    try {
      await until(() => runner.id() !== undefined, 'the beacon')
      const slot = runner.id()
      const fresh = randomUUID()
      claim(dirs, fresh, `slot:${slot}`)
      record(dirs, slot, { v: 1, start: fresh, name: 'x', folder: dirs.folder, at: Date.now() })
      await until(() => /under this slot's floor of 64 GB/.test(runner.out()), `the refusal\n${runner.out()}`)
      assert.equal(runsOf(dirs).filter(run => run.args.length > 0).length, 0)
      const old = randomUUID()
      transcript(dirs, old)
      claim(dirs, old, `slot:${slot}`)
      record(dirs, slot, { v: 1, resume: old, folder: dirs.folder, at: Date.now() })
      await until(() => runsOf(dirs).some(run => run.args[1] === old), `the resume\n${runner.out()}`)
      await until(() => beaconOf(dirs, slot).state === 'idle', 'idle again')
      // A cap of one, with the holder and whatever else this machine runs: at the cap.
      placement(dirs, { minFreeGb: 1, maxSessions: 1 })
      const again = randomUUID()
      transcript(dirs, again)
      claim(dirs, again, `slot:${slot}`)
      record(dirs, slot, { v: 1, resume: again, folder: dirs.folder, at: Date.now() })
      await until(() => /at this slot's cap of 1/.test(runner.out()), `the cap\n${runner.out()}`)
      assert.ok(!runsOf(dirs).some(run => run.args[1] === again))
    } finally {
      other.stop()
      runner.stop()
    }
  })

  test('-Start: the claim must name launch:<id>; the id must be new; then claude here, and the tab goes on as an idle slot', async () => {
    const dirs = lab()
    const bare = randomUUID()
    const wrong = startRunner(dirs, ['-Start', bare, '-Name', 'dealerwrap', ...PIN])
    try {
      await until(() => /does not name this tab's launch/.test(wrong.out()), `the refusal\n${wrong.out()}`)
      assert.equal(runsOf(dirs).length, 0)
    } finally {
      wrong.stop()
    }
    const badName = startRunner(dirs, ['-Start', randomUUID(), '-Name', 'Not A Name', ...PIN])
    try {
      await until(() => /-Start takes -Name/.test(badName.out()), `the refusal\n${badName.out()}`)
    } finally {
      badName.stop()
    }
    const fresh = randomUUID()
    claim(dirs, fresh, `launch:${fresh}`)
    const runner = startRunner(dirs, ['-Start', fresh, '-Name', 'dealerwrap', '-ConfigDirs', `${dirs.config}|${dirs.other}`, ...PIN])
    try {
      await until(() => runsOf(dirs).length === 1, `the run\n${runner.out()}`)
      assert.deepEqual(runsOf(dirs)[0].args, ['--session-id', fresh, '--name', 'dealerwrap'])
      assert.equal(runsOf(dirs)[0].cwd, dirs.folder)
      await until(() => beaconOf(dirs, runner.id()).state === 'idle', 'idle after')
    } finally {
      runner.stop()
    }
  })

  test("-Resume: this folder must be its own; a holder refuses (L1, L2); a left record's stat is checked at the last look: changed refuses, unchanged runs", async () => {
    const dirs = lab()
    const id = randomUUID()
    const path = transcript(dirs, id)
    claim(dirs, id, `launch:${id}`)
    const elsewhere = startRunner(dirs, ['-Resume', id, ...PIN], { cwd: dirs.root })
    try {
      await until(() => /this folder is not that conversation's own/.test(elsewhere.out()), `the refusal\n${elsewhere.out()}`)
    } finally {
      elsewhere.stop()
    }
    const named = await holder({ stub, work, env: envOf(dirs), args: ['--resume', id] })
    const held = startRunner(dirs, ['-Resume', id, ...PIN])
    try {
      await until(() => /it is open elsewhere: process \d+ names it on its command line \(L2\)/.test(held.out()), `the refusal\n${held.out()}`)
    } finally {
      held.stop()
      named.stop()
    }
    const when = new Date(Date.now() - 60_000)
    utimesSync(path, when, when)
    const mtime = Math.round(statSync(path).mtimeMs)
    const changed = startRunner(dirs, ['-Resume', id, '-LeftSize', '999', '-LeftMtime', String(mtime), ...PIN])
    try {
      await until(() => /its transcript changed since it was left/.test(changed.out()), `the refusal\n${changed.out()}`)
      assert.equal(runsOf(dirs).length, 0)
    } finally {
      changed.stop()
    }
    const size = statSync(path).size
    const runner = startRunner(dirs, ['-Resume', id, '-LeftSize', String(size), '-LeftMtime', String(mtime), ...PIN])
    try {
      await until(() => runsOf(dirs).length === 1, `the run\n${runner.out()}`)
      assert.deepEqual(runsOf(dirs)[0].args, ['--resume', id])
    } finally {
      runner.stop()
    }
  })

  test("a `resume` record with a left record's stat: the transcript changed since refuses it", async () => {
    const dirs = lab()
    const runner = startRunner(dirs, ['-Idle'])
    try {
      await until(() => runner.id() !== undefined, 'the beacon')
      const slot = runner.id()
      const id = randomUUID()
      transcript(dirs, id)
      claim(dirs, id, `slot:${slot}`)
      record(dirs, slot, { v: 1, resume: id, folder: dirs.folder, at: Date.now(), left: { size: 999, mtime: 1 } })
      await until(() => /its transcript changed since it was left/.test(runner.out()), `the refusal\n${runner.out()}`)
      assert.equal(runsOf(dirs).length, 0)
    } finally {
      runner.stop()
    }
  })

  test('which launcher: a record names it by its hash; that copy runs, and the hand copy beside it never does', async () => {
    const dirs = lab()
    const runner = startRunner(dirs, ['-Idle'])
    try {
      await until(() => runner.id() !== undefined, 'the beacon')
      const slot = runner.id()
      const fresh = randomUUID()
      claim(dirs, fresh, `slot:${slot}`)
      record(dirs, slot, { v: 1, start: fresh, name: 'dealerwrap', folder: dirs.folder, at: Date.now() })
      await until(() => runsOf(dirs).length === 1, `the run\n${runner.out()}`)
      assert.deepEqual(runsOf(dirs)[0].args, ['--session-id', fresh, '--name', 'dealerwrap'])
      assert.ok(!handCopyRan(dirs), 'the hand copy is not run')
      // Another launcher, named by another record: that one runs, with no new runner and no restart of this pane.
      await until(() => beaconOf(dirs, slot).state === 'idle', 'idle again')
      const newer = otherLauncher(dirs, 1000, 'newer-ran')
      const next = randomUUID()
      claim(dirs, next, `slot:${slot}`)
      record(dirs, slot, { v: 1, start: next, name: 'dealerwrap', folder: dirs.folder, at: Date.now(), launcher: newer.sha })
      await until(newer.ran, `the other launcher\n${runner.out()}`)
      assert.equal(runsOf(dirs).length, 1, 'that launcher starts no claude, so no second run')
      assert.ok(!handCopyRan(dirs))
    } finally {
      runner.stop()
    }
  })

  test('planted, a missing field: a record with no launcher, or one not of a hash\'s shape, starts nothing and says what to do; so does a tab with no -Launcher', async () => {
    const dirs = lab()
    const runner = startRunner(dirs, ['-Idle'])
    try {
      await until(() => runner.id() !== undefined, 'the beacon')
      const slot = runner.id()
      const old = randomUUID()
      transcript(dirs, old)
      claim(dirs, old, `slot:${slot}`)
      record(dirs, slot, { v: 1, resume: old, folder: dirs.folder, at: Date.now() }, { bare: true })
      const said = /it names no launcher by its SHA-256, so a plugin older than this slot runner wrote it: update the plugins, then launch it again/g
      await until(() => (runner.out().match(said) ?? []).length === 1, `the refusal\n${runner.out()}`)
      assert.match(runner.out(), /Once it is safe, resume it yourself: & '.+claude-launch\.ps1' -Resume /)
      for (const launcher of ['not-a-hash', machine.LAUNCH_SCRIPT_SHA256.toUpperCase(), 12]) {
        record(dirs, slot, { v: 1, resume: old, folder: dirs.folder, at: Date.now(), launcher })
        await until(() => !existsSync(machine.slotRecordPath(dirs.state, slot)), 'read')
      }
      await until(() => (runner.out().match(said) ?? []).length === 4, `each refused\n${runner.out()}`)
      assert.equal(runsOf(dirs).length, 0)
      assert.ok(!handCopyRan(dirs))
    } finally {
      runner.stop()
    }
    const fresh = randomUUID()
    claim(dirs, fresh, `launch:${fresh}`)
    const tab = startRunner(dirs, ['-Start', fresh, '-Name', 'dealerwrap'])
    try {
      await until(() => /it names no launcher by its SHA-256 \(-Launcher\), so a plugin older than this slot runner opened it: update the plugins, then launch it again/.test(tab.out()), `the refusal\n${tab.out()}`)
      assert.equal(runsOf(dirs).length, 0)
      assert.ok(!handCopyRan(dirs))
    } finally {
      tab.stop()
    }
  })

  test('planted, a changed file: the copy at that name with another hash, or none there, starts nothing, says what to do, and the pane goes on; the hand copy is not the way out; a launch\'s copy put back runs', async () => {
    const dirs = lab()
    const runner = startRunner(dirs, ['-Idle'])
    try {
      await until(() => runner.id() !== undefined, 'the beacon')
      const slot = runner.id()
      const path = machine.launchScriptPath(dirs.state)
      const old = randomUUID()
      transcript(dirs, old)
      claim(dirs, old, `slot:${slot}`)
      writeFileSync(path, `${machine.LAUNCH_SCRIPT_TEXT}# edited\n`)
      record(dirs, slot, { v: 1, resume: old, folder: dirs.folder, at: Date.now() })
      const said = /Nothing started: .+claude-launch-[0-9a-f]{8}\.ps1 does not have the SHA-256 [0-9a-f]{64}\. It is missing, or it changed after a launch put it there\. Launch it again: a launch puts it back\./g
      await until(() => (runner.out().match(said) ?? []).length === 1, `the refusal\n${runner.out()}`)
      assert.match(runner.out(), /Once it is safe, resume it yourself: & '.+claude-launch\.ps1' -Resume [0-9a-f-]{36} -Dir '.+'/)
      rmSync(path)
      record(dirs, slot, { v: 1, resume: old, folder: dirs.folder, at: Date.now() })
      await until(() => (runner.out().match(said) ?? []).length === 2, `missing\n${runner.out()}`)
      assert.equal(runsOf(dirs).length, 0)
      assert.ok(!handCopyRan(dirs))
      assert.equal(beaconOf(dirs, slot).state, 'idle', 'nothing ran: never said running')
      writeFileSync(path, machine.LAUNCH_SCRIPT_TEXT)
      record(dirs, slot, { v: 1, resume: old, folder: dirs.folder, at: Date.now() })
      await until(() => runsOf(dirs).length === 1, `put back\n${runner.out()}`)
      assert.deepEqual(runsOf(dirs)[0].args, ['--resume', old])
    } finally {
      runner.stop()
    }
  })

  test('planted, the hand copy: a runner edited to run it is caught by what the tests above read; this runner, with only a hand copy there, starts nothing', async () => {
    const dirs = lab()
    const faulty = readFileSync(RUNNER, 'utf8').replace("$launcherPath = Join-Path $state ('claude-launch-' + $sha.Substring(0, 8) + '.ps1')", '$launcherPath = $handCopy').replace('if ($actual -cne $sha) {', 'if ($false) {')
    assert.notEqual(faulty, readFileSync(RUNNER, 'utf8'))
    const edited = { ...dirs, script: join(dirs.root, 'edited', 'claude-slot.ps1') }
    mkdirSync(join(dirs.root, 'edited'))
    writeFileSync(edited.script, faulty)
    const fresh = randomUUID()
    claim(dirs, fresh, `launch:${fresh}`)
    const bad = startRunner(edited, ['-Start', fresh, '-Name', 'dealerwrap', ...PIN])
    try {
      await until(() => handCopyRan(dirs), `the marker a run of the hand copy leaves\n${bad.out()}`)
    } finally {
      bad.stop()
    }
    rmSync(join(dirs.state, 'hand-copy-ran'))
    rmSync(machine.launchScriptPath(dirs.state))
    const again = randomUUID()
    claim(dirs, again, `launch:${again}`)
    const good = startRunner(dirs, ['-Start', again, '-Name', 'dealerwrap', ...PIN])
    try {
      await until(() => /Nothing started: .+ does not have the SHA-256/.test(good.out()), `the refusal\n${good.out()}`)
      assert.ok(!handCopyRan(dirs))
      assert.equal(runsOf(dirs).length, 0)
    } finally {
      good.stop()
    }
  })

  test('no record, as at Enter: the highest version among the copies whose hash their name gives; an edited one passed over; only a hand copy there starts nothing, and says what to do', async () => {
    // Only a hand copy.
    const none = lab()
    rmSync(machine.launchScriptPath(none.state))
    const alone = startRunner(none, [])
    try {
      await until(() => /Nothing started: no claude-launch-<hash>\.ps1 in .+ has the SHA-256 its name gives, and only such a copy starts claude here\. A launch \(a switch, a restart\) puts one there\. Or leave this slot with Ctrl\+C, and run yours by hand: & '.+claude-launch\.ps1'/.test(alone.out()), `the words\n${alone.out()}`)
      assert.equal(runsOf(none).length, 0)
      assert.ok(!handCopyRan(none))
    } finally {
      alone.stop()
    }
    // An older copy and this release's: this release's runs, plain.
    const both = lab()
    const older = otherLauncher(both, 1, 'older-ran')
    const plain = startRunner(both, [])
    try {
      await until(() => runsOf(both).length === 1, `the run\n${plain.out()}`)
      assert.deepEqual(runsOf(both)[0].args, [])
      assert.ok(!older.ran())
      assert.ok(!handCopyRan(both))
    } finally {
      plain.stop()
    }
    // The highest version, edited after it was put there: passed over, and the next one runs.
    const edited = lab()
    const newest = otherLauncher(edited, 1000, 'newest-ran')
    writeFileSync(newest.path, `${readFileSync(newest.path, 'utf8')}# edited\n`)
    const passed = startRunner(edited, [])
    try {
      await until(() => runsOf(edited).length === 1, `the run\n${passed.out()}`)
      assert.ok(!newest.ran())
    } finally {
      passed.stop()
    }
    // The highest version, whole: it runs.
    const whole = lab()
    const highest = otherLauncher(whole, 1000, 'highest-ran')
    const top = startRunner(whole, [])
    try {
      await until(highest.ran, `the marker\n${top.out()}`)
      assert.equal(runsOf(whole).length, 0)
    } finally {
      top.stop()
    }
  })
})

describe("the probe's slots mode, and the launch's own run, against a running runner", { skip: !isWindows && 'Windows only', concurrency: 2 }, () => {
  test('every runner found, by its id and hash; a closed tab\'s beacon never read; an edited copy reads another hash; heavy-slot from its folders; a lock holder accounted as holding its id only; nothing but what the type names', async () => {
    const dirs = lab()
    const runner = startRunner(dirs, ['-Idle'])
    const editedDirs = { ...dirs, script: join(dirs.root, 'elsewhere', 'claude-slot.ps1') }
    mkdirSync(join(dirs.root, 'elsewhere'))
    writeFileSync(editedDirs.script, `${readFileSync(RUNNER, 'utf8')}# edited\n`)
    const edited = startRunner(editedDirs, ['-Idle'])
    const id = randomUUID()
    try {
      await until(() => runner.id() !== undefined && edited.id() !== undefined, 'the beacons')
      // A closed tab's beacon: its process isn't running.
      writeFileSync(machine.slotBeaconPath(dirs.state, '4-1'), JSON.stringify({ v: 1, state: 'idle', since: 1, configDir: dirs.config }))
      const heavy = join(dirs.root, 'heavy')
      mkdirSync(join(heavy, '.gate-queue'), { recursive: true })
      mkdirSync(join(heavy, '.gate-lock'))
      writeFileSync(join(heavy, '.gate-queue', '1-2'), '')
      const ran = await underStub({ stub, work, env: envOf(dirs), script: () => machine.probeScript({ ids: [id], configDirs: [dirs.config], stateDir: dirs.state, heavySlotRoot: heavy, slots: true }) })
      const probe = machine.parseProbe(ran.stdout)
      assert.ok(!('error' in probe), `${probe.error}\n${ran.stdout}${ran.stderr}`)
      const mine = probe.slots.find(s => s.id === runner.id())
      assert.equal(mine.sha256, machine.SLOT_SCRIPT_SHA256)
      assert.equal(mine.child, null)
      assert.equal(mine.beacon.state, 'idle')
      assert.equal(mine.beacon.configDir, dirs.config)
      assert.notEqual(probe.slots.find(s => s.id === edited.id()).sha256, machine.SLOT_SCRIPT_SHA256)
      assert.ok(!probe.slots.some(s => s.id === '4-1'), 'no runner, no beacon')
      assert.equal(probe.heavyBusy, 1)
      // A ticket counts only while a heavy-slot shell runs: this very test may run under one.
      assert.ok(probe.heavyWaiters === 0 || probe.heavyWaiters === 1, String(probe.heavyWaiters))
      assert.equal(typeof probe.room, 'number')
      assert.ok(probe.inputIdleSec === null || Number.isInteger(probe.inputIdleSec))
      assert.ok(probe.procs.some(p => p.pid === ran.self.pid && typeof p.privateBytes === 'number'), 'the stub, a claude.exe, has private bytes')
      assert.ok(!ran.stdout.includes(dirs.script), 'the runner\'s path stays in the script')
    } finally {
      runner.stop()
      edited.stop()
    }
  })

  test("a launch to an idle slot elsewhere, its own run: the record with CreateNew; the runner runs it. A record there already refuses; a beacon idle under 10 s refuses; a slot that isn't running refuses", async () => {
    const dirs = lab()
    const runner = startRunner(dirs, ['-Idle'])
    try {
      await until(() => runner.id() !== undefined, 'the beacon')
      const slot = runner.id()
      /** The machine's own input and memory stand aside: this test is about the slot, and must not depend on the person's keyboard. */
      const steady = script =>
        script
          .replace('$idleMs = [ClaudeSelfToolsInput]::IdleMs()', '$idleMs = 120000')
          .replace('$needBytes = [math]::Max(', '$freeKb = [long]999999999; $needBytes = [math]::Max(')
      const input = (id, change = {}) => ({ powershell: WINDOWS_POWERSHELL, kind: 'start', id, name: 'dealerwrap', folder: dirs.folder, claim: `slot:${slot}`, configDirs: [dirs.config], stateDir: dirs.state, where: { slot }, checks: { floor: true, input: true, fresh: true }, maxSessions: 40, tool: 'coordinator', ...change })
      // Idle under 10 s.
      const soon = randomUUID()
      const early = await underStub({ stub, work, env: envOf(dirs), script: () => steady(machine.launchScriptText(input(soon))) })
      assert.equal(machine.parseLaunch(early.stdout).refused?.code, 'slot', early.stdout + early.stderr)
      assert.match(early.stdout, /less than 10 seconds ago/)
      assert.ok(!existsSync(machine.claimPath(dirs.state, soon)))
      // Idle long enough, by the beacon's own word.
      const beacon = beaconOf(dirs, slot)
      writeFileSync(machine.slotBeaconPath(dirs.state, slot), JSON.stringify({ ...beacon, since: Date.now() - 60_000 }))
      // A record there already refuses, and is left: CreateNew. The runner would take it: a file it can't read yet.
      // The launcher isn't there yet: the launch puts it there, and its record names it.
      rmSync(machine.launchScriptPath(dirs.state))
      const fresh = randomUUID()
      const ran = await underStub({ stub, work, env: envOf(dirs), script: () => steady(machine.launchScriptText(input(fresh))) })
      assert.deepEqual(machine.parseLaunch(ran.stdout).launched, { transport: 'slot', label: slot }, ran.stdout + ran.stderr)
      await until(() => runsOf(dirs).length === 1, `the run\n${runner.out()}`)
      assert.deepEqual(runsOf(dirs)[0].args, ['--session-id', fresh, '--name', 'dealerwrap'])
      assert.ok(existsSync(machine.launchScriptPath(dirs.state)), 'the launch put its copy at its hash\'s name')
      assert.ok(!handCopyRan(dirs), 'and the runner ran that, by the hash the record named')
      // A slot that isn't running.
      const gone = await underStub({ stub, work, env: envOf(dirs), script: () => steady(machine.launchScriptText(input(randomUUID(), { where: { slot: '4-1' }, claim: 'slot:4-1' }))) })
      assert.equal(machine.parseLaunch(gone.stdout).refused?.code, 'slot', gone.stdout + gone.stderr)
    } finally {
      runner.stop()
    }
  })

  test('the launch reads its floor in its own run: free memory under the floor, and the cap, refuse before anything is taken; so does input not idle', async () => {
    const dirs = lab()
    const id = randomUUID()
    const input = change => ({ powershell: WINDOWS_POWERSHELL, kind: 'start', id, name: 'dealerwrap', folder: dirs.folder, claim: `launch:${id}`, configDirs: [dirs.config], stateDir: dirs.state, where: { window: true }, checks: { floor: true, input: true, fresh: true }, tool: 'coordinator', ...change })
    const noWindow = script => script.split('$window = Start-Process').join("throw 'a test never opens a window'; $window = Start-Process")
    const low = await underStub({ stub, work, env: envOf(dirs), script: () => noWindow(machine.launchScriptText(input({}))).replace('$needBytes = [math]::Max(', '$freeKb = [long]1024; $needBytes = [math]::Max(') })
    assert.equal(machine.parseLaunch(low.stdout).refused?.code, 'memory', low.stdout + low.stderr)
    const cap = await underStub({ stub, work, env: envOf(dirs), script: () => noWindow(machine.launchScriptText(input({}))).replace('$needBytes = [math]::Max(', '$freeKb = [long]999999999; $needBytes = [math]::Max(').replace(/\$room -ge 12\b/, '$room -ge 0') })
    assert.equal(machine.parseLaunch(cap.stdout).refused?.code, 'cap', cap.stdout + cap.stderr)
    const typing = await underStub({ stub, work, env: envOf(dirs), script: () => noWindow(machine.launchScriptText(input({ maxSessions: 40 }))).replace('$needBytes = [math]::Max(', '$freeKb = [long]999999999; $needBytes = [math]::Max(').replace('$idleMs = [ClaudeSelfToolsInput]::IdleMs()', '$idleMs = 1000') })
    assert.equal(machine.parseLaunch(typing.stdout).refused?.code, 'input', typing.stdout + typing.stderr)
    assert.ok(!existsSync(machine.claimPath(dirs.state, id)), 'nothing taken')
  })

  test('relockScript: rewrites only a lock naming this launch, adds the holder, keeps the rest; a lock naming another, or none, is left alone', () => {
    const dirs = lab()
    const id = randomUUID()
    const by = `launch:${randomUUID()}`
    const run = input => spawnSync(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', machine.encodeCommand(machine.relockScript(input))], { env: envOf(dirs), encoding: 'utf8', windowsHide: true })
    const holderRef = { pid: 77, created: '134062345678901240' }
    assert.equal(machine.RELOCKED.exec(run({ stateDir: dirs.state, id, by, holder: holderRef }).stdout)?.[1], 'absent')
    const other = lockText(`launch:${randomUUID()}`)
    writeFileSync(machine.claimPath(dirs.state, id), other)
    assert.equal(machine.RELOCKED.exec(run({ stateDir: dirs.state, id, by, holder: holderRef }).stdout)?.[1], 'not-ours')
    assert.equal(readFileSync(machine.claimPath(dirs.state, id), 'utf8'), other)
    const mine = lockText(by)
    writeFileSync(machine.claimPath(dirs.state, id), mine)
    assert.equal(machine.RELOCKED.exec(run({ stateDir: dirs.state, id, by, holder: holderRef }).stdout)?.[1], 'relocked')
    const lock = JSON.parse(readFileSync(machine.claimPath(dirs.state, id), 'utf8'))
    assert.deepEqual(lock.holder, holderRef)
    const was = JSON.parse(mine)
    for (const key of ['v', 'by', 'pid', 'created', 'at', 'transport']) assert.deepEqual(lock[key], was[key], key)
  })
})
