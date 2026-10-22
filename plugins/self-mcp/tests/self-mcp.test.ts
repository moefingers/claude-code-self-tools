import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__self-mcp__reconnect_mcp_after_turn'

/**
 * The engine beneath the plugin. `reconnect` is what /mcp reconnect does: show its outcome as its own
 * transcript line and hand back no text (`silent`, as Claude Code does), hand back text, or be refused.
 */
function engine(on: On, { reconnect = 'silent' }: { reconnect?: 'silent' | 'reports' | 'refused' } = {}) {
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
    commands.push(`${e.command} ${e.args}`)
    if (reconnect === 'refused') return next(e)
    if (reconnect === 'silent') return {}
    return { text: `Reconnected to ${e.args.replace(/^reconnect /, '')}.\n` }
  })
  return { commands, prompts, toasts, session, clock }
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as const

test('the reconnect runs once the turn ends, and the resume points to its outcome', async ($, on) => {
  const { commands, prompts, clock } = engine(on)
  await $.session.start(start)

  const queued = await $.tool.call({ tool: TOOL, server: ' claude-in-chrome ', resume: ' Take the screenshot again. ' })
  expect(queued.deny).toBeUndefined()
  expect(commands).toEqual([])

  await $.turn.complete(answered)
  expect(commands).toEqual([])
  await clock.advance(1000)
  expect(commands).toEqual(['mcp reconnect claude-in-chrome'])
  expect(prompts).toEqual([
    "MCP reconnect of claude-in-chrome ran: Claude Code's own line above says whether it reconnected. Resume: Take the screenshot again.",
  ])

  // A later turn's end runs nothing more.
  await $.turn.complete({ ...answered, turnId: 't2' })
  await clock.advance(1000)
  expect(commands).toHaveLength(1)
  expect(prompts).toHaveLength(1)
})

test('without resume, the model is told on its next turn, with any text the command hands back', async ($, on) => {
  const { commands, prompts, session, clock } = engine(on, { reconnect: 'reports' })
  await $.session.start(start)

  const queued = await $.tool.call({ tool: TOOL, server: 'all' })
  expect(queued.result).toMatch(/waits for the next message/)
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual(['mcp reconnect all'])
  expect(prompts).toEqual([])
  expect(JSON.stringify(session.appended())).toMatch(/MCP reconnect of all: Reconnected to all\./)
})

test('a refused reconnect says it did not run', async ($, on) => {
  const { prompts, toasts, clock } = engine(on, { reconnect: 'refused' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, server: 'chrome-1', resume: 'Go on.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(toasts.some(t => /didn't run/.test(t))).toBe(true)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toMatch(/^MCP reconnect of chrome-1 didn't run: .+\. Resume: Go on\.$/)
})

test('an interrupted turn cancels the reconnect', async ($, on) => {
  const { commands, prompts, toasts, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, server: 'chrome-1', resume: 'Go on.' })
  await $.turn.complete({ ...answered, isAborted: true, reason: 'aborted' })
  await clock.advance(1000)
  expect(commands).toEqual([])
  expect(prompts).toEqual([])
  expect(toasts.some(t => /cancelled/.test(t))).toBe(true)
})

test('a server name must be given, on one line', async ($, on) => {
  engine(on)
  await $.session.start(start)
  expect((await $.tool.call({ tool: TOOL })).deny).toMatch(/server/)
  expect((await $.tool.call({ tool: TOOL, server: '  ' })).deny).toMatch(/server/)
  expect((await $.tool.call({ tool: TOOL, server: 'a\nreconnect b' })).deny).toMatch(/one line/)
})

test('a subagent is refused', async ($, on) => {
  const { commands, clock } = engine(on)
  await $.session.start(start)
  const call = await $.tool.call({ tool: TOOL, server: 'chrome-1', agentId: 'a1' })
  expect(call.deny).toMatch(/subagent/)
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
})
