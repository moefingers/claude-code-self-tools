#!/usr/bin/env node
// dev-run: runs one dev server for a Claude Code session on a shared Windows machine, in place of a
// `next dev` the session starts by hand. It starts the server only when enough memory is free,
// restarts it every few minutes on the same port, stops it when free memory runs low and waits to
// start again, stops it for good after a stretch without a request, and claims a heavy-slot slot
// for each start's first compile. One log and one status file per runner. See README.md.
//
//   node dev-run.mjs --name <label> --dir <folder> --port <n> [options] -- <command> [args...]
//
// Windows only. Node's standard library only.
import { execFile, spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { freemem, homedir } from 'node:os'
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
export const MAX_RESTART_MIN = 10
export const SLOT_COMPILE_MS = 3 * 60_000
const METHODS = 'GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS'
// A request line as Next prints it: " GET /path 200 in 12ms".
export const HIT_RE = String.raw`^\s*(?:${METHODS})\s+\S+\s+\d{3}\s+in\b`
// The end of a first compile, read case-sensitively: a 2xx/3xx request line, or Next's own
// " ✓ Compiled ..." line, at its start, other than middleware's (or proxy's, or instrumentation's),
// which come before the page's own. So neither a request for /compiled nor the app's own output
// that says "compiled" counts. Not "Ready": Next prints it once it listens, before it compiles anything.
export const COMPILED_RE = String.raw`^\s*(?:${METHODS})\s+\S+\s+[23]\d\d\s+in\b|^\s*(?:\S{1,2}\s+)?Compiled\b(?!\s+\/(?:middleware|proxy|instrumentation)\b)`
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const SYS = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
const NETSTAT = join(SYS, 'NETSTAT.EXE')
const POWERSHELL = join(SYS, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGBREAK: 149 }
const SLOT_MODES = ['compile', 'life', 'off']

export const USAGE = `usage: node dev-run.mjs --name <label> --dir <folder> --port <n> [options] -- <command> [args...]

  --name <label>            a-z, 0-9 and -, up to 40 characters; names the log and the status file
  --dir <folder>            the project folder the command runs in
  --port <n>                the port the command's server listens on (the command must use it)
  --restart-min <n>         restart the server every n minutes (default 10, at most 10)
  --idle-min <n>            stop for good after n minutes of server time without a request (default 20)
  --floor-gb <n>            GiB of free memory to start or restart at (default 6)
  --compile-floor-gb <n>    GiB free before each start's first compile (default 9); the larger floor applies
  --stop-gb <n>             stop the server under n GiB free, then wait for the floor again (default 4)
  --slot[=compile|life|off] claim a heavy-slot slot for each start's first compile (the default), for
                            each whole run, or not at all
  --slot-script <path>      heavy-slot.sh (default: $HEAVY_SLOT_SCRIPT, else the first found in a
                            folder above the repository that holds --dir)
  --hit <regex>             an output line that counts as a request (default: " GET /path 200 in 12ms")
  --compiled <regex>        an output line that ends the first compile (default: a 2xx/3xx request
                            line, or a "Compiled" line other than middleware's)`

export class UsageError extends Error {}

const NUMBERS = { port: 'port', 'restart-min': 'restartMin', 'idle-min': 'idleMin', 'floor-gb': 'floorGb', 'compile-floor-gb': 'compileFloorGb', 'stop-gb': 'stopGb' }
const STRINGS = { name: 'name', dir: 'dir', hit: 'hit', compiled: 'compiled', 'slot-script': 'slotScript' }

export function parseArgs(argv, env = process.env) {
  const o = { restartMin: 10, idleMin: 20, floorGb: 6, compileFloorGb: 9, stopGb: 4, hit: HIT_RE, compiled: COMPILED_RE, slot: 'compile', slotScript: null }
  const sep = argv.indexOf('--')
  if (sep < 0 || sep === argv.length - 1) throw new UsageError('give the server command after --')
  ;[o.command, ...o.args] = argv.slice(sep + 1)
  const flags = argv.slice(0, sep)
  for (let i = 0; i < flags.length; i++) {
    if (!flags[i].startsWith('--')) throw new UsageError(`unexpected ${flags[i]}`)
    let [key, value] = flags[i].slice(2).split(/=(.*)/s, 2)
    if (key === 'slot') {
      o.slot = value ?? 'compile'
      continue
    }
    if (!(key in NUMBERS) && !(key in STRINGS)) throw new UsageError(`unknown option ${flags[i]}`)
    if (value === undefined) value = flags[++i]
    if (value === undefined) throw new UsageError(`--${key} needs a value`)
    if (key in STRINGS) o[STRINGS[key]] = value
    else if (value.trim() === '' || !Number.isFinite(Number(value))) throw new UsageError(`--${key} takes a number, not ${value}`)
    else o[NUMBERS[key]] = Number(value)
  }
  if (!NAME_RE.test(o.name ?? '')) throw new UsageError(`--name must match ${NAME_RE.source}`)
  if (!o.dir) throw new UsageError('--dir is required')
  o.dir = resolve(o.dir)
  if (!statSync(o.dir, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`--dir ${o.dir} is not a folder`)
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new UsageError('--port must be a whole number from 1 to 65535')
  if (!(o.restartMin > 0 && o.restartMin <= MAX_RESTART_MIN)) throw new UsageError(`--restart-min must be over 0 and at most ${MAX_RESTART_MIN}`)
  if (!(o.idleMin > 0)) throw new UsageError('--idle-min must be over 0')
  if (!(o.stopGb >= 0 && o.floorGb >= o.stopGb && o.compileFloorGb >= 0)) throw new UsageError('the floors must be 0 or more, and --floor-gb at least --stop-gb')
  for (const key of ['hit', 'compiled']) {
    try {
      new RegExp(o[key], 'i')
    } catch (e) {
      throw new UsageError(`--${key}: ${e.message}`)
    }
  }
  if (!SLOT_MODES.includes(o.slot)) throw new UsageError(`--slot takes ${SLOT_MODES.join(', ')}`)
  if (o.slot !== 'off') {
    o.slotScript ??= findSlotScript(o.dir, env)
    if (!o.slotScript) throw new UsageError('no heavy-slot.sh: set HEAVY_SLOT_SCRIPT, pass --slot-script <path>, or --slot=off')
    o.bash = findBash(env)
    if (!o.bash) throw new UsageError('no Git Bash to run heavy-slot.sh: install Git for Windows, or pass --slot=off')
  }
  Object.assign(o, resolveCommand(o.command, o.args, o.dir, env))
  return o
}

/** The program to spawn, without a shell: an .exe as it is; a .cmd or .bat shim through cmd.exe. */
export function resolveCommand(command, args, cwd, env = process.env) {
  let file = command
  if (!['.exe', '.com'].includes(extname(command).toLowerCase())) {
    // Only PATHEXT names: npm's extensionless shim beside a .cmd is a shell script Windows can't run.
    const exts = extname(command) ? [''] : (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    // A bare name through PATH only, as PowerShell does, so a node.cmd in the project can't stand in
    // for node; a path is taken from --dir.
    const dirs = /[\\/]/.test(command) ? [''] : (env.PATH || '').split(delimiter).filter(d => isAbsolute(d))
    const found = dirs.flatMap(d => exts.map(e => resolve(cwd, d, command + e))).find(p => statSync(p, { throwIfNoEntry: false })?.isFile())
    if (found) file = found
  }
  if (!/\.(cmd|bat)$/i.test(file)) return { file, fileArgs: args, verbatim: false }
  const line = [file, ...args].map(a => {
    if (/["%!^&|<>\r\n]/.test(a)) throw new UsageError(`«${a}» has a character cmd.exe would read; run the program itself (for Next: node node_modules/next/dist/bin/next dev -p <port>)`)
    return a === '' || /[\s()]/.test(a) ? `"${a}"` : a
  })
  return { file: env.ComSpec || join(SYS, 'cmd.exe'), fileArgs: ['/d', '/s', '/c', `"${line.join(' ')}"`], verbatim: true }
}

/**
 * heavy-slot.sh: $HEAVY_SLOT_SCRIPT, else the first one in a folder above the repository that holds
 * `dir` (or above `dir`, outside a repository). Never one inside the served repository, which a
 * project could carry, or an old worktree keep.
 */
export function findSlotScript(dir, env = process.env) {
  if (env.HEAVY_SLOT_SCRIPT) return env.HEAVY_SLOT_SCRIPT
  let from = resolve(dir)
  for (let d = from; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) {
      if (dirname(d) === d) return null
      from = dirname(d)
      break
    }
    if (dirname(d) === d) break
  }
  for (let d = from; ; d = dirname(d)) {
    if (existsSync(join(d, 'heavy-slot.sh'))) return join(d, 'heavy-slot.sh')
    if (dirname(d) === d) return null
  }
}

/** Git's bash. Never System32's or WindowsApps' bash.exe, which start WSL. */
export function findBash(env = process.env) {
  const skip = [env.SystemRoot || 'C:\\Windows', 'WindowsApps'].map(s => s.toLowerCase())
  for (const d of (env.PATH || '').split(delimiter)) {
    if (!d || skip.some(s => d.toLowerCase().includes(s))) continue
    if (existsSync(join(d, 'bash.exe'))) return join(d, 'bash.exe')
  }
  const git = join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
  return existsSync(git) ? git : null
}

export function homeDir(env = process.env) {
  return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'claude-self-tools', 'dev-run')
}

export function exec(file, args) {
  return new Promise(res =>
    execFile(file, args, { windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) =>
      res({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout), stderr: String(stderr) })))
}

// Killing a tree. Windows keeps a dead parent's id on its orphans and never checks it, and a later
// process can take that id: so `taskkill /T` takes strangers. Here the tree comes from one process
// snapshot, walked down by parent id, taking a child only when it was created at or after its parent
// (machine.ts's GET_PARENT rule): an older "child" is an orphan of the id's earlier owner. Each is then
// stopped by id, deepest first, through a handle on which its start time is checked again.
const START_TOLERANCE = 10_000 // FILETIME units, 1 ms: machine.ts's PROC_START_TOLERANCE
const SNAPSHOT = "Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CreationDate | ForEach-Object { if ($null -ne $_.CreationDate) { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc() } }"
const powershell = (command, run) => run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', command])

/** Every process, by id: { pid, ppid, created }, created a FILETIME as a BigInt. Null when unreadable. */
export async function snapshot(run = exec) {
  const { code, stdout } = await powershell(SNAPSHOT, run)
  if (code !== 0) return null
  const table = new Map()
  for (const m of stdout.matchAll(/^(\d+) (\d+) (\d+)\r?$/gm)) table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), created: BigInt(m[3]) })
  return table
}

/** A process's creation time (FILETIME, BigInt), or null when it is gone. Read it while its handle is held. */
export async function processCreated(pid, run = exec) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const { stdout } = await powershell(`$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}' -Property CreationDate; if ($null -ne $p.CreationDate) { $p.CreationDate.ToFileTimeUtc() }`, run)
  return /^\d+$/.test(stdout.trim()) ? BigInt(stdout.trim()) : null
}

/**
 * The processes `root` (created at `rootCreated`) started, and theirs, deepest first, from a snapshot;
 * then the root itself with includeRoot, if it still runs. When the root's id has since been taken by
 * a later process, that one's children (all created after it) are left out too.
 */
export function treeOf(table, root, rootCreated, { includeRoot = false } = {}) {
  const children = new Map()
  for (const p of table.values()) if (p.pid !== p.ppid) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p])
  const holder = table.get(root)
  const takenAt = holder && holder.created !== rootCreated ? holder.created : null
  const found = []
  const seen = new Set([root])
  const walk = (pid, created, depth, before) => {
    for (const c of children.get(pid) ?? []) {
      if (seen.has(c.pid)) continue
      if (c.created < created) continue // older than its parent: an orphan of the id's earlier owner
      if (before !== null && c.created >= before) continue // a child of the id's later owner
      seen.add(c.pid)
      found.push({ pid: c.pid, created: c.created, depth })
      walk(c.pid, c.created, depth + 1, null)
    }
  }
  walk(root, rootCreated, 1, takenAt)
  found.sort((a, b) => b.depth - a.depth)
  if (includeRoot && holder?.created === rootCreated) found.push({ pid: root, created: rootCreated, depth: 0 })
  return found
}

/**
 * The fixed script that stops each target by id: it opens a handle on the process, checks its start
 * time against the snapshot's, and stops that same process through the handle. Never by name, never a tree.
 */
export function stopScript(targets) {
  return [
    `$targets = @(${targets.map(t => `'${t.pid}:${t.created}'`).join(', ')})`,
    'foreach ($t in $targets) {',
    "  $id, $ft = $t.Split(':')",
    '  $p = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue',
    '  if ($null -eq $p) { "gone $id"; continue }',
    '  try { $null = $p.Handle; $now = $p.StartTime.ToFileTimeUtc() } catch { "unreadable $id"; continue }',
    `  if ([math]::Abs($now - [long]$ft) -gt ${START_TOLERANCE}) { "reused $id"; continue }`,
    '  try { Stop-Process -InputObject $p -Force -ErrorAction Stop; "stopped $id" } catch { "failed $id" }',
    '}',
  ].join('\n')
}

/** Stops what `root` started, and theirs (and the root, with includeRoot), deepest first. */
export async function killTree(root, rootCreated, { includeRoot = false, run = exec } = {}) {
  if (!Number.isInteger(root) || root <= 0 || root === process.pid || typeof rootCreated !== 'bigint') throw new Error(`refusing to walk from pid ${root}`)
  const table = await snapshot(run)
  if (!table) return { targets: null, results: [] }
  const targets = treeOf(table, root, rootCreated, { includeRoot }).filter(t => t.pid !== process.pid)
  if (!targets.length) return { targets, results: [] }
  const { stdout } = await powershell(stopScript(targets), run)
  return { targets, results: stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean) }
}

/** The ids of the processes listening on a TCP port (IPv4 or IPv6), or null when netstat fails. */
export async function portListeners(port, run = exec) {
  const { code, stdout } = await run(NETSTAT, ['-ano'])
  if (code !== 0) return null
  const pids = new Set()
  for (const line of stdout.split(/\r?\n/)) {
    const [proto, local, remote, , pid] = line.trim().split(/\s+/)
    // A listener's remote address ends in :0 (read that, not the state word, which is translated).
    if (/^TCP/i.test(proto) && local?.endsWith(`:${port}`) && /:0$/.test(remote ?? '') && pid) pids.add(Number(pid))
  }
  return [...pids]
}

/**
 * Claims a slot through heavy-slot.sh itself: bash runs `heavy-slot.sh read -r DEV_RUN_HOLD`, which
 * queues, waits and takes a slot as for any job, says "[heavy-slot] holding <slot>", and holds it
 * while `read` waits on this process's pipe. drop() ends the pipe: `read` returns, and heavy-slot's
 * own exit trap gives the slot back. If this process dies, Node's job ends bash with it, and
 * heavy-slot reclaims a slot whose holder is gone the next time a job looks for one.
 */
export function claimSlot({ script, cwd, bash, env = process.env, note = () => {}, run = exec }) {
  const child = spawn(bash, [script.replace(/\\/g, '/'), 'read', '-r', 'DEV_RUN_HOLD'], { cwd, env, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
  child.stdin.on('error', () => {})
  let held = false
  const exited = new Promise(r => {
    child.once('exit', r)
    child.once('error', e => (note(`heavy-slot: ${e.message}`), r()))
  })
  const acquired = new Promise(res => {
    createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', line => {
      note(line)
      const m = /^\[heavy-slot\] holding (\S+) for:/.exec(line)
      if (m && !held) res(((held = true), m[1]))
    })
    exited.then(() => res(null))
  })
  return {
    pid: child.pid,
    acquired,
    async drop() {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.stdin.end()
      // Still queued: stop the claim, bash through Node's handle, then what it started; heavy-slot
      // drops a ticket whose holder is gone. The start time is read while that handle pins the id.
      if (!held && child.pid) {
        const created = await processCreated(child.pid, run)
        child.kill()
        await exited
        if (created !== null) await killTree(child.pid, created, { run })
      }
      await exited
    },
  }
}

export function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  for (let i = 0; ; i++) {
    try {
      return renameSync(tmp, path)
    } catch (e) {
      // A reader holding the file open makes Windows refuse the replace for a moment.
      if (i >= 9 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

const gb = n => (Number.isFinite(n) ? n.toFixed(1) : 'unknown')

export class DevRun {
  constructor(o, deps = {}) {
    this.o = o
    this.d = {
      now: Date.now,
      sleep: ms => new Promise(r => setTimeout(r, ms)),
      freeGb: async () => freemem() / 2 ** 30, // GlobalMemoryStatusEx's available physical memory
      exec,
      spawn,
      claimSlot,
      portHolders: null,
      home: homeDir(),
      guard: true,
      out: line => process.stdout.write(`${line}\n`),
      err: line => process.stderr.write(`${line}\n`),
      ...deps,
    }
    mkdirSync(this.d.home, { recursive: true })
    this.logPath = join(this.d.home, `${o.name}.log`)
    this.statusPath = join(this.d.home, `${o.name}.json`)
    this.outPath = join(this.d.home, `${o.name}.out`)
    this.events = new EventEmitter()
    this.hitRe = new RegExp(o.hit, 'i')
    this.compiledRe = new RegExp(o.compiled) // case-sensitive: Next's "Compiled", not any "compiled"
    Object.assign(this, { state: 'waiting', child: null, pid: null, startedAt: null, lastHitAt: null, restarts: 0, lastReason: null })
    Object.assign(this, { idleAnchor: null, downSince: null, quickExits: 0, claim: null, slotName: null, stopReq: null, dirty: false })
    this.stopSignal = new Promise(r => (this.wake = r))
  }

  requestStop(why) {
    if (this.stopReq) return
    this.stopReq = why
    this.log(`stop requested (${why})`)
    this.wake()
  }

  async run() {
    const { o } = this
    try {
      if (statSync(this.logPath).size > 1 << 20) renameSync(this.logPath, `${this.logPath}.1`)
    } catch {}
    const prev = readJson(this.statusPath)
    if (prev?.state && prev.state !== 'stopped' && prev.runnerPid !== process.pid && alive(prev.runnerPid))
      throw new UsageError(`a runner named ${o.name} already runs (pid ${prev.runnerPid}); pick another --name`)
    this.log(`runner ${process.pid}: ${o.command} ${o.args.join(' ')} in ${o.dir}, port ${o.port}; restart every ${o.restartMin} min; ` +
      `idle exit after ${o.idleMin} min; start at ${this.startFloor()} GiB free (floor ${o.floorGb}, compile floor ${o.compileFloorGb}); ` +
      `stop under ${o.stopGb} GiB; heavy slot: ${o.slot}${o.slot === 'off' ? '' : ` through ${o.slotScript}`}`)
    this.write('waiting', 'starting')
    this.startGuard()
    let code
    try {
      code = await this.loop()
    } catch (e) {
      code = 1
      this.lastReason = `error: ${e?.message ?? e}`
      this.log(`error: ${e?.stack ?? e}`)
    }
    if (this.child) await this.stopServer(this.lastReason, true).catch(e => this.log(`error while stopping: ${e.message}`))
    await this.releaseSlot('runner ending')
    this.write('stopped')
    this.log(`runner ends (${code}): ${this.lastReason}`)
    await this.endGuard()
    return code
  }

  async loop() {
    const { o } = this
    if (!(await this.waitPortFree())) return this.finish(1, `port ${o.port} is in use by another process; not starting a second server on it`)
    for (;;) {
      if (!(await this.waitFloor())) return this.finish(EXIT_CODES[this.stopReq] ?? 0, this.stopReq)
      if (o.slot !== 'off') {
        const got = await this.takeSlot()
        if (got === 'stop') return this.finish(EXIT_CODES[this.stopReq] ?? 0, this.stopReq)
        if (got === 'fail') return this.finish(1, 'heavy-slot ended without giving a slot')
        if (got === 'retry') continue
      }
      await this.start()
      const end = await this.watch()
      await this.stopServer(end.reason, end.final)
      const clear = await this.waitPortFree()
      if (end.final) return this.finish(end.code, end.reason)
      if (!clear) return this.finish(1, `port ${o.port} is still in use 30 s after the stop`)
    }
  }

  finish(code, reason) {
    this.lastReason = reason
    return code
  }

  startFloor() {
    return Math.max(this.o.floorGb, this.o.compileFloorGb)
  }

  async mem() {
    try {
      const v = await this.d.freeGb()
      return Number.isFinite(v) ? v : NaN
    } catch (e) {
      this.log(`error reading free memory: ${e.message}`)
      return NaN
    }
  }

  nap(ms) {
    return Promise.race([this.d.sleep(ms), this.stopSignal])
  }

  async waitFloor() {
    const need = this.startFloor()
    let free = await this.mem()
    for (let polls = 0; !(free >= need); polls++) {
      if (this.stopReq) return false
      const why = `${gb(free)} GiB free, under the ${need} GiB start floor`
      if (polls === 0) this.write('waiting', why)
      this.log(`waiting for memory: ${why}`)
      await this.nap(15_000)
      free = await this.mem()
    }
    if (this.stopReq) return false
    this.log(`memory: ${gb(free)} GiB free, at or over the ${need} GiB start floor`)
    return true
  }

  async takeSlot() {
    const { o } = this
    this.log(`claiming a heavy slot ${o.slot === 'life' ? 'for the run' : 'for the first compile'}`)
    this.write('waiting', 'waiting for a heavy slot')
    const claim = this.d.claimSlot({ script: o.slotScript, cwd: o.dir, bash: o.bash, note: line => this.log(line) })
    const got = await Promise.race([claim.acquired, this.stopSignal.then(() => 'stop')])
    if (got === 'stop' || this.stopReq) {
      await claim.drop()
      return 'stop'
    }
    if (!got) return 'fail'
    this.claim = claim
    this.slotName = got
    this.log(`holding heavy slot ${got}`)
    this.writeStatus()
    const free = await this.mem()
    if (free >= this.startFloor()) return 'ok'
    await this.releaseSlot(`memory fell to ${gb(free)} GiB while waiting for the slot`)
    return 'retry'
  }

  async releaseSlot(why) {
    const claim = this.claim
    if (!claim) return
    this.claim = null
    this.log(`releasing heavy slot ${this.slotName}: ${why}`)
    this.slotName = null
    this.writeStatus()
    await claim.drop().catch(e => this.log(`error releasing the heavy slot: ${e.message}`))
  }

  async start() {
    const { o } = this
    const now = this.d.now()
    if (this.startedAt !== null) this.restarts++
    if (this.downSince === null) this.idleAnchor = now // the first start counts as a request
    else this.idleAnchor += now - this.downSince // the idle clock stands still while the server is down
    this.downSince = null
    this.spawnError = null
    // The server writes to a file, never to a pipe to this process: a Node server whose output pipe
    // breaks dies at once, and a dead root would leave its workers, and the port, to no one.
    try {
      if (statSync(this.outPath).size > 5 << 20) renameSync(this.outPath, `${this.outPath}.1`)
    } catch {}
    const fd = openSync(this.outPath, 'a')
    const from = fstatSync(fd).size
    let child
    try {
      child = this.d.spawn(o.file, o.fileArgs, { cwd: o.dir, stdio: ['ignore', fd, fd], windowsHide: true, windowsVerbatimArguments: o.verbatim })
    } finally {
      closeSync(fd)
    }
    child.on('error', e => {
      this.spawnError = e
      this.log(`error: ${e.message}`)
    })
    this.untail = this.tail(child, from)
    this.child = child
    this.pid = child.pid ?? null
    this.startedAt = now
    // The root's real start time, read while it runs: the walk at the stop, and the guard, take only
    // what it started. Until the guard has it, a runner killed outright leaves the guard nothing.
    this.rootCreated = this.pid ? await processCreated(this.pid, this.d.exec) : null
    if (this.rootCreated !== null) this.guardSay(`child ${this.pid} ${this.rootCreated}`)
    this.write('running')
    const created = this.rootCreated === null ? 'start time unknown' : `started ${new Date(Number(this.rootCreated / 10_000n) - 11_644_473_600_000).toISOString()}`
    this.log(`started pid ${this.pid}${this.restarts ? ` (restart ${this.restarts})` : ''}, ${created}: ${o.file} ${o.fileArgs.join(' ')}`)
    this.events.emit('start', { pid: this.pid, at: now })
  }

  /** Reads the server's new output lines every 100 ms; the function it returns reads the rest and stops. */
  tail(child, from) {
    const fd = openSync(this.outPath, 'r')
    const buf = Buffer.alloc(1 << 16)
    const text = new StringDecoder('utf8')
    let pos = from
    let carry = ''
    const pump = () => {
      for (let n; (n = readSync(fd, buf, 0, buf.length, pos)) > 0; ) {
        pos += n
        const lines = (carry + text.write(buf.subarray(0, n))).split(/\r?\n/)
        carry = lines.pop()
        for (const line of lines) this.onLine(line, child)
      }
    }
    const timer = setInterval(pump, 100)
    return () => {
      clearInterval(timer)
      try {
        pump()
        if (carry) this.onLine(carry, child)
      } finally {
        closeSync(fd)
      }
    }
  }

  onLine(raw, child) {
    if (child !== this.child) return
    this.d.out(raw)
    const line = raw.replace(ANSI, '')
    this.events.emit('line', line)
    if (this.hitRe.test(line)) {
      this.lastHitAt = this.idleAnchor = this.d.now()
      this.dirty = true
    }
    if (this.claim && this.o.slot === 'compile' && this.compiledRe.test(line)) void this.releaseSlot(`first compiled response: ${line.trim()}`)
  }

  async watch() {
    const { o } = this
    for (let tick = 1; ; tick++) {
      await this.nap(10_000)
      if (this.stopReq) return { reason: this.stopReq, final: true, code: EXIT_CODES[this.stopReq] ?? 0 }
      const now = this.d.now()
      const child = this.child
      if (this.spawnError || child.exitCode !== null || child.signalCode !== null) {
        const how = this.spawnError ? `could not start (${this.spawnError.message})` : `exited by itself (${child.exitCode ?? child.signalCode})`
        this.quickExits = now - this.startedAt < 60_000 ? this.quickExits + 1 : 0
        if (this.quickExits >= 3) return { reason: `the server ${how}, three times within a minute of starting`, final: true, code: 1 }
        return { reason: `the server ${how}`, final: false }
      }
      const free = await this.mem()
      if (tick % 6 === 0) this.log(`memory: ${gb(free)} GiB free`)
      if (free < o.stopGb) return { reason: `${gb(free)} GiB free, under the ${o.stopGb} GiB stop floor`, final: false }
      if (now - this.idleAnchor >= o.idleMin * 60_000) {
        this.log(`idle: no request for ${o.idleMin} min of server time; stopping for good`)
        return { reason: `idle: no request for ${o.idleMin} min`, final: true, code: 0 }
      }
      if (now - this.startedAt >= o.restartMin * 60_000) return { reason: `scheduled restart after ${o.restartMin} min`, final: false }
      if (this.claim && o.slot === 'compile' && now - this.startedAt >= SLOT_COMPILE_MS) await this.releaseSlot('no compiled response within 3 min')
      if (this.dirty) {
        this.dirty = false
        this.writeStatus()
      }
    }
  }

  async stopServer(reason, final) {
    const { child, pid } = this
    this.lastReason = reason
    if (!final) this.write('restarting')
    this.log(`stopping pid ${pid}: ${reason}`)
    if (pid && child.exitCode === null && child.signalCode === null) {
      child.kill() // the root through Node's own handle, so never a process that took its id
      const until = this.d.now() + 10_000
      while (child.exitCode === null && child.signalCode === null && this.d.now() < until) await this.d.sleep(250)
      if (child.exitCode === null && child.signalCode === null) this.log(`error: pid ${pid} still runs 10 s after it was stopped`)
    }
    if (pid) await this.stopStarted(pid)
    this.untail?.()
    this.untail = null
    await this.releaseSlot('server stopped')
    this.child = null
    this.pid = null
    this.downSince = this.d.now()
    this.guardSay('none')
    this.events.emit('stop', { pid, reason, at: this.d.now() })
  }

  /** Stops what the root started (and theirs), which a root that isn't Node leaves running. */
  async stopStarted(pid) {
    const created = this.rootCreated
    if (created === null) return this.log(`error: no start time for pid ${pid}, so what it started is left to the port wait`)
    const { targets, results } = await killTree(pid, created, { run: this.d.exec })
    if (targets === null) this.log('error: could not read the process table, so what the server started is left to the port wait')
    else if (targets.length) this.log(`stopped what pid ${pid} started, deepest first: ${results.join(', ')}`)
  }

  async portHolders() {
    try {
      return await (this.d.portHolders ?? (p => portListeners(p, this.d.exec)))(this.o.port)
    } catch {
      return null
    }
  }

  async waitPortFree() {
    const until = this.d.now() + 30_000
    for (;;) {
      const holders = await this.portHolders()
      if (holders?.length === 0) return true
      if (this.d.now() >= until) {
        this.log(`error: port ${this.o.port} is still in use after 30 s (${holders ? `pid ${holders.join(', ')}` : 'netstat failed'})`)
        return false
      }
      await this.d.sleep(1000)
    }
  }

  write(state, reason) {
    this.state = state
    if (reason !== undefined) this.lastReason = reason
    this.writeStatus()
  }

  writeStatus() {
    const { o } = this
    const s = { v: 1, name: o.name, dir: o.dir, port: o.port, pid: this.pid, state: this.state, startedAt: this.startedAt, lastHitAt: this.lastHitAt,
      restarts: this.restarts, lastReason: this.lastReason, slot: this.slotName, runnerPid: process.pid, at: this.d.now() }
    try {
      writeJsonAtomic(this.statusPath, s)
    } catch (e) {
      this.log(`error writing ${this.statusPath}: ${e.message}`)
    }
    this.events.emit('status', s)
  }

  log(msg) {
    try {
      appendFileSync(this.logPath, `${new Date(this.d.now()).toISOString()} ${msg}\n`)
    } catch {}
    this.d.err(`[dev-run ${this.o.name}] ${msg}`)
    this.events.emit('log', msg)
  }

  // The guard: a detached copy of this script that holds a pipe from the runner. When the runner
  // dies without stopping its server (killed outright, so no signal handler ran), the pipe ends and
  // the guard stops what is left of the server's tree (see guardMain).
  startGuard() {
    if (!this.d.guard) return
    this.guardProc = spawn(process.execPath, [fileURLToPath(import.meta.url), '--guard', String(process.pid), this.statusPath, this.logPath], {
      detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
    })
    this.guardProc.stdin.on('error', () => {})
    this.guardProc.unref()
  }

  guardSay(line) {
    this.guardProc?.stdin.write(`${line}\n`)
  }

  endGuard() {
    const g = this.guardProc
    return g ? new Promise(r => g.stdin.end('none\n', r)) : undefined
  }
}

export function wireSignals(runner, proc = process) {
  for (const sig of Object.keys(EXIT_CODES)) proc.on(sig, () => runner.requestStop(sig))
}

// The runner's server root usually dies with the runner: Node puts each child it spawns in a job
// that ends with it. A root that isn't Node (cmd.exe running a .cmd shim) has no such job, so what it
// started lives on, holding the port. The guard is told the root's id and real start time, and stops
// the root if it still runs, and the tree it started, by the same age-checked walk as a stop.
async function guardMain([runner, statusPath, logPath]) {
  let pid = null
  let created = null
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on('line', l => {
    const m = /^child (\d+) (\d+)$/.exec(l)
    pid = m ? Number(m[1]) : null
    created = m ? BigInt(m[2]) : null
  })
  await once(lines, 'close')
  if (!pid) return
  const note = msg => {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} guard: ${msg}\n`)
    } catch {}
  }
  const { targets, results } = await killTree(pid, created, { includeRoot: true })
  const stopped = results.filter(r => r.startsWith('stopped ')).map(r => r.slice(8))
  if (targets === null) note(`runner ${runner} ended; the process table could not be read`)
  else if (targets.length) note(`runner ${runner} ended without stopping its server, pid ${pid}: ${results.join(', ')}`)
  else note(`runner ${runner} ended; its server ended with it`)
  const s = readJson(statusPath)
  const lastReason = `runner ${runner} ended; ${stopped.length ? `its guard stopped pid ${stopped.join(', ')}` : 'its server ended with it'}`
  if (s) {
    try {
      writeJsonAtomic(statusPath, { ...s, pid: null, state: 'stopped', slot: null, lastReason, at: Date.now() })
    } catch {}
  }
}

async function main(argv) {
  if (argv[0] === '--guard') return guardMain(argv.slice(1))
  if (argv[0] === '--help' || argv[0] === '-h') return void console.log(USAGE)
  if (process.platform !== 'win32') return (console.error('dev-run: Windows only for now'), 2)
  let runner
  try {
    runner = new DevRun(parseArgs(argv))
  } catch (e) {
    if (!(e instanceof UsageError)) throw e
    console.error(`dev-run: ${e.message}\n\n${USAGE}`)
    return 2
  }
  wireSignals(runner)
  try {
    return await runner.run()
  } catch (e) {
    console.error(`dev-run: ${e.message}`)
    return e instanceof UsageError ? 2 : 1
  }
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) process.exit((await main(process.argv.slice(2))) ?? 0)
