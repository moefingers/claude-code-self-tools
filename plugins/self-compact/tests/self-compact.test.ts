import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__self-compact__compact_after_turn'

/** The engine beneath the plugin: what it answers, and the compactions and prompts it was asked for. */
function engine(on: On, { skip, rejectFirst = false }: { skip?: string; rejectFirst?: boolean } = {}) {
  const compactions: (string | undefined)[] = []
  const described: string[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => (described.push(String(e.description)), { value: { tool: TOOL } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  let rejected = !rejectFirst
  on('session.compact', (_, e) => {
    // As the engine does while it still counts a turn as running.
    if (!rejected) {
      rejected = true
      throw new Error('a turn is running; the conversation compacts between turns')
    }
    compactions.push(e.instructions)
    return skip === undefined ? { messages: [{ role: 'user', text: 'The summary.', toolUses: [] }] } : { skip }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', () => ({ text: 'done' }))
  return { compactions, prompts, toasts, described, clock: mock.clock(on) }
}

const ended = { answer: 'done', durationMs: 1, turnId: 't1' } as const

test('a queued compaction runs once the turn ends, keeping what the call said', async ($, on) => {
  const { compactions, prompts, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const queued = await $.tool.call({ tool: TOOL, keep: 'the PR queue' })
  expect(queued.deny).toBeUndefined()
  expect(compactions).toEqual([])

  await $.turn.complete({ ...ended, isAborted: false, reason: 'answer' })
  await clock.advance(0)
  // Between turns, the default: from the turn's end itself, with no beat for a queued message to take the session.
  expect(compactions).toEqual(['the PR queue'])
  await clock.advance(1000)
  expect(compactions).toEqual(['the PR queue'])
  // No resume asked for: the session waits for the next message.
  expect(prompts).toEqual([])

  // Queued once, run once: the next turn's end compacts nothing.
  await $.turn.complete({ ...ended, turnId: 't2', isAborted: false, reason: 'answer' })
  await clock.advance(1000)
  expect(compactions).toEqual(['the PR queue'])
})

test('with resume, the session sends itself that message once, after compacting', async ($, on) => {
  const { compactions, prompts, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: TOOL, keep: 'the PR queue', resume: ' Review the open PR at its new head. ' })
  await $.turn.complete({ ...ended, isAborted: false, reason: 'answer' })
  expect(prompts).toEqual([])
  await clock.advance(1000)
  expect(compactions).toEqual(['the PR queue'])
  expect(prompts).toEqual(['Compacted. Resume: Review the open PR at its new head.'])

  // The resumed turn ends without calling the tool: no second compaction, no second resume.
  await $.turn.complete({ ...ended, turnId: 't2', isAborted: false, reason: 'answer' })
  await clock.advance(1000)
  expect(compactions).toEqual(['the PR queue'])
  expect(prompts).toHaveLength(1)
})

test('a skipped compaction still resumes, and says it was skipped', async ($, on) => {
  const { prompts, toasts, clock } = engine(on, { skip: 'nothing to compact' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: TOOL, keep: 'the PR queue', resume: 'Go on with the next ticket.' })
  await $.turn.complete({ ...ended, isAborted: false, reason: 'answer' })
  await clock.advance(1000)
  expect(toasts.some(t => /skipped/.test(t))).toBe(true)
  expect(prompts).toEqual(['Compaction was skipped (nothing to compact). Resume: Go on with the next ticket.'])
})

test('an interrupted turn cancels the queued compaction and its resume', async ($, on) => {
  const { compactions, prompts, toasts, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: TOOL, keep: 'the PR queue', resume: 'Go on.' })
  await $.turn.complete({ ...ended, isAborted: true, reason: 'aborted' })
  await clock.advance(1000)
  expect(compactions).toEqual([])
  expect(prompts).toEqual([])
  expect(toasts.some(t => /cancelled/.test(t))).toBe(true)
})

test('a subagent is refused, and told how to close a piece instead', async ($, on) => {
  const { compactions, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const refused = await $.tool.call({ tool: TOOL, keep: 'the piece', agentId: 'a1' })
  expect(refused.deny).toMatch(/fresh agent/)
  await $.turn.complete({ ...ended, isAborted: false, reason: 'answer' })
  await clock.advance(1000)
  expect(compactions).toEqual([])
})

test('a call with nothing to keep is refused, and nothing is queued', async ($, on) => {
  const { compactions, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const refused = await $.tool.call({ tool: TOOL, keep: '   ' })
  expect(refused.deny).toMatch(/keep/)
  await $.turn.complete({ ...ended, isAborted: false, reason: 'answer' })
  await clock.advance(1000)
  expect(compactions).toEqual([])
})

test("the owner's design: 'idle' waits a beat, so anything queued goes first; between turns doesn't", async ($, on) => {
  const { compactions, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const queued = await $.tool.call({ tool: TOOL, keep: 'the PR queue', when: 'idle' })
  expect(queued.result).toContain('compacts once the session is idle after this turn')
  await $.turn.complete({ ...ended, isAborted: false, reason: 'answer' })
  await clock.advance(0)
  expect(compactions).toEqual([])
  await clock.advance(1000)
  expect(compactions).toEqual(['the PR queue'])
})

test("the owner's design: `when` is between turns or idle, nothing else; the description says both, and warns of the distant future", async ($, on) => {
  const { described, compactions, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const said = described.join(' ')
  expect(said).toContain("'between-turns' (the default) compacts right as this turn ends, ahead of anything queued meanwhile")
  expect(said).toContain('under a nonstop stream of work and notifications that may be the distant future')
  const refused = await $.tool.call({ tool: TOOL, keep: 'the PR queue', when: 'soon' })
  expect(refused.deny).toBe("`when` is 'between-turns' (the default) or 'idle'.")
  await $.turn.complete({ ...ended, isAborted: false, reason: 'answer' })
  await clock.advance(1000)
  expect(compactions).toEqual([])
})

test('R3: between turns, a compaction the engine rejects (the turn still counted as running) tries once more half a second later, with no turn to wait for', async ($, on) => {
  const { compactions, clock } = engine(on, { rejectFirst: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, keep: 'the PR queue' })
  await $.turn.complete({ ...ended, isAborted: false, reason: 'answer' })
  await clock.advance(0)
  expect(compactions).toEqual([])
  await clock.advance(1000)
  expect(compactions).toEqual(['the PR queue'])
})

test("the owner's note: the description says to end the turn and do nothing more until it has run, then carry on", async ($, on) => {
  const { described } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(described.join(' ')).toContain('After calling it, end your turn and do nothing more until it has run; then carry on.')
})
