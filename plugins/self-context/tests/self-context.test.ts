import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__self-context__context_usage'
const ENGINE = { plugin: 'engine', tier: 'core' } as const

type Reading = { tokens?: number; percent?: number; autoCompact?: boolean; withCompactTool?: boolean }

/** The engine beneath the plugin: the window's fill, the /config rows, the tools; and any change asked of it. */
function engine(on: On, { tokens, percent, autoCompact, withCompactTool = false }: Reading = {}) {
  const changes: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000, tokens, percent }, rateLimits: [] },
  }))
  on('config.list', () => ({
    value: [
      { key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', options: ['dark', 'light'], provider: ENGINE, isLocked: false },
      ...(autoCompact === undefined
        ? []
        : [{ key: 'autoCompact', label: 'Auto-compact', kind: 'boolean' as const, value: autoCompact, provider: ENGINE, isLocked: false }]),
    ],
  }))
  on('tool.list', () => ({
    value: [
      { name: 'Read', description: 'Reads a file.', mcp: false },
      ...(withCompactTool ? [{ name: 'mcp__self-compact__compact_after_turn', description: 'Compacts.', mcp: true }] : []),
    ],
  }))
  on('config.set', (_, e) => {
    changes.push(`config ${e.key}`)
    return { value: e.value }
  })
  on('command.run', (_, e) => {
    changes.push(`command ${e.command}`)
    return { text: '' }
  })
  return { changes }
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const

test('reports the tokens, the window, the percentage and auto-compact', async ($, on) => {
  engine(on, { tokens: 123456, percent: 62, autoCompact: true, withCompactTool: true })
  await $.session.start(start)

  const read = await $.tool.call({ tool: TOOL })
  expect(read.deny).toBeUndefined()
  expect(read.result).toBe(
    'Context: 123,456 of 200,000 tokens (62%). Auto-compact is on. To compact at this break, call compact_after_turn.',
  )
})

test('says when there is no reading yet, and names no compact tool that is not there', async ($, on) => {
  engine(on, { autoCompact: false })
  await $.session.start(start)

  const read = await $.tool.call({ tool: TOOL })
  expect(read.result).toMatch(/^Context: no reading yet\. The window holds 200,000 tokens/)
  expect(read.result).toMatch(/Auto-compact is off\.$/)
  expect(read.result).not.toMatch(/compact_after_turn/)
})

test('works out the percentage when the engine gives none, and says when auto-compact has no row', async ($, on) => {
  engine(on, { tokens: 50000 })
  await $.session.start(start)

  const read = await $.tool.call({ tool: TOOL })
  expect(read.result).toBe('Context: 50,000 of 200,000 tokens (25%). Auto-compact: not listed in /config.')
})

test('a subagent is refused, since the figures are not its own', async ($, on) => {
  engine(on, { tokens: 1000, percent: 1, autoCompact: true })
  await $.session.start(start)

  const refused = await $.tool.call({ tool: TOOL, agentId: 'a1' })
  expect(refused.deny).toMatch(/main conversation's/)
})

test('reading changes nothing: no setting, no command', async ($, on) => {
  const { changes } = engine(on, { tokens: 1000, percent: 1, autoCompact: true, withCompactTool: true })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL })
  await $.tool.call({ tool: TOOL })
  expect(changes).toEqual([])
})
