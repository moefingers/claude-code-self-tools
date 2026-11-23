// self-update, the pure side: the settings read, when a look is due, what to run for which install records, what an
// install changed, what a failure counts for, the files the machine keeps, and when a session reloads for an install.
// No $ and no I/O: tests/update-logic.test.ts tests it directly; update.ts and reload.ts do the reading and the running.
//
// The `autoUpdate` setting names plugin marketplaces to keep current on this machine; empty (the default) is off. On,
// one session per machine at a time refreshes each named marketplace that has a plugin installed here and updates every
// plugin already installed from it, in every scope it is installed in, with Claude Code's own `claude plugin` commands.
// The commands' words are fixed (scripts.ts, UPDATE_SCRIPT); the only parts that vary are a marketplace's name, a
// plugin's name and a scope, each checked to a strict shape here and again in the script. A command whose time runs out
// is ended by the script, with every process it started (Windows' own taskkill, the one other program this runs), and
// looks that can't reach a named marketplace, in a row, stretch the wait to the next (lookEveryMs); a plugin's own update
// failing never does.
//
// Never: a marketplace added, a plugin installed that has no install record, a marketplace the setting doesn't name, a
// version asked for (so never an older one), or `--force`. Only names, scopes, folders and versions are read of Claude
// Code's install records, and of a command only its exit code and its last line.
import type { ReloadRecord } from '../types'
import { ENDED, EXIT_SAID, INSIDE, KIND_VAR, NAME_SHAPE, NAME_VAR, NO_CLAUDE, REFUSED, SCOPE_VAR, STEP_MS, stateFolder } from './scripts'

/** A marketplace's or a plugin's name as it is written (scripts.ts, NAME_SHAPE), whole. */
export const NAME = new RegExp(`^${NAME_SHAPE}$`)
/** The marketplaces the setting may name, at most. */
export const NAMES_MAX = 16
/** The machine looks this often at most while its looks reach every marketplace, however many sessions run. */
export const LOOK_EVERY_MS = 5 * 60_000
/** ...and this often at least, however many looks in a row couldn't reach one (lookEveryMs). */
export const LOOK_EVERY_MAX_MS = 60 * 60_000
/** Looks that failed in a row before one toast says so. */
export const FAILS_TOLD = 3

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

// ---------------------------------------------------------------------------------------------
// Text as a line shows it.

/** Line and paragraph breaks of every kind, and tabs: each run becomes one space. */
const BREAKS = /[\t\n\u000b\u000c\r\u0085\u2028\u2029]+/g
/** What a reader can't see: control, format, private-use and unassigned code points, and the default-ignorable ones. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}]/gu

/** `text` as one line: breaks and tabs a space, what a reader can't see dropped, runs of spaces one, trimmed, at most `max` characters (an ellipsis last). */
export function oneLine(text: string, max: number): string {
  const line = text.replace(BREAKS, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()
  if (line.length <= max) return line
  let kept = line.slice(0, max - 1)
  if (/[\ud800-\udbff]$/.test(kept)) kept = kept.slice(0, -1)
  return `${kept}\u2026`
}

/** What a masked value reads as. */
export const SECRET = '‹secret›'

/** The words that make a name a secret's (password, GITHUB_TOKEN, client_secret, Set-Cookie, sessionId, X-Auth). */
const SECRET_WORDS: ReadonlySet<string> = new Set(['token', 'tokens', 'secret', 'secrets', 'password', 'passwords', 'passwd', 'passphrase', 'pass', 'pwd', 'apikey', 'credential', 'credentials', 'cookie', 'auth', 'authorization', 'session', 'sig', 'signature'])
/** The words that make a name a secret's when `key` follows them (api_key, X-Api-Key, accessKey, private-key). */
const KEY_WORDS: ReadonlySet<string> = new Set(['api', 'access', 'private', 'secret', 'client', 'signing', 'account', 'master'])

/** A name's words: split at `_`, `-` and `.`, and where a small letter or a digit meets a capital (apiKey), each in small letters. */
const wordsOf = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter(word => word !== '')
    .map(word => word.toLowerCase())

/** Whether a name says its value is a secret: one of its words is a secret's, or it is `key` after one of KEY_WORDS, or the whole name is `key`. */
export function secretName(name: string): boolean {
  const words = wordsOf(name)
  return words.some((word, i) => SECRET_WORDS.has(word) || (word === 'key' && (words.length === 1 || KEY_WORDS.has(words[i - 1] ?? ''))))
}

/** A name and what joins it to its value: `name=`, `name:`, `"name":`, `'name':`. Only the name is matched, so a value is still read for names of its own (`https://host/x?access_token=…`). */
const NAME_HEAD = /(["']?)\b([A-Za-z][A-Za-z0-9_.-]{0,63})\1(\s*[:=]\s*)/g
/** The value after a secret's name: a header's scheme kept apart (`Authorization: token …`), then a quoted value, or one up to a space or a separator. */
const NAMED_VALUE = /^((?:Bearer|Basic|Token|Digest|Negotiate|Bot)\s+)?("[^"]*"|'[^']*'|[^\s,;&"'<>()[\]{}]+)/i

/** `text` with each value a secret's name gives masked whole (secretName), its quotes and a header's scheme kept. */
function maskNamed(text: string): string {
  let out = ''
  let last = 0
  const heads = new RegExp(NAME_HEAD.source, 'g')
  for (let head = heads.exec(text); head !== null; head = heads.exec(text)) {
    if (!secretName(head[2] ?? '')) continue
    const from = head.index + head[0].length
    const found = NAMED_VALUE.exec(text.slice(from))
    if (found === null) continue
    const [whole, scheme = '', value = ''] = found
    const bare = value.replace(/^["']|["']$/g, '')
    const wrapped = bare === SECRET ? value : value.startsWith('"') ? `"${SECRET}"` : value.startsWith("'") ? `'${SECRET}'` : SECRET
    out += `${text.slice(last, from)}${scheme}${wrapped}`
    last = from + whole.length
    heads.lastIndex = last
  }
  return out + text.slice(last)
}

/** Whether a run of base64's characters reads as random: 32 or more, with capitals, small letters and digits. */
const base64Random = (run: string): boolean => /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run)
/** Whether a run of a token's characters reads as random: a piece of 16 or more (between `-` and `_`) that mixes letters and digits. A name made of words and numbers (`claude-code-self-tools-2026`) is not one. */
const tokenRandom = (run: string): boolean => run.split(/[-_]/).some(piece => piece.length >= 16 && /[A-Za-z]/.test(piece) && /[0-9]/.test(piece))

/**
 * A command's line with the secrets of the shapes a failing `claude plugin` command can print masked, before it is
 * kept, logged or shown, each value whole, never a piece:
 * - a URL's user and password, up to the last `@` before its host (`https://user:p@ss@host`);
 * - the word after Bearer or Basic, and a cookie header's whole value;
 * - a value given by a name that says secret (secretName), however it is given: `name=value`, `name: value`, a quoted
 *   name and value, a header with its scheme (`Authorization: token …`, `PRIVATE-TOKEN: …`, `X-Api-Key: …`), of any
 *   length;
 * - the tokens of the shapes their issuers give them, 8 characters on from their prefix: GitHub's (ghp_, gho_, ghu_,
 *   ghs_, ghr_, github_pat_), GitLab's (glpat-), Slack's (xox?-), Anthropic's and OpenAI's (sk-), AWS key ids (AKIA,
 *   ASIA), Google API keys (AIza), and JSON web tokens (eyJ…);
 * - a run that reads as random: 20 or more letters and digits mixing capitals, small letters and digits; 32 or more of
 *   base64's (`+` and `/` among them) of the same mix; or 32 or more of a token's (`-` and `_`) with a random piece.
 * Masking again changes nothing. Prose next to a secret's name loses its next word (`invalid token: ‹secret›`): a
 * name's value is masked whatever it reads as. Paths, versions and names made of words are left as they are.
 */
export function masked(text: string): string {
  const named = maskNamed(
    text
      .replace(/(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#]*@/g, (_, scheme: string) => `${scheme}${SECRET}@`)
      .replace(/\b(Bearer|Basic)\s+(?!‹secret›)[^\s"',;]+/gi, (_, word: string) => `${word} ${SECRET}`)
      .replace(/\b((?:Set-)?Cookie\s*:\s*)(?!‹secret›)[^"'\r\n]+/gi, (_, head: string) => `${head}${SECRET}`),
  )
  return named
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|xox[abposr]-[A-Za-z0-9-]{8,}|sk-[A-Za-z0-9_-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{12,}|AIza[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?)/g, SECRET)
    .replace(/[A-Za-z0-9+/]{32,}={0,2}/g, run => (base64Random(run) ? SECRET : run))
    .replace(/[A-Za-z0-9_-]{32,}/g, run => (tokenRandom(run) ? SECRET : run))
    .replace(/\b[A-Za-z0-9]{20,}\b/g, run => (base64Random(run) ? SECRET : run))
}

/** A command's line as it is kept and shown: masked first (masked), then one line of `max` characters at most, so no cut ever splits a secret the rules would have caught. */
export const maskedLine = (text: string, max: number): string => oneLine(masked(oneLine(text, 4_000)), max)

/** Text from outside quoted as data, on one line: «…», each «, » and backslash inside escaped with a backslash. */
export const quotedData = (text: string): string => `«${oneLine(text, 400).replace(/[\\«»]/g, c => `\\${c}`)}»`

// ---------------------------------------------------------------------------------------------
// The settings.

/** The `autoUpdate` setting, read: the marketplaces it names (none: off), and why it is off when its value can't be taken. */
export type AutoUpdate = { names: readonly string[]; why?: string }

/**
 * The `autoUpdate` setting: marketplace names, comma-separated. Unset or empty is off, and says nothing. A value with any
 * entry that is not a name's shape turns the whole feature off (`why`): never the entries that happen to fit.
 */
export function autoUpdateOf(raw: unknown): AutoUpdate {
  if (raw === undefined || raw === null) return { names: [] }
  if (typeof raw !== 'string') return { names: [], why: 'its value is not text' }
  if (raw.trim() === '') return { names: [] }
  const parts = raw
    .split(',')
    .map(p => p.trim())
    .filter(p => p !== '')
  if (parts.length === 0) return { names: [], why: 'it names no marketplace' }
  const bad = parts.find(p => !NAME.test(p))
  if (bad !== undefined) return { names: [], why: `"${oneLine(bad, 40)}" is not a marketplace's name (letters, digits, dots, dashes and underscores, a letter or a digit first, 64 at most)` }
  const names = [...new Set(parts)]
  if (names.length > NAMES_MAX) return { names: [], why: `it names more than ${NAMES_MAX} marketplaces` }
  return { names }
}

/** The `reloadAfterUpdate` setting: on unless it says `off`. */
export const reloadAfterUpdateOf = (raw: unknown): boolean => !(typeof raw === 'string' && raw.trim().toLowerCase() === 'off')

// ---------------------------------------------------------------------------------------------
// When a look is due.

/**
 * How long the machine waits between looks after `unreached` looks in a row couldn't reach a named marketplace (its
 * refresh failed, ran past its time or couldn't be started): 5 minutes while every refresh passes, doubled for each such
 * look (10, 20, 40), an hour at most, until one reaches them all. A machine whose marketplace can't be reached (a lapsed
 * login, no network) then tries 24 times a day, not 288. A plugin's own update failing never stretches it: one record
 * that can never update (a retired plugin's, a half-deleted worktree's) must not slow every marketplace's updates.
 */
export function lookEveryMs(unreached: number): number {
  const n = Number.isFinite(unreached) ? Math.min(8, Math.max(0, Math.floor(unreached))) : 0
  return Math.min(LOOK_EVERY_MAX_MS, LOOK_EVERY_MS * 2 ** n)
}

/**
 * Whether this process's own floor between looks (`nextAt`) still holds at `now`: before it, and not further ahead than
 * the longest wait (a clock set back would otherwise hold this process's looks for as long as it moved).
 */
export const floorHolds = (nextAt: number, now: number): boolean => now < nextAt && nextAt - now <= LOOK_EVERY_MAX_MS

/**
 * Whether a look is due: none yet, the last one a whole interval ago (lookEveryMs, by the looks in a row that couldn't
 * reach a marketplace), or one stamped further ahead than that (a clock that moved; never believed).
 */
export function lookDue(last: number | undefined, now: number, unreached = 0): boolean {
  const every = lookEveryMs(unreached)
  return last === undefined || now - last >= every || last - now > every
}

// ---------------------------------------------------------------------------------------------
// Where the machine keeps things.

/** Claude Code's install records, in its plugins folder. */
export const INSTALLED_FILE = 'installed_plugins.json'

/** A path as compared: each separator `/`, none trailing, and on Windows (`windows`) in one case. */
export function pathKey(path: string, windows: boolean): string {
  const key = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return windows ? key.toLowerCase() : key
}

/**
 * A folder as the environment names it, its trailing separators dropped, when it can be placed for sure: an absolute
 * local path (on Windows, `windows`, one with a drive). Undefined for spaces around it, a relative path (`~/x` among
 * them), a network or device path, or a NUL.
 */
function placedFolder(folder: string, windows: boolean): string | undefined {
  if (folder === '' || folder !== folder.trim() || !/^[A-Za-z]:[\\/]|^[\\/]/.test(folder) || /^[\\/]{2}/.test(folder) || /^[\\/]\?\?[\\/]/.test(folder) || folder.includes('\0')) return undefined
  if (windows && !/^[A-Za-z]:[\\/]/.test(folder)) return undefined
  return folder.replace(/[\\/]+$/, '')
}

/** Claude Code's config folder: CLAUDE_CONFIG_DIR when it is set, else <home>/.claude. Undefined when it can't be placed for sure. */
export function configFolderOf(home: string | undefined, configDir: string | undefined, windows: boolean): string | undefined {
  const custom = typeof configDir === 'string' && configDir.trim() !== ''
  const placed = placedFolder(custom ? configDir : (home ?? ''), windows)
  return placed === undefined ? undefined : custom ? placed : `${placed}/.claude`
}

/**
 * Claude Code's plugins folder, as it places it: CLAUDE_CODE_PLUGIN_CACHE_DIR when that is set, else `plugins` in its
 * config folder (`cowork_plugins` with CLAUDE_CODE_USE_COWORK_PLUGINS set). Undefined when it can't be placed for sure.
 */
export function pluginsFolderOf(config: string | undefined, cacheDir: string | undefined, cowork: string | undefined, windows: boolean): string | undefined {
  if (cacheDir !== undefined && cacheDir !== '') return placedFolder(cacheDir, windows)
  if (config === undefined) return undefined
  return `${config}/${cowork !== undefined && cowork !== '' ? 'cowork_plugins' : 'plugins'}`
}

/**
 * A plugins folder as eight hex characters (FNV-1a over its compared form): one lock and one state file per plugins
 * folder, since each has its own install records. Another plugin that keeps plugins current keys its lock the same way,
 * so the two take one lock for one plugins folder.
 */
export function folderKey(plugins: string): string {
  const key = pathKey(plugins, true)
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** The lock: <LOCALAPPDATA>\claude-self-tools\auto-update\<key>.lock, the one another plugin that keeps plugins current takes too. */
export const updateLockPath = (localAppData: string, plugins: string): string => `${stateFolder(localAppData)}\\auto-update\\${folderKey(plugins)}.lock`

/** self-update's own state, beside the lock: never the other plugin's file, which it neither reads nor writes. */
export const updateStatePath = (localAppData: string, plugins: string): string => `${stateFolder(localAppData)}\\auto-update\\${folderKey(plugins)}.self-update.json`

/** What the lock file holds while self-update holds it. */
export const lockText = (at: number): string => JSON.stringify({ v: 1, by: 'self-update', at })

/** What TAKE printed, read: taken, or held (by whom, as the lock says, and how long ago it was taken); undefined for anything else. */
export function readTakeReply(stdout: string): 'taken' | { held: { by: string; ageMs: number } } | undefined {
  const line = stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? ''
  if (line === 'taken') return line
  const held = /^held\|([A-Za-z0-9._:-]{1,64})\|(-?\d{1,16})$/.exec(line)
  return held ? { held: { by: held[1] ?? 'unknown', ageMs: Number(held[2]) } } : undefined
}

/** What RELEASE printed, read: released, kept, gone or busy; undefined for anything else. */
export function readReleaseReply(stdout: string): 'released' | 'kept' | 'gone' | 'busy' | undefined {
  const line = stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? ''
  return line === 'released' || line === 'kept' || line === 'gone' || line === 'busy' ? line : undefined
}

// ---------------------------------------------------------------------------------------------
// What a look runs.

/** One install record, as much of it as is read: the plugin, its marketplace, its scope, its folder, its project's folder (a project's or a local one), its version. */
export type Install = { plugin: string; marketplace: string; scope: string; installPath: string; projectPath?: string; version?: string }

/**
 * Every install record in installed_plugins.json's text (`{ version: 2, plugins: { "<plugin>@<marketplace>": [records]
 * } }`), each with a scope and a folder. Undefined when the text isn't that file's shape, so nothing can be told (and
 * nothing is run).
 */
export function installsOf(text: string): Install[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !isRecord(parsed.plugins)) return undefined
  const out: Install[] = []
  for (const [key, list] of Object.entries(parsed.plugins)) {
    const at = key.lastIndexOf('@')
    if (at <= 0 || !Array.isArray(list)) continue
    for (const r of list) {
      if (!isRecord(r) || typeof r.scope !== 'string' || typeof r.installPath !== 'string' || r.installPath === '') continue
      out.push({
        plugin: key.slice(0, at),
        marketplace: key.slice(at + 1),
        scope: r.scope,
        installPath: r.installPath,
        ...(typeof r.projectPath === 'string' && r.projectPath !== '' ? { projectPath: r.projectPath } : {}),
        ...(typeof r.version === 'string' ? { version: r.version } : {}),
      })
    }
  }
  return out
}

/** One command of a look: a marketplace refreshed, or one installed plugin updated in one scope (`folder`: the project a local or a project scope is run from; the user's scope runs from the home folder). */
export type Step = { kind: 'marketplace'; marketplace: string } | { kind: 'plugin'; plugin: string; marketplace: string; scope: 'user' | 'local' | 'project'; folder?: string }

/**
 * A project's folder a step may run from: one on a drive (C:\... or C:/...). Never a network share, a device path or
 * one with no drive: nothing here reaches out to another machine for a folder.
 */
export const PROJECT_FOLDER = /^[A-Za-z]:[\\/]/

/** One record as told apart from the next: its plugin, marketplace, scope and project. */
const recordKey = (i: Install, windows: boolean): string => `${i.plugin}@${i.marketplace}|${i.scope}|${i.projectPath === undefined ? '' : pathKey(i.projectPath, windows)}`

/**
 * What a look runs, in order: for each named marketplace that has a record to update, its refresh, then one update per
 * record installed from it. A named marketplace with no such record gets nothing (not even a refresh: nothing here says
 * Claude Code knows it), and a record of any other marketplace is never read further. A record is left out when its
 * plugin's name is not a name's shape, when its scope is not the user's, a project's or a local one (a managed install
 * is its administrator's), or when a project's or a local one names no folder on a drive (PROJECT_FOLDER).
 */
export function updatePlan(names: readonly string[], installs: readonly Install[], windows: boolean): Step[] {
  const steps: Step[] = []
  for (const marketplace of new Set(names)) {
    if (!NAME.test(marketplace)) continue
    const seen = new Set<string>()
    const plugins: Step[] = []
    for (const i of installs) {
      if (i.marketplace !== marketplace || !NAME.test(i.plugin)) continue
      const key = recordKey(i, windows)
      if (seen.has(key)) continue
      if (i.scope === 'user') plugins.push({ kind: 'plugin', plugin: i.plugin, marketplace, scope: 'user' })
      else if ((i.scope === 'local' || i.scope === 'project') && i.projectPath !== undefined && PROJECT_FOLDER.test(i.projectPath) && !i.projectPath.includes('\0')) plugins.push({ kind: 'plugin', plugin: i.plugin, marketplace, scope: i.scope, folder: i.projectPath })
      else continue
      seen.add(key)
    }
    if (plugins.length > 0) steps.push({ kind: 'marketplace', marketplace }, ...plugins)
  }
  return steps
}

/** The named marketplaces a plan runs nothing for: none of their plugins is installed here in a scope that is updated (a misspelt name among them). */
export const namesIdle = (names: readonly string[], plan: readonly Step[]): string[] => [...new Set(names)].filter(name => !plan.some(step => step.marketplace === name))

/** A step's words after `claude`, as UPDATE_SCRIPT builds them from its three inputs. */
export const stepWords = (step: Step): string[] => (step.kind === 'marketplace' ? ['plugin', 'marketplace', 'update', step.marketplace] : ['plugin', 'update', `${step.plugin}@${step.marketplace}`, '--scope', step.scope])

/** A step as a person would type it. */
export const stepSaid = (step: Step): string => `claude ${stepWords(step).join(' ')}`

/** UPDATE_SCRIPT's inputs for a step: the kind, the name, and the scope (empty for a refresh). */
export const stepEnv = (step: Step): Record<string, string> => ({
  [KIND_VAR]: step.kind,
  [NAME_VAR]: step.kind === 'marketplace' ? step.marketplace : `${step.plugin}@${step.marketplace}`,
  [SCOPE_VAR]: step.kind === 'marketplace' ? '' : step.scope,
})

// ---------------------------------------------------------------------------------------------
// What a command's run says.

const EXIT_LINE = new RegExp(`^${EXIT_SAID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-?\\d{1,10})$`)
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g')

/** A command's line as read, before it is masked: never cut short enough to split a secret that is then shown (maskedLine masks it whole, then cuts it to 200). */
export const LINE_READ_MAX = 4_000

/** The last line of a command's output that says something, colour codes dropped, one line of LINE_READ_MAX characters at most, unmasked; '' for none. */
function lastLine(lines: readonly string[]): string {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = oneLine((lines[i] ?? '').replace(ANSI, ''), LINE_READ_MAX)
    if (line !== '') return line
  }
  return ''
}

/**
 * What UPDATE_SCRIPT's run says: the command ran (its exit code, and the last line it printed: on standard output, else
 * on standard error, and the other way round for one that failed), its time ran out (`ended`), no claude was found, the
 * only one found sits inside the folder it would run from (`inside`), the script refused its inputs, or (`broken`) it
 * ended without its last line. Nothing else of the output is read. The line is not masked yet: whoever keeps or shows
 * it masks it first (maskedLine).
 */
export function readStepReply(stdout: string, stderr: string, exitCode: number): { code: number; line: string } | 'ended' | 'no-claude' | 'inside' | 'refused' | { broken: string } {
  const out = stdout.split(/\r?\n/)
  while (out.length > 0 && (out.at(-1) ?? '').trim() === '') out.pop()
  const last = (out.at(-1) ?? '').trim()
  if (last === NO_CLAUDE) return 'no-claude'
  if (last === INSIDE) return 'inside'
  if (last === REFUSED) return 'refused'
  if (last === ENDED) return 'ended'
  const said = EXIT_LINE.exec(last)
  if (said === null) return { broken: `it exited ${exitCode} without saying what the command did` }
  const code = Number(said[1])
  const [said1, said2] = [lastLine(out.slice(0, -1)), lastLine(stderr.split(/\r?\n/))]
  // A command that failed says why on standard error, whatever progress it printed before.
  return { code, line: code === 0 ? said1 || said2 : said2 || said1 }
}

/** What a command whose time ran out is recorded as. */
export const ENDED_SAID = `its ${STEP_MS / 1000} s ran out, and whatever it had started was ended with it`
/** What a step is recorded as when the only claude found sits inside the folder it would run from. */
export const INSIDE_SAID = 'the only claude on PATH is inside the folder it would run from, so it was not run'

/** A step that failed, as the record and the toast say it: the command as typed, and its last line (else its exit code). */
export const failureSaid = (step: Step, reply: { code: number; line: string } | { broken: string }): string => `${stepSaid(step)}: ${'broken' in reply ? reply.broken : reply.line !== '' ? reply.line : `it exited ${reply.code}`}`

// ---------------------------------------------------------------------------------------------
// What a look installed.

/** One install a look made: the plugin, its marketplace, and the versions its record named before and after. */
export type Installed = { plugin: string; marketplace: string; from?: string; to?: string }

/**
 * What a look's commands installed: each record of a named marketplace that was there before (the same plugin,
 * marketplace, scope and project) and now names another version or another folder. A record that is new was never this
 * look's doing, and one of another marketplace is never read. One entry per plugin and pair of versions, however many
 * scopes moved.
 */
export function installsChanged(names: readonly string[], before: readonly Install[], after: readonly Install[], windows: boolean): Installed[] {
  const was = new Map(before.map(i => [recordKey(i, windows), i]))
  const seen = new Set<string>()
  const out: Installed[] = []
  for (const now of after) {
    if (!names.includes(now.marketplace) || !NAME.test(now.plugin) || !NAME.test(now.marketplace)) continue
    const old = was.get(recordKey(now, windows))
    if (old === undefined || (old.version === now.version && pathKey(old.installPath, windows) === pathKey(now.installPath, windows))) continue
    const key = `${now.plugin}@${now.marketplace}|${old.version ?? ''}|${now.version ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ plugin: now.plugin, marketplace: now.marketplace, ...(old.version === undefined ? {} : { from: old.version }), ...(now.version === undefined ? {} : { to: now.version }) })
  }
  return out
}

/** A version as a line shows it: the record's own text, one line of 40 characters at most. */
const versionSaid = (version: string | undefined): string => (version === undefined || oneLine(version, 40) === '' ? 'an unversioned copy' : oneLine(version, 40))

/**
 * The one line an install gets, in the transcript and as a toast. `reloads`: sessions reload themselves here
 * (`reloadAfterUpdate` on, as the session that looked reads it); off, the line says what loads it instead.
 */
export const installedLine = (i: Installed, reloads: boolean): string =>
  `self-update: updated ${i.plugin} ${versionSaid(i.from)} to ${versionSaid(i.to)} from ${i.marketplace}; ${reloads ? 'sessions reload at their next idle moment' : 'reloadAfterUpdate is off, so a session loads it at its next start or /reload-plugins'}`

// ---------------------------------------------------------------------------------------------
// What the machine keeps between looks.

/**
 * What self-update keeps between looks, in one file beside the lock: when the last look started or last ran a command
 * (`at`), how many looks failed in a row and the last failure (`fails`, `failed`), whether the toast for them was shown
 * (`told`), how many looks in a row couldn't reach a named marketplace (`unreached`, absent for none: the one count that
 * stretches the wait, lookEveryMs), and when a look last installed something (`installed`: a session whose plugins were
 * loaded before it reloads, reload.ts).
 */
export type UpdateState = { at: number; fails: number; failed?: string; told: boolean; unreached?: number; installed?: number }

const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** The state from its file's text, or undefined when it is not one (missing, half written): a look is then due, and decided under the lock. */
export function readUpdateState(text: string | undefined): UpdateState | undefined {
  if (text === undefined) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(raw) || raw.v !== 1 || !time(raw.at)) return undefined
  return {
    at: raw.at,
    fails: time(raw.fails) ? Math.floor(raw.fails) : 0,
    ...(typeof raw.failed === 'string' ? { failed: oneLine(raw.failed, 400) } : {}),
    told: raw.told === true,
    ...(time(raw.unreached) && raw.unreached >= 1 ? { unreached: Math.floor(raw.unreached) } : {}),
    ...(time(raw.installed) ? { installed: raw.installed } : {}),
  }
}

/** The state as its file holds it. */
export const updateStateText = (state: UpdateState): string => JSON.stringify({ v: 1, ...state })

/**
 * The counts after a look. `fails`: the looks in a row in which any command failed (`failure`: the look's first, as
 * failureSaid words it); a look with none starts it over. `unreached`: the looks in a row in which a named marketplace
 * couldn't be reached (`unreachedBy`: that refresh's failure), the one count that stretches the wait to the next look
 * (lookEveryMs); a look that reaches them all starts it over, whatever a plugin's own update did. `toast`: one line when
 * `unreached` gets to FAILS_TOLD (the looks come less often from here), else when `fails` does and none was shown for
 * this run of failures yet (the looks keep their pace).
 */
export function failuresNext(
  prev: Pick<UpdateState, 'fails' | 'told' | 'unreached'> | undefined,
  failure: string | undefined,
  unreachedBy?: string,
): { fails: number; told: boolean; unreached: number; failed?: string; toast?: string } {
  const first = failure ?? unreachedBy
  if (first === undefined) return { fails: 0, told: false, unreached: 0 }
  const unreached = unreachedBy === undefined ? 0 : (prev?.unreached ?? 0) + 1
  const fails = (prev?.fails ?? 0) + 1
  const told = prev?.told === true
  if (unreached === FAILS_TOLD) {
    return { fails, told: true, unreached, failed: first, toast: `self-update: couldn't reach a marketplace ${unreached} looks in a row; it goes on trying, less often (once an hour at the least), until a look reaches them all; the last: ${unreachedBy}` }
  }
  if (fails >= FAILS_TOLD && !told) return { fails, told: true, unreached, failed: first, toast: `self-update: failed ${fails} looks in a row; it goes on trying at every look; the last: ${first}` }
  return { fails, told, unreached, failed: first }
}

// ---------------------------------------------------------------------------------------------
// A session behind an install: its reload (reload.ts).
//
// A look that installed a newer version of a plugin leaves the time in the state file, and a session whose plugins
// were loaded before it is behind: one /reload-plugins loads what was installed. The session runs it at an idle turn
// end, under the holds below, at most once every 15 minutes, and at most twice for one install. A /reload-plugins that
// ran and reloaded, this plugin's or anyone's, brings the session's load time to the moment it ran: Claude Code reloads
// only the plugins that changed, so self-update's own module may run on, and its first load time alone would call the
// session still behind. One that was skipped (Claude Code asks for /reload-plugins --force, the person's to choose) or
// didn't run is tried once more, then never again for that install; a later install is another key, with its own two.

/** How /reload-plugins says it skipped the reload: it does when the reload would change which MCP tools are loaded, until it is run with --force. */
export const RELOAD_SKIPPED = /\/reload-plugins --force/

/** Whether a /reload-plugins that answered `text` reloaded: anything but the line that says it was skipped. */
export const reloadTook = (text: string | undefined): boolean => !RELOAD_SKIPPED.test(text ?? '')

/** A reload tried for one install this many times at most. */
export const RELOAD_TRIES = 2
/** A session reloads for an install at most this often. */
export const RELOAD_EVERY_MS = 15 * 60_000
/** An install's time this far ahead of now is not believed (a clock that moved): never a reason to reload. */
export const INSTALL_AHEAD_MS = 60_000

/** Whether the session's plugins were loaded before the last install: both times known, the install later, and not ahead of now. */
export function behindInstall(installedAt: number | undefined, loadedAt: number | undefined, now: number): boolean {
  return installedAt !== undefined && loadedAt !== undefined && Number.isFinite(installedAt) && Number.isFinite(loadedAt) && installedAt > loadedAt && installedAt <= now + INSTALL_AHEAD_MS
}

/** The reloads tried for one install (keyed by its time), and whether the person was told past RELOAD_TRIES: the plugin's session state holds it (types/index.d.ts). */
export type { ReloadRecord }

/** The record from whatever is stored, or undefined. */
export function readReloadRecord(raw: unknown): ReloadRecord | undefined {
  if (!isRecord(raw) || !time(raw.install)) return undefined
  const tries = typeof raw.tries === 'number' && Number.isFinite(raw.tries) ? Math.max(0, Math.floor(raw.tries)) : 0
  return { install: raw.install, tries, told: raw.told === true }
}

/** The record for `install`: the one kept when it is for that install, else a fresh one (a later install starts afresh). */
export const recordFor = (kept: ReloadRecord | undefined, install: number): ReloadRecord => (kept !== undefined && kept.install === install ? kept : { install, tries: 0, told: false })

/** What a reload of the session's own waits on, as read right before it would run. */
export type ReloadInput = {
  /** A person is at the session (false: claude -p, an SDK host, where no reload of a plugin's runs). */
  interactive: boolean
  /** The `reloadAfterUpdate` setting. */
  on: boolean
  /** Reloads already tried for this install. */
  tries: number
  /** A main-loop turn runs. */
  turnRunning: boolean
  /** The prompt box's draft ($.prompt.read); undefined when it can't be read in time. */
  draft: string | undefined
  /** The session's agents ($.agent.list), each its status; undefined when they can't be read. */
  agents: ReadonlyArray<{ status: string }> | undefined
  /** This session's look runs (update.ts): a reload would drop it mid-look. */
  looking: boolean
  /** A /reload-plugins this plugin ran is still out. */
  reloading: boolean
  /** When this session last ran a reload of this plugin's, if it did. */
  lastReload: number | undefined
  now: number
}

/** One hold: why the reload waits, or undefined. */
export type ReloadHold = { name: string; holds: (input: ReloadInput) => string | undefined }

/**
 * The agent statuses that are no work under way: a teammate between turns (`idle`), and an agent ended (`completed`,
 * `failed`, `killed`). Every other status holds the reload, the busy ones and any the engine names later alike.
 */
export const QUIET_AGENTS: ReadonlySet<string> = new Set(['idle', 'completed', 'failed', 'killed'])

/** What holds a reload of the session's own, in order: the first that holds says why it waits. */
export const RELOAD_HOLDS: readonly ReloadHold[] = [
  { name: 'headless', holds: i => (i.interactive ? undefined : 'the session is headless') },
  { name: 'off', holds: i => (i.on ? undefined : 'reloadAfterUpdate is off') },
  { name: 'tries', holds: i => (i.tries >= RELOAD_TRIES ? `tried ${i.tries} times for this install already` : undefined) },
  { name: 'turn', holds: i => (i.turnRunning ? 'a turn is running' : undefined) },
  { name: 'draft', holds: i => (i.draft === undefined ? "the prompt box can't be read" : i.draft !== '' ? 'a draft is in the prompt box' : undefined) },
  { name: 'subagent', holds: i => (i.agents === undefined ? "the session's agents can't be read" : i.agents.some(a => !QUIET_AGENTS.has(a.status)) ? 'a subagent is at work' : undefined) },
  { name: 'look', holds: i => (i.looking ? "this session's look for updates is under way" : undefined) },
  { name: 'reloading', holds: i => (i.reloading ? 'a reload of this plugin is still out' : undefined) },
  {
    name: 'rate',
    holds: i =>
      i.lastReload !== undefined && i.now - i.lastReload < RELOAD_EVERY_MS && i.lastReload - i.now <= RELOAD_EVERY_MS
        ? `this session reloaded for an update ${Math.max(0, Math.round((i.now - i.lastReload) / 60_000))} min ago, and reloads at most once every ${RELOAD_EVERY_MS / 60_000} minutes`
        : undefined,
  },
]

/** Why a reload of the session's own waits now, or undefined when it may run. `holds`: the list (a test takes one away). */
export function reloadHold(input: ReloadInput, holds: readonly ReloadHold[] = RELOAD_HOLDS): string | undefined {
  for (const hold of holds) {
    const why = hold.holds(input)
    if (why !== undefined) return why
  }
  return undefined
}

/** The line a reload gets as it runs, in the transcript and as a toast. */
export const RELOAD_LINE = 'self-update: running /reload-plugins: a plugin was updated on this machine after this session loaded its plugins.'

/** The one line the person reads once two tries at /reload-plugins didn't reload this session for an install: what loads it is theirs to choose. */
export const RESTART_LINE =
  "self-update: a plugin was updated on this machine after this session loaded its plugins, and two tries at /reload-plugins didn't reload them (skipped, or not run), so it tries no more for that update; /reload-plugins --force, a restart of this session, or a new one loads it."

// ---------------------------------------------------------------------------------------------
// What update_status says.

/** A time before now, as the status says it: minutes, or hours past 90 minutes. */
export function agoSaid(at: number, now: number): string {
  const ms = now - at
  if (ms < -60_000) return "at a time ahead of this machine's clock"
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 1) return 'under a minute ago'
  if (minutes <= 90) return `${minutes} min ago`
  return `${Math.round(minutes / 60)} h ago`
}

/** What update_status reads: the settings, where it can't run, the state file, this session's load and its reload record. */
export type StatusInput = {
  conf: AutoUpdate
  reloads: boolean
  /** Why it does nothing in this session (another platform, its folders unplaced, no claude), or undefined. */
  cant?: string
  /** The state file, read; undefined for none yet, 'unread' when it can't be read. */
  state: UpdateState | undefined | 'unread'
  now: number
  loaded: number | undefined
  interactive: boolean
  record: ReloadRecord | undefined
}

/** update_status's answer: what self-update does on this machine, and in this session. */
export function statusText(s: StatusInput): string {
  if (s.conf.why !== undefined) return `self-update is off on this machine: autoUpdate ${s.conf.why}. Nothing runs, is read or is written until it names marketplaces.`
  if (s.conf.names.length === 0) return 'self-update is off on this machine: autoUpdate is empty, so nothing runs, is read or is written. Setting it to marketplace names, comma-separated, turns it on.'
  const head = `autoUpdate names ${s.conf.names.join(', ')}. reloadAfterUpdate is ${s.reloads ? 'on' : 'off'}.`
  if (s.cant !== undefined) return `${head} It does nothing in this session: ${s.cant}.`
  if (s.state === 'unread') return `${head} Its state file can't be read now.`
  if (s.state === undefined) return `${head} No look has been recorded on this machine yet: the next turn's end looks.`
  const st = s.state
  const every = lookEveryMs(st.unreached ?? 0)
  const lines = [head, `Last look: ${agoSaid(st.at, s.now)}; the next comes at a turn's end ${Math.round(every / 60_000)} minutes after it.`]
  if (st.fails === 0) lines.push('No failure at the last look.')
  // The failure's line is a command's output, as masked: quoted as data, never read as words of the plugin's.
  else lines.push(`${st.fails} look${st.fails === 1 ? '' : 's'} in a row had a failure${st.failed === undefined ? '' : `; the last, quoted from its output: ${quotedData(st.failed)}`}.`)
  if ((st.unreached ?? 0) > 0) lines.push(`${st.unreached} look${st.unreached === 1 ? '' : 's'} in a row couldn't reach a marketplace, so looks come every ${Math.round(every / 60_000)} minutes until one reaches them all.`)
  if (st.installed === undefined) lines.push('No install has been recorded.')
  else {
    const behind = behindInstall(st.installed, s.loaded, s.now)
    const tries = s.record !== undefined && s.record.install === st.installed ? s.record.tries : 0
    const session = !behind
      ? 'this session loaded its plugins after it.'
      : !s.reloads
        ? 'this session loaded its plugins before it, and reloadAfterUpdate is off: /reload-plugins or a new session loads it.'
        : !s.interactive
          ? 'this session loaded its plugins before it, and is headless, so it reloads at no idle moment.'
          : tries >= RELOAD_TRIES
            ? "this session loaded its plugins before it, and two tries at /reload-plugins didn't reload them: /reload-plugins --force, a restart or a new session loads it."
            : 'this session loaded its plugins before it, and reloads at its next idle moment.'
    lines.push(`Last install: ${agoSaid(st.installed, s.now)}; ${session}`)
  }
  return lines.join(' ')
}
