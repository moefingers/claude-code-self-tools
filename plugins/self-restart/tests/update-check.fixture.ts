// What the shared update-check test (tests/update-check.test.ts, a copy of shared/tests/update-check.test.ts)
// needs of this plugin: its name, a call of one of its tools that answers the same each time, and
// what that call reads beneath the plugin beyond the update check's own.
import type { On } from 'claude-code'

export const PLUGIN = 'self-restart'
export const CALL = { tool: 'mcp__self-restart__restart_after_turn', reason: 'the account changed' } as const

/**
 * The call plans the launch at once, refusing it anywhere but Windows: what it reads of a Windows machine,
 * beneath each test's own environment. No %LOCALAPPDATA%, so no probe runs.
 */
export const ENV: Readonly<Record<string, string>> = { OS: 'Windows_NT', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u' }

/** The machine probe's answer: this session's claude.exe, nothing running under it. */
const AT_REST = `${JSON.stringify({
  v: 1,
  self: 300,
  session: { pid: 100, created: '134062345688901240' },
  slot: null,
  procs: [
    { pid: 20, ppid: 10, created: '134062345678901240', name: 'powershell.exe', cls: 'shell' },
    { pid: 100, ppid: 20, created: '134062345688901240', name: 'claude.exe' },
    { pid: 300, ppid: 100, created: '134062355668901240', name: 'powershell.exe', cls: 'shell' },
  ],
  registry: [],
  transcripts: [],
  locks: [],
  claim: null,
  heavy: null,
  freeKb: null,
  errors: [],
})}\r\n`

/**
 * The call checks the folder the session started in ('/', the shared test's) against the conversation's
 * transcript, which is there, under that folder's project folder (`-`). Its pre-check runs the machine
 * probe (nothing under the session), and reads the session's subagents (none) and its crons (CronList,
 * allowed, lists none). The shared test's classic events aren't raised.
 */
export function world(on: On): void {
  on('fs.exists', (_, e) => ({ value: /\\projects\\-\\[0-9a-f-]{36}\.jsonl$/.test(e.path) }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: AT_REST, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('agent.list', () => ({ value: [] }))
  on('tool.check', { tool: 'CronList' }, () => ({ decision: 'allow' as const }))
  on('tool.call', { tool: 'CronList' }, () => ({ result: { jobs: [] } }) as never)
}
