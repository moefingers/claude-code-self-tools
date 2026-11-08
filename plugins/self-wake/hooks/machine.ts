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
//   wrapper's tab, a record for a slot (this pane's, or an idle one elsewhere), a named tab or window of
//   Windows Terminal running the slot runner, or a new window. The window waits for the old
//   process when asked, reads the registry and process table again, checks the claim, and runs
//   claude-launch.ps1 (plugins/self-switch/slot/claude-launch.ps1, LAUNCH_SCRIPT_SHA256, installed by
//   its hash's name: launchScriptPath), the only script that starts claude: it takes the same last look
//   again, by hand too, then alone clears LAUNCH_ENV_CLEAR and LAUNCH_ENV_DROP and sets LAUNCH_ENV_SET
//   right before claude, passes claude only --resume, or --session-id and --name, and never a
//   permission flag.
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
//   byte. A pane is used as a slot only when the script its parent runs has this hash. The probe's
//   slots mode reads every slot runner, its beacon, memory, heavy-slot, the session count and the
//   machine's input idle; floorOk and pickLaunchTransport judge them.
// - Placement (readPlacement, placementPath): the file the person edits, which the layout script reads too.
// - The trampoline (goStep, goRun, goAnswer, GO_VIA): a final command queued through a command of the plugin's own, whose
//   handler checks again when it is dequeued. It ships as 'direct'.
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

/** A launch's own claim: what a tab's slot runner is told, and compares the lock with. */
export const LAUNCH_CLAIM = /^launch:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Who a claim lock names: a slot runner by its pid and creation time, or one launch by a UUID. */
export const CLAIM_BY = /^(?:slot:\d{1,10}-\d{1,20}|launch:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

/** Every quote PowerShell reads as a single quote: the straight one and the four curly ones. */
const SINGLE_QUOTES = /['\u2018\u2019\u201a\u201b]/g

/** Characters a folder given to a script may not hold: quotes of any kind, control characters, and what Windows refuses in a name. */
const UNSAFE = /["'\u2018\u2019\u201a\u201b\u201c\u201d\u201e<>|?*\u0000-\u001f\u007f-\u009f]/

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
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path)) return 'holds a control character'
  if (/["'\u2018-\u201e]/.test(path)) return 'holds a quote (straight or typographic)'
  if (/[<>|?*/]/.test(path) || path.indexOf(':', 2) !== -1) return 'holds a character Windows does not take in a folder name (< > | ? * / or a second colon)'
  return "has a '.' or '..' part, an empty part, or a part with spaces at either end"
}

/** Why a launch never takes `path` as the conversation's folder, naming the class at fault: folderFault's, or a semicolon. */
export function launchFolderFault(path: unknown): string | undefined {
  return folderFault(path) ?? ((path as string).includes(';') ? 'holds a semicolon (;)' : undefined)
}

/**
 * Why a folder or path never reaches Windows Terminal's command line, naming the class at fault:
 * launchFolderFault's, or a percent sign: WT expands environment variables in a tab's starting directory
 * and its command line, so a folder with % would name another folder than the one checked. A folder
 * that reaches no wt string (a slot's record, a plain window) may hold one.
 */
export function wtFolderFault(path: unknown): string | undefined {
  return launchFolderFault(path) ?? ((path as string).includes('%') ? 'holds a percent sign (%), which Windows Terminal expands' : undefined)
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
  leftLock: { folder: 'left', ending: '.lock', shape: SESSION_ID },
  poke: { folder: 'poke', ending: '.json', shape: SESSION_ID },
  wake: { folder: 'wake', ending: '.json', shape: SESSION_ID },
  pending: { folder: 'pending', ending: '.json', shape: SESSION_ID },
  selfcheck: { folder: 'selfcheck', ending: '.json', shape: SESSION_ID },
  gate: { folder: 'gate', ending: '.json', shape: SESSION_ID },
  refused: { folder: 'refused', ending: '.json', shape: SESSION_ID },
  pane: { folder: 'panes', ending: '.json', shape: PANE_TOKEN },
  paneTicket: { folder: 'panes', ending: '.next.json', shape: PANE_TOKEN },
  slotRecord: { folder: 'slots', ending: '.next.json', shape: SLOT_ID },
  slotBeacon: { folder: 'slots', ending: '.state.json', shape: SLOT_ID },
} as const

/** The kinds of file named by an id. */
export type IdFile = keyof typeof ID_FILES

/** The folders under the state folder whose files are named by an id, each once: what scripts/id-paths.test.mjs scans for. */
export const ID_FOLDERS: readonly string[] = [...new Set(Object.values(ID_FILES).map(file => file.folder))]

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

/** The beacon a slot runner keeps, by the runner's id. Throws on another id. */
export const slotBeaconPath = (state: string, slot: string): string => idPath(state, 'slotBeacon', slot)

/** The one place the slot script is run from, by a tab, a window or the layout: never a path read off a command line (review gap 10). */
export const slotScriptPath = (state: string): string => `${state}\\claude-slot.ps1`

/** The file the person edits: which windows and tabs there are, and where a launch or a restart goes. */
export const placementPath = (state: string): string => `${state}\\placement.json`

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

/**
 * A refused launch's record: `<state>\refused\<conversation>.json`, what a window or a slot runner writes when it
 * refuses after the process that asked for it has gone, so the refusal reaches someone other than that window.
 * `{ v: 1, id, kind: 'resume' | 'start', by, at (milliseconds, a string), folder, why }`. The coordinator reads it;
 * until then a person, by hand (the README says how).
 */
export const refusedPath = (state: string, id: string): string => idPath(state, 'refused', id)

/** A refused record, checked; undefined when it isn't one. Each field is the script's, and this file is trusted no further than its shape. */
export type RefusedRecord = { readonly id: string; readonly kind: 'resume' | 'start'; readonly by: string; readonly at: number; readonly folder: string; readonly why: string }

export function readRefused(text: string): RefusedRecord | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const { v, id, kind, by, at, folder, why } = raw as Record<string, unknown>
  if (v !== 1 || typeof id !== 'string' || !SESSION_ID.test(id) || (kind !== 'resume' && kind !== 'start') || typeof by !== 'string' || typeof at !== 'string' || !/^\d{1,16}$/.test(at) || typeof folder !== 'string' || typeof why !== 'string') return undefined
  return { id, kind, by, at: Number(at), folder, why: oneLine(why, 400) }
}

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
/**
 * What a script's output says, fit to show a person: one line, at most 300 characters. Of a PowerShell error record
 * (the `#< CLIXML` and `<Objs ...>` text Windows PowerShell writes to a redirected error stream, from its first
 * byte) only its message lines are kept, decoded; the record itself never. Empty when nothing is left.
 */
export function plainOutput(text: string): string {
  const cut = text.indexOf('#< CLIXML')
  const kept = (cut === -1 ? text : text.slice(0, cut)).replace(/<Objs\b[\s\S]*$/, '')
  // The error records' own words, where there are any: their message lines, never where in the script it stood.
  const said = cut === -1 ? [] : [...text.slice(cut).matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map(m => clixmlText(m[1] ?? ''))
  const reasons = said.join('\n').split(/\r?\n/).filter(line => line.trim() !== '' && !/^\s*(\+|At line:|At char:|At .+:\d+ char:\d+|~+\s*$)/.test(line))
  return oneLine([kept, ...reasons].filter(part => part.trim() !== '').join(' '), 300)
}

/** A CLIXML string's text: its `_xHHHH_` escapes and XML entities undone. */
const clixmlText = (text: string): string =>
  text
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

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

/**
 * An agent in one of these has ended: `completed`, `failed` or `killed`. Every other status is still to
 * report: `pending`, `running`, `waiting`, `idle` (a teammate between turns, which an exit ends without
 * a word), and any status a later Claude Code adds, so an unknown one holds rather than passes.
 */
export const AGENT_DONE: readonly string[] = ['completed', 'failed', 'killed']

/** Whether an agent of this status is still to report: any status but AGENT_DONE's. */
export const isBusyAgent = (status: string): boolean => !AGENT_DONE.includes(status)

/**
 * An agent in one of these is at its task, and reports on its own once done: `pending`, `running`,
 * `waiting`. Any other that holds (isBusyAgent) may never: an idle teammate, between turns until it is
 * stopped, or a status this code doesn't know (a terminal one a later Claude Code adds among them). It
 * holds all the same, and the hold says how to clear it: TaskStop, or exit by hand.
 */
export const AGENT_AT_WORK: readonly string[] = ['pending', 'running', 'waiting']

/**
 * How long after the SessionStart that named a conversation `$.session.id()` may still read the one
 * before (it lags the event, seen live on 2.1.318): within it, the event's id stands; past it,
 * `$.session.id()` is the conversation, so a disagreement that never resolves holds nothing for good.
 */
export const ID_LAG_MS = 15_000

/**
 * Whether a classic SessionStart of this source moves the process to the conversation it names: a
 * startup, a resume or a clear does. A fork's doesn't (the /fork background copy, a conversation moved
 * to the background: the foreground stays), nor does a compact's or a source not known here. Where a
 * fork's does move the foreground (/branch), idLag sees it: `$.session.id()` reads the fork's id.
 */
export const movesConversation = (source: unknown): boolean => source === 'startup' || source === 'resume' || source === 'clear'

/**
 * How `$.session.id()`, reading `own` at `now`, stands against `named`, the conversation the last
 * moving SessionStart named at `at`:
 * - `agrees`: they are one, or no event has named one;
 * - `lags`: it reads another, at most ID_LAG_MS after the event: the event's id stands;
 * - `stale`: it reads another past that, or the clock reads before the event: `own` is the conversation.
 */
export function idLag(named: string | undefined, at: number | undefined, own: string, now: number): 'agrees' | 'lags' | 'stale' {
  if (named === undefined || named === own) return 'agrees'
  const since = at === undefined ? Number.NaN : now - at
  return since >= 0 && since <= ID_LAG_MS ? 'lags' : 'stale'
}

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
export const SLOT_SCRIPT_SHA256 = 'f90cc3b7c7f14642cc6f7454393fea06ed9ccc814049173f890113b99a7c3e8c'

/**
 * The SHA-256 of plugins/self-switch/slot/claude-layout.ps1, as it is committed: a release pin, tested and
 * printed in the README for the person to compare. Nothing runs that script but the person, by hand.
 */
export const LAYOUT_SCRIPT_SHA256 = '1f3ede07759bb31b53e88bb00d83fa1735f9e05f44cc5849dff349182ccffeef'

/** Input idle for this long before any launch of another process (PM2): a null reading is not idle. */
export const INPUT_IDLE_MS = 60_000

/** A slot takes a launch only once its beacon has said idle for this long. */
export const SLOT_IDLE_MIN_MS = 10_000

/** A launch of another process leaves at least this free (PM5). */
export const FLOOR_MIN_GB = 6

/** The largest running session's private bytes plus this must be free too: heavy-slot's own floor. */
export const HEAVY_FLOOR_GB = 4

/** The largest session, when no claude.exe's private bytes could be read. */
export const LARGEST_UNREAD_GB = 2

/** What the slot runner holds a start to, and a launch's cap, when placement.json names no limits. */
export const LIMITS_DEFAULT = { minFreeGb: 5, maxSessions: 12 } as const

/** The Windows Terminal a flag needs: names, pos and size, and a tab's stamps (it forwards the environment). */
export const WT_MIN = { names: '1.8', pos: '1.17', stamps: '1.19' } as const

/**
 * The SHA-256 of plugins/self-switch/slot/claude-launch.ps1, as it is committed: the only script that
 * starts claude. A window runs it only from launchScriptPath, with this hash, checked by .NET just
 * before it runs. scripts/embed-launch.mjs writes it.
 */
export const LAUNCH_SCRIPT_SHA256 = '1546411d0dd1bb041de9f59e8c5f86bbb1cefcbb630ae3e1bb76e9c1a0892bb5'

/**
 * claude-launch.ps1's version, its `# claude-launch version <n>` line: one more with every change to the
 * script. The copy kept for use by hand (launchHandPath) is replaced only by a higher one, so plugins of
 * two versions never trade it back and forth. scripts/embed-launch.mjs writes it from the script.
 */
export const LAUNCH_SCRIPT_VERSION = 2

/**
 * Where a launch puts claude-launch.ps1 and a window runs it from: beside the slot runner, named by the
 * first 8 hex digits of its SHA-256 (`claude-launch-<sha8>.ps1`), so each version of the plugins has a
 * file of its own and never overwrites another's, however long sessions of two versions run side by
 * side. A slot runner runs it from there too, by the SHA-256 its record or argument names, so a new
 * launcher needs no new runner. Never a path read off a command line. Throws on a `sha` that isn't a SHA-256 in hex.
 */
export function launchScriptPath(state: string, sha: string = LAUNCH_SCRIPT_SHA256): string {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`not a SHA-256: ${JSON.stringify(sha)}`)
  return `${state}\\claude-launch-${sha.slice(0, 8)}.ps1`
}

/**
 * The copy of claude-launch.ps1 kept for use by hand, under the name the README gives: the highest
 * version any launch has put there (LAUNCH_SCRIPT_VERSION). It is the person's alone: a window or a slot
 * runner never runs it, only ever naming it in a line printed for the person.
 */
export const launchHandPath = (state: string): string => `${state}\\claude-launch.ps1`

/** claude-launch.ps1 as this release ships it, byte for byte (ASCII, LF line ends): the copy a launch puts at launchScriptPath when the one there is missing or has another SHA-256. scripts/claude-launch.test.mjs holds it equal to plugins/self-switch/slot/claude-launch.ps1 and to LAUNCH_SCRIPT_SHA256; after an edit to the script, run `node scripts/embed-launch.mjs`. */
export const LAUNCH_SCRIPT_TEXT = [
  "# claude-launch.ps1: starts Claude Code as a top-level session. The one script in",
  "# claude-code-self-tools that runs claude: every launch (a restart's or a switch's window, the",
  "# coordinator's go, a steward's launch, a slot runner's every start, and you by hand) comes through it.",
  "# claude-launch version 2",
  "#",
  "# Part of self-switch (claude-code-self-tools, plugins/self-switch/slot/claude-launch.ps1). Nobody",
  "# copies it: a launch that opens a window puts the copy it carries in %LOCALAPPDATA%\\claude-self-tools,",
  "# as claude-launch-<the first 8 hex digits of its SHA-256>.ps1, one file per version of the plugins,",
  "# and the window runs it from there only when its SHA-256 is the one the plugins ship",
  "# (LAUNCH_SCRIPT_SHA256), checked right before it runs: that is the verified copy. The same launch keeps",
  "# claude-launch.ps1 there, once a first launch has run: the highest version any launch has carried (the",
  "# version line above), for you to run by hand. A slot runner runs the verified copy too, by the SHA-256 its",
  "# record or argument names. A window or a slot runner never runs the copy for use by hand.",
  "#",
  "# By hand, in a terminal:",
  "#   claude-launch.ps1 -Resume <session id> [-Dir <folder>]               resume a conversation",
  "#   claude-launch.ps1 -Start <session id> -Name <name> [-Dir <folder>]   start one with that id and name",
  "#   claude-launch.ps1 -Lane <name>                                        resume a session's current",
  "#                                                                         conversation, by its name",
  "#   claude-launch.ps1 [-Dir <folder>]                                     start a new session",
  "# With -Resume, -Start or -Lane, -ConfigDir <folder>[,<folder>...] names other config folders whose",
  "# session registries the last look reads too (a launch's window names every one it read). With -Resume,",
  "# -LeftSize <bytes> -LeftMtime <ms>, or -LeftExitAt <ms>, is a left record's stat, which the last look",
  "# checks the transcript against (a window passes it when its move rests on a left record).",
  "#",
  "# What it does, in order:",
  "# 1. It checks its arguments: a session id is a lowercase UUID; a name is lowercase letters, digits and",
  "#    hyphens; a folder is an absolute folder of the shape the plugins take (no quote, control character,",
  "#    < > | ? * / or ';', no '.' or '..' part, no empty part, no part with spaces at either end), and is",
  "#    there; an argument given empty refuses. -Lane reads lanes.json in the config folder",
  "#    (CLAUDE_CONFIG_DIR, else %USERPROFILE%\\.claude), takes that name's conversation and folder from its",
  "#    entry, and says which; it never reads a transcript. Anything else stops it, saying why, before it",
  "#    changes anything.",
  "# 2. In Windows PowerShell 5.1, it sets PSModulePath to 5.1's own module folders: in a tab whose",
  "#    environment puts PowerShell 7's first, 5.1 loads 7's modules and loses cmdlets.",
  "# 3. It goes to the folder, and finds claude: %USERPROFILE%\\.local\\bin\\claude.exe when it is there,",
  "#    else the first claude application on PATH.",
  "# 4. The last look, for -Resume, -Lane and -Start, as a launch's window and the claude wrapper take it",
  "#    (RECHECK and LEFT_RECHECK in the plugins' machine code, line for line): no running Claude Code holds",
  "#    the conversation, read again from the session registry of the config folder and of each -ConfigDir,",
  "#    and from every process's command line; with a left record's stat, its transcript unchanged since.",
  "#    Anything it can't read counts as held. Held, it stops, saying by what, and starts nothing: two",
  "#    copies would both write the conversation.",
  "# 5. Right before claude, the launch environment. It removes the variables Claude Code sets in the",
  "#    processes it starts (a claude that inherits them is nested, and saves no transcript), NO_COLOR",
  "#    among them; PSExecutionPolicyPreference (an -ExecutionPolicy on the command line that ran this",
  "#    script was for this script alone); and CLAUDE_PANE_TOKEN (the claude wrapper's token for the tab a",
  "#    session ran in: one resumed here has no tab of its own). It sets",
  "#    CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 and CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1. It never",
  "#    touches WT_SESSION or WT_PROFILE_ID: Claude Code reads WT_SESSION to draw its prompt and its links.",
  "# 6. It runs claude with --resume <id>, or --session-id <id> --name <name>, or nothing else: never a",
  "#    permission flag, so the session starts in the mode a new one would. Its exit code is claude's.",
  "",
  "param([string]$Resume, [string]$Start, [string]$Name, [string]$Dir, [string]$Lane, [string[]]$ConfigDir, [string]$LeftSize, [string]$LeftMtime, [string]$LeftExitAt)",
  "",
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "",
  "$SessionId = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\z'",
  "$AreaName = '^[a-z0-9][a-z0-9-]{0,39}\\z'",
  "$Whole = '^\\d{1,16}\\z'",
  "# The launch environment: LAUNCH_ENV_CLEAR, LAUNCH_ENV_DROP and LAUNCH_ENV_SET in the plugins' machine code.",
  "$Clear = 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_JOB_DIR', 'AI_AGENT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_SSE_PORT', 'NO_COLOR'",
  "$Drop = 'PSExecutionPolicyPreference', 'CLAUDE_PANE_TOKEN'",
  "$Set = [ordered]@{ CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1'; CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP = '1' }",
  "",
  "function Stop-Launch($why) {",
  "  Write-Host ('claude-launch: ' + $why + ' Nothing was started.')",
  "  exit 2",
  "}",
  "",
  "# An absolute folder of the shape the plugins take (isSafeFolder in their machine code): a drive, a",
  "# colon and a backslash first; at most 240 characters; no quote of any kind, control character,",
  "# < > | ? * or /, and no second colon; no '.' or '..' part, no empty part but a last one, and no part",
  "# with spaces at either end.",
  "function Test-Shape($path) {",
  "  if ($path -isnot [string] -or $path.Length -lt 3 -or $path.Length -gt 240) { return $false }",
  "  if ($path -cnotmatch '^[A-Za-z]:\\\\' -or $path -match '[\\x00-\\x1f\\x7f-\\x9f\\x22\\x27\\u2018-\\u201e<>|?*/]' -or $path.IndexOf(':', 2) -ge 0) { return $false }",
  "  $parts = $path.Substring(3).Split('\\')",
  "  for ($i = 0; $i -lt $parts.Count; $i++) {",
  "    if ($parts[$i] -eq '') { if ($i -ne $parts.Count - 1) { return $false } }",
  "    elseif ($parts[$i] -eq '.' -or $parts[$i] -eq '..' -or $parts[$i] -match '^[\\s\\ufeff]|[\\s\\ufeff]$') { return $false }",
  "  }",
  "  return $true",
  "}",
  "",
  "# A folder a launch takes: of that shape, with no ';', and there.",
  "function Test-Folder($path) { return ((Test-Shape $path) -and $path.IndexOf(';') -lt 0 -and (Test-Path -LiteralPath $path -PathType Container)) }",
  "",
  "# Whether a running Claude Code holds conversation $id now: $null when none does, else why. RECHECK in",
  "# the plugins' machine code, line for line: the session registries of $configDirs and every process's",
  "# command line, read again. Anything it can't read counts as held.",
  "function Get-Live($id, $configDirs) {",
  "  try {",
  "    $live = $null",
  "    function Test-Exited($p) { $h = $null; try { $h = [Diagnostics.Process]::GetProcessById([int]$p.ProcessId); return $h.HasExited } catch { return ($_.Exception -is [ArgumentException] -or $_.Exception.InnerException -is [ArgumentException]) } finally { if ($null -ne $h) { $h.Dispose() } } }",
  "    $procs = @{}",
  "    foreach ($p in (Get-CimInstance -ClassName Win32_Process -Property ProcessId, Name, CreationDate, CommandLine)) { $procs[[int]$p.ProcessId] = $p }",
  "    $snapshotFt = [DateTime]::UtcNow.ToFileTimeUtc()",
  "    $elsewhere = @{}",
  "    foreach ($dir in $configDirs) {",
  "      $reg = Join-Path $dir \"sessions\"",
  "      if ($null -ne $live -or -not (Test-Path -LiteralPath $reg -PathType Container)) { continue }",
  "      foreach ($f in @(Get-ChildItem -LiteralPath $reg -Filter \"*.json\" -File -Force)) {",
  "        $p = $null",
  "        if ($f.BaseName -match \"^\\d{1,10}\\z\") { $p = $procs[[int]$f.BaseName] }",
  "        if ($null -eq $p -or $p.Name -ne \"claude.exe\") { continue }",
  "        if (Test-Exited $p) { continue }",
  "        $e = $null",
  "        for ($try = 1; $try -le 3 -and $null -eq $e; $try++) {",
  "          try { $e = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $e = $null }",
  "          if ($null -ne $e -and ($e.sessionId -isnot [string] -or $null -eq $e.procStart)) { $e = $null }",
  "          if ($null -eq $e -and $try -lt 3) { Start-Sleep -Milliseconds 250 }",
  "        }",
  "        if ($null -eq $e) { $live = \"whether it is open elsewhere is unknown: the registry file of Claude Code $($f.BaseName) could not be read, three times, or has another shape\"; break }",
  "        $near = $false",
  "        try { $near = [math]::Abs([double]$p.CreationDate.ToFileTimeUtc() - [double]$e.procStart) -le 10000 } catch { $near = $false }",
  "        if ($e.sessionId -eq $id) {",
  "          if ($near) { $live = \"it is open elsewhere: Claude Code $($f.BaseName) holds it (L1)\" } else { $live = \"it may be open elsewhere: the registry file of running Claude Code $($f.BaseName) names it, though its procStart is not that process start time (a stale file, or a format this check does not know)\" }",
  "          break",
  "        }",
  "        $named = $false",
  "        foreach ($prop in $e.PSObject.Properties) { if ($prop.Name -cne \"sessionId\" -and $prop.Name -cne \"cwd\" -and $prop.Name -cne \"name\" -and \"$(ConvertTo-Json -InputObject $prop.Value -Compress -Depth 8)\".IndexOf($id, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $named = $true } }",
  "        if ($named) { $live = \"it may be open elsewhere: the registry file of running Claude Code $($f.BaseName) names it outside its sessionId\"; break }",
  "        $pidOk = $false",
  "        try { $pidOk = [long]$e.pid -eq [long]$p.ProcessId } catch { $pidOk = $false }",
  "        if ($near -and $pidOk -and ($snapshotFt - [long]$p.CreationDate.ToFileTimeUtc()) -gt 600000000 -and $e.sessionId -match \"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\z\") { $elsewhere[[int]$p.ProcessId] = $true }",
  "      }",
  "    }",
  "    if ($null -eq $live) { foreach ($p in $procs.Values) { if ($null -eq $live -and $p.ProcessId -ne $PID -and -not $elsewhere.ContainsKey([int]$p.ProcessId) -and \"$($p.CommandLine)\" -match \"(^|[\\s\\x22])(--resume|--session-id|-r)(\\s+|=)[\\x22\\x27]?$id\" -and -not (Test-Exited $p)) { $live = \"it is open elsewhere: process $($p.ProcessId) names it on its command line (L2)\" } } }",
  "  } catch { $live = 'whether it is open elsewhere is unknown: the registry or the process table could not be read (' + $_.Exception.Message + ')' }",
  "  return $live",
  "}",
  "",
  "# Whether conversation $id's transcript changed since its left record's stat: $null when it didn't,",
  "# else why. LEFT_RECHECK in the plugins' machine code, line for line, after Get-Live found nothing.",
  "# Anything it can't read counts as changed.",
  "function Test-Left($id, $configDirs, $leftSize, $leftMtime, $leftExitAt) {",
  "  $live = $null",
  "  try {",
  "    if ($null -eq $live) {",
  "      $seen = @(foreach ($dir in $configDirs) { $projects = Join-Path $dir \"projects\"; if (Test-Path -LiteralPath $projects -PathType Container) { foreach ($d in @(Get-ChildItem -LiteralPath $projects -Directory -Force)) { $tx = Join-Path $d.FullName ($id + \".jsonl\"); if (Test-Path -LiteralPath $tx -PathType Leaf) { Get-Item -LiteralPath $tx -Force } } } })",
  "      if ($seen.Count -ne 1) { $live = \"its transcript is not one file on this machine now (\" + $seen.Count + \" found), so whether it changed since it was left is unknown\" }",
  "      elseif ($null -ne $leftExitAt) { if (([DateTimeOffset]$seen[0].LastWriteTimeUtc).ToUnixTimeMilliseconds() -gt ([long]$leftExitAt + 10000)) { $live = \"its transcript was written after it was left (another process may have resumed it)\" } }",
  "      elseif ([long]$seen[0].Length -ne [long]$leftSize -or ([DateTimeOffset]$seen[0].LastWriteTimeUtc).ToUnixTimeMilliseconds() -ne [long]$leftMtime) { $live = \"its transcript changed since it was left (another process may have resumed it)\" }",
  "    }",
  "  } catch { $live = 'whether its transcript changed since it was left is unknown (' + $_.Exception.Message + ')' }",
  "  return $live",
  "}",
  "",
  "# 1. The arguments, each checked before anything changes.",
  "foreach ($k in 'Resume', 'Start', 'Name', 'Dir', 'Lane', 'LeftSize', 'LeftMtime', 'LeftExitAt') {",
  "  if ($PSBoundParameters.ContainsKey($k) -and [string]::IsNullOrEmpty($PSBoundParameters[$k])) { Stop-Launch ('-' + $k + ' was given empty.') }",
  "}",
  "$modes = 0",
  "foreach ($given in $Resume, $Start, $Lane) { if ($given) { $modes++ } }",
  "if ($modes -gt 1) { Stop-Launch 'give one of -Resume, -Start and -Lane.' }",
  "if ($Name -and -not $Start) { Stop-Launch '-Name goes with -Start.' }",
  "if ($PSBoundParameters.ContainsKey('ConfigDir')) {",
  "  if ($modes -eq 0) { Stop-Launch '-ConfigDir goes with -Resume, -Start or -Lane.' }",
  "  if (@($ConfigDir).Count -lt 1 -or @($ConfigDir).Count -gt 8) { Stop-Launch '-ConfigDir takes 1 to 8 config folders.' }",
  "  foreach ($c in @($ConfigDir)) { if (-not (Test-Shape $c)) { Stop-Launch '-ConfigDir takes absolute folders, with no quote, control character, < > | ? * or /, and no . or .. part.' } }",
  "}",
  "$leftGiven = [bool]($LeftSize -or $LeftMtime -or $LeftExitAt)",
  "if ($leftGiven) {",
  "  if (-not $Resume) { Stop-Launch 'a left record''s stat goes with -Resume.' }",
  "  if ($LeftExitAt) { if ($LeftSize -or $LeftMtime -or $LeftExitAt -cnotmatch $Whole) { Stop-Launch '-LeftExitAt goes alone, a whole number.' } }",
  "  elseif (-not $LeftSize -or -not $LeftMtime -or $LeftSize -cnotmatch $Whole -or $LeftMtime -cnotmatch $Whole) { Stop-Launch '-LeftSize and -LeftMtime go together, whole numbers.' }",
  "}",
  "$config = $null",
  "if ($env:CLAUDE_CONFIG_DIR) { $config = $env:CLAUDE_CONFIG_DIR } elseif ($env:USERPROFILE) { $config = Join-Path $env:USERPROFILE '.claude' }",
  "if ($Lane) {",
  "  if ($Dir) { Stop-Launch '-Lane takes its folder from lanes.json: give no -Dir.' }",
  "  if ($Lane -cnotmatch $AreaName) { Stop-Launch 'a session name is lowercase letters, digits and hyphens.' }",
  "  if ($null -eq $config) { Stop-Launch 'no config folder is known here (CLAUDE_CONFIG_DIR, else %USERPROFILE%\\.claude).' }",
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
  "  # The conversation and its folder come from the entry, never from the name; said, so you know which.",
  "  $Resume = $entry.session",
  "  $Dir = $entry.folder",
  "  Write-Host ('claude-launch: -Lane ' + $Lane + ' is conversation ' + $Resume + ', in ' + $Dir + '.')",
  "}",
  "if ($Resume -and $Resume -cnotmatch $SessionId) { Stop-Launch '-Resume takes a session id (a lowercase UUID).' }",
  "if ($Start) {",
  "  if ($Start -cnotmatch $SessionId) { Stop-Launch '-Start takes a session id (a lowercase UUID).' }",
  "  if (-not $Name -or $Name -cnotmatch $AreaName) { Stop-Launch '-Start takes -Name: lowercase letters, digits and hyphens.' }",
  "}",
  "if ($Dir -and -not (Test-Folder $Dir)) { Stop-Launch '-Dir takes an absolute folder that is there, with no quote, control character, semicolon, < > | ? * or /, and no . or .. part.' }",
  "# The config folders the last look reads: this one first, then each -ConfigDir, each once.",
  "$lookIn = @()",
  "if ($Resume -or $Start) {",
  "  if (-not (Test-Shape $config)) { Stop-Launch 'the config folder (CLAUDE_CONFIG_DIR, else %USERPROFILE%\\.claude) is not an absolute folder the last look can read.' }",
  "  foreach ($c in @($config) + @($ConfigDir | Where-Object { $null -ne $_ })) {",
  "    $plain = $c",
  "    if ($plain.Length -gt 3) { $plain = $plain.TrimEnd([char]92) }",
  "    if (@($lookIn | Where-Object { $_ -ieq $plain }).Count -eq 0) { $lookIn += $plain }",
  "  }",
  "}",
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
  "# 4. The last look, right before the environment and claude.",
  "if ($Resume -or $Start) {",
  "  $lookId = $Resume",
  "  if ($Start) { $lookId = $Start }",
  "  $why = Get-Live $lookId $lookIn",
  "  if ($null -eq $why -and $leftGiven) {",
  "    $size = $null; $mtime = $null; $exitAt = $null",
  "    if ($LeftExitAt) { $exitAt = [long]$LeftExitAt } else { $size = [long]$LeftSize; $mtime = [long]$LeftMtime }",
  "    $why = Test-Left $lookId $lookIn $size $mtime $exitAt",
  "  }",
  "  if ($null -ne $why) { Stop-Launch ('conversation ' + $lookId + ' is not run here, so that two copies never write it: ' + $why + '.') }",
  "}",
  "",
  "# 5. The launch environment, right before claude. Removed, not set to empty: [NullString]::Value, since",
  "# PowerShell passes $null to a .NET string as \"\", and PowerShell 7 keeps a variable set to \"\".",
  "foreach ($n in $Clear) { [Environment]::SetEnvironmentVariable($n, [NullString]::Value, [EnvironmentVariableTarget]::Process) }",
  "foreach ($n in $Drop) { [Environment]::SetEnvironmentVariable($n, [NullString]::Value, [EnvironmentVariableTarget]::Process) }",
  "foreach ($n in $Set.Keys) { [Environment]::SetEnvironmentVariable($n, $Set[$n], [EnvironmentVariableTarget]::Process) }",
  "",
  "# 6. claude, and its exit code.",
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
 * no colour. claude-launch.ps1 clears these (LAUNCH_ENV_CLEAR), and no other; the claude wrapper and the
 * layout script keep the same list (it is the person's own `claude`, and its tabs start idle). Never one a person sets otherwise; never
 * CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP (LAUNCH_ENV_SET keeps it on: the owner's choice); never
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
 * memory-pressure reap kept off (the owner's choice, 2026-11-04: the page file carries the load).
 */
export const LAUNCH_ENV_SET: Readonly<Record<string, string>> = {
  CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1',
  CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP: '1',
}

/**
 * Removed by claude-launch.ps1 as well, after LAUNCH_ENV_CLEAR (the slot runner, which runs it in its own
 * process, puts the first back for its next run): PSExecutionPolicyPreference (an -ExecutionPolicy on
 * the command line that ran the launcher was for it alone), and CLAUDE_PANE_TOKEN (the claude wrapper's
 * token for the tab a session ran in, which every process under that claude inherits: a session resumed
 * in a window or a slot has no tab of its own, and an inherited token would point its later restarts at
 * that tab's pane file).
 */
export const LAUNCH_ENV_DROP: readonly string[] = ['PSExecutionPolicyPreference', 'CLAUDE_PANE_TOKEN']

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

/** A left record this recent, of the same id, how and process, is the same move: a second writer takes it as written (leftScript). */
export const LEFT_SAME_MOVE_MS = 30_000

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
  '$slotStale = $false',
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
  // The file's hash says what a new run would be, not what this process runs: left with Ctrl+C it reads no
  // record, and started before a newer copy it runs older code. Its own beacon, by its id, says both.
  '  if ($slotOk) {',
  '    $slotLook = $null',
  '    if ($null -ne $state) { try { $slotLook = Get-Beacon ([IO.File]::ReadAllText((Join-Path $state ("slots\\" + $slot["id"] + ".state.json")), [Text.Encoding]::UTF8) | ConvertFrom-Json) } catch { $slotLook = $null } }',
  `    if ($null -eq $slotLook -or $slotLook["sha256"] -cne '${SLOT_SCRIPT_SHA256}') { $slotOk = $false; $slotStale = $true }`,
  '  }',
  '  $slot["live"] = $slotOk',
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
  // A process the lock was re-owned to (relockScript): the lock stands while it runs, whoever made it.
  '    if ($null -ne $old -and $null -ne $old.holder -and $old.holder.pid -is [ValueType] -and "$($old.holder.created)" -match "^\\d{1,20}\\z") {',
  '      $holds = $table[[int]$old.holder.pid]',
  `      if ($null -ne $holds -and $null -ne $holds.CreationDate -and [math]::Abs([long]$holds.CreationDate.ToFileTimeUtc() - [long]"$($old.holder.created)") -le ${PROC_START_TOLERANCE}) { $over = $false }`,
  '    }',
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
/**
 * Whether a process of the table has exited, by asking it: one that has can still be listed for a moment after
 * its exit code reads. Anything but "no such process" that can't be read counts as still there. Needs `$p.ProcessId`.
 */
export const TEST_EXITED = 'function Test-Exited($p) { $h = $null; try { $h = [Diagnostics.Process]::GetProcessById([int]$p.ProcessId); return $h.HasExited } catch { return ($_.Exception -is [ArgumentException] -or $_.Exception.InnerException -is [ArgumentException]) } finally { if ($null -ne $h) { $h.Dispose() } } }'

export const RECHECK = [
  '$live = $null',
  TEST_EXITED,
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

/** The one folder, under the temp folder, every test stub claude.exe runs from (scripts/stub.mjs): what Get-Aside passes over. */
export const TEST_STUB_FOLDER = 'claude-self-tools-test-stubs'

/**
 * Get-Aside: a claude.exe that holds no conversation and has no registry entry, though it is no Claude Code
 * command: Claude Code's own daemon (`daemon ...`) and the pty host of a background session (`--bg-pty-host`),
 * which /fork and /background start, and a test stub, by its folder (TEST_STUB_FOLDER under the temp folder).
 * Liveness counts it as accounted, so that none refuses every switch on the machine while it runs; the session
 * count and the floor still count it. A second real install, or one under another config folder, is what the
 * unaccounted rule guards against, and stays unaccounted: only these three are passed over. Only the answer
 * leaves the script. Needs ExecutablePath in the table.
 */
export const GET_ASIDE = [
  'function Get-Aside($p) {',
  '  if ("$($p.Name)".ToLowerInvariant() -ne "claude.exe") { return $false }',
  `  if ("$($p.ExecutablePath)".StartsWith([IO.Path]::GetTempPath() + '${TEST_STUB_FOLDER}\\', [StringComparison]::OrdinalIgnoreCase)) { return $true }`,
  String.raw`  if ("$($p.CommandLine)" -notmatch '^\s*("[^"]*"|\S+)\s*(?<rest>.*)$') { return $false }`,
  String.raw`  return ($Matches["rest"] -match '^(daemon|--bg-pty-host)(\s|$)')`,
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
  '    $again = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $([int]$b.ProcessId)" -Property ProcessId, ParentProcessId, Name, CreationDate, CommandLine, ExecutablePath',
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

/**
 * The machine's input idle, by GetLastInputInfo (Add-Type: a plugin's child reads the session's desktop):
 * `$inputIdleSec`, whole seconds, or $null when it can't be read, which no launch takes as idle.
 */
const READ_INPUT_IDLE = [
  '$inputIdleSec = $null',
  'try {',
  `  Add-Type -ErrorAction Stop -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ClaudeSelfToolsInput { [StructLayout(LayoutKind.Sequential)] struct Last { public uint cbSize; public uint dwTime; } [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref Last last); public static long IdleMs() { Last last = new Last(); last.cbSize = (uint)Marshal.SizeOf(typeof(Last)); if (!GetLastInputInfo(ref last)) return -1; return unchecked((uint)Environment.TickCount - last.dwTime); } }'`,
  '  $idleMs = [ClaudeSelfToolsInput]::IdleMs()',
  '  if ($idleMs -ge 0) { $inputIdleSec = [long][math]::Floor($idleMs / 1000) }',
  '} catch { $inputIdleSec = $null }',
]

/** A heavy-slot ticket or holder older than this is stale, as heavy-slot.sh's HEAVY_SLOT_STALE_SECS says. */
const HEAVY_STALE_SECS = 3600

/**
 * heavy-slot's state, from its folders under `$heavyRoot`, by PowerShell alone (never bash, never MSYS):
 * `$heavyWaiters`, the live tickets in .gate-queue, and `$heavyBusy`, the slots held (0 to 2). A ticket
 * names its waiter by an MSYS pid, which Windows can't look up: it counts while a heavy-slot shell runs at
 * all (the process table) and it is under an hour old, so a ticket a dead waiter left holds a launch only
 * while another job runs, which clears it. A slot counts as held while the Windows pid it names runs, or,
 * with none named, while it is under an hour old. Needs `$table`; throws when the folders can't be read, and
 * when `$heavyRoot` is no folder (a typo, a drive not mounted yet): nothing found there is not nothing waiting.
 */
const READ_HEAVY = [
  'if (-not (Test-Path -LiteralPath $heavyRoot -PathType Container)) { throw ("no folder at " + $heavyRoot) }',
  '$heavyWaiters = 0',
  '$heavyBusy = 0',
  String.raw`$heavyShells = @($table.Values | Where-Object { "$($_.CommandLine)" -match "heavy-slot\.sh" }).Count`,
  '$heavyNow = [DateTime]::UtcNow',
  '$heavyQueue = Join-Path $heavyRoot ".gate-queue"',
  `if ($heavyShells -gt 0 -and (Test-Path -LiteralPath $heavyQueue -PathType Container)) { foreach ($t in @(Get-ChildItem -LiteralPath $heavyQueue -File -Force)) { if ($t.Name -match "^\\d+-\\d+\\z" -and ($heavyNow - $t.LastWriteTimeUtc).TotalSeconds -lt ${HEAVY_STALE_SECS}) { $heavyWaiters++ } } }`,
  'foreach ($s in ".gate-lock", ".gate-lock-2") {',
  '  $d = Join-Path $heavyRoot $s',
  '  if (-not (Test-Path -LiteralPath $d -PathType Container)) { continue }',
  '  $wf = Join-Path $d "winpid"',
  '  $w = $null',
  String.raw`  if (Test-Path -LiteralPath $wf -PathType Leaf) { $w = "$(Get-Content -LiteralPath $wf -Raw)".Trim(); if ($w -notmatch "^\d{1,10}\z") { $w = $null } }`,
  `  if ($null -ne $w) { if ($null -ne $table[[int]$w]) { $heavyBusy++ } } elseif (($heavyNow - [IO.Directory]::GetLastWriteTimeUtc($d)).TotalSeconds -lt ${HEAVY_STALE_SECS}) { $heavyBusy++ }`,
  '}',
]

/**
 * The sessions running: every claude.exe but one running a Claude Code command (Get-Cli), and but one
 * another claude.exe started (a helper of its own, or what a command started). `$room`. Needs `$table`,
 * Get-Parent and Get-Cli.
 */
const COUNT_SESSIONS = [
  '$room = 0',
  TEST_EXITED,
  // A claude.exe that has exited and is on its way out of the table is no session: it would refuse at the cap for nothing.
  'foreach ($p in @($table.Values)) { if ($p.Name -ne "claude.exe" -or (Get-Cli $p) -or (Test-Exited $p)) { continue }; $above = Get-Parent $p; if ($null -ne $above -and $above.Name -eq "claude.exe") { continue }; $room++ }',
]

/** The fields of a beacon a reader takes, each checked; `$null` for one not of its shape. */
const GET_BEACON = [
  'function Get-Beacon($b) {',
  '  if ($b -isnot [Management.Automation.PSCustomObject] -or $b.v -isnot [ValueType] -or $b.v -ne 1) { return $null }',
  '  if (($b.state -cne "idle" -and $b.state -cne "running") -or $b.since -isnot [ValueType] -or $b.configDir -isnot [string] -or $b.configDir.Length -gt 240) { return $null }',
  '  $o = [ordered]@{ state = $b.state; since = [long]$b.since; configDir = $b.configDir }',
  String.raw`  if ($b.window -is [string] -and $b.window -cmatch "^[A-Za-z0-9_-]{1,40}\z") { $o["window"] = $b.window }`,
  String.raw`  if ($b.tab -is [string] -and $b.tab -cmatch "^[A-Za-z0-9 ._-]{1,40}\z") { $o["tab"] = $b.tab }`,
  String.raw`  if ($b.sha256 -is [string] -and $b.sha256 -cmatch "^[0-9a-f]{64}\z") { $o["sha256"] = $b.sha256 }`,
  '  return $o',
  '}',
]

/**
 * Every slot runner on the machine: each powershell.exe whose command line runs `-File <absolute>\claude-slot.ps1`
 * (its path stays here, read to be hashed, one .NET SHA-256 per distinct path), with its id, the claude.exe
 * it runs now, and its beacon, read only for a runner found running, by its own pid and creation time, so
 * a closed tab's beacon is never read. `$slotsOut`. Needs `$table`, `$state`, Get-Created, Get-Parent,
 * Get-Sha256 and Get-Beacon.
 */
const READ_SLOTS = [
  '$slotsOut = New-Object System.Collections.ArrayList',
  '$hashes = @{}',
  '$childOf = @{}',
  'foreach ($p in @($table.Values)) { if ($p.Name -eq "claude.exe") { $above = Get-Parent $p; if ($null -ne $above) { $childOf[[int]$above.ProcessId] = [long]$p.ProcessId } } }',
  'foreach ($p in @($table.Values)) {',
  String.raw`  if ($p.Name -ne "powershell.exe" -or "$($p.CommandLine)" -notmatch "-File\s+(\x22?)(?<path>[A-Za-z]:\\[^\x22]*?\\claude-slot\.ps1)\1(\s|\z)") { continue }`,
  '  $slotPath = $Matches["path"]',
  '  if (-not $hashes.ContainsKey($slotPath)) { $slotHash = $null; try { $slotHash = Get-Sha256 $slotPath } catch { $slotHash = $null }; $hashes[$slotPath] = $slotHash }',
  '  $runnerCreated = Get-Created $p',
  '  $runnerId = "$($p.ProcessId)-$runnerCreated"',
  '  $runnerChild = $null',
  '  if ($childOf.ContainsKey([int]$p.ProcessId)) { $runnerChild = $childOf[[int]$p.ProcessId] }',
  '  $beacon = $null',
  '  if ($null -ne $state) { try { $beaconFile = Join-Path $state ("slots\\" + $runnerId + ".state.json"); if (Test-Path -LiteralPath $beaconFile -PathType Leaf) { $beacon = Get-Beacon ([IO.File]::ReadAllText($beaconFile, [Text.Encoding]::UTF8) | ConvertFrom-Json) } } catch { $beacon = $null } }',
  '  [void]$slotsOut.Add([ordered]@{ pid = [long]$p.ProcessId; created = $runnerCreated; id = $runnerId; sha256 = $hashes[$slotPath]; child = $runnerChild; beacon = $beacon })',
  '}',
]

/**
 * The claude.exe that hold a claim lock (relockScript: a launch stuck at a dialog keeps it, review gap 7):
 * for every lock on the machine, its `holder`, when that process runs with that start. `$holdersOut`, each
 * `{ id, pid, created }`. Needs `$table`, `$state`, `$errors` and Get-Created.
 */
const READ_HOLDERS = [
  '$holdersOut = New-Object System.Collections.ArrayList',
  'if ($null -ne $state) { try {',
  '  $claims = Join-Path $state "claims"',
  '  if (Test-Path -LiteralPath $claims -PathType Container) { foreach ($f in @(Get-ChildItem -LiteralPath $claims -Filter "*.lock" -File -Force)) {',
  String.raw`    if ($f.BaseName -cnotmatch "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z") { continue }`,
  '    $l = $null',
  '    try { $l = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { $l = $null }',
  String.raw`    if ($null -eq $l -or $null -eq $l.holder -or $l.holder.pid -isnot [ValueType] -or "$($l.holder.created)" -notmatch "^\d{1,20}\z") { continue }`,
  '    $held = $table[[int]$l.holder.pid]',
  `    if ($null -ne $held -and $held.Name -eq "claude.exe" -and [math]::Abs([long](Get-Created $held) - [long]"$($l.holder.created)") -le ${PROC_START_TOLERANCE}) { [void]$holdersOut.Add([ordered]@{ id = $f.BaseName; pid = [long]$held.ProcessId; created = (Get-Created $held) }) }`,
  '  } }',
  '} catch { [void]$errors.Add("locks:") } }',
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
  /** The folder holding heavy-slot.sh's .gate-lock folders; null: this machine has none. Required with `slots`, whose answer says which it was (`heavyChecked`). */
  readonly heavySlotRoot?: string | null
  /** Read the left record of each asked-about conversation (needs `stateDir`), its MAC checked inside the script. */
  readonly left?: boolean
  /**
   * The steward's reading of the machine: every slot runner and its beacon, each claude.exe's private
   * bytes, heavy-slot's waiters and busy slots, the sessions running, the input idle, and every claim
   * lock's holder. Never a command line, a cwd or a name. Without it, the answer is as it always was.
   */
  readonly slots?: boolean
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
  if (input.slots === true && input.heavySlotRoot === undefined) throw new Error('the slots mode names its heavy-slot folder (null: this machine has none): heavySlotRoot')
  const ids = input.ids.map(checkId)
  if (ids.length < 1 || ids.length > 8) throw new Error('the probe asks about 1 to 8 conversations')
  const take = input.take === undefined ? undefined : checkId(input.take)
  if (take !== undefined && !ids.includes(take)) throw new Error('the probe claims only a conversation it asks about')
  if (input.configDirs.length > 8) throw new Error('the probe reads at most 8 config folders')
  const configDirs = input.configDirs.map(dir => checkFolder('a config folder', dir))
  const state = input.stateDir === undefined ? undefined : checkFolder('the state folder', input.stateDir)
  if (take !== undefined && state === undefined) throw new Error('the probe claims only with the state folder')
  const heavy = input.heavySlotRoot === undefined || input.heavySlotRoot === null ? undefined : checkFolder('the heavy-slot folder', input.heavySlotRoot)
  if (input.left === true && state === undefined) throw new Error('the probe reads left records only with the state folder')
  // Each asked-about conversation's left record, its path built here from the checked id.
  const leftRead = input.left === true && state !== undefined ? leftReadLines(state, ids) : []
  const slots = input.slots === true
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
    `foreach ($p in (Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate, CommandLine, ExecutablePath${slots ? ', PrivatePageCount' : ''})) { $table[[int]$p.ProcessId] = $p }`,
    ...READ_BLANK_AGAIN,
    ...GET_PARENT,
    ...GET_CREATED,
    ...GET_CLASS,
    ...GET_CLI,
    ...GET_ASIDE,
    ...GET_BEACON,
    ...(slots ? GET_SHA256 : []),
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
    '  if (Get-Aside $p) { $o["aside"] = $true }',
    ...(slots ? ['  if ($p.Name -eq "claude.exe" -and $null -ne $p.PrivatePageCount) { $o["privateBytes"] = [long]$p.PrivatePageCount }'] : []),
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
    ...(slots
      ? [
          ...READ_SLOTS,
          '$heavyWaiters = $null',
          '$heavyBusy = $null',
          'if ($null -ne $heavyRoot) { try {',
          ...READ_HEAVY.map(line => `  ${line}`),
          '} catch { $heavyWaiters = $null; $heavyBusy = $null; if (-not $errors.Contains("heavy:")) { [void]$errors.Add("heavy:") } } }',
          ...COUNT_SESSIONS,
          ...READ_INPUT_IDLE,
          ...READ_HOLDERS,
        ]
      : []),
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
    String.raw`      if ($null -ne $l.holder -and $l.holder.pid -is [ValueType] -and "$($l.holder.created)" -match "^\d{1,20}\z") { $o["holder"] = [ordered]@{ pid = [long]$l.holder.pid; created = "$($l.holder.created)" } }`,
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
    ...(slots ? ['$result["heavyChecked"] = ($null -ne $heavyRoot)', '$result["slots"] = $slotsOut', '$result["heavyWaiters"] = $heavyWaiters', '$result["heavyBusy"] = $heavyBusy', '$result["room"] = $room', '$result["inputIdleSec"] = $inputIdleSec', '$result["holders"] = $holdersOut'] : []),
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
  /** `aside`: a claude.exe of Claude Code's own /fork or /background machinery, or a test stub (Get-Aside): no registry entry, none needed. */
  readonly aside?: true
  /** A claude.exe's private bytes (Win32_Process.PrivatePageCount), from a probe in slots mode. */
  readonly privateBytes?: number
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

/** `holder`: the process the lock was re-owned to (relockScript): it isn't stale while that one runs. */
export type LockEntry =
  | { readonly id: string; readonly mtime: number; readonly ok: true; readonly by: string; readonly pid: number; readonly created: string; readonly at: number; readonly transport: string; readonly holder?: ProcessRef }
  | { readonly id: string; readonly mtime: number; readonly ok: false }

/** A slot runner's beacon, each field checked: idle or running, since when, its stamp when it has one, and its config folder. */
export type SlotBeacon = { readonly state: 'idle' | 'running'; readonly since: number; readonly window?: string; readonly tab?: string; readonly configDir: string; readonly sha256?: string }

/** A slot runner found running: its pid and creation FILETIME, its id, its script's hash, the claude.exe it runs now, and its beacon. */
export type SlotRunner = { readonly pid: number; readonly created: string; readonly id: string; readonly sha256: string | null; readonly child: number | null; readonly beacon: SlotBeacon | null }

/** A claude.exe a claim lock names as its holder, running with that start: it holds that lock's id. */
export type LockHolder = { readonly id: string; readonly pid: number; readonly created: string }

export type ClaimResult = { readonly id: string; readonly taken: true; readonly by: string } | { readonly id: string; readonly taken: false; readonly why: string }

/** The slot runner: its pid, its creation FILETIME and its id (`<pid>-<created>`) as exact strings, its script and that script's hash. */
export type SlotParent = { readonly pid: number; readonly created: string; readonly id: string; readonly path: string; readonly sha256: string | null; readonly hashError?: string; readonly live?: boolean }

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
  /** Every slot runner found running, from a probe in slots mode; null from any other. */
  readonly slots: readonly SlotRunner[] | null
  /** heavy-slot's live waiters and busy slots (0 to 2); null with no heavy-slot folder, or none read. */
  readonly heavyWaiters: number | null
  readonly heavyBusy: number | null
  /** Slots mode: whether heavy-slot's folders were read (true), or the caller named none on this machine (false). */
  readonly heavyChecked?: boolean
  /** The sessions running (a Claude Code command left out), from a probe in slots mode. */
  readonly room: number | null
  /** Whole seconds since the machine's last input; null when unread, which no launch takes as idle. */
  readonly inputIdleSec: number | null
  /** Each claude.exe holding a claim lock, on any conversation, from a probe in slots mode. */
  readonly holders: readonly LockHolder[] | null
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

/** A beacon as the probe printed it, checked; null for one not of its shape, which counts as none: no launch picks that slot. */
function slotBeacon(value: unknown): SlotBeacon | null {
  if (!isRecord(value)) return null
  for (const key of Object.keys(value)) if (!['state', 'since', 'window', 'tab', 'configDir', 'sha256'].includes(key)) return null
  const { state, since, window, tab, configDir, sha256 } = value
  if ((state !== 'idle' && state !== 'running') || !isCount(since) || !isSafeFolder(configDir)) return null
  if (window !== undefined && !isWindowName(window)) return null
  if (tab !== undefined && (typeof tab !== 'string' || !TAB_LABEL.test(tab))) return null
  if (sha256 !== undefined && (typeof sha256 !== 'string' || !SHA256.test(sha256))) return null
  return { state, since, configDir, ...(window === undefined ? {} : { window: window as string }), ...(tab === undefined ? {} : { tab: tab as string }), ...(sha256 === undefined ? {} : { sha256: sha256 as string }) }
}

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
    const top = fields(raw, 'the answer', ['v', 'self', 'session', 'slot', 'procs', 'registry', 'transcripts', 'locks', 'claim', 'heavy', 'freeKb', 'errors'], ['slotSeen', 'left', 'slots', 'heavyChecked', 'heavyWaiters', 'heavyBusy', 'room', 'inputIdleSec', 'holders'])
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
      const s = fields(top.slot, 'the slot', ['pid', 'created', 'id', 'path', 'sha256'], ['hashError', 'live'])
      if ('live' in s && typeof s.live !== 'boolean') bad("the slot's live is not true or false")
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
        ...(typeof s.live === 'boolean' ? { live: s.live } : {}),
      }
    }
    const procs = list(top.procs, 'the processes').map((value): ProcessEntry => {
      const p = fields(value, 'a process', ['pid', 'ppid', 'created', 'name'], ['cls', 'ids', 'cli', 'aside', 'privateBytes'])
      if ('privateBytes' in p && !isCount(p.privateBytes)) bad("a process's private bytes are not a number")
      if ('cli' in p && (p.cli !== true || typeof p.name !== 'string' || p.name.toLowerCase() !== 'claude.exe')) bad('a process is a Claude Code command but not a claude.exe')
      if ('aside' in p && (p.aside !== true || typeof p.name !== 'string' || p.name.toLowerCase() !== 'claude.exe')) bad("a process is set aside but not a claude.exe")
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
        ...(p.aside === true ? { aside: true as const } : {}),
        ...('privateBytes' in p ? { privateBytes: p.privateBytes as number } : {}),
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
      const l = fields(value, 'a lock', ['id', 'mtime', 'ok'], ['by', 'pid', 'created', 'at', 'transport', 'holder'])
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
      let holder: ProcessRef | undefined
      if ('holder' in l) {
        const h = fields(l.holder, "a lock's holder", ['pid', 'created'])
        if (!isPid(h.pid) || !isTicks(h.created)) bad("a lock's holder is not a pid and a time as a string")
        holder = { pid: h.pid as number, created: h.created as string }
      }
      return { id, mtime, ok: true, by: l.by as string, pid: l.pid as number, created: l.created as string, at: l.at as number, transport: l.transport as string, ...(holder === undefined ? {} : { holder }) }
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
    if (typeof top.heavyChecked === 'boolean' && top.heavyChecked !== (heavy !== null)) bad('the answer says whether heavy-slot was read, and its heavy slots say otherwise')
    if (top.freeKb !== null && !isCount(top.freeKb)) bad('free memory is not a number')
    const errors = list(top.errors, 'the errors').map(value => {
      const m = typeof value === 'string' ? /^(registry|transcripts|locks|heavy|memory|left):(\d?)$/.exec(value) : null
      if (m === null) return bad('an error is not one of the fixed list')
      return m[2] === '' ? { source: m[1] as ProbeError } : { source: m[1] as ProbeError, dir: Number(m[2]) }
    })
    const extraKeys = [...new Set(registry.flatMap(entry => (entry.shape === 'ok' ? entry.extra : [])))]
    const left = 'left' in top ? list(top.left, 'the left records').map(leftEntry) : null
    const slots =
      'slots' in top
        ? list(top.slots, 'the slot runners').map((value): SlotRunner => {
            const s = fields(value, 'a slot runner', ['pid', 'created', 'id', 'sha256', 'child', 'beacon'])
            if (!isPid(s.pid) || !isTicks(s.created)) bad('a slot runner is not a pid and a time as a string')
            if (s.id !== `${s.pid}-${s.created}`) bad("a slot runner's id is not its pid and time")
            if (s.sha256 !== null && (typeof s.sha256 !== 'string' || !SHA256.test(s.sha256))) bad("a slot runner's hash is not a SHA-256")
            if (s.child !== null && !isPid(s.child)) bad("a slot runner's child is not a pid")
            return { pid: s.pid as number, created: s.created as string, id: s.id as string, sha256: s.sha256 as string | null, child: s.child as number | null, beacon: slotBeacon(s.beacon) }
          })
        : null
    const countOrNull = (key: string, what: string, max?: number): number | null => {
      const value = top[key]
      if (value === undefined || value === null) return null
      return isCount(value, max) ? value : bad(`${what} is not a count`)
    }
    const holders =
      'holders' in top
        ? list(top.holders, "the locks' holders").map((value): LockHolder => {
            const h = fields(value, "a lock's holder", ['id', 'pid', 'created'])
            if (typeof h.id !== 'string' || !SESSION_ID.test(h.id) || !isPid(h.pid) || !isTicks(h.created)) bad("a lock's holder is not an id, a pid and a time")
            return { id: h.id as string, pid: h.pid as number, created: h.created as string }
          })
        : null
    return {
      self: top.self as number,
      session,
      slot,
      slotSeen: top.slotSeen === true,
      procs,
      registry,
      transcripts,
      locks,
      claim,
      heavy,
      freeKb: top.freeKb as number | null,
      errors,
      extraKeys,
      left,
      slots,
      heavyWaiters: countOrNull('heavyWaiters', 'the heavy-slot waiters'),
      heavyBusy: countOrNull('heavyBusy', 'the heavy slots busy', 2),
      ...('heavyChecked' in top ? { heavyChecked: top.heavyChecked === true || (top.heavyChecked === false ? false : bad('the answer says neither that heavy-slot was read nor that it was not')) } : {}),
      room: countOrNull('room', 'the sessions running'),
      inputIdleSec: countOrNull('inputIdleSec', 'the input idle'),
      holders,
    }
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
  const runs = (ref: ProcessRef): boolean => {
    const p = table.get(ref.pid)
    return p !== undefined && near(p.created, ref.created)
  }
  // A lock re-owned to a process stands while that process runs, however old it is (review gap 7).
  if (lock.holder !== undefined && runs(lock.holder)) return false
  return !runs({ pid: lock.pid, created: lock.created }) && now - lock.at > CLAIM_STALE_MS
}

/** The claude.exe a claim lock names as its holder, running with that start: each holds that lock's id, and only that. */
function lockHolders(probe: Probe, table: Map<number, ProcessEntry>): LockHolder[] {
  const fromLocks = probe.locks.flatMap((lock): LockHolder[] => (lock.ok && lock.holder !== undefined ? [{ id: lock.id, ...lock.holder }] : []))
  return [...fromLocks, ...(probe.holders ?? [])].filter(h => {
    const p = table.get(h.pid)
    return p !== undefined && isClaude(p) && near(p.created, h.created)
  })
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
    // A Claude Code command, or Claude Code's own /fork and /background machinery, or a test stub (Get-Aside).
    // A Claude Code command, and what it starts, are accounted. An aside process (Claude Code's own /fork daemon and
    // pty host, a test stub) only itself: a claude.exe under one is a session of its own, held to the rule.
    if (at.cli === true || (at === p && at.aside === true)) return true
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
 *   restart, self-restart): its own registry entry and command line are no evidence against it, and its
 *   transcript writes and heartbeat (L3, L5) aren't read, but only while the probe sees it running with
 *   that start and its own current registry entry names `id`; otherwise L3 and L5 are read, saying why.
 *   Any other holder still is evidence, and an unknown stays unknown;
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
  // A claude.exe a claim lock was re-owned to (a launch stuck at a dialog, review gap 7): live for that
  // lock's id, and no unknown for any other.
  const holders = lockHolders(probe, table)
  const holdersIds = new Set(holders.map(h => h.pid))
  for (const h of holders) if (h.id === id && !isSelf(h.pid)) live.push(`L6: claude.exe ${h.pid} holds the claim lock on it (a launch that may be stuck at a dialog)`)
  for (const p of probe.procs) {
    if (!isClaude(p)) continue
    // A Claude Code command (claude plugin ..., --version), or a claude.exe it started: no conversation,
    // and no registry entry. L2 above still reads its command line.
    if (underCli(table, p)) continue
    let at: ProcessEntry | undefined = p
    let isAccounted = false
    for (let i = 0; i < 32 && at !== undefined && !isAccounted; i += 1) {
      isAccounted = current.has(at.pid) || holdersIds.has(at.pid)
      at = parentOf(table, at)
    }
    if (!isAccounted) unknown.push(`unknown: claude.exe ${p.pid} isn't in any registry this plugin knows (another config folder, or a version without one)`)
  }
  const transcripts = probe.transcripts.filter(t => t.id === id)
  if (transcripts.length === 0) unknown.push(`unknown: no transcript of ${id} is on this machine`)
  if (transcripts.length > 1) unknown.push(`unknown: ${transcripts.length} project folders hold a transcript of ${id}`)
  // L3 and L5, unless waived: by this very process (its own writes and beats), or by a left record.
  // `self` waives them only when this process is running, by its pid and its start, and its own current
  // registry entry names `id`: a process that moved in place to another conversation since, or one the
  // probe doesn't see, proves nothing about who wrote `id`'s transcript last.
  const waivers: string[] = []
  let waived = false
  const selfHolds = opts.self !== undefined && isSelf(opts.self.pid) && (holds.get(opts.self.pid) ?? []).includes(id)
  if (selfHolds && opts.self !== undefined) waivers.push(`L3 and L5 are not read: ${id} is this process's own conversation (claude.exe ${opts.self.pid})`)
  else if (opts.self !== undefined) {
    waivers.push(
      isSelf(opts.self.pid)
        ? `L3 and L5 are read: this process's own current registry entry (claude.exe ${opts.self.pid}) doesn't name ${id}, so it isn't known to be its own conversation`
        : `L3 and L5 are read: this process (claude.exe ${opts.self.pid}, started ${when(opts.self.created)} UTC) isn't running with that start, so ${id} isn't known to be its own conversation`,
    )
  }
  if (!selfHolds && opts.left === true) {
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
  const readsL3L5 = !selfHolds && !waived
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

/** An agent's name as a hold says it: its task's description, else its type, else `an agent`; one line. */
export const agentName = (agent: AgentLike): string => oneLine(agent.description?.trim() ? agent.description.trim() : (agent.type ?? 'an agent'), 120)

/**
 * The subagents that hold (each isBusyAgent), as one clause naming them: `a subagent is still running
 * (Lint)` while each is at its task (AGENT_AT_WORK), else `2 subagents haven't ended (Lint; A teammate)`.
 */
export function agentsHeld(agents: readonly AgentLike[]): string {
  const n = agents.length
  const names = agents.map(agentName).join('; ')
  return agents.every(a => AGENT_AT_WORK.includes(a.status))
    ? `${n === 1 ? 'a subagent is' : `${n} subagents are`} still running (${names})`
    : `${n === 1 ? "a subagent hasn't" : `${n} subagents haven't`} ended (${names})`
}

/**
 * How to clear the subagents among `agents` that hold and won't report on their own (an idle teammate,
 * a status this code doesn't know), each named with its status; undefined when there are none. The hold
 * stands: TaskStop ends one, or the person exits by hand. Whether a reload clears one already gone from
 * `$.agent.list()` is unknown until G2, so it isn't offered.
 */
export function agentsWayOut(agents: readonly AgentLike[]): string | undefined {
  const stuck = agents.filter(a => isBusyAgent(a.status) && !AGENT_AT_WORK.includes(a.status))
  if (stuck.length === 0) return undefined
  const named = stuck.map(a => `${agentName(a)} (${oneLine(a.status, 40)})`)
  return stuck.length === 1
    ? `${named[0]} won't report on its own: stop it with TaskStop, or exit by hand`
    : `${named.join(', ')} won't report on their own: stop each with TaskStop, or exit by hand`
}

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
 * - S1: a subagent that hasn't ended (isBusyAgent; one that won't report on its own is named with its
 *   status and how to clear it, agentsWayOut) (`agents`; a string says why they couldn't be read);
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
    const busy = agents.filter(a => isBusyAgent(a.status))
    const way = agentsWayOut(busy)
    if (busy.length > 0) reasons.push(`S1: ${agentsHeld(busy)}${way === undefined ? '' : `; ${way}`}`)
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
export const SLOT_NOT_LIVE = "this pane's slot runner doesn't say it reads records at the shipped hash: it was left with Ctrl+C, or it runs an older copy (restart the pane)"

export function slotFallback(slot: SlotParent): string {
  if (slot.sha256 === null) return `slot hash unreadable: ${slot.hashError === undefined ? 'no reason given' : oneLine(slot.hashError, 200)}`
  if (slot.sha256 === SLOT_SCRIPT_SHA256) return SLOT_NOT_LIVE
  return "this pane's claude-slot.ps1 has another SHA-256 than the one shipped (an edited or older copy: copy the shipped script and restart the pane)"
}

/** Whether this pane's slot runner takes a record: the shipped hash on disk, and in the beacon of the process running it. */
export const slotVerified = (slot: SlotParent | null): boolean => slot !== null && slot.sha256 === SLOT_SCRIPT_SHA256 && slot.live === true

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
  if (slot !== null && slotVerified(slot)) return { transport: 'slot', slot: slot.id, folder }
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
//   the caller's claude has exited (its own checks: the claim, RECHECK); a ticket naming more than one
//   config folder, or a left record's stat, only for a wrapper of pane file version 3, read here;
// - `slot`: a record for a slot runner: this pane's, which resumes it in the same pane once the caller's
//   claude has exited, or an idle one elsewhere, its record written with CreateNew (the runner's own
//   checks: the claim, the project or a new id, RECHECK and the left record, its floor and cap), naming
//   the launcher it runs by LAUNCH_SCRIPT_SHA256;
// - `tab`: a tab in a named window of Windows Terminal (Start-Process of its full path with one quoted string),
//   running the slot runner with -Resume or -Start, -Claim and -Launcher, by the one place and hash it is run from;
// - `window`: a new window. With a name: as the tab, where Windows Terminal is new enough and the slot
//   runner in place; else, or with `true`, Start-Process of Windows PowerShell by its known path, whose
//   script waits for the caller's process when asked, then RECHECKs (and the left record's stat), checks
//   the claim and the folder, checks claude-launch.ps1's SHA-256, and runs it, with every config folder
//   and the stat, so that its own last look is the same: claude-launch.ps1 is the only script that starts
//   claude, the only place that holds the launch environment. It is put in place first, at its hash's
//   own name, which a slot runner runs too, and at the name a person runs;
// - `auto`: this pane's slot when its runner is verified and takes the folder, else the window, decided
//   in the script (self-restart's choice).
// A launch of another process (no waitForExit) must ask for the floor and input idle, and each is read
// in this same run, right before the claim and the record: never a probe a moment before.
// It answers `launched <transport> <label> [<pid>]`, or `refused <code> <why>` (a lock it took given
// back first), and `claim <by>` once the lock is taken. Nothing is written after a failed check.
//
// The threat model (N9): a window hashes claude-launch.ps1 and then runs it by its path, a gap of
// milliseconds. A writer who can use it is the same OS user (T20), who can as well edit the unpinned
// claude-wrapper.ps1 in the same folder, which the person's profile dot-sources, or run claude itself.
// The hash stops a stale or edited copy, and names per version stop two versions of the plugins
// trading one file: not that user. So a slot record's `launcher` names a file, it doesn't authorise one:
// that same user can plant claude-launch-<its own digits>.ps1 and name it, or leave a high version for Enter.

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
 * - `{ slot: id }`: a slot runner, by its id (`<pid>-<created>`): the caller's own pane's, for a launch
 *   that replaces its caller; else an idle one elsewhere;
 * - `{ tab: { window, title, pos?, size? } }`: a tab in that named window, running the slot runner, under this launch's own claim;
 * - `{ window: { name, pos?, size? } }`: a new named window, as the tab, where Windows Terminal can;
 * - `{ window: true }`: a new window, running claude-launch.ps1;
 * - `'auto'`: this pane's slot when its runner is verified and takes the folder, else the window.
 * The pane and 'auto' are for a launch that replaces its caller (`waitForExit`).
 */
export type LaunchWhere =
  | { readonly pane: { readonly token: string } }
  | { readonly slot: string }
  | { readonly tab: WtTab }
  | { readonly window: true | WtWindow }
  | 'auto'

/** A window by placement: its name, and where it opens when it isn't there yet. */
export type WtWindow = { readonly name: string; readonly pos?: readonly [number, number]; readonly size?: readonly [number, number] }

/** A tab by placement: the named window it goes in, its label, and where that window opens when it isn't there yet. */
export type WtTab = { readonly window: string; readonly title: string; readonly pos?: readonly [number, number]; readonly size?: readonly [number, number] }

/**
 * The checks the launch script makes in the same run as it places the launch:
 * - `live`: NOT LIVE now (RECHECK, and the left record's stat when given), for a launch that doesn't
 *   wait for its caller, which must ask for it; one that waits takes its last look after the wait;
 * - `fresh`: a start's id is new on this machine: no transcript in any config folder, no registry file
 *   and no command line names it. Required for a start;
 * - `floor`: free memory of at least max(6 GB, 4 GB + the largest session's private bytes), no heavy-slot
 *   waiter, not both heavy slots busy, and the sessions under the cap, as floorOk reads them. Required of
 *   a launch of another process;
 * - `input`: the machine's input idle for at least 60 s; a reading that fails is not idle (PM2). Required
 *   of a launch of another process. One that replaces its caller may ask (a replacing fresh's window, PM6).
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
  /** A left record's stat: the last look, wherever it is taken, refuses when the transcript changed since (\u00a73.4). */
  readonly left?: LeftStat
  /** The cap `checks.floor` holds the sessions to, named by the caller (placement.json's limits.maxSessions, else LIMITS_DEFAULT's): required with it. */
  readonly maxSessions?: number
  /** The folder holding heavy-slot.sh's .gate-lock folders; null: this machine has none. Required with `checks.floor`: left out, it would skip the rule without a word. */
  readonly heavySlotRoot?: string | null
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
 * Puts claude-launch.ps1 in place at its own name (launchScriptPath: no other version writes it) when it
 * is missing or has another SHA-256 than `$sha` (an edited copy): the copy the launch carries (`$b64`,
 * LAUNCH_SCRIPT_TEXT's bytes) written whole under another name in the same folder (CreateNew), checked,
 * then moved over the file there ([IO.File]::Replace, or Move when there is none), and read back.
 * Returns $null when the file at `$path` has `$sha` (already, or now), else why not; a write another
 * launch of the same version made meanwhile counts. Needs Get-Sha256.
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
 * Keeps the copy for use by hand (`$hand`, launchHandPath) at the highest version any launch carries:
 * when it is missing, has no `# claude-launch version <n>` line, or says less than `$version`, the
 * installed script at `$from` (just checked by its hash) is copied there whole: a new file under another
 * name (CreateNew), the old one deleted, the new one moved in. Never [IO.File]::Replace, which would keep
 * a downloaded file's mark (Zone.Identifier) on the copy. One of the same or a higher version is left as
 * it is, so plugins of two versions never trade it back and forth. It never refuses a launch: whatever
 * goes wrong here, the window runs its own hashed copy all the same.
 */
export const INSTALL_HAND_COPY = [
  'function Install-HandCopy($hand, $from, $version) {',
  '  try {',
  '    $have = -1',
  '    if (Test-Path -LiteralPath $hand -PathType Leaf) {',
  '      $have = 0',
  String.raw`      if ([IO.FileInfo]::new($hand).Length -le 65536 -and [IO.File]::ReadAllText($hand) -cmatch '(?m)^# claude-launch version (\d{1,6})\r?$') { $have = [int]$Matches[1] }`,
  '    }',
  '    if ($have -ge $version) { return }',
  '    $tmp = $hand + "." + [guid]::NewGuid().ToString("N") + ".tmp"',
  '    try {',
  '      $bytes = [IO.File]::ReadAllBytes($from)',
  '      $stream = [IO.File]::Open($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)',
  '      try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }',
  '      if ($have -ge 0) { [IO.File]::Delete($hand) }',
  '      [IO.File]::Move($tmp, $hand)',
  '    } finally { if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) } }',
  '  } catch { }',
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
 * deleted while it is held, only when it still names `$by`. A reader that has it open without sharing
 * delete makes the delete fail: tried twice more, 250 ms apart, as releaseScript does; then it is left, to
 * go stale. It never throws, so what its caller says next is said. Needs `$claimPath` and `$by`.
 */
export const RELEASE_CLAIM = [
  'function Release-Claim {',
  "  try { $stream = [IO.File]::Open($claimPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'Read, Delete') } catch { return }",
  '  try {',
  '    $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8, $true, 4096, $true)',
  '    $text = $reader.ReadToEnd()',
  '    $reader.Dispose()',
  '    $lock = $null',
  '    try { $lock = $text | ConvertFrom-Json } catch { $lock = $null }',
  '    if ($null -ne $lock -and $lock.by -ceq $by) {',
  '      for ($try = 0; $try -lt 3; $try++) {',
  '        if ($try -gt 0) { Start-Sleep -Milliseconds 250 }',
  '        try { [IO.File]::Delete($claimPath); break } catch { }',
  '      }',
  '    }',
  '  } catch { } finally { $stream.Dispose() }',
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

/**
 * One element of wt's argument string, by Windows' quoting rules (CommandLineToArgvW): wrapped in double
 * quotes when it holds a space. Throws on an empty one, one holding a double quote (it would end its
 * quotes), a semicolon (wt reads it as the next command, wherever it stands) or a percent sign (wt
 * expands it), and on a quoted one ending in a backslash, which would escape the closing quote.
 */
export function wtArgument(element: string): string {
  if (element === '' || /[";%]/.test(element)) throw new Error(`an argument for Windows Terminal is empty, or holds a double quote, a semicolon or a percent sign: ${JSON.stringify(element)}`)
  if (!/\s/.test(element)) return element
  if (element.endsWith('\\')) throw new Error(`an argument with a space ends in a backslash: ${JSON.stringify(element)}`)
  return `"${element}"`
}

/** A folder as wt's -d takes it: no trailing backslash, which would escape a closing quote; a drive's root keeps its own. */
export const wtFolder = (folder: string): string => (folder.length > 3 ? folder.replace(/\\+$/, '') : folder)

/** What a tab's slot runner is opened to do. */
export type TabRun =
  | { readonly idle: true }
  | { readonly start: string; readonly name: string; readonly claim: string; readonly configDirs?: readonly string[] }
  | { readonly resume: string; readonly claim: string; readonly waitFor?: ProcessRef; readonly configDirs?: readonly string[]; readonly left?: LeftStat }

/**
 * The one string wt.exe is given for a tab (Start-Process's -ArgumentList, which joins an array with
 * spaces and quotes nothing): the window by name, its place when it isn't there yet, `nt` with the title
 * and the folder, `--`, then Windows PowerShell by its known path running the slot script from its one
 * place, and what the tab is opened to do, each value pattern-checked, with the launcher it runs by this
 * release's pin. Nothing else: no prompt, no assignment, no permission flag.
 */
export function wtTabLine(input: { readonly powershell: string; readonly stateDir: string; readonly window: string; readonly title: string; readonly pos?: readonly [number, number]; readonly size?: readonly [number, number]; readonly folder: string; readonly run: TabRun }): string {
  if (!POWERSHELL_PATH.test(input.powershell)) throw new Error(`not Windows PowerShell by its known path: ${JSON.stringify(input.powershell)}`)
  if (!isWindowName(input.window)) throw new Error(`not a window Windows Terminal takes by name: ${JSON.stringify(input.window)}`)
  if (!TAB_LABEL.test(input.title)) throw new Error(`not a tab's label: ${JSON.stringify(input.title)}`)
  for (const [what, path] of [['the folder', input.folder], ['the state folder', input.stateDir]] as const) {
    const fault = wtFolderFault(path)
    if (fault !== undefined) throw new Error(`${what} ${JSON.stringify(path)} ${fault}, so it never reaches Windows Terminal`)
  }
  const place = (pair: readonly [number, number] | undefined, flag: string, ok: (a: number, b: number) => boolean): string[] => {
    if (pair === undefined) return []
    if (!ok(pair[0], pair[1])) throw new Error(`not a ${flag.slice(2)}: ${JSON.stringify(pair)}`)
    return [flag, `${pair[0]},${pair[1]}`]
  }
  const run = input.run
  const dirs = 'idle' in run || run.configDirs === undefined ? [] : run.configDirs
  for (const dir of dirs) {
    const fault = wtFolderFault(dir)
    if (fault !== undefined) throw new Error(`a config folder ${JSON.stringify(dir)} ${fault}, so it never reaches Windows Terminal`)
  }
  const named = dirs.length === 0 ? [] : ['-ConfigDirs', dirs.map(wtFolder).join('|')]
  // Per launch, never of the conversation: a later launch that takes the lock over turns this tab away.
  const claim = (by: string): string[] => {
    if (!LAUNCH_CLAIM.test(by)) throw new Error(`a tab's claim is a launch's own: ${JSON.stringify(by)}`)
    return ['-Claim', by]
  }
  let doing: string[]
  if ('idle' in run) doing = ['-Idle']
  else if ('start' in run) {
    if (!SESSION_ID.test(run.start) || !AREA_NAME.test(run.name)) throw new Error('a tab starts a session id under a session name')
    doing = ['-Start', run.start, '-Name', run.name, ...named, ...claim(run.claim), '-Launcher', LAUNCH_SCRIPT_SHA256]
  } else {
    if (!SESSION_ID.test(run.resume)) throw new Error('a tab resumes a session id')
    const waits = run.waitFor === undefined ? [] : ['-WaitFor', `${run.waitFor.pid}-${run.waitFor.created}`]
    const left = run.left === undefined ? [] : 'size' in run.left ? ['-LeftSize', String(run.left.size), '-LeftMtime', String(run.left.mtime)] : ['-LeftExitAt', String(run.left.exitAt)]
    doing = ['-Resume', run.resume, ...waits, ...named, ...left, ...claim(run.claim), '-Launcher', LAUNCH_SCRIPT_SHA256]
  }
  return [
    '-w',
    input.window,
    ...place(input.pos, '--pos', (x, y) => isPos(x) && isPos(y)),
    ...place(input.size, '--size', isSize),
    'nt',
    '--title',
    input.title,
    '--suppressApplicationTitle',
    '-d',
    wtFolder(input.folder),
    '--',
    input.powershell,
    '-NoExit',
    '-NoProfile',
    '-ExecutionPolicy',
    'RemoteSigned',
    '-File',
    slotScriptPath(input.stateDir),
    ...doing,
  ]
    .map(wtArgument)
    .join(' ')
}

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
  const where = input.where
  const waitFor = input.waitForExit
  if (waitFor !== undefined && (!isPid(waitFor.pid) || !isTicks(waitFor.created))) throw new Error('the process to wait for is not a pid and a time as a string')
  if (checks.live === true && waitFor !== undefined) throw new Error('a launch that waits for its caller takes its last look after the wait, not now')
  // A launch of another process adds a process, in a pane or a window the person may be typing in.
  if (waitFor === undefined && (checks.floor !== true || checks.input !== true)) throw new Error('a launch of another process checks the floor and the input idle (checks.floor, checks.input)')
  if (waitFor === undefined && input.kind === 'resume' && checks.live !== true) throw new Error('a resume that waits for nothing checks NOT LIVE now (checks.live)')
  if (checks.floor === true && (input.heavySlotRoot === undefined || input.maxSessions === undefined)) throw new Error('a floor names its heavy-slot folder (null: this machine has none) and its cap: heavySlotRoot, maxSessions')
  const maxSessions = input.maxSessions ?? LIMITS_DEFAULT.maxSessions
  if (!isCount(maxSessions, 40) || maxSessions < 1) throw new Error(`the cap is not a whole number from 1 to 40: ${JSON.stringify(input.maxSessions)}`)
  const heavyRoot = input.heavySlotRoot === undefined || input.heavySlotRoot === null ? undefined : checkFolder('the heavy-slot folder', input.heavySlotRoot)
  if (input.kind === 'start') {
    if (typeof input.name !== 'string' || !AREA_NAME.test(input.name)) throw new Error(`a start's name is not a session name: ${JSON.stringify(input.name)}`)
    if (checks.fresh !== true) throw new Error('a start checks that its id is new (checks.fresh)')
    if (where === 'auto' || (typeof where === 'object' && 'pane' in where)) throw new Error("a start goes to a slot, a tab or a window: the claude wrapper's ticket and 'auto' resume")
    if (typeof where === 'object' && waitFor !== undefined && ('tab' in where || ('window' in where && where.window !== true))) throw new Error('a start in a tab waits for nothing: only a resume in one does')
    if (input.left !== undefined) throw new Error('a left record is a resumed conversation\'s')
  } else if (input.kind === 'resume') {
    if (input.name !== undefined) throw new Error('a resume takes no name')
    if (checks.fresh === true) throw new Error('a resume is not of a new id')
  } else throw new Error(`not a launch's kind: ${JSON.stringify(input.kind)}`)
  let label: string | undefined
  let ticket: string | undefined
  /** The string wt.exe is given, for a tab or a named window. */
  let wtLine: string | undefined
  /** The tab's stamp, for a tab or a named window. */
  let stamp: { readonly window: string; readonly tab: string } | undefined
  const tabRun = (): TabRun =>
    input.kind === 'start'
      ? { start: id, name: input.name as string, claim: input.claim, configDirs }
      : { resume: id, claim: input.claim, ...(waitFor === undefined ? {} : { waitFor }), configDirs, ...(input.left === undefined ? {} : { left: input.left }) }
  const tabOf = (tab: WtTab): string => {
    if (!LAUNCH_CLAIM.test(input.claim)) throw new Error("a tab's or a named window's slot runner takes only a launch's own claim, launch:<uuid>")
    return wtTabLine({ powershell: input.powershell, stateDir: state, window: tab.window, title: tab.title, ...(tab.pos === undefined ? {} : { pos: tab.pos }), ...(tab.size === undefined ? {} : { size: tab.size }), folder, run: tabRun() })
  }
  if (where === 'auto') {
    if (waitFor === undefined) throw new Error("'auto' is for a launch that replaces its caller (waitForExit)")
    if (!input.claim.startsWith('launch:')) throw new Error("'auto' names a launch's claim; the slot's is its own")
  } else if ('tab' in where) {
    wtLine = tabOf(where.tab)
    stamp = { window: where.tab.window, tab: where.tab.title }
    label = where.tab.window
  } else if ('pane' in where) {
    if (waitFor === undefined) throw new Error('the pane is for a launch that replaces its caller (waitForExit)')
    if (!input.claim.startsWith('launch:')) throw new Error("the pane's ticket names a launch's claim")
    if (typeof input.now !== 'number') throw new Error("the pane's ticket needs the time")
    // The ticket names every config folder this launch reads, and the left record's stat when there is
    // one: the wrapper's last look (pane file version 3) reads them all, and checks the transcript.
    ticket = paneTicket({ token: where.pane.token, resume: id, by: input.claim, dir: folder, at: input.now, configDirs, ...(input.left === undefined ? {} : { left: input.left }) })
    label = where.pane.token
  } else if ('slot' in where) {
    idPath(state, 'slotRecord', where.slot)
    label = where.slot
    if (input.claim !== `slot:${where.slot}`) throw new Error("a slot's launch names that slot's claim")
  } else if ('window' in where) {
    if (!input.claim.startsWith('launch:')) throw new Error("a window names a launch's claim")
    if (where.window !== true) {
      const named = where.window
      wtLine = tabOf({ window: named.name, title: input.name ?? `resume-${id.slice(0, 8)}`, ...(named.pos === undefined ? {} : { pos: named.pos }), ...(named.size === undefined ? {} : { size: named.size }) })
      stamp = { window: named.name, tab: input.name ?? `resume-${id.slice(0, 8)}` }
      label = named.name
    }
  } else throw new Error('not a place to launch to')
  if (input.left !== undefined) leftRecheck(input.left)
  if (input.deadline !== undefined && !isCount(input.deadline)) throw new Error('the deadline is not a time')
  return { id, folder, state, configDirs, tool, checks, where, waitFor, label, ticket, wtLine, stamp, maxSessions, heavyRoot, deadline: input.deadline }
}

/**
 * The floor, in the launch script's own run (`checks.floor`), by floorOk's rules and in its order: free
 * memory of at least max(6 GB, 4 GB + the largest session's private bytes; 2 GB when none could be read),
 * read through Win32; no heavy-slot waiter, not both heavy slots busy, read from heavy-slot's folders; the
 * sessions under the cap. Anything it can't read refuses. Needs `$table` (with PrivatePageCount),
 * Get-Parent, Get-Cli, and the `Refuse` function.
 */
function floorLines(heavyRoot: string | undefined, maxSessions: number): string[] {
  return [
    '$freeKb = $null',
    'try { $freeKb = [long](Get-CimInstance -ClassName Win32_OperatingSystem -Property FreePhysicalMemory).FreePhysicalMemory } catch { $freeKb = $null }',
    "if ($null -eq $freeKb) { Refuse 'memory' 'the free memory could not be read' }",
    '$largest = $null',
    'foreach ($p in @($table.Values)) { if ($p.Name -eq "claude.exe" -and $null -ne $p.PrivatePageCount -and -not (Get-Cli $p) -and ($null -eq $largest -or [long]$p.PrivatePageCount -gt $largest)) { $largest = [long]$p.PrivatePageCount } }',
    `if ($null -eq $largest) { $largest = [long]${LARGEST_UNREAD_GB} * 1073741824 }`,
    `$needBytes = [math]::Max([long]${FLOOR_MIN_GB} * 1073741824, [long]${HEAVY_FLOOR_GB} * 1073741824 + $largest)`,
    "if (($freeKb * 1024) -lt $needBytes) { Refuse 'memory' ('only ' + [math]::Round($freeKb / 1048576, 1) + ' GB of memory is free, under the ' + [math]::Round($needBytes / 1073741824, 1) + ' GB a launch leaves') }",
    ...(heavyRoot === undefined
      ? []
      : [
          `$heavyRoot = ${literal(heavyRoot)}`,
          'try {',
          ...READ_HEAVY.map(line => `  ${line}`),
          "} catch { Refuse 'heavy' ('the heavy-slot folders could not be read: ' + $_.Exception.Message) }",
          "if ($heavyWaiters -gt 0) { Refuse 'heavy' ($heavyWaiters.ToString() + ' heavy jobs are waiting, and they go first') }",
          "if ($heavyBusy -ge 2) { Refuse 'heavy' 'both heavy slots are busy' }",
        ]),
    ...COUNT_SESSIONS,
    `if ($room -ge ${maxSessions}) { Refuse 'cap' ($room.ToString() + ' sessions are running, at the cap of ${maxSessions}') }`,
  ]
}

/** Input idle, in the launch script's own run (`checks.input`): at least 60 s; a reading that fails is not idle. */
const INPUT_LINES = [
  ...READ_INPUT_IDLE,
  `if ($null -eq $inputIdleSec) { Refuse 'input' 'the machine''s input idle could not be read, and that is not idle' }`,
  `if ($inputIdleSec -lt ${INPUT_IDLE_MS / 1000}) { Refuse 'input' ('the machine had input ' + $inputIdleSec + ' seconds ago, under the ${INPUT_IDLE_MS / 1000} a launch waits for') }`,
]

/**
 * An idle slot elsewhere, in the launch script's own run: the runner by its id is running with that start,
 * runs `-File ...\claude-slot.ps1` of the shipped hash, has no claude.exe under it, and its beacon has said
 * idle for at least 10 s. Sets `$slot`. Needs `$table`, Get-Created, Get-Sha256, Get-Beacon, Refuse.
 */
function slotIdleLines(state: string, slot: string): string[] {
  const dash = slot.indexOf('-')
  const pid = slot.slice(0, dash)
  const created = slot.slice(dash + 1)
  return [
    `$runner = $table[[int]${pid}]`,
    `if ($null -eq $runner -or $runner.Name -ne 'powershell.exe' -or (Get-Created $runner) -cne '${created}') { Refuse 'slot' 'that slot runner is no longer running' }`,
    String.raw`if ("$($runner.CommandLine)" -notmatch "-File\s+(\x22?)(?<path>[A-Za-z]:\\[^\x22]*?\\claude-slot\.ps1)\1(\s|\z)") { Refuse 'slot' 'that process runs no slot runner' }`,
    `if ((Get-Sha256 $Matches["path"]) -cne '${SLOT_SCRIPT_SHA256}') { Refuse 'slot' 'that slot runner has another SHA-256 than the one shipped' }`,
    `foreach ($p in @($table.Values)) { if ($p.Name -eq 'claude.exe' -and [long]$p.ParentProcessId -eq ${pid}) { Refuse 'slot' 'that slot runs a Claude Code already' } }`,
    '$slotBeacon = $null',
    `try { $slotBeacon = Get-Beacon ([IO.File]::ReadAllText(${literal(slotBeaconPath(state, slot))}, [Text.Encoding]::UTF8) | ConvertFrom-Json) } catch { $slotBeacon = $null }`,
    "if ($null -eq $slotBeacon -or $slotBeacon['state'] -cne 'idle') { Refuse 'slot' 'that slot''s beacon does not say idle' }",
    `if ($slotBeacon['sha256'] -cne '${SLOT_SCRIPT_SHA256}') { Refuse 'slot' 'that slot''s beacon does not say it runs the shipped hash: restart the pane' }`,
    `if (([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$slotBeacon['since']) -lt ${SLOT_IDLE_MIN_MS}) { Refuse 'slot' 'that slot went idle less than ${SLOT_IDLE_MIN_MS / 1000} seconds ago' }`,
    `$slot = [ordered]@{ id = '${slot}' }`,
  ]
}

/**
 * Windows Terminal's version, read after the PSModulePath reset (the Appx module is 5.1's): `$wtVersion`,
 * the highest of the Store's and the Preview's, `$null` when neither can be read. Never by running wt.
 */
const READ_WT_VERSION = [
  '$wtVersion = $null',
  "try { $wtFound = @(Get-AppxPackage -Name 'Microsoft.WindowsTerminal*' | ForEach-Object { [version]$_.Version } | Sort-Object -Descending); if ($wtFound.Count -gt 0) { $wtVersion = $wtFound[0] } } catch { $wtVersion = $null }",
]

/**
 * Whether the process waited for has gone, by asking it (Test-Gone), and the wait for it by its handle (Wait-Gone).
 * A process's exit code reads set as soon as its last user thread has ended, tens of milliseconds before the process
 * is signaled and dropped from the process table, and longer under load (no ceiling was found), so a wait that stops
 * at the exit code (Wait-Process) can return with the process still listed, and a look at the table then would find
 * it and refuse the launch for nothing. WaitForExit waits on the handle being signaled, past that gap. `$created` is
 * the process's start time (FILETIME as a string): a process id the system gave to another process reads as gone,
 * since it isn't the one waited for. A start time of "0" (one the probe couldn't read), or one this process can't
 * read, is waited for by the pid alone. Anything but "no such process" that can't be read counts as still there.
 */
export const TEST_GONE = [
  'function Test-Gone($processId, $created) {',
  '  $h = $null',
  '  try { $h = [Diagnostics.Process]::GetProcessById([int]$processId); $other = $false; if ($created -and "$created" -ne "0") { try { $other = [math]::Abs($h.StartTime.ToFileTimeUtc() - [long]$created) -gt 10000 } catch { $other = $false } }; if ($other) { return $true }; return $h.HasExited }',
  '  catch { return ($_.Exception -is [ArgumentException] -or $_.Exception.InnerException -is [ArgumentException]) }',
  '  finally { if ($null -ne $h) { $h.Dispose() } }',
  '}',
  'function Wait-Gone($processId, $created, $seconds) {',
  '  $h = $null',
  '  try { $h = [Diagnostics.Process]::GetProcessById([int]$processId); $same = $true; if ($created -and "$created" -ne "0") { try { $same = [math]::Abs($h.StartTime.ToFileTimeUtc() - [long]$created) -le 10000 } catch { $same = $true } }; if ($same) { [void]$h.WaitForExit([int]$seconds * 1000) } } catch { } finally { if ($null -ne $h) { $h.Dispose() } }',
  '  return (Test-Gone $processId $created)',
  '}',
]

/**
 * How soon claude-launch.ps1's exit code 2 counts as its own refusal, in seconds: its last look, under load (the
 * process table, then up to 3 reads 250 ms apart of each registry file it can't read), can take tens of seconds;
 * a Claude Code session that ends with 2 after longer is no refusal. Only a marker of the launcher's own (a later
 * version) tells them apart for sure.
 */
export const LAUNCH_REFUSED_SECONDS = 60

/** How long the wait for an old process that outlasted the first wait looks each time, in seconds. */
export const WAIT_POLL_SECONDS = 30

/**
 * Writes the refused record of `$id` (read back by readRefused) to `$refusedPath`, whole: never throws, so what its
 * caller says next is said. Needs `$id`, `$by`, `$folder`, `$refusedPath`, `$refusedKind`.
 */
const WRITE_REFUSED = [
  'function Write-Refused($why) {',
  '  try {',
  '    $final = $refusedPath',
  '    $text = [ordered]@{ v = 1; id = $id; kind = $refusedKind; by = $by; at = [string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); folder = $folder; why = [string]$why } | ConvertTo-Json -Compress',
  ...WRITE_WHOLE.map(line => `    ${line}`),
  '  } catch { }',
  '}',
]

/**
 * The new window's script, run by Windows PowerShell after the launch script has placed it: it waits
 * for the caller's process when asked; then, right before claude, reads the registry and the process
 * table again (RECHECK) and the left record's stat, and for a start that no transcript appeared;
 * checks that the claim lock still names this launch and that the folder is there; checks
 * claude-launch.ps1's SHA-256; and runs it, handing it every config folder this launch read and the
 * left record's stat, so that its own last look, right before claude, is this one again. A run that
 * throws (a Group Policy execution policy, a claude.exe an update holds) is caught and said, with the
 * way to resume by hand, never a window that closes on it. Values only as single-quoted literals or
 * checked numbers.
 */
function windowScript(v: { id: string; kind: 'resume' | 'start'; name?: string; folder: string; state: string; configDirs: readonly string[]; by: string; waitFor?: ProcessRef; left?: LeftStat }): string {
  const resume = v.kind === 'resume'
  // A line that runs as it is printed: the script's whole path, and the folder quoted, whatever it holds
  // (neither can hold a quote). The copy kept for use by hand: the one this window pins may be what changed.
  const byHand = resume ? `"& '" + $handPath + "' -Resume " + $id + " -Dir '" + $folder + "'"` : `"& '" + $handPath + "' -Start " + $id + " -Name " + $name + " -Dir '" + $folder + "'"`
  const refusedAt = literal(idPath(v.state, 'refused', v.id))
  // The numbers were checked whole (leftRecheck) before they reach here.
  const leftArgs = v.left === undefined ? '' : 'size' in v.left ? ` -LeftSize '${v.left.size}' -LeftMtime '${v.left.mtime}'` : ` -LeftExitAt '${v.left.exitAt}'`
  const runs = resume ? `& $launchPath -Resume $id -Dir $folder -ConfigDir $configDirs${leftArgs}` : '& $launchPath -Start $id -Name $name -Dir $folder -ConfigDir $configDirs'
  return [
    '$ErrorActionPreference = "Stop"',
    '$ProgressPreference = "SilentlyContinue"',
    PSMODULEPATH_RESET,
    // Its session is in no tab of a named window: the stamp of the one that launched it would send a later `same` there.
    '$env:CLAUDE_SELF_TOOLS_WT_WINDOW = $null',
    '$env:CLAUDE_SELF_TOOLS_WT_TAB = $null',
    `$id = '${v.id}'`,
    ...(resume ? [] : [`$name = '${v.name}'`]),
    `$by = '${v.by}'`,
    `$folder = ${literal(v.folder)}`,
    `$configDirs = @(${v.configDirs.map(literal).join(', ')})`,
    `$claimPath = ${literal(claimPath(v.state, v.id))}`,
    `$launchPath = ${literal(launchScriptPath(v.state))}`,
    `$handPath = ${literal(launchHandPath(v.state))}`,
    ...GET_SHA256,
    ...RELEASE_CLAIM,
    // The record of a refusal, for whoever comes looking (the coordinator, or a person, by hand): this
    // window may be the only place it is said. Written whole, and it never throws.
    `$refusedPath = ${refusedAt}`,
    `$refusedKind = '${resume ? 'resume' : 'start'}'`,
    ...WRITE_REFUSED,
    '$refusal = $null',
    ...(v.waitFor === undefined
      ? []
      : [
          ...TEST_GONE,
          `Write-Host ("Waiting for the old Claude Code process (${v.waitFor.pid}) to exit, then ${resume ? 'resuming' : 'starting'} session " + $id + " here.")`,
          // Looked at every WAIT_POLL_SECONDS until it goes, however long that takes; the claim read at each look, so a
          // move taken back (its claim released, or taken over) ends the wait at once. The last look below still decides.
          '$waitClock = [Diagnostics.Stopwatch]::StartNew()',
          '$toldLong = $false',
          '$gone = $false',
          'while (-not $gone) {',
          `  $gone = Wait-Gone ${v.waitFor.pid} '${v.waitFor.created}' ${WAIT_POLL_SECONDS}`,
          '  if ($gone) { break }',
          // Only a clear answer ends the wait: the claim gone, or naming another. One that can't be read now (being
          // written, a sharing violation) is looked at again next time; the claim check below still fails closed.
          '  $claimSays = "unknown"',
          '  if (-not (Test-Path -LiteralPath $claimPath)) { $claimSays = "gone" } else { try { $held = Get-Content -LiteralPath $claimPath -Raw -Encoding UTF8 | ConvertFrom-Json; if ($null -ne $held -and $held.by -is [string]) { $claimSays = $(if ($held.by -ceq $by) { "ours" } else { "other" }) } } catch { $claimSays = "unknown" } }',
          '  if ($claimSays -eq "gone" -or $claimSays -eq "other") { $refusal = "The session is not resumed here: the claim on it no longer names this window (the move that opened it was taken back, or its time ran out)."; break }',
          `  if (-not $toldLong -and $waitClock.Elapsed.TotalSeconds -ge ${WAIT_SECONDS}) { $toldLong = $true; Write-Host "It has not exited after ${WAIT_SECONDS / 60} minutes. This window keeps waiting while the move that opened it stands, and ${resume ? 'resumes' : 'starts'} the session when it goes. Close this window to give up." }`,
          '  Start-Sleep -Seconds 1',
          '}',
        ]),
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
    // A window that refuses gives the claim back, while it still names this window, so the conversation
    // doesn't read as held for 15 minutes on nothing (N5).
    'if ($null -ne $refusal) {',
    '  Write-Refused $refusal',
    '  Write-Host $refusal',
    `  Write-Host ("Once it is safe, resume it yourself: " + ${byHand})`,
    '  Release-Claim',
    '  Read-Host "Press Enter to close this window" | Out-Null',
    '  exit 1',
    '}',
    '$started = Get-Date',
    '$code = 1',
    'try {',
    `  ${runs}`,
    '  $code = $LASTEXITCODE',
    '} catch {',
    `  Write-Refused ("claude-launch.ps1 stopped on an error: " + $_.Exception.Message)`,
    `  Write-Host ("claude-launch.ps1 stopped on an error, so the session may not have ${resume ? 'resumed' : 'started'} here: " + $_.Exception.Message)`,
    `  Write-Host ("Once it is safe, ${resume ? 'resume' : 'start'} it yourself: " + ${byHand})`,
    '  Release-Claim',
    '  Read-Host "Press Enter to close this window" | Out-Null',
    '  exit 1',
    '}',
    // An error, or an end within seconds: the resume didn't take. Say how to resume by hand, and wait.
    `if ($code -ne 0 -or ((Get-Date) - $started).TotalSeconds -lt ${SHORT_RUN_SECONDS}) {`,
    // The launcher refused (its exit 2: its last look found the conversation open elsewhere, or no claude.exe): recorded.
    `  if ($code -eq 2 -and ((Get-Date) - $started).TotalSeconds -lt ${LAUNCH_REFUSED_SECONDS}) { Write-Refused "claude-launch.ps1 ended within a minute with exit code 2: its last look refused the conversation (open elsewhere, or no way to tell), or Claude Code could not start" }`,
    '  Write-Host "Claude Code ended (exit code $code)."',
    `  Write-Host ("If the session did not ${resume ? 'resume' : 'start'} here, do it yourself: " + ${byHand})`,
    // The launcher refused (its exit 2: nothing ran), or what ran has ended: this launch's own claim, so no one else's.
    '  if ($code -ne 0) { Release-Claim }',
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
  const transport = where === 'auto' ? 'auto' : 'pane' in where ? 'pane' : 'slot' in where ? 'slot' : 'tab' in where ? 'tab' : 'window'
  /** A slot's record for a runner this launch doesn't run under: an idle slot elsewhere. */
  const elsewhere = where !== 'auto' && 'slot' in where && v.waitFor === undefined
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
    // -ExecutionPolicy Bypass, for this window's scripts alone (claude-launch.ps1 clears it again before
    // claude): the window runs claude-launch.ps1 only with the SHA-256 it pins, checked right before, a
    // stronger check than RemoteSigned's; under RemoteSigned, a downloaded file's mark (Zone.Identifier)
    // on the script would make the run throw after the old process has gone. A Group Policy execution
    // policy still wins over the command line: the window's catch then says so, and how to resume by hand.
    `$window = Start-Process -FilePath ${literal(input.powershell)} -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded -PassThru`,
    `$placed = "window - " + $window.Id`,
  ]
  /** A tab or a named window: its stamp set first (wt forwards it), the slot script's hash checked right before, then wt.exe with one string. */
  const openWt =
    v.wtLine === undefined || v.stamp === undefined
      ? []
      : [
          `$wtLine = ${literal(v.wtLine)}`,
          `$env:CLAUDE_SELF_TOOLS_WT_WINDOW = ${literal(v.stamp.window)}`,
          `$env:CLAUDE_SELF_TOOLS_WT_TAB = ${literal(v.stamp.tab)}`,
          `if ((Get-Sha256 $slotScript) -cne '${SLOT_SCRIPT_SHA256}') { throw ("the slot runner is not at " + $slotScript + " with the SHA-256 this plugin ships") }`,
          '$window = Start-Process $wtExe -ArgumentList $wtLine -PassThru',
          `$placed = '${transport} ${v.label ?? ''}'`,
        ]
  const leftField = input.left === undefined ? '' : 'size' in input.left ? `; left = [ordered]@{ size = ${input.left.size}; mtime = ${input.left.mtime} }` : `; left = [ordered]@{ exitAt = ${input.left.exitAt} }`
  /** The slot's record: the conversation, its folder, when, the config folders the runner's re-check also reads, the launcher it runs by this release's pin (put in place below, before the record), and a left record's stat. */
  const writeRecord = [
    // The slot asked for, by the path built from its checked id; or, for 'auto', the slot found here,
    // whose id the script made of two numbers.
    where !== 'auto' && 'slot' in where ? `$final = ${literal(slotRecordPath(v.state, where.slot))}` : '$final = Join-Path $state ("slots\\" + $slot["id"] + ".next.json")',
    input.kind === 'start'
      ? `$text = [ordered]@{ v = 1; start = $id; name = '${input.name}'; folder = $folder; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); configDirs = [object[]]$configDirs; launcher = '${LAUNCH_SCRIPT_SHA256}' } | ConvertTo-Json -Compress`
      : `$text = [ordered]@{ v = 1; resume = $id; folder = $folder; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); configDirs = [object[]]$configDirs; launcher = '${LAUNCH_SCRIPT_SHA256}'${leftField} } | ConvertTo-Json -Compress -Depth 3`,
    // A slot elsewhere: CreateNew, so that of a switch and a launch racing for it, one wins, and a record
    // already there refuses; the runner reads it only once this handle lets go. This pane's own: whole, by
    // a move or a replace (a withdrawn record of its own may sit there until claude exits).
    ...(elsewhere
      ? [
          '[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($final))',
          '$recordStream = [IO.File]::Open($final, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)',
          'try { $recordBytes = [Text.Encoding]::UTF8.GetBytes($text); $recordStream.Write($recordBytes, 0, $recordBytes.Length); $recordStream.Flush($true) } finally { $recordStream.Dispose() }',
        ]
      : WRITE_WHOLE),
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
    ...GET_BEACON,
    ...FIND_SLOT,
    '$slotFallback = $null',
    'if ($null -ne $slot -and -not $slotOk) { if ($null -ne $slotHashError) { $slotFallback = "slot hash unreadable: " + $slotHashError } elseif ($slotStale) { $slotFallback = "this pane" + [char]39 + "s slot runner does not say it reads records at the shipped hash: it was left with Ctrl+C, or it runs an older copy (restart the pane)" } else { $slotFallback = "this pane" + [char]39 + "s claude-slot.ps1 has another SHA-256 than the one shipped" } }',
    'if ($slotSeen) { $slotFallback = "this pane runs claude-slot.ps1 some other way than the slot runner the plugin recognises (Windows PowerShell, powershell.exe -File with the script" + [char]39 + "s absolute path), so it is no slot" }',
    ...(input.kind === 'start'
      ? []
      : [
          'if ($slotOk) {',
          '  $projectName = [regex]::Replace($folder, "[^A-Za-z0-9]", "-")',
          '  $inProject = $false',
          '  foreach ($dir in $configDirs) { if ($projectName.Length -le 200 -and (Test-Path -LiteralPath (Join-Path $dir ("projects\\" + $projectName + "\\" + $id + ".jsonl")) -PathType Leaf)) { $inProject = $true } }',
          '  if (-not $inProject) { $slotOk = $false; $slotFallback = "the folder is not one the slot runner takes: no transcript of the conversation under its project" }',
          '}',
        ]),
  ]
  /** A tab or a named window: Windows Terminal new enough for a stamp, read after the module path's reset, and the slot script in its one place with the shipped hash. */
  const wtCheck =
    v.wtLine === undefined
      ? []
      : [
          ...READ_WT_VERSION,
          `$slotScript = ${literal(slotScriptPath(v.state))}`,
          // By its full path, under the state folder's parent: a bare name would search the conversation's own folder too.
          "$wtExe = Join-Path (Split-Path -Parent $state) 'Microsoft\\WindowsApps\\wt.exe'",
          `$wtOld = $null -eq $wtVersion -or $wtVersion -lt [version]'${WT_MIN.stamps}' -or -not (Test-Path -LiteralPath $wtExe -PathType Leaf)`,
          `$slotAway = (Get-Sha256 $slotScript) -cne '${SLOT_SCRIPT_SHA256}'`,
          ...(transport === 'tab'
            ? [
                `if ($wtOld) { Refuse 'wt' ($tool + ': a tab needs Windows Terminal ${WT_MIN.stamps} or later') }`,
                "if ($slotAway) { Refuse 'slotscript' ($tool + ': the slot runner is not at ' + $slotScript + ' with the SHA-256 this plugin ships: copy it there, unchanged') }",
              ]
            : [
                // A named window without them: the plain window, saying why.
                '$slotFallback = $null',
                `if ($wtOld) { $slotFallback = "Windows Terminal ${WT_MIN.stamps} or later is not here, so a plain window, not the one named" } elseif ($slotAway) { $slotFallback = "the slot runner is not at " + $slotScript + " with the SHA-256 this plugin ships, so a plain window, not the one named" }`,
              ]),
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
    `$handPath = ${literal(launchHandPath(v.state))}`,
    '$taken = $false',
    '$final = $null',
    '$window = $null',
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
    `foreach ($p in (Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate, CommandLine${v.checks.floor === true ? ', PrivatePageCount' : ''})) { $table[[int]$p.ProcessId] = $p }`,
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
    // The floor, the cap and the input idle, read here, in the run that writes the record or opens the
    // tab (the same-run must-check): never a probe a moment before.
    ...(v.checks.floor === true ? [...GET_CLI, ...floorLines(v.heavyRoot, v.maxSessions)] : []),
    ...(v.checks.input === true ? INPUT_LINES : []),
    ...(elsewhere ? [...GET_BEACON, ...slotIdleLines(v.state, where.slot), "$transport = 'slot'"] : []),
    ...((transport === 'slot' && !elsewhere) || transport === 'auto' ? slotCheck : []),
    ...(transport === 'slot' && !elsewhere
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
          : transport === 'tab'
            ? ["$transport = 'tab'"]
            : []),
    ...wtCheck,
    // A tab whose ticket names more than one config folder, or carries a left record's stat, needs the
    // wrapper of pane file version 3, whose last look reads them: read here, whatever the caller judged
    // (a wrapper of version 2 reads its own config folder alone and checks no left record).
    ...(where !== 'auto' && 'pane' in where && (v.configDirs.length > 1 || input.left !== undefined)
      ? [
          `$paneFile = ${literal(panePath(v.state, where.pane.token) ?? '')}`,
          '$paneV = $null',
          'try { $paneDoc = [IO.File]::ReadAllText($paneFile) | ConvertFrom-Json; if ($paneDoc.v -is [ValueType]) { $paneV = [long]$paneDoc.v } } catch { $paneV = $null }',
          `if ($null -eq $paneV -or $paneV -lt ${PANE_VERSION}) { Refuse 'pane' ($tool + ': this tab' + [char]39 + 's claude wrapper is not of pane file version ${PANE_VERSION}, whose last look reads every config folder its ticket names and checks a left record, and this move needs that: copy the current claude-wrapper.ps1 into place') }`,
        ]
      : []),
    // claude-launch.ps1 in place at its own name, with the shipped hash, before anything is taken or
    // opened: the copy this launch carries is put there when the file is missing or has another hash;
    // refused only when it can't be. A slot or a tab runs that one too, by the hash its record or line
    // names: nothing else starts claude. Then the copy a person runs, never refused on.
    ...(transport !== 'pane'
      ? [
          `$launcherCopy = '${asciiBase64(LAUNCH_SCRIPT_TEXT)}'`,
          ...INSTALL_LAUNCHER,
          ...INSTALL_HAND_COPY,
          `$installWhy = Install-Launcher $launchPath $launcherCopy '${LAUNCH_SCRIPT_SHA256}'`,
          "if ($null -ne $installWhy) { Refuse 'launcher' ($tool + ': claude-launch.ps1 is not at ' + $launchPath + ' with the SHA-256 this plugin ships, and the copy it carries could not be put there: ' + $installWhy) }",
          `Install-HandCopy $handPath $launchPath ${LAUNCH_SCRIPT_VERSION}`,
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
    ...(transport === 'pane' ? writeTicket : transport === 'slot' ? writeRecord : transport === 'tab' ? openWt : transport === 'window' && v.wtLine === undefined ? openWindow : []).map(line => `  ${line}`),
    ...(transport === 'window' && v.wtLine !== undefined
      ? ['  if ($null -eq $slotFallback) {', ...openWt.map(line => `    ${line}`), '  } else {', ...openWindow.map(line => `    ${line}`), '  }']
      : []),
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
          // A window placed already: it would only sit saying it waits, as long as its claim holds, for a launch
          // no one wants. A tab's wt.exe has handed its tab over by now: the released claim turns the tab away.
          '  if ($transport -eq "window" -and $null -ne $window) { try { $window.Kill() } catch { } }',
          "  Refuse 'late' ($tool + ': the launch was placed past its deadline, or its claim was taken back meanwhile, so it is withdrawn')",
          '}',
        ]),
    ...(transport === 'auto' || (transport === 'window' && v.wtLine !== undefined) ? [`if ($transport -eq 'window' -and $null -ne $slotFallback) { ${say('"fallback " + ($slotFallback -split "\\r?\\n")[0]')} }`] : []),
    say('"launched " + $placed'),
  ]
  return lines.join('\r\n')
}

// ---------------------------------------------------------------------------------------------
// Placement: the file the person edits (\u00a76.1), read by one pure function; the shared fixture
// (scripts/placement-fixture.json) holds this and the layout script's PowerShell validator equal.

/** A place a launch may go, in a `prefer` list. */
export type PlacementLeg = 'slot' | 'tab' | 'window'

/** A window of the layout: its name, where it opens, its tabs' labels, and the folder they start in. */
export type LayoutWindow = { readonly window: string; readonly pos?: readonly [number, number]; readonly size?: readonly [number, number]; readonly tabs: readonly string[]; readonly folder: string }

/** Where launches go: `tab.window` by name, at most `maxTabs` beyond the layout's. */
export type PlacementLaunch = { readonly prefer: readonly PlacementLeg[]; readonly tab?: { readonly window: string; readonly maxTabs: number }; readonly window?: WtWindow }

/** Where a restart goes: `tab.window` by name, or `same`: the tab's own stamp's window. */
export type PlacementRestart = { readonly prefer: readonly PlacementLeg[]; readonly tab?: { readonly window: string }; readonly window?: WtWindow }

/** placement.json, read. `limits` as the file gives them: the slot runner's and a launch's defaults fill the rest. */
export type Placement = {
  readonly layout: readonly LayoutWindow[]
  readonly launch?: PlacementLaunch
  readonly restart?: PlacementRestart
  readonly workspaces?: Readonly<Record<string, string>>
  readonly limits?: { readonly minFreeGb?: number; readonly maxSessions?: number }
  readonly afterBoot?: { readonly fltFix?: string }
}

const isPos = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= 32768
const isSize = (cols: unknown, rows: unknown): boolean => typeof cols === 'number' && Number.isInteger(cols) && cols >= 20 && cols <= 400 && typeof rows === 'number' && Number.isInteger(rows) && rows >= 5 && rows <= 200
const isWholeIn = (value: unknown, low: number, high: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high

/**
 * placement.json's text, every field checked by \u00a76.1's rules: `{ placement }`, or `{ errors }` naming
 * each thing wrong; a bad file means no placement at all. Window names letters, digits, `_` and `-`, never
 * `0`, `last`, `new`, `-1` or all digits (a name WT reads as special, T-L6); tab labels; folders absolute,
 * with no quote, control character, `;` or `%` (that one is there, the layout script checks: this is pure);
 * `pos` within 32768, `size` 20 to 400 columns and 5 to 200 rows; `prefer` from the fixed set, each once;
 * `workspaces` window names to workspace ids; `limits.minFreeGb` 1 to 64, `limits.maxSessions` 1 to 40;
 * `afterBoot.fltFix` an absolute .ps1 of the same shape; unknown keys refused, naming them.
 */
export function readPlacement(text: string): { readonly placement: Placement } | { readonly errors: readonly string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\ufeff/, ''))
  } catch {
    return { errors: ['it is not JSON'] }
  }
  if (!isRecord(raw)) return { errors: ['it is not a JSON object'] }
  const errors: string[] = []
  const keys = (value: Record<string, unknown>, allowed: readonly string[], where: string): void => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${where} has an unknown key ${key}`)
  }
  keys(raw, ['v', 'layout', 'launch', 'restart', 'workspaces', 'limits', 'afterBoot'], 'the file')
  if (raw.v !== 1) errors.push('it is not version 1')
  const placeOf = (value: Record<string, unknown>, where: string): { pos?: [number, number]; size?: [number, number] } => {
    const out: { pos?: [number, number]; size?: [number, number] } = {}
    if (value.pos !== undefined) {
      if (Array.isArray(value.pos) && value.pos.length === 2 && isPos(value.pos[0]) && isPos(value.pos[1])) out.pos = [value.pos[0], value.pos[1]]
      else errors.push(`${where} has a pos that is not two whole numbers within 32768`)
    }
    if (value.size !== undefined) {
      if (Array.isArray(value.size) && value.size.length === 2 && isSize(value.size[0], value.size[1])) out.size = [value.size[0] as number, value.size[1] as number]
      else errors.push(`${where} has a size that is not 20-400 columns and 5-200 rows`)
    }
    return out
  }
  const preferOf = (value: unknown, where: string): PlacementLeg[] => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
      errors.push(`${where}.prefer is not a list of slot, tab and window`)
      return []
    }
    const seen: PlacementLeg[] = []
    for (const leg of value) {
      if (leg !== 'slot' && leg !== 'tab' && leg !== 'window') errors.push(`${where}.prefer holds something other than slot, tab and window`)
      else if (seen.includes(leg)) errors.push(`${where}.prefer holds ${leg} twice`)
      else seen.push(leg)
    }
    return seen
  }
  const namedWindow = (value: unknown, where: string): WtWindow | undefined => {
    if (!isRecord(value)) {
      errors.push(`${where}.window is not an object`)
      return undefined
    }
    keys(value, ['name', 'pos', 'size'], `${where}.window`)
    if (!isWindowName(value.name)) errors.push(`${where}.window.name is not a name Windows Terminal takes as one`)
    return { name: value.name as string, ...placeOf(value, `${where}.window`) }
  }
  const layout: LayoutWindow[] = []
  if (!Array.isArray(raw.layout)) errors.push('layout is not a list')
  else {
    const names = new Set<string>()
    raw.layout.forEach((value: unknown, at: number) => {
      const here = `layout[${at}]`
      if (!isRecord(value)) {
        errors.push(`${here} is not an object`)
        return
      }
      keys(value, ['window', 'pos', 'size', 'tabs', 'folder'], here)
      if (!isWindowName(value.window)) errors.push(`${here}.window is not a name Windows Terminal takes as one`)
      else if (names.has(value.window)) errors.push(`${here}.window names a window twice`)
      else names.add(value.window)
      const place = placeOf(value, here)
      const tabs: string[] = []
      if (!Array.isArray(value.tabs) || value.tabs.length < 1) errors.push(`${here}.tabs is not a list of tab labels`)
      else {
        for (const tab of value.tabs) {
          if (typeof tab !== 'string' || !TAB_LABEL.test(tab)) errors.push(`${here}.tabs holds something that is not a tab label`)
          else if (tabs.includes(tab)) errors.push(`${here}.tabs holds a label twice`)
          else tabs.push(tab)
        }
      }
      if (wtFolderFault(value.folder) !== undefined) errors.push(`${here}.folder is not an absolute folder with no quote, semicolon or %`)
      layout.push({ window: value.window as string, ...place, tabs, folder: value.folder as string })
    })
  }
  let launch: PlacementLaunch | undefined
  if (raw.launch !== undefined) {
    if (!isRecord(raw.launch)) errors.push('launch is not an object')
    else {
      keys(raw.launch, ['prefer', 'tab', 'window'], 'launch')
      const prefer = preferOf(raw.launch.prefer, 'launch')
      let tab: PlacementLaunch['tab']
      if (raw.launch.tab !== undefined) {
        if (!isRecord(raw.launch.tab)) errors.push('launch.tab is not an object')
        else {
          keys(raw.launch.tab, ['window', 'maxTabs'], 'launch.tab')
          if (!isWindowName(raw.launch.tab.window)) errors.push('launch.tab.window is not a name Windows Terminal takes as one')
          else if (raw.launch.tab.window === 'same') errors.push('launch.tab.window is same, which only restart.tab takes')
          if (!isWholeIn(raw.launch.tab.maxTabs, 1, 16)) errors.push('launch.tab.maxTabs is not a whole number from 1 to 16')
          tab = { window: raw.launch.tab.window as string, maxTabs: raw.launch.tab.maxTabs as number }
        }
      }
      const window = raw.launch.window === undefined ? undefined : namedWindow(raw.launch.window, 'launch')
      launch = { prefer, ...(tab === undefined ? {} : { tab }), ...(window === undefined ? {} : { window }) }
    }
  }
  let restart: PlacementRestart | undefined
  if (raw.restart !== undefined) {
    if (!isRecord(raw.restart)) errors.push('restart is not an object')
    else {
      keys(raw.restart, ['prefer', 'tab', 'window'], 'restart')
      const prefer = preferOf(raw.restart.prefer, 'restart')
      let tab: PlacementRestart['tab']
      if (raw.restart.tab !== undefined) {
        if (!isRecord(raw.restart.tab)) errors.push('restart.tab is not an object')
        else {
          keys(raw.restart.tab, ['window'], 'restart.tab')
          if (raw.restart.tab.window !== 'same' && !isWindowName(raw.restart.tab.window)) errors.push('restart.tab.window is neither same nor a name Windows Terminal takes as one')
          tab = { window: raw.restart.tab.window as string }
        }
      }
      const window = raw.restart.window === undefined ? undefined : namedWindow(raw.restart.window, 'restart')
      restart = { prefer, ...(tab === undefined ? {} : { tab }), ...(window === undefined ? {} : { window }) }
    }
  }
  let workspaces: Record<string, string> | undefined
  if (raw.workspaces !== undefined) {
    if (!isRecord(raw.workspaces)) errors.push('workspaces is not an object')
    else {
      workspaces = {}
      for (const [name, value] of Object.entries(raw.workspaces)) {
        if (!isWindowName(name)) errors.push(`workspaces has a key that is not a window name: ${name}`)
        if (typeof value !== 'string' || !WORKSPACE_ID.test(value)) errors.push(`workspaces.${name} is not a workspace id`)
        else workspaces[name] = value
      }
    }
  }
  let limits: Placement['limits']
  if (raw.limits !== undefined) {
    if (!isRecord(raw.limits)) errors.push('limits is not an object')
    else {
      keys(raw.limits, ['minFreeGb', 'maxSessions'], 'limits')
      if (raw.limits.minFreeGb !== undefined && !isWholeIn(raw.limits.minFreeGb, 1, 64)) errors.push('limits.minFreeGb is not a whole number from 1 to 64')
      if (raw.limits.maxSessions !== undefined && !isWholeIn(raw.limits.maxSessions, 1, 40)) errors.push('limits.maxSessions is not a whole number from 1 to 40')
      limits = { ...(raw.limits.minFreeGb === undefined ? {} : { minFreeGb: raw.limits.minFreeGb as number }), ...(raw.limits.maxSessions === undefined ? {} : { maxSessions: raw.limits.maxSessions as number }) }
    }
  }
  let afterBoot: Placement['afterBoot']
  if (raw.afterBoot !== undefined) {
    if (!isRecord(raw.afterBoot)) errors.push('afterBoot is not an object')
    else {
      keys(raw.afterBoot, ['fltFix'], 'afterBoot')
      const flt = raw.afterBoot.fltFix
      if (flt !== undefined && (wtFolderFault(flt) !== undefined || !/\.ps1$/i.test(flt as string))) errors.push('afterBoot.fltFix is not an absolute .ps1 file that is there, with no quote, semicolon or %')
      afterBoot = flt === undefined ? {} : { fltFix: flt as string }
    }
  }
  if (errors.length > 0) return { errors }
  return { placement: { layout, ...(launch === undefined ? {} : { launch }), ...(restart === undefined ? {} : { restart }), ...(workspaces === undefined ? {} : { workspaces }), ...(limits === undefined ? {} : { limits }), ...(afterBoot === undefined ? {} : { afterBoot }) } }
}

/**
 * placement.json under `state`, read with the engine: `placement`, or null when there is none; a bad
 * file means no placement, and `errors` says what is wrong with it. Never throws.
 */
export async function loadPlacement($: EngineInterface, state: string): Promise<{ readonly placement: Placement | null; readonly errors?: readonly string[] }> {
  try {
    const path = placementPath(state)
    if (!(await $.fs.exists(path))) return { placement: null }
    const text = await $.fs.read(path)
    if (typeof text !== 'string') return { placement: null, errors: ["it can't be read as text"] }
    const read = readPlacement(text)
    return 'errors' in read ? { placement: null, errors: read.errors } : { placement: read.placement }
  } catch (err) {
    return { placement: null, errors: [errorLine(err)] }
  }
}

/** A launch's memory floor, in KB, from a probe in slots mode: max(6 GB, 4 GB + the largest session's private bytes; 2 GB when none could be read). */
export function floorNeedKb(probe: Probe): number {
  const sizes = probe.procs.filter(p => isClaude(p) && p.cli !== true && p.privateBytes !== undefined).map(p => p.privateBytes as number)
  const largestKb = sizes.length === 0 ? LARGEST_UNREAD_GB * 1024 * 1024 : Math.max(...sizes) / 1024
  return Math.max(FLOOR_MIN_GB * 1024 * 1024, HEAVY_FLOOR_GB * 1024 * 1024 + largestKb)
}

/**
 * Whether a launch of another process may proceed, from a probe in slots mode: `ok`, or the first reason
 * it waits (PM5, \u00a75.6): `memory` (free under floorNeedKb, or unread), `heavy` (a heavy-slot waiter, both
 * slots busy, heavy-slot's folders unread, or read with no count), `cap` (the sessions at `maxSessions`, or
 * unread). A pure function: only advisory, as the launch reads each again in its own run (checks.floor).
 */
export function floorOk(probe: Probe, maxSessions: number): 'ok' | 'memory' | 'heavy' | 'cap' {
  if (!isCount(maxSessions, 40) || maxSessions < 1) throw new Error(`the cap is not a whole number from 1 to 40: ${JSON.stringify(maxSessions)}`)
  if (probe.freeKb === null || probe.freeKb < floorNeedKb(probe)) return 'memory'
  if (probe.errors.some(e => e.source === 'heavy')) return 'heavy'
  // A reading that doesn't say whether heavy-slot was looked at isn't a floor's: only a named none skips it.
  if (probe.heavyChecked === undefined) return 'heavy'
  // Read, yet with no count: not a reading that says it's free. Only a named none has none.
  if (probe.heavyChecked && (probe.heavyWaiters === null || probe.heavyBusy === null)) return 'heavy'
  if ((probe.heavyWaiters ?? 0) > 0 || (probe.heavyBusy ?? 0) >= 2) return 'heavy'
  if (probe.room === null || probe.room >= maxSessions) return 'cap'
  return 'ok'
}

/** Whether the machine's input has been idle long enough for a launch: a null reading is not idle (PM2). */
export const inputIdle = (probe: Probe): boolean => probe.inputIdleSec !== null && probe.inputIdleSec * 1000 >= INPUT_IDLE_MS

/**
 * The slot runners a launch of another process may use, first to last (\u00a75.5): the shipped hash; no
 * claude.exe under it; its beacon idle for at least 10 s; its window untagged, or tagged with this
 * workspace; its config folder the one asked for.
 */
export function idleSlots(probe: Probe, placement: Placement | null, opts: { readonly workspace?: string; readonly configDir: string; readonly now: number }): SlotRunner[] {
  return (probe.slots ?? [])
    .filter(slot => {
      const beacon = slot.beacon
      if (slot.sha256 !== SLOT_SCRIPT_SHA256 || slot.child !== null || beacon === null || beacon.state !== 'idle' || beacon.sha256 !== SLOT_SCRIPT_SHA256) return false
      if (opts.now - beacon.since < SLOT_IDLE_MIN_MS) return false
      if (!sameFolder(beacon.configDir, opts.configDir)) return false
      const tag = beacon.window === undefined ? undefined : placement?.workspaces?.[beacon.window]
      return tag === undefined || tag === opts.workspace
    })
    .sort((a, b) => a.pid - b.pid)
}

/** The overflow tabs in `window`: slots stamped with it whose tab isn't one of the layout's for it. */
function overflowTabs(probe: Probe, placement: Placement, window: string): number {
  const own = placement.layout.find(w => w.window === window)?.tabs ?? []
  return (probe.slots ?? []).filter(slot => slot.beacon?.window === window && !(slot.beacon.tab !== undefined && own.includes(slot.beacon.tab))).length
}

/** Where a launch goes, and the places to try if that one is refused for want of Windows Terminal or the slot script. */
export type LaunchPick = { readonly where: LaunchWhere; readonly fallback?: string; readonly then?: readonly LaunchWhere[] } | { readonly wait: 'input' | 'slot'; readonly why: string }

/** What pickLaunchTransport is told besides the probe and the placement. */
export type PickOptions = {
  /** A launch that replaces its caller: a restart, a switch out of this pane, the coordinator's go. */
  readonly replacing: boolean
  /** This tab's claude wrapper, when the session carries its token. */
  readonly pane?: { readonly token: string; readonly pane: Pane }
  /** How many config folders the launch reads (1 to 8: a tab of pane file version 2 reads one alone). */
  readonly configCount: number
  /** Whether the verdict rests on a left record (it waived L3 and L5). */
  readonly needsLeft: boolean
  /** The placement's section: `restart` for self-restart, else `launch`. */
  readonly using?: 'launch' | 'restart'
  /** This tab's stamp, as its environment says (`same`, and a tab's label). */
  readonly stamp?: { readonly window?: string; readonly tab?: string }
  /** A tab's label: the session's name for a start. */
  readonly title?: string
  /** The conversation's folder: one Windows Terminal would expand goes to no tab or named window. */
  readonly folder?: string
  /** The workspace a launch belongs to: a window tagged with another is passed over. Required of a launch of another process; one that replaces its caller names none. */
  readonly workspace?: string
  /** The config folder the conversation needs (a resume), or the machine's default (a start). */
  readonly configDir?: string
  /** Now, for how long a beacon has said idle. */
  readonly now?: number
  /** A launch that replaces its caller, whose tab or window waits for the input idle too (a replacing fresh, PM6). */
  readonly needsInput?: boolean
}

/** A tab or a window by the placement's section, in its `prefer` order: where a launch goes past a slot. */
function placedLegs(probe: Probe, placement: Placement | null, opts: PickOptions): { readonly legs: LaunchWhere[]; readonly why?: string } {
  if (placement === null) return { legs: [] }
  const using = opts.using ?? 'launch'
  const section = using === 'restart' ? placement.restart : placement.launch
  if (section === undefined) return { legs: [] }
  // A folder Windows Terminal would expand reaches no wt string: past the slot, a plain window.
  const fault = opts.folder === undefined ? undefined : wtFolderFault(opts.folder)
  if (fault !== undefined) return { legs: [], why: `its folder ${fault}, so no tab or named window` }
  const legs: LaunchWhere[] = []
  const said: string[] = []
  // A launch of another process always names one (pickLaunchTransport throws); a move of this session's own names none, and goes where it goes.
  const taggedElsewhere = (window: string): boolean => {
    const tag = placement.workspaces?.[window]
    return opts.workspace !== undefined && tag !== undefined && tag !== opts.workspace
  }
  for (const leg of section.prefer) {
    if (leg === 'tab' && section.tab !== undefined) {
      const window = section.tab.window === 'same' ? opts.stamp?.window : section.tab.window
      if (window === undefined || !isWindowName(window)) {
        said.push('this tab carries no window stamp')
        continue
      }
      if (taggedElsewhere(window)) {
        said.push(`window ${window} is tagged for another workspace`)
        continue
      }
      const maxTabs = 'maxTabs' in section.tab ? (section.tab as { maxTabs: number }).maxTabs : undefined
      if (maxTabs !== undefined && (probe.slots === null || overflowTabs(probe, placement, window) >= maxTabs)) {
        said.push(`window ${window} has no room for another overflow tab`)
        continue
      }
      const home = placement.layout.find(w => w.window === window)
      const title = section.tab.window === 'same' && opts.stamp?.tab !== undefined && TAB_LABEL.test(opts.stamp.tab) ? opts.stamp.tab : (opts.title ?? 'overflow')
      legs.push({ tab: { window, title, ...(home?.pos === undefined ? {} : { pos: home.pos }), ...(home?.size === undefined ? {} : { size: home.size }) } })
    }
    if (leg === 'window') {
      const named = section.window ?? placement.launch?.window
      if (named !== undefined && taggedElsewhere(named.name)) said.push(`window ${named.name} is tagged for another workspace`)
      else if (named !== undefined) legs.push({ window: named })
      else said.push('the placement names no window')
    }
  }
  return { legs, ...(said.length === 0 ? {} : { why: said.join('; ') }) }
}

/**
 * Where a launch goes, on the probe that judged it, in the coordinating note's order; a pure function.
 *
 * A launch that replaces its caller (`replacing`): this tab through the claude wrapper (its pane file's
 * PowerShell is this claude.exe's own parent, and its last look reads what the launch needs); else this
 * pane's slot, its script of the shipped hash; else the placement's tab or window in the section's
 * `prefer` order; else a new window, `fallback` saying why a slot runner found here wasn't used.
 *
 * A launch of another process: the machine's input idle for at least 60 s, whichever the place (PM2: a null
 * reading is not idle, `wait: 'input'`); then, in `launch.prefer`'s order: the first idle slot (idleSlots);
 * a tab, with room in `maxTabs`; a window, when the placement allows it. With no placement: the first idle
 * slot, else today's window. Else `wait: 'slot'`.
 *
 * Two are required, never defaulted, so a caller can't leave out what weakens a tab's last look:
 * `configCount` (1 to 8), and `needsLeft`, whether the verdict rests on a left record. The launch itself
 * refuses a tab of pane file version 2 for either all the same. Throws on a count that isn't 1 to 8. A launch
 * of another process names `configDir`, `now` and `workspace` too, or it throws: with no workspace, idleSlots
 * would pass over a tagged slot and the placed legs take a tagged tab or window instead.
 */
export function pickLaunchTransport(probe: Probe, placement: Placement | null, opts: PickOptions): LaunchPick {
  if (!Number.isInteger(opts.configCount) || opts.configCount < 1 || opts.configCount > 8) throw new Error(`a launch reads 1 to 8 config folders, not ${JSON.stringify(opts.configCount)}`)
  if (typeof opts.needsLeft !== 'boolean') throw new Error('needsLeft says whether the verdict rests on a left record: true or false')
  const notIdle: LaunchPick = { wait: 'input', why: probe.inputIdleSec === null ? "the machine's input idle could not be read, and that is not idle" : `the machine had input ${probe.inputIdleSec} seconds ago, under ${INPUT_IDLE_MS / 1000}` }
  if (opts.replacing) {
    const tab = opts.pane
    if (tab !== undefined && PANE_TOKEN.test(tab.token) && paneFallback(probe, tab.pane) === undefined && paneReads(tab.pane, opts.configCount) === undefined && (!opts.needsLeft || paneNoLeft(tab.pane) === undefined)) return { where: { pane: { token: tab.token } } }
    const slot = probe.slot
    if (slot !== null && slotVerified(slot)) return { where: { slot: slot.id } }
    const fallback = slot !== null ? slotFallback(slot) : probe.slotSeen ? SLOT_NOT_RECOGNISED : undefined
    if (opts.needsInput === true && !inputIdle(probe)) return notIdle
    const { legs } = placedLegs(probe, placement, opts)
    const [first, ...then] = [...legs, { window: true } as const]
    return { where: first as LaunchWhere, ...(fallback === undefined ? {} : { fallback }), ...(then.length === 0 ? {} : { then }) }
  }
  if (!inputIdle(probe)) return notIdle
  if (opts.configDir === undefined || opts.now === undefined) throw new Error('a launch of another process names the config folder it needs, and now')
  if (opts.workspace === undefined) throw new Error('a launch of another process names its workspace: with none, the tags on tabs and windows would not hold it')
  const slots = idleSlots(probe, placement, { configDir: opts.configDir, now: opts.now, ...(opts.workspace === undefined ? {} : { workspace: opts.workspace }) })
  const first = slots[0]
  if (placement === null || placement.launch === undefined) return first !== undefined ? { where: { slot: first.id } } : { where: { window: true } }
  const { legs, why } = placedLegs(probe, placement, { ...opts, using: 'launch' })
  // Each place in the file's order: a slot where `prefer` names it, or the placed legs as they fall.
  const ordered: LaunchWhere[] = []
  for (const leg of placement.launch.prefer) {
    if (leg === 'slot' && first !== undefined) ordered.push({ slot: first.id })
    if (leg === 'tab') ordered.push(...legs.filter(place => typeof place === 'object' && 'tab' in place))
    if (leg === 'window') ordered.push(...legs.filter(place => typeof place === 'object' && 'window' in place))
  }
  const [next, ...then] = ordered
  if (next === undefined) return { wait: 'slot', why: `no slot is idle, and no tab or window is open to it${why === undefined ? '' : ` (${why})`}` }
  return { where: next, ...(then.length === 0 ? {} : { then }) }
}

/** The claim a place takes, when the place decides it: its slot's. Undefined: a launch's own, fresh for each launch, a tab's and a named window's too (the tab names it to its runner), so a later launch that takes the lock over turns an earlier one away. */
export function claimOf(where: LaunchWhere): string | undefined {
  return where !== 'auto' && 'slot' in where ? `slot:${where.slot}` : undefined
}

/** The label a tab or a named window gets for a resume, when the placement gives none: of letters, digits and a hyphen. */
export const resumeTitle = (id: string): string => `resume-${id.slice(0, 8)}`


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

/** The relock script's answer: the lock re-owned, none there, one naming another, or one held by a taker throughout. */
export const RELOCKED = /^(relocked|absent|not-ours|busy|held)\s*$/m

/**
 * Re-owns the claim lock on `id` to `holder` (review gap 7): a launch whose process is stuck at a dialog
 * keeps the conversation claimed, and the lock isn't stale while that process runs, whoever made it. Only
 * a lock naming this launch's `by`: read and rewritten through one handle that lets no one else write it,
 * every other field as it was. Throws on any input that isn't what it must be.
 */
export function relockScript(input: { readonly stateDir: string; readonly id: string; readonly by: string; readonly holder: ProcessRef }): string {
  const { state, id, by } = checkClaim(input)
  if (!isPid(input.holder.pid) || !isTicks(input.holder.created)) throw new Error('the holder is not a pid and a time as a string')
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    PSMODULEPATH_RESET,
    `$path = ${literal(claimPath(state, id))}`,
    "$answer = 'busy'",
    "for ($try = 0; $try -lt 3 -and $answer -eq 'busy'; $try++) {",
    '  if ($try -gt 0) { Start-Sleep -Milliseconds 250 }',
    '  try { $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read) }',
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
    `    if ($null -eq $lock -or $lock.by -cne '${by}') { $answer = 'not-ours' }`,
    '    else {',
    // A different holder, still running, stays: two launches stuck under one `by` hold what each holds.
    `      $held = $false; if ($null -ne $lock.holder -and $lock.holder.pid -is [ValueType] -and "$($lock.holder.created)" -match '^\\d{1,20}\\z' -and -not ([long]$lock.holder.pid -eq ${input.holder.pid} -and "$($lock.holder.created)" -ceq '${input.holder.created}')) { $other = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = " + [long]$lock.holder.pid) -Property ProcessId, CreationDate; if ($null -ne $other -and [math]::Abs($other.CreationDate.ToFileTimeUtc() - [long]"$($lock.holder.created)") -le ${PROC_START_TOLERANCE}) { $held = $true } }`,
    "      if ($held) { $answer = 'held' } else {",
    `      $bytes = [Text.Encoding]::UTF8.GetBytes(([ordered]@{ v = $lock.v; by = $lock.by; pid = $lock.pid; created = $lock.created; at = $lock.at; transport = $lock.transport; holder = [ordered]@{ pid = ${input.holder.pid}; created = '${input.holder.created}' } } | ConvertTo-Json -Compress -Depth 3))`,
    '      [void]$stream.Seek(0, [IO.SeekOrigin]::Begin)',
    '      $stream.SetLength(0)',
    '      $stream.Write($bytes, 0, $bytes.Length)',
    '      $stream.Flush()',
    "      $answer = 'relocked'",
    '      }',
    '    }',
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

/**
 * One job as the built-in CronList tool lists it: a session cron (CronCreate, ScheduleWakeup, /loop).
 * `durable`: CronCreate's durable job, which survives the exit (the session's others end with it).
 */
export type CronJob = {
  readonly id: string
  readonly humanSchedule?: string
  readonly cron?: string
  readonly prompt?: string
  readonly recurring?: boolean
  readonly durable?: boolean
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
 *   where the caller has none to read: no plugin's pre-check has one (a classic Stop hook in each would be
 *   a new gating hook, for work the process tree and the agent list mostly show already).
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
      ...(typeof job.durable === 'boolean' ? { durable: job.durable } : {}),
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
  shell: p => `the shell ${p.name} ${p.pid} runs under this session (a background job of the Bash, PowerShell or Monitor tool, or a tool call still finishing)`,
  build: p => `${p.name} ${p.pid} under this session is a build, test or lint`,
  'heavy-slot': p => `a heavy-slot job (${p.name} ${p.pid}) runs under this session`,
}

/**
 * How to clear a shell under the session: stop the job, or, when no background job was started, wait: a tool call
 * still finishing reads the same (self-check's check at a resume runs one for a few seconds).
 */
const SHELL_WAY = "stop it with TaskStop (the task id its Bash, PowerShell or Monitor call gave), or let it finish; if you started no background job, it is a tool call still finishing (self-check's check at a resume runs one): call again in a moment"

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
      // A durable cron is named apart: it doesn't end with the session, so it would go on after the exit.
      const what = job.durable === true ? `durable cron ${id} (${when}${words}) is set, and survives the exit` : `cron ${id} (${when}${words}) is set to wake this session`
      found.push({ kind: 'cron', id: job.id, what, howToStop: `delete it with CronDelete (id ${id})` })
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
          howToStop: (jobClass(p) ?? 'shell') === 'shell' ? SHELL_WAY : 'stop it with TaskStop (the task id its Bash, PowerShell or Monitor call gave), or let it finish',
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
      if (!isBusyAgent(agent.status)) continue
      const name = agentName(agent)
      const id = typeof agent.id === 'string' && agent.id !== '' ? agent.id : undefined
      const stop = `stop it with TaskStop${id === undefined ? '' : ` (${idText(id)})`}`
      found.push({
        kind: 'subagent',
        ...(id === undefined ? {} : { id }),
        what: agent.status === 'running' ? `a subagent is still running (${name})` : `a subagent hasn't ended (${name}; ${oneLine(agent.status, 40)})`,
        // One at its task reports on its own; an idle teammate, or a status this code doesn't know, may
        // never: it still holds, and says how to clear it.
        howToStop: AGENT_AT_WORK.includes(agent.status) ? `wait for it to report, or ${stop}` : `${stop}, or exit by hand`,
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
      ...(typeof job.durable === 'boolean' ? { durable: job.durable } : {}),
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
      const err = plainOutput(run.stderr)
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
 * absent: no probe, off Windows), and the wake-up of the conversation `more.wake` names.
 */
export async function readExit(
  $: EngineInterface,
  probe?: { readonly powershell: string; readonly id: string } | string,
  more: { readonly wake?: { readonly state: string; readonly id: string } } = {},
): Promise<ExitInputs> {
  const [crons, agents, busy, wake] = await Promise.all([
    readCrons($),
    readAgents($),
    probe === undefined || typeof probe === 'string' ? Promise.resolve(probe) : runProbe($, probe),
    more.wake === undefined ? Promise.resolve(undefined) : readWake($, more.wake.state, more.wake.id).then(exitWake),
  ])
  return { crons, agents, ...(busy === undefined ? {} : { busy }), ...(wake === undefined ? {} : { wake }) }
}

/** S10w's read as exitBlockers takes it: a pending wake-up by when it is due, null for none, why when unknown, which holds as pending does. */
export const exitWake = (read: WakeRead): WakeLike | null | string => (read.wake === 'pending' ? { due: read.due } : read.wake === 'none' ? null : read.why)

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
    ...GET_LEFT_FIELDS,
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
    // One writer at a time per conversation (the coordinator's go and this plugin both write this record): a lock
    // made new (CreateNew) and held as a handle no one else may open, deleted when it closes or this process ends (one
    // there is another writer's, waited for), from before the transcript
    // is stat-ed to after the record is in place. So the stat, the look for the same move and the write are one
    // step, and a later writer stats the transcript after the earlier one has written.
    `$leftLockPath = ${literal(idPath(state, 'leftLock', id))}`,
    '[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($leftLockPath))',
    '$leftLock = $null',
    'for ($try = 0; $try -lt 80 -and $null -eq $leftLock; $try++) {',
    '  try { $leftLock = [IO.FileStream]::new($leftLockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose) }',
    `  catch { if (-not (${IS_IO} -or $_.Exception -is [UnauthorizedAccessException] -or $_.Exception.InnerException -is [UnauthorizedAccessException])) { throw }; Start-Sleep -Milliseconds 125 }`,
    '}',
    "if ($null -eq $leftLock) { 'refused lock another writer held this record for 10 seconds'; exit 0 }",
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
    // The key: created once, never replaced. Its 32 bytes are written whole under another name (CreateNew),
    // then moved into place, which a key already there refuses: so a crash part way never leaves a torn
    // key where the records look for it. Then read.
    '[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($leftKeyPath))',
    '$keyTmp = $leftKeyPath + "." + [guid]::NewGuid().ToString("N") + ".tmp"',
    'try {',
    '  if (-not (Test-Path -LiteralPath $leftKeyPath -PathType Leaf)) {',
    '    $keyStream = [IO.File]::Open($keyTmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)',
    '    try { $fresh = New-Object byte[] 32; $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); try { $rng.GetBytes($fresh) } finally { $rng.Dispose() }; $keyStream.Write($fresh, 0, 32); $keyStream.Flush($true) } finally { $keyStream.Dispose(); $fresh = $null }',
    '    [IO.File]::Move($keyTmp, $leftKeyPath)',
    '  }',
    `} catch { if (-not ${IS_IO}) { throw } } finally { try { if ([IO.File]::Exists($keyTmp)) { [IO.File]::Delete($keyTmp) } } catch { } }`,
    '$leftKey = $null',
    'for ($try = 0; $try -lt 3 -and $null -eq $leftKey; $try++) { if ($try -gt 0) { Start-Sleep -Milliseconds 100 }; try { $leftKey = [IO.File]::ReadAllBytes($leftKeyPath) } catch { $leftKey = $null } }',
    // A key of another length was cut short when it was made (by a version that wrote it in place): it
    // is never replaced, so it is said how to start again.
    "if ($null -eq $leftKey -or $leftKey.Length -ne 32) { $leftKey = $null; 'refused key the left key (' + $leftKeyPath + ') can not be read as 32 bytes: if it is there and not 32 bytes long, it was cut short when it was made; delete it, and the next record makes a new one (records made under it then waive nothing)'; exit 0 }",
    // The fields, each a string, as the reader checks them; then the MAC over them, and the key let go.
    '$f = [ordered]@{ id = $id; how = $how; pid = ([string][long]$session.ProcessId); created = (Get-Created $session); at = ([string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()); dir = $one.dir; project = $one.project; size = ([string][long]$one.item.Length); mtime = ([string]([DateTimeOffset]$one.item.LastWriteTimeUtc).ToUnixTimeMilliseconds()); by = $by; go = $go }',
    '$mac = Get-LeftMac $leftKey (Get-LeftText $f)',
    '$leftKey = $null',
    '$record = [ordered]@{ v = 1; id = $f.id; how = $f.how; pid = $f.pid; created = $f.created; at = $f.at; transcript = [ordered]@{ dir = $f.dir; project = $f.project; size = $f.size; mtime = $f.mtime }; by = $f.by }',
    'if ($go -ne "") { $record["go"] = $go }',
    '$record["mac"] = $mac',
    '$final = $leftPath',
    '$text = $record | ConvertTo-Json -Compress -Depth 4',
    // The same move's record already there (the coordinator's go and this plugin each write one for an in-place go,
    // whichever gets here first): it stands, and this one counts as written. The same move: a record of its shape
    // under its MAC, by the other writer, of the same id and how, by this very process, over the same transcript size
    // and time, written within LEFT_SAME_MOVE_MS either side of this one; and when this write names a go, that go.
    // So a write without a go never replaces a record of the same move that has one, and a write with one replaces a
    // record without it. Any other record is replaced, as it always is; one that appears between the look and the
    // move (the move then fails: the file exists) is looked at again, and replaced when it isn't the same move.
    'function Test-SameLeft {',
    '  $e = $null',
    '  try { $e = Get-Content -LiteralPath $leftPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $false }',
    '  $ef = Get-LeftFields $e',
    '  if ($null -eq $ef -or $e.mac -isnot [string]) { return $false }',
    '  if ($ef.id -cne $id -or $ef.how -cne $how -or $ef.pid -cne $f.pid -or $ef.created -cne $f.created -or $ef.size -cne $f.size -or $ef.mtime -cne $f.mtime -or $ef.by -ceq $by) { return $false }',
    '  if ($go -ne "" -and $ef.go -cne $go) { return $false }',
    '  $apart = $null',
    '  try { $apart = [math]::Abs([long]$f.at - [long]$ef.at) } catch { return $false }',
    `  if ($apart -gt ${LEFT_SAME_MOVE_MS}) { return $false }`,
    '  $sameKey = $null',
    '  try { $sameKey = [IO.File]::ReadAllBytes($leftKeyPath) } catch { return $false }',
    '  try { return ((Get-LeftMac $sameKey (Get-LeftText $ef)) -ceq $e.mac) } finally { $sameKey = $null }',
    '}',
    // Whole, by a temporary file and a move or a replace; the same move looked for at each try and again right before a
    // replace, so a record the other writer made a moment ago is never replaced unread. A move that fails (the other's
    // file appeared) is tried again, up to three times.
    '[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($final))',
    '$written = $false',
    'for ($try = 0; $try -lt 3 -and -not $written; $try++) {',
    '  if ($try -gt 0) { Start-Sleep -Milliseconds 100 }',
    '  if (Test-SameLeft) { "left " + $id; exit 0 }',
    '  $temp = $final + "." + [guid]::NewGuid().ToString() + ".tmp"',
    '  [IO.File]::WriteAllText($temp, $text)',
    '  try {',
    '    if ([IO.File]::Exists($final)) { if (Test-SameLeft) { [IO.File]::Delete($temp); "left " + $id; exit 0 }; [IO.File]::Replace($temp, $final, [NullString]::Value) } else { [IO.File]::Move($temp, $final) }',
    '    $written = $true',
    '  } catch { try { [IO.File]::Delete($temp) } catch { }; if ($try -ge 2) { throw } }',
    '}',
    'try { $leftLock.Dispose() } catch { }',
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

/**
 * The way out of an unknown S10w when self-wake is new enough already: a self-wake updated on disk but
 * not loaded yet writes no marker until /reload-plugins; one whose write failed writes it again at
 * cancel_wake.
 */
const WAKE_WAY_OUT = `if it is ${SELF_WAKE_MARKER_VERSION} or later already, run /reload-plugins (a self-wake updated but not yet loaded writes no marker), or call cancel_wake, which writes the marker again (and cancels any wake-up set)`

/** S10w's read of a conversation's wake-up: pending (and when), none (and why), or unknown (and why), which holds as pending does. */
export type WakeRead = { readonly wake: 'pending'; readonly due: number } | { readonly wake: 'none'; readonly why: string } | { readonly wake: 'unknown'; readonly why: string }

/**
 * Whether a wake-up is pending for conversation `id` (S10w, \u00a77.1): with self-wake in this session (its
 * tool in `$.tool.list()`), its marker says, armed or not; a marker that isn't there or doesn't parse,
 * or a tool list that can't be read, is unknown, and unknown holds. Without self-wake, there is nothing
 * to wait for.
 */
export async function readWake($: EngineInterface, state: string, id: string, other?: { readonly now: number }): Promise<WakeRead> {
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
    if (!(await $.fs.exists(path))) return { wake: 'unknown', why: `self-wake is on, but its marker for this conversation isn't there (${path}): update self-wake to ${SELF_WAKE_MARKER_VERSION} or later, which writes one; ${WAKE_WAY_OUT}` }
    text = await $.fs.read(path)
  } catch (err) {
    return { wake: 'unknown', why: `self-wake's marker for this conversation can't be read (${errorLine(err)}): self-wake ${SELF_WAKE_MARKER_VERSION} or later writes one this plugin reads; ${WAKE_WAY_OUT}` }
  }
  const marker = typeof text === 'string' ? readWakeMarker(text) : undefined
  if (marker === undefined) return { wake: 'unknown', why: `self-wake's marker for this conversation is not of its shape: update self-wake to ${SELF_WAKE_MARKER_VERSION} or later; ${WAKE_WAY_OUT}` }
  if (other !== undefined && marker.armed && marker.due !== undefined && wakeStale(marker, other.now)) {
    return { wake: 'unknown', why: `its marker says a wake-up was due at ${new Date(marker.due).toISOString().slice(0, 16).replace('T', ' ')} UTC, which has passed: the process that armed it is likely gone` }
  }
  return marker.armed && marker.due !== undefined ? { wake: 'pending', due: marker.due } : { wake: 'none', why: 'no wake-up is armed' }
}

/**
 * A wake-up should have fired this long ago before another session's read stops taking its marker's word:
 * the timer fires at `due` and rewrites the marker at once, so one still armed past this is a process
 * that exited with it armed. The session itself reads its own marker as it stands.
 */
export const WAKE_STALE_GRACE_MS = 5 * 60 * 1000

/** Whether an armed marker's wake-up is past due by more than the grace: for a reader other than the session itself (`readWake`'s `other`: the coordinator's pool). */
export const wakeStale = (marker: WakeMarker, now: number): boolean => marker.armed && marker.due !== undefined && marker.due < now - WAKE_STALE_GRACE_MS

/** The wake marker removal's answer: `removed` (no marker there now), or `kept <why>`. */
export const WAKE_REMOVED = /^(removed|kept)(?: (.{1,600}?))?\s*$/m

/**
 * Removes conversation `id`'s wake marker, so that S10w reads its wake-up as unknown, which holds: for
 * self-wake when it couldn't write the marker saying a wake-up is armed, and the marker left there says
 * none is (read as none, it would let a switch drop the wake-up). A plugin can't delete a file; this one
 * fixed script does, by the path wakePath builds. Throws on an id that isn't a session id.
 */
export function wakeRemoveScript(input: { readonly stateDir: string; readonly id: string }): string {
  const state = checkFolder('the state folder', input.stateDir)
  const path = wakePath(state, checkId(input.id))
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    PSMODULEPATH_RESET,
    `$path = ${literal(path)}`,
    '$why = "it is still there"',
    'for ($try = 0; $try -lt 3 -and [IO.File]::Exists($path); $try++) { if ($try -gt 0) { Start-Sleep -Milliseconds 200 }; try { [IO.File]::Delete($path) } catch { $why = $_.Exception.Message } }',
    'if ([IO.File]::Exists($path)) { "kept " + (("" + $why) -split "\\r?\\n")[0] } else { "removed" }',
  ].join('\r\n')
}

/** How long removing a wake marker may take. */
export const WAKE_REMOVE_MS = 15_000

/**
 * Runs wakeRemoveScript for conversation `id` under `state`, with Windows PowerShell by its known
 * path: whether no marker is there now. Never throws; anything that goes wrong is a marker kept.
 */
export async function removeWakeMarker($: EngineInterface, powershell: string, state: string, id: string): Promise<boolean> {
  try {
    const call = powershellCall(powershell, wakeRemoveScript({ stateDir: state, id }))
    const run = await $.process.run(call.argv, { stdin: call.stdin, timeoutMs: WAKE_REMOVE_MS })
    return run.exitCode === 0 && WAKE_REMOVED.exec(run.stdout)?.[1] === 'removed'
  } catch {
    return false
  }
}

/** S10w as a reason a go or a switch holds, or undefined when it doesn't. */
export function wakeHold(read: WakeRead): string | undefined {
  if (read.wake === 'pending') return `S10w: a wake-up is pending (due ${new Date(read.due).toISOString().slice(0, 16).replace('T', ' ')} UTC): cancel it with cancel_wake, or wait for it`
  if (read.wake === 'unknown') return `S10w: whether a wake-up is pending is unknown, and unknown holds: ${read.why}`
  return undefined
}

// ---------------------------------------------------------------------------------------------
// The trampoline (\u00a77.3): a final command that checks again when it is dequeued.
//
// `$.command.run` queues; a turn that enters right after the same-tick check runs first, and the command
// after it with no fresh safe point. So the plugin registers a command of its own at session.start,
// answers it with a command.run hook on that literal name (which never reads `next`, so validate lists it
// as answering its own command, not as a gate), and queues that, with a nonce, instead of the final
// command. Its handler runs when the engine dequeues it, after any racing turn: it checks again, and only
// then queues the real command, unawaited (awaiting would wait on the queue the handler itself holds);
// otherwise it withdraws what the switch or the restart placed. GO_VIA ships as 'direct': the plain
// command, as before. Flipping it is one commit, once the live checks M17a-d have passed.

/** How a final command runs. One constant: the flip to 'trampoline' is one commit, after M17a-d pass live. */
export const GO_VIA: 'trampoline' | 'direct' = 'direct'

/** One final command and what hangs on it. */
export type GoStep = {
  /** The command that ends the switch or the restart: `exit`, `resume`, `clear`. */
  readonly command: string
  readonly args?: string
  /** The conversation this step belongs to, by the event's id. */
  readonly conversation: string
  /** The conversation this process holds now. */
  readonly holds: () => Promise<string | undefined>
  /** The session's subagents, or why they can't be read. */
  readonly agents: () => Promise<readonly AgentLike[] | string>
  /** For an exit: the process tree alone, or why it can't be read. S2 to S6 hold on it. */
  readonly probe?: () => Promise<Probe | string>
  /** Right before the command, once every check has passed (self-switch's exit record). */
  readonly before?: () => Promise<void>
  /** After the command has run. */
  readonly after?: () => Promise<void>
  /** The command, or its queueing, failed. */
  readonly failed: (err: unknown) => Promise<void>
  /** It stood down: everything placed is taken back, saying why. Only ever on the trampoline. */
  readonly withdraw: (said: string) => Promise<void>
  /** What the handler answers when the command goes ahead. */
  readonly runs: string
}

/** The handler's answer when nothing is armed under that nonce: a person typed the command, or a stale queue entry. */
export const GO_NOTHING = 'Nothing to do.'

/** One plugin's trampoline: its command and its state, and the two marks of a main-loop turn. goRun and goAnswer act on it. */
export type Go = {
  /** The plugin's own command. */
  readonly name: string
  /** How this plugin's final commands run: GO_VIA, in what ships. */
  via: 'trampoline' | 'direct'
  /** How many main-loop turns have started: a turn since arming stands the step down. */
  epoch: number
  /** Whether a main-loop turn is running now. */
  running: boolean
  /** The step waiting for its command to be dequeued, under its nonce. */
  armed: { readonly nonce: string; readonly step: GoStep; readonly epoch: number } | undefined
  /** Each main-loop turn's start and end. */
  turnStarted: () => void
  turnEnded: () => void
}

/** 16 random hex digits: what the handler is told, so a person's typing or a stale entry acts on nothing. */
function goNonce(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** A plugin's trampoline, for its command `name`: one per plugin. */
export function goStep(name: string): Go {
  const go: Go = {
    name,
    via: GO_VIA,
    epoch: 0,
    running: false,
    armed: undefined,
    turnStarted: () => {
      go.epoch += 1
      go.running = true
    },
    turnEnded: () => {
      go.running = false
    },
  }
  return go
}

/** Queues the step's command. */
function queueIt($: EngineInterface, step: GoStep): Promise<void> {
  return $.command.run({ command: step.command, ...(step.args === undefined ? {} : { args: step.args }) }).then(() => undefined)
}

/** Why a step stands down now, or undefined when it goes ahead: every check at dequeue. */
async function goRecheck(go: Go, at: { readonly step: GoStep; readonly epoch: number }): Promise<string | undefined> {
  const fresh = (): string | undefined => (go.epoch !== at.epoch || go.running ? 'a turn came first' : undefined)
  if (fresh() !== undefined) return fresh()
  if ((await at.step.holds()) !== at.step.conversation) return 'this session became another conversation'
  const agents = await at.step.agents()
  const busy = typeof agents === 'string' ? `its subagents can't be read (${agents})` : agents.some(a => isBusyAgent(a.status)) ? agentsHeld(agents.filter(a => isBusyAgent(a.status))) : undefined
  if (busy !== undefined) return busy
  if (at.step.probe !== undefined) {
    const safe = safePoint(await at.step.probe(), { isReadable: true, markers: [], trees: [] }, [])
    if (safe.verdict !== 'clear') return safe.reasons.join('; ')
  }
  return fresh()
}

/**
 * Runs `step`: the plain command, or through the trampoline. Never rejects: failures go to `step.failed`.
 * A plain function, as goAnswer is: the engine loads a hooks module only when `$` goes to a plain function's
 * argument, never to a method.
 */
export async function goRun($: EngineInterface, go: Go, step: GoStep): Promise<void> {
  if (go.via === 'direct') {
    try {
      await step.before?.()
      await queueIt($, step)
    } catch (err) {
      await step.failed(err)
      return
    }
    await step.after?.()
    return
  }
  const nonce = goNonce()
  go.armed = { nonce, step, epoch: go.epoch }
  try {
    await $.command.run({ command: go.name, args: nonce })
  } catch (err) {
    if (go.armed?.nonce === nonce) go.armed = undefined
    await step.failed(err)
  }
}

/** The command.run hook's answer: it never reads `next`. */
export async function goAnswer($: EngineInterface, go: Go, args: string): Promise<{ readonly text: string }> {
  const at = go.armed
  if (at === undefined || args.trim() !== at.nonce) return { text: GO_NOTHING }
  go.armed = undefined
  let said: string | undefined
  try {
    said = await goRecheck(go, at)
  } catch (err) {
    said = `the checks at dequeue failed (${errorLine(err)})`
  }
  if (said !== undefined) {
    await at.step.withdraw(said)
    return { text: `It stood down: ${oneLine(said, 300)}.` }
  }
  try {
    await at.step.before?.()
  } catch (err) {
    await at.step.failed(err)
    return { text: `It didn't run: ${errorLine(err)}.` }
  }
  // Never awaited: the command waits on the queue this handler holds. The test kit refuses even this ("called
  // from a command.run hook", a host check): if M17b shows the same live, a flip needs the design's Trampoline
  // C here, a timer that queues it, with a same-tick check first. Why GO_VIA stays 'direct' until then.
  void queueIt($, at.step)
    .then(
      () => at.step.after?.(),
      err => at.step.failed(err),
    )
    .catch(() => undefined)
  return { text: at.step.runs }
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
export const isWindowName = (name: unknown): name is string => typeof name === 'string' && WINDOW_NAME.test(name) && !/^-?\d+$/.test(name) && !/^(?:new|last|_quake)$/i.test(name)

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
 * Read, merge this entry (names compared exactly; one that isn't a session's name dropped), write a
 * temporary file, [IO.File]::Replace over the old one: a reader never sees half a file. A lanes.json
 * not of its shape is left as it is (refused, saying how to start again). Throws on a name, id, folder,
 * window, tab or workspace that isn't of its shape. The coordinator writes through this script too:
 * another lock of its own would not keep out this one's writers.
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
    // A lock file being deleted (another writer's, closed while a scanner still has it open) refuses
    // access rather than sharing: waited for, as a held one is.
    `  catch { if (-not (${IS_IO} -or $_.Exception -is [UnauthorizedAccessException] -or $_.Exception.InnerException -is [UnauthorizedAccessException])) { throw }; Start-Sleep -Milliseconds 250 }`,
    '}',
    "if ($null -eq $lock) { 'refused lock another writer held lanes.json for 10 seconds'; exit 0 }",
    'try {',
    // Names compared exactly, as readLanes does: a hashtable would fold a hand-written `Foo` and this
    // `foo` into one entry under the first spelling, which readLanes then drops.
    '  $lanes = [Collections.Specialized.OrderedDictionary]::new([StringComparer]::Ordinal)',
    '  if (Test-Path -LiteralPath $path -PathType Leaf) {',
    '    $doc = $null',
    '    try { $doc = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { $doc = $null }',
    "    if ($doc -isnot [Management.Automation.PSCustomObject] -or $doc.v -isnot [ValueType] -or $doc.v -ne 1 -or $doc.lanes -isnot [Management.Automation.PSCustomObject]) { 'refused file lanes.json is not of its shape, so it is left as it is: not JSON, not version 1, no lanes object, or two names in it that differ only in case. Fix it by hand, or move it aside (rename it lanes.json.bad), and the next write starts a new one'; exit 0 }",
    // Every other entry kept as it is, but one whose name isn't a session's name: readLanes drops it anyway.
    String.raw`    foreach ($p in $doc.lanes.PSObject.Properties) { if ($p.Name -cne $name -and $p.Name -cmatch '^[a-z0-9][a-z0-9-]{0,39}\z') { $lanes[$p.Name] = $p.Value } }`,
    '  }',
    '  $lanes[$name] = $entryText | ConvertFrom-Json',
    '  $final = $path',
    '  $text = [ordered]@{ v = 1; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); lanes = $lanes } | ConvertTo-Json -Compress -Depth 6',
    ...WRITE_WHOLE.map(line => `  ${line}`),
    '} finally { $lock.Dispose() }',
    '"lanes " + $name',
  ].join('\r\n')
}
