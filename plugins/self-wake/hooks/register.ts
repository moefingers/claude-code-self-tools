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
import type { EngineInterface, Register, Timer } from 'claude-code'
import type { Wake } from '../types'

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
  const held = await $.state.get(armed)
  if (held.value?.id !== id) return
  const taken = await $.state.set(armed, null, { ifVersion: held.version })
  if (!taken.isSet) return
  $.ui.status(undefined)
  try {
    const sent = await $.prompt.submit({ text: `Wake-up: ${held.value.note}` })
    if (sent.drop !== undefined) $.ui.toast(`Wake-up not sent: ${sent.drop}`)
  } catch {
    $.ui.toast('Wake-up not sent; the session waits for the next message.')
  }
}

/** Starts this module's timer for `wake`, in place of any it had; one already due fires at once. */
function arm($: EngineInterface, wake: Wake, now: number): void {
  timer?.cancel()
  timer = $.clock.after(Math.max(0, wake.dueAt - now), () => void fire($, wake.id))
  $.ui.status(pinned(wake.note))
}

export const register: Register = on => {
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
    // After a reload: the wake is still in $.state, its timer gone.
    const { value } = await $.state.get(armed)
    if (value) arm($, value, await $.clock.now())
    return started
  })

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
    const wake: Wake = {
      id: `${now}-${Math.random().toString(36).slice(2, 10)}`,
      dueAt: now + value.minutes * MINUTE,
      note: value.note,
    }
    await $.state.set(armed, wake)
    arm($, wake, now)
    return done
  })
}
