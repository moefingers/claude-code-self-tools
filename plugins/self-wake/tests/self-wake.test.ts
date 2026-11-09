import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { readWakeMarker, WAKE_REMOVED, wakeMarker, wakePath, wakeRemoveScript } from '../hooks/machine'

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

  /**
   * The engine with %LOCALAPPDATA%, the session's id and the file writes: each marker as written, by
   * conversation. `failArmed`: that many writes of an armed marker fail (a scanner holding the file);
   * `removal`: what the removal script answers, `removed` or `kept`; `removalMs`, how long on the
   * engine's clock it takes to answer; `scripts`, each script it was run with.
   */
  function marked(on: On, { failArmed = 0, removal = 'removed', removalMs = 0 }: { failArmed?: number; removal?: 'removed' | 'kept'; removalMs?: number } = {}) {
    const base = engine(on)
    const writes: { path: string; text: string }[] = []
    const failed: string[] = []
    const scripts: string[] = []
    const logs: string[] = []
    const world = { id: W, failArmed }
    mock.env(on, { LOCALAPPDATA: LOCAL, SystemRoot: 'C:\\Windows', OS: 'Windows_NT' })
    on('session.id', () => ({ value: world.id }))
    on('classic.SessionStart', () => ({}))
    on('ui.log', (_, e) => {
      logs.push(String(e.text))
      return { value: undefined }
    })
    on('fs.write', (_, e) => {
      if (world.failArmed > 0 && readWakeMarker(e.text)?.armed === true) {
        world.failArmed -= 1
        failed.push(e.path)
        return { deny: 'EBUSY: resource busy or locked' }
      }
      writes.push({ path: e.path, text: e.text })
      return { value: undefined }
    })
    on('process.run', async (_, e) => {
      scripts.push(String(e.init?.stdin ?? ''))
      if (removalMs > 0) await base.clock.sleep(removalMs)
      return { value: { exitCode: 0, stdout: removal === 'removed' ? 'removed\r\n' : 'kept The process cannot access the file\r\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    /** The markers written for `id`, parsed, oldest first. */
    const markers = (id: string) => writes.filter(w => w.path === wakePath(STATE, id)).map(w => readWakeMarker(w.text))
    return { ...base, writes, failed, scripts, logs, world, markers }
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

  test("each conversation this process comes to, by its event's id: an in-place /resume to another drops the wake-up, so the one left's marker says none at once, and nothing fires", async ($, on) => {
    const { markers, world, clock, prompts } = marked(on)
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
    // W's wake-up was dropped by the move: no timer holds it, and W's marker says so.
    expect(markers(W).at(-1)?.armed).toBe(false)
    world.id = T

    await clock.advance(6 * MINUTE)
    expect(prompts).toEqual([])
  })

  test("a fork's SessionStart moves nothing: its own marker says none, a wake-up stays armed under W, and one set after it is W's too, so a switch from W holds (D-6)", async ($, on) => {
    const { markers, clock } = marked(on)
    await $.session.start(start)
    await $.classic.SessionStart({ source: 'startup', session_id: W })
    await $.tool.call({ tool: WAKE, minutes: 10, note: 'check W' })
    await $.turn.complete({ ...answered, turnId: 't1' })
    await clock.settle()
    expect(markers(W).at(-1)?.armed).toBe(true)
    await $.classic.SessionStart({ source: 'fork', session_id: T })
    await clock.settle()
    expect(markers(T).at(-1)?.armed).toBe(false)
    expect(markers(W).at(-1)?.armed).toBe(true)
    // Set after the fork's event, in the foreground, still W: never stored under the fork.
    await $.tool.call({ tool: WAKE, minutes: 5, note: 'check W again' })
    await $.turn.complete({ ...answered, turnId: 't2' })
    await clock.settle()
    expect(markers(W).at(-1)?.armed).toBe(true)
    expect(markers(T).at(-1)?.armed).toBe(false)
  })

  test("an id that lags its SessionStart, inside 15 seconds: the event's id stands, and the wake-up is armed under it (D-6)", async ($, on) => {
    const { markers, clock } = marked(on)
    await $.session.start(start)
    await $.classic.SessionStart({ source: 'resume', session_id: T })
    await clock.advance(14_000)
    await $.tool.call({ tool: WAKE, minutes: 5, note: 'check T' })
    await $.turn.complete({ ...answered, turnId: 't1' })
    await clock.settle()
    expect(markers(T).at(-1)?.armed).toBe(true)
    expect(markers(W).at(-1)?.armed).toBe(false)
  })

  test('after /branch, past 15 seconds, $.session.id() is the conversation: the wake-up is armed under the one it reads (D-6)', async ($, on) => {
    const { markers, world, clock } = marked(on)
    await $.session.start(start)
    await $.classic.SessionStart({ source: 'startup', session_id: W })
    await $.classic.SessionStart({ source: 'fork', session_id: T })
    world.id = T
    await clock.advance(16_000)
    await $.tool.call({ tool: WAKE, minutes: 5, note: 'check T' })
    await $.turn.complete({ ...answered, turnId: 't1' })
    await clock.settle()
    expect(markers(T).at(-1)?.armed).toBe(true)
    expect(markers(W).at(-1)?.armed).toBe(false)
  })

  test('a wake-up keeps the conversation it was armed in: after a reload, a move to another drops it, never handing it to the other, and a move back finds none (S1-1)', async ($, on) => {
    const { markers, clock, prompts } = marked(on)
    await $.session.start(start)
    await $.tool.call({ tool: WAKE, minutes: 10, note: 'check W' })
    await $.turn.complete({ ...answered, turnId: 't1' })
    await clock.settle()
    expect(markers(W).at(-1)?.armed).toBe(true)
    // A reload: session.start again, the wake-up still in $.state; no SessionStart has named a
    // conversation since, so the module doesn't know the one it holds but by the wake-up's own record.
    await $.session.start(start)
    await clock.settle()
    expect(markers(W).at(-1)?.armed).toBe(true)
    // /resume T in place: the first SessionStart after the reload. T is not the wake-up's: it is dropped.
    await $.classic.SessionStart({ source: 'resume', session_id: T })
    await clock.settle()
    expect(markers(T).at(-1)?.armed).toBe(false)
    expect(markers(W).at(-1)?.armed).toBe(false)
    // And back to W: none waits there.
    await $.classic.SessionStart({ source: 'resume', session_id: W })
    await clock.settle()
    expect(markers(W).at(-1)?.armed).toBe(false)
    expect(markers(T).at(-1)?.armed).toBe(false)
    await clock.advance(20 * MINUTE)
    expect(prompts).toEqual([])
  })

  test('an armed marker whose first write fails is written again, before the turn\'s end returns (S1-2)', async ($, on) => {
    const { markers, failed, scripts, toasts } = marked(on, { failArmed: 1 })
    await $.session.start(start)
    await $.tool.call({ tool: WAKE, minutes: 5, note: 'check the deploy' })
    await $.turn.complete({ ...answered, turnId: 't1' })
    // Awaited by the turn's end: a switch queued in the same turn reads it after.
    expect(failed).toEqual([wakePath(STATE, W)])
    expect(markers(W).at(-1)?.armed).toBe(true)
    expect(scripts).toEqual([])
    expect(toasts.some(t => /marker/.test(t))).toBe(false)
  })

  test('an armed marker that can\'t be written twice: the marker saying none is removed, so it reads unknown and holds, and a toast says so (S1-2)', async ($, on) => {
    const { markers, scripts, toasts, logs, clock } = marked(on, { failArmed: 2 })
    await $.session.start(start)
    await clock.settle()
    expect(markers(W).at(-1)?.armed).toBe(false)
    await $.tool.call({ tool: WAKE, minutes: 5, note: 'check the deploy' })
    await $.turn.complete({ ...answered, turnId: 't1' })
    await clock.settle()
    // The marker left there would read as none: removed, by the fixed script for W alone.
    expect(markers(W).at(-1)?.armed).toBe(false)
    expect(scripts).toEqual([wakeRemoveScript({ stateDir: STATE, id: W })])
    expect(WAKE_REMOVED.exec('removed\r\n')?.[1]).toBe('removed')
    expect(toasts).toContain("Wake-up set, but its marker couldn't be written, so it was removed: a switch or a go here reads this wake-up as unknown, and holds, until it fires or is cancelled.")
    expect(logs.some(l => l.startsWith("self-wake: the wake marker for ") && l.includes("the marker there before, if any, still stands"))).toBe(true)
  })

  test('the removal is awaited: the turn\'s end returns only once it has run, so a switch read right after never finds the stale marker (D-3)', async ($, on) => {
    const { scripts, toasts, clock } = marked(on, { failArmed: 2, removalMs: 2000 })
    await $.session.start(start)
    await $.tool.call({ tool: WAKE, minutes: 5, note: 'check the deploy' })
    let ended = false
    const ending = $.turn.complete({ ...answered, turnId: 't1' }).then(done => {
      ended = true
      return done
    })
    await clock.settle()
    // The removal runs, and the turn's end waits on it.
    expect(scripts).toEqual([wakeRemoveScript({ stateDir: STATE, id: W })])
    expect(ended).toBe(false)
    await clock.advance(2000)
    await ending
    expect(toasts).toContain("Wake-up set, but its marker couldn't be written, so it was removed: a switch or a go here reads this wake-up as unknown, and holds, until it fires or is cancelled.")
  })

  test('one that can\'t be removed either: the toast says a switch may not see it, and how to stop that (S1-2)', async ($, on) => {
    const { toasts, clock } = marked(on, { failArmed: 2, removal: 'kept' })
    await $.session.start(start)
    await $.tool.call({ tool: WAKE, minutes: 5, note: 'check the deploy' })
    await $.turn.complete({ ...answered, turnId: 't1' })
    await clock.settle()
    expect(toasts).toContain("Wake-up set, but its marker couldn't be written or removed: a switch or a go here may not see this wake-up. Cancel it (cancel_wake) before switching away, or set it again.")
  })

  test('the removal script: the marker by the path wakePath builds, deleted, tried 3 times; any other id refused before it is built', () => {
    const script = wakeRemoveScript({ stateDir: STATE, id: W })
    expect(script).toContain(`$path = '${wakePath(STATE, W)}'`)
    expect(script).toContain('[IO.File]::Delete($path)')
    expect(script).not.toMatch(/Remove-Item|-Recurse|Delete\(\$state/)
    for (const id of ['..\\x', W.toUpperCase(), `${W}\\..\\x`, '']) expect(() => wakeRemoveScript({ stateDir: STATE, id })).toThrow()
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
