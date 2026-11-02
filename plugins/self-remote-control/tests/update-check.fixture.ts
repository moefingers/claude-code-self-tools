// What the shared update-check test (tests/update-check.test.ts, a copy of shared/tests/update-check.test.ts)
// needs of this plugin: its name, a call of one of its tools that answers the same each time, and
// what that call reads beneath the plugin beyond the update check's own.
import type { On } from 'claude-code'

export const PLUGIN = 'self-remote-control'
export const CALL = { tool: 'mcp__self-remote-control__remote_control', action: 'status' } as const

/** What `status` reads: the remote-control command, the /config rows and the attached clients. */
export function world(on: On): void {
  on('command.list', () => ({
    value: [{ name: 'remote-control', description: 'Control this session from your phone or claude.ai/code', source: 'builtin' as const }],
  }))
  on('config.list', () => ({ value: [] }))
  on('session.surfaces', () => ({ value: ['terminal' as const] }))
}
