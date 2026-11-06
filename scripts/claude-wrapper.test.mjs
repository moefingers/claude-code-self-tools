// The claude wrapper, tools/claude-wrapper/claude-wrapper.ps1, run for real in Windows PowerShell 5.1
// and PowerShell 7 against a stub claude.exe (scripts/claude-wrapper-stub.cs, compiled into a
// temporary folder): a ticket that holds resumes the conversation in the same shell, with the
// launch environment; each one that doesn't is said and resumes nothing; the loop is capped; the
// ticket is deleted before it is used; the pane file is removed, and the person's environment and
// folder put back. The ticket rules are checked against checkPaneTicket in the shared machine code,
// and the fixed script that writes a ticket is run too. Then faults are planted, in a copy of the
// wrapper or of the machine code, and each must be caught.
//
// No real Claude Code runs: every shell starts with an environment built here, whose PATH holds the
// stub and the system's folders only, and whose USERPROFILE, LOCALAPPDATA and CLAUDE_CONFIG_DIR are
// temporary folders. Windows only. Run with `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { ROOT } from './sync-shared.mjs'

const isWindows = process.platform === 'win32'
const WRAPPER = join(ROOT, 'tools', 'claude-wrapper', 'claude-wrapper.ps1')
const MACHINE = join(ROOT, 'shared', 'hooks', 'machine.ts')
const machine = await import(pathToFileURL(MACHINE).href)

const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows'
const WINDOWS_POWERSHELL = join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const PWSH = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
const SHELLS = [
  ['Windows PowerShell 5.1', WINDOWS_POWERSHELL],
  ['PowerShell 7', PWSH],
].filter(([, path]) => existsSync(path))

/**
 * A conversation for the fixture probes, and a token that is no tab's. The runs each resume one of
 * their own (lab()), so that one run's resumed claude, still on its command line, is never another's
 * conversation open elsewhere.
 */
const ID = '00000000-0000-4000-a000-000000000001'
const OTHER_TOKEN = '00000000-0000-4000-a000-000000000002'
/** The token a ticket is built with before the stub puts the tab's own in its place. */
const PLACEHOLDER = '00000000-0000-4000-8000-000000000000'

/** The line that reads the ticket's config folders into the last look, once each. */
const LOOK_IN = String.raw`        if ($null -ne $t.configDirs) { foreach ($dir in @($t.configDirs)) { if (@($lookIn | Where-Object { $_.TrimEnd('\') -eq $dir.TrimEnd('\') }).Count -eq 0) { $lookIn += $dir } } }` + '\n'
/** The line that takes the left record's last look, after RECHECK found nothing. */
const LEFT_LOOK = '        if ($null -eq $why -and $null -ne $t.left) { $why = Test-Left $t.resume $lookIn $t.left.size $t.left.mtime $t.left.exitAt }\n'

/** The line the wrapper prints for a ticket it doesn't use. */
const NOT_USED = 'claude: the ticket to resume a session in this tab was not used: '

let work
let stub

/**
 * A folder of its own for one run: the stub on its PATH, a home, a LOCALAPPDATA, a config folder; a
 * conversation of its own (`id`), its transcript under `work`'s project, and the claim lock on it for
 * one launch (`by`), as a switch or restart leaves them.
 */
function lab() {
  const root = mkdtempSync(join(work, 'run-'))
  const dirs = { root, bin: join(root, 'bin'), home: join(root, 'home'), local: join(root, 'local'), config: join(root, 'config'), start: join(root, 'start'), work: join(root, 'work'), plan: join(root, 'plan') }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  copyFileSync(stub, join(dirs.bin, 'claude.exe'))
  const id = randomUUID()
  const by = `launch:${randomUUID()}`
  const project = machine.projectName(dirs.work)
  mkdirSync(join(dirs.config, 'projects', project), { recursive: true })
  // Empty: the wrapper checks the transcript by its name, and never reads it.
  writeFileSync(join(dirs.config, 'projects', project, `${id}.jsonl`), '')
  const lock = join(dirs.local, 'claude-self-tools', 'claims', `${id}.lock`)
  mkdirSync(join(dirs.local, 'claude-self-tools', 'claims'), { recursive: true })
  writeFileSync(lock, JSON.stringify({ v: 1, by, pid: 4, created: '1', at: Date.now(), transport: 'pane' }))
  return { ...dirs, id, by, lock }
}

/**
 * A ticket as the plugins build it (paneTicket), for the stub to write: {TOKEN} for the tab's token,
 * "{NOW}" for the time it writes it. `change` alters the parsed ticket first, for a ticket that breaks a rule.
 */
function ticketFor(dirs, change = {}) {
  const built = JSON.parse(machine.paneTicket({ token: PLACEHOLDER, resume: dirs.id, by: dirs.by, dir: dirs.work, at: 1 }))
  return JSON.stringify({ ...built, token: '{TOKEN}', at: '{NOW}', ...change })
}

/**
 * Another Claude Code holding the run's conversation while the wrapper takes its last look: a stub
 * claude.exe that sleeps, named on its command line (`L2`: --resume <id>), or with a registry file in
 * the run's config folder naming the conversation (`L1`). Stop it with `.kill()`.
 */
function holdElsewhere(dirs, how) {
  const bin = join(dirs.root, 'elsewhere')
  mkdirSync(bin)
  copyFileSync(stub, join(bin, 'claude.exe'))
  const env = { SystemRoot: SYSTEM_ROOT, LOCALAPPDATA: join(dirs.root, 'elsewhere-local'), STUB_LOG: join(dirs.root, 'elsewhere.jsonl'), STUB_SLEEP_MS: '90000' }
  const child = spawn(join(bin, 'claude.exe'), how === 'L2' ? ['--resume', dirs.id] : [], { env, windowsHide: true, stdio: 'ignore' })
  if (how === 'L1') {
    mkdirSync(join(dirs.config, 'sessions'), { recursive: true })
    writeFileSync(join(dirs.config, 'sessions', `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId: dirs.id, procStart: '0' }))
  }
  return child
}

/** A stub's template as checkPaneTicket reads it, for `token` at `now`: what the stub would write. */
const rendered = (template, token, now) =>
  template.split('{TOKEN}').join(token).split('"{NOW}"').join(String(now)).split('"{OLD}"').join(String(now - 200_000)).split('"{AHEAD}"').join(String(now + 60_000))

/** The script each shell runs: the wrapper defined in it, then `claude` typed once, then what it left behind. */
const DRIVER = String.raw`$ErrorActionPreference = 'Stop'
. ([scriptblock]::Create([IO.File]::ReadAllText($env:WRAPPER_UNDER_TEST)))
$created = [string](Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $PID" -Property CreationDate).CreationDate.ToFileTimeUtc()
Set-Location -LiteralPath $env:TEST_START
# A process that names the conversation on its command line and has exited, this shell still holding a handle to it.
$exited = $null
if ($env:TEST_HELD_EXITED) { $exited = Start-Process -FilePath $env:ComSpec -ArgumentList '/c', 'exit', '--resume', $env:TEST_HELD_EXITED -PassThru -NoNewWindow; $exited.WaitForExit() }
if ($env:TEST_FIRST_RESUME) { claude --resume $env:TEST_FIRST_RESUME } else { claude --first 'two words' -c }
$code = $LASTEXITCODE
if ($null -ne $exited) { $exited.Dispose() }
$markers = @(${machine.SESSION_MARKERS.map(name => `'${name}'`).join(', ')})
$panes = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'claude-self-tools\panes' } else { Join-Path $env:TEST_LOCAL 'claude-self-tools\panes' }
$after = [ordered]@{
  pid = $PID
  created = $created
  lastExit = $code
  location = (Get-Location).ProviderPath
  tokenSet = $null -ne [Environment]::GetEnvironmentVariable('CLAUDE_PANE_TOKEN')
  forceSet = $null -ne [Environment]::GetEnvironmentVariable('CLAUDE_CODE_FORCE_SESSION_PERSISTENCE')
  reapSet = $null -ne [Environment]::GetEnvironmentVariable('CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP')
  markersLost = @($markers | Where-Object { [Environment]::GetEnvironmentVariable($_) -ne 'marker-test' })
  wt = ($env:WT_SESSION -eq 'wt-test') -and ($env:WT_PROFILE_ID -eq 'wt-profile-test')
  files = @(if (Test-Path -LiteralPath $panes) { Get-ChildItem -LiteralPath $panes -File | ForEach-Object { $_.Name } })
}
'AFTER ' + (ConvertTo-Json -InputObject $after -Compress)
`

/** The variables every shell starts with: the system's, and this lab's; the markers set, so their clearing shows. */
function environment(dirs, extra) {
  const keep = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'CommonProgramFiles']
  const env = Object.fromEntries(keep.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]))
  const all = {
    ...env,
    PATH: [dirs.bin, join(SYSTEM_ROOT, 'System32'), SYSTEM_ROOT, join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0'), join(PWSH, '..')].join(';'),
    USERPROFILE: dirs.home,
    APPDATA: join(dirs.home, 'AppData', 'Roaming'),
    LOCALAPPDATA: dirs.local,
    CLAUDE_CONFIG_DIR: dirs.config,
    STUB_LOG: join(dirs.root, 'log.jsonl'),
    STUB_PLAN: dirs.plan,
    STUB_EXIT: '7',
    TEST_START: dirs.start,
    TEST_LOCAL: dirs.local,
    WT_SESSION: 'wt-test',
    WT_PROFILE_ID: 'wt-profile-test',
    ...Object.fromEntries(machine.SESSION_MARKERS.map(name => [name, 'marker-test'])),
    ...extra,
  }
  // Never without USERPROFILE: PowerShell (5.1 and 7) sets it again from the account's profile, and the
  // wrapper would then find the real claude.exe in its .local\bin. Every run's home is a lab folder.
  if (typeof all.USERPROFILE !== 'string' || !all.USERPROFILE.startsWith(work)) throw new Error('a shell must start with USERPROFILE in its lab, never without one')
  // A variable given as null is left out: the shell starts without it.
  return Object.fromEntries(Object.entries(all).filter(([, value]) => value !== null))
}

/** One shell, the wrapper defined and `claude` typed: what it printed, what the stub logged, and what was left. */
function run(shell, dirs, { plan = {}, env = {}, wrapper = WRAPPER, timeoutMs = 60_000 } = {}) {
  for (const [n, text] of Object.entries(plan)) writeFileSync(join(dirs.plan, `${n}.json`), text)
  const call = machine.powershellCall(shell, DRIVER)
  return new Promise(resolve => {
    const child = spawn(call.argv[0], call.argv.slice(1), { env: environment(dirs, { WRAPPER_UNDER_TEST: wrapper, ...env }), cwd: dirs.root, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('close', code => {
      clearTimeout(timer)
      const log = join(dirs.root, 'log.jsonl')
      const runs = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
      const line = stdout.split(/\r?\n/).find(l => l.startsWith('AFTER '))
      resolve({ code, stdout, stderr, runs, pid: child.pid, after: line === undefined ? undefined : JSON.parse(line.slice('AFTER '.length)) })
    })
    child.stdin.end(call.stdin)
  })
}

/** What went wrong, as lines; none when all is as it must be. */
function problems() {
  const found = []
  const check = (ok, what) => {
    if (!ok) found.push(what)
  }
  return { found, check }
}

/** What every run leaves when it is over: the folder, the environment and no file of the tab. */
function leftAsItWas(check, dirs, result) {
  const a = result.after
  check(a !== undefined, `the driver ended: exit ${result.code}, stderr ${result.stderr.slice(0, 400)}`)
  if (a === undefined) return
  check(a.location === dirs.start, `the folder is put back (${a.location})`)
  check(a.tokenSet === false, 'CLAUDE_PANE_TOKEN is put back (unset)')
  check(a.forceSet === false, 'CLAUDE_CODE_FORCE_SESSION_PERSISTENCE is put back (unset)')
  check(a.reapSet === false, 'CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP is put back (unset)')
  check(a.markersLost.length === 0, `the markers are put back (${a.markersLost.join(', ')})`)
  check(a.wt === true, 'WT_SESSION and WT_PROFILE_ID are as they were')
  check(a.files.length === 0, `the pane file and the ticket are gone (${a.files.join(', ')})`)
}

/** A ticket that holds: the conversation resumed, here, in its folder, with the launch environment. */
async function resumesOnce(shell, wrapper = WRAPPER) {
  const dirs = lab()
  const result = await run(shell, dirs, { wrapper, plan: { 1: ticketFor(dirs) } })
  const { found, check } = problems()
  const [first, second, third] = result.runs
  check(result.runs.length === 2, `claude ran twice, the user's run and one resume (${result.runs.length})`)
  check(first !== undefined && JSON.stringify(first.args) === JSON.stringify(['--first', 'two words', '-c']), `the user's arguments pass as typed (${JSON.stringify(first?.args)})`)
  check(first?.cwd === dirs.start, "the user's run is in the folder it was typed in")
  check(first?.exe === join(dirs.bin, 'claude.exe'), `the stub on PATH ran (${first?.exe})`)
  check(first !== undefined && first.env.includes('CLAUDE_PANE_TOKEN'), 'claude carries CLAUDE_PANE_TOKEN')
  check(first !== undefined && machine.SESSION_MARKERS.every(name => first.env.includes(name)), "the user's own run gets the environment as it is")
  const pane = first?.pane === null || first?.pane === undefined ? undefined : machine.parsePane(first.pane)
  check(pane !== undefined && !('why' in pane), `the pane file reads as one (${first?.pane})`)
  if (pane !== undefined && !('why' in pane) && result.after !== undefined) {
    check(pane.pid === result.after.pid && pane.pid === result.pid, `the pane file names the shell that runs claude (${pane.pid}, the shell ${result.pid})`)
    const apart = BigInt(pane.started) - BigInt(result.after.created)
    check(apart <= 10_000n && apart >= -10_000n, `the pane file's start is the shell's, within 1 ms, as the probe reads it (${apart} ticks apart)`)
  }
  check(pane !== undefined && JSON.parse(first?.pane ?? '{}').v === 3, 'the pane file is version 3: the wrapper that checks the claim and takes the last look in every config folder the ticket names')
  check(second !== undefined && JSON.stringify(second.args) === JSON.stringify(['--resume', dirs.id]), `the resume runs claude --resume <id>, nothing more (${JSON.stringify(second?.args)})`)
  check(second?.cwd === dirs.work, `the resume runs in the ticket's folder (${second?.cwd})`)
  check(second?.ticketPresent === false, 'the ticket was deleted before the resume ran')
  check(second?.pane === first?.pane, 'the resume keeps the tab: same token, same pane file')
  for (const name of machine.SESSION_MARKERS) check(second !== undefined && !second.env.includes(name), `the resume runs without ${name}`)
  check(second?.forceIsOne === true, 'the resume runs with CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1')
  check(second?.reapIsOne === true, 'the resume runs with CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1 (the launch environment)')
  for (const name of ['WT_SESSION', 'WT_PROFILE_ID', 'CLAUDE_PANE_TOKEN']) check(second !== undefined && second.env.includes(name), `the resume keeps ${name}`)
  check(third === undefined, 'nothing runs after a resume that left no ticket')
  check(result.stdout.includes(`Resuming ${dirs.id} here, in ${dirs.work}.`), 'the resume is said')
  check(!result.stdout.includes(NOT_USED), 'no ticket is refused')
  check(result.after?.lastExit === 7, `$LASTEXITCODE is the last claude's (${result.after?.lastExit})`)
  leftAsItWas(check, dirs, result)
  return found
}

/** The tickets that don't hold, each with why the wrapper says so; `pure` ones checkPaneTicket refuses the same way. */
const BROKEN = [
  { name: 'for another tab', why: machine.PANE_WHY.token, pure: true, ticket: dirs => ticketFor(dirs, { token: OTHER_TOKEN }) },
  { name: 'expired', why: machine.PANE_WHY.age, pure: true, ticket: dirs => ticketFor(dirs, { at: '{OLD}' }) },
  { name: 'from the future', why: machine.PANE_WHY.age, pure: true, ticket: dirs => ticketFor(dirs, { at: '{AHEAD}' }) },
  { name: 'a bad UUID', why: machine.PANE_WHY.resume, pure: true, ticket: dirs => ticketFor(dirs, { resume: 'not-a-session' }) },
  { name: 'an uppercase UUID', why: machine.PANE_WHY.resume, pure: true, ticket: dirs => ticketFor(dirs, { resume: dirs.id.toUpperCase() }) },
  { name: 'naming no claim', why: machine.PANE_WHY.claim, pure: true, ticket: dirs => ticketFor(dirs, { by: undefined }) },
  { name: "naming a slot's claim", why: machine.PANE_WHY.claim, pure: true, ticket: dirs => ticketFor(dirs, { by: 'slot:20-134062345678901240' }) },
  {
    name: 'whose claim the lock names no more (another switch took it over)',
    why: machine.PANE_WHY.lock,
    pure: false,
    ticket: dirs => ticketFor(dirs),
    setup: dirs => writeFileSync(dirs.lock, JSON.stringify({ v: 1, by: `launch:${randomUUID()}`, pid: 4, created: '1', at: Date.now(), transport: 'window' })),
  },
  { name: 'with no claim lock at all', why: machine.PANE_WHY.lock, pure: false, ticket: dirs => ticketFor(dirs), setup: dirs => rmSync(dirs.lock) },
  { name: 'whose claim lock is not JSON', why: machine.PANE_WHY.lock, pure: false, ticket: dirs => ticketFor(dirs), setup: dirs => writeFileSync(dirs.lock, 'not json') },
  { name: 'a missing folder', why: machine.PANE_WHY.dir, pure: false, ticket: dirs => ticketFor(dirs, { dir: join(dirs.root, 'gone') }) },
  { name: 'a relative folder', why: machine.PANE_WHY.dir, pure: true, ticket: dirs => ticketFor(dirs, { dir: 'work' }) },
  { name: 'naming a config folder that is not absolute', why: machine.PANE_WHY.configs, pure: true, ticket: dirs => ticketFor(dirs, { configDirs: [dirs.config, 'config'] }) },
  { name: 'naming no config folders in a list', why: machine.PANE_WHY.configs, pure: true, ticket: dirs => ticketFor(dirs, { configDirs: [] }) },
  { name: 'with a left record stat of a size alone', why: machine.PANE_WHY.left, pure: true, ticket: dirs => ticketFor(dirs, { left: { size: 1 } }) },
  { name: 'with a left record stat of both kinds', why: machine.PANE_WHY.left, pure: true, ticket: dirs => ticketFor(dirs, { left: { size: 1, mtime: 2, exitAt: 3 } }) },
  { name: 'with a left record exit time below zero', why: machine.PANE_WHY.left, pure: true, ticket: dirs => ticketFor(dirs, { left: { exitAt: -5 } }) },
  { name: 'with a left record stat that is text', why: machine.PANE_WHY.left, pure: true, ticket: dirs => ticketFor(dirs, { left: 'size 1' }) },
  { name: 'a missing transcript', why: machine.PANE_WHY.transcript, pure: false, ticket: dirs => ticketFor(dirs, { dir: dirs.start }) },
  { name: 'withdrawn', why: machine.PANE_WHY.withdrawn, pure: true, ticket: () => JSON.stringify({ v: 1, cancelled: true }) },
  { name: 'version 2', why: machine.PANE_WHY.version, pure: true, ticket: dirs => ticketFor(dirs, { v: 2 }) },
  { name: 'not JSON', why: machine.PANE_WHY.json, pure: true, ticket: () => 'not json' },
  { name: 'a JSON list', why: machine.PANE_WHY.json, pure: true, ticket: dirs => `[${ticketFor(dirs)}]` },
]

/** A ticket that doesn't hold: said in one line, nothing resumed, the ticket gone all the same. */
async function refused(shell, broken, wrapper = WRAPPER) {
  const dirs = lab()
  const template = broken.ticket(dirs)
  broken.setup?.(dirs)
  const result = await run(shell, dirs, { wrapper, plan: { 1: template } })
  const { found, check } = problems()
  check(result.runs.length === 1, `nothing is resumed (${result.runs.length} runs)`)
  const said = result.stdout.split(/\r?\n/).filter(line => line.startsWith(NOT_USED))
  check(said.length === 1 && said[0].startsWith(`${NOT_USED}${broken.why}.`), `one line says why: ${broken.why} (${JSON.stringify(said)})`)
  // The same rule, in the same words, in the machine code the plugins build tickets with.
  const now = Date.now()
  const token = randomUUID()
  const verdict = machine.checkPaneTicket(rendered(template, token, now), token, now)
  if (broken.pure) check('why' in verdict && verdict.why === broken.why, `checkPaneTicket says the same (${JSON.stringify(verdict)})`)
  else check('ticket' in verdict, `checkPaneTicket takes it: the wrapper's own check, on disk, refuses it (${JSON.stringify(verdict)})`)
  leftAsItWas(check, dirs, result)
  return found
}

/** Four tickets in a row, each valid: three resumes, then the fourth is refused (3 within 30 seconds). */
async function cappedIn30s(shell, wrapper = WRAPPER) {
  const dirs = lab()
  const ticket = ticketFor(dirs)
  const result = await run(shell, dirs, { wrapper, plan: { 1: ticket, 2: ticket, 3: ticket, 4: ticket } })
  const { found, check } = problems()
  check(result.runs.length === 4, `three resumes, no fourth (${result.runs.length} runs)`)
  check(result.stdout.includes(`${NOT_USED}this tab resumed 3 times within 30 seconds. Once it is safe, resume it yourself: claude --resume ${dirs.id}`), 'the cap is said, with the line to resume by hand')
  leftAsItWas(check, dirs, result)
  return found
}

/**
 * A ticket that holds in every other way, for a conversation another Claude Code holds when the
 * wrapper takes its last look (L1: a running claude.exe's registry file names it; L2: a process names
 * it on its command line): refused in one line, in the slot runner's and the window's own words, and
 * nothing resumed.
 */
async function liveElsewhere(shell, how, wrapper = WRAPPER) {
  const dirs = lab()
  const other = holdElsewhere(dirs, how)
  try {
    const result = await run(shell, dirs, { wrapper, plan: { 1: ticketFor(dirs) } })
    const { found, check } = problems()
    check(result.runs.length === 1, `nothing is resumed (${result.runs.length} runs)`)
    const why =
      how === 'L2'
        ? `it is open elsewhere: process ${other.pid} names it on its command line (L2)`
        : `it may be open elsewhere: the registry file of running Claude Code ${other.pid} names it, though its procStart is not that process start time (a stale file, or a format this check does not know)`
    check(result.stdout.includes(`${NOT_USED}${why}. Once it is safe, resume it yourself: claude --resume ${dirs.id}`), `one line says why: ${why} (${result.stdout.slice(0, 600)})`)
    leftAsItWas(check, dirs, result)
    return found
  } finally {
    other.kill()
  }
}

/**
 * A ticket that names a second config folder (a switch that reads two), for a conversation a running
 * claude.exe holds by a registry file in that second folder: the wrapper's last look reads that folder
 * too, and refuses in one line; nothing is resumed (the coordinator's review, finding 1).
 */
async function liveInSecondConfig(shell, wrapper = WRAPPER) {
  const dirs = lab()
  const second = join(dirs.root, 'config-2')
  mkdirSync(join(second, 'sessions'), { recursive: true })
  const bin = join(dirs.root, 'elsewhere')
  mkdirSync(bin)
  copyFileSync(stub, join(bin, 'claude.exe'))
  const env = { SystemRoot: SYSTEM_ROOT, LOCALAPPDATA: join(dirs.root, 'elsewhere-local'), STUB_LOG: join(dirs.root, 'elsewhere.jsonl'), STUB_SLEEP_MS: '90000' }
  const other = spawn(join(bin, 'claude.exe'), [], { env, windowsHide: true, stdio: 'ignore' })
  writeFileSync(join(second, 'sessions', `${other.pid}.json`), JSON.stringify({ pid: other.pid, sessionId: dirs.id, procStart: '0' }))
  try {
    const result = await run(shell, dirs, { wrapper, plan: { 1: ticketFor(dirs, { configDirs: [dirs.config, second] }) } })
    const { found, check } = problems()
    check(result.runs.length === 1, `nothing is resumed (${result.runs.length} runs)`)
    const why = `it may be open elsewhere: the registry file of running Claude Code ${other.pid} names it, though its procStart is not that process start time (a stale file, or a format this check does not know)`
    check(result.stdout.includes(`${NOT_USED}${why}. Once it is safe, resume it yourself: claude --resume ${dirs.id}`), `one line says why: ${why} (${result.stdout.slice(0, 600)})`)
    leftAsItWas(check, dirs, result)
    return found
  } finally {
    other.kill()
  }
}

/**
 * A switch back to a conversation left moments ago, its ticket carrying the left record's stat (and its
 * config folders naming the tab's own again, as the plugins name them): `how` 'same' (in place, the
 * transcript's size and time as they are: resumed), 'grown' (in place, the transcript written after the
 * stat was taken: refused), 'exit-old' (on exit, the transcript last written more than 10 s after the
 * exit time: refused), 'exit-fresh' (on exit, written before it: resumed).
 */
async function leftRecord(shell, how, wrapper = WRAPPER) {
  const dirs = lab()
  const transcript = join(dirs.config, 'projects', machine.projectName(dirs.work), `${dirs.id}.jsonl`)
  writeFileSync(transcript, '{"type":"user"}\n')
  const stat = statSync(transcript)
  const left =
    how === 'same' || how === 'grown'
      ? { size: stat.size, mtime: Math.floor(stat.mtimeMs) }
      : { exitAt: how === 'exit-old' ? Math.floor(stat.mtimeMs) - 60_000 : Math.floor(stat.mtimeMs) }
  if (how === 'grown') writeFileSync(transcript, '{"type":"user"}\n{"type":"assistant"}\n')
  const result = await run(shell, dirs, { wrapper, plan: { 1: ticketFor(dirs, { configDirs: [dirs.config], left }) } })
  const { found, check } = problems()
  const resumes = how === 'same' || how === 'exit-fresh'
  check(result.runs.length === (resumes ? 2 : 1), `${resumes ? 'one resume' : 'nothing resumed'} (${result.runs.length} runs; ${result.stdout.slice(0, 600)})`)
  if (!resumes) {
    const why = how === 'grown' ? 'its transcript changed since it was left (another process may have resumed it)' : 'its transcript was written after it was left (another process may have resumed it)'
    check(result.stdout.includes(`${NOT_USED}${why}. Once it is safe, resume it yourself: claude --resume ${dirs.id}`), `one line says why: ${why} (${result.stdout.slice(0, 600)})`)
  } else check(!result.stdout.includes(NOT_USED), `no ticket is refused (${result.stdout.slice(0, 600)})`)
  leftAsItWas(check, dirs, result)
  return found
}

/** Eleven tickets, 10.5 seconds apart: ten resumes, then the eleventh is refused (10 per `claude` typed). */
async function cappedAt10(shell, wrapper = WRAPPER) {
  const dirs = lab()
  const ticket = ticketFor(dirs)
  const plan = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i + 1, ticket]))
  const result = await run(shell, dirs, { wrapper, plan, env: { STUB_SLEEP_MS: '10500' }, timeoutMs: 240_000 })
  const { found, check } = problems()
  check(result.runs.length === 11, `ten resumes, no eleventh (${result.runs.length} runs)`)
  check(result.stdout.includes(`${NOT_USED}this tab has resumed 10 times already.`), 'the cap is said')
  leftAsItWas(check, dirs, result)
  return found
}

/**
 * No claude.exe anywhere (none on PATH, none in the home's .local\bin; a claude.ps1 on PATH, which is
 * no application): it says so, runs nothing, and never calls itself.
 */
async function noClaude(shell, wrapper = WRAPPER) {
  const dirs = lab()
  const scripts = join(dirs.root, 'scripts')
  mkdirSync(scripts)
  const touched = join(dirs.root, 'ps1-ran')
  writeFileSync(join(scripts, 'claude.ps1'), `Set-Content -LiteralPath '${touched}' -Value ran\n`)
  const path = [scripts, join(SYSTEM_ROOT, 'System32'), SYSTEM_ROOT, join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0'), join(PWSH, '..')].join(';')
  const result = await run(shell, dirs, { wrapper, env: { PATH: path } })
  const { found, check } = problems()
  check(result.stdout.includes('claude: no claude.exe was found.'), `it says no claude.exe was found (${result.stdout.slice(0, 300)} ${result.stderr.slice(0, 300)})`)
  check(result.runs.length === 0, 'nothing ran')
  check(!existsSync(touched), 'the claude.ps1 on PATH did not run')
  check(!/call depth|recurs/i.test(result.stderr + result.stdout), 'it never called itself')
  check(result.after !== undefined, 'the driver went on')
  return found
}

/** The native installer's claude.exe, in the home's .local\bin, comes before the one on PATH. */
async function installerFirst(shell, wrapper = WRAPPER) {
  const dirs = lab()
  const installed = join(dirs.home, '.local', 'bin')
  mkdirSync(installed, { recursive: true })
  copyFileSync(stub, join(installed, 'claude.exe'))
  const result = await run(shell, dirs, { wrapper })
  const { found, check } = problems()
  check(result.runs.length === 1 && result.runs[0].exe === join(installed, 'claude.exe'), `the installer's claude.exe ran (${result.runs[0]?.exe})`)
  return found
}

/**
 * A restart of a session that was itself resumed: the user's run is `claude --resume <id>`, and its
 * ticket resumes the same conversation, so the claude that just exited named the id on its command
 * line; it holds nothing, and mustn't be taken for one that does (R-1). With `held`, a process that
 * named it too has exited while the shell still holds a handle to it.
 */
async function resumesAfterResume(shell, held, wrapper = WRAPPER) {
  const dirs = lab()
  const env = { TEST_FIRST_RESUME: dirs.id, ...(held ? { TEST_HELD_EXITED: dirs.id } : {}) }
  const result = await run(shell, dirs, { wrapper, plan: { 1: ticketFor(dirs) }, env })
  const { found, check } = problems()
  check(result.runs.length === 2, `the user's run, then one resume (${result.runs.length} runs; ${result.stdout.slice(0, 400)})`)
  for (const [i, run] of result.runs.entries()) check(JSON.stringify(run.args) === JSON.stringify(['--resume', dirs.id]), `run ${i + 1} is claude --resume <id> (${JSON.stringify(run.args)})`)
  check(!result.stdout.includes(NOT_USED), `no ticket is refused (${result.stdout.slice(0, 400)})`)
  leftAsItWas(check, dirs, result)
  return found
}

/**
 * With no LOCALAPPDATA (an SSH or remoting shell): claude just runs, once, with no token, nothing
 * written, and nothing fails. (No USERPROFILE can't be tried: PowerShell sets it again from the
 * account's profile, which would reach the real claude.exe; environment() refuses it.)
 */
async function runsPlainly(shell, wrapper = WRAPPER) {
  const dirs = lab()
  const result = await run(shell, dirs, { wrapper, plan: { 1: ticketFor(dirs) }, env: { LOCALAPPDATA: null } })
  const { found, check } = problems()
  check(result.after !== undefined, `the driver went on: nothing failed (exit ${result.code}, ${result.stderr.slice(0, 400)})`)
  check(result.runs.length === 1 && JSON.stringify(result.runs[0].args) === JSON.stringify(['--first', 'two words', '-c']), `claude ran once, as typed (${result.runs.length} runs)`)
  check(result.runs[0] !== undefined && !result.runs[0].env.includes('CLAUDE_PANE_TOKEN'), 'with no token')
  check(!result.stdout.includes('claude:'), `the wrapper says nothing (${result.stdout.slice(0, 300)})`)
  check(result.after?.lastExit === 7, `$LASTEXITCODE is claude's (${result.after?.lastExit})`)
  check(result.after?.files.length === 0 && result.after?.tokenSet === false, 'no pane file, no token left')
  return found
}

const SLOT_RUNNER = join(ROOT, 'plugins', 'self-switch', 'slot', 'claude-slot.ps1')
const LAUNCHER = join(ROOT, 'plugins', 'self-switch', 'slot', 'claude-launch.ps1')

/**
 * The four copies of the last look, each as a function Get-Live($id, $configDirs): the wrapper's,
 * the slot runner's, claude-launch.ps1's (by hand too), and RECHECK as the window and the in-place
 * check run it.
 */
function lastLooks(wrapperText = readFileSync(WRAPPER, 'utf8'), recheck = machine.RECHECK) {
  const cut = (text, open, close) => {
    const lines = text.split('\n')
    const from = lines.findIndex(line => line.startsWith(open))
    const to = lines.findIndex((line, i) => i > from && line === close)
    assert.ok(from >= 0 && to > from, `Get-Live is where it was (${open})`)
    return lines.slice(from, to + 1).join('\n')
  }
  return {
    wrapper: cut(wrapperText, '  function Get-Live(', '  }'),
    slot: cut(readFileSync(SLOT_RUNNER, 'utf8'), 'function Get-Live(', '}'),
    launcher: cut(readFileSync(LAUNCHER, 'utf8'), 'function Get-Live(', '}'),
    window: ['function Get-Live($id, $configDirs) {', '  try {', ...recheck.map(line => `    ${line}`), "  } catch { $live = 'unreadable: ' + $_.Exception.Message }", '  return $live', '}'].join('\n'),
  }
}

/**
 * One copy of the last look, against a process table with one claude.exe in it (Get-CimInstance
 * stood in for): one that has exited (a pid whose process is gone) or one alive (this test runner),
 * naming the conversation on its command line (L2) or in a registry file (L1). Its answer per case.
 */
function lastLook(shell, live) {
  const config = mkdtempSync(join(work, 'look-'))
  const id = randomUUID()
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$id = '${id}'`,
    `$config = '${config}'`,
    "$x = Start-Process -FilePath $env:ComSpec -ArgumentList '/c', 'exit' -PassThru -NoNewWindow",
    '$x.WaitForExit(); $gone = $x.Id; $x.Dispose()',
    '$script:table = @()',
    'function Get-CimInstance { param($ClassName, $Property, $Filter) $script:table }',
    live,
    "foreach ($case in @(@{ name = 'exited-L2'; pid = $gone; l1 = $false }, @{ name = 'exited-L1'; pid = $gone; l1 = $true }, @{ name = 'alive-L2'; pid = [int]$env:TEST_ALIVE_PID; l1 = $false }, @{ name = 'alive-L1'; pid = [int]$env:TEST_ALIVE_PID; l1 = $true })) {",
    "  $sessions = Join-Path $config 'sessions'",
    '  if (Test-Path -LiteralPath $sessions) { Remove-Item -LiteralPath $sessions -Recurse -Force }',
    '  if ($case.l1) { [void](New-Item -ItemType Directory -Path $sessions); [IO.File]::WriteAllText((Join-Path $sessions "$($case.pid).json"), (ConvertTo-Json -Compress -InputObject @{ pid = $case.pid; sessionId = $id; procStart = "0" })) }',
    "  $line = if ($case.l1) { 'claude.exe' } else { 'claude.exe --resume ' + $id }",
    "  $script:table = @([pscustomobject]@{ ProcessId = $case.pid; Name = 'claude.exe'; CreationDate = (Get-Date).AddMinutes(-5); CommandLine = $line })",
    '  "CASE $($case.name)|$(Get-Live $id @($config))"',
    '}',
  ].join('\r\n')
  const call = machine.powershellCall(shell, script)
  const ran = spawnSync(call.argv[0], call.argv.slice(1), { input: call.stdin, encoding: 'utf8', windowsHide: true, env: { ...process.env, TEST_ALIVE_PID: String(process.pid) } })
  assert.equal(ran.status, 0, ran.stderr)
  return Object.fromEntries(ran.stdout.split(/\r?\n/).filter(line => line.startsWith('CASE ')).map(line => line.slice(5).split('|')))
}

/** What a last look must answer: nothing for a process that has exited, the window's words for one alive. */
function looksRight(answers) {
  const { found, check } = problems()
  check(answers['exited-L2'] === '', `a process that has exited, naming it on its command line, holds nothing (${answers['exited-L2']})`)
  check(answers['exited-L1'] === '', `a claude.exe that has exited, its registry file naming it, holds nothing (${answers['exited-L1']})`)
  check(/names it on its command line \(L2\)$/.test(answers['alive-L2'] ?? ''), `one alive, naming it on its command line, holds it (${answers['alive-L2']})`)
  check(/^it may be open elsewhere: the registry file of running Claude Code \d+ names it/.test(answers['alive-L1'] ?? ''), `one alive, its registry file naming it, holds it (${answers['alive-L1']})`)
  return found
}

before(() => {
  if (!isWindows) return
  work = mkdtempSync(join(tmpdir(), 'claude-wrapper-test-'))
  stub = join(work, 'claude.exe')
  // Windows PowerShell's Add-Type compiles the stub with the .NET Framework's own compiler.
  const compile = spawnSync(
    WINDOWS_POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -TypeDefinition ([IO.File]::ReadAllText('${join(ROOT, 'scripts', 'claude-wrapper-stub.cs')}')) -OutputAssembly '${stub}' -OutputType ConsoleApplication`],
    { encoding: 'utf8', windowsHide: true },
  )
  assert.equal(compile.status, 0, compile.stderr)
  assert.ok(existsSync(stub), 'the stub was compiled')
})

after(() => {
  if (work !== undefined) rmSync(work, { recursive: true, force: true })
})

describe('the claude wrapper, in each PowerShell', { skip: !isWindows && 'Windows only', concurrency: true }, () => {
  test('the wrapper is plain ASCII, and its markers are the machine code\'s SESSION_MARKERS', () => {
    const bytes = readFileSync(WRAPPER)
    assert.ok(bytes.every(b => b < 128), 'Windows PowerShell 5.1 reads a file without a BOM as ANSI: keep it ASCII')
    const text = bytes.toString('utf8')
    assert.ok(text.includes(`$markers = ${machine.SESSION_MARKERS.map(name => `'${name}'`).join(', ')}`))
    assert.ok(!text.includes('WT_SESSION\''), 'it names WT_SESSION nowhere but its comments')
    assert.ok(!/--dangerously|--permission-mode|bypassPermissions/.test(text), 'no permission flag')
    // The last look is the slot runner's and the window's, line for line, and fails closed as theirs does.
    for (const line of machine.RECHECK) assert.ok(text.includes(`      ${line}\n`), `missing from the wrapper's last look: ${line}`)
    const slot = readFileSync(join(ROOT, 'plugins', 'self-switch', 'slot', 'claude-slot.ps1'), 'utf8')
    const unread = "'whether it is open elsewhere is unknown: the registry or the process table could not be read (' + $_.Exception.Message + ')'"
    assert.ok(slot.includes(unread) && text.includes(`} catch { $live = ${unread} }`))
    // Run right before claude, after every other check, in this tab's own config folder and every one the ticket names.
    const look = text.indexOf('        $why = Get-Live $t.resume $lookIn')
    assert.ok(look > text.indexOf("{ 'this tab resumed 3 times within 30 seconds' }"))
    assert.ok(look < text.indexOf('& $exe --resume $t.resume'))
    assert.ok(text.indexOf('        $lookIn = @($config)') < look)
    assert.ok(text.indexOf(LOOK_IN) < look)
    // Then the left record's last look, LEFT_RECHECK line for line, right after it and before claude.
    for (const line of machine.LEFT_RECHECK) assert.ok(text.includes(`      ${line}\n`), `missing from the wrapper's left record check: ${line}`)
    const left = text.indexOf(LEFT_LOOK)
    assert.ok(left > look && left < text.indexOf('& $exe --resume $t.resume'))
    // The launch environment's set is the machine code's LAUNCH_ENV_SET, applied to a resume.
    const set = Object.entries(machine.LAUNCH_ENV_SET).map(([name, value]) => `${name} = '${value}'`).join('; ')
    assert.ok(text.includes(`  $launchSet = [ordered]@{ ${set} }\n`))
    assert.ok(text.includes('      foreach ($name in $launchSet.Keys) { Set-Item -LiteralPath "Env:$name" -Value $launchSet[$name] }\n'))
  })

  for (const [name, shell] of SHELLS) {
    describe(name, { concurrency: 3 }, () => {
      test('a ticket that holds: claude --resume <id> in its folder, the markers and NO_COLOR cleared, FORCE set, WT_* kept, then all put back', async () => {
        assert.deepEqual(await resumesOnce(shell), [])
      })
      for (const broken of BROKEN) {
        test(`a ticket ${broken.name} is refused, saying "${broken.why}", and deleted`, async () => {
          assert.deepEqual(await refused(shell, broken), [])
        })
      }
      test('a conversation another process names on its command line at the last look (L2): refused, in the window\'s words', async () => {
        assert.deepEqual(await liveElsewhere(shell, 'L2'), [])
      })
      test("a conversation a running claude.exe's registry file names at the last look (L1): refused, in the window's words", async () => {
        assert.deepEqual(await liveElsewhere(shell, 'L1'), [])
      })
      for (const how of ['same', 'grown', 'exit-old', 'exit-fresh']) {
        test(`a switch back that rests on a left record (${how}): ${how === 'same' || how === 'exit-fresh' ? 'resumed' : 'refused at the last look'}`, async () => {
          assert.deepEqual(await leftRecord(shell, how), [])
        })
      }
      test('a conversation held under a second config folder the ticket names: refused at the last look', async () => {
        assert.deepEqual(await liveInSecondConfig(shell), [])
      })
      test('a restart of a resumed session: the claude that just exited named the id, and is not taken for one holding it (R-1)', async () => {
        assert.deepEqual(await resumesAfterResume(shell, false), [])
      })
      test('a process naming the id that has exited, a handle to it still open: not taken for one holding it (R-1)', async () => {
        assert.deepEqual(await resumesAfterResume(shell, true), [])
      })
      test('no LOCALAPPDATA (an SSH or remoting shell): claude just runs, with no token and nothing written', async () => {
        assert.deepEqual(await runsPlainly(shell), [])
      })
      test("the wrapper's last look passes over a process that has exited, and holds on one alive", () => {
        assert.deepEqual(looksRight(lastLook(shell, lastLooks().wrapper)), [])
      })
      test('three resumes within 30 seconds, then the loop stops and says so', async () => {
        assert.deepEqual(await cappedIn30s(shell), [])
      })
      test('ten resumes, then the loop stops and says so (about two minutes)', async () => {
        assert.deepEqual(await cappedAt10(shell), [])
      })
      test('no claude.exe: it says so, and never calls itself', async () => {
        assert.deepEqual(await noClaude(shell), [])
      })
      test("the native installer's claude.exe comes first", async () => {
        assert.deepEqual(await installerFirst(shell), [])
      })
    })
  }
})

describe('the last look, in the slot runner and the window too (Windows PowerShell 5.1)', { skip: !isWindows && 'Windows only' }, () => {
  test("the slot runner's, claude-launch.ps1's and RECHECK's pass over a process that has exited, and hold on one alive; the four copies are one", () => {
    const looks = lastLooks()
    assert.deepEqual(looksRight(lastLook(WINDOWS_POWERSHELL, looks.slot)), [])
    assert.deepEqual(looksRight(lastLook(WINDOWS_POWERSHELL, looks.launcher)), [])
    assert.deepEqual(looksRight(lastLook(WINDOWS_POWERSHELL, looks.window)), [])
    // The wrapper's, the slot runner's and claude-launch.ps1's are RECHECK, line for line.
    for (const line of machine.RECHECK) {
      assert.ok(looks.wrapper.includes(`      ${line}\n`), `the wrapper's last look: ${line}`)
      assert.ok(looks.slot.includes(`  ${line}\n`), `the slot runner's last look: ${line}`)
      assert.ok(looks.launcher.includes(`    ${line}\n`), `claude-launch.ps1's last look: ${line}`)
    }
  })
})

describe('the ticket the plugins write', { skip: !isWindows && 'Windows only' }, () => {
  test('paneScript writes paneTicket whole, by a move, and replaces one already there; no temporary file is left', () => {
    const state = mkdtempSync(join(work, 'state-'))
    const token = randomUUID()
    for (const at of [Date.now(), Date.now() + 1]) {
      const ticket = { token, resume: ID, by: `launch:${token}`, dir: work, at }
      const call = machine.powershellCall(WINDOWS_POWERSHELL, machine.paneScript({ stateDir: state, ticket }))
      const ran = spawnSync(call.argv[0], call.argv.slice(1), { input: call.stdin, encoding: 'utf8', windowsHide: true })
      assert.equal(ran.status, 0, ran.stderr)
      assert.equal(machine.PANE_WRITTEN.exec(ran.stdout)?.[1], token)
      assert.equal(readFileSync(machine.paneTicketPath(state, token), 'utf8'), machine.paneTicket(ticket))
      assert.deepEqual(readdirSync(join(state, 'panes')), [`${token}.next.json`])
    }
  })
})

/** The wrapper with one change, which must apply. */
function planted(from, to) {
  const text = readFileSync(WRAPPER, 'utf8')
  assert.ok(text.includes(from), `the fault's anchor is in the wrapper: ${from}`)
  const path = join(mkdtempSync(join(work, 'fault-')), 'claude-wrapper.ps1')
  writeFileSync(path, text.split(from).join(to))
  return path
}

describe('planted faults, each caught', { skip: !isWindows && 'Windows only', concurrency: 2 }, () => {
  const shell = SHELLS.at(-1)?.[1] ?? WINDOWS_POWERSHELL
  const DELETE = '      try { [IO.File]::Delete($ticketFile) } catch { $deleted = $false }\n'
  const RESUME = '      & $exe --resume $t.resume\n'
  const CLEAR = '      foreach ($name in $markers) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }\n'
  const CAP_10 = "        elseif ($resumes.Count -ge 10) { 'this tab has resumed 10 times already' }\n"
  const CAP_30S = "        elseif (@($resumes | Where-Object { ([datetime]::UtcNow - $_).TotalSeconds -lt 30 }).Count -ge 3) { 'this tab resumed 3 times within 30 seconds' }\n"

  test('the ticket deleted only after it is used: the resumed claude still sees it', async () => {
    const text = readFileSync(WRAPPER, 'utf8')
    assert.ok(text.includes(DELETE) && text.includes(RESUME))
    const path = join(mkdtempSync(join(work, 'fault-')), 'claude-wrapper.ps1')
    writeFileSync(path, text.replace(DELETE, '').replace(RESUME, `${RESUME}      [IO.File]::Delete($ticketFile)\n`))
    assert.notDeepEqual(await resumesOnce(shell, path), [])
  })

  test('the age check removed: an expired ticket resumes', async () => {
    const path = planted(' -or $age -gt 120000 -or $age -lt -5000', '')
    assert.notDeepEqual(await refused(shell, BROKEN.find(b => b.name === 'expired'), path), [])
  })

  test('the loop cap removed: a fourth resume within 30 seconds runs', async () => {
    const text = readFileSync(WRAPPER, 'utf8')
    assert.ok(text.includes(CAP_10) && text.includes(CAP_30S))
    const path = join(mkdtempSync(join(work, 'fault-')), 'claude-wrapper.ps1')
    writeFileSync(path, text.replace(CAP_10, '').replace(CAP_30S, ''))
    assert.notDeepEqual(await cappedIn30s(shell, path), [])
  })

  test('the 10-resume cap removed alone: an eleventh resume runs (about two minutes)', async () => {
    assert.notDeepEqual(await cappedAt10(shell, planted(CAP_10, '')), [])
  })

  test('WT_SESSION cleared with the markers: the resumed claude lacks it', async () => {
    assert.notDeepEqual(await resumesOnce(shell, planted(CLEAR, `${CLEAR}      Remove-Item -LiteralPath Env:WT_SESSION\n`)), [])
  })

  test('the claim check removed: a ticket whose claim the lock names no more resumes', async () => {
    const path = planted("        elseif ($null -eq $lock -or $lock.by -cne $t.by) { 'the claim lock on that conversation does not name this ticket' }\n", '')
    assert.notDeepEqual(await refused(shell, BROKEN.find(b => b.why === machine.PANE_WHY.lock), path), [])
  })

  test('the last look removed: a conversation open elsewhere is resumed a second time', async () => {
    const path = planted('        $why = Get-Live $t.resume $lookIn\n', '')
    assert.notDeepEqual(await liveElsewhere(shell, 'L2', path), [])
  })

  test("the exited-process skip removed from the wrapper's last look: a process that has exited is taken for one holding the conversation", () => {
    const text = readFileSync(planted('          if (Test-Exited $p) { continue }\n', ''), 'utf8')
    const faulty = text.split(' -and -not (Test-Exited $p)').join('')
    assert.notEqual(faulty, text, 'the L2 skip was there to remove')
    assert.notDeepEqual(looksRight(lastLook(shell, lastLooks(faulty).wrapper)), [])
  })

  test('RECHECK taking a gone process for a running one: the window\'s last look holds on it', () => {
    const NOT_RUNNING = 'return ($_.Exception -is [ArgumentException] -or $_.Exception.InnerException -is [ArgumentException])'
    assert.ok(machine.RECHECK.some(line => line.includes(NOT_RUNNING)))
    const faulty = machine.RECHECK.map(line => line.split(NOT_RUNNING).join('return $false'))
    assert.notDeepEqual(looksRight(lastLook(WINDOWS_POWERSHELL, lastLooks(undefined, faulty).window)), [])
  })

  test('the pane file left at version 1: the plugins would give that tab no ticket', async () => {
    assert.notDeepEqual(await resumesOnce(shell, planted('[ordered]@{ v = 3; pid = $PID; started = $started }', '[ordered]@{ v = 1; pid = $PID; started = $started }')), [])
  })

  test("the ticket's config folders left out of the last look: a conversation held under the second is resumed", async () => {
    assert.notDeepEqual(await liveInSecondConfig(shell, planted(LOOK_IN, '')), [])
  })

  test("the left record's last look removed: a transcript written since the record is resumed all the same", async () => {
    assert.notDeepEqual(await leftRecord(shell, 'grown', planted(LEFT_LOOK, '')), [])
  })

  test('the REAP setting left out of a resume: the resumed claude runs with shells reaped', async () => {
    const path = planted(" CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP = '1' }", ' }')
    assert.notDeepEqual(await resumesOnce(shell, path), [])
  })

  test('the version gate removed from the machine code: a version 1 pane file, a wrapper without these checks, is taken', async () => {
    const OLD = '  if (isRecord(raw) && raw.v === 1) {\n'
    const GATE = 'raw.v !== PANE_VERSION'
    const text = readFileSync(MACHINE, 'utf8')
    assert.ok(text.includes(OLD) && text.includes(GATE))
    const dir = mkdtempSync(join(work, 'fault-'))
    writeFileSync(join(dir, 'machine.ts'), text.replace(OLD, '  if (false) {\n').replace(GATE, '(raw.v !== PANE_VERSION && raw.v !== 1)'))
    const faulty = await import(pathToFileURL(join(dir, 'machine.ts')).href)
    const v1 = JSON.stringify({ v: 1, pid: 20, started: '134062345678901240' })
    const v2 = JSON.stringify({ v: 2, pid: 20, started: '134062345678901240' })
    // The real code: versions 3 and 2 only, and version 1 said as an older wrapper.
    assert.deepEqual(machine.parsePane(v2), { pid: 20, started: '134062345678901240', v: 2 })
    assert.match(machine.parsePane(v1).why, /an older one \(its pane file is version 1\)/)
    // The fault is caught: version 1 is taken.
    assert.deepEqual(faulty.parsePane(v1), { pid: 20, started: '134062345678901240', v: 1 })
  })

  test("the parent-pid check removed from the machine code: a pane file naming another PowerShell is taken", async () => {
    const PARENT = /^  if \(parent\.pid !== pane\.pid\) return .*\n/m
    const text = readFileSync(MACHINE, 'utf8')
    assert.match(text, PARENT)
    const dir = mkdtempSync(join(work, 'fault-'))
    writeFileSync(join(dir, 'machine.ts'), text.replace(PARENT, ''))
    const faulty = await import(pathToFileURL(join(dir, 'machine.ts')).href)
    // Two PowerShell tabs, 20 and 21; this session's claude.exe 100 runs under 20, the pane file names 21.
    const ft = seconds => String(134062345668901240n + BigInt(seconds) * 10_000_000n)
    const probe = {
      self: 300,
      session: { pid: 100, created: ft(2) },
      slot: null,
      slotSeen: false,
      procs: [
        { pid: 20, ppid: 10, created: ft(1), name: 'pwsh.exe' },
        { pid: 21, ppid: 10, created: ft(1), name: 'pwsh.exe' },
        { pid: 100, ppid: 20, created: ft(2), name: 'claude.exe' },
        { pid: 300, ppid: 100, created: ft(9), name: 'powershell.exe' },
      ],
      registry: [],
      transcripts: [
        { id: ID, dir: 0, project: 'C--work-repo', mtime: 0 },
        { id: OTHER_TOKEN, dir: 0, project: 'C--work-other', mtime: 0 },
      ],
      locks: [],
      claim: null,
      heavy: null,
      freeKb: null,
      errors: [],
      extraKeys: [],
    }
    const pane = { token: PLACEHOLDER, pane: { pid: 21, started: ft(1) } }
    const folder = ['C:', 'work', 'other'].join(String.fromCharCode(92))
    // The real code: not this claude.exe's parent, so a new window.
    assert.match(machine.paneFallback(probe, pane.pane), /is not the parent of claude\.exe 100/)
    assert.equal(machine.pickTransport(probe, ID, OTHER_TOKEN, folder, pane).transport, 'window')
    // The fault is caught: the same pane is taken.
    assert.equal(faulty.paneFallback(probe, pane.pane), undefined)
    assert.equal(faulty.pickTransport(probe, ID, OTHER_TOKEN, folder, pane).transport, 'pane')
  })
})
