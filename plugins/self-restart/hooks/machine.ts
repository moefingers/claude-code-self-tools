// The machine code self-restart and self-switch share: what runs on this machine, who holds which
// conversation, whether a session is at a safe point, and the fixed scripts that look and launch.
//
// Canonical copy: shared/hooks/machine.ts. It is copied, identical, to the plugins named on the next
// line, at plugins/<name>/hooks/machine.ts; `node scripts/sync-shared.mjs` writes those copies and
// `node --test "scripts/*.test.mjs"` fails when one differs, or sits in a plugin not named. Edit the
// canonical copy only.
// Copies: self-restart, self-switch
//
// One self-contained module: it imports nothing but the engine's types, so another plugin (the
// coordinator's, agent-coordinator-3000) can vendor it byte for byte. Copies outside this repository
// are pinned by this file's SHA-256: any change here is a new hash there, made on purpose.
//
// What it holds:
// - The probe (probeScript, parseProbe): one fixed Windows PowerShell script, run by its known path as
//   an -EncodedCommand. Its only inputs are session ids (each a UUID, checked here) and folders (each
//   an absolute path with no quote or control character, checked here, then single-quote escaped).
//   It answers one JSON line: the process table (ids, parents, creation times, names, and for each a
//   class from a fixed busy list worked out from its command line, which never leaves the script),
//   the engine's session registry (six fields and the key names of each file; never cwd, name or
//   socket), the transcripts' project folders and times (never their contents), the claim locks, the
//   heavy-slot folders, free memory, and the claim lock it took, if asked to.
// - The rules (liveness, safePoint, pickTransport): pure functions of a probe, so they run on fixtures.
//   A conversation is NOT LIVE only when no evidence says it is live and nothing that should be read
//   couldn't be. A session is at a safe point only when nothing under it is busy and everything that
//   says so could be read: anything unread holds, and says why.
// - The launcher (launcherScript): self-restart's window, version 2. The conversation to resume and its
//   folder are separate inputs; after the wait for the old process it reads the registry and process
//   table again and resumes nothing if the conversation is live; it checks that the claim lock names
//   it; it clears Claude Code's own markers from the environment before claude runs; and it passes
//   claude no permission flag of any kind, so the resumed session starts in the mode a new one would.
// - The claim lock: %LOCALAPPDATA%\claude-self-tools\claims\<id>.lock, created with CreateNew by the
//   run that judges, holding { v, by, pid, created, at, transport }. `by` names the one that resumes:
//   `slot:<pid>-<created>` (a slot runner) or `launch:<uuid>` (one window, or one in-place move).
//   It is stale when its creator (pid and creation time) isn't running and it is older than 15 minutes.
// - The slot runner's hash (SLOT_SCRIPT_SHA256): plugins/self-switch/slot/claude-slot.ps1, byte for
//   byte. A pane is used as a slot only when the script its parent runs has this hash.
// - The gate file the coordinator writes (gatePath, readGate), and git's state (readGit).
import type { EngineInterface, ProcessRunResult } from 'claude-code'

// ---------------------------------------------------------------------------------------------
// Inputs, and how they reach a script.

/** A session id `claude --resume` takes: a UUID, lowercase as Claude Code writes it. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The Windows folder as SystemRoot names it: a drive and one plain folder, such as C:\Windows. */
export const SYSTEM_ROOT = /^[A-Za-z]:\\[A-Za-z0-9_ -]{1,64}$/

/** Who a claim lock names: a slot runner by its pid and creation time, or one launch by a UUID. */
export const CLAIM_BY = /^(?:slot:\d{1,10}-\d{1,20}|launch:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

/** Every quote PowerShell reads as a single quote: the straight one and the four curly ones. */
const SINGLE_QUOTES = /['\u2018\u2019\u201a\u201b]/g

/** Characters a folder given to a script may not hold: quotes of any kind, control characters, and what Windows refuses in a name. */
const UNSAFE = /["'\u2018\u2019\u201a\u201b\u201c\u201d\u201e<>|?*\u0000-\u001f\u007f]/

/**
 * Whether `path` is fit to reach a script: a drive-absolute Windows path (C:\...), at most 240
 * characters, with no quote or control character, no `.` or `..` part, and only one colon, the drive's.
 */
export function isSafeFolder(path: unknown): path is string {
  if (typeof path !== 'string' || path.length < 3 || path.length > 240) return false
  if (!/^[A-Za-z]:\\/.test(path) || UNSAFE.test(path) || path.indexOf(':', 2) !== -1 || path.includes('/')) return false
  return path
    .slice(3)
    .split('\\')
    .every((part, i, all) => (part === '' ? i === all.length - 1 : part !== '.' && part !== '..' && part.trim() === part))
}

/** `text` inside a single-quoted PowerShell string: every quote PowerShell reads as one, doubled. */
export const psQuote = (text: string): string => text.replace(SINGLE_QUOTES, quote => quote + quote)

/** `text` as a single-quoted PowerShell literal. */
const literal = (text: string): string => `'${psQuote(text)}'`

/** Windows PowerShell by its known path under the Windows folder. */
export const powershellPath = (systemRoot: string): string => `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

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

/**
 * The one -EncodedCommand every generated script runs under: it reads standard input to its end, as
 * UTF-8, and runs it as one script block. A script on the command line itself, UTF-16LE in base64,
 * is 2.67 times its length, and the probe passed Windows' 32,767-character limit on a command line
 * (the process then never starts); on standard input it has no limit. Read whole, then run: never
 * PowerShell's own line-by-line reading of standard input, which breaks a block over several lines.
 */
export const STDIN_BOOTSTRAP =
  '& ([scriptblock]::Create([IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false)).ReadToEnd()))'

/**
 * How `$.process.run` runs `script`: Windows PowerShell by its known path, no profile, no prompts, the
 * fixed STDIN_BOOTSTRAP as its command, and the script on standard input. The command line is the
 * same few hundred characters whatever the script.
 */
export function powershellCall(powershell: string, script: string): { readonly argv: readonly string[]; readonly stdin: string } {
  return { argv: [powershell, '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(STDIN_BOOTSTRAP)], stdin: script }
}

/**
 * The engine's project folder name for a folder: every character but a letter or a digit becomes `-`
 * (O:\work\my_repo is O--work-my-repo). Undefined past 200 characters, where the engine shortens it.
 */
export function projectName(folder: string): string | undefined {
  const name = folder.replace(/[^A-Za-z0-9]/g, '-')
  return name.length > 200 ? undefined : name
}

/** Two project folder names, compared as Windows compares names: without regard to case. */
export const sameProject = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** This plugin family's folder under %LOCALAPPDATA%: claims, slot records and the coordinator's gate. */
export const stateFolder = (localAppData: string): string => `${localAppData.replace(/\\+$/, '')}\\claude-self-tools`

/** The claim lock on conversation `id`. */
export const claimPath = (state: string, id: string): string => `${state}\\claims\\${id}.lock`

/** The record a slot runner reads when its claude exits, by the runner's id (`<pid>-<created>`). */
export const slotRecordPath = (state: string, slot: string): string => `${state}\\slots\\${slot}.next.json`

/** The coordinator's gate file for conversation `id`. */
export const gatePath = (state: string, id: string): string => `${state}\\gate\\${id}.json`

// ---------------------------------------------------------------------------------------------
// Another session's words, as data.

/** The most characters of another session's text a row carries, inside its quotes. */
export const QUOTED_MAX = 400

/** Line and paragraph breaks of every kind, and tabs: each run becomes one space. */
const BREAKS = /[\t\n\u000b\u000c\r\u0085\u2028\u2029]+/g

/**
 * What a reader can't see, dropped: control characters (Cc), format characters (Cf: bidi controls,
 * zero widths, the BOM, and the Unicode tag characters U+E0020-E007F, which carry text a model reads
 * and a person doesn't), private-use (Co) and unassigned (Cn) code points, and every default-ignorable
 * code point (variation selectors, the Hangul fillers, the combining grapheme joiner). By property,
 * with the `u` flag, so the planes past the first are covered too.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}]/gu

/** `text` cut to `max` characters, the last an ellipsis, never splitting a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text
  let kept = text.slice(0, max - 1)
  if (/[\ud800-\udbff]$/.test(kept)) kept = kept.slice(0, -1)
  return `${kept}\u2026`
}

/**
 * Another session's text as one line: every line break and tab a space, control and format
 * characters dropped, runs of spaces one, trimmed, at most `max` characters (an ellipsis last).
 */
export function oneLine(text: string, max = QUOTED_MAX): string {
  return cut(text.replace(BREAKS, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim(), max)
}

/**
 * Another session's text quoted as data: \u00abone line\u00bb, each \u00ab and \u00bb inside, and the backslash, escaped
 * with a backslash, so the quote can't be closed early. At most QUOTED_MAX characters inside the
 * quotes, escapes included; an escape is never cut in half.
 */
export function quoted(text: string): string {
  let inside = oneLine(text, Number.MAX_SAFE_INTEGER).replace(/[\\\u00ab\u00bb]/g, c => `\\${c}`)
  if (inside.length > QUOTED_MAX) {
    inside = inside.slice(0, QUOTED_MAX - 1)
    const tail = /\\+$/.exec(inside)?.[0].length ?? 0
    if (tail % 2 === 1) inside = inside.slice(0, -1)
    if (/[\ud800-\udbff]$/.test(inside)) inside = inside.slice(0, -1)
    inside += '\u2026'
  }
  return `\u00ab${inside}\u00bb`
}

// ---------------------------------------------------------------------------------------------
// The fixed values the rules use.

/** How long the new window waits for the old process to exit, in seconds. */
export const WAIT_SECONDS = 600

/** A Claude Code that ends sooner than this after the resume, in seconds, is taken not to have resumed. */
export const SHORT_RUN_SECONDS = 10

/** A registry entry is current when its procStart is within this of its process's creation time: 1 ms, in FILETIME ticks. */
export const PROC_START_TOLERANCE = 10_000

/** A transcript written more recently than this is live evidence (L3). */
export const TRANSCRIPT_LIVE_MS = 10 * 60 * 1000

/** A heartbeat younger than this is live evidence (L5). */
export const HEARTBEAT_LIVE_MS = 5 * 60 * 1000

/** A claim lock whose creator has gone is stale once it is older than this (L6). */
export const CLAIM_STALE_MS = 15 * 60 * 1000

/** A slot record older than this is not honoured. */
export const SLOT_RECORD_MS = 120 * 1000

/** A gate file older than this is ignored. */
export const GATE_MS = 24 * 60 * 60 * 1000

/** How long each git read may take. */
export const GIT_TIMEOUT_MS = 5000

/** An agent in one of these is still to report. */
export const BUSY_AGENTS: readonly string[] = ['pending', 'running', 'waiting']

/**
 * Every key a session registry file (`<config>\sessions\<pid>.json`) was seen to hold on Claude Code
 * 2.1.318. Any other key is logged once per process by name, and ignored: what liveness reads is
 * REGISTRY_FIELDS, checked strictly, and a new format is caught by REGISTRY_VERSION_MARKERS.
 */
export const REGISTRY_KEYS = [
  'pid',
  'sessionId',
  'cwd',
  'startedAt',
  'procStart',
  'version',
  'peerProtocol',
  'peerFeatures',
  'kind',
  'entrypoint',
  'pidDomain',
  'messagingSocketPath',
  'name',
  'nameSource',
  'status',
  'updatedAt',
  'statusUpdatedAt',
  'bridgeSessionId',
  'asksForConvertedSkills',
  'nameSince',
] as const

/**
 * The fields liveness reads from a registry file (L1): the process's id (also the file's name), the
 * conversation it holds, and its creation time. Each is strict: missing, of another type, or not of
 * its pattern, the file makes the verdict unknown, naming the field. procStart is a whole number, or
 * a string of digits, as Claude Code 2.1.318 writes it; compared exactly, never as a JavaScript number.
 */
export const REGISTRY_FIELDS = ['pid', 'sessionId', 'procStart'] as const

/**
 * Keys that would mark a new registry format: a file holding one makes the verdict unknown, naming it.
 * `version` isn't one: in today's shape it is Claude Code's own version, a string, and a `version` of
 * any other type refuses the same way.
 */
export const REGISTRY_VERSION_MARKERS = ['v', 'schema', 'schemaVersion', 'formatVersion', 'registryVersion'] as const

/**
 * How long a claude.exe must have run, before the snapshot that reads it, for its own registry entry
 * to outweigh its command line (L2): a fresh `claude --resume <id>` may write its first entry under
 * another id before it has loaded the conversation, and in that moment only its command line says so.
 */
export const LAUNCH_LINE_TRUSTED_AFTER_MS = 60_000

/** The SHA-256 of plugins/self-switch/slot/claude-slot.ps1, as it is committed. */
export const SLOT_SCRIPT_SHA256 = '9e8c984c89ea6d1503635a5280c6fc224406ef724767f7b5e31323d4e6be490e'

/**
 * The variables Claude Code sets in the processes it starts, which a top-level claude must not inherit:
 * the launcher clears these before `claude --resume`, and no other. From the environment-variables
 * reference (code.claude.com/docs/en/env-vars), each "set by Claude Code" or "set automatically":
 * CLAUDE_CODE_CHILD_SESSION (makes a claude nested: no transcript, left out of --resume), CLAUDECODE,
 * CLAUDE_CODE_SESSION_ID, CLAUDE_PID, CLAUDE_EFFORT, CLAUDE_CODE_BRIDGE_SESSION_ID (the old Remote
 * Control connection), CLAUDE_CODE_MESSAGING_SOCKET and CLAUDE_CODE_MESSAGING_TOKEN (each session
 * exports its own, "never one inherited from a parent"), CLAUDE_CODE_REMOTE and
 * CLAUDE_CODE_REMOTE_SESSION_ID (cloud sessions), CLAUDE_JOB_DIR (background sessions). Not in that
 * reference, but set by Claude Code 2.1.318 in its tools' processes, and in neither the user's
 * settings nor the Windows environment: AI_AGENT (`claude-code_<version>_agent`), CLAUDE_CODE_ENTRYPOINT,
 * CLAUDE_CODE_EXECPATH, CLAUDE_CODE_SESSION_ATTENDED. And CLAUDE_CODE_SSE_PORT, which an IDE's terminal sets:
 * a session restarted or switched out of one would hand the old process's IDE link to the new one.
 * And NO_COLOR, which Claude Code sets to 1 in its tool shells: a session started from one would draw
 * no colour. The slot runner clears these too. Never one a person sets otherwise, and never
 * CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP (kept as it is: the person's choice).
 */
export const SESSION_MARKERS = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_JOB_DIR',
  'AI_AGENT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SSE_PORT',
  'NO_COLOR',
] as const

/**
 * What a launcher's window clears: SESSION_MARKERS, and WT_SESSION, the Windows Terminal tab id of the
 * session it came from, so the new tab gets its own. Not the slot runner: its pane's WT_SESSION is its own.
 */
export const LAUNCH_CLEARS = [...SESSION_MARKERS, 'WT_SESSION'] as const

/**
 * Set in every process a launcher starts claude in (the window, and the slot runner's): transcripts on,
 * whatever marker a later Claude Code adds that this list doesn't clear yet.
 */
export const FORCE_PERSISTENCE = '$env:CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = "1"'

/** The line that clears LAUNCH_CLEARS from a window's own environment, which claude inherits. */
export const CLEAR_MARKERS = `foreach ($name in ${LAUNCH_CLEARS.map(name => `"${name}"`).join(', ')}) { [Environment]::SetEnvironmentVariable($name, $null, [EnvironmentVariableTarget]::Process) }`

// ---------------------------------------------------------------------------------------------
// PowerShell the scripts share. Each fragment is lines of Windows PowerShell 5.1.

/** A process's parent, while it is older than the child: a later process that took a gone parent's id is none. */
const GET_PARENT = [
  'function Get-Parent($child) {',
  '  $up = $table[[int]$child.ParentProcessId]',
  '  if ($null -ne $up -and $up.CreationDate -le $child.CreationDate) { return $up }',
  '  return $null',
  '}',
]

/**
 * A process's creation time as a FILETIME, 0 when the table has none (the idle and system processes),
 * as a decimal string: FILETIMEs pass 2^53, where a JavaScript number keeps multiples of 16 only, so
 * the answer never carries one as a number.
 */
const GET_CREATED = ['function Get-Created($p) { if ($null -eq $p.CreationDate) { return "0" } return [string][long]$p.CreationDate.ToFileTimeUtc() }']

/**
 * The slot runner this session's claude.exe runs under, when its parent is one: `$up` is that parent
 * (from the walk), and it counts only when it is Windows PowerShell running `-File ...\claude-slot.ps1`.
 * Sets `$slot` (pid, created, id = `<pid>-<created>`, path, sha256, and hashError when it couldn't be
 * hashed; created and id strings) and `$slotOk` (its script has the shipped hash). The hash is .NET's,
 * never Get-FileHash: in a Windows Terminal tab whose PSModulePath puts PowerShell 7's folders first,
 * Windows PowerShell 5.1 loads 7's Utility module, which has no Get-FileHash. A file over 64 KB isn't
 * read: it is no slot runner, and its hash error says so. `$slotSeen`: the parent runs claude-slot.ps1
 * some other way (pwsh.exe, -f, a path the match doesn't take), so it is no slot this code uses, and the
 * fallback says so.
 */
const FIND_SLOT = [
  '$slot = $null',
  '$slotOk = $false',
  '$slotSeen = $false',
  String.raw`if ($null -ne $session -and $null -ne $up -and $up.Name -eq "powershell.exe" -and "$($up.CommandLine)" -match "-File\s+(\x22?)(?<path>[A-Za-z]:\\[^\x22]*?\\claude-slot\.ps1)\1(\s|\z)") {`,
  '  $slotPath = $Matches["path"]',
  '  $slotHash = $null',
  '  $slotHashError = $null',
  '  try { if ([IO.FileInfo]::new($slotPath).Length -gt 65536) { throw "the file is over 64 KB, so it is not the slot runner" }; $hasher = [Security.Cryptography.SHA256]::Create(); try { $slotHash = [BitConverter]::ToString($hasher.ComputeHash([IO.File]::ReadAllBytes($slotPath))).Replace("-", "").ToLowerInvariant() } finally { $hasher.Dispose() } } catch { $slotHash = $null; $slotHashError = "$($_.Exception.Message)" }',
  '  $slotCreated = Get-Created $up',
  '  $slot = [ordered]@{ pid = [long]$up.ProcessId; created = $slotCreated; id = "$($up.ProcessId)-$slotCreated"; path = $slotPath; sha256 = $slotHash }',
  '  if ($null -ne $slotHashError) { $slot["hashError"] = $slotHashError }',
  `  $slotOk = $slotHash -eq '${SLOT_SCRIPT_SHA256}'`,
  String.raw`} elseif ($null -ne $session -and $null -ne $up -and ($up.Name -eq "powershell.exe" -or $up.Name -eq "pwsh.exe") -and "$($up.CommandLine)" -match "claude-slot\.ps1") { $slotSeen = $true }`,
]

/** Whether the error in a catch block is a sharing violation, a file already there, or another plain I/O failure. */
const IS_IO = '($_.Exception -is [IO.IOException] -or $_.Exception.InnerException -is [IO.IOException])'

/**
 * Takes the claim lock `$claimPath` for `$by`, with CreateNew, so of two that race one wins. A lock
 * already there is taken over only when it is this session's own (its creator is this claude.exe) or
 * stale (its creator isn't running and it is older than 15 minutes; one that can't be read, by its
 * file's age). The takeover is one exclusive handle, never a delete and a create: it opens the lock
 * for writing with no one else allowed to write it, reads and judges it through that handle, and
 * writes the new claim over it in place. A second taker can't open it meanwhile, and reports it held.
 * Needs `$table`, `$session`, `$by`, `$transport`, `$claimPath`; sets `$taken`.
 */
const TAKE_CLAIM = [
  'function New-Claim($path, $text) {',
  '  [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))',
  '  try { $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read) }',
  `  catch { if ${IS_IO} { return $false } throw }`,
  '  try { $bytes = [Text.Encoding]::UTF8.GetBytes($text); $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }',
  '  return $true',
  '}',
  'function Set-Claim($path, $text) {',
  '  try { $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read) }',
  '  catch {',
  '    if ($_.Exception -is [IO.FileNotFoundException] -or $_.Exception.InnerException -is [IO.FileNotFoundException]) { return (New-Claim $path $text) }',
  `    if ${IS_IO} { return $false }`,
  '    throw',
  '  }',
  '  try {',
  '    $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8, $true, 4096, $true)',
  '    $oldText = $reader.ReadToEnd()',
  '    $reader.Dispose()',
  '    $old = $null',
  '    try { $old = $oldText | ConvertFrom-Json } catch { $old = $null }',
  '    $age = $nowMs - ([DateTimeOffset]([IO.File]::GetLastWriteTimeUtc($path))).ToUnixTimeMilliseconds()',
  '    $over = $false',
  '    if ($null -ne $old -and $old.pid -is [ValueType] -and "$($old.created)" -match "^\\d{1,20}\\z" -and $old.at -is [ValueType]) {',
  '      $creator = $table[[int]$old.pid]',
  `      $running = $null -ne $creator -and $null -ne $creator.CreationDate -and [math]::Abs([long]$creator.CreationDate.ToFileTimeUtc() - [long]"$($old.created)") -le ${PROC_START_TOLERANCE}`,
  `      $over = ($running -and [long]$old.pid -eq [long]$session.ProcessId) -or ((-not $running) -and ($nowMs - [double]$old.at) -gt ${CLAIM_STALE_MS})`,
  `    } else { $over = $age -gt ${CLAIM_STALE_MS} }`,
  '    if (-not $over) { return $false }',
  '    $bytes = [Text.Encoding]::UTF8.GetBytes($text)',
  '    $stream.SetLength(0)',
  '    $stream.Write($bytes, 0, $bytes.Length)',
  '    $stream.Flush()',
  '    return $true',
  '  } finally { $stream.Dispose() }',
  '}',
  '$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
  '$claimText = [ordered]@{ v = 1; by = $by; pid = [long]$session.ProcessId; created = (Get-Created $session); at = $nowMs; transport = $transport } | ConvertTo-Json -Compress',
  '$taken = New-Claim $claimPath $claimText',
  'if (-not $taken) { $taken = Set-Claim $claimPath $claimText }',
]

/**
 * The last-moment re-check, in the launcher's window and the slot runner: whether a running Claude
 * Code holds conversation `$id` now, read from `$configDirs`' registries (L1) and every process's
 * command line (L2). Sets `$live`, null when nothing holds it, else a line saying why it isn't resumed.
 * A registry file of a running claude.exe that can't be read, or reads in another shape, is read again
 * twice, 250 ms apart (Claude Code may be rewriting it), and then counts as unknown, which resumes
 * nothing. The same rules as the probe's liveness: sessionId compared without regard to case; a file
 * that names `$id` in any key but sessionId, cwd and name refuses; and a command line naming `$id`
 * (L2) is passed over only for a claude.exe whose own registry file is current (its pid, and its
 * procStart within 1 ms of its start), well formed, and names another conversation, and which started
 * more than 60 s before the process table was read: a process started as `claude --resume <id>` keeps
 * that line after it switched in place to another, and a fresh one may not have written it yet. Anything else that can't be read throws, and a caller that catches it resumes nothing. No
 * single quote in these lines: the launcher carries each inside one. A running claude.exe whose file
 * names $id refuses whatever its procStart; the start time only words the line. procStart compares as a [double]:
 * a string of digits, as Claude Code 2.1.318 writes it, converts as a number does, and at today's
 * FILETIMEs a double is off by at most 32 ticks, well within the 1 ms tolerance.
 */
export const RECHECK = [
  '$live = $null',
  '$procs = @{}',
  'foreach ($p in (Get-CimInstance -ClassName Win32_Process -Property ProcessId, Name, CreationDate, CommandLine)) { $procs[[int]$p.ProcessId] = $p }',
  // The table's time, read as soon as it is: a process started less than 60 s before it keeps L2.
  '$snapshotFt = [DateTime]::UtcNow.ToFileTimeUtc()',
  // The claude.exe whose own registry file is current, well formed and names another conversation.
  '$elsewhere = @{}',
  'foreach ($dir in $configDirs) {',
  '  $reg = Join-Path $dir "sessions"',
  '  if ($null -ne $live -or -not (Test-Path -LiteralPath $reg -PathType Container)) { continue }',
  '  foreach ($f in @(Get-ChildItem -LiteralPath $reg -Filter "*.json" -File -Force)) {',
  '    $p = $null',
  String.raw`    if ($f.BaseName -match "^\d{1,10}\z") { $p = $procs[[int]$f.BaseName] }`,
  '    if ($null -eq $p -or $p.Name -ne "claude.exe") { continue }',
  '    $e = $null',
  '    for ($try = 1; $try -le 3 -and $null -eq $e; $try++) {',
  '      try { $e = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $e = $null }',
  '      if ($null -ne $e -and ($e.sessionId -isnot [string] -or $null -eq $e.procStart)) { $e = $null }',
  '      if ($null -eq $e -and $try -lt 3) { Start-Sleep -Milliseconds 250 }',
  '    }',
  '    if ($null -eq $e) { $live = "whether it is open elsewhere is unknown: the registry file of Claude Code $($f.BaseName) could not be read, three times, or has another shape"; break }',
  // A running claude.exe whose file names the id holds it, whatever its procStart: the start time only
  // words the line (a unit or a field that moved, procStartFt, must never read as free).
  '    $near = $false',
  `    try { $near = [math]::Abs([double]$p.CreationDate.ToFileTimeUtc() - [double]$e.procStart) -le ${PROC_START_TOLERANCE} } catch { $near = $false }`,
  '    if ($e.sessionId -eq $id) {',
  '      if ($near) { $live = "it is open elsewhere: Claude Code $($f.BaseName) holds it (L1)" } else { $live = "it may be open elsewhere: the registry file of running Claude Code $($f.BaseName) names it, though its procStart is not that process start time (a stale file, or a format this check does not know)" }',
  '      break',
  '    }',
  // Named in another key (cwd and name are free text): what that process holds is unclear.
  '    $named = $false',
  '    foreach ($prop in $e.PSObject.Properties) { if ($prop.Name -cne "sessionId" -and $prop.Name -cne "cwd" -and $prop.Name -cne "name" -and "$(ConvertTo-Json -InputObject $prop.Value -Compress -Depth 8)".IndexOf($id, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $named = $true } }',
  '    if ($named) { $live = "it may be open elsewhere: the registry file of running Claude Code $($f.BaseName) names it outside its sessionId"; break }',
  '    $pidOk = $false',
  '    try { $pidOk = [long]$e.pid -eq [long]$p.ProcessId } catch { $pidOk = $false }',
  String.raw`    if ($near -and $pidOk -and ($snapshotFt - [long]$p.CreationDate.ToFileTimeUtc()) -gt ` + `${LAUNCH_LINE_TRUSTED_AFTER_MS * 10_000}` + String.raw` -and $e.sessionId -match "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z") { $elsewhere[[int]$p.ProcessId] = $true }`,
  '  }',
  '}',
  // L2: a command line naming it, past a claude.exe whose own current entry names another conversation.
  String.raw`if ($null -eq $live) { foreach ($p in $procs.Values) { if ($null -eq $live -and $p.ProcessId -ne $PID -and -not $elsewhere.ContainsKey([int]$p.ProcessId) -and "$($p.CommandLine)" -match "(^|[\s\x22])(--resume|--session-id|-r)(\s+|=)[\x22\x27]?$id") { $live = "it is open elsewhere: process $($p.ProcessId) names it on its command line (L2)" } } }`,
] as const

/**
 * The classes the probe gives a process from its command line (S2-S6), which never leaves the script:
 * `git` (git.exe and its helpers), `heavy-slot` (a shell running heavy-slot.sh), `dev` (next dev or
 * start, vite, Playwright, a browser under remote debugging), `build` (pnpm, npm, vitest, eslint, tsc),
 * `shell` (any other bash, sh, pwsh or powershell: a background job of the Bash, PowerShell or Monitor
 * tool). Anything else (an MCP server's node, cmd or conhost) has no class.
 */
export const PROCESS_CLASSES = ['git', 'heavy-slot', 'dev', 'build', 'shell'] as const
export type ProcessClass = (typeof PROCESS_CLASSES)[number]

/**
 * Whether a process is a claude.exe running a Claude Code command (`claude plugin ...`, `mcp`,
 * `doctor`, `update`, `install`, `config`, `auth`, `--version`, `--help`): its arguments start
 * with one, and name no conversation anywhere (no --resume, -r, --session-id, --continue, -c, -p or
 * --print). Such a run holds no conversation and has no registry entry: liveness counts it, and the
 * claude.exe it starts, as accounted. Only the answer leaves the script, never the command line.
 */
export const GET_CLI = [
  'function Get-Cli($p) {',
  '  if ("$($p.Name)".ToLowerInvariant() -ne "claude.exe") { return $false }',
  String.raw`  if ("$($p.CommandLine)" -notmatch '^\s*("[^"]*"|\S+)\s*(?<rest>.*)$') { return $false }`,
  '  $rest = $Matches["rest"]',
  String.raw`  if ($rest -notmatch '^(plugin|mcp|doctor|update|install|config|auth|--version|-v|--help|-h)(\s|$)') { return $false }`,
  String.raw`  if ($rest -match '(^|\s)(--resume|-r|--session-id|--continue|-c|-p|--print)(\s|=|$)') { return $false }`,
  '  return $true',
  '}',
]

/**
 * A claude.exe in its last 70 to 120 ms reads an empty command line, so Get-Cli can't tell it is a
 * Claude Code command, and it would read as unaccounted. Each claude.exe whose command line reads
 * empty is read again, once, 300 ms later: gone (or its pid another process's), it is dropped from
 * the table; there, it is read as it is then. Still empty, it stays, unaccounted: that fails closed.
 */
export const READ_BLANK_AGAIN = [
  '$blank = @($table.Values | Where-Object { $_.Name -eq "claude.exe" -and [string]::IsNullOrEmpty("$($_.CommandLine)") })',
  'if ($blank.Count -gt 0) {',
  '  Start-Sleep -Milliseconds 300',
  '  foreach ($b in $blank) {',
  '    $again = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $([int]$b.ProcessId)" -Property ProcessId, ParentProcessId, Name, CreationDate, CommandLine',
  '    if ($null -eq $again -or $again.CreationDate -ne $b.CreationDate) { $table.Remove([int]$b.ProcessId) } else { $table[[int]$b.ProcessId] = $again }',
  '  }',
  '}',
]

const GET_CLASS = [
  'function Get-Class($p) {',
  '  $n = "$($p.Name)".ToLowerInvariant()',
  '  $c = "$($p.CommandLine)"',
  '  if ($n -match "^git(-[a-z0-9-]+)?\\.exe\\z") { return "git" }',
  '  if ($n -eq "bash.exe" -or $n -eq "sh.exe") { if ($c -match "heavy-slot\\.sh") { return "heavy-slot" } return "shell" }',
  '  if ($n -eq "pwsh.exe" -or $n -eq "powershell.exe") { return "shell" }',
  '  if ($n -eq "pnpm.exe" -or $n -eq "npm.exe") { return "build" }',
  '  if ($n -eq "node.exe" -or $n -eq "bun.exe" -or $n -eq "cmd.exe") {',
  String.raw`    if ($c -match "\bnext(\.js)?[\x22\x27]?\s+(dev|start)\b|playwright|\bvite(\.js)?[\x22\x27]?(\s|\z)") { return "dev" }`,
  String.raw`    if ($c -match "vitest|eslint|\btsc(\.js)?\b|\bpnpm|npm-cli\.js|\bnpm(\.cmd)?(\s|\z)") { return "build" }`,
  '    return $null',
  '  }',
  '  if ($n -eq "chrome.exe" -or $n -eq "msedge.exe") { if ($c -match "--remote-debugging|ms-playwright") { return "dev" } return $null }',
  '  return $null',
  '}',
]

// ---------------------------------------------------------------------------------------------
// The probe.

/** What the probe is asked: the conversations to look for, where, and optionally the one to claim. */
export type ProbeInput = {
  /** The conversations asked about (this session's own and the target): each a UUID. */
  readonly ids: readonly string[]
  /** Take the claim lock on this one (one of `ids`), in the same run. */
  readonly take?: string
  /** The config folders known on this machine, this session's own first; none for a probe of the process tree alone. */
  readonly configDirs: readonly string[]
  /** stateFolder(%LOCALAPPDATA%): where the claim locks are; absent, they are neither read nor taken. */
  readonly stateDir?: string
  /** The folder holding heavy-slot.sh's .gate-lock folders, when there is one. */
  readonly heavySlotRoot?: string
}

function checkFolder(what: string, path: unknown): string {
  if (!isSafeFolder(path)) throw new Error(`${what} is not an absolute folder without quotes or control characters: ${JSON.stringify(path)}`)
  return path
}

function checkId(id: unknown): string {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new Error(`not a session id: ${JSON.stringify(id)}`)
  return id
}

/** The probe script. Throws on any input that isn't what it must be, so nothing else is spliced in. */
export function probeScript(input: ProbeInput): string {
  const ids = input.ids.map(checkId)
  if (ids.length < 1 || ids.length > 8) throw new Error('the probe asks about 1 to 8 conversations')
  const take = input.take === undefined ? undefined : checkId(input.take)
  if (take !== undefined && !ids.includes(take)) throw new Error('the probe claims only a conversation it asks about')
  if (input.configDirs.length > 8) throw new Error('the probe reads at most 8 config folders')
  const configDirs = input.configDirs.map(dir => checkFolder('a config folder', dir))
  const state = input.stateDir === undefined ? undefined : checkFolder('the state folder', input.stateDir)
  if (take !== undefined && state === undefined) throw new Error('the probe claims only with the state folder')
  const heavy = input.heavySlotRoot === undefined ? undefined : checkFolder('the heavy-slot folder', input.heavySlotRoot)
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `$ids = @(${ids.map(literal).join(', ')})`,
    `$configDirs = @(${configDirs.map(literal).join(', ')})`,
    `$state = ${state === undefined ? '$null' : literal(state)}`,
    `$heavyRoot = ${heavy === undefined ? '$null' : literal(heavy)}`,
    `$take = ${take === undefined ? '$null' : literal(take)}`,
    '$errors = New-Object System.Collections.ArrayList',
    // Every process once, by id: everything below reads only this table.
    '$table = @{}',
    'foreach ($p in (Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate, CommandLine)) { $table[[int]$p.ProcessId] = $p }',
    ...READ_BLANK_AGAIN,
    ...GET_PARENT,
    ...GET_CREATED,
    ...GET_CLASS,
    ...GET_CLI,
    // This session's claude.exe: the nearest above the probe, then the top of an unbroken run of
    // claude.exe parents, so a helper process of the session's own is never taken for the session.
    '$session = $null',
    '$up = $null',
    '$at = $table[[int]$PID]',
    'for ($i = 0; $i -lt 8 -and $null -ne $at; $i++) {',
    '  $at = Get-Parent $at',
    "  if ($null -ne $at -and $at.Name -eq 'claude.exe') { $session = $at; break }",
    '}',
    'if ($null -ne $session) {',
    '  for ($i = 0; $i -lt 8; $i++) {',
    '    $up = Get-Parent $session',
    "    if ($null -eq $up -or $up.Name -ne 'claude.exe') { break }",
    '    $session = $up',
    '  }',
    '}',
    ...FIND_SLOT,
    // Each process: its id, parent, creation time, name, class, whether it is a Claude Code command
    // (Get-Cli), and which asked-about ids its command line names after --resume, -r or --session-id.
    // The command line itself stays here.
    String.raw`$named = "(^|[\s\x22])(--resume|--session-id|-r)(\s+|=)[\x22\x27]?(${ids.join('|')})"`,
    '$procs = New-Object System.Collections.ArrayList',
    'foreach ($p in $table.Values) {',
    '  $o = [ordered]@{ pid = [long]$p.ProcessId; ppid = [long]$p.ParentProcessId; created = (Get-Created $p); name = "$($p.Name)" }',
    '  $cls = Get-Class $p',
    '  if ($null -ne $cls) { $o["cls"] = $cls }',
    '  if (Get-Cli $p) { $o["cli"] = $true }',
    '  $found = @([regex]::Matches("$($p.CommandLine)", $named, "IgnoreCase") | ForEach-Object { $_.Groups[4].Value.ToLowerInvariant() } | Select-Object -Unique)',
    '  if ($found.Count -gt 0) { $o["ids"] = [object[]]$found }',
    '  [void]$procs.Add($o)',
    '}',
    // The registry: per file, whether it parses, its key names, and seven values as their JSON types; a
    // value that is a list or an object comes as { nested = "list" } or { nested = "object" }, never as null.
    // And which of the asked-about ids it names in any key but sessionId, cwd and name (free text: a
    // session can work under a folder named for another conversation) (`mentions`): the ids, never a value.
    '$registry = New-Object System.Collections.ArrayList',
    'for ($k = 0; $k -lt $configDirs.Count; $k++) {',
    '  $reg = Join-Path $configDirs[$k] "sessions"',
    '  if (-not (Test-Path -LiteralPath $reg -PathType Container)) { continue }',
    '  try {',
    '    foreach ($f in @(Get-ChildItem -LiteralPath $reg -Filter "*.json" -File -Force)) {',
    String.raw`      if ($f.BaseName -notmatch "^\d{1,10}\z") { continue }`,
    '      $o = [ordered]@{ dir = $k; file = [long]$f.BaseName; ok = $false }',
    '      $e = $null',
    // Read again twice, 250 ms apart, when it doesn't parse: Claude Code may be rewriting it.
    '      for ($try = 1; $try -le 3 -and $e -isnot [Management.Automation.PSCustomObject]; $try++) {',
    '        if ($try -gt 1) { Start-Sleep -Milliseconds 250 }',
    '        try { $e = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $e = $null }',
    '      }',
    '      if ($e -is [Management.Automation.PSCustomObject]) {',
    '        $o["ok"] = $true',
    '        $o["keys"] = [object[]]@($e.PSObject.Properties | ForEach-Object { $_.Name })',
    '        foreach ($key in "pid", "sessionId", "procStart", "status", "statusUpdatedAt", "kind", "version") {',
    '          $prop = $e.PSObject.Properties | Where-Object { $_.Name -ceq $key } | Select-Object -First 1',
    '          if ($null -ne $prop) { $v = $prop.Value; if ($null -ne $v -and -not ($v -is [string] -or $v -is [ValueType])) { if ($v -is [Array]) { $v = [ordered]@{ nested = "list" } } else { $v = [ordered]@{ nested = "object" } } }; $o[$key] = $v }',
    '        }',
    '        $mentioned = New-Object System.Collections.ArrayList',
    '        foreach ($prop in $e.PSObject.Properties) {',
    '          if ($prop.Name -ceq "sessionId" -or $prop.Name -ceq "cwd" -or $prop.Name -ceq "name") { continue }',
    '          $valueText = "$(ConvertTo-Json -InputObject $prop.Value -Compress -Depth 8)"',
    '          foreach ($a in $ids) { if (-not $mentioned.Contains($a) -and $valueText.IndexOf($a, [StringComparison]::OrdinalIgnoreCase) -ge 0) { [void]$mentioned.Add($a) } }',
    '        }',
    '        if ($mentioned.Count -gt 0) { $o["mentions"] = [object[]]$mentioned }',
    '      }',
    '      [void]$registry.Add($o)',
    '    }',
    '  } catch { [void]$errors.Add("registry:$k") }',
    '}',
    // The transcripts: which project folder holds each asked-about conversation, and when it was written.
    '$transcripts = New-Object System.Collections.ArrayList',
    'for ($k = 0; $k -lt $configDirs.Count; $k++) {',
    '  $projects = Join-Path $configDirs[$k] "projects"',
    '  if (-not (Test-Path -LiteralPath $projects -PathType Container)) { continue }',
    '  try {',
    '    foreach ($d in @(Get-ChildItem -LiteralPath $projects -Directory -Force)) {',
    '      foreach ($id in $ids) {',
    '        $t = Join-Path $d.FullName ($id + ".jsonl")',
    '        if (Test-Path -LiteralPath $t -PathType Leaf) {',
    '          $mtime = ([DateTimeOffset](Get-Item -LiteralPath $t -Force).LastWriteTimeUtc).ToUnixTimeMilliseconds()',
    '          [void]$transcripts.Add([ordered]@{ id = $id; dir = $k; project = $d.Name; mtime = $mtime })',
    '        }',
    '      }',
    '    }',
    '  } catch { [void]$errors.Add("transcripts:$k") }',
    '}',
    // heavy-slot.sh's two slots: each one held, and the Windows pid of its job when it wrote one.
    '$heavy = $null',
    'if ($null -ne $heavyRoot) {',
    '  $heavy = New-Object System.Collections.ArrayList',
    '  try {',
    '    foreach ($s in ".gate-lock", ".gate-lock-2") {',
    '      $d = Join-Path $heavyRoot $s',
    '      if (-not (Test-Path -LiteralPath $d -PathType Container)) { continue }',
    '      $w = $null',
    '      $wf = Join-Path $d "winpid"',
    String.raw`      if (Test-Path -LiteralPath $wf -PathType Leaf) { $t = "$(Get-Content -LiteralPath $wf -Raw)".Trim(); if ($t -match "^\d{1,10}\z") { $w = [long]$t } }`,
    '      [void]$heavy.Add([ordered]@{ slot = $s; winpid = $w })',
    '    }',
    '  } catch { [void]$errors.Add("heavy:") }',
    '}',
    '$freeKb = $null',
    'try { $freeKb = [long](Get-CimInstance -ClassName Win32_OperatingSystem -Property FreePhysicalMemory).FreePhysicalMemory } catch { [void]$errors.Add("memory:") }',
    // The claim, last but one: taken in this run, after everything above was read, so the snapshot
    // it is judged on and the lock are one. A slot runner of a verified script is named by its id;
    // otherwise one launch, by a fresh UUID.
    '$claim = $null',
    'if ($null -ne $take) {',
    '  if ($null -eq $session) { $claim = [ordered]@{ id = $take; taken = $false; why = "no-session" } }',
    '  else {',
    '    if ($slotOk) { $by = "slot:" + $slot["id"]; $transport = "slot" } else { $by = "launch:" + [guid]::NewGuid().ToString(); $transport = "window" }',
    '    $claimPath = Join-Path $state ("claims\\" + $take + ".lock")',
    ...TAKE_CLAIM.map(line => `    ${line}`),
    '    if ($taken) { $claim = [ordered]@{ id = $take; taken = $true; by = $by } } else { $claim = [ordered]@{ id = $take; taken = $false; why = "held" } }',
    '  }',
    '}',
    // The claim locks on the asked-about conversations, as they stand after the take.
    '$locks = New-Object System.Collections.ArrayList',
    'if ($null -ne $state) { try {',
    '  foreach ($id in $ids) {',
    '    $lp = Join-Path $state ("claims\\" + $id + ".lock")',
    '    if (-not (Test-Path -LiteralPath $lp -PathType Leaf)) { continue }',
    '    $o = [ordered]@{ id = $id; mtime = ([DateTimeOffset](Get-Item -LiteralPath $lp -Force).LastWriteTimeUtc).ToUnixTimeMilliseconds(); ok = $false }',
    '    $l = $null',
    '    try { $l = Get-Content -LiteralPath $lp -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $l = $null }',
    '    if ($l -is [Management.Automation.PSCustomObject]) {',
    '      $o["ok"] = $true',
    '      foreach ($key in "by", "pid", "created", "at", "transport") { $v = $l.$key; if ($v -is [string] -or $v -is [ValueType]) { $o[$key] = $v } }',
    '    }',
    '    [void]$locks.Add($o)',
    '  }',
    '} catch { [void]$errors.Add("locks:") } }',
    '$sessionOut = $null',
    'if ($null -ne $session) { $sessionOut = [ordered]@{ pid = [long]$session.ProcessId; created = (Get-Created $session) } }',
    '$result = [ordered]@{ v = 1; self = [long]$PID; session = $sessionOut; slot = $slot; procs = $procs; registry = $registry; transcripts = $transcripts; locks = $locks; claim = $claim; heavy = $heavy; freeKb = $freeKb; errors = $errors }',
    'if ($slotSeen) { $result["slotSeen"] = $true }',
    '$result | ConvertTo-Json -Compress -Depth 6',
  ].join('\r\n')
}

// ---------------------------------------------------------------------------------------------
// The probe's answer, every field checked.

/** `created` is a FILETIME as a decimal string, exact: compare it with ticks() and ticksApart(), never as a number. */
/** `cli`: a claude.exe running a Claude Code command (`claude plugin ...`), holding no conversation (Get-Cli). */
export type ProcessEntry = {
  readonly pid: number
  readonly ppid: number
  readonly created: string
  readonly name: string
  readonly cls?: ProcessClass
  readonly ids?: readonly string[]
  readonly cli?: true
}

/** A registry file, as its shape was judged: `ok` holds what L1 reads; `bad` says what's wrong with it. */
export type RegistryEntry =
  | {
      readonly dir: number
      readonly file: number
      readonly shape: 'ok'
      readonly pid: number
      readonly sessionId: string
      /** A FILETIME: a number, or a string of digits as Claude Code 2.1.318 writes it. */
      readonly procStart: number | string
      /** Keys not in REGISTRY_KEYS: ignored, and logged once per process by the plugin. */
      readonly extra: readonly string[]
      /** The asked-about conversations it names in any key but sessionId, cwd and name. */
      readonly mentions: readonly string[]
    }
  | { readonly dir: number; readonly file: number; readonly shape: 'bad'; readonly why: string }

export type Transcript = { readonly id: string; readonly dir: number; readonly project: string; readonly mtime: number }

export type LockEntry =
  | { readonly id: string; readonly mtime: number; readonly ok: true; readonly by: string; readonly pid: number; readonly created: string; readonly at: number; readonly transport: string }
  | { readonly id: string; readonly mtime: number; readonly ok: false }

export type ClaimResult = { readonly id: string; readonly taken: true; readonly by: string } | { readonly id: string; readonly taken: false; readonly why: string }

/** The slot runner: its pid, its creation FILETIME and its id (`<pid>-<created>`) as exact strings, its script and that script's hash. */
export type SlotParent = { readonly pid: number; readonly created: string; readonly id: string; readonly path: string; readonly sha256: string | null; readonly hashError?: string }

export type HeavySlot = { readonly slot: '.gate-lock' | '.gate-lock-2'; readonly winpid: number | null }

/** What the probe couldn't read: a source, and for registry and transcripts the config folder's index. */
export type ProbeError = 'registry' | 'transcripts' | 'locks' | 'heavy' | 'memory'

export type Probe = {
  readonly self: number
  readonly session: { readonly pid: number; readonly created: string } | null
  readonly slot: SlotParent | null
  /** The parent runs claude-slot.ps1 some other way than the slot runner this code recognises. */
  readonly slotSeen: boolean
  readonly procs: readonly ProcessEntry[]
  readonly registry: readonly RegistryEntry[]
  readonly transcripts: readonly Transcript[]
  readonly locks: readonly LockEntry[]
  readonly claim: ClaimResult | null
  readonly heavy: readonly HeavySlot[] | null
  readonly freeKb: number | null
  readonly errors: readonly { readonly source: ProbeError; readonly dir?: number }[]
  /** Every key a registry file held that isn't in REGISTRY_KEYS, each once: ignored, for the plugin to log. */
  readonly extraKeys: readonly string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isCount = (value: unknown, max = 2 ** 53): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
const isPid = (value: unknown): value is number => isCount(value, 0xffffffff)
/** A FILETIME as the probe prints it: a decimal string, so it stays exact past 2^53. */
const isTicks = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value)
const NAME = /^[^\u0000-\u001f\u007f]{1,260}$/
const PROJECT = /^[A-Za-z0-9-]{1,200}$/
const KEY = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/
const STATUS = /^[a-z][a-z_-]{0,31}$/
const SHA256 = /^[0-9a-f]{64}$/

class Bad extends Error {}
const bad = (what: string): never => {
  throw new Bad(what)
}

/** Only these keys, each of them there or optional. */
function fields(value: unknown, what: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isRecord(value)) bad(`${what} is not an object`)
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) if (!required.includes(key) && !optional.includes(key)) bad(`${what} has an unknown field ${JSON.stringify(key)}`)
  for (const key of required) if (!(key in record)) bad(`${what} has no ${key}`)
  return record
}

const list = (value: unknown, what: string): unknown[] => (Array.isArray(value) ? value : bad(`${what} is not a list`))

/** What a value is, as a refusal names it: null, a nested object, a list, or its JavaScript type. */
const kindOf = (value: unknown): string => {
  if (value === null) return 'null'
  if (Array.isArray(value) || (isRecord(value) && value.nested === 'list')) return 'list'
  return typeof value === 'object' ? 'nested object' : typeof value
}

/**
 * One registry file's shape, judged by what liveness reads (REGISTRY_FIELDS), strictly: pid a whole
 * number equal to the file's name, sessionId a session id, procStart a whole number or a string of
 * digits. Missing or of another type, the file is `bad`, naming the field. A key of
 * REGISTRY_VERSION_MARKERS, or a `version` that isn't a string, is a new format: `bad` too, naming it.
 * Any other key is ignored, and listed in `extra` when it isn't in REGISTRY_KEYS. `mentions` are the
 * asked-about ids it names in any key but sessionId, cwd and name, which liveness reads (a
 * conversation named there is unknown).
 */
function registryShape(raw: Record<string, unknown>, dir: number, file: number): RegistryEntry {
  const no = (why: string): RegistryEntry => ({ dir, file, shape: 'bad', why })
  if (raw.ok !== true) return no("can't be parsed as a JSON object")
  const keys = list(raw.keys, 'a registry entry\'s keys')
  for (const key of keys) if (typeof key !== 'string' || !KEY.test(key)) return no('holds a key that is not a plain name')
  const names = keys as string[]
  for (const marker of REGISTRY_VERSION_MARKERS) if (names.includes(marker)) return no(`holds the key "${marker}", which marks a new format`)
  if ('version' in raw && typeof raw.version !== 'string') return no(`has a version that is a ${kindOf(raw.version)}, not Claude Code's version as a string`)
  for (const key of REGISTRY_FIELDS) if (!names.includes(key) || !(key in raw)) return no(`has no ${key}`)
  const { pid, sessionId, procStart } = raw
  if (typeof pid !== 'number') return no(`has a pid that is a ${kindOf(pid)}, not a number`)
  if (!isPid(pid) || pid !== file) return no('has a pid that is not its file\'s')
  if (typeof sessionId !== 'string') return no(`has a sessionId that is a ${kindOf(sessionId)}, not a string`)
  if (!SESSION_ID.test(sessionId)) return no('has a sessionId that is not a session id')
  if (typeof procStart === 'number') {
    if (!isCount(procStart, Number.MAX_VALUE)) return no('has a procStart that is not a whole number')
  } else if (typeof procStart === 'string') {
    if (!/^[0-9]{1,20}$/.test(procStart)) return no('has a procStart that is a string, but not of digits')
  } else return no(`has a procStart that is a ${kindOf(procStart)}, not a number or a string of digits`)
  const extra = names.filter(key => !(REGISTRY_KEYS as readonly string[]).includes(key))
  const mentions = 'mentions' in raw ? (raw.mentions as string[]) : []
  return { dir, file, shape: 'ok', pid, sessionId, procStart, extra, mentions }
}

/** The probe's answer, every field checked; `{ error }` naming the first that isn't what it must be. */
export function parseProbe(stdout: string): Probe | { error: string } {
  const line = stdout
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.startsWith('{'))
    .at(-1)
  if (line === undefined) return { error: 'the probe printed no answer' }
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return { error: "the probe's answer is not JSON" }
  }
  try {
    const top = fields(raw, 'the answer', ['v', 'self', 'session', 'slot', 'procs', 'registry', 'transcripts', 'locks', 'claim', 'heavy', 'freeKb', 'errors'], ['slotSeen'])
    if ('slotSeen' in top && (top.slotSeen !== true || top.slot !== null)) bad('the answer says a slot runner was seen, but not as one')
    if (top.v !== 1) bad('the answer is not version 1')
    if (!isPid(top.self)) bad("the probe's own pid is not a pid")
    let session: Probe['session'] = null
    if (top.session !== null) {
      const s = fields(top.session, 'the session', ['pid', 'created'])
      if (!isPid(s.pid) || !isTicks(s.created)) bad('the session is not a pid and a time as a string')
      session = { pid: s.pid as number, created: s.created as string }
    }
    let slot: SlotParent | null = null
    if (top.slot !== null) {
      const s = fields(top.slot, 'the slot', ['pid', 'created', 'id', 'path', 'sha256'], ['hashError'])
      if ('hashError' in s && (typeof s.hashError !== 'string' || s.hashError.length > 2000)) bad("the slot's hash error is not a line of text")
      if (!isPid(s.pid) || !isTicks(s.created)) bad('the slot is not a pid and a time as a string')
      if (s.id !== `${s.pid}-${s.created}`) bad("the slot's id is not its pid and time")
      if (!isSafeFolder(s.path) || !/\\claude-slot\.ps1$/i.test(s.path as string)) bad("the slot's script is not a plain path")
      if (s.sha256 !== null && (typeof s.sha256 !== 'string' || !SHA256.test(s.sha256))) bad("the slot's hash is not a SHA-256")
      slot = {
        pid: s.pid as number,
        created: s.created as string,
        id: s.id as string,
        path: s.path as string,
        sha256: s.sha256 as string | null,
        ...(typeof s.hashError === 'string' ? { hashError: s.hashError } : {}),
      }
    }
    const procs = list(top.procs, 'the processes').map((value): ProcessEntry => {
      const p = fields(value, 'a process', ['pid', 'ppid', 'created', 'name'], ['cls', 'ids', 'cli'])
      if ('cli' in p && (p.cli !== true || typeof p.name !== 'string' || p.name.toLowerCase() !== 'claude.exe')) bad('a process is a Claude Code command but not a claude.exe')
      if (!isPid(p.pid) || !isPid(p.ppid) || !isTicks(p.created)) bad('a process has no pid, parent or time as a string')
      if (typeof p.name !== 'string' || (p.name !== '' && !NAME.test(p.name))) bad("a process's name is not a plain name")
      if ('cls' in p && !(PROCESS_CLASSES as readonly unknown[]).includes(p.cls)) bad("a process's class is not one of the fixed list")
      const ids = 'ids' in p ? list(p.ids, "a process's ids") : undefined
      if (ids !== undefined && (ids.length === 0 || ids.some(id => typeof id !== 'string' || !SESSION_ID.test(id)))) bad("a process's ids are not session ids")
      return {
        pid: p.pid as number,
        ppid: p.ppid as number,
        created: p.created as string,
        name: p.name as string,
        ...('cls' in p ? { cls: p.cls as ProcessClass } : {}),
        ...(ids !== undefined ? { ids: ids as string[] } : {}),
        ...(p.cli === true ? { cli: true as const } : {}),
      }
    })
    const registry = list(top.registry, 'the registry').map((value): RegistryEntry => {
      const r = fields(value, 'a registry entry', ['dir', 'file', 'ok'], ['keys', 'pid', 'sessionId', 'procStart', 'status', 'statusUpdatedAt', 'kind', 'version', 'mentions'])
      if (!isCount(r.dir, 7) || !isPid(r.file) || typeof r.ok !== 'boolean') bad('a registry entry has no folder, file or parse flag')
      if ('mentions' in r && (r.ok !== true || !Array.isArray(r.mentions) || r.mentions.length > 8 || !r.mentions.every(m => typeof m === 'string' && SESSION_ID.test(m)))) {
        bad("a registry entry's mentions are not session ids")
      }
      if (r.ok === false && 'keys' in r) bad('a registry entry that did not parse has keys')
      return registryShape(r, r.dir as number, r.file as number)
    })
    const transcripts = list(top.transcripts, 'the transcripts').map((value): Transcript => {
      const t = fields(value, 'a transcript', ['id', 'dir', 'project', 'mtime'])
      if (typeof t.id !== 'string' || !SESSION_ID.test(t.id) || !isCount(t.dir, 7)) bad('a transcript has no id or folder')
      if (typeof t.project !== 'string' || !PROJECT.test(t.project) || !isCount(t.mtime)) bad("a transcript's project or time is not plain")
      return { id: t.id as string, dir: t.dir as number, project: t.project as string, mtime: t.mtime as number }
    })
    const locks = list(top.locks, 'the locks').map((value): LockEntry => {
      const l = fields(value, 'a lock', ['id', 'mtime', 'ok'], ['by', 'pid', 'created', 'at', 'transport'])
      if (typeof l.id !== 'string' || !SESSION_ID.test(l.id) || !isCount(l.mtime) || typeof l.ok !== 'boolean') bad('a lock has no id, time or parse flag')
      const id = l.id as string
      const mtime = l.mtime as number
      const isWhole =
        l.ok === true &&
        typeof l.by === 'string' &&
        CLAIM_BY.test(l.by) &&
        isPid(l.pid) &&
        isTicks(l.created) &&
        isCount(l.at) &&
        typeof l.transport === 'string' &&
        STATUS.test(l.transport)
      if (!isWhole) return { id, mtime, ok: false }
      return { id, mtime, ok: true, by: l.by as string, pid: l.pid as number, created: l.created as string, at: l.at as number, transport: l.transport as string }
    })
    let claim: ClaimResult | null = null
    if (top.claim !== null) {
      const c = fields(top.claim, 'the claim', ['id', 'taken'], ['by', 'why'])
      if (typeof c.id !== 'string' || !SESSION_ID.test(c.id)) bad('the claim names no session id')
      if (c.taken === true) {
        if (typeof c.by !== 'string' || !CLAIM_BY.test(c.by) || 'why' in c) bad('the claim taken names no claimant')
        claim = { id: c.id as string, taken: true, by: c.by as string }
      } else if (c.taken === false) {
        if (typeof c.why !== 'string' || !STATUS.test(c.why) || 'by' in c) bad('the claim not taken says no reason')
        claim = { id: c.id as string, taken: false, why: c.why as string }
      } else bad('the claim is neither taken nor not')
    }
    let heavy: HeavySlot[] | null = null
    if (top.heavy !== null) {
      heavy = list(top.heavy, 'the heavy slots').map((value): HeavySlot => {
        const h = fields(value, 'a heavy slot', ['slot', 'winpid'])
        if (h.slot !== '.gate-lock' && h.slot !== '.gate-lock-2') bad('a heavy slot is not one of the two')
        if (h.winpid !== null && !isPid(h.winpid)) bad("a heavy slot's winpid is not a pid")
        return { slot: h.slot as HeavySlot['slot'], winpid: h.winpid as number | null }
      })
    }
    if (top.freeKb !== null && !isCount(top.freeKb)) bad('free memory is not a number')
    const errors = list(top.errors, 'the errors').map(value => {
      const m = typeof value === 'string' ? /^(registry|transcripts|locks|heavy|memory):(\d?)$/.exec(value) : null
      if (m === null) return bad('an error is not one of the fixed list')
      return m[2] === '' ? { source: m[1] as ProbeError } : { source: m[1] as ProbeError, dir: Number(m[2]) }
    })
    const extraKeys = [...new Set(registry.flatMap(entry => (entry.shape === 'ok' ? entry.extra : [])))]
    return { self: top.self as number, session, slot, slotSeen: top.slotSeen === true, procs, registry, transcripts, locks, claim, heavy, freeKb: top.freeKb as number | null, errors, extraKeys }
  } catch (err) {
    if (err instanceof Bad) return { error: `the probe's answer is not what it must be: ${err.message}` }
    throw err
  }
}

// ---------------------------------------------------------------------------------------------
// The process tree.

const isClaude = (p: ProcessEntry): boolean => p.name.toLowerCase() === 'claude.exe'

/** A FILETIME, exact: from the probe's string, a registry's string of digits (Claude Code 2.1.318), or a registry number (a double already). */
export const ticks = (value: string | number): bigint => BigInt(typeof value === 'number' ? Math.trunc(value) : value)

/** How far apart two FILETIMEs are, in ticks, exactly. */
export function ticksApart(a: string | number, b: string | number): bigint {
  const d = ticks(a) - ticks(b)
  return d < BigInt(0) ? -d : d
}

/** Whether two FILETIMEs are within PROC_START_TOLERANCE (1 ms) of each other. */
const near = (a: string | number, b: string | number): boolean => ticksApart(a, b) <= BigInt(PROC_START_TOLERANCE)

const byPid = (probe: Probe): Map<number, ProcessEntry> => new Map(probe.procs.map(p => [p.pid, p]))

/** A process's parent, while it is older than its child; a process that took a gone parent's id is none. */
function parentOf(table: Map<number, ProcessEntry>, p: ProcessEntry): ProcessEntry | undefined {
  const up = table.get(p.ppid)
  return up !== undefined && up.pid !== p.pid && ticks(up.created) <= ticks(p.created) ? up : undefined
}

/** A FILETIME as a time a person reads: UTC, to the minute. */
const when = (filetime: number | string): string => new Date(Number(filetime) / 10_000 - 11_644_473_600_000).toISOString().slice(0, 16).replace('T', ' ')

/** How long ago, in whole minutes or seconds. */
const ago = (ms: number): string => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(0, Math.round(ms / 1000))} s`)

/** This session's own claude.exe in the table, when the probe found one and it is there. */
function sessionProcess(probe: Probe, table: Map<number, ProcessEntry>): ProcessEntry | undefined {
  if (probe.session === null) return undefined
  const p = table.get(probe.session.pid)
  return p !== undefined && isClaude(p) && p.created === probe.session.created ? p : undefined
}

/**
 * Everything running under this session's claude.exe, by the walk down that takes a child only when
 * its parent is older than it; the probe itself and what runs under it are left out.
 */
export function descendants(probe: Probe): ProcessEntry[] {
  const table = byPid(probe)
  const root = sessionProcess(probe, table)
  if (root === undefined) return []
  const own = new Set<number>()
  let at = table.get(probe.self)
  for (let i = 0; i < 16 && at !== undefined && at.pid !== root.pid; i += 1) {
    own.add(at.pid)
    at = parentOf(table, at)
  }
  const children = new Map<number, ProcessEntry[]>()
  for (const p of probe.procs) {
    const up = parentOf(table, p)
    if (up !== undefined) children.set(up.pid, [...(children.get(up.pid) ?? []), p])
  }
  const found: ProcessEntry[] = []
  const seen = new Set<number>([root.pid])
  let level = children.get(root.pid) ?? []
  for (let depth = 0; depth < 32 && level.length > 0; depth += 1) {
    const next: ProcessEntry[] = []
    for (const p of level) {
      if (seen.has(p.pid) || own.has(p.pid)) continue
      seen.add(p.pid)
      found.push(p)
      next.push(...(children.get(p.pid) ?? []))
    }
    level = next
  }
  return found
}

// ---------------------------------------------------------------------------------------------
// Liveness: never two processes on one conversation.

/** The coordinator's word on a conversation (L4), in coordinated mode only. */
export type LaneEvidence = { readonly isLive: boolean; readonly why?: string } | 'unreachable'

export type Liveness = { readonly verdict: 'live' | 'not-live' | 'unknown'; readonly evidence: readonly string[] }

/** Whether a claim lock no longer counts: its creator isn't running and it is older than 15 minutes. */
function isStale(lock: LockEntry, table: Map<number, ProcessEntry>, now: number): boolean {
  if (!lock.ok) return now - lock.mtime > CLAIM_STALE_MS
  const creator = table.get(lock.pid)
  const isRunning = creator !== undefined && near(creator.created, lock.created)
  return !isRunning && now - lock.at > CLAIM_STALE_MS
}

/**
 * The keys of the probe's registry files not in REGISTRY_KEYS that `seen` doesn't hold yet: added to it,
 * and returned for the caller to log, so each new key name is logged once per process.
 */
export function newRegistryKeys(probe: Probe, seen: Set<string>): string[] {
  const fresh = probe.extraKeys.filter(key => !seen.has(key))
  for (const key of fresh) seen.add(key)
  return fresh
}

/**
 * Whether conversation `id` is live on this machine, from one probe (\u00a73.2 of the design):
 * - L1: a current registry entry (its pid a running claude.exe started within 1 ms of its procStart)
 *   holds it; an entry whose process has gone, or whose pid another process took, is ignored;
 * - L2: a process names it on its command line, unless it is a claude.exe started more than 60 s
 *   before the probe whose own current registry entry names another conversation (it was started with
 *   --resume <id>, and switched in place since);
 * - L3: its transcript was written less than 10 minutes ago;
 * - L4: the coordinator says its lane is live, or a claim of its names another (coordinated mode);
 * - L5: its heartbeat is younger than 5 minutes;
 * - L6: a claim lock on it that isn't `mine` and isn't stale.
 * Unknown, which refuses too: a source the probe couldn't read; a registry file of a running
 * claude.exe that can't be parsed, whose REGISTRY_FIELDS are missing or of another type, or that
 * marks a new format (registryShape), or that names `id` anywhere but its sessionId; a claude.exe
 * no current entry accounts for, itself or through an older ancestor, unless it runs a Claude Code
 * command or a claude.exe running one started it (`cli`); the coordinator unreachable; no transcript of it on this
 * machine, or more than one.
 */
/** Whether `p`, or a claude.exe in the unbroken run of claude.exe parents above it, runs a Claude Code command. */
function underCli(table: Map<number, ProcessEntry>, p: ProcessEntry): boolean {
  let at: ProcessEntry | undefined = p
  for (let i = 0; i < 8 && at !== undefined && isClaude(at); i += 1) {
    if (at.cli === true) return true
    at = parentOf(table, at)
  }
  return false
}

export function liveness(probe: Probe, id: string, now: number, opts: { lane?: LaneEvidence; heartbeat?: { readonly at: number }; mine?: string } = {}): Liveness {
  const live: string[] = []
  const unknown: string[] = []
  const table = byPid(probe)
  for (const e of probe.errors) {
    if (e.source === 'registry') unknown.push(`unknown: the session registry of config folder ${e.dir ?? '?'} can't be read`)
    if (e.source === 'transcripts') unknown.push(`unknown: the transcripts of config folder ${e.dir ?? '?'} can't be read`)
    if (e.source === 'locks') unknown.push("unknown: the claim locks can't be read")
  }
  const current = new Set<number>()
  /** The probe's own process: its creation time is the snapshot's. */
  const snapshot = table.get(probe.self)
  /** The conversations each claude.exe's own current, well-formed registry entries name. */
  const holds = new Map<number, string[]>()
  for (const entry of probe.registry) {
    const owner = table.get(entry.file)
    const isLiveClaude = owner !== undefined && isClaude(owner)
    if (entry.shape === 'bad') {
      if (isLiveClaude) unknown.push(`unknown: the registry file of running claude.exe ${entry.file} ${entry.why}`)
      continue
    }
    // Named outside its sessionId (a key this check doesn't read): what that process holds is unclear.
    if (isLiveClaude && entry.sessionId !== id && entry.mentions.includes(id)) {
      unknown.push(`unknown: the registry file of running claude.exe ${entry.file} names it outside its sessionId`)
    }
    if (!isLiveClaude || !near(owner.created, entry.procStart)) continue
    current.add(entry.pid)
    holds.set(entry.pid, [...(holds.get(entry.pid) ?? []), entry.sessionId])
    if (entry.sessionId === id) live.push(`L1: claude.exe ${entry.pid} (started ${when(entry.procStart)} UTC) holds it`)
  }
  for (const p of probe.procs) {
    if (!p.ids?.includes(id)) continue
    // A claude.exe started as `claude --resume <id>` keeps that line after it switched in place: its own
    // current entry naming another conversation says it moved on. With none, or a bad one, L2 holds.
    // Only for one started more than 60 s before this snapshot (the probe's own start, from the same
    // process table): a fresh one may not have written the conversation it resumes yet.
    const held = holds.get(p.pid)
    const settled = snapshot !== undefined && ticks(snapshot.created) - ticks(p.created) > BigInt(LAUNCH_LINE_TRUSTED_AFTER_MS) * BigInt(10_000)
    if (settled && held !== undefined && held.length > 0 && held.every(other => other !== id)) continue
    live.push(`L2: ${p.name} ${p.pid} names it on its command line`)
  }
  for (const p of probe.procs) {
    if (!isClaude(p)) continue
    // A Claude Code command (claude plugin ..., --version), or a claude.exe it started: no conversation,
    // and no registry entry. L2 above still reads its command line.
    if (underCli(table, p)) continue
    let at: ProcessEntry | undefined = p
    let isAccounted = false
    for (let i = 0; i < 32 && at !== undefined && !isAccounted; i += 1) {
      isAccounted = current.has(at.pid)
      at = parentOf(table, at)
    }
    if (!isAccounted) unknown.push(`unknown: claude.exe ${p.pid} isn't in any registry this plugin knows (another config folder, or a version without one)`)
  }
  const transcripts = probe.transcripts.filter(t => t.id === id)
  if (transcripts.length === 0) unknown.push(`unknown: no transcript of ${id} is on this machine`)
  if (transcripts.length > 1) unknown.push(`unknown: ${transcripts.length} project folders hold a transcript of ${id}`)
  for (const t of transcripts) if (now - t.mtime < TRANSCRIPT_LIVE_MS) live.push(`L3: its transcript was written ${ago(now - t.mtime)} ago`)
  if (opts.lane === 'unreachable') unknown.push("unknown: the coordinator can't be reached")
  else if (opts.lane?.isLive === true) live.push(`L4: ${opts.lane.why ?? 'the coordinator has its lane live'}`)
  if (opts.heartbeat !== undefined && now - opts.heartbeat.at < HEARTBEAT_LIVE_MS) live.push(`L5: its heartbeat is ${ago(now - opts.heartbeat.at)} old`)
  for (const lock of probe.locks) {
    if (lock.id !== id || (lock.ok && opts.mine !== undefined && lock.by === opts.mine) || isStale(lock, table, now)) continue
    live.push(lock.ok ? `L6: a claim lock on it names ${lock.by} (taken ${ago(now - lock.at)} ago)` : "L6: a claim lock on it can't be read and is less than 15 minutes old")
  }
  const verdict = live.length > 0 ? 'live' : unknown.length > 0 ? 'unknown' : 'not-live'
  return { verdict, evidence: [...live, ...unknown] }
}

// ---------------------------------------------------------------------------------------------
// The safe point.

/**
 * One tree the safe point reads for S11: the session's start folder (`start`), or a worktree of the
 * same repository the caller named (`named`). Its branch (null when detached, or no repository), its
 * head commit (null when there is none yet), how many files are uncommitted, and the fingerprint of
 * that dirty state (fingerprintOf; null when it can't be read whole).
 */
export type TreeState = {
  readonly path: string
  readonly role: 'start' | 'named'
  readonly branch: string | null
  readonly head: string | null
  readonly dirty: number
  readonly fingerprint: string | null
}

/**
 * Git's state where the session works: what's in flight in every worktree of its repos (S2), and each
 * tree S11 reads. Unreadable, it holds; `check` names the check a refusal belongs to (S11 for a named
 * tree that isn't a worktree of the start folder's repository; S2 otherwise).
 */
export type GitState =
  | { readonly isReadable: true; readonly markers: readonly string[]; readonly trees: readonly TreeState[] }
  | { readonly isReadable: false; readonly why: string; readonly check?: 'S2' | 'S11' }

/**
 * The start folder's dirty state when the conversation started (S11's baseline): the folder, its
 * fingerprint then, and when it was taken. Its dirt then holds only once the fingerprint has changed.
 */
export type Baseline = { readonly folder: string; readonly fingerprint: string; readonly at: number }

export type AgentLike = { readonly status: string; readonly description?: string; readonly type?: string }

export type SafePoint = { readonly verdict: 'clear' | 'hold'; readonly reasons: readonly string[] }

const CHECK: Record<ProcessClass, (p: ProcessEntry) => string> = {
  git: p => `S2: ${p.name} ${p.pid} runs under this session (a git operation in flight)`,
  'heavy-slot': p => `S3: a heavy-slot job (${p.name} ${p.pid}) runs under this session`,
  dev: p => `S4: ${p.name} ${p.pid} under this session is a dev server, Playwright or a debugged browser`,
  build: p => `S6: ${p.name} ${p.pid} under this session is a build, test or lint`,
  shell: p => `S6: ${p.name} ${p.pid} runs under this session (a background job of the Bash, PowerShell or Monitor tool)`,
}

/**
 * Whether the session is at a safe point to end or switch (\u00a74 of the design): `hold` with a reason
 * line per check that stops it, `clear` only when every check could be read and none stops it.
 * - S1: a subagent pending, running or waiting (`agents`; a string says why they couldn't be read);
 * - S2: a git process under the session, or a git operation in flight in a worktree of its repos;
 * - S3: a heavy slot whose job's Windows pid runs under the session, or a heavy-slot job under it;
 * - S4: a dev server, Playwright or a debugged browser under it;
 * - S6: a build, test or lint under it, and any shell under it: a background job;
 * - S11: uncommitted changes in a tree `git` read: in a named worktree, any (a worker's own tree must be
 *   clean); in the start folder, only once its fingerprint differs from `baseline`, taken when the
 *   conversation started (a shared checkout may carry changes that aren't this session's). With no
 *   baseline for that folder, its dirt holds, saying so.
 * `probe` is a string when the probe failed: why.
 */
export function safePoint(probe: Probe | string, git: GitState, agents: readonly AgentLike[] | string, baseline?: Baseline): SafePoint {
  const reasons: string[] = []
  if (typeof agents === 'string') reasons.push(`S1: the session's subagents can't be read (${agents})`)
  else {
    const busy = agents.filter(a => BUSY_AGENTS.includes(a.status)).map(a => (a.description?.trim() ? a.description.trim() : (a.type ?? 'an agent')))
    if (busy.length > 0) reasons.push(`S1: ${busy.length === 1 ? 'a subagent is' : `${busy.length} subagents are`} still running (${busy.join('; ')})`)
  }
  if (typeof probe === 'string') reasons.push(`the machine probe failed (${probe}), so what runs under this session is unknown`)
  else {
    const table = byPid(probe)
    if (sessionProcess(probe, table) === undefined) reasons.push("this session's own claude.exe wasn't found above the probe, so what runs under it is unknown")
    else {
      const under = descendants(probe)
      const pids = new Set(under.map(p => p.pid))
      if (probe.errors.some(e => e.source === 'heavy')) reasons.push("S3: the heavy-slot folders can't be read")
      const held = (probe.heavy ?? []).filter(h => h.winpid !== null && pids.has(h.winpid))
      for (const h of held) reasons.push(`S3: this session holds heavy slot ${h.slot} (its job, Windows pid ${h.winpid}, runs under it)`)
      const heldPids = new Set(held.map(h => h.winpid))
      for (const p of under) if (p.cls !== undefined && !(p.cls === 'heavy-slot' && heldPids.has(p.pid))) reasons.push(CHECK[p.cls](p))
    }
  }
  if (!git.isReadable) reasons.push(git.check === 'S11' ? `S11: ${git.why}` : `S2: git's state can't be read (${git.why})`)
  else {
    for (const marker of git.markers) reasons.push(`S2: ${marker}`)
    for (const tree of git.trees) {
      const why = s11(tree, baseline)
      if (why !== undefined) reasons.push(why)
    }
  }
  return { verdict: reasons.length === 0 ? 'clear' : 'hold', reasons }
}

/** Two folders compared as Windows compares paths: either slash, no trailing one, without regard to case. */
export const sameFolder = (a: string, b: string): boolean => folderKey(a) === folderKey(b)
const folderKey = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** Why `tree`'s uncommitted changes hold (S11), or undefined when they don't. */
function s11(tree: TreeState, baseline: Baseline | undefined): string | undefined {
  if (tree.dirty === 0) return undefined
  const files = tree.dirty === 1 ? '1 file is' : `${tree.dirty} files are`
  if (tree.role === 'named') return `S11: ${files} uncommitted in ${tree.path}, dirty, no baseline: a named worktree must be clean (commit or stash them)`
  if (baseline === undefined || !sameFolder(baseline.folder, tree.path)) {
    return `S11: ${files} uncommitted in ${tree.path}, the start folder, dirty, no baseline (this conversation started before one was kept, or it can't be read): commit or stash them, or the merger's anyway`
  }
  if (tree.fingerprint === null) return `S11: ${files} uncommitted in ${tree.path}, the start folder, and they can't be read whole to compare with the baseline: commit or stash them, or the merger's anyway`
  if (tree.fingerprint === baseline.fingerprint) return undefined
  return `S11: ${files} uncommitted in ${tree.path}, the start folder, dirty since this conversation started: commit or stash them, or the merger's anyway`
}

/** The files and folders in a git folder that say an operation is in flight. */
const IN_FLIGHT = ['index.lock', 'rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG']

/** Git by fixed argv in `folder`, with a 5-second bound. */
function gitIn($: EngineInterface, folder: string, args: readonly string[]): Promise<ProcessRunResult> {
  return $.process.run(['git', '--no-optional-locks', '-C', folder, ...args], { cwd: folder, timeoutMs: GIT_TIMEOUT_MS })
}

/** The most trees a caller may name besides the start folder. */
export const MAX_TREES = 8

/**
 * The trees a caller named, checked: each an absolute folder without quotes, and a worktree of the
 * same repository as `start`, by `git worktree list --porcelain` there (paths compared with either
 * slash and without regard to case, as Windows does). Anything else is refused, naming the path.
 */
export async function checkTrees($: EngineInterface, start: string, trees: readonly string[]): Promise<{ readonly trees: readonly string[] } | { readonly refusal: string }> {
  if (trees.length === 0) return { trees: [] }
  if (trees.length > MAX_TREES) return { refusal: `${trees.length} trees are named, more than ${MAX_TREES}` }
  for (const tree of trees) if (!isSafeFolder(tree)) return { refusal: `${JSON.stringify(tree)} is not an absolute folder without quotes or control characters` }
  try {
    const run = await gitIn($, start, ['worktree', 'list', '--porcelain'])
    if (run.exitCode !== 0 || run.isStdoutTruncated) return { refusal: `the worktrees of the repository at ${start}, the start folder, can't be listed (git worktree list exited ${run.exitCode}), so no tree can be named` }
    const known = run.stdout
      .split(/\r?\n/)
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length).trim())
    const kept: string[] = []
    for (const tree of trees) {
      if (!known.some(path => sameFolder(path, tree))) return { refusal: `${tree} is not a worktree of the repository at ${start}, the start folder` }
      if (!kept.some(path => sameFolder(path, tree))) kept.push(tree)
    }
    return { trees: kept }
  } catch (err) {
    return { refusal: `the worktrees of the repository at ${start} can't be listed: ${err instanceof Error && err.message.trim() !== '' ? err.message.trim() : 'git did not answer'}` }
  }
}

/** The git reads that fingerprint a tree's dirty state: the coordinator's (S5) exactly. */
export const FINGERPRINT_READS = {
  status: ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
  diff: ['diff', 'HEAD', '--no-ext-diff', '--no-color', '--binary'],
  untracked: ['ls-files', '--others', '--exclude-standard', '-z'],
} as const

/** The most untracked files a fingerprint stats; past it, the fingerprint can't be read whole. */
export const MAX_UNTRACKED = 50

/**
 * A tree's dirty state as one hash (SHA-256, hex), as the coordinator's S5 takes it: the porcelain
 * status, the diff against HEAD (binary included), and each untracked file's size and time, joined.
 * A further edit to a file already dirty changes it where the count doesn't. Null when any part can't
 * be read whole (a read that fails, an output past the engine's 4 MiB, more than 50 untracked files).
 * `status`, when given, is the status read already.
 */
export async function fingerprintOf($: EngineInterface, folder: string, status?: string): Promise<string | null> {
  try {
    let statusText = status
    if (statusText === undefined) {
      const run = await gitIn($, folder, FINGERPRINT_READS.status)
      if (run.exitCode !== 0 || run.isStdoutTruncated) return null
      statusText = run.stdout
    }
    const diff = await gitIn($, folder, FINGERPRINT_READS.diff)
    const untracked = await gitIn($, folder, FINGERPRINT_READS.untracked)
    if ([diff, untracked].some(run => run.exitCode !== 0 || run.isStdoutTruncated)) return null
    const names = untracked.stdout.split('\0').filter(name => name !== '')
    if (names.length > MAX_UNTRACKED) return null
    const stats: string[] = []
    for (const name of names) {
      const st = await $.fs.stat(`${folder}\\${name.replace(/\//g, '\\')}`)
      stats.push(`${name}\t${st.size}\t${st.mtimeMs}`)
    }
    const bytes = new TextEncoder().encode([statusText, diff.stdout, ...stats].join('\0\0'))
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

/** How many files a `status --porcelain=v1 -z` names: a rename or a copy carries its origin as one more field. */
export function countStatus(z: string): number {
  const fields = z.split('\0')
  let count = 0
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i] as string
    if (field.length < 4) continue
    count += 1
    if (/[RC]/.test(field.slice(0, 2))) i += 1
  }
  return count
}

/**
 * One tree's state for S11: its status (porcelain, -z), branch, head and fingerprint. A folder outside
 * any repository reads clean, with no branch or head. Undefined, with `why`, when it can't be read.
 */
async function treeState($: EngineInterface, path: string, role: TreeState['role']): Promise<TreeState | { readonly why: string }> {
  const status = await gitIn($, path, FINGERPRINT_READS.status)
  if (status.exitCode !== 0) {
    if (/not a git repository/i.test(status.stderr)) return { path, role, branch: null, head: null, dirty: 0, fingerprint: null }
    return { why: `git status in ${path} exited ${status.exitCode}` }
  }
  if (status.isStdoutTruncated) return { why: `git status in ${path} printed more than can be read` }
  const branch = await gitIn($, path, ['branch', '--show-current'])
  const head = await gitIn($, path, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  const sha = head.stdout.trim()
  return {
    path,
    role,
    branch: branch.exitCode === 0 && branch.stdout.trim() !== '' ? branch.stdout.trim() : null,
    head: head.exitCode === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null,
    dirty: countStatus(status.stdout),
    fingerprint: await fingerprintOf($, path, status.stdout),
  }
}

/**
 * Git's state for the safe point, each read by fixed argv with a 5-second bound:
 * - in every worktree of the repos of `start`, the named `trees` and `folders`, an operation in
 *   flight (S2);
 * - each tree's state for S11 (TreeState): the start folder's when `dirty`, and every named tree's,
 *   always. A tree named that isn't a worktree of the start folder's repository makes the state
 *   unreadable for S11 (checkTrees); a named tree that is the start folder reads as named.
 * A folder outside any repo has nothing in flight and nothing dirty. Anything that can't be read
 * makes the state unreadable, which holds.
 */
export async function readGit(
  $: EngineInterface,
  opts: { readonly start: string; readonly trees?: readonly string[]; readonly folders?: readonly string[]; readonly dirty: boolean },
): Promise<GitState> {
  const git = (folder: string, args: readonly string[]) => gitIn($, folder, args)
  const markers: string[] = []
  const commons = new Set<string>()
  try {
    const checked = await checkTrees($, opts.start, opts.trees ?? [])
    if ('refusal' in checked) return { isReadable: false, why: checked.refusal, check: 'S11' }
    for (const folder of new Set([opts.start, ...checked.trees, ...(opts.folders ?? [])])) {
      const run = await git(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      if (run.exitCode !== 0) {
        if (/not a git repository/i.test(run.stderr)) continue
        return { isReadable: false, why: `git rev-parse in ${folder} exited ${run.exitCode}` }
      }
      const common = run.stdout.trim()
      if (common === '' || commons.has(common.toLowerCase())) continue
      commons.add(common.toLowerCase())
      const gitDirs = [common]
      if (await $.fs.exists(`${common}/worktrees`)) {
        for (const entry of await $.fs.list(`${common}/worktrees`)) if (entry.kind === 'dir') gitDirs.push(`${common}/worktrees/${entry.name}`)
      }
      for (const dir of gitDirs) {
        const names = new Set((await $.fs.list(dir)).map(entry => entry.name))
        for (const name of IN_FLIGHT) if (names.has(name)) markers.push(`${name} in ${dir}: a git operation is in flight there`)
      }
    }
    const reads: { path: string; role: TreeState['role'] }[] = []
    if (opts.dirty && !checked.trees.some(tree => sameFolder(tree, opts.start))) reads.push({ path: opts.start, role: 'start' })
    for (const tree of checked.trees) reads.push({ path: tree, role: 'named' })
    const trees: TreeState[] = []
    for (const read of reads) {
      const state = await treeState($, read.path, read.role)
      if ('why' in state) return { isReadable: false, why: state.why }
      trees.push(state)
    }
    return { isReadable: true, markers, trees }
  } catch (err) {
    return { isReadable: false, why: err instanceof Error && err.message.trim() !== '' ? err.message.trim() : 'git did not answer' }
  }
}

// ---------------------------------------------------------------------------------------------
// Transports.

/** `fallback`, on a window: why this pane's slot runner wasn't used, when it runs in one. */
export type Transport =
  | { readonly transport: 'in-place' }
  | { readonly transport: 'slot'; readonly slot: string; readonly folder: string }
  | { readonly transport: 'window'; readonly folder: string; readonly fallback?: string }

/** Why a parent that runs claude-slot.ps1 some other way isn't used as a slot. */
export const SLOT_NOT_RECOGNISED =
  "this pane runs claude-slot.ps1 some other way than the slot runner the plugin recognises (Windows PowerShell, powershell.exe -File with the script's absolute path), so it is no slot"

/** Why a slot runner found under this session isn't used, as the leaving row and the toast say it. */
export function slotFallback(slot: SlotParent): string {
  if (slot.sha256 === null) return `slot hash unreadable: ${slot.hashError === undefined ? 'no reason given' : oneLine(slot.hashError, 200)}`
  return "this pane's claude-slot.ps1 has another SHA-256 than the one shipped (an edited or older copy: copy the shipped script and restart the pane)"
}

/**
 * How conversation `to` comes to this pane, from the probe that judged it (\u00a75.3 of the design):
 * - in place (`/resume`), only when this session's transcript and `to`'s sit in the same project
 *   folder of the same config folder, compared without regard to case;
 * - else in the slot this claude.exe runs under, only when its script has the shipped hash;
 * - else a new window, with `fallback` saying why when this claude.exe runs under a slot runner that
 *   isn't used (slotFallback).
 * The slot and the window resume `to` in `folder` (its own, from its heartbeat): an absolute folder
 * whose project name is `to`'s project folder, in this session's own config folder.
 */
export function pickTransport(probe: Probe, from: string, to: string, folder: string | undefined): Transport | { refusal: string } {
  const own = probe.transcripts.filter(t => t.id === from)
  const target = probe.transcripts.filter(t => t.id === to)
  if (target.length !== 1) return { refusal: `${to} has ${target.length} transcripts on this machine, not one` }
  const there = target[0] as Transcript
  const here = own.length === 1 ? own[0] : undefined
  if (here !== undefined && here.dir === there.dir && sameProject(here.project, there.project)) return { transport: 'in-place' }
  if (there.dir !== 0) return { refusal: `${to} lives in another config folder than this session's, and a switch stays in one` }
  if (folder === undefined) return { refusal: `${to}'s folder isn't known here (it hasn't run with self-switch on this machine), and it lives in another project, so it can't be resumed in this pane` }
  if (!isSafeFolder(folder)) return { refusal: `${to}'s folder (${JSON.stringify(folder)}) is not an absolute folder without quotes or control characters` }
  const name = projectName(folder)
  if (name === undefined || !sameProject(name, there.project)) return { refusal: `${to}'s folder ${folder} is not where its transcript's project is (${there.project})` }
  const slot = probe.slot
  // The slot's id as the probe printed it: a FILETIME through a JavaScript number would not round-trip.
  if (slot !== null && slot.sha256 === SLOT_SCRIPT_SHA256) return { transport: 'slot', slot: slot.id, folder }
  if (slot !== null) return { transport: 'window', folder, fallback: slotFallback(slot) }
  if (probe.slotSeen) return { transport: 'window', folder, fallback: SLOT_NOT_RECOGNISED }
  return { transport: 'window', folder }
}

// ---------------------------------------------------------------------------------------------
// The launcher, version 2.

/** The line the launcher ends with once a window is open: `launched <pid of the process it waits on>`. */
export const LAUNCHED = /^launched (\d+)\s*$/m

/** The line the launcher ends with when it left a record for this pane's slot runner instead: `slot <pid>-<created>`. */
export const SLOTTED = /^slot (\d{1,10}-\d{1,20})\s*$/m

/** The line naming the claim the launcher took or checked: `claim <by>`. */
export const CLAIMED = /^claim ((?:slot|launch):[0-9a-f-]{1,40})\s*$/m

/** The line self-restart's launcher adds when it found this pane's slot runner but opened a window: why. */
export const FALLBACK = /^fallback (.{1,1000}?)\s*$/m

/** A switch's window: where it resumes, the claim it must find, what the re-check reads. */
export type LaunchOptions = {
  /** The conversation's own folder. */
  readonly folder: string
  /** The claim lock on the conversation must name this (`launch:<uuid>`). */
  readonly claim: string
  /** The config folders the last-moment re-check reads. */
  readonly configDirs: readonly string[]
  /** stateFolder(%LOCALAPPDATA%). */
  readonly stateDir: string
}

/**
 * The launcher script for conversation `id`. Throws on any input that isn't what it must be, so
 * nothing else can be spliced into it.
 *
 * Without `options` it is self-restart's: it resumes `id` in the folder it runs in, reads the
 * registry of the config folder Claude Code uses (CLAUDE_CONFIG_DIR, or ~\.claude), and takes the
 * claim lock itself. When this session's claude.exe runs in a slot (its parent runs a claude-slot.ps1
 * with the shipped hash), it leaves the slot a record and opens no window. With `options` it is
 * self-switch's window: the folder, the claim to find and the config folders are given.
 *
 * The window waits for this session's claude.exe to exit, then, before claude runs: reads the registry
 * and process table again and resumes nothing if the conversation is live; checks the claim lock
 * still names it; checks the folder; clears Claude Code's markers; and runs `claude --resume <id>`
 * with no other flag.
 */
export function launcherScript(id: string, options?: LaunchOptions): string {
  checkId(id)
  const tool = options === undefined ? 'self-restart' : 'self-switch'
  let where: string[]
  if (options === undefined) {
    where = [
      '$folder = (Get-Location).ProviderPath',
      "$state = Join-Path $env:LOCALAPPDATA 'claude-self-tools'",
      "$configDirs = @(if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' })",
      ...FIND_SLOT,
      // The slot only for a folder its runner takes, checked now, before this session exits: absolute,
      // no quote or control character, and the conversation's own (its project holds the transcript).
      // Otherwise the window, which escapes the folder itself.
      // A slot runner found but not used is said, never passed over in silence.
      '$slotFallback = $null',
      'if ($null -ne $slot -and -not $slotOk) { if ($null -ne $slotHashError) { $slotFallback = "slot hash unreadable: " + $slotHashError } else { $slotFallback = "this pane" + [char]39 + "s claude-slot.ps1 has another SHA-256 than the one shipped" } }',
      'if ($slotSeen) { $slotFallback = "this pane runs claude-slot.ps1 some other way than the slot runner the plugin recognises (Windows PowerShell, powershell.exe -File with the script" + [char]39 + "s absolute path), so it is no slot" }',
      'if ($slotOk) {',
      '  $projectName = [regex]::Replace($folder, "[^A-Za-z0-9]", "-")',
      '  $inProject = $false',
      '  foreach ($dir in $configDirs) { if ($projectName.Length -le 200 -and (Test-Path -LiteralPath (Join-Path $dir ("projects\\" + $projectName + "\\" + $id + ".jsonl")) -PathType Leaf)) { $inProject = $true } }',
      String.raw`  if (-not ($inProject -and $folder -cmatch "^[A-Za-z]:\\" -and $folder -notmatch "[\x00-\x1f\x22\x27\u2018\u2019\u201a\u201b\u201c\u201d\u201e]")) { $slotOk = $false; $slotFallback = "the folder this session started in isn" + [char]39 + "t one the slot runner takes" }`,
      '}',
      // The claim: the slot by its id, or this window by a fresh UUID; taken here, in this run.
      'if ($slotOk) { $by = "slot:" + $slot["id"]; $transport = "slot" } else { $by = "launch:" + [guid]::NewGuid().ToString(); $transport = "window" }',
      '$claimPath = Join-Path $state ("claims\\" + $id + ".lock")',
      ...TAKE_CLAIM,
      `if (-not $taken) { "${tool}: another switch or restart holds the claim on this conversation ($claimPath), so it is not resumed"; exit 5 }`,
      // A slot resumes the conversation in this same pane once this process exits: a record, no window.
      'if ($slotOk) {',
      '  $record = Join-Path $state ("slots\\" + $slot["id"] + ".next.json")',
      '  [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($record))',
      '  $text = [ordered]@{ v = 1; resume = $id; folder = $folder; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); configDirs = [object[]]$configDirs } | ConvertTo-Json -Compress',
      '  [IO.File]::WriteAllText($record, $text)',
      '  "slot $($slot["id"])"',
      '  "claim $by"',
      '  exit 0',
      '}',
    ]
  } else {
    const folder = checkFolder('the folder', options.folder)
    const state = checkFolder('the state folder', options.stateDir)
    if (options.configDirs.length < 1 || options.configDirs.length > 8) throw new Error('the launcher reads 1 to 8 config folders')
    const configDirs = options.configDirs.map(dir => checkFolder('a config folder', dir))
    if (!CLAIM_BY.test(options.claim) || !options.claim.startsWith('launch:')) throw new Error(`not a launch's claim: ${JSON.stringify(options.claim)}`)
    where = [
      `$folder = ${literal(folder)}`,
      `$state = ${literal(state)}`,
      `$configDirs = @(${configDirs.map(literal).join(', ')})`,
      `$by = '${options.claim}'`,
      // The probe that judged took the claim for this launch; it must still name it.
      '$claimPath = Join-Path $state ("claims\\" + $id + ".lock")',
      '$lock = $null',
      'try { $lock = Get-Content -LiteralPath $claimPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $lock = $null }',
      `if ($null -eq $lock -or $lock.by -cne $by) { "${tool}: the claim on this conversation does not name this launch, so it is not resumed"; exit 5 }`,
    ]
  }
  return [
    "$ErrorActionPreference = 'Stop'",
    // Windows PowerShell 5.1 writes its module-loading progress to a redirected stream as CLIXML,
    // which would fill the plugin's one-line account of a failure.
    "$ProgressPreference = 'SilentlyContinue'",
    `$id = '${id}'`,
    // Every process once, by id: the walk up from this launcher reads only this table.
    '$table = @{}',
    'foreach ($p in (Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate, CommandLine)) { $table[[int]$p.ProcessId] = $p }',
    // A process's parent, while it is older than the child; a later process that took a gone
    // parent's id is none.
    ...GET_PARENT,
    ...GET_CREATED,
    // The nearest claude.exe above this launcher, then the top of an unbroken run of claude.exe
    // parents, so a helper process of the session's own is never taken for the session. `$up` ends
    // as that claude.exe's own parent: the slot runner, when it runs in one.
    '$session = $null',
    '$at = $table[[int]$PID]',
    'for ($i = 0; $i -lt 8 -and $null -ne $at; $i++) {',
    '  $at = Get-Parent $at',
    "  if ($null -ne $at -and $at.Name -eq 'claude.exe') { $session = $at; break }",
    '}',
    `if ($null -eq $session) { '${tool}: no claude.exe above this launcher'; exit 3 }`,
    'for ($i = 0; $i -lt 8; $i++) {',
    '  $up = Get-Parent $session',
    "  if ($null -eq $up -or $up.Name -ne 'claude.exe') { break }",
    '  $session = $up',
    '}',
    "$claude = Get-Command -Name 'claude' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1",
    `if ($null -eq $claude) { '${tool}: no claude on PATH'; exit 4 }`,
    '$wait = [int]$session.ProcessId',
    // For a single-quoted string: every quote PowerShell reads as one doubled, the curly ones too.
    '$exe = [Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($claude.Source)',
    ...where,
    '$folderText = [Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($folder)',
    '$stateText = [Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($state)',
    `$configText = (@($configDirs | ForEach-Object { "'" + [Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($_) + "'" })) -join ', '`,
    // The new window's script: only the process id, the session id, claude's path, the folder, the
    // config folders and the claim go in, each a single-quoted literal.
    '$inner = @(',
    `  "Write-Host 'Waiting for the old Claude Code process ($wait) to exit, then resuming session $id here.'",`,
    `  "Wait-Process -Id $wait -Timeout ${WAIT_SECONDS} -ErrorAction SilentlyContinue",`,
    "  \"`$id = '$id'\",",
    "  \"`$by = '$by'\",",
    "  \"`$folder = '$folderText'\",",
    "  \"`$state = '$stateText'\",",
    "  \"`$configDirs = @($configText)\",",
    // A new PowerShell continues past a failing command by default: here a read that fails must
    // stop, so that the catch below resumes nothing.
    "  '$ErrorActionPreference = \"Stop\"',",
    "  '$refusal = $null',",
    "  \"if (Get-Process -Id $wait -ErrorAction SilentlyContinue) { `$refusal = 'The old process is still running, so the session is not resumed here: two copies would both write to it.' }\",",
    // After the wait, right before claude: whether anything holds the conversation now (L1, L2).
    "  'if ($null -eq $refusal) {',",
    "  '  $live = $null',",
    "  '  try {',",
    ...RECHECK.map(line => `  '    ${line}',`),
    "  '  } catch { $live = \"whether it is open elsewhere is unknown: the registry or the process table could not be read (\" + $_.Exception.Message + \")\" }',",
    "  '  if ($null -ne $live) { $refusal = \"The session is not resumed here, so that two copies never write it: \" + $live + \".\" }',",
    "  '}',",
    // The claim must still name this window: another switch or restart that took it over wins.
    "  'if ($null -eq $refusal) {',",
    "  '  $lock = $null',",
    "  '  try { $lock = Get-Content -LiteralPath (Join-Path $state (\"claims\\\" + $id + \".lock\")) -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $lock = $null }',",
    "  '  if ($null -eq $lock -or $lock.by -cne $by) { $refusal = \"The session is not resumed here: the claim on it no longer names this window.\" }',",
    "  '}',",
    "  'if ($null -eq $refusal -and -not (Test-Path -LiteralPath $folder -PathType Container)) { $refusal = \"The session is not resumed here: its folder \" + $folder + \" is not there.\" }',",
    "  'if ($null -ne $refusal) {',",
    "  '  Write-Host $refusal',",
    `  "  Write-Host 'Once it is safe, resume it yourself: claude --resume $id'",`,
    `  "  Read-Host 'Press Enter to close this window' | Out-Null",`,
    "  '  exit 1',",
    "  '}',",
    // The old session's markers, gone before claude starts: a claude that inherits them is nested.
    `  '${CLEAR_MARKERS}',`,
    `  '${FORCE_PERSISTENCE}',`,
    "  'Set-Location -LiteralPath $folder',",
    "  '$started = Get-Date',",
    `  "& '$exe' --resume '$id'",`,
    "  '$code = $LASTEXITCODE',",
    // An error, or an end within seconds: the resume didn't take. Say how to resume by hand, and wait.
    `  'if ($code -ne 0 -or ((Get-Date) - $started).TotalSeconds -lt ${SHORT_RUN_SECONDS}) {',`,
    `  '  Write-Host "Claude Code ended (exit code $code)."',`,
    `  "  Write-Host 'If the session did not resume here, resume it yourself: claude --resume $id'",`,
    `  "  Read-Host 'Press Enter to close this window' | Out-Null",`,
    "  '}',",
    "  'exit $code'",
    ') -join [Environment]::NewLine',
    // The window's own command line: a fixed bootstrap that unpacks the inner script (GZip, then base64,
    // inside the bootstrap itself) and runs it as one script block. Nothing is written to disk, and the
    // line stays well under the 32,767 characters Windows allows one.
    '$packed = [IO.MemoryStream]::new()',
    '$gzip = [IO.Compression.GZipStream]::new($packed, [IO.Compression.CompressionMode]::Compress)',
    '$innerBytes = [Text.Encoding]::UTF8.GetBytes($inner)',
    '$gzip.Write($innerBytes, 0, $innerBytes.Length)',
    '$gzip.Dispose()',
    '$payload = [Convert]::ToBase64String($packed.ToArray())',
    `$unpack = "& ([scriptblock]::Create([IO.StreamReader]::new([IO.Compression.GZipStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String('$payload')), [IO.Compression.CompressionMode]::Decompress), [Text.Encoding]::UTF8).ReadToEnd()))"`,
    '$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($unpack))',
    "Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile', '-EncodedCommand', $encoded",
    '"launched $wait"',
    '"claim $by"',
    ...(options === undefined ? ['if ($null -ne $slotFallback) { "fallback " + ($slotFallback -split "\r?\n")[0] }'] : []),
  ].join('\r\n')
}

/** The release script's answer: the lock removed, none there, one naming another, or one held by a taker throughout. */
export const RELEASED = /^(released|absent|not-ours|busy)\s*$/m

function checkClaim(input: { readonly stateDir: string; readonly id: string; readonly by: string }): { state: string; id: string; by: string } {
  const state = checkFolder('the state folder', input.stateDir)
  const id = checkId(input.id)
  if (!CLAIM_BY.test(input.by)) throw new Error(`not a claimant: ${JSON.stringify(input.by)}`)
  return { state, id, by: input.by }
}

/**
 * Removes the claim lock on `id`, only when it names `by`. It reads the lock through a handle that
 * lets no one else write it, and deletes it while still holding that handle, so it can never remove
 * a lock someone took over in between. A lock a taker holds, or one a reader has open so that it can't
 * be deleted yet, is tried again twice, 250 ms apart; then it is left in place (`busy`), which refuses
 * every other move until it goes stale, 15 minutes after its creator exits.
 * Throws on any input that isn't what it must be.
 */
export function releaseScript(input: { readonly stateDir: string; readonly id: string; readonly by: string }): string {
  const { state, id, by } = checkClaim(input)
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$path = Join-Path ${literal(state)} 'claims\\${id}.lock'`,
    "$answer = 'busy'",
    "for ($try = 0; $try -lt 3 -and $answer -eq 'busy'; $try++) {",
    '  if ($try -gt 0) { Start-Sleep -Milliseconds 250 }',
    "  try { $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'Read, Delete') }",
    '  catch {',
    "    if ($_.Exception -is [IO.FileNotFoundException] -or $_.Exception.InnerException -is [IO.FileNotFoundException] -or $_.Exception -is [IO.DirectoryNotFoundException] -or $_.Exception.InnerException -is [IO.DirectoryNotFoundException]) { $answer = 'absent'; continue }",
    `    if ${IS_IO} { continue }`,
    '    throw',
    '  }',
    '  try {',
    '    $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8, $true, 4096, $true)',
    '    $text = $reader.ReadToEnd()',
    '    $reader.Dispose()',
    '    $lock = $null',
    '    try { $lock = $text | ConvertFrom-Json } catch { $lock = $null }',
    // Deleted while this handle, which shares delete, still keeps every writer out.
    // A reader that has it open without sharing delete makes the delete fail: try again, then leave it.
    `    if ($null -eq $lock -or $lock.by -cne '${by}') { $answer = 'not-ours' } else { try { [IO.File]::Delete($path); $answer = 'released' } catch { if ${IS_IO} { $answer = 'busy' } else { throw } } }`,
    '  } finally { $stream.Dispose() }',
    '}',
    '$answer',
  ].join('\r\n')
}

/** The claim check's answer: the lock names the claimant, names another (or can't be read), or isn't there. */
export const CLAIM_CHECKED = /^(ours|not-ours|absent)\s*$/m

/** The claim check's other answer: the conversation is held, or may be, by another process now (L1, L2). */
export const CLAIM_CHECK_LIVE = /^live (.{1,1000}?)\s*$/m

/**
 * The last look before an in-place /resume, as the window and the slot take theirs: first the
 * re-check (RECHECK: L1 and L2 of `id`, from `configDirs`' registries and every process's command
 * line), answering `live <why>` when anything holds it or can't be read; then the claim lock on `id`,
 * whether it names `by`. Changes nothing.
 */
export function claimCheckScript(input: { readonly stateDir: string; readonly id: string; readonly by: string; readonly configDirs: readonly string[] }): string {
  const { state, id, by } = checkClaim(input)
  if (input.configDirs.length < 1 || input.configDirs.length > 8) throw new Error('the claim check reads 1 to 8 config folders')
  const configDirs = input.configDirs.map(dir => checkFolder('a config folder', dir))
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$id = '${id}'`,
    `$configDirs = @(${configDirs.map(literal).join(', ')})`,
    '$live = $null',
    'try {',
    ...RECHECK.map(line => `  ${line}`),
    '} catch { $live = "whether it is open elsewhere is unknown: the registry or the process table could not be read (" + $_.Exception.Message + ")" }',
    String.raw`if ($null -ne $live) { "live " + ($live -split "\r?\n")[0]; exit 0 }`,
    `$path = Join-Path ${literal(state)} 'claims\\${id}.lock'`,
    "if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { 'absent'; exit 0 }",
    '$lock = $null',
    'try { $lock = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $lock = $null }',
    `if ($null -ne $lock -and $lock.by -ceq '${by}') { 'ours' } else { 'not-ours' }`,
  ].join('\r\n')
}

// ---------------------------------------------------------------------------------------------
// The coordinator's gate.

/**
 * The gate file the coordinator plugin writes at gatePath(state, <conversation>):
 * `{ "v": 1, "coordinated": true, "at": <milliseconds since the epoch> }`. `coordinated` means the
 * coordinator runs switches in that conversation; one older than a day is ignored. `bad`: there is a
 * file, but not of this shape, which refuses as `coordinated` does.
 */
export function readGate(text: string, now: number): 'coordinated' | 'open' | 'stale' | 'bad' {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return 'bad'
  }
  if (!isRecord(raw) || raw.v !== 1 || typeof raw.coordinated !== 'boolean') return 'bad'
  const at = typeof raw.at === 'number' ? raw.at : typeof raw.at === 'string' ? Date.parse(raw.at) : Number.NaN
  if (!Number.isFinite(at)) return 'bad'
  if (now - at > GATE_MS) return 'stale'
  return raw.coordinated ? 'coordinated' : 'open'
}
