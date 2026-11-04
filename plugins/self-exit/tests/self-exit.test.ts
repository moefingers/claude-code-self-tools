import { expect, mock, test } from 'claude-code/testing'
import type { AgentStatus, On } from 'claude-code'

const TOOL = 'mcp__self-exit__exit_after_turn'
const HOUR = 60 * 60 * 1000

type Options = {
  /**
   * What /exit does: end the process (the call never comes back, as the module ends with the
   * session), come back with the session still open (a dialog answered no), or be refused.
   */
  exit?: 'exits' | 'stays' | 'refused'
  /** The session's agents and their status. */
  agents?: { description: string; status: AgentStatus }[]
}

/** The engine beneath the plugin: its agents, and the commands, rows and lines it was asked for. */
function engine(on: On, { exit = 'exits', agents = [] }: Options = {}) {
  const commands: string[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  const logs: string[] = []
  const world = { agents }
  const clock = mock.clock(on)
  const session = mock.session(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
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
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', () => ({ text: 'done' }))
  on('command.run', async (_, e, next) => {
    commands.push(e.command)
    if (exit === 'refused') return next(e)
    if (exit === 'exits') await clock.sleep(HOUR)
    return {}
  })
  return { commands, prompts, toasts, logs, clock, session, world }
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as const

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
  expect(rows).toMatch(/ended at its own request \(exit_after_turn\)\. Reason: The brief is done and the PR is open\. Note for whoever resumes it: Review comments on PR 12\./)
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
  expect(refused.deny).toMatch(/still running \(Run the e2e suite\)/)

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
