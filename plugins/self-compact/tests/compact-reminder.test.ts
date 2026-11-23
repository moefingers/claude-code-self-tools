// The compact reminder (#72): `compactReminder` levels, one line to the session's next turn past a level, once per
// passing, armed again when the window falls back below it (a compaction).
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { parseReminder } from '../hooks/reminder'

const TOOL = 'mcp__self-compact__compact_after_turn'
const WINDOW = 1_000_000

/** The line at `at` percent (1 to 99) of a 1,000,000-token window, written out here so a change of words fails. */
const line = (at: number) =>
  `self-compact: the context window is at ${at}% (${at * 10},000 of 1,000,000 tokens). If the piece of work you just finished is complete, this is the break to call compact_after_turn, with keep (what the summary must hold) and resume (the next piece). If you are mid-piece, finish it first.`

/**
 * The engine beneath the plugin: the window's reading, which a test moves (`at`) and a compaction empties, as Claude
 * Code's does until the next response; the rows added to the conversation; the toasts and debug lines.
 */
function engine(on: On) {
  const reading: { tokens?: number } = {}
  const toasts: string[] = []
  const logs: string[] = []
  const compactions: (string | undefined)[] = []
  const session = mock.session(on)
  const clock = mock.clock(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => (toasts.push(String(e.text)), { value: undefined }))
  on('ui.log', (_, e) => (logs.push(String(e.text)), { value: undefined }))
  on('session.usage', () => {
    const { tokens } = reading
    return { value: { startedAt: 0, context: { window: WINDOW, tokens, percent: tokens === undefined ? undefined : Math.round((tokens * 100) / WINDOW) }, rateLimits: [] } }
  })
  on('session.compact', (_, e) => {
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
    clock,
    /** The window at `percent` of its size, as the last response read it. */
    at: (percent: number) => void (reading.tokens = (percent * WINDOW) / 100),
  }
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const
let turns = 0
/** A turn's end: the main loop's, answered, unless `ended` says otherwise. */
const answered = ({ isAborted = false, reason = 'answer', agentId }: { isAborted?: boolean; reason?: 'answer' | 'aborted' | 'error'; agentId?: string } = {}) => ({
  answer: 'done',
  durationMs: 1,
  turnId: `t${++turns}`,
  isAborted,
  reason,
  ...(agentId === undefined ? {} : { agentId }),
})

test('off by default: with the option empty, no line at any level, and nothing said', async ($, on) => {
  const { lines, toasts, logs, at } = engine(on)
  await $.session.start(start)
  for (const percent of [45, 70, 99]) {
    at(percent)
    await $.turn.complete(answered())
  }
  expect(lines()).toEqual([])
  expect(toasts).toEqual([])
  expect(logs).toEqual([])
})

test('off when set to blanks: no line', { options: { compactReminder: '   ' } }, async ($, on) => {
  const { lines, toasts, at } = engine(on)
  await $.session.start(start)
  at(99)
  await $.turn.complete(answered())
  expect(lines()).toEqual([])
  expect(toasts).toEqual([])
})

test('a level passed at a turn end: one line, in the exact words, with no toast; the same level again: nothing; a later level: one more', { options: { compactReminder: '40%, 60%, 80%' } }, async ($, on) => {
  const { lines, toasts, at } = engine(on)
  await $.session.start(start)

  at(30)
  await $.turn.complete(answered())
  expect(lines()).toEqual([])

  at(45)
  await $.turn.complete(answered())
  expect(lines()).toEqual([
    'self-compact: the context window is at 45% (450,000 of 1,000,000 tokens). If the piece of work you just finished is complete, this is the break to call compact_after_turn, with keep (what the summary must hold) and resume (the next piece). If you are mid-piece, finish it first.',
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
  await $.session.start(start)
  at(85)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(85)])
  at(95)
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(85)])
})

test("a subagent's turn end: nothing, and the level waits for the main loop's", { options: { compactReminder: '40%' } }, async ($, on) => {
  const { lines, at } = engine(on)
  await $.session.start(start)
  at(70)
  await $.turn.complete(answered({ agentId: 'a1' }))
  expect(lines()).toEqual([])
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(70)])
})

test('an interrupted turn, or one that ended on an error, is no break: the level waits for the next answered turn end', { options: { compactReminder: '40%' } }, async ($, on) => {
  const { lines, at } = engine(on)
  await $.session.start(start)
  at(45)
  await $.turn.complete(answered({ isAborted: true, reason: 'aborted' }))
  await $.turn.complete(answered({ reason: 'error' }))
  expect(lines()).toEqual([])
  await $.turn.complete(answered())
  expect(lines()).toEqual([line(45)])
})

test('after a compaction the levels remind again: by compact_after_turn, with no line at the turn end it compacts', { options: { compactReminder: '40%, 60%, 80%' } }, async ($, on) => {
  const { lines, compactions, clock, at } = engine(on)
  await $.session.start(start)
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

test('after a compaction the levels remind again: by /compact or auto-compact, read off the window falling', { options: { compactReminder: '40%, 60%' } }, async ($, on) => {
  const { lines, at } = engine(on)
  await $.session.start(start)
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

test('a compaction that lands above a level: no line for it, and the levels above remind again', { options: { compactReminder: '10%, 50%' } }, async ($, on) => {
  const { lines, at } = engine(on)
  await $.session.start(start)
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
  await $.session.start(start)
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
  await $.session.start(start)
  await $.turn.complete(answered())
  expect(lines()).toEqual([])
})

test('a malformed option: off, said once (a toast and a debug line), and no line at any level', { options: { compactReminder: '40%, soon' } }, async ($, on) => {
  const { lines, toasts, logs, at } = engine(on)
  await $.session.start(start)
  const why = 'compactReminder is off: "soon" is not a level. Each level is a percentage of the window (40%) or a token count (400k or 400000), separated by commas, such as 40%, 60%, 80%.'
  expect(toasts).toEqual([why])
  expect(logs).toEqual([why])

  // A reload's start, the same value: not said again.
  await $.session.start(start)
  expect(toasts).toEqual([why])
  expect(logs).toEqual([why])

  at(90)
  await $.turn.complete(answered())
  expect(lines()).toEqual([])
})

test('what is not a level, and what is', () => {
  for (const [raw, said] of [
    ['40', '"40" is not a level: a token count is 1k or more, and a percentage takes its % (40%).'],
    ['0%', '"0%" is not a level: a percentage is 1% to 99%.'],
    ['100%', '"100%" is not a level: a percentage is 1% to 99%.'],
    ['40%,,60%', 'a level between two commas is empty.'],
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
})
