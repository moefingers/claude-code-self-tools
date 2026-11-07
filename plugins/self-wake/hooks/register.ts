// A session wakes itself later: `minutes` after the current turn ends, it sends itself
// "Wake-up: <note>" as a prompt, a turn of its own. The model calls wake_after; the wake is armed
// once the turn ends with an answer and counts from there, and an interrupted turn drops it (a
// wake armed before stands). One wake at a time: a new one replaces the one before it, and says
// so. cancel_wake takes it back at once. Only the main conversation wakes this way, never a
// subagent.
//
// The armed wake lives in $.state, which survives a reload of this plugin; its timer doesn't. So
// session.start arms it again for the time left, or fires it at once if that has passed. Firing
// takes the wake with a compare-and-set on its version, so it is sent once.
//
// The wake marker (S10w's read, for self-switch and the coordinator): %LOCALAPPDATA%\claude-self-tools\
// wake\<conversation>.json = { v: 1, armed, due?, at }, `armed` true only while this process holds a
// timer for that conversation's wake-up. Written at the start of each conversation this process holds
// (session.start, and each classic SessionStart by its event's id: a fork's writes its own marker and
// moves nothing, by the rule self-switch reads the same id by, movesConversation), when a wake-up is armed or
// replaced, when it fires, and when it is cancelled; and for the conversation an in-place /resume or
// /clear left, which no timer of this process holds any more (unless it holds its wake-up still). Each
// write replaces the file whole. The path is built from the conversation's id by the shared machine
// code (wakePath), which refuses anything but a session id. A wake-up keeps the conversation it was
// armed in, in $.state with it, so a reload arms it again for that one. The armed marker is awaited,
// and written once more when it fails: a marker left saying none is armed would let a switch or a go
// drop the wake-up. Failing twice, it is removed (a fixed script: a plugin can't delete a file), which
// reads as unknown and holds, and a toast says so; if it can't be removed either, the toast says a
// switch may not see the wake-up.
import type { EngineInterface, Register, Timer } from 'claude-code'
import type { Wake } from '../types'
import { idLag, isSafeFolder, movesConversation, powershellPath, removeWakeMarker, SESSION_ID, stateFolder, SYSTEM_ROOT, wakeMarker, wakePath } from './machine'
import { configureUpdateCheck, loadUpdateCheck, withUpdateNotice } from './update-check'

const queued = { plugin: 'self-wake', key: 'queued' } as const
const armed = { plugin: 'self-wake', key: 'armed' } as const

const MINUTE = 60 * 1000
const MIN_MINUTES = 1
const MAX_MINUTES = 1440

const WAKE_DESCRIPTION = [
  'Wakes this session later: `minutes` after the current turn ends, the session sends itself "Wake-up: <note>", which starts a turn of its own.',
  'Call it when the next step has to wait for something that takes time (a deploy, a long job, a check that reports later) and nothing will tell you when it is done, so you can check back without the user prompting you.',
  'Not for waiting within a turn, and not when a message or notification will arrive on its own.',
  '`note` is what to check or do on waking, with where its details are.',
  'One wake-up at a time: a new one replaces the one before. A wake-up lasts as long as the session.',
  'End the turn after calling it; the wait starts once your answer is shown.',
].join(' ')

const CANCEL_DESCRIPTION =
  'Cancels the wake-up set with wake_after, if there is one. Call it when what you were waiting for has arrived or no longer matters.'

const SUBAGENT =
  "A subagent can't set or cancel the session's wake-ups. Finish your piece and return its result, saying what to check later and when: the main session can set the wake-up."

/** This module's timer for the armed wake; a reload drops it, and session.start arms a new one. */
let timer: Timer | undefined

/**
 * The conversation this process holds: each main-loop classic SessionStart's own id, of a startup, a
 * resume or a clear (`$.session.id()` may still read the one before at an in-place resume), and at
 * session.start until one comes. A fork's names nothing here: the foreground stays.
 */
let current: string | undefined

/** When the SessionStart that named `current` came, by the engine's clock; undefined once it was read from `$.session.id()`. */
let currentAt: number | undefined

/** The wake-up this module's timer holds: the conversation it was armed in, its id, and when it is due. */
let held: { conversation: string | undefined; readonly id: string; readonly dueAt: number } | undefined

/** Whether a failed marker write was logged already: once per process. */
let warned = false

/**
 * The conversation this process holds now, or undefined when it can't be read: by the rule self-switch
 * holds a switch by (idLag). The SessionStart's id stands while `$.session.id()` lags it; past that the
 * id is the conversation, from here (a /branch, whose fork's SessionStart names nothing here).
 */
async function conversation($: EngineInterface): Promise<string | undefined> {
  let own: string | undefined
  try {
    const id = await $.session.id()
    own = SESSION_ID.test(id) ? id : undefined
  } catch {
    own = undefined
  }
  if (current === undefined) return own
  if (own === undefined) return current
  if (idLag(current, currentAt, own, await $.clock.now()) === 'stale') {
    current = own
    currentAt = undefined
  }
  return current
}

/**
 * Writes conversation `id`'s wake marker: armed, with when it is due, while this module's timer holds
 * that conversation's wake-up; else not armed. Whether it was written (or there is none to write: no
 * conversation, no state folder); never throws. A write that fails is logged once per process. It
 * leaves the marker before it in place, which a switch or a go reads as it stands: for the armed
 * marker, arm() tries again, then removes it (unmark).
 */
async function mark($: EngineInterface, id: string | undefined): Promise<boolean> {
  if (id === undefined || !SESSION_ID.test(id)) return true
  // No %LOCALAPPDATA% (off Windows), or one that can't be read: there are no markers here at all.
  let local: string | undefined
  try {
    local = await $.env.get('LOCALAPPDATA')
  } catch {
    return true
  }
  if (!isSafeFolder(local)) return true
  try {
    const path = wakePath(stateFolder(local), id)
    const armedHere = held !== undefined && held.conversation === id ? held : undefined
    await $.fs.write(path, wakeMarker({ armed: armedHere !== undefined, ...(armedHere === undefined ? {} : { due: armedHere.dueAt }), at: await $.clock.now() }))
    return true
  } catch (err) {
    if (!warned) {
      warned = true
      try {
        $.ui.log(`self-wake: the wake marker for ${id} wasn't written (${err instanceof Error ? err.message : String(err)}); the marker there before, if any, still stands.`)
      } catch {
        // Nowhere to say it.
      }
    }
    return false
  }
}

/**
 * The armed marker for conversation `id` couldn't be written, twice, and the one in place may say no
 * wake-up is armed, which a switch or a go would read as none, dropping this one. So it is removed, by
 * the one fixed script, run from the machine code (removeWakeMarker; a plugin can't delete a file): with self-wake on and no
 * marker, the wake-up reads as unknown, which holds. A toast and the log say which came of it.
 */
async function unmark($: EngineInterface, id: string): Promise<void> {
  let removed = false
  try {
    const root = await $.env.get('SystemRoot')
    const local = await $.env.get('LOCALAPPDATA')
    if (root !== undefined && SYSTEM_ROOT.test(root) && isSafeFolder(local)) {
      removed = await removeWakeMarker($, powershellPath(root), stateFolder(local), id)
    }
  } catch {
    removed = false
  }
  const said = removed
    ? "Wake-up set, but its marker couldn't be written, so it was removed: a switch or a go here reads this wake-up as unknown, and holds, until it fires or is cancelled."
    : "Wake-up set, but its marker couldn't be written or removed: a switch or a go here may not see this wake-up. Cancel it (cancel_wake) before switching away, or set it again."
  try {
    $.ui.toast(said)
    $.ui.log(`self-wake: ${said} (conversation ${id})`)
  } catch {
    // Nowhere to say it.
  }
}

/** Trimmed text, or undefined when it is not a string or is blank. */
function text(raw: unknown): string | undefined {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed === '' ? undefined : trimmed
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/** How long until `dueAt`, in whole minutes, at least one. */
const dueIn = (dueAt: number, now: number): string => plural(Math.max(1, Math.ceil((dueAt - now) / MINUTE)), 'minute')

/** The status line while a wake is armed, its note cut short. */
const pinned = (note: string): string => `wake-up pending: ${note.length > 60 ? `${note.slice(0, 59)}…` : note}`

async function fire($: EngineInterface, id: string): Promise<void> {
  // The timer has run: whatever comes of it, this process holds no wake-up for that conversation now.
  const was = held !== undefined && held.id === id ? held.conversation : undefined
  if (held !== undefined && held.id === id) held = undefined
  const stored = await $.state.get(armed)
  if (stored.value?.id !== id) {
    await mark($, was)
    return
  }
  const taken = await $.state.set(armed, null, { ifVersion: stored.version })
  await mark($, was)
  if (!taken.isSet) return
  $.ui.status(undefined)
  try {
    const sent = await $.prompt.submit({ text: `Wake-up: ${stored.value.note}` })
    if (sent.drop !== undefined) $.ui.toast(`Wake-up not sent: ${sent.drop}`)
  } catch {
    $.ui.toast('Wake-up not sent; the session waits for the next message.')
  }
}

/**
 * Starts this module's timer for `wake`, in place of any it had; one already due fires at once. The
 * wake-up belongs to `conversation`, whose marker then says armed (and the one a replaced wake-up
 * belonged to, if another, not). The armed marker is awaited, so a switch or a go queued in the same
 * turn reads it, and written once more if that fails; failing again, it is removed (unmark), awaited
 * too: a switch's read right after must not find the stale marker saying none.
 */
async function arm($: EngineInterface, wake: Wake, now: number, conversationOf: string | undefined): Promise<void> {
  timer?.cancel()
  const replaced = held?.conversation
  held = { conversation: conversationOf, id: wake.id, dueAt: wake.dueAt }
  timer = $.clock.after(Math.max(0, wake.dueAt - now), () => void fire($, wake.id))
  $.ui.status(pinned(wake.note))
  if (!(await mark($, conversationOf)) && !(await mark($, conversationOf)) && conversationOf !== undefined) await unmark($, conversationOf)
  if (replaced !== undefined && replaced !== conversationOf) void mark($, replaced)
}

/** The conversation a stored wake-up belongs to: its own, kept with it; else (one armed before 0.2.0) `here`. */
const ownerOf = (wake: Wake, here: string | undefined): string | undefined => (typeof wake.conversation === 'string' && SESSION_ID.test(wake.conversation) ? wake.conversation : here)

export const register: Register = (on, options) => {
  configureUpdateCheck('self-wake', options)

  // First, so it is outermost on this plugin's tools: it sees each answer, and adds the update
  // notice when one is due. It never waits on the check; see update-check.ts.
  on('tool.call', { tool: /^mcp__self-wake__/ }, async ($, e, next) => withUpdateNotice($, e, await next(e))).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'wake_after',
      description: WAKE_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          minutes: {
            type: 'number',
            description: 'How long after this turn ends, in minutes: 1 to 1440 (a day); a number outside that is brought within it.',
          },
          note: { type: 'string', description: 'What to check or do on waking, and where its details are.' },
        },
        required: ['minutes', 'note'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'cancel_wake',
      description: CANCEL_DESCRIPTION,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      isDeferred: false,
    })
    // After a reload: the wake is still in $.state, its timer gone. It is armed again for the
    // conversation it was armed in, kept with it: never the one a later SessionStart names.
    const { value } = await $.state.get(armed)
    const here = await conversation($)
    if (value) await arm($, value, await $.clock.now(), ownerOf(value, here))
    // The marker of the conversation this process starts in: armed or not, as its timer says.
    else void mark($, here)
    loadUpdateCheck($)
    return started
  })

  // Each conversation this process comes to holds its marker, by the event's own id: at a startup, a
  // resume or a clear. A timer armed at session.start belongs to the conversation its wake-up names (a
  // reload's first SessionStart is a move to another, never the conversation it was armed in), or, when
  // none could be read then, to the first one named here. An
  // in-place move leaves a conversation whose wake-up no timer of this process holds any more: its
  // marker says so (unless the timer still holds it: a move back before it is due fires it there).
  // A fork's event (the /fork background copy, a conversation moved to the background) writes the
  // fork's marker and moves nothing: the foreground stays where it was, and a wake-up set there is
  // that conversation's, or a switch from it would read none and drop the wake-up.
  // It answers what the chain beneath answered, always, and quickly (the markers are written after,
  // unawaited); a failure here passes the start through unchanged (the .catch).
  on('classic.SessionStart', async ($, e, next) => {
    const done = await next(e)
    if (e.agent_id !== undefined || typeof e.session_id !== 'string' || !SESSION_ID.test(e.session_id)) return done
    if (!movesConversation(e.source)) {
      void mark($, e.session_id)
      return done
    }
    const previous = current
    current = e.session_id
    currentAt = await $.clock.now()
    if (previous === undefined && held !== undefined && held.conversation === undefined) held.conversation = current
    void mark($, current)
    if (previous !== undefined && previous !== current) void mark($, previous)
    return done
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__self-wake__wake_after' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: SUBAGENT }
    const input = e as { minutes?: unknown; note?: unknown }
    const asked = typeof input.minutes === 'number' ? input.minutes : Number(text(input.minutes) ?? Number.NaN)
    if (!Number.isFinite(asked)) return { deny: '`minutes` is a number from 1 to 1440.' }
    const note = text(input.note)
    if (note === undefined) return { deny: 'Say what to wake up to (`note`).' }
    const minutes = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, asked))
    const [before, earlier, now] = await Promise.all([$.state.get(queued), $.state.get(armed), $.clock.now()])
    await $.state.set(queued, { minutes, note })
    $.ui.status(`wake-up queued for when this turn ends: ${note.length > 40 ? `${note.slice(0, 39)}…` : note}`)
    const clamped = minutes === asked ? '' : ` (${asked} is outside 1 to 1440)`
    const replaces = before.value
      ? ` It replaces the wake-up queued earlier this turn ("${before.value.note}").`
      : earlier.value
        ? ` It replaces the wake-up due in ${dueIn(earlier.value.dueAt, now)} ("${earlier.value.note}").`
        : ''
    return {
      result: `Queued: ${plural(minutes, 'minute')} after this turn ends${clamped}, the session sends itself "Wake-up: ${note}".${replaces}`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-wake: queuing the wake-up failed; nothing is queued.' }))

  on('tool.call', { tool: 'mcp__self-wake__cancel_wake' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: SUBAGENT }
    const [before, earlier, now] = await Promise.all([$.state.get(queued), $.state.get(armed), $.clock.now()])
    await $.state.set(queued, null)
    await $.state.set(armed, null)
    timer?.cancel()
    timer = undefined
    const was = held?.conversation
    held = undefined
    // Cancelled: the marker says no wake-up is armed, for this conversation and the one it was armed in.
    const here = await conversation($)
    await mark($, here)
    if (was !== undefined && was !== here) await mark($, was)
    $.ui.status(undefined)
    const gone = [
      ...(earlier.value ? [`the wake-up due in ${dueIn(earlier.value.dueAt, now)} ("${earlier.value.note}")`] : []),
      ...(before.value ? [`the wake-up queued this turn ("${before.value.note}")`] : []),
    ]
    return { result: gone.length === 0 ? 'No wake-up was set; nothing to cancel.' : `Cancelled ${gone.join(' and ')}.` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-wake: cancelling failed; a wake-up may still be set.' }))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const { value } = await $.state.get(queued)
    if (!value) return done
    await $.state.set(queued, null)
    if (e.isAborted || e.reason !== 'answer') {
      const { value: standing } = await $.state.get(armed)
      $.ui.status(standing ? pinned(standing.note) : undefined)
      $.ui.toast(`Wake-up not set: the turn didn't finish.${standing ? ' The one set before stands.' : ''}`)
      return done
    }
    const now = await $.clock.now()
    const here = await conversation($)
    const wake: Wake = {
      id: `${now}-${Math.random().toString(36).slice(2, 10)}`,
      dueAt: now + value.minutes * MINUTE,
      note: value.note,
      ...(here === undefined ? {} : { conversation: here }),
    }
    await $.state.set(armed, wake)
    await arm($, wake, now, here)
    return done
  })
}
