// The machine code self-restart, self-switch, self-exit and self-check share: what runs on this
// machine, who holds which conversation, whether a session is at a safe point, what would make /exit
// ask, the fixed scripts that look and launch, and the files the coordinator reads.
//
// Canonical copy: shared/hooks/machine.ts. It is copied, identical, to the plugins named on the next
// line, at plugins/<name>/hooks/machine.ts; `node scripts/sync-shared.mjs` writes those copies and
// `node --test "scripts/*.test.mjs"` fails when one differs, or sits in a plugin not named. Edit the
// canonical copy only.
// Copies: self-check, self-exit, self-restart, self-switch, self-wake
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
// - The launcher (launch, parseLaunch): the one function every plugin calls to start a Claude Code
//   process, for a restart, a switch, the coordinator's go or a steward's launch. It builds one script
//   that checks, takes the claim and places the launch in the same run: a ticket for the claude
//   wrapper's tab, a record for this pane's slot, or a new window. The window waits for the old
//   process when asked, reads the registry and process table again, checks the claim, and runs
//   claude-launch.ps1 (plugins/self-switch/slot/claude-launch.ps1, LAUNCH_SCRIPT_SHA256), the only
//   script that starts claude: it alone clears LAUNCH_ENV_CLEAR and sets LAUNCH_ENV_SET right before
//   claude, passes claude only --resume, or --session-id and --name, and never a permission flag.
// - The left record (leftScript, the probe's `left`, liveness's waiver): a record, MAC'd under a local
//   key that never leaves the scripts, that a plugin moved its own process off a conversation; it
//   waives L3 and L5 for that conversation only, and the last look checks its transcript again.
// - Every file named by an id (idPath): claims, left records, pokes, wake markers, the pending marker,
//   the self-check record, the gate, the wrapper's panes and the slots' records, each id shape-checked
//   before a path is built.
// - The wake marker self-wake writes (wakePath, wakeMarker, readWakeMarker, readWake): S10w's read.
// - lanes.json (lanesPath, lanesUpdateScript, readLanes): a name's current conversation and folder.
// - The claim lock: %LOCALAPPDATA%\claude-self-tools\claims\<id>.lock, created with CreateNew by the
//   run that judges, holding { v, by, pid, created, at, transport }. `by` names the one that resumes:
//   `slot:<pid>-<created>` (a slot runner) or `launch:<uuid>` (one window, one in-place move, or one
//   ticket for the claude wrapper's tab).
//   It is stale when its creator (pid and creation time) isn't running and it is older than 15 minutes.
// - The slot runner's hash (SLOT_SCRIPT_SHA256): plugins/self-switch/slot/claude-slot.ps1, byte for
//   byte. A pane is used as a slot only when the script its parent runs has this hash.
// - The claude wrapper's tab (tools/claude-wrapper/claude-wrapper.ps1, a `claude` function in the
//   person's PowerShell profile): its token and pane file (readPane, parsePane), whether this
//   claude.exe runs right under it (paneFallback), and the ticket it resumes from (paneTicket to build
//   one, checkPaneTicket for the rules the wrapper reads it by; paneScript writes it whole).
// - The gate file the coordinator writes (gatePath, readGate), and git's state (readGit).
// - The exit pre-check (exitBlockers, readExit): what would make a queued /exit stop at its
//   confirmation, or end work still running: session crons (the built-in CronList, through
//   $.tool.call once $.tool.check allows it), background jobs under the session (the probe's S6),
//   subagents, a pending wake-up. Anything it can't read is a blocker of its own ("can't tell: ..."),
//   never none.
// - The files the coordinator reads, each at an id-shaped path (pendingPath, selfcheckPath: a session
//   id, checked, or no path at all): the pending marker self-exit and self-restart keep while an exit
//   or restart is queued (readPending), and the last self-check's failed tools (readSelfcheck).
import type { EngineInterface, ProcessRunResult, Timer } from 'claude-code'

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

/** Why `path` is not a folder isSafeFolder takes, naming the class of character or part at fault; undefined when it is one. */
export function folderFault(path: unknown): string | undefined {
  if (isSafeFolder(path)) return undefined
  if (typeof path !== 'string') return 'is not text'
  if (path.length > 240) return 'is longer than 240 characters'
  if (path.length < 3 || !/^[A-Za-z]:\\/.test(path)) return 'is not an absolute folder (a drive letter, a colon and a backslash first)'
  if (/[\u0000-\u001f\u007f]/.test(path)) return 'holds a control character'
  if (/["'\u2018-\u201e]/.test(path)) return 'holds a quote (straight or typographic)'
  if (/[<>|?*/]/.test(path) || path.indexOf(':', 2) !== -1) return 'holds a character Windows does not take in a folder name (< > | ? * / or a second colon)'
  return "has a '.' or '..' part, an empty part, or a part with spaces at either end"
}

/** Why a launch never takes `path` as the conversation's folder, naming the class at fault: folderFault's, or a semicolon. */
export function launchFolderFault(path: unknown): string | undefined {
  return folderFault(path) ?? ((path as string).includes(';') ? 'holds a semicolon (;)' : undefined)
}

/** launchFolderFault as one sentence: what is wrong, and what a launch takes. */
export const launchFolderSaid = (path: unknown, fault: string): string =>
  `the folder ${JSON.stringify(path)} ${fault}, so a launch never takes it: it takes an absolute folder with no quote, control character, semicolon, < > | ? * or /, and no '.' or '..' part`

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
  return base64(bytes)
}

/** ASCII text's bytes in base64: what a script carries a file in. Throws on any other character. */
export function asciiBase64(text: string): string {
  const bytes: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i)
    if (unit > 0x7f) throw new Error('not ASCII text')
    bytes.push(unit)
  }
  return base64(bytes)
}

function base64(bytes: readonly number[]): string {
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

/** A tab's token, as the claude wrapper makes it ([guid]::NewGuid()): a lowercase UUID. */
export const PANE_TOKEN = SESSION_ID

/** A slot runner's id: its process id and its creation time (a FILETIME), `<pid>-<created>`. */
export const SLOT_ID = /^\d{1,10}-\d{1,20}$/

/**
 * Every file named by an id, its folder under the state folder and its ending. Each folder takes ids
 * of one shape: a conversation (SESSION_ID), a tab's token (PANE_TOKEN), or a slot runner (SLOT_ID).
 */
const ID_FILES = {
  claim: { folder: 'claims', ending: '.lock', shape: SESSION_ID },
  left: { folder: 'left', ending: '.json', shape: SESSION_ID },
  poke: { folder: 'poke', ending: '.json', shape: SESSION_ID },
  wake: { folder: 'wake', ending: '.json', shape: SESSION_ID },
  pending: { folder: 'pending', ending: '.json', shape: SESSION_ID },
  selfcheck: { folder: 'selfcheck', ending: '.json', shape: SESSION_ID },
  gate: { folder: 'gate', ending: '.json', shape: SESSION_ID },
  pane: { folder: 'panes', ending: '.json', shape: PANE_TOKEN },
  paneTicket: { folder: 'panes', ending: '.next.json', shape: PANE_TOKEN },
  slotRecord: { folder: 'slots', ending: '.next.json', shape: SLOT_ID },
  slotBeacon: { folder: 'slots', ending: '.state.json', shape: SLOT_ID },
} as const

/** The kinds of file named by an id. */
export type IdFile = keyof typeof ID_FILES

/**
 * The one way a path is built from an id: `<state>\<folder>\<id><ending>`, after the id is checked to
 * be of its folder's shape. Throws on anything else (`..\x`, `..%5cx`, an absolute path, a too-long
 * id, a token where a session id goes), before any path is joined.
 */
export function idPath(state: string, file: IdFile, id: unknown): string {
  const { folder, ending, shape } = ID_FILES[file]
  if (typeof id !== 'string' || !shape.test(id)) throw new Error(`not an id for ${folder}\\: ${JSON.stringify(typeof id === 'string' ? id.slice(0, 80) : id)}`)
  return `${state}\\${folder}\\${id}${ending}`
}

/** idPath, or undefined for an id of another shape: for the readers and writers that never throw. */
export function idPathOrNone(state: string, file: IdFile, id: unknown): string | undefined {
  try {
    return idPath(state, file, id)
  } catch {
    return undefined
  }
}

/** The claim lock on conversation `id`. Throws on an id that isn't a session id. */
export const claimPath = (state: string, id: string): string => idPath(state, 'claim', id)

/** The record a slot runner reads when its claude exits, by the runner's id (`<pid>-<created>`). Throws on another id. */
export const slotRecordPath = (state: string, slot: string): string => idPath(state, 'slotRecord', slot)

/** The coordinator's gate file for conversation `id`. Throws on an id that isn't a session id. */
export const gatePath = (state: string, id: string): string => idPath(state, 'gate', id)

/** The claude wrapper's pane file for the tab with `token`; undefined for a token that isn't one, so nothing else is joined into a path. */
export const panePath = (state: string, token: string): string | undefined => idPathOrNone(state, 'pane', token)

/** The ticket the claude wrapper reads when its claude exits, for the tab with `token`; undefined for a token that isn't one. */
export const paneTicketPath = (state: string, token: string): string | undefined => idPathOrNone(state, 'paneTicket', token)

/** The left record of conversation `id` (left\<id>.json). Throws on an id that isn't a session id. */
export const leftPath = (state: string, id: string): string => idPath(state, 'left', id)

/** The key the left records are MAC'd under: 32 random bytes, created once, read only inside the fixed scripts. */
export const leftKeyPath = (state: string): string => `${state}\\left.key`

/** The poke file of conversation `id` (the coordinator's, \u00a78). Throws on an id that isn't a session id. */
export const pokePath = (state: string, id: string): string => idPath(state, 'poke', id)

/** self-wake's marker for conversation `id`. Throws on an id that isn't a session id. */
export const wakePath = (state: string, id: string): string => idPath(state, 'wake', id)

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

/** A ticket for the claude wrapper's tab older than this is not honoured, as a slot record isn't. */
export const PANE_TICKET_MS = 120 * 1000

/** A ticket whose time is further ahead of the wrapper's clock than this is not honoured either. */
export const PANE_AHEAD_MS = 5 * 1000

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
export const SLOT_SCRIPT_SHA256 = 'db33bcf242ac2df21be9ab6c3de382d8dca45b712eacbb4429cce49dddee6a43'

/**
 * The SHA-256 of plugins/self-switch/slot/claude-launch.ps1, as it is committed: the only script that
 * starts claude. A window runs it only from launchScriptPath, with this hash, checked by .NET just
 * before it runs.
 */
export const LAUNCH_SCRIPT_SHA256 = '8a137a6168aab1cbef6ef3e6938ff2f2b8cb46f8b04aef9802a7d71504dd5e3a'

/** Where claude-launch.ps1 is copied, beside the slot runner: never a path read off a command line. */
export const launchScriptPath = (state: string): string => `${state}\\claude-launch.ps1`

/** claude-launch.ps1 as this release ships it, byte for byte (ASCII, LF line ends): the copy a launch puts at launchScriptPath when the one there is missing or has another SHA-256. scripts/claude-launch.test.mjs holds it equal to plugins/self-switch/slot/claude-launch.ps1 and to LAUNCH_SCRIPT_SHA256; after an edit to the script, run `node scripts/embed-launch.mjs`. */
export const LAUNCH_SCRIPT_TEXT = [
  "# claude-launch.ps1: starts Claude Code as a top-level session. The one script in",
  "# claude-code-self-tools that runs claude: every launch (a restart's or a switch's window, the",
  "# coordinator's go, a steward's launch, and you by hand) comes through it.",
  "#",
  "# Part of self-switch (claude-code-self-tools, plugins/self-switch/slot/claude-launch.ps1). Copy it,",
  "# unchanged, beside the slot runner: %LOCALAPPDATA%\\claude-self-tools\\claude-launch.ps1. The plugins",
  "# run it only from there, and only when its SHA-256 is the one they ship (LAUNCH_SCRIPT_SHA256).",
  "#",
  "# By hand, in a terminal:",
  "#   claude-launch.ps1 -Resume <session id> [-Dir <folder>]               resume a conversation",
  "#   claude-launch.ps1 -Start <session id> -Name <name> [-Dir <folder>]   start one with that id and name",
  "#   claude-launch.ps1 -Lane <name>                                        resume a session's current",
  "#                                                                         conversation, by its name",
  "#   claude-launch.ps1 [-Dir <folder>]                                     start a new session",
  "#",
  "# What it does, in order:",
  "# 1. It checks its arguments: a session id is a lowercase UUID; a name is lowercase letters, digits and",
  "#    hyphens; a folder is an absolute folder with no quote, control character or ';', and is there.",
  "#    -Lane reads lanes.json in the config folder (CLAUDE_CONFIG_DIR, else %USERPROFILE%\\.claude), and",
  "#    takes that name's conversation and folder from its entry; it never reads a transcript. Anything",
  "#    else stops it, saying why, before it changes anything.",
  "# 2. In Windows PowerShell 5.1, it sets PSModulePath to 5.1's own module folders: in a tab whose",
  "#    environment puts PowerShell 7's first, 5.1 loads 7's modules and loses cmdlets.",
  "# 3. It goes to the folder, and finds claude: %USERPROFILE%\\.local\\bin\\claude.exe when it is there,",
  "#    else the first claude application on PATH.",
  "# 4. Right before claude, the launch environment. It removes the variables Claude Code sets in the",
  "#    processes it starts (a claude that inherits them is nested, and saves no transcript), NO_COLOR",
  "#    among them, and PSExecutionPolicyPreference (an -ExecutionPolicy on the command line that ran this",
  "#    script was for this script alone). It sets CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 and",
  "#    CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1. It never touches WT_SESSION or WT_PROFILE_ID: Claude",
  "#    Code reads WT_SESSION to draw its prompt and its links.",
  "# 5. It runs claude with --resume <id>, or --session-id <id> --name <name>, or nothing else: never a",
  "#    permission flag, so the session starts in the mode a new one would. Its exit code is claude's.",
  "",
  "param([string]$Resume, [string]$Start, [string]$Name, [string]$Dir, [string]$Lane)",
  "",
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "",
  "$SessionId = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\z'",
  "$AreaName = '^[a-z0-9][a-z0-9-]{0,39}\\z'",
  "# The launch environment: LAUNCH_ENV_CLEAR and LAUNCH_ENV_SET in the plugins' machine code.",
  "$Clear = 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_JOB_DIR', 'AI_AGENT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_SSE_PORT', 'NO_COLOR'",
  "$Set = [ordered]@{ CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1'; CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP = '1' }",
  "",
  "function Stop-Launch($why) {",
  "  Write-Host ('claude-launch: ' + $why + ' Nothing was started.')",
  "  exit 2",
  "}",
  "",
  "# An absolute folder with no quote, control character or ';', no . or .. part, at most 240 characters, that is there.",
  "function Test-Folder($path) {",
  "  if ($path -isnot [string] -or $path.Length -lt 3 -or $path.Length -gt 240) { return $false }",
  "  if ($path -cnotmatch '^[A-Za-z]:\\\\' -or $path -match '[\\x00-\\x1f\\x22\\x27\\u2018-\\u201e<>|?*;/]' -or $path.IndexOf(':', 2) -ge 0) { return $false }",
  "  foreach ($part in $path.Substring(3).Split('\\')) { if ($part -eq '.' -or $part -eq '..') { return $false } }",
  "  return (Test-Path -LiteralPath $path -PathType Container)",
  "}",
  "",
  "# 1. The arguments, each checked before anything changes.",
  "$modes = 0",
  "foreach ($given in $Resume, $Start, $Lane) { if ($given) { $modes++ } }",
  "if ($modes -gt 1) { Stop-Launch 'give one of -Resume, -Start and -Lane.' }",
  "if ($Name -and -not $Start) { Stop-Launch '-Name goes with -Start.' }",
  "if ($Lane) {",
  "  if ($Dir) { Stop-Launch '-Lane takes its folder from lanes.json: give no -Dir.' }",
  "  if ($Lane -cnotmatch $AreaName) { Stop-Launch 'a session name is lowercase letters, digits and hyphens.' }",
  "  $config = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }",
  "  $lanesFile = Join-Path $config 'lanes.json'",
  "  if (-not (Test-Path -LiteralPath $lanesFile -PathType Leaf)) { Stop-Launch ('there is no ' + $lanesFile + '.') }",
  "  $doc = $null",
  "  try { $doc = [IO.File]::ReadAllText($lanesFile, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { $doc = $null }",
  "  if ($doc -isnot [Management.Automation.PSCustomObject] -or $doc.v -isnot [ValueType] -or $doc.v -ne 1 -or $doc.lanes -isnot [Management.Automation.PSCustomObject]) { Stop-Launch ($lanesFile + ' is not of its shape.') }",
  "  $entry = $null",
  "  foreach ($p in $doc.lanes.PSObject.Properties) { if ($p.Name -ceq $Lane) { $entry = $p.Value } }",
  "  if ($null -eq $entry) { Stop-Launch ('lanes.json names no session ' + $Lane + '.') }",
  "  if ($entry.session -isnot [string] -or $entry.session -cnotmatch $SessionId) { Stop-Launch ('the entry for ' + $Lane + ' names no conversation by its id.') }",
  "  if (-not (Test-Folder $entry.folder)) { Stop-Launch ('the entry for ' + $Lane + ' names no folder that is there.') }",
  "  # The conversation and its folder come from the entry, never from the name.",
  "  $Resume = $entry.session",
  "  $Dir = $entry.folder",
  "}",
  "if ($Resume -and $Resume -cnotmatch $SessionId) { Stop-Launch '-Resume takes a session id (a lowercase UUID).' }",
  "if ($Start) {",
  "  if ($Start -cnotmatch $SessionId) { Stop-Launch '-Start takes a session id (a lowercase UUID).' }",
  "  if (-not $Name -or $Name -cnotmatch $AreaName) { Stop-Launch '-Start takes -Name: lowercase letters, digits and hyphens.' }",
  "}",
  "if ($Dir -and -not (Test-Folder $Dir)) { Stop-Launch '-Dir takes an absolute folder that is there, with no quote, control character or semicolon.' }",
  "",
  "# 2. Windows PowerShell 5.1's own module folders.",
  "if ($PSVersionTable.PSEdition -ne 'Core') {",
  "  $env:PSModulePath = @([Environment]::GetFolderPath('MyDocuments') + '\\WindowsPowerShell\\Modules', [Environment]::GetFolderPath('ProgramFiles') + '\\WindowsPowerShell\\Modules', [Environment]::GetFolderPath('System') + '\\WindowsPowerShell\\v1.0\\Modules') -join ';'",
  "}",
  "",
  "# 3. The folder, and claude.",
  "if ($Dir) { Set-Location -LiteralPath $Dir }",
  "$exe = $null",
  "if ($env:USERPROFILE) {",
  "  $pinned = Join-Path $env:USERPROFILE '.local\\bin\\claude.exe'",
  "  if (Test-Path -LiteralPath $pinned -PathType Leaf) { $exe = $pinned }",
  "}",
  "if ($null -eq $exe) {",
  "  $found = @(Get-Command -Name 'claude' -CommandType Application -ErrorAction SilentlyContinue)",
  "  if ($found.Count -gt 0) { $exe = $found[0].Source }",
  "}",
  "if ($null -eq $exe) { Stop-Launch 'no claude.exe was found (in %USERPROFILE%\\.local\\bin, or on PATH).' }",
  "",
  "# 4. The launch environment, right before claude. Removed, not set to empty: [NullString]::Value, since",
  "# PowerShell passes $null to a .NET string as \"\", and PowerShell 7 keeps a variable set to \"\".",
  "foreach ($n in $Clear) { [Environment]::SetEnvironmentVariable($n, [NullString]::Value, [EnvironmentVariableTarget]::Process) }",
  "[Environment]::SetEnvironmentVariable('PSExecutionPolicyPreference', [NullString]::Value, [EnvironmentVariableTarget]::Process)",
  "foreach ($n in $Set.Keys) { [Environment]::SetEnvironmentVariable($n, $Set[$n], [EnvironmentVariableTarget]::Process) }",
  "",
  "# 5. claude, and its exit code.",
  "if ($Resume) { & $exe --resume $Resume }",
  "elseif ($Start) { & $exe --session-id $Start --name $Name }",
  "else { & $exe }",
  "exit $LASTEXITCODE",
  "",
].join('\n')

/**
 * The first line of every generated script: $env:PSModulePath set to Windows PowerShell 5.1's own
 * module folders (the user's, Program Files', System32's). In a Windows Terminal tab whose environment
 * puts PowerShell 7's folders first, 5.1 loads 7's modules and loses cmdlets (Get-FileHash, live-checks
 * bug 2). Double quotes only, and no variable in them: the line goes inside a single-quoted string too.
 */
export const PSMODULEPATH_RESET =
  '$env:PSModulePath = @([Environment]::GetFolderPath("MyDocuments") + "\\WindowsPowerShell\\Modules", [Environment]::GetFolderPath("ProgramFiles") + "\\WindowsPowerShell\\Modules", [Environment]::GetFolderPath("System") + "\\WindowsPowerShell\\v1.0\\Modules") -join ";"'
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
 * no colour. claude-launch.ps1 clears these (LAUNCH_ENV_CLEAR), and no other; the slot runner and the
 * claude wrapper keep the same list until they call it. Never one a person sets otherwise; never
 * CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP (LAUNCH_ENV_SET keeps it on: Mo's choice); never
 * WT_SESSION or WT_PROFILE_ID (Claude Code's terminal detection reads WT_SESSION on Windows to draw its
 * Unicode prompt and its links: cleared, a resumed session showed `>` and no links).
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
 * The launch environment (\u00a75.9, D55), applied by claude-launch.ps1 alone, right before claude: these
 * cleared. SESSION_MARKERS, NO_COLOR among them (Claude Code sets it in its tool shells, so a tab
 * launched from one draws no colour). Never WT_SESSION or WT_PROFILE_ID, never the REAP setting.
 */
export const LAUNCH_ENV_CLEAR: readonly string[] = [...SESSION_MARKERS]

/**
 * The launch environment, set by claude-launch.ps1 right before claude: transcripts on whatever marker
 * a later Claude Code adds that LAUNCH_ENV_CLEAR doesn't clear yet; and the background-shell
 * memory-pressure reap kept off (Mo's choice, 2026-11-04: the page file carries the load).
 */
export const LAUNCH_ENV_SET: Readonly<Record<string, string>> = {
  CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1',
  CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP: '1',
}

/** How long after a classic SessionStart for another conversation the arriving side writes the left record. */
export const LEFT_SETTLE_MS = 3000

/** An exiting process may append its last rows this long after its left record's `at`, and no longer. */
export const LEFT_EXIT_FLUSH_MS = 10_000

/** A left record older than this waives nothing. */
export const LEFT_MAX_AGE_MS = 600_000

/** A left record whose `at` is further ahead than this waives nothing. */
export const LEFT_AHEAD_MS = 5000

/** A heartbeat this long after a left record's `at` says the conversation ran again: no waiver. */
export const LEFT_BEAT_GRACE_MS = 10_000

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
 * A process that has exited by the time it would count, for L1 or L2, is passed over (Test-Exited):
 * it holds nothing, and the claude.exe a slot, a window or the claude wrapper just waited out names
 * the conversation on its command line. Asked only of the few that would count, never of the whole
 * table. Gone (GetProcessById: not running) is exited; a process that can't be asked (access denied),
 * or a pid another process has taken since, counts as before. On Windows 11 an exited process isn't
 * listed by Win32_Process even while a handle to it is open (seen in PowerShell 5.1 and 7), so this
 * is for a process that exits between the table's read and the look, or a Windows that lists one.
 */
export const RECHECK = [
  '$live = $null',
  'function Test-Exited($p) { $h = $null; try { $h = [Diagnostics.Process]::GetProcessById([int]$p.ProcessId); return $h.HasExited } catch { return ($_.Exception -is [ArgumentException] -or $_.Exception.InnerException -is [ArgumentException]) } finally { if ($null -ne $h) { $h.Dispose() } } }',
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
  '    if (Test-Exited $p) { continue }',
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
  String.raw`if ($null -eq $live) { foreach ($p in $procs.Values) { if ($null -eq $live -and $p.ProcessId -ne $PID -and -not $elsewhere.ContainsKey([int]$p.ProcessId) -and "$($p.CommandLine)" -match "(^|[\s\x22])(--resume|--session-id|-r)(\s+|=)[\x22\x27]?$id" -and -not (Test-Exited $p)) { $live = "it is open elsewhere: process $($p.ProcessId) names it on its command line (L2)" } } }`,
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
  /** Read the left record of each asked-about conversation (needs `stateDir`), its MAC checked inside the script. */
  readonly left?: boolean
}

/**
 * The left record's fields, each a string checked against its pattern, and the text its MAC is over:
 * a fixed first line, then the fields in a fixed order, one a line. Neither a field nor the key can
 * hold a line break, so no two records share a text. Used by the writer (leftScript) and the reader
 * (the probe) alike.
 */
const LEFT_FIELDS = [
  'function Get-LeftText($f) { return "ac3k-left/1`n" + (@($f.id, $f.how, $f.pid, $f.created, $f.at, $f.dir, $f.project, $f.size, $f.mtime, $f.by, $f.go) -join "`n") }',
  'function Get-LeftMac($key, $text) { $h = [Security.Cryptography.HMACSHA256]::new($key); try { return [BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))).Replace("-", "").ToLowerInvariant() } finally { $h.Dispose() } }',
]

/**
 * Reads a left record's fields from its parsed JSON: each a string of its pattern, or $null for the
 * whole record. Never a value that isn't checked leaves this function.
 */
const GET_LEFT_FIELDS = [
  'function Get-LeftFields($r) {',
  '  if ($r -isnot [Management.Automation.PSCustomObject] -or $r.v -isnot [ValueType] -or $r.v -ne 1) { return $null }',
  '  $t = $r.transcript',
  '  if ($t -isnot [Management.Automation.PSCustomObject]) { return $null }',
  '  $go = ""',
  '  if ($null -ne $r.go) { $go = $r.go }',
  '  $f = [ordered]@{ id = $r.id; how = $r.how; pid = $r.pid; created = $r.created; at = $r.at; dir = $t.dir; project = $t.project; size = $t.size; mtime = $t.mtime; by = $r.by; go = $go }',
  String.raw`  $rules = [ordered]@{ id = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z"; how = "^(in-place|exit)\z"; pid = "^\d{1,10}\z"; created = "^\d{1,20}\z"; at = "^\d{1,15}\z"; dir = "^[A-Za-z]:\\[^\x00-\x1f\x22\x27]{0,237}\z"; project = "^[A-Za-z0-9-]{1,200}\z"; size = "^\d{1,15}\z"; mtime = "^\d{1,15}\z"; by = "^(coordinator|self-switch)\z"; go = "^(wu_[a-z0-9]{1,40})?\z" }`,
  '  foreach ($k in $rules.Keys) { if ($f[$k] -isnot [string] -or $f[$k] -cnotmatch $rules[$k]) { return $null } }',
  '  return $f',
  '}',
]

function checkFolder(what: string, path: unknown): string {
  const fault = folderFault(path)
  if (fault !== undefined || !isSafeFolder(path)) throw new Error(`${what} ${JSON.stringify(path)} ${fault ?? 'is not a folder a script takes'}, so it is not an absolute folder a script takes (no quote, control character, < > | ? * or /, no '.' or '..' part)`)
  return path
}

function checkId(id: unknown): string {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new Error(`not a session id: ${JSON.stringify(id)}`)
  return id
}

/**
 * The lines that read the left record of each of `ids` (checked ids) under `state`: `$leftOut`, a list
 * of `{ asked, ok, ... macOk }`, the MAC compared inside the script with left.key, which never leaves
 * it. Needs `$configDirs` and `$errors`; adds `left:` to `$errors` when the records can't be read.
 */
function leftReadLines(state: string, ids: readonly string[]): string[] {
  return [
    `$leftKeyPath = ${literal(leftKeyPath(state))}`,
    // A list of pairs, each added whole: @(@(a, b)) would unroll one pair into its two strings.
    '$leftPaths = New-Object System.Collections.ArrayList',
    ...ids.map(id => `[void]$leftPaths.Add(@(${literal(id)}, ${literal(leftPath(state, id))}))`),
    ...LEFT_FIELDS,
    ...GET_LEFT_FIELDS,
    '$leftOut = New-Object System.Collections.ArrayList',
    'try {',
    '  $leftKey = $null',
    '  if (Test-Path -LiteralPath $leftKeyPath -PathType Leaf) { $leftKey = [IO.File]::ReadAllBytes($leftKeyPath); if ($leftKey.Length -ne 32) { $leftKey = $null } }',
    '  foreach ($pair in $leftPaths) {',
    '    $asked = $pair[0]',
    '    $lp = $pair[1]',
    '    if (-not (Test-Path -LiteralPath $lp -PathType Leaf)) { continue }',
    '    $o = [ordered]@{ asked = $asked; ok = $false }',
    '    $r = $null',
    '    try { if ((Get-Item -LiteralPath $lp -Force).Length -le 8192) { $r = [IO.File]::ReadAllText($lp, [Text.Encoding]::UTF8) | ConvertFrom-Json } } catch { $r = $null }',
    '    $f = Get-LeftFields $r',
    String.raw`    if ($null -ne $f -and $r.mac -is [string] -and $r.mac -cmatch "^[0-9a-f]{64}\z") {`,
    // The MAC is compared here, with the key read here: only whether it matched leaves the script.
    '      $macOk = $false',
    '      if ($null -ne $leftKey) { $macOk = (Get-LeftMac $leftKey (Get-LeftText $f)) -ceq $r.mac }',
    // The record's config folder, as an index into this probe's own; -1 when it reads none of them.
    '      $dirIndex = -1',
    '      for ($k = 0; $k -lt $configDirs.Count; $k++) { if ($configDirs[$k].TrimEnd([char]92).ToLowerInvariant() -eq $f.dir.TrimEnd([char]92).ToLowerInvariant()) { $dirIndex = $k } }',
    '      $o = [ordered]@{ asked = $asked; ok = $true; id = $f.id; how = $f.how; pid = [long]$f.pid; created = $f.created; at = [long]$f.at; transcript = [ordered]@{ dir = $dirIndex; project = $f.project; size = [long]$f.size; mtime = [long]$f.mtime }; by = $f.by; macOk = $macOk }',
    '      if ($f.go -ne "") { $o["go"] = $f.go }',
    '    }',
    '    [void]$leftOut.Add($o)',
    '  }',
    '} catch { [void]$errors.Add("left:") }',
    '$leftKey = $null',
  ]
}

/**
 * The left records of `ids` alone, as the probe reads them: `{ left: [...], errors: [...] }` on one
 * line, each record's MAC checked inside the script (only whether it matched leaves it). For a reader
 * that needs no process table. Throws on any input that isn't what it must be.
 */
export function leftReadScript(input: { readonly stateDir: string; readonly ids: readonly string[]; readonly configDirs: readonly string[] }): string {
  const state = checkFolder('the state folder', input.stateDir)
  const ids = input.ids.map(checkId)
  if (ids.length < 1 || ids.length > 8) throw new Error('the left records are read for 1 to 8 conversations')
  if (input.configDirs.length > 8) throw new Error('the left records are read with at most 8 config folders')
  const configDirs = input.configDirs.map(dir => checkFolder('a config folder', dir))
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    PSMODULEPATH_RESET,
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `$configDirs = @(${configDirs.map(literal).join(', ')})`,
    '$errors = New-Object System.Collections.ArrayList',
    ...leftReadLines(state, ids),
    '[ordered]@{ left = $leftOut; errors = $errors } | ConvertTo-Json -Compress -Depth 5',
  ].join('\r\n')
}

/** leftReadScript's answer, every record checked as the probe's are; `{ error }` naming the first that isn't. */
export function parseLeftRead(stdout: string): { readonly left: readonly LeftEntry[]; readonly unreadable: boolean } | { readonly error: string } {
  const line = stdout
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.startsWith('{'))
    .at(-1)
  if (line === undefined) return { error: 'the left records script printed no answer' }
  try {
    const top = fields(JSON.parse(line), 'the answer', ['left', 'errors'])
    const errors = list(top.errors, 'the errors')
    if (errors.some(e => e !== 'left:')) bad('an error is not one of the fixed list')
    return { left: list(top.left, 'the left records').map(leftEntry), unreadable: errors.length > 0 }
  } catch (err) {
    if (err instanceof Bad) return { error: `the left records' answer is not what it must be: ${err.message}` }
    if (err instanceof SyntaxError) return { error: "the left records' answer is not JSON" }
    throw err
  }
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
  if (input.left === true && state === undefined) throw new Error('the probe reads left records only with the state folder')
  // Each asked-about conversation's left record, its path built here from the checked id.
  const leftRead = input.left === true && state !== undefined ? leftReadLines(state, ids) : []
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    PSMODULEPATH_RESET,
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
    '          $item = Get-Item -LiteralPath $t -Force',
    '          $mtime = ([DateTimeOffset]$item.LastWriteTimeUtc).ToUnixTimeMilliseconds()',
    '          [void]$transcripts.Add([ordered]@{ id = $id; dir = $k; project = $d.Name; mtime = $mtime; size = [long]$item.Length })',
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
    ...leftRead,
    '$result = [ordered]@{ v = 1; self = [long]$PID; session = $sessionOut; slot = $slot; procs = $procs; registry = $registry; transcripts = $transcripts; locks = $locks; claim = $claim; heavy = $heavy; freeKb = $freeKb; errors = $errors }',
    'if ($slotSeen) { $result["slotSeen"] = $true }',
    ...(leftRead.length > 0 ? ['$result["left"] = $leftOut'] : []),
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

/** A transcript's place and its last write; `size` in bytes, from a probe that reads it (every probe since the left record). */
export type Transcript = { readonly id: string; readonly dir: number; readonly project: string; readonly mtime: number; readonly size?: number }

/**
 * A left record as the probe read it for an asked-about conversation (`asked`): `ok: false` when it
 * isn't of its shape; otherwise its fields, `macOk` whether its MAC matched under left.key (read only
 * inside the script), and its transcript's config folder as an index into the probe's own (-1: none).
 */
export type LeftEntry =
  | { readonly asked: string; readonly ok: false }
  | {
      readonly asked: string
      readonly ok: true
      readonly id: string
      readonly how: 'in-place' | 'exit'
      readonly pid: number
      readonly created: string
      readonly at: number
      readonly transcript: { readonly dir: number; readonly project: string; readonly size: number; readonly mtime: number }
      readonly by: 'coordinator' | 'self-switch'
      readonly go?: string
      readonly macOk: boolean
    }

export type LockEntry =
  | { readonly id: string; readonly mtime: number; readonly ok: true; readonly by: string; readonly pid: number; readonly created: string; readonly at: number; readonly transport: string }
  | { readonly id: string; readonly mtime: number; readonly ok: false }

export type ClaimResult = { readonly id: string; readonly taken: true; readonly by: string } | { readonly id: string; readonly taken: false; readonly why: string }

/** The slot runner: its pid, its creation FILETIME and its id (`<pid>-<created>`) as exact strings, its script and that script's hash. */
export type SlotParent = { readonly pid: number; readonly created: string; readonly id: string; readonly path: string; readonly sha256: string | null; readonly hashError?: string }

export type HeavySlot = { readonly slot: '.gate-lock' | '.gate-lock-2'; readonly winpid: number | null }

/** What the probe couldn't read: a source, and for registry and transcripts the config folder's index. */
export type ProbeError = 'registry' | 'transcripts' | 'locks' | 'heavy' | 'memory' | 'left'

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
  /** The asked-about conversations' left records, when the probe was asked to read them; null when it wasn't. */
  readonly left: readonly LeftEntry[] | null
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

/** A go's id, as a left record may name the coordinator's go it was written for. */
const GO_ID = /^wu_[a-z0-9]{1,40}$/

/** One left record as the probe printed it, every field checked. */
function leftEntry(value: unknown): LeftEntry {
  const l = fields(value, 'a left record', ['asked', 'ok'], ['id', 'how', 'pid', 'created', 'at', 'transcript', 'by', 'go', 'macOk'])
  if (typeof l.asked !== 'string' || !SESSION_ID.test(l.asked) || typeof l.ok !== 'boolean') bad('a left record names no asked-about id or shape flag')
  const asked = l.asked as string
  if (l.ok === false) {
    if (Object.keys(l).length !== 2) bad('a left record of no shape carries fields')
    return { asked, ok: false }
  }
  const f = fields(value, 'a left record', ['asked', 'ok', 'id', 'how', 'pid', 'created', 'at', 'transcript', 'by', 'macOk'], ['go'])
  if (typeof f.id !== 'string' || !SESSION_ID.test(f.id)) bad("a left record's id is not a session id")
  if (f.how !== 'in-place' && f.how !== 'exit') bad("a left record's how is neither in-place nor exit")
  if (!isPid(f.pid) || !isTicks(f.created) || !isCount(f.at)) bad("a left record's process or time is not plain")
  if (f.by !== 'coordinator' && f.by !== 'self-switch') bad("a left record's writer is neither the coordinator nor self-switch")
  if ('go' in f && (typeof f.go !== 'string' || !GO_ID.test(f.go))) bad("a left record's go is not a go's id")
  if (typeof f.macOk !== 'boolean') bad("a left record's MAC check is not a yes or no")
  const t = fields(f.transcript, "a left record's transcript", ['dir', 'project', 'size', 'mtime'])
  if (typeof t.dir !== 'number' || !Number.isInteger(t.dir) || t.dir < -1 || t.dir > 7) bad("a left record's config folder is not an index")
  if (typeof t.project !== 'string' || !PROJECT.test(t.project) || !isCount(t.size) || !isCount(t.mtime)) bad("a left record's transcript is not plain")
  return {
    asked,
    ok: true,
    id: f.id as string,
    how: f.how as 'in-place' | 'exit',
    pid: f.pid as number,
    created: f.created as string,
    at: f.at as number,
    transcript: { dir: t.dir as number, project: t.project as string, size: t.size as number, mtime: t.mtime as number },
    by: f.by as 'coordinator' | 'self-switch',
    ...(typeof f.go === 'string' ? { go: f.go } : {}),
    macOk: f.macOk as boolean,
  }
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
    const top = fields(raw, 'the answer', ['v', 'self', 'session', 'slot', 'procs', 'registry', 'transcripts', 'locks', 'claim', 'heavy', 'freeKb', 'errors'], ['slotSeen', 'left'])
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
      const t = fields(value, 'a transcript', ['id', 'dir', 'project', 'mtime'], ['size'])
      if (typeof t.id !== 'string' || !SESSION_ID.test(t.id) || !isCount(t.dir, 7)) bad('a transcript has no id or folder')
      if (typeof t.project !== 'string' || !PROJECT.test(t.project) || !isCount(t.mtime)) bad("a transcript's project or time is not plain")
      if ('size' in t && !isCount(t.size)) bad("a transcript's size is not a number of bytes")
      return { id: t.id as string, dir: t.dir as number, project: t.project as string, mtime: t.mtime as number, ...('size' in t ? { size: t.size as number } : {}) }
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
      const m = typeof value === 'string' ? /^(registry|transcripts|locks|heavy|memory|left):(\d?)$/.exec(value) : null
      if (m === null) return bad('an error is not one of the fixed list')
      return m[2] === '' ? { source: m[1] as ProbeError } : { source: m[1] as ProbeError, dir: Number(m[2]) }
    })
    const extraKeys = [...new Set(registry.flatMap(entry => (entry.shape === 'ok' ? entry.extra : [])))]
    const left = 'left' in top ? list(top.left, 'the left records').map(leftEntry) : null
    return { self: top.self as number, session, slot, slotSeen: top.slotSeen === true, procs, registry, transcripts, locks, claim, heavy, freeKb: top.freeKb as number | null, errors, extraKeys, left }
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

/**
 * The verdict and every line of evidence. `waived`: a left record waived L3 and L5; the last look must
 * then check the transcript against it (a transport whose last look can't, refuses).
 */
export type Liveness = { readonly verdict: 'live' | 'not-live' | 'unknown'; readonly evidence: readonly string[]; readonly waived?: LeftStat }

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

/** A process, by its id and its creation time (a FILETIME, as the probe prints it). */
export type ProcessRef = { readonly pid: number; readonly created: string }

/**
 * What liveness may take into account besides the probe:
 * - `lane`: the coordinator's word (L4); `heartbeat`: the conversation's last beat (L5); `mine`: the
 *   claim this caller took (L6 passes over it);
 * - `self`: this very process, by its pid and creation time, when `id` is its own conversation (a lane
 *   restart, self-restart): its own registry entry, command line, transcript writes and heartbeat are
 *   no evidence against it. Any other holder still is, and an unknown stays unknown;
 * - `left`: take the probe's left record for `id` into account (\u00a73.4): it waives L3 and L5, and only
 *   those, under all six of its conditions; otherwise it is ignored, saying why.
 */
export type LivenessOptions = {
  readonly lane?: LaneEvidence
  readonly heartbeat?: { readonly at: number }
  readonly mine?: string
  readonly self?: ProcessRef
  readonly left?: boolean
}

/** Why a left record waives nothing, or undefined when it waives L3 and L5 (\u00a73.4's six conditions). */
function leftRefusal(probe: Probe, id: string, now: number, record: LeftEntry, table: Map<number, ProcessEntry>, current: Map<number, string[]>, heartbeat: { readonly at: number } | undefined): string | undefined {
  // 1. Its MAC, its version (the probe's shape check) and its id.
  if (!record.ok) return 'it is not of its shape'
  if (!record.macOk) return "its MAC doesn't match under this machine's key"
  if (record.id !== id) return `it names another conversation (${record.id})`
  // 2. Its age.
  if (record.at > now + LEFT_AHEAD_MS) return 'it is dated in the future'
  if (now - record.at > LEFT_MAX_AGE_MS) return `it is ${ago(now - record.at)} old, more than ${LEFT_MAX_AGE_MS / 60_000} minutes`
  // 3. The transcript, untouched since: one, in the recorded folder and project.
  const transcripts = probe.transcripts.filter(t => t.id === id)
  if (transcripts.length !== 1) return `${transcripts.length} transcripts of it are on this machine, not one`
  const t = transcripts[0] as Transcript
  if (record.transcript.dir !== t.dir || !sameProject(record.transcript.project, t.project)) return 'its transcript is in another config folder or project than the record names'
  if (record.how === 'in-place') {
    if (t.size === undefined || t.size !== record.transcript.size || t.mtime !== record.transcript.mtime) return 'the transcript changed since it was written'
  } else if (t.mtime > record.at + LEFT_EXIT_FLUSH_MS) return `the transcript was written ${ago(t.mtime - record.at)} after it`
  // 4. The old process no longer holds it.
  const old = table.get(record.pid)
  const oldRuns = old !== undefined && near(old.created, record.created)
  if (record.how === 'exit' && oldRuns) return `the process that left it (${record.pid}) is still running`
  if (record.how === 'in-place' && oldRuns) {
    const holds = current.get(record.pid)
    if (holds === undefined || holds.length === 0 || holds.includes(id)) return `the process that left it (${record.pid}) has no current registry entry naming another conversation`
  }
  // 5. No heartbeat after the leave.
  if (heartbeat !== undefined && heartbeat.at > record.at + LEFT_BEAT_GRACE_MS) return 'its heartbeat came after it'
  return undefined
}

export function liveness(probe: Probe, id: string, now: number, opts: LivenessOptions = {}): Liveness {
  const live: string[] = []
  const unknown: string[] = []
  const table = byPid(probe)
  /** Whether `pid` is this very process (opts.self), by its id and its creation time. */
  const isSelf = (pid: number): boolean => {
    if (opts.self === undefined || pid !== opts.self.pid) return false
    const p = table.get(pid)
    return p !== undefined && near(p.created, opts.self.created)
  }
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
    // This very process's own entry is no evidence against its own conversation; any other's is.
    if (entry.sessionId === id && !isSelf(entry.pid)) live.push(`L1: claude.exe ${entry.pid} (started ${when(entry.procStart)} UTC) holds it`)
  }
  for (const p of probe.procs) {
    if (!p.ids?.includes(id)) continue
    if (isSelf(p.pid)) continue
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
  // L3 and L5, unless waived: by this very process (its own writes and beats), or by a left record.
  const waivers: string[] = []
  let waived = false
  if (opts.self !== undefined) waivers.push(`L3 and L5 are not read: ${id} is this process's own conversation (claude.exe ${opts.self.pid})`)
  else if (opts.left === true) {
    const records = (probe.left ?? []).filter(l => l.asked === id)
    const record = records[0]
    if (probe.errors.some(e => e.source === 'left')) waivers.push("left record ignored: the left records can't be read")
    else if (record !== undefined) {
      const why = records.length > 1 ? 'the probe read more than one' : leftRefusal(probe, id, now, record, table, holds, opts.heartbeat)
      if (why === undefined && record.ok) {
        waived = true
        waivers.push(`L3 and L5 waived: it was left cleanly (${record.how}) by claude.exe ${record.pid} ${ago(now - record.at)} ago, and its transcript is untouched since`)
      } else waivers.push(`left record ignored: ${why ?? 'it is not of its shape'}`)
    }
  }
  const readsL3L5 = opts.self === undefined && !waived
  if (readsL3L5) for (const t of transcripts) if (now - t.mtime < TRANSCRIPT_LIVE_MS) live.push(`L3: its transcript was written ${ago(now - t.mtime)} ago`)
  if (opts.lane === 'unreachable') unknown.push("unknown: the coordinator can't be reached")
  else if (opts.lane?.isLive === true) live.push(`L4: ${opts.lane.why ?? 'the coordinator has its lane live'}`)
  if (readsL3L5 && opts.heartbeat !== undefined && now - opts.heartbeat.at < HEARTBEAT_LIVE_MS) live.push(`L5: its heartbeat is ${ago(now - opts.heartbeat.at)} old`)
  for (const lock of probe.locks) {
    if (lock.id !== id || (lock.ok && opts.mine !== undefined && lock.by === opts.mine) || isStale(lock, table, now)) continue
    live.push(lock.ok ? `L6: a claim lock on it names ${lock.by} (taken ${ago(now - lock.at)} ago)` : "L6: a claim lock on it can't be read and is less than 15 minutes old")
  }
  const verdict = live.length > 0 ? 'live' : unknown.length > 0 ? 'unknown' : 'not-live'
  const record = waived ? (probe.left ?? []).find(l => l.asked === id) : undefined
  const stat = record !== undefined && record.ok ? leftStat(record) : undefined
  return { verdict, evidence: [...live, ...unknown, ...waivers], ...(stat === undefined ? {} : { waived: stat }) }
}

/**
 * What the last look checks a left record's conversation against (\u00a73.4): in place, its transcript's
 * size and time as the record stat-ed them, exactly; on exit, its time no later than the record's
 * `at` plus LEFT_EXIT_FLUSH_MS.
 */
export type LeftStat = { readonly size: number; readonly mtime: number } | { readonly exitAt: number }

/** The last look's check for a left record. */
export const leftStat = (record: Extract<LeftEntry, { ok: true }>): LeftStat =>
  record.how === 'in-place' ? { size: record.transcript.size, mtime: record.transcript.mtime } : { exitAt: record.at }

// ---------------------------------------------------------------------------------------------
// The safe point.

/**
 * One tree the safe point reads for S11: the session's start folder (`start`); a worktree of the same
 * repository the caller named, or the session's own folder when it is one (`named`); or the session's
 * own folder when it is in another repository (`cwd`). Its branch (null when detached, or no
 * repository), its head commit (null when there is none yet), how many files are uncommitted, and the
 * fingerprint of that dirty state (fingerprintOf; null when it can't be read whole).
 */
export type TreeState = {
  readonly path: string
  readonly role: 'start' | 'named' | 'cwd'
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
export type Baseline = { readonly folder: string; readonly fingerprint: string; readonly at: number; readonly usedAt?: number }

export type AgentLike = { readonly status: string; readonly description?: string; readonly type?: string; readonly id?: string }

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
 * - S11: uncommitted changes in a tree `git` read: in a named worktree, or the session's own folder,
 *   any (a worker's own tree must be clean); in the start folder, only once its fingerprint differs
 *   from `baseline`, taken when the conversation started (a shared checkout may carry changes that
 *   aren't this session's). With no baseline for that folder, its dirt holds, saying so.
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
  if (tree.role === 'cwd') return `S11: ${files} uncommitted in ${tree.path}, the folder this session works in, dirty, no baseline: commit or stash them, or the merger's anyway`
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

/**
 * The git reads that fingerprint a tree's dirty state: the coordinator's (S5), each with the
 * repository's fsmonitor off, and the diff with no textconv, so that no setting of the repository's
 * own can hide a change from it.
 */
export const FINGERPRINT_READS = {
  status: ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
  diff: ['-c', 'core.fsmonitor=false', 'diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--no-color', '--binary'],
  untracked: ['-c', 'core.fsmonitor=false', 'ls-files', '--others', '--exclude-standard', '-z'],
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
 * One tree's state for S11: its status (porcelain, -z), branch, head and fingerprint. A start folder
 * outside any repository reads clean, with no branch or head; a named tree there, which checkTrees
 * found listed, is a broken worktree, and can't be read (S11). `why` when it can't be read.
 */
async function treeState($: EngineInterface, path: string, role: TreeState['role']): Promise<TreeState | { readonly why: string; readonly check?: 'S11' }> {
  const status = await gitIn($, path, FINGERPRINT_READS.status)
  if (status.exitCode !== 0) {
    if (/not a git repository/i.test(status.stderr)) {
      if (role === 'start') return { path, role, branch: null, head: null, dirty: 0, fingerprint: null }
      const what = role === 'named' ? `${path} is listed as a worktree of the start folder's repository, but git finds no repository there (a broken worktree)` : `git finds no repository in ${path}, the folder this session works in, though it found one a moment before`
      return { why: `${what}, so what it holds can't be read`, check: 'S11' }
    }
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
 * - each tree's state for S11 (TreeState): the start folder's when `dirty`, every named tree's, and
 *   `cwd`'s, the session's own folder, always, when it is in another worktree than the start folder's
 *   (its top, by `git rev-parse --show-toplevel`): a worktree of the start folder's repository reads as
 *   named, one of another repository as `cwd`; outside any repository, nothing. A tree named that
 *   isn't a worktree of the start folder's repository makes the state unreadable for S11 (checkTrees);
 *   a named tree that is the start folder reads as named.
 * A folder outside any repo has nothing in flight and nothing dirty. Anything that can't be read
 * makes the state unreadable, which holds.
 */
export async function readGit(
  $: EngineInterface,
  opts: { readonly start: string; readonly trees?: readonly string[]; readonly cwd?: string; readonly folders?: readonly string[]; readonly dirty: boolean },
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
    // The session's own folder: when it is in another worktree than the start folder's, that tree too,
    // named or not. Not model input, so never refused: of another repository, it reads as `cwd`.
    // Outside any repository, nothing, unless it is a worktree the start folder's repository lists (a
    // broken one), which reads as named, and so holds.
    if (opts.cwd !== undefined && !sameFolder(opts.cwd, opts.start)) {
      const own = await git(opts.cwd, ['rev-parse', '--show-toplevel'])
      const outside = own.exitCode !== 0 && /not a git repository/i.test(own.stderr)
      if (own.exitCode !== 0 && !outside) return { isReadable: false, why: `git rev-parse in ${opts.cwd} exited ${own.exitCode}` }
      const top = outside ? opts.cwd : own.stdout.trim().replace(/\//g, '\\')
      const startTop = outside ? undefined : await git(opts.start, ['rev-parse', '--show-toplevel'])
      const isStart = startTop !== undefined && startTop.exitCode === 0 && sameFolder(startTop.stdout.trim(), top)
      if (!isStart && !reads.some(read => sameFolder(read.path, top))) {
        const listed = isSafeFolder(top) && !('refusal' in (await checkTrees($, opts.start, [top])))
        if (listed) reads.push({ path: top, role: 'named' })
        else if (!outside) reads.push({ path: top, role: 'cwd' })
      }
    }
    const trees: TreeState[] = []
    for (const read of reads) {
      const state = await treeState($, read.path, read.role)
      if ('why' in state) return { isReadable: false, why: state.why, ...(state.check === undefined ? {} : { check: state.check }) }
      trees.push(state)
    }
    return { isReadable: true, markers, trees }
  } catch (err) {
    return { isReadable: false, why: err instanceof Error && err.message.trim() !== '' ? err.message.trim() : 'git did not answer' }
  }
}

// ---------------------------------------------------------------------------------------------
// Transports.

/**
 * `fallback`, on a window: why this pane's slot runner wasn't used, when it runs in one. `pane`: the
 * claude wrapper's tab, by its token (a ticket, then /exit; the wrapper resumes it in the same tab).
 */
export type Transport =
  | { readonly transport: 'in-place' }
  | { readonly transport: 'slot'; readonly slot: string; readonly folder: string }
  | { readonly transport: 'pane'; readonly token: string; readonly folder: string }
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
 * - else in this tab, by a ticket for the claude wrapper (`pane`: the session's CLAUDE_PANE_TOKEN and
 *   the pane file it names), only when the wrapper's PowerShell is this claude.exe's own parent
 *   (paneFallback), and its last look reads the `configCount` config folders the switch reads (paneReads);
 * - else a new window, with `fallback` saying why when this claude.exe runs under a slot runner that
 *   isn't used (slotFallback).
 * The slot, the tab and the window resume `to` in `folder` (its own, from its heartbeat): an absolute
 * folder whose project name is `to`'s project folder, in this session's own config folder.
 */
export function pickTransport(
  probe: Probe,
  from: string,
  to: string,
  folder: string | undefined,
  pane?: { readonly token: string; readonly pane: Pane },
  configCount = 1,
): Transport | { refusal: string } {
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
  if (pane !== undefined && PANE_TOKEN.test(pane.token) && paneFallback(probe, pane.pane) === undefined && paneReads(pane.pane, configCount) === undefined) return { transport: 'pane', token: pane.token, folder }
  if (slot !== null) return { transport: 'window', folder, fallback: slotFallback(slot) }
  if (probe.slotSeen) return { transport: 'window', folder, fallback: SLOT_NOT_RECOGNISED }
  return { transport: 'window', folder }
}

// ---------------------------------------------------------------------------------------------
// The launcher: launch(), the one function every plugin calls to start a Claude Code process.
//
// launch(input) builds one script, run by powershellCall (the script on standard input), that in one
// run: finds the caller's own claude.exe (and, for a launch that waits for it, checks it is the
// process named); checks what the caller asked for (NOT LIVE right now, a new id); takes the claim lock
// on the conversation; and places the launch:
// - `pane`: a ticket for the claude wrapper's tab, which resumes the conversation in the same tab once
//   the caller's claude has exited (its own checks: the claim, RECHECK);
// - `slot`: a record for this pane's slot runner, which resumes it in the same pane once the caller's
//   claude has exited (its own checks: the claim, the project, RECHECK);
// - `window`: a new window (Start-Process, Windows PowerShell by its known path), whose script waits for
//   the caller's process when asked, then RECHECKs (and the left record's stat), checks the claim and
//   the folder, checks claude-launch.ps1's SHA-256, and runs it: claude-launch.ps1 is the only script
//   that starts claude, the only place that holds the launch environment;
// - `auto`: this pane's slot when its runner is verified and takes the folder, else the window, decided
//   in the script (self-restart's choice).
// It answers `launched <transport> <label> [<pid>]`, or `refused <code> <why>` (a lock it took given
// back first), and `claim <by>` once the lock is taken. Nothing is written after a failed check.
//
// Slots v2 (S2) adds the floor and input checks, an idle slot elsewhere, a tab in a named window and
// placement's window; asking for any of them now throws, never a launch that skips them.

/** A launch's answer: `launched <transport> <label> [<pid>]`. */
export const LAUNCH_ANSWER = /^launched (pane|slot|window|tab) ([A-Za-z0-9_.:-]{1,80})(?: (\d{1,10}))?\s*$/m

/** A launch's refusal: `refused <code> <why>`. */
export const LAUNCH_REFUSED = /^refused ([a-z]{1,20}) (.{1,1000}?)\s*$/m

/** The line naming the claim a launch took: `claim <by>`. */
export const CLAIMED = /^claim ((?:slot|launch):[0-9a-f-]{1,40})\s*$/m

/** The line a launch adds when it found this pane's slot runner but opened a window: why. */
export const FALLBACK = /^fallback (.{1,1000}?)\s*$/m

/**
 * Where a launch goes, in the order a caller tries them (the coordinating note, \u00a72):
 * - `{ pane: { token } }`: the caller's own tab, through the claude wrapper's ticket;
 * - `{ slot: id }`: the caller's own pane's slot runner, by its id (`<pid>-<created>`);
 * - `{ window: true }`: a new window, running claude-launch.ps1;
 * - `'auto'`: this pane's slot when its runner is verified and takes the folder, else the window.
 * The pane, the slot and 'auto' are for a launch that replaces its caller (`waitForExit`).
 */
export type LaunchWhere = { readonly pane: { readonly token: string } } | { readonly slot: string } | { readonly window: true } | 'auto'

/**
 * The checks the launch script makes in the same run as it places the launch:
 * - `live`: NOT LIVE now (RECHECK, and the left record's stat when given), for a launch that doesn't
 *   wait for its caller; one that waits takes its last look after the wait, in the window or the pane;
 * - `fresh`: a start's id is new on this machine: no transcript in any config folder, no registry file
 *   and no command line names it. Required for a start;
 * - `floor`, `input`: the memory floor and cap, and the machine's input idle: slots v2 (S2). Asking for
 *   them now throws.
 */
export type LaunchChecks = { readonly live?: boolean; readonly fresh?: boolean; readonly floor?: boolean; readonly input?: boolean }

/** A launch: what is started, where, under which claim, after which checks. */
export type LaunchInput = {
  /** Windows PowerShell by its known path: powershellPath(SystemRoot). */
  readonly powershell: string
  /** Resume a conversation (`--resume <id>`), or start a new one (`--session-id <id> --name <name>`). */
  readonly kind: 'resume' | 'start'
  readonly id: string
  /** A start's name: AREA_NAME. */
  readonly name?: string
  /** The conversation's own folder: an absolute folder without quotes, control characters or `;`. */
  readonly folder: string
  /** The claimant the claim lock names: `launch:<uuid>` (a window, a pane), or `slot:<id>` (that slot). */
  readonly claim: string
  /** The config folders the checks read: 1 to 8. */
  readonly configDirs: readonly string[]
  /** stateFolder(%LOCALAPPDATA%). */
  readonly stateDir: string
  readonly where: LaunchWhere
  readonly checks?: LaunchChecks
  /** A left record's stat: the last look refuses when the transcript changed since (\u00a73.4). The window's only. */
  readonly left?: LeftStat
  /** The caller's own claude.exe, which the pane, the slot or the window waits for before it resumes. */
  readonly waitForExit?: ProcessRef
  /** The pane's ticket's time: the caller's clock, now. */
  readonly now?: number
  /**
   * The last moment the launch may be placed (ms since the epoch): the caller's clock plus a margin
   * under its own timeout on the run. Past it, the script takes no claim and places nothing; and when
   * it finds itself past it, or its claim no longer its own, once it has placed the launch, it takes
   * the launch back (the ticket or the record written over as withdrawn, the claim given back), so a
   * run the caller gave up on never leaves a launch in place behind the caller's own withdrawal.
   */
  readonly deadline?: number
  /** Who launches, as a refusal names it: self-restart, self-switch, coordinator. */
  readonly tool?: string
}

/** A launch's answer, read from the launch script's output. */
export type LaunchAnswer =
  | { readonly launched: { readonly transport: 'pane' | 'slot' | 'window' | 'tab'; readonly label: string; readonly pid?: number }; readonly claim?: string; readonly fallback?: string }
  | { readonly refused: { readonly code: string; readonly why: string }; readonly claim?: string }
  | { readonly error: string; readonly claim?: string }

/** The launch script's answer: launched, refused, or neither (`error`); with the claim it took, if it printed one. */
export function parseLaunch(stdout: string): LaunchAnswer {
  const claim = CLAIMED.exec(stdout)?.[1]
  const withClaim = claim === undefined ? {} : { claim }
  const refused = LAUNCH_REFUSED.exec(stdout)
  if (refused !== null) return { refused: { code: refused[1] as string, why: oneLine(refused[2] as string, 1000) }, ...withClaim }
  const launched = LAUNCH_ANSWER.exec(stdout)
  if (launched === null) return { error: 'the launch script printed no answer', ...withClaim }
  const fallback = FALLBACK.exec(stdout)?.[1]
  return {
    launched: { transport: launched[1] as 'pane' | 'slot' | 'window' | 'tab', label: launched[2] as string, ...(launched[3] === undefined ? {} : { pid: Number(launched[3]) }) },
    ...withClaim,
    ...(fallback === undefined ? {} : { fallback: oneLine(fallback, 1000) }),
  }
}

/**
 * How a caller runs a launch: a timeout of LAUNCH_RUN_MS on its `$.process.run`, and a deadline
 * LAUNCH_DEADLINE_MS after its clock's now, 10 s under it: a script that hasn't placed the launch by
 * then places nothing, and one that finds itself past it once placed takes it back. So a run the
 * caller gave up on (and took back, by its own withdrawal) can't leave a launch in place after.
 */
export const LAUNCH_RUN_MS = 30_000
export const LAUNCH_DEADLINE_MS = 20_000

/** How long after a launch that failed its caller takes it back once more: a run killed at its timeout may have been writing still. */
export const LAUNCH_RETRY_MS = 3000

/** A session's name at a launch (`--name`), a lane's name in lanes.json: lowercase letters, digits and hyphens. */
export const AREA_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/

/** Windows PowerShell by its known path, as powershellPath(SystemRoot) gives it. */
const POWERSHELL_PATH = /^[A-Za-z]:\\[A-Za-z0-9_ -]{1,64}\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/

/** A caller's name in a refusal. */
const TOOL_NAME = /^[a-z][a-z0-9-]{0,30}$/

/** A file's SHA-256 by .NET, never Get-FileHash; $null when it isn't there or is over 64 KB. */
export const GET_SHA256 = [
  'function Get-Sha256($path) {',
  '  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }',
  '  if ([IO.FileInfo]::new($path).Length -gt 65536) { return $null }',
  '  $hasher = [Security.Cryptography.SHA256]::Create()',
  '  try { return [BitConverter]::ToString($hasher.ComputeHash([IO.File]::ReadAllBytes($path))).Replace("-", "").ToLowerInvariant() } finally { $hasher.Dispose() }',
  '}',
]

/**
 * Puts claude-launch.ps1 in place when it is missing or has another SHA-256 than `$sha`: the copy the
 * launch carries (`$b64`, LAUNCH_SCRIPT_TEXT's bytes) written whole under another name in the same
 * folder (CreateNew), checked, then moved over the file there ([IO.File]::Replace, or Move when there
 * is none), and read back. Returns $null when the file at `$path` has `$sha` (already, or now), else
 * why not; a write another launch made meanwhile with the same bytes counts. Needs Get-Sha256.
 */
export const INSTALL_LAUNCHER = [
  'function Install-Launcher($path, $b64, $sha) {',
  '  if ((Get-Sha256 $path) -ceq $sha) { return $null }',
  '  $tmp = $path + "." + [guid]::NewGuid().ToString("N") + ".tmp"',
  '  $why = $null',
  '  try {',
  '    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))',
  '    $bytes = [Convert]::FromBase64String($b64)',
  '    $stream = [IO.File]::Open($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)',
  '    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }',
  '    if ((Get-Sha256 $tmp) -cne $sha) { $why = "the copy this plugin carries does not have the SHA-256 it pins" }',
  '    elseif (Test-Path -LiteralPath $path -PathType Leaf) { [IO.File]::Replace($tmp, $path, [NullString]::Value) }',
  '    else { [IO.File]::Move($tmp, $path) }',
  '  } catch { $why = "it could not be written there (" + $_.Exception.Message + ")" }',
  '  finally { try { if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) } } catch { } }',
  '  if ((Get-Sha256 $path) -ceq $sha) { return $null }',
  '  if ($null -eq $why) { $why = "it was written, but reads back with another SHA-256" }',
  '  return $why',
  '}',
]

/**
 * The caller's claude.exe: the nearest above this script, then the top of its unbroken run of
 * claude.exe parents, so a helper process of the session's own is never taken for it. `$up` ends as
 * that claude.exe's own parent: the slot runner, when it runs in one. Needs `$table` and Get-Parent.
 */
const FIND_SESSION = [
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
]

/**
 * A left record's last look (\u00a73.4), after RECHECK found nothing: `$live` says why when conversation
 * `$id`'s transcript, found anew in `$configDirs`, isn't one file, or changed since the record: in
 * place, its size or time differs; on exit, it was written after `exitAt` + LEFT_EXIT_FLUSH_MS. The
 * numbers are checked here before they are spliced in.
 */
export function leftRecheck(left: LeftStat): string[] {
  const stat =
    'size' in left
      ? (() => {
          if (!isCount(left.size) || !isCount(left.mtime)) throw new Error("a left record's stat is not a size and a time")
          return `$leftSize = ${left.size}; $leftMtime = ${left.mtime}; $leftExitAt = $null`
        })()
      : (() => {
          if (!isCount(left.exitAt)) throw new Error("a left record's exit time is not a time")
          return `$leftSize = $null; $leftMtime = $null; $leftExitAt = ${left.exitAt}`
        })()
  return [stat, ...LEFT_RECHECK]
}

/**
 * The left record's last look itself, the same lines in the launch's window and in the claude wrapper
 * (which reads `$leftSize`, `$leftMtime` and `$leftExitAt` off its ticket, checked as whole numbers):
 * after RECHECK found nothing, `$live` says why when conversation `$id`'s transcript, found anew in
 * `$configDirs`, isn't one file, or changed since the record: in place (`$leftSize`), its size or time
 * differs; on exit (`$leftExitAt`), it was written after it + LEFT_EXIT_FLUSH_MS.
 */
export const LEFT_RECHECK = [
  'if ($null -eq $live) {',
  '  $seen = @(foreach ($dir in $configDirs) { $projects = Join-Path $dir "projects"; if (Test-Path -LiteralPath $projects -PathType Container) { foreach ($d in @(Get-ChildItem -LiteralPath $projects -Directory -Force)) { $tx = Join-Path $d.FullName ($id + ".jsonl"); if (Test-Path -LiteralPath $tx -PathType Leaf) { Get-Item -LiteralPath $tx -Force } } } })',
  '  if ($seen.Count -ne 1) { $live = "its transcript is not one file on this machine now (" + $seen.Count + " found), so whether it changed since it was left is unknown" }',
  `  elseif ($null -ne $leftExitAt) { if (([DateTimeOffset]$seen[0].LastWriteTimeUtc).ToUnixTimeMilliseconds() -gt ([long]$leftExitAt + ${LEFT_EXIT_FLUSH_MS})) { $live = "its transcript was written after it was left (another process may have resumed it)" } }`,
  '  elseif ([long]$seen[0].Length -ne [long]$leftSize -or ([DateTimeOffset]$seen[0].LastWriteTimeUtc).ToUnixTimeMilliseconds() -ne [long]$leftMtime) { $live = "its transcript changed since it was left (another process may have resumed it)" }',
  '}',
]

/**
 * A start's id is new on this machine: no transcript of it in any config folder's projects, no
 * registry file names it anywhere in its text, and no process but this script names it on its command
 * line. `$fresh` says why it isn't; a registry file that can't be read refuses too. Needs `$table`
 * (with command lines), `$configDirs` and `$id`.
 */
const FRESH_CHECK = [
  '$fresh = $null',
  'foreach ($dir in $configDirs) {',
  '  $projects = Join-Path $dir "projects"',
  '  if ($null -eq $fresh -and (Test-Path -LiteralPath $projects -PathType Container)) { foreach ($d in @(Get-ChildItem -LiteralPath $projects -Directory -Force)) { if (Test-Path -LiteralPath (Join-Path $d.FullName ($id + ".jsonl")) -PathType Leaf) { $fresh = "a transcript of it is already in the projects of " + $dir } } }',
  '  $reg = Join-Path $dir "sessions"',
  '  if ($null -eq $fresh -and (Test-Path -LiteralPath $reg -PathType Container)) { foreach ($f in @(Get-ChildItem -LiteralPath $reg -Filter "*.json" -File -Force)) { $text = $null; try { $text = [IO.File]::ReadAllText($f.FullName) } catch { $fresh = "the registry file " + $f.Name + " can not be read" }; if ($null -ne $text -and $text.IndexOf($id, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $fresh = "the registry file " + $f.Name + " names it" } } }',
  '}',
  'if ($null -eq $fresh) { foreach ($p in $table.Values) { if ($p.ProcessId -ne $PID -and "$($p.CommandLine)".IndexOf($id, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $fresh = "process " + $p.ProcessId + " names it on its command line" } } }',
]

/**
 * Gives back the claim lock this run took: read through a handle that keeps every writer out, and
 * deleted while it is held, only when it still names `$by`. Needs `$claimPath` and `$by`.
 */
const RELEASE_CLAIM = [
  'function Release-Claim {',
  "  try { $stream = [IO.File]::Open($claimPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'Read, Delete') } catch { return }",
  '  try {',
  '    $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8, $true, 4096, $true)',
  '    $text = $reader.ReadToEnd()',
  '    $reader.Dispose()',
  '    $lock = $null',
  '    try { $lock = $text | ConvertFrom-Json } catch { $lock = $null }',
  '    if ($null -ne $lock -and $lock.by -ceq $by) { try { [IO.File]::Delete($claimPath) } catch { } }',
  '  } finally { $stream.Dispose() }',
  '}',
]

/** Writes `$text` to `$final` whole: a temporary file beside it, then a move or a replace. */
const WRITE_WHOLE = [
  '$temp = $final + "." + [guid]::NewGuid().ToString() + ".tmp"',
  '[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($final))',
  '[IO.File]::WriteAllText($temp, $text)',
  // No backup file: [NullString]::Value, since PowerShell passes $null to a .NET string as "", which Replace refuses.
  'try { if ([IO.File]::Exists($final)) { [IO.File]::Replace($temp, $final, [NullString]::Value) } else { [IO.File]::Move($temp, $final) } }',
  'catch { [IO.File]::Delete($temp); throw }',
]

/** A launch's input, checked; throws on anything that isn't what it must be, so nothing else is spliced in. */
function checkLaunch(input: LaunchInput) {
  if (!POWERSHELL_PATH.test(input.powershell)) throw new Error(`not Windows PowerShell by its known path: ${JSON.stringify(input.powershell)}`)
  const id = checkId(input.id)
  const folderWhy = launchFolderFault(input.folder)
  if (folderWhy !== undefined) throw new Error(launchFolderSaid(input.folder, folderWhy))
  const folder = checkFolder('the folder', input.folder)
  const state = checkFolder('the state folder', input.stateDir)
  if (input.configDirs.length < 1 || input.configDirs.length > 8) throw new Error('a launch reads 1 to 8 config folders')
  const configDirs = input.configDirs.map(dir => checkFolder('a config folder', dir))
  if (!CLAIM_BY.test(input.claim)) throw new Error(`not a claimant: ${JSON.stringify(input.claim)}`)
  const tool = input.tool ?? 'claude-self-tools'
  if (!TOOL_NAME.test(tool)) throw new Error(`not a tool's name: ${JSON.stringify(tool)}`)
  const checks = input.checks ?? {}
  if (checks.floor === true || checks.input === true) throw new Error('the floor and input checks come with slots v2: not in this version')
  const where = input.where
  const waitFor = input.waitForExit
  if (waitFor !== undefined && (!isPid(waitFor.pid) || !isTicks(waitFor.created))) throw new Error('the process to wait for is not a pid and a time as a string')
  if (checks.live === true && waitFor !== undefined) throw new Error('a launch that waits for its caller takes its last look after the wait, not now')
  if (input.kind === 'start') {
    if (typeof input.name !== 'string' || !AREA_NAME.test(input.name)) throw new Error(`a start's name is not a session name: ${JSON.stringify(input.name)}`)
    if (checks.fresh !== true) throw new Error('a start checks that its id is new (checks.fresh)')
    if (where === 'auto' || !('window' in where)) throw new Error('a start goes to a window in this version')
    if (input.left !== undefined) throw new Error('a left record is a resumed conversation\'s')
  } else if (input.kind === 'resume') {
    if (input.name !== undefined) throw new Error('a resume takes no name')
    if (checks.fresh === true) throw new Error('a resume is not of a new id')
  } else throw new Error(`not a launch's kind: ${JSON.stringify(input.kind)}`)
  let label: string | undefined
  let ticket: string | undefined
  if (where === 'auto') {
    if (waitFor === undefined) throw new Error("'auto' is for a launch that replaces its caller (waitForExit)")
    if (input.left !== undefined) throw new Error("this pane's slot runner doesn't check a left record until slots v2: 'auto' takes none")
    if (!input.claim.startsWith('launch:')) throw new Error("'auto' names a launch's claim; the slot's is its own")
  } else if ('pane' in where) {
    if (waitFor === undefined) throw new Error('the pane is for a launch that replaces its caller (waitForExit)')
    if (!input.claim.startsWith('launch:')) throw new Error("the pane's ticket names a launch's claim")
    if (typeof input.now !== 'number') throw new Error("the pane's ticket needs the time")
    // The ticket names every config folder this launch reads, and the left record's stat when there is
    // one: the wrapper's last look (pane file version 3) reads them all, and checks the transcript.
    ticket = paneTicket({ token: where.pane.token, resume: id, by: input.claim, dir: folder, at: input.now, configDirs, ...(input.left === undefined ? {} : { left: input.left }) })
    label = where.pane.token
  } else if ('slot' in where) {
    if (waitFor === undefined) throw new Error("this pane's slot is for a launch that replaces its caller (waitForExit)")
    if (input.left !== undefined) throw new Error("this pane's slot runner doesn't check a left record until slots v2")
    idPath(state, 'slotRecord', where.slot)
    label = where.slot
    if (input.claim !== `slot:${where.slot}`) throw new Error("a slot's launch names that slot's claim")
  } else if ('window' in where) {
    if (where.window !== true) throw new Error('a window by placement comes with slots v2: not in this version')
    if (!input.claim.startsWith('launch:')) throw new Error("a window names a launch's claim")
  } else throw new Error('not a place to launch to')
  if (input.left !== undefined) leftRecheck(input.left)
  if (input.deadline !== undefined && !isCount(input.deadline)) throw new Error('the deadline is not a time')
  return { id, folder, state, configDirs, tool, checks, where, waitFor, label, ticket, deadline: input.deadline }
}

/**
 * The new window's script, run by Windows PowerShell after the launch script has placed it: it waits
 * for the caller's process when asked; then, right before claude, reads the registry and the process
 * table again (RECHECK) and the left record's stat, and for a start that no transcript appeared;
 * checks that the claim lock still names this launch and that the folder is there; checks
 * claude-launch.ps1's SHA-256; and runs it. Values only as single-quoted literals or checked numbers.
 */
function windowScript(v: { id: string; kind: 'resume' | 'start'; name?: string; folder: string; state: string; configDirs: readonly string[]; by: string; waitFor?: ProcessRef; left?: LeftStat }): string {
  const resume = v.kind === 'resume'
  const byHand = resume ? '"claude-launch.ps1 -Resume " + $id + " -Dir " + $folder' : '"claude-launch.ps1 -Start " + $id + " -Name " + $name + " -Dir " + $folder'
  const runs = resume ? '& $launchPath -Resume $id -Dir $folder' : '& $launchPath -Start $id -Name $name -Dir $folder'
  return [
    '$ErrorActionPreference = "Stop"',
    '$ProgressPreference = "SilentlyContinue"',
    PSMODULEPATH_RESET,
    `$id = '${v.id}'`,
    ...(resume ? [] : [`$name = '${v.name}'`]),
    `$by = '${v.by}'`,
    `$folder = ${literal(v.folder)}`,
    `$configDirs = @(${v.configDirs.map(literal).join(', ')})`,
    `$claimPath = ${literal(claimPath(v.state, v.id))}`,
    `$launchPath = ${literal(launchScriptPath(v.state))}`,
    ...GET_SHA256,
    ...(v.waitFor === undefined
      ? []
      : [
          `Write-Host ("Waiting for the old Claude Code process (${v.waitFor.pid}) to exit, then ${resume ? 'resuming' : 'starting'} session " + $id + " here.")`,
          `Wait-Process -Id ${v.waitFor.pid} -Timeout ${WAIT_SECONDS} -ErrorAction SilentlyContinue`,
        ]),
    '$refusal = $null',
    ...(v.waitFor === undefined
      ? []
      : [`if (Get-Process -Id ${v.waitFor.pid} -ErrorAction SilentlyContinue) { $refusal = "The old process is still running, so the session is not resumed here: two copies would both write to it." }`]),
    // Right before claude: whether anything holds the conversation now (L1, L2), and the left record's stat.
    'if ($null -eq $refusal) {',
    '  $live = $null',
    '  try {',
    ...RECHECK.map(line => `    ${line}`),
    ...(v.left === undefined ? [] : leftRecheck(v.left).map(line => `    ${line}`)),
    ...(resume
      ? []
      : [
          '    if ($null -eq $live) { foreach ($dir in $configDirs) { $projects = Join-Path $dir "projects"; if (Test-Path -LiteralPath $projects -PathType Container) { foreach ($d in @(Get-ChildItem -LiteralPath $projects -Directory -Force)) { if (Test-Path -LiteralPath (Join-Path $d.FullName ($id + ".jsonl")) -PathType Leaf) { $live = "a transcript of it appeared since the launch" } } } } }',
        ]),
    '  } catch { $live = "whether it is open elsewhere is unknown: the registry or the process table could not be read (" + $_.Exception.Message + ")" }',
    '  if ($null -ne $live) { $refusal = "The session is not resumed here, so that two copies never write it: " + $live + "." }',
    '}',
    // The claim must still name this launch: another switch, restart or launch that took it over wins.
    'if ($null -eq $refusal) {',
    '  $lock = $null',
    '  try { $lock = Get-Content -LiteralPath $claimPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $lock = $null }',
    '  if ($null -eq $lock -or $lock.by -cne $by) { $refusal = "The session is not resumed here: the claim on it no longer names this window." }',
    '}',
    'if ($null -eq $refusal -and -not (Test-Path -LiteralPath $folder -PathType Container)) { $refusal = "The session is not resumed here: its folder " + $folder + " is not there." }',
    // claude-launch.ps1 from its pinned place only, its hash checked just before it runs.
    `if ($null -eq $refusal -and (Get-Sha256 $launchPath) -cne '${LAUNCH_SCRIPT_SHA256}') { $refusal = "The session is not resumed here: claude-launch.ps1 is not at " + $launchPath + " with the SHA-256 this plugin ships (it was changed after the launch put it there)." }`,
    'if ($null -ne $refusal) {',
    '  Write-Host $refusal',
    `  Write-Host ("Once it is safe, resume it yourself: " + ${byHand})`,
    '  Read-Host "Press Enter to close this window" | Out-Null',
    '  exit 1',
    '}',
    '$started = Get-Date',
    runs,
    '$code = $LASTEXITCODE',
    // An error, or an end within seconds: the resume didn't take. Say how to resume by hand, and wait.
    `if ($code -ne 0 -or ((Get-Date) - $started).TotalSeconds -lt ${SHORT_RUN_SECONDS}) {`,
    '  Write-Host "Claude Code ended (exit code $code)."',
    `  Write-Host ("If the session did not ${resume ? 'resume' : 'start'} here, do it yourself: " + ${byHand})`,
    '  Read-Host "Press Enter to close this window" | Out-Null',
    '}',
    'exit $code',
  ].join('\r\n')
}

/**
 * The launch: `{ argv, stdin }` for `$.process.run` (powershellCall: Windows PowerShell by its known
 * path, the fixed bootstrap, the script on standard input). Throws on any input that isn't what it
 * must be (checkLaunch), so nothing else is spliced into the script. Read the answer with parseLaunch.
 */
export function launch(input: LaunchInput): { readonly argv: readonly string[]; readonly stdin: string } {
  return powershellCall(input.powershell, launchScriptText(input))
}

/** The launch script itself: launch()'s standard input. */
export function launchScriptText(input: LaunchInput): string {
  const v = checkLaunch(input)
  const where = v.where
  const transport = where === 'auto' ? 'auto' : 'pane' in where ? 'pane' : 'slot' in where ? 'slot' : 'window'
  const usesWindow = transport === 'window' || transport === 'auto'
  const inner = usesWindow
    ? windowScript({ id: v.id, kind: input.kind, ...(input.name === undefined ? {} : { name: input.name }), folder: v.folder, state: v.state, configDirs: v.configDirs, by: input.claim, ...(v.waitFor === undefined ? {} : { waitFor: v.waitFor }), ...(input.left === undefined ? {} : { left: input.left }) })
    : undefined
  const say = (line: string): string => `[Console]::Out.WriteLine(${line})`
  /** The window, placed: its script compressed into a fixed unpacking bootstrap, started by Start-Process. */
  const openWindow = [
    `$inner = ${literal(inner ?? '')}`,
    '$packed = [IO.MemoryStream]::new()',
    '$gzip = [IO.Compression.GZipStream]::new($packed, [IO.Compression.CompressionMode]::Compress)',
    '$innerBytes = [Text.Encoding]::UTF8.GetBytes($inner)',
    '$gzip.Write($innerBytes, 0, $innerBytes.Length)',
    '$gzip.Dispose()',
    '$payload = [Convert]::ToBase64String($packed.ToArray())',
    `$unpack = "& ([scriptblock]::Create([IO.StreamReader]::new([IO.Compression.GZipStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String('$payload')), [IO.Compression.CompressionMode]::Decompress), [Text.Encoding]::UTF8).ReadToEnd()))"`,
    '$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($unpack))',
    // -ExecutionPolicy RemoteSigned for this window's scripts alone (claude-launch.ps1 clears it again before claude).
    `$window = Start-Process -FilePath ${literal(input.powershell)} -ArgumentList '-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-EncodedCommand', $encoded -PassThru`,
    `$placed = "window - " + $window.Id`,
  ]
  /** The slot's record, written whole: the conversation, its folder, when, and the config folders the runner's re-check also reads. */
  const writeRecord = [
    // The slot asked for, by the path built from its checked id; or, for 'auto', the slot found here,
    // whose id the script made of two numbers.
    where !== 'auto' && 'slot' in where ? `$final = ${literal(slotRecordPath(v.state, where.slot))}` : '$final = Join-Path $state ("slots\\" + $slot["id"] + ".next.json")',
    '$text = [ordered]@{ v = 1; resume = $id; folder = $folder; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); configDirs = [object[]]$configDirs } | ConvertTo-Json -Compress',
    ...WRITE_WHOLE,
    '$placed = "slot " + $slot["id"]',
  ]
  /** The claude wrapper's ticket, written whole. */
  const writeTicket = [
    `$final = ${literal(where !== 'auto' && 'pane' in where ? (paneTicketPath(v.state, where.pane.token) ?? '') : '')}`,
    `$text = ${literal(v.ticket ?? '')}`,
    ...WRITE_WHOLE,
    `$placed = 'pane ${v.label ?? ''}'`,
  ]
  /** This pane's slot runner, verified, and the folder its runner takes: absolute, no quote, the conversation's own. */
  const slotCheck = [
    ...FIND_SLOT,
    '$slotFallback = $null',
    'if ($null -ne $slot -and -not $slotOk) { if ($null -ne $slotHashError) { $slotFallback = "slot hash unreadable: " + $slotHashError } else { $slotFallback = "this pane" + [char]39 + "s claude-slot.ps1 has another SHA-256 than the one shipped" } }',
    'if ($slotSeen) { $slotFallback = "this pane runs claude-slot.ps1 some other way than the slot runner the plugin recognises (Windows PowerShell, powershell.exe -File with the script" + [char]39 + "s absolute path), so it is no slot" }',
    'if ($slotOk) {',
    '  $projectName = [regex]::Replace($folder, "[^A-Za-z0-9]", "-")',
    '  $inProject = $false',
    '  foreach ($dir in $configDirs) { if ($projectName.Length -le 200 -and (Test-Path -LiteralPath (Join-Path $dir ("projects\\" + $projectName + "\\" + $id + ".jsonl")) -PathType Leaf)) { $inProject = $true } }',
    '  if (-not $inProject) { $slotOk = $false; $slotFallback = "the folder is not one the slot runner takes: no transcript of the conversation under its project" }',
    '}',
  ]
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    PSMODULEPATH_RESET,
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `$tool = '${v.tool}'`,
    `$id = '${v.id}'`,
    `$folder = ${literal(v.folder)}`,
    `$state = ${literal(v.state)}`,
    `$configDirs = @(${v.configDirs.map(literal).join(', ')})`,
    `$by = '${input.claim}'`,
    `$claimPath = ${literal(claimPath(v.state, v.id))}`,
    `$launchPath = ${literal(launchScriptPath(v.state))}`,
    '$taken = $false',
    '$final = $null',
    ...RELEASE_CLAIM,
    // A refusal: the lock this run took given back first, then one line, and nothing else.
    'function Refuse($code, $why) {',
    '  if ($taken) { Release-Claim }',
    '  [Console]::Out.WriteLine("refused " + $code + " " + (("" + $why) -split "\\r?\\n")[0])',
    '  exit 0',
    '}',
    ...GET_SHA256,
    // Every process once, by id: the walk up and the checks read only this table.
    '$table = @{}',
    'foreach ($p in (Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate, CommandLine)) { $table[[int]$p.ProcessId] = $p }',
    ...GET_PARENT,
    ...GET_CREATED,
    ...FIND_SESSION,
    `if ($null -eq $session) { Refuse 'session' ($tool + ': no claude.exe above this launch') }`,
    ...(v.waitFor === undefined
      ? []
      : [
          // The process the launch waits for is the caller's own claude.exe, by its id and its start.
          `if ([long]$session.ProcessId -ne ${v.waitFor.pid} -or [math]::Abs([long](Get-Created $session) - [long]'${v.waitFor.created}') -gt ${PROC_START_TOLERANCE}) { Refuse 'wait' ($tool + ': the process to wait for (${v.waitFor.pid}) is not the Claude Code this launch runs under') }`,
        ]),
    ...(transport === 'slot' || transport === 'auto' ? slotCheck : []),
    ...(transport === 'slot'
      ? [
          `if (-not $slotOk -or $slot["id"] -cne '${v.label}') { if ($null -eq $slotFallback) { $slotFallback = "this pane runs no slot runner, or another than the one asked for" }; Refuse 'slot' ($tool + ': ' + $slotFallback) }`,
          "$transport = 'slot'",
        ]
      : []),
    ...(transport === 'auto'
      ? ['if ($slotOk) { $by = "slot:" + $slot["id"]; $transport = "slot" } else { $transport = "window" }']
      : transport === 'pane'
        ? ["$transport = 'pane'"]
        : transport === 'window'
          ? ["$transport = 'window'"]
          : []),
    // claude-launch.ps1 in place, with the shipped hash, before anything is taken or opened: the copy
    // this launch carries is put there when the file is missing or has another hash; refused only when
    // it can't be.
    ...(usesWindow
      ? [
          `$launcherCopy = '${asciiBase64(LAUNCH_SCRIPT_TEXT)}'`,
          ...INSTALL_LAUNCHER,
          "if ($transport -eq 'window') {",
          `  $installWhy = Install-Launcher $launchPath $launcherCopy '${LAUNCH_SCRIPT_SHA256}'`,
          "  if ($null -ne $installWhy) { Refuse 'launcher' ($tool + ': claude-launch.ps1 is not at ' + $launchPath + ' with the SHA-256 this plugin ships, and the copy it carries could not be put there: ' + $installWhy) }",
          '}',
        ]
      : []),
    ...(v.checks.live === true
      ? [
          '$live = $null',
          'try {',
          ...RECHECK.map(line => `  ${line}`),
          ...(input.left === undefined ? [] : leftRecheck(input.left).map(line => `  ${line}`)),
          '} catch { $live = "whether it is open elsewhere is unknown: the registry or the process table could not be read (" + $_.Exception.Message + ")" }',
          "if ($null -ne $live) { Refuse 'live' $live }",
        ]
      : []),
    ...(v.checks.fresh === true ? [...FRESH_CHECK, "if ($null -ne $fresh) { Refuse 'fresh' $fresh }"] : []),
    // Past the deadline the caller has given up on this run: nothing is taken or placed.
    ...(v.deadline === undefined ? [] : [`if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -gt ${v.deadline}) { Refuse 'late' ($tool + ': the launch came past its deadline, so nothing is placed') }`]),
    // The claim, taken in this run, after every check: of two launches that race, one wins.
    ...TAKE_CLAIM,
    "if (-not $taken) { Refuse 'claim' ($tool + ': another switch, restart or launch holds the claim on this conversation') }",
    say('"claim " + $by'),
    'try {',
    ...(transport === 'pane' ? writeTicket : transport === 'slot' ? writeRecord : transport === 'window' ? openWindow : []).map(line => `  ${line}`),
    ...(transport === 'auto'
      ? ['  if ($transport -eq "slot") {', ...writeRecord.map(line => `    ${line}`), '  } else {', ...openWindow.map(line => `    ${line}`), '  }']
      : []),
    "} catch { Refuse 'place' ($tool + ': the launch could not be placed: ' + $_.Exception.Message) }",
    ...(v.deadline === undefined
      ? []
      : [
          // Placed: still within the deadline, and the claim still this launch's? Otherwise the caller
          // may have given up and withdrawn: the ticket or the record is written over as withdrawn and
          // the claim given back, which turns away a window placed already.
          '$lockNow = $null',
          'try { $lockNow = [IO.File]::ReadAllText($claimPath) | ConvertFrom-Json } catch { $lockNow = $null }',
          `if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -gt ${v.deadline} -or $null -eq $lockNow -or $lockNow.by -cne $by) {`,
          '  if ($null -ne $final -and $transport -ne "window") { try { [IO.File]::WriteAllText($final, \'{"v":1,"cancelled":true}\') } catch { } }',
          "  Refuse 'late' ($tool + ': the launch was placed past its deadline, or its claim was taken back meanwhile, so it is withdrawn')",
          '}',
        ]),
    ...(transport === 'auto' ? [`if ($transport -eq 'window' -and $null -ne $slotFallback) { ${say('"fallback " + ($slotFallback -split "\\r?\\n")[0]')} }`] : []),
    say('"launched " + $placed'),
  ]
  return lines.join('\r\n')
}

/**
 * Which launch replaces this session's process (a restart, a switch out of this pane, the
 * coordinator's go), on the probe that judged it, in the coordinating note's order: this tab through
 * the claude wrapper (its pane file's PowerShell is this claude.exe's own parent); else this pane's
 * slot, its script of the shipped hash; else a new window, `fallback` saying why a slot runner found
 * here wasn't used. A launch that doesn't replace its caller has no transport in this version: a slot
 * elsewhere, a tab and placement's window come with slots v2, and it waits. `needsLeft`: the verdict
 * rests on a left record (it waived L3 and L5), so only a place whose last look checks it: a tab of
 * pane file version 3, or a window (never this pane's slot, until slots v2, saying so). A pure function.
 */
export function pickLaunchTransport(
  probe: Probe,
  opts: { readonly replacing: boolean; readonly pane?: { readonly token: string; readonly pane: Pane }; readonly configCount?: number; readonly needsLeft?: boolean },
): { readonly where: LaunchWhere; readonly fallback?: string } | { readonly wait: string } {
  if (!opts.replacing) return { wait: 'a launch of another process needs an idle slot, a tab or a window, which come with slots v2 (S2)' }
  const tab = opts.pane
  const needsLeft = opts.needsLeft === true
  if (tab !== undefined && PANE_TOKEN.test(tab.token) && paneFallback(probe, tab.pane) === undefined && paneReads(tab.pane, opts.configCount ?? 1) === undefined && (!needsLeft || paneNoLeft(tab.pane) === undefined)) return { where: { pane: { token: tab.token } } }
  const slot = probe.slot
  if (slot !== null && slot.sha256 === SLOT_SCRIPT_SHA256) return needsLeft ? { where: { window: true }, fallback: SLOT_NO_LEFT } : { where: { slot: slot.id } }
  if (slot !== null) return { where: { window: true }, fallback: slotFallback(slot) }
  if (probe.slotSeen) return { where: { window: true }, fallback: SLOT_NOT_RECOGNISED }
  return { where: { window: true } }
}


// ---------------------------------------------------------------------------------------------
// The claim lock: released, and checked at the last look.

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
    PSMODULEPATH_RESET,
    `$path = ${literal(claimPath(state, id))}`,
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
 * line), and, with `left`, the left record's stat (leftRecheck: the transcript unchanged since it was
 * left), answering `live <why>` when anything holds it, changed or can't be read; then the claim lock
 * on `id`, whether it names `by`. Changes nothing.
 */
export function claimCheckScript(input: { readonly stateDir: string; readonly id: string; readonly by: string; readonly configDirs: readonly string[]; readonly left?: LeftStat }): string {
  const { state, id, by } = checkClaim(input)
  if (input.configDirs.length < 1 || input.configDirs.length > 8) throw new Error('the claim check reads 1 to 8 config folders')
  const configDirs = input.configDirs.map(dir => checkFolder('a config folder', dir))
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    PSMODULEPATH_RESET,
    `$id = '${id}'`,
    `$configDirs = @(${configDirs.map(literal).join(', ')})`,
    '$live = $null',
    'try {',
    ...RECHECK.map(line => `  ${line}`),
    ...(input.left === undefined ? [] : leftRecheck(input.left).map(line => `  ${line}`)),
    '} catch { $live = "whether it is open elsewhere is unknown: the registry or the process table could not be read (" + $_.Exception.Message + ")" }',
    String.raw`if ($null -ne $live) { "live " + ($live -split "\r?\n")[0]; exit 0 }`,
    `$path = ${literal(claimPath(state, id))}`,
    "if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { 'absent'; exit 0 }",
    '$lock = $null',
    'try { $lock = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $lock = $null }',
    `if ($null -ne $lock -and $lock.by -ceq '${by}') { 'ours' } else { 'not-ours' }`,
  ].join('\r\n')
}

// ---------------------------------------------------------------------------------------------
// The claude wrapper's tab: a restart or a switch resumed in the same Windows Terminal tab.
//
// The claude wrapper (tools/claude-wrapper/claude-wrapper.ps1) is a `claude` function in the
// person's PowerShell profile. Each time `claude` is typed it gives claude.exe a fresh token,
// CLAUDE_PANE_TOKEN (a lowercase UUID), and writes a pane file, panePath(state, token):
// `{ "v": 3, "pid": <its PowerShell's process id>, "started": "<that process's start, a FILETIME>" }`.
// When claude exits, it looks for the ticket, paneTicketPath(state, token), deletes it before
// anything else, and runs `claude --resume <id>` in that tab only when the ticket holds: the rules of
// checkPaneTicket, and on disk, its folder is there, its project holds the conversation's transcript,
// and the claim lock on the conversation names the ticket's claim (`by`); then, at most 10 resumes and
// never a fourth within 30 seconds; and last, right before claude runs, the same last look the slot
// runner and the window take (RECHECK, line for line): no running Claude Code holds the conversation,
// read from its own config folder and every config folder the ticket names (`configDirs`), as the
// window's and the slot's last looks read every one the switch reads.
// Then it loops: a resumed session can restart again.
//
// The token is no secret (it names the pane file, and every process under claude has it), so the
// claim and the last look are what keep a ticket from putting a second process on a conversation.
// The plugins write a ticket only for a pane file of version 3, the wrapper that makes those checks
// and reads the ticket's config folders, or of version 2 (the wrapper before that, which reads its
// own config folder alone) when the launch reads that one config folder alone (paneReads); an older
// or edited one gets a new window. And only when the pane file's process is this claude.exe's own
// parent (paneFallback): a claude started under another one inherits the token, but its parent is a
// tool's shell, and it gets a new window as before.

/**
 * The claude wrapper's pane file: the PowerShell that runs claude, by its process id and its start (a
 * FILETIME as an exact decimal string), and the wrapper's version: 3 reads every config folder a
 * ticket names at its last look, 2 its own alone.
 */
export type Pane = { readonly pid: number; readonly started: string; readonly v: 2 | 3 }

/** The pane file's version that the current claude wrapper writes: the claim check, the last look, and the ticket's config folders read. */
export const PANE_VERSION = 3

/**
 * A pane file's text, checked: `{ v: 3, pid, started }`, or version 2's; `why` naming what it isn't.
 * Version 1 is a wrapper without the claim check and the last look: no ticket for it.
 */
export function parsePane(text: string): Pane | { readonly why: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return { why: "this tab's pane file is not JSON" }
  }
  if (isRecord(raw) && raw.v === 1) {
    return { why: "this tab's claude wrapper is an older one (its pane file is version 1), which checks neither the claim nor whether the conversation is open: copy the current claude-wrapper.ps1 into place" }
  }
  if (!isRecord(raw) || (raw.v !== PANE_VERSION && raw.v !== 2) || !isPid(raw.pid) || !isTicks(raw.started)) return { why: "this tab's pane file is not { v: 3, pid, started }" }
  return { pid: raw.pid as number, started: raw.started as string, v: raw.v as 2 | 3 }
}

/**
 * Why the claude wrapper's tab can't take a launch whose last look must read `configCount` config
 * folders, or undefined when it can: a wrapper of pane file version 2 reads its own config folder
 * alone, so it takes a launch that reads that one alone; version 3 reads every one the ticket names.
 */
export function paneReads(pane: Pane, configCount: number): string | undefined {
  if (pane.v >= 3 || configCount <= 1) return undefined
  return `this tab's claude wrapper is an older one (its pane file is version 2), whose last look reads its own config folder alone, and this move reads ${configCount}: copy the current claude-wrapper.ps1 into place`
}

/**
 * Why the claude wrapper's tab can't take a move that rests on a left record (it waived L3 and L5), or
 * undefined when it can: version 3 checks the transcript against the ticket's `left` at its last look.
 */
export function paneNoLeft(pane: Pane): string | undefined {
  if (pane.v >= 3) return undefined
  return "this tab's claude wrapper is an older one (its pane file is version 2), whose last look doesn't check a left record, and this move rests on one (a return trip soon after a switch): copy the current claude-wrapper.ps1 into place"
}

/**
 * Why this pane's slot runner doesn't take a move that rests on a left record: its last look doesn't
 * check one until slots v2. A new window, whose last look does, takes the move instead.
 */
export const SLOT_NO_LEFT =
  "this pane's slot runner doesn't check a left record until slots v2, and this move rests on one (a return trip soon after a switch), so a new window takes it: its last look does"

/**
 * The pane file of the tab with `token` (the session's CLAUDE_PANE_TOKEN, which the caller reads by
 * its literal name), read with the engine and checked; `why` when there is none, or it isn't one.
 */
export async function readPane($: EngineInterface, state: string, token: string): Promise<Pane | { readonly why: string }> {
  const path = panePath(state, token)
  if (path === undefined) return { why: 'CLAUDE_PANE_TOKEN is not a token the claude wrapper gives (a lowercase UUID)' }
  let text: unknown
  try {
    text = await $.fs.read(path)
  } catch {
    return { why: `this tab's pane file (${path}) can't be read` }
  }
  return typeof text === 'string' ? parsePane(text) : { why: `this tab's pane file (${path}) can't be read as text` }
}

/** The names the claude wrapper's PowerShell runs under. */
const POWERSHELL_NAME = /^(?:pwsh|powershell)\.exe$/i

/**
 * Why the claude wrapper's tab can't take a restart or a switch, or undefined when it can: the pane
 * file's process is this session's claude.exe's own parent (the parent of the top of its run of
 * claude.exe parents, older than it, from the probe's process table), a PowerShell, started when the
 * pane file says, within 1 ms (its id wasn't taken by another process since).
 */
export function paneFallback(probe: Probe, pane: Pane): string | undefined {
  const table = byPid(probe)
  const session = sessionProcess(probe, table)
  if (session === undefined) return "this session's own claude.exe wasn't found above the probe, so its parent can't be checked"
  const parent = parentOf(table, session)
  if (parent === undefined) return `the parent of claude.exe ${session.pid} isn't running`
  if (parent.pid !== pane.pid) return `the tab's claude wrapper (PowerShell ${pane.pid}) is not the parent of claude.exe ${session.pid}; ${parent.name} ${parent.pid} is`
  if (!POWERSHELL_NAME.test(parent.name)) return `the parent of claude.exe ${session.pid} is ${parent.name} ${parent.pid}, not PowerShell`
  if (!near(parent.created, pane.started)) return `the tab's pane file names process ${pane.pid}, but that process started at another time (another process took its id)`
  return undefined
}

/**
 * A ticket for the claude wrapper's tab: the tab's token, the conversation to resume, the claim lock's
 * claimant on it (`launch:<uuid>`), its folder, when (milliseconds since the epoch), and the config
 * folders its last look reads besides the wrapper's own (`configDirs`, 1 to 8; the plugins always
 * name them).
 */
export type PaneTicket = {
  readonly v: 1
  readonly token: string
  readonly resume: string
  readonly by: string
  readonly dir: string
  readonly at: number
  readonly configDirs?: readonly string[]
  /** A left record's stat, when the switch rests on one: the wrapper's last look checks the transcript against it (LEFT_RECHECK). */
  readonly left?: LeftStat
}

/** The claim a ticket names: one launch's. */
const LAUNCH_CLAIM = /^launch:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Why the claude wrapper doesn't use a ticket, each as it prints it, in the order it checks them; it
 * checks the last three on disk, past checkPaneTicket. Then come its caps, and last the re-check
 * (RECHECK), whose words are the slot runner's and the window's.
 */
export const PANE_WHY = {
  json: 'it is not a JSON object',
  withdrawn: 'it was withdrawn',
  version: 'it is not version 1',
  token: 'it is for another tab',
  resume: 'it names no conversation by its id',
  claim: 'it names no claim',
  age: 'its time is not within the last 120 seconds',
  dir: 'its folder is not an existing folder',
  configs: 'its config folders are not absolute folders',
  left: "its left record's stat is not a size and a time, or an exit time",
  transcript: "no transcript of it is under its folder's project",
  lock: 'the claim lock on that conversation does not name this ticket',
} as const

/** A drive-absolute folder with no quote of any kind or control character: the folder rule the wrapper and the slot runner read a record by. */
const TICKET_DIR = /^[A-Za-z]:\\/
const TICKET_DIR_UNSAFE = /[\u0000-\u001f"'\u2018-\u201e]/

/**
 * A ticket's text as the claude wrapper reads it, by the same rules in the same order: a JSON object;
 * not withdrawn (`cancelled: true`, which a switch or restart that took it back writes over it); `v`
 * the number 1; `token` exactly the tab's; `resume` a session id; `by` one launch's claim; `at` a
 * number within the last 120 seconds (and not more than 5 seconds ahead); `dir` a drive-absolute
 * folder with no quote or control character; `configDirs`, when there, a list of 1 to 8 such folders
 * (each at most 240 characters); `left`, when there, `{ size, mtime }` or `{ exitAt }` in whole
 * numbers and nothing else. The wrapper then checks on disk that `dir` is there,
 * that its project, in its own config folder, holds `<resume>.jsonl` (by name; it never reads it),
 * and that the claim lock on `resume` names `by`; then its caps; and right before claude runs, RECHECK,
 * then with `left` LEFT_RECHECK.
 */
export function checkPaneTicket(text: string, token: string, now: number): { readonly ticket: PaneTicket } | { readonly why: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return { why: PANE_WHY.json }
  }
  if (!isRecord(raw)) return { why: PANE_WHY.json }
  if (raw.cancelled === true) return { why: PANE_WHY.withdrawn }
  if (raw.v !== 1) return { why: PANE_WHY.version }
  if (typeof raw.token !== 'string' || raw.token !== token) return { why: PANE_WHY.token }
  if (typeof raw.resume !== 'string' || !SESSION_ID.test(raw.resume)) return { why: PANE_WHY.resume }
  if (typeof raw.by !== 'string' || !LAUNCH_CLAIM.test(raw.by)) return { why: PANE_WHY.claim }
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at) || now - raw.at > PANE_TICKET_MS || now - raw.at < -PANE_AHEAD_MS) return { why: PANE_WHY.age }
  if (typeof raw.dir !== 'string' || !TICKET_DIR.test(raw.dir) || TICKET_DIR_UNSAFE.test(raw.dir)) return { why: PANE_WHY.dir }
  const dirs = raw.configDirs
  if (dirs !== undefined) {
    const isFolder = (dir: unknown): boolean => typeof dir === 'string' && dir.length <= 240 && TICKET_DIR.test(dir) && !TICKET_DIR_UNSAFE.test(dir)
    if (!Array.isArray(dirs) || dirs.length < 1 || dirs.length > 8 || !dirs.every(isFolder)) return { why: PANE_WHY.configs }
  }
  // No left record, or null, as the wrapper reads it ($null): no left record check.
  const absent = raw.left === undefined || raw.left === null
  const left = absent ? undefined : ticketLeft(raw.left)
  if (!absent && left === undefined) return { why: PANE_WHY.left }
  return {
    ticket: {
      v: 1,
      token: raw.token as string,
      resume: raw.resume as string,
      by: raw.by as string,
      dir: raw.dir as string,
      at: raw.at as number,
      ...(dirs === undefined ? {} : { configDirs: dirs as string[] }),
      ...(left === undefined ? {} : { left }),
    },
  }
}

/** A ticket's left record stat, as the wrapper takes it: `{ size, mtime }` or `{ exitAt }`, whole numbers, nothing else. */
function ticketLeft(raw: unknown): LeftStat | undefined {
  if (!isRecord(raw)) return undefined
  const keys = Object.keys(raw).sort().join(',')
  if (keys === 'mtime,size' && isCount(raw.size) && isCount(raw.mtime)) return { size: raw.size, mtime: raw.mtime }
  if (keys === 'exitAt' && isCount(raw.exitAt)) return { exitAt: raw.exitAt }
  return undefined
}

/** What a ticket is built from: all of PaneTicket but its version. */
export type PaneTicketInput = Omit<PaneTicket, 'v'>

/**
 * A ticket for the claude wrapper's tab, as JSON. Throws on anything the wrapper wouldn't take as of
 * `at` (checkPaneTicket), on a token that isn't one, and on a folder that isn't an absolute folder
 * without quotes or control characters (isSafeFolder), so nothing else is written.
 */
export function paneTicket(input: PaneTicketInput): string {
  if (!PANE_TOKEN.test(input.token)) throw new Error(`not a tab's token: ${JSON.stringify(input.token)}`)
  checkFolder("the ticket's folder", input.dir)
  if (input.configDirs !== undefined) for (const dir of input.configDirs) checkFolder("a ticket's config folder", dir)
  const text = JSON.stringify({
    v: 1,
    token: input.token,
    resume: input.resume,
    by: input.by,
    dir: input.dir,
    at: input.at,
    ...(input.configDirs === undefined ? {} : { configDirs: input.configDirs }),
    ...(input.left === undefined ? {} : { left: 'size' in input.left ? { size: input.left.size, mtime: input.left.mtime } : { exitAt: input.left.exitAt } }),
  })
  const checked = checkPaneTicket(text, input.token, input.at)
  if ('why' in checked) throw new Error(`not a ticket the claude wrapper takes: ${checked.why}`)
  return text
}

/** The line the pane script ends with once the ticket is in place: `pane <token>`. */
export const PANE_WRITTEN = /^pane ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/m

/**
 * The script that leaves the claude wrapper's tab its ticket (paneTicket), written whole under
 * another name in the panes folder and then moved into place, so the wrapper never reads half of one.
 * With `claim` (self-restart's: no probe took one), it first takes the claim lock on the ticket's
 * conversation for the ticket's own claimant (`by`), in the same run, as the launcher does
 * (`claim <by>`), and writes no ticket when another holds it (exit 5). Without it, the claim the
 * ticket names is the probe's (self-switch's). Throws on any input that isn't what it must be.
 * The plugins write a ticket through launch() ({ pane }), which takes the claim and writes the same
 * ticket in one run; this stays for a caller that writes a ticket alone (the wrapper's tests).
 */
export function paneScript(input: { readonly stateDir: string; readonly ticket: PaneTicketInput; readonly claim?: boolean }): string {
  const state = checkFolder('the state folder', input.stateDir)
  const text = paneTicket(input.ticket)
  const { token, resume, by } = input.ticket
  const claim =
    input.claim === true
      ? [
          `$id = '${resume}'`,
          // The session's claude.exe, as the launcher finds it: the nearest above this script, then the
          // top of its unbroken run of claude.exe parents.
          '$table = @{}',
          'foreach ($p in (Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate, CommandLine)) { $table[[int]$p.ProcessId] = $p }',
          ...GET_PARENT,
          ...GET_CREATED,
          '$session = $null',
          '$at = $table[[int]$PID]',
          'for ($i = 0; $i -lt 8 -and $null -ne $at; $i++) {',
          '  $at = Get-Parent $at',
          "  if ($null -ne $at -and $at.Name -eq 'claude.exe') { $session = $at; break }",
          '}',
          "if ($null -eq $session) { 'self-restart: no claude.exe above this script'; exit 3 }",
          'for ($i = 0; $i -lt 8; $i++) {',
          '  $up = Get-Parent $session',
          "  if ($null -eq $up -or $up.Name -ne 'claude.exe') { break }",
          '  $session = $up',
          '}',
          `$by = '${by}'`,
          "$transport = 'pane'",
          '$claimPath = Join-Path $state ("claims\\" + $id + ".lock")',
          ...TAKE_CLAIM,
          'if (-not $taken) { "self-restart: another switch or restart holds the claim on this conversation ($claimPath), so it is not resumed"; exit 5 }',
          '"claim $by"',
        ]
      : []
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    PSMODULEPATH_RESET,
    `$state = ${literal(state)}`,
    `$token = '${token}'`,
    ...claim,
    '$panes = Join-Path $state "panes"',
    '[void][IO.Directory]::CreateDirectory($panes)',
    '$final = Join-Path $panes ($token + ".next.json")',
    '$temp = Join-Path $panes ($token + "." + [guid]::NewGuid().ToString() + ".tmp")',
    `[IO.File]::WriteAllText($temp, ${literal(text)})`,
    // No backup file: [NullString]::Value, since PowerShell passes $null to a .NET string as "", which Replace refuses.
    'try { if ([IO.File]::Exists($final)) { [IO.File]::Replace($temp, $final, [NullString]::Value) } else { [IO.File]::Move($temp, $final) } }',
    'catch { [IO.File]::Delete($temp); throw }',
    '"pane $token"',
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

// ---------------------------------------------------------------------------------------------
// The exit pre-check: what would make a queued /exit stop at its confirmation, or end work still
// running. self-exit and self-restart read it at the call and again when the exit is armed, and
// refuse while anything stands, so that nothing is queued that /exit would meet a dialog over; the
// coordinator's ready_for_reboot reads the same.

/** One job as the built-in CronList tool lists it: a session cron (CronCreate, ScheduleWakeup, /loop). */
export type CronJob = {
  readonly id: string
  readonly humanSchedule?: string
  readonly cron?: string
  readonly prompt?: string
  readonly recurring?: boolean
}

/** A wake-up self-wake holds for this session: by its note when the caller has it, or by when it is due (its marker's `due`). */
export type WakeLike = { readonly note?: string; readonly due?: number }

/**
 * One in-flight task as the classic Stop hook's `background_tasks` lists it (hooks reference, Stop
 * input): its id, its type (`shell`, `monitor`, `subagent`, `workflow`, ...), its status, what it is.
 */
export type BackgroundTask = { readonly id: string; readonly type?: string; readonly status?: string; readonly description?: string }

/**
 * What exitBlockers reads. Each is what was read, or a string: why it couldn't be read.
 * - `crons`: CronList's jobs, or the Stop hook's `session_crons` (stopCrons).
 * - `busy`: the probe, whose S6 says what runs under this session, or why it failed. Absent where
 *   there is no probe to run (off Windows: the probe is a Windows PowerShell script), which looks at
 *   nothing and says nothing; a caller on Windows always passes it.
 * - `tasks`: the Stop hook's `background_tasks` (stopTasks), which tells a Monitor from a shell. Absent
 *   where the caller has none to read.
 * - `agents`: `$.agent.list()`.
 * - `wake`: self-wake's pending wake-up, null for none. Absent while nothing reads it.
 */
export type ExitInputs = {
  readonly crons: readonly CronJob[] | string
  readonly busy?: Probe | string
  readonly tasks?: readonly BackgroundTask[] | string
  readonly agents: readonly AgentLike[] | string
  readonly wake?: WakeLike | null | string
}

/** A task's status that is over: no blocker. */
const TASK_DONE = /^(completed|complete|done|failed|killed|stopped|cancelled|canceled)$/i

/** The Stop hook's `background_tasks`, each with a non-empty id; undefined when the value isn't of that shape. */
export function stopTasks(value: unknown): BackgroundTask[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tasks: BackgroundTask[] = []
  for (const task of value) {
    if (!isRecord(task) || typeof task.id !== 'string' || task.id === '') return undefined
    tasks.push({
      id: task.id,
      ...(typeof task.type === 'string' ? { type: task.type } : {}),
      ...(typeof task.status === 'string' ? { status: task.status } : {}),
      ...(typeof task.description === 'string' ? { description: task.description } : {}),
    })
  }
  return tasks
}

/** The Stop hook's `session_crons` as CronJobs (its `schedule` as `cron`); undefined when the value isn't of that shape. */
export function stopCrons(value: unknown): CronJob[] | undefined {
  if (!Array.isArray(value)) return undefined
  const jobs: CronJob[] = []
  for (const job of value) {
    if (!isRecord(job) || typeof job.id !== 'string' || job.id === '') return undefined
    jobs.push({
      id: job.id,
      ...(typeof job.schedule === 'string' ? { cron: job.schedule } : {}),
      ...(typeof job.prompt === 'string' ? { prompt: job.prompt } : {}),
      ...(typeof job.recurring === 'boolean' ? { recurring: job.recurring } : {}),
    })
  }
  return jobs
}

/**
 * What stands in an exit's way: a session cron, a background job under the session (`shell`), a
 * subagent, a pending wake-up, or something that couldn't be read (`unknown`). `monitor` is kept for a
 * caller that can tell a Monitor's job from a Bash one: the probe can't (both are a shell under the
 * session), so from the probe a Monitor's job is a `shell`.
 */
export type ExitBlockerKind = 'cron' | 'shell' | 'monitor' | 'subagent' | 'wake' | 'unknown'

/** One blocker: its kind, its id when it has one (a cron's, a process's, an agent's), what it is, and how to stop it. */
export type ExitBlocker = { readonly kind: ExitBlockerKind; readonly id?: string; readonly what: string; readonly howToStop: string }

/** The process classes whose top-most process under the session is a background job: a shell, a build, a heavy-slot run. */
type JobClass = 'shell' | 'build' | 'heavy-slot'

/** What each job class is, as a blocker names it. */
const JOB_WHAT: Readonly<Record<JobClass, (p: ProcessEntry) => string>> = {
  shell: p => `the background shell ${p.name} ${p.pid} runs under this session (a background job of the Bash, PowerShell or Monitor tool)`,
  build: p => `${p.name} ${p.pid} under this session is a build, test or lint`,
  'heavy-slot': p => `a heavy-slot job (${p.name} ${p.pid}) runs under this session`,
}

/** A process's job class, or undefined when its class is none of them. */
const jobClass = (p: ProcessEntry): JobClass | undefined => (p.cls === 'shell' || p.cls === 'build' || p.cls === 'heavy-slot' ? p.cls : undefined)

/** How an unreadable input is resolved: by reading it again, or by the person. */
const UNREADABLE = "call again in a moment; if it still can't be read, tell the person, who can act by hand"

/** An id as a blocker shows it: plain, or quoted when it holds anything but letters, digits, `-` and `_`. */
const idText = (id: string): string => (/^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : quoted(id))

/**
 * The top-most background jobs under this session: each process under it of a job class (S6's shell
 * and build, and a heavy-slot run) with no such process above it under the session, so a shell and
 * the build it runs are one job. A git, dev server or browser under the session alone is no job here
 * (Claude Code runs git of its own; an MCP server may be a browser): the safe point holds on those.
 */
function busyJobs(probe: Probe): ProcessEntry[] {
  const under = descendants(probe)
  const table = byPid(probe)
  const pids = new Set(under.map(p => p.pid))
  return under.filter(p => {
    if (jobClass(p) === undefined) return false
    let up = parentOf(table, p)
    for (let i = 0; i < 32 && up !== undefined && pids.has(up.pid); i += 1) {
      if (jobClass(up) !== undefined) return false
      up = parentOf(table, up)
    }
    return true
  })
}

/**
 * Everything that stands in an exit's way, each with how to stop it; empty only when every input
 * given could be read and none holds anything. An input that couldn't be read is a blocker of kind
 * `unknown` ("can't tell: ..."), never none. Pure: a function of what was read.
 */
export function exitBlockers(input: ExitInputs): ExitBlocker[] {
  const found: ExitBlocker[] = []
  const unknown = (what: string): void => {
    found.push({ kind: 'unknown', what: `can't tell ${what}`, howToStop: UNREADABLE })
  }
  if (typeof input.crons === 'string') unknown(`whether a session cron is set (${oneLine(input.crons, 300)})`)
  else {
    for (const job of input.crons) {
      const id = idText(job.id)
      const when = oneLine(job.humanSchedule ?? job.cron ?? 'its schedule', 80)
      const words = job.prompt === undefined ? '' : `: ${quoted(oneLine(job.prompt, 80))}`
      found.push({ kind: 'cron', id: job.id, what: `cron ${id} (${when}${words}) is set to wake this session`, howToStop: `delete it with CronDelete (id ${id})` })
    }
  }
  if (input.busy !== undefined) {
    if (typeof input.busy === 'string') unknown(`what runs under this session: the machine probe failed (${oneLine(input.busy, 300)})`)
    else if (sessionProcess(input.busy, byPid(input.busy)) === undefined) unknown("what runs under this session: its own claude.exe wasn't found above the probe")
    else {
      for (const p of busyJobs(input.busy)) {
        found.push({
          kind: 'shell',
          id: String(p.pid),
          what: JOB_WHAT[jobClass(p) ?? 'shell'](p),
          howToStop: 'stop it with TaskStop (the task id its Bash, PowerShell or Monitor call gave), or let it finish',
        })
      }
    }
  }
  if (typeof input.tasks === 'string') unknown(`what background tasks are in flight (${oneLine(input.tasks, 300)})`)
  else if (input.tasks !== undefined) {
    for (const task of input.tasks) {
      if (task.status !== undefined && TASK_DONE.test(task.status)) continue
      const type = (task.type ?? 'shell').toLowerCase()
      // A subagent's task is the agents' list's to say; any other type is a job the exit would end.
      if (type === 'subagent') continue
      const id = idText(task.id)
      const described = oneLine(task.description ?? '', 80)
      const what = described === '' ? '' : ` (${quoted(described)})`
      found.push({
        kind: type === 'monitor' ? 'monitor' : 'shell',
        id: task.id,
        what: type === 'monitor' ? `a Monitor task ${id}${what} is running` : `a background ${oneLine(type, 40)} task ${id}${what} is running`,
        howToStop: `stop task ${id} with TaskStop, or let it finish`,
      })
    }
  }
  if (typeof input.agents === 'string') unknown(`whether a subagent is still running: the session's subagents can't be read (${oneLine(input.agents, 300)})`)
  else {
    for (const agent of input.agents) {
      if (!BUSY_AGENTS.includes(agent.status)) continue
      const described = agent.description?.trim() ?? ''
      const name = oneLine(described !== '' ? described : (agent.type ?? 'an agent'), 120)
      const id = typeof agent.id === 'string' && agent.id !== '' ? agent.id : undefined
      found.push({
        kind: 'subagent',
        ...(id === undefined ? {} : { id }),
        what: `a subagent is still running (${name})`,
        howToStop: `wait for it to report, or stop it with TaskStop${id === undefined ? '' : ` (${idText(id)})`}`,
      })
    }
  }
  if (typeof input.wake === 'string') unknown(`whether a wake-up is pending (${oneLine(input.wake, 300)})`)
  else if (input.wake !== undefined && input.wake !== null) {
    const said = [
      ...(input.wake.note === undefined ? [] : [quoted(oneLine(input.wake.note, 80))]),
      ...(input.wake.due === undefined || !Number.isFinite(input.wake.due) ? [] : [`due ${new Date(input.wake.due).toISOString().slice(0, 16).replace('T', ' ')} UTC`]),
    ]
    found.push({ kind: 'wake', what: `a wake-up is pending${said.length === 0 ? '' : ` (${said.join(', ')})`}`, howToStop: "cancel it with cancel_wake: it doesn't outlive this process" })
  }
  return found
}

/** The blockers as one line of a refusal: each what it is and how to stop it, `; ` between. */
export const blockersText = (blockers: readonly ExitBlocker[]): string => blockers.map(b => `${b.what}: ${b.howToStop}`).join('; ')

/** How long the pre-check's reads of the engine may each take: CronList's permission, its call, the agents. */
export const EXIT_READ_MS = 5000

/** How long the probe may take. */
export const PROBE_MS = 60_000

/** What an error says, as one line. */
const errorLine = (err: unknown): string => {
  const text = oneLine(err instanceof Error ? err.message : String(err), 300)
  return text === '' ? 'no reason given' : text
}

/**
 * `work`, or `undefined` once `ms` have passed on the engine's clock first. A timer, never a sleep, so
 * the wait isn't the calling hook's own time; `work` goes on, its late answer dropped.
 */
export async function within<T>($: EngineInterface, ms: number, work: Promise<T>): Promise<{ readonly value: T } | undefined> {
  let timer: Timer | undefined
  const late = new Promise<undefined>(resolve => {
    timer = $.clock.after(ms, () => resolve(undefined))
  })
  const answered = work.then(value => ({ value }))
  // A rejection after the wait has ended is no one's to see.
  answered.catch(() => undefined)
  try {
    return await Promise.race([answered, late])
  } finally {
    timer?.cancel()
  }
}

/** CronList's `jobs`, each with a non-empty id; undefined when the answer isn't of that shape. */
export function cronJobs(result: unknown): CronJob[] | undefined {
  if (!isRecord(result) || !Array.isArray(result.jobs)) return undefined
  const jobs: CronJob[] = []
  for (const job of result.jobs) {
    if (!isRecord(job) || typeof job.id !== 'string' || job.id === '') return undefined
    jobs.push({
      id: job.id,
      ...(typeof job.humanSchedule === 'string' ? { humanSchedule: job.humanSchedule } : {}),
      ...(typeof job.cron === 'string' ? { cron: job.cron } : {}),
      ...(typeof job.prompt === 'string' ? { prompt: job.prompt } : {}),
      ...(typeof job.recurring === 'boolean' ? { recurring: job.recurring } : {}),
    })
  }
  return jobs
}

/**
 * The session's crons, by the built-in CronList tool: first its permission verdict (`$.tool.check`,
 * which opens no dialog), then, only when that is `allow`, the call (`$.tool.call`), each within
 * EXIT_READ_MS. A string says why they couldn't be read: a verdict other than allow (the call would
 * ask, or is refused), a refusal, an error, no answer in time, or an answer of another shape.
 * The two shapes differ: `$.tool.check` takes the arguments under `input`, `$.tool.call` takes them
 * at the top level (CronList has none). A call with `input:` is an error result (`isError`), which
 * reads as unknown. Live (SS2): CronList answers `{ result: { jobs }, text }` mid-turn and at idle
 * from a timer, in about 20 ms, with no transcript row; it lists ScheduleWakeup and /loop jobs too.
 */
export async function readCrons($: EngineInterface, ms = EXIT_READ_MS): Promise<readonly CronJob[] | string> {
  const seconds = `${ms / 1000} s`
  try {
    const verdict = await within($, ms, $.tool.check({ tool: 'CronList', input: {} }))
    if (verdict === undefined) return `CronList's permission wasn't answered within ${seconds}`
    const { decision, reason } = verdict.value
    if (decision !== 'allow') return `CronList would ${decision === 'ask' ? 'ask for permission' : 'be refused'} here${typeof reason === 'string' && reason.trim() !== '' ? `: ${oneLine(reason, 200)}` : ''}`
    const ran = await within($, ms, $.tool.call({ tool: 'CronList' }))
    if (ran === undefined) return `CronList didn't answer within ${seconds}`
    const run = ran.value as { readonly deny?: string; readonly isError?: boolean; readonly result?: unknown; readonly text?: string }
    if (typeof run.deny === 'string') return `CronList was refused: ${oneLine(run.deny, 200)}`
    if (run.isError === true) return `CronList failed: ${oneLine(String(run.text ?? 'no reason given'), 200)}`
    return cronJobs(run.result) ?? "CronList answered in a shape this plugin doesn't know"
  } catch (err) {
    return `CronList didn't run: ${errorLine(err)}`
  }
}

/** The session's agents, or why they can't be read (no answer within EXIT_READ_MS among them). */
export async function readAgents($: EngineInterface, ms = EXIT_READ_MS): Promise<readonly AgentLike[] | string> {
  try {
    const listed = await within($, ms, $.agent.list())
    return listed === undefined ? `the list wasn't answered within ${ms / 1000} s` : listed.value
  } catch (err) {
    return errorLine(err)
  }
}

/**
 * The probe of this session's process tree alone (its id, no config folder, no claim), run as every
 * script is: Windows PowerShell by its known path, the script on standard input (powershellCall).
 * A string says why it failed.
 */
export async function runProbe($: EngineInterface, target: { readonly powershell: string; readonly id: string }): Promise<Probe | string> {
  try {
    const call = powershellCall(target.powershell, probeScript({ ids: [target.id], configDirs: [] }))
    const run = await $.process.run(call.argv, { stdin: call.stdin, timeoutMs: PROBE_MS })
    if (run.exitCode !== 0) {
      const err = oneLine(run.stderr, 300)
      return `it exited ${run.exitCode}${err === '' ? '' : `: ${err}`}`
    }
    const probe = parseProbe(run.stdout)
    return 'error' in probe ? probe.error : probe
  } catch (err) {
    return `it didn't run: ${errorLine(err)}`
  }
}

/**
 * What the exit pre-check reads, all at once: the crons, the agents, and the probe when `probe` says
 * where it runs from (a string there: why it can't run, which is passed on as the probe's failure;
 * absent: no probe, off Windows).
 */
export async function readExit($: EngineInterface, probe?: { readonly powershell: string; readonly id: string } | string): Promise<ExitInputs> {
  const [crons, agents, busy] = await Promise.all([readCrons($), readAgents($), probe === undefined || typeof probe === 'string' ? Promise.resolve(probe) : runProbe($, probe)])
  return busy === undefined ? { crons, agents } : { crons, agents, busy }
}

// ---------------------------------------------------------------------------------------------
// The files the coordinator reads: the pending marker, and the last self-check.

/** A pending marker older than this is ignored: the exit or restart it stood for didn't run, or ran without saying so. */
export const PENDING_MS = 15 * 60 * 1000

/** A pending marker whose `at` is further ahead of the reader's clock than this is bad: no marker holds forever. */
export const PENDING_AHEAD_MS = 60 * 1000

/** What a pending marker stands for. */
export type PendingKind = 'exit' | 'restart'

/**
 * The pending marker for conversation `id`: `<state>\pending\<id>.json`. Undefined for an id that
 * isn't a session id, so nothing else (`..\x`) is ever joined into a path.
 */
export const pendingPath = (state: string, id: string): string | undefined => idPathOrNone(state, 'pending', id)

/** The marker while an exit or restart is queued or armed: `{ v: 1, kind, at }`, `at` in milliseconds since the epoch. */
export const pendingMarker = (kind: PendingKind, at: number): string => JSON.stringify({ v: 1, kind, at })

/** The marker once the exit or restart ran or was cancelled. */
export const PENDING_DONE = JSON.stringify({ v: 1, done: true })

/**
 * A pending marker as the coordinator reads it: `pending` (an exit or restart is queued or armed,
 * and the marker is at most 15 minutes old: hold deliveries), `done` (it ran or was cancelled),
 * `stale` (older than 15 minutes), or `bad` (another shape, or an `at` more than a minute ahead of
 * `now`, which would otherwise hold deliveries for as long as it stays ahead). Only `pending` holds
 * anything.
 */
export function readPending(text: string, now: number): 'pending' | 'done' | 'stale' | 'bad' {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return 'bad'
  }
  if (!isRecord(raw) || raw.v !== 1) return 'bad'
  if (raw.done === true) return 'done'
  if (raw.kind !== 'exit' && raw.kind !== 'restart') return 'bad'
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at) || raw.at > now + PENDING_AHEAD_MS) return 'bad'
  return now - raw.at > PENDING_MS ? 'stale' : 'pending'
}

/**
 * Writes this conversation's pending marker: `kind` while an exit or restart is queued or armed,
 * null once it ran or was cancelled. Nothing is written where %LOCALAPPDATA% isn't a plain folder
 * (off Windows) or the session's id isn't a session id. Never throws: the marker is the
 * coordinator's hint, ignored after 15 minutes. Returns why a write failed, if one did.
 */
export async function markPending($: EngineInterface, kind: PendingKind | null): Promise<string | undefined> {
  try {
    const local = await $.env.get('LOCALAPPDATA')
    if (!isSafeFolder(local)) return undefined
    const path = pendingPath(stateFolder(local), await $.session.id())
    if (path === undefined) return undefined
    await $.fs.write(path, kind === null ? PENDING_DONE : pendingMarker(kind, await $.clock.now()))
    return undefined
  } catch (err) {
    return errorLine(err)
  }
}

/** The most tool names a self-check record carries. */
export const SELFCHECK_MAX = 8

/** A tool name a self-check record carries: Bash, PowerShell, or an MCP server by its tool-name spelling. */
export const SELFCHECK_NAME = /^(?:Bash|PowerShell|mcp:[A-Za-z0-9_-]{1,64})$/

/** The last self-check of conversation `id`: `<state>\selfcheck\<id>.json`. Undefined for an id that isn't a session id. */
export const selfcheckPath = (state: string, id: string): string | undefined => idPathOrNone(state, 'selfcheck', id)

/** A self-check record: `{ v: 1, at, failed }`, the failed tools by name only, at most SELFCHECK_MAX. */
export const selfcheckRecord = (at: number, failed: readonly string[]): string =>
  JSON.stringify({ v: 1, at, failed: failed.filter(name => SELFCHECK_NAME.test(name)).slice(0, SELFCHECK_MAX) })

/** A self-check record as the coordinator reads it: when, and the failed tools' names; undefined for another shape. */
export function readSelfcheck(text: string): { readonly at: number; readonly failed: readonly string[] } | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(raw) || raw.v !== 1 || typeof raw.at !== 'number' || !Number.isFinite(raw.at) || !Array.isArray(raw.failed)) return undefined
  if (raw.failed.length > SELFCHECK_MAX || !raw.failed.every(name => typeof name === 'string' && SELFCHECK_NAME.test(name))) return undefined
  return { at: raw.at, failed: raw.failed as string[] }
}

// ---------------------------------------------------------------------------------------------
// The left record (\u00a73.4): a conversation this process left cleanly.
//
// `%LOCALAPPDATA%\claude-self-tools\left\<W>.json`:
// `{ v: 1, id, how, pid, created, at, transcript: { dir, project, size, mtime }, by, go?, mac }`, every
// value but `v` a string. `mac` is HMAC-SHA256, under left.key (32 random bytes, created once with
// CreateNew, read only inside the fixed scripts and never printed), over Get-LeftText's lines. The MAC
// binds the fields and stops stray or torn writes; it is no defence against the same OS user, who
// could as well run `claude --resume` (T20, D54). Written by leftScript, read by the probe (`left`),
// judged by liveness (`left: true`), and checked again at the last look (leftRecheck).

/** The left record script's answer: `left <id>`. A refusal is `refused <code> <why>`. */
export const LEFT_WRITTEN = /^left ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/m

/** What a left record is written for. */
export type LeftInput = {
  readonly stateDir: string
  /** The conversation this process left. */
  readonly id: string
  /** In place (a /resume or /clear: the arriving side writes it, LEFT_SETTLE_MS after the SessionStart), or exit (right before /exit). */
  readonly how: 'in-place' | 'exit'
  /** Where its transcript is found: 1 to 8 config folders. */
  readonly configDirs: readonly string[]
  /** Who writes it: the coordinator or self-switch. Never self-restart, which resumes its own conversation. */
  readonly by: 'coordinator' | 'self-switch'
  /** The coordinator's go it is written for. */
  readonly go?: string
  /** The leaving claude.exe, when the caller read it from a probe: it must be the one this script runs under. */
  readonly process?: ProcessRef
}

/**
 * The script that writes a left record for conversation `id`, left by the claude.exe this script runs
 * under: it finds that claude.exe (the nearest above, then the top of its run); stats the one
 * transcript of `id` in `configDirs` (none, or more than one, refuses); creates left.key with CreateNew
 * when it isn't there (32 bytes from RandomNumberGenerator; never replaced); and writes the record,
 * its MAC under the key, whole: a temporary file, then a move or a replace. Answers `left <id>`, or
 * `refused <code> <why>`. Throws on any input that isn't what it must be.
 */
export function leftScript(input: LeftInput): string {
  const state = checkFolder('the state folder', input.stateDir)
  const id = checkId(input.id)
  if (input.how !== 'in-place' && input.how !== 'exit') throw new Error(`not how a conversation is left: ${JSON.stringify(input.how)}`)
  if (input.by !== 'coordinator' && input.by !== 'self-switch') throw new Error('a left record is written by the coordinator or self-switch only: self-restart resumes its own conversation')
  if (input.configDirs.length < 1 || input.configDirs.length > 8) throw new Error('a left record reads 1 to 8 config folders')
  const configDirs = input.configDirs.map(dir => checkFolder('a config folder', dir))
  if (input.go !== undefined && !GO_ID.test(input.go)) throw new Error(`not a go's id: ${JSON.stringify(input.go)}`)
  const named = input.process
  if (named !== undefined && (!isPid(named.pid) || !isTicks(named.created))) throw new Error('the leaving process is not a pid and a time as a string')
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    PSMODULEPATH_RESET,
    `$id = '${id}'`,
    `$how = '${input.how}'`,
    `$by = '${input.by}'`,
    `$go = '${input.go ?? ''}'`,
    `$configDirs = @(${configDirs.map(literal).join(', ')})`,
    `$leftPath = ${literal(leftPath(state, id))}`,
    `$leftKeyPath = ${literal(leftKeyPath(state))}`,
    ...LEFT_FIELDS,
    '$table = @{}',
    'foreach ($p in (Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate)) { $table[[int]$p.ProcessId] = $p }',
    ...GET_PARENT,
    ...GET_CREATED,
    ...FIND_SESSION,
    "if ($null -eq $session) { 'refused session no claude.exe above this script'; exit 0 }",
    ...(named === undefined
      ? []
      : [
          `if ([long]$session.ProcessId -ne ${named.pid} -or [math]::Abs([long](Get-Created $session) - [long]'${named.created}') -gt ${PROC_START_TOLERANCE}) { 'refused process the process named is not the Claude Code this script runs under'; exit 0 }`,
        ]),
    // The transcript: exactly one, in the config folders given.
    '$found = New-Object System.Collections.ArrayList',
    'foreach ($dir in $configDirs) {',
    '  $projects = Join-Path $dir "projects"',
    '  if (-not (Test-Path -LiteralPath $projects -PathType Container)) { continue }',
    '  foreach ($d in @(Get-ChildItem -LiteralPath $projects -Directory -Force)) {',
    '    $t = Join-Path $d.FullName ($id + ".jsonl")',
    '    if (Test-Path -LiteralPath $t -PathType Leaf) { [void]$found.Add([ordered]@{ dir = $dir; project = $d.Name; item = (Get-Item -LiteralPath $t -Force) }) }',
    '  }',
    '}',
    'if ($found.Count -ne 1) { "refused transcript " + $found.Count + " transcripts of it are on this machine, not one"; exit 0 }',
    '$one = $found[0]',
    // The key: created once, with CreateNew, so a second creation never replaces it; then read.
    '[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($leftKeyPath))',
    'try {',
    '  $keyStream = [IO.File]::Open($leftKeyPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)',
    '  try { $fresh = New-Object byte[] 32; $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); try { $rng.GetBytes($fresh) } finally { $rng.Dispose() }; $keyStream.Write($fresh, 0, 32) } finally { $keyStream.Dispose(); $fresh = $null }',
    `} catch { if (-not ${IS_IO}) { throw } }`,
    '$leftKey = $null',
    'for ($try = 0; $try -lt 3 -and $null -eq $leftKey; $try++) { if ($try -gt 0) { Start-Sleep -Milliseconds 100 }; try { $leftKey = [IO.File]::ReadAllBytes($leftKeyPath) } catch { $leftKey = $null } }',
    "if ($null -eq $leftKey -or $leftKey.Length -ne 32) { $leftKey = $null; 'refused key the left key can not be read as 32 bytes'; exit 0 }",
    // The fields, each a string, as the reader checks them; then the MAC over them, and the key let go.
    '$f = [ordered]@{ id = $id; how = $how; pid = ([string][long]$session.ProcessId); created = (Get-Created $session); at = ([string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()); dir = $one.dir; project = $one.project; size = ([string][long]$one.item.Length); mtime = ([string]([DateTimeOffset]$one.item.LastWriteTimeUtc).ToUnixTimeMilliseconds()); by = $by; go = $go }',
    '$mac = Get-LeftMac $leftKey (Get-LeftText $f)',
    '$leftKey = $null',
    '$record = [ordered]@{ v = 1; id = $f.id; how = $f.how; pid = $f.pid; created = $f.created; at = $f.at; transcript = [ordered]@{ dir = $f.dir; project = $f.project; size = $f.size; mtime = $f.mtime }; by = $f.by }',
    'if ($go -ne "") { $record["go"] = $go }',
    '$record["mac"] = $mac',
    '$final = $leftPath',
    '$text = $record | ConvertTo-Json -Compress -Depth 4',
    ...WRITE_WHOLE,
    '"left " + $id',
  ].join('\r\n')
}

// ---------------------------------------------------------------------------------------------
// self-wake's wake marker, and S10w: whether a wake-up is pending for a conversation.
//
// self-wake 0.2.0 writes `%LOCALAPPDATA%\claude-self-tools\wake\<conversation>.json` = `{ v: 1, armed,
// due?, at }` at the start of each conversation it runs in, when a wake-up is armed, when it fires, and
// when it is cancelled or replaced: `armed` true only while this process holds a timer for that
// conversation's wake-up. It overwrites the file; a plugin can't delete one.

/** The tool self-wake registers: in `$.tool.list()` when self-wake runs in this session. */
export const SELF_WAKE_TOOL = 'mcp__self-wake__wake_after'

/** The first self-wake that writes the markers S10w reads: a hold on a missing one names it. */
export const SELF_WAKE_MARKER_VERSION = '0.2.0'

/** A wake marker: whether a wake-up is armed for the conversation, when it is due, and when this was written (ms since the epoch). */
export type WakeMarker = { readonly armed: boolean; readonly due?: number; readonly at: number }

/** A wake marker's text: `{ v: 1, armed, due?, at }`; `due` only while armed. */
export const wakeMarker = (marker: WakeMarker): string =>
  JSON.stringify({ v: 1, armed: marker.armed, ...(marker.armed && marker.due !== undefined ? { due: marker.due } : {}), at: marker.at })

/** A wake marker's text, read strictly: undefined for anything not of its shape (one armed with no due among them). */
export function readWakeMarker(text: string): WakeMarker | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
  if (!isRecord(raw) || raw.v !== 1 || typeof raw.armed !== 'boolean' || !isCount(raw.at)) return undefined
  for (const key of Object.keys(raw)) if (!['v', 'armed', 'due', 'at'].includes(key)) return undefined
  if (raw.armed) return isCount(raw.due) ? { armed: true, due: raw.due, at: raw.at } : undefined
  return 'due' in raw ? undefined : { armed: false, at: raw.at }
}

/** S10w's read of a conversation's wake-up: pending (and when), none (and why), or unknown (and why), which holds as pending does. */
export type WakeRead = { readonly wake: 'pending'; readonly due: number } | { readonly wake: 'none'; readonly why: string } | { readonly wake: 'unknown'; readonly why: string }

/**
 * Whether a wake-up is pending for conversation `id` (S10w, \u00a77.1): with self-wake in this session (its
 * tool in `$.tool.list()`), its marker says, armed or not; a marker that isn't there or doesn't parse,
 * or a tool list that can't be read, is unknown, and unknown holds. Without self-wake, there is nothing
 * to wait for.
 */
export async function readWake($: EngineInterface, state: string, id: string): Promise<WakeRead> {
  const path = idPathOrNone(state, 'wake', id)
  if (path === undefined) return { wake: 'unknown', why: `${JSON.stringify(id)} is not a session id` }
  let present: boolean
  try {
    present = (await $.tool.list()).some(tool => tool.name === SELF_WAKE_TOOL)
  } catch (err) {
    return { wake: 'unknown', why: `this session's tools can't be listed (${errorLine(err)})` }
  }
  if (!present) return { wake: 'none', why: 'self-wake is not in this session' }
  let text: unknown
  try {
    if (!(await $.fs.exists(path))) return { wake: 'unknown', why: `self-wake is on, but its marker for this conversation isn't there (${path}): update self-wake to ${SELF_WAKE_MARKER_VERSION} or later, which writes one` }
    text = await $.fs.read(path)
  } catch (err) {
    return { wake: 'unknown', why: `self-wake's marker for this conversation can't be read (${errorLine(err)}): self-wake ${SELF_WAKE_MARKER_VERSION} or later writes one this plugin reads` }
  }
  const marker = typeof text === 'string' ? readWakeMarker(text) : undefined
  if (marker === undefined) return { wake: 'unknown', why: `self-wake's marker for this conversation is not of its shape: update self-wake to ${SELF_WAKE_MARKER_VERSION} or later` }
  return marker.armed && marker.due !== undefined ? { wake: 'pending', due: marker.due } : { wake: 'none', why: 'no wake-up is armed' }
}

/** S10w as a reason a go or a switch holds, or undefined when it doesn't. */
export function wakeHold(read: WakeRead): string | undefined {
  if (read.wake === 'pending') return `S10w: a wake-up is pending (due ${new Date(read.due).toISOString().slice(0, 16).replace('T', ' ')} UTC): cancel it with cancel_wake, or wait for it`
  if (read.wake === 'unknown') return `S10w: whether a wake-up is pending is unknown, and unknown holds: ${read.why}`
  return undefined
}

// ---------------------------------------------------------------------------------------------
// lanes.json (\u00a73.6, D65): each session name's current conversation, per machine.
//
// `<config folder>\lanes.json` = `{ v: 1, at, lanes: { "<name>": { session, folder, window?, tab?, ws,
// at } } }`: ids, folders, labels and a workspace id; no secret and no transcript content. A map, not
// an authority (T-L47): a launch from an entry checks the conversation as any launch does. Written one
// entry at a time by lanesUpdateScript, read by readLanes and claude-launch.ps1 -Lane.

/** A named window: letters, digits, `_` and `-`; never one WT reads as special (`0`, digits, `-1`, `new`, `last`). */
export const WINDOW_NAME = /^[A-Za-z0-9_-]{1,40}$/

/** Whether `name` is a window name WT takes as a name, never as `-w 0`, `-w -1`, `new` or `last`. */
export const isWindowName = (name: unknown): name is string => typeof name === 'string' && WINDOW_NAME.test(name) && !/^-?\d+$/.test(name) && !/^(?:new|last)$/i.test(name)

/** A tab's label. */
export const TAB_LABEL = /^[A-Za-z0-9 ._-]{1,40}$/

/** A workspace id, as the coordinator names one (lib/spaces.ts). */
export const WORKSPACE_ID = /^(?:default|w_[a-z0-9]{12})$/

/** One name's entry: its current conversation, that conversation's folder, its window and tab, the workspace, and when. */
export type LaneEntry = { readonly session: string; readonly folder: string; readonly window?: string; readonly tab?: string; readonly ws: string; readonly at: number }

/** lanes.json, read: when it was written, and its well-formed entries by name. */
export type Lanes = { readonly at: number; readonly lanes: Readonly<Record<string, LaneEntry>> }

/** lanes.json in config folder `configDir`. */
export const lanesPath = (configDir: string): string => `${configDir.replace(/\\+$/, '')}\\lanes.json`

/** An entry for `name`, checked: undefined when the name or any field isn't of its shape, or a field is unknown. */
export function laneEntry(name: unknown, value: unknown): LaneEntry | undefined {
  if (typeof name !== 'string' || !AREA_NAME.test(name) || !isRecord(value)) return undefined
  for (const key of Object.keys(value)) if (!['session', 'folder', 'window', 'tab', 'ws', 'at'].includes(key)) return undefined
  const { session, folder, window, tab, ws, at } = value
  if (typeof session !== 'string' || !SESSION_ID.test(session)) return undefined
  if (!isSafeFolder(folder) || folder.includes(';')) return undefined
  if (window !== undefined && !isWindowName(window)) return undefined
  if (tab !== undefined && (typeof tab !== 'string' || !TAB_LABEL.test(tab))) return undefined
  if (typeof ws !== 'string' || !WORKSPACE_ID.test(ws) || !isCount(at)) return undefined
  return { session, folder, ...(window === undefined ? {} : { window: window as string }), ...(tab === undefined ? {} : { tab: tab as string }), ws, at }
}

/** lanes.json's text, read: the file strict (`v` 1, `at`, `lanes`, nothing else), each entry checked, a malformed one dropped and the rest kept. */
export function readLanes(text: string): Lanes | { readonly error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return { error: 'lanes.json is not JSON' }
  }
  if (!isRecord(raw) || raw.v !== 1) return { error: 'lanes.json is not version 1' }
  for (const key of Object.keys(raw)) if (!['v', 'at', 'lanes'].includes(key)) return { error: `lanes.json has an unknown field ${JSON.stringify(key)}` }
  if (!isCount(raw.at) || !isRecord(raw.lanes)) return { error: 'lanes.json has no time or no lanes' }
  const lanes: Record<string, LaneEntry> = {}
  for (const [name, value] of Object.entries(raw.lanes)) {
    const entry = laneEntry(name, value)
    if (entry !== undefined) lanes[name] = entry
  }
  return { at: raw.at, lanes }
}

/** The lanes script's answer: `lanes <name>`. A refusal is `refused <code> <why>`. */
export const LANES_WRITTEN = /^lanes ([a-z0-9][a-z0-9-]{0,39})\s*$/m

/**
 * The script that writes one name's entry into lanes.json, keeping every other entry as it is. A lock
 * (lanes.json.lock) held as a handle no one else may open, with DeleteOnClose, from before the read to
 * after the write: a second writer waits for it (40 tries, 250 ms apart), and a writer that dies lets
 * it go with its process, so no lock is ever stale; a lock file another left behind is simply opened.
 * Read, merge this entry, write a temporary file, [IO.File]::Replace over the old one: a reader never
 * sees half a file. A lanes.json not of its shape is left as it is (refused). Throws on a name, id,
 * folder, window, tab or workspace that isn't of its shape.
 */
export function lanesUpdateScript(input: { readonly configDir: string; readonly name: string; readonly entry: LaneEntry }): string {
  const configDir = checkFolder('the config folder', input.configDir)
  if (!AREA_NAME.test(input.name)) throw new Error(`not a session's name: ${JSON.stringify(input.name)}`)
  const entry = laneEntry(input.name, input.entry)
  if (entry === undefined) throw new Error(`not a lanes.json entry: ${JSON.stringify(input.entry)}`)
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    PSMODULEPATH_RESET,
    `$path = ${literal(lanesPath(configDir))}`,
    '$lockPath = $path + ".lock"',
    `$name = '${input.name}'`,
    `$entryText = ${literal(JSON.stringify(entry))}`,
    '[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))',
    '$lock = $null',
    'for ($try = 0; $try -lt 40 -and $null -eq $lock; $try++) {',
    '  try { $lock = [IO.FileStream]::new($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose) }',
    `  catch { if (-not ${IS_IO}) { throw }; Start-Sleep -Milliseconds 250 }`,
    '}',
    "if ($null -eq $lock) { 'refused lock another writer held lanes.json for 10 seconds'; exit 0 }",
    'try {',
    '  $lanes = [ordered]@{}',
    '  if (Test-Path -LiteralPath $path -PathType Leaf) {',
    '    $doc = $null',
    '    try { $doc = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { $doc = $null }',
    "    if ($doc -isnot [Management.Automation.PSCustomObject] -or $doc.v -isnot [ValueType] -or $doc.v -ne 1 -or $doc.lanes -isnot [Management.Automation.PSCustomObject]) { 'refused file lanes.json is not of its shape, so it is left as it is'; exit 0 }",
    '    foreach ($p in $doc.lanes.PSObject.Properties) { if ($p.Name -cne $name) { $lanes[$p.Name] = $p.Value } }',
    '  }',
    '  $lanes[$name] = $entryText | ConvertFrom-Json',
    '  $final = $path',
    '  $text = [ordered]@{ v = 1; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); lanes = $lanes } | ConvertTo-Json -Compress -Depth 6',
    ...WRITE_WHOLE.map(line => `  ${line}`),
    '} finally { $lock.Dispose() }',
    '"lanes " + $name',
  ].join('\r\n')
}
