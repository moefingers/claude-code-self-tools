// The compact reminder (#72): `compactReminder` levels, one line to the session's next turn past a level, once per
// passing; all armed again after compact_after_turn compacts, and a level the window falls back below after any other
// compaction.
import { expect, mock, test } from 'claude-code/testing'
import type { On, TurnCompleteInput } from 'claude-code'
import { parseReminder } from '../hooks/reminder'

const TOOL = 'mcp__self-compact__compact_after_turn'
const WINDOW = 1_000_000

/** The line at `at` percent (1 to 99) of a 1,000,000-token window, written out here so a change of words fails. */
const line = (at: number) =>
  `self-compact: a polite reminder, in case it slipped your mind: the context window is at ${at}% (${at * 10},000 of 1,000,000 tokens). Nothing is required. If the piece you just finished is complete, this could be a good break for compact_after_turn, with keep (what the summary must hold) and resume (the next piece); if you are mid-piece, carry on.`

/**
 * The engine beneath the plugin: the window's reading, which a test moves (`at`) and a compaction empties, as Claude
 * Code's does until the next response; the rows added to the conversation; the toasts and debug lines. `refuse` is how
 * many of the plugin's appends a hook above refuses (`deny`), first; `skip`, a compaction Claude Code skips.
 */
function engine(on: On, { refuse = 0, skip }: { refuse?: number; skip?: string } = {}) {
  const reading: { tokens?: number } = {}
  const toasts: string[] = []
  const logs: string[] = []
  const compactions: (string | undefined)[] = []
  const counts = { usage: 0, appends: 0 }
  const session = mock.session(on)
  const clock = mock.clock(on)
  clockNow = clock
  // The conversation, and the plugin's store, where a conversation's own levels would be: none here.
  mock.store(on)
  on('session.id', () => ({ value: 'conversation-1' }))
  on('session.append', { door: 'note' }, (_, e, next) => {
    counts.appends += 1
    return counts.appends > refuse ? next(e) : { deny: 'held by policy' }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => (toasts.push(String(e.text)), { value: undefined }))
  on('ui.log', (_, e) => (logs.push(String(e.text)), { value: undefined }))
  on('session.usage', () => {
    counts.usage += 1
    const { tokens } = reading
    return { value: { startedAt: 0, context: { window: WINDOW, tokens, percent: tokens === undefined ? undefined : Math.round((tokens * 100) / WINDOW) }, rateLimits: [] } }
  })
  on('session.compact', (_, e) => {
    if (skip !== undefined) return { skip }
    compactions.push(e.instructions)
    reading.tokens = undefined
    return { messages: [{ role: 'user', text: 'The summary.', toolUses: [] }] }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: 'done' }))
  /** Every line the plugin added to the conversation, oldest first. */
  const lines = () =>
    session.appended().flatMap(row => ((row as { message?: { content?: { text?: unknown }[] } }).message?.content ?? []).map(block => String(block.text)))
  return {
    lines,
    toasts,
    logs,
    compactions,
    counts,
    clock,
    /** The window at `percent` of its size, as the last response read it. */
    at: (percent: number) => void (reading.tokens = (percent * WINDOW) / 100),
    /** No reading: a conversation compacted outside the plugin (/compact), until its next response. */
    unread: () => void (reading.tokens = undefined),
  }
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const

/** The clock of the test running now, for begin(). */
let clockNow: { advance: (ms: number) => Promise<void> } | undefined

/** The process's first start, and the seconds its conversation id may lag it gone by (hooks/moving.ts). */
async function begin($: { session: { start: (e: typeof start) => Promise<unknown> } }): Promise<void> {
  await $.session.start(start)
  await clockNow?.advance(15_000)
}
let turns = 0
/** A turn's end: the main loop's, answered, unless `ended` says otherwise. */
function answered({ isAborted = false, reason = 'answer', agentId }: { isAborted?: boolean; reason?: 'answer' | 'aborted' | 'error' | 'refusal'; agentId?: string } = {}): TurnCompleteInput {
  const base = { answer: 'done', durationMs: 1, turnId: `t${++turns}`, isAborted, ...(agentId === undefined ? {} : { agentId }) }
  return reason === 'refusal' ? { ...base, reason, refusal: { category: null, explanation: null } } : { ...base, reason }
}

test('off by default: with the option empty, no line at any level, nothing said, and the window never read', async ($, on) => {
  const { lines, toasts, logs, counts, at } = engine(on)
  await begin($)
  for (const percent of [45, 70, 99]) {
    at(percent)
    await $.turn.complete(answered())
  }
  expect(lines()).toEqual([])
  expect(toasts).toEqual([])
  expect(logs).toEqual([])
  expect(counts.usage).toBe(0)
})

test('off when set to blanks: no line', { options: { compactReminder: '   ' } }, async ($, on) => {
  const { lines, toasts, at } = engine(on)
  await begin($)
  at(99)
  await $.turn.complete(answered())
  expect(lines()).toEqual([])
  expect(toasts).toEqual([])
})

test('a level passed at a turn end: one line, in the exact words, with no toast; the same level again: nothing; a later level: one more', { options: { compactReminder: '40%, 60%, 80%' } }, async ($, on) => {
  const { lines, toasts, at } = engine(on)
  await begin($)

  at(30)
  await $.turn.complete(answered())
  expect(lines()).toEqual([])

  at(45)
  await $.turn.complete(answered())
  expect(lines()).toEqual([
    'self-compact: a polite reminder, in case it slipped your mind: the context window is at 45% (450,000 of 1,000,000 tokens). Nothing is required. If the piece you just finished is complete, this could be a good break for compact_after_turn, with keep (what the summary must hold) and resume (the next piece); if you are mid-piece, carry on.',
  ])
  expect(toasts).toEqual([])

  // Still past 40% only: the level was reminded.
  at(52)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(45)])

  at(62)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(45), line(62)])
  expect(toasts).toEqual([])
})

test('several levels passed at once (a session that starts at 85%): one line, then nothing until a new level', { options: { compactReminder: '40%, 60%, 80%' } }, async ($, on) => {
  const { lines, at } = engine(on)
  await begin($)
  at(85)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(85)])
  at(95)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(85)])
})

test("a subagent's turn end: nothing, and the level waits for the main loop's", { options: { compactReminder: '40%' } }, async ($, on) => {
  const { lines, at } = engine(on)
  await begin($)
  at(70)
  await $.turn.complete(answered({ agentId: 'a1' }))
  expect(lines()).toEqual([])
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(70)])
})

test('an interrupted turn, or one that ended on an error or a refusal, is no break: the level waits for the next answered turn end', { options: { compactReminder: '40%' } }, async ($, on) => {
  const { lines, at } = engine(on)
  await begin($)
  at(45)
  await $.turn.complete(answered({ isAborted: true, reason: 'aborted' }))
  await $.turn.complete(answered({ reason: 'error' }))
  await $.turn.complete(answered({ reason: 'refusal' }))
  expect(lines()).toEqual([])
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(45)])
})

test('after a compaction the levels remind again: by compact_after_turn, with no line at the turn end it compacts', { options: { compactReminder: '40%, 60%, 80%' } }, async ($, on) => {
  const { lines, compactions, clock, at } = engine(on)
  await begin($)
  at(65)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(65)])

  // The session compacts: past 80% at that turn's end, but the compaction is queued, so no line.
  await $.tool.call({ tool: TOOL, keep: 'the PR queue' })
  at(85)
  await $.turn.complete(answered())
  await clock.advance(1000)
  expect(compactions).toEqual(['the PR queue'])
  expect(lines()).toEqual([line(65)])

  // The next turn's end reads the window low: every level it fell below is armed again, and nothing is said.
  at(3)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(65)])

  at(45)
  await $.turn.complete(answered())
  at(61)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(65), line(45), line(61)])
})

test('after a /compact or an auto-compact, a level the window fell below reminds again, read off the window', { options: { compactReminder: '40%, 60%' } }, async ($, on) => {
  const { lines, at } = engine(on)
  await begin($)
  at(85)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(85)])

  // Compacted with no call of the tool (the person's /compact, or auto-compact inside the turn): only the reading says so.
  at(2)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(85)])
  at(41)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(85), line(41)])
})

test('a /compact or an auto-compact that lands above a level: no line for it, and the levels above remind again', { options: { compactReminder: '10%, 50%' } }, async ($, on) => {
  const { lines, at } = engine(on)
  await begin($)
  at(55)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(55)])
  // Compacted to 12%: still past 10%, which compacting again would not take it under, so nothing.
  at(12)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(55)])
  at(51)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(55), line(51)])
})

test('a token count is a level, and 400k and 400000 are the same one', { options: { compactReminder: '400k, 400000, 700000' } }, async ($, on) => {
  const { lines, at } = engine(on)
  await begin($)
  at(39)
  await $.turn.complete(answered())
  expect(lines()).toEqual([])
  at(40)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(40)])
  at(71)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(40), line(71)])
})

test('no reading yet (a new or just-compacted conversation): nothing', { options: { compactReminder: '1k' } }, async ($, on) => {
  const { lines } = engine(on)
  await begin($)
  await $.turn.complete(answered())
  expect(lines()).toEqual([])
})

test('a malformed option: off, said once (a toast and a debug line), and no line at any level', { options: { compactReminder: '40%, soon' } }, async ($, on) => {
  const { lines, toasts, logs, at } = engine(on)
  await begin($)
  const why = 'compactReminder is off: "soon" is not a level. Each level is a percentage of the window (40%) or a token count (400k or 400000), separated by commas, such as 40%, 60%, 80%.'
  expect(toasts).toEqual([why])
  expect(logs).toEqual([why])

  // A reload's start, the same value: not said again.
  await begin($)
  expect(toasts).toEqual([why])
  expect(logs).toEqual([why])

  at(90)
  await $.turn.complete(answered())
  expect(lines()).toEqual([])
})

test("M1: after compact_after_turn, every level reminds again, one the compaction landed above too (the review's sequence)", { options: { compactReminder: '40%, 60%, 80%' } }, async ($, on) => {
  const { lines, compactions, clock, at } = engine(on)
  await begin($)
  at(62)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(62)])

  await $.tool.call({ tool: TOOL, keep: 'the PR queue', resume: 'Go on with the next piece.' })
  await $.turn.complete(answered())
  await clock.advance(1000)
  expect(compactions).toEqual(['the PR queue'])

  // The resumed turn does the next piece and ends at 47%, past 40% again with no answered turn end below it between.
  at(47)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(62), line(47)])
  at(50)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(62), line(47)])
})

test('a skipped compaction arms nothing again', { options: { compactReminder: '40%' } }, async ($, on) => {
  const { lines, compactions, clock, at } = engine(on, { skip: 'nothing to compact' })
  await begin($)
  at(45)
  await $.turn.complete(answered())
  await $.tool.call({ tool: TOOL, keep: 'the PR queue' })
  await $.turn.complete(answered())
  await clock.advance(1000)
  expect(compactions).toEqual([])
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(45)])
})

test('the limit, pinned: after a /compact, a level the window is back above by the first answered turn end is not reminded that cycle', { options: { compactReminder: '40%, 60%' } }, async ($, on) => {
  const { lines, at, unread } = engine(on)
  await begin($)
  at(62)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(62)])
  // A /compact the plugin can't hear, then a turn that climbs back past 40%: no fall below 40% was ever read.
  unread()
  at(47)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(62)])
  // 60% was read below, so it reminds at its next passing.
  at(61)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(62), line(61)])
})

test('a line a hook above refuses: the levels are put back, one try per turn end, and the next answered turn end tries again', { options: { compactReminder: '40%, 60%' } }, async ($, on) => {
  const { lines, logs, counts, at } = engine(on, { refuse: 1 })
  await begin($)
  at(45)
  await $.turn.complete(answered())
  expect(counts.appends).toBe(1)
  expect(lines()).toEqual([])
  expect(logs).toEqual(['compact reminder: the line was refused (held by policy); the next answered turn end tries again.'])
  await $.turn.complete(answered())
  expect(counts.appends).toBe(2)
  expect(lines()).toEqual([line(45)])
  await $.turn.complete(answered())
  expect(counts.appends).toBe(2)
})

test('a turn end with no reading leaves the record as it was', { options: { compactReminder: '40%' } }, async ($, on) => {
  const { lines, at, unread } = engine(on)
  await begin($)
  at(65)
  await $.turn.complete(answered())
  unread()
  await $.turn.complete(answered())
  at(66)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(65)])
})

test('percentages and token counts in one setting', { options: { compactReminder: '40%, 700k' } }, async ($, on) => {
  const { lines, at } = engine(on)
  await begin($)
  at(45)
  await $.turn.complete(answered())
  at(69)
  await $.turn.complete(answered())
  at(71)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(45), line(71)])
})

test("a token level at or past this window's size: kept, never a line, and said once in the debug log", { options: { compactReminder: '1000k, 2000000' } }, async ($, on) => {
  const { lines, logs, at } = engine(on)
  await begin($)
  at(99)
  await $.turn.complete(answered())
  await $.turn.complete(answered())
  expect(lines()).toEqual([])
  expect(logs).toEqual([
    "compact reminder: the level 1,000,000 is at or past this window's 1,000,000 tokens, so it never reminds in this session.",
    "compact reminder: the level 2,000,000 is at or past this window's 1,000,000 tokens, so it never reminds in this session.",
  ])
})

test('what is not a level, and what is', () => {
  for (const [raw, said] of [
    ['40', '"40" is not a level: a token count is 1k or more, and a percentage takes its % (40%).'],
    ['0%', '"0%" is not a level: a percentage is 1% to 99%.'],
    ['100%', '"100%" is not a level: a percentage is 1% to 99%.'],
    ['40%,,60%', 'two commas have no level between them: leave one out.'],
    ['40%, 60%,', 'the list ends with a comma: leave the last comma out.'],
    [', 40%', 'the list starts with a comma: leave the first comma out.'],
    ['40%, 400,000', '"400,000" is not a level: commas separate levels, so a token count has none (write 400000 or 400k).'],
    ['1,000,000', '"1,000,000" is not a level: commas separate levels, so a token count has none (write 1000000 or 1000k).'],
    ['40%, 1.5k', '"1.5k" is not a level.'],
    ['40 %', '"40 %" is not a level.'],
  ] as const) {
    const read = parseReminder(raw)
    expect(read.levels).toEqual([])
    expect(read.why).toBe(`compactReminder is off: ${said} Each level is a percentage of the window (40%) or a token count (400k or 400000), separated by commas, such as 40%, 60%, 80%.`)
  }
  expect(parseReminder('')).toEqual({ levels: [] })
  expect(parseReminder(' 40% , 2K,40%, 1000 ')).toEqual({
    levels: [
      { key: '40%', percent: 40 },
      { key: '2000', tokens: 2000 },
      { key: '1000', tokens: 1000 },
    ],
  })
  expect(parseReminder('400k, 400000')).toEqual({ levels: [{ key: '400000', tokens: 400000 }] })
})

test("the test kit keeps $.state across a compaction the test raises (a /compact): so the compact_after_turn tests prove forgetReminded", { options: { compactReminder: '40%' } }, async ($, on) => {
  const { lines, compactions, at } = engine(on)
  await begin($)
  at(45)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(45)])
  await $.session.compact({ trigger: 'manual', instructions: 'by hand', messages: [] })
  expect(compactions).toEqual(['by hand'])
  // Had the kit emptied the marks at the compaction, 40% would remind here, as it does after compact_after_turn.
  at(47)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(45)])
})
