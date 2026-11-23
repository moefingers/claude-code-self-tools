// self-update's fixed scripts (plugins/self-update/hooks/scripts.ts): that the pieces it carries are the copies they
// were taken from, and, on Windows, that UPDATE_SCRIPT does what it says when a real Windows PowerShell runs it against
// a stand-in claude.cmd in a temporary folder (never the real CLI; nothing leaves the folder). Run with
// `node --test "scripts/*.test.mjs"`.
//
// - The lock's two scripts are self-remote-control's, byte for byte (plugins/self-remote-control/hooks/rc-lock.ts), with
//   the same SHA-256s: self-update takes the lock another plugin that keeps plugins current takes, the same way.
// - How a script runs (the bootstrap, the call, the paths, the folder check) is the shared machine code's
//   (shared/hooks/machine.ts), which self-update doesn't carry.
// - The script's runs (Windows only): the fixed words reach the command from the folder it was started in; what is not a
//   name is refused before a claude is looked for; no claude, or only one the folder it runs from could supply, runs
//   nothing; an npm claude under the home folder runs for a step run from there; a bare `node` is never looked for in
//   the folder (and the control: it is, with that one line of the script taken out); and a command out of time is ended
//   with its child, or never started.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { ROOT } from './sync-shared.mjs'

const HOOKS = join(ROOT, 'plugins', 'self-update', 'hooks')
const scripts = await import(pathToFileURL(join(HOOKS, 'scripts.ts')).href)
const rcLock = await import(pathToFileURL(join(ROOT, 'plugins', 'self-remote-control', 'hooks', 'rc-lock.ts')).href)
const machine = await import(pathToFileURL(join(ROOT, 'shared', 'hooks', 'machine.ts')).href)

/**
 * update-logic.ts, loaded under Node: a copy beside a copy of scripts.ts in a temporary folder, its one import given the
 * file's extension (the plugin's modules import without one, as the engine loads them; Node's own loader needs it).
 */
async function loadLogic() {
  const dir = mkdtempSync(join(tmpdir(), 'self-update-logic-'))
  after(() => rmSync(dir, { recursive: true, force: true }))
  copyFileSync(join(HOOKS, 'scripts.ts'), join(dir, 'scripts.ts'))
  const text = readFileSync(join(HOOKS, 'update-logic.ts'), 'utf8')
  assert.equal(text.split("from './scripts'").length - 1, 1, "update-logic.ts imports one module of its own by value, './scripts', once (a type import is erased)")
  writeFileSync(join(dir, 'update-logic.ts'), text.replace("from './scripts'", "from './scripts.ts'"))
  return import(pathToFileURL(join(dir, 'update-logic.ts')).href)
}
const logic = await loadLogic()

test("the lock's two scripts are self-remote-control's, byte for byte, pinned by the same SHA-256s", () => {
  assert.equal(scripts.TAKE_SCRIPT, rcLock.TAKE_SCRIPT)
  assert.equal(scripts.RELEASE_SCRIPT, rcLock.RELEASE_SCRIPT)
  assert.equal(scripts.TAKE_SHA256, rcLock.TAKE_SHA256)
  assert.equal(scripts.RELEASE_SHA256, rcLock.RELEASE_SHA256)
  assert.equal(createHash('sha256').update(Buffer.from(scripts.TAKE_SCRIPT, 'utf8')).digest('hex'), scripts.TAKE_SHA256)
  assert.equal(createHash('sha256').update(Buffer.from(scripts.RELEASE_SCRIPT, 'utf8')).digest('hex'), scripts.RELEASE_SHA256)
})

test("how a script runs is the shared machine code's: the bootstrap, the call, Windows PowerShell's path, the state folder, the folder check", () => {
  assert.equal(scripts.STDIN_BOOTSTRAP, machine.STDIN_BOOTSTRAP)
  assert.equal(scripts.STDIN_BOOTSTRAP, rcLock.STDIN_BOOTSTRAP)
  const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  assert.deepEqual(scripts.powershellCall(ps, scripts.UPDATE_SCRIPT), machine.powershellCall(ps, scripts.UPDATE_SCRIPT))
  assert.equal(scripts.powershellPath('C:\\Windows'), machine.powershellPath('C:\\Windows'))
  assert.equal(scripts.stateFolder('C:\\Users\\tester\\AppData\\Local\\'), machine.stateFolder('C:\\Users\\tester\\AppData\\Local\\'))
  assert.equal(scripts.SYSTEM_ROOT.source, machine.SYSTEM_ROOT.source)
  assert.equal(scripts.SESSION_ID.source, machine.SESSION_ID.source)
  for (const path of ['C:\\Users\\tester','C:\\Users\\tester\\', 'D:\\a b\\c', 'C:\\work\\O\'Brien', 'C:\\x\\..\\y', 'C:/x', '\\\\server\\share', 'relative', 'C:\\a\u0007b', `C:\\${'x'.repeat(240)}`, 'C:\\x:y', 'C:\\ x', 5, undefined])
    assert.equal(scripts.isSafeFolder(path), machine.isSafeFolder(path), String(path))
})

test("the pending marker is read where, and as, self-exit and self-restart write it: the shared machine code's pendingPath and readPending", () => {
  const state = 'C:\\Users\\tester\\AppData\\Local\\claude-self-tools'
  for (const id of ['aaaaaaaa-0000-4000-8000-000000000001', 'AAAAAAAA-0000-4000-8000-000000000001', '..\\x', '', 5, undefined, 'aaaaaaaa-0000-4000-8000-000000000001\\..'])
    assert.equal(scripts.pendingPath(state, id), machine.pendingPath(state, id), String(id))
  assert.equal(scripts.PENDING_MS, machine.PENDING_MS)
  assert.equal(scripts.PENDING_AHEAD_MS, machine.PENDING_AHEAD_MS)
  const now = 1_700_000_000_000
  // What each writes (pendingMarker, PENDING_DONE), and what may be found in its place.
  const texts = [
    machine.pendingMarker('exit', now),
    machine.pendingMarker('restart', now - 60_000),
    machine.pendingMarker('exit', now - 16 * 60_000),
    machine.pendingMarker('exit', now + 2 * 60_000),
    machine.PENDING_DONE,
    JSON.stringify({ v: 1, kind: 'switch', at: now }),
    JSON.stringify({ v: 2, kind: 'exit', at: now }),
    '[]',
    'null',
    '{',
    '',
  ]
  for (const text of texts) assert.equal(scripts.readPending(text, now), machine.readPending(text, now), text)
  assert.equal(scripts.readPending(machine.pendingMarker('exit', now), now), 'pending')
})

// The script as the plugin runs it (powershellCall), by a real Windows PowerShell, against a stand-in claude.cmd.
const isWindows = process.platform === 'win32'
const PS = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const SKIP = !(isWindows && existsSync(PS)) && 'Windows PowerShell only'
/** The variable that keeps cmd.exe from looking in the folder it runs from for a program named bare: the script sets it for the command it starts. */
const CWD_RULE = 'NoDefaultCurrentDirectoryInExePath'

/**
 * A child's environment: `base` with `drop` taken out and `set` laid over it, each by name whatever its letters' case.
 * A name's one spelling is not enough on Windows, where a process can hand a child the same variable under two
 * spellings, and the child is then given whichever sorts first: a variable cleared under one spelling would stay set
 * under the other.
 */
function envWith(base, set, drop = []) {
  const gone = new Set([...drop, ...Object.keys(set)].map(name => name.toUpperCase()))
  return { ...Object.fromEntries(Object.entries(base).filter(([name]) => !gone.has(name.toUpperCase()))), ...set }
}

test("a child's environment: a name is taken out, and laid over, whatever its letters' case", () => {
  const twice = { Path: 'a', PATH: 'a', [CWD_RULE]: '1', [CWD_RULE.toUpperCase()]: '1', Other: 'x', OTHER: 'x' }
  assert.deepEqual(envWith(twice, { PATH: 'b' }, [CWD_RULE]), { Other: 'x', OTHER: 'x', PATH: 'b' })
  assert.deepEqual(envWith(twice, { [CWD_RULE.toLowerCase()]: '0' }), { Path: 'a', PATH: 'a', Other: 'x', OTHER: 'x', [CWD_RULE.toLowerCase()]: '0' })
})

/** The folders and stand-ins, made once, on first use (so a machine that skips the runs makes none), and removed after the last test. */
let made
after(() => {
  if (made !== undefined) rmSync(made.dir, { recursive: true, force: true })
})
function place() {
  if (made !== undefined) return made
  const dir = mkdtempSync(join(tmpdir(), 'self-update-script-'))
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  // bin: a claude on PATH, outside every folder a command runs from. home: the home folder, with an npm install's claude
  // under it. repo: a project's folder, with a claude.cmd and a node.cmd of its own, and a claude.cmd deeper in it.
  const [bin, home, repo] = [join(dir, 'bin'), join(dir, 'home'), join(dir, 'repo')]
  const npm = join(home, 'AppData', 'Roaming', 'npm')
  for (const d of [bin, npm, join(dir, 'empty'), join(repo, 'tools')]) mkdirSync(d, { recursive: true })
  // The stand-in: says its arguments and its folder; told to, it starts a child that writes a mark 11 s on, runs a bare `node`, or fails.
  const standIn = ['@echo off', 'echo stand-in args: %*', 'echo stand-in cwd: %CD%', 'if "%STAND_IN_LATE%"=="1" ( cmd /c ""%~dp0late.cmd"" )', 'if "%STAND_IN_NODE%"=="1" ( node --version )', 'if "%STAND_IN_FAIL%"=="1" (', '  echo progress before it failed', '  echo Error: the stand-in failed 1>&2', '  exit /b 7', ')', 'echo stand-in done', 'exit /b 0', ''].join('\r\n')
  writeFileSync(join(bin, 'claude.cmd'), standIn)
  writeFileSync(join(npm, 'claude.cmd'), standIn)
  writeFileSync(join(bin, 'late.cmd'), ['@echo off', 'ping -n 12 127.0.0.1 >nul', 'echo late> "%STAND_IN_MARK%"', ''].join('\r\n'))
  // The repository's own: none of them may ever run.
  writeFileSync(join(repo, 'node.cmd'), '@echo off\r\necho REPO NODE RAN\r\n')
  writeFileSync(join(repo, 'claude.cmd'), '@echo off\r\necho REPO CLAUDE RAN\r\n')
  writeFileSync(join(repo, 'tools', 'claude.cmd'), '@echo off\r\necho REPO CLAUDE RAN\r\n')
  /** The environment a run's PowerShell starts with: this process's, without the script's own variable, the home folder and PATH laid over it, then the step's variables and the run's own. */
  const envOf = (step, how = {}) => envWith(process.env, { USERPROFILE: home, PATH: how.path ?? `${bin};${system}`, ...step, ...how.env }, [CWD_RULE])
  /** What a child started with `env` has of the script's variable: what cmd.exe's own `set` prints for the name, '' for none. */
  const ruleIn = env => (spawnSync(join(system, 'cmd.exe'), ['/d', '/c', 'set', CWD_RULE], { env, encoding: 'utf8', timeout: 30_000 }).stdout ?? '').trim()
  /** One run of the script, from the home folder unless told otherwise, with `bin` first on PATH unless told otherwise. */
  const run = (step, how = {}) => {
    const call = scripts.powershellCall(PS, how.script ?? scripts.UPDATE_SCRIPT)
    const done = spawnSync(call.argv[0], call.argv.slice(1), { input: call.stdin, cwd: how.cwd ?? home, env: envOf(step, how), encoding: 'utf8', timeout: 60_000 })
    return { code: done.status, out: done.stdout ?? '', err: done.stderr ?? '', reply: logic.readStepReply(done.stdout ?? '', done.stderr ?? '', done.status ?? -1) }
  }
  const market = logic.stepEnv({ kind: 'marketplace', marketplace: 'zz-stand-in' })
  const user = logic.stepEnv({ kind: 'plugin', plugin: 'zz-plugin', marketplace: 'zz-stand-in', scope: 'user' })
  const local = logic.stepEnv({ kind: 'plugin', plugin: 'zz-plugin', marketplace: 'zz-stand-in', scope: 'local', folder: repo })
  const project = logic.stepEnv({ kind: 'plugin', plugin: 'zz-plugin', marketplace: 'zz-stand-in', scope: 'project', folder: repo })
  made = { dir, system, bin, home, repo, npm, envOf, ruleIn, run, market, user, local, project }
  return made
}

test('a marketplace and a plugin: the fixed words reach the command, in the folder it was started from, and its exit code and last line come back', { skip: SKIP }, () => {
  const { run, market, local, repo } = place()
  const m = run(market)
  assert.ok(m.out.includes('stand-in args: plugin marketplace update zz-stand-in\r\n'), m.out)
  assert.deepEqual([m.reply, m.code], [{ code: 0, line: 'stand-in done' }, 0])
  const p = run(local, { cwd: repo })
  assert.ok(p.out.includes('stand-in args: plugin update zz-plugin@zz-stand-in --scope local\r\n'), p.out)
  assert.match(p.out, /stand-in cwd: [^\r\n]*\\repo\r\n/)
  assert.deepEqual([p.reply, p.code], [{ code: 0, line: 'stand-in done' }, 0])
  // One that fails: its own exit code, and what it said on standard error, not the progress before it.
  const failed = run(local, { cwd: repo, env: { STAND_IN_FAIL: '1' } })
  assert.deepEqual([failed.reply, failed.code], [{ code: 7, line: 'Error: the stand-in failed' }, 7])
})

test('what is not a name is refused before a claude is looked for: a flag, a name inside other text, one ending in a line break, another case, another scope', { skip: SKIP }, () => {
  const { run, market, local } = place()
  for (const step of [
    { ...market, SELF_UPDATE_NAME: '--force' },
    { ...market, SELF_UPDATE_NAME: 'zz-stand-in; calc' },
    { ...market, SELF_UPDATE_NAME: 'x zz-stand-in' },
    { ...market, SELF_UPDATE_NAME: 'zz-stand-in\n' },
    { ...market, SELF_UPDATE_NAME: 'zz-plugin@zz-stand-in' },
    { ...market, SELF_UPDATE_KIND: 'Marketplace' },
    { ...local, SELF_UPDATE_SCOPE: 'managed' },
    { ...local, SELF_UPDATE_SCOPE: 'User' },
    { ...local, SELF_UPDATE_NAME: 'zz-plugin' },
    { ...local, SELF_UPDATE_NAME: 'zz-plugin@zz-stand-in --force' },
  ]) {
    const r = run(step)
    assert.deepEqual([step, r.reply, r.code, r.out.includes('stand-in')], [step, 'refused', 96, false])
  }
})

test('no claude that can be started: said, and nothing runs', { skip: SKIP }, () => {
  const { run, market, dir, system } = place()
  const none = run(market, { path: `${join(dir, 'empty')};${system}` })
  assert.deepEqual([none.reply, none.code], ['no-claude', 97])
})

test("a claude the folder it runs from could supply is never run: directly in it, or (a project's or a local scope) anywhere under it, however PATH names it", { skip: SKIP }, () => {
  const { run, market, local, project, repo, bin, system } = place()
  // Directly in the folder, by a PATH that names `.`: found, and refused, for any step.
  const own = run(market, { path: `.;${system}`, cwd: repo })
  assert.deepEqual([own.reply, own.code, own.out.includes('REPO CLAUDE RAN')], ['inside', 94, false])
  // Deeper in a project's folder, by its full path spelt in another case: refused for a local and a project scope.
  for (const step of [local, project]) {
    const deep = run(step, { path: `${join(repo, 'tools').toUpperCase()};${system}`, cwd: repo })
    assert.deepEqual([deep.reply, deep.code, deep.out.includes('REPO CLAUDE RAN')], ['inside', 94, false])
  }
  // The same by a relative PATH entry: whether or not this PowerShell finds a claude through it, it never runs it.
  const relative = run(local, { path: `tools;.\\tools;${system}`, cwd: repo })
  assert.ok(['inside', 'no-claude'].includes(relative.reply), JSON.stringify(relative.reply))
  assert.ok(!(relative.out + relative.err).includes('REPO CLAUDE RAN'))
  // One outside, later on PATH, is the one that runs.
  const outside = run(local, { path: `${join(repo, 'tools')};${bin};${system}`, cwd: repo })
  assert.deepEqual([outside.reply, outside.out.includes('REPO CLAUDE RAN')], [{ code: 0, line: 'stand-in done' }, false])
})

test("an npm install's claude, under the home folder, is the one a step run from the home folder runs", { skip: SKIP }, () => {
  const { run, market, user, local, npm, system } = place()
  for (const step of [market, user]) {
    const r = run(step, { path: `${npm};${system}` })
    assert.deepEqual([r.reply, r.code], [{ code: 0, line: 'stand-in done' }, 0])
  }
  // A local scope whose project is the home folder itself: that claude is under the folder it would run from, so this one step isn't run.
  const inHome = run(local, { path: `${npm};${system}` })
  assert.deepEqual([inHome.reply, inHome.code, inHome.out.includes('stand-in')], ['inside', 94, false])
})

test('a program the command names bare is never looked for in the folder it runs from', { skip: SKIP }, () => {
  const { run, local, repo } = place()
  const r = run(local, { cwd: repo, env: { STAND_IN_NODE: '1' } })
  assert.ok(r.out.includes('stand-in done'), r.out)
  assert.ok(!(r.out + r.err).includes('REPO NODE RAN'))
})

test("the control: it is the script's own line, and nothing else, that keeps cmd.exe out of that folder (skipped, saying why, where no child can be started without the variable)", { skip: SKIP }, t => {
  const { run, local, repo, envOf, ruleIn } = place()
  const how = { cwd: repo, env: { STAND_IN_NODE: '1' } }
  // The control needs a child that starts WITHOUT the variable, so that the script's line is the only thing that can
  // bring it. The runs' environment takes it out whatever its case (envOf), and that is checked here on a real child.
  const still = ruleIn(envOf(local, how))
  if (still !== '') {
    t.skip(`a child of this process has ${still} whatever a test clears, so nothing here could show the script's line at work`)
    return
  }
  // With the line, in that environment: not looked for.
  const withLine = run(local, how)
  assert.ok(withLine.out.includes('stand-in done'))
  assert.ok(!(withLine.out + withLine.err).includes('REPO NODE RAN'))
  // The same run with that one line taken out of the script, and nothing else changed: cmd.exe finds the repository's node.cmd first.
  const line = `$start.EnvironmentVariables['${CWD_RULE}'] = '1'\n`
  assert.equal(scripts.UPDATE_SCRIPT.split(line).length - 1, 1)
  const without = scripts.UPDATE_SCRIPT.split(line).join('')
  assert.equal(without.length, scripts.UPDATE_SCRIPT.length - line.length)
  assert.ok(run(local, { ...how, script: without }).out.includes('REPO NODE RAN'))
  // And why the environment has to be cleared for this: with the variable already there, under any spelling, the
  // repository's node isn't run even without the line, and the run above would have shown nothing.
  for (const name of [CWD_RULE, CWD_RULE.toUpperCase()]) {
    const preset = run(local, { ...how, env: { STAND_IN_NODE: '1', [name]: '1' }, script: without })
    assert.deepEqual([name, preset.out.includes('stand-in done'), (preset.out + preset.err).includes('REPO NODE RAN')], [name, true, false])
  }
})

test('a command whose time runs out is ended with every process it started, and one with too little time left is never started; the script says so', { skip: SKIP }, () => {
  const { run, market, dir } = place()
  const wait = ms => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  const withLimit = ms => scripts.UPDATE_SCRIPT.split(`$limitMs = ${scripts.STEP_MS}`).join(`$limitMs = ${ms}`)
  assert.notEqual(withLimit(7_000), scripts.UPDATE_SCRIPT)
  // In time: the command's child writes its mark 11 s on, and the command ends by itself.
  const marks = [1, 2, 3].map(n => join(dir, `mark-${n}.txt`))
  const inTime = run(market, { env: { STAND_IN_LATE: '1', STAND_IN_MARK: marks[0] } })
  assert.deepEqual([inTime.reply, existsSync(marks[0])], [{ code: 0, line: 'stand-in done' }, true])
  // The same script with 7 s in all (the figure is the only change): started, and ended with its child, 7 s from the script's own start.
  const started = Date.now()
  const over = run(market, { script: withLimit(7_000), env: { STAND_IN_LATE: '1', STAND_IN_MARK: marks[1] } })
  assert.deepEqual([over.reply, over.code], ['ended', 95])
  assert.ok(over.out.includes('stand-in args: plugin marketplace update zz-stand-in'))
  assert.ok(!over.out.includes('stand-in done'))
  // Long before the stand-in's child would have ended by itself, and before this run's own 60 s.
  assert.ok(Date.now() - started < 30_000)
  // With 3 s in all, less than the least is left by the time the command would start: it never does.
  const begun = Date.now()
  const never = run(market, { script: withLimit(3_000), env: { STAND_IN_LATE: '1', STAND_IN_MARK: marks[2] } })
  assert.deepEqual([never.reply, never.code, never.out.includes('stand-in')], ['ended', 95, false])
  assert.ok(Date.now() - begun < 30_000)
  // Past the moment either child would have written its mark: neither did.
  wait(9_000)
  assert.deepEqual(marks.slice(1).map(mark => existsSync(mark)), [false, false])
})
