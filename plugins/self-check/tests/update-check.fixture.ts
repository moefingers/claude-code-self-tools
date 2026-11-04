// What the shared update-check test (tests/update-check.test.ts, a copy of shared/tests/update-check.test.ts)
// needs of this plugin: its name, a call of one of its tools that answers the same each time, and
// what that call reads beneath the plugin beyond the update check's own.
import type { On } from 'claude-code'

export const PLUGIN = 'self-check'
export const CALL = { tool: 'mcp__self-check__tools_check' } as const

/**
 * The session lists no tools, so the check answers the same each time: Bash and PowerShell aren't
 * among them, and there is no MCP server. The shared test's environment has no %LOCALAPPDATA%, so no
 * record is written.
 */
export function world(on: On): void {
  on('tool.list', () => ({ value: [] }))
}
