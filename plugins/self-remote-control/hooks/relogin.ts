// After a login change: reconnect Remote Control, then resume a turn that was cut off.
//
// A login changes three ways on a machine whose sessions share one login: a tool swaps the stored
// login (and the account record beside it) when an account hits its limit, a collector does the
// same after a new login is stored, or the person runs /login in one session. Claude Code then
// (read from its 2.1.319 source):
//   - re-reads the login file once its modification time changes, in every running session;
//   - stops Remote Control in a session whose signed-in account changed. /login does it once its
//     dialog closes ("Login successful. Remote Control disconnected."). In the other sessions,
//     Remote Control watches the account record in the config file, has the server confirm the
//     new login is another account's, stops ("signed-in claude.ai account or organization changed
//     on this machine — run /remote-control to start a session for the current account"), and ten
//     seconds later turns itself off, when the remote-control command reads not connected again;
//   - leaves a turn the limit or a failed sign-in cut off where it stopped, until someone types.
// The plugin API has no event for a login change, and `$.session.identity()` answers only a mod an
// organization's managed settings install. So this watches:
//   - the login file's size and modification time, never its contents: a cheap trigger. It changes
//     on every token refresh as well as on a new login, so it only says when to look at
//   - the account record (`oauthAccount`) in Claude Code's config file, the record Remote Control
//     itself checks: its account and organization ids, hashed at once into a fingerprint. Nothing
//     else of the file is kept, and nothing of it is logged or shown.
// A change is another account read at two looks in a row. Remote Control is read when the new
// account is first seen (before the change can stop it: whether it was connected), and while a
// change is handled, at most every RC_READ_MS; never on an idle session.
//
// What a change does, once no turn and no /login is running, in this order:
//   1. Remote Control, when reconnectOnLoginChange is on and Remote Control should be on: it read
//      connected when the new account was first seen, or the `remoteControl` setting for all
//      sessions is true. The remote-control command runs, under the session's title, only under the
//      Remote Control lock (rc-lock.ts, shared with the coordinator plugin) and on a fresh reading of
//      "not connected" taken after the lock; never while it reads connected or unknown. A connected
//      reading right after the change may be the old link not yet stopped, so it waits up to
//      RC_WAIT_MS for it to read not connected, and runs nothing if it never does. At most
//      RECONNECT_CAP runs in RECONNECT_WINDOW_MS, so a login that flaps doesn't fill the app's list.
//      A change the cap holds back leaves Remote Control down (Claude Code stopped it at the switch),
//      so it is owed (`rcOwed`): a change after it counts Remote Control as connected before, and
//      once the oldest run leaves the window it is tried once more, whatever account the login
//      settled on (owedRetry), unless signed out. It stays owed until it ran or reads connected.
//   2. Claude in Chrome, when reconnectChromeOnLoginChange is on, once the Remote Control step settles, whatever its
//      outcome: /mcp reconnect claude-in-chrome, in a session that lists Claude in Chrome's tools now or listed them
//      before (a server the change dropped lists none), and none of the coordinator plugin's (`mcp__coordinator__*`).
//      A session the coordinator runs in has the coordinator reconnect it after its own switch, so this leaves it
//      alone there. The coordinator's tools are looked for three times (at once, CHROME_LOOK_MS after): a coordinator
//      reloading lists none for a moment. One listed before and missing at all three looks is left alone too, and so
//      is a session whose tools can't be listed: never two reconnects. Its cloud bridge routes by claude.ai account,
//      and a session keeps the old account's connection until it reconnects; a reconnect starts the session's tab
//      group over. It runs inside the login watch, so with both settings above off it doesn't run either.
//   3. The resume, when resumeAfterLoginChange is on and the main conversation's last turn ended,
//      within CUT_OFF_MS, on an API error a login can clear (the usage limit, a failed sign-in, ...)
//      with no turn since: RESUME, once, after the reconnect has settled, Claude in Chrome's step and
//      the session's own delay (0 to JITTER_MS, so the sessions of one switch don't all start at
//      once). Only under the resume claim (resume-claim.ts): the coordinator's auto-resume, or the
//      owner's Resume on its page, may resume the same stop, and whichever claims it first sends;
//      the other sends nothing. A turn still running at the change is waited for. A session at a
//      finished break gets nothing. A resume whose turn ends on an error at once (no usage, or under QUICK_MS) isn't
//      followed by another until a person types: the loop-breaker. A rewind past the cut-off turn
//      isn't seen (the API gives no cheap mark of the newest message, and $.session.messages()
//      copies up to 4096 of them): the 6-hour limit bounds it.
//   4. One toast saying what happened. A cap's line is told once while that cap holds: after it, its
//      part is left out, and a toast with nothing else new (a resume, a step that did something) isn't
//      shown. A resume names the error kind its turn ended on and how long ago, there and in a debug
//      line, so it can be checked after.
//
// The login record and the servers seen are the machine's sign-in and the session's tools, not the
// conversation's, so they outlive a move: Claude Code empties $.state at an in-process /clear or /resume,
// with no session.start after, and the module keeps a mirror of each, set at every write. A read that finds
// one empty while its mirror is set writes the mirror back and goes by it; and each goes back at every
// main-loop classic SessionStart of a clear or a resume (restoreAfterMove), since the wipe may land before
// that SessionStart or after it. The last turn and the resume's record are the conversation's, and are
// forgotten at a move (forgetTurn). A turn keeps the conversation it ran in (`session`), named by the last
// main-loop SessionStart of a startup, a resume or a clear while `$.session.id()` lags it: the resume claim
// is keyed by it, never by `$.session.id()` read when the claim is made.
import type { EngineInterface, PluginOptions, Timer } from 'claude-code'
import type { Login, Pending, Resumes, Servers, Turn } from '../types'
import { readNow, runRemoteControl, sessionTitle, why } from './connection'
import { LOCK_HOLD_MS, releaseLock, SESSION_ID, takeLock } from './rc-lock'
import { claimResume } from './resume-claim'

const loginRef = { plugin: 'self-remote-control', key: 'login' } as const
const turnRef = { plugin: 'self-remote-control', key: 'turn' } as const
const resumesRef = { plugin: 'self-remote-control', key: 'resumes' } as const
const serversRef = { plugin: 'self-remote-control', key: 'servers' } as const

/** The message that resumes a turn a login change, or the limit before it, cut off. */
export const RESUME = 'There was a small interruption. Please resume from your last turn normally.'

/** How often the login watch looks at the login file. */
export const POLL_MS = 5000
/** How many looks read the account record after the login file changed: the record can follow the login by a moment. */
export const CLAIM_LOOKS = 3
/** Without a login file (the login kept in a keychain), the record's own changes are read at most this often. */
export const CLAIM_GAP_MS = 30_000
/** Unusable reads of the account record in a row before the one toast that the feature can't work. */
export const UNUSABLE_LOOKS = 3
/** How often a change being handled is moved on (its state only; Remote Control is read less often). */
export const TICK_MS = 2000
/** How often Remote Control is read while a change is handled. */
export const RC_READ_MS = 15_000
/** The first look after /remote-control ran. */
export const CHECK_MS = 3000
/** A beat after a turn ends before anything runs, so the turn is no longer running. */
export const SETTLE_MS = 1000
/** How long, once no turn runs, the reconnect waits for a connected reading to turn not connected. */
export const RC_WAIT_MS = 60_000
/** How long the remote-control command is waited for before the watch moves on (its check goes on). */
export const RUN_WAIT_MS = 15_000
/** At most this many reconnect runs in RECONNECT_WINDOW_MS. */
export const RECONNECT_CAP = 3
export const RECONNECT_WINDOW_MS = 10 * 60_000
/** A /login that has run longer than this no longer holds a change back. */
export const LOGIN_HOLD_MS = 10 * 60_000
/** How long the resume's submit is waited for (it resolves as its turn starts) before the toast goes without it. */
export const SUBMIT_WAIT_MS = 30_000
/** A turn counts as cut off only if it ended within this. */
export const CUT_OFF_MS = 6 * 60 * 60_000
/** The most a session's resume waits after the reconnect settled: its own share of this. */
export const JITTER_MS = 60_000
/** A resume's turn that ends on an error this quickly (or with no usage) didn't take. */
export const QUICK_MS = 30_000
/**
 * When the looks for the coordinator's tools after the first are due, from it: a coordinator plugin that is reloading
 * lists no tools for a moment, so one look without them isn't read as no coordinator.
 */
export const CHROME_LOOK_MS = [10_000, 30_000] as const
/** How long after the resume was sent a turn starting with it counts as its turn. */
const SENT_MS = 10 * 60_000
/**
 * How long after a move's SessionStart `$.session.id()` may still name the conversation left: within it the
 * event's id stands; past it the id is the conversation (the shared machine code's ID_LAG_MS, self-switch's
 * and self-wake's rule).
 */
const ID_LAG_MS = 15_000

/**
 * API error kinds a new login can clear: the limits, a failed or refused sign-in, billing, and an
 * outage. Any other kind (an invalid request, a too-long output, an unknown model, one Claude Code
 * classes `unknown`, or none given) would fail the same way again, and is left alone.
 */
const RESUMABLE = new Set(['rate_limit', 'authentication_failed', 'billing_error', 'oauth_org_not_allowed', 'account_on_hold', 'overloaded', 'server_error'])

/** Where the watch looks: the login file (stat only) and the config file holding the account record. */
type Paths = { login: string; claim: string }

type Settings = { reconnect: boolean; resume: boolean; chrome: boolean }

let settings: Settings = { reconnect: true, resume: true, chrome: true }

/**
 * Claude in Chrome's MCP server: its cloud bridge routes by claude.ai account, and a session keeps the connection it
 * made under the old account until it reconnects. A reconnect starts the session's Chrome tab group over.
 */
const CHROME = 'claude-in-chrome'
/** The coordinator plugin's tools: a session that has them has the coordinator reconnect Claude in Chrome. */
const COORDINATOR_TOOLS = 'mcp__coordinator__'
/** Undefined until looked for; null when they can't be worked out (no home folder), and nothing is watched. */
let paths: Paths | null | undefined
/** The login file's size and modification time at the last look; 'none' when there was none. */
let loginKey: string | undefined
let claimKey: string | undefined
let claimReadAt = -Infinity
let claimLooks = 0
/** Unusable reads of the account record in a row, and whether the person was told. */
let unusable = 0
let toldUnusable = false
/** A look or a step under way: the watch and the steps never interleave. */
let busy = false
/** When each /login in flight started (ms); a change waits while one runs. */
let logins: number[] = []
/**
 * When a /login here began with Remote Control reading connected (ms): its dialog's close turns it
 * off, possibly before the new account is first seen, so that sighting takes connected from this.
 */
let connectedAtLogin: number | undefined
let watchTimer: Timer | undefined
let tickTimer: Timer | undefined
/** The login record and the servers seen as this module last wrote or read them: the copies a /clear or a /resume doesn't empty. */
let loginMirror: Login | undefined
let serversMirror: Servers | undefined
/** The conversation the last main-loop SessionStart of a startup, a resume or a clear named, and when. */
let conversation: { readonly id: string; readonly at: number } | undefined

/** Reads this load's settings and starts over; at register. */
export function configureRelogin(options: PluginOptions): void {
  settings = { reconnect: options.reconnectOnLoginChange !== false, resume: options.resumeAfterLoginChange !== false, chrome: options.reconnectChromeOnLoginChange !== false }
  paths = undefined
  loginKey = undefined
  claimKey = undefined
  claimReadAt = -Infinity
  claimLooks = 0
  unusable = 0
  toldUnusable = false
  busy = false
  logins = []
  connectedAtLogin = undefined
  watchTimer = undefined
  tickTimer = undefined
  loginMirror = undefined
  serversMirror = undefined
  conversation = undefined
}

/** Whether the watch runs at all: off when both settings are, and then Claude in Chrome's step doesn't run either. */
export const isWatching = (): boolean => settings.reconnect || settings.resume

/** FNV-1a over the text's UTF-16 units, from `seed`, as 8 hex digits. */
function fnv(text: string, seed: number): string {
  let h = seed >>> 0
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * The account a parsed config file names, as a fingerprint of its account and organization ids;
 * null when it names none (signed out: no `oauthAccount`); undefined when it can't be used (not an
 * object, or a record with no account id, which a renamed field would also give).
 */
export function fingerprintOf(doc: unknown): string | null | undefined {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return undefined
  const record = (doc as { oauthAccount?: unknown }).oauthAccount
  if (record === undefined || record === null) return null
  if (typeof record !== 'object' || Array.isArray(record)) return undefined
  const { accountUuid, organizationUuid } = record as { accountUuid?: unknown; organizationUuid?: unknown }
  if (typeof accountUuid !== 'string' || accountUuid === '') return undefined
  const ids = `${accountUuid}\n${typeof organizationUuid === 'string' ? organizationUuid : ''}`
  return `${fnv(ids, 0x811c9dc5)}${fnv(ids, 0x050c5d1f)}`
}

/**
 * Whether a turn was cut off, at `now`: it ended within CUT_OFF_MS on an API error a new login can
 * clear, and no turn has started since.
 */
export function isCutOff(turn: Turn | null | undefined, now: number): boolean {
  return (
    turn !== null &&
    turn !== undefined &&
    !turn.running &&
    turn.outcome === 'error' &&
    RESUMABLE.has(turn.error ?? '') &&
    now - turn.at <= CUT_OFF_MS
  )
}

/** A session's own delay before its resume, 0 to JITTER_MS, drawn from its id: each session's differs. */
export function jitterOf(id: string): number {
  return parseInt(fnv(id, 0x2f6b3a91), 16) % (JITTER_MS + 1)
}

/** A variable, or undefined when it is unset, empty or can't be read. */
async function env(read: () => Promise<string | undefined>): Promise<string | undefined> {
  try {
    const value = await read()
    return value === undefined || value === '' ? undefined : value
  } catch {
    return undefined
  }
}

const isAbsolute = (path: string | undefined): path is string => path !== undefined && (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/'))

/** `folder` and `name`, joined with the separator the folder is written with. */
const join = (folder: string, name: string): string => {
  const sep = folder.includes('\\') ? '\\' : '/'
  return `${folder.replace(/[\\/]+$/, '')}${sep}${name}`
}

/**
 * Where Claude Code keeps the login and the account record, as it works them out: the login file in
 * CLAUDE_SECURESTORAGE_CONFIG_DIR when that is set (~/.claude when it is set empty), else in
 * CLAUDE_CONFIG_DIR, else in ~/.claude; the config file in CLAUDE_CONFIG_DIR when set, else in the
 * home folder.
 */
async function locate($: EngineInterface): Promise<Paths | null> {
  const [profile, home, config, secure, isSecureSet] = await Promise.all([
    env(() => $.env.get('USERPROFILE')),
    env(() => $.env.get('HOME')),
    env(() => $.env.get('CLAUDE_CONFIG_DIR')),
    env(() => $.env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')),
    $.env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR').then(
      value => value !== undefined,
      () => false,
    ),
  ])
  const base = profile ?? home
  if (!isAbsolute(base)) return null
  const configDir = config ?? join(base, '.claude')
  const loginDir = isSecureSet ? (secure ?? join(base, '.claude')) : configDir
  const claimDir = config ?? base
  if (!isAbsolute(configDir) || !isAbsolute(loginDir) || !isAbsolute(claimDir)) return null
  return { login: join(loginDir, '.credentials.json'), claim: join(claimDir, '.claude.json') }
}

/** A file's size and modification time, never its contents; 'none' when it isn't there or isn't a file. */
async function statKey($: EngineInterface, path: string): Promise<string> {
  try {
    const stat = await $.fs.stat(path)
    return stat.kind === 'file' ? `${stat.size}:${stat.mtimeMs}` : 'none'
  } catch {
    return 'none'
  }
}

/** The account the config file names (fingerprintOf); undefined when it can't be read, parsed or used. */
async function accountOf($: EngineInterface, path: string): Promise<string | null | undefined> {
  try {
    return fingerprintOf(JSON.parse(await $.fs.read(path)))
  } catch {
    return undefined
  }
}

/** Whether the /config setting for all sessions turns Remote Control on. */
async function isSettingOn($: EngineInterface): Promise<boolean> {
  try {
    const row = (await $.config.list()).find(r => r.key === 'remoteControl')
    return row !== undefined && String(row.value) === 'true'
  } catch {
    return false
  }
}

/**
 * The login record: $.state's, which the mirror then follows; read empty while the mirror is set (Claude Code
 * emptied $.state at a /clear or a /resume), the mirror, written back.
 */
async function getLogin($: EngineInterface): Promise<Login | null> {
  const value = (await $.state.get(loginRef)).value ?? null
  if (value !== null) {
    loginMirror = value
    return value
  }
  if (loginMirror === undefined) return null
  await $.state.set(loginRef, loginMirror)
  return loginMirror
}

/** Writes the login record, its mirror first. */
async function setLogin($: EngineInterface, value: Login): Promise<void> {
  loginMirror = value
  await $.state.set(loginRef, value)
}

/** The servers seen, as getLogin reads the login: $.state's, else the mirror, written back; none when neither has any. Never throws. */
async function getServers($: EngineInterface): Promise<Servers> {
  const value = (await $.state.get(serversRef).catch(() => ({ value: null }))).value ?? null
  if (value !== null) {
    serversMirror = value
    return value
  }
  if (serversMirror === undefined) return {}
  await $.state.set(serversRef, serversMirror).catch(() => undefined)
  return serversMirror
}

/**
 * At a main-loop classic SessionStart: the conversation it names, by its own id, at a startup, a resume or a
 * clear; and at a clear or a resume, which empty $.state now or a moment after, the login record and the
 * servers seen written back from their mirrors, with plain sets. Safe to repeat. Never throws.
 */
export async function restoreAfterMove($: EngineInterface, source: unknown, id: unknown): Promise<void> {
  try {
    if ((source === 'startup' || source === 'resume' || source === 'clear') && typeof id === 'string' && SESSION_ID.test(id)) conversation = { id, at: await $.clock.now() }
    if (source !== 'clear' && source !== 'resume') return
    if (loginMirror !== undefined) await $.state.set(loginRef, loginMirror)
    if (serversMirror !== undefined) await $.state.set(serversRef, serversMirror)
  } catch {
    // The next read that finds either empty puts it back.
  }
}

/**
 * The conversation this process holds now: the one the last moving SessionStart named, while `$.session.id()`
 * still reads another within ID_LAG_MS of it (the id lags the move); else `$.session.id()`, adopted from
 * here (past the lag, or a /branch, whose fork's SessionStart names nothing). Undefined when neither knows.
 */
async function conversationOf($: EngineInterface): Promise<string | undefined> {
  let own: string | undefined
  try {
    const id = await $.session.id()
    own = SESSION_ID.test(id) ? id : undefined
  } catch {
    own = undefined
  }
  const named = conversation
  if (named === undefined) return own
  if (own === undefined || own === named.id) return named.id
  const now = await $.clock.now()
  if (now - named.at >= 0 && now - named.at <= ID_LAG_MS) return named.id
  conversation = { id: own, at: now }
  return own
}

async function getTurn($: EngineInterface): Promise<Turn | null> {
  return (await $.state.get(turnRef)).value ?? null
}

async function getResumes($: EngineInterface): Promise<Resumes | null> {
  return (await $.state.get(resumesRef)).value ?? null
}

/** `value` with the fields named in `drop` left out: stored state holds no undefined. */
function without<T extends object>(value: T, ...drop: (keyof T)[]): T {
  const copy: Partial<T> = { ...value }
  for (const key of drop) delete copy[key]
  return copy as T
}

/** `work`, or 'late' once `ms` have passed without it settling. */
function within<T>($: EngineInterface, work: Promise<T>, ms: number): Promise<T | 'late'> {
  return new Promise((resolve, reject) => {
    const timer = $.clock.after(ms, () => resolve('late'))
    work.then(
      value => {
        timer.cancel()
        resolve(value)
      },
      err => {
        timer.cancel()
        reject(err)
      },
    )
  })
}

/**
 * What a look at the account record means for what is held: the baseline, the same account, a
 * sign-out, a first sighting of another account (with Remote Control's reading then), or, at the
 * second look in a row, a change.
 */
async function noteAccount($: EngineInterface, held: Login | null, account: string | null, now: number): Promise<Login> {
  if (held === null) return { account }
  if (account === held.account) return held.candidate === undefined ? held : without(held, 'candidate', 'candidateRc')
  if (account === null) return { ...without(held, 'candidate', 'candidateRc'), account: null }
  if (held.candidate !== account) {
    const read = settings.reconnect ? (await readNow($)).state : 'unknown'
    // Connected if either says so: now, or when a /login here began (its close disconnects).
    const rc = connectedAtLogin !== undefined && now - connectedAtLogin < LOGIN_HOLD_MS ? 'connected' : read
    return { ...held, candidate: account, candidateRc: rc }
  }
  // Another account at two looks in a row: a change. One already being handled folds this one in:
  // the reconnect starts over (this change may stop Remote Control again), the resume still goes at
  // most once, and a lock the first one holds is given back.
  let pending: Pending
  // Remote Control a cap left down counts as connected before this change: Claude Code stopped it at the switch away.
  const wasConnected = held.candidateRc === 'connected' || held.rcOwed === true
  if (held.pending === undefined) {
    pending = { at: now, wasConnected, settingOn: await isSettingOn($) }
  } else {
    if (held.pending.lock !== undefined) await releaseLock($, held.pending.lock)
    // A retry after the cap that a real change folds into becomes that change: it may resume. Whatever it folds into, the
    // change counts its own reading of Remote Control, and the setting as it is now, over the first one's (or a retry's
    // placeholders, `wasConnected` as owed and `settingOn` false).
    const folded = held.pending.retry === true ? without(held.pending, 'retry', 'resumed') : held.pending
    pending = without(
      { ...folded, at: now, wasConnected: folded.wasConnected || wasConnected, settingOn: folded.settingOn || (await isSettingOn($)) },
      'idleAt',
      'readAt',
      'sawDown',
      'rc',
      'detail',
      'name',
      'ranAt',
      'lock',
      'resumeAt',
      'chrome',
      'chromeLooks',
      'chromeFirstAt',
      'chromeAt',
      'chromeRanAt',
    )
  }
  return { ...without(held, 'candidate', 'candidateRc'), account, pending }
}

/** An unusable read of the account record; the third in a row is said, once per load, with no content. */
function noteUnusable($: EngineInterface): void {
  unusable += 1
  if (unusable < UNUSABLE_LOOKS || toldUnusable) return
  toldUnusable = true
  $.ui.toast(
    "self-remote-control can't read the signed-in account from Claude Code's config file, so it can't tell when the login changes: no Remote Control reconnect and no resume after a login change.",
  )
}

/**
 * One look of the login watch: the login file's stat; after a change of it, or while another
 * account waits for its second look, the account record. Never throws.
 */
export async function watch($: EngineInterface): Promise<void> {
  if (busy) return
  busy = true
  try {
    if (paths === undefined) paths = await locate($)
    if (paths === null) return
    const now = await $.clock.now()
    const login = await statKey($, paths.login)
    if (login !== 'none') {
      if (login !== loginKey) claimLooks = CLAIM_LOOKS
    } else {
      // No login file: the record's own changes are the trigger, read at most every CLAIM_GAP_MS.
      const claim = await statKey($, paths.claim)
      if (claim !== claimKey && now - claimReadAt >= CLAIM_GAP_MS) {
        claimKey = claim
        claimLooks = Math.max(claimLooks, 1)
      }
    }
    loginKey = login
    const held = await getLogin($)
    let next = held
    if (claimLooks > 0 || held?.candidate !== undefined) {
      claimLooks = Math.max(0, claimLooks - 1)
      claimReadAt = now
      const account = await accountOf($, paths.claim)
      if (account === undefined) noteUnusable($)
      else {
        unusable = 0
        next = await noteAccount($, held, account, now)
      }
    }
    if (next !== null && next.pending === undefined && next.owedAt !== undefined && now >= next.owedAt) next = owedRetry(next, now)
    if (next !== held && next !== null) await setLogin($, next)
    if (next?.pending !== undefined) startMoving($)
  } catch {
    // The next look tries again.
  } finally {
    busy = false
  }
}

/**
 * Once the cap's window has passed after a burst of changes, the reconnects it held back, once, for the login as it
 * is now: Remote Control when a cap left it down (`rcOwed`), whatever account the login settled on, since Claude Code
 * stopped it at the switch away even when the login came back to the last reconnect's account; Claude in Chrome when
 * it last reconnected under another account (its connection isn't stopped by a switch). Nothing while signed out: the
 * sign-in after it is a change of its own, which counts Remote Control as owed.
 */
function owedRetry(held: Login, now: number): Login {
  const base = without(held, 'owedAt')
  if (held.account === null) return base
  const rc = held.rcOwed === true
  const chrome = held.chromeAccount !== undefined && held.chromeAccount !== held.account
  if (!rc && !chrome) return base
  // Seen down already: a connected reading is Remote Control back, not the old link yet to stop.
  return {
    ...base,
    pending: { at: now, wasConnected: rc, settingOn: false, retry: true, resumed: true, ...(rc ? { sawDown: true as const } : {}), ...(chrome ? {} : { chrome: 'none' as const }) },
  }
}

/**
 * Starts the login watch: one look now, then every POLL_MS, only where the files can be found (no
 * timer at all otherwise). A change a reload left is taken up again.
 */
export function startWatch($: EngineInterface): void {
  if (!isWatching() || watchTimer !== undefined) return
  void (async () => {
    try {
      if (paths === undefined) paths = await locate($)
      if (paths === null || watchTimer !== undefined) return
      watchTimer = $.clock.every(POLL_MS, () => void watch($))
      await watch($)
    } catch {
      // Nothing is watched in this load.
    }
  })()
}

function startMoving($: EngineInterface): void {
  if (tickTimer !== undefined) return
  tickTimer = $.clock.every(TICK_MS, () => void move($))
}

function stopMoving(): void {
  tickTimer?.cancel()
  tickTimer = undefined
}

/**
 * Around a /login in this session: Remote Control is read first (the dialog's close turns it off
 * when the account changed, so a reading after can't say it was on); a change waits until the
 * dialog has closed, since that close would turn off a reconnect made before it. Then a look at once.
 */
export async function aroundLogin<T>($: EngineInterface, run: () => Promise<T>): Promise<T> {
  let started: number | undefined
  try {
    started = await $.clock.now()
    logins.push(started)
    if (settings.reconnect && (await readNow($)).state === 'connected') connectedAtLogin = started
  } catch {
    // Without the clock, the change isn't held back.
  }
  try {
    return await run()
  } finally {
    if (started !== undefined) {
      const at = logins.indexOf(started)
      if (at !== -1) logins.splice(at, 1)
    }
    if (isWatching()) void watch($)
  }
}

/** ` as "<name>"`, or nothing when there is no name. */
const titled = (name: string | undefined) => (name === undefined ? '' : ` as "${name}"`)

/** What the toast says of the reconnect. */
function rcSaid(p: Pending): string {
  switch (p.rc) {
    case 'reconnected':
      return `Remote Control reconnected${titled(p.name)}`
    case 'connected':
      return 'Remote Control is connected'
    case 'stayed':
      return 'Remote Control still reads connected, so nothing ran'
    case 'was-off':
      return 'Remote Control was off, and is left off'
    case 'setting-off':
      return 'Remote Control left as it was (reconnectOnLoginChange is off)'
    case 'unavailable':
      return 'no Remote Control in this session'
    case 'unknown':
      return `Remote Control not reconnected: the remote-control command reads "${p.detail ?? ''}", which this plugin doesn't recognise`
    case 'not-taken':
      return "Remote Control: the command ran, but the session doesn't read as connected"
    case 'failed':
      return `Remote Control didn't reconnect: ${p.detail ?? 'no reason given'}`
    case 'capped':
      return `Remote Control not reconnected: it already reconnected ${RECONNECT_CAP} times in ${RECONNECT_WINDOW_MS / 60_000} minutes, so it waits for the login to settle (run /remote-control yourself to reconnect now)`
    case 'busy':
      return `Remote Control not reconnected: ${p.detail ?? "another run holds this session's Remote Control lock"}`
    default:
      return 'Remote Control: nothing ran'
  }
}

/** The reconnect runs within the window, oldest first. */
const recentRuns = (held: Login, now: number): number[] => (held.runs ?? []).filter(at => now - at < RECONNECT_WINDOW_MS)

/** The reconnect step: how it stands after this tick (the same while it waits), and the runs. */
async function reconnect($: EngineInterface, held: Login, p: Pending, now: number): Promise<{ p: Pending; held: Login }> {
  if (!settings.reconnect) return { p: { ...p, rc: 'setting-off' }, held }
  if (!p.wasConnected && !p.settingOn) return { p: { ...p, rc: 'was-off' }, held }
  if (p.readAt !== undefined && now < p.readAt) return { p, held }
  const isLate = now - (p.idleAt ?? now) >= RC_WAIT_MS
  let reading = await readNow($)
  let q: Pending = { ...p, readAt: now + RC_READ_MS }
  if (reading.state === 'unavailable') return { p: { ...q, rc: 'unavailable' }, held }
  if (reading.state === 'not connected') {
    q = { ...q, sawDown: true }
    const runs = recentRuns(held, now)
    if (runs.length >= RECONNECT_CAP) return { p: { ...q, rc: 'capped' }, held: { ...held, runs } }
    const taken = await takeLock($, now)
    if ('busy' in taken) return { p: isLate ? { ...q, rc: 'busy', detail: taken.busy } : { ...q, detail: taken.busy }, held }
    // Held: the fresh reading, then the run only if it still reads not connected.
    reading = await readNow($)
    if (reading.state === 'not connected') {
      const name = await sessionTitle($)
      try {
        // Bounded, so a command that never answers doesn't hold the watch; the lock stays held.
        await within($, runRemoteControl($, name), RUN_WAIT_MS)
      } catch (err) {
        await releaseLock($, taken.held)
        return { p: { ...q, rc: 'failed', detail: why(err) }, held }
      }
      const after = await $.clock.now()
      const ran: Pending = { ...q, rc: 'ran', ranAt: after, readAt: after + CHECK_MS, lock: taken.held, ...(name === undefined ? {} : { name }) }
      return { p: ran, held: { ...held, runs: [...runs, now] } }
    }
    await releaseLock($, taken.held)
    if (reading.state === 'unavailable') return { p: { ...q, rc: 'unavailable' }, held }
  }
  // Connected, after reading not connected or when it wasn't before: connected again since.
  if (reading.state === 'connected' && (!p.wasConnected || q.sawDown === true)) return { p: { ...q, rc: 'connected' }, held }
  if (!isLate) return { p: q, held }
  if (reading.state === 'connected') return { p: { ...q, rc: 'stayed' }, held }
  if (reading.state === 'unknown') return { p: { ...q, rc: 'unknown', detail: reading.description }, held }
  return { p: q, held }
}

/** The run's check: reconnected (the lock given back), or still waiting; LOCK_HOLD_MS ends it in `move`. */
async function check($: EngineInterface, p: Pending, now: number): Promise<Pending> {
  if (p.readAt !== undefined && now < p.readAt) return p
  const reading = await readNow($)
  if (reading.state !== 'connected') return { ...p, readAt: now + RC_READ_MS }
  if (p.lock !== undefined) await releaseLock($, p.lock)
  return { ...without(p, 'lock'), rc: 'reconnected' }
}

/** Whether a resume is due now, before the session's own delay: the cheap part of the resume's conditions. */
async function isResumeDue($: EngineInterface, p: Pending, now: number): Promise<boolean> {
  if (!settings.resume || p.resumed === true) return false
  if ((await getResumes($))?.blocked === true) return false
  return isCutOff(await getTurn($), now)
}

/** The session's own delay before its resume. */
async function jitter($: EngineInterface): Promise<number> {
  try {
    return jitterOf(await $.session.id())
  } catch {
    return Math.floor(Math.random() * (JITTER_MS + 1))
  }
}

/** How long ago, as a resume's line says it: seconds, then minutes, then hours. */
function agoText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 120) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`
}

/** A resume's words: the error kind its turn ended on, and how long ago, so a resume can be checked after the fact. */
export const resumedSaid = (error: string | undefined, ms: number): string => `resumed: the turn ended on ${error ?? 'an error'} ${agoText(ms)} ago`

/** The resume step: sends RESUME to a turn that was cut off; says what it did, in the toast's words and the debug log. */
async function resume($: EngineInterface, held: Login, p: Pending, now: number): Promise<string> {
  if (!settings.resume) return 'no resume (resumeAfterLoginChange is off)'
  if (p.resumed === true) return 'the interrupted turn was resumed'
  if ((await getResumes($))?.blocked === true) return 'no resume: the last one ended on an error at once, so it waits for you to type'
  const turn = await getTurn($)
  if (!isCutOff(turn, now)) return 'no turn was cut off'
  await setLogin($, { ...held, pending: { ...p, resumed: true } })
  // The claim, right before the submit: whoever claims this stop first resumes it, and no one else. Keyed by
  // the conversation the stop was recorded in, never by `$.session.id()` now, which may lag a move.
  const claim = await claimResume($, turn?.turnId, turn?.session, now)
  if ('lost' in claim) {
    $.ui.log(`self-remote-control: ${claim.lost}`, { to: 'debug' })
    return claim.lost
  }
  // The claim can take a while (one PowerShell run): a turn that started meanwhile, a person typing, means
  // nothing is cut off any more, and so does one that started and ended on the limit again (another stop, with
  // a claim of its own). Either way it is given back, and nothing is sent. A turn that starts between this look
  // and the submit below can't be ruled out (the submit is queued behind it then); the window is two state
  // operations, the resume record's read and its write.
  const again = await getTurn($)
  if (!isCutOff(again, await $.clock.now()) || again?.turnId !== turn?.turnId || again?.at !== turn?.at) {
    await claim.giveBack()
    const said = 'no resume: a turn started while the resume was being claimed'
    $.ui.log(`self-remote-control: ${said}`, { to: 'debug' })
    return said
  }
  await $.state.set(resumesRef, { ...((await getResumes($)) ?? {}), sentAt: now })
  const said = resumedSaid(turn?.error, now - (turn?.at ?? now))
  const submitting = $.prompt.submit({ text: RESUME })
  let wasLate = false
  // However the submit ends, even after the wait below has given up on it: a drop or a refusal gives the claim
  // back, and one after the toast said it was queued is told.
  submitting
    .then(
      async sent => {
        if (sent.drop === undefined) return
        await claim.giveBack()
        if (!wasLate) return
        $.ui.log(`self-remote-control: the queued resume was dropped: ${sent.drop}`, { to: 'debug' })
        $.ui.toast(`The queued resume was dropped: ${sent.drop}`)
      },
      () => claim.giveBack(),
    )
    .catch(() => undefined)
  let outcome: string
  try {
    const sent = await within($, submitting, SUBMIT_WAIT_MS)
    wasLate = sent === 'late'
    outcome = sent === 'late' ? `${said} (queued, to run once the session is idle)` : sent.drop === undefined ? said : `resume not sent: ${sent.drop}`
  } catch (err) {
    outcome = `resume not sent: ${why(err)}`
  }
  $.ui.log(`self-remote-control: ${outcome}`, { to: 'debug' })
  return outcome
}

/** Whether a /login in this session holds a change back. */
const isLoginRunning = (now: number): boolean => logins.some(at => now - at < LOGIN_HOLD_MS)

/** The servers this session has listed tools of before, with what `tools` lists now added. Never throws. */
async function rememberServers($: EngineInterface, tools: readonly { name: string }[]): Promise<Servers> {
  const known = await getServers($)
  const seen: Servers = {
    ...known,
    ...(tools.some(tool => tool.name.startsWith(`mcp__${CHROME}__`)) ? { chrome: true as const } : {}),
    ...(tools.some(tool => tool.name.startsWith(COORDINATOR_TOOLS)) ? { coordinator: true as const } : {}),
  }
  if (seen.chrome !== known.chrome || seen.coordinator !== known.coordinator) {
    serversMirror = seen
    await $.state.set(serversRef, seen).catch(() => undefined)
  }
  return seen
}

/**
 * Notes which of Claude in Chrome and the coordinator this session lists tools of, so that a login change that drops
 * Claude in Chrome's server still finds it was there: at the session's start and each main-loop turn's end. Never throws.
 */
export async function noteServers($: EngineInterface): Promise<void> {
  try {
    await rememberServers($, await $.tool.list())
  } catch {
    // The next look tries again.
  }
}

/** Claude in Chrome's reconnect runs within the window, oldest first. */
const recentChromeRuns = (held: Login, now: number): number[] => (held.chromeRuns ?? []).filter(at => now - at < RECONNECT_WINDOW_MS)

/**
 * Claude in Chrome's step, one look a tick: the coordinator's tools looked for at once and CHROME_LOOK_MS after the
 * first look, then /mcp reconnect where no coordinator runs, at most RECONNECT_CAP times in RECONNECT_WINDOW_MS (as
 * Remote Control's reconnect). The change as it stands after this look; `p.chrome` stays absent while a look is
 * still due. Never throws.
 */
async function chromeStep($: EngineInterface, held: Login, p: Pending, now: number): Promise<{ p: Pending; held: Login }> {
  // Started before a reload of this plugin, and maybe still running: never a second run.
  if (p.chromeRanAt !== undefined) return { p: { ...without(p, 'chromeRanAt'), chrome: 'reloaded' }, held }
  if (p.chromeAt !== undefined && now < p.chromeAt) return { p, held }
  const q = await chromeLook($, p, now)
  if (q.chrome !== 'reconnect') return { p: q.p, held }
  const runs = recentChromeRuns(held, now)
  if (runs.length >= RECONNECT_CAP) return { p: { ...q.p, chrome: 'capped' }, held: { ...held, chromeRuns: runs } }
  const marked: Pending = { ...q.p, chromeRanAt: now }
  const next: Login = { ...held, chromeRuns: [...runs, now], chromeAccount: held.account }
  await setLogin($, { ...next, pending: marked })
  try {
    const ran = await within($, $.command.run({ command: 'mcp', args: `reconnect ${CHROME}` }), RUN_WAIT_MS)
    return { p: { ...without(marked, 'chromeRanAt'), chrome: ran === 'late' ? 'queued' : 'ran' }, held: next }
  } catch (err) {
    $.ui.log(`self-remote-control: /mcp reconnect ${CHROME} was refused: ${why(err)}`, { to: 'debug' })
    return { p: { ...without(marked, 'chromeRanAt'), chrome: 'failed' }, held: next }
  }
}

/** One look of Claude in Chrome's step: decided, still looking, or 'reconnect'. Never throws. */
async function chromeLook($: EngineInterface, p: Pending, now: number): Promise<{ p: Pending; chrome?: 'reconnect' }> {
  let tools: readonly { name: string }[]
  try {
    tools = await $.tool.list()
  } catch (err) {
    $.ui.log(`self-remote-control: Claude in Chrome left as it was: this session's tools can't be listed (${why(err)})`, { to: 'debug' })
    return { p: { ...p, chrome: 'unread' } }
  }
  const servers = await rememberServers($, tools)
  if (servers.chrome !== true) return { p: { ...p, chrome: 'none' } }
  if (tools.some(tool => tool.name.startsWith(COORDINATOR_TOOLS))) {
    $.ui.log('self-remote-control: Claude in Chrome left to the coordinator, which runs in this session', { to: 'debug' })
    return { p: { ...p, chrome: 'coordinator' } }
  }
  const looks = (p.chromeLooks ?? 0) + 1
  const first = p.chromeFirstAt ?? now
  const next = CHROME_LOOK_MS[looks - 1]
  if (next !== undefined) return { p: { ...p, chromeLooks: looks, chromeFirstAt: first, chromeAt: first + next } }
  if (servers.coordinator === true) {
    $.ui.log("self-remote-control: Claude in Chrome left as it was: the coordinator's tools were listed in this session before and aren't now, and the coordinator may reconnect it", { to: 'debug' })
    return { p: { ...p, chrome: 'unsure' } }
  }
  return { p, chrome: 'reconnect' }
}

/**
 * Claude in Chrome's outcomes that did something (its reconnect ran, or was tried): news, told even while a cap's toast
 * holds. One that left it as it was (none, coordinator, unread, unsure) says the same words at every flap.
 */
const CHROME_TELLS: ReadonlySet<string> = new Set(['ran', 'queued', 'reloaded', 'failed'])
/** Remote Control's outcomes that did nothing: no news while a cap's toast holds. */
const RC_QUIET: ReadonlySet<string> = new Set(['was-off', 'setting-off', 'unavailable', 'stayed'])
/** Remote Control's outcomes after which it ran or reads connected: nothing more is owed it. */
const RC_UP: ReadonlySet<string> = new Set(['reconnected', 'connected', 'stayed', 'not-taken'])

/** What the toast says of Claude in Chrome: nothing when this session has none. */
function chromeSaid(p: Pending): string {
  switch (p.chrome) {
    case 'ran':
      return "; Claude in Chrome: /mcp reconnect ran, so its tab group starts over (Claude Code's own line says whether it reconnected)"
    case 'queued':
      return `; Claude in Chrome: /mcp reconnect hadn't finished within ${RUN_WAIT_MS / 1000} s (queued or still running; its tab group starts over when it runs)`
    case 'reloaded':
      return `; Claude in Chrome: /mcp reconnect was started before this plugin reloaded, so it isn't run again (its tab group starts over if it ran)`
    case 'failed':
      return `; Claude in Chrome didn't reconnect: run /mcp reconnect ${CHROME}`
    case 'unread':
      return `; Claude in Chrome left as it was: this session's tools can't be listed (run /mcp reconnect ${CHROME} if it needs it)`
    case 'unsure':
      return `; Claude in Chrome left as it was: the coordinator's tools were here before and aren't now, and the coordinator may reconnect it (run /mcp reconnect ${CHROME} if it doesn't)`
    case 'coordinator':
      return `; Claude in Chrome left to the coordinator (run /mcp reconnect ${CHROME} if it doesn't reconnect)`
    case 'capped':
      return `; Claude in Chrome not reconnected: it already reconnected ${RECONNECT_CAP} times in ${RECONNECT_WINDOW_MS / 60_000} minutes, so it waits for the login to settle (run /mcp reconnect ${CHROME} yourself to reconnect now)`
    default:
      return ''
  }
}

/**
 * Moves a change being handled on by one step, once no turn and no /login runs: the reconnect, its
 * check, Claude in Chrome's step and the session's own delay, then the resume and the toast. A lock
 * held past LOCK_HOLD_MS is given back whatever else waits. Never throws.
 */
export async function move($: EngineInterface): Promise<void> {
  if (busy) return
  busy = true
  try {
    let held = await getLogin($)
    const pending = held?.pending
    if (held === null || pending === undefined) {
      stopMoving()
      return
    }
    const now = await $.clock.now()
    const stored: Login = held
    let p = pending
    if (p.lock !== undefined && now - p.lock.at >= LOCK_HOLD_MS) {
      await releaseLock($, p.lock)
      p = without(p, 'lock')
      if (p.rc === 'ran') p = { ...p, rc: 'not-taken' }
    }
    /** Writes the change as it now stands, when anything moved. */
    const save = async (q: Pending, login: Login = stored) => {
      if (q !== pending || login !== stored) await setLogin($, { ...login, pending: q })
    }
    /** `q` with its idle moment forgotten: a turn or a /login runs. */
    const busyAgain = (q: Pending) => (q.idleAt === undefined ? q : without(q, 'idleAt'))
    const turn = await getTurn($)
    if (turn?.running === true || isLoginRunning(now)) return await save(busyAgain(p))
    if (turn !== null && now - turn.at < SETTLE_MS) return await save(p)
    if (p.idleAt === undefined) p = { ...p, idleAt: now }
    if (p.rc === undefined) ({ p, held } = await reconnect($, held, p, now))
    else if (p.rc === 'ran') p = await check($, p, now)
    if (p.rc === undefined || p.rc === 'ran') return await save(p, held)
    // The Remote Control step has settled, whatever its outcome: the session's own delay starts, and Claude in
    // Chrome's step goes on meanwhile; the resume waits for both.
    if (p.resumeAt === undefined && (await isResumeDue($, p, now))) {
      p = { ...p, resumeAt: now + (await jitter($)) }
    }
    if (settings.chrome && p.chrome === undefined) {
      // A turn that started since this tick began holds the reconnect back, as it holds the resume.
      if ((await getTurn($))?.running === true) return await save(busyAgain(p), held)
      const before = held
      ;({ p, held } = await chromeStep($, held, p, now))
      if (p.chrome === undefined) return await save(p, held)
      // Its runs are kept now: the settle below reads the login again.
      if (held !== before) await setLogin($, { ...held, pending: p })
    }
    if (p.resumeAt !== undefined && now < p.resumeAt) return await save(p, held)
    if ((await getTurn($))?.running === true) return await save(busyAgain(p), held)
    const resumed = await resume($, held, p, now)
    stopMoving()
    const latest = (await getLogin($)) ?? held
    const runs = recentRuns(latest, now)
    const chromeRuns = recentChromeRuns(latest, now)
    // A retry after the cap has its own toast; after it, a cap is new again and is told.
    const told = p.retry === true ? without(latest, 'cappedAt', 'chromeCappedAt') : latest
    const isCapToldAlready = p.rc === 'capped' && told.cappedAt !== undefined && now - told.cappedAt < RECONNECT_WINDOW_MS
    const isChromeCapToldAlready = p.chrome === 'capped' && told.chromeCappedAt !== undefined && now - told.chromeCappedAt < RECONNECT_WINDOW_MS
    // Remote Control a cap left down stays owed until it ran or reads connected; the retry is its one try.
    const rcOwed = p.rc === 'capped' || (latest.rcOwed === true && p.retry !== true && !RC_UP.has(p.rc ?? ''))
    // A reconnect the cap held back is tried again, once, when the oldest run leaves the window (owedRetry). One still
    // owed keeps its time; one owed with none (its retry was folded into this change) is due when the cap allows.
    const owed = [p.rc === 'capped' ? runs[0] : undefined, p.chrome === 'capped' ? chromeRuns[0] : undefined]
      .filter((at): at is number => at !== undefined)
      .map(at => at + RECONNECT_WINDOW_MS)
    if (rcOwed && p.rc !== 'capped') {
      if (latest.owedAt !== undefined) owed.push(latest.owedAt)
      else owed.push(runs.length >= RECONNECT_CAP ? (runs[0] as number) + RECONNECT_WINDOW_MS : now)
    }
    const settled: Login = {
      ...without(latest, 'pending', 'runs', 'cappedAt', 'chromeRuns', 'chromeCappedAt', 'owedAt', 'rcOwed'),
      ...(runs.length === 0 ? {} : { runs }),
      ...(chromeRuns.length === 0 ? {} : { chromeRuns }),
      ...(p.rc === 'capped' ? { cappedAt: isCapToldAlready ? (told.cappedAt as number) : now } : told.cappedAt === undefined ? {} : { cappedAt: told.cappedAt }),
      ...(p.chrome === 'capped' ? { chromeCappedAt: isChromeCapToldAlready ? (told.chromeCappedAt as number) : now } : told.chromeCappedAt === undefined ? {} : { chromeCappedAt: told.chromeCappedAt }),
      ...(owed.length === 0 ? {} : { owedAt: Math.max(...owed) }),
      ...(rcOwed ? { rcOwed: true as const } : {}),
    }
    await setLogin($, settled)
    // A cap's line is told once while that cap holds: after it, its part is left out.
    const rcPart = isCapToldAlready ? '' : rcSaid(p)
    const chromePart = isChromeCapToldAlready ? '' : chromeSaid(p).replace(/^; /, '')
    if (p.retry === true) {
      // Only what was owed: Remote Control when it was (wasConnected), Claude in Chrome when it was.
      const parts = [p.wasConnected ? rcPart : '', chromePart].filter(part => part !== '')
      if (parts.length > 0) $.ui.toast(`Login settled after the reconnect cap; ${parts.join('; ')}.`)
      return
    }
    // While a cap's toast holds, one only when something else in it is new: a resume, or a step that did something.
    if (isCapToldAlready || isChromeCapToldAlready) {
      const isRcNews = rcPart !== '' && !RC_QUIET.has(p.rc ?? '')
      const isChromeNews = CHROME_TELLS.has(p.chrome ?? 'none') || (p.chrome === 'capped' && chromePart !== '')
      if (!isRcNews && !isChromeNews && !resumed.startsWith('resumed:')) return
    }
    $.ui.toast(`Login changed; ${[rcPart, chromePart, resumed].filter(part => part !== '').join('; ')}.`)
  } catch {
    // The next tick tries again.
  } finally {
    busy = false
  }
}

/**
 * On a main-loop turn's start: running, its error kind cleared. The first turn after the resume was
 * sent whose text holds it is the resume's own; a continuation (no text) is not.
 */
export async function noteTurnStart($: EngineInterface, text: string, turnId?: string): Promise<void> {
  try {
    const now = await $.clock.now()
    const resumes = await getResumes($)
    const sentAt = resumes?.sentAt
    const isResumeTurn = sentAt !== undefined && now - sentAt < SENT_MS && text.includes(RESUME)
    if (resumes !== null && sentAt !== undefined && (isResumeTurn || now - sentAt >= SENT_MS)) await $.state.set(resumesRef, without(resumes, 'sentAt'))
    const session = await conversationOf($)
    await $.state.set(turnRef, { running: true, at: now, ...(isResumeTurn ? { fromResume: true as const } : {}), ...(turnId === undefined ? {} : { turnId }), ...(session === undefined ? {} : { session }) })
  } catch {
    // The turn's end sets it again.
  }
}

/** How a main-loop turn ended, as turn.complete says. */
export type TurnEnd = { reason: NonNullable<Turn['outcome']>; durationMs: number; usage?: unknown; turnId?: string }

/**
 * On a main-loop turn's end: how it ended, keeping the error kind StopFailure gave this turn. A
 * resume's turn that ends on an error at once blocks the next resume until a person types; a prompt
 * the person typed while it ran (queued behind it) already counts.
 */
export async function noteTurnEnd($: EngineInterface, end: TurnEnd): Promise<void> {
  try {
    const prior = await getTurn($)
    const isThisTurn = prior !== null && (prior.running || prior.outcome === undefined)
    const error = isThisTurn ? prior.error : undefined
    const fromResume = isThisTurn && prior.fromResume === true
    // The id turn.complete carries, else the one its turn.start did, and the conversation its turn.start was
    // in, else the one held now: the resume claim's key.
    const turnId = end.turnId ?? (isThisTurn ? prior.turnId : undefined)
    const session = (isThisTurn ? prior.session : undefined) ?? (await conversationOf($))
    await $.state.set(turnRef, {
      running: false,
      at: await $.clock.now(),
      outcome: end.reason,
      ...(error === undefined ? {} : { error }),
      ...(fromResume ? { fromResume: true as const } : {}),
      ...(turnId === undefined ? {} : { turnId }),
      ...(session === undefined ? {} : { session }),
    })
    if (fromResume && end.reason === 'error' && (end.usage === undefined || end.durationMs < QUICK_MS)) {
      const resumes = (await getResumes($)) ?? {}
      const hasTypedSince = resumes.personAt !== undefined && prior !== null && resumes.personAt >= prior.at
      if (!hasTypedSince) await $.state.set(resumesRef, { ...resumes, blocked: true })
    }
  } catch {
    // Without it, no resume follows a change.
  }
}

/**
 * On a prompt the person typed (at the terminal or from the app): the loop-breaker lets go, and
 * when, so a resume's turn that is running now and ends at once doesn't block after it.
 */
export async function notePersonPrompt($: EngineInterface): Promise<void> {
  try {
    const resumes = (await getResumes($)) ?? {}
    await $.state.set(resumesRef, { ...without(resumes, 'blocked'), personAt: await $.clock.now() })
  } catch {
    // The next prompt tries again.
  }
}

/** On the main conversation's StopFailure: the API error kind its turn ended on. */
export async function noteFailure($: EngineInterface, error: string): Promise<void> {
  try {
    const prior = await getTurn($)
    await $.state.set(turnRef, { ...(prior ?? { running: false, at: await $.clock.now() }), error })
  } catch {
    // The turn's outcome still says it ended on an error.
  }
}

/** On a /clear or a resume: the conversation is another one, and its last turn isn't known. */
export async function forgetTurn($: EngineInterface): Promise<void> {
  try {
    await $.state.set(turnRef, null)
    await $.state.set(resumesRef, null)
  } catch {
    // Nothing to undo.
  }
}
