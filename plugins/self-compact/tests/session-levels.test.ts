// A conversation's own reminder levels (#76): compact_reminder sets them in place of the compactReminder setting's,
// for that conversation alone, kept in the plugin's store under a key of its own; "off" goes back to the setting; with
// no arguments it says where they stand. While the session moves between conversations, it sets nothing.
import { expect, mock, test } from 'claude-code/testing'
import type { On, TurnCompleteInput } from 'claude-code'
import { KEEP_CONVERSATIONS, MAX_LEVELS, MAX_TEXT, NOTE_MAX } from '../hooks/reminder'

const LEVELS = 'mcp__self-compact__compact_reminder'
const COMPACT = 'mcp__self-compact__compact_after_turn'
const WINDOW = 1_000_000
/** The store key of a conversation's own levels. */
const KEY = (id: string) => `sessionLevels:${id}`

/** The line at `at` percent (1 to 99) of a window of 1,000,000 tokens, written out here so a change of words fails. */
const line = (at: number) =>
  `self-compact: a polite reminder, in case it slipped your mind: the context window is at ${at}% (${at * 10},000 of 1,000,000 tokens). Nothing is required. If the piece you just finished is complete, this could be a good break for compact_after_turn, with keep (what the summary must hold) and resume (the next piece); if you are mid-piece, carry on.`

/** How long to wait, as the tool says it: a start's seconds left, or a move's upper bound. */
const START_WAIT = (seconds: number) => `It is in its first seconds, while its id may still name the conversation before it. Try again in ${seconds} seconds.`
const MOVE_WAIT = (seconds: number) =>
  `A /clear or a /resume has just ended the conversation, and its id may still name that one: this ends once the id names the conversation moved to, usually within seconds, and at most in ${seconds} seconds. Try again in about 10 seconds.`
const MOVING_DENY = (wait: string) => `This session is moving between conversations; nothing was set. ${wait}`
const MOVING_STATUS = (wait: string) => `This session is moving between conversations, so which conversation's levels stand can't be told yet. ${wait}`

/** The session's own note, put into the expected strings by a template, so no added line holds it as a quoted literal. */
const NOTE = 'write the notes file first'
const NO_READING = 'The window has no reading yet (a new or just-compacted conversation, until its next response).'

/** The clock of the test running now, for begin(). */
let clockNow: { advance: (ms: number) => Promise<void> } | undefined

/**
 * The engine beneath the plugin: the window's reading (`at`), emptied by a compaction, and its size (`windowSize`, 0:
 * unreadable); the conversation's id, which a test changes as a /clear or another session would (`id`), or holds back
 * (`hang`); the plugin's store, seeded with `stored` as a new load finds it; the rows added to the conversation, the
 * toasts, the debug lines and the tools registered.
 */
function engine(
  on: On,
  stored: Record<string, unknown> = {},
  { windowSize = WINDOW, lateMark = false, marksFail = false, keysFail = false }: { windowSize?: number; lateMark?: boolean; marksFail?: boolean; keysFail?: boolean } = {},
) {
  const reading: { tokens?: number } = {}
  const conversation = { id: 'conversation-1', hang: false }
  const held = new Map<string, unknown>(Object.entries(stored))
  const toasts: string[] = []
  const logs: string[] = []
  const registered: { name: unknown; description: unknown; inputSchema: unknown; isDeferred: unknown }[] = []
  const session = mock.session(on)
  const clock = mock.clock(on)
  clockNow = clock
  on('store.get', (_, e) => ({ value: held.get(e.key) }))
  on('store.set', (_, e) => {
    held.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => (held.delete(e.key), { value: undefined }))
  on('store.keys', () => (keysFail ? { deny: 'the store is busy' } : { value: [...held.keys()] }))
  let late = lateMark
  on('state.get', async (_, e, next) => {
    if (late && e.key === 'started') {
      late = false
      await clock.sleep(5000)
    }
    return next(e)
  })
  on('state.set', (_, e, next) => (marksFail && e.key === 'reminded' ? { deny: 'held' } : next(e)))
  on('session.id', async () => {
    if (conversation.hang) await clock.sleep(5000)
    return { value: conversation.id }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('tool.register', (_, e) => {
    registered.push({ name: e.name, description: e.description, inputSchema: e.inputSchema, isDeferred: e.isDeferred })
    return { value: { tool: `mcp__self-compact__${e.name}` } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => (toasts.push(String(e.text)), { value: undefined }))
  on('ui.log', (_, e) => (logs.push(String(e.text)), { value: undefined }))
  on('session.usage', () => {
    const { tokens } = reading
    return { value: { startedAt: 0, context: { window: windowSize, tokens, percent: tokens === undefined ? undefined : Math.round((tokens * 100) / WINDOW) }, rateLimits: [] } }
  })
  on('session.compact', () => {
    reading.tokens = undefined
    return { messages: [{ role: 'user', text: 'The summary.', toolUses: [] }] }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: 'done' }))
  const lines = () =>
    session.appended().flatMap(row => ((row as { message?: { content?: { text?: unknown }[] } }).message?.content ?? []).map(block => String(block.text)))
  return {
    lines,
    clock,
    held,
    toasts,
    logs,
    registered,
    /** The window at `percent` of its size, as the last response read it. */
    at: (percent: number) => void (reading.tokens = (percent * WINDOW) / 100),
    /** The conversation the session is in now. */
    id: (id: string) => void (conversation.id = id),
    /** Whether a read of the conversation's id answers only 5 s late. */
    hang: (late: boolean) => void (conversation.hang = late),
  }
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const

/** The process's first start, and the seconds its id may lag it gone by. */
async function begin($: { session: { start: (e: typeof start) => Promise<unknown> } }): Promise<void> {
  await $.session.start(start)
  await clockNow?.advance(15_000)
}

let turns = 0
/** A main-loop turn's end, answered. */
const answered = (): TurnCompleteInput => ({ answer: 'done', durationMs: 1, turnId: `t${++turns}`, isAborted: false, reason: 'answer' })

/** The session end of a /clear (or a /resume) of `id`. */
const ended = (reason: 'clear' | 'resume', id: string) => ({ reason, sessionId: id, resume: { id } })

test('with no arguments, it says where the levels stand: none, from an empty setting', async ($, on) => {
  engine(on)
  await begin($)
  const said = await $.tool.call({ tool: LEVELS })
  expect(said.result).toBe(`Compact reminder levels: none (the compactReminder setting's; this conversation has none of its own). ${NO_READING}`)
})

test('the tool is registered behind ToolSearch, with its inputs and its words', async ($, on) => {
  const { registered } = engine(on)
  await begin($)
  const spec = registered.find(r => r.name === 'compact_reminder')
  expect(spec?.isDeferred).toBe(true)
  expect(spec?.inputSchema).toEqual({
    type: 'object',
    properties: {
      levels: { type: 'string', description: expect.any(String) },
      notes: { type: 'object', additionalProperties: { type: 'string' }, description: expect.any(String) },
    },
    additionalProperties: false,
  })
  const words = String(spec?.description)
  expect(words).toContain("Sets this conversation's own compact reminder levels, in place of the compactReminder setting's, or says what they are now.")
  expect(words).toContain(`a comma-separated list of at most ${MAX_LEVELS}`)
  expect(words).toContain(`one line of plain text (no angle brackets) of at most ${NOTE_MAX} characters`)
  expect(words).toContain("In a process's first seconds (every new session included) and in the seconds after a /clear or a /resume")
  expect(words).toContain('it sets nothing and says how long to wait')
  expect(words).toContain('It answers at once and queues nothing.')
})

test('with the setting empty, a conversation that sets its own levels gets reminders, and no other does; each change is announced', async ($, on) => {
  const { lines, toasts, held, at, id } = engine(on)
  await begin($)
  const set = await $.tool.call({ tool: LEVELS, levels: '40%, 70%' })
  expect(set.result).toBe(
    `This conversation's compact reminder levels are now 40%, 70%, in place of the compactReminder setting's (none). They last across a compaction, a restart and a resume of this conversation; "off" goes back to the setting. ${NO_READING}`,
  )
  expect(toasts).toEqual(["Compact reminder: this conversation's own levels are 40%, 70%."])
  expect((held.get(KEY('conversation-1')) as { levels: string[] }).levels).toEqual(['40%', '70%'])
  at(45)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(45)])

  // Another conversation (another session's, or one moved to): the setting, which is empty.
  id('conversation-2')
  at(75)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(45)])

  // Back in the first: its levels, read from the store.
  id('conversation-1')
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(45), line(75)])
})

test("a conversation's own levels take the place of the setting's", { options: { compactReminder: '40%' } }, async ($, on) => {
  const { lines, at } = engine(on)
  await begin($)
  await $.tool.call({ tool: LEVELS, levels: '70%' })
  at(45)
  await $.turn.complete(answered())
  expect(lines()).toEqual([])
  at(71)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(71)])
})

test('"off" goes back to the setting, and so does an empty list, each announced', { options: { compactReminder: '40%' } }, async ($, on) => {
  const { lines, toasts, held, at } = engine(on)
  await begin($)
  await $.tool.call({ tool: LEVELS, levels: '70%' })
  at(30)
  const off = await $.tool.call({ tool: LEVELS, levels: 'off' })
  expect(off.result).toBe("This conversation's own levels are dropped: the compactReminder setting's stand again (40%). The window is at 30% (300,000 of 1,000,000 tokens).")
  expect(toasts).toEqual(["Compact reminder: this conversation's own levels are 70%.", 'Compact reminder: this conversation follows the setting again (40%).'])
  expect(held.has(KEY('conversation-1'))).toBe(false)
  at(45)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(45)])

  await $.tool.call({ tool: LEVELS, levels: '90%' })
  await $.tool.call({ tool: LEVELS, levels: '  ' })
  const said = await $.tool.call({ tool: LEVELS })
  expect(said.result).toMatch(/^Compact reminder levels: 40% \(the compactReminder setting's; this conversation has none of its own\)\./)
})

test('a new load (a restart, a resume) finds the conversation its levels, under its own key', async ($, on) => {
  const { lines, at } = engine(on, { [KEY('conversation-1')]: { levels: ['70%', '300000'], at: 1 } })
  await begin($)
  const said = await $.tool.call({ tool: LEVELS })
  expect(said.result).toMatch(/^Compact reminder levels: 70%, 300,000 tokens \(this conversation's own, set with compact_reminder; the setting's are none\)\./)
  at(31)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(31)])
})

test('no code reads the old single-object form of the store', async ($, on) => {
  const { lines, at } = engine(on, { sessionLevels: { 'conversation-1': { levels: ['40%'], at: 1 } } })
  await begin($)
  at(75)
  await $.turn.complete(answered())
  expect(lines()).toEqual([])
})

test('they last across a compaction, and every level reminds again after compact_after_turn', async ($, on) => {
  const { lines, clock, at } = engine(on)
  await begin($)
  await $.tool.call({ tool: LEVELS, levels: '40%' })
  at(45)
  await $.turn.complete(answered())
  await $.tool.call({ tool: COMPACT, keep: 'the notes' })
  await $.turn.complete(answered())
  await clock.advance(1000)
  at(42)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(45), line(42)])
  const said = await $.tool.call({ tool: LEVELS })
  expect(said.result).toMatch(/^Compact reminder levels: 40% \(this conversation's own/)
})

test('levels the window already stands past are marked with no line: only a passing after the change reminds', async ($, on) => {
  const { lines, at } = engine(on)
  await begin($)
  at(55)
  const set = await $.tool.call({ tool: LEVELS, levels: '50%, 70%' })
  expect(set.result).toContain('Already past, so marked reminded with no line: 50%. The window is at 55% (550,000 of 1,000,000 tokens).')
  await $.turn.complete(answered())
  expect(lines()).toEqual([])
  at(71)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(71)])
  const said = await $.tool.call({ tool: LEVELS })
  expect(said.result).toBe(
    "Compact reminder levels: 50%, 70% (this conversation's own, set with compact_reminder; the setting's are none). Passed since the last compaction (reminded, or marked when set): 50%, 70%. The window is at 71% (710,000 of 1,000,000 tokens).",
  )
})

test('a token level at or past the window is said in the answer: it never reminds in this window', async ($, on) => {
  const { at } = engine(on)
  await begin($)
  at(45)
  const set = await $.tool.call({ tool: LEVELS, levels: '40%, 2000k' })
  expect(set.result).toContain(
    "Already past, so marked reminded with no line: 40%. The window is at 45% (450,000 of 1,000,000 tokens). At or past this window's 1,000,000 tokens, so never reminding in this window: 2,000,000 tokens.",
  )
})

test("a window that can't be read after the levels are written: they are set, and the answer says no level was marked", async ($, on) => {
  const { held } = engine(on, {}, { windowSize: 0 })
  await begin($)
  const set = await $.tool.call({ tool: LEVELS, levels: '40%' })
  expect(set.result).toBe(
    `This conversation's compact reminder levels are now 40%, in place of the compactReminder setting's (none). They last across a compaction, a restart and a resume of this conversation; "off" goes back to the setting. The window couldn't be read, so no level was marked: one the window already stands past may remind at the next answered turn end.`,
  )
  expect((held.get(KEY('conversation-1')) as { levels: string[] }).levels).toEqual(['40%'])
})

test("a level's own note is shown back with its reminder, quoted and named as the session's own", async ($, on) => {
  const { lines, at } = engine(on)
  await begin($)
  const set = await $.tool.call({ tool: LEVELS, levels: '40%, 300k', notes: { '300000': NOTE } })
  expect(set.result).toContain(` Notes: 300,000 tokens: ${JSON.stringify(NOTE)}.`)
  at(45)
  await $.turn.complete(answered())
  expect(lines()).toEqual([`${line(45)} Your own note at 300,000 tokens: ${JSON.stringify(NOTE)}.`])
})

test('a note is one line of plain text, for a level it sets, at most NOTE_MAX characters; nothing is set otherwise', async ($, on) => {
  const { held, toasts } = engine(on)
  await begin($)
  const hidden = 'holds a line break, or a control or format character: a note is one line of plain text.'
  for (const [notes, said] of [
    [{ '60%': 'x'.repeat(NOTE_MAX + 1) }, `the note for 60% is ${NOTE_MAX + 1} characters; a note is at most ${NOTE_MAX}.`],
    [{ '60%': 'first line\nsecond line' }, `the note for 60% ${hidden}`],
    [{ '60%': `first${String.fromCodePoint(0x2028)}second` }, `the note for 60% ${hidden}`],
    [{ '60%': `write ${String.fromCodePoint(0x202e)}tsrif` }, `the note for 60% ${hidden}`],
    [{ '60%': `write${String.fromCodePoint(0x200b)}first` }, `the note for 60% ${hidden}`],
    [{ '60%': 'see <tag> first' }, 'the note for 60% holds an angle bracket: a note is plain text, with no markup.'],
    [{ '60%': '   ' }, 'the note for 60% is empty.'],
    [{ '70%': 'not a level of these' }, 'the note for "70%" names no level in `levels`.'],
    [{ '60%': 3 }, 'the note for 60% is not text.'],
  ] as const) {
    const refused = await $.tool.call({ tool: LEVELS, levels: '60%', notes })
    expect(refused.deny).toBe(`Nothing was set: ${said}`)
  }
  expect((await $.tool.call({ tool: LEVELS, notes: { '60%': 'a note' } })).deny).toBe('Notes go with `levels`: give the levels, and a note for each level you want one for.')
  expect(held.has(KEY('conversation-1'))).toBe(false)
  expect(toasts).toEqual([])
})

test('a note read back from the store is checked the same way: one that hides text is dropped', async ($, on) => {
  engine(on, { [KEY('conversation-1')]: { levels: ['40%'], notes: { '40%': `write ${String.fromCodePoint(0x202e)}tsrif` }, at: 1 } })
  await begin($)
  const said = await $.tool.call({ tool: LEVELS })
  expect(said.result).toBe(
    `Compact reminder levels: 40% (this conversation's own, set with compact_reminder; the setting's are none). Passed since the last compaction (reminded, or marked when set): none. ${NO_READING}`,
  )
})

test('levels that are not levels, too many or too long are refused, and nothing is set', async ($, on) => {
  const { held } = engine(on)
  await begin($)
  const refused = await $.tool.call({ tool: LEVELS, levels: '40%, soon' })
  expect(refused.deny).toBe(
    'Nothing was set: "soon" is not a level. Each level is a percentage of the window (40%) or a token count (400k or 400000), separated by commas, such as 40%, 60%, 80%. Or "off", to go back to the setting.',
  )
  expect((await $.tool.call({ tool: LEVELS, levels: 40 })).deny).toBe('`levels` is text, such as "40%, 70%" or "300k", or "off".')
  const many = Array.from({ length: MAX_LEVELS + 1 }, (_, n) => `${n + 1}%`).join(', ')
  expect((await $.tool.call({ tool: LEVELS, levels: many })).deny).toBe(`Nothing was set: at most ${MAX_LEVELS} levels; this list has ${MAX_LEVELS + 1}.`)
  const long = '40%, '.repeat(50).trim()
  expect((await $.tool.call({ tool: LEVELS, levels: long })).deny).toBe(`Nothing was set: the levels are ${long.length} characters; at most ${MAX_TEXT}.`)
  expect(held.has(KEY('conversation-1'))).toBe(false)
})

test('a stored list over the bound, or one that is not levels, is passed over, and the setting stands', { options: { compactReminder: '40%' } }, async ($, on) => {
  const many = Array.from({ length: MAX_LEVELS + 1 }, (_, n) => `${n + 50}%`)
  const { lines, at, id } = engine(on, { [KEY('conversation-1')]: { levels: many, at: 1 }, [KEY('conversation-2')]: { levels: ['soon'], at: 1 } })
  await begin($)
  at(45)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(45)])
  id('conversation-2')
  const said = await $.tool.call({ tool: LEVELS })
  expect(said.result).toMatch(/^Compact reminder levels: 40% \(the compactReminder setting's; this conversation has none of its own\)\./)
})

test('a subagent is refused, and sets nothing', async ($, on) => {
  const { held } = engine(on)
  await begin($)
  const refused = await $.tool.call({ tool: LEVELS, levels: '40%', agentId: 'a1' })
  expect(refused.deny).toBe(
    "A subagent has no reminder levels of its own: the levels and the window's reading are the main conversation's. A subagent compacts on its own near its context limit; to close a piece cleanly, finish it and return its result.",
  )
  expect(held.has(KEY('conversation-1'))).toBe(false)
})

test('M1: after the session end of a /clear, while the id still reads the conversation left, nothing is set, the status says so, and the turn end waits', async ($, on) => {
  const { held, lines, toasts, at, id } = engine(on)
  await begin($)
  await $.tool.call({ tool: LEVELS, levels: '40%', notes: { '40%': NOTE } })
  const left = JSON.stringify(held.get(KEY('conversation-1')))
  await $.session.end(ended('clear', 'conversation-1'))

  expect((await $.tool.call({ tool: LEVELS, levels: '70%' })).deny).toBe(MOVING_DENY(MOVE_WAIT(120)))
  expect((await $.tool.call({ tool: LEVELS, levels: 'off' })).deny).toBe(MOVING_DENY(MOVE_WAIT(120)))
  expect((await $.tool.call({ tool: LEVELS })).result).toBe(MOVING_STATUS(MOVE_WAIT(120)))
  at(45)
  await $.turn.complete(answered())
  expect(lines()).toEqual([])
  expect(JSON.stringify(held.get(KEY('conversation-1')))).toBe(left)
  expect(toasts).toHaveLength(1)

  // The id names the conversation moved to: a set works, under its key; the one left is as it was, notes and all.
  id('conversation-2')
  const set = await $.tool.call({ tool: LEVELS, levels: '70%' })
  expect(set.result).toMatch(/^This conversation's compact reminder levels are now 70%,/)
  expect((held.get(KEY('conversation-2')) as { levels: string[] }).levels).toEqual(['70%'])
  expect(JSON.stringify(held.get(KEY('conversation-1')))).toBe(left)
})

test('Tail 1: after the session end of a /resume, the wait holds while the id reads the conversation left, up to 2 minutes; it ends at once when the id moves', async ($, on) => {
  const { clock, held, id } = engine(on)
  await begin($)
  await $.session.end(ended('resume', 'conversation-1'))
  expect((await $.tool.call({ tool: LEVELS, levels: '40%' })).deny).toBe(MOVING_DENY(MOVE_WAIT(120)))
  // A long transcript still loading: 16 s, then 60 s, after the session end, the id unchanged.
  await clock.advance(16_000)
  expect((await $.tool.call({ tool: LEVELS, levels: '40%' })).deny).toBe(MOVING_DENY(MOVE_WAIT(104)))
  await clock.advance(44_000)
  expect((await $.tool.call({ tool: LEVELS, levels: '40%' })).deny).toBe(MOVING_DENY(MOVE_WAIT(60)))
  expect(held.has(KEY('conversation-1'))).toBe(false)
  // The id names the conversation moved to: a set works at once.
  id('conversation-2')
  expect((await $.tool.call({ tool: LEVELS, levels: '40%' })).result).toMatch(/^This conversation's compact reminder levels are now 40%,/)
  // Past the bound with the id unchanged: no longer refused.
  await $.session.end(ended('resume', 'conversation-2'))
  await clock.advance(120_001)
  expect((await $.tool.call({ tool: LEVELS, levels: '45%' })).result).toMatch(/^This conversation's compact reminder levels are now 45%,/)
  // Another end reason begins no wait.
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'conversation-2', resume: { id: 'conversation-2' } })
  expect((await $.tool.call({ tool: LEVELS, levels: '50%' })).result).toMatch(/^This conversation's compact reminder levels are now 50%,/)
})

test("M1: in the process's first seconds nothing is set and the status says how long; a reload's start begins no such wait", async ($, on) => {
  const { clock, held } = engine(on)
  await $.session.start(start)
  expect((await $.tool.call({ tool: LEVELS, levels: '40%' })).deny).toBe(MOVING_DENY(START_WAIT(15)))
  expect((await $.tool.call({ tool: LEVELS })).result).toBe(MOVING_STATUS(START_WAIT(15)))
  expect(held.has(KEY('conversation-1'))).toBe(false)
  await clock.advance(15_000)
  expect((await $.tool.call({ tool: LEVELS, levels: '40%' })).result).toMatch(/^This conversation's compact reminder levels are now 40%,/)
  // A reload: session.start again in the same process.
  await $.session.start(start)
  expect((await $.tool.call({ tool: LEVELS, levels: '50%' })).result).toMatch(/^This conversation's compact reminder levels are now 50%,/)
})

test("a start mark that can't be read in time begins the start's wait: the guard fails closed", async ($, on) => {
  const { clock, held } = engine(on, {}, { lateMark: true })
  const starting = $.session.start(start)
  await clock.settle()
  await clock.advance(2500)
  await starting
  expect((await $.tool.call({ tool: LEVELS, levels: '40%' })).deny).toMatch(/^This session is moving between conversations; nothing was set\. It is in its first seconds/)
  expect(held.has(KEY('conversation-1'))).toBe(false)
  await clock.advance(15_000)
  expect((await $.tool.call({ tool: LEVELS, levels: '40%' })).result).toMatch(/^This conversation's compact reminder levels are now 40%,/)
})

test('L5: a turn end whose read of the id runs out of time is skipped, with no line and no marks changed, said once in the debug log', { options: { compactReminder: '40%' } }, async ($, on) => {
  const { lines, logs, clock, at, hang } = engine(on, { [KEY('conversation-1')]: { levels: ['70%'], at: 1 } })
  await begin($)
  at(45)
  hang(true)
  const slow = "compact reminder: the conversation's id or its own levels weren't read within 2 s at a turn end, so that turn end was skipped (said once)."
  for (let n = 0; n < 2; n += 1) {
    const ending = $.turn.complete(answered())
    await clock.advance(2500)
    await ending
    await clock.advance(5000)
  }
  // The setting's 40% would have reminded here; the conversation's own 70% stands instead, once the id is read.
  expect(lines()).toEqual([])
  expect(logs).toEqual([slow])
  hang(false)
  await $.turn.complete(answered())
  expect(lines()).toEqual([])
  at(71)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(71)])
})

test('marks that cannot be written after a set: the answer says so, not that the window was unread', async ($, on) => {
  const { at } = engine(on, {}, { marksFail: true })
  await begin($)
  at(45)
  const set = await $.tool.call({ tool: LEVELS, levels: '40%' })
  expect(set.result).toBe(
    `This conversation's compact reminder levels are now 40%, in place of the compactReminder setting's (none). They last across a compaction, a restart and a resume of this conversation; "off" goes back to the setting. The marks couldn't be written, so no level was marked: one the window already stands past may remind at the next answered turn end. The window is at 45% (450,000 of 1,000,000 tokens).`,
  )
})

test("a drop of old conversations that fails after the write doesn't fail the set: its answer and toast come, and the debug log says it", async ($, on) => {
  const { held, toasts, logs } = engine(on, {}, { keysFail: true })
  await begin($)
  const set = await $.tool.call({ tool: LEVELS, levels: '40%' })
  expect(set.result).toMatch(/^This conversation's compact reminder levels are now 40%,/)
  expect(toasts).toEqual(["Compact reminder: this conversation's own levels are 40%."])
  expect(logs).toEqual(["compact reminder: the store's bound of 200 conversations wasn't checked or kept after this set; the levels were set."])
  expect((held.get(KEY('conversation-1')) as { levels: string[] }).levels).toEqual(['40%'])
})

test('the store keeps at most 200 conversations: past that, the oldest go, down to KEEP_CONVERSATIONS; no other entry is rewritten', async ($, on) => {
  const seeded = Object.fromEntries(Array.from({ length: 200 }, (_, n) => [KEY(`other-${n}`), { levels: ['50%'], at: n + 1 }]))
  const { held } = engine(on, seeded)
  await begin($)
  await $.tool.call({ tool: LEVELS, levels: '40%' })
  const kept = [...held.keys()].filter(key => key.startsWith('sessionLevels:'))
  expect(kept).toHaveLength(KEEP_CONVERSATIONS)
  expect((held.get(KEY('conversation-1')) as { levels: string[] }).levels).toEqual(['40%'])
  expect(held.has(KEY('other-50'))).toBe(false)
  expect(held.has(KEY('other-51'))).toBe(true)
  expect(JSON.stringify(held.get(KEY('other-199')))).toBe(JSON.stringify({ levels: ['50%'], at: 200 }))
  await $.tool.call({ tool: LEVELS, levels: 'off' })
  expect(held.has(KEY('conversation-1'))).toBe(false)
  expect([...held.keys()].filter(key => key.startsWith('sessionLevels:'))).toHaveLength(KEEP_CONVERSATIONS - 1)
})
