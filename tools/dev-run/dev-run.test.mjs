// dev-run's tests, against a fake dev server (fixtures/fake-server.mjs) that prints Next-style
// request lines. The memory reader, the clock and the heavy-slot claim are injected: the clock moves
// only when the runner sleeps, and stands still while a fake server starts or answers, so ten
// minutes pass in about a second. One test runs the real heavy-slot.sh, in a slot folder of its own.
// Each planted fault is a copy of dev-run.mjs with one line changed, run through the same scenario,
// which must fail. Run with `node --test tools/dev-run/dev-run.test.mjs`.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as real from './dev-run.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEV_RUN = join(HERE, 'dev-run.mjs')
const FIXTURES = join(HERE, 'fixtures')
const FAKE = join(FIXTURES, 'fake-server.mjs')
const SLEEPER = join(FIXTURES, 'sleeper.mjs')
const TMP = mkdtempSync(join(tmpdir(), 'dev-run-test-'))
const REQUEST = /^\s*GET \S+ 200 in/
const MIN = 60_000
const skip = process.platform !== 'win32' && 'dev-run is Windows only'
after(() => rmSync(TMP, { recursive: true, force: true }))

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(cond, what, ms = 20_000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await delay(5)
  }
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer().on('error', rej)
    s.listen(0, () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })
}

// Time moves only in sleep(); hold() stops it until the returned function is called.
function clock() {
  let t = Date.UTC(2026, 0, 1)
  let holds = 0
  const waiters = []
  const c = {
    limit: Infinity,
    onLimit: null,
    now: () => t,
    async sleep(ms) {
      while (holds > 0) await new Promise(r => waiters.push(r))
      t += ms
      if (t >= c.limit && c.onLimit) {
        const f = c.onLimit
        c.onLimit = null
        f()
      }
      await delay(1)
    },
    hold() {
      holds++
      let done = false
      const free = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (--holds === 0) waiters.splice(0).forEach(r => r())
      }
      const timer = setTimeout(free, 15_000)
      return free
    },
    releaseAll() {
      holds = 0
      waiters.splice(0).forEach(r => r())
    },
  }
  return c
}

// The code under test runs its own exec, but a stop script runs only when it is exactly dev-run's
// by-id script, and every process it names is one this test started. Read-only calls pass.
function guardedExec(mod, ours, runs) {
  return (file, args) => {
    const script = String(args.at(-1))
    if (/taskkill/i.test(file) || (/powershell/i.test(file) && /Stop-Process|\.Kill\(|\$targets/.test(script))) {
      const targets = [...script.matchAll(/'(\d+):(\d+)'/g)].map(m => ({ pid: Number(m[1]), created: BigInt(m[2]) }))
      const ok = /powershell/i.test(file) && script === real.stopScript(targets) && targets.every(t => ours.has(t.pid))
      runs.push({ pids: targets.map(t => t.pid), ok })
      if (!ok) return Promise.resolve({ code: 1, stdout: '', stderr: 'refused by the test' })
    }
    return mod.exec(file, args)
  }
}

// One runner (from `mod`: dev-run.mjs or a planted fault) on a fake server, with everything recorded.
async function harness(mod, { name, flags = [], mem = 10, limitMin = 90, linger = 0 }) {
  const port = await freePort()
  const home = mkdtempSync(join(TMP, `${name}-`))
  const o = mod.parseArgs(['--name', name, '--dir', FIXTURES, '--port', String(port), ...flags, '--', process.execPath, FAKE, String(port), '--grandchild'])
  const clk = clock()
  const h = { port, home, o, mem, clock: clk, portBusy: 0, children: [], order: [], lines: [], states: [], stops: [], stopRuns: [], claims: [], logs: [], done: false }
  const ours = new Set()
  const exec = guardedExec(mod, ours, h.stopRuns)
  const spawnChild = (file, args, opts) => {
    const free = clk.hold() // a start takes no time on the runner's clock
    const child = spawn(file, args, opts)
    ours.add(child.pid)
    h.children.push({ child, pid: child.pid, at: clk.now(), portBusy: h.portBusy > 0, grandchild: null, ready: false, free })
    h.order.push('spawn')
    child.once('exit', () => {
      free()
      h.portBusy = linger
    })
    child.once('error', free)
    return child
  }
  // A port that stays held for `linger` checks after each kill, as a slow socket would.
  const portHolders = async p => (h.portBusy > 0 ? (h.portBusy--, [4]) : mod.portListeners(p, exec))
  const claimSlot = () => {
    const c = { taken: null, dropped: null }
    h.claims.push(c)
    h.order.push('claim')
    c.acquired = Promise.resolve().then(() => ((c.taken = clk.now()), h.order.push('taken'), '.gate-lock'))
    c.drop = async () => {
      if (c.dropped === null) (c.dropped = clk.now()), h.order.push('released')
    }
    return c
  }
  const runner = new mod.DevRun(o, { now: clk.now, sleep: clk.sleep, freeGb: async () => h.mem, exec, spawn: spawnChild, claimSlot, portHolders, home, guard: false, out() {}, err() {} })
  runner.events.on('line', line => {
    h.lines.push(line)
    let m
    if ((m = /^grandchild (\d+)/.exec(line))) ours.add((h.children.at(-1).grandchild = Number(m[1])))
    else if ((m = /ready on \d+, pid (\d+)/.exec(line))) {
      const c = h.children.find(c => c.pid === Number(m[1]))
      c.ready = true
      c.free()
    } else if (REQUEST.test(line)) h.order.push('request')
  })
  runner.events.on('status', s => h.states.at(-1) !== s.state && h.states.push(s.state))
  runner.events.on('stop', e => h.stops.push(e))
  runner.events.on('log', m => h.logs.push(m))
  clk.limit = clk.now() + limitMin * MIN
  clk.onLimit = () => runner.requestStop('test deadline')
  h.runner = runner
  h.result = runner.run().finally(() => (h.done = true))
  h.until = async (cond, what) => {
    const end = Date.now() + 20_000
    while (!cond()) {
      if (h.done) throw new Error(`the runner ended (${runner.lastReason}) before ${what}`)
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await delay(5)
    }
  }
  h.ready = n => h.until(() => h.children[n - 1]?.ready, `server ${n} to be ready`)
  h.get = async (path = '/') => {
    const free = clk.hold()
    try {
      const before = h.lines.filter(l => REQUEST.test(l)).length
      const body = await (await fetch(`http://127.0.0.1:${port}${path}`)).json()
      await h.until(() => h.lines.filter(l => REQUEST.test(l)).length > before, 'the request line')
      return body
    } finally {
      free()
    }
  }
  h.status = () => JSON.parse(readFileSync(join(home, `${name}.json`), 'utf8'))
  h.stop = async () => {
    runner.requestStop('test end')
    clk.releaseAll()
    await h.result.catch(() => {})
    for (const c of h.children) if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill()
  }
  return h
}

async function restartScenario(mod) {
  const h = await harness(mod, { name: 'restart', flags: ['--slot=off'], linger: 3 })
  try {
    for (let n = 1; n <= 3; n++) {
      await h.ready(n)
      assert.deepEqual(await h.get('/'), { pid: h.children[n - 1].pid, port: h.port }, `server ${n} answers on the same port`)
    }
    for (const n of [0, 1]) {
      assert.match(h.stops[n].reason, /^scheduled restart after 10 min$/)
      const ran = h.stops[n].at - h.children[n].at
      assert.ok(ran >= 10 * MIN && ran <= 10 * MIN + 15_000, `server ${n + 1} ran ${ran} ms`)
      assert.ok(h.children[n + 1].at - h.stops[n].at >= 3000, 'the next start waited for the port')
    }
    assert.ok(h.children.every(c => !c.portBusy), 'no start while the port was still held')
    assert.equal(h.runner.restarts, 2)
  } finally {
    await h.stop()
  }
}

async function stopFloorScenario(mod) {
  const h = await harness(mod, { name: 'stop-floor', flags: ['--slot=off', '--compile-floor-gb', '0'], mem: 8, limitMin: 30 })
  try {
    await h.ready(1)
    h.mem = 3
    const dropAt = h.clock.now()
    await h.until(() => h.stops.length === 1, 'a stop')
    assert.match(h.stops[0].reason, /^3\.0 GiB free, under the 4 GiB stop floor$/)
    assert.ok(h.stops[0].at - dropAt <= 15_000, 'stopped within a check of the drop')
    assert.ok(!alive(h.children[0].pid))
    h.mem = 5
    const lowAt = h.clock.now()
    await h.until(() => h.clock.now() - lowAt >= MIN, 'a minute under the floor')
    assert.equal(h.children.length, 1, 'no start under the 6 GiB floor')
    assert.equal(h.status().state, 'waiting')
    assert.ok(h.logs.filter(l => l === 'waiting for memory: 5.0 GiB free, under the 6 GiB start floor').length >= 3, 'a log line every 15 s')
    h.mem = 7
    await h.ready(2)
    assert.equal(h.runner.restarts, 1)
  } finally {
    await h.stop()
  }
}

async function idleScenario(mod) {
  const h = await harness(mod, { name: 'idle', flags: ['--slot=off'], limitMin: 60 })
  try {
    await h.ready(1)
    await h.get('/')
    const hitAt = h.runner.lastHitAt
    assert.equal(await h.result, 0)
    assert.equal(h.runner.lastReason, 'idle: no request for 20 min')
    assert.ok(h.runner.restarts >= 1, 'restarts came between, and did not reset the idle clock')
    const quiet = h.stops.at(-1).at - hitAt
    assert.ok(quiet >= 20 * MIN && quiet <= 22 * MIN, `the idle exit came ${quiet / MIN} min after the last request`)
    assert.ok(h.logs.includes('idle: no request for 20 min of server time; stopping for good'))
    assert.equal(h.status().state, 'stopped')
    assert.ok(h.children.every(c => !alive(c.pid)))
  } finally {
    await h.stop()
  }
}

async function ownTreeScenario(mod) {
  const a = await harness(mod, { name: 'tree-a', flags: ['--slot=off'] })
  const b = await harness(mod, { name: 'tree-b', flags: ['--slot=off'] })
  try {
    await Promise.all([a.ready(1), b.ready(1)])
    const [ca, cb] = [a.children[0], b.children[0]]
    b.clock.hold() // b's time stands still while a stops, so b doesn't reach its own restart meanwhile
    a.runner.requestStop('test: stop a')
    await a.result
    // The root through its handle, then its detached child, the only process it started, by id.
    assert.deepEqual(a.stopRuns, [{ pids: [ca.grandchild], ok: true }], 'only the by-id stop script, on its own tree')
    // A grandchild left behind ends itself 5 s after its parent, so gone within 2 s means the walk.
    await until(() => !alive(ca.pid) && !alive(ca.grandchild), "a's server and its child to be gone", 2000)
    assert.ok(alive(cb.pid) && alive(cb.grandchild), "b's server and its child still run")
    assert.equal((await b.get('/')).pid, cb.pid)
  } finally {
    await a.stop()
    await b.stop()
  }
}

async function slotCompileScenario(mod) {
  const h = await harness(mod, { name: 'slot-compile', flags: ['--slot-script', 'heavy-slot.sh'], limitMin: 5 })
  try {
    await h.ready(1)
    assert.deepEqual(h.order.slice(0, 3), ['claim', 'taken', 'spawn'], 'the slot is taken before the spawn')
    assert.equal(h.claims[0].dropped, null, 'still held once the server is ready, before its first compile')
    await h.get('/')
    await h.until(() => h.claims[0].dropped !== null, 'the slot to be released')
    assert.deepEqual(h.order.slice(3), ['request', 'released'])
    assert.ok(h.logs.some(l => /^releasing heavy slot \.gate-lock: first compiled response: GET \/ 200 in/.test(l)))
    assert.equal(h.status().slot, null)
  } finally {
    await h.stop()
  }
}

test('--name is a-z, 0-9 and -, from a letter or digit, up to 40 characters; the other options are checked', { skip }, () => {
  const args = (name, ...more) => ['--name', name, '--dir', FIXTURES, '--port', '3999', '--slot=off', ...more, '--', process.execPath]
  for (const ok of ['a', '0', 'web', 'web-3271', 'a'.repeat(40)]) assert.equal(real.parseArgs(args(ok)).name, ok)
  for (const bad of ['', '-web', 'Web', 'web_1', 'web.1', 'a/b', '..', 'a b', 'a'.repeat(41), 'é']) assert.throws(() => real.parseArgs(args(bad)), real.UsageError, bad)
  const o = real.parseArgs(args('web'))
  assert.deepEqual([o.restartMin, o.idleMin, o.floorGb, o.compileFloorGb, o.stopGb, o.file, o.verbatim], [10, 20, 6, 9, 4, process.execPath, false])
  for (const bad of [['--restart-min', '11'], ['--restart-min', '0'], ['--floor-gb', '3'], ['--port', '0'], ['--idle-min', 'x'], ['--bogus', '1'], ['--slot=sometimes'], ['--hit', '(']])
    assert.throws(() => real.parseArgs(args('web', ...bad)), real.UsageError, bad.join(' '))
  assert.throws(() => real.parseArgs(['--name', 'web', '--dir', FIXTURES, '--port', '3999']), /after --/)
  assert.equal(real.parseArgs([...args('web').slice(0, -2), '--slot', '--slot-script', 'x.sh', '--', process.execPath]).slot, 'compile')
  // A .cmd shim runs through cmd.exe, and an argument cmd.exe would read is refused.
  const shim = join(TMP, 'shim.cmd')
  writeFileSync(shim, '@echo off\r\n')
  assert.deepEqual(real.resolveCommand(shim, ['dev', '-p', '3999'], TMP).fileArgs.slice(0, 3), ['/d', '/s', '/c'])
  assert.throws(() => real.resolveCommand(shim, ['a&b'], TMP), real.UsageError)
})

test('the request and first-compile patterns read Next lines', { skip }, () => {
  const hit = new RegExp(real.HIT_RE, 'i')
  const compiled = new RegExp(real.COMPILED_RE, 'i')
  for (const l of [' GET / 200 in 12ms', ' POST /api/x 404 in 3ms', ' GET /a 200 in 1.2s (compile: 1s, render: 200ms)']) assert.ok(hit.test(l), l)
  for (const l of [' ✓ Ready in 2.1s', ' ○ Compiling / ...', 'GET request failed']) assert.ok(!hit.test(l), l)
  for (const l of [' GET / 200 in 12ms', ' GET /old 307 in 4ms', ' ✓ Compiled / in 3.1s (812 modules)', ' ✓ Compiled in 300ms']) assert.ok(compiled.test(l), l)
  for (const l of [' GET / 404 in 5ms', ' GET / 500 in 5ms', ' ✓ Ready in 2.1s', ' ○ Compiling / ...', ' ✓ Compiled /middleware in 210ms', ' ⨯ Failed to compile'])
    assert.ok(!compiled.test(l), l)
})

test('restarts every 10 minutes on the same port, each time once the port is free', { skip }, () => restartScenario(real))
test('stops under the 4 GiB stop floor, then waits for the floor before it starts again', { skip }, () => stopFloorScenario(real))
test('stops for good after 20 minutes of server time without a request, restarts or not', { skip }, () => idleScenario(real))
test('kills only its own tree, by PID: a second server and its child live on', { skip }, () => ownTreeScenario(real))
test('takes the heavy slot before the spawn, and releases it at the first compiled response', { skip }, () => slotCompileScenario(real))

test('with no compiled response, releases the slot after 3 minutes and keeps the server', { skip }, async () => {
  const h = await harness(real, { name: 'slot-timeout', flags: ['--slot-script', 'heavy-slot.sh'] })
  try {
    await h.ready(1)
    await h.until(() => h.claims[0].dropped !== null, 'the timeout')
    const held = h.claims[0].dropped - h.children[0].at
    assert.ok(held >= 3 * MIN && held <= 3 * MIN + 10_000, `held ${held} ms`)
    assert.ok(h.logs.includes('releasing heavy slot .gate-lock: no compiled response within 3 min'))
    assert.equal(h.children.length, 1)
    assert.ok(alive(h.children[0].pid))
  } finally {
    await h.stop()
  }
})

test('--slot=life holds the slot for the whole run, and claims it again for the next', { skip }, async () => {
  const h = await harness(real, { name: 'slot-life', flags: ['--slot=life', '--slot-script', 'heavy-slot.sh'] })
  try {
    await h.ready(1)
    await h.get('/')
    assert.equal(h.claims[0].dropped, null, 'held past the first compiled response')
    await h.ready(2)
    assert.deepEqual(h.order, ['claim', 'taken', 'spawn', 'request', 'released', 'claim', 'taken', 'spawn'])
    assert.ok(h.claims[0].dropped <= h.stops[0].at && h.claims[0].dropped >= h.children[0].at + 10 * MIN)
    assert.equal(h.status().slot, '.gate-lock')
  } finally {
    await h.stop()
  }
})

test('each start waits for the 9 GiB compile floor before it claims a slot or spawns', { skip }, async () => {
  const h = await harness(real, { name: 'compile-floor', flags: ['--slot-script', 'heavy-slot.sh'], mem: 8 })
  try {
    const waiting = 'waiting for memory: 8.0 GiB free, under the 9 GiB start floor'
    await h.until(() => h.logs.filter(l => l === waiting).length >= 2, 'the wait')
    assert.deepEqual([h.claims.length, h.children.length, h.status().state], [0, 0, 'waiting'])
    h.mem = 9.5
    await h.ready(1)
    assert.deepEqual(h.order.slice(0, 3), ['claim', 'taken', 'spawn'])
  } finally {
    await h.stop()
  }
})

test('the status file walks waiting, running, restarting, running, stopped, and is whole on disk', { skip }, async () => {
  const h = await harness(real, { name: 'status', flags: ['--slot=off'], mem: 5 })
  try {
    await h.until(() => h.logs.some(l => l.startsWith('waiting for memory')), 'the wait')
    h.mem = 10
    await h.ready(1)
    await h.get('/')
    await h.ready(2)
    h.runner.requestStop('test: done')
    assert.equal(await h.result, 0)
    assert.deepEqual(h.states, ['waiting', 'running', 'restarting', 'running', 'stopped'])
    const s = h.status()
    assert.deepEqual(Object.keys(s), ['v', 'name', 'dir', 'port', 'pid', 'state', 'startedAt', 'lastHitAt', 'restarts', 'lastReason', 'slot', 'runnerPid', 'at'])
    assert.deepEqual({ ...s, at: 0 }, { v: 1, name: 'status', dir: FIXTURES, port: h.port, pid: null, state: 'stopped', startedAt: h.children[1].at,
      lastHitAt: h.runner.lastHitAt, restarts: 1, lastReason: 'test: done', slot: null, runnerPid: process.pid, at: 0 })
    assert.equal(typeof s.lastHitAt, 'number')
    assert.deepEqual(readdirSync(h.home).sort(), ['status.json', 'status.log', 'status.out'], 'no temporary file left')
  } finally {
    await h.stop()
  }
})

test('Ctrl+C stops the server tree, and the runner ends with 130', { skip }, async () => {
  const h = await harness(real, { name: 'ctrl-c', flags: ['--slot=off'] })
  try {
    const signals = new EventEmitter()
    real.wireSignals(h.runner, signals)
    await h.ready(1)
    const c = h.children[0]
    signals.emit('SIGINT')
    assert.equal(await h.result, 130)
    assert.deepEqual(h.stopRuns, [{ pids: [c.grandchild], ok: true }])
    await until(() => !alive(c.pid) && !alive(c.grandchild), 'the tree to be gone', 2000)
    assert.deepEqual([h.status().state, h.status().lastReason], ['stopped', 'SIGINT'])
  } finally {
    await h.stop()
  }
})

// Node ends a child it spawned when it dies (a job), so a Node server goes with a killed runner. A
// .cmd shim's cmd.exe goes too, but the server it started does not: that one is the guard's.
test('a runner killed outright leaves no server, even behind a .cmd shim: its guard stops the tree', { skip }, async () => {
  const port = await freePort()
  const local = mkdtempSync(join(TMP, 'cli-'))
  const shim = join(local, 'fake-dev.cmd')
  writeFileSync(shim, `@"${process.execPath}" "${FAKE}" %*\r\n`)
  const floors = ['--floor-gb', '0', '--compile-floor-gb', '0', '--stop-gb', '0']
  const cli = spawn(process.execPath, [DEV_RUN, '--name', 'cli', '--dir', FIXTURES, '--port', String(port), '--slot=off', ...floors, '--', shim, String(port), '--grandchild'],
    { env: { ...process.env, LOCALAPPDATA: local }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let out = ''
  cli.stdout.on('data', d => (out += d))
  cli.stderr.on('data', d => (out += d))
  try {
    // The runner logs the start once its guard knows the root and its start time.
    await until(() => /ready on \d+, pid \d+/.test(out) && /\] started pid \d+, started \d{4}-/.test(out), 'the server')
    const pid = Number(/ready on \d+, pid (\d+)/.exec(out)[1])
    const grandchild = Number(/grandchild (\d+)/.exec(out)[1])
    cli.kill() // TerminateProcess: no handler of the runner's runs
    await delay(300)
    assert.ok(alive(pid), 'the server outlives its cmd.exe and the runner, until the guard comes')
    await until(() => !alive(pid), 'the guard to stop the server')
    await until(() => !alive(grandchild), "the server's child to go with it", 2000)
    const home = join(local, 'claude-self-tools', 'dev-run')
    await until(() => JSON.parse(readFileSync(join(home, 'cli.json'), 'utf8')).state === 'stopped', 'the status to say stopped', 5000)
    // cmd.exe went with the runner; the guard walked from it: the server's child, then the server.
    assert.equal(JSON.parse(readFileSync(join(home, 'cli.json'), 'utf8')).lastReason.replace(/^runner \d+/, 'runner'), `runner ended; its guard stopped pid ${grandchild}, ${pid}`)
    assert.match(readFileSync(join(home, 'cli.log'), 'utf8'), new RegExp(`guard: runner \\d+ ended without stopping its server, pid \\d+: stopped ${grandchild}, stopped ${pid}`))
  } finally {
    if (cli.exitCode === null) cli.kill()
  }
})

const SLOT_SCRIPT = process.env.HEAVY_SLOT_SCRIPT || real.findSlotScript(HERE)
test("a claim through the real heavy-slot.sh, in a slot folder of its own: held, given back, and dropped while queued", { skip: skip || (!SLOT_SCRIPT && 'no heavy-slot.sh above this folder; set HEAVY_SLOT_SCRIPT') }, async () => {
  const root = mkdtempSync(join(TMP, 'slots-'))
  const env = { ...process.env, HEAVY_SLOT_ROOT: root.replace(/\\/g, '/'), HEAVY_SLOT_MIN_FREE_GB: '0' }
  const notes = []
  const take = () => real.claimSlot({ script: SLOT_SCRIPT, cwd: FIXTURES, bash: real.findBash(), env, note: l => notes.push(l) })
  const claim = take()
  assert.equal(await claim.acquired, '.gate-lock')
  assert.ok(existsSync(join(root, '.gate-lock', 'owner')), 'heavy-slot wrote its owner file')
  await claim.drop()
  assert.ok(!existsSync(join(root, '.gate-lock')), "heavy-slot's own exit trap gave the slot back")
  // With the cap at 0, heavy-slot holds every new job: the claim waits in the queue until dropped.
  writeFileSync(join(root, '.gate-cap'), '0\n')
  const queued = take()
  await until(() => existsSync(join(root, '.gate-queue')) && readdirSync(join(root, '.gate-queue')).length === 1, 'the queued ticket', 10_000)
  await queued.drop()
  assert.equal(await queued.acquired, null)
  assert.ok(!existsSync(join(root, '.gate-lock')))
  assert.ok(notes.some(l => l.startsWith('[heavy-slot] holding .gate-lock for: read -r DEV_RUN_HOLD')))
})

// The tree walk on a made-up process table. Windows keeps a dead parent's id on its orphans, so a
// process older than the root can carry the root's id as its parent: never the root's.
async function orphanTableScenario(mod) {
  const row = (pid, ppid, created) => [pid, { pid, ppid, created: BigInt(created) }]
  // R (100) started C (200), which started G (300). O (400) and its child (500) are older than R:
  // orphans of an earlier owner of id 100. S (600) is someone else's.
  const table = new Map([row(100, 1, 1000), row(200, 100, 1100), row(300, 200, 1200), row(400, 100, 900), row(500, 400, 950), row(600, 50, 800)])
  assert.deepEqual(mod.treeOf(table, 100, 1000n).map(t => t.pid), [300, 200], "R's tree, deepest first, without the older orphan")
  assert.deepEqual(mod.treeOf(table, 100, 1000n, { includeRoot: true }).map(t => t.pid), [300, 200, 100])
  // R gone and its id taken by X (created 5000), which started Y: of R's, only C is left.
  const later = new Map([row(100, 9, 5000), row(700, 100, 5100), row(200, 100, 1100), row(400, 100, 900)])
  assert.deepEqual(mod.treeOf(later, 100, 1000n, { includeRoot: true }).map(t => t.pid), [200], 'neither the older orphan nor the new owner and its child')
}

// The walk on live processes: harmless sleepers this test starts, each child detached so that only
// the walk ends it. Every stop script is checked as in the harness.
async function liveWalkScenario(mod) {
  const procs = []
  const ours = new Set()
  const runs = []
  const run = guardedExec(mod, ours, runs)
  const start = async depth => {
    const p = spawn(process.execPath, [SLEEPER, String(depth)], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    procs.push(p)
    let out = ''
    p.stdout.on('data', d => (out += d))
    await until(() => (out.match(/^sleeper /gm) ?? []).length === depth + 1, 'the sleepers', 10_000)
    const pids = [...out.matchAll(/^sleeper (\d+) \d+\r?$/gm)].map(m => Number(m[1]))
    pids.forEach(pid => ours.add(pid))
    return { p, pids }
  }
  const end = p => (p.kill(), until(() => p.exitCode !== null || p.signalCode !== null, 'a sleeper to end', 5000))
  try {
    const { pids: [older] } = await start(0)
    // P starts O, then P ends: O, an orphan, keeps P's id as its parent id.
    const { p: P, pids: [pPid, oPid] } = await start(1)
    await end(P)
    // R starts C, which starts G. R is ended through its handle, as the runner does.
    const { p: R, pids: [rPid, cPid, gPid] } = await start(2)
    const rCreated = await mod.processCreated(rPid, run)
    await end(R)
    const mine = await mod.killTree(rPid, rCreated, { run })
    assert.deepEqual(mine.targets.map(t => t.pid), [gPid, cPid], "R's tree, deepest first")
    assert.deepEqual(mine.results, [`stopped ${gPid}`, `stopped ${cPid}`])
    await until(() => !alive(gPid) && !alive(cPid), 'C and G to end', 3000)
    // A root created after O, holding P's old id: O is older than it, so not its child.
    const taken = await mod.killTree(pPid, rCreated, { includeRoot: true, run })
    assert.ok(!taken.targets.some(t => t.pid === oPid), 'the older orphan is not in the tree')
    assert.ok(alive(oPid) && alive(older), 'the orphan and the older process live on')
    assert.ok(runs.every(r => r.ok), 'every stop script was the by-id one, on processes this test started')
  } finally {
    for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill()
  }
}

test('the tree walk never takes a process older than its parent: an orphan carrying the root id', { skip }, () => orphanTableScenario(real))
test('live: the walk stops exactly the tree it started, deepest first, and nothing older', { skip }, () => liveWalkScenario(real))

// Planted faults: a copy of dev-run.mjs with one line changed. Each must make its scenario fail.
let mutants = 0
async function mutant(find, replace) {
  const src = readFileSync(DEV_RUN, 'utf8')
  assert.equal(src.split(find).length, 2, `the fault's line is in dev-run.mjs once: ${find}`)
  const file = join(TMP, `mutant-${++mutants}.mjs`)
  writeFileSync(file, src.replace(find, () => replace))
  return import(pathToFileURL(file).href)
}

// [what, the line, its faulty form, the scenario, what the scenario must fail on]
const FAULTS = [
  ['a restart does not wait for the port', 'const clear = await this.waitPortFree()', 'const clear = true', restartScenario, /the next start waited for the port/],
  ['the stop floor is ignored', 'if (free < o.stopGb)', 'if (false)', stopFloorScenario, /stop floor\$\/\. Input:\s+'scheduled restart after 10 min'/],
  ['idle never fires (each start resets the idle clock)', 'this.idleAnchor += now - this.downSince', 'this.idleAnchor = now', idleScenario, /\+ 'test deadline'\s+- 'idle: no request for 20 min'/],
  ['kill by name instead of by PID', 'Stop-Process -InputObject $p -Force', 'Stop-Process -Name $p.ProcessName -Force', ownTreeScenario, /only the by-id stop script/],
  ['the walk takes an orphan older than its parent (process table)', 'if (c.created < created) continue', 'if (false) continue', orphanTableScenario, /without the older orphan/],
  ['the walk takes an orphan older than its parent (live)', 'if (c.created < created) continue', 'if (false) continue', liveWalkScenario, /older orphan is not in the tree|R's tree, deepest first|every stop script/],
  ['the heavy slot is never released', 'if (!claim) return', 'return', slotCompileScenario, /ended \(test deadline\) before the slot to be released/],
  ['the heavy slot is released before the compile', ' && this.compiledRe.test(line)', '', slotCompileScenario, /still held once the server is ready/],
]
for (const [what, find, replace, scenario, failsOn] of FAULTS)
  test(`planted fault, caught: ${what}`, { skip }, async () => assert.rejects(scenario(await mutant(find, replace)), e => (assert.match(e.message, failsOn), true)))
