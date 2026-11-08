// self-restart on the shared launcher (launch, in the shared machine code): the claim lock it takes,
// the slot it uses when its pane is one, the re-check after the wait, and the release once the
// session resumed. The tests in self-restart.test.ts are the rest.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { launchScriptText, SESSION_MARKERS } from '../hooks/launcher'
import { type LaunchInput, leftScript, RECHECK, SLOT_SCRIPT_SHA256 } from '../hooks/machine'

const TOOL = 'mcp__self-restart__restart_after_turn'
const HOUR = 60 * 60 * 1000
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const WINDOWS = { OS: 'Windows_NT', SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', USERPROFILE: 'C:\\Users\\u' }
const SLOT = '20-134062345678901240'
/** The claim a launch takes: a fresh one each time, read back from its script. */
const claimOf = (script: string): string => /^\$by = '(launch:[0-9a-f-]{36})'$/m.exec(script)?.[1] ?? 'none'

/** self-restart's launch for this session, as the shared launcher builds it ('auto': this pane's slot, else a window). */
const restartInput = (claim: string): LaunchInput => ({
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  kind: 'resume',
  id: ID,
  folder: 'C:\\work\\repo',
  claim,
  configDirs: ['C:\\Users\\u\\.claude'],
  stateDir: 'C:\\Users\\u\\AppData\\Local\\claude-self-tools',
  where: 'auto',
  waitForExit: { pid: 100, created: '134062345688901240' },
  now: 1_000_500,
  tool: 'self-restart',
  deadline: 1_000_500 + 20_000,
})

/** What the launch answers, by what it placed: a window, or this pane's slot (the claim then the slot's own). */
const WINDOW = (script: string) => `claim ${claimOf(script)}\r\nlaunched window - 17716\r\n`
const SLOTTED = `claim slot:${SLOT}\r\nlaunched slot ${SLOT}\r\n`

/** Base64 back to text, as PowerShell reads an -EncodedCommand: UTF-16LE. */
function decode(encoded: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  const clean = encoded.replace(/=+$/, '')
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].reduce((acc, k) => (acc << 6) | Math.max(0, alphabet.indexOf(clean.charAt(i + k) || 'A')), 0)
    bytes.push((n >> 16) & 255, (n >> 8) & 255, n & 255)
  }
  const used = Math.floor((clean.length * 6) / 8)
  let out = ''
  for (let i = 0; i + 1 < used; i += 2) out += String.fromCharCode((bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8))
  return out
}

/** A probe's answer: claude.exe 100 in a pane, the probe under it, and `under`, what else runs under the session. */
const probeOf = (under: Record<string, unknown>[] = []) =>
  `${JSON.stringify({
    v: 1,
    self: 300,
    session: { pid: 100, created: '134062345688901240' },
    slot: null,
    procs: [
      { pid: 20, ppid: 10, created: '134062345678901240', name: 'powershell.exe', cls: 'shell' },
      { pid: 100, ppid: 20, created: '134062345688901240', name: 'claude.exe' },
      { pid: 300, ppid: 100, created: '134062355668901240', name: 'powershell.exe', cls: 'shell' },
      { pid: 400, ppid: 100, created: '134062345788901240', name: 'node.exe' },
      ...under,
    ],
    registry: [],
    transcripts: [],
    locks: [],
    claim: null,
    heavy: null,
    freeKb: null,
    errors: [],
  })}\r\n`

type Machine = {
  /** What the probe answers: a machine (its stdout), or a failure. */
  probe?: string | 'fails'
  /** What git answers: no repository, or a failure. */
  git?: 'no-repo' | 'fails'
  /** Whether the session's folder can be read. */
  cwd?: 'reads' | 'fails'
  /** The session's crons, as CronList lists them. */
  crons?: readonly { readonly id: string; readonly humanSchedule?: string; readonly prompt?: string }[]
}

/** The pending marker's path for this session. */
const MARKER = `${WINDOWS.LOCALAPPDATA}\\claude-self-tools\\pending\\${ID}.json`

/** The engine beneath the plugin, its launcher answering `answer`; and what it was asked to run. */
function engine(
  on: On,
  { answer, store = {}, probe = probeOf(), git = 'no-repo', cwd = 'reads', crons = [], released = 'released' }: { answer: { exitCode: number; stdout: string | ((script: string) => string) }; store?: Record<string, unknown>; released?: 'released' | 'busy' } & Machine,
) {
  const probes: string[] = []
  const described: string[] = []
  const scripts: string[] = []
  const commands: string[] = []
  const toasts: string[] = []
  const logs: string[] = []
  const writes: { path: string; text: string }[] = []
  /** The machine as it is now: a test changes it between the call and the run. */
  const world: Required<Machine> = { probe, git, cwd, crons }
  const held = new Map<string, unknown>(Object.entries(store))
  const clock = mock.clock(on, { now: 1_000_000 })
  const session = mock.session(on)
  mock.env(on, WINDOWS)
  on('tool.check', { tool: 'CronList' }, () => ({ decision: 'allow' as const }))
  // CronList as the engine answers it (live check SS2): `{ result: { jobs }, text }`, and an error result
  // for a call that puts its arguments under `input`. `as never`: its record's type is the engine's own.
  on('tool.call', { tool: 'CronList' }, (_, e) =>
    ('input' in e ? { isError: true, result: 'InputValidationError', text: 'InputValidationError' } : { result: { jobs: world.crons }, text: `${world.crons.length} scheduled jobs.` }) as never,
  )
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('store.get', (_, e) => ({ value: held.get(e.key) }))
  on('store.set', (_, e) => {
    held.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: ID }))
  on('tool.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.cwd', () => (world.cwd === 'reads' ? { value: 'C:\\work\\repo' } : { deny: 'no folder' }))
  on('tool.register', (_, e) => {
    described.push(String(e.description))
    return { value: { tool: TOOL } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    logs.push(String(e.text))
    return { value: undefined }
  })
  on('agent.list', () => ({ value: [] }))
  on('classic.SessionStart', () => ({}))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git') {
      return world.git === 'no-repo'
        ? { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
        : { value: { exitCode: 128, stdout: '', stderr: 'fatal: detected dubious ownership in repository', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const script = String(e.init?.stdin ?? '')
    if (script.includes('$ids = @(')) {
      probes.push(script)
      return world.probe === 'fails'
        ? { value: { exitCode: 1, stdout: '', stderr: 'Get-CimInstance : Access denied', isStdoutTruncated: false, isStderrTruncated: false } }
        : { value: { exitCode: 0, stdout: world.probe, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    scripts.push(script)
    if (script.includes("'not-ours'")) return { value: { exitCode: 0, stdout: `${released}\r\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: answer.exitCode, stdout: typeof answer.stdout === 'function' ? answer.stdout(script) : answer.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.run', async (_, e) => {
    commands.push(e.command)
    await clock.sleep(HOUR)
    return {}
  })
  return { probes, described, scripts, commands, toasts, logs, writes, world, held, clock, session }
}

const start = { cwd: 'C:\\work\\repo', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as const

test("the launch for this session's own id: the claim, the re-check after the wait, claude-launch.ps1, and no flag of its own", () => {
  const script = launchScriptText(restartInput('launch:00000000-0000-4000-a000-000000000004'))
  // The claim on this conversation, taken in the launch's own run, with CreateNew, after the checks.
  expect(script).toContain('[IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)')
  expect(script).toContain('if (-not $taken) { $taken = Set-Claim $claimPath $claimText }')
  expect(script).toContain(`$claimPath = 'C:\\Users\\u\\AppData\\Local\\claude-self-tools\\claims\\${ID}.lock'`)
  expect(script).toContain("if (-not $taken) { Refuse 'claim' ($tool + ': another switch, restart or launch holds the claim on this conversation') }")
  // The process it waits for is this session's own claude.exe, by its id and its start.
  expect(script).toContain("if ([long]$session.ProcessId -ne 100 -or [math]::Abs([long](Get-Created $session) - [long]'134062345688901240') -gt 10000) { Refuse 'wait'")
  // The window re-reads the registry and the process table after the wait, and checks the claim, before claude.
  const wait = script.indexOf('$gone = Wait-Gone 100 ')
  const claude = script.indexOf('& $launchPath -Resume $id -Dir $folder')
  expect(wait).toBeGreaterThan(0)
  for (const line of RECHECK) {
    expect(script.indexOf(`    ${line}`, wait)).toBeGreaterThan(wait)
    expect(script.indexOf(`    ${line}`, wait)).toBeLessThan(claude)
  }
  expect(script.indexOf('the claim on it no longer names this window')).toBeGreaterThan(wait)
  expect(script.indexOf('the claim on it no longer names this window')).toBeLessThan(claude)
  // In the folder it was started in, checked to be a folder; claude-launch.ps1 goes there.
  expect(script).toContain("$folder = 'C:\\work\\repo'")
  expect(script.indexOf('if ($null -eq $refusal -and -not (Test-Path -LiteralPath $folder -PathType Container))')).toBeLessThan(claude)
  // No scrub here: claude-launch.ps1 is the one place the launch environment is set.
  expect(script).not.toContain('SetEnvironmentVariable')
  for (const name of SESSION_MARKERS) expect(script).not.toContain(name)
  for (const flag of ['--permission-mode', '--dangerously-skip-permissions', 'bypassPermissions']) expect(script).not.toContain(flag)
  // A slot whose script has the shipped hash, and takes the folder, gets a record instead of a window.
  expect(script).toContain(`$slotOk = $slotHash -eq '${SLOT_SCRIPT_SHA256}'`)
  expect(script.indexOf('[IO.File]::WriteAllText($temp, $text)')).toBeLessThan(script.indexOf('Start-Process'))
  // self-restart writes no left record (review gap 5), and leftScript refuses it as a writer.
  expect(script).not.toContain('left.key')
  expect(() => leftScript({ stateDir: 'C:\\Users\\u\\AppData\\Local\\claude-self-tools', id: ID, how: 'exit', configDirs: ['C:\\Users\\u\\.claude'], by: 'self-restart' as never })).toThrow(/self-restart resumes its own conversation/)
})

test('a pane that is a verified slot: the launcher leaves the slot a record, no window opens, and the session exits', async ($, on) => {
  const { scripts, commands, toasts, held, session, clock } = engine(on, { answer: { exitCode: 0, stdout: SLOTTED } })
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.', resume: 'Go on.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(scripts).toEqual([launchScriptText(restartInput(claimOf(scripts[0] ?? '')))])
  expect(commands).toEqual(['exit'])
  expect(toasts.some(t => /Restarting: this pane's slot resumes this session once it has exited/.test(t))).toBe(true)
  expect(JSON.stringify(session.appended())).toContain('restarted at its own request (restart_after_turn). Reason: Switched accounts.')
  expect((held.get('restarts') as Record<string, { claim?: string }>)[ID]?.claim).toBe(`slot:${SLOT}`)
  // No left record: self-restart resumes its own conversation (review gap 5).
  expect(scripts.some(s => s.includes('left.key'))).toBe(false)
})

test("a slot runner the launcher passed over for a window: the restart says why, in the row, the toast and the log", async ($, on) => {
  const why = 'slot hash unreadable: Exception calling "ReadAllBytes" with "1" argument(s): "Access to the path is denied."'
  const { commands, toasts, logs, session, clock } = engine(on, { answer: { exitCode: 0, stdout: (script: string) => `${WINDOW(script)}fallback ${why}\r\n` } })
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual(['exit'])
  const rows = session.appended().flatMap(row => ((row as { message?: { content?: { text?: unknown }[] } }).message?.content ?? []).map(block => String(block.text)))
  expect(rows).toContain(`This session restarted at its own request (restart_after_turn). Reason: Switched accounts. It restarted in a new window, not this pane's slot: \u00ab${why}\u00bb.`)
  expect(toasts).toContain(`Restarting: a new window resumes this session once it has exited, not this pane's slot (${why}). Switched accounts.`)
  expect(logs).toContain(`this pane's slot runner isn't used: ${why}. A new window resumes the session.`)
})

test('a window with no slot passed over, or the slot itself, says nothing of a fallback', async ($, on) => {
  const { toasts, session, clock } = engine(on, { answer: { exitCode: 0, stdout: WINDOW } })
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(JSON.stringify(session.appended())).not.toContain("not this pane's slot")
  expect(toasts).toContain('Restarting: a new window resumes this session once it has exited. Switched accounts.')
})

test('the claim the window took is kept for the resumed session, which releases it once', async ($, on) => {
  const opened = engine(on, { answer: { exitCode: 0, stdout: WINDOW } })
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await opened.clock.advance(1000)
  const kept = (opened.held.get('restarts') as Record<string, { claim?: string; at: number }>)[ID]
  const LAUNCH = claimOf(opened.scripts[0] ?? '')
  expect(LAUNCH).not.toBe('none')
  expect(kept?.claim).toBe(LAUNCH)

  // The resumed process: its copy of the plugin releases that claim, and only that one.
  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  await opened.clock.advance(1000)
  const release = opened.scripts.filter(s => s.includes("'not-ours'"))
  expect(release).toHaveLength(1)
  expect(release[0]).toContain(`$lock.by -cne '${LAUNCH}'`)
  expect(release[0]).toContain(`$path = 'C:\\Users\\u\\AppData\\Local\\claude-self-tools\\claims\\${ID}.lock'`)
  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  await opened.clock.advance(1000)
  expect(opened.scripts.filter(s => s.includes("'not-ours'"))).toHaveLength(1)
})

test('a claim another switch holds: the launcher resumes nothing, no window opens, nothing exits', async ($, on) => {
  const { commands, toasts, session, held, clock } = engine(on, {
    answer: { exitCode: 0, stdout: 'refused claim self-restart: another switch, restart or launch holds the claim on this conversation\r\n' },
  })
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
  expect(toasts.some(t => /Restart didn't run/.test(t))).toBe(true)
  expect(JSON.stringify(session.appended())).toMatch(/the launcher didn't place the restart \(refused: self-restart: another switch, restart or launch holds the claim/)
  expect(held.get('restarts')).toEqual({})
})

test('a start folder a launch never takes (a semicolon in it): refused, naming the character, nothing launched, nothing exits', async ($, on) => {
  const { scripts, commands, toasts, session, clock } = engine(on, { answer: { exitCode: 0, stdout: WINDOW } })
  await $.session.start({ ...start, cwd: 'C:\\work\\a;b' })
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(scripts).toEqual([])
  expect(commands).toEqual([])
  expect(toasts.some(t => /Restart didn't run/.test(t))).toBe(true)
  expect(JSON.stringify(session.appended())).toContain('holds a semicolon (;), so a launch never takes it: it takes an absolute folder with no quote, control character, semicolon')
})

test('at the call and before the launch, the full safe point: the probe asks of this session alone, and claims nothing', async ($, on) => {
  const { probes, scripts, commands, clock } = engine(on, { answer: { exitCode: 0, stdout: WINDOW } })
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  // The pre-check at the call, then again before the launch.
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(probes).toHaveLength(2)
  for (const probe of probes) {
    expect(probe).toContain(`$ids = @('${ID}')`)
    expect(probe).toContain('$configDirs = @()')
    expect(probe).toContain('$take = $null')
    expect(probe).toContain('$state = $null')
  }
  // An MCP server's node under the session doesn't count: the launch goes ahead.
  expect(scripts).toEqual([launchScriptText(restartInput(claimOf(scripts[0] ?? '')))])
  expect(commands).toEqual(['exit'])
})

const BASH = { pid: 505, ppid: 100, created: '134062355678901240', name: 'bash.exe', cls: 'shell' }
const CRON = { id: '7f3a9c21', humanSchedule: 'Every 5 minutes', prompt: 'check the deploy' }

for (const [name, machine, said] of [
  [
    'a background Bash job under the session',
    { probe: probeOf([BASH]) },
    /the shell bash\.exe 505 runs under this session \(a background job of the Bash, PowerShell or Monitor tool, or a tool call still finishing\): stop it with TaskStop/,
  ],
  ['a session cron', { crons: [CRON] }, /cron 7f3a9c21 \(Every 5 minutes: \u00abcheck the deploy\u00bb\) is set to wake this session: delete it with CronDelete \(id 7f3a9c21\)/],
  ['a git process under the session', { probe: probeOf([{ pid: 501, ppid: 100, created: '134062355678901240', name: 'git.exe', cls: 'git' }]) }, /S2: git\.exe 501 runs under this session/],
  ['a probe that fails (an unreadable process table)', { probe: 'fails' as const }, /can't tell what runs under this session: the machine probe failed \(it exited 1: Get-CimInstance : Access denied\)/],
  ['git that cannot be read', { git: 'fails' as const }, /S2: git's state can't be read \(git rev-parse in C:\\\\work\\\\repo exited 128\)/],
  ['a session folder that cannot be read', { cwd: 'fails' as const }, /this session's folder can't be read, so git's state there is unknown/],
] as const) {
  test(`${name}, there by the time the restart is armed, holds it: no window, no exit, the model told why, the marker done`, async ($, on) => {
    const { scripts, commands, toasts, held, session, writes, world, clock } = engine(on, { answer: { exitCode: 0, stdout: WINDOW } })
    await $.session.start(start)
    expect((await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })).deny).toBeUndefined()
    // It comes after the call, before the turn ends.
    Object.assign(world, machine)
    await $.turn.complete(answered)
    await clock.advance(1000)
    expect(scripts).toEqual([])
    expect(commands).toEqual([])
    expect(toasts.some(t => /Restart didn't run/.test(t))).toBe(true)
    expect(JSON.stringify(session.appended())).toMatch(said)
    expect(held.get('restarts')).toBeUndefined()
    expect(writes.map(w => w.text)).toEqual(['{"v":1,"kind":"restart","at":1000000}', '{"v":1,"kind":"restart","at":1000000}', '{"v":1,"done":true}'])
  })
}

for (const [name, machine, said] of [
  [
    'a background Bash job under the session',
    { probe: probeOf([BASH]) },
    'Not queued: the shell bash.exe 505 runs under this session (a background job of the Bash, PowerShell or Monitor tool, or a tool call still finishing): stop it with TaskStop (the task id its Bash, PowerShell or Monitor call gave), or let it finish; if you started no background job, it is a tool call still finishing (self-check\'s check at a resume runs one): call again in a moment. Each would make the restart\'s exit stop at its confirmation, or end with this process: stop them, then call again.',
  ],
  [
    'a session cron',
    { crons: [CRON] },
    "Not queued: cron 7f3a9c21 (Every 5 minutes: \u00abcheck the deploy\u00bb) is set to wake this session: delete it with CronDelete (id 7f3a9c21). Each would make the restart's exit stop at its confirmation, or end with this process: stop them, then call again.",
  ],
  [
    'a probe that fails',
    { probe: 'fails' as const },
    "Not queued: can't tell what runs under this session: the machine probe failed (it exited 1: Get-CimInstance : Access denied): call again in a moment; if it still can't be read, tell the person, who can act by hand. Each would make the restart's exit stop at its confirmation, or end with this process: stop them, then call again.",
  ],
] as const) {
  test(`${name} at the call refuses it, naming how to stop it: nothing is queued, armed or marked`, async ($, on) => {
    const { scripts, commands, writes, clock } = engine(on, { answer: { exitCode: 0, stdout: WINDOW }, ...machine })
    await $.session.start(start)
    expect((await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })).deny).toBe(said)
    await $.turn.complete(answered)
    await clock.advance(1000)
    expect(scripts).toEqual([])
    expect(commands).toEqual([])
    expect(writes).toEqual([])
  })
}

test('the pending marker: written at the call and at the arm, done right before the exit runs', async ($, on) => {
  const { commands, writes, clock } = engine(on, { answer: { exitCode: 0, stdout: WINDOW } })
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  expect(writes).toEqual([{ path: MARKER, text: '{"v":1,"kind":"restart","at":1000000}' }])
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual(['exit'])
  expect(writes.map(w => w.path)).toEqual([MARKER, MARKER, MARKER])
  expect(writes.map(w => w.text)).toEqual(['{"v":1,"kind":"restart","at":1000000}', '{"v":1,"kind":"restart","at":1000000}', '{"v":1,"done":true}'])
})

test('the pending marker says done when the restart is cancelled: a new turn, an interrupted turn, a launcher that fails', async ($, on) => {
  const { writes, clock } = engine(on, { answer: { exitCode: 3, stdout: 'self-restart: no claude.exe above this launcher\r\n' } })
  await $.session.start(start)
  const kinds = () => writes.map(w => (w.text.includes('"done":true') ? 'done' : 'restart'))

  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await $.turn.start({ text: 'a message', turnId: 't2' })
  await clock.advance(1000)
  expect(kinds()).toEqual(['restart', 'restart', 'done'])

  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete({ ...answered, turnId: 't3', isAborted: true, reason: 'aborted' })
  expect(kinds()).toEqual(['restart', 'restart', 'done', 'restart', 'done'])

  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete({ ...answered, turnId: 't4' })
  await clock.advance(1000)
  expect(kinds()).toEqual(['restart', 'restart', 'done', 'restart', 'done', 'restart', 'restart', 'done'])
})

test('a queued restart a new turn cancels is told in a plugin row; the third in a row says the session is busy', async ($, on) => {
  const { scripts, commands, session, clock } = engine(on, { answer: { exitCode: 0, stdout: WINDOW } })
  await $.session.start(start)
  for (const turnId of ['t2', 't3', 't4']) {
    await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
    await $.turn.complete(answered)
    await $.turn.start({ text: 'a message', turnId })
    await clock.advance(1000)
  }
  expect(scripts).toEqual([])
  expect(commands).toEqual([])
  const said = session.appended().map(row => JSON.stringify(row))
  expect(said).toHaveLength(3)
  const row = 'self-restart: your queued restart was cancelled because a new turn started; queue it again at the next finished break.'
  expect(said[0]).toContain(`${row} The restart you queued didn't go ahead`)
  expect(said[1]).toContain(`${row} The restart you queued didn't go ahead`)
  expect(said[1]).not.toContain('in a row')
  expect(said[2]).toContain(
    `${row} That is 3 in a row: this session is busy. Queue it again when it's idle, or ask the merger or the owner.`,
  )
  // The break holds: the restart runs, and the count is over.
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual(['exit'])
})

test("the tool's description says it holds on the full safe point, and what still ends with the process", async ($, on) => {
  const { described } = engine(on, { answer: { exitCode: 0, stdout: '' } })
  await $.session.start(start)
  const [text] = described
  expect(text).toContain('It refuses unless the session is at a safe point')
  expect(text).toContain('while anything runs under this session (a background Bash, PowerShell or Monitor job, git, a build, test or lint, a dev server or Playwright, a heavy-slot job)')
  expect(text).toContain("while any of that can't be read")
  expect(text).toContain('What still ends with this process: Remote Control')
})

test('a release that finds the lock held open throughout is logged, never taken as released', async ($, on) => {
  const { logs, clock } = engine(on, {
    answer: { exitCode: 0, stdout: '' },
    released: 'busy',
    store: { restarts: { [ID]: { at: 1_000_000 - 60_000, reason: 'Switched accounts.', claim: 'launch:00000000-0000-4000-a000-000000000005' } } },
  })
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  await clock.advance(1000)
  expect(logs).toContain(`the claim lock on ${ID} wasn't released (another process had it open throughout); it is left in place, and goes stale 15 minutes after the old process exited.`)
})
