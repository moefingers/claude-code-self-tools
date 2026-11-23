// What the shared update-check test (tests/update-check.test.ts, a copy of shared/tests/update-check.test.ts)
// needs of this plugin: its name, a call of one of its tools that answers the same each time, and
// what that call reads beneath the plugin beyond the update check's own.
import type { On } from 'claude-code'

export const PLUGIN = 'self-update'
export const CALL = { tool: 'mcp__self-update__update_status' } as const

/** With autoUpdate empty, as the shared test leaves it, update_status reads nothing: it says self-update is off. */
export function world(_on: On): void {}
