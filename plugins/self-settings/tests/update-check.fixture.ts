// What the shared update-check test (tests/update-check.test.ts, a copy of shared/tests/update-check.test.ts)
// needs of this plugin: its name, a call of one of its tools that answers the same each time, and
// what that call reads beneath the plugin beyond the update check's own.
import type { On } from 'claude-code'

export const PLUGIN = 'self-settings'
export const CALL = { tool: 'mcp__self-settings__settings_read' } as const

/**
 * What settings_read reads: the /config rows (none here, so it answers the same each time) and the enabledPlugins
 * setting; and Claude Code's own permission check, which lets the call on to its serving at tool.run.
 */
export function world(on: On): void {
  on('config.list', () => ({ value: [] }))
  on('settings.read', () => ({ value: {} }))
  on('tool.check', () => ({ decision: 'allow' as const }))
}
