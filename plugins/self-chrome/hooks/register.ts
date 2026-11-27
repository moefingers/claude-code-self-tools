// A session makes sure Chrome runs for Claude in Chrome, and reconnects Claude in Chrome (#54). A session sometimes
// decides Claude in Chrome isn't connected when all it needs is Chrome started, or the MCP reconnected; the model
// calls chrome_ensure, and the plugin:
// 1. Looks for the person's Chrome: the browser process of the configured chrome.exe (or Google Chrome binary on
//    macOS), of this login, on the default user data folder, never a test or isolated Chrome with a --user-data-dir of
//    its own; and whether it started with --silent-debugger-extension-api. On Windows through a fixed Windows
//    PowerShell script, as the shared machine code reads processes (machine.ts: powershellCall); on macOS with pgrep
//    and ps.
// 2. Starts Chrome when it isn't running, detached: on the profile folder the call or the setting names, else on the
//    one profile folder whose Google account has the email of Claude Code's account (the account match; with none or
//    several, it starts nothing), each one of Chrome's profile folders; --restore-last-session; and the flag
//    when the person opted in (the silentDebugger setting, or CLAUDE_CHROME_SILENT_DEBUGGER while it is auto). The
//    launch is short and returns at once; looks of their own then wait up to 20 s for the browser process. A lock
//    made with an exclusive create, one per user whatever the config folder, keeps two sessions from starting Chrome
//    at once (chrome.ts: windowsStartScript; macLockPath).
// 3. Never quits, kills or restarts Chrome: that closes every session's tabs and tab groups. A Chrome running without
//    the flag the person opted in to is said, with how the person fixes it. With nothing naming a profile, a Chrome
//    running is said to run on the account match's folder, or another, as far as its command line shows.
// 4. Queues `/mcp reconnect claude-in-chrome` for when the turn ends, as self-mcp does, whenever Chrome runs, at most
//    RECONNECT_CAP times in RECONNECT_WINDOW_MS a session; then resumes with `resume`, or tells the model.
// The rules are in chrome.ts, pure; this file runs them. It hooks no event Claude Code's built-in guard passes over.
import type { EngineInterface, Register } from 'claude-code'
import type { Queued } from '../types'
import { idleWords } from './at-idle'
import {
  accountFolders,
  accountMatch,
  type AccountPick,
  accountRefusal,
  answer,
  type Browser,
  type ChromeProcess,
  chooseProfile,
  CLAIM_MAX_BYTES,
  claimPathOf,
  type ClaudeAccount,
  claudeAccountOf,
  type FileFault,
  fileFault,
  type FlagChoice,
  flagChoice,
  isStaleLock,
  isProfileName,
  isRunning,
  judge,
  LOCAL_STATE,
  LOCAL_STATE_MAX_BYTES,
  type Look,
  macChromeFault,
  macLockPath,
  macOpenArgv,
  macStandard,
  macUserData,
  missingProfile,
  MKDIR,
  type NamedSource,
  parsePids,
  parsePs,
  parseWindowsLook,
  parseWindowsStart,
  pgrepArgv,
  ID,
  type Platform,
  type ProfileAccount,
  profileAccountsOf,
  profileCandidates,
  psArgv,
  type Reconnect,
  reconnectsWithin,
  RMDIR,
  SERVER,
  type SilentSetting,
  silentSetting,
  SLEEP,
  type Start,
  START_LOOKS,
  START_WAIT_S,
  type StartProfile,
  windowsChromeFault,
  windowsLaunchArgs,
  windowsLookScript,
  windowsReleaseScript,
  windowsStartScript,
} from './chrome'
import { oneLine, plainOutput, powershellCall, powershellPath, SYSTEM_ROOT } from './machine'
import { configureUpdateCheck, loadUpdateCheck, withUpdateNotice } from './update-check'

const TOOL = 'mcp__self-chrome__chrome_ensure'
const queued = { plugin: 'self-chrome', key: 'queued' } as const
const reconnects = { plugin: 'self-chrome', key: 'reconnects' } as const

/** How long a look's script may take on Windows: Get-CimInstance can be slow on a loaded machine. */
const LOOK_MS = 30_000
/** How long the start's script may take on Windows: a last look, Add-Type's compile, and the launch. */
const START_MS = 30_000
/** How long each of macOS's open, pgrep, ps and id may take. */
const MAC_MS = 10_000
/** How long a look in a start's wait pauses first. */
const PAUSE_MS = 700

/** When the reconnect starts after the turn's end: at once, the moment the turn's end returns, as self-mcp's. */
const TURN_END_MS = 0

/** The plugin's settings, read at load. */
let silent: SilentSetting = 'auto'
let profileSetting = ''
let chromePathSetting = ''

// ---------------------------------------------------------------------------------------------
// The person's message after the reconnect was queued: self-mcp's rule, for the same reason. The reconnect does no
// harm late, but its resume would: a person who typed "stop" meanwhile would be answered by the old "go on". So a
// message from the person after the arm marks it, and the resume goes to the model as a note instead of starting a
// turn. The message is known by the turn it came in over, never by its words: no prompt text is held or logged.

type Typed = { entered: boolean; arms: Set<Arm> }
/** One reconnect armed at a turn's end: stale once a person's prompt that marked it entered, or while one in flight holds it. */
type Arm = { sure: boolean; marks: Set<Typed> }
/** The reconnects armed and not yet reported. */
const openArms = new Set<Arm>()
/** The main-loop turns a person's prompt was typed over, each with those prompts. Emptied at each main-loop turn's end. */
const typedOver = new Map<string, Set<Typed>>()

const isStale = (arm: Arm): boolean => arm.sure || arm.marks.size > 0

function mark(arm: Arm, typed: Typed): void {
  if (typed.entered) arm.sure = true
  else {
    arm.marks.add(typed)
    typed.arms.add(arm)
  }
}

/** At a person's prompt, before it enters: every open arm marked, and the turn it was typed over noted. */
function personTyped(turnId: string | undefined): Typed {
  const typed: Typed = { entered: false, arms: new Set() }
  for (const arm of openArms) mark(arm, typed)
  if (turnId !== undefined) typedOver.set(turnId, (typedOver.get(turnId) ?? new Set<Typed>()).add(typed))
  return typed
}

/** The prompt entered: what it marked stays marked. */
function personEntered(typed: Typed): void {
  typed.entered = true
  for (const arm of typed.arms) {
    arm.marks.delete(typed)
    arm.sure = true
  }
  typed.arms.clear()
}

/** The prompt was dropped: its marks taken back, and its turn no longer held for it. */
function personDropped(typed: Typed, turnId: string | undefined): void {
  for (const arm of typed.arms) arm.marks.delete(typed)
  typed.arms.clear()
  if (turnId === undefined) return
  const held = typedOver.get(turnId)
  held?.delete(typed)
  if (held?.size === 0) typedOver.delete(turnId)
}

/** At a main-loop turn's end: its arm, marked by the person's prompts typed over the turn. */
function armAt(turnId: string): Arm {
  const arm: Arm = { sure: false, marks: new Set() }
  for (const typed of typedOver.get(turnId) ?? []) mark(arm, typed)
  openArms.add(arm)
  return arm
}

/** An arm whose reconnect has reported, or that queued nothing: it is marked no more. */
function closeArm(arm: Arm): void {
  openArms.delete(arm)
  for (const typed of arm.marks) typed.arms.delete(arm)
  arm.marks.clear()
}

// ---------------------------------------------------------------------------------------------
// The tool.

const DESCRIPTION = [
  'Makes sure Chrome runs for Claude in Chrome, and reconnects Claude in Chrome: for when its tools say the browser is not connected, before asking the person.',
  "It looks for the person's Chrome (its browser process on the default user data folder; never a test or isolated Chrome), starts it when it isn't running (on the profile folder named, else on the profile folder whose Google account has the email of Claude Code's account; the last session restored; and --silent-debugger-extension-api when the person opted in), and queues /mcp reconnect claude-in-chrome for when this turn ends whenever Chrome runs, at most 3 times in 10 minutes.",
  "It never quits, kills or restarts Chrome, which would close every session's tabs and tab groups: when Chrome runs without the flag the person opted in to, it says how the person can fix it. It never opens a profile in a Chrome that runs, signs in, or types anything into Chrome.",
  "`profile` (optional) is the profile folder a start opens, by its folder's name (Default, Profile 2), never an account, and only one that is in Chrome's user data folder; left out, the plugin's profile setting, else the account match: the one profile folder whose Google account (in Chrome's Local State) has the email of Claude Code's Claude account (in its .claude.json). The match stands in for the profile whose Claude in Chrome is signed in to Claude Code's account. When no folder or several match, or either account can't be read, it starts nothing and says why: then name the profile, which is also how to start the profile Chrome used last. With Chrome running and no profile named, it says whether Chrome's command line names the matched folder. It names profile folders only, never an account.",
  '`reconnect` (default true) queues the reconnect. `resume` is the message that starts your next turn once the reconnect has run: what to try again.',
  "The reconnect runs when the session is idle: Claude Code queues a plugin's command behind anything already waiting (a message typed during this turn, a background task's notification), so under a nonstop stream of work and notifications it may run in the distant future. Nothing waiting is lost.",
  "Windows and macOS. When it says to ask the person, ask them; don't call it again.",
  idleWords('When it says the reconnect is queued'),
].join(' ')

const SUBAGENT =
  "A subagent can't start Chrome or reconnect the session's MCP servers. Finish your piece and return its result, saying that Claude in Chrome isn't connected: the main session can call chrome_ensure."

/** Trimmed text, or undefined when it is not a string or is blank. */
function text(raw: unknown): string | undefined {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed === '' ? undefined : trimmed
}

/** Why something failed, as one line. */
function why(err: unknown): string {
  const said = oneLine(err instanceof Error ? err.message : String(err), 300)
  return said === '' ? 'no reason given' : said
}

/** A command's standard error as the end of a phrase: `: <one line>`, or nothing. */
const errSaid = (stderr: string): string => (stderr.trim() === '' ? '' : `: ${oneLine(stderr, 200)}`)

/**
 * A variable of this process's environment, or undefined when unset or unreadable. `read` is the engine's read with
 * the variable's name written out: the engine lists the variables a module reads by the literal names at its call sites.
 */
async function env(read: () => Promise<string | undefined>): Promise<string | undefined> {
  try {
    return await read()
  } catch {
    return undefined
  }
}

/** Where the session runs: Windows or macOS, or a phrase saying where else (a hosted server, Linux, WSL). */
async function platformOf($: EngineInterface): Promise<Platform | string> {
  let platform: string | undefined
  let isHosted = false
  try {
    const info = await $.session.info()
    platform = info.platform
    isHosted = info.isHosted === true
  } catch {
    // Read from the environment below.
  }
  if (isHosted) return 'a hosted server, not the machine Chrome runs on'
  if (platform === 'windows' || platform === 'macos') return platform
  if ((platform === undefined || platform === 'unknown') && (await env(() => $.env.get('OS'))) === 'Windows_NT') return 'windows'
  if (platform === 'wsl') return "WSL, whose processes are not Windows' own"
  return platform === undefined || platform === 'unknown' ? 'a platform Claude Code does not name' : platform
}

/** Whether `path` is there, as far as a read can tell. */
async function isThere($: EngineInterface, path: string): Promise<boolean> {
  try {
    return await $.fs.exists(path)
  } catch {
    return false
  }
}

/** The clock now; 0 when it can't be read, which no mark or count takes for a time. */
async function now($: EngineInterface): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------------------------
// The machine: a look, and a start, on Windows or macOS.

/**
 * What a start's run came to. `unknown`: its answer didn't come (a timeout), so it may have launched: the looks tell.
 * `held`: another start holds the lock, so nothing was launched. `refused`: nothing was launched, for sure.
 */
type StartRun =
  | { readonly kind: 'launched'; readonly pid?: number }
  | { readonly kind: 'running' }
  | { readonly kind: 'held' }
  | { readonly kind: 'refused'; readonly why: string }
  | { readonly kind: 'failed'; readonly why: string }
  | { readonly kind: 'unknown'; readonly why: string }

/** Why the Windows start launched nothing when the environment wasn't the login's exactly. Names no variable, nor any value. */
const MISMATCH =
  "the environment it would have started Chrome with wasn't the login environment exactly, so it launched nothing (it never hands Chrome the session's)"

/** Chrome on this machine, as its first look found it, and how to look again and to start it. */
type Machine = {
  readonly platform: Platform
  readonly paths: readonly string[]
  readonly userData: string | undefined
  readonly sep: '\\' | '/'
  /** The executable a start runs: the first of `paths` that is there. */
  readonly binary: string | undefined
  readonly first: readonly ChromeProcess[]
  /** Another look, after a short pause when `pause`; a string says why it failed. */
  look(pause: boolean): Promise<ChromeProcess[] | string>
  /** The start on `profile`, a profile folder checked by isProfileFolder, under the lock, named by `claim`: a fresh UUID. */
  start(profile: string, flag: boolean, claim: string): Promise<StartRun>
  /** Lets the start's lock go, when it is still `claim`'s own. Never throws. */
  release(claim: string): Promise<void>
}

/** One fixed script in Windows PowerShell, by its known path: its output; or why it failed (`exited`), or never answered (`threw`). */
async function powershell($: EngineInterface, exe: string, script: string, ms: number): Promise<{ readonly stdout: string } | { readonly exited: string } | { readonly threw: string }> {
  try {
    const call = powershellCall(exe, script)
    const run = await $.process.run(call.argv, { stdin: call.stdin, timeoutMs: ms })
    if (run.exitCode !== 0) {
      const err = plainOutput(run.stderr)
      return { exited: `exited ${run.exitCode}${err === '' ? '' : `: ${err}`}` }
    }
    return { stdout: run.stdout }
  } catch (err) {
    return { threw: `didn't answer (${why(err)})` }
  }
}

async function windowsMachine($: EngineInterface): Promise<Machine | string> {
  const root = await env(() => $.env.get('SystemRoot'))
  if (root === undefined || !SYSTEM_ROOT.test(root)) return `the Windows folder (SystemRoot) reads ${JSON.stringify(root ?? '')}, so Windows PowerShell can't be found by its known path`
  const exe = powershellPath(root)
  const configured = chromePathSetting === '' ? undefined : chromePathSetting
  const fault = configured === undefined ? undefined : windowsChromeFault(configured)
  if (fault !== undefined) return `the chromePath setting ${fault}; set it to chrome.exe's absolute path, or empty it for the standard installs`
  const ran = await powershell($, exe, windowsLookScript(configured), LOOK_MS)
  if (!('stdout' in ran)) return `the look ${'exited' in ran ? ran.exited : ran.threw}`
  const first = parseWindowsLook(ran.stdout)
  if (typeof first === 'string') return first
  const binary = first.start
  return {
    platform: 'windows',
    paths: first.paths,
    userData: first.userData,
    sep: '\\',
    binary,
    first: first.procs,
    async look(pause) {
      const again = await powershell($, exe, windowsLookScript(configured, pause ? PAUSE_MS : 0), LOOK_MS)
      if (!('stdout' in again)) return `the look ${'exited' in again ? again.exited : again.threw}`
      const read = parseWindowsLook(again.stdout)
      return typeof read === 'string' ? read : [...read.procs]
    },
    async start(profile, flag, claim) {
      if (binary === undefined) return { kind: 'refused', why: 'no chrome.exe is there to start' }
      const run = await powershell($, exe, windowsStartScript(binary, windowsLaunchArgs(profile, flag), claim), START_MS)
      if ('threw' in run) return { kind: 'unknown', why: `the start ${run.threw}` }
      if ('exited' in run) return { kind: 'failed', why: `the start ${run.exited}` }
      const said = parseWindowsStart(run.stdout)
      if (typeof said === 'string') return { kind: 'unknown', why: said }
      if (said.kind === 'running' || said.kind === 'held') return { kind: said.kind }
      if (said.kind === 'mismatch') return { kind: 'refused', why: MISMATCH }
      return said.pid === undefined ? { kind: 'launched' } : { kind: 'launched', pid: said.pid }
    },
    async release(claim) {
      await powershell($, exe, windowsReleaseScript(claim), LOOK_MS)
    },
  }
}

/** This user's uid on macOS, which pgrep is held to; undefined when id doesn't say, and pgrep then reads every user's. */
async function uidOf($: EngineInterface): Promise<number | undefined> {
  try {
    const run = await $.process.run([ID, '-u'], { timeoutMs: MAC_MS })
    const uid = run.stdout.trim()
    return run.exitCode === 0 && /^\d{1,10}$/.test(uid) ? Number(uid) : undefined
  } catch {
    return undefined
  }
}

/** The look on macOS: pgrep for this user's Chrome binaries, then ps of those processes alone. A string says why it failed. */
async function lookMac($: EngineInterface, paths: readonly string[], uid: number | undefined): Promise<ChromeProcess[] | string> {
  try {
    const found = await $.process.run(pgrepArgv(paths, uid), { timeoutMs: MAC_MS })
    // pgrep exits 1 when nothing matched.
    if (found.exitCode === 1) return []
    if (found.exitCode !== 0) return `pgrep exited ${found.exitCode}${errSaid(found.stderr)}`
    const pids = parsePids(found.stdout)
    if (pids.length === 0) return []
    const listed = await $.process.run(psArgv(pids), { timeoutMs: MAC_MS })
    // ps exits 1 when a process it was asked about has gone meanwhile; it lists the rest.
    if (listed.exitCode !== 0 && listed.exitCode !== 1) return `ps exited ${listed.exitCode}${errSaid(listed.stderr)}`
    return parsePs(listed.stdout, paths)
  } catch (err) {
    return `the look didn't answer (${why(err)})`
  }
}

async function macMachine($: EngineInterface): Promise<Machine | string> {
  const home = await env(() => $.env.get('HOME'))
  const fault = chromePathSetting === '' ? undefined : macChromeFault(chromePathSetting)
  if (fault !== undefined) return `the chromePath setting ${fault}; set it to that binary, or empty it for the standard install`
  const paths = chromePathSetting === '' ? macStandard(home) : [chromePathSetting]
  const userData = macUserData(home)
  const lock = macLockPath(home)
  /** When this call made the lock, by its clock; undefined while it holds none. */
  let heldAt: number | undefined
  /** Lets the lock go: only one this call made, and only while it can't have been taken over (within START_LOCK_MS). */
  const releaseLock = async (): Promise<void> => {
    if (lock === undefined || heldAt === undefined) return
    const made = heldAt
    heldAt = undefined
    if (isStaleLock(made, await now($))) return
    try {
      await $.process.run([RMDIR, lock], { timeoutMs: MAC_MS })
    } catch {
      // It is taken over once older than START_LOCK_MS.
    }
  }
  const uid = await uidOf($)
  const first = await lookMac($, paths, uid)
  if (typeof first === 'string') return first
  let binary: string | undefined
  for (const path of paths) {
    if (await isThere($, path)) {
      binary = path
      break
    }
  }
  return {
    platform: 'macos',
    paths,
    userData,
    sep: '/',
    binary,
    first,
    async look(pause) {
      if (pause) {
        // A sleep process, never the hook's own clock: a hook's own time is bounded, and the engine stops that clock
        // while a `$` call is in flight.
        try {
          await $.process.run([SLEEP, '1'], { timeoutMs: 5_000 })
        } catch {
          // The look goes at once.
        }
      }
      return lookMac($, paths, uid)
    },
    async start(profile, flag) {
      if (binary === undefined) return { kind: 'refused', why: 'no Chrome binary is there to start' }
      // The lock: a folder, which mkdir makes or finds there, atomically.
      if (lock !== undefined) {
        heldAt = await takeMacLock($, lock)
        if (heldAt === undefined) return { kind: 'held' }
      }
      // The last look, right before the launch: a Chrome that came up since is never started again.
      const last = await lookMac($, paths, uid)
      if (typeof last !== 'string' && judge(last, { platform: 'macos', paths, userData }).browsers.length > 0) {
        await releaseLock()
        return { kind: 'running' }
      }
      try {
        const opened = await $.process.run(macOpenArgv(binary, profile, flag), { timeoutMs: MAC_MS })
        return opened.exitCode === 0 ? { kind: 'launched' } : { kind: 'failed', why: `open exited ${opened.exitCode}${errSaid(opened.stderr)}` }
      } catch (err) {
        return { kind: 'unknown', why: `open didn't answer (${why(err)})` }
      }
    },
    release: releaseLock,
  }
}

/**
 * The macOS lock taken: mkdir of the lock folder, which fails when it is there; one older than START_LOCK_MS is taken
 * over (removed, and made again). When this call made it, by this call's clock; undefined when another start holds it.
 */
async function takeMacLock($: EngineInterface, lock: string): Promise<number | undefined> {
  const make = async (): Promise<boolean> => {
    try {
      return (await $.process.run([MKDIR, lock], { timeoutMs: MAC_MS })).exitCode === 0
    } catch {
      return false
    }
  }
  try {
    await $.process.run([MKDIR, '-p', lock.slice(0, lock.lastIndexOf('/'))], { timeoutMs: MAC_MS })
  } catch {
    // mkdir of the lock says what is wrong.
  }
  if (await make()) return now($)
  let mtimeMs: number | undefined
  try {
    mtimeMs = (await $.fs.stat(lock)).mtimeMs
  } catch {
    // Gone meanwhile: made again below, or held by whoever made it.
  }
  if (mtimeMs !== undefined && !isStaleLock(mtimeMs, await now($))) return undefined
  try {
    await $.process.run([RMDIR, lock], { timeoutMs: MAC_MS })
  } catch {
    // The make below says whether it went.
  }
  return (await make()) ? now($) : undefined
}

// ---------------------------------------------------------------------------------------------
// The profile, the start and its wait.

/** Chrome's user data folder's entries, each a name and a kind. */
type Entries = readonly { readonly name: string; readonly kind: string }[]

/** Chrome's user data folder's entries; undefined when the folder isn't known or can't be listed. */
async function listUserData($: EngineInterface, m: Machine): Promise<Entries | undefined> {
  if (m.userData === undefined) return undefined
  try {
    return await $.fs.list(m.userData)
  } catch {
    return undefined
  }
}

/**
 * Whether `name` is one of Chrome's profile folders: a profile folder's name (PROFILE_NAME), a folder of exactly that
 * name in Chrome's user data folder (as Chrome keys its profiles, never one that differs only in case), with its
 * Preferences file. Every folder a start opens, named or matched, is held to it: given any other, Chrome would make a
 * new, empty profile of that name, without Claude in Chrome.
 */
async function isProfileFolder($: EngineInterface, m: Machine, entries: Entries | undefined, name: string): Promise<boolean> {
  if (m.userData === undefined || entries === undefined || !isProfileName(name)) return false
  if (!entries.some(e => e.kind === 'dir' && e.name === name)) return false
  return isThere($, `${m.userData}${m.sep}${name}${m.sep}Preferences`)
}

/** The profile folders in Chrome's user data folder, by isProfileFolder's rule, sorted, at most 40; undefined when not listed. */
async function profileFolders($: EngineInterface, m: Machine, entries: Entries | undefined): Promise<string[] | undefined> {
  if (entries === undefined) return undefined
  const folders: string[] = []
  for (const candidate of profileCandidates(entries)) if (await isProfileFolder($, m, entries, candidate)) folders.push(candidate)
  return folders
}

/**
 * Why a named profile isn't one to start: Chrome's user data folder unknown, or not one of Chrome's profile folders
 * (isProfileFolder). Undefined when it is one.
 */
async function profileMissing($: EngineInterface, m: Machine, entries: Entries | undefined, name: string, source: NamedSource): Promise<{ readonly why: string; readonly fix: string } | undefined> {
  if (m.userData === undefined) {
    return {
      why: "Chrome's user data folder isn't known here, so the profile named can't be checked against Chrome's profile folders",
      fix: 'start Chrome by hand on that profile',
    }
  }
  if (await isProfileFolder($, m, entries, name)) return undefined
  return missingProfile(source, await profileFolders($, m, entries))
}

// ---------------------------------------------------------------------------------------------
// The account match's reads. Each file is read whole, once its stat shows a plain file, no link, within its cap; only
// the one field chrome.ts takes leaves the function that read it, and its text goes when that function returns. No
// error's own text is kept: it may hold the path, and the path the person's name.

/** A file's text, read only once its stat shows a plain file, no link, of at most `max` bytes; else why not (fileFault). */
async function readSmall($: EngineInterface, path: string, max: number): Promise<{ readonly text: string } | { readonly fault: FileFault }> {
  let fault: FileFault | undefined
  try {
    fault = fileFault(await $.fs.stat(path), max)
  } catch {
    return { fault: 'missing' }
  }
  if (fault !== undefined) return { fault }
  try {
    return { text: await $.fs.read(path) }
  } catch {
    return { fault: 'unreadable' }
  }
}

/**
 * Claude Code's account, from its .claude.json (chrome.ts: claimPathOf, claudeAccountOf): `oauthAccount`'s email, and
 * nothing else of the file; or why it can't be read.
 *
 * Not $.session.identity(): its `email` is there only where a managed `forceLoginOrgUUID` lists the account's
 * organization (SessionIdentity, in the engine's types), so on most machines it has none.
 */
async function readClaudeAccount($: EngineInterface, platform: Platform): Promise<ClaudeAccount | { readonly kind: 'unread'; readonly fault: FileFault | 'unplaced' }> {
  const path = claimPathOf(platform, {
    configDir: await env(() => $.env.get('CLAUDE_CONFIG_DIR')),
    userProfile: platform === 'windows' ? await env(() => $.env.get('USERPROFILE')) : undefined,
    home: await env(() => $.env.get('HOME')),
  })
  if (path === undefined) return { kind: 'unread', fault: 'unplaced' }
  const read = await readSmall($, path, CLAIM_MAX_BYTES)
  return 'fault' in read ? { kind: 'unread', fault: read.fault } : claudeAccountOf(read.text)
}

/** What Chrome's Local State says of its profiles: each folder's Google account; why it can't be read; or that it holds no profile list. */
type LocalStateRead = { readonly pairs: readonly ProfileAccount[] } | { readonly fault: FileFault | 'unplaced' } | { readonly unclear: true }

/** Each profile folder's Google account, from Chrome's Local State in its user data folder (chrome.ts: profileAccountsOf): `user_name` alone. */
async function readProfileAccounts($: EngineInterface, m: Machine): Promise<LocalStateRead> {
  if (m.userData === undefined) return { fault: 'unplaced' }
  const read = await readSmall($, `${m.userData}${m.sep}${LOCAL_STATE}`, LOCAL_STATE_MAX_BYTES)
  if ('fault' in read) return { fault: read.fault }
  const pairs = profileAccountsOf(read.text)
  return pairs === undefined ? { unclear: true } : { pairs }
}

/**
 * The account match: the one profile folder whose Google account has the email of Claude Code's account, or why there is
 * none. Each folder that matches is checked as a named one is (isProfileFolder). Neither email leaves this function: it
 * answers folder names only. Every read is caught, so it never throws.
 */
async function matchAccount($: EngineInterface, m: Machine, entries: Entries | undefined): Promise<AccountPick> {
  if (m.userData === undefined) return { kind: 'no-local-state', fault: 'unplaced' }
  const account = await readClaudeAccount($, m.platform)
  if (account.kind === 'unread') return { kind: 'no-claim', fault: account.fault }
  if (account.kind === 'none') return { kind: 'no-account' }
  if (account.kind === 'unknown') return { kind: 'claim-unclear' }
  const local = await readProfileAccounts($, m)
  if ('fault' in local) return { kind: 'no-local-state', fault: local.fault }
  if ('unclear' in local) return { kind: 'local-state-unclear' }
  const matched = accountFolders(local.pairs, account.email)
  const present: string[] = []
  for (const folder of matched) if (await isProfileFolder($, m, entries, folder)) present.push(folder)
  return accountMatch(matched, present)
}

/** Looks, each in a run of its own after a short pause, until the person's Chrome shows, START_WAIT_S pass, or `looks` are made. */
async function waitForBrowser($: EngineInterface, m: Machine, looks: number): Promise<Browser | undefined> {
  const began = await now($)
  for (let i = 0; i < looks; i += 1) {
    const procs = await m.look(true)
    if (typeof procs !== 'string') {
      const shown = judge(procs, { platform: m.platform, paths: m.paths, userData: m.userData }).browsers[0]
      if (shown !== undefined) return shown
    }
    if ((await now($)) - began >= START_WAIT_S * 1000) break
  }
  return undefined
}

/** What the look and the start came to; `account`, the account match while Chrome runs and nothing names a profile. */
type Found = { readonly look: Look; readonly start: Start; readonly account?: AccountPick }

const none: Start = { kind: 'none' }
const lookFailed = (whyNot: string): Found => ({ look: { kind: 'failed', why: whyNot }, start: none })

async function ensureChrome($: EngineInterface, platform: Platform, flag: FlagChoice, asked: string | undefined): Promise<Found> {
  const m = platform === 'windows' ? await windowsMachine($) : await macMachine($)
  if (typeof m === 'string') return lookFailed(m)
  const judged = judge(m.first, { platform, paths: m.paths, userData: m.userData })
  if (judged.browsers.length === 0 && judged.unreadable > 0) {
    const n = judged.unreadable
    return lookFailed(`${n} Chrome process${n === 1 ? '' : 'es'} of this login ${n === 1 ? 'has' : 'have'} a command line that can't be read, as an elevated Chrome's can't`)
  }
  const found: Look = { kind: 'read', judged }
  const choice = chooseProfile(asked, profileSetting)
  if (judged.browsers.length > 0) {
    // Chrome runs, and opens no profile. With nothing naming one, the answer says whether it runs on the match's folder.
    if ('refusal' in choice || choice.source !== 'account') return { look: found, start: none }
    return { look: found, start: none, account: await matchAccount($, m, await listUserData($, m)) }
  }
  if (m.binary === undefined) {
    const configured = chromePathSetting !== ''
    const standard = platform === 'windows' ? "Chrome isn't at its standard install paths (under Program Files, or the per-user install)" : "Chrome isn't at its standard install path (/Applications/Google Chrome.app)"
    const fix = platform === 'windows' ? "set the chromePath setting to chrome.exe's absolute path" : 'set the chromePath setting to the Google Chrome binary inside its .app'
    return { look: found, start: { kind: 'refused', why: configured ? 'the chromePath setting names no file' : standard, fix } }
  }
  if ('refusal' in choice) return { look: found, start: { kind: 'refused', why: choice.refusal, fix: choice.fix } }
  const entries = await listUserData($, m)
  let profile: StartProfile
  if (choice.source === 'account') {
    const pick = await matchAccount($, m, entries)
    if (pick.kind !== 'one') return { look: found, start: { kind: 'refused', ...accountRefusal(pick, await profileFolders($, m, entries)) } }
    profile = { profile: pick.folder, source: 'account' }
  } else {
    const missing = await profileMissing($, m, entries, choice.profile, choice.source)
    if (missing !== undefined) return { look: found, start: { kind: 'refused', ...missing } }
    profile = { profile: choice.profile, source: choice.source }
  }
  const claim = crypto.randomUUID()
  const run = await m.start(profile.profile, flag.on, claim)
  // Held by another start: this call launched nothing, and looks for what that start makes.
  if (run.kind === 'held') {
    const shown = await waitForBrowser($, m, START_LOOKS)
    return { look: found, start: { kind: 'waited', ...(shown === undefined ? {} : { browser: shown }) } }
  }
  if (run.kind === 'refused') return { look: found, start: { kind: 'failed', why: run.why } }
  // Found running by the start's last look, which let the lock go itself.
  if (run.kind === 'running') {
    const shown = await waitForBrowser($, m, 1)
    return { look: found, start: { kind: 'late', ...(shown === undefined ? {} : { browser: shown }) } }
  }
  try {
    // A start that said it failed gets one look, in case it launched before it failed; any other, the whole wait.
    const shown = await waitForBrowser($, m, run.kind === 'failed' ? 1 : START_LOOKS)
    if (run.kind === 'failed' && shown === undefined) return { look: found, start: { kind: 'failed', why: run.why } }
    return {
      look: found,
      start: {
        kind: 'started',
        profile,
        flag: flag.on,
        ...(shown === undefined ? {} : { browser: shown }),
        ...(run.kind === 'launched' && run.pid !== undefined ? { launched: run.pid } : {}),
        ...(run.kind === 'unknown' || run.kind === 'failed' ? { unknown: run.why } : {}),
      },
    }
  } finally {
    // The lock is let go once the wait is over, so the next start needn't wait out its age.
    await m.release(claim)
  }
}

/**
 * The reconnect, queued for when the turn ends: whenever it was asked for and Chrome runs (found, or started), as
 * self-mcp queues one; a server that dropped lists no tools, and is the one that needs it most. At most RECONNECT_CAP
 * in RECONNECT_WINDOW_MS a session: past it, a loop of reconnects that don't help is the person's to look at. A second
 * call in the same turn changes the resume, and counts no second reconnect.
 */
async function queueReconnect($: EngineInterface, asked: boolean, running: boolean, resume: string | undefined): Promise<Reconnect> {
  if (!asked) return { kind: 'not-asked' }
  if (!running) return { kind: 'not-running' }
  try {
    const { value: waiting } = await $.state.get(queued)
    if (waiting === null || waiting === undefined) {
      const at = await now($)
      const { value: times } = await $.state.get(reconnects)
      const { kept, isCapped } = reconnectsWithin(times, at)
      if (isCapped) {
        await $.state.set(reconnects, kept)
        return { kind: 'capped' }
      }
      await $.state.set(reconnects, [...kept, at])
    }
    await $.state.set(queued, resume === undefined ? {} : { resume })
  } catch {
    return { kind: 'failed' }
  }
  $.ui.status('Claude in Chrome reconnect queued for when this turn ends')
  return resume === undefined ? { kind: 'queued' } : { kind: 'queued', resume }
}

// ---------------------------------------------------------------------------------------------
// The reconnect, once the turn has ended.

/** Tells the model on its next turn, in a row it reads and the person doesn't see as typed. */
async function tellModel($: EngineInterface, note: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
  } catch {
    // The toast has told the person; there is no other way to reach the model.
  }
}

async function sendResume($: EngineInterface, said: string, resume: string): Promise<void> {
  try {
    const sent = await $.prompt.submit({ text: `${said} Resume: ${resume}` })
    if (sent.drop !== undefined) $.ui.toast(`Resume not sent: ${sent.drop}`)
  } catch {
    $.ui.toast('Resume not sent; the session waits for the next message.')
  }
}

/** How many of Claude in Chrome's tools the session lists now, as a sentence; empty when the list can't be read. */
async function toolsNow($: EngineInterface): Promise<string> {
  try {
    const count = (await $.tool.list()).filter(t => t.name.startsWith(`mcp__${SERVER}__`)).length
    return count === 0 ? ' None of its tools are listed now.' : count === 1 ? ' 1 of its tools is listed now.' : ` ${count} of its tools are listed now.`
  } catch {
    return ''
  }
}

/** Runs the reconnect, then tells the person and the model what it said. Its arm is closed however it ends. */
async function reconnectNow($: EngineInterface, value: Queued, arm: Arm): Promise<void> {
  try {
    $.ui.status(undefined)
    let said: string
    try {
      const output = text((await $.command.run({ command: 'mcp', args: `reconnect ${SERVER}` })).text)
      // /mcp shows its outcome as its own transcript line, which the person and the model both read, and hands the
      // caller no text; a version that hands one back has it passed on.
      said =
        output === undefined
          ? `Claude in Chrome reconnect ran: Claude Code's own line above says whether it reconnected.${await toolsNow($)}`
          : `Claude in Chrome reconnect: ${oneLine(output)}${await toolsNow($)}`
    } catch (err) {
      said = `Claude in Chrome reconnect didn't run: ${why(err)}.`
    }
    $.ui.toast(said)
    if (value.resume === undefined) await tellModel($, said)
    else if (!isStale(arm)) await sendResume($, said, value.resume)
    else {
      $.ui.toast('Resume not sent: your message came after the reconnect was queued, so the model has it as a note.')
      await tellModel($, `${said} The person's message came after the reconnect was queued, so its resume wasn't sent as a new message. It was: ${value.resume}`)
    }
  } finally {
    closeArm(arm)
  }
}

export const register: Register = (on, options) => {
  configureUpdateCheck('self-chrome', options)
  silent = silentSetting(options.silentDebugger)
  profileSetting = typeof options.profile === 'string' ? options.profile.trim() : ''
  chromePathSetting = typeof options.chromePath === 'string' ? options.chromePath.trim() : ''

  // First, so it is outermost on this plugin's tools: it sees each answer, and adds the update notice when one is
  // due. It never waits on the check; see update-check.ts.
  on('tool.call', { tool: /^mcp__self-chrome__/ }, async ($, e, next) => withUpdateNotice($, e, await next(e))).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'chrome_ensure',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          profile: {
            type: 'string',
            description:
              "The profile folder a start opens, by its folder's name (Default, Profile 2), never an account; one that isn't in Chrome's user data folder is refused, with the folders that are. Used only when Chrome isn't running. Left out: the plugin's profile setting, else the one profile folder whose Google account has the email of Claude Code's account (none or several: nothing starts). To start the profile Chrome used last, name it.",
          },
          reconnect: {
            type: 'boolean',
            description: 'Queue /mcp reconnect claude-in-chrome for when this turn ends (default true), whenever Chrome runs; at most 3 times in 10 minutes.',
          },
          resume: {
            type: 'string',
            description: 'The message that starts your next turn once the reconnect has run: what to try again. Leave it out only when the next step waits on someone else.',
          },
        },
        additionalProperties: false,
      },
      isDeferred: false,
    })
    loadUpdateCheck($)
    return started
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: SUBAGENT }
    const input = e as { profile?: unknown; reconnect?: unknown; resume?: unknown }
    const asked = text(input.profile)
    if (input.profile !== undefined && (typeof input.profile !== 'string' || (asked !== undefined && !isProfileName(asked)))) {
      return { deny: "`profile` must be a profile folder's name, such as Default or Profile 2: letters, digits, spaces, _ and -, at most 64. Never an account." }
    }
    if (input.reconnect !== undefined && typeof input.reconnect !== 'boolean') return { deny: '`reconnect` is true or false.' }
    const resume = text(input.resume)
    const platform = await platformOf($)
    if (platform !== 'windows' && platform !== 'macos') {
      return { result: `Chrome: not looked for. self-chrome looks after Chrome on Windows and macOS, on the machine Chrome runs on, and this session runs on ${platform}. Nothing was started or queued.` }
    }
    const flag = flagChoice(silent, await env(() => $.env.get('CLAUDE_CHROME_SILENT_DEBUGGER')))
    const { look, start, account } = await ensureChrome($, platform, flag, asked)
    const reconnect = await queueReconnect($, input.reconnect !== false, isRunning(look, start), resume)
    return { result: answer({ platform, flag, look, start, reconnect, ...(account === undefined ? {} : { account }) }) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-chrome: chrome_ensure failed before it could answer. Call it again to see where Chrome stands.' }))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // This turn's arm, made at once, marked by the person's prompts typed over the turn; closed below if nothing is queued.
    const arm = armAt(e.turnId)
    typedOver.clear()
    let isArmed = false
    try {
      const done = await next(e)
      const { value } = await $.state.get(queued)
      if (!value) return done
      await $.state.set(queued, null)
      if (e.isAborted || e.reason !== 'answer') {
        $.ui.status(undefined)
        $.ui.toast("Claude in Chrome reconnect cancelled: the turn didn't finish.")
        return done
      }
      isArmed = true
      $.clock.after(TURN_END_MS, () => void reconnectNow($, value, arm))
      return done
    } finally {
      if (!isArmed) closeArm(arm)
    }
  })

  // The person's message, at the terminal or from the app: it marks the arms it comes after (see Typed). No text is kept.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)
    const typed = personTyped(e.turnId)
    const done = await next(e)
    if (done.drop === undefined) personEntered(typed)
    else personDropped(typed, e.turnId)
    return done
  }).catch(($, e, next) => next(e))
}
