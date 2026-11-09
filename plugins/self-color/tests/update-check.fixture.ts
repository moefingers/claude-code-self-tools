// What the shared update-check test (tests/update-check.test.ts, a copy of shared/tests/update-check.test.ts)
// needs of this plugin: its name, a call of one of its tools that answers the same each time, and
// what that call reads beneath the plugin beyond the update check's own.
import type { On } from 'claude-code'

export const PLUGIN = 'self-color'
export const CALL = { tool: 'mcp__self-color__color_after_turn', color: 'cyan' } as const

/** The queued color change only shows a status line. */
export function world(_on: On): void {}
