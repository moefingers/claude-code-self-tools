// Claude Code empties a plugin's `$.state` at an in-process /clear or /resume, and no session.start follows
// (claude-code-self-tools#24); a /resume may bring back what `$.state` held for that conversation before.
// The armed wake-up lives in the module, loaded once, and stands over `$.state` from then on. A move decides
// what becomes of it: a /clear carries it on to the new conversation (its marker armed there), a /resume or a
// switch to another conversation drops it and says so, and a /resume of its own conversation keeps it. A
// timer that loses the take looks again, and gives up after three misses, saying so.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { exitBlockers, exitWake, readWakeMarker, type WakeMarker, wakePath } from '../hooks/machine'

const WAKE = 'mcp__self-wake__wake_after'
const CANCEL = 'mcp__self-wake__cancel_wake'
const MINUTE = 60 * 1000
/** The conversations this process holds in turn. */
const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'
const C = '00000000-0000-0000-0000-00000000000c'
const D = '00000000-0000-0000-0000-00000000000d'
/** The branch a /branch forks off A. */
const F = '00000000-0000-0000-0000-00000000000f'
const LOCAL = 'C:\\Users\\u\\AppData\\Local'
const STATE = `${LOCAL}\\claude-self-tools`
const ARMED = 'self-wake/armed'

type Options = {
  /** How many compare-and-sets on the armed wake-up lose (another write landed first): the first ones, then they land. */
  conflicts?: number
}

/** The engine beneath the plugin, its `$.state` the test's own, so a test can empty it as Claude Code does. */
function engine(on: On, { conflicts = 0 }: Options = {}) {
  const state = new Map<string, { value: unknown; version: number }>()
  const world = { id: A, conflicts, stateFails: false }
  const prompts: string[] = []
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const writes: { path: string; text: string }[] = []
  const clock = mock.clock(on)
  const session = mock.session(on)
  mock.env(on, { LOCALAPPDATA: LOCAL })
  on('state.get', (_, e) => (world.stateFails ? { deny: 'the session state is being swapped' } : { value: state.get(`${e.plugin}/${e.key}`) ?? { value: undefined, version: 0 } }))
  on('state.set', (_, e) => {
    const key = `${e.plugin}/${e.key}`
    const held = state.get(key) ?? { value: undefined, version: 0 }
    if (world.stateFails) return { deny: 'the session state is being swapped' }
    if (e.ifVersion !== undefined && world.conflicts > 0) {
      world.conflicts -= 1
      return { value: { isSet: false, version: held.version } }
    }
    if (e.ifVersion !== undefined && e.ifVersion !== held.version) return { value: { isSet: false, version: held.version } }
    const version = held.version + 1
    state.set(key, { value: JSON.parse(JSON.stringify(e.value ?? null)), version })
    return { value: { isSet: true, version } }
  })
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: world.id }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__self-wake__${e.name}` } }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('classic.SessionStart', () => ({}))
  on('turn.complete', () => ({ text: 'done' }))
  /** Claude Code at an in-process /clear or /resume: every value of the plugin's `$.state` gone, and no session.start. */
  const wipe = () => state.clear()
  /** The markers written for conversation `id`, parsed, oldest first. */
  const markers = (id: string): (WakeMarker | undefined)[] => writes.filter(w => w.path === wakePath(STATE, id)).map(w => readWakeMarker(w.text))
  /** The armed wake-up as `$.state` holds it now. */
  const stored = () => state.get(ARMED)?.value as { id?: string; note?: string; conversation?: string } | null | undefined
  return { state, world, prompts, toasts, statuses, clock, session, wipe, markers, stored }
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' } as const
const DROPPED_TOAST = /^Wake-up dropped: it was set in another conversation \(due \d\d:\d\d: "check the deploy"\), and this session moved\.$/
/** The note the model in the conversation now held reads: the drop said, nothing of the other conversation's task. */
const DROPPED_NOTE = 'self-wake: a wake-up from another conversation was dropped when this session moved here.'
/** The rows the model was handed, as text. */
const notes = (appended: unknown) => JSON.stringify(appended)

/** A wake-up `minutes` after this turn, armed in conversation A. */
async function armed($: Engine, minutes: number, note: string) {
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'startup', session_id: A })
  await $.tool.call({ tool: WAKE, minutes, note })
  await $.turn.complete({ ...answered, turnId: 't1' })
}

/** What self-restart's and self-exit's pre-check makes of a marker, as readWake and exitWake read it: the blockers. */
const preCheck = (marker: WakeMarker | undefined) =>
  exitBlockers({ crons: [], agents: [], wake: exitWake(marker?.armed === true && marker.due !== undefined ? { wake: 'pending', due: marker.due } : { wake: 'none', why: 'no wake-up is armed' }) })

test('a /clear carries the wake-up on: re-keyed to the new conversation, its marker armed there and not in the one left, so an exit there is held, and it fires there', async ($, on) => {
  const w = engine(on)
  await armed($, 5, 'check the deploy')
  await w.clock.settle()
  expect(w.markers(A).at(-1)?.armed).toBe(true)

  // The /clear: the state emptied, no session.start, then the SessionStart of the conversation it starts.
  w.wipe()
  await $.classic.SessionStart({ source: 'clear', session_id: C })
  await w.clock.settle()
  expect(w.stored()?.conversation).toBe(C)
  expect(w.stored()?.note).toBe('check the deploy')
  expect(w.markers(C).at(-1)?.armed).toBe(true)
  expect(w.markers(A).at(-1)?.armed).toBe(false)
  // A restart's or an exit's pre-check in C reads C's marker, and refuses while the wake-up is pending.
  expect(preCheck(w.markers(C).at(-1)).map(b => b.kind)).toEqual(['wake'])
  expect(preCheck(w.markers(A).at(-1))).toEqual([])

  w.world.id = C
  await w.clock.advance(6 * MINUTE)
  expect(w.prompts).toEqual(['Wake-up: check the deploy'])
  expect(w.markers(C).at(-1)?.armed).toBe(false)
})

test('a /resume to another conversation drops the wake-up: a toast, a note in the conversation now held, both markers none, and nothing fires later', async ($, on) => {
  const w = engine(on)
  await armed($, 5, 'check the deploy')
  w.wipe()
  await $.classic.SessionStart({ source: 'resume', session_id: B })
  await w.clock.settle()
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(DROPPED_TOAST)
  // B's model reads that a wake-up was dropped, and nothing of A's task: no note text, no invitation.
  expect(notes(w.session.appended())).toContain(DROPPED_NOTE)
  expect(notes(w.session.appended())).not.toContain('check the deploy')
  expect(notes(w.session.appended())).not.toContain('Set it again')
  expect(w.stored()).toBeNull()
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(w.markers(A).at(-1)?.armed).toBe(false)
  expect(w.markers(B).at(-1)?.armed).toBe(false)

  w.world.id = B
  await w.clock.advance(60 * MINUTE)
  expect(w.prompts).toEqual([])
  // Never waiting hidden for a move back: back in A, there is none.
  await $.classic.SessionStart({ source: 'resume', session_id: A })
  await w.clock.advance(60 * MINUTE)
  expect(w.prompts).toEqual([])
  expect((await $.tool.call({ tool: CANCEL })).result).toBe('No wake-up was set; nothing to cancel.')
})

test("an in-place switch to D (its SessionStart while $.session.id() still reads A, and $.state still A's) drops it too", async ($, on) => {
  const w = engine(on)
  await armed($, 5, 'check the deploy')
  await $.classic.SessionStart({ source: 'resume', session_id: D })
  await w.clock.settle()
  expect(w.toasts[0]).toMatch(DROPPED_TOAST)
  expect(notes(w.session.appended())).toContain(DROPPED_NOTE)
  expect(notes(w.session.appended())).not.toContain('check the deploy')
  expect(w.stored()).toBeNull()
  expect(w.markers(A).at(-1)?.armed).toBe(false)
  expect(w.markers(D).at(-1)?.armed).toBe(false)
  // The swap to D's state comes after; nothing comes back with it.
  w.wipe()
  w.world.id = D
  await w.clock.advance(60 * MINUTE)
  expect(w.prompts).toEqual([])
})

test('a /resume of the conversation the wake-up belongs to keeps it, put back after the wipe, and it fires once', async ($, on) => {
  const w = engine(on)
  await armed($, 2, 'check the job')
  w.wipe()
  await $.classic.SessionStart({ source: 'resume', session_id: A })
  expect(w.stored()?.note).toBe('check the job')
  expect(w.toasts).toEqual([])
  await w.clock.advance(3 * MINUTE)
  expect(w.prompts).toEqual(['Wake-up: check the job'])
  await w.clock.advance(60 * MINUTE)
  expect(w.prompts).toHaveLength(1)
})

test("a /clear whose wipe lands after its SessionStart: the timer goes by the module's copy, and sends once", async ($, on) => {
  const w = engine(on)
  await armed($, 2, 'check the job')
  await $.classic.SessionStart({ source: 'clear', session_id: C })
  w.wipe()
  await w.clock.advance(3 * MINUTE)
  expect(w.prompts).toEqual(['Wake-up: check the job'])
  expect(w.statuses.at(-1)).toBeUndefined()
  await w.clock.advance(60 * MINUTE)
  expect(w.prompts).toHaveLength(1)
})

test('after a wipe, wake_after and cancel_wake still see the wake-up: the replace is said, the cancel takes it, and nothing fires', async ($, on) => {
  const w = engine(on)
  await armed($, 10, 'first')
  w.wipe()
  const replacing = await $.tool.call({ tool: WAKE, minutes: 5, note: 'second' })
  expect(replacing.result).toMatch(/It replaces the wake-up due in 10 minutes \("first"\)\.$/)
  // The read that found it empty put it back.
  expect(w.stored()?.note).toBe('first')
  w.wipe()
  const cancelled = await $.tool.call({ tool: CANCEL })
  expect(cancelled.result).toBe('Cancelled the wake-up due in 10 minutes ("first").')
  await w.clock.advance(20 * MINUTE)
  expect(w.prompts).toEqual([])
})

test('a move back to a conversation whose stale state still holds a wake-up that already fired: the module stands, and it never comes back', async ($, on) => {
  const w = engine(on)
  await armed($, 2, 'check the deploy')
  const stale = w.stored()
  await w.clock.advance(3 * MINUTE)
  expect(w.prompts).toEqual(['Wake-up: check the deploy'])
  // A /resume back to A brings back what $.state held for it before the wake-up fired.
  w.state.set(ARMED, { value: stale, version: 1 })
  await $.classic.SessionStart({ source: 'resume', session_id: A })
  expect(w.stored()).toBeNull()
  expect((await $.tool.call({ tool: CANCEL })).result).toBe('No wake-up was set; nothing to cancel.')
  await w.clock.advance(60 * MINUTE)
  expect(w.prompts).toEqual(['Wake-up: check the deploy'])
})

test('a timer that loses the take keeps the wake-up armed and pinned, looks again a second later, and sends once', async ($, on) => {
  const w = engine(on, { conflicts: 1 })
  await armed($, 2, 'check the deploy')
  await w.clock.advance(2 * MINUTE)
  // Lost once: still armed, in the module and in $.state, the status line still pinned.
  expect(w.prompts).toEqual([])
  expect(w.stored()?.note).toBe('check the deploy')
  expect(w.statuses.at(-1)).toBe('wake-up pending: check the deploy')
  await w.clock.advance(1000)
  expect(w.prompts).toEqual(['Wake-up: check the deploy'])
  expect(w.statuses.at(-1)).toBeUndefined()
  await w.clock.advance(60 * MINUTE)
  expect(w.prompts).toHaveLength(1)
})

test('a timer that loses every take drops the wake-up, says so, and clears the status line', async ($, on) => {
  const w = engine(on, { conflicts: 99 })
  await armed($, 2, 'check the deploy')
  expect(w.statuses.at(-1)).toBe('wake-up pending: check the deploy')
  await w.clock.advance(3 * MINUTE)
  expect(w.prompts).toEqual([])
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(w.toasts).toEqual(["Wake-up not sent: it couldn't be taken from session state (another write came first, 3 times), so it is dropped."])
  expect(JSON.stringify(w.session.appended())).toContain('self-wake: your wake-up (\\"check the deploy\\") wasn\'t sent')
  expect(w.stored()).toBeNull()
})

test('a SessionStart that finds $.state as the module has it writes nothing there: the put-back is only for a $.state that reads otherwise', async ($, on) => {
  const w = engine(on)
  await armed($, 5, 'check the deploy')
  const before = w.state.get(ARMED)?.version
  await $.classic.SessionStart({ source: 'resume', session_id: A })
  expect(w.state.get(ARMED)?.version).toBe(before)
  // Emptied, it is written back.
  w.wipe()
  await $.classic.SessionStart({ source: 'resume', session_id: A })
  expect(w.stored()?.note).toBe('check the deploy')
})

test("a /branch carries the wake-up to the fork once $.session.id() reads it past its lag: F's marker armed and A's not, so a restart's pre-check in F holds, and it fires there", async ($, on) => {
  const w = engine(on)
  await armed($, 5, 'check the deploy')
  await w.clock.settle()
  expect(w.markers(A).at(-1)?.armed).toBe(true)
  // The fork's SessionStart names F and moves nothing here; the id reads F from then on.
  await $.classic.SessionStart({ source: 'fork', session_id: F })
  w.world.id = F
  await w.clock.advance(17_000)
  expect(w.stored()?.conversation).toBe(F)
  expect(w.markers(F).at(-1)?.armed).toBe(true)
  expect(w.markers(A).at(-1)?.armed).toBe(false)
  expect(preCheck(w.markers(F).at(-1)).map(b => b.kind)).toEqual(['wake'])
  await w.clock.advance(5 * MINUTE)
  expect(w.prompts).toEqual(['Wake-up: check the deploy'])
})

test("a /fork's background copy leaves the wake-up where it was: the id still reads A, and A's marker stays armed", async ($, on) => {
  const w = engine(on)
  await armed($, 5, 'check the deploy')
  await $.classic.SessionStart({ source: 'fork', session_id: F })
  await w.clock.advance(17_000)
  expect(w.stored()?.conversation).toBe(A)
  expect(w.markers(A).at(-1)?.armed).toBe(true)
  expect(w.markers(F).at(-1)?.armed).toBe(false)
})

test("the drop is decided by the module's copy: a /resume to B whose $.state can't be read still drops the wake-up, and says so", async ($, on) => {
  const w = engine(on)
  await armed($, 5, 'check the deploy')
  w.world.stateFails = true
  await $.classic.SessionStart({ source: 'resume', session_id: B })
  expect(w.toasts[0]).toMatch(DROPPED_TOAST)
  expect(notes(w.session.appended())).toContain(DROPPED_NOTE)
  w.world.stateFails = false
  w.world.id = B
  await w.clock.advance(60 * MINUTE)
  expect(w.prompts).toEqual([])
})
