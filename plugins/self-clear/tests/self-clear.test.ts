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
  const described: string[] = []
  const world = { id: 'session-1', agents }
  const clock = mock.clock(on)
  const session = mock.session(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: world.id }))
  on('tool.register', (_, e) => {
    described.push(String(e.description))
    return { value: { tool: TOOL } }
  })
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
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('command.run', (_, e, next) => {
    commands.push(e.command)
    if (clear === 'refused') return next(e)
    if (clear === 'clears' && e.command === 'clear') world.id = 'session-2'
    return {}
  })
  return { commands, prompts, toasts, described, clock, session, world }
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as const

test('the clear runs only once the turn has ended, and the handoff is the first prompt after it', async ($, on) => {
  const { commands, prompts, toasts, clock } = engine(on)
  await $.session.start(start)

  const queued = await $.tool.call({ tool: TOOL, why: 'complete', handoff: ' Start ticket 42; notes in docs/42.md. ' })
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

test('a call without a handoff is refused, and nothing is queued: `handoff` is still required', async ($, on) => {
  const { commands, clock } = engine(on)
  await $.session.start(start)

  for (const input of [{}, { handoff: '' }, { handoff: '   ' }, { handoff: 42 }]) {
    const refused = await $.tool.call({ tool: TOOL, why: 'complete', ...input })
    expect(refused.deny).toMatch(/handoff/)
  }
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
})

/** The refusal of a clear that is neither complete nor contaminated, spelled out so that a change to it shows. */
const NOT_WHY =
  "A clear loses this session's memory of the whole story. Compact instead (compact_after_turn), or restart into the same conversation (restart_after_turn). Clear only when the work is complete (why: 'complete') or the context is contaminated (why: 'contaminated'), with the notes named in handoff."

test("a clear without why, or with any why but 'complete' or 'contaminated', is refused at the call: nothing is queued or armed", async ($, on) => {
  const { commands, prompts, session, clock } = engine(on)
  await $.session.start(start)

  for (const why of [undefined, 'tidy', '', ' complete', 'Complete', 'complete ', 'contaminated, and tidy', 7, true, ['complete'], null]) {
    const refused = await $.tool.call({ tool: TOOL, ...(why === undefined ? {} : { why }), handoff: 'Start ticket 42; notes in docs/42.md.' })
    expect(refused.deny).toBe(NOT_WHY)
  }
  // Not at the turn's end either: nothing was queued, so nothing runs.
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
  expect(prompts).toEqual([])
  expect(session.appended()).toEqual([])
})

for (const [why, said] of [
  ['complete', 'its work is complete'],
  ['contaminated', 'its context was contaminated'],
] as const) {
  test(`why: '${why}' clears as before, and says why in the leaving row and the toast`, async ($, on) => {
    const { commands, prompts, toasts, session, clock } = engine(on)
    await $.session.start(start)

    const queued = await $.tool.call({ tool: TOOL, why, handoff: 'Start ticket 42; notes in docs/42.md.' })
    expect(queued.deny).toBeUndefined()
    expect(queued.result).toMatch(new RegExp(`^Queued \\(why: ${why}\\)\\.`))
    await $.turn.complete(answered)
    await clock.advance(1000)
    expect(commands).toEqual(['clear'])
    expect(prompts).toEqual(['Context cleared at your own request (clear_after_turn). Handoff: Start ticket 42; notes in docs/42.md.'])
    const rows = session.appended().flatMap(row => ((row as { message?: { content?: { text?: unknown }[] } }).message?.content ?? []).map(block => String(block.text)))
    // The leaving row: the conversation's last before the clear.
    expect(rows).toEqual([
      `This conversation was cleared at its own request (clear_after_turn), because ${said} (why: ${why}). The cleared conversation starts from the handoff: Start ticket 42; notes in docs/42.md.`,
    ])
    expect(toasts).toContain(`Conversation cleared because ${said}; the handoff is its first prompt.`)
  })
}

test('the description leads with compacting and restarting, and names the two reasons a clear is for', async ($, on) => {
  const { described } = engine(on)
  await $.session.start(start)
  const [text] = described
  expect(text?.startsWith("Prefer compact_after_turn, which keeps a summary of this conversation, or restart_after_turn, which gives a fresh process and resumes this same conversation: a clear loses this session's memory of the whole story.")).toBe(true)
  expect(text).toContain("Only when `why` is 'complete'")
  expect(text).toContain("or 'contaminated'")
})

test('a clear that leaves the session as it was sends no handoff, and says so', async ($, on) => {
  const { commands, prompts, toasts, session, clock } = engine(on, { clear: 'no-op' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, why: 'complete', handoff: 'Go on.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual(['clear'])
  expect(prompts).toEqual([])
  expect(toasts.some(t => /didn't take/.test(t))).toBe(true)
  // The handoff is not lost: the note carries it.
  expect(JSON.stringify(session.appended())).toMatch(/ran but didn't take.+It was: Go on\./)
})

test('a refused clear sends no handoff, and tells the model the conversation stands', async ($, on) => {
  const { prompts, toasts, session, clock } = engine(on, { clear: 'refused' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, why: 'complete', handoff: 'Go on.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(prompts).toEqual([])
  expect(toasts.some(t => /didn't run/.test(t))).toBe(true)
  expect(JSON.stringify(session.appended())).toMatch(/didn't run.+as it was/)
})

test('a handoff the engine drops is kept as a note for the next message', async ($, on) => {
  const { prompts, toasts, session, clock } = engine(on, { dropped: 'a Stop stands' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, why: 'complete', handoff: 'Start ticket 42.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(prompts).toEqual([])
  expect(toasts.some(t => /Handoff not sent: a Stop stands/.test(t))).toBe(true)
  expect(JSON.stringify(session.appended())).toMatch(/Handoff: Start ticket 42\./)
})

test('a running subagent refuses the call, and one started before the turn ends cancels the clear', async ($, on) => {
  const { commands, prompts, toasts, world, clock } = engine(on, { agents: [{ description: 'Run the e2e suite', status: 'running' }] })
  await $.session.start(start)

  const refused = await $.tool.call({ tool: TOOL, why: 'complete', handoff: 'Go on.' })
  expect(refused.deny).toMatch(/still running \(Run the e2e suite\)/)

  // It reported; the call queues. Then another starts before the turn ends: the clear doesn't run.
  world.agents = [{ description: 'Run the e2e suite', status: 'completed' }]
  expect((await $.tool.call({ tool: TOOL, why: 'complete', handoff: 'Go on.' })).deny).toBeUndefined()
  world.agents = [{ description: 'Lint', status: 'pending' }]
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
  expect(prompts).toEqual([])
  expect(toasts.some(t => /Clear cancelled/.test(t))).toBe(true)
})

test('a message that starts a turn before the clear has run cancels it, and says so', async ($, on) => {
  const { commands, prompts, toasts, session, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, why: 'complete', handoff: 'Go on.' })
  await $.turn.complete(answered)
  // The person's next message starts its turn before the queued command has run.
  await $.turn.start({ text: 'one more thing', turnId: 't2' })
  await clock.advance(60_000)
  expect(commands).toEqual([])
  expect(prompts).toEqual([])
  expect(toasts.some(t => /Clear cancelled: a new turn started/.test(t))).toBe(true)
  expect(JSON.stringify(session.appended())).toMatch(/clear you queued didn't run: a new turn started/)
})

test("a subagent's turn, starting or ending, leaves the queued clear alone", async ($, on) => {
  const { commands, toasts, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, why: 'complete', handoff: 'Go on.' })
  // A subagent's turn ends before the main one: the clear stays queued, and doesn't run yet.
  await $.turn.complete({ ...answered, turnId: 'a-t1', agentId: 'a1' })
  await clock.advance(60_000)
  expect(commands).toEqual([])
  // The main turn ends; a subagent's turn that starts then doesn't take the clear back.
  await $.turn.complete(answered)
  await $.turn.start({ text: '', turnId: 'a-t2', agentId: 'a1' })
  await clock.advance(1000)
  expect(commands).toEqual(['clear'])
  expect(toasts.some(t => /cancelled/.test(t))).toBe(false)
})

test('an interrupted turn cancels the clear and its handoff', async ($, on) => {
  const { commands, prompts, toasts, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, why: 'complete', handoff: 'Go on.' })
  await $.turn.complete({ ...answered, isAborted: true, reason: 'aborted' })
  await clock.advance(1000)
  expect(commands).toEqual([])
  expect(prompts).toEqual([])
  expect(toasts.some(t => /cancelled/.test(t))).toBe(true)
})

test('a subagent is refused, and nothing is queued', async ($, on) => {
  const { commands, clock } = engine(on)
  await $.session.start(start)

  const refused = await $.tool.call({ tool: TOOL, why: 'complete', handoff: 'Go on.', agentId: 'a1' })
  expect(refused.deny).toMatch(/subagent/)
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
})

test('a subagent that has not ended holds, whatever its status: an idle teammate, and a status this plugin does not know; it says how to clear one that will not report; one that has ended does not hold', async ($, on) => {
  const { world } = engine(on)
  await $.session.start(start)
  for (const status of ['idle', 'paused']) {
    world.agents = [{ status, description: 'A teammate' }] as never
    const refused = await $.tool.call({ tool: TOOL, why: 'complete', handoff: 'Go on.' })
    expect(refused.deny).toContain('A teammate')
    expect(refused.deny).toContain(status)
    expect(refused.deny).toContain('TaskStop')
  }
  world.agents = [{ status: 'running', description: 'Lint' }] as never
  expect((await $.tool.call({ tool: TOOL, why: 'complete', handoff: 'Go on.' })).deny).toContain('Lint')
  for (const status of ['completed', 'failed', 'killed']) {
    world.agents = [{ status, description: 'Lint' }] as never
    expect((await $.tool.call({ tool: TOOL, why: 'complete', handoff: 'Go on.' })).deny).toBeUndefined()
  }
})
