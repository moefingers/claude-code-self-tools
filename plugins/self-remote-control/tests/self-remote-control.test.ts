import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

const TOOL = 'mcp__self-remote-control__remote_control'
const ENGINE = { plugin: 'engine', tier: 'core' } as const
const CONNECTED = 'Disconnect Remote Control'
const NOT_CONNECTED = 'Control this session from your phone or claude.ai/code'

type Options = { description?: string | null; remoteControl?: string; surfaces?: RenderSurface[]; refused?: boolean }

/**
 * The engine beneath the plugin. Its remote-control command is a toggle, as the real one is: run
 * while connected, it disconnects. `rc.description` is what the command list shows for it (null:
 * no such command in this session).
 */
function engine(on: On, { description = NOT_CONNECTED, remoteControl = 'false', surfaces = ['terminal'], refused }: Options = {}) {
  const commands: string[] = []
  const toasts: string[] = []
  const rc = { description }
  const clock = mock.clock(on)
  const session = mock.session(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('turn.complete', () => ({ text: 'done' }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('config.list', () => ({
    value: [
      {
        key: 'remoteControl',
        label: 'Remote Control for all sessions',
        kind: 'choice',
        value: remoteControl,
        options: ['true', 'false', 'default'],
        provider: ENGINE,
        isLocked: false,
      },
    ],
  }))
  on('command.list', () => ({
    value: [
      { name: 'compact', description: 'Clear conversation history but keep a summary in context', source: 'builtin' },
      ...(rc.description === null ? [] : [{ name: 'remote-control', description: rc.description, source: 'builtin' as const }]),
    ],
  }))
  on('command.run', (_, e, next) => {
    commands.push(e.command)
    if (refused) return next(e)
    if (e.command === 'remote-control') rc.description = rc.description === CONNECTED ? NOT_CONNECTED : CONNECTED
    return { text: '' }
  })
  return { commands, toasts, rc, clock, session }
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' } as const

test('status reports the connection, the setting for all sessions and the attached clients', async ($, on) => {
  engine(on, { description: CONNECTED, remoteControl: 'false', surfaces: ['terminal'] })
  await $.session.start(start)

  const read = await $.tool.call({ tool: TOOL, action: 'status' })
  expect(read.result).toBe(
    'Remote Control: connected. Remote Control for all sessions (/config remoteControl): false. Attached clients: terminal.',
  )
})

test('status says so when the reading is not one it knows, or there is no command', async ($, on) => {
  const { rc } = engine(on, { description: 'Something new' })
  await $.session.start(start)

  expect((await $.tool.call({ tool: TOOL, action: 'status' })).result).toMatch(/^Remote Control: unknown \(the remote-control command reads "Something new"\)\./)
  rc.description = null
  expect((await $.tool.call({ tool: TOOL, action: 'status' })).result).toMatch(/^Remote Control: unavailable in this session/)
})

test('connect runs the command once the turn ends, when not connected, and says it took', async ($, on) => {
  const { commands, toasts, clock } = engine(on)
  await $.session.start(start)

  const queued = await $.tool.call({ tool: TOOL, action: 'connect' })
  expect(queued.result).toMatch(/^Queued: Remote Control connects once this turn ends/)
  expect(commands).toEqual([])

  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(1000)
  expect(commands).toEqual(['remote-control'])
  await clock.advance(3000)
  expect(toasts).toContain('Remote Control connected.')
})

test('connect never runs the toggle while connected', async ($, on) => {
  const { commands, rc, clock } = engine(on, { description: CONNECTED })
  await $.session.start(start)

  const already = await $.tool.call({ tool: TOOL, action: 'connect' })
  expect(already.result).toBe('Remote Control is already connected; nothing to do.')
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(5000)
  expect(commands).toEqual([])
  expect(rc.description).toBe(CONNECTED)
})

test('connect checks again at the turn end, and runs nothing if it connected meanwhile', async ($, on) => {
  const { commands, toasts, rc, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, action: 'connect' })
  rc.description = CONNECTED
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(5000)
  expect(commands).toEqual([])
  expect(rc.description).toBe(CONNECTED)
  expect(toasts).toContain('Remote Control was already connected; nothing ran.')
})

test('connect refuses a reading it does not recognise, and when there is no command', async ($, on) => {
  const { commands, rc, clock } = engine(on, { description: 'Remote Control (beta)' })
  await $.session.start(start)

  const unknown = await $.tool.call({ tool: TOOL, action: 'connect' })
  expect(unknown.deny).toMatch(/doesn't recognise/)
  rc.description = null
  const missing = await $.tool.call({ tool: TOOL, action: 'connect' })
  expect(missing.deny).toMatch(/no remote-control command/)
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(5000)
  expect(commands).toEqual([])
})

test('a reading that turns unknown by the turn end runs nothing, and the model is told', async ($, on) => {
  const { commands, toasts, rc, clock, session } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, action: 'connect' })
  rc.description = 'Remote Control (beta)'
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(5000)
  expect(commands).toEqual([])
  expect(toasts.some(t => t.startsWith('Remote Control not connected:'))).toBe(true)
  expect(JSON.stringify(session.appended())).toMatch(/connect you queued did not run/)
})

test('an interrupted turn cancels a queued connect', async ($, on) => {
  const { commands, toasts, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, action: 'connect' })
  await $.turn.complete({ ...answered, turnId: 't1', isAborted: true, reason: 'aborted' })
  await clock.advance(5000)
  expect(commands).toEqual([])
  expect(toasts.some(t => /cancelled/.test(t))).toBe(true)
})

test('a refused command is told to the person and to the model', async ($, on) => {
  const { toasts, clock, session } = engine(on, { refused: true })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, action: 'connect' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(5000)
  expect(toasts.some(t => t.startsWith("Remote Control didn't connect:"))).toBe(true)
  expect(JSON.stringify(session.appended())).toMatch(/connect you queued didn't run/)
})

test('a subagent is refused', async ($, on) => {
  const { commands, clock } = engine(on)
  await $.session.start(start)

  expect((await $.tool.call({ tool: TOOL, action: 'status', agentId: 'a1' })).deny).toMatch(/subagent/)
  expect((await $.tool.call({ tool: TOOL, action: 'connect', agentId: 'a1' })).deny).toMatch(/subagent/)
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(5000)
  expect(commands).toEqual([])
})
