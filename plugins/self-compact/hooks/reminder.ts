// The compact reminder (#72), off unless the person sets `compactReminder`: context levels, each a percentage of the
// window (40%) or a token count (400k, 400000). At a main-loop turn's end that the model answered, with no compaction
// queued, the plugin reads the window as context_usage does. When it has risen past a level the session hasn't been
// reminded of, the session gets one line on its next turn: how full the window is, and that a finished piece is the
// break to compact. One line per turn end, however many levels it passed. Never a turn of its own, never a toast for
// the line, never to a subagent, nothing sent off the machine.
//
// When the levels remind again. After this plugin's own compaction (compact_after_turn), all of them: the plugin made
// it, so it knows. A /compact or an auto-compact it can't hear: Claude Code has no compaction event a plugin can hook in
// every session (`session.compact` is one its built-in guard passes over: scripts/guarded-hooks.mjs). So for those the
// fall is read off the window: the levels kept as reminded are the ones the last answered turn end's reading had
// reached, and a level the window falls back below reminds again the next time it is passed. A level the window is
// back above by the first answered turn end after such a compaction stays quiet that cycle.
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

/** Why an empty entry is there: a comma at either end, or two in a row. */
function empty(at: number, of: number): string {
  if (at === of - 1) return 'the list ends with a comma: leave the last comma out.'
  if (at === 0) return 'the list starts with a comma: leave the first comma out.'
  return 'two commas have no level between them: leave one out.'
}

/** Reads `compactReminder`: empty (the default) is off and says nothing; anything but levels is off, and says why. */
export function parseReminder(raw: unknown): Reminder {
  const text = raw === undefined ? '' : String(raw).trim()
  if (text === '') return { levels: [] }
  const items = text.split(',').map(part => part.trim())
  const levels: Level[] = []
  for (const [at, item] of items.entries()) {
    const off = (said: string): Reminder => ({ levels: [], why: `compactReminder is off: ${said} ${HOW}` })
    if (item === '') return off(empty(at, items.length))
    // A token count written with a thousands separator (400,000): the commas split it into levels.
    let runs = at + 1
    while (runs < items.length && /^\d{3}$/.test(items[runs] ?? '')) runs += 1
    if (/^\d{1,3}$/.test(item) && runs > at + 1) {
      const written = items.slice(at, runs).join(',')
      return off(`${JSON.stringify(written)} is not a level: commas separate levels, so a token count has none (write ${items.slice(at, runs).join('')} or ${items.slice(at, runs - 1).join('')}k).`)
    }
    const read = level(item)
    if (typeof read === 'string') return off(read)
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

/** What this load's `compactReminder` sets, from register (configureReminder). */
let current: Reminder = { levels: [] }

/** Token levels already said to be out of this window's reach, in this load, so each is said once. */
const outOfReach = new Set<string>()

/** At register: reads `compactReminder` for this load, and answers what it sets. */
export function configureReminder(raw: unknown): Reminder {
  current = parseReminder(raw)
  outOfReach.clear()
  return current
}

/** Tells the model on its next turn, in a row it reads and the person doesn't see as typed; false when it wasn't kept. */
async function tellModel($: EngineInterface, note: string): Promise<boolean> {
  try {
    const kept = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
    if (kept.deny === undefined) return true
    $.ui.log(`compact reminder: the line was refused (${kept.deny}); the next answered turn end tries again.`, { to: 'debug' })
  } catch {
    $.ui.log("compact reminder: the line wasn't added; the next answered turn end tries again.", { to: 'debug' })
  }
  return false
}

/** A token level at or past the window's size never fires in this session: said once, in the debug log alone. */
function sayOutOfReach($: EngineInterface, window: number): void {
  for (const l of current.levels) {
    if (!('tokens' in l) || l.tokens < window || outOfReach.has(l.key)) continue
    outOfReach.add(l.key)
    $.ui.log(`compact reminder: the level ${grouped(l.tokens)} is at or past this window's ${grouped(window)} tokens, so it never reminds in this session.`, { to: 'debug' })
  }
}

/**
 * At a main-loop turn's end the model answered, with no compaction queued: reads the window, keeps the levels it has
 * reached as the ones reminded, and when one of them is new, tells the model once. Off with no levels.
 */
export async function remind($: EngineInterface): Promise<void> {
  if (current.levels.length === 0) return
  try {
    const { context } = await $.session.usage()
    // No reading yet (a new or just-compacted conversation, until its next response): nothing to compare.
    if (context.tokens === undefined || !(context.window > 0)) return
    sayOutOfReach($, context.window)
    const reached = reachedKeys(current.levels, context.tokens, context.window)
    const before: readonly string[] = (await $.state.get(reminded)).value ?? []
    if (reached.length === before.length && reached.every(key => before.includes(key))) return
    // Marked before the send, and put back as they were when the line isn't kept, so the next answered turn end
    // tries once more: one try per turn end.
    await $.state.set(reminded, reached.length === 0 ? null : reached)
    if (!reached.some(key => !before.includes(key))) return
    const sent = await tellModel($, reminderLine(context.tokens, context.window, context.percent))
    if (!sent) await $.state.set(reminded, before.length === 0 ? null : [...before])
  } catch {
    $.ui.log("compact reminder: this turn end's check failed; no line was sent.", { to: 'debug' })
  }
}

/** After this plugin's own compaction ran: every level reminds again at its next passing. */
export async function forgetReminded($: EngineInterface): Promise<void> {
  if (current.levels.length === 0) return
  try {
    await $.state.set(reminded, null)
  } catch {
    $.ui.log("compact reminder: the levels weren't armed again after the compaction.", { to: 'debug' })
  }
}

/** Says why `compactReminder` is off, once per conversation and value: a toast and a line in the debug log. */
export async function sayWhyOff($: EngineInterface, raw: unknown): Promise<void> {
  if (current.why === undefined) return
  const value = String(raw).trim()
  try {
    if ((await $.state.get(warned)).value === value) return
    await $.state.set(warned, value)
  } catch {
    // Unread, it is said again rather than never.
  }
  $.ui.log(current.why, { to: 'debug' })
  $.ui.toast(current.why)
}
