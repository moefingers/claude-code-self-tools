import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__self-reload__reload_plugins_after_turn'
const HOUR = 60 * 60 * 1000

/**
 * The engine beneath the plugin. `reload` is what the reload command does: return (it left this
 * module in place), hang (it replaced this module, whose continuation never comes back in time), or
 * be refused.
 */
function engine(on: On, { reload = 'returns' }: { reload?: 'returns' | 'hangs' | 'refused' | 'skips' } = {}) {
  const commands: string[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  /** Everything the plugin handed the engine, as JSON (the person's own prompts aside): where the no-leak test looks. */
  const seen: string[] = []
  /** The pending record as each write left it: what the next module would read. */
  const pendings: unknown[] = []
  /**
   * The person's prompts the test holds at the bottom (`hold`), by text, each entering or dropped when the test says, as
   * Claude Code holds one typed over a running turn until its own turn; and those it drops at once (`block`).
   */
  const plan = new Map<string, 'hold' | { drop: string }>()
  const held = new Map<string, (drop: string | undefined) => void>()
  const clock = mock.clock(on)
  const session = mock.session(on)
  on('state.set', (_, e, next) => {
    seen.push(JSON.stringify(e))
    if (e.key === 'pending') pendings.push(e.value)
    return next(e)
  })
  on('ui.log', (_, e) => (seen.push(JSON.stringify(e)), { value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => (registeredDescriptions.push(String(e.description)), { value: { tool: TOOL } }))
  on('ui.status', (_, e) => (seen.push(JSON.stringify(e)), { value: undefined }))
  on('ui.toast', (_, e) => {
    seen.push(JSON.stringify(e))
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('prompt.submit', async (_, e) => {
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!isPerson) seen.push(JSON.stringify(e))
    const planned = isPerson ? plan.get(e.text) : undefined
    if (planned === 'hold') {
      const drop = await new Promise<string | undefined>(resolve => held.set(e.text, resolve))
      if (drop !== undefined) return { drop }
    } else if (planned !== undefined) return { drop: planned.drop }
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('command.run', async (_, e, next) => {
    seen.push(JSON.stringify(e))
    commands.push(e.command)
    if (reload === 'refused') return next(e)
    if (reload === 'hangs') await clock.sleep(HOUR)
    if (reload === 'skips') {
      return {
        text: 'Reloading would change the MCP tools, so your next message will re-read the whole conversation instead of using the cache. Run /reload-plugins --force to apply.',
      }
    }
    return { text: 'Reloaded 3 plugins.' }
  })
  /** Lets a held prompt enter, or drops it with `why`; the test then awaits its submit, the clock still. */
  const release = (text: string, why?: string) => {
    held.get(text)?.(why)
    held.delete(text)
  }
  return {
    commands,
    prompts,
    toasts,
    clock,
    session,
    seen,
    pendings,
    hold: (text: string) => void plan.set(text, 'hold'),
    block: (text: string, why: string) => void plan.set(text, { drop: why }),
    enter: (text: string) => release(text),
    drop: (text: string, why: string) => release(text, why),
  }
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as const

/** Every description the plugin registered its tool with. */
const registeredDescriptions: string[] = []

/** A prompt the person typed at the terminal (or, `bridge`, from the app): over the running turn `over`, else while idle. */
const typed = (text: string, over?: string, kind: 'composer' | 'bridge' = 'composer') => ({ text, wait: false, origin: { kind }, ...(over === undefined ? {} : { turnId: over }) })

const STALE_TOAST = 'Resume not sent: your message came after the reload was queued, so the model has it as a note.'
const STALE_NOTE = "The person's message came after the reload was queued, so its resume wasn't sent as a new message. It was: "

test('the reload runs once the turn ends, and the resume is sent once', async ($, on) => {
  const { commands, prompts, clock } = engine(on)
  await $.session.start(start)

  const queued = await $.tool.call({ tool: TOOL, resume: ' Try the edited tool. ' })
  expect(queued.deny).toBeUndefined()
  expect(commands).toEqual([])

  await $.turn.complete(answered)
  expect(commands).toEqual([])
  await clock.advance(1000)
  expect(commands).toEqual(['reload-plugins'])
  expect(prompts).toEqual(['Plugins reloaded. Resume: Try the edited tool.'])

  // A later start, and a later turn's end, send and run nothing more.
  await $.session.start(start)
  await $.turn.complete({ ...answered, turnId: 't2' })
  await clock.advance(1000)
  expect(commands).toEqual(['reload-plugins'])
  expect(prompts).toHaveLength(1)
})

test('a module the reload started sends the resume from its start, and only once', async ($, on) => {
  const { commands, prompts, clock } = engine(on, { reload: 'hangs' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, resume: 'Run the new tool once.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual(['reload-plugins'])
  expect(prompts).toEqual([])

  // The reloaded module starts: it finds the resume in $.state and sends it.
  await $.session.start(start)
  await clock.settle()
  expect(prompts).toEqual(['Plugins reloaded. Resume: Run the new tool once.'])

  // Another start, and the old module's command coming back at last, send nothing more.
  await $.session.start(start)
  await clock.advance(HOUR)
  expect(prompts).toHaveLength(1)
})

test('without resume, a reload sends nothing and the session waits', async ($, on) => {
  const { commands, prompts, toasts, clock } = engine(on)
  await $.session.start(start)

  const queued = await $.tool.call({ tool: TOOL })
  expect(queued.result).toMatch(/waits for the next message/)
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual(['reload-plugins'])
  expect(prompts).toEqual([])
  expect(toasts.some(t => /Plugins reloaded/.test(t))).toBe(true)
})

test('a refused reload is told to the person, and the resume says it did not run', async ($, on) => {
  const { prompts, toasts, clock } = engine(on, { reload: 'refused' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, resume: 'Go on.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(toasts.some(t => /didn't run/.test(t))).toBe(true)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toMatch(/^Plugin reload didn't run \(.+\)\. Resume: Go on\.$/)
})

test('a reload the command skips is not called a reload', async ($, on) => {
  const { prompts, toasts, clock } = engine(on, { reload: 'skips' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, resume: 'Go on.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(toasts.some(t => t.startsWith('Plugin reload skipped:'))).toBe(true)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toMatch(/^Plugin reload was skipped \(.+--force to apply\.\)\. Resume: Go on\.$/)
})

test('a refused reload with no resume is told to the model in a note', async ($, on) => {
  const { prompts, clock, session } = engine(on, { reload: 'refused' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(prompts).toEqual([])
  expect(JSON.stringify(session.appended())).toMatch(/reload you queued didn't run/)
})

test('an interrupted turn cancels the reload and its resume', async ($, on) => {
  const { commands, prompts, toasts, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, resume: 'Go on.' })
  await $.turn.complete({ ...answered, isAborted: true, reason: 'aborted' })
  await clock.advance(1000)
  expect(commands).toEqual([])
  expect(prompts).toEqual([])
  expect(toasts.some(t => /cancelled/.test(t))).toBe(true)
})

test('a subagent is refused, and nothing is queued', async ($, on) => {
  const { commands, clock } = engine(on)
  await $.session.start(start)

  const refused = await $.tool.call({ tool: TOOL, resume: 'Go on.', agentId: 'a1' })
  expect(refused.deny).toMatch(/subagent/)
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
})

test('a resume left pending too long is dropped, not sent', async ($, on) => {
  const { prompts, toasts, clock } = engine(on, { reload: 'hangs' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, resume: 'Go on.' })
  await $.turn.complete(answered)
  await clock.advance(11 * 60 * 1000)
  await $.session.start(start)
  await clock.settle()
  expect(prompts).toEqual([])
  expect(toasts.some(t => /dropped/.test(t))).toBe(true)
  await clock.advance(HOUR)
  expect(prompts).toEqual([])
})

test("the owner's design: the description says the tool runs only when the session is idle, why, and warns of the distant future", async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const said = registeredDescriptions.at(-1) ?? ''
  expect(said).toContain("It runs when the session is idle: Claude Code queues a plugin's command behind anything already waiting (a message typed during this turn, a background task's notification) and has no slot between turns ahead of them, so under a nonstop stream of work and notifications it may run in the distant future. Nothing waiting is lost.")
})

test("the owner's A: the step starts the moment the turn's end returns, with no half-second beat", async ($, on) => {
  const { commands, clock } = engine(on)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL })
  await $.turn.complete(answered)
  expect(commands).toEqual([])
  await clock.advance(1)
  expect(commands).toHaveLength(1)
})

test("the owner's note: the description says to end the turn and do nothing more until it has run", async ($, on) => {
  engine(on)
  await $.session.start(start)
  expect(registeredDescriptions.at(-1) ?? '').toContain("After calling it, end your turn and do nothing more until it has run; then carry on.")
})

test("the person's turn after the reload was queued, before it ran: the reload runs, and its resume goes to the model as a note, never as a turn", async ($, on) => {
  const { commands, prompts, toasts, session, clock } = engine(on)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, resume: 'Carry on with X.' })
  // The person types during the turn ("stop, don't do X"), over t1: it waits, and its turn runs first.
  await $.prompt.submit(typed("stop, don't do X", 't1'))
  await $.turn.complete(answered)
  await $.turn.start({ text: "stop, don't do X", turnId: 't2' })
  await $.turn.complete({ ...answered, turnId: 't2' })
  await clock.advance(1000)
  expect(commands).toEqual(['reload-plugins'])
  expect(prompts.some(p => p.includes('Carry on with X.'))).toBe(false)
  expect(toasts).toContain(STALE_TOAST)
  expect(JSON.stringify(session.appended())).toContain(`${STALE_NOTE}Carry on with X.`)
})

test("a task's notification turn first, not the person's: the resume still goes as a new message", async ($, on) => {
  const { commands, prompts, session, clock } = engine(on)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, resume: 'Run the tests.' })
  await $.turn.complete(answered)
  const note = '<task-notification>The tests finished: 3 failed.</task-notification>'
  await $.prompt.submit({ text: note, wait: false, origin: { kind: 'task-notification' } })
  await $.turn.start({ text: note, turnId: 't2' })
  await $.turn.complete({ ...answered, turnId: 't2' })
  await clock.advance(1000)
  expect(commands).toEqual(['reload-plugins'])
  expect(prompts).toEqual([note, 'Plugins reloaded. Resume: Run the tests.'])
  expect(JSON.stringify(session.appended())).not.toContain("wasn't sent as a new message")
})

// The person's message, by turn id: no prompt text is held. The turn a prompt was typed over ends before that
// prompt's own next(e) resolves, so these hold the person's prompt at the bottom, as Claude Code does, until its turn.

test("the person types mid-turn and the model arms at that turn's end: the pending record is marked, and the resume is a note", async ($, on) => {
  const w = engine(on)
  w.hold('do Y instead')
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, resume: 'Carry on with X.' })
  const sent = $.prompt.submit(typed('do Y instead', 't1'))
  await w.clock.settle()
  await $.turn.complete(answered)
  // The arm is marked here at once; the record, which the module the reload starts reads, by the prompt's turn's start.
  expect(w.pendings).toEqual([{ resume: 'Carry on with X.', at: expect.any(Number) }])
  w.enter('do Y instead')
  await sent
  await $.turn.start({ text: 'do Y instead', turnId: 't2' })
  expect(w.pendings.at(-1)).toEqual({ resume: 'Carry on with X.', at: expect.any(Number), turnSince: true })
  await $.turn.complete({ ...answered, turnId: 't2' })
  await w.clock.advance(1000)
  expect(w.prompts).toEqual(['do Y instead'])
  expect(w.toasts).toContain(STALE_TOAST)
  expect(JSON.stringify(w.session.appended())).toContain(`${STALE_NOTE}Carry on with X.`)
})

test('the mark survives the reload: the module it starts sends the resume as a note', async ($, on) => {
  const w = engine(on, { reload: 'hangs' })
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, resume: 'Run the new tool once.' })
  await $.turn.complete(answered)
  await $.prompt.submit(typed('wait, not yet', undefined, 'bridge'))
  await w.clock.advance(1000)
  expect(w.commands).toEqual(['reload-plugins'])
  await $.session.start(start)
  await w.clock.settle()
  expect(w.prompts).toEqual(['wait, not yet'])
  expect(w.toasts).toContain(STALE_TOAST)
  expect(JSON.stringify(w.session.appended())).toContain(`${STALE_NOTE}Run the new tool once.`)
})

test("another plugin's resume runs first, not the person's: the resume still goes as a new message", async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, resume: 'Run the tests.' })
  await $.turn.complete(answered)
  const woke = 'The self-wake plugin sent a message: check the deploy.'
  await $.prompt.submit({ text: woke, wait: false, origin: { kind: 'plugin', name: 'self-wake' } })
  await $.turn.start({ text: woke, turnId: 't2' })
  await $.turn.complete({ ...answered, turnId: 't2' })
  await w.clock.advance(1000)
  expect(w.prompts.filter(p => p.includes('Run the tests.'))).toHaveLength(1)
  expect(w.toasts).not.toContain(STALE_TOAST)
})

test('the person types while idle after the arm, before the reload reports: the record is marked, and the resume is a note', async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, resume: 'Carry on with X.' })
  await $.turn.complete(answered)
  await $.prompt.submit(typed('hold on'))
  expect(w.pendings.at(-1)).toEqual({ resume: 'Carry on with X.', at: expect.any(Number), turnSince: true })
  await w.clock.advance(1000)
  expect(w.prompts.some(p => p.includes('Carry on with X.'))).toBe(false)
  expect(JSON.stringify(w.session.appended())).toContain(`${STALE_NOTE}Carry on with X.`)
})

test("a dropped person's prompt leaves no mark: the record is never marked, and the resume goes as a new message", async ($, on) => {
  const w = engine(on)
  w.hold('blocked one')
  w.block('blocked two', 'a UserPromptSubmit hook blocked it')
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, resume: 'First resume.' })
  const sent = $.prompt.submit(typed('blocked one', 't1'))
  await w.clock.settle()
  await $.turn.complete(answered)
  w.drop('blocked one', 'a UserPromptSubmit hook blocked it')
  expect((await sent).drop).toBe('a UserPromptSubmit hook blocked it')
  expect(w.pendings).toEqual([{ resume: 'First resume.', at: expect.any(Number) }])
  await w.clock.advance(1000)
  expect(w.prompts).toEqual(['Plugins reloaded. Resume: First resume.'])

  await $.tool.call({ tool: TOOL, resume: 'Second resume.' })
  await $.turn.complete({ ...answered, turnId: 't3' })
  expect((await $.prompt.submit(typed('blocked two'))).drop).toBe('a UserPromptSubmit hook blocked it')
  await w.clock.advance(1000)
  expect(w.prompts.filter(p => p.includes('Second resume.'))).toHaveLength(1)
  expect(w.toasts).not.toContain(STALE_TOAST)
})

test("a dropped prompt takes back only its own mark: another person's prompt that entered marks the record", async ($, on) => {
  const w = engine(on)
  w.hold('first')
  w.hold('second')
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, resume: 'Carry on with X.' })
  const one = $.prompt.submit(typed('first', 't1'))
  const two = $.prompt.submit(typed('second', 't1'))
  await w.clock.settle()
  await $.turn.complete(answered)
  w.enter('first')
  w.drop('second', 'blocked')
  await one
  await two
  await $.turn.start({ text: 'first', turnId: 't2' })
  expect(w.pendings.at(-1)).toEqual({ resume: 'Carry on with X.', at: expect.any(Number), turnSince: true })
  await w.clock.advance(1000)
  expect(w.prompts.some(p => p.includes('Carry on with X.'))).toBe(false)
  expect(w.toasts).toContain(STALE_TOAST)
})

test('a prompt typed over the arm\'s turn and still in flight when the reload reports counts here: the resume is a note', async ($, on) => {
  const w = engine(on)
  w.hold('one more thing')
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, resume: 'Carry on with X.' })
  const sent = $.prompt.submit(typed('one more thing', 't1'))
  await w.clock.settle()
  await $.turn.complete(answered)
  await w.clock.advance(1000)
  expect(w.commands).toEqual(['reload-plugins'])
  expect(w.prompts.some(p => p.includes('Carry on with X.'))).toBe(false)
  expect(w.toasts).toContain(STALE_TOAST)
  w.enter('one more thing')
  await sent
})

test("a slash command typed mid-turn is the person's message too: the resume is a note", async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, resume: 'Carry on with X.' })
  await $.prompt.submit({ ...typed('/review the diff', 't1'), command: { name: 'review', args: 'the diff' } })
  await $.turn.complete(answered)
  await w.clock.advance(1000)
  expect(w.prompts.some(p => p.includes('Carry on with X.'))).toBe(false)
  expect(w.toasts).toContain(STALE_TOAST)
})

test('two prompts queued over one turn and batched into the next leave nothing behind to mark a later arm', async ($, on) => {
  const w = engine(on)
  w.hold('first')
  w.hold('second')
  await $.session.start(start)
  const one = $.prompt.submit(typed('first', 't0'))
  const two = $.prompt.submit(typed('second', 't0'))
  await w.clock.settle()
  await $.turn.complete({ ...answered, turnId: 't0' })
  w.enter('first')
  w.enter('second')
  await one
  await two
  await $.turn.start({ text: 'first\nsecond', turnId: 't1' })
  await $.tool.call({ tool: TOOL, resume: 'Carry on with X.' })
  await $.turn.complete(answered)
  await w.clock.advance(1000)
  expect(w.prompts.filter(p => p.includes('Carry on with X.'))).toHaveLength(1)
  expect(w.toasts).not.toContain(STALE_TOAST)
})

test("the review's case: an earlier short reply ('y') never marks a later, unrelated arm", async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await $.prompt.submit(typed('y', 't0'))
  await $.turn.complete({ ...answered, turnId: 't0' })
  await $.turn.start({ text: 'go on with the deploy', turnId: 't1' })
  await $.tool.call({ tool: TOOL, resume: 'Retry the deploy.' })
  await $.turn.complete(answered)
  const note = '<task-notification>yes: the build finished, and every test passed.</task-notification>'
  await $.prompt.submit({ text: note, wait: false, origin: { kind: 'task-notification' } })
  await $.turn.start({ text: note, turnId: 't2' })
  await $.turn.complete({ ...answered, turnId: 't2' })
  await w.clock.advance(1000)
  expect(w.prompts.filter(p => p.includes('Retry the deploy.'))).toHaveLength(1)
  expect(w.toasts).not.toContain(STALE_TOAST)
})

test("the turns a prompt was typed over are all forgotten at each main-loop turn end; a subagent's turn end forgets none", async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await $.prompt.submit(typed('first', 'tX'))
  await $.turn.complete(answered)
  await $.tool.call({ tool: TOOL, resume: 'First resume.' })
  await $.turn.complete({ ...answered, turnId: 'tX' })
  await w.clock.advance(1000)
  expect(w.prompts.filter(p => p.includes('First resume.'))).toHaveLength(1)

  await $.tool.call({ tool: TOOL, resume: 'Second resume.' })
  await $.prompt.submit(typed('second', 't3'))
  await $.turn.complete({ ...answered, turnId: 'a-t1', agentId: 'a1' })
  await $.turn.complete({ ...answered, turnId: 't3' })
  await w.clock.advance(1000)
  expect(w.prompts.some(p => p.includes('Second resume.'))).toBe(false)
  expect(w.toasts).toContain(STALE_TOAST)
})

/** A marker no file holds: 16 random bytes, made as the test runs. */
function marker(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return `marker-${[...bytes].map(b => b.toString(16).padStart(2, '0')).join('')}`
}

test("no prompt text is kept: the person's words reach no state, toast, note, log line or command", async ($, on) => {
  const w = engine(on, { reload: 'hangs' })
  const words = marker()
  const dropped = marker()
  expect(words).not.toBe(dropped)
  w.hold(words)
  w.hold(dropped)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, resume: 'Carry on with X.' })
  const sent = $.prompt.submit(typed(words, 't1'))
  const blocked = $.prompt.submit(typed(dropped, 't1', 'bridge'))
  await w.clock.settle()
  await $.turn.complete(answered)
  w.enter(words)
  w.drop(dropped, 'blocked')
  await sent
  await blocked
  await $.turn.start({ text: words, turnId: 't2' })
  await $.turn.complete({ ...answered, turnId: 't2' })
  await w.clock.advance(1000)
  // The reload started its module: the mark it read, and the note it gave.
  await $.session.start(start)
  await w.clock.settle()
  expect(w.toasts).toContain(STALE_TOAST)
  expect(w.pendings.length).toBeGreaterThanOrEqual(2)
  const everything = [...w.seen, ...w.toasts, ...w.commands, JSON.stringify(w.pendings), JSON.stringify(w.session.appended())].join('\n')
  expect(everything).not.toContain(words)
  expect(everything).not.toContain(dropped)
})
