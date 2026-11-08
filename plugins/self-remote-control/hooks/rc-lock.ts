// The Remote Control lock: one per session, taken by every plugin that runs /remote-control in it
// (this one, and the coordinator plugin after a switch it made), so two that read "not connected"
// together don't both run it. Run while connected, /remote-control opens the Remote Control panel
// and waits for a person, so the second run would hold the session.
//
// The protocol, the same in every plugin that takes it (README, "The Remote Control lock"):
//   - the file %LOCALAPPDATA%\claude-self-tools\rc\<sessionId>.lock, where sessionId is
//     `$.session.id()`, holding {"v":1,"by":"<plugin name>","at":<ms>} (UTF-8, no BOM);
//   - taken and released ONLY by the two canonical scripts below, run byte for byte (their SHA-256
//     pinned here and in the coordinator plugin), each one Windows PowerShell process:
//       TAKE: create the file exclusively; if it is there, open it with no sharing at all, judge
//       its `at` (else its modification time) under that handle, and if it is stale (over 90 s
//       old, or over 90 s in the future) overwrite it in place through the same handle. It never
//       deletes the lock. It also deletes other sessions' lock files untouched for a day.
//       RELEASE: open it letting others only delete, compare its text with the taker's own, and
//       delete it while holding that handle; another's text is left untouched;
//   - held from just before the fresh "not connected" reading until the session reads connected,
//     or LOCK_HOLD_MS; /remote-control runs only while it is held, after that fresh reading.
// The scripts get the path and the text in the environment (RC_LOCK_PATH, RC_LOCK_TEXT), so their
// bytes never change. Where the lock can't be placed (no %LOCALAPPDATA% folder, no session id, no
// %SystemRoot%: off Windows), the lock is one in this session's state instead, which serialises
// this plugin's own two paths (a queued connect, a reconnect after a login change).
import type { EngineInterface } from 'claude-code'
import type { Held } from '../types'

const memoryRef = { plugin: 'self-remote-control', key: 'rcLock' } as const

/** The name the lock is taken under. */
export const BY = 'self-remote-control'
/** A lock younger than this is held: nothing runs (the scripts' own figure; the state's lock uses it too). */
export const LOCK_FRESH_MS = 90_000
/** The longest a taker holds it: released then, connected or not. */
export const LOCK_HOLD_MS = 60_000
/** How long one PowerShell call may take. */
const PS_TIMEOUT_MS = 20_000

// BEGIN canonical scripts (scratchpad rc-lock-scripts\take.ps1 and release.ps1, byte for byte)
export const TAKE_SCRIPT = `# claude-self-tools rc-lock take, v1: the canonical script, run byte for byte by every plugin that takes the lock.
# In: RC_LOCK_PATH, the session's lock file; RC_LOCK_TEXT, this taker's {"v":1,"by":"<plugin>","at":<ms>}.
# Out, one line: "taken", or "held|<by>|<age ms>". It never deletes the lock it takes: a stale one
# (over 90 s old, or over 90 s in the future) is overwritten in place, under a handle no one else
# can open. While here, it deletes other sessions' lock files untouched for a day.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$path = $env:RC_LOCK_PATH
$text = $env:RC_LOCK_TEXT
$staleMs = 90000
$sweepMs = 86400000
$utf8 = New-Object Text.UTF8Encoding($false)
$bytes = $utf8.GetBytes($text)
$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$folder = [IO.Path]::GetDirectoryName($path)
[void][IO.Directory]::CreateDirectory($folder)
foreach ($other in [IO.Directory]::GetFiles($folder, '*.lock')) {
  if ($other -eq $path) { continue }
  try {
    $handle = [IO.File]::Open($other, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Delete)
    try {
      $written = ([DateTimeOffset][IO.File]::GetLastWriteTimeUtc($other)).ToUnixTimeMilliseconds()
      if ($nowMs - $written -gt $sweepMs) { [IO.File]::Delete($other) }
    } finally { $handle.Dispose() }
  } catch { }
}
$result = 'held|busy|0'
$stream = $null
try { $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) } catch { $stream = $null }
if ($null -ne $stream) {
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush() } finally { $stream.Dispose() }
  $result = 'taken'
} else {
  try { $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) } catch { $stream = $null }
  if ($null -ne $stream) {
    try {
      $reader = New-Object IO.StreamReader($stream, $utf8, $false, 4096, $true)
      $old = $reader.ReadToEnd()
      $reader.Dispose()
      $at = $null
      $by = 'unknown'
      try {
        $doc = $old | ConvertFrom-Json
        if ($doc.at -is [ValueType]) { $at = [double]$doc.at }
        if ($doc.by -is [string] -and $doc.by -cmatch '^[A-Za-z0-9._:-]{1,64}$') { $by = $doc.by }
      } catch { $at = $null }
      if ($null -eq $at -or [double]::IsNaN($at) -or [double]::IsInfinity($at)) {
        $at = [double]([DateTimeOffset][IO.File]::GetLastWriteTimeUtc($path)).ToUnixTimeMilliseconds()
      }
      $age = $nowMs - $at
      if ($age -gt $staleMs -or $age -lt (0 - $staleMs)) {
        $stream.SetLength(0)
        $stream.Position = 0
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
        $result = 'taken'
      } else {
        $result = 'held|' + $by + '|' + [string][long][math]::Round($age)
      }
    } finally { $stream.Dispose() }
  }
}
$result
`

export const RELEASE_SCRIPT = `# claude-self-tools rc-lock release, v1: the canonical script, run byte for byte by every plugin that takes the lock.
# In: RC_LOCK_PATH, the session's lock file; RC_LOCK_TEXT, the text this taker wrote when it took it.
# Out, one line: "released" (it held exactly that text, and is deleted), "kept" (it holds another
# taker's text, and is untouched), "gone" (there is no lock), or "busy" (another process kept it
# open for the whole second this waits). The text is compared, and the file deleted, under one
# handle that lets no one else read or write it in between.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$path = $env:RC_LOCK_PATH
$text = $env:RC_LOCK_TEXT
$utf8 = New-Object Text.UTF8Encoding($false)
$result = 'busy'
for ($try = 0; $try -lt 20; $try++) {
  $stream = $null
  try {
    $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Delete)
  } catch {
    $cause = $_.Exception
    if ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
    if ($cause -is [IO.FileNotFoundException] -or $cause -is [IO.DirectoryNotFoundException]) { $result = 'gone'; break }
    Start-Sleep -Milliseconds 50
    continue
  }
  try {
    $reader = New-Object IO.StreamReader($stream, $utf8, $false, 4096, $true)
    $held = $reader.ReadToEnd()
    $reader.Dispose()
    if ($held -ceq $text) {
      [IO.File]::Delete($path)
      $result = 'released'
    } else {
      $result = 'kept'
    }
  } finally { $stream.Dispose() }
  break
}
$result
`

/** The SHA-256 of TAKE_SCRIPT's UTF-8 bytes: the coordinator plugin pins the same. */
export const TAKE_SHA256 = 'd9adaec581d817ca46f10fbd1e6fbb6ba845ea26dd2ab01fc5ab04cbf7999dd6'
/** The SHA-256 of RELEASE_SCRIPT's UTF-8 bytes: the coordinator plugin pins the same. */
export const RELEASE_SHA256 = 'caeb549b91af66bebe634710889da5600d263c43b9bc77c36e61cc8f83e4f9c2'
// END canonical scripts

/** What taking the lock came to: held, or why not. */
export type Taken = { held: Held } | { busy: string }

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const UNSAFE = /["'‘’‚‛“”„<>|?*\u0000-\u001f\u007f]/

/** A drive-absolute Windows folder with nothing in it a script could misread. */
export function isSafeFolder(path: unknown): path is string {
  if (typeof path !== 'string' || path.length < 3 || path.length > 240) return false
  if (!/^[A-Za-z]:\\/.test(path) || UNSAFE.test(path) || path.indexOf(':', 2) !== -1 || path.includes('/')) return false
  return path
    .slice(3)
    .split('\\')
    .every((part, i, all) => (part === '' ? i === all.length - 1 : part !== '.' && part !== '..' && part.trim() === part))
}

/** The lock's path for a session: `<LOCALAPPDATA>\claude-self-tools\rc\<id>.lock`. */
export const lockPath = (localAppData: string, id: string): string => `${localAppData.replace(/\\+$/, '')}\\claude-self-tools\\rc\\${id}.lock`

/** What the lock file holds for a taker. */
export const lockText = (at: number): string => JSON.stringify({ v: 1, by: BY, at })

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** `script` as PowerShell's -EncodedCommand takes it: UTF-16LE, then base64 (as the shared machine code does). */
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

/** The one command every script runs under: it reads standard input whole, as UTF-8, and runs it. */
export const STDIN_BOOTSTRAP =
  '& ([scriptblock]::Create([IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false)).ReadToEnd()))'

/** Where the file lock lives and what runs its scripts; null where it can't be placed (the state's lock then). */
async function machine($: EngineInterface): Promise<{ path: string; powershell: string } | null> {
  try {
    const [local, root, id] = await Promise.all([$.env.get('LOCALAPPDATA'), $.env.get('SystemRoot'), $.session.id()])
    if (!isSafeFolder(local) || typeof root !== 'string' || !/^[A-Za-z]:\\[^\\/:*?"<>|]+\\?$/.test(root) || !SESSION_ID.test(id)) return null
    return { path: lockPath(local, id), powershell: `${root.replace(/\\+$/, '')}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` }
  } catch {
    return null
  }
}

/** Runs one canonical script with `env`, in one Windows PowerShell process: its one line of output. The resume claim's scripts run this way too. */
export async function runCanonical($: EngineInterface, powershell: string, script: string, env: Record<string, string>): Promise<string> {
  const run = await $.process.run([powershell, '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(STDIN_BOOTSTRAP)], {
    stdin: script,
    env,
    timeoutMs: PS_TIMEOUT_MS,
  })
  if (run.exitCode !== 0) throw new Error(`PowerShell exited ${run.exitCode}`)
  return run.stdout.trim()
}

/** Runs one lock script for `path` and `text`; its one line of output. A plain function: the engine loads a hooks module only when `$` goes to one. */
function runScript($: EngineInterface, powershell: string, script: string, path: string, text: string): Promise<string> {
  return runCanonical($, powershell, script, { RC_LOCK_PATH: path, RC_LOCK_TEXT: text })
}

/** Why the lock is held, as a clause, from TAKE's `held|<by>|<age ms>`. */
function heldBy(line: string): string {
  const [, by = 'unknown', age = '0'] = line.split('|')
  if (by === 'busy') return "another process has this session's Remote Control lock open"
  const who = by === BY ? 'another run of this plugin' : /^[A-Za-z0-9._:-]{1,64}$/.test(by) ? by : 'another plugin'
  const seconds = Math.max(0, Math.round((Number(age) || 0) / 1000))
  return `${who} holds this session's Remote Control lock (taken ${seconds} s ago)`
}

/** The state's lock: one taker at a time in this session, stale after LOCK_FRESH_MS. */
async function takeMemory($: EngineInterface, now: number): Promise<Taken> {
  const held = (await $.state.get(memoryRef)).value ?? null
  if (held !== null && now - held.at < LOCK_FRESH_MS) return { busy: `another run of this plugin holds this session's Remote Control lock (taken ${Math.round((now - held.at) / 1000)} s ago)` }
  await $.state.set(memoryRef, { at: now })
  return { held: { kind: 'memory', at: now } }
}

/**
 * Takes the lock at `now`, before the fresh reading that may lead to a run: one TAKE. Never
 * throws: a lock that can't be taken, for any reason, is `busy` with why, and nothing runs.
 */
export async function takeLock($: EngineInterface, now: number): Promise<Taken> {
  try {
    const where = await machine($)
    if (where === null) return await takeMemory($, now)
    const line = await runScript($, where.powershell, TAKE_SCRIPT, where.path, lockText(now))
    if (line === 'taken') return { held: { kind: 'file', path: where.path, powershell: where.powershell, at: now } }
    if (line.startsWith('held|')) return { busy: heldBy(line) }
    return { busy: "this session's Remote Control lock can't be taken (an answer the plugin doesn't know)" }
  } catch (err) {
    const said = (err instanceof Error ? err.message : String(err)).trim()
    return { busy: `this session's Remote Control lock can't be taken (${said === '' ? 'no reason given' : said})` }
  }
}

/** Releases a lock this plugin took: one RELEASE, which deletes it only while it holds this taker's text. Never throws. */
export async function releaseLock($: EngineInterface, held: Held): Promise<void> {
  try {
    if (held.kind === 'memory') {
      const value = (await $.state.get(memoryRef)).value ?? null
      if (value !== null && value.at === held.at) await $.state.set(memoryRef, null)
      return
    }
    await runScript($, held.powershell, RELEASE_SCRIPT, held.path, lockText(held.at))
  } catch {
    // Not released: it goes stale on its own after LOCK_FRESH_MS.
  }
}
