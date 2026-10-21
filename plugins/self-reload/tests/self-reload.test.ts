import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__self-reload__reload_plugins_after_turn'
const HOUR = 60 * 60 * 1000

/**
 * The engine beneath the plugin. `reload` is what the reload command does: return (it left this
 * module in place), hang (it replaced this module, whose continuation never comes back in time), or
 * be refused.
 */
function engine(on: On, { reload = 'returns' }: { reload?: 'returns' | 'hangs' | 'refused' | 'skips' } = {}) {
  const commands: string[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  const clock = mock.clock(on)
  const session = mock.session(on)
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
  on('turn.complete', () => ({ text: 'done' }))
  on('command.run', async (_, e, next) => {
    commands.push(e.command)
    if (reload === 'refused') return next(e)
    if (reload === 'hangs') await clock.sleep(HOUR)
    if (reload === 'skips') {
      return {
        text: 'Reloading would change the MCP tools, so your next message will re-read the whole conversation instead of using the cache. Run /reload-plugins --force to apply.',
      }
    }
    return { text: 'Reloaded 3 plugins.' }
  })
  return { commands, prompts, toasts, clock, session }
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as const

test('the reload runs once the turn ends, and the resume is sent once', async ($, on) => {
  const { commands, prompts, clock } = engine(on)
  await $.session.start(start)

  const queued = await $.tool.call({ tool: TOOL, resume: ' Try the edited tool. ' })
  expect(queued.deny).toBeUndefined()
  expect(commands).toEqual([])

  await $.turn.complete(answered)
  expect(commands).toEqual([])
  await clock.advance(1000)
  expect(commands).toEqual(['reload-plugins'])
  expect(prompts).toEqual(['Plugins reloaded. Resume: Try the edited tool.'])

  // A later start, and a later turn's end, send and run nothing more.
  await $.session.start(start)
  await $.turn.complete({ ...answered, turnId: 't2' })
  await clock.advance(1000)
  expect(commands).toEqual(['reload-plugins'])
  expect(prompts).toHaveLength(1)
})

test('a module the reload started sends the resume from its start, and only once', async ($, on) => {
  const { commands, prompts, clock } = engine(on, { reload: 'hangs' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, resume: 'Run the new tool once.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual(['reload-plugins'])
  expect(prompts).toEqual([])

  // The reloaded module starts: it finds the resume in $.state and sends it.
  await $.session.start(start)
  await clock.settle()
  expect(prompts).toEqual(['Plugins reloaded. Resume: Run the new tool once.'])

  // Another start, and the old module's command coming back at last, send nothing more.
  await $.session.start(start)
  await clock.advance(HOUR)
  expect(prompts).toHaveLength(1)
})

test('without resume, a reload sends nothing and the session waits', async ($, on) => {
  const { commands, prompts, toasts, clock } = engine(on)
  await $.session.start(start)

  const queued = await $.tool.call({ tool: TOOL })
  expect(queued.result).toMatch(/waits for the next message/)
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual(['reload-plugins'])
  expect(prompts).toEqual([])
  expect(toasts.some(t => /Plugins reloaded/.test(t))).toBe(true)
})

test('a refused reload is told to the person, and the resume says it did not run', async ($, on) => {
  const { prompts, toasts, clock } = engine(on, { reload: 'refused' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, resume: 'Go on.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(toasts.some(t => /didn't run/.test(t))).toBe(true)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toMatch(/^Plugin reload didn't run \(.+\)\. Resume: Go on\.$/)
})

test('a reload the command skips is not called a reload', async ($, on) => {
  const { prompts, toasts, clock } = engine(on, { reload: 'skips' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, resume: 'Go on.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(toasts.some(t => t.startsWith('Plugin reload skipped:'))).toBe(true)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toMatch(/^Plugin reload was skipped \(.+--force to apply\.\)\. Resume: Go on\.$/)
})

test('a refused reload with no resume is told to the model in a note', async ($, on) => {
  const { prompts, clock, session } = engine(on, { reload: 'refused' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(prompts).toEqual([])
  expect(JSON.stringify(session.appended())).toMatch(/reload you queued didn't run/)
})

test('an interrupted turn cancels the reload and its resume', async ($, on) => {
  const { commands, prompts, toasts, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, resume: 'Go on.' })
  await $.turn.complete({ ...answered, isAborted: true, reason: 'aborted' })
  await clock.advance(1000)
  expect(commands).toEqual([])
  expect(prompts).toEqual([])
  expect(toasts.some(t => /cancelled/.test(t))).toBe(true)
})

test('a subagent is refused, and nothing is queued', async ($, on) => {
  const { commands, clock } = engine(on)
  await $.session.start(start)

  const refused = await $.tool.call({ tool: TOOL, resume: 'Go on.', agentId: 'a1' })
  expect(refused.deny).toMatch(/subagent/)
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
})

test('a resume left pending too long is dropped, not sent', async ($, on) => {
  const { prompts, toasts, clock } = engine(on, { reload: 'hangs' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, resume: 'Go on.' })
  await $.turn.complete(answered)
  await clock.advance(11 * 60 * 1000)
  await $.session.start(start)
  await clock.settle()
  expect(prompts).toEqual([])
  expect(toasts.some(t => /dropped/.test(t))).toBe(true)
  await clock.advance(HOUR)
  expect(prompts).toEqual([])
})
