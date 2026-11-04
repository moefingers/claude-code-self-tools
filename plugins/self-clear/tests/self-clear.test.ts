import { expect, mock, test } from 'claude-code/testing'
import type { AgentStatus, On } from 'claude-code'

const TOOL = 'mcp__self-clear__clear_after_turn'

type Options = {
  /** What /clear does: start a new conversation under a new id, leave the session as it was, or be refused. */
  clear?: 'clears' | 'no-op' | 'refused'
  /** The session's agents and their status. */
  agents?: { description: string; status: AgentStatus }[]
  /** Why the engine drops a prompt a plugin submits; left out, it enters. */
  dropped?: string
}

/** The engine beneath the plugin: its session id, its agents, and the commands and prompts it was asked for. */
function engine(on: On, { clear = 'clears', agents = [], dropped }: Options = {}) {
  const commands: string[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  const world = { id: 'session-1', agents }
  const clock = mock.clock(on)
  const session = mock.session(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: world.id }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('agent.list', () => ({
    value: world.agents.map((a, i) => ({ id: `a${i}`, type: 'general-purpose', ...a })),
  }))
  on('prompt.submit', (_, e) => {
    if (dropped !== undefined) return { drop: dropped }
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', () => ({ text: 'done' }))
  on('command.run', (_, e, next) => {
    commands.push(e.command)
    if (clear === 'refused') return next(e)
    if (clear === 'clears' && e.command === 'clear') world.id = 'session-2'
    return {}
  })
  return { commands, prompts, toasts, clock, session, world }
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as const

test('the clear runs only once the turn has ended, and the handoff is the first prompt after it', async ($, on) => {
  const { commands, prompts, toasts, clock } = engine(on)
  await $.session.start(start)

  const queued = await $.tool.call({ tool: TOOL, handoff: ' Start ticket 42; notes in docs/42.md. ' })
  expect(queued.deny).toBeUndefined()
  expect(queued.result).toMatch(/Start ticket 42; notes in docs\/42\.md\.$/)
  // Nothing runs while the turn does, however long it goes on: not at the call, not at the turn's
  // end, only after it.
  await clock.advance(60_000)
  expect(commands).toEqual([])
  await $.turn.complete(answered)
  expect(commands).toEqual([])
  await clock.advance(1000)
  expect(commands).toEqual(['clear'])
  expect(prompts).toEqual(['Context cleared at your own request (clear_after_turn). Handoff: Start ticket 42; notes in docs/42.md.'])
  expect(toasts.some(t => /cleared/.test(t))).toBe(true)

  // Queued once, run once.
  await $.turn.complete({ ...answered, turnId: 't2' })
  await clock.advance(1000)
  expect(commands).toEqual(['clear'])
  expect(prompts).toHaveLength(1)
})

test('a call without a handoff is refused, and nothing is queued', async ($, on) => {
  const { commands, clock } = engine(on)
  await $.session.start(start)

  for (const input of [{}, { handoff: '' }, { handoff: '   ' }, { handoff: 42 }]) {
    const refused = await $.tool.call({ tool: TOOL, ...input })
    expect(refused.deny).toMatch(/handoff/)
  }
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
})

test('a clear that leaves the session as it was sends no handoff, and says so', async ($, on) => {
  const { commands, prompts, toasts, session, clock } = engine(on, { clear: 'no-op' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, handoff: 'Go on.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual(['clear'])
  expect(prompts).toEqual([])
  expect(toasts.some(t => /didn't take/.test(t))).toBe(true)
  expect(JSON.stringify(session.appended())).toMatch(/ran but didn't take/)
})

test('a refused clear sends no handoff, and tells the model the conversation stands', async ($, on) => {
  const { prompts, toasts, session, clock } = engine(on, { clear: 'refused' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, handoff: 'Go on.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(prompts).toEqual([])
  expect(toasts.some(t => /didn't run/.test(t))).toBe(true)
  expect(JSON.stringify(session.appended())).toMatch(/didn't run.+as it was/)
})

test('a handoff the engine drops is kept as a note for the next message', async ($, on) => {
  const { prompts, toasts, session, clock } = engine(on, { dropped: 'a Stop stands' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, handoff: 'Start ticket 42.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(prompts).toEqual([])
  expect(toasts.some(t => /Handoff not sent: a Stop stands/.test(t))).toBe(true)
  expect(JSON.stringify(session.appended())).toMatch(/Handoff: Start ticket 42\./)
})

test('a running subagent refuses the call, and one started before the turn ends cancels the clear', async ($, on) => {
  const { commands, prompts, toasts, world, clock } = engine(on, { agents: [{ description: 'Run the e2e suite', status: 'running' }] })
  await $.session.start(start)

  const refused = await $.tool.call({ tool: TOOL, handoff: 'Go on.' })
  expect(refused.deny).toMatch(/still running \(Run the e2e suite\)/)

  // It reported; the call queues. Then another starts before the turn ends: the clear doesn't run.
  world.agents = [{ description: 'Run the e2e suite', status: 'completed' }]
  expect((await $.tool.call({ tool: TOOL, handoff: 'Go on.' })).deny).toBeUndefined()
  world.agents = [{ description: 'Lint', status: 'pending' }]
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
  expect(prompts).toEqual([])
  expect(toasts.some(t => /Clear cancelled/.test(t))).toBe(true)
})

test('an interrupted turn cancels the clear and its handoff', async ($, on) => {
  const { commands, prompts, toasts, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, handoff: 'Go on.' })
  await $.turn.complete({ ...answered, isAborted: true, reason: 'aborted' })
  await clock.advance(1000)
  expect(commands).toEqual([])
  expect(prompts).toEqual([])
  expect(toasts.some(t => /cancelled/.test(t))).toBe(true)
})

test('a subagent is refused, and nothing is queued', async ($, on) => {
  const { commands, clock } = engine(on)
  await $.session.start(start)

  const refused = await $.tool.call({ tool: TOOL, handoff: 'Go on.', agentId: 'a1' })
  expect(refused.deny).toMatch(/subagent/)
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
})
