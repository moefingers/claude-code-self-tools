// What the shared update-check test (tests/update-check.test.ts, a copy of shared/tests/update-check.test.ts)
// needs of this plugin: its name, a call of one of its tools that answers the same each time, and
// what that call reads beneath the plugin beyond the update check's own.
import type { On } from 'claude-code'

export const PLUGIN = 'self-desktop'
export const CALL = { tool: 'mcp__self-desktop__desktop_windows' } as const

/**
 * The plugin is off by default, and the session runs on Linux: the call answers that it is off, the same each time,
 * and the cleaning of old captures, which asks where the session runs, finds nothing to clean there.
 */
export function world(on: On): void {
  on('session.info', () => ({ value: { transcriptPath: '', platform: 'linux' as const, isHosted: false } }))
}
