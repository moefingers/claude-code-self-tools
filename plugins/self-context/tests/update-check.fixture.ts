// What the shared update-check test (tests/update-check.test.ts, a copy of shared/tests/update-check.test.ts)
// needs of this plugin: its name, a call of one of its tools that answers the same each time, and
// what that call reads beneath the plugin beyond the update check's own.
import type { On } from 'claude-code'

export const PLUGIN = 'self-context'
export const CALL = { tool: 'mcp__self-context__context_usage' } as const

/** The window's fill, the /config rows and the tools that context_usage reads. */
export function world(on: On): void {
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [] } }))
  on('config.list', () => ({ value: [] }))
  on('tool.list', () => ({ value: [] }))
}
