// The update check: tells the session, and the person, when this plugin is out of date.
//
// Canonical copy: shared/hooks/update-check.ts. Each plugin carries an identical copy at
// plugins/<name>/hooks/update-check.ts, since each installs on its own; `node scripts/sync-shared.mjs`
// writes them, and `node --test "scripts/*.test.mjs"` fails when one differs or is left over. Edit the canonical
// copy only.
//
// When one of the plugin's tools is called by the main session, and the last check is 30 minutes old
// or there is none, the plugin fetches its own plugin.json from the default branch of the repository
// its installed plugin.json names, and compares the `version` there with the installed one. The
// request is a plain GET: the plugin adds no headers, query or body, and sends nothing about the
// session or the machine. GitHub sees it as it sees any web request (the address it comes from, the
// time, the headers the host sends on its own). The check's time and answer are kept in the plugin's
// own $.store, so a reload or another session on this machine within the 30 minutes uses that answer
// instead of fetching again. Sessions that come due at the same moment each make their one GET.
//
// Off the tool path: everything that reads (the env, the manifest, the store, the clock) or fetches
// runs in a chain of its own that the tool call never waits on. The call's answer gets the notice only
// from what that chain already knows (the store, loaded at the session's start, or an earlier check),
// so the call that starts a check never waits for its answer; and a failure anywhere in the chain is
// silence: offline, refused by policy, a 404, a rate limit, a timeout, bad JSON.
//
// The notice is fixed text: its only values are the plugin's name, from the fixed list below, and the
// two versions, each of which must be three whole numbers (VERSION) or there is no notice. Nothing
// else from the fetched file reaches the session. It tells the session what the person can run; it
// never asks the session to run anything. A session is told of each check once, and at most once per
// 30 minutes: the chain works out, from its own reading of the clock, whether 30 minutes have passed
// since the session was last told, and a call tells only when they have. Time only moves on, so a
// "yes" worked out earlier still holds when a later call reads it; a "no" can hold the notice back
// one call longer than it needs. The toast for the person follows the same rule.
//
// Off with the plugin's `updateCheck` setting set to `off`, or while CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
// is set to anything. Subagents' calls check nothing.
import type { EngineInterface, PluginOptions, Timer } from 'claude-code'

/** The plugins of this marketplace: the only names a notice carries. */
export const PLUGINS = ['self-clear', 'self-compact', 'self-context', 'self-exit', 'self-mcp', 'self-reload', 'self-remote-control', 'self-restart', 'self-switch', 'self-wake'] as const
export type PluginName = (typeof PLUGINS)[number]

const MARKETPLACE = 'claude-code-self-tools'

/** How long a check's answer stands before the next tool call checks again, and the least time between two notices to a session. */
export const WINDOW_MS = 30 * 60 * 1000
/** How long the request may take; past it, the check has no answer. */
export const TIMEOUT_MS = 5000
/** The most of a response read as a manifest; a longer one is no answer. */
const MAX_TEXT = 64 * 1024
/** The most sessions whose notices the store keeps. */
const MAX_SESSIONS = 100

/** $.store keys: the last check, and what each session was told, and when. */
const CHECK_KEY = 'updateCheck'
const SEEN_KEY = 'updateSeen'

/** A version as the manifests write it: three whole numbers and two dots, nothing around them. */
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/

/** A session id fit to key the store with (a UUID is); never `__proto__` and the like. */
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** The last check: when (`$.clock.now()` milliseconds), and the published version, null when there was no usable answer. */
type Check = { at: number; latest: string | null }

/**
 * What a session was told: of which check (`noticed`, `toasted`: that check's `at`), and when
 * (`noticedAt`, `toastedAt`: `$.clock.now()` milliseconds), in a tool's answer and in a toast.
 */
type Seen = { noticed?: number; noticedAt?: number; toasted?: number; toastedAt?: number }

/** The installed plugin: its version, and the URL of its published manifest. */
type Installed = { version: string; url: string }

/** What a tool.call answer may hold, as far as the notice cares. */
type Answer = { result?: unknown; deny?: unknown; ref?: unknown }

// What this load of the plugin knows. Module state, so a reload of the plugin starts it afresh; what
// must outlast a load is in $.store.
/** Set by configureUpdateCheck, at register. */
let plugin: PluginName | undefined
let enabled = false
/** Read once per load: undefined until read, null when it can't be used (no check then). */
let installed: Installed | null | undefined
/** This session's id, to keep what it was told in the store; null when it can't key the store. */
let session: string | null | undefined
/** Set at each session.start: the session may have changed (/clear, a resume), so read its id again. */
let isSessionStale = true
let check: Check | undefined
let seen: Seen = {}
/** Whether 30 minutes have passed since this session was last told, as the chain last worked it out. */
let mayNotice = false
/** A call told the session; the chain notes when, at its next reading of the clock. */
let isNoticeUnstamped = false
/** The background work, one piece after another; never rejects. */
let chain: Promise<void> = Promise.resolve()

export const isVersion = (value: unknown): value is string => typeof value === 'string' && VERSION.test(value)

/** Compares two versions number by number: negative when `a` is older, 0 when equal, positive when newer. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  return 0
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isPlugin = (name: string): name is PluginName => (PLUGINS as readonly string[]).includes(name)

/**
 * The raw URL of plugin `name`'s manifest on the default branch of the GitHub repository `repository`
 * names (`https://github.com/<owner>/<repo>`, as a string or `{ url }`); undefined for anything else.
 */
export function manifestUrl(repository: unknown, name: PluginName): string | undefined {
  const raw = typeof repository === 'string' ? repository : isRecord(repository) ? repository.url : undefined
  if (typeof raw !== 'string') return undefined
  const found = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(raw)
  const owner = found?.[1]
  const repo = found?.[2]
  if (owner === undefined || repo === undefined || /^\.+$/.test(repo)) return undefined
  return `https://raw.githubusercontent.com/${owner}/${repo}/main/plugins/${name}/.claude-plugin/plugin.json`
}

/** The line the tool's answer ends with, for the session; undefined unless every value is what it must be. */
export function notice(name: string, version: string, latest: string): string | undefined {
  if (!isPlugin(name) || !isVersion(version) || !isVersion(latest)) return undefined
  return `${name} ${version} is out of date (${latest} is published). To update, the person runs: claude plugin marketplace update ${MARKETPLACE}, then claude plugin update ${name}@${MARKETPLACE}, then /reload-plugins in each open session (a new session loads the update on its own). Don't run these yourself unless the person asks.`
}

/** The toast, for the person; undefined unless every value is what it must be. */
export function toastText(name: string, version: string, latest: string): string | undefined {
  if (!isPlugin(name) || !isVersion(version) || !isVersion(latest)) return undefined
  return `${name} ${version} is out of date (${latest} is published). To update: claude plugin marketplace update ${MARKETPLACE}, then claude plugin update ${name}@${MARKETPLACE}, then /reload-plugins or a new session.`
}

/** The published version in a manifest's text, or null for anything else. */
export function publishedVersion(text: unknown): string | null {
  if (typeof text !== 'string' || text.length > MAX_TEXT) return null
  try {
    const manifest: unknown = JSON.parse(text)
    return isRecord(manifest) && isVersion(manifest.version) ? manifest.version : null
  } catch {
    return null
  }
}

const asCheck = (value: unknown): Check | undefined =>
  isRecord(value) && typeof value.at === 'number' && Number.isFinite(value.at) && (value.latest === null || isVersion(value.latest))
    ? { at: value.at, latest: value.latest }
    : undefined

const stamp = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

const asSeen = (value: unknown): Seen =>
  isRecord(value)
    ? { noticed: stamp(value.noticed), noticedAt: stamp(value.noticedAt), toasted: stamp(value.toasted), toastedAt: stamp(value.toastedAt) }
    : {}

const later = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b)

/** Two records of what a session was told, as one: the later of each. */
const merged = (a: Seen, b: Seen): Seen => ({
  noticed: later(a.noticed, b.noticed),
  noticedAt: later(a.noticedAt, b.noticedAt),
  toasted: later(a.toasted, b.toasted),
  toastedAt: later(a.toastedAt, b.toastedAt),
})

/** Whether 30 minutes have passed since `at` (a clock that went back counts as passed). */
const hasWindowPassed = (at: number | undefined, now: number): boolean => at === undefined || now < at || now - at >= WINDOW_MS

/** Whether CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set, to any value at all; a failed read counts as set. */
async function trafficOff($: EngineInterface): Promise<boolean> {
  try {
    const value = await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')
    return value !== undefined && value !== ''
  } catch {
    return true
  }
}

/** The published version, or null on any failure: a plain GET of `url`, given TIMEOUT_MS. */
async function fetchLatest($: EngineInterface, url: string): Promise<string | null> {
  let timer: Timer | undefined
  const timeout = new Promise<undefined>(resolve => {
    timer = $.clock.after(TIMEOUT_MS, () => resolve(undefined))
  })
  try {
    const request = $.http.fetch(url)
    request.catch(() => undefined)
    const response = await Promise.race([request, timeout])
    return response !== undefined && response.status === 200 ? publishedVersion(response.text) : null
  } catch {
    return null
  } finally {
    timer?.cancel()
  }
}

async function readInstalled($: EngineInterface, name: PluginName): Promise<Installed | null> {
  try {
    const root = $.plugin.root.replace(/[\\/]+$/, '')
    const manifest: unknown = JSON.parse(await $.fs.read(`${root}/.claude-plugin/plugin.json`))
    if (!isRecord(manifest) || manifest.name !== name || !isVersion(manifest.version)) return null
    const url = manifestUrl(manifest.repository, name)
    return url === undefined ? null : { version: manifest.version, url }
  } catch {
    return null
  }
}

async function sessionId($: EngineInterface): Promise<string | null> {
  try {
    const id = await $.session.id()
    return SESSION.test(id) ? id : null
  } catch {
    return null
  }
}

/** The newer version the current check found and this session wasn't yet told of as `kind`. */
function pending(kind: 'noticed' | 'toasted'): string | undefined {
  if (!installed || !check || check.latest === null || seen[kind] === check.at) return undefined
  return compareVersions(check.latest, installed.version) > 0 ? check.latest : undefined
}

/**
 * Writes what this session was told, read back and merged with what stands just before the write, so
 * a session writing meanwhile keeps its entry (the store has no compare-and-set: two writes at the
 * same moment can still lose one, which costs at most one notice more). Drops the entries that can no
 * longer hold a notice back: told of a check older than ours, and longer than 30 minutes ago.
 */
async function saveSeen($: EngineInterface, now: number): Promise<void> {
  if (!session || !check) return
  const stored = await $.store.get(SEEN_KEY)
  const entries = isRecord(stored) ? stored : {}
  const kept: Record<string, Seen> = {}
  let count = 0
  for (const [id, value] of Object.entries(entries)) {
    if (id === session || !SESSION.test(id) || count >= MAX_SESSIONS - 1) continue
    const other = asSeen(value)
    const toldOfOurs = (later(other.noticed, other.toasted) ?? -Infinity) >= check.at
    const toldLately = !hasWindowPassed(later(other.noticedAt, other.toastedAt) ?? -Infinity, now)
    if (!toldOfOurs && !toldLately) continue
    kept[id] = other
    count += 1
  }
  seen = merged(seen, asSeen(entries[session]))
  kept[session] = seen
  await $.store.set(SEEN_KEY, kept)
}

/**
 * Loads what is known; notes when a call told the session; with `mayFetch` (a call), checks when due and toasts a
 * newer version when the window allows; and works out whether a call may tell the session. Never throws.
 */
async function sync($: EngineInterface, mayFetch: boolean): Promise<void> {
  try {
    if (plugin === undefined || (await trafficOff($))) return
    if (installed === undefined) installed = await readInstalled($, plugin)
    if (installed === null) return
    if (session === undefined || isSessionStale) {
      const id = await sessionId($)
      if (session !== undefined && id !== session) {
        seen = {}
        isNoticeUnstamped = false
      }
      session = id
      isSessionStale = false
    }
    const now = await $.clock.now()
    let isChanged = false
    if (isNoticeUnstamped) {
      seen = { ...seen, noticedAt: now }
      isNoticeUnstamped = false
      isChanged = true
    }
    const [storedCheck, storedSeen] = await Promise.all([$.store.get(CHECK_KEY), $.store.get(SEEN_KEY)])
    const known = asCheck(storedCheck)
    if (known !== undefined && (check === undefined || known.at >= check.at)) check = known
    if (session && isRecord(storedSeen)) seen = merged(seen, asSeen(storedSeen[session]))
    if (mayFetch && (check === undefined || hasWindowPassed(check.at, now))) {
      check = { at: now, latest: await fetchLatest($, installed.url) }
      await $.store.set(CHECK_KEY, check)
    }
    // A toast only for a call: never at the session's start, where every plugin would toast at once.
    const latest = mayFetch ? pending('toasted') : undefined
    const text = latest === undefined || !hasWindowPassed(seen.toastedAt, now) ? undefined : toastText(plugin, installed.version, latest)
    if (text !== undefined && check !== undefined) {
      seen = { ...seen, toasted: check.at, toastedAt: now }
      $.ui.toast(text)
      isChanged = true
    }
    mayNotice = hasWindowPassed(seen.noticedAt, now)
    if (isChanged) await saveSeen($, now)
  } catch {
    // Silence: the check is a courtesy, never the tool's business.
  }
}

/** Queues `work` behind the background work before it. */
function schedule(work: () => Promise<void>): void {
  chain = chain.then(work).catch(() => undefined)
}

/** At register: which plugin this is, and whether its `updateCheck` setting is on. */
export function configureUpdateCheck(name: PluginName, options: PluginOptions): void {
  plugin = name
  enabled = options.updateCheck !== 'off' && isPlugin(name)
  installed = undefined
  session = undefined
  isSessionStale = true
  check = undefined
  seen = {}
  mayNotice = false
  isNoticeUnstamped = false
}

/**
 * At session.start: loads what this machine already knows, with no request, and reads the session's
 * id again, since a session.start in the same load can be a new session. Never waits, never throws.
 */
export function loadUpdateCheck($: EngineInterface): void {
  if (!enabled) return
  isSessionStale = true
  mayNotice = false
  schedule(() => sync($, false))
}

/**
 * Around a call of one of the plugin's tools, once the tool has answered: starts a check when one is
 * due, and returns the answer with the notice when one is due. Never waits, never throws.
 */
export function withUpdateNotice<R extends Answer>($: EngineInterface, e: { agentId?: string }, done: R): R {
  if (!enabled || plugin === undefined || e.agentId !== undefined) return done
  schedule(() => sync($, true))
  try {
    if (!mayNotice || typeof done.result !== 'string' || done.deny !== undefined || done.ref !== undefined) return done
    const latest = pending('noticed')
    const line = latest === undefined || !installed ? undefined : notice(plugin, installed.version, latest)
    if (line === undefined || !check) return done
    seen = { ...seen, noticed: check.at }
    mayNotice = false
    isNoticeUnstamped = true
    return { ...done, result: `${done.result}\n\n${line}` }
  } catch {
    return done
  }
}
