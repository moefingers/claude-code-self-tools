// What the shared update-check test (tests/update-check.test.ts, a copy of shared/tests/update-check.test.ts)
// needs of this plugin: its name, a call of one of its tools that answers the same each time, and
// what that call reads beneath the plugin beyond the update check's own.
import type { On } from 'claude-code'

export const PLUGIN = 'self-wake'
export const CALL = { tool: 'mcp__self-wake__cancel_wake' } as const

/** With no wake-up set, cancel_wake reads the clock and answers that there is nothing to cancel. */
export function world(_on: On): void {}
