// The one process self-restart starts, and everything it is given.
//
// The plugin runs Windows PowerShell by its known path under the Windows folder, with this fixed
// script as an -EncodedCommand. The script's only variable part is the session id, which must be a
// UUID (SESSION_ID) before it gets here: no text from the tool's input reaches the script, the argv
// or a command line.
//
// The script finds the session's own claude.exe above it, then starts a new console window with
// Start-Process. A probe found that `cmd /c start` hands its inheritable handles on, so the plugin's
// $.process.run, which reads the child's output to its end, would wait out the whole new session;
// Start-Process doesn't, and its window outlives the session it came from. The window waits for
// that claude.exe to exit, so two copies never write one session (and Remote Control, which a second
// copy leaves off, connects in the new one), then runs `claude --resume <id>` from PATH. If the old
// process is still there after 10 minutes, the window says so and resumes nothing.

/** A session id `claude --resume` takes: a UUID, lowercase as Claude Code writes it. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The Windows folder as SystemRoot names it: a drive and one plain folder, such as C:\Windows. */
export const SYSTEM_ROOT = /^[A-Za-z]:\\[A-Za-z0-9_ -]{1,64}$/

/** How long the new window waits for the old process to exit, in seconds. */
export const WAIT_SECONDS = 600

/** Windows PowerShell by its known path under the Windows folder. */
export const powershellPath = (systemRoot: string): string => `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

/** The line the script ends with once the window is open: `launched <pid of the process it waits on>`. */
export const LAUNCHED = /^launched (\d+)\s*$/m

/**
 * The launcher script for session `id`. Throws on an id that isn't a UUID, so nothing else can be
 * spliced into it.
 */
export function launcherScript(id: string): string {
  if (!SESSION_ID.test(id)) throw new Error(`not a session id: ${JSON.stringify(id)}`)
  return [
    "$ErrorActionPreference = 'Stop'",
    `$id = '${id}'`,
    // Every process once, by id: the walk up from this launcher reads only this table.
    '$table = @{}',
    'foreach ($p in (Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, Name)) { $table[[int]$p.ProcessId] = $p }',
    // The nearest claude.exe above this launcher, then the top of an unbroken run of claude.exe
    // parents, so a helper process of the session's own is never taken for the session.
    '$session = $null',
    '$at = $table[[int]$PID]',
    'for ($i = 0; $i -lt 8 -and $null -ne $at; $i++) {',
    '  $at = $table[[int]$at.ParentProcessId]',
    "  if ($null -ne $at -and $at.Name -eq 'claude.exe') { $session = $at; break }",
    '}',
    'if ($null -eq $session) { \'self-restart: no claude.exe above this launcher\'; exit 3 }',
    'for ($i = 0; $i -lt 8; $i++) {',
    '  $up = $table[[int]$session.ParentProcessId]',
    "  if ($null -eq $up -or $up.Name -ne 'claude.exe') { break }",
    '  $session = $up',
    '}',
    "$claude = Get-Command -Name 'claude' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1",
    "if ($null -eq $claude) { 'self-restart: no claude on PATH'; exit 4 }",
    '$wait = [int]$session.ProcessId',
    `$exe = $claude.Source -replace "'", "''"`,
    // The new window's script: only the process id, the session id and claude's path go in.
    '$inner = @(',
    `  "Write-Host 'Waiting for the old Claude Code process ($wait) to exit, then resuming session $id here.'",`,
    `  "Wait-Process -Id $wait -Timeout ${WAIT_SECONDS} -ErrorAction SilentlyContinue",`,
    '  "if (Get-Process -Id $wait -ErrorAction SilentlyContinue) {",',
    `  "  Write-Host 'The old process is still running, so the session is not resumed here: two copies would both write to it.'",`,
    `  "  Write-Host 'Once it has exited, run: claude --resume $id'",`,
    `  "  Read-Host 'Press Enter to close this window' | Out-Null",`,
    '  "  exit 1",',
    '  "}",',
    `  "& '$exe' --resume '$id'"`,
    ') -join [Environment]::NewLine',
    '$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))',
    "Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile', '-EncodedCommand', $encoded",
    '"launched $wait"',
  ].join('\r\n')
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** `script` as PowerShell's -EncodedCommand takes it: UTF-16LE, then base64. */
export function encodeCommand(script: string): string {
  const bytes: number[] = []
  for (let i = 0; i < script.length; i += 1) {
    const unit = script.charCodeAt(i)
    bytes.push(unit & 0xff, unit >> 8)
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += BASE64.charAt((n >> 18) & 63) + BASE64.charAt((n >> 12) & 63)
    out += b === undefined ? '=' : BASE64.charAt((n >> 6) & 63)
    out += c === undefined ? '=' : BASE64.charAt(n & 63)
  }
  return out
}
