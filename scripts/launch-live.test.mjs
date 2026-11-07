// The launch scripts the machine code builds (launchScriptText), run for real on Windows (review F5):
// the whole script under the stub claude.exe (scripts/stub.mjs), so that it finds its caller's
// claude.exe by walking up as it does under Claude Code; and the new window's own script, run here in a
// hidden Windows PowerShell exactly as the window runs it (the same bootstrap, -ExecutionPolicy Bypass),
// against claude-launch.ps1 and the stub. Temporary folders only (USERPROFILE, LOCALAPPDATA and the
// config folder), and never a window: no test lets a script reach Start-Process, and each script run
// here has it replaced by a throw besides, so a fault can only fail a test. Run with
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
import { compileStub, fence, noWindow, underStub, WINDOWS_POWERSHELL } from './stub.mjs'
import { ROOT } from './sync-shared.mjs'

const machine = await import(pathToFileURL(join(ROOT, 'shared', 'hooks', 'machine.ts')).href)
const isWindows = process.platform === 'win32'

let work
let stub

before(() => {
  if (!isWindows) return
  work = mkdtempSync(join(tmpdir(), 'launch-live-'))
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
 */
function runWindow(inner, dirs, extra = {}) {
  const payload = gzipSync(Buffer.from(inner, 'utf8')).toString('base64')
  const unpack = `& ([scriptblock]::Create([IO.StreamReader]::new([IO.Compression.GZipStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String('${payload}')), [IO.Compression.CompressionMode]::Decompress), [Text.Encoding]::UTF8).ReadToEnd()))`
  const encoded = Buffer.from(unpack, 'utf16le').toString('base64')
  const env = envOf(dirs, extra)
  return new Promise(resolve => {
    const child = spawn(WINDOWS_POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { env, cwd: dirs.root, windowsHide: true })
    let out = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (out += chunk))
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
  return { dirs, input, inner }
}

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
