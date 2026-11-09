import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__self-color__color_after_turn'

/** The colors the tool takes, spelled out here so that a change to the list shows: Claude Code's eight, and `default`. */
const COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan', 'default'] as const

/** What the call refuses with for anything else. */
const REFUSED = '`color` must be one of: red, blue, green, yellow, purple, orange, pink, cyan, or default (which resets it).'

/** /color's own refusal in a teammate session (Claude Code 2.1.319). */
const TEAMMATE = 'Cannot set color: This session is a teammate. Teammate colors are assigned by the team leader.'

/**
 * The engine beneath the plugin. `color` is what /color does: print its line and hand back no text (`silent`), hand back
 * its success line (`reports`), hand back its own refusal (`refuses`), or be refused by the engine (`fails`).
 */
function engine(on: On, { color = 'silent' }: { color?: 'silent' | 'reports' | 'refuses' | 'fails' } = {}) {
  const commands: string[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const registered: { description: string; inputSchema: unknown }[] = []
  const clock = mock.clock(on)
  const session = mock.session(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => (registered.push({ description: String(e.description), inputSchema: e.inputSchema }), { value: { tool: TOOL } }))
  on('ui.status', (_, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.toast', (_, e) => (toasts.push(String(e.text)), { value: undefined }))
  on('prompt.submit', (_, e) => (prompts.push(e.text), { text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('command.run', async (_, e, next) => {
    commands.push(`${e.command} ${e.args}`)
    if (color === 'fails') return next(e)
    if (color === 'refuses') return { text: TEAMMATE }
    if (color === 'reports') return { text: e.args === 'default' ? 'Session color reset to default' : `Session color set to: ${e.args}` }
    return {}
  })
  return { commands, prompts, toasts, statuses, registered, clock, session }
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as const

test('a valid color is queued at the call, and /color <color> runs once the turn ends', async ($, on) => {
  const { commands, toasts, statuses, session, clock } = engine(on)
  await $.session.start(start)

  const queued = await $.tool.call({ tool: TOOL, color: 'red' })
  expect(queued.deny).toBeUndefined()
  expect(queued.result).toBe('Queued. The prompt bar turns red once this turn ends, and stays red for the session.')
  expect(statuses).toEqual(['/color red queued for when this turn ends'])
  expect(commands).toEqual([])

  await $.turn.complete(answered)
  expect(commands).toEqual([])
  // At once, the moment the turn's end returns: no half-second beat.
  await clock.advance(1)
  expect(commands).toEqual(['color red'])
  expect(toasts).toEqual(['Prompt bar color set to red.'])
  expect(statuses.at(-1)).toBeUndefined()
  // A change that took tells the model nothing more: the call's result has said it.
  expect(session.appended()).toEqual([])

  // A later turn's end runs nothing more.
  await $.turn.complete({ ...answered, turnId: 't2' })
  await clock.advance(1000)
  expect(commands).toHaveLength(1)
})

test('every color /color takes is accepted, and the schema lists exactly them', async ($, on) => {
  const { commands, registered, clock } = engine(on)
  await $.session.start(start)
  const schema = registered.at(-1)?.inputSchema as { properties: { color: { enum: string[] } }; required: string[] }
  expect(schema.properties.color.enum).toEqual([...COLORS])
  expect(schema.required).toEqual(['color'])

  for (const [i, color] of COLORS.entries()) {
    const queued = await $.tool.call({ tool: TOOL, color })
    expect(queued.deny).toBeUndefined()
    await $.turn.complete({ ...answered, turnId: `t${i}` })
    await clock.advance(1)
  }
  expect(commands).toEqual(COLORS.map(color => `color ${color}`))
})

test('`default` resets the prompt bar: /color default runs, and the toast says it was reset', async ($, on) => {
  const { commands, toasts, statuses, clock } = engine(on)
  await $.session.start(start)

  const queued = await $.tool.call({ tool: TOOL, color: 'default' })
  expect(queued.result).toBe('Queued. The prompt bar goes back to its default color once this turn ends.')
  expect(statuses).toEqual(['/color default queued for when this turn ends'])
  await $.turn.complete(answered)
  await clock.advance(1)
  expect(commands).toEqual(['color default'])
  expect(toasts).toEqual(['Prompt bar color reset to default.'])
})

test('anything else is refused at the call, naming the valid colors, and nothing runs', async ($, on) => {
  const { commands, statuses, clock } = engine(on)
  await $.session.start(start)

  // /color's own aliases and a random pick (no argument) are left out, as are other spellings and anything not one word.
  for (const color of ['grey', 'gray', 'reset', 'none', 'Red', ' red', 'red ', '', 'red blue', 'red\n/clear', 'magenta', 3, null, undefined]) {
    const call = await $.tool.call({ tool: TOOL, color })
    expect(call.deny).toBe(REFUSED)
    expect(call.result).toBeUndefined()
  }
  expect((await $.tool.call({ tool: TOOL })).deny).toBe(REFUSED)
  expect(statuses).toEqual([])
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
})

test('a subagent is refused, and nothing runs', async ($, on) => {
  const { commands, toasts, clock } = engine(on)
  await $.session.start(start)

  const call = await $.tool.call({ tool: TOOL, color: 'red', agentId: 'a1' })
  expect(call.deny).toBe("A subagent can't set the session's prompt bar color. Finish your piece and return its result; the main session can set it.")
  await $.turn.complete({ ...answered, turnId: 'a-t1', agentId: 'a1' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
  expect(toasts).toEqual([])
})

test("a subagent's turn end leaves the main session's change queued, for the main turn's end", async ($, on) => {
  const { commands, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'green' })
  await $.turn.complete({ ...answered, turnId: 'a-t1', agentId: 'a1' })
  await clock.advance(1000)
  expect(commands).toEqual([])
  await $.turn.complete(answered)
  await clock.advance(1)
  expect(commands).toEqual(['color green'])
})

test('a /color the engine refuses says so in a toast, and the model is told', async ($, on) => {
  const { commands, toasts, session, clock } = engine(on, { color: 'fails' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'purple' })
  await $.turn.complete(answered)
  await clock.advance(1)
  expect(commands).toEqual(['color purple'])
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatch(/^\/color didn't run: .+/)
  expect(toasts.some(t => t.startsWith('Prompt bar color set'))).toBe(false)
  expect(JSON.stringify(session.appended())).toMatch(/The prompt bar color change to purple you queued didn't run: .+\./)
})

test("/color's own refusal (a teammate session) says the color wasn't set, in Claude Code's words, and the model is told", async ($, on) => {
  const { commands, toasts, session, clock } = engine(on, { color: 'refuses' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'orange' })
  await $.turn.complete(answered)
  await clock.advance(1)
  expect(commands).toEqual(['color orange'])
  expect(toasts).toEqual([`Prompt bar color not set: ${TEAMMATE}`])
  expect(JSON.stringify(session.appended())).toContain(`The prompt bar color change to orange you queued didn't take: ${TEAMMATE}`)
})

test("/color's own success line, handed back, counts as set", async ($, on) => {
  const { toasts, session, clock } = engine(on, { color: 'reports' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'pink' })
  await $.turn.complete(answered)
  await clock.advance(1)
  await $.tool.call({ tool: TOOL, color: 'default' })
  await $.turn.complete({ ...answered, turnId: 't2' })
  await clock.advance(1)
  expect(toasts).toEqual(['Prompt bar color set to pink.', 'Prompt bar color reset to default.'])
  expect(session.appended()).toEqual([])
})

test("a person's turn between the turn's end and the run: the color still changes, once", async ($, on) => {
  const { commands, prompts, toasts, session, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'yellow' })
  // Typed over t1, so it runs first, in a turn of its own, before the queued /color.
  await $.prompt.submit({ text: "stop, don't do X", wait: false, origin: { kind: 'composer' }, turnId: 't1' })
  await $.turn.complete(answered)
  await $.turn.start({ text: "stop, don't do X", turnId: 't2' })
  await $.turn.complete({ ...answered, turnId: 't2' })
  await clock.advance(1)
  expect(prompts).toEqual(["stop, don't do X"])
  expect(commands).toEqual(['color yellow'])
  expect(toasts).toEqual(['Prompt bar color set to yellow.'])
  expect(session.appended()).toEqual([])
})

test('a person typing while idle, after the turn ended and before the run: the color still changes', async ($, on) => {
  const { commands, toasts, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'blue' })
  await $.turn.complete(answered)
  await $.prompt.submit({ text: 'hold on', wait: false, origin: { kind: 'bridge' } })
  await $.turn.start({ text: 'hold on', turnId: 't2' })
  await clock.advance(1)
  expect(commands).toEqual(['color blue'])
  expect(toasts).toEqual(['Prompt bar color set to blue.'])
})

test('an interrupted turn cancels the change, with a notice', async ($, on) => {
  const { commands, toasts, statuses, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'cyan' })
  await $.turn.complete({ ...answered, isAborted: true, reason: 'aborted' })
  await clock.advance(1000)
  expect(commands).toEqual([])
  expect(toasts).toEqual(["Prompt bar color change cancelled: the turn didn't finish."])
  expect(statuses.at(-1)).toBeUndefined()

  // Nothing is left queued for the next turn's end.
  await $.turn.complete({ ...answered, turnId: 't2' })
  await clock.advance(1000)
  expect(commands).toEqual([])
})

test('two calls in one turn: the last one is the color set', async ($, on) => {
  const { commands, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'red' })
  await $.tool.call({ tool: TOOL, color: 'blue' })
  await $.turn.complete(answered)
  await clock.advance(1)
  expect(commands).toEqual(['color blue'])
})

test('the description says what it does, when to use it, that it lasts for the session and that `default` resets it', async ($, on) => {
  const { registered } = engine(on)
  await $.session.start(start)
  expect(registered.at(-1)?.description).toBe(
    [
      "Sets this session's prompt bar color once the current turn ends, as /color does.",
      "Use it to mark the session's role, so the person can tell sessions apart at a glance: for example, one color for a merger and another for a worker.",
      'The color lasts for the session; `default` resets it.',
      "It runs once the session is idle, after anything already waiting; you don't need to end your turn for it.",
    ].join(' '),
  )
})
