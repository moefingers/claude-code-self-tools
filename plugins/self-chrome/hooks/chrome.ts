// self-chrome's rules, pure wherever they can be, so they run on fixtures: which Chrome process is the person's
// browser, what its command line says, which profile and flag a start takes, the argv and the fixed scripts that look
// and start, and the lines the tool answers with. register.ts runs them on the machine.
//
// What it reads, and only that:
// - Chrome's browser processes, this login's alone: on Windows, a fixed Windows PowerShell script reads the chrome.exe
//   processes of its own Windows session through Get-CimInstance, as the shared machine code reads processes, and
//   passes on only those that are no child of a browser (no --type=); on macOS, pgrep finds this user's processes whose
//   command starts with Chrome's executable, and ps reads those alone. Of each command line the plugin keeps whether it
//   has the flag and --no-startup-window, its --profile-directory and its --user-data-dir, and never prints it.
// - When a call or the setting names a profile folder: whether that folder, with its Preferences file, is in Chrome's
//   user data folder; and, when it isn't, the names of the folders there that are (directory names only).
// - When neither names one, for the account match: of Claude Code's .claude.json, `oauthAccount`'s `emailAddress` (its
//   `accountUuid` only checked to be a plain id, never kept); of Chrome's Local State, each profile folder's
//   `profile.info_cache.<folder>.user_name`, and no other key; and whether each folder that matches is a profile folder,
//   as a named one is checked. Each file only once its stat shows a plain file, no link, of at most 4 MiB.
// It prints profile folder names only, never a path, an account, an email or a command line.
// It writes only the start's lock, which names a fresh UUID and when, and lets it go after the start's wait.
//
// What it never does: quit, kill or restart Chrome (that closes every session's tabs and tab groups), open a profile in
// a Chrome that runs, sign in, or type anything into Chrome.
import { GO_IDLE, WHY_IDLE } from './at-idle'
import { isSafeFolder, PSMODULEPATH_RESET, psQuote } from './machine'

/** The flag that hides Chrome's "is debugging this browser" banner, for every extension and every profile in that Chrome. */
export const FLAG = '--silent-debugger-extension-api'

/** Claude in Chrome's MCP server, as /mcp lists it and its tools are named (mcp__claude-in-chrome__<tool>). */
export const SERVER = 'claude-in-chrome'

/** The environment variable whose 1, true or on turns the flag on while the silentDebugger setting is auto. */
export const ENV_VAR = 'CLAUDE_CHROME_SILENT_DEBUGGER'

/** How long a start waits for Chrome's browser process to show, in seconds. */
export const START_WAIT_S = 20

/** How many looks a start's wait makes at most, whatever the clock says. */
export const START_LOOKS = 20

/** How many reconnects one session queues within RECONNECT_WINDOW_MS; past it, the person is asked. */
export const RECONNECT_CAP = 3

/** The window RECONNECT_CAP counts in. */
export const RECONNECT_WINDOW_MS = 10 * 60 * 1000

/**
 * How long a start's lock holds other starts off, at most: the start's own run (30 s), its wait (START_WAIT_S) and one
 * more look (30 s), with room to spare. A lock older than this is taken over: its start ended without letting it go.
 */
export const START_LOCK_MS = 90_000

/** The operating systems the plugin looks after Chrome on. */
export type Platform = 'windows' | 'macos'

const BOM = String.fromCharCode(0xfeff)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

// ---------------------------------------------------------------------------------------------
// The flag: the setting, and the environment variable while the setting is auto.

/** The silentDebugger setting: auto follows ENV_VAR; on and off override it. */
export type SilentSetting = 'auto' | 'on' | 'off'

/** The setting as the plugin takes it: on or off as given, anything else auto (Claude Code fills in the default). */
export const silentSetting = (raw: unknown): SilentSetting => (raw === 'on' || raw === 'off' ? raw : 'auto')

/** Whether ENV_VAR's value turns the flag on: 1, true or on, in any case, spaces around ignored. */
export const envTurnsOn = (raw: string | undefined): boolean => raw !== undefined && /^(?:1|true|on)$/i.test(raw.trim())

/** Whether a start takes the flag, and why, as a phrase. */
export type FlagChoice = { readonly on: boolean; readonly why: string }

/**
 * Whether a Chrome this plugin starts takes the flag. Three values, because Claude Code fills an unset option in with
 * its default: a plain on/off defaulting to off could never let the environment variable apply.
 */
export function flagChoice(setting: SilentSetting, env: string | undefined): FlagChoice {
  if (setting === 'on') return { on: true, why: 'the silentDebugger setting is on' }
  if (setting === 'off') return { on: false, why: 'the silentDebugger setting is off' }
  return envTurnsOn(env)
    ? { on: true, why: `the silentDebugger setting is auto, and ${ENV_VAR} turns it on` }
    : { on: false, why: `the silentDebugger setting is auto, and ${ENV_VAR} doesn't turn it on (1, true or on would)` }
}

// ---------------------------------------------------------------------------------------------
// The profile: the call's, else the setting's, else the account match's, and nothing after it.

/** A profile folder's name as --profile-directory takes it (Default, Profile 2, Guest Profile): letters, digits, spaces, _ and -, no space at either end, at most 64. */
export const PROFILE_NAME = /^[A-Za-z0-9_-](?:[A-Za-z0-9 _-]{0,62}[A-Za-z0-9_-])?$/

/** Whether `value` is a profile folder's name the plugin passes to Chrome and prints. */
export const isProfileName = (value: unknown): value is string => typeof value === 'string' && PROFILE_NAME.test(value)

/** The folder the account match picks, as every answer names it. */
export const MATCHED = "the profile folder whose Google account has the email of Claude Code's account"

/** Where a named profile came from: the call, or the profile setting. */
export type NamedSource = 'call' | 'setting'

/** Where a start's profile came from: named (the call, the setting), or the account match. */
export type ProfileSource = NamedSource | 'account'

/**
 * The profile a start opens: the call's `profile` (checked at the call), else the profile setting (a pin), else the
 * account match (`source: 'account'`), and nothing after it: with no folder picked, nothing starts. A setting that isn't
 * a profile folder's name refuses, saying how long it is, never what it says: a person may have typed an account there.
 */
export type ProfileChoice =
  | { readonly profile: string; readonly source: NamedSource }
  | { readonly source: 'account' }
  | { readonly refusal: string; readonly fix: string }

export function chooseProfile(asked: string | undefined, setting: string): ProfileChoice {
  if (asked !== undefined) return { profile: asked, source: 'call' }
  if (setting === '') return { source: 'account' }
  if (PROFILE_NAME.test(setting)) return { profile: setting, source: 'setting' }
  return {
    refusal: `the profile setting isn't a profile folder's name (it is ${setting.length} character${setting.length === 1 ? '' : 's'} long)`,
    fix: `set the profile setting to one of Chrome's profile folders, by its folder's name (Default, Profile 2), or empty it, so a start takes ${MATCHED}`,
  }
}

/** The folder names under Chrome's user data folder that may be profile folders: plain names only, sorted, at most 40. */
export function profileCandidates(entries: readonly { readonly name: string; readonly kind: string }[]): string[] {
  return entries
    .filter(entry => entry.kind === 'dir' && isProfileName(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
    .slice(0, 40)
}

/**
 * The refusal for a profile folder that isn't in Chrome's user data folder: Chrome would make a new, empty profile of
 * that name, without Claude in Chrome. It names the profile folders that are there, by folder name only (a folder
 * with a Preferences file); never the name asked for, which may be an account's.
 */
export function missingProfile(source: NamedSource, folders: readonly string[] | undefined): { readonly why: string; readonly fix: string } {
  const named = source === 'call' ? 'the profile asked for in this call' : 'the profile setting'
  const how = source === 'call' ? 'call chrome_ensure again with `profile` set to' : 'set the profile setting to'
  const without = source === 'call' ? `leave it out, so a start takes the profile setting, else ${MATCHED}` : `empty it, so a start takes ${MATCHED}`
  return {
    why: `${named} names no profile folder in Chrome's user data folder, and Chrome would make a new, empty profile of that name`,
    fix: `${how} one of Chrome's profile folders${foldersSaid(folders)}, or ${without}`,
  }
}

/** Profile folders as a fix lists them: ` (<names>)`, ` (none was found)`, or, when not listed, `, by its folder's name`. */
function foldersSaid(folders: readonly string[] | undefined): string {
  if (folders === undefined) return ", by its folder's name"
  return ` (${folders.length === 0 ? 'none was found' : folders.map(f => JSON.stringify(f)).join(', ')})`
}

// ---------------------------------------------------------------------------------------------
// The account match: the email of Claude Code's account, from its .claude.json; each profile folder's Google account,
// from Chrome's Local State; and the one folder where they agree.
//
// It matches a profile's Google account (Local State's `user_name`) against the email of Claude Code's Claude account.
// That stands in for "the profile whose Claude in Chrome is signed in to Claude Code's account", which no file says. It
// holds where the person signs in to Claude with the same address as the profile's Google account; where they don't,
// the person pins the profile (the call's `profile`, or the profile setting).

/** A mebibyte, in bytes. */
const MIB = 1024 * 1024

/**
 * Claude Code's config file, which "Holds account details" (Claude Code's own layout,
 * code.claude.com/docs/en/claude-directory.md). Its place, from the same page: "If you set CLAUDE_CONFIG_DIR, every
 * ~/.claude path on this page lives under that directory instead. The same applies to .claude.json, which otherwise sits
 * at ~/.claude.json": beside the .claude folder, not in it. The page names no field of it: `oauthAccount`, its
 * `accountUuid` and its `emailAddress` are from memory, and from another reader of the same file.
 */
export const CLAIM_NAME = '.claude.json'

/**
 * The most of .claude.json read: 4 MiB, $.fs.read's own limit (its answer is refused past it). The file holds Claude
 * Code's whole state, and grows; one past this is not read at all.
 */
export const CLAIM_MAX_BYTES = 4 * MIB

/** The variables .claude.json's place is taken from, as the environment holds them (unset: undefined). */
export type ClaimEnv = { readonly configDir?: string | undefined; readonly userProfile?: string | undefined; readonly home?: string | undefined }

/** A variable's value when it is set and not blank; undefined otherwise. */
const setValue = (value: string | undefined): string | undefined => (value === undefined || value.trim() === '' ? undefined : value)

/**
 * Where Claude Code's .claude.json is: in CLAUDE_CONFIG_DIR when it is set and not blank, else in the home folder
 * (USERPROFILE on Windows, else HOME; HOME on macOS). Undefined when that folder can't be placed for sure: not an
 * absolute local path (on Windows one with a drive, C:\), spaces around it, a network or device path (\\host, //host,
 * \\?\, \\.\, \??\), or a control character. A relative one is Claude Code's to resolve, against a folder this process
 * can't know. The folder's trailing separators are dropped.
 */
export function claimPathOf(platform: Platform, env: ClaimEnv): string | undefined {
  const home = platform === 'windows' ? (setValue(env.userProfile) ?? setValue(env.home)) : setValue(env.home)
  const folder = setValue(env.configDir) ?? home
  if (folder === undefined || folder !== folder.trim() || /[\x00-\x1f\x7f]/.test(folder)) return undefined
  if (/^[\\/]{2}/.test(folder) || /^[\\/]\?\?[\\/]/.test(folder)) return undefined
  if (platform === 'windows') return /^[A-Za-z]:[\\/]/.test(folder) ? `${folder.replace(/[\\/]+$/, '')}\\${CLAIM_NAME}` : undefined
  return folder.startsWith('/') ? `${folder.replace(/\/+$/, '')}/${CLAIM_NAME}` : undefined
}

/** An account id as Claude Code writes one: letters, digits and -, 8 to 64 (from memory, and another reader of the file). */
const ACCOUNT_ID = /^[A-Za-z0-9-]{8,64}$/

/**
 * What a .claude.json says of Claude Code's account: the email of its Claude account; none (an API key, a cloud
 * provider, logged out); or unknown, when the text isn't a JSON object (caught mid-write, say).
 */
export type ClaudeAccount = { readonly kind: 'email'; readonly email: string } | { readonly kind: 'none' } | { readonly kind: 'unknown' }

/**
 * Claude Code's account in a .claude.json's text: `oauthAccount`'s `emailAddress`, when `oauthAccount` is an object whose
 * `accountUuid` is a plain id (ACCOUNT_ID) and the email is a string holding @. The text may start with a BOM. Nothing
 * else of the file leaves this function: the parsed object goes when it returns.
 */
export function claudeAccountOf(text: string): ClaudeAccount {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text)
  } catch {
    return { kind: 'unknown' }
  }
  if (!isRecord(parsed)) return { kind: 'unknown' }
  const account = parsed.oauthAccount
  if (!isRecord(account) || typeof account.accountUuid !== 'string' || !ACCOUNT_ID.test(account.accountUuid)) return { kind: 'none' }
  const email = account.emailAddress
  return typeof email === 'string' && email.includes('@') ? { kind: 'email', email } : { kind: 'none' }
}

// Each profile folder's Google account. Chromium keeps its profiles' attributes under `profile.info_cache`, "A map of
// profile data directory to profile attributes" (chrome/common/pref_names.h, kProfileAttributes), and a profile's
// signed-in account as `user_name` (chrome/browser/profiles/profile_attributes_entry.cc: kUserNameKey, which SetAuthInfo
// writes). From memory, not those pages: that the map is in Local State, in the user data folder, and that `user_name`
// is the Google account's email.

/** Chrome's file in its user data folder that holds `profile.info_cache`. */
export const LOCAL_STATE = 'Local State'

/**
 * The most of Local State read: 4 MiB, $.fs.read's own limit (its answer is refused past it). Local State is tens of KB
 * (from memory); one past this is not read at all.
 */
export const LOCAL_STATE_MAX_BYTES = 4 * MIB

/** A profile folder and the email of its Google account, as Local State pairs them. */
export type ProfileAccount = { readonly folder: string; readonly email: string }

/**
 * The profile folders and their Google accounts in Local State's text: `profile.info_cache.<folder>.user_name`, and no
 * other key of the file. A folder counts only when its name is a profile folder's (PROFILE_NAME); a `user_name` only when
 * it is a string holding @. Undefined when the text has no `profile.info_cache` object: not Local State, or caught
 * mid-write. The text may start with a BOM. The parsed object goes when this returns.
 */
export function profileAccountsOf(text: string): ProfileAccount[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text)
  } catch {
    return undefined
  }
  const profile = isRecord(parsed) ? parsed.profile : undefined
  const cache = isRecord(profile) ? profile.info_cache : undefined
  if (!isRecord(cache)) return undefined
  const pairs: ProfileAccount[] = []
  for (const [folder, info] of Object.entries(cache)) {
    if (!isProfileName(folder) || !isRecord(info)) continue
    const email = info.user_name
    if (typeof email === 'string' && email.includes('@')) pairs.push({ folder, email })
  }
  return pairs
}

/** An email as the match compares it: trimmed and lower-cased. */
const foldEmail = (email: string): string => email.trim().toLowerCase()

/** The profile folders whose Google account has `email`: both trimmed and lower-cased, compared whole; sorted, each once. */
export function accountFolders(pairs: readonly ProfileAccount[], email: string): string[] {
  const want = foldEmail(email)
  const folders = new Set(pairs.filter(pair => foldEmail(pair.email) === want).map(pair => pair.folder))
  return [...folders].sort((a, b) => a.localeCompare(b, 'en'))
}

/** Why a file wasn't read: not there (or not to be looked at), a link, not a plain file, over its cap, or its read failed. */
export type FileFault = 'missing' | 'link' | 'not-file' | 'too-big' | 'unreadable'

/** Why a file of this stat isn't read: a link, not a plain file, or over `max` bytes; undefined when it is read. */
export function fileFault(stat: { readonly kind: string; readonly isLink: boolean; readonly size: number }, max: number): FileFault | undefined {
  if (stat.isLink) return 'link'
  if (stat.kind !== 'file') return 'not-file'
  return stat.size >= 0 && stat.size <= max ? undefined : 'too-big'
}

/** What the account match came to: the one folder, or why there is none. */
export type AccountPick =
  | { readonly kind: 'one'; readonly folder: string }
  /** No folder matches; `absent` of the folders that do are listed in Local State without being profile folders. */
  | { readonly kind: 'none'; readonly absent: number }
  | { readonly kind: 'several'; readonly folders: readonly string[] }
  /** Claude Code's .claude.json can't be placed for sure, or read. */
  | { readonly kind: 'no-claim'; readonly fault: FileFault | 'unplaced' }
  /** It names no Claude account with an email. */
  | { readonly kind: 'no-account' }
  /** It isn't a JSON object. */
  | { readonly kind: 'claim-unclear' }
  /** Chrome's user data folder isn't known (`unplaced`), or its Local State can't be read. */
  | { readonly kind: 'no-local-state'; readonly fault: FileFault | 'unplaced' }
  /** It holds no `profile.info_cache` object. */
  | { readonly kind: 'local-state-unclear' }

/** An account match that picked no folder. */
export type NoPick = Exclude<AccountPick, { readonly kind: 'one' }>

/**
 * What the matching folders come to, among those register.ts found to be profile folders (`present`, each checked as a
 * named one is): one, none or several. Decided on principle: a folder Local State lists without its Preferences file (a
 * profile being deleted, say) doesn't count, since Chrome would make it anew, empty; `absent` counts those when none is
 * left.
 */
export function accountMatch(matched: readonly string[], present: readonly string[]): AccountPick {
  const kept = matched.filter(folder => isProfileName(folder) && present.includes(folder))
  const [only] = kept
  if (kept.length === 1 && only !== undefined) return { kind: 'one', folder: only }
  return kept.length === 0 ? { kind: 'none', absent: matched.length } : { kind: 'several', folders: kept }
}

/** A file's fault, as the end of a sentence about it. */
function faultSaid(fault: FileFault, max: number): string {
  if (fault === 'missing') return "isn't there, or can't be looked at"
  if (fault === 'link') return "is a link, which isn't followed"
  if (fault === 'not-file') return "isn't a plain file"
  if (fault === 'too-big') return `is over ${max / MIB} MiB, which isn't read`
  return "couldn't be read"
}

/** Why the account match picked no folder, as a phrase: folder names only, never an email. */
export function pickReason(pick: NoPick): string {
  switch (pick.kind) {
    case 'none': {
      const n = pick.absent
      const absent = n === 0 ? '' : ` (${n} folder${n === 1 ? '' : 's'} Local State lists with it ${n === 1 ? 'has' : 'have'} no Preferences file, so ${n === 1 ? "it doesn't" : "they don't"} count)`
      return `no profile folder's Google account has it${absent}`
    }
    case 'several':
      return `${pick.folders.length} profile folders' Google accounts have it (${pick.folders.map(f => JSON.stringify(f)).join(', ')}), and it doesn't guess`
    case 'no-claim':
      return pick.fault === 'unplaced'
        ? "Claude Code's .claude.json can't be placed for sure (CLAUDE_CONFIG_DIR, or the home folder, isn't an absolute local path)"
        : `Claude Code's .claude.json ${faultSaid(pick.fault, CLAIM_MAX_BYTES)}`
    case 'no-account':
      return "Claude Code's .claude.json names no Claude account with an email (an API key, a cloud provider, or logged out)"
    case 'claim-unclear':
      return "Claude Code's .claude.json doesn't read as a JSON object just now (caught mid-write, say)"
    case 'no-local-state':
      return pick.fault === 'unplaced' ? "Chrome's user data folder isn't known here, so its Local State can't be read" : `Chrome's Local State ${faultSaid(pick.fault, LOCAL_STATE_MAX_BYTES)}`
    case 'local-state-unclear':
      return "Chrome's Local State doesn't read as its list of profiles"
  }
}

/**
 * The refusal for a start the account match picked no folder for, with how the person pins one among `folders` (the
 * profile folders there, as missingProfile lists them; undefined: not listed). With Chrome's user data folder unknown,
 * no folder can be checked, named or matched, so the fix is a start by hand.
 */
export function accountRefusal(pick: NoPick, folders: readonly string[] | undefined): { readonly why: string; readonly fix: string } {
  const why = `${MATCHED} can't be picked: ${pickReason(pick)}`
  if (pick.kind === 'no-local-state' && pick.fault === 'unplaced') return { why, fix: "start Chrome by hand, on the profile whose Claude in Chrome is signed in to Claude Code's account" }
  const pin = `pin the profile: call chrome_ensure again with \`profile\` set to one of Chrome's profile folders${foldersSaid(folders)}, or set the profile setting to one`
  return { why, fix: pick.kind === 'claim-unclear' ? `call chrome_ensure again in a moment, or ${pin}` : pin }
}

// ---------------------------------------------------------------------------------------------
// Chrome's executable and its user data folder.

/** The standard install of Chrome on macOS: the binary inside its .app, under /Applications. */
export const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** The binary inside a macOS app: the .app's folder, then Contents/MacOS/<a name with Chrome in it>. */
const MAC_BINARY = /^(\/[^\x00-\x1f\x7f]*?\.app)\/Contents\/MacOS\/([^/\x00-\x1f\x7f]*Chrome[^/\x00-\x1f\x7f]*)$/

/**
 * Why `path` isn't Chrome's executable on Windows as the plugin takes it: an absolute path to a chrome.exe, by
 * isSafeFolder's rules, with no [, ] or backtick, which PowerShell reads as a wildcard or an escape. Undefined when it is.
 */
export function windowsChromeFault(path: unknown): string | undefined {
  if (!isSafeFolder(path)) return 'is not an absolute path with no quote, control character, or . or .. part'
  if (/[[\]`]/.test(path)) return 'holds [, ] or a backtick, which PowerShell reads as a wildcard or an escape'
  return /\\chrome\.exe$/i.test(path) ? undefined : 'does not end in \\chrome.exe'
}

/** Why `path` isn't Chrome's executable on macOS as the plugin takes it (a Chrome binary inside an .app); undefined when it is. */
export function macChromeFault(path: unknown): string | undefined {
  if (typeof path !== 'string' || path.length > 1024 || !MAC_BINARY.test(path)) return 'is not the Chrome binary inside an app (/Applications/Google Chrome.app/Contents/MacOS/Google Chrome)'
  return path.split('/').some(part => part === '.' || part === '..') ? 'has a . or .. part' : undefined
}

/** The .app folder a macOS binary sits in, as `open -a` takes it; undefined when it sits in none. */
export const macBundle = (binary: string): string | undefined => MAC_BINARY.exec(binary)?.[1]

/** A home folder fit to build a path on: absolute, no control character. */
const isHome = (home: string | undefined): home is string => home !== undefined && /^\/[^\x00-\x1f\x7f]*$/.test(home)

/** The standard places of Chrome on macOS: /Applications, then the home folder's own Applications. */
export function macStandard(home: string | undefined): string[] {
  const own = isHome(home) ? `${home.replace(/\/+$/, '')}${MAC_CHROME}` : undefined
  return own === undefined || macChromeFault(own) !== undefined ? [MAC_CHROME] : [MAC_CHROME, own]
}

/** Chrome's default user data folder on macOS, from the home folder; undefined without one. */
export const macUserData = (home: string | undefined): string | undefined =>
  isHome(home) ? `${home.replace(/\/+$/, '')}/Library/Application Support/Google/Chrome` : undefined

// ---------------------------------------------------------------------------------------------
// Reading a command line.

/** `text` as a regular expression matching it literally. */
const literally = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')

/** Whether `cmd` holds the switch `name` (`--name`, or `--name=...`) as an argument of its own, quoted or not. */
export function hasSwitch(cmd: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)"?${literally(name)}(?=[\\s"=]|$)`).test(cmd)
}

/**
 * The value of `name=` on `cmd`, or undefined when it has none. Quoted (`--name="a b"` or `"--name=a b"`), the text
 * inside the quotes. Unquoted: on Windows, up to the next space, since a command line keeps a value's quotes there; on
 * macOS, where ps shows the arguments joined by spaces with their quotes gone, up to the next ` --`, or the end.
 */
export function switchValue(cmd: string, name: string, platform: Platform): string | undefined {
  const at = new RegExp(`(?:^|\\s)("?)${literally(name)}=`).exec(cmd)
  if (at === null) return undefined
  const rest = cmd.slice(at.index + at[0].length)
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1)
    return end === -1 ? rest.slice(1) : rest.slice(1, end)
  }
  if (at[1] === '"') {
    const end = rest.indexOf('"')
    return end === -1 ? rest : rest.slice(0, end)
  }
  if (platform === 'windows') return /^\S*/.exec(rest)?.[0] ?? ''
  const end = rest.search(/\s--/)
  return (end === -1 ? rest : rest.slice(0, end)).trim()
}

/** A path compared as the file systems compare it here: case aside, either slash, no trailing separator. */
const pathKey = (path: string): string => path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/** The executable a Windows command line starts with, quoted or not. */
const firstToken = (cmd: string): string => /^\s*"([^"]*)"/.exec(cmd)?.[1] ?? /^\s*(\S+)/.exec(cmd)?.[1] ?? ''

// ---------------------------------------------------------------------------------------------
// Which process is the person's Chrome.

/** A Chrome process as a look reads it: its id, its executable (empty when unknown), its command line (empty when unreadable). */
export type ChromeProcess = { readonly pid: number; readonly exe: string; readonly cmd: string }

/**
 * What the plugin keeps of a browser process: never its command line. `profile` is the --profile-directory it names
 * when that is a profile folder's name; `namesProfile` whether it names one at all; `background` whether it started
 * with --no-startup-window (Chrome running with no window, as it does at login).
 */
export type Browser = { readonly pid: number; readonly flag: boolean; readonly profile?: string; readonly namesProfile: boolean; readonly background: boolean }

/**
 * The person's Chrome, as a look found it: its browser processes on the default user data folder; how many others had
 * a user data folder of their own; and how many chrome.exe processes of this login had a command line that couldn't
 * be read (an elevated Chrome), which leaves the look unable to say Chrome isn't running.
 */
export type Judged = { readonly browsers: readonly Browser[]; readonly isolated: number; readonly unreadable: number }

/**
 * The person's Chrome among `procs`: a browser process (no --type=, which every child of one has) of one of `paths`,
 * on the default user data folder `userData` (no --user-data-dir, or that one). A browser with a --user-data-dir of
 * its own is a test or isolated Chrome: counted apart, never the person's. Lowest pid first.
 */
export function judge(procs: readonly ChromeProcess[], where: { readonly platform: Platform; readonly paths: readonly string[]; readonly userData: string | undefined }): Judged {
  const paths = new Set(where.paths.map(pathKey))
  const browsers: Browser[] = []
  let isolated = 0
  let unreadable = 0
  for (const proc of [...procs].sort((a, b) => a.pid - b.pid)) {
    if (proc.cmd.trim() === '') {
      unreadable += 1
      continue
    }
    if (hasSwitch(proc.cmd, '--type')) continue
    const exe = proc.exe !== '' ? proc.exe : where.platform === 'windows' ? firstToken(proc.cmd) : ''
    if (!paths.has(pathKey(exe))) continue
    const dataDir = switchValue(proc.cmd, '--user-data-dir', where.platform)
    if (dataDir !== undefined && (where.userData === undefined || pathKey(dataDir) !== pathKey(where.userData))) {
      isolated += 1
      continue
    }
    const named = switchValue(proc.cmd, '--profile-directory', where.platform)
    browsers.push({
      pid: proc.pid,
      flag: hasSwitch(proc.cmd, FLAG),
      namesProfile: named !== undefined,
      background: hasSwitch(proc.cmd, '--no-startup-window'),
      ...(isProfileName(named) ? { profile: named } : {}),
    })
  }
  return { browsers, isolated, unreadable }
}

// ---------------------------------------------------------------------------------------------
// The reconnect's cap.

/** The reconnects this session queued within RECONNECT_WINDOW_MS of `now`, and whether another would pass RECONNECT_CAP. */
export function reconnectsWithin(times: unknown, now: number): { readonly kept: number[]; readonly isCapped: boolean } {
  const kept = (Array.isArray(times) ? times : []).filter((t): t is number => typeof t === 'number' && t > now - RECONNECT_WINDOW_MS && t <= now)
  return { kept, isCapped: kept.length >= RECONNECT_CAP }
}

// ---------------------------------------------------------------------------------------------
// The start's lock, which keeps two sessions from starting Chrome at once. It is one file (Windows) or folder (macOS)
// per user, outside every Claude Code config folder, so sessions under any of them share it. Made with an exclusive
// create, so of two starts at once one makes it and the other finds it held; taken over once older than
// START_LOCK_MS; let go by the start that made it, and only by that one.

/** A start's own claim on the lock: a fresh UUID, which the Windows lock file names. */
export const START_CLAIM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The lock's name, beside the self tools' other files. */
export const LOCK_NAME = 'chrome-start.lock'

/** The macOS lock, a folder (mkdir is atomic), under the home folder's caches; undefined without a home folder. */
export const macLockPath = (home: string | undefined): string | undefined =>
  isHome(home) ? `${home.replace(/\/+$/, '')}/Library/Caches/claude-self-tools/${LOCK_NAME}` : undefined

/** macOS's mkdir and rmdir, by their known paths: mkdir of the lock fails when it is there, which is what makes it a lock. */
export const MKDIR = '/bin/mkdir'
export const RMDIR = '/bin/rmdir'

/** Whether a lock last written at `mtimeMs` is stale at `now`: older than START_LOCK_MS. */
export const isStaleLock = (mtimeMs: number, now: number): boolean => now - mtimeMs > START_LOCK_MS

// ---------------------------------------------------------------------------------------------
// Starting Chrome: the arguments, macOS's argv, Windows' scripts.

/** Chrome's arguments for a start: the profile folder when one is named, the last session restored, the flag when on. */
export const launchArgs = (profile: string | undefined, flag: boolean): string[] => [
  ...(profile === undefined ? [] : [`--profile-directory=${profile}`]),
  '--restore-last-session',
  ...(flag ? [FLAG] : []),
]

/**
 * The same as Windows passes them, joined into one command line: the profile folder, which may hold a space, quoted.
 * A profile folder's name holds no quote.
 */
export const windowsLaunchArgs = (profile: string | undefined, flag: boolean): string[] =>
  launchArgs(profile, flag).map(arg => (arg.startsWith('--profile-directory=') ? `--profile-directory="${profile}"` : arg))

/** macOS's open, by its known path. */
export const OPEN = '/usr/bin/open'
/** macOS's pgrep, by its known path. */
export const PGREP = '/usr/bin/pgrep'
/** macOS's ps, by its known path. */
export const PS = '/bin/ps'
/** macOS's id, by its known path: this user's uid, which pgrep is held to. */
export const ID = '/usr/bin/id'
/** macOS's sleep, by its known path: a start's wait between looks, run as a process so it is no hook's own time. */
export const SLEEP = '/bin/sleep'

/**
 * The start on macOS: `open -a <the .app> --args <arguments>`. LaunchServices starts Chrome, with its own environment
 * and none of this session's; `open` passes the arguments only when Chrome isn't running, which a look right before it
 * checks. Throws when `binary` sits in no .app, or `profile` isn't a profile folder's name.
 */
export function macOpenArgv(binary: string, profile: string | undefined, flag: boolean): string[] {
  const bundle = macBundle(binary)
  if (bundle === undefined || (profile !== undefined && !isProfileName(profile))) throw new Error("a start takes the Chrome binary inside an .app, and a profile folder's name or none")
  return [OPEN, '-a', bundle, '--args', ...launchArgs(profile, flag)]
}

/**
 * The look on macOS, first step: pgrep for this user's processes (`uid`, when it is known) whose full command starts
 * with one of `binaries`, then a space or its end. Only those processes' command lines are read after it (psArgv).
 */
export const pgrepArgv = (binaries: readonly string[], uid?: number): string[] => [
  PGREP,
  ...(uid === undefined ? [] : ['-U', String(uid)]),
  '-f',
  `^(${binaries.map(b => b.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')).join('|')})( |$)`,
]

/** The look on macOS, second step: ps of those processes alone, each as its id and its whole command. */
export const psArgv = (pids: readonly number[]): string[] => [PS, '-ww', '-o', 'pid=,command=', '-p', pids.join(',')]

/** The process ids pgrep printed, one a line. */
export const parsePids = (stdout: string): number[] =>
  stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^\d{1,10}$/.test(line))
    .map(Number)

/** ps's lines as Chrome processes: each command matched to the one of `binaries` it starts with (none: empty). */
export function parsePs(stdout: string, binaries: readonly string[]): ChromeProcess[] {
  const procs: ChromeProcess[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\d{1,10})\s+(.*?)\s*$/.exec(line)
    if (m === null) continue
    const cmd = m[2] as string
    procs.push({ pid: Number(m[1]), exe: binaries.find(b => cmd === b || cmd.startsWith(`${b} `)) ?? '', cmd })
  }
  return procs
}

/** `text` as a single-quoted PowerShell literal. */
const literal = (text: string): string => `'${psQuote(text)}'`

/** What every script runs under: errors stop it, no progress bars, Windows PowerShell's own modules, UTF-8 out. */
const PREAMBLE = ["$ErrorActionPreference = 'Stop'", "$ProgressPreference = 'SilentlyContinue'", PSMODULEPATH_RESET, '[Console]::OutputEncoding = [Text.Encoding]::UTF8']

/**
 * Read-Browsers: every chrome.exe of this script's own Windows session (never another login's) that is no child of a
 * browser (no --type=), as { pid, exe, cmd }. A child's command line never leaves the script. One whose command line
 * reads empty (an elevated Chrome, or one in its last milliseconds) is read again once, 300 ms later: gone, it is
 * dropped; still empty, it goes out with an empty command line, so the look can say it can't tell. An ArrayList, so
 * one entry or none still writes a JSON list.
 */
const READ_BROWSERS = [
  'function Read-Browsers {',
  '  $own = [Diagnostics.Process]::GetCurrentProcess().SessionId',
  "  $found = @(Get-CimInstance -ClassName Win32_Process -Filter \"Name = 'chrome.exe'\" -Property ProcessId, SessionId, CommandLine, ExecutablePath | Where-Object { [int]$_.SessionId -eq $own })",
  '  if (@($found | Where-Object { [string]::IsNullOrEmpty("$($_.CommandLine)") }).Count -gt 0) {',
  '    Start-Sleep -Milliseconds 300',
  '    $found = @(foreach ($p in $found) { if (-not [string]::IsNullOrEmpty("$($p.CommandLine)")) { $p } else { Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $([int]$p.ProcessId)" -Property ProcessId, SessionId, CommandLine, ExecutablePath } })',
  '  }',
  '  $out = New-Object System.Collections.ArrayList',
  '  foreach ($p in $found) {',
  '    $c = "$($p.CommandLine)"',
  String.raw`    if ($c -match '(^|\s)"?--type=') { continue }`,
  '    [void]$out.Add([ordered]@{ pid = [long]$p.ProcessId; exe = "$($p.ExecutablePath)"; cmd = $c })',
  '  }',
  '  return ,$out',
  '}',
]

/**
 * The look on Windows: Chrome's browser processes, the paths that count as Chrome (`configured`, else the standard
 * installs, each under the folder Windows names, never an environment variable), the first of them that is there to
 * start, and the default user data folder. `pauseMs` first, for a start's wait between looks. One JSON line:
 * { v, paths, start, userData, procs }.
 */
export function windowsLookScript(configured: string | undefined, pauseMs = 0): string {
  if (configured !== undefined && windowsChromeFault(configured) !== undefined) throw new Error(`the chromePath setting ${windowsChromeFault(configured)}`)
  if (!Number.isInteger(pauseMs) || pauseMs < 0 || pauseMs > 5000) throw new Error('a look pauses 0 to 5000 ms')
  return [
    ...PREAMBLE,
    ...READ_BROWSERS,
    ...(pauseMs > 0 ? [`Start-Sleep -Milliseconds ${pauseMs}`] : []),
    `$configured = ${configured === undefined ? '$null' : literal(configured)}`,
    "$local = [Environment]::GetFolderPath('LocalApplicationData').TrimEnd([char]92)",
    '$paths = New-Object System.Collections.ArrayList',
    'if ($null -ne $configured) { [void]$paths.Add($configured) } else {',
    "  foreach ($base in @([Environment]::GetFolderPath('ProgramFiles'), [Environment]::GetFolderPath('ProgramFilesX86'), $local)) {",
    String.raw`    if ("$base" -notmatch '^[A-Za-z]:\\') { continue }`,
    String.raw`    $path = "$base".TrimEnd([char]92) + '\Google\Chrome\Application\chrome.exe'`,
    '    if (-not $paths.Contains($path)) { [void]$paths.Add($path) }',
    '  }',
    '}',
    '$start = $null',
    'foreach ($path in $paths) { if (Test-Path -LiteralPath $path -PathType Leaf) { $start = $path; break } }',
    String.raw`$userData = $local + '\Google\Chrome\User Data'`,
    '[ordered]@{ v = 1; paths = $paths; start = $start; userData = $userData; procs = (Read-Browsers) } | ConvertTo-Json -Compress -Depth 4',
  ].join('\r\n')
}

/**
 * The login environment, and the swap to it, in C#: the swap is Windows' own calls, so it is the same under every
 * PowerShell and .NET (under PowerShell 7, setting a variable to null through .NET left its name in place).
 * - `Login()`: the environment Windows builds for a process the person starts, CreateEnvironmentBlock for this
 *   process's own token, not inheriting this process's environment: the machine's and the user's Environment keys in
 *   the registry (HKLM and HKCU), the volatile ones, and the system's own variables (SystemRoot, USERPROFILE,
 *   ProgramFiles and the rest), with nothing of the Claude Code session.
 * - `Swap(login)`: every variable of this process deleted (SetEnvironmentVariableW with no value, over
 *   GetEnvironmentStringsW, the hidden drive-folder entries included), then each of the login's set.
 * - `Same(login)`: whether this process's environment, as Windows holds it, is the login's exactly. The start
 *   launches nothing when it isn't.
 * No single quote in it: it goes to Add-Type inside a single-quoted PowerShell string.
 */
export const LOGIN_ENV_CS = [
  'using System; using System.Collections.Generic; using System.ComponentModel; using System.Runtime.InteropServices;',
  'public static class SelfChromeLoginEnv {',
  '[DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);',
  '[DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();',
  '[DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);',
  '[DllImport("userenv.dll", SetLastError = true)] static extern bool CreateEnvironmentBlock(out IntPtr block, IntPtr token, bool inherit);',
  '[DllImport("userenv.dll", SetLastError = true)] static extern bool DestroyEnvironmentBlock(IntPtr block);',
  '[DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetEnvironmentStringsW();',
  '[DllImport("kernel32.dll")] static extern bool FreeEnvironmentStringsW(IntPtr block);',
  '[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool SetEnvironmentVariableW(string name, string value);',
  'static string[] Pairs(IntPtr block) { List<string> pairs = new List<string>(); IntPtr at = block; while (true) { string pair = Marshal.PtrToStringUni(at); if (String.IsNullOrEmpty(pair)) break; pairs.Add(pair); at = new IntPtr(at.ToInt64() + (pair.Length + 1) * 2); } return pairs.ToArray(); }',
  'static string NameOf(string pair) { int at = pair.IndexOf("=", 1, StringComparison.Ordinal); return at > 0 ? pair.Substring(0, at) : null; }',
  'public static string[] Login() { IntPtr token; if (!OpenProcessToken(GetCurrentProcess(), 0x000E, out token)) throw new Win32Exception(); try { IntPtr block; if (!CreateEnvironmentBlock(out block, token, false)) throw new Win32Exception(); try { return Pairs(block); } finally { DestroyEnvironmentBlock(block); } } finally { CloseHandle(token); } }',
  'public static string[] Current() { IntPtr block = GetEnvironmentStringsW(); if (block == IntPtr.Zero) throw new Win32Exception(); try { return Pairs(block); } finally { FreeEnvironmentStringsW(block); } }',
  'public static void Swap(string[] login) { foreach (string pair in Current()) { string name = NameOf(pair); if (name != null) SetEnvironmentVariableW(name, null); } foreach (string pair in login) { string name = NameOf(pair); if (name != null && !SetEnvironmentVariableW(name, pair.Substring(name.Length + 1))) throw new Win32Exception(); } }',
  'public static bool Same(string[] login) { string[] now = Current(); string[] want = (string[])login.Clone(); if (now.Length != want.Length) return false; Array.Sort(now, StringComparer.Ordinal); Array.Sort(want, StringComparer.Ordinal); for (int i = 0; i < now.Length; i++) { if (!String.Equals(now[i], want[i], StringComparison.Ordinal)) return false; } return true; }',
  '}',
].join(' ')

/** The start's lock, as the start script and the release script name it: one file per user, beside the self tools' own. */
const LOCK_PATH = [
  String.raw`$lockDir = [Environment]::GetFolderPath('LocalApplicationData').TrimEnd([char]92) + '\claude-self-tools'`,
  `$lock = $lockDir + '\\${LOCK_NAME}'`,
]

/** Free-Lock: deletes the lock when it is this start's own (it names `$claim`), and only then. */
const FREE_LOCK = [
  'function Free-Lock {',
  `  try { if ([IO.File]::ReadAllText($lock).Contains('"by":"' + $claim + '"')) { [IO.File]::Delete($lock) } } catch { }`,
  '}',
]

/**
 * Take-Lock: the lock made with an exclusive create, naming `$claim` and when; false when another start's is there.
 * Any other failure (the folder can't be written) stops the script.
 */
const TAKE_LOCK = [
  'function Take-Lock {',
  '  try { $file = [IO.File]::Open($lock, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) } catch { if ([IO.File]::Exists($lock)) { return $false }; throw }',
  `  try { $bytes = [Text.Encoding]::UTF8.GetBytes('{"by":"' + $claim + '","at":' + [string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '}'); $file.Write($bytes, 0, $bytes.Length) } finally { $file.Dispose() }`,
  '  return $true',
  '}',
]

/**
 * The start on Windows, short: it returns once Chrome is launched, with the launched process's id, and never waits
 * for the browser (the plugin's own looks do that, each in a run of its own). In order:
 * 1. What takes time, first: Add-Type's compile (LOGIN_ENV_CS) and the login environment's read.
 * 2. The lock, %LOCALAPPDATA%\claude-self-tools\chrome-start.lock, one per user whatever the config folder: made with
 *    an exclusive create and naming `claim`; taken over once older than START_LOCK_MS; held by another start, nothing
 *    is launched (`{ v, held }`).
 * 3. Then back to back: a last look, so a Chrome of `chrome` on the default user data folder that came up since the
 *    plugin's look is never started again (`{ v, running }`); the swap to the login environment; the check that the
 *    environment is the login's exactly, else nothing is launched (`{ v, mismatch }`); and the launch.
 * The launch: Chrome by `chrome` (a path the look found), with `args` (windowsLaunchArgs), through ShellExecute (the
 * call Start-Process -PassThru makes, made directly, so no cmdlet is looked up once the environment is the login one,
 * and neither path is read as a wildcard), in Chrome's own folder, never the session's, which Chrome would hold for its
 * whole life. ShellExecute hands Chrome none of this script's pipes, and the login environment, so Chrome and every
 * process it starts for as long as it runs get the person's environment and none of the session's. `{ v, started }`,
 * the id, or null when Windows names no process. The lock stays for the plugin's wait, and the release script lets it
 * go; a start that found Chrome running, or refused, lets it go itself.
 * It quits, kills and restarts nothing.
 */
export function windowsStartScript(chrome: string, args: readonly string[], claim: string): string {
  if (windowsChromeFault(chrome) !== undefined) throw new Error(`Chrome's path ${windowsChromeFault(chrome)}`)
  if (args.some(arg => !/^--[a-z-]+(?:="[A-Za-z0-9 _-]{1,64}")?$/.test(arg))) throw new Error("a start takes only switches, and a profile folder's name")
  if (!START_CLAIM.test(claim)) throw new Error("a start's claim is a UUID")
  if (LOGIN_ENV_CS.includes("'")) throw new Error('the login environment helper holds a single quote')
  return [
    ...PREAMBLE,
    ...READ_BROWSERS,
    // 1. What takes time.
    `Add-Type -ErrorAction Stop -TypeDefinition '${LOGIN_ENV_CS}'`,
    '$login = [SelfChromeLoginEnv]::Login()',
    `$chrome = ${literal(chrome)}`,
    `$arguments = ${literal(args.join(' '))}`,
    `$claim = '${claim}'`,
    '$launch = New-Object System.Diagnostics.ProcessStartInfo',
    '$launch.FileName = $chrome',
    '$launch.Arguments = $arguments',
    '$launch.WorkingDirectory = [IO.Path]::GetDirectoryName($chrome)',
    '$launch.UseShellExecute = $true',
    // 2. The lock.
    ...LOCK_PATH,
    '[void][IO.Directory]::CreateDirectory($lockDir)',
    ...FREE_LOCK,
    ...TAKE_LOCK,
    '$taken = Take-Lock',
    `if (-not $taken -and ([DateTime]::UtcNow - [IO.File]::GetLastWriteTimeUtc($lock)).TotalMilliseconds -gt ${START_LOCK_MS}) { try { [IO.File]::Delete($lock) } catch { }; $taken = Take-Lock }`,
    `if (-not $taken) { [Console]::Out.WriteLine('{"v":1,"held":true}'); return }`,
    // 3. The last look, the swap and the launch, back to back.
    'foreach ($p in (Read-Browsers)) {',
    "  $exe = if (\"$($p['exe'])\" -ne '') { \"$($p['exe'])\" } elseif (\"$($p['cmd'])\" -match '^\\s*\"([^\"]*)\"') { $Matches[1] } else { '' }",
    `  if ($exe -ieq $chrome -and "$($p['cmd'])" -notmatch '--user-data-dir') { Free-Lock; [Console]::Out.WriteLine('{"v":1,"running":' + [string][long]$p['pid'] + '}'); return }`,
    '}',
    // From here on, .NET calls and this script's own functions only: no cmdlet is looked up in the login environment.
    '[SelfChromeLoginEnv]::Swap($login)',
    `if (-not [SelfChromeLoginEnv]::Same($login)) { Free-Lock; [Console]::Out.WriteLine('{"v":1,"mismatch":true}'); return }`,
    '$started = [System.Diagnostics.Process]::Start($launch)',
    `if ($null -eq $started) { [Console]::Out.WriteLine('{"v":1,"started":null}') } else { [Console]::Out.WriteLine('{"v":1,"started":' + [string][long]$started.Id + '}') }`,
  ].join('\r\n')
}

/** The release on Windows: the start's lock let go, when it is still `claim`'s own. Writes nothing. */
export function windowsReleaseScript(claim: string): string {
  if (!START_CLAIM.test(claim)) throw new Error("a start's claim is a UUID")
  return [...PREAMBLE, `$claim = '${claim}'`, ...LOCK_PATH, ...FREE_LOCK, 'Free-Lock'].join('\r\n')
}

/** A script's JSON line: the last line of its output that reads as an object. */
function jsonLine(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.replace(BOM, '').split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('{'))
  try {
    const parsed: unknown = JSON.parse(lines.at(-1) ?? '')
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** A script's `procs`, each checked; undefined when it isn't a list of them. */
function procsOf(raw: unknown): ChromeProcess[] | undefined {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? [raw] : raw === null || raw === undefined ? [] : undefined
  if (list === undefined) return undefined
  const procs: ChromeProcess[] = []
  for (const p of list) {
    if (!isRecord(p) || typeof p.pid !== 'number' || !Number.isInteger(p.pid) || typeof p.cmd !== 'string') return undefined
    procs.push({ pid: p.pid, exe: typeof p.exe === 'string' ? p.exe : '', cmd: p.cmd })
  }
  return procs
}

/** The Windows look as the plugin takes it: every path checked, so none but a chrome.exe reaches a start. */
export type WindowsLook = { readonly paths: readonly string[]; readonly start: string | undefined; readonly userData: string | undefined; readonly procs: readonly ChromeProcess[] }

/** The look script's line, checked; a string says what is wrong with it. */
export function parseWindowsLook(stdout: string): WindowsLook | string {
  const line = jsonLine(stdout)
  if (line === undefined || line.v !== 1) return "the look's answer isn't the line it writes"
  const procs = procsOf(line.procs)
  if (procs === undefined) return "the look's answer lists processes in a shape this plugin doesn't know"
  const paths = (Array.isArray(line.paths) ? line.paths : typeof line.paths === 'string' ? [line.paths] : []).filter((p): p is string => windowsChromeFault(p) === undefined)
  const start = typeof line.start === 'string' && paths.some(p => pathKey(p) === pathKey(line.start as string)) ? line.start : undefined
  const userData = isSafeFolder(line.userData) ? line.userData : undefined
  return { paths, start, userData, procs }
}

/**
 * What a start's run came to: launched (with the id Windows gave, when it gave one); a Chrome found running by its last
 * look; the lock held by another start; or an environment that wasn't the login's exactly, so nothing launched.
 */
export type StartAnswer =
  | { readonly kind: 'launched'; readonly pid?: number }
  | { readonly kind: 'running'; readonly pid: number }
  | { readonly kind: 'held' }
  | { readonly kind: 'mismatch' }

/** The start script's line, checked; a string says what is wrong with it. */
export function parseWindowsStart(stdout: string): StartAnswer | string {
  const line = jsonLine(stdout)
  if (line === undefined || line.v !== 1) return "the start's answer isn't the line it writes"
  if (line.held === true) return { kind: 'held' }
  if (line.mismatch === true) return { kind: 'mismatch' }
  if (typeof line.running === 'number' && Number.isInteger(line.running)) return { kind: 'running', pid: line.running }
  if (typeof line.started === 'number' && Number.isInteger(line.started)) return { kind: 'launched', pid: line.started }
  if (line.started === null) return { kind: 'launched' }
  return "the start's answer isn't the line it writes"
}

// ---------------------------------------------------------------------------------------------
// The answer.

/** What the look found: the person's Chrome, or why it couldn't tell. */
export type Look = { readonly kind: 'read'; readonly judged: Judged } | { readonly kind: 'failed'; readonly why: string }

/** The profile folder a start passed, and where it came from: every start passes one. */
export type StartProfile = { readonly profile: string; readonly source: ProfileSource }

/** What the tool did about starting Chrome. */
export type Start =
  /** Chrome runs, or the look couldn't tell: nothing started. */
  | { readonly kind: 'none' }
  /** Chrome doesn't run, and nothing was started: why, and what fixes it. */
  | { readonly kind: 'refused'; readonly why: string; readonly fix: string }
  /** The start ran and said it failed, and no browser came up. */
  | { readonly kind: 'failed'; readonly why: string }
  /** Another session was starting Chrome: this call launched nothing, and looked; the browser that showed, if one did. */
  | { readonly kind: 'waited'; readonly browser?: Browser }
  /** Chrome came up between the look and the start (its last look found it): nothing launched. */
  | { readonly kind: 'late'; readonly browser?: Browser }
  /**
   * The start ran: with that profile and flag; the browser process that showed, if one did within START_WAIT_S;
   * `launched`, the id Windows gave the launched process; `unknown`, why the start's own answer didn't come.
   */
  | {
      readonly kind: 'started'
      readonly profile: StartProfile
      readonly flag: boolean
      readonly browser?: Browser
      readonly launched?: number
      readonly unknown?: string
    }

/** What became of the reconnect. */
export type Reconnect =
  | { readonly kind: 'queued'; readonly resume?: string }
  | { readonly kind: 'not-asked' }
  | { readonly kind: 'not-running' }
  | { readonly kind: 'capped' }
  | { readonly kind: 'failed' }

/**
 * Everything the answer says. `account`: what the account match came to while Chrome runs and nothing names a profile,
 * for the Profile line (accountLine); absent otherwise.
 */
export type Outcome = {
  readonly platform: Platform
  readonly flag: FlagChoice
  readonly look: Look
  readonly start: Start
  readonly reconnect: Reconnect
  readonly account?: AccountPick
}

/** Whether Chrome runs once the tool is done: found running, started (a start that showed no process yet may still come up), or found after. */
export function isRunning(look: Look, start: Start): boolean {
  if (look.kind === 'read' && look.judged.browsers.length > 0) return true
  if (start.kind === 'started') return start.browser !== undefined || start.unknown === undefined
  return (start.kind === 'waited' || start.kind === 'late') && start.browser !== undefined
}

/** What a browser's command line says of its profile, as a phrase: a profile folder's name only. */
function profileSaid(browser: Browser): string {
  if (browser.profile !== undefined) return `its command line names the profile folder ${JSON.stringify(browser.profile)}`
  if (browser.namesProfile) return "its command line names a profile folder whose name isn't plain, so it isn't shown"
  return browser.background ? 'its command line names no profile folder' : 'its command line names no profile folder (Chrome opened the one it used last)'
}

/** A browser process found running, as the Chrome line says it. */
function runningSaid(browser: Browser, more: number): string {
  const also = more === 0 ? '' : ` (and ${more} more browser process${more === 1 ? '' : 'es'} of it)`
  const background = browser.background
    ? ', in the background with no window. That counts as running: a start now would only hand off to it, and Chrome took its flags when it started'
    : ''
  return `Chrome: running (PID ${browser.pid}${also})${background}; ${browser.flag ? 'with' : 'without'} ${FLAG}; ${profileSaid(browser)}.`
}

/**
 * The Profile line, for a Chrome that runs while nothing names a profile: whether its browser process's command line
 * names the folder the account match picked, as far as it shows; and, when it names another, that opening the picked
 * profile is the person's (`left`). A window opened from Chrome's profile menu shows on no command line. Folder names
 * only.
 */
export function accountLine(browser: Browser, pick: AccountPick): { readonly line: string; readonly left?: string } {
  if (pick.kind !== 'one') return { line: `Profile: can't tell whether Chrome runs on ${MATCHED}: ${pickReason(pick)}.` }
  const folder = JSON.stringify(pick.folder)
  if (browser.profile === pick.folder) return { line: `Profile: Chrome was started on ${folder}, ${MATCHED}.` }
  if (browser.profile !== undefined) {
    return {
      line: `Profile: Chrome was started on ${JSON.stringify(browser.profile)}, but ${MATCHED} is ${folder}. A window opened from Chrome's profile menu shows on no command line, so that profile may be open already.`,
      left: `open the profile ${folder} from Chrome's profile menu, if it isn't open already: this tool never opens a profile in a Chrome that runs.`,
    }
  }
  if (browser.namesProfile) return { line: `Profile: Chrome's command line names a profile folder whose name isn't plain, so it can't tell whether Chrome was started on ${folder}, ${MATCHED}.` }
  const last = browser.background ? '' : ' (Chrome opened the profile it used last)'
  return { line: `Profile: Chrome's command line names no profile folder${last}, so it can't tell whether that is ${folder}, ${MATCHED}.` }
}

/** The test or isolated Chromes a look passed over, as a sentence; empty for none. */
function isolatedSaid(count: number): string {
  if (count === 0) return ''
  return count === 1
    ? " 1 other Chrome, with its own --user-data-dir (a test or isolated Chrome), isn't counted."
    : ` ${count} other Chromes, each with its own --user-data-dir (a test or isolated Chrome), aren't counted.`
}

/** How the person adds the flag to a Chrome running without it: never by this tool. */
function addFlagByHand(platform: Platform): string {
  const quit =
    platform === 'windows'
      ? 'quit Chrome fully (every window, and Chrome in the notification area if it keeps running in the background), then call chrome_ensure again'
      : 'quit Chrome fully (Cmd+Q, every window), then call chrome_ensure again'
  const always =
    platform === 'windows'
      ? `or add ${FLAG} to the Target of the shortcut Chrome is started from, so every start has it`
      : `or start Chrome with it by hand: open -a "Google Chrome" --args ${FLAG}`
  return `for the flag, ${quit}; ${always}. Until then Chrome shows its "is debugging this browser" banner while an extension drives a tab. Quitting Chrome closes every session's tabs and tab groups, so it is the person's call.`
}

/** The arguments a start passed, as a phrase. */
function argsSaid(profile: StartProfile, flag: boolean): string {
  const from = profile.source === 'call' ? 'asked for in this call' : profile.source === 'setting' ? 'the profile setting' : "its Google account has the email of Claude Code's account"
  return `the profile folder ${JSON.stringify(profile.profile)} (${from}), --restore-last-session${flag ? ` and ${FLAG}` : `, without ${FLAG}`}`
}

/** Whether a browser has the flag a start asked for, as the end of a sentence. */
const flagSaid = (browser: Browser, wanted: boolean): string => (wanted ? (browser.flag ? ', and the flag took' : ', but without the flag') : '')

/** The tool's answer, one line each: what it found, the flag, what it did, the reconnect, and what is left for the person. */
export function answer(o: Outcome): string {
  const lines: string[] = []
  const left: string[] = []
  // What it found.
  if (o.look.kind === 'failed') lines.push(`Chrome: can't tell whether it runs (${o.look.why}).`)
  else {
    const [browser, ...more] = o.look.judged.browsers
    const others = isolatedSaid(o.look.judged.isolated)
    lines.push(browser === undefined ? `Chrome: not running.${others}` : `${runningSaid(browser, more.length)}${others}`)
    // Chrome runs, and nothing names a profile: whether it runs on the folder the account match picked.
    if (browser !== undefined && o.account !== undefined) {
      const said = accountLine(browser, o.account)
      lines.push(said.line)
      if (said.left !== undefined) left.push(said.left)
    }
  }
  lines.push(`Flag: ${o.flag.on ? 'on' : 'off'}: ${o.flag.why}.`)
  // What it did.
  const running = o.look.kind === 'read' ? o.look.judged.browsers[0] : undefined
  const s = o.start
  if (o.look.kind === 'failed') {
    lines.push("Did: nothing. It starts Chrome only when it can see that Chrome isn't running.")
    left.push("check whether Chrome runs, and start it by hand if it doesn't.")
  } else if (running !== undefined) {
    if (running.flag && o.flag.on) lines.push('Did: nothing: Chrome runs, with the flag.')
    else if (running.flag) lines.push('Did: nothing. Chrome runs with the flag though it is off here; Chrome keeps it until it next starts.')
    else if (!o.flag.on) lines.push('Did: nothing: Chrome runs, and the flag is off.')
    else {
      lines.push("Did: nothing to Chrome. Chrome takes flags only when it starts, and this tool never quits, kills or restarts Chrome: that would close every session's tabs and tab groups.")
      left.push(addFlagByHand(o.platform))
    }
  } else if (s.kind === 'refused') {
    lines.push(`Did: nothing: ${s.why}.`)
    left.push(`${s.fix}.`)
  } else if (s.kind === 'failed') {
    lines.push(`Did: tried to start Chrome, but ${s.why}.`)
    left.push('start Chrome by hand.')
  } else if (s.kind === 'waited') {
    if (s.browser === undefined) {
      lines.push(`Did: nothing: another session is starting Chrome, and no browser process of it showed within ${START_WAIT_S} s.`)
      left.push('call chrome_ensure again in a minute; if Chrome still isn\'t running, start it by hand.')
    } else {
      lines.push(`Did: nothing: another session was starting Chrome, which runs as PID ${s.browser.pid}, ${s.browser.flag ? 'with' : 'without'} the flag.`)
      if (o.flag.on && !s.browser.flag) left.push(addFlagByHand(o.platform))
    }
  } else if (s.kind === 'late') {
    const pid = s.browser === undefined ? '' : `, PID ${s.browser.pid}, ${s.browser.flag ? 'with' : 'without'} the flag`
    lines.push(`Did: nothing: Chrome came up just before the start (another session's start, or the person's)${pid}.`)
    if (o.flag.on && s.browser !== undefined && !s.browser.flag) left.push(addFlagByHand(o.platform))
  } else if (s.kind === 'started') {
    const args = argsSaid(s.profile, s.flag)
    const shown = s.browser
    const unknown = s.unknown === undefined ? '' : `; the start's own answer didn't come (${s.unknown})`
    if (shown === undefined) {
      lines.push(`Did: asked Chrome to start, with ${args}${unknown}, but no browser process of it showed within ${START_WAIT_S} s.`)
      left.push("check whether Chrome opened; if it didn't, start it by hand, or call chrome_ensure again.")
    } else if (s.launched !== undefined && s.launched !== shown.pid) {
      lines.push(`Did: launched Chrome, with ${args}, but the launch handed off to a Chrome that was starting already: it runs as PID ${shown.pid}${flagSaid(shown, s.flag)}.`)
      if (s.flag && !shown.flag) left.push(addFlagByHand(o.platform))
    } else if (s.flag && !shown.flag) {
      lines.push(`Did: started Chrome, with ${args}${unknown}. It runs as PID ${shown.pid}, but without the flag: a Chrome already starting may have taken the launch.`)
      left.push(addFlagByHand(o.platform))
    } else lines.push(`Did: started Chrome, with ${args}${unknown}. It runs as PID ${shown.pid}${flagSaid(shown, s.flag)}.`)
  }
  // The reconnect.
  const r = o.reconnect
  if (r.kind === 'queued') {
    const then = r.resume === undefined ? 'waits for the next message' : `resumes with: ${r.resume}`
    // #67: the shared words of every tool that queues for the idle moment, as the description has them.
    lines.push(`Reconnect: /mcp reconnect ${SERVER} runs once this turn ends, so ${GO_IDLE} ${WHY_IDLE} Then the session ${then}`)
  } else if (r.kind === 'not-asked') lines.push('Reconnect: not asked for (reconnect is false).')
  else if (r.kind === 'not-running') lines.push("Reconnect: not queued: Chrome isn't known to run. reconnect_mcp_after_turn (self-mcp) reconnects Claude in Chrome by itself.")
  else if (r.kind === 'capped') {
    lines.push(
      `Reconnect: not queued: this session has queued ${RECONNECT_CAP} reconnects of Claude in Chrome in the last ${RECONNECT_WINDOW_MS / 60_000} minutes, and it still isn't connected. Ask the person rather than call chrome_ensure again.`,
    )
    left.push('check that Claude in Chrome is turned on, and signed in, in the Chrome profile it should use.')
  } else lines.push('Reconnect: not queued: queuing it failed.')
  lines.push(`Left for the person: ${left.length === 0 ? 'nothing.' : left.join(' ')}`)
  return lines.join('\n')
}
