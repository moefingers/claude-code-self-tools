// A return trip in place (#31), the PowerShell side, run for real on Windows against temporary folders
// only. Claude Code's session registry keeps the conversation a process left in place in
// `formerNames[].sessionId`. The probe reports such an id apart (`former`) from one named anywhere else
// (`mentions`), with the one Get-Mentions the in-place last look reads too. The last look, given this
// process (claimCheckScript's `self`), lets its own current registry file name the conversation there,
// with its own left record of it; anything else naming it outside its sessionId still refuses. Every id
// here is fixed and plain; the left key is 32 random bytes made at run time, and the records are MAC'd
// with it here, as leftScript writes them. The claude.exe processes are the stub (scripts/stub.mjs).
// Each test of the last look first passes the return trip, so each fails without the fix. Run with
// `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { compileStub, holder, stubWork } from './stub.mjs'
import { ROOT } from './sync-shared.mjs'

const machine = await import(pathToFileURL(join(ROOT, 'shared', 'hooks', 'machine.ts')).href)
const isWindows = process.platform === 'win32'
const POWERSHELL = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

/** The conversation gone back to, the one held now, and two others. */
const T = '00000000-0000-0000-0000-00000000003a'
const W = '00000000-0000-0000-0000-00000000003b'
const C = '00000000-0000-0000-0000-00000000003c'
const Y = '00000000-0000-0000-0000-00000000003d'
const BY = 'launch:00000000-0000-4000-a000-00000000003e'
const PROJECT = 'C--work-repo'

let work
let env
let self
let other

before(async () => {
  if (!isWindows) return
  work = stubWork('former-names-')
  env = { ...process.env, LOCALAPPDATA: join(work, 'local'), USERPROFILE: join(work, 'home') }
  const stub = compileStub(work)
  // Two running claude.exe: this process (the one that goes back), and another.
  self = await holder({ stub, work, env, ms: 600_000 })
  other = await holder({ stub, work, env, ms: 600_000 })
})

after(() => {
  self?.stop()
  other?.stop()
  // The stubs take a moment to exit and let go of claude.exe.
  if (work !== undefined) rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
})

/** One script run as the plugins run it: powershellCall, the script on standard input. */
function run(script) {
  const call = machine.powershellCall(POWERSHELL, script)
  return new Promise(resolve => {
    const child = spawn(call.argv[0], call.argv.slice(1), { windowsHide: true, env })
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

/** A state folder with a fresh left key, and a config folder with an empty session registry. */
function lab() {
  const root = mkdtempSync(join(work, 'run-'))
  const state = join(root, 'state')
  const config = join(root, 'config')
  mkdirSync(join(state, 'left'), { recursive: true })
  mkdirSync(join(config, 'sessions'), { recursive: true })
  const key = randomBytes(32)
  writeFileSync(join(state, 'left.key'), key)
  /** A registry file, as Claude Code writes one: pid, sessionId, procStart (a string of digits), and `more`. */
  const registry = (pid, sessionId, procStart, more = {}) => writeFileSync(join(config, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: 'C:\\work\\repo', procStart, version: '2.1.320', ...more }))
  /** A left record of T, MAC'd under the key over the text leftScript MACs; `tamper` changes it after. */
  const left = ({ pid, created, how = 'in-place', tamper = r => r }) => {
    const f = { id: T, how, pid: String(pid), created: String(created), at: String(Date.now() - 60_000), dir: config, project: PROJECT, size: '4096', mtime: String(Date.now() - 65_000), by: 'coordinator', go: '' }
    const text = `ac3k-left/1\n${[f.id, f.how, f.pid, f.created, f.at, f.dir, f.project, f.size, f.mtime, f.by, f.go].join('\n')}`
    const mac = createHmac('sha256', key).update(text, 'utf8').digest('hex')
    const record = { v: 1, id: f.id, how: f.how, pid: f.pid, created: f.created, at: f.at, transcript: { dir: f.dir, project: f.project, size: f.size, mtime: f.mtime }, by: f.by, mac }
    writeFileSync(join(state, 'left', `${T}.json`), JSON.stringify(tamper(record)))
  }
  return { state, config, registry, left }
}

/** The in-place last look on T: `absent` when nothing holds it (no claim lock here), else `live <why>`. */
async function lastLook(dirs, me) {
  const ran = await run(machine.claimCheckScript({ stateDir: dirs.state, id: T, by: BY, configDirs: [dirs.config], ...(me === undefined ? {} : { self: me }) }))
  assert.equal(ran.code, 0, ran.stderr)
  const held = machine.CLAIM_CHECK_LIVE.exec(ran.stdout)?.[1]
  return held === undefined ? (machine.CLAIM_CHECKED.exec(ran.stdout)?.[1] ?? `none: ${ran.stdout} ${ran.stderr}`) : `live ${held}`
}

/** The return trip: this process holds W, its formerNames names T, and its own left record of T is there. */
function returnTrip(dirs) {
  dirs.registry(self.pid, W, self.created, { formerNames: [{ sessionId: T, name: 'go-check' }] })
  dirs.left({ pid: self.pid, created: self.created })
}

const outside = pid => `live it may be open elsewhere: the registry file of running Claude Code ${pid} names it outside its sessionId`
/** A FILETIME one second after `created`. */
const later = created => String(BigInt(created) + 10_000_000n)

describe('the probe: a formerNames entry\'s sessionId is `former`; named anywhere else, `mentions`', { skip: !isWindows && 'Windows only' }, () => {
  test('each shape of a registry file, read for real', async () => {
    const dirs = lab()
    const files = {
      101: { formerNames: [{ sessionId: T, name: 'go-check' }] },
      102: { formerNames: [{ sessionId: T, name: `back to ${T}` }] },
      103: { formerNames: [{ sessionId: T.toUpperCase() }] },
      104: { hostSessionId: T },
      105: { formerNames: [{ sessionId: T }, { sessionId: C }] },
      106: { formerNames: { sessionId: T } },
      107: { formerNames: [T] },
      108: { formerNames: [{ sessionId: `x${T}` }] },
      109: { formerNames: [{ sessionId: T, at: { deep: T } }] },
      110: { formerNames: [] },
    }
    for (const [pid, more] of Object.entries(files)) dirs.registry(Number(pid), Y, '1', more)
    // Named only in sessionId, cwd and name: nothing, as before.
    writeFileSync(join(dirs.config, 'sessions', '111.json'), JSON.stringify({ pid: 111, sessionId: T, cwd: `C:\\work\\${T}`, name: T, procStart: '1' }))
    const ran = await run(machine.probeScript({ ids: [T, C], configDirs: [dirs.config] }))
    assert.equal(ran.code, 0, ran.stderr)
    const probe = machine.parseProbe(ran.stdout)
    assert.ok(!('error' in probe), JSON.stringify(probe))
    const said = Object.fromEntries(probe.registry.map(r => [r.file, r.shape === 'ok' ? `former [${r.former.join(' ')}] mentions [${r.mentions.join(' ')}]` : `bad ${r.why}`]))
    assert.deepEqual(said, {
      101: `former [${T}] mentions []`,
      102: `former [${T}] mentions [${T}]`,
      103: `former [] mentions [${T}]`,
      104: `former [] mentions [${T}]`,
      105: `former [${T} ${C}] mentions []`,
      106: `former [] mentions [${T}]`,
      107: `former [] mentions [${T}]`,
      108: `former [] mentions [${T}]`,
      109: `former [${T}] mentions [${T}]`,
      110: 'former [] mentions []',
      111: 'former [] mentions []',
    })
  })
})

describe('the in-place last look of a return trip, given this process', { skip: !isWindows && 'Windows only', concurrency: false }, () => {
  test("this process's own formerNames naming T, with its own left record: nothing holds T; without `self`, refused as before", async () => {
    const dirs = lab()
    returnTrip(dirs)
    assert.equal(await lastLook(dirs, self), 'absent')
    assert.equal(await lastLook(dirs), outside(self.pid))
  })

  test('the same formerNames entry with no left record: refused', async () => {
    const dirs = lab()
    returnTrip(dirs)
    assert.equal(await lastLook(dirs, self), 'absent')
    // The same registry file in a lab with no left record at all; then one that is not a record.
    const bare = lab()
    bare.registry(self.pid, W, self.created, { formerNames: [{ sessionId: T, name: 'go-check' }] })
    assert.equal(await lastLook(bare, self), outside(self.pid))
    writeFileSync(join(bare.state, 'left', `${T}.json`), '{}')
    assert.equal(await lastLook(bare, self), outside(self.pid))
  })

  test('a left record by another process, or by this pid at another start: refused', async () => {
    const dirs = lab()
    returnTrip(dirs)
    assert.equal(await lastLook(dirs, self), 'absent')
    dirs.left({ pid: other.pid, created: other.created })
    assert.equal(await lastLook(dirs, self), outside(self.pid))
    // Another pid at this process's very start: the pid is read, not the start alone.
    dirs.left({ pid: other.pid, created: self.created })
    assert.equal(await lastLook(dirs, self), outside(self.pid))
    dirs.left({ pid: self.pid, created: later(self.created) })
    assert.equal(await lastLook(dirs, self), outside(self.pid))
  })

  test("a left record whose MAC doesn't match, or of another version: refused", async () => {
    const dirs = lab()
    returnTrip(dirs)
    assert.equal(await lastLook(dirs, self), 'absent')
    dirs.left({ pid: self.pid, created: self.created, tamper: r => ({ ...r, at: String(Number(r.at) + 1) }) })
    assert.equal(await lastLook(dirs, self), outside(self.pid))
    dirs.left({ pid: self.pid, created: self.created, tamper: r => ({ ...r, v: 2 }) })
    assert.equal(await lastLook(dirs, self), outside(self.pid))
  })

  test('a self of this pid at another start, its record of that start too: refused (the running process is not it)', async () => {
    const dirs = lab()
    returnTrip(dirs)
    assert.equal(await lastLook(dirs, self), 'absent')
    const claimed = { pid: self.pid, created: later(self.created) }
    dirs.left(claimed)
    assert.equal(await lastLook(dirs, claimed), outside(self.pid))
  })

  test("this process's file naming T in formerNames and anywhere else too: refused", async () => {
    const dirs = lab()
    returnTrip(dirs)
    assert.equal(await lastLook(dirs, self), 'absent')
    dirs.registry(self.pid, W, self.created, { formerNames: [{ sessionId: T, name: 'go-check' }], hostSessionId: T })
    assert.equal(await lastLook(dirs, self), outside(self.pid))
  })

  test('another running process with T in its formerNames: refused, naming it, beside this process\'s own return trip', async () => {
    const dirs = lab()
    returnTrip(dirs)
    assert.equal(await lastLook(dirs, self), 'absent')
    dirs.registry(other.pid, Y, other.created, { formerNames: [{ sessionId: T }] })
    assert.equal(await lastLook(dirs, self), outside(other.pid))
    // With its own left record of T: it isn't this process, so still refused (and this process, whose own
    // record that no longer is, too: whichever file is read first is named).
    dirs.left({ pid: other.pid, created: other.created })
    const said = await lastLook(dirs, self)
    assert.ok([outside(other.pid), outside(self.pid)].includes(said), said)
  })

  test('T in the sessionId of another running process: held (L1), unchanged', async () => {
    const dirs = lab()
    returnTrip(dirs)
    assert.equal(await lastLook(dirs, self), 'absent')
    dirs.registry(other.pid, T, other.created)
    assert.equal(await lastLook(dirs, self), `live it is open elsewhere: Claude Code ${other.pid} holds it (L1)`)
  })
})
