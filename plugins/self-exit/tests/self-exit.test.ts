import { expect, mock, test } from 'claude-code/testing'
import type { AgentStatus, On } from 'claude-code'
import { wakeMarker } from '../hooks/machine'

const TOOL = 'mcp__self-exit__exit_after_turn'
const HOUR = 60 * 60 * 1000
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const LOCAL = 'C:\\Users\\u\\AppData\\Local'
const MARKER = `${LOCAL}\\claude-self-tools\\pending\\${ID}.json`
/** Windows, where the pre-check runs the probe. */
const WINDOWS = { OS: 'Windows_NT', SystemRoot: 'C:\\Windows', LOCALAPPDATA: LOCAL }
/** Off Windows, but with a folder for the marker: no probe runs. */
const ELSEWHERE = { LOCALAPPDATA: LOCAL }

/** A FILETIME some seconds after a fixed start, as the probe prints it. */
const ft = (seconds: number): string => String(BigInt('134062345668901240') + BigInt(seconds) * BigInt(10_000_000))

/** The probe's answer: claude.exe 100 in a pane, the probe (300) under it, and `under`. */
const probeOf = (under: Record<string, unknown>[] = []) =>
  `${JSON.stringify({
    v: 1,
    self: 300,
    session: { pid: 100, created: ft(2) },
    slot: null,
    procs: [
      { pid: 20, ppid: 10, created: ft(1), name: 'powershell.exe', cls: 'shell' },
      { pid: 100, ppid: 20, created: ft(2), name: 'claude.exe' },
      { pid: 300, ppid: 100, created: ft(900), name: 'powershell.exe', cls: 'shell' },
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

const BASH = { pid: 505, ppid: 100, created: ft(500), name: 'bash.exe', cls: 'shell' }
const CRON = { id: '7f3a9c21', humanSchedule: 'Every 5 minutes', cron: '*/5 * * * *', prompt: 'check the deploy', recurring: true }

type Cron = { id: string; humanSchedule?: string; cron?: string; prompt?: string; recurring?: boolean }

type Options = {
  /**
   * What /exit does: end the process (the call never comes back, as the module ends with the
   * session), come back with the session still open (a dialog answered no), or be refused.
   */
  exit?: 'exits' | 'stays' | 'refused'
  /** The session's agents and their status. */
  agents?: { description: string; status: AgentStatus }[]
  /** The process's environment: off Windows, with no folder for the marker, unless a test says. */
  env?: Record<string, string>
  /** The session's id. */
  id?: string
  /** The session's crons, as CronList lists them. */
  crons?: Cron[]
  /** CronList's permission verdict. */
  cronCheck?: 'allow' | 'ask' | 'deny'
  /** What CronList does: answer, fail, or answer in another shape. */
  cronList?: 'answers' | 'fails' | 'garbled'
  /** What the probe prints, or that it fails. */
  probe?: string | 'fails'
}

/** The engine beneath the plugin: its agents, crons and machine, and the commands, rows, lines and files it was asked for. */
function engine(on: On, { exit = 'exits', agents = [], env = {}, id = ID, crons = [], cronCheck = 'allow', cronList = 'answers', probe = probeOf() }: Options = {}) {
  const commands: string[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  const logs: string[] = []
  const probes: string[] = []
  const cronCalls: string[] = []
  const writes: { path: string; text: string }[] = []
  const described: string[] = []
  /** What each `$.tool.check` of CronList put under `input`, and the keys each `$.tool.call` of it carried. */
  const checkInputs: unknown[] = []
  const callShapes: string[][] = []
  // self-wake: undefined, not in this session; null, on with no marker; else its marker's text.
  const world: { agents: typeof agents; crons: typeof crons; cronCheck: typeof cronCheck; cronList: typeof cronList; probe: typeof probe; wake?: string | null } = { agents, crons, cronCheck, cronList, probe }
  const clock = mock.clock(on, { now: 1_000_000 })
  const session = mock.session(on)
  mock.env(on, env)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: id }))
  on('tool.list', () => ({ value: world.wake === undefined ? [] : [{ name: 'mcp__self-wake__wake_after', description: 'Wakes this session later.', mcp: true }] }))
  on('fs.exists', () => ({ value: world.wake !== null && world.wake !== undefined }))
  on('fs.read', () => (typeof world.wake === 'string' ? { value: world.wake } : { deny: 'ENOENT' }))
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
  on('agent.list', () => ({
    value: world.agents.map((a, i) => ({ id: `a${i}`, type: 'general-purpose', ...a })),
  }))
  on('tool.check', { tool: 'CronList' }, (_, e) => {
    checkInputs.push(e.input)
    return world.cronCheck === 'allow' ? { decision: 'allow' as const } : { decision: world.cronCheck, reason: 'a rule says so' }
  })
  // CronList as the engine answers it (live check SS2): `{ result: { jobs }, text }`, and an error
  // result for a call that puts its arguments under `input`. `as never`: its record's type is the engine's own.
  on('tool.call', { tool: 'CronList' }, (_, e) => {
    cronCalls.push('CronList')
    callShapes.push(Object.keys(e).filter(key => key !== 'tool_use_id' && key !== 'agentId' && key !== 'consent').sort())
    if ('input' in e) return { isError: true, result: 'InputValidationError: An unexpected parameter `input` was provided', text: 'InputValidationError: An unexpected parameter `input` was provided' } as never
    if (world.cronList === 'fails') return { isError: true, result: 'CronList broke', text: 'CronList broke' } as never
    if (world.cronList === 'garbled') return { result: { tasks: [] }, text: 'No scheduled jobs.' } as never
    return { result: { jobs: world.crons }, text: world.crons.length === 0 ? 'No scheduled jobs.' : `${world.crons.length} scheduled jobs.` } as never
  })
  on('process.run', (_, e) => {
    probes.push(String(e.init?.stdin ?? ''))
    if (world.probe === 'fails') return { value: { exitCode: 1, stdout: '', stderr: 'Get-CimInstance : Access denied', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: world.probe, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('command.run', async (_, e, next) => {
    commands.push(e.command)
    if (exit === 'refused') return next(e)
    if (exit === 'exits') await clock.sleep(HOUR)
    return {}
  })
  return { commands, prompts, toasts, logs, probes, cronCalls, checkInputs, callShapes, writes, described, clock, session, world }
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as const

/** The marker's states, in order: `exit` for a pending one, `done` for done. */
const marks = (writes: readonly { path: string; text: string }[]) => writes.map(w => (JSON.parse(w.text) as { kind?: string; done?: boolean }).kind ?? (JSON.parse(w.text).done === true ? 'done' : '?'))

test('the exit runs only once the turn has ended, after the reason and note are recorded', async ($, on) => {
  const { commands, prompts, toasts, logs, session, clock } = engine(on)
  await $.session.start(start)

  const queued = await $.tool.call({ tool: TOOL, reason: ' The brief is done and the PR is open. ', note: ' Review comments on PR 12. ' })
  expect(queued.deny).toBeUndefined()
  expect(queued.result).toMatch(/The brief is done and the PR is open\./)
  expect(queued.result).toMatch(/Remote Control/)
  // Nothing runs while the turn does, however long it goes on: not at the call, not at the turn's
  // end, only after it.
  await clock.advance(60_000)
  expect(commands).toEqual([])
  await $.turn.complete(answered)
  expect(commands).toEqual([])
  await clock.advance(1000)
  expect(commands).toEqual(['exit'])

  const rows = JSON.stringify(session.appended())
  expect(rows).not.toMatch(/This session ended/)
  expect(rows).toMatch(/This session asked to end here \(exit_after_turn\), and \/exit ran\. Reason: The brief is done and the PR is open\. Note for whoever resumes it: Review comments on PR 12\./)
  expect(logs.some(l => /The brief is done/.test(l))).toBe(true)
  expect(toasts.some(t => /Exiting/.test(t))).toBe(true)
  // An exit sends no prompt, and an exit that took never comes back to say it didn't.
  expect(prompts).toEqual([])
  await clock.advance(HOUR / 2)
  expect(toasts.some(t => /still open/.test(t))).toBe(false)
})

test('a call without a reason is refused, and nothing is queued', async ($, on) => {
  const { commands, session, clock } = engine(on)
  await $.session.start(start)

  for (const input of [{}, { reason: '' }, { reason: '  ' }, { reason: 7 }, { note: 'only a note' }]) {
    const refused = await $.tool.call({ tool: TOOL, ...input })
    expect(refused.deny).toMatch(/reason/)
  }
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
  expect(session.appended()).toEqual([])
})

test('a refused exit says so, and the session goes on', async ($, on) => {
  const { toasts, session, clock } = engine(on, { exit: 'refused' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, reason: 'Done.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(toasts.some(t => /Exit didn't run/.test(t))).toBe(true)
  expect(JSON.stringify(session.appended())).toMatch(/exit you queued didn't run.+goes on/)
})

test('an exit that leaves the session open is noticed', async ($, on) => {
  const { toasts, session, clock } = engine(on, { exit: 'stays' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, reason: 'Done.' })
  await $.turn.complete(answered)
  await clock.advance(10_000)
  expect(toasts.some(t => /still open/.test(t))).toBe(true)
  expect(JSON.stringify(session.appended())).toMatch(/ran, but the session is still open/)
})

test('a running subagent refuses the call, and one started before the turn ends cancels the exit', async ($, on) => {
  const { commands, toasts, world, clock } = engine(on, { agents: [{ description: 'Run the e2e suite', status: 'running' }] })
  await $.session.start(start)

  const refused = await $.tool.call({ tool: TOOL, reason: 'Done.' })
  expect(refused.deny).toMatch(/still running \(Run the e2e suite\): wait for it to report, or stop it with TaskStop \(a0\)/)

  world.agents = [{ description: 'Run the e2e suite', status: 'completed' }]
  expect((await $.tool.call({ tool: TOOL, reason: 'Done.' })).deny).toBeUndefined()
  world.agents = [{ description: 'Lint', status: 'waiting' }]
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
  expect(toasts.some(t => /Exit cancelled/.test(t))).toBe(true)
})

test('a session no one is at the prompt of is refused', async ($, on) => {
  const { commands, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })

  const refused = await $.tool.call({ tool: TOOL, reason: 'Done.' })
  expect(refused.deny).toMatch(/-p run/)
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
})

test('a message that starts a turn before the exit has run cancels it, and says so', async ($, on) => {
  const { commands, toasts, session, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, reason: 'Done.' })
  await $.turn.complete(answered)
  // The person's next message starts its turn before the queued command has run.
  await $.turn.start({ text: 'one more thing', turnId: 't2' })
  await clock.advance(60_000)
  expect(commands).toEqual([])
  expect(toasts.some(t => /Exit cancelled: a new turn started/.test(t))).toBe(true)
  const rows = JSON.stringify(session.appended())
  expect(rows).toMatch(/exit you queued didn't run: a new turn started/)
  expect(rows).not.toMatch(/asked to end here/)
})

test("a subagent's turn, starting or ending, leaves the queued exit alone", async ($, on) => {
  const { commands, toasts, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, reason: 'Done.' })
  // A subagent's turn ends before the main one: the exit stays queued, and doesn't run yet.
  await $.turn.complete({ ...answered, turnId: 'a-t1', agentId: 'a1' })
  await clock.advance(60_000)
  expect(commands).toEqual([])
  // The main turn ends; a subagent's turn that starts then doesn't take the exit back.
  await $.turn.complete(answered)
  await $.turn.start({ text: '', turnId: 'a-t2', agentId: 'a1' })
  await clock.advance(1000)
  expect(commands).toEqual(['exit'])
  expect(toasts.some(t => /cancelled/.test(t))).toBe(false)
})

test('an interrupted turn cancels the exit', async ($, on) => {
  const { commands, toasts, session, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, reason: 'Done.' })
  await $.turn.complete({ ...answered, isAborted: true, reason: 'aborted' })
  await clock.advance(1000)
  expect(commands).toEqual([])
  expect(session.appended()).toEqual([])
  expect(toasts.some(t => /cancelled/.test(t))).toBe(true)
})

test('a subagent is refused, and nothing is queued', async ($, on) => {
  const { commands, clock } = engine(on)
  await $.session.start(start)

  const refused = await $.tool.call({ tool: TOOL, reason: 'Done.', agentId: 'a1' })
  expect(refused.deny).toMatch(/subagent/)
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
})

// The pre-check: what would make /exit ask, or cut work off.

test('a session cron refuses the call, naming it with how to delete it, and nothing is queued', async ($, on) => {
  const { commands, writes, clock } = engine(on, { env: ELSEWHERE, crons: [CRON] })
  await $.session.start(start)

  const refused = await $.tool.call({ tool: TOOL, reason: 'Done.' })
  expect(refused.deny).toBe(
    'Not queued: cron 7f3a9c21 (Every 5 minutes: \u00abcheck the deploy\u00bb) is set to wake this session: delete it with CronDelete (id 7f3a9c21). Each would make /exit stop at its confirmation, or end with the session: stop them, then call again.',
  )
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
  expect(writes).toEqual([])
})

test('on Windows, a background shell under the session refuses the call, naming it with how to stop it', async ($, on) => {
  const { commands, probes, clock } = engine(on, { env: WINDOWS, probe: probeOf([BASH]) })
  await $.session.start(start)

  const refused = await $.tool.call({ tool: TOOL, reason: 'Done.' })
  expect(refused.deny).toBe(
    'Not queued: the shell bash.exe 505 runs under this session (a background job of the Bash, PowerShell or Monitor tool, or a tool call still finishing): stop it with TaskStop (the task id its Bash, PowerShell or Monitor call gave), or let it finish; if you started no background job, it is a tool call still finishing (self-check\'s check at a resume runs one): call again in a moment. Each would make /exit stop at its confirmation, or end with the session: stop them, then call again.',
  )
  // The probe asked of this session alone, and claimed nothing.
  expect(probes).toHaveLength(1)
  expect(probes[0]).toContain(`$ids = @('${ID}')`)
  expect(probes[0]).toContain('$take = $null')
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
})

test("anything the pre-check can't read refuses: CronList that would ask (never called), refused, failing or garbled; a probe that fails", async ($, on) => {
  const { cronCalls, world } = engine(on, { env: WINDOWS, cronCheck: 'ask' })
  await $.session.start(start)

  const asked = await $.tool.call({ tool: TOOL, reason: 'Done.' })
  expect(asked.deny).toMatch(/^Not queued: can't tell whether a session cron is set \(CronList would ask for permission here: a rule says so\)/)
  // A verdict other than allow: CronList is never called, so no dialog can open.
  expect(cronCalls).toEqual([])

  world.cronCheck = 'deny'
  expect((await $.tool.call({ tool: TOOL, reason: 'Done.' })).deny).toMatch(/can't tell whether a session cron is set \(CronList would be refused here/)
  expect(cronCalls).toEqual([])

  world.cronCheck = 'allow'
  world.cronList = 'fails'
  expect((await $.tool.call({ tool: TOOL, reason: 'Done.' })).deny).toMatch(/can't tell whether a session cron is set \(CronList failed: CronList broke\)/)
  world.cronList = 'garbled'
  expect((await $.tool.call({ tool: TOOL, reason: 'Done.' })).deny).toMatch(/can't tell whether a session cron is set \(CronList answered in a shape this plugin doesn't know\)/)

  world.cronList = 'answers'
  world.probe = 'fails'
  expect((await $.tool.call({ tool: TOOL, reason: 'Done.' })).deny).toMatch(
    /can't tell what runs under this session: the machine probe failed \(it exited 1: Get-CimInstance : Access denied\)/,
  )
  world.probe = probeOf()
  expect((await $.tool.call({ tool: TOOL, reason: 'Done.' })).deny).toBeUndefined()
})

test("CronList's two shapes: the check takes its arguments under `input`, the call at the top level (an `input:` call is an error result)", async ($, on) => {
  const { checkInputs, callShapes, commands, clock } = engine(on, { crons: [] })
  await $.session.start(start)
  expect((await $.tool.call({ tool: TOOL, reason: 'Done.' })).deny).toBeUndefined()
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual(['exit'])
  // At the call and again when armed: each check with `input: {}` (the kit checks again inside each
  // call, as the engine's permission step does), each call with no `input` key.
  expect(checkInputs.length).toBeGreaterThanOrEqual(2)
  for (const input of checkInputs) expect(input).toEqual({})
  expect(callShapes).toHaveLength(2)
  for (const keys of callShapes) {
    expect(keys).toContain('tool')
    expect(keys).not.toContain('input')
  }
})

test('on Windows, a session id that is no session id refuses: the probe would have nothing to ask about', async ($, on) => {
  const { probes } = engine(on, { env: WINDOWS, id: 'session-1' })
  await $.session.start(start)
  expect((await $.tool.call({ tool: TOOL, reason: 'Done.' })).deny).toMatch(/can't tell what runs under this session: the machine probe failed \(this session's id \("session-1"\) is not a session id\)/)
  expect(probes).toEqual([])
})

test('off Windows no probe runs, and crons and subagents are still read', async ($, on) => {
  const { probes, cronCalls, commands, clock } = engine(on)
  await $.session.start(start)
  expect((await $.tool.call({ tool: TOOL, reason: 'Done.' })).deny).toBeUndefined()
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual(['exit'])
  expect(probes).toEqual([])
  // At the call and again when armed.
  expect(cronCalls).toEqual(['CronList', 'CronList'])
})

test('a blocker that appears before the exit is armed refuses at the arm: nothing exits, and the marker says done', async ($, on) => {
  const { commands, toasts, session, writes, world, clock } = engine(on, { env: ELSEWHERE })
  await $.session.start(start)

  expect((await $.tool.call({ tool: TOOL, reason: 'Done.' })).deny).toBeUndefined()
  // A cron set later in the same turn.
  world.crons = [CRON]
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
  expect(toasts).toContain('Exit cancelled: cron 7f3a9c21 (Every 5 minutes: \u00abcheck the deploy\u00bb) is set to wake this session: delete it with CronDelete (id 7f3a9c21).')
  expect(JSON.stringify(session.appended())).toMatch(/The exit you queued didn't run: cron 7f3a9c21/)
  expect(JSON.stringify(session.appended())).not.toMatch(/asked to end here/)
  expect(marks(writes)).toEqual(['exit', 'exit', 'done'])
})

test('on Windows, a background shell started before the exit is armed refuses at the arm', async ($, on) => {
  const { commands, toasts, probes, world, clock } = engine(on, { env: WINDOWS })
  await $.session.start(start)

  expect((await $.tool.call({ tool: TOOL, reason: 'Done.' })).deny).toBeUndefined()
  world.probe = probeOf([BASH])
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
  expect(probes).toHaveLength(2)
  expect(toasts.some(t => t.startsWith('Exit cancelled: the shell bash.exe 505 runs under this session'))).toBe(true)
})

// The pending marker the coordinator reads.

test('the pending marker: written at the call and at the arm, done right before the exit runs', async ($, on) => {
  const { commands, writes, clock } = engine(on, { env: WINDOWS })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, reason: 'Done.' })
  expect(writes).toEqual([{ path: MARKER, text: '{"v":1,"kind":"exit","at":1000000}' }])
  await $.turn.complete(answered)
  expect(marks(writes)).toEqual(['exit', 'exit'])
  await clock.advance(1000)
  expect(commands).toEqual(['exit'])
  expect(writes.map(w => w.path)).toEqual([MARKER, MARKER, MARKER])
  expect(writes[2]?.text).toBe('{"v":1,"done":true}')
})

test('the pending marker says done when the exit is cancelled: an interrupted turn, or a new turn', async ($, on) => {
  const { writes, clock } = engine(on, { env: ELSEWHERE })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, reason: 'Done.' })
  await $.turn.complete({ ...answered, isAborted: true, reason: 'aborted' })
  expect(marks(writes)).toEqual(['exit', 'done'])

  await $.tool.call({ tool: TOOL, reason: 'Done.' })
  await $.turn.complete({ ...answered, turnId: 't2' })
  await $.turn.start({ text: 'one more thing', turnId: 't3' })
  await clock.advance(1000)
  expect(marks(writes)).toEqual(['exit', 'done', 'exit', 'exit', 'done'])
})

test("a session id that is no session id writes no marker: nothing but a session id is joined into the marker's path", async ($, on) => {
  const { commands, writes, clock } = engine(on, { env: ELSEWHERE, id: '..\\x' })
  await $.session.start(start)

  expect((await $.tool.call({ tool: TOOL, reason: 'Done.' })).deny).toBeUndefined()
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual(['exit'])
  expect(writes).toEqual([])
})

test("the tool's description names what it refuses on, and how to stop each", async ($, on) => {
  const { described } = engine(on)
  await $.session.start(start)
  const text = described.join(' ')
  expect(text).toContain('a session cron (delete it with CronDelete)')
  expect(text).toContain('a background Bash, PowerShell or Monitor job (stop it with TaskStop)')
  expect(text).toContain("while any of that can't be read")
})

test('a wake-up pending, by self-wake\'s marker, refuses the exit at the call and when armed (S1-9)', async ($, on) => {
  const { commands, world, clock } = engine(on, { env: WINDOWS })
  world.wake = wakeMarker({ armed: true, due: 2_000_000, at: 1 })
  await $.session.start(start)
  const refused = await $.tool.call({ tool: TOOL, reason: 'done' })
  expect(refused.deny).toContain('a wake-up is pending')
  expect(refused.deny).toContain('cancel_wake')
  // None armed: it goes.
  world.wake = wakeMarker({ armed: false, at: 1 })
  expect((await $.tool.call({ tool: TOOL, reason: 'done' })).deny).toBeUndefined()
  // Armed after the call: the run holds.
  world.wake = wakeMarker({ armed: true, due: 2_000_000, at: 2 })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
})

test('self-wake on with no marker holds: unknown holds (S1-9)', async ($, on) => {
  const { world } = engine(on, { env: WINDOWS })
  world.wake = null
  await $.session.start(start)
  const refused = await $.tool.call({ tool: TOOL, reason: 'done' })
  expect(refused.deny).toContain('whether a wake-up is pending')
})

test("the owner's design: the description says a exit runs only when the session is idle, why, and what a turn that starts first does", async ($, on) => {
  const { described } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const said = described.join(' ')
  expect(said).toContain("It can run only when the session is idle: Claude Code queues a plugin's command behind anything already waiting (a message typed during this turn, a background task's notification) and has no slot between turns ahead of them. A turn that starts first cancels the exit")
  expect(said).toContain('under a nonstop stream of work and notifications it may not run for a long time')
})
