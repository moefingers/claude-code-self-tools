// #53: where Claude Code's built-in guard loads (managed settings, or a Team or Enterprise login), a person's plugin's
// classic.SessionStart never runs, so a /clear or a /resume before the queued reload left its resume in place, and it
// was sent into the conversation arrived at. Its partner (hooks/classic.ts), the session end of that /clear or
// /resume, drops it there instead, and only there: the module's copy at once, the record after the engine's end step,
// marked so the reload's report tells the model why no resume came. Where the classic SessionStart runs, it drops it
// as before, and the partner nothing.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__self-reload__reload_plugins_after_turn'
const PENDING = 'self-reload/pending'
/** How long the reload command takes: the /clear runs first, while it waits. */
const RELOAD_MS = 10_000
const ENDED = '0f8fad5b-d9cb-469f-a165-70867728950e'

/** The engine beneath the plugin, its `$.state` the test's own (seeded with `kept`), so a test can empty it as Claude Code does. */
function engine(on: On, kept: Record<string, unknown> = {}) {
  const state = new Map<string, { value: unknown; version: number }>(Object.entries(kept).map(([key, value]) => [key, { value, version: 1 }]))
  const commands: string[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  const clock = mock.clock(on)
  const session = mock.session(on)
  on('state.get', (_, e) => ({ value: state.get(`${e.plugin}/${e.key}`) ?? { value: undefined, version: 0 } }))
  on('state.set', (_, e) => {
    const key = `${e.plugin}/${e.key}`
    const held = state.get(key) ?? { value: undefined, version: 0 }
    if (e.ifVersion !== undefined && e.ifVersion !== held.version) return { value: { isSet: false, version: held.version } }
    const version = held.version + 1
    state.set(key, { value: JSON.parse(JSON.stringify(e.value ?? null)), version })
    return { value: { isSet: true, version } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('classic.SessionStart', () => ({}))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('command.run', async (_, e) => {
    commands.push(e.command)
    await clock.sleep(RELOAD_MS)
    return { text: 'Reloaded 3 plugins.' }
  })
  /** Claude Code at an in-process /clear or /resume: every value of the plugin's `$.state` gone, and no session.start. */
  const wipe = () => state.clear()
  /** The rows the model was handed, as text. */
  const notes = () => JSON.stringify(session.appended())
  return { state, commands, prompts, toasts, clock, notes, wipe }
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as const
const DROPPED_TOAST = "Resume dropped: a /clear ran before the queued plugin reload, so its resume, which was for the conversation left, isn't sent. The reload still runs."
/** The classic path's note, at the SessionStart. */
const CLASSIC_NOTE = 'self-reload: a plugin reload queued before this /clear still runs, but its resume was dropped: it was for the conversation the /clear left, not this one.'
/** The partner's note, with the reload's report. */
const GUARDED_NOTE = 'self-reload: the plugin reload queued before this /clear ran, but its resume was dropped: it was for the conversation the /clear left, not this one.'
const clearEnds = { reason: 'clear', sessionId: ENDED, resume: { id: ENDED } } as const

test('#53, guarded: the session end of a /clear before the queued reload drops its resume; the reload still runs, and its report tells the model why no resume came', async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, resume: 'Try the edited tool.' })
  await $.turn.complete(answered)
  await w.clock.settle()
  expect(w.commands).toEqual(['reload-plugins'])

  // The /clear runs while the reload waits: its wipe comes first, then the session end.
  w.wipe()
  await $.session.end(clearEnds)
  expect(w.toasts).toEqual([DROPPED_TOAST])
  // Back in $.state without its resume, marked dropped: the reload's end says how it went.
  const held = w.state.get(PENDING)?.value as { at?: number; resume?: string; dropped?: string } | undefined
  expect(held?.at).toBeDefined()
  expect(held?.resume).toBeUndefined()
  expect(held?.dropped).toBe('clear')
  // Nothing goes into the conversation ending.
  expect(w.notes()).toBe('[]')

  await w.clock.advance(RELOAD_MS + 1000)
  expect(w.prompts).toEqual([])
  expect(w.toasts).toEqual([DROPPED_TOAST, 'Plugins reloaded. Reloaded 3 plugins.'])
  expect(w.notes()).toContain(GUARDED_NOTE)
  expect(w.notes()).not.toContain('Try the edited tool.')
})

test('#53, guarded: a session end whose wipe lands after it leaves no record, so the reload sends nothing, and the toast has said why', async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, resume: 'Try the edited tool.' })
  await $.turn.complete(answered)
  await w.clock.settle()
  await $.session.end(clearEnds)
  w.wipe()
  await w.clock.advance(RELOAD_MS + 1000)
  expect(w.prompts).toEqual([])
  expect(w.toasts).toEqual([DROPPED_TOAST])
})

test('#53, guarded: the module a reload starts reports a record the partner marked: the model hears why no resume came, and nothing is sent', async ($, on) => {
  const w = engine(on, { [PENDING]: { at: 0, dropped: 'clear' } })
  await $.session.start(start)
  await w.clock.settle()
  expect(w.prompts).toEqual([])
  expect(w.toasts).toEqual(['Plugins reloaded.'])
  expect(w.notes()).toContain(GUARDED_NOTE)
})

test('#53, unguarded: the session end leaves the drop to the classic SessionStart, as before: one toast, one note', async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'startup' })
  await $.tool.call({ tool: TOOL, resume: 'Try the edited tool.' })
  await $.turn.complete(answered)
  await w.clock.settle()
  await $.session.end(clearEnds)
  expect(w.toasts).toEqual([])
  expect((w.state.get(PENDING)?.value as { resume?: string } | undefined)?.resume).toBe('Try the edited tool.')
  w.wipe()
  await $.classic.SessionStart({ source: 'clear' })
  expect(w.toasts).toEqual([DROPPED_TOAST])
  expect(w.notes()).toContain(CLASSIC_NOTE)
  await w.clock.advance(RELOAD_MS + 1000)
  expect(w.prompts).toEqual([])
  expect(w.toasts).toEqual([DROPPED_TOAST, 'Plugins reloaded. Reloaded 3 plugins.'])
  expect(w.notes()).not.toContain(GUARDED_NOTE)
})

test('#53, a reload after an unguarded /clear reads that classic hooks run here: a later session end drops nothing, the classic SessionStart does', async ($, on) => {
  const w = engine(on, { 'self-reload/classic': true })
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, resume: 'Try the edited tool.' })
  await $.turn.complete(answered)
  await w.clock.settle()
  await $.session.end(clearEnds)
  expect(w.toasts).toEqual([])
  await $.classic.SessionStart({ source: 'clear' })
  expect(w.toasts).toEqual([DROPPED_TOAST])
})
