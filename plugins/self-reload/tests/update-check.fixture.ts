// What the shared update-check test (tests/update-check.test.ts, a copy of shared/tests/update-check.test.ts)
// needs of this plugin: its name, a call of one of its tools that answers the same each time, and
// what that call reads beneath the plugin beyond the update check's own.
import type { On } from 'claude-code'

export const PLUGIN = 'self-reload'
export const CALL = { tool: 'mcp__self-reload__reload_plugins_after_turn' } as const

/** The queued reload only shows a status line. */
export function world(_on: On): void {}
