import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { readWakeMarker, wakeMarker, wakePath } from '../hooks/machine'

const WAKE = 'mcp__self-wake__wake_after'
const CANCEL = 'mcp__self-wake__cancel_wake'
const MINUTE = 60 * 1000

/**
 * The engine beneath the plugin. With `reloadedAfter`, the timer the plugin starts for a wait of
 * that length never fires, as the timer of a module a reload replaced never does; its $.state stays.
 */
function engine(on: On, { reloadedAfter }: { reloadedAfter?: number } = {}) {
  const prompts: string[] = []
  const toasts: string[] = []
  if (reloadedAfter !== undefined) on('clock.after', { ms: reloadedAfter }, () => ({ deny: 'the module was reloaded' }))
  const clock = mock.clock(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__self-wake__${e.name}` } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', () => ({ text: 'done' }))
  return { prompts, toasts, clock }
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' } as const

test('a wake-up fires its minutes after the turn ends, once', async ($, on) => {
  const { prompts, clock } = engine(on)
  await $.session.start(start)

  const queued = await $.tool.call({ tool: WAKE, minutes: 1, note: 'check the deploy' })
  expect(queued.result).toBe('Queued: 1 minute after this turn ends, the session sends itself "Wake-up: check the deploy".')
  // Not armed until the turn ends.
  await clock.advance(2 * MINUTE)
  expect(prompts).toEqual([])

  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(59 * 1000)
  expect(prompts).toEqual([])
  await clock.advance(2 * 1000)
  expect(prompts).toEqual(['Wake-up: check the deploy'])
  await clock.advance(60 * MINUTE)
  expect(prompts).toHaveLength(1)
})

test('minutes are brought within 1 to 1440, and a wake-up needs a number and a note', async ($, on) => {
  engine(on)
  await $.session.start(start)

  expect((await $.tool.call({ tool: WAKE, minutes: 0, note: 'a' })).result).toMatch(/^Queued: 1 minute after this turn ends \(0 is outside 1 to 1440\)/)
  expect((await $.tool.call({ tool: WAKE, minutes: 5000, note: 'a' })).result).toMatch(/^Queued: 1440 minutes after this turn ends \(5000 is outside/)
  expect((await $.tool.call({ tool: WAKE, minutes: 'soon', note: 'a' })).deny).toMatch(/minutes/)
  expect((await $.tool.call({ tool: WAKE, minutes: 5, note: '  ' })).deny).toMatch(/note/)
})

test('a new wake-up replaces the one before it, and says so', async ($, on) => {
  const { prompts, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: WAKE, minutes: 10, note: 'first' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  const second = await $.tool.call({ tool: WAKE, minutes: 5, note: 'second' })
  expect(second.result).toMatch(/It replaces the wake-up due in 10 minutes \("first"\)\.$/)
  await $.turn.complete({ ...answered, turnId: 't2' })

  await clock.advance(6 * MINUTE)
  expect(prompts).toEqual(['Wake-up: second'])
  await clock.advance(30 * MINUTE)
  expect(prompts).toEqual(['Wake-up: second'])
})

test('an interrupted turn drops the wake-up it asked for; one set before stands', async ($, on) => {
  const { prompts, toasts, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: WAKE, minutes: 10, note: 'first' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await $.tool.call({ tool: WAKE, minutes: 2, note: 'second' })
  await $.turn.complete({ ...answered, turnId: 't2', isAborted: true, reason: 'aborted' })
  expect(toasts.some(t => /didn't finish\. The one set before stands\./.test(t))).toBe(true)

  await clock.advance(3 * MINUTE)
  expect(prompts).toEqual([])
  await clock.advance(8 * MINUTE)
  expect(prompts).toEqual(['Wake-up: first'])
})

test('cancel_wake takes the wake-up back at once', async ($, on) => {
  const { prompts, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: WAKE, minutes: 1, note: 'check the job' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  const cancelled = await $.tool.call({ tool: CANCEL })
  expect(cancelled.result).toBe('Cancelled the wake-up due in 1 minute ("check the job").')
  await clock.advance(5 * MINUTE)
  expect(prompts).toEqual([])
  expect((await $.tool.call({ tool: CANCEL })).result).toBe('No wake-up was set; nothing to cancel.')
})

test('after a reload, the wake-up is armed again for the time left', async ($, on) => {
  const { prompts, clock } = engine(on, { reloadedAfter: 10 * MINUTE })
  await $.session.start(start)

  await $.tool.call({ tool: WAKE, minutes: 10, note: 'check the build' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(3 * MINUTE)
  // The reloaded module starts: its timer is for the 7 minutes left.
  await $.session.start(start)

  await clock.advance(6 * MINUTE)
  expect(prompts).toEqual([])
  await clock.advance(2 * MINUTE)
  expect(prompts).toEqual(['Wake-up: check the build'])
  await clock.advance(60 * MINUTE)
  expect(prompts).toHaveLength(1)
})

test('after a reload past its time, the wake-up fires at once', async ($, on) => {
  const { prompts, clock } = engine(on, { reloadedAfter: MINUTE })
  await $.session.start(start)

  await $.tool.call({ tool: WAKE, minutes: 1, note: 'check the build' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(5 * MINUTE)
  expect(prompts).toEqual([])

  await $.session.start(start)
  await clock.settle()
  expect(prompts).toEqual(['Wake-up: check the build'])
  await $.session.start(start)
  await clock.advance(MINUTE)
  expect(prompts).toHaveLength(1)
})

test('a subagent is refused by both tools', async ($, on) => {
  const { prompts, clock } = engine(on)
  await $.session.start(start)

  expect((await $.tool.call({ tool: WAKE, minutes: 1, note: 'x', agentId: 'a1' })).deny).toMatch(/subagent/)
  expect((await $.tool.call({ tool: CANCEL, agentId: 'a1' })).deny).toMatch(/subagent/)
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(5 * MINUTE)
  expect(prompts).toEqual([])
})

describe("the wake marker (S10w's read): wake\\<conversation>.json, { v: 1, armed, due?, at }", () => {
  const LOCAL = 'C:\\Users\\u\\AppData\\Local'
  const STATE = `${LOCAL}\\claude-self-tools`
  /** Two conversations this process holds in turn. */
  const W = '00000000-0000-4000-a000-00000000000a'
  const T = '00000000-0000-4000-a000-00000000000b'

  /** The engine with %LOCALAPPDATA%, the session's id and the file writes: each marker as written, by conversation. */
  function marked(on: On) {
    const base = engine(on)
    const writes: { path: string; text: string }[] = []
    const world = { id: W }
    mock.env(on, { LOCALAPPDATA: LOCAL })
    on('session.id', () => ({ value: world.id }))
    on('classic.SessionStart', () => ({}))
    on('ui.log', () => ({ value: undefined }))
    on('fs.write', (_, e) => {
      writes.push({ path: e.path, text: e.text })
      return { value: undefined }
    })
    /** The markers written for `id`, parsed, oldest first. */
    const markers = (id: string) => writes.filter(w => w.path === wakePath(STATE, id)).map(w => readWakeMarker(w.text))
    return { ...base, writes, world, markers }
  }

  test('at the start: not armed; armed: armed, with when it is due; fired: not armed', async ($, on) => {
    const { markers, clock } = marked(on)
    await $.session.start(start)
    await clock.settle()
    expect(markers(W).map(m => m?.armed)).toEqual([false])

    await $.tool.call({ tool: WAKE, minutes: 5, note: 'check the deploy' })
    await $.turn.complete({ ...answered, turnId: 't1' })
    await clock.settle()
    const armedOne = markers(W).at(-1)
    expect(armedOne?.armed).toBe(true)
    expect(armedOne?.due).toBe((armedOne?.at ?? 0) + 5 * MINUTE)

    await clock.advance(6 * MINUTE)
    expect(markers(W).at(-1)?.armed).toBe(false)
    expect(markers(W).at(-1)?.due).toBeUndefined()
  })

  test('replaced: the new due; cancelled: not armed (no write on cancel would leave a go held)', async ($, on) => {
    const { markers, clock } = marked(on)
    await $.session.start(start)
    await $.tool.call({ tool: WAKE, minutes: 10, note: 'first' })
    await $.turn.complete({ ...answered, turnId: 't1' })
    await $.tool.call({ tool: WAKE, minutes: 3, note: 'second' })
    await $.turn.complete({ ...answered, turnId: 't2' })
    await clock.settle()
    const replaced = markers(W).at(-1)
    expect(replaced?.armed).toBe(true)
    expect(replaced?.due).toBe((replaced?.at ?? 0) + 3 * MINUTE)

    const count = markers(W).length
    await $.tool.call({ tool: CANCEL })
    await clock.settle()
    expect(markers(W).length).toBe(count + 1)
    expect(markers(W).at(-1)?.armed).toBe(false)
  })

  test('each conversation this process comes to, by its event\'s id: an in-place move leaves the one left armed only while the timer still holds its wake-up', async ($, on) => {
    const { markers, world, clock } = marked(on)
    await $.session.start(start)
    await $.classic.SessionStart({ source: 'startup', session_id: W })
    await $.tool.call({ tool: WAKE, minutes: 5, note: 'check W' })
    await $.turn.complete({ ...answered, turnId: 't1' })
    await clock.settle()
    expect(markers(W).at(-1)?.armed).toBe(true)

    // An in-place /resume to T: $.session.id() still reads W at its SessionStart; the event names T.
    await $.classic.SessionStart({ source: 'resume', session_id: T })
    await clock.settle()
    expect(markers(T).at(-1)?.armed).toBe(false)
    // W's wake-up is still this process's timer's: W's marker says so.
    expect(markers(W).at(-1)?.armed).toBe(true)
    world.id = T

    // The timer runs out: W's marker says not armed.
    await clock.advance(6 * MINUTE)
    expect(markers(W).at(-1)?.armed).toBe(false)
  })

  test('a conversation whose id is not a session id gets no marker, and nothing else is written', async ($, on) => {
    const { writes, world, clock } = marked(on)
    world.id = '..\\x'
    await $.session.start(start)
    await $.tool.call({ tool: WAKE, minutes: 1, note: 'x' })
    await $.turn.complete({ ...answered, turnId: 't1' })
    await clock.advance(2 * MINUTE)
    expect(writes).toEqual([])
  })

  test('the marker as written reads back strictly: armed needs a due, not armed has none, nothing else', () => {
    expect(readWakeMarker(wakeMarker({ armed: true, due: 5, at: 1 }))).toEqual({ armed: true, due: 5, at: 1 })
    expect(readWakeMarker(wakeMarker({ armed: false, at: 1 }))).toEqual({ armed: false, at: 1 })
    expect(wakeMarker({ armed: false, due: 5, at: 1 })).toBe('{"v":1,"armed":false,"at":1}')
    for (const text of ['{', '{"v":2,"armed":false,"at":1}', '{"v":1,"armed":true,"at":1}', '{"v":1,"armed":false,"due":5,"at":1}', '{"v":1,"armed":"yes","at":1}', '{"v":1,"armed":false,"at":1,"note":"x"}']) {
      expect(readWakeMarker(text)).toBeUndefined()
    }
  })
})
