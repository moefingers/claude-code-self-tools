// What the shared update-check test (tests/update-check.test.ts, a copy of shared/tests/update-check.test.ts)
// needs of this plugin: its name, a call of one of its tools that answers the same each time, and
// what that call reads beneath the plugin beyond the update check's own.
import type { On } from 'claude-code'

export const PLUGIN = 'self-chrome'
export const CALL = { tool: 'mcp__self-chrome__chrome_ensure' } as const

/**
 * The session runs on Linux, where the plugin looks after no Chrome: the call answers the same each time, and runs,
 * reads and queues nothing.
 */
export function world(on: On): void {
  on('session.info', () => ({ value: { transcriptPath: '', platform: 'linux' as const, isHosted: false } }))
}
