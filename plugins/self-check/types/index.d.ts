/**
 * How one tool fared in a check: it answered (`ok`), it didn't (`failed`), it wasn't run because its
 * permission would ask or it was refused (`not-tested`), the session doesn't have it (`absent`), or an
 * MCP server whose tools are listed was not exercised, no probe naming it (`listed`).
 */
export type CheckStatus = 'ok' | 'failed' | 'not-tested' | 'absent' | 'listed'

/**
 * One line of a check: the tool as the record names it (`Bash`, `PowerShell`, `mcp:<server>`), how it
 * fared, and the line the answer shows.
 */
export type CheckLine = { name: string; status: CheckStatus; said: string }

/**
 * How much room this session's env script leaves a Bash command, Git Bash running only the first
 * 8,186 characters of each call: none (`BROKEN`), under 2,000 characters (`AT RISK`: long commands
 * are cut), or more (`OK`).
 */
export type EnvVerdict = 'OK' | 'AT RISK' | 'BROKEN'

/**
 * The record of the last check, at %LOCALAPPDATA%\claude-self-tools\selfcheck\<conversation>.json:
 * when (milliseconds since the epoch), and the failed tools by name only, at most 8.
 */
export type SelfCheckRecord = { v: 1; at: number; failed: string[] }
