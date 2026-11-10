// The launch scripts the machine code builds (launchScriptText), run for real on Windows (review F5):
// the whole script under the stub claude.exe (scripts/stub.mjs), so that it finds its caller's
// claude.exe by walking up as it does under Claude Code; and the new window's own script, run here in a
// hidden Windows PowerShell exactly as the window runs it (the same bootstrap, -ExecutionPolicy Bypass),
// against claude-launch.ps1 and the stub. Temporary folders only (USERPROFILE, LOCALAPPDATA and the
// config folder), and never a window: no test lets a script reach Start-Process, and each script run
// here has it replaced by a throw besides, or by a function that only records what the window would
// have been started with (recordWindow), so a fault can only fail a test. The last part runs a window's
// launch from end to end, its recorded command run hidden here: PowerShell 7 or 5.1 by the rule, the
// claude wrapper's verified copy, and a restart taken in the same window. Run with
// `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { compileStub, fence, holder, noWindow, recordWindow, underStub, WINDOWS_POWERSHELL, stubWork } from './stub.mjs'
import { ROOT } from './sync-shared.mjs'

const machine = await import(pathToFileURL(join(ROOT, 'shared', 'hooks', 'machine.ts')).href)
const isWindows = process.platform === 'win32'

let work
let stub

before(() => {
  if (!isWindows) return
  work = stubWork('launch-live-')
  stub = compileStub(work)
})

after(() => {
  if (work !== undefined) rmSync(work, { recursive: true, force: true })
})

/** A run's folders: a home whose .local\bin holds the stub, a LOCALAPPDATA and its state folder, a config folder, the conversation's folder. */
function lab() {
  const root = mkdtempSync(join(work, 'run-'))
  const dirs = { root, home: join(root, 'home'), local: join(root, 'local'), config: join(root, 'config'), other: join(root, 'config two'), folder: join(root, 'work folder') }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  mkdirSync(join(dirs.home, '.local', 'bin'), { recursive: true })
  copyFileSync(stub, join(dirs.home, '.local', 'bin', 'claude.exe'))
  return { ...dirs, state: join(dirs.local, 'claude-self-tools') }
}

/** The environment a run gets: the lab's folders only, and the markers Claude Code sets, so what the launcher clears shows. */
function envOf(dirs, extra = {}) {
  const keep = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'CommonProgramFiles']
  const env = {
    ...Object.fromEntries(keep.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])),
    PATH: [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), process.env.SystemRoot ?? 'C:\\Windows', join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0')].join(';'),
    USERPROFILE: dirs.home,
    APPDATA: join(dirs.home, 'AppData', 'Roaming'),
    LOCALAPPDATA: dirs.local,
    CLAUDE_CONFIG_DIR: dirs.config,
    STUB_LOG: join(dirs.root, 'claude-runs.jsonl'),
    STUB_EXIT: '0',
    CLAUDE_PANE_TOKEN: '00000000-0000-4000-a000-0000000000ff',
    ...Object.fromEntries(machine.LAUNCH_ENV_CLEAR.map(name => [name, 'marker-test'])),
    ...extra,
  }
  fence(env, work)
  return env
}

/** The claude runs the stub logged in a lab (the stub claude.exe under .local\bin). */
const runsOf = dirs => {
  const log = join(dirs.root, 'claude-runs.jsonl')
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}

/** A resume's launch into the lab, under a fresh launch's claim. */
const launchInput = (dirs, change = {}) => ({
  powershell: WINDOWS_POWERSHELL,
  kind: 'resume',
  id: change.id ?? randomUUID(),
  folder: dirs.folder,
  claim: `launch:${randomUUID()}`,
  configDirs: [dirs.config],
  stateDir: dirs.state,
  where: { window: true },
  tool: 'self-switch',
  ...change,
})

/** A claim lock as TAKE_CLAIM writes one, naming `by`, by a process that isn't running with that start. */
const claimText = (by, pid) => JSON.stringify({ v: 1, by, pid, created: '1', at: Date.now(), transport: 'window' })

describe('the launch script, run under a stub claude.exe', { skip: !isWindows && 'Windows only', concurrency: 2 }, () => {
  test("this tab: the caller's claude.exe found above it, the claim taken, the ticket written whole, and the wrapper takes it", async () => {
    const dirs = lab()
    const id = randomUUID()
    const token = randomUUID()
    const now = Date.now()
    let input
    const ran = await underStub({
      stub,
      work,
      env: envOf(dirs),
      script: self => {
        input = launchInput(dirs, { id, where: { pane: { token } }, waitForExit: { pid: self.pid, created: self.created }, now, deadline: now + 60_000 })
        return machine.launchScriptText(input)
      },
    })
    assert.match(ran.stdout, new RegExp(`^claim ${input.claim}\\s*$`, 'm'), ran.stdout + ran.stderr)
    assert.match(ran.stdout, new RegExp(`^launched pane ${token}\\s*$`, 'm'))
    assert.deepEqual(machine.parseLaunch(ran.stdout), { launched: { transport: 'pane', label: token }, claim: input.claim })
    const lock = JSON.parse(readFileSync(machine.claimPath(dirs.state, id), 'utf8'))
    assert.equal(lock.by, input.claim)
    assert.equal(lock.pid, ran.self.pid)
    assert.equal(lock.transport, 'pane')
    const taken = machine.checkPaneTicket(readFileSync(machine.paneTicketPath(dirs.state, token), 'utf8'), token, Date.now())
    assert.deepEqual(taken, { ticket: { v: 1, token, resume: id, by: input.claim, dir: dirs.folder, at: now, configDirs: [dirs.config] } })
  })

  test('past its deadline: refused late, and no claim is there', async () => {
    const dirs = lab()
    const id = randomUUID()
    const token = randomUUID()
    const ran = await underStub({
      stub,
      work,
      env: envOf(dirs),
      script: self => machine.launchScriptText(launchInput(dirs, { id, where: { pane: { token } }, waitForExit: { pid: self.pid, created: self.created }, now: Date.now(), deadline: Date.now() - 1000 })),
    })
    assert.equal(machine.parseLaunch(ran.stdout).refused?.code, 'late', ran.stdout + ran.stderr)
    assert.ok(!existsSync(machine.claimPath(dirs.state, id)))
    assert.ok(!existsSync(machine.paneTicketPath(dirs.state, token)))
  })

  test('the claim held by another launch: refused claim, the lock left as it was, no ticket', async () => {
    const dirs = lab()
    const id = randomUUID()
    const token = randomUUID()
    const other = `launch:${randomUUID()}`
    mkdirSync(join(dirs.state, 'claims'), { recursive: true })
    const held = claimText(other, 4)
    writeFileSync(machine.claimPath(dirs.state, id), held)
    const ran = await underStub({
      stub,
      work,
      env: envOf(dirs),
      script: self => machine.launchScriptText(launchInput(dirs, { id, where: { pane: { token } }, waitForExit: { pid: self.pid, created: self.created }, now: Date.now(), deadline: Date.now() + 60_000 })),
    })
    assert.equal(machine.parseLaunch(ran.stdout).refused?.code, 'claim', ran.stdout + ran.stderr)
    assert.equal(readFileSync(machine.claimPath(dirs.state, id), 'utf8'), held)
    assert.ok(!existsSync(machine.paneTicketPath(dirs.state, token)))
  })

  test('a process to wait for that is not the caller: refused wait, nothing taken', async () => {
    const dirs = lab()
    const id = randomUUID()
    const ran = await underStub({
      stub,
      work,
      env: envOf(dirs),
      script: self => machine.launchScriptText(launchInput(dirs, { id, where: { pane: { token: randomUUID() } }, waitForExit: { pid: self.pid, created: '1' }, now: Date.now() })),
    })
    assert.equal(machine.parseLaunch(ran.stdout).refused?.code, 'wait', ran.stdout + ran.stderr)
    assert.ok(!existsSync(machine.claimPath(dirs.state, id)))
  })

  test('a ticket naming two config folders: a tab of pane file version 2 is refused before the claim; version 3 takes it (F4)', async () => {
    for (const [v, code] of [
      [2, 'pane'],
      [3, undefined],
    ]) {
      const dirs = lab()
      const id = randomUUID()
      const token = randomUUID()
      mkdirSync(join(dirs.state, 'panes'), { recursive: true })
      writeFileSync(machine.panePath(dirs.state, token), JSON.stringify({ v, pid: 1, started: '1' }))
      const ran = await underStub({
        stub,
        work,
        env: envOf(dirs),
        script: self => machine.launchScriptText(launchInput(dirs, { id, configDirs: [dirs.config, dirs.other], where: { pane: { token } }, waitForExit: { pid: self.pid, created: self.created }, now: Date.now(), deadline: Date.now() + 60_000 })),
      })
      const answer = machine.parseLaunch(ran.stdout)
      if (code === undefined) {
        assert.equal(answer.launched?.transport, 'pane', ran.stdout + ran.stderr)
      } else {
        assert.equal(answer.refused?.code, code, ran.stdout + ran.stderr)
        assert.match(answer.refused?.why ?? '', /pane file version 3/)
        assert.ok(!existsSync(machine.claimPath(dirs.state, id)), 'refused before the claim')
      }
    }
  })

  test("'auto' with no slot: the launcher put in place at its hash's own name, and the copy for use by hand, before the deadline refuses it (F2)", async () => {
    const dirs = lab()
    const id = randomUUID()
    const ran = await underStub({
      stub,
      work,
      env: envOf(dirs),
      script: self => noWindow(machine.launchScriptText(launchInput(dirs, { id, where: 'auto', waitForExit: { pid: self.pid, created: self.created }, now: Date.now(), deadline: Date.now() - 1000 }))),
    })
    assert.equal(machine.parseLaunch(ran.stdout).refused?.code, 'late', ran.stdout + ran.stderr)
    const installed = machine.launchScriptPath(dirs.state)
    assert.ok(installed.endsWith(`claude-launch-${machine.LAUNCH_SCRIPT_SHA256.slice(0, 8)}.ps1`))
    assert.equal(createHash('sha256').update(readFileSync(installed)).digest('hex'), machine.LAUNCH_SCRIPT_SHA256)
    assert.equal(readFileSync(machine.launchHandPath(dirs.state), 'utf8'), machine.LAUNCH_SCRIPT_TEXT)
    assert.ok(!existsSync(machine.claimPath(dirs.state, id)))
  })

  test("'auto' with the claim held: refused claim after the install, and nothing placed", async () => {
    const dirs = lab()
    const id = randomUUID()
    mkdirSync(join(dirs.state, 'claims'), { recursive: true })
    writeFileSync(machine.claimPath(dirs.state, id), claimText(`launch:${randomUUID()}`, 4))
    const ran = await underStub({
      stub,
      work,
      env: envOf(dirs),
      script: self => noWindow(machine.launchScriptText(launchInput(dirs, { id, where: 'auto', waitForExit: { pid: self.pid, created: self.created }, now: Date.now(), deadline: Date.now() + 60_000 }))),
    })
    assert.equal(machine.parseLaunch(ran.stdout).refused?.code, 'claim', ran.stdout + ran.stderr)
    assert.ok(existsSync(machine.launchScriptPath(dirs.state)))
  })
})

/** The window's own script, out of a launch script: its single-quoted literal, quotes undoubled (as launch.test.ts reads it). */
function innerOf(script) {
  const from = script.indexOf("$inner = '") + "$inner = '".length
  let end = from
  for (let i = from; i < script.length; i += 1) {
    if (script[i] === "'" && script[i + 1] === "'") {
      i += 1
      continue
    }
    if (script[i] === "'") {
      end = i
      break
    }
  }
  assert.ok(end > from, 'the window script is in the launch script')
  return script.slice(from, end).split("''").join("'")
}

/**
 * The window's script, run as Start-Process runs it, but hidden and here: the same unpacking bootstrap
 * (gzip, base64), Windows PowerShell with -NoProfile -ExecutionPolicy Bypass -EncodedCommand. Its Enter
 * prompts are answered on standard input. Its output, its exit code, and the claude runs it made.
 * `onOut`, when given, sees the output so far each time more comes.
 */
function runWindow(inner, dirs, extra = {}, onOut = undefined) {
  const payload = gzipSync(Buffer.from(inner, 'utf8')).toString('base64')
  const unpack = `& ([scriptblock]::Create([IO.StreamReader]::new([IO.Compression.GZipStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String('${payload}')), [IO.Compression.CompressionMode]::Decompress), [Text.Encoding]::UTF8).ReadToEnd()))`
  const encoded = Buffer.from(unpack, 'utf16le').toString('base64')
  const env = envOf(dirs, extra)
  return new Promise(resolve => {
    const child = spawn(WINDOWS_POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { env, cwd: dirs.root, windowsHide: true })
    let out = ''
    const more = chunk => {
      out += chunk
      onOut?.(out)
    }
    child.stdout.on('data', more)
    child.stderr.on('data', more)
    const timer = setTimeout(() => child.kill(), 90_000)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, out, runs: runsOf(dirs) })
    })
    child.stdin.end('\r\n\r\n\r\n')
  })
}

/** A window's launch in the lab, not waiting (no old process here), its claim in place, the launcher installed. */
function windowLab(change = {}) {
  const dirs = lab()
  const input = launchInput(dirs, { checks: { live: true, floor: true, input: true }, heavySlotRoot: null, maxSessions: 12, ...change })
  const inner = innerOf(machine.launchScriptText(input))
  mkdirSync(join(dirs.state, 'claims'), { recursive: true })
  writeFileSync(machine.claimPath(dirs.state, input.id), claimText(input.claim, 4))
  writeFileSync(machine.launchScriptPath(dirs.state), machine.LAUNCH_SCRIPT_TEXT)
  labs.set(input, dirs)
  return { dirs, input, inner }
}

/** The folders of a windowLab, by its input. */
const labs = new Map()
const windowLabDirs = input => labs.get(input)

describe("the window's own script, run as the window runs it (hidden, here)", { skip: !isWindows && 'Windows only', concurrency: 2 }, () => {
  test('claude-launch.ps1 from its hashed name, with every config folder: claude --resume <id> in the folder, the launch environment applied', async () => {
    const { dirs, input, inner } = windowLab()
    const ran = await runWindow(inner, dirs)
    assert.equal(ran.runs.length, 1, ran.out)
    const [only] = ran.runs
    assert.deepEqual(only.args, ['--resume', input.id])
    assert.equal(only.cwd, dirs.folder)
    for (const name of [...machine.LAUNCH_ENV_CLEAR, ...machine.LAUNCH_ENV_DROP]) assert.ok(!only.env.includes(name), `${name} is cleared`)
    assert.equal(only.forceIsOne, true)
    assert.equal(only.reapIsOne, true)
    // The run ended within seconds: the window says how to resume by hand, and waits for Enter.
    assert.match(ran.out, /Claude Code ended \(exit code 0\)\./)
    assert.equal(ran.code, 0)
  })

  test('a launcher whose hash changed after the launch put it there: not run, and the window says so', async () => {
    const { dirs, input, inner } = windowLab()
    writeFileSync(machine.launchScriptPath(dirs.state), `${machine.LAUNCH_SCRIPT_TEXT}# one line more\n`)
    const ran = await runWindow(inner, dirs)
    assert.equal(ran.runs.length, 0, ran.out)
    assert.match(ran.out, /claude-launch\.ps1 is not at .+ with the SHA-256 this plugin ships/)
    assert.ok(!existsSync(machine.claimPath(dirs.state, input.id)), 'a window that refuses gives the claim back (N5)')
    assert.match(ran.out, /Once it is safe, resume it yourself: & '.+claude-launch\.ps1' -Resume [0-9a-f-]{36} -Dir '.+'/)
    assert.equal(ran.code, 1)
  })

  test('a claim that names another launch: not run', async () => {
    const { dirs, input, inner } = windowLab()
    writeFileSync(machine.claimPath(dirs.state, input.id), claimText(`launch:${randomUUID()}`, 4))
    const ran = await runWindow(inner, dirs)
    assert.equal(ran.runs.length, 0, ran.out)
    assert.match(ran.out, /the claim on it no longer names this window/)
    assert.ok(existsSync(machine.claimPath(dirs.state, input.id)), "another's claim is left alone")
  })

  test('a folder that is gone: not run', async () => {
    const { dirs, input, inner } = windowLab()
    rmSync(dirs.folder, { recursive: true, force: true })
    const ran = await runWindow(inner, dirs)
    assert.equal(ran.runs.length, 0, ran.out)
    assert.match(ran.out, /its folder .+ is not there/)
    assert.ok(!existsSync(machine.claimPath(dirs.state, input.id)), 'a window that refuses gives the claim back (N5)')
  })

  test('claude-launch.ps1 that stops on an error is caught: the window says so and how to resume, and waits (F3)', async () => {
    // The script the window runs, hash and all, made to throw: a policy or a locked claude.exe does so.
    const { dirs, input } = windowLab()
    const inner = innerOf(machine.launchScriptText(input)).split('  & $launchPath -Resume').join("  throw 'claude.exe is locked by an update'; & $launchPath -Resume")
    const ran = await runWindow(inner, dirs)
    assert.equal(ran.runs.length, 0, ran.out)
    assert.match(ran.out, /claude-launch\.ps1 stopped on an error, so the session may not have resumed here: claude\.exe is locked by an update/)
    assert.match(ran.out, /Once it is safe, resume it yourself: & '.+claude-launch\.ps1' -Resume [0-9a-f-]{36} -Dir '.+'/)
    assert.equal(ran.code, 1)
  })

  test("D2: the launcher refusing (no claude.exe, its exit 2) or claude ending non-zero gives this launch's claim back; a normal end, even a short one, leaves it", async () => {
    const refused = windowLab()
    rmSync(join(refused.dirs.home, '.local', 'bin', 'claude.exe'))
    const nothing = await runWindow(refused.inner, refused.dirs)
    assert.equal(nothing.runs.length, 0, nothing.out)
    assert.match(nothing.out, /no claude\.exe was found/)
    assert.match(nothing.out, /Claude Code ended \(exit code 2\)\./)
    assert.ok(!existsSync(machine.claimPath(refused.dirs.state, refused.input.id)), `given back\n${nothing.out}`)
    assert.equal(nothing.code, 2, nothing.out)
    const ended = windowLab()
    const seven = await runWindow(ended.inner, ended.dirs, { STUB_EXIT: '7' })
    assert.equal(seven.runs.length, 1, seven.out)
    assert.ok(!existsSync(machine.claimPath(ended.dirs.state, ended.input.id)), `given back\n${seven.out}`)
    assert.equal(seven.code, 7, seven.out)
    const normal = windowLab()
    const zero = await runWindow(normal.inner, normal.dirs)
    assert.equal(zero.code, 0, zero.out)
    assert.ok(existsSync(machine.claimPath(normal.dirs.state, normal.input.id)), `left\n${zero.out}`)
  })
})

describe('S3: the window waits for the old process by its handle, keeps waiting, and records a refusal', { skip: !isWindows && 'Windows only', concurrency: 2 }, () => {
  /** The window's first wait, shortened from 10 minutes to 2 seconds for the test: nothing else changes. */
  /** The window's looks, shortened from 30 s to 1 s, and its 10-minute line to 2 s, for the test: nothing else changes. */
  const shortWait = (inner, waitFor) => {
    const look = `$gone = Wait-Gone ${waitFor.pid} '${waitFor.created}' ${machine.WAIT_POLL_SECONDS}`
    const long = `$waitClock.Elapsed.TotalSeconds -ge ${machine.WAIT_SECONDS}`
    assert.ok(inner.includes(look) && inner.includes(long), 'the wait lines as the window has them')
    return inner.split(look).join(`$gone = Wait-Gone ${waitFor.pid} '${waitFor.created}' 1`).split(long).join('$waitClock.Elapsed.TotalSeconds -ge 2')
  }

  test('a process that outlasts the first wait is waited for until it goes, and then the session resumes (no refusal, no giving up)', async () => {
    const dirs = lab()
    // Kept running until the window has said it keeps waiting, however long the window takes to start
    // under load; stopped then, so the wait ends because the process went.
    const old = await holder({ stub, work, env: envOf(dirs), ms: 60_000 })
    try {
      const { inner, input } = windowLab({ waitForExit: { pid: old.pid, created: old.created }, checks: {} })
      void dirs
      const ran = await runWindow(shortWait(inner, { pid: old.pid, created: old.created }), windowLabDirs(input), {}, out => {
        if (out.includes('It has not exited after')) old.stop()
      })
      assert.match(ran.out, /It has not exited after 10 minutes\. This window keeps waiting while the move that opened it stands, and resumes the session when it goes\./)
      assert.doesNotMatch(ran.out, /still running/)
      assert.equal(ran.runs.length, 1, ran.out)
      assert.deepEqual(ran.runs[0].args, ['--resume', input.id])
    } finally {
      old.stop()
    }
  })

  test('a process id the system gave to another process is not the one waited for: no wait, the session resumes', async () => {
    const dirs = lab()
    const other = await holder({ stub, work, env: envOf(dirs), ms: 60_000 })
    try {
      // Its start time an hour off: the pid is another process's now.
      const waitFor = { pid: other.pid, created: String(BigInt(other.created) - 36_000_000_000n) }
      const { inner, input } = windowLab({ waitForExit: waitFor, checks: {} })
      const started = Date.now()
      const ran = await runWindow(inner, windowLabDirs(input))
      assert.equal(ran.runs.length, 1, ran.out)
      assert.ok(Date.now() - started < 60_000, 'no wait for the pid')
    } finally {
      other.stop()
    }
  })

  test('R4: a move taken back while the window waits (its claim released) ends the wait at once: refused, said and recorded', async () => {
    const dirs = lab()
    const old = await holder({ stub, work, env: envOf(dirs), ms: 60_000 })
    try {
      const waitFor = { pid: old.pid, created: old.created }
      const waiting = windowLab({ waitForExit: waitFor, checks: {} })
      const running = runWindow(shortWait(waiting.inner, waitFor), waiting.dirs)
      // A few looks in, the switch is taken back: its claim released.
      await new Promise(resolve => setTimeout(resolve, 5000))
      rmSync(machine.claimPath(waiting.dirs.state, waiting.input.id), { force: true })
      const taken = Date.now()
      const ran = await running
      assert.ok(Date.now() - taken < 20_000, `the wait ended at once, not when the old process went\n${ran.out}`)
      assert.equal(ran.runs.length, 0, ran.out)
      assert.match(ran.out, /the claim on it no longer names this window/)
      assert.match(machine.readRefused(readFileSync(machine.refusedPath(waiting.dirs.state, waiting.input.id), 'utf8'))?.why ?? '', /no longer names this window/)
    } finally {
      old.stop()
    }
  })

  test('R3 (delta): a claim that cannot be read for a moment (held open by a writer) keeps the window waiting; it resumes when the old process goes', async () => {
    const dirs = lab()
    const old = await holder({ stub, work, env: envOf(dirs), ms: 9000 })
    try {
      const waitFor = { pid: old.pid, created: old.created }
      const waiting = windowLab({ waitForExit: waitFor, checks: {} })
      const claim = machine.claimPath(waiting.dirs.state, waiting.input.id)
      // A writer holds the lock open, sharing nothing, for 4 seconds of the wait's looks.
      const blocker = spawn(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `$s = [IO.File]::Open('${claim}', 'Open', 'ReadWrite', 'None'); Start-Sleep -Seconds 4; $s.Dispose()`], { windowsHide: true, stdio: 'ignore' })
      const ran = await runWindow(shortWait(waiting.inner, waitFor), waiting.dirs)
      blocker.kill()
      assert.doesNotMatch(ran.out, /no longer names this window/)
      assert.equal(ran.runs.length, 1, ran.out)
    } finally {
      old.stop()
    }
  })

  test('a refusal and an error are recorded at refused\\<id>.json for whoever comes looking; a run that resumes records none', async () => {
    const refused = windowLab()
    writeFileSync(machine.launchScriptPath(refused.dirs.state), `${machine.LAUNCH_SCRIPT_TEXT}# one line more\n`)
    await runWindow(refused.inner, refused.dirs)
    const record = machine.readRefused(readFileSync(machine.refusedPath(refused.dirs.state, refused.input.id), 'utf8'))
    assert.ok(record !== undefined, 'a record of its shape')
    assert.equal(record.id, refused.input.id)
    assert.equal(record.kind, 'resume')
    assert.equal(record.by, refused.input.claim)
    assert.equal(record.folder, refused.input.folder)
    assert.match(record.why, /claude-launch\.ps1 is not at .+ with the SHA-256 this plugin ships/)
    const threw = windowLab()
    const inner = threw.inner.split('  & $launchPath -Resume').join("  throw 'claude.exe is locked by an update'; & $launchPath -Resume")
    await runWindow(inner, threw.dirs)
    assert.match(machine.readRefused(readFileSync(machine.refusedPath(threw.dirs.state, threw.input.id), 'utf8'))?.why ?? '', /stopped on an error: claude\.exe is locked by an update/)
    const fine = windowLab()
    await runWindow(fine.inner, fine.dirs)
    assert.ok(!existsSync(machine.refusedPath(fine.dirs.state, fine.input.id)), 'none for a run that resumed')
  })
})

// ---------------------------------------------------------------------------------------------
// A window's launch from end to end: the launch script run under the stub as a restart runs it (it waits
// for its caller), its Start-Process a recording function (stub.mjs's recordWindow: it opens nothing), and
// then the very command the window would have been started with, run here hidden: the interpreter the
// launch chose, the window script, claude-launch.ps1 -Wrapper, the claude wrapper's verified copy the
// launch put in place, and the stub as claude. The stub, as self-restart would, runs the probe under itself
// and leaves the wrapper a ticket, so the restart from that window is taken in that window.

const PWSH = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
const hasPwsh = existsSync(PWSH)
const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows'
/** The token a ticket is built with before the stub puts the tab's own in its place. */
const PLACEHOLDER = '00000000-0000-4000-8000-000000000000'
/** Where the launch script reads the Program Files folder: Windows' own name for it, never a variable. */
const PROGRAM_FILES = "[Environment]::GetFolderPath('ProgramFiles')"
/** The part of the interpreter rule that holds pwsh.exe's path to its shape. */
const SHAPE = `$pwsh -cmatch '${machine.PWSH_PATH.source.replace(/\$$/, '\\z')}'`
/** The line of the interpreter rule that holds pwsh.exe to version 7 or later. */
const VERSION = 'if ($pwshOk) { try { $pwshOk = [Diagnostics.FileVersionInfo]::GetVersionInfo($pwsh).FileMajorPart -ge 7 } catch { $pwshOk = $false } }'

/**
 * A launch script whose Program Files folder is `folder` (a test can't change Windows' own): the one place
 * the interpreter rule reads it, made a literal. With `aside` ('shape' or 'version'), that check of the
 * rule is set aside too, so the other is all that stands.
 */
function withProgramFiles(script, folder, aside = undefined) {
  assert.equal(script.split(PROGRAM_FILES).length, 2, 'the interpreter rule reads the Program Files folder once')
  assert.ok(!/['"]/.test(folder))
  const placed = script.split(PROGRAM_FILES).join(`'${folder}'`)
  if (aside === undefined) return placed
  const [check, instead] = aside === 'shape' ? [SHAPE, "$pwsh -cmatch '.'"] : [VERSION, '']
  assert.equal(placed.split(check).length, 2, `the ${aside} check is there once`)
  return placed.split(check).join(instead)
}

/** The launch of a window that resumes `id` in its folder, run under the stub, its Start-Process recorded: the answer, the input, and what the window was given. */
async function launchWindow(dirs, id, extra, change = script => script) {
  const record = join(dirs.root, 'window.json')
  let input
  const ran = await underStub({
    stub,
    work,
    env: envOf(dirs, extra),
    script: self => {
      input = launchInput(dirs, { id, waitForExit: { pid: self.pid, created: self.created }, now: Date.now(), deadline: Date.now() + 60_000, tool: 'self-restart' })
      return recordWindow(change(machine.launchScriptText(input)), record)
    },
  })
  return { ran, input, answer: machine.parseLaunch(ran.stdout), window: existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : undefined }
}

/**
 * The recorded window's command run here, hidden, as Start-Process would have started it. Its Enter prompts
 * are answered at once; or, with `enterAfter`, only once the output matches it and the window is still
 * running 1.5 s later (`waited`): a window that waits for Enter is still there, one that closed on it isn't.
 */
function openRecorded(window, dirs, extra, enterAfter = undefined) {
  const env = envOf(dirs, extra)
  return new Promise(resolve => {
    const child = spawn(window.file, window.args, { env, cwd: dirs.root, windowsHide: true })
    let out = ''
    let waited = false
    let answered = false
    const more = chunk => {
      out += chunk
      if (enterAfter === undefined || answered || !enterAfter.test(out)) return
      answered = true
      setTimeout(() => {
        waited = child.exitCode === null
        child.stdin.end('\r\n\r\n\r\n')
      }, 1500)
    }
    child.stdout.on('data', more)
    child.stderr.on('data', more)
    const timer = setTimeout(() => child.kill(), 150_000)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, out, runs: runsOf(dirs), pid: child.pid, waited })
    })
    if (enterAfter === undefined) child.stdin.end('\r\n\r\n\r\n')
  })
}

/** A ticket the plugins write (paneTicket), for the stub to leave: {TOKEN} for the tab's token, "{NOW}" (or `at`) for its time. */
const ticketOf = (resume, by, dir, configDirs, at = '{NOW}') => {
  const built = JSON.parse(machine.paneTicket({ token: PLACEHOLDER, resume, by, dir, at: 1, configDirs }))
  return JSON.stringify({ ...built, token: '{TOKEN}', at })
}

/**
 * A restart's window, end to end: `programFiles` (the real one, or the Windows folder, of the standard
 * shape and with no PowerShell 7 in it), `restricted` (a Restricted execution policy for these processes
 * alone), `copy` ('ok', 'missing', 'changed': the wrapper's copy as the launch left it, or not), `plan` (the
 * tickets the stub leaves, by run, given the run's folders and the launch's input; by default one for the
 * same conversation, as self-restart would), `holdOther` (another claude.exe naming the second
 * conversation on its command line, all along), `enterAfter` (see openRecorded), `probe` (the stub runs
 * the probe under itself at each run), `exit` (each claude run's exit code).
 */
async function windowRun({ programFiles = 'real', restricted = false, copy = 'ok', plan = (r, input) => ({ 1: ticketOf(r.id, input.claim, r.dirs.folder, [r.dirs.config]) }), holdOther = false, enterAfter = undefined, probe = true, exit = '0' } = {}) {
  const dirs = lab()
  const id = randomUUID()
  const other = randomUUID()
  const otherFolder = join(dirs.root, 'other folder')
  mkdirSync(otherFolder)
  for (const [conversation, folder] of [
    [id, dirs.folder],
    [other, otherFolder],
  ]) {
    mkdirSync(join(dirs.config, 'projects', machine.projectName(folder)), { recursive: true })
    writeFileSync(join(dirs.config, 'projects', machine.projectName(folder), `${conversation}.jsonl`), '')
  }
  const extra = restricted ? { PSExecutionPolicyPreference: 'Restricted' } : {}
  // 'none': the Windows folder, of the standard shape (a drive and one folder) and with no PowerShell 7 in
  // it, so only the check that pwsh.exe is there turns the window to Windows PowerShell.
  if (programFiles !== 'real') assert.ok(machine.PWSH_PATH.test(machine.pwshPath(SYSTEM_ROOT)) && !existsSync(machine.pwshPath(SYSTEM_ROOT)), `${SYSTEM_ROOT} is of the shape, with no PowerShell 7 in it`)
  const launched = await launchWindow(dirs, id, extra, programFiles === 'real' ? undefined : script => withProgramFiles(script, SYSTEM_ROOT))
  const wrapperCopy = machine.wrapperScriptPath(dirs.state)
  const installed = existsSync(wrapperCopy) ? readFileSync(wrapperCopy) : undefined
  if (copy === 'missing') rmSync(wrapperCopy, { force: true })
  if (copy === 'changed') writeFileSync(wrapperCopy, `${machine.WRAPPER_SCRIPT_TEXT}# one line more\n`)
  // The stub, as self-restart would: the probe under itself, then a ticket for the wrapper.
  const planDir = join(dirs.root, 'plan')
  mkdirSync(planDir)
  for (const [n, text] of Object.entries(plan({ dirs, id, other, otherFolder }, launched.input))) writeFileSync(join(planDir, `${n}.json`), text)
  const probeIn = join(dirs.root, 'probe.ps1')
  writeFileSync(probeIn, machine.probeScript({ ids: [id, other], configDirs: [dirs.config] }))
  const call = machine.powershellCall(WINDOWS_POWERSHELL, '')
  const stubExtra = {
    STUB_PLAN: planDir,
    STUB_EXIT: exit,
    ...(probe ? { STUB_CHILD_EXE: call.argv[0], STUB_CHILD_ARGS: call.argv.slice(1).join(' '), STUB_CHILD_STDIN: probeIn, STUB_CHILD_OUT: join(dirs.root, 'probe-{RUN}.out'), STUB_CHILD_ERR: join(dirs.root, 'probe-{RUN}.err') } : {}),
  }
  const held = holdOther ? await holder({ stub, work, env: envOf(dirs), args: ['--resume', other], ms: 120_000 }) : undefined
  try {
    const opened = launched.window === undefined ? undefined : await openRecorded(launched.window, dirs, { ...extra, ...stubExtra }, enterAfter)
    const probeOf = n => {
      const path = join(dirs.root, `probe-${n}.out`)
      return existsSync(path) ? machine.parseProbe(readFileSync(path, 'utf8')) : { error: 'no probe output' }
    }
    return { dirs, id, other, otherFolder, launched, installed, opened, probeOf, held }
  } finally {
    held?.stop()
  }
}

/** A claim lock as a move's launch takes one, naming `by`, for the stub's ticket to a second conversation. */
const lockFor = (dirs, id, by) => {
  mkdirSync(join(dirs.state, 'claims'), { recursive: true })
  writeFileSync(machine.claimPath(dirs.state, id), claimText(by, 4))
}

/** Two FILETIMEs within 1 ms, as the plugins compare a pane file's start with its process's. */
const nearTicks = (a, b) => BigInt(a) - BigInt(b) <= 10_000n && BigInt(b) - BigInt(a) <= 10_000n

describe("a window's launch, end to end: the interpreter it chose, the wrapper's verified copy, and the restart from it in the same window", { skip: !isWindows && 'Windows only', concurrency: 2 }, () => {
  test(`PowerShell 7 at its standard path${hasPwsh ? '' : ' (not on this machine: Windows PowerShell)'}: the window runs in it, claude right under it through the wrapper, and its restart comes back in it (pane)`, async () => {
    const r = await windowRun()
    const shell = hasPwsh ? PWSH : WINDOWS_POWERSHELL
    assert.equal(r.launched.answer.launched?.transport, 'window', r.launched.ran.stdout + r.launched.ran.stderr)
    // (c) The interpreter rule, and the command as ever: -NoProfile, Bypass for the window's scripts, the fixed bootstrap.
    assert.equal(r.launched.window.file.toLowerCase(), shell.toLowerCase())
    assert.deepEqual(r.launched.window.args.slice(0, 4), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
    // The wrapper's copy put in place by the launch, at its hash's name, byte for byte.
    assert.equal(r.installed?.toString('utf8'), machine.WRAPPER_SCRIPT_TEXT)
    assert.equal(createHash('sha256').update(r.installed).digest('hex'), machine.WRAPPER_SCRIPT_SHA256)
    const { opened } = r
    assert.equal(opened.runs.length, 2, opened.out)
    const [first, second] = opened.runs
    // (a) claude.exe right under the window's PowerShell, a fresh token, the pane file (version 3, hosted) naming that process.
    assert.deepEqual(first.args, ['--resume', r.id])
    assert.equal(first.cwd, r.dirs.folder)
    assert.equal(first.parent?.pid, opened.pid, 'claude.exe runs right under the window')
    assert.equal(first.parent?.path?.toLowerCase(), shell.toLowerCase())
    assert.ok(first.token !== null && first.token !== '00000000-0000-4000-a000-0000000000ff', `a fresh CLAUDE_PANE_TOKEN (${first.token})`)
    const pane = machine.parsePane(first.pane ?? '')
    assert.ok(!('why' in pane) && pane.v === 3 && pane.pid === opened.pid && pane.hosted === true, `the pane file names the window, hosted (${first.pane})`)
    assert.ok(nearTicks(pane.started, first.parent.created), 'by its start too')
    // (d) The launch environment, NO_COLOR and the rest cleared; the token the wrapper's own.
    for (const name of [...machine.LAUNCH_ENV_CLEAR, 'PSExecutionPolicyPreference']) assert.ok(!first.env.includes(name), `${name} is cleared`)
    assert.ok(first.forceIsOne && first.reapIsOne)
    assert.ok(first.env.includes('CLAUDE_PANE_TOKEN'))
    // (e) The probe the restart would take, run under that claude.exe: this tab, by pickLaunchTransport and pickTransport alike.
    const probe = r.probeOf(1)
    assert.ok(!('error' in probe), JSON.stringify(probe))
    assert.equal(machine.paneFallback(probe, pane), undefined)
    assert.deepEqual(machine.pickLaunchTransport(probe, null, { replacing: true, pane: { token: first.token, pane }, configCount: 1, needsLeft: false }), { where: { pane: { token: first.token } } })
    assert.deepEqual(machine.pickTransport(probe, r.id, r.other, r.otherFolder, { token: first.token, pane }), { transport: 'pane', token: first.token, folder: r.otherFolder })
    // The restart itself: the ticket the plugins write (paneTicket, version 1), read by the window's copy, resumed in the same window.
    assert.deepEqual(second.args, ['--resume', r.id])
    assert.equal(second.parent?.pid, opened.pid, 'the restart runs in the same window')
    assert.equal(second.token, first.token)
    assert.equal(second.pane, first.pane)
    assert.equal(second.ticketPresent, false)
    assert.ok(opened.out.includes(`Resuming ${r.id} here, in ${r.dirs.folder}.`), opened.out)
    assert.ok(!opened.out.includes('the claude wrapper is not used'), opened.out)
  })

  test('no PowerShell 7 at its standard path, and a Restricted execution policy for these processes alone: the window is Windows PowerShell 5.1, and the wrapper works all the same', async () => {
    const r = await windowRun({ programFiles: 'none', restricted: true })
    assert.equal(r.launched.answer.launched?.transport, 'window', r.launched.ran.stdout + r.launched.ran.stderr)
    assert.equal(r.launched.window.file.toLowerCase(), WINDOWS_POWERSHELL.toLowerCase())
    const { opened } = r
    assert.equal(opened.runs.length, 2, opened.out)
    const [first, second] = opened.runs
    assert.equal(first.parent?.pid, opened.pid)
    assert.equal(first.parent?.path?.toLowerCase(), WINDOWS_POWERSHELL.toLowerCase())
    const pane = machine.parsePane(first.pane ?? '')
    assert.ok(!('why' in pane) && pane.pid === opened.pid, `the pane file names the window (${first.pane})`)
    assert.ok(!first.env.includes('PSExecutionPolicyPreference'), "the window's policy never reaches claude")
    assert.deepEqual(machine.pickLaunchTransport(r.probeOf(1), null, { replacing: true, pane: { token: first.token, pane }, configCount: 1, needsLeft: false }), { where: { pane: { token: first.token } } })
    assert.equal(second.parent?.pid, opened.pid, 'the restart runs in the same window')
    assert.deepEqual(second.args, ['--resume', r.id])
  })

  test("a pwsh.exe under a Program Files folder not of the standard shape (a drive and one folder) is never the window's interpreter (the version check set aside, so the shape check stands alone)", async () => {
    const dirs = lab()
    // A file named pwsh.exe, where a folder deep in the temporary folder would put PowerShell 7: never run (the window is only recorded).
    // Not a program, so the version check would turn it away too: set aside, the shape check alone has to.
    const odd = mkdtempSync(join(work, 'odd-pf-'))
    mkdirSync(join(odd, 'PowerShell', '7'), { recursive: true })
    writeFileSync(join(odd, 'PowerShell', '7', 'pwsh.exe'), 'not a program')
    assert.ok(!machine.PWSH_PATH.test(machine.pwshPath(odd)))
    const launched = await launchWindow(dirs, randomUUID(), {}, script => withProgramFiles(script, odd, 'version'))
    assert.equal(launched.answer.launched?.transport, 'window', launched.ran.stdout + launched.ran.stderr)
    assert.equal(launched.window.file.toLowerCase(), WINDOWS_POWERSHELL.toLowerCase())
  })

  test('a pwsh.exe whose version is under 7 is never the window\'s interpreter (the shape check set aside, so the version check stands alone)', async () => {
    const dirs = lab()
    // The stub claude.exe, a program of version 0, where PowerShell 7 would be: never run (the window is only recorded).
    const old = mkdtempSync(join(work, 'old-pf-'))
    mkdirSync(join(old, 'PowerShell', '7'), { recursive: true })
    copyFileSync(stub, join(old, 'PowerShell', '7', 'pwsh.exe'))
    const launched = await launchWindow(dirs, randomUUID(), {}, script => withProgramFiles(script, old, 'shape'))
    assert.equal(launched.answer.launched?.transport, 'window', launched.ran.stdout + launched.ran.stderr)
    assert.equal(launched.window.file.toLowerCase(), WINDOWS_POWERSHELL.toLowerCase())
  })

  test("the wrapper's copy held open by another process while the launch puts it in place: the launch is never refused on it", async () => {
    const dirs = lab()
    const copy = machine.wrapperScriptPath(dirs.state)
    mkdirSync(dirs.state, { recursive: true })
    const ready = join(dirs.root, 'held.ready')
    // A writer that shares nothing, for the length of the launch: reading the copy's hash throws.
    const blocker = spawn(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `$s = [IO.File]::Open('${copy}', 'OpenOrCreate', 'ReadWrite', 'None'); [IO.File]::WriteAllText('${ready}', 'held'); Start-Sleep -Seconds 30; $s.Dispose()`], { windowsHide: true, stdio: 'ignore' })
    try {
      const end = Date.now() + 20_000
      while (!existsSync(ready) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 100))
      assert.ok(existsSync(ready), 'the copy is held')
      const launched = await launchWindow(dirs, randomUUID(), {})
      assert.equal(launched.answer.launched?.transport, 'window', launched.ran.stdout + launched.ran.stderr)
    } finally {
      blocker.kill()
    }
  })

  test("a switch from the window into another project's conversation: resumed in the same window, in that conversation's folder; the closing lines name it, not the window's first", async () => {
    // Each run ends with 1, so the window says how to resume by hand however long the runs took.
    const r = await windowRun({
      plan: (x, input) => {
        lockFor(x.dirs, x.other, input.claim)
        return { 1: ticketOf(x.other, input.claim, x.otherFolder, [x.dirs.config]) }
      },
      probe: false,
      exit: '1',
    })
    const { opened } = r
    assert.equal(opened.runs.length, 2, opened.out)
    const [first, second] = opened.runs
    assert.deepEqual(second.args, ['--resume', r.other])
    assert.equal(second.cwd, r.otherFolder)
    assert.equal(second.parent?.pid, opened.pid, 'in the same window')
    assert.equal(second.pane, first.pane)
    // Both runs end within seconds: the window says how to resume by hand, the conversation it resumed last.
    assert.ok(opened.out.includes(`-Resume ${r.other} -Dir '${r.otherFolder}'`), opened.out)
    assert.ok(!opened.out.includes(`-Resume ${r.id} `), opened.out)
  })

  for (const [name, setup] of [
    ['too old (an /exit held past 120 seconds)', { plan: (x, input) => ({ 1: ticketOf(x.id, input.claim, x.dirs.folder, [x.dirs.config], '{OLD}') }), why: /its time is not within the last 120 seconds/, conversation: x => x.id }],
    ['past the guard of 3 resumes within 30 seconds', { plan: (x, input) => Object.fromEntries([1, 2, 3, 4].map(n => [n, ticketOf(x.id, input.claim, x.dirs.folder, [x.dirs.config])])), why: /this tab resumed 3 times within 30 seconds/, conversation: x => x.id, runs: 4 }],
    [
      'for a conversation open elsewhere (L2)',
      {
        plan: (x, input) => {
          lockFor(x.dirs, x.other, input.claim)
          return { 1: ticketOf(x.other, input.claim, x.otherFolder, [x.dirs.config]) }
        },
        holdOther: true,
        why: /it is open elsewhere: process \d+ names it on its command line \(L2\)/,
        conversation: x => x.other,
      },
    ],
  ]) {
    test(`a ticket the window's wrapper doesn't use, ${name}: the reason shown, the refusal recorded for that conversation, its claim given back, and the window kept open`, async () => {
      const r = await windowRun({ plan: setup.plan, holdOther: setup.holdOther === true, enterAfter: /was not resumed in this window/, probe: false })
      const { opened } = r
      const id = setup.conversation(r)
      assert.equal(opened.runs.length, setup.runs ?? 1, opened.out)
      // The wrapper's own line, the reason.
      assert.match(opened.out, new RegExp(`claude: the ticket to resume a session in this tab was not used: ${setup.why.source}`))
      // The window's line, and its wait for Enter: still there 1.5 s after it.
      assert.match(opened.out, new RegExp(`Session ${id} was not resumed in this window \\(${setup.why.source}\\)\\. The refusal is recorded at .+refused\\\\${id}\\.json\\.`))
      assert.equal(opened.waited, true, 'the window waited for Enter')
      assert.equal(opened.code, machine.WRAPPER_UNUSED_EXIT)
      const record = machine.readRefused(readFileSync(machine.refusedPath(r.dirs.state, id), 'utf8'))
      assert.ok(record !== undefined, 'a refused record of its shape')
      assert.equal(record.id, id)
      assert.equal(record.kind, 'resume')
      assert.equal(record.by, r.launched.input.claim)
      assert.match(record.why, /^the claude wrapper did not use the ticket to resume it in this window: /)
      assert.match(record.why, setup.why)
      // The move's claim on that conversation, given back: it named the ticket's.
      assert.ok(!existsSync(machine.claimPath(r.dirs.state, id)), 'the claim is given back')
    })
  }

  for (const copy of ['missing', 'changed']) {
    test(`the wrapper's copy ${copy === 'missing' ? 'gone' : 'changed'} after the launch put it there: claude starts directly in the window, and the window says why`, async () => {
      const r = await windowRun({ copy, plan: () => ({}), probe: false })
      const { opened } = r
      assert.equal(opened.runs.length, 1, opened.out)
      const [only] = opened.runs
      assert.deepEqual(only.args, ['--resume', r.id])
      assert.equal(only.parent?.pid, opened.pid)
      assert.equal(only.token, null)
      assert.equal(only.pane, null)
      const why = copy === 'missing' ? /its verified copy is not at .+claude-wrapper-[0-9a-f]{8}\.ps1/ : /is not the copy this launcher pins \(another SHA-256\)/
      const said = opened.out.split(/\r?\n/).filter(line => line.startsWith('claude-launch: the claude wrapper is not used: '))
      assert.equal(said.length, 1, opened.out)
      assert.match(said[0], why)
      assert.match(said[0], /\. Claude starts directly, so a restart from this session opens in a new window or tab\.$/)
    })
  }
})
