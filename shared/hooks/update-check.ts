// The update check: tells the session, and the person, when this plugin is out of date.
//
// Canonical copy: shared/hooks/update-check.ts. Each plugin carries an identical copy at
// plugins/<name>/hooks/update-check.ts, since each installs on its own; `node scripts/sync-shared.mjs`
// writes them, and `node --test scripts` fails when one differs. Edit the canonical copy only.
//
// When one of the plugin's tools is called by the main session, and the last check is 30 minutes old
// or there is none, the plugin fetches its own plugin.json from the default branch of the repository
// its installed plugin.json names (a plain GET of a public file: no headers, no query, nothing about
// the session or the machine) and compares the `version` there with the installed one. The check's
// time and answer are kept in the plugin's own $.store, so a reload or another session on this machine
// within the 30 minutes uses that answer instead of fetching again.
//
// Off the tool path: everything that reads (the env, the manifest, the store) or fetches runs in a
// chain of its own that the tool call never waits on. The call's answer gets the notice only from what
// that chain already knows (the store, loaded at the session's start, or an earlier check), so the
// call that starts a check never waits for its answer; and a failure anywhere in the chain is silence:
// offline, refused by policy, a 404, a rate limit, a timeout, bad JSON.
//
// The notice is fixed text: its only values are the plugin's name, from the fixed list below, and the
// two versions, each of which must be three whole numbers (VERSION) or there is no notice. Nothing
// else from the fetched file reaches the session. It tells the session what the person can run; it
// never asks the session to run anything. A session gets it at most once per check, and a check runs
// at most once per 30 minutes, so at most once per 30 minutes per session; a toast tells the person
// the same, as often.
//
// Off with the plugin's `updateCheck` setting set to `off`, or while CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
// is set. Subagents' calls check nothing.
import type { EngineInterface, PluginOptions, Timer } from 'claude-code'

/** The plugins of this marketplace: the only names a notice carries. */
export const PLUGINS = ['self-compact', 'self-context', 'self-mcp', 'self-reload', 'self-remote-control', 'self-wake'] as const
export type PluginName = (typeof PLUGINS)[number]

const MARKETPLACE = 'claude-code-self-tools'

/** How long a check's answer stands before the next tool call checks again. */
export const WINDOW_MS = 30 * 60 * 1000
/** How long the request may take; past it, the check has no answer. */
export const TIMEOUT_MS = 5000
/** The most of a response read as a manifest; a longer one is no answer. */
const MAX_TEXT = 64 * 1024

/** $.store keys: the last check, and what each session was told of it. */
const CHECK_KEY = 'updateCheck'
const SEEN_KEY = 'updateSeen'

/** A version as the manifests write it: three whole numbers and two dots, nothing around them. */
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/

/** A session id fit to key the store with (a UUID is); never `__proto__` and the like. */
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** The last check: when (`$.clock.now()` milliseconds), and the published version, null when there was no usable answer. */
type Check = { at: number; latest: string | null }

/** Which check this session was told of, by its `at`: in the tool's answer, and in a toast. */
type Seen = { noticed?: number; toasted?: number }

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
let check: Check | undefined
let seen: Seen = {}
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
  return `${name} ${version} is out of date (${latest} is published). To update, the person runs: claude plugin marketplace update ${MARKETPLACE}, then claude plugin update ${name}@${MARKETPLACE} (once for each scope it is installed at, adding --scope project or --scope local for those), then /reload-plugins. Don't run these yourself unless the person asks.`
}

/** The toast, for the person; undefined unless every value is what it must be. */
export function toastText(name: string, version: string, latest: string): string | undefined {
  if (!isPlugin(name) || !isVersion(version) || !isVersion(latest)) return undefined
  return `${name} ${version} is out of date (${latest} is published). To update: claude plugin marketplace update ${MARKETPLACE}, then claude plugin update ${name}@${MARKETPLACE}, then /reload-plugins.`
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

const asSeen = (value: unknown): Seen => (isRecord(value) ? { noticed: stamp(value.noticed), toasted: stamp(value.toasted) } : {})

const later = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b)

/** Whether CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set; a failed read counts as set. */
async function trafficOff($: EngineInterface): Promise<boolean> {
  try {
    const value = (await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'))?.trim().toLowerCase()
    return value !== undefined && value !== '' && value !== '0' && value !== 'false' && value !== 'no' && value !== 'off'
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
function pending(kind: keyof Seen): string | undefined {
  if (!installed || !check || check.latest === null || seen[kind] === check.at) return undefined
  return compareVersions(check.latest, installed.version) > 0 ? check.latest : undefined
}

/** Keeps what this session was told; drops what other sessions were told of checks older than ours. */
async function saveSeen($: EngineInterface): Promise<void> {
  if (!session || !check) return
  const stored = await $.store.get(SEEN_KEY)
  const kept: Record<string, Seen> = {}
  let count = 0
  for (const [id, value] of Object.entries(isRecord(stored) ? stored : {})) {
    const other = asSeen(value)
    if (id === session || !SESSION.test(id) || count >= 100) continue
    if ((later(other.noticed, other.toasted) ?? -Infinity) < check.at) continue
    kept[id] = other
    count += 1
  }
  kept[session] = seen
  await $.store.set(SEEN_KEY, kept)
}

/** Loads what is known; with `mayFetch`, checks when due and toasts a newer version. Never throws. */
async function sync($: EngineInterface, mayFetch: boolean): Promise<void> {
  try {
    if (plugin === undefined || (await trafficOff($))) return
    if (installed === undefined) installed = await readInstalled($, plugin)
    if (installed === null) return
    if (session === undefined) session = await sessionId($)
    const [storedCheck, storedSeen] = await Promise.all([$.store.get(CHECK_KEY), $.store.get(SEEN_KEY)])
    const known = asCheck(storedCheck)
    if (known !== undefined && (check === undefined || known.at >= check.at)) check = known
    const mine = session && isRecord(storedSeen) ? asSeen(storedSeen[session]) : {}
    seen = { noticed: later(seen.noticed, mine.noticed), toasted: later(seen.toasted, mine.toasted) }
    if (!mayFetch) return
    const now = await $.clock.now()
    if (check === undefined || now < check.at || now - check.at >= WINDOW_MS) {
      check = { at: now, latest: await fetchLatest($, installed.url) }
      await $.store.set(CHECK_KEY, check)
    }
    const latest = pending('toasted')
    const text = latest === undefined ? undefined : toastText(plugin, installed.version, latest)
    if (text === undefined) return
    seen = { ...seen, toasted: check.at }
    $.ui.toast(text)
    await saveSeen($)
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
  check = undefined
  seen = {}
}

/** At session.start: loads what this machine already knows, with no request. Never waits, never throws. */
export function loadUpdateCheck($: EngineInterface): void {
  if (enabled) schedule(() => sync($, false))
}

/**
 * Around a call of one of the plugin's tools, once the tool has answered: starts a check when one is
 * due, and returns the answer with the notice when one is due. Never waits, never throws.
 */
export function withUpdateNotice<R extends Answer>($: EngineInterface, e: { agentId?: string }, done: R): R {
  if (!enabled || plugin === undefined || e.agentId !== undefined) return done
  schedule(() => sync($, true))
  try {
    if (typeof done.result !== 'string' || done.deny !== undefined || done.ref !== undefined) return done
    const latest = pending('noticed')
    const line = latest === undefined || !installed ? undefined : notice(plugin, installed.version, latest)
    if (line === undefined || !check) return done
    seen = { ...seen, noticed: check.at }
    schedule(() => saveSeen($))
    return { ...done, result: `${done.result}\n\n${line}` }
  } catch {
    return done
  }
}
