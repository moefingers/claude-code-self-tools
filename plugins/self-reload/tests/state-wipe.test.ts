// A /clear or a /resume that runs before the queued reload (claude-code-self-tools#24): Claude Code empties
// `$.state` then, with no session.start, and the session is another conversation. The reload still runs,
// but its resume was the conversation's it left: at that SessionStart it is dropped, and the person and the
// model are told, whether the wipe came before the SessionStart or comes after it.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__self-reload__reload_plugins_after_turn'
const PENDING = 'self-reload/pending'
/** How long the reload command takes: the /clear runs first, while it waits. */
const RELOAD_MS = 10_000

/** The engine beneath the plugin, its `$.state` the test's own, so a test can empty it as Claude Code does. */
function engine(on: On) {
  const state = new Map<string, { value: unknown; version: number }>()
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
  return { state, commands, prompts, toasts, clock, session, wipe }
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as const
const DROPPED_TOAST = "Resume dropped: a /clear ran before the queued plugin reload, so its resume, which was for the conversation left, isn't sent. The reload still runs."
const DROPPED_NOTE = 'self-reload: a plugin reload queued before this /clear still runs, but its resume was dropped: it was for the conversation the /clear left, not this one.'

test('a /clear empties $.state before the queued reload runs: the reload runs, its resume is dropped, and a toast and a note say so', async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, resume: 'Try the edited tool.' })
  await $.turn.complete(answered)
  await w.clock.settle()
  expect(w.commands).toEqual(['reload-plugins'])

  // The /clear runs while the reload waits: the state emptied, no session.start, then its SessionStart.
  w.wipe()
  await $.classic.SessionStart({ source: 'clear' })
  expect(w.toasts).toEqual([DROPPED_TOAST])
  expect(JSON.stringify(w.session.appended())).toContain(DROPPED_NOTE)

  await w.clock.advance(RELOAD_MS + 1000)
  expect(w.prompts).toEqual([])
  expect(JSON.stringify(w.session.appended())).not.toContain('Try the edited tool.')
})

test("a /clear whose wipe lands after its SessionStart: the record still in $.state loses its resume, so the reload's end sends none", async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, resume: 'Try the edited tool.' })
  await $.turn.complete(answered)
  await w.clock.settle()

  await $.classic.SessionStart({ source: 'clear' })
  expect(w.toasts).toEqual([DROPPED_TOAST])
  expect((w.state.get(PENDING)?.value as { resume?: string } | undefined)?.resume).toBeUndefined()

  // The reload returns with the record in place: it is taken, and reported, with no resume.
  await w.clock.advance(RELOAD_MS + 1000)
  expect(w.prompts).toEqual([])
  expect(w.toasts).toEqual([DROPPED_TOAST, 'Plugins reloaded. Reloaded 3 plugins.'])
})

test('a /resume does the same, said as a /resume; a reload with no resume waits for nothing, and nothing is said', async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, resume: 'Try the edited tool.' })
  await $.turn.complete(answered)
  await w.clock.settle()
  await $.classic.SessionStart({ source: 'resume' })
  expect(w.toasts).toEqual(["Resume dropped: a /resume ran before the queued plugin reload, so its resume, which was for the conversation left, isn't sent. The reload still runs."])
  await w.clock.advance(RELOAD_MS + 1000)
  expect(w.prompts).toEqual([])

  // No resume asked for: the next /clear has nothing to drop.
  await $.tool.call({ tool: TOOL })
  await $.turn.complete({ ...answered, turnId: 't2' })
  await w.clock.settle()
  w.wipe()
  await $.classic.SessionStart({ source: 'clear' })
  expect(w.toasts.filter(t => t.startsWith('Resume dropped'))).toHaveLength(1)
})

test('a compact, a fork, or a subagent\'s start drops nothing: the resume goes once the reload is done', async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, resume: 'Try the edited tool.' })
  await $.turn.complete(answered)
  await w.clock.settle()
  await $.classic.SessionStart({ source: 'compact' })
  await $.classic.SessionStart({ source: 'fork' })
  await $.classic.SessionStart({ source: 'clear', agent_id: 'a1' })
  await w.clock.advance(RELOAD_MS + 1000)
  expect(w.prompts).toEqual(['Plugins reloaded. Resume: Try the edited tool.'])
})
