// self-restart in the claude wrapper's tab: a session started through the wrapper (CLAUDE_PANE_TOKEN,
// and a pane file naming the PowerShell that is its claude.exe's parent) restarts in the same tab, by
// a ticket and no window; any other falls back to the slot or the window, as before. The claim lock,
// the full safe point and the pending marker hold as they do for the window. The scripts answer
// from fixtures: nothing here starts a process.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { launcherScript } from '../hooks/launcher'
import { checkPaneTicket, panePath, paneScript, quoted } from '../hooks/machine'

const TOOL = 'mcp__self-restart__restart_after_turn'
const HOUR = 60 * 60 * 1000
const ID = '00000000-0000-4000-a000-000000000001'
const OTHER = '00000000-0000-4000-a000-000000000002'
const TOKEN = '00000000-0000-4000-a000-000000000003'
const LOCAL = 'C:\\Users\\u\\AppData\\Local'
const STATE = `${LOCAL}\\claude-self-tools`
const REPO = 'C:\\work\\repo'
const LAUNCH = 'launch:00000000-0000-4000-a000-000000000004'
/** The PowerShell that runs this session's claude.exe 100: pid 20, started at this FILETIME. */
const SHELL_STARTED = '134062345678901240'
const PANE = JSON.stringify({ v: 2, pid: 20, started: SHELL_STARTED })
/** The time the restart runs at: the clock's start, and the half second after the turn's end. */
const AT = 1_000_500

/** A probe's answer: claude.exe 100 under PowerShell 20 in a tab, the probe under it, and `under`, what else runs under the session. */
const probeOf = (under: Record<string, unknown>[] = []) =>
  `${JSON.stringify({
    v: 1,
    self: 300,
    session: { pid: 100, created: '134062345688901240' },
    slot: null,
    procs: [
      { pid: 20, ppid: 10, created: SHELL_STARTED, name: 'pwsh.exe', cls: 'shell' },
      { pid: 21, ppid: 10, created: SHELL_STARTED, name: 'pwsh.exe', cls: 'shell' },
      { pid: 100, ppid: 20, created: '134062345688901240', name: 'claude.exe' },
      { pid: 300, ppid: 100, created: '134062355668901240', name: 'powershell.exe', cls: 'shell' },
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

type Options = {
  /** The session's CLAUDE_PANE_TOKEN; none: not started through the wrapper. */
  token?: string
  /** The pane file's text; null: there is none (undefined takes the default, a version 2 pane file of the parent). */
  pane?: string | null
  /** What the probe answers. */
  probe?: string
  /** What the pane script does: writes the ticket, finds the claim held, or fails after taking it. */
  paneScript?: 'writes' | 'held' | 'fails'
  /** The session's crons, as CronList lists them. */
  crons?: readonly { readonly id: string; readonly humanSchedule?: string }[]
  /** What /exit does. */
  exit?: 'exits' | 'refused'
  /** What the launcher leaves: a window (`launched`) or this pane's slot a record (`slot`). */
  launcher?: 'window' | 'slot'
  /** A subagent starts while the pane script or the launcher runs: the restart stops right before its exit. */
  agentDuring?: boolean
}

/** The slot runner a `slot` launcher found: its id, and the claim it took. */
const SLOT = '20-134062345678901240'

/** The engine beneath the plugin; and what it was asked to run and say. */
function engine(on: On, { token = TOKEN, pane = PANE, probe = probeOf(), paneScript: answer = 'writes', crons = [], exit = 'exits', launcher = 'window', agentDuring = false }: Options = {}) {
  const prompts: string[] = []
  const agents: { id: string; type: string; description: string; status: 'running' }[] = []
  const scripts: string[] = []
  const kinds: string[] = []
  const described: string[] = []
  const commands: string[] = []
  const toasts: string[] = []
  const logs: string[] = []
  const writes: { path: string; text: string }[] = []
  const held = new Map<string, unknown>()
  const world = { probe }
  const clock = mock.clock(on, { now: 1_000_000 })
  const session = mock.session(on)
  mock.env(on, { OS: 'Windows_NT', SystemRoot: 'C:\\Windows', LOCALAPPDATA: LOCAL, ...(token === '' ? {} : { CLAUDE_PANE_TOKEN: token }) })
  on('tool.check', { tool: 'CronList' }, () => ({ decision: 'allow' as const }))
  on('tool.call', { tool: 'CronList' }, (_, e) =>
    ('input' in e ? { isError: true, result: 'InputValidationError', text: 'InputValidationError' } : { result: { jobs: crons }, text: `${crons.length} scheduled jobs.` }) as never,
  )
  on('fs.read', (_, e) => (e.path === panePath(STATE, TOKEN) && pane !== null ? { value: pane } : { deny: `ENOENT: ${e.path}` }))
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
  on('session.cwd', () => ({ value: REPO }))
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
  on('agent.list', () => ({ value: agents }))
  on('classic.SessionStart', () => ({}))
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git') return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    const script = String(e.init?.stdin ?? '')
    if (script.includes('$ids = @(')) return ok(world.probe)
    const kind = script.includes('"pane $token"') ? 'pane' : script.includes("'not-ours'") ? 'release' : 'launcher'
    kinds.push(kind)
    scripts.push(script)
    if (kind === 'release') return ok('released\r\n')
    if (agentDuring) agents.push({ id: 'a1', type: 'general-purpose', description: 'Lint', status: 'running' })
    if (kind === 'launcher') return ok(launcher === 'slot' ? `slot ${SLOT}\r\nclaim slot:${SLOT}\r\n` : `launched 17716\r\nclaim ${LAUNCH}\r\n`)
    if (answer === 'held') return ok('self-restart: another switch or restart holds the claim on this conversation (C:\\x\\claims\\y.lock), so it is not resumed\r\n', 5)
    // The pane script takes the claim its ticket names, and says so, as it does on the machine.
    const by = /^\$by = '(launch:[0-9a-f-]{36})'$/m.exec(script)?.[1] ?? 'none'
    if (answer === 'fails') return ok(`claim ${by}\r\n`, 1)
    return ok(`claim ${by}\r\npane ${TOKEN}\r\n`)
  })
  on('command.run', async (_, e, next) => {
    commands.push(e.command)
    if (exit === 'refused') return next(e)
    await clock.sleep(HOUR)
    return {}
  })
  /** The rows the model reads, as text. */
  const rows = () => session.appended().flatMap(row => ((row as { message?: { content?: { text?: unknown }[] } }).message?.content ?? []).map(block => String(block.text)))
  return { scripts, kinds, described, commands, toasts, logs, writes, held, world, clock, session, rows, prompts }
}

const start = { cwd: REPO, surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as const
const MARKER = `${STATE}\\pending\\${ID}.json`

/** The ticket for this tab, as the pane script writes it, but its claim (a fresh launch's each time). */
const TICKET = { token: TOKEN, resume: ID, dir: REPO, at: AT }

/** The launch claim a pane script takes and its ticket names. */
const claimOf = (script: string | undefined): string => /^\$by = '(launch:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'$/m.exec(script ?? '')?.[1] ?? 'none'

test('started through the claude wrapper: one script takes the claim and leaves this tab a ticket naming it, no window opens, and the session exits', async ($, on) => {
  const { scripts, kinds, commands, toasts, held, rows, clock } = engine(on)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.', resume: 'Go on.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(kinds).toEqual(['pane'])
  const by = claimOf(scripts[0])
  expect(by).not.toBe('none')
  expect(scripts).toEqual([paneScript({ stateDir: STATE, ticket: { ...TICKET, by }, claim: true })])
  // The ticket: this tab's token, this session's id, the claim, the folder it started in, now; one the wrapper takes.
  const written = /\[IO\.File\]::WriteAllText\(\$temp, '(.+)'\)/.exec(scripts[0] ?? '')?.[1] ?? ''
  expect(JSON.parse(written)).toEqual({ v: 1, token: TOKEN, resume: ID, by, dir: REPO, at: AT })
  expect(checkPaneTicket(written, TOKEN, AT)).toEqual({ ticket: { v: 1, token: TOKEN, resume: ID, by, dir: REPO, at: AT } })
  // A fresh launch's claim each time.
  expect(by).not.toBe(LAUNCH)
  // The claim, in the same run, before the ticket: for one launch, its transport the tab.
  const script = scripts[0] ?? ''
  expect(script.indexOf("$transport = 'pane'")).toBeGreaterThan(0)
  expect(script.indexOf('if (-not $taken) {')).toBeLessThan(script.indexOf('[IO.File]::WriteAllText($temp'))
  expect(script.indexOf('[IO.File]::Move($temp, $final)')).toBeGreaterThan(script.indexOf('[IO.File]::WriteAllText($temp'))
  expect(commands).toEqual(['exit'])
  expect(toasts).toContain('Restarting: this tab resumes this session once it has exited. Switched accounts.')
  expect((held.get('restarts') as Record<string, { claim?: string }>)[ID]?.claim).toBe(by)
  expect(rows().at(-1)).toBe('This session restarted at its own request (restart_after_turn). Reason: Switched accounts.')
})

test("the resumed session releases the tab's claim, once", async ($, on) => {
  const { scripts, kinds, clock } = engine(on)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  await clock.advance(1000)
  expect(kinds).toEqual(['pane', 'release'])
  expect(scripts[1]).toContain(`$lock.by -cne '${claimOf(scripts[0])}'`)
})

const SHELL_21 = JSON.stringify({ v: 2, pid: 21, started: SHELL_STARTED })
for (const [name, options, why] of [
  ['no CLAUDE_PANE_TOKEN (not started through the wrapper)', { token: '' }, undefined],
  ['a pane file naming another PowerShell than claude.exe\'s parent', { pane: SHELL_21 }, "the tab's claude wrapper (PowerShell 21) is not the parent of claude.exe 100; pwsh.exe 20 is"],
  ['a pane file whose process started at another time', { pane: JSON.stringify({ v: 2, pid: 20, started: '134062345698901240' }) }, "the tab's pane file names process 20, but that process started at another time (another process took its id)"],
  ['no pane file', { pane: null }, `this tab's pane file (${STATE}\\panes\\${TOKEN}.json) can't be read`],
  ['a pane file of another shape', { pane: '{"v":2}' }, "this tab's pane file is not { v: 2, pid, started }"],
  [
    'a version 1 pane file (an older wrapper, without the claim check and the last look), though its PowerShell is the parent',
    { pane: JSON.stringify({ v: 1, pid: 20, started: SHELL_STARTED }) },
    "this tab's claude wrapper is an older one (its pane file is version 1), which checks neither the claim nor whether the conversation is open: copy the current claude-wrapper.ps1 into place",
  ],
  ['a token that is no UUID', { token: 'not-a-token' }, 'CLAUDE_PANE_TOKEN is not a token the claude wrapper gives (a lowercase UUID)'],
  [
    "claude.exe's parent not a PowerShell",
    { probe: probeOf().replace('"name":"pwsh.exe","cls":"shell"}', '"name":"bash.exe","cls":"shell"}') },
    'the parent of claude.exe 100 is bash.exe 20, not PowerShell',
  ],
] as const) {
  test(`${name}: the window, as before${why === undefined ? ', saying nothing of a tab' : ', and the log and the row say why'}`, async ($, on) => {
    const { scripts, kinds, commands, logs, rows, clock } = engine(on, options)
    await $.session.start(start)
    await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
    await $.turn.complete(answered)
    await clock.advance(1000)
    expect(kinds).toEqual(['launcher'])
    expect(scripts).toEqual([launcherScript(ID)])
    expect(commands).toEqual(['exit'])
    if (why === undefined) {
      expect(logs.some(l => l.includes('claude wrapper'))).toBe(false)
      expect(rows().some(r => r.includes('claude wrapper'))).toBe(false)
    } else {
      expect(logs).toContain(`this tab's claude wrapper isn't used: ${why}. A new window resumes the session.`)
      expect(rows().at(-1)).toContain(`It restarted in a new window, not in its tab through the claude wrapper: ${quoted(why)}.`)
    }
  })
}

test("a conversation whose start named another id than $.session.id() reads: the window, saying why", async ($, on) => {
  const { kinds, logs, clock } = engine(on)
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'startup', session_id: OTHER })
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(kinds).toEqual(['launcher'])
  expect(logs).toContain(`this tab's claude wrapper isn't used: this session's id reads ${ID}, but the start of this conversation named ${OTHER}. A new window resumes the session.`)
})

test('the claim held by another switch or restart: no ticket, nothing exits, and the model is told', async ($, on) => {
  const { kinds, commands, toasts, rows, held, clock } = engine(on, { paneScript: 'held' })
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(kinds).toEqual(['pane'])
  expect(commands).toEqual([])
  expect(toasts.some(t => t.startsWith("Restart didn't run: the ticket for this tab wasn't written (exit 5: self-restart: another switch or restart holds the claim"))).toBe(true)
  expect(rows().at(-1)).toMatch(/^The restart you queued didn't run, and nothing was left for this tab \(/)
  expect(held.get('restarts')).toEqual({})
})

test("a ticket that isn't written after the claim was taken: the claim is given back at once, and nothing exits", async ($, on) => {
  const { kinds, scripts, commands, clock } = engine(on, { paneScript: 'fails' })
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(kinds).toEqual(['pane', 'release'])
  expect(scripts[1]).toContain(`$lock.by -cne '${claimOf(scripts[0])}'`)
  expect(commands).toEqual([])
})

test('the full safe point holds first: a background job under the session, there by the time it is armed, writes no ticket and exits nothing', async ($, on) => {
  const { kinds, commands, rows, world, writes, clock } = engine(on)
  await $.session.start(start)
  expect((await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })).deny).toBeUndefined()
  world.probe = probeOf([{ pid: 505, ppid: 100, created: '134062355678901240', name: 'bash.exe', cls: 'shell' }])
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(kinds).toEqual([])
  expect(commands).toEqual([])
  expect(rows().at(-1)).toMatch(/the background shell bash\.exe 505 runs under this session/)
  expect(writes.map(w => w.text).at(-1)).toBe('{"v":1,"done":true}')
})

test('the pre-check at the call: a session cron refuses it, and nothing is queued, written or run', async ($, on) => {
  const { kinds, writes, clock } = engine(on, { crons: [{ id: '7f3a9c21', humanSchedule: 'Every 5 minutes' }] })
  await $.session.start(start)
  expect((await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })).deny).toMatch(/^Not queued: cron 7f3a9c21/)
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(kinds).toEqual([])
  expect(writes).toEqual([])
})

for (const [where, options, toast] of [
  ['the tab', {}, "This tab resumes the session if it exits (/exit) within 2 minutes."],
  ["this pane's slot", { token: '', launcher: 'slot' as const }, "This pane's slot resumes the session if it exits (/exit) within 2 minutes."],
  ['a new window', { token: '' }, 'Its window waits up to 10 minutes for this session to exit, then gives up; close it, or exit (/exit) to resume there.'],
] as const) {
  test(`a restart stopped right before its exit, ${where} already holding the claim: the record keeps the claim, and the session resumed there releases it`, async ($, on) => {
    const { scripts, kinds, commands, toasts, held, prompts, clock } = engine(on, { ...options, agentDuring: true })
    await $.session.start(start)
    await $.tool.call({ tool: TOOL, reason: 'Switched accounts.', resume: 'Go on.' })
    await $.turn.complete(answered)
    await clock.advance(1000)
    expect(commands).toEqual([])
    expect(toasts).toContain(`Restart stopped before the exit: a subagent is still running (Lint), and its work would end with this process. ${toast}`)
    // The claim the ticket, the slot's record or the window holds.
    const claim = where === 'the tab' ? claimOf(scripts[0]) : where === "this pane's slot" ? `slot:${SLOT}` : LAUNCH
    // Kept, with the claim, but not the first prompt: the session went on.
    expect((held.get('restarts') as Record<string, unknown>)[ID]).toEqual({ at: 1_000_500, reason: 'Switched accounts.', claim })

    // The person exits within 2 minutes, and the tab, the slot or the window resumes the session: its
    // copy of the plugin releases that claim, once, and sends no first prompt.
    await $.classic.SessionStart({ source: 'resume', session_id: ID })
    await clock.advance(1000)
    expect(kinds.at(-1)).toBe('release')
    expect(scripts.at(-1)).toContain(`$lock.by -cne '${claim}'`)
    expect(prompts).toEqual([])
    expect(held.get('restarts')).toEqual({})
  })
}

test('the pending marker: written at the call and the arm, done right before the exit', async ($, on) => {
  const { commands, writes, clock } = engine(on)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual(['exit'])
  expect(writes.map(w => w.path)).toEqual([MARKER, MARKER, MARKER])
  expect(writes.map(w => w.text)).toEqual(['{"v":1,"kind":"restart","at":1000000}', '{"v":1,"kind":"restart","at":1000000}', '{"v":1,"done":true}'])
})

test('an exit that is refused: this tab resumes the session if it exits within 2 minutes, and the model is told so', async ($, on) => {
  const { commands, toasts, rows, clock } = engine(on, { exit: 'refused' })
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual(['exit'])
  expect(toasts.some(t => /^Exit didn't run: .+\. This tab resumes the session if it exits \(\/exit\) within 2 minutes\.$/.test(t))).toBe(true)
  expect(rows().at(-1)).toMatch(/^The restart left this tab's claude wrapper a ticket, but the exit didn't run: .+ If this process exits within 2 minutes, the wrapper resumes the session in this tab; after that this session goes on as it is\.$/)
})

test("the tool's description says it restarts in the same tab through the claude wrapper", async ($, on) => {
  const { described } = engine(on)
  await $.session.start(start)
  expect(described[0]).toContain('when Claude Code was started through the claude wrapper')
  expect(described[0]).toContain('it restarts in this same terminal tab')
})
