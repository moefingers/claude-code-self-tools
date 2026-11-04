// What the shared update-check test (tests/update-check.test.ts, a copy of shared/tests/update-check.test.ts)
// needs of this plugin: its name, a call of one of its tools that answers the same each time, and
// what that call reads beneath the plugin beyond the update check's own.
import type { On } from 'claude-code'

export const PLUGIN = 'self-switch'
export const CALL = {
  tool: 'mcp__self-switch__switch_after_turn',
  to: '6b29fc40-ca47-4c7f-9b8a-2a3f6c1d0e5b',
  reason: 'the other piece is next',
  notes: 'notes/next.md',
} as const

/**
 * The call reads the session's subagents (none) and its store (no switch lately). With no
 * %LOCALAPPDATA%, the gate is left to the switch's own run, so the call is queued. The shared test's
 * classic events aren't raised.
 */
export function world(on: On): void {
  on('agent.list', () => ({ value: [] }))
}
