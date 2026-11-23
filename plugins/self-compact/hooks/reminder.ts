// The compact reminder (#72), off unless the person sets `compactReminder`: context levels, each a percentage of the
// window (40%) or a token count (400k, 400000). At a main-loop turn's end that the model answered, with no compaction
// queued, the plugin reads the window as context_usage does. When it has risen past a level the session hasn't been
// reminded of, the session gets one line on its next turn: a polite reminder of how full the window is, and that a
// finished piece may be a good break to compact. One line per turn end, however many levels it passed. Never a turn of
// its own, never a toast for the line, never to a subagent, nothing sent off the machine.
//
// A conversation's own levels (#76). With compact_reminder, a session sets levels for its own conversation, in the
// setting's form, in place of the setting's, with a short note of its own per level if it likes. They are kept in the
// plugin's store under a key of the conversation's own (`sessionLevels:<id>`), so they follow the conversation, not the
// process: across a compaction, a restart, a `claude --resume` and a reload. `off` drops them, and the setting stands
// again. While the session moves between conversations (moving.ts), the id may name the one left: nothing is set then.
//
// When the levels remind again. After this plugin's own compaction (compact_after_turn), all of them: the plugin made
// it, so it knows. A /compact or an auto-compact it can't hear: Claude Code has no compaction event a plugin can hook in
// every session (`session.compact` is one its built-in guard passes over: scripts/guarded-hooks.mjs). So for those the
// fall is read off the window: the levels kept as reminded are the ones the last answered turn end's reading had
// reached, and a level the window falls back below reminds again the next time it is passed. A level the window is
// back above by the first answered turn end after such a compaction stays quiet that cycle. When the levels change, the
// ones the window already stands past are marked reminded with no line: only a passing after the change reminds.
import type { EngineInterface } from 'claude-code'
import { moving, READ_MS, waitSaid, within } from './moving'

/** The levels the window had reached at the last answered turn end, by key: the ones reminded. */
const reminded = { plugin: 'self-compact', key: 'reminded' } as const

/** The `compactReminder` value the session was last told is not levels, so a reload doesn't say it again. */
const warned = { plugin: 'self-compact', key: 'warned' } as const

/** $.store keys: each conversation's own levels, under this and its id. */
const LEVELS_PREFIX = 'sessionLevels:'

/** The most conversations whose own levels the store keeps; past it, the oldest go, down to KEEP_CONVERSATIONS. */
export const MAX_CONVERSATIONS = 200
export const KEEP_CONVERSATIONS = 150

/** The most levels a conversation sets, and the longest levels text it gives: a stored list over the first is refused. */
export const MAX_LEVELS = 20
export const MAX_TEXT = 200

/** A conversation id fit to key the store with (a UUID is); never `__proto__` and the like. */
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** The longest note a level may carry: the session's own words, shown back to it on one line. */
export const NOTE_MAX = 120

/**
 * One context level: its key (`40%`, or the token count as digits, so `400k` and `400000` are one level), and the
 * percentage of the window or the token count a reading must reach to pass it.
 */
export type Level = { key: string } & ({ percent: number } | { tokens: number })

/** What `compactReminder` sets: its levels (none: off), and why it is off when it holds anything but levels. */
export type Reminder = { levels: readonly Level[]; why?: string }

/** A conversation's own levels, as the store keeps them: their keys, a note by key where one was given, and when. */
type Own = { levels: string[]; notes?: Record<string, string>; at: number }

export const HOW = 'Each level is a percentage of the window (40%) or a token count (400k or 400000), separated by commas, such as 40%, 60%, 80%.'

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

/** A non-empty list of levels read, each once by key; or what is wrong with it, and what to write. */
export function readLevels(text: string): { levels: Level[] } | { problem: string } {
  const items = text.split(',').map(part => part.trim())
  const levels: Level[] = []
  for (const [at, item] of items.entries()) {
    if (item === '') return { problem: empty(at, items.length) }
    // A token count written with a thousands separator (400,000): the commas split it into levels.
    let runs = at + 1
    while (runs < items.length && /^\d{3}$/.test(items[runs] ?? '')) runs += 1
    if (/^\d{1,3}$/.test(item) && runs > at + 1) {
      const written = items.slice(at, runs).join(',')
      return {
        problem: `${JSON.stringify(written)} is not a level: commas separate levels, so a token count has none (write ${items.slice(at, runs).join('')} or ${items.slice(at, runs - 1).join('')}k).`,
      }
    }
    const read = level(item)
    if (typeof read === 'string') return { problem: read }
    const { key } = read
    if (!levels.some(known => known.key === key)) levels.push(read)
  }
  return { levels }
}

/** Reads `compactReminder`: empty (the default) is off and says nothing; anything but levels is off, and says why. */
export function parseReminder(raw: unknown): Reminder {
  const text = raw === undefined ? '' : String(raw).trim()
  if (text === '') return { levels: [] }
  const read = readLevels(text)
  return 'problem' in read ? { levels: [], why: `compactReminder is off: ${read.problem} ${HOW}` } : { levels: read.levels }
}

/** The keys of the levels a reading of `tokens` in a window of `window` tokens has reached. */
export function reachedKeys(levels: readonly Level[], tokens: number, window: number): string[] {
  return levels.filter(l => ('percent' in l ? tokens * 100 >= l.percent * window : tokens >= l.tokens)).map(l => l.key)
}

/** A whole number with thousands separators, written out, as context_usage writes it. */
const grouped = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** A level's key as the session reads it: `40%`, or `300,000 tokens`. */
const named = (key: string): string => (key.endsWith('%') ? key : `${grouped(Number(key))} tokens`)

/** Levels' keys as a list the session reads, or `none`. */
const listed = (keys: readonly string[]): string => (keys.length === 0 ? 'none' : keys.map(named).join(', '))

/** Where the window stands, in a few words. */
const standing = (tokens: number, window: number, percent: number | undefined): string =>
  `${percent ?? Math.round((tokens * 100) / window)}% (${grouped(tokens)} of ${grouped(window)} tokens)`

/**
 * The line, in fixed words: only the numbers vary, then the session's own notes for the levels it just passed, each
 * quoted and named as its own.
 */
export function reminderLine(tokens: number, window: number, percent: number | undefined, notes: readonly (readonly [string, string])[] = []): string {
  const said = `self-compact: a polite reminder, in case it slipped your mind: the context window is at ${standing(tokens, window, percent)}. Nothing is required. If the piece you just finished is complete, this could be a good break for compact_after_turn, with keep (what the summary must hold) and resume (the next piece); if you are mid-piece, carry on.`
  return notes.length === 0 ? said : `${said} ${notes.map(([key, note]) => `Your own note at ${named(key)}: ${JSON.stringify(note)}.`).join(' ')}`
}

/** What this load's `compactReminder` sets, from register (configureReminder). */
let current: Reminder = { levels: [] }

/** Token levels already said to be out of this window's reach, in this load, so each is said once. */
const outOfReach = new Set<string>()

/** This load's copy of the conversation's own levels, by the id it was read for: read once, then kept as written. */
let known: { id: string; own: Own | null } | undefined

/** Whether a turn-end read that ran out of time was said in the debug log, in this load: said once. */
let saidSlow = false

/** At register: reads `compactReminder` for this load, and answers what it sets. */
export function configureReminder(raw: unknown): Reminder {
  current = parseReminder(raw)
  outOfReach.clear()
  known = undefined
  saidSlow = false
  return current
}

/** The store key of one conversation's own levels: one key each, so no write rewrites another's entry. */
const keyOf = (id: string): string => `${LEVELS_PREFIX}${id}`

/** The conversation's id, when it is one fit to key the store with; within READ_MS when `bounded`. */
async function conversationId($: EngineInterface, bounded = false): Promise<string | undefined> {
  try {
    const id = bounded ? await within($, $.session.id()) : await $.session.id()
    return typeof id === 'string' && SESSION.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

/** A stored entry read back as levels the parser takes, with notes only for those levels; null when it isn't one. */
function asOwn(value: unknown): Own | null {
  if (typeof value !== 'object' || value === null) return null
  const { levels, notes, at } = value as { levels?: unknown; notes?: unknown; at?: unknown }
  if (!Array.isArray(levels) || levels.length === 0 || levels.length > MAX_LEVELS || !levels.every(key => typeof key === 'string')) return null
  const read = readLevels(levels.join(','))
  if ('problem' in read || read.levels.length > MAX_LEVELS) return null
  const keys = read.levels.map(l => l.key)
  const kept: Record<string, string> = {}
  if (typeof notes === 'object' && notes !== null) {
    for (const [key, note] of Object.entries(notes)) if (keys.includes(key) && typeof note === 'string' && noteProblem(note) === undefined) kept[key] = note
  }
  return { levels: keys, ...(Object.keys(kept).length === 0 ? {} : { notes: kept }), at: typeof at === 'number' ? at : 0 }
}

/**
 * The conversation's own levels: read from the store once per conversation in a load, then kept as written. On the
 * turn-end path (`bounded`), each read is bounded by READ_MS, and one that runs out or fails answers `slow`: that turn
 * end is skipped, said once in the debug log. Undefined when the id can't be read (unbounded).
 */
async function ownLevels($: EngineInterface, bounded = false): Promise<{ id: string; own: Own | null } | 'slow' | undefined> {
  const id = await conversationId($, bounded)
  if (id === undefined) return bounded ? 'slow' : undefined
  if (known?.id === id) return known
  try {
    const stored = bounded ? await within($, $.store.get(keyOf(id)).then(value => ({ value }))) : { value: await $.store.get(keyOf(id)) }
    if (stored === undefined) return 'slow'
    known = { id, own: asOwn(stored.value) }
    return known
  } catch {
    return bounded ? 'slow' : { id, own: null }
  }
}

/** A turn-end read ran out of time, or failed: said once in this load, in the debug log alone. */
function saySlow($: EngineInterface): void {
  if (saidSlow) return
  saidSlow = true
  $.ui.log(`compact reminder: the conversation's id or its own levels weren't read within ${READ_MS / 1000} s at a turn end, so that turn end was skipped (said once).`, { to: 'debug' })
}

/**
 * Writes this conversation's own levels (null: drops them), under its own key. When the conversations' keys pass
 * MAX_CONVERSATIONS, the oldest (by when they were set) are dropped down to KEEP_CONVERSATIONS: the only time any other
 * entry is read, and never at a turn end.
 */
async function writeOwn($: EngineInterface, id: string, own: Own | null): Promise<void> {
  if (own === null) await $.store.delete(keyOf(id))
  else await $.store.set(keyOf(id), own)
  known = { id, own }
  if (own === null) return
  try {
    const keys = (await $.store.keys()).filter(key => key.startsWith(LEVELS_PREFIX) && key !== keyOf(id))
    if (keys.length + 1 <= MAX_CONVERSATIONS) return
    const dated = await Promise.all(keys.map(async key => [key, asOwn(await $.store.get(key))?.at ?? -Infinity] as const))
    dated.sort((a, b) => a[1] - b[1])
    for (const [key] of dated.slice(0, keys.length + 1 - KEEP_CONVERSATIONS)) await $.store.delete(key)
  } catch {
    // The levels are set; only the bound wasn't kept this time.
    $.ui.log(`compact reminder: the store's bound of ${MAX_CONVERSATIONS} conversations wasn't checked or kept after this set; the levels were set.`, { to: 'debug' })
  }
}

/** The levels that stand for this conversation: its own, else the setting's; with its own notes. */
function standingOf(mine: { own: Own | null } | 'slow' | undefined): { levels: readonly Level[]; notes: Record<string, string>; isOwn: boolean } {
  const own = mine === undefined || mine === 'slow' ? null : mine.own
  if (own) {
    const read = readLevels(own.levels.join(','))
    if ('levels' in read) return { levels: read.levels, notes: own.notes ?? {}, isOwn: true }
  }
  return { levels: current.levels, notes: {}, isOwn: false }
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

/** The token levels at or past the window's size: none of them ever reminds in that window. */
const pastWindow = (levels: readonly Level[], window: number): Level[] => levels.filter(l => 'tokens' in l && l.tokens >= window)

/** A token level at or past the window's size never fires in this session: said once, in the debug log alone. */
function sayOutOfReach($: EngineInterface, levels: readonly Level[], window: number): void {
  for (const l of pastWindow(levels, window)) {
    if (outOfReach.has(l.key) || !('tokens' in l)) continue
    outOfReach.add(l.key)
    $.ui.log(`compact reminder: the level ${grouped(l.tokens)} is at or past this window's ${grouped(window)} tokens, so it never reminds in this session.`, { to: 'debug' })
  }
}

/**
 * At a main-loop turn's end the model answered, with no compaction queued: reads the window, keeps the levels it has
 * reached as the ones reminded, and when one of them is new, tells the model once. Off with no levels, the
 * conversation's own or the setting's. While the session moves between conversations, it waits for a later turn end.
 */
export async function remind($: EngineInterface): Promise<void> {
  const mine = await ownLevels($, true)
  // Whose levels stand isn't known this turn end: it is skipped, with no line and no marks changed.
  if (mine === 'slow') {
    saySlow($)
    return
  }
  const { levels, notes } = standingOf(mine)
  if (levels.length === 0) return
  try {
    if ((await moving($, mine?.id)) !== undefined) return
    const { context } = await $.session.usage()
    // No reading yet (a new or just-compacted conversation, until its next response): nothing to compare.
    if (context.tokens === undefined || !(context.window > 0)) return
    sayOutOfReach($, levels, context.window)
    const reached = reachedKeys(levels, context.tokens, context.window)
    const before: readonly string[] = (await $.state.get(reminded)).value ?? []
    if (reached.length === before.length && reached.every(key => before.includes(key))) return
    // Marked before the send, and put back as they were when the line isn't kept, so the next answered turn end
    // tries once more: one try per turn end.
    await $.state.set(reminded, reached.length === 0 ? null : reached)
    const passed = reached.filter(key => !before.includes(key))
    if (passed.length === 0) return
    const said = passed.flatMap(key => {
      const note = notes[key]
      return note === undefined ? [] : [[key, note] as const]
    })
    const sent = await tellModel($, reminderLine(context.tokens, context.window, context.percent, said))
    if (!sent) await $.state.set(reminded, before.length === 0 ? null : [...before])
  } catch {
    $.ui.log("compact reminder: this turn end's check failed; no line was sent.", { to: 'debug' })
  }
}

/** After this plugin's own compaction ran: every level reminds again at its next passing. */
export async function forgetReminded($: EngineInterface): Promise<void> {
  try {
    if ((await $.state.get(reminded)).value) await $.state.set(reminded, null)
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

/**
 * What is wrong with a note: it is one line of the session's own words, at most NOTE_MAX characters, with no control,
 * format, line or paragraph separator character (Unicode Cc, Cf, Zl, Zp: no hidden or reordered text) and no angle
 * bracket (no markup).
 */
function noteProblem(note: string): string | undefined {
  if (note.trim() === '') return 'is empty'
  if (note.length > NOTE_MAX) return `is ${note.length} characters; a note is at most ${NOTE_MAX}`
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(note)) return 'holds a line break, or a control or format character: a note is one line of plain text'
  if (/[<>]/.test(note)) return 'holds an angle bracket: a note is plain text, with no markup'
  return undefined
}

/** The notes for `levels`, by key; or why they can't be taken. */
function readNotes(raw: unknown, levels: readonly Level[]): Record<string, string> | string {
  if (raw === undefined) return {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return '`notes` maps a level, as written in `levels`, to its note, such as {"60%": "write the notes file first"}.'
  const notes: Record<string, string> = {}
  for (const [written, value] of Object.entries(raw)) {
    const read = readLevels(written.trim())
    const key = 'levels' in read && read.levels.length === 1 ? read.levels[0]?.key : undefined
    if (key === undefined || !levels.some(l => l.key === key)) return `the note for ${JSON.stringify(written.slice(0, 24))} names no level in \`levels\`.`
    if (typeof value !== 'string') return `the note for ${named(key)} is not text.`
    const note = value.trim()
    const problem = noteProblem(note)
    if (problem !== undefined) return `the note for ${named(key)} ${problem}.`
    notes[key] = note
  }
  return notes
}

/** The window now: its size, and the tokens in it when there is a reading. */
type Window = { window: number; tokens?: number; percent?: number }

/** The window now, or undefined when it can't be read. */
async function windowNow($: EngineInterface): Promise<Window | undefined> {
  const { context } = await $.session.usage()
  if (!(context.window > 0)) return undefined
  return {
    window: context.window,
    ...(context.tokens === undefined ? {} : { tokens: context.tokens }),
    ...(context.percent === undefined ? {} : { percent: context.percent }),
  }
}

/** Where the window stands, as a sentence. */
const windowSaid = (now: Window | undefined): string =>
  now === undefined
    ? "The window couldn't be read."
    : now.tokens === undefined
      ? 'The window has no reading yet (a new or just-compacted conversation, until its next response).'
      : `The window is at ${standing(now.tokens, now.window, now.percent)}.`

/** The token levels at or past the window's size, as a sentence, or nothing. */
const pastSaid = (levels: readonly Level[], now: Window | undefined): string => {
  const past = now === undefined ? [] : pastWindow(levels, now.window)
  if (now === undefined || past.length === 0) return ''
  return ` At or past this window's ${grouped(now.window)} tokens, so never reminding in this window: ${listed(past.map(l => l.key))}.`
}

/** The notes, as a sentence, or nothing. */
const notesSaid = (notes: Record<string, string>): string => {
  const entries = Object.entries(notes)
  return entries.length === 0 ? '' : ` Notes: ${entries.map(([key, note]) => `${named(key)}: ${JSON.stringify(note)}`).join('; ')}.`
}

/** What markStanding did: the window unread, the marks unwritten, or the levels marked, with the window. */
type Marking = { kind: 'unread' } | { kind: 'unwritten'; now: Window } | { kind: 'done'; marked: string[]; now: Window }

/**
 * The levels changed: the ones the window already stands past are marked reminded, with no line, so only a passing
 * after the change reminds. With no reading yet, nothing is marked; nor when the window can't be read, or the marks
 * can't be written, which the answer says.
 */
async function markStanding($: EngineInterface, levels: readonly Level[]): Promise<Marking> {
  let now: Window | undefined
  try {
    now = await windowNow($)
  } catch {
    now = undefined
  }
  if (now === undefined) return { kind: 'unread' }
  const marked = now.tokens === undefined ? [] : reachedKeys(levels, now.tokens, now.window)
  try {
    await $.state.set(reminded, marked.length === 0 ? null : marked)
  } catch {
    return { kind: 'unwritten', now }
  }
  return { kind: 'done', marked, now }
}

/** What markStanding did, as sentences: the levels marked; or that the window couldn't be read, or the marks written. */
const markedSaid = (done: Marking): string => {
  const follows = 'so no level was marked: one the window already stands past may remind at the next answered turn end.'
  if (done.kind === 'unread') return ` The window couldn't be read, ${follows}`
  if (done.kind === 'unwritten') return ` The marks couldn't be written, ${follows} ${windowSaid(done.now)}`
  return `${done.marked.length === 0 ? '' : ` Already past, so marked reminded with no line: ${listed(done.marked)}.`} ${windowSaid(done.now)}`
}

const MOVING = 'This session is moving between conversations'

/** compact_reminder with no `levels`: what the levels are, where they come from, and which have passed. */
async function status($: EngineInterface): Promise<string> {
  const mine = await ownLevels($)
  if (mine === undefined || mine === 'slow') return "This conversation's id can't be read, so its levels can't be told."
  const lag = await moving($, mine.id)
  if (lag !== undefined) return `${MOVING}, so which conversation's levels stand can't be told yet. ${waitSaid(lag)}`
  const { levels, notes, isOwn } = standingOf(mine)
  const keys = levels.map(l => l.key)
  const from = isOwn
    ? `this conversation's own, set with compact_reminder; the setting's are ${listed(current.levels.map(l => l.key))}`
    : `the compactReminder setting's${current.why === undefined ? '' : ', which is off: it holds something that is not levels'}; this conversation has none of its own`
  const passed = ((await $.state.get(reminded)).value ?? []).filter(key => keys.includes(key))
  let now: Window | undefined
  try {
    now = await windowNow($)
  } catch {
    now = undefined
  }
  const passedSaid = keys.length === 0 ? '' : ` Passed since the last compaction (reminded, or marked when set): ${listed(passed)}.`
  return `Compact reminder levels: ${listed(keys)} (${from}).${passedSaid} ${windowSaid(now)}${pastSaid(levels, now)}${notesSaid(notes)}`
}

/** compact_reminder: sets this conversation's own levels, drops them (`off`), or says where they stand (no `levels`). */
export async function reminderTool($: EngineInterface, input: { levels?: unknown; notes?: unknown }): Promise<{ result: string } | { deny: string }> {
  if (input.levels === undefined) {
    if (input.notes !== undefined) return { deny: 'Notes go with `levels`: give the levels, and a note for each level you want one for.' }
    return { result: await status($) }
  }
  if (typeof input.levels !== 'string') return { deny: '`levels` is text, such as "40%, 70%" or "300k", or "off".' }
  const text = input.levels.trim()
  const off = text === '' || /^off$/i.test(text)
  if (off && input.notes !== undefined) return { deny: 'Notes go with levels; `off` takes none.' }
  if (text.length > MAX_TEXT) return { deny: `Nothing was set: the levels are ${text.length} characters; at most ${MAX_TEXT}.` }
  let read: { levels: Level[] } | undefined
  let notes: Record<string, string> = {}
  if (!off) {
    const parsed = readLevels(text)
    if ('problem' in parsed) return { deny: `Nothing was set: ${parsed.problem} ${HOW} Or "off", to go back to the setting.` }
    if (parsed.levels.length > MAX_LEVELS) return { deny: `Nothing was set: at most ${MAX_LEVELS} levels; this list has ${parsed.levels.length}.` }
    const given = readNotes(input.notes, parsed.levels)
    if (typeof given === 'string') return { deny: `Nothing was set: ${given}` }
    read = parsed
    notes = given
  }
  const id = await conversationId($)
  if (id === undefined) return { deny: "self-compact: this conversation's id couldn't be read, so nothing was set." }
  const lag = await moving($, id)
  if (lag !== undefined) return { deny: `${MOVING}; nothing was set. ${waitSaid(lag)}` }
  if (read === undefined) {
    await writeOwn($, id, null)
    const back = current.levels.length === 0 ? 'none, so this conversation gets no reminders' : listed(current.levels.map(l => l.key))
    $.ui.toast(`Compact reminder: this conversation follows the setting again (${current.levels.length === 0 ? 'none' : listed(current.levels.map(l => l.key))}).`)
    const done = await markStanding($, current.levels)
    return { result: `This conversation's own levels are dropped: the compactReminder setting's stand again (${back}).${markedSaid(done)}` }
  }
  const own: Own = { levels: read.levels.map(l => l.key), ...(Object.keys(notes).length === 0 ? {} : { notes }), at: await $.clock.now() }
  await writeOwn($, id, own)
  $.ui.toast(`Compact reminder: this conversation's own levels are ${listed(own.levels)}.`)
  const done = await markStanding($, read.levels)
  return {
    result: `This conversation's compact reminder levels are now ${listed(own.levels)}, in place of the compactReminder setting's (${listed(current.levels.map(l => l.key))}). They last across a compaction, a restart and a resume of this conversation; "off" goes back to the setting.${markedSaid(done)}${pastSaid(read.levels, done.kind === 'unread' ? undefined : done.now)}${notesSaid(own.notes ?? {})}`,
  }
}
