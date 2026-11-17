// self-chrome's rules, pure wherever they can be, so they run on fixtures: which Chrome process is the person's
// browser, what its command line says, which profile and flag a start takes, the argv and the fixed scripts that look
// and start, and the lines the tool answers with. register.ts runs them on the machine.
//
// What it reads, and only that:
// - Chrome's browser processes: on Windows, a fixed Windows PowerShell script reads chrome.exe processes through
//   Get-CimInstance, as the shared machine code reads processes, and passes on only those that are no child of a
//   browser (no --type=); on macOS, pgrep finds the processes whose command starts with Chrome's executable, and ps
//   reads those alone. Of each command line the plugin keeps whether it has the flag, its --profile-directory and its
//   --user-data-dir, and never prints it.
// - One field of Chrome's Local State, profile.last_active_profiles, and only when a start needs a profile. The file
//   is parsed and only that field is kept: never an account's name or address.
// It prints profile folder names only, never a path, an account or a command line.
//
// What it never does: quit, kill or restart Chrome (that closes every session's tabs and tab groups), sign in, or
// type anything into Chrome.
import { LAUNCH_ENV_CLEAR, LAUNCH_ENV_DROP, isSafeFolder, PSMODULEPATH_RESET, psQuote, quoted } from './machine'

/** The flag that hides Chrome's "is debugging this browser" banner, for every extension and every profile in that Chrome. */
export const FLAG = '--silent-debugger-extension-api'

/** Claude in Chrome's MCP server, as /mcp lists it and its tools are named (mcp__claude-in-chrome__<tool>). */
export const SERVER = 'claude-in-chrome'

/** The environment variable whose 1, true or on turns the flag on while the silentDebugger setting is auto. */
export const ENV_VAR = 'CLAUDE_CHROME_SILENT_DEBUGGER'

/** How long a start waits for Chrome's browser process to show, in seconds. */
export const START_WAIT_S = 20

/** The operating systems the plugin looks after Chrome on. */
export type Platform = 'windows' | 'macos'

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
// The profile: the call's, the setting's, Chrome's last active one, or Default.

/** A profile folder's name as --profile-directory takes it (Default, Profile 2, Guest Profile): letters, digits, spaces, _ and -, no space at either end, at most 64. */
export const PROFILE_NAME = /^[A-Za-z0-9_-](?:[A-Za-z0-9 _-]{0,62}[A-Za-z0-9_-])?$/

/** Whether `value` is a profile folder's name the plugin passes to Chrome and prints. */
export const isProfileName = (value: unknown): value is string => typeof value === 'string' && PROFILE_NAME.test(value)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** What Local State said: the first of its last active profiles, or why there is none to take. */
export type LocalStateRead = { readonly profile: string } | { readonly why: string }

/**
 * The first of Local State's `profile.last_active_profiles`, when it is a profile folder's name. Nothing else of the
 * file is kept, and nothing of it is said but that name: Local State also holds the accounts signed in to each profile.
 */
export function lastActiveProfile(text: string): LocalStateRead {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return { why: "its Local State isn't JSON" }
  }
  const profile = isRecord(parsed) ? parsed.profile : undefined
  const last = isRecord(profile) ? profile.last_active_profiles : undefined
  if (!Array.isArray(last) || last.length === 0) return { why: 'its Local State lists no last active profile' }
  return isProfileName(last[0]) ? { profile: last[0] } : { why: "the first of its last active profiles isn't a plain folder name" }
}

/** The profile a start opens, and where it came from; or why none is taken, and what fixes it. */
export type ProfileChoice = { readonly profile: string; readonly from: string } | { readonly refusal: string; readonly fix: string }

/**
 * The profile a start opens: the call's `profile` (checked at the call), else the profile setting, else the first of
 * Chrome's last active profiles, else Default. `localState` is undefined when it wasn't read (no folder to read it in).
 * A setting that isn't a profile folder's name refuses, rather than open another profile than the person set.
 */
export function chooseProfile(asked: string | undefined, setting: string, localState: LocalStateRead | undefined): ProfileChoice {
  if (asked !== undefined) return { profile: asked, from: 'asked for in this call' }
  if (setting !== '') {
    return isProfileName(setting)
      ? { profile: setting, from: 'the profile setting' }
      : { refusal: `the profile setting reads ${quoted(setting)}, which is no profile folder's name`, fix: "set it to a profile folder's name, such as Default or Profile 2, or empty it" }
  }
  if (localState !== undefined && 'profile' in localState) return { profile: localState.profile, from: "Chrome's last active profile, from its Local State" }
  return { profile: 'Default', from: localState === undefined ? "Chrome's first profile" : `Chrome's first profile: ${localState.why}` }
}

// ---------------------------------------------------------------------------------------------
// Chrome's executable and its user data folder.

/** The standard install of Chrome on macOS: the binary inside its .app, under /Applications. */
export const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** The binary inside a macOS app: the .app's folder, then Contents/MacOS/<name>. */
const MAC_BINARY = /^(\/[^\u0000-\u001f\u007f]*?\.app)\/Contents\/MacOS\/[^/\u0000-\u001f\u007f]+$/

/** Why `path` isn't Chrome's executable on Windows as the plugin takes it (an absolute path to a chrome.exe, isSafeFolder's rules); undefined when it is. */
export function windowsChromeFault(path: unknown): string | undefined {
  if (!isSafeFolder(path)) return 'is not an absolute path with no quote, control character, or . or .. part'
  return /\\chrome\.exe$/i.test(path) ? undefined : 'does not end in \\chrome.exe'
}

/** Why `path` isn't Chrome's executable on macOS as the plugin takes it (the binary inside an .app); undefined when it is. */
export function macChromeFault(path: unknown): string | undefined {
  if (typeof path !== 'string' || path.length > 1024 || !MAC_BINARY.test(path)) return 'is not the binary inside an app (/Applications/Google Chrome.app/Contents/MacOS/Google Chrome)'
  return path.split('/').some(part => part === '.' || part === '..') ? 'has a . or .. part' : undefined
}

/** The .app folder a macOS binary sits in, as `open -a` takes it; undefined when it sits in none. */
export const macBundle = (binary: string): string | undefined => MAC_BINARY.exec(binary)?.[1]

/** The standard places of Chrome on macOS: /Applications, then the home folder's own Applications. */
export function macStandard(home: string | undefined): string[] {
  const own = home !== undefined && /^\/[^\u0000-\u001f\u007f]*$/.test(home) ? `${home.replace(/\/+$/, '')}${MAC_CHROME}` : undefined
  return own === undefined || macChromeFault(own) !== undefined ? [MAC_CHROME] : [MAC_CHROME, own]
}

/** Chrome's default user data folder on macOS, from the home folder; undefined without one. */
export const macUserData = (home: string | undefined): string | undefined =>
  home !== undefined && /^\/[^\u0000-\u001f\u007f]*$/.test(home) ? `${home.replace(/\/+$/, '')}/Library/Application Support/Google/Chrome` : undefined

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

/** A Chrome process as a look reads it: its id, its executable (empty when unknown), its command line. */
export type ChromeProcess = { readonly pid: number; readonly exe: string; readonly cmd: string }

/**
 * What the plugin keeps of a browser process: never its command line. `profile` is the --profile-directory it names
 * when that is a profile folder's name; `namesProfile` whether it names one at all.
 */
export type Browser = { readonly pid: number; readonly flag: boolean; readonly profile?: string; readonly namesProfile: boolean }

/** The person's Chrome, as a look found it: its browser processes on the default user data folder, and how many others had their own. */
export type Judged = { readonly browsers: readonly Browser[]; readonly isolated: number }

/**
 * The person's Chrome among `procs`: a browser process (no --type=, which every child of one has) of one of `paths`,
 * on the default user data folder `userData` (no --user-data-dir, or that one). A browser with a --user-data-dir of
 * its own is a test or isolated Chrome: counted apart, never the person's. Lowest pid first.
 */
export function judge(procs: readonly ChromeProcess[], where: { readonly platform: Platform; readonly paths: readonly string[]; readonly userData: string | undefined }): Judged {
  const paths = new Set(where.paths.map(pathKey))
  const browsers: Browser[] = []
  let isolated = 0
  for (const proc of [...procs].sort((a, b) => a.pid - b.pid)) {
    if (hasSwitch(proc.cmd, '--type')) continue
    const exe = proc.exe !== '' ? proc.exe : where.platform === 'windows' ? firstToken(proc.cmd) : ''
    if (!paths.has(pathKey(exe))) continue
    const dataDir = switchValue(proc.cmd, '--user-data-dir', where.platform)
    if (dataDir !== undefined && (where.userData === undefined || pathKey(dataDir) !== pathKey(where.userData))) {
      isolated += 1
      continue
    }
    const named = switchValue(proc.cmd, '--profile-directory', where.platform)
    browsers.push({ pid: proc.pid, flag: hasSwitch(proc.cmd, FLAG), namesProfile: named !== undefined, ...(isProfileName(named) ? { profile: named } : {}) })
  }
  return { browsers, isolated }
}

// ---------------------------------------------------------------------------------------------
// Starting Chrome: the arguments, macOS's argv, Windows' scripts.

/** Chrome's arguments for a start, as one argv takes them: the profile folder, the last session restored, the flag when on. */
export const launchArgs = (profile: string, flag: boolean): string[] => [`--profile-directory=${profile}`, '--restore-last-session', ...(flag ? [FLAG] : [])]

/**
 * The same as Windows' Start-Process passes them: it joins its argument list with spaces and quotes nothing, so the
 * profile folder, which may hold a space, is quoted here. A profile folder's name holds no quote.
 */
export const windowsLaunchArgs = (profile: string, flag: boolean): string[] => [`--profile-directory="${profile}"`, ...launchArgs(profile, flag).slice(1)]

/** macOS's open, by its known path. */
export const OPEN = '/usr/bin/open'
/** macOS's pgrep, by its known path. */
export const PGREP = '/usr/bin/pgrep'
/** macOS's ps, by its known path. */
export const PS = '/bin/ps'
/** macOS's sleep, by its known path: a start's wait between looks, run as a process so it is no hook's own time. */
export const SLEEP = '/bin/sleep'

/**
 * The start on macOS: `open -a <the .app> --args <arguments>`. LaunchServices starts Chrome, with its own environment
 * and none of this session's; `open` passes the arguments only when Chrome isn't running, which is the only time a
 * start runs. Throws when `binary` sits in no .app.
 */
export function macOpenArgv(binary: string, profile: string, flag: boolean): string[] {
  const bundle = macBundle(binary)
  if (bundle === undefined || !isProfileName(profile)) throw new Error('a start takes the binary inside an .app and a profile folder\'s name')
  return [OPEN, '-a', bundle, '--args', ...launchArgs(profile, flag)]
}

/**
 * The look on macOS, first step: pgrep for the processes whose full command starts with one of `binaries`, then a
 * space or its end. Only those processes' command lines are read after it (psArgv).
 */
export const pgrepArgv = (binaries: readonly string[]): string[] => [PGREP, '-f', `^(${binaries.map(b => b.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')).join('|')})( |$)`]

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
 * Read-Browsers: every chrome.exe that is no child of a browser (no --type=), as { pid, exe, cmd }. A child's command
 * line never leaves the script. An ArrayList, so one entry or none still writes a JSON list.
 */
const READ_BROWSERS = [
  'function Read-Browsers {',
  '  $out = New-Object System.Collections.ArrayList',
  `  foreach ($p in @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'chrome.exe'" -Property ProcessId, CommandLine, ExecutablePath)) {`,
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
 * start, and the default user data folder. One JSON line: { v, paths, start, userData, procs }.
 */
export function windowsLookScript(configured: string | undefined): string {
  if (configured !== undefined && windowsChromeFault(configured) !== undefined) throw new Error(`the chromePath setting ${windowsChromeFault(configured)}`)
  return [
    ...PREAMBLE,
    ...READ_BROWSERS,
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
 * The start on Windows: Chrome by `chrome` (a path the look found), with `args` (windowsLaunchArgs), detached through
 * Start-Process, in Chrome's own folder (never the session's, which it would hold for its whole life), with none of
 * the variables Claude Code sets in the processes it starts (the launch environment's lists in the shared machine
 * code). Then it waits up to START_WAIT_S for a browser process of that chrome.exe on the default user data folder,
 * and writes the browser processes as the look does: { v, procs }. It quits, kills and restarts nothing.
 */
export function windowsStartScript(chrome: string, args: readonly string[]): string {
  if (windowsChromeFault(chrome) !== undefined) throw new Error(`Chrome's path ${windowsChromeFault(chrome)}`)
  if (args.some(arg => !/^--[a-z-]+(?:="[A-Za-z0-9 _-]{1,64}")?$/.test(arg))) throw new Error('a start takes only switches, and a profile folder\'s name')
  const cleared = [...LAUNCH_ENV_CLEAR, ...LAUNCH_ENV_DROP]
  return [
    ...PREAMBLE,
    ...READ_BROWSERS,
    `$chrome = ${literal(chrome)}`,
    `$arguments = @(${args.map(literal).join(', ')})`,
    `foreach ($name in @(${cleared.map(literal).join(', ')})) { Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue }`,
    'Start-Process -FilePath $chrome -ArgumentList $arguments -WorkingDirectory (Split-Path -Parent $chrome)',
    `$deadline = [DateTime]::UtcNow.AddSeconds(${START_WAIT_S})`,
    'do {',
    '  Start-Sleep -Milliseconds 500',
    '  $procs = Read-Browsers',
    '  $mine = $false',
    '  foreach ($p in $procs) {',
    "    $exe = if (\"$($p['exe'])\" -ne '') { \"$($p['exe'])\" } elseif (\"$($p['cmd'])\" -match '^\\s*\"([^\"]*)\"') { $Matches[1] } else { '' }",
    "    if ($exe -ieq $chrome -and \"$($p['cmd'])\" -notmatch '--user-data-dir') { $mine = $true }",
    '  }',
    '} while (-not $mine -and [DateTime]::UtcNow -lt $deadline)',
    '[ordered]@{ v = 1; procs = $procs } | ConvertTo-Json -Compress -Depth 4',
  ].join('\r\n')
}

/** A script's JSON line: the last line of its output that reads as an object. */
function jsonLine(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('{'))
  try {
    const parsed: unknown = JSON.parse(lines.at(-1) ?? '')
    return isRecord(parsed) ? parsed : undefined
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

/** The start script's line, checked: the browser processes after the wait; a string says what is wrong with it. */
export function parseWindowsStart(stdout: string): ChromeProcess[] | string {
  const line = jsonLine(stdout)
  if (line === undefined || line.v !== 1) return "the start's answer isn't the line it writes"
  return procsOf(line.procs) ?? "the start's answer lists processes in a shape this plugin doesn't know"
}

// ---------------------------------------------------------------------------------------------
// The answer.

/** What the look found: the person's Chrome, or why it couldn't tell. */
export type Look = { readonly kind: 'read'; readonly judged: Judged } | { readonly kind: 'failed'; readonly why: string }

/** What the tool did about starting Chrome. */
export type Start =
  /** Chrome runs, or the look couldn't tell: nothing started. */
  | { readonly kind: 'none' }
  /** Chrome doesn't run, and nothing was started: why, and what fixes it. */
  | { readonly kind: 'refused'; readonly why: string; readonly fix: string }
  /** The start was run and failed. */
  | { readonly kind: 'failed'; readonly why: string }
  /** The start ran: with that profile and flag; the browser process that showed, if one did within START_WAIT_S. */
  | { readonly kind: 'started'; readonly profile: string; readonly from: string; readonly flag: boolean; readonly browser?: Browser }

/** What became of the reconnect. */
export type Reconnect =
  | { readonly kind: 'queued'; readonly resume?: string }
  | { readonly kind: 'not-asked' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unlisted'; readonly why: string }
  | { readonly kind: 'not-running' }
  | { readonly kind: 'failed' }

/** Everything the answer says. */
export type Outcome = { readonly platform: Platform; readonly flag: FlagChoice; readonly look: Look; readonly start: Start; readonly reconnect: Reconnect }

/** Whether Chrome runs once the tool is done: found running, or started (a start that showed no process yet may still come up). */
export const isRunning = (look: Look, start: Start): boolean => (look.kind === 'read' && look.judged.browsers.length > 0) || start.kind === 'started'

/** What a browser's command line says of its profile, as a phrase: a profile folder's name only. */
function profileSaid(browser: Browser): string {
  if (browser.profile !== undefined) return `its command line names the profile folder ${JSON.stringify(browser.profile)}`
  if (browser.namesProfile) return "its command line names a profile folder whose name isn't plain, so it isn't shown"
  return 'its command line names no profile folder (Chrome opened the one it used last)'
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

/** The tool's answer, one line each: what it found, the flag, what it did, the reconnect, and what is left for the person. */
export function answer(o: Outcome): string {
  const lines: string[] = []
  const left: string[] = []
  // What it found.
  if (o.look.kind === 'failed') lines.push(`Chrome: can't tell whether it runs (${o.look.why}).`)
  else {
    const [browser, ...more] = o.look.judged.browsers
    const others = isolatedSaid(o.look.judged.isolated)
    if (browser === undefined) lines.push(`Chrome: not running.${others}`)
    else {
      const also = more.length === 0 ? '' : ` (and ${more.length} more browser process${more.length === 1 ? '' : 'es'} of it)`
      lines.push(`Chrome: running (PID ${browser.pid}${also}), ${browser.flag ? 'with' : 'without'} ${FLAG}; ${profileSaid(browser)}.${others}`)
    }
  }
  lines.push(`Flag: ${o.flag.on ? 'on' : 'off'}: ${o.flag.why}.`)
  // What it did.
  const running = o.look.kind === 'read' ? o.look.judged.browsers[0] : undefined
  if (o.look.kind === 'failed') {
    lines.push('Did: nothing. It starts Chrome only when it can see that Chrome isn\'t running.')
    left.push('check whether Chrome runs, and start it by hand if it doesn\'t.')
  } else if (running !== undefined) {
    if (running.flag && o.flag.on) lines.push('Did: nothing: Chrome runs, with the flag.')
    else if (running.flag) lines.push('Did: nothing. Chrome runs with the flag though it is off here; Chrome keeps it until it next starts.')
    else if (!o.flag.on) lines.push('Did: nothing: Chrome runs, and the flag is off.')
    else {
      lines.push("Did: nothing to Chrome. Chrome takes flags only when it starts, and this tool never quits, kills or restarts Chrome: that would close every session's tabs and tab groups.")
      left.push(addFlagByHand(o.platform))
    }
  } else if (o.start.kind === 'refused') {
    lines.push(`Did: nothing: ${o.start.why}.`)
    left.push(`${o.start.fix}.`)
  } else if (o.start.kind === 'failed') {
    lines.push(`Did: tried to start Chrome, but ${o.start.why}.`)
    left.push('start Chrome by hand.')
  } else if (o.start.kind === 'started') {
    const flag = o.start.flag ? ` and ${FLAG}` : `, without ${FLAG}`
    const args = `the profile folder ${JSON.stringify(o.start.profile)} (${o.start.from}), --restore-last-session${flag}`
    const shown = o.start.browser
    if (shown === undefined) {
      lines.push(`Did: asked Chrome to start, with ${args}, but no browser process of it showed within ${START_WAIT_S} s.`)
      left.push('check whether Chrome opened; if it didn\'t, start it by hand, or call chrome_ensure again.')
    } else if (o.start.flag && !shown.flag) {
      lines.push(`Did: started Chrome, with ${args}. It runs as PID ${shown.pid}, but without the flag: a Chrome already starting may have taken the launch.`)
      left.push(addFlagByHand(o.platform))
    } else lines.push(`Did: started Chrome, with ${args}. It runs as PID ${shown.pid}${o.start.flag ? ', and the flag took' : ''}.`)
  }
  // The reconnect.
  const r = o.reconnect
  if (r.kind === 'queued') {
    const then = r.resume === undefined ? 'waits for the next message' : `resumes with: ${r.resume}`
    lines.push(`Reconnect: /mcp reconnect ${SERVER} runs once this turn ends: end your turn now, and do nothing more until it has run. Then the session ${then}`)
  } else if (r.kind === 'not-asked') lines.push('Reconnect: not asked for (reconnect is false).')
  else if (r.kind === 'absent') lines.push(`Reconnect: not queued: Claude in Chrome isn't one of this session's MCP servers (no mcp__${SERVER}__ tool is listed).`)
  else if (r.kind === 'unlisted') lines.push(`Reconnect: not queued: this session's tools can't be listed (${r.why}).`)
  else if (r.kind === 'not-running') lines.push("Reconnect: not queued: Chrome isn't known to run. reconnect_mcp_after_turn (self-mcp) reconnects Claude in Chrome by itself.")
  else lines.push('Reconnect: not queued: queuing it failed.')
  lines.push(`Left for the person: ${left.length === 0 ? 'nothing.' : left.join(' ')}`)
  return lines.join('\n')
}
