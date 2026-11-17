// #53: where Claude Code's built-in guard loads (managed settings, or a Team or Enterprise login), a person's plugin's
// classic.SessionStart never runs, so nothing named the conversation an in-process /clear or /resume moved to: a
// wake-up set before a /resume fired into an unrelated task. Its partner (hooks/classic.ts) does that hook's work there
// instead: session.end says a move began, and the first read of `$.session.id()` as another conversation takes it up,
// with follow's rule. Where the classic SessionStart runs, it does the work as before, and the partner nothing.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { readWakeMarker, type WakeMarker, wakePath } from '../hooks/machine'

const WAKE = 'mcp__self-wake__wake_after'
const MINUTE = 60 * 1000
/** The conversations this process holds in turn. */
const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'
const C = '00000000-0000-0000-0000-00000000000c'
const LOCAL = 'C:\\Users\\u\\AppData\\Local'
const STATE = `${LOCAL}\\claude-self-tools`
const ARMED = 'self-wake/armed'
/** How long the partner waits for a classic hook at a start. */
const GRACE = 5000
const DROPPED_TOAST = /^Wake-up dropped: it was set in another conversation \(due \d\d:\d\d: "check the deploy"\), and this session moved\.$/
const DROPPED_NOTE = 'self-wake: a wake-up from another conversation was dropped when this session moved here.'

/** The engine beneath the plugin, its `$.state` the test's own, so a test can empty it as Claude Code does. */
function engine(on: On, kept: Record<string, unknown> = {}) {
  const state = new Map<string, { value: unknown; version: number }>(Object.entries(kept).map(([key, value]) => [key, { value, version: 1 }]))
  const world = { id: A }
  const prompts: string[] = []
  const toasts: string[] = []
  const writes: { path: string; text: string }[] = []
  const clock = mock.clock(on)
  const session = mock.session(on)
  mock.env(on, { LOCALAPPDATA: LOCAL })
  on('state.get', (_, e) => ({ value: state.get(`${e.plugin}/${e.key}`) ?? { value: undefined, version: 0 } }))
  on('state.set', (_, e) => {
    const key = `${e.plugin}/${e.key}`
    const held = state.get(key) ?? { value: undefined, version: 0 }
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
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: world.id }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__self-wake__${e.name}` } }))
  on('ui.status', () => ({ value: undefined }))
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
  /** Claude Code at an in-process /clear or /resume: every value of the plugin's `$.state` gone. */
  const wipe = () => state.clear()
  /** The markers written for conversation `id`, parsed, oldest first. */
  const markers = (id: string): (WakeMarker | undefined)[] => writes.filter(w => w.path === wakePath(STATE, id)).map(w => readWakeMarker(w.text))
  /** The armed wake-up as `$.state` holds it now. */
  const stored = () => state.get(ARMED)?.value as { id?: string; note?: string; conversation?: string } | null | undefined
  return { state, world, prompts, toasts, clock, session, wipe, markers, stored }
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' } as const
const notes = (appended: unknown) => JSON.stringify(appended)

/** A process started in A, no classic hook reaching the plugin, with a wake-up `minutes` after this turn. */
async function guardedArmed($: Engine, w: ReturnType<typeof engine>, minutes: number) {
  await $.session.start(start)
  await w.clock.advance(GRACE)
  await $.tool.call({ tool: WAKE, minutes, note: 'check the deploy' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await w.clock.settle()
  expect(w.markers(A).at(-1)?.armed).toBe(true)
}

test('guarded, a /clear carries the wake-up on: once the id reads the new conversation it is re-keyed there, its marker armed and the one left not, and it fires there', async ($, on) => {
  const w = engine(on)
  await guardedArmed($, w, 5)
  await $.session.end({ reason: 'clear', sessionId: A, resume: { id: A } })
  w.wipe()
  w.world.id = C
  await w.clock.advance(1000)
  expect(w.stored()?.conversation).toBe(C)
  expect(w.markers(C).at(-1)?.armed).toBe(true)
  expect(w.markers(A).at(-1)?.armed).toBe(false)
  expect(w.toasts).toEqual([])
  await w.clock.advance(6 * MINUTE)
  expect(w.prompts).toEqual(['Wake-up: check the deploy'])
})

test('guarded, a /resume to another conversation drops the wake-up, says so in the conversation now held, and nothing fires later', async ($, on) => {
  const w = engine(on)
  await guardedArmed($, w, 5)
  await $.session.end({ reason: 'resume', sessionId: A, resume: { id: A } })
  w.wipe()
  w.world.id = B
  await w.clock.advance(1000)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(DROPPED_TOAST)
  expect(notes(w.session.appended())).toContain(DROPPED_NOTE)
  expect(w.stored()).toBeNull()
  expect(w.markers(A).at(-1)?.armed).toBe(false)
  expect(w.markers(B).at(-1)?.armed).toBe(false)
  await w.clock.advance(60 * MINUTE)
  expect(w.prompts).toEqual([])
  expect(w.toasts).toHaveLength(1)
})

test('guarded, a wake-up that comes due while the id still lags a /resume waits for the move, so it never fires into the conversation moved to', async ($, on) => {
  const w = engine(on)
  await guardedArmed($, w, 1)
  // The /resume ends A a moment before the wake-up is due; the id goes on reading A past it.
  await w.clock.advance(MINUTE - 2000)
  await $.session.end({ reason: 'resume', sessionId: A, resume: { id: A } })
  await w.clock.advance(5000)
  expect(w.prompts).toEqual([])
  w.world.id = B
  await w.clock.advance(2000)
  expect(w.prompts).toEqual([])
  expect(w.toasts[0]).toMatch(DROPPED_TOAST)
  await w.clock.advance(60 * MINUTE)
  expect(w.prompts).toEqual([])
})

test('guarded, a wake-up set in a turn of the conversation a /resume moved to, while the id still read the one left, goes with the move and fires', async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await w.clock.advance(GRACE)
  await $.session.end({ reason: 'resume', sessionId: A, resume: { id: A } })
  // A turn in the conversation resumed, the id still lagging the move.
  await $.tool.call({ tool: WAKE, minutes: 5, note: 'check the deploy' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  w.world.id = B
  await w.clock.advance(1000)
  expect(w.toasts).toEqual([])
  expect(w.stored()?.conversation).toBe(B)
  expect(w.markers(B).at(-1)?.armed).toBe(true)
  await w.clock.advance(6 * MINUTE)
  expect(w.prompts).toEqual(['Wake-up: check the deploy'])
})

test('unguarded, a /resume: the classic SessionStart drops the wake-up as before, and the partner, which never looked, adds nothing', async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'startup', session_id: A })
  await $.tool.call({ tool: WAKE, minutes: 5, note: 'check the deploy' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await $.session.end({ reason: 'resume', sessionId: A, resume: { id: A } })
  w.wipe()
  await $.classic.SessionStart({ source: 'resume', session_id: B })
  w.world.id = B
  await w.clock.advance(60 * MINUTE)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(DROPPED_TOAST)
  expect(w.prompts).toEqual([])
  expect(w.state.get('self-wake/classic')?.value).toBe(true)
})

test('a reload after a /clear in an unguarded process reads that classic hooks run here, so its partner looks for no move: the classic SessionStart decides', async ($, on) => {
  const w = engine(on, { 'self-wake/classic': true, 'self-wake/started': A })
  await $.session.start(start)
  await $.tool.call({ tool: WAKE, minutes: 5, note: 'check the deploy' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await $.session.end({ reason: 'resume', sessionId: A, resume: { id: A } })
  w.world.id = B
  await w.clock.advance(3000)
  // No partner took the move up: the wake-up stands until the classic SessionStart of the move says what becomes of it.
  expect(w.toasts).toEqual([])
  await $.classic.SessionStart({ source: 'resume', session_id: B })
  await w.clock.settle()
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(DROPPED_TOAST)
})
