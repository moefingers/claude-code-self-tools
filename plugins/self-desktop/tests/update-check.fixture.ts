// What the shared update-check test (tests/update-check.test.ts, a copy of shared/tests/update-check.test.ts)
// needs of this plugin: its name, a call of one of its tools that answers the same each time, and
// what that call reads beneath the plugin beyond the update check's own.
import type { On } from 'claude-code'

export const PLUGIN = 'self-desktop'
export const CALL = { tool: 'mcp__self-desktop__desktop_windows' } as const

/** The plugin is off by default: the call answers that it is off, the same each time, and reads and runs nothing. */
export function world(_on: On): void {}
