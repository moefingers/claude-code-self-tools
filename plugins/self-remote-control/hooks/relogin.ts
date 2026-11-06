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
// What a change does, once no turn and no /login is running:
//   1. Remote Control, when reconnectOnLoginChange is on and Remote Control should be on: it read
//      connected when the new account was first seen, or the `remoteControl` setting for all
//      sessions is true. The remote-control command runs, under the session's title, only under the
//      Remote Control lock (rc-lock.ts, shared with the coordinator plugin) and on a fresh reading of
//      "not connected" taken after the lock; never while it reads connected or unknown. A connected
//      reading right after the change may be the old link not yet stopped, so it waits up to
//      RC_WAIT_MS for it to read not connected, and runs nothing if it never does. At most
//      RECONNECT_CAP runs in RECONNECT_WINDOW_MS, so a login that flaps doesn't fill the app's list.
//   2. The resume, when resumeAfterLoginChange is on and the main conversation's last turn ended,
//      within CUT_OFF_MS, on an API error a login can clear (the usage limit, a failed sign-in, ...)
//      with no turn since: RESUME, once, after the reconnect has settled and
//      the session's own delay (0 to JITTER_MS, so the sessions of one switch don't all start at
//      once). A turn still running at the change is waited for. A session at a finished break gets
//      nothing. A resume whose turn ends on an error at once (no usage, or under QUICK_MS) isn't
//      followed by another until a person types: the loop-breaker. A rewind past the cut-off turn
//      isn't seen (the API gives no cheap mark of the newest message, and $.session.messages()
//      copies up to 4096 of them): the 6-hour limit bounds it.
//   3. One toast saying what happened (one only while the reconnect cap holds).
import type { EngineInterface, PluginOptions, Timer } from 'claude-code'
import type { Login, Pending, Resumes, Turn } from '../types'
import { readNow, runRemoteControl, sessionTitle, why } from './connection'
import { LOCK_HOLD_MS, releaseLock, takeLock } from './rc-lock'

const loginRef = { plugin: 'self-remote-control', key: 'login' } as const
const turnRef = { plugin: 'self-remote-control', key: 'turn' } as const
const resumesRef = { plugin: 'self-remote-control', key: 'resumes' } as const

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
/** How long after the resume was sent a turn starting with it counts as its turn. */
const SENT_MS = 10 * 60_000

/**
 * API error kinds a new login can clear: the limits, a failed or refused sign-in, billing, and an
 * outage. Any other kind (an invalid request, a too-long output, an unknown model, one Claude Code
 * classes `unknown`, or none given) would fail the same way again, and is left alone.
 */
const RESUMABLE = new Set(['rate_limit', 'authentication_failed', 'billing_error', 'oauth_org_not_allowed', 'account_on_hold', 'overloaded', 'server_error'])

/** Where the watch looks: the login file (stat only) and the config file holding the account record. */
type Paths = { login: string; claim: string }

type Settings = { reconnect: boolean; resume: boolean }

let settings: Settings = { reconnect: true, resume: true }
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

/** Reads this load's settings and starts over; at register. */
export function configureRelogin(options: PluginOptions): void {
  settings = { reconnect: options.reconnectOnLoginChange !== false, resume: options.resumeAfterLoginChange !== false }
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
}

/** Whether the watch runs at all: off when both settings are. */
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

async function getLogin($: EngineInterface): Promise<Login | null> {
  return (await $.state.get(loginRef)).value ?? null
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
  if (held.pending === undefined) {
    pending = { at: now, wasConnected: held.candidateRc === 'connected', settingOn: await isSettingOn($) }
  } else {
    if (held.pending.lock !== undefined) await releaseLock($, held.pending.lock)
    pending = without({ ...held.pending, at: now }, 'idleAt', 'readAt', 'sawDown', 'rc', 'detail', 'name', 'ranAt', 'lock', 'resumeAt')
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
    if (next !== held) await $.state.set(loginRef, next)
    if (next?.pending !== undefined) startMoving($)
  } catch {
    // The next look tries again.
  } finally {
    busy = false
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

/** The resume step: sends RESUME to a turn that was cut off; says what it did. */
async function resume($: EngineInterface, held: Login, p: Pending, now: number): Promise<string> {
  if (!settings.resume) return 'no resume (resumeAfterLoginChange is off)'
  if (p.resumed === true) return 'the interrupted turn was resumed'
  if ((await getResumes($))?.blocked === true) return 'no resume: the last one ended on an error at once, so it waits for you to type'
  const turn = await getTurn($)
  if (!isCutOff(turn, now)) return 'no turn was cut off'
  await $.state.set(loginRef, { ...held, pending: { ...p, resumed: true } })
  await $.state.set(resumesRef, { ...((await getResumes($)) ?? {}), sentAt: now })
  try {
    const sent = await within($, $.prompt.submit({ text: RESUME }), SUBMIT_WAIT_MS)
    if (sent === 'late') return 'the resume is queued, to run once the session is idle'
    return sent.drop === undefined ? 'resumed the interrupted turn' : `resume not sent: ${sent.drop}`
  } catch (err) {
    return `resume not sent: ${why(err)}`
  }
}

/** Whether a /login in this session holds a change back. */
const isLoginRunning = (now: number): boolean => logins.some(at => now - at < LOGIN_HOLD_MS)

/**
 * Moves a change being handled on by one step, once no turn and no /login runs: the reconnect, its
 * check, the session's own delay, then the resume and the toast. A lock held past LOCK_HOLD_MS is
 * given back whatever else waits. Never throws.
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
      if (q !== pending || login !== stored) await $.state.set(loginRef, { ...login, pending: q })
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
    // The reconnect has settled: the session's own delay, then the resume.
    if (p.resumeAt === undefined && (await isResumeDue($, p, now))) {
      p = { ...p, resumeAt: now + (await jitter($)) }
    }
    if (p.resumeAt !== undefined && now < p.resumeAt) return await save(p, held)
    if ((await getTurn($))?.running === true) return await save(busyAgain(p), held)
    const resumed = await resume($, held, p, now)
    stopMoving()
    const latest = (await getLogin($)) ?? held
    const runs = recentRuns(latest, now)
    const isCapToldAlready = p.rc === 'capped' && latest.cappedAt !== undefined && now - latest.cappedAt < RECONNECT_WINDOW_MS
    const settled: Login = {
      ...without(latest, 'pending', 'runs', 'cappedAt'),
      ...(runs.length === 0 ? {} : { runs }),
      ...(p.rc === 'capped' ? { cappedAt: isCapToldAlready ? (latest.cappedAt as number) : now } : latest.cappedAt === undefined ? {} : { cappedAt: latest.cappedAt }),
    }
    await $.state.set(loginRef, settled)
    if (isCapToldAlready && resumed !== 'resumed the interrupted turn') return
    $.ui.toast(`Login changed; ${rcSaid(p)}; ${resumed}.`)
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
export async function noteTurnStart($: EngineInterface, text: string): Promise<void> {
  try {
    const now = await $.clock.now()
    const resumes = await getResumes($)
    const sentAt = resumes?.sentAt
    const isResumeTurn = sentAt !== undefined && now - sentAt < SENT_MS && text.includes(RESUME)
    if (resumes !== null && sentAt !== undefined && (isResumeTurn || now - sentAt >= SENT_MS)) await $.state.set(resumesRef, without(resumes, 'sentAt'))
    await $.state.set(turnRef, { running: true, at: now, ...(isResumeTurn ? { fromResume: true as const } : {}) })
  } catch {
    // The turn's end sets it again.
  }
}

/** How a main-loop turn ended, as turn.complete says. */
export type TurnEnd = { reason: NonNullable<Turn['outcome']>; durationMs: number; usage?: unknown }

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
    await $.state.set(turnRef, {
      running: false,
      at: await $.clock.now(),
      outcome: end.reason,
      ...(error === undefined ? {} : { error }),
      ...(fromResume ? { fromResume: true as const } : {}),
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
