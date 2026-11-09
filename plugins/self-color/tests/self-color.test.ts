import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { oneLine, sentence, text, why } from '../hooks/text'

const TOOL = 'mcp__self-color__color_after_turn'

/** The colors the tool takes, spelled out here so that a change to the list shows: Claude Code's eight, and `default`. */
const COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan', 'default'] as const

/** How long after a turn's end the change waits before it goes to Claude Code. */
const SETTLE = 500

/** What the call refuses with for anything else. */
const REFUSED = '`color` must be one of: red, blue, green, yellow, purple, orange, pink, cyan, or default (which resets it).'

/** /color's own refusal in a teammate session (Claude Code 2.1.319). */
const TEAMMATE = 'Cannot set color: This session is a teammate. Teammate colors are assigned by the team leader.'

/** The toast when /color hands back no text, as the interactive one never does. */
const RAN = (color: string) => `/color ${color} ran: Claude Code's line above says whether it took.`

const DROPPED = 'Prompt bar color change dropped: this session moved to another conversation.'

/**
 * The engine beneath the plugin. `color` is what /color does: print its line itself and hand back no text (`silent`,
 * the interactive panel command), hand back a line (`says`, headless), or be refused by the engine (`fails`). A /resume
 * or /clear the person runs waits, once `hold` names it, until the test lets it end (`end`).
 */
function engine(on: On, { color = 'silent', says = '' }: { color?: 'silent' | 'says' | 'fails'; says?: string } = {}) {
  const commands: string[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const registered: { description: string; inputSchema: unknown }[] = []
  const held = new Set<string>()
  const ends = new Map<string, () => void>()
  const clock = mock.clock(on)
  const session = mock.session(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('tool.register', (_, e) => (registered.push({ description: String(e.description), inputSchema: e.inputSchema }), { value: { tool: TOOL } }))
  on('ui.status', (_, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.toast', (_, e) => (toasts.push(String(e.text)), { value: undefined }))
  on('prompt.submit', (_, e) => (prompts.push(e.text), { text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('command.run', async (_, e, next) => {
    if (e.command !== 'color') {
      if (held.has(e.command)) await new Promise<void>(resolve => ends.set(e.command, resolve))
      return {}
    }
    commands.push(`${e.command} ${e.args}`)
    if (color === 'fails') return next(e)
    if (color === 'says') return { text: says }
    return {}
  })
  /** The notes the model was given, as text. */
  const notes = () => JSON.stringify(session.appended())
  return {
    commands,
    prompts,
    toasts,
    statuses,
    registered,
    clock,
    session,
    notes,
    hold: (command: string) => void held.add(command),
    end: (command: string) => {
      ends.get(command)?.()
      ends.delete(command)
    },
  }
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as const
const presentation = { isFullscreen: false, columns: 120 } as const

test('a valid color is queued at the call, and /color <color> runs half a second after the turn ends', async ($, on) => {
  const { commands, toasts, statuses, notes, clock } = engine(on)
  await $.session.start(start)

  const queued = await $.tool.call({ tool: TOOL, color: 'red' })
  expect(queued.deny).toBeUndefined()
  expect(queued.result).toBe("Queued. The prompt bar turns red once this turn ends, and stays red until it's changed.")
  expect(statuses).toEqual(['/color red queued for when this turn ends'])
  expect(commands).toEqual([])

  await $.turn.complete(answered)
  await clock.advance(SETTLE - 1)
  expect(commands).toEqual([])
  await clock.advance(1)
  expect(commands).toEqual(['color red'])
  expect(statuses.at(-1)).toBeUndefined()

  // A later turn's end runs nothing more.
  await $.turn.complete({ ...answered, turnId: 't2' })
  await clock.advance(1000)
  expect(commands).toHaveLength(1)
  expect(toasts).toHaveLength(1)
  expect(notes()).toBe('[]')
})

test("interactive: /color hands back no text, so the toast says it ran and points to Claude Code's line, never that it was set", async ($, on) => {
  const { commands, toasts, notes, clock } = engine(on, { color: 'silent' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'red' })
  await $.turn.complete(answered)
  await clock.advance(SETTLE)
  await $.tool.call({ tool: TOOL, color: 'default' })
  await $.turn.complete({ ...answered, turnId: 't2' })
  await clock.advance(SETTLE)
  expect(commands).toEqual(['color red', 'color default'])
  expect(toasts).toEqual([RAN('red'), RAN('default')])
  expect(toasts.some(t => /^Prompt bar color (set|reset)/.test(t))).toBe(false)
  expect(notes()).toBe('[]')
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
    await clock.advance(SETTLE)
  }
  expect(commands).toEqual(COLORS.map(color => `color ${color}`))
})

test('`default` resets the prompt bar: /color default runs, with its own result', async ($, on) => {
  const { commands, statuses, clock } = engine(on)
  await $.session.start(start)

  const queued = await $.tool.call({ tool: TOOL, color: 'default' })
  expect(queued.result).toBe('Queued. The prompt bar goes back to its default color once this turn ends.')
  expect(statuses).toEqual(['/color default queued for when this turn ends'])
  await $.turn.complete(answered)
  await clock.advance(SETTLE)
  expect(commands).toEqual(['color default'])
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
  await $.turn.start({ text: 'a subagent', turnId: 'a-t1', agentId: 'a1' })
  await $.turn.complete({ ...answered, turnId: 'a-t1', agentId: 'a1' })
  await clock.advance(1000)
  expect(commands).toEqual([])
  await $.turn.complete(answered)
  await clock.advance(SETTLE)
  expect(commands).toEqual(['color green'])
})

test('a /color the engine refuses says so in a toast, and the model is told', async ($, on) => {
  const { commands, toasts, notes, clock } = engine(on, { color: 'fails' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'purple' })
  await $.turn.complete(answered)
  await clock.advance(SETTLE)
  expect(commands).toEqual(['color purple'])
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatch(/^\/color didn't run: .+/)
  expect(notes()).toMatch(/The prompt bar color change to purple you queued didn't run: .+[^.]\."/)
})

test("the model's note ends with one full stop: the engine's reason, which has none, gets one", async ($, on) => {
  const { toasts, notes, clock } = engine(on, { color: 'fails' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'blue' })
  await $.turn.complete(answered)
  await clock.advance(SETTLE)
  expect(toasts).toEqual(["/color didn't run: no implementation for command.run"])
  expect(notes()).toContain("The prompt bar color change to blue you queued didn't run: no implementation for command.run.\"")
})

test('the text rules: one full stop at most, one line, and a reason always', () => {
  expect(sentence('refused by policy')).toBe('refused by policy.')
  expect(sentence('refused by policy.')).toBe('refused by policy.')
  expect(sentence('refused?')).toBe('refused?')
  expect(sentence('refused!')).toBe('refused!')
  expect(oneLine('first line\n  second line\r\nthird')).toBe('first line second line third')
  expect(oneLine('one line')).toBe('one line')
  expect(text('  Session color set to: red \n')).toBe('Session color set to: red')
  expect(text('   ')).toBeUndefined()
  expect(text(undefined)).toBeUndefined()
  expect(why(new Error(' refused '))).toBe('refused')
  expect(why(new Error(''))).toBe('no reason given')
  expect(why('plain')).toBe('plain')
})

test("headless: /color's exact success line counts as set", async ($, on) => {
  const set = engine(on, { color: 'says', says: 'Session color set to: pink' })
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, color: 'pink' })
  await $.turn.complete(answered)
  await set.clock.advance(SETTLE)
  expect(set.toasts).toEqual(['Prompt bar color set to pink.'])
  expect(set.notes()).toBe('[]')
})

test("headless: /color's exact reset line counts as reset", async ($, on) => {
  const reset = engine(on, { color: 'says', says: 'Session color reset to default' })
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, color: 'default' })
  await $.turn.complete(answered)
  await reset.clock.advance(SETTLE)
  expect(reset.toasts).toEqual(['Prompt bar color reset to default.'])
  expect(reset.notes()).toBe('[]')
})

test("/color's own refusal (a teammate session), handed back, is shown in its words, and the model is told", async ($, on) => {
  const { commands, toasts, notes, clock } = engine(on, { color: 'says', says: TEAMMATE })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'orange' })
  await $.turn.complete(answered)
  await clock.advance(SETTLE)
  expect(commands).toEqual(['color orange'])
  expect(toasts).toEqual([`/color orange said: ${TEAMMATE}`])
  expect(notes()).toContain(`The prompt bar color change to orange you queued ran, and /color said: ${TEAMMATE}`)
})

test("a cloud session's warning is no clean success: the line is shown, on one line, and the model is told", async ($, on) => {
  const warned =
    "Session color set to: cyan on this screen only. It couldn't be saved to the cloud session, so it may not show elsewhere or after you leave.\n  Run /color cyan to try again."
  const { toasts, notes, clock } = engine(on, { color: 'says', says: warned })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'cyan' })
  await $.turn.complete(answered)
  await clock.advance(SETTLE)
  const line = "Session color set to: cyan on this screen only. It couldn't be saved to the cloud session, so it may not show elsewhere or after you leave. Run /color cyan to try again."
  expect(toasts).toEqual([`/color cyan said: ${line}`])
  expect(notes()).toContain(`The prompt bar color change to cyan you queued ran, and /color said: ${line}`)
})

test("another color's success line is no success for this one: only the exact line counts", async ($, on) => {
  const { toasts, clock } = engine(on, { color: 'says', says: 'Session color set to: red' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'blue' })
  await $.turn.complete(answered)
  await clock.advance(SETTLE)
  expect(toasts).toEqual(['/color blue said: Session color set to: red'])
})

test("a person's turn between the turn's end and the run: the color still changes, once, after that turn", async ($, on) => {
  const { commands, prompts, toasts, notes, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'yellow' })
  // Typed over t1, so it runs first, in a turn of its own.
  await $.prompt.submit({ text: "stop, don't do X", wait: false, origin: { kind: 'composer' }, turnId: 't1' })
  await $.turn.complete(answered)
  await $.turn.start({ text: "stop, don't do X", turnId: 't2' })
  await clock.advance(SETTLE * 4)
  // That turn runs: the change waits for its end.
  expect(commands).toEqual([])
  await $.turn.complete({ ...answered, turnId: 't2' })
  await clock.advance(SETTLE)
  expect(prompts).toEqual(["stop, don't do X"])
  expect(commands).toEqual(['color yellow'])
  expect(toasts).toEqual([RAN('yellow')])
  expect(notes()).toBe('[]')
})

test('a person typing while idle, after the turn ended and before the run: the color still changes', async ($, on) => {
  const { commands, toasts, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'blue' })
  await $.turn.complete(answered)
  await $.prompt.submit({ text: 'hold on', wait: false, origin: { kind: 'bridge' } })
  await clock.advance(SETTLE)
  expect(commands).toEqual(['color blue'])
  expect(toasts).toEqual([RAN('blue')])
})

test('a /resume the person typed during the turn runs first and moves the session: the change is dropped, with a toast', async ($, on) => {
  const w = engine(on)
  w.hold('resume')
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'red' })
  await $.turn.complete(answered)
  // The waiting /resume starts within the half second, and the change waits on it.
  const resumed = $.command.run({ command: 'resume', args: 'another-conversation', origin: { kind: 'composer' }, presentation })
  await w.clock.advance(SETTLE * 4)
  expect(w.commands).toEqual([])
  await $.classic.SessionStart({ source: 'resume' })
  w.end('resume')
  await resumed
  await w.clock.advance(SETTLE * 4)
  expect(w.commands).toEqual([])
  expect(w.toasts).toEqual([DROPPED])
  expect(w.statuses.at(-1)).toBeUndefined()

  // Nothing is left to run at a later turn's end.
  await $.turn.complete({ ...answered, turnId: 't2' })
  await w.clock.advance(SETTLE * 4)
  expect(w.commands).toEqual([])
})

test('a /clear that runs first drops it the same way', async ($, on) => {
  const w = engine(on)
  w.hold('clear')
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'green' })
  await $.turn.complete(answered)
  const cleared = $.command.run({ command: 'clear', args: '', origin: { kind: 'plugin', name: 'self-clear' }, presentation })
  await w.clock.advance(SETTLE)
  await $.classic.SessionStart({ source: 'clear' })
  w.end('clear')
  await cleared
  await w.clock.advance(SETTLE * 4)
  expect(w.commands).toEqual([])
  expect(w.toasts).toEqual([DROPPED])
})

test('a /resume that ends without moving (its picker closed): the change goes once it has ended', async ($, on) => {
  const w = engine(on)
  w.hold('resume')
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'purple' })
  await $.turn.complete(answered)
  const resumed = $.command.run({ command: 'resume', args: '', origin: { kind: 'composer' }, presentation })
  await w.clock.advance(SETTLE * 4)
  expect(w.commands).toEqual([])
  w.end('resume')
  await resumed
  await w.clock.advance(SETTLE)
  expect(w.commands).toEqual(['color purple'])
  expect(w.toasts).toEqual([RAN('purple')])
})

test('a SessionStart of a resume or a clear before the change runs drops it; a compact, a fork or a subagent\'s does not', async ($, on) => {
  const w = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'red' })
  await $.turn.complete(answered)
  await $.classic.SessionStart({ source: 'compact' })
  await $.classic.SessionStart({ source: 'fork' })
  await $.classic.SessionStart({ source: 'resume', agent_id: 'a1' })
  await w.clock.advance(SETTLE)
  expect(w.commands).toEqual(['color red'])

  await $.tool.call({ tool: TOOL, color: 'blue' })
  await $.turn.complete({ ...answered, turnId: 't2' })
  await $.classic.SessionStart({ source: 'resume' })
  await w.clock.advance(SETTLE * 4)
  expect(w.commands).toEqual(['color red'])
  expect(w.toasts).toEqual([RAN('red'), DROPPED])
})

test('a turn interrupted by the person (isAborted, reason answer) cancels the change, with a notice', async ($, on) => {
  const { commands, toasts, statuses, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'cyan' })
  await $.turn.complete({ ...answered, isAborted: true, reason: 'answer' })
  await clock.advance(SETTLE * 4)
  expect(commands).toEqual([])
  expect(toasts).toEqual(["Prompt bar color change cancelled: the turn didn't finish."])
  expect(statuses.at(-1)).toBeUndefined()

  // Nothing is left queued for the next turn's end.
  await $.turn.complete({ ...answered, turnId: 't2' })
  await clock.advance(SETTLE * 4)
  expect(commands).toEqual([])
})

test('a turn that ended on an error (not aborted, reason error) cancels the change, with a notice', async ($, on) => {
  const { commands, toasts, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'cyan' })
  await $.turn.complete({ ...answered, isAborted: false, reason: 'error' })
  await clock.advance(SETTLE * 4)
  expect(commands).toEqual([])
  expect(toasts).toEqual(["Prompt bar color change cancelled: the turn didn't finish."])
})

test('two calls in one turn: the last one is the color set', async ($, on) => {
  const { commands, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, color: 'red' })
  await $.tool.call({ tool: TOOL, color: 'blue' })
  await $.turn.complete(answered)
  await clock.advance(SETTLE)
  expect(commands).toEqual(['color blue'])
})

test('the description says what it does, when to use it, that it lasts for the session and that `default` resets it', async ($, on) => {
  const { registered } = engine(on)
  await $.session.start(start)
  expect(registered.at(-1)?.description).toBe(
    [
      "Sets this session's prompt bar color once the current turn ends, as /color does.",
      "Use it to mark the session's role, so the person can tell sessions apart at a glance: for example, one color for a coordinating session, another for workers.",
      'The color lasts for the session; `default` resets it.',
      "It runs once the session is idle, after anything already waiting, and a /resume or /clear that runs first drops it; you don't need to end your turn for it.",
    ].join(' '),
  )
})
