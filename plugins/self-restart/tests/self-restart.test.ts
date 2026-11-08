import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentStatus, On } from 'claude-code'
import { encodeCommand, launchScriptText, SESSION_MARKERS } from '../hooks/launcher'
import { LAUNCH_ENV_CLEAR, LAUNCH_SCRIPT_SHA256, type LaunchInput, STDIN_BOOTSTRAP } from '../hooks/machine'

const TOOL = 'mcp__self-restart__restart_after_turn'
const HOUR = 60 * 60 * 1000
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const WINDOWS = { OS: 'Windows_NT', SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', USERPROFILE: 'C:\\Users\\u' }

/** The claim a launch script names (`$by`): a fresh launch's each time. */
const claimOf = (script: string): string => /^\$by = '(launch:[0-9a-f-]{36})'$/m.exec(script)?.[1] ?? 'none'

/**
 * self-restart's launch, as the shared launcher builds it for this session: its own id, the folder it
 * started in, its config folder, this pane's slot or a window ('auto'), after its own claude.exe 100.
 */
const restartInput = (claim: string): LaunchInput => ({
  powershell: POWERSHELL,
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

/** The launch script for one claim, as self-restart builds it. */
const RESTART = launchScriptText(restartInput('launch:00000000-0000-4000-a000-000000000004'))

type Run = { argv: readonly string[]; init?: Record<string, unknown> }

type Options = {
  /** The process's environment. */
  env?: Record<string, string>
  /** What `$.session.id()` reads. */
  id?: string
  /** What the launcher does: open the window, fail, or not start at all. */
  launcher?: 'opens' | 'fails' | 'throws'
  /** What /exit does: end the process (the call never comes back), come back with the session open, or be refused. */
  exit?: 'exits' | 'stays' | 'refused'
  /** The session's agents and their status. */
  agents?: { description: string; status: AgentStatus }[]
  /** What the plugin's store holds at the start. */
  store?: Record<string, unknown>
  /** How long the launcher takes to open the window, in milliseconds. */
  launchMs?: number
}

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

/** The probe's answer for a session with nothing running under it: claude.exe 100 in a pane, the probe under it. */
const AT_REST = `${JSON.stringify({
  v: 1,
  self: 300,
  session: { pid: 100, created: '134062345688901240' },
  slot: null,
  procs: [
    { pid: 20, ppid: 10, created: '134062345678901240', name: 'powershell.exe', cls: 'shell' },
    { pid: 100, ppid: 20, created: '134062345688901240', name: 'claude.exe' },
    { pid: 300, ppid: 100, created: '134062355668901240', name: 'powershell.exe', cls: 'shell' },
  ],
  registry: [],
  transcripts: [],
  locks: [],
  claim: null,
  heavy: null,
  freeKb: null,
  errors: [],
})}\r\n`

/** The engine beneath the plugin: its environment, session id, store and agents; and what it was asked to run. */
function engine(on: On, { env = WINDOWS, id = ID, launcher = 'opens', exit = 'exits', agents = [], store = {}, launchMs = 0 }: Options = {}) {
  const runs: Run[] = []
  const commands: string[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  const described: string[] = []
  const logs: string[] = []
  const world = { id, agents }
  const held = new Map<string, unknown>(Object.entries(store))
  const clock = mock.clock(on, { now: 1_000_000 })
  const session = mock.session(on)
  mock.env(on, env)
  on('store.get', (_, e) => ({ value: held.get(e.key) }))
  on('store.set', (_, e) => {
    held.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    held.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...held.keys()] }))
  // The pending marker's writes: taken, and not looked at here (self-restart-v2.test.ts reads them).
  on('fs.write', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: world.id }))
  on('tool.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.cwd', () => ({ value: 'C:\\work\\repo' }))
  on('tool.register', (_, e) => (described.push(String(e.description)), { value: { tool: TOOL } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    logs.push(String(e.text))
    return { value: undefined }
  })
  on('agent.list', () => ({
    value: world.agents.map((a, i) => ({ id: `a${i}`, type: 'general-purpose', ...a })),
  }))
  // The pre-check's crons: CronList allowed, listing none (`as never`: its record's type is the engine's own).
  on('tool.check', { tool: 'CronList' }, () => ({ decision: 'allow' as const }))
  on('tool.call', { tool: 'CronList' }, (_, e) => ('input' in e ? { isError: true, result: 'InputValidationError', text: 'InputValidationError' } : { result: { jobs: [] }, text: 'No scheduled jobs.' }) as never)
  on('classic.SessionStart', () => ({}))
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('process.run', async (_, e) => {
    // The safe point's reads before the launch, answered as a machine at rest and kept out of `runs`,
    // which are the launcher's: git finds no repository, and the probe finds nothing under the session.
    if (e.argv[0] === 'git') return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git', isStdoutTruncated: false, isStderrTruncated: false } }
    if (String(e.init?.stdin ?? '').includes('$ids = @(')) return { value: { exitCode: 0, stdout: AT_REST, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    runs.push({ argv: [...e.argv], init: e.init === undefined ? undefined : { ...e.init } })
    if (launchMs > 0) await clock.sleep(launchMs)
    if (launcher === 'throws') return { deny: 'spawn EPERM' }
    if (launcher === 'fails') return { value: { exitCode: 3, stdout: 'self-restart: no claude.exe above this launcher\r\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    // The launch took the claim its script names, and opened a window.
    const by = claimOf(String(e.init?.stdin ?? ''))
    return { value: { exitCode: 0, stdout: `claim ${by}\r\nlaunched window - 17716\r\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.run', async (_, e, next) => {
    commands.push(e.command)
    if (exit === 'refused') return next(e)
    if (exit === 'exits') await clock.sleep(HOUR)
    return {}
  })
  return { runs, commands, prompts, toasts, logs, described, clock, session, world, held }
}

const start = { cwd: 'C:\\work\\repo', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as const

/** Text the tool's input carries that must never reach the launch. */
const HOSTILE = "C:\\evil\\claude.exe'; Remove-Item -Recurse C:\\ #"

test('the window opens only once the turn has ended, by the fixed path with nothing of the input, then the session exits', async ($, on) => {
  const { runs, commands, session, logs, held, clock } = engine(on)
  await $.session.start(start)

  const queued = await $.tool.call({
    tool: TOOL,
    reason: ` Switched accounts. ${HOSTILE} `,
    resume: ` Re-run the deploy check. ${HOSTILE} `,
    // Not in the schema, and never read: a path the input names is never launched.
    claude: 'C:\\evil\\claude.exe',
    powershell: 'C:\\evil\\powershell.exe',
    cwd: 'C:\\evil',
  })
  expect(queued.deny).toBeUndefined()
  // Nothing runs while the turn does, however long it goes on: not at the call, not at the turn's
  // end, only after it.
  await clock.advance(60_000)
  expect(runs).toEqual([])
  expect(commands).toEqual([])
  await $.turn.complete(answered)
  expect(runs).toEqual([])
  expect(commands).toEqual([])
  await clock.advance(1000)

  expect(runs).toHaveLength(1)
  const [run] = runs
  expect(run?.argv[0]).toBe(POWERSHELL)
  expect(run?.argv.slice(1, 4)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
  expect(run?.argv).toHaveLength(5)
  // The folder the session started in, never one the input names.
  expect(run?.init?.cwd).toBe('C:\\work\\repo')
  // On standard input, under the fixed bootstrap: the command line is the same whatever the script.
  expect(decode(String(run?.argv[4]))).toBe(STDIN_BOOTSTRAP)
  const script = String(run?.init?.stdin)
  // The shared launcher's script for this session: its id, its folder, its own claude.exe, a fresh claim.
  expect(claimOf(script)).not.toBe('none')
  // The run comes half a second after the turn's end, a minute in: its deadline LAUNCH_DEADLINE_MS after that.
  expect(script).toBe(launchScriptText({ ...restartInput(claimOf(script)), now: 1_060_500, deadline: 1_060_500 + 20_000 }))
  expect(script).toContain(`$id = '${ID}'`)
  for (const part of ['evil', 'Remove-Item', 'Switched accounts', 'deploy check']) expect(JSON.stringify(run)).not.toContain(part)
  for (const part of ['evil', 'Remove-Item']) expect(script).not.toContain(part)

  expect(commands).toEqual(['exit'])
  expect(JSON.stringify(session.appended())).toContain('restarted at its own request (restart_after_turn). Reason: Switched accounts.')
  expect(logs.some(l => l.includes('Switched accounts.'))).toBe(true)
  // The first prompt waits in the store, under the session's id, for the process that resumes it.
  const kept = (held.get('restarts') as Record<string, { resume?: string; reason: string }>)[ID]
  expect(kept?.resume).toBe(`Re-run the deploy check. ${HOSTILE}`)
})

test('the window opens in the folder the session started in, though the session has moved since', async ($, on) => {
  const { runs, clock } = engine(on)
  await $.session.start(start)
  // A worktree or /cd moves the session, and a plugin reload starts it again from there.
  await $.session.start({ ...start, cwd: 'C:\\work\\repo\\.claude\\worktrees\\feature' })

  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(runs).toHaveLength(1)
  expect(runs[0]?.init?.cwd).toBe('C:\\work\\repo')
})

test('a second restart within 2 minutes of the first is refused: no restart loop', async ($, on) => {
  const { runs, held, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(runs).toHaveLength(1)
  expect((held.get('recentRestarts') as Record<string, number>)[ID]).toBe(1_000_000 + 500)

  // The resumed session, a minute later, asks again: refused at the call.
  await clock.advance(60_000)
  const refused = await $.tool.call({ tool: TOOL, reason: 'Still broken.' })
  expect(refused.deny).toMatch(/restarted 6\d seconds ago.+within 2 minutes is refused/)

  // Past 2 minutes it may restart again.
  await clock.advance(60_000)
  expect((await $.tool.call({ tool: TOOL, reason: 'Still broken.' })).deny).toBeUndefined()
})

test('a restart that comes due within 2 minutes of the last opens no window', async ($, on) => {
  const { runs, commands, toasts, session, held, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  // Another copy of the session restarted it meanwhile.
  held.set('recentRestarts', { [ID]: 1_000_000 })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(runs).toEqual([])
  expect(commands).toEqual([])
  expect(toasts.some(t => /within 2 minutes is refused/.test(t))).toBe(true)
  expect(JSON.stringify(session.appended())).toMatch(/restart you queued didn't run: this session restarted/)
})

test('a call without a reason is refused, and nothing is queued', async ($, on) => {
  const { runs, commands, clock } = engine(on)
  await $.session.start(start)

  for (const input of [{}, { reason: '' }, { reason: '  ' }, { reason: 3 }, { resume: 'only a resume' }]) {
    const refused = await $.tool.call({ tool: TOOL, ...input })
    expect(refused.deny).toMatch(/reason/)
  }
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(runs).toEqual([])
  expect(commands).toEqual([])
})

describe('nothing launches, and nothing exits, when what the launch needs is not what it must be', () => {
  for (const [name, options, said] of [
    ['a session id that is not a UUID', { id: 'session-1' }, /is not one claude --resume takes/],
    ['a session id with more spliced on', { id: `${ID}'; calc; '` }, /is not one claude --resume takes/],
    ['an uppercase session id', { id: ID.toUpperCase() }, /is not one claude --resume takes/],
    ['anything but Windows', { env: { SystemRoot: 'C:\\Windows' } }, /only on Windows/],
    ['a Windows folder that is not a drive and one plain folder', { env: { OS: 'Windows_NT', SystemRoot: 'C:\\Windows\\..\\Users\\x' } }, /SystemRoot/],
    ['a Windows folder on a share', { env: { OS: 'Windows_NT', SystemRoot: '\\\\server\\share' } }, /SystemRoot/],
    ['no Windows folder at all', { env: { OS: 'Windows_NT' } }, /SystemRoot/],
  ] as const) {
    test(name, async ($, on) => {
      const { runs, commands, toasts, session, held, clock } = engine(on, options)
      await $.session.start(start)

      expect((await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })).deny).toBeUndefined()
      await $.turn.complete(answered)
      await clock.advance(1000)
      expect(runs).toEqual([])
      expect(commands).toEqual([])
      expect(toasts.some(t => /Restart didn't run/.test(t))).toBe(true)
      expect(JSON.stringify(session.appended())).toMatch(said)
      expect(held.get('restarts')).toBeUndefined()
    })
  }
})

test('the launch refuses anything but a session id, and a folder with a quote or a semicolon', () => {
  for (const id of ['', 'session-1', `${ID} `, `${ID}'`, ID.toUpperCase(), `${ID}\n`]) expect(() => launchScriptText({ ...restartInput('launch:00000000-0000-4000-a000-000000000004'), id })).toThrow()
  for (const folder of ["C:\\o'brien", 'C:\\a;b', 'C:\\a"b', 'relative']) expect(() => launchScriptText({ ...restartInput('launch:00000000-0000-4000-a000-000000000004'), folder })).toThrow()
  // claude-launch.ps1 runs claude: the window passes it the id and the folder, by name.
  expect(RESTART).toContain('& $launchPath -Resume $id -Dir $folder')
})

test('the launch script: quiet progress, parents older than their children, values as literals, a pause when the resume fails', () => {
  const script = RESTART
  // Windows PowerShell 5.1's module progress, as CLIXML, would fill the one-line failure.
  expect(script).toContain("$ProgressPreference = 'SilentlyContinue'")
  // Every step up the walk, both of them, takes a parent only while it is older than the child.
  expect(script).toContain('-Property ProcessId, ParentProcessId, Name, CreationDate')
  expect(script).toContain('if ($null -ne $up -and $up.CreationDate -le $child.CreationDate) { return $up }')
  expect(script.split('= Get-Parent $').length - 1).toBe(2)
  expect(script).not.toContain('$table[[int]$at.ParentProcessId]')
  // The id, the folder and the claim go in as single-quoted literals, checked before: nothing is escaped at run time.
  expect(script).toContain(`$folder = 'C:\\work\\repo'`)
  expect(script).not.toContain('-replace')
  // An error, or an end within 10 seconds: the window says how to resume by hand, and waits.
  expect(script).toContain('$code = $LASTEXITCODE')
  expect(script).toContain('if ($code -ne 0 -or ((Get-Date) - $started).TotalSeconds -lt 10) {')
  // Inside the window's own literal, each quote doubled.
  expect(script).toContain(`"Once it is safe, resume it yourself: " + "& ''" + $handPath + "'' -Resume " + $id + " -Dir ''" + $folder + "''"`)
  // Three pauses: a refusal, a run of claude-launch.ps1 that stops on an error (caught), and an end within seconds.
  expect(script.split('Read-Host "Press Enter to close this window"').length - 1).toBe(3)
  expect(script).not.toContain('-NoExit')
})

test("the window leaves the launch environment to claude-launch.ps1: it clears and sets nothing itself", () => {
  // Claude Code's own markers, from the environment-variables reference and from what its tools' processes carry.
  expect(SESSION_MARKERS).toEqual([
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDECODE',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_PID',
    'CLAUDE_EFFORT',
    'CLAUDE_CODE_BRIDGE_SESSION_ID',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_REMOTE',
    'CLAUDE_CODE_REMOTE_SESSION_ID',
    'CLAUDE_JOB_DIR',
    'AI_AGENT',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_CODE_SSE_PORT',
    'NO_COLOR',
  ])
  // The list claude-launch.ps1 clears is that one (scripts/claude-launch.test.mjs reads the script).
  expect(LAUNCH_ENV_CLEAR).toEqual([...SESSION_MARKERS])
  const script = RESTART
  // The window sets and clears nothing: no marker, no NO_COLOR, no WT_SESSION or WT_PROFILE_ID, no REAP.
  expect(script).not.toContain('SetEnvironmentVariable')
  for (const name of [...SESSION_MARKERS, 'WT_SESSION', 'WT_PROFILE_ID', 'CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP', 'CLAUDE_CODE_FORCE_SESSION_PERSISTENCE']) expect(script).not.toContain(name)
  // claude-launch.ps1, from its pinned place (its hash's own name), after the wait and the last look.
  expect(script).toContain(`$launchPath = 'C:\\Users\\u\\AppData\\Local\\claude-self-tools\\claude-launch-${LAUNCH_SCRIPT_SHA256.slice(0, 8)}.ps1'`)
  expect(script.indexOf('& $launchPath -Resume $id -Dir $folder')).toBeGreaterThan(script.indexOf('$gone = Wait-Gone'))
})

test('the encoded command is the script as UTF-16LE base64', () => {
  expect(encodeCommand('dir')).toBe('ZABpAHIA')
  expect(encodeCommand('a')).toBe('YQA=')
  expect(decode(encodeCommand(RESTART))).toBe(RESTART)
})

for (const [launcher, said] of [
  ['fails', /exit 3: self-restart: no claude.exe above this launcher/],
  ['throws', /launcher didn't run: .*spawn EPERM/],
] as const) {
  test(`a launcher that ${launcher} opens no window and exits nothing, and its first prompt is taken back`, async ($, on) => {
    const { commands, toasts, session, held, clock } = engine(on, { launcher })
    await $.session.start(start)

    await $.tool.call({ tool: TOOL, reason: 'Switched accounts.', resume: 'Go on.' })
    await $.turn.complete(answered)
    await clock.advance(1000)
    expect(commands).toEqual([])
    expect(toasts.some(t => /Restart didn't run/.test(t))).toBe(true)
    const rows = JSON.stringify(session.appended())
    expect(rows).toMatch(/no window opened/)
    expect(rows).toMatch(said)
    expect(rows).not.toMatch(/restarted at its own request/)
    expect(held.get('restarts')).toEqual({})
  })
}

test('an exit that does not run leaves the window waiting, and says so', async ($, on) => {
  const { toasts, session, clock } = engine(on, { exit: 'refused' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(toasts.some(t => /Exit didn't run/.test(t))).toBe(true)
  // A window that outlasts its first wait keeps waiting: no word of giving up after 10 minutes.
  expect(JSON.stringify(session.appended())).toMatch(/keeps waiting for this process to exit/)
  expect(JSON.stringify(session.appended())).not.toMatch(/10 minutes|gives up and says so/)
})

test('the process that resumes the session sends the first prompt once, and only for that session', async ($, on) => {
  const { prompts, toasts, held, clock } = engine(on, {
    store: { restarts: { [ID]: { at: 1_000_000 - 60_000, reason: 'Switched accounts.', resume: 'Re-run the deploy check.' } } },
  })
  await $.session.start(start)

  // A fresh start, another session's resume, or a subagent's: nothing.
  await $.classic.SessionStart({ source: 'startup', session_id: ID })
  await $.classic.SessionStart({ source: 'resume', session_id: '11111111-2222-4333-8444-555555555555' })
  await $.classic.SessionStart({ source: 'resume', session_id: ID, agent_id: 'a1' })
  await clock.advance(1000)
  expect(prompts).toEqual([])

  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  await clock.advance(1000)
  expect(prompts).toEqual(['Restarted. Resume: Re-run the deploy check.'])
  expect(toasts.some(t => /Restarted: Switched accounts\./.test(t))).toBe(true)
  expect(held.get('restarts')).toEqual({})

  // Resumed again later: nothing more.
  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  await clock.advance(1000)
  expect(prompts).toHaveLength(1)
})

test('a first prompt waiting longer than 15 minutes is dropped, not sent', async ($, on) => {
  const { prompts, toasts, held, clock } = engine(on, {
    store: { restarts: { [ID]: { at: 1_000_000 - 16 * 60_000, reason: 'Switched accounts.', resume: 'Go on.' } } },
  })
  await $.session.start(start)

  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  await clock.advance(1000)
  expect(prompts).toEqual([])
  expect(toasts.some(t => /dropped/.test(t))).toBe(true)
  expect(held.get('restarts')).toEqual({})
})

test('a running subagent refuses the call, and one started before the turn ends cancels the restart', async ($, on) => {
  const { runs, commands, toasts, world, clock } = engine(on, { agents: [{ description: 'Run the e2e suite', status: 'running' }] })
  await $.session.start(start)

  const refused = await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  expect(refused.deny).toMatch(/still running \(Run the e2e suite\)/)

  world.agents = [{ description: 'Run the e2e suite', status: 'completed' }]
  expect((await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })).deny).toBeUndefined()
  world.agents = [{ description: 'Lint', status: 'running' }]
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(runs).toEqual([])
  expect(commands).toEqual([])
  expect(toasts.some(t => /Restart cancelled/.test(t))).toBe(true)
})

test('a session not run in a terminal is refused', async ($, on) => {
  const { runs, clock } = engine(on)
  for (const how of [
    { cwd: '/', surface: null, isInteractive: false },
    { cwd: '/', surface: 'desktop', isInteractive: true },
  ] as const) {
    await $.session.start(how)
    expect((await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })).deny).toMatch(/terminal/)
  }
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(runs).toEqual([])
})

test('a message that starts a turn before the restart has begun cancels it, and says so', async ($, on) => {
  const { runs, commands, toasts, session, held, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.', resume: 'Go on.' })
  await $.turn.complete(answered)
  await $.turn.start({ text: 'one more thing', turnId: 't2' })
  await clock.advance(60_000)
  expect(runs).toEqual([])
  expect(commands).toEqual([])
  expect(toasts.some(t => /Restart cancelled: a new turn started/.test(t))).toBe(true)
  expect(JSON.stringify(session.appended())).toMatch(/restart you queued didn't go ahead: a new turn started/)
  expect(held.get('restarts')).toBeUndefined()
})

test('input already waiting at the turn\'s end: its turn starts after a step at once would have begun, and the restart stands down, saying so, rather than run a turn late', async ($, on) => {
  const { runs, commands, toasts, session, held, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.', resume: 'Go on.' })
  await $.turn.complete(answered)
  // A message typed during the turn was waiting: Claude Code runs it first, and its turn starts a moment later.
  await clock.advance(50)
  await $.turn.start({ text: 'one more thing', turnId: 't2' })
  await clock.advance(60_000)
  expect(runs).toEqual([])
  expect(commands).toEqual([])
  expect(toasts.some(t => /Restart cancelled: a new turn started/.test(t))).toBe(true)
  expect(JSON.stringify(session.appended())).toMatch(/restart you queued didn't go ahead: a new turn started/)
  expect(held.get('restarts')).toBeUndefined()
})

test("the owner's note: the description says to end the turn and do nothing more until it has run, then carry on", async ($, on) => {
  const { described } = engine(on)
  await $.session.start(start)
  expect(described.join(' ')).toContain('After calling it, end your turn and do nothing more until it has run; then carry on.')
})

test('a message that starts a turn while the window opens stops the exit, and the window is said to wait', async ($, on) => {
  const { runs, commands, toasts, session, held, clock } = engine(on, { launchMs: 2000 })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.', resume: 'Go on.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(runs).toHaveLength(1)
  await $.turn.start({ text: 'one more thing', turnId: 't2' })
  await clock.advance(60_000)
  expect(commands).toEqual([])
  expect(toasts.some(t => /Restart stopped before the exit: a new turn started/.test(t))).toBe(true)
  const rows = JSON.stringify(session.appended())
  expect(rows).toMatch(/window opened, but this session didn't exit: a new turn started/)
  expect(rows).not.toMatch(/restarted at its own request/)
  // The first prompt is taken back: the window may still resume the session if the person exits, and
  // the record keeps only the claim the window holds, for the process that resumes it to release.
  const LAUNCH = claimOf(String(runs[0]?.init?.stdin))
  expect(held.get('restarts')).toEqual({ [ID]: { at: 1_000_500, reason: 'Switched accounts.', claim: LAUNCH } })
})

test('a subagent that starts while the window opens stops the exit', async ($, on) => {
  const { commands, toasts, world, clock } = engine(on, { launchMs: 2000 })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  world.agents = [{ description: 'Lint', status: 'running' }]
  await clock.advance(60_000)
  expect(commands).toEqual([])
  expect(toasts.some(t => /Restart stopped before the exit: a subagent is still running \(Lint\)/.test(t))).toBe(true)
})

test("a subagent's turn, starting or ending, leaves the queued restart alone", async ($, on) => {
  const { runs, commands, toasts, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  // A subagent's turn ends before the main one: the restart stays queued, and doesn't run yet.
  await $.turn.complete({ ...answered, turnId: 'a-t1', agentId: 'a1' })
  await clock.advance(60_000)
  expect(runs).toEqual([])
  // The main turn ends; a subagent's turn that starts then doesn't take the restart back.
  await $.turn.complete(answered)
  await $.turn.start({ text: '', turnId: 'a-t2', agentId: 'a1' })
  await clock.advance(1000)
  expect(runs).toHaveLength(1)
  expect(commands).toEqual(['exit'])
  expect(toasts.some(t => /cancelled|stopped/.test(t))).toBe(false)
})

test('an interrupted turn cancels the restart', async ($, on) => {
  const { runs, commands, toasts, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete({ ...answered, isAborted: true, reason: 'aborted' })
  await clock.advance(1000)
  expect(runs).toEqual([])
  expect(commands).toEqual([])
  expect(toasts.some(t => /cancelled/.test(t))).toBe(true)
})

test('a subagent is refused, and nothing is queued', async ($, on) => {
  const { runs, clock } = engine(on)
  await $.session.start(start)

  const refused = await $.tool.call({ tool: TOOL, reason: 'Switched accounts.', agentId: 'a1' })
  expect(refused.deny).toMatch(/subagent/)
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(runs).toEqual([])
})
