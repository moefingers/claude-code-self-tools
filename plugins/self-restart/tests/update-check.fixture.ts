// What the shared update-check test (tests/update-check.test.ts, a copy of shared/tests/update-check.test.ts)
// needs of this plugin: its name, a call of one of its tools that answers the same each time, and
// what that call reads beneath the plugin beyond the update check's own.
import type { On } from 'claude-code'

export const PLUGIN = 'self-restart'
export const CALL = { tool: 'mcp__self-restart__restart_after_turn', reason: 'the account changed' } as const

/** The call reads the session's subagents: none. The shared test's classic events aren't raised. */
export function world(on: On): void {
  on('agent.list', () => ({ value: [] }))
}
