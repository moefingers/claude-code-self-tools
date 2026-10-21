import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const EFFORT = 'mcp__self-config__set_effort'
const MODEL = 'mcp__self-config__set_model'
const ENGINE = { plugin: 'engine', tier: 'core' } as const
const MODELS = ['default', 'sonnet', 'opus', 'haiku', 'sonnet[1m]']

type Options = { effort?: string; model?: string; isLocked?: boolean; effortRefused?: boolean; modelDenied?: string }

/**
 * The engine beneath the plugin, with /config rows the plugin must leave alone beside the Model
 * row. `touched` records every setting written and every command run, in order.
 */
function engine(on: On, { effort = 'medium', model = 'opus', isLocked = false, effortRefused, modelDenied }: Options = {}) {
  const touched: string[] = []
  const toasts: string[] = []
  const rows = {
    model: { key: 'model', label: 'Model', kind: 'choice' as const, value: model, options: MODELS, provider: ENGINE, isLocked },
    permissionMode: {
      key: 'permissionMode',
      label: 'Permission mode',
      kind: 'choice' as const,
      value: 'default',
      options: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
      provider: ENGINE,
      isLocked: false,
    },
    autoCompact: { key: 'autoCompact', label: 'Auto-compact', kind: 'boolean' as const, value: true, provider: ENGINE, isLocked: false },
  }
  const level = { now: effort }
  const clock = mock.clock(on)
  const session = mock.session(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__self-config__${e.name}` } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('turn.complete', () => ({ text: 'done' }))
  on('classic.Stop', () => ({}))
  on('config.list', () => ({ value: Object.values(rows) }))
  on('config.set', (_, e) => {
    touched.push(`config ${e.key}=${String(e.value)}`)
    if (modelDenied !== undefined) return { deny: modelDenied }
    if (e.key === 'model') rows.model = { ...rows.model, value: String(e.value) }
    return { value: e.value }
  })
  on('command.run', (_, e, next) => {
    touched.push(`command ${e.command} ${e.args}`.trim())
    if (effortRefused) return next(e)
    if (e.command === 'effort' && e.args === 'status') return { text: `Current effort level: ${level.now} (balanced)` }
    if (e.command === 'effort') {
      level.now = e.args
      return { text: `Set effort level to ${e.args} (this session only): how hard the model thinks.` }
    }
    return { text: '' }
  })
  return { touched, toasts, rows, clock, session }
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' } as const

test('an effort switch runs as the turn ends, announced from the level the engine reported', async ($, on) => {
  const { touched, toasts, clock } = engine(on)
  await $.session.start(start)
  await $.classic.Stop({ stop_hook_active: false, effort: { level: 'medium' } })

  const queued = await $.tool.call({ tool: EFFORT, level: 'low' })
  expect(queued.result).toBe('Queued: effort from medium to low. It switches when this turn ends, for the turns after it.')
  expect(touched).toEqual([])

  await $.turn.complete({ ...answered, turnId: 't1' })
  expect(touched).toEqual([])
  await clock.advance(1000)
  expect(touched).toEqual(['command effort low'])
  expect(toasts).toContain('Effort: from medium to low. Set effort level to low (this session only): how hard the model thinks.')

  // And back, once the next turn's end has reported the new level.
  await $.classic.Stop({ stop_hook_active: false, effort: { level: 'low' } })
  const back = await $.tool.call({ tool: EFFORT, level: 'MEDIUM' })
  expect(back.result).toMatch(/^Queued: effort from low to medium\./)
  await $.turn.complete({ ...answered, turnId: 't2' })
  await clock.advance(1000)
  expect(touched).toEqual(['command effort low', 'command effort medium'])
  expect(toasts.some(t => t.startsWith('Effort: from low to medium.'))).toBe(true)
})

test('with no level reported yet, "from" is what /effort status says', async ($, on) => {
  const { touched, toasts, clock } = engine(on, { effort: 'high' })
  await $.session.start(start)

  const queued = await $.tool.call({ tool: EFFORT, level: 'xhigh' })
  expect(queued.result).toMatch(/^Queued: effort from its current level to xhigh\./)
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(1000)
  expect(touched).toEqual(['command effort status', 'command effort xhigh'])
  expect(toasts.some(t => t.startsWith('Effort: from high to xhigh.'))).toBe(true)
})

test('a model switch goes through the Model row as the turn ends, announced from X to Y', async ($, on) => {
  const { touched, toasts, rows, clock } = engine(on, { model: 'opus' })
  await $.session.start(start)

  const queued = await $.tool.call({ tool: MODEL, model: 'Sonnet' })
  expect(queued.result).toBe('Queued: model from opus to sonnet. It switches when this turn ends, for the turns after it.')
  expect(touched).toEqual([])

  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(1000)
  expect(touched).toEqual(['config model=sonnet'])
  expect(rows.model.value).toBe('sonnet')
  expect(toasts).toContain('Model: from opus to sonnet.')
})

test('both in one turn: the model switches first, then the effort', async ($, on) => {
  const { touched, clock } = engine(on)
  await $.session.start(start)
  await $.classic.Stop({ stop_hook_active: false, effort: { level: 'medium' } })

  await $.tool.call({ tool: EFFORT, level: 'high' })
  await $.tool.call({ tool: MODEL, model: 'sonnet' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(1000)
  // The new model may bring another default level, so "from" is read afresh.
  expect(touched).toEqual(['config model=sonnet', 'command effort status', 'command effort high'])
})

test('a model the row does not offer is refused with the list, and the model in use queues nothing', async ($, on) => {
  const { touched, clock } = engine(on)
  await $.session.start(start)

  const unknown = await $.tool.call({ tool: MODEL, model: 'gpt' })
  expect(unknown.deny).toBe(`"gpt" is not one of the Model row's options: ${MODELS.join(', ')}.`)
  const same = await $.tool.call({ tool: MODEL, model: 'opus' })
  expect(same.result).toMatch(/already opus/)
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(1000)
  expect(touched).toEqual([])
})

test('a Model row a managed policy holds is refused', async ($, on) => {
  engine(on, { isLocked: true })
  await $.session.start(start)

  const refused = await $.tool.call({ tool: MODEL, model: 'sonnet' })
  expect(refused.deny).toMatch(/managed policy/)
})

test('only the effort command and the Model row are ever touched, whatever the input', async ($, on) => {
  const { touched, rows, clock } = engine(on)
  await $.session.start(start)

  const attempts = [
    await $.tool.call({ tool: EFFORT, level: 'ultracode' }),
    await $.tool.call({ tool: EFFORT, level: 'ultracode on' }),
    await $.tool.call({ tool: EFFORT, level: 'permissionMode' }),
    await $.tool.call({ tool: EFFORT, level: 'plan' }),
    await $.tool.call({ tool: MODEL, model: 'permissionMode' }),
    await $.tool.call({ tool: MODEL, model: 'bypassPermissions' }),
    await $.tool.call({ tool: MODEL, model: 'acceptEdits' }),
  ]
  for (const attempt of attempts) expect(attempt.deny).toBeDefined()

  // Extra fields naming another row or command are ignored: only `level` and `model` are read.
  await $.tool.call({ tool: MODEL, model: 'haiku', key: 'permissionMode', value: 'bypassPermissions' })
  await $.tool.call({ tool: EFFORT, level: 'low', command: 'config', args: 'permissionMode=bypassPermissions' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(1000)

  expect(touched.length).toBeGreaterThan(0)
  for (const line of touched) expect(line).toMatch(/^(config model=|command effort )/)
  expect(touched).toEqual(['config model=haiku', 'command effort status', 'command effort low'])
  expect(rows.permissionMode.value).toBe('default')
  expect(rows.autoCompact.value).toBe(true)
})

test('an interrupted turn cancels the switches it queued', async ($, on) => {
  const { touched, toasts, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: EFFORT, level: 'low' })
  await $.tool.call({ tool: MODEL, model: 'sonnet' })
  await $.turn.complete({ ...answered, turnId: 't1', isAborted: true, reason: 'aborted' })
  await clock.advance(1000)
  expect(touched).toEqual([])
  expect(toasts.some(t => /cancelled/.test(t))).toBe(true)
})

test('a subagent is refused by both tools', async ($, on) => {
  const { touched, clock } = engine(on)
  await $.session.start(start)

  const effort = await $.tool.call({ tool: EFFORT, level: 'low', agentId: 'a1' })
  const model = await $.tool.call({ tool: MODEL, model: 'sonnet', agentId: 'a1' })
  expect(effort.deny).toMatch(/subagent/)
  expect(model.deny).toMatch(/subagent/)
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(1000)
  expect(touched).toEqual([])
})

test('a refused effort command is told to the person and to the model', async ($, on) => {
  const { toasts, clock, session } = engine(on, { effortRefused: true })
  await $.session.start(start)
  await $.classic.Stop({ stop_hook_active: false, effort: { level: 'medium' } })

  await $.tool.call({ tool: EFFORT, level: 'low' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(1000)
  expect(toasts.some(t => t.startsWith('Not switched: effort to low'))).toBe(true)
  expect(JSON.stringify(session.appended())).toMatch(/A switch you queued did not happen: effort to low/)
})

test('a refused model switch is told to the person and to the model', async ($, on) => {
  const { toasts, clock, session } = engine(on, { modelDenied: 'only its dialog changes it' })
  await $.session.start(start)

  await $.tool.call({ tool: MODEL, model: 'sonnet' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(1000)
  expect(toasts).toContain('Not switched: the model to sonnet: only its dialog changes it')
  expect(JSON.stringify(session.appended())).toMatch(/did not happen: the model to sonnet/)
})
