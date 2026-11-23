// The compact reminder (#72), off unless the person sets `compactReminder`: context levels, each a percentage of the
// window (40%) or a token count (400k, 400000). At a main-loop turn's end that the model answered, with no compaction
// queued, the plugin reads the window as context_usage does. When it has risen past a level since the plugin last saw
// it below that level, the session gets one line on its next turn: how full the window is, and that a finished piece
// is the break to compact. One line per turn end, however many levels it passed. Never a turn of its own, never a toast
// for the line, never to a subagent, nothing sent off the machine.
//
// What counts as compacted is the reading itself. Claude Code has no compaction event a plugin can hook in every
// session (`session.compact` is one its built-in guard passes over: scripts/guarded-hooks.mjs), and a compaction, by
// compact_after_turn, /compact or auto-compact, is what makes the window fall. So the levels kept as reminded are the
// ones the last reading had reached: a level the window falls back below reminds again the next time it is passed. A
// compaction that lands below every level arms them all again; one that lands above a level leaves that level quiet,
// since compacting again would not take the window under it.
import type { EngineInterface } from 'claude-code'

/** The levels the window had reached at the last answered turn end, by key: the ones reminded. */
const reminded = { plugin: 'self-compact', key: 'reminded' } as const

/** The `compactReminder` value the session was last told is not levels, so a reload doesn't say it again. */
const warned = { plugin: 'self-compact', key: 'warned' } as const

/**
 * One context level: its key (`40%`, or the token count as digits, so `400k` and `400000` are one level), and the
 * percentage of the window or the token count a reading must reach to pass it.
 */
export type Level = { key: string } & ({ percent: number } | { tokens: number })

/** What `compactReminder` sets: its levels (none: off), and why it is off when it holds anything but levels. */
export type Reminder = { levels: readonly Level[]; why?: string }

const HOW = 'Each level is a percentage of the window (40%) or a token count (400k or 400000), separated by commas, such as 40%, 60%, 80%.'

/** One entry of the list, or why it is not a level. */
function level(item: string): Level | string {
  if (item === '') return 'a level between two commas is empty.'
  const shown = JSON.stringify(item.length > 24 ? `${item.slice(0, 24)}...` : item)
  const percent = /^(\d{1,3})%$/.exec(item)
  if (percent) {
    const p = Number(percent[1])
    return p >= 1 && p <= 99 ? { key: `${p}%`, percent: p } : `${shown} is not a level: a percentage is 1% to 99%.`
  }
  const count = /^(\d{1,12})(k?)$/i.exec(item)
  if (count) {
    const tokens = Number(count[1]) * (count[2] === '' ? 1 : 1000)
    // A bare number this small reads as a percentage that lost its sign: refused, never taken as a few tokens.
    return tokens >= 1000 ? { key: String(tokens), tokens } : `${shown} is not a level: a token count is 1k or more, and a percentage takes its % (40%).`
  }
  return `${shown} is not a level.`
}

/** Reads `compactReminder`: empty (the default) is off and says nothing; anything but levels is off, and says why. */
export function parseReminder(raw: unknown): Reminder {
  const text = raw === undefined ? '' : String(raw).trim()
  if (text === '') return { levels: [] }
  const levels: Level[] = []
  for (const item of text.split(',').map(part => part.trim())) {
    const read = level(item)
    if (typeof read === 'string') return { levels: [], why: `compactReminder is off: ${read} ${HOW}` }
    const { key } = read
    if (!levels.some(known => known.key === key)) levels.push(read)
  }
  return { levels }
}

/** The keys of the levels a reading of `tokens` in a window of `window` tokens has reached. */
export function reachedKeys(levels: readonly Level[], tokens: number, window: number): string[] {
  return levels.filter(l => ('percent' in l ? tokens * 100 >= l.percent * window : tokens >= l.tokens)).map(l => l.key)
}

/** A whole number with thousands separators, written out, as context_usage writes it. */
const grouped = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** The line, in fixed words: only the numbers vary. */
export function reminderLine(tokens: number, window: number, percent: number | undefined): string {
  const at = percent ?? Math.round((tokens * 100) / window)
  return `self-compact: the context window is at ${at}% (${grouped(tokens)} of ${grouped(window)} tokens). If the piece of work you just finished is complete, this is the break to call compact_after_turn, with keep (what the summary must hold) and resume (the next piece). If you are mid-piece, finish it first.`
}

/** Tells the model on its next turn, in a row it reads and the person doesn't see as typed. */
async function tellModel($: EngineInterface, note: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
  } catch {
    // No toast for the line, so the debug log alone says it wasn't kept.
    $.ui.log("compact reminder: the line wasn't added to the next turn.", { to: 'debug' })
  }
}

/**
 * At a main-loop turn's end the model answered, with no compaction queued: reads the window, keeps the levels it has
 * reached as the ones reminded, and when one of them is new, tells the model once. Off with no levels.
 */
export async function remind($: EngineInterface, levels: readonly Level[]): Promise<void> {
  if (levels.length === 0) return
  try {
    const { context } = await $.session.usage()
    // No reading yet (a new or just-compacted conversation, until its next response): nothing to compare.
    if (context.tokens === undefined || !(context.window > 0)) return
    const reached = reachedKeys(levels, context.tokens, context.window)
    const before: readonly string[] = (await $.state.get(reminded)).value ?? []
    if (reached.length === before.length && reached.every(key => before.includes(key))) return
    // Marked first, so a line is never sent twice for one passing.
    await $.state.set(reminded, reached.length === 0 ? null : reached)
    if (reached.some(key => !before.includes(key))) await tellModel($, reminderLine(context.tokens, context.window, context.percent))
  } catch {
    $.ui.log("compact reminder: the context window wasn't read at this turn's end.", { to: 'debug' })
  }
}

/** Says why `compactReminder` is off, once per conversation and value: a toast and a line in the debug log. */
export async function sayWhyOff($: EngineInterface, raw: unknown, reminder: Reminder): Promise<void> {
  if (reminder.why === undefined) return
  const value = String(raw).trim()
  try {
    if ((await $.state.get(warned)).value === value) return
    await $.state.set(warned, value)
  } catch {
    // Unread, it is said again rather than never.
  }
  $.ui.log(reminder.why, { to: 'debug' })
  $.ui.toast(reminder.why)
}
