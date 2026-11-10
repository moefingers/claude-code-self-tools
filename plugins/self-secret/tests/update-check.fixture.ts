// What the shared update-check test (tests/update-check.test.ts, a copy of shared/tests/update-check.test.ts)
// needs of this plugin: its name, a call of one of its tools that answers the same each time, and
// what that call reads beneath the plugin beyond the update check's own.
import type { On } from 'claude-code'

export const PLUGIN = 'self-secret'
export const CALL = { tool: 'mcp__self-secret__secret_run_command', mode: 'hold-status' } as const

/** The call works out the state folder from Windows' variables. */
export const ENV: Readonly<Record<string, string>> = { OS: 'Windows_NT', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }

/** The call writes the shim there (it reads it first: the shared engine answers no such file). */
export function world(on: On): void {
  on('fs.write', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
}
