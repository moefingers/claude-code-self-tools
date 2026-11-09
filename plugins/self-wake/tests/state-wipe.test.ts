// Claude Code empties a plugin's `$.state` at an in-process /clear or /resume, and no session.start follows
// (claude-code-self-tools#24). The armed wake-up outlives it in the module: it goes back to `$.state` at the
// move's SessionStart and at the first read that finds it empty, the timer goes by the module's copy when
// `$.state` reads empty, and a timer that sends nothing clears the status line. A wake-up armed before a
// /clear fires into the conversation the /clear started.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const WAKE = 'mcp__self-wake__wake_after'
const CANCEL = 'mcp__self-wake__cancel_wake'
const MINUTE = 60 * 1000
const A = '1f4e7a2c-9b3d-4c8e-a5f1-6d2b0e9c7a43'
const B = '8c3a5e71-4d2f-4b9a-9e6c-1a7f3d5b2e08'
const ARMED = 'self-wake/armed'

type Options = {
  /** A compare-and-set on the armed wake-up loses: another writer got there first. */
  conflict?: boolean
}

/** The engine beneath the plugin, its `$.state` the test's own, so a test can empty it as Claude Code does. */
function engine(on: On, { conflict = false }: Options = {}) {
  const state = new Map<string, { value: unknown; version: number }>()
  const prompts: string[] = []
  const statuses: (string | undefined)[] = []
  const clock = mock.clock(on)
  on('state.get', (_, e) => ({ value: state.get(`${e.plugin}/${e.key}`) ?? { value: undefined, version: 0 } }))
  on('state.set', (_, e) => {
    const key = `${e.plugin}/${e.key}`
    const held = state.get(key) ?? { value: undefined, version: 0 }
    if (e.ifVersion !== undefined && (conflict || e.ifVersion !== held.version)) return { value: { isSet: false, version: held.version } }
    const version = held.version + 1
    state.set(key, { value: JSON.parse(JSON.stringify(e.value ?? null)), version })
    return { value: { isSet: true, version } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: A }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__self-wake__${e.name}` } }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('classic.SessionStart', () => ({}))
  on('turn.complete', () => ({ text: 'done' }))
  /** Claude Code at an in-process /clear or /resume: every value of the plugin's `$.state` gone, and no session.start. */
  const wipe = () => state.clear()
  return { state, prompts, statuses, clock, wipe }
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' } as const

/** A wake-up `minutes` after this turn, armed in conversation A. */
async function armed($: Engine, minutes: number, note: string) {
  await $.classic.SessionStart({ source: 'startup', session_id: A })
  await $.tool.call({ tool: WAKE, minutes, note })
  await $.turn.complete({ ...answered, turnId: 't1' })
}

test('a /clear empties $.state and no session.start follows: the wake-up goes back at its SessionStart, and fires into the cleared conversation', async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await armed($, 2, 'check the deploy')
  expect((w.state.get(ARMED)?.value as { note?: string } | undefined)?.note).toBe('check the deploy')

  w.wipe()
  await $.classic.SessionStart({ source: 'clear', session_id: B })
  // Back in $.state before the timer comes due.
  expect((w.state.get(ARMED)?.value as { note?: string } | undefined)?.note).toBe('check the deploy')
  await w.clock.advance(3 * MINUTE)
  expect(w.prompts).toEqual(['Wake-up: check the deploy'])
  expect(w.state.get(ARMED)?.value).toBeNull()
})

test('a /resume whose wipe lands after its SessionStart: the timer goes by the module\'s copy, and sends once', async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await armed($, 2, 'check the job')
  await $.classic.SessionStart({ source: 'resume', session_id: B })
  w.wipe()
  await w.clock.advance(3 * MINUTE)
  expect(w.prompts).toEqual(['Wake-up: check the job'])
  expect(w.statuses.at(-1)).toBeUndefined()
  await w.clock.advance(60 * MINUTE)
  expect(w.prompts).toHaveLength(1)
})

test('after a wipe, wake_after and cancel_wake still see the wake-up: the replace is said, the cancel takes it, and nothing fires', async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await armed($, 10, 'first')
  w.wipe()
  const replacing = await $.tool.call({ tool: WAKE, minutes: 5, note: 'second' })
  expect(replacing.result).toMatch(/It replaces the wake-up due in 10 minutes \("first"\)\.$/)
  // The read that found it empty put it back.
  expect((w.state.get(ARMED)?.value as { note?: string } | undefined)?.note).toBe('first')
  w.wipe()
  const cancelled = await $.tool.call({ tool: CANCEL })
  expect(cancelled.result).toBe('Cancelled the wake-up due in 10 minutes ("first").')
  await w.clock.advance(20 * MINUTE)
  expect(w.prompts).toEqual([])
})

test('a timer that sends nothing (another writer took the wake-up) clears the status line', async ($, on) => {
  const w = engine(on, { conflict: true })
  await $.session.start(start)
  await armed($, 2, 'check the deploy')
  expect(w.statuses.at(-1)).toBe('wake-up pending: check the deploy')
  await w.clock.advance(3 * MINUTE)
  expect(w.prompts).toEqual([])
  expect(w.statuses.at(-1)).toBeUndefined()
})
