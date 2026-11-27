import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { GO_IDLE, idleWords, WHY_IDLE } from '../hooks/at-idle'
import {
  accountFolders,
  accountMatch,
  type AccountPick,
  answer,
  chooseProfile,
  CLAIM_MAX_BYTES,
  type ClaimEnv,
  claimPathOf,
  type ClaudeAccount,
  claudeAccountOf,
  type FileFault,
  fileFault,
  flagChoice,
  hasSwitch,
  isStaleLock,
  judge,
  LOCAL_STATE_MAX_BYTES,
  LOGIN_ENV_CS,
  MAC_CHROME,
  macBundle,
  macChromeFault,
  macLockPath,
  macOpenArgv,
  macStandard,
  MATCHED,
  mayHoldClaudeAccount,
  missingProfile,
  parsePs,
  parseWindowsStart,
  pgrepArgv,
  type Platform,
  type ProfileAccount,
  profileAccountsOf,
  profileCandidates,
  psArgv,
  reconnectsWithin,
  type SessionSignIn,
  silentSetting,
  START_LOCK_MS,
  switchValue,
  windowsChromeFault,
  windowsLaunchArgs,
  windowsLookScript,
  windowsReleaseScript,
  windowsStartScript,
} from '../hooks/chrome'

const TOOL = 'mcp__self-chrome__chrome_ensure'
const FLAG = '--silent-debugger-extension-api'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const LOCAL = 'C:\\Users\\u\\AppData\\Local'
const USER_DATA = `${LOCAL}\\Google\\Chrome\\User Data`
const HOME = '/Users/u'
const USERPROFILE = 'C:\\Users\\u'
const WINDOWS = { OS: 'Windows_NT', SystemRoot: 'C:\\Windows', USERPROFILE }
const MAC = { HOME }
/** Claude Code's .claude.json and Chrome's Local State, where the plugin should look for them. */
const CLAIM_WINDOWS = `${USERPROFILE}\\.claude.json`
const CLAIM_MAC = `${HOME}/.claude.json`
const LOCAL_STATE_WINDOWS = `${USER_DATA}\\Local State`
const LOCAL_STATE_MAC = `${HOME}/Library/Application Support/Google/Chrome/Local State`
/** The phrase the answers name the account match's folder by. */
const MATCH = "the profile folder whose Google account has the email of Claude Code's account"

// Made-up accounts, built at run time: no address is written out whole, and none is a real one.
const mail = (name: string) => [name, 'example.test'].join('@')
/** The email of Claude Code's account, in the fakes. */
const OWNER = mail('owner')
/** Another account's. */
const SOMEONE = mail('someone')
/** An account id as Claude Code writes one, made up. */
const accountId = (n: number) => `${'0'.repeat(8)}-${'0'.repeat(4)}-${String(n).padStart(4, '0')}`
/** A made-up account id with letters in it, to show the ids are compared whole, case and all. */
const ID_WITH_LETTERS = ['abcdef01', 'beef', 'cafe', '0001'].join('-')
/** A value planted where the plugin must not look: no answer or read's result may hold one. */
const plant = (n: number) => ['planted', 'never', 'out', String(n)].join('_')
/** An `oauthAccount` with `email` and `id`, among the other fields Claude Code writes there. */
const accountRecord = (email: unknown, id: unknown = accountId(1)) => ({ accountUuid: id, emailAddress: email, organizationUuid: accountId(2), displayName: plant(1) })
/** A .claude.json's text: `oauthAccount` (left out when undefined) among the rest of Claude Code's state. */
const claimText = (account: unknown) => JSON.stringify({ numStartups: 3, oauthAccount: account, projects: { [plant(2)]: { allowedTools: [] } }, userID: plant(3) })
/** A Local State's text: `profile.info_cache` among other keys, `os_crypt` planted. */
const localStateText = (cache: unknown) => JSON.stringify({ os_crypt: { planted: plant(4) }, profile: { info_cache: cache, last_used: 'Default' }, browser: { planted: plant(5) } })
/** A profile's attributes in info_cache, signed in to `email`, its other keys planted. */
const signedIn = (email: unknown) => ({ user_name: email, name: plant(6), gaia_name: plant(7), gaia_id: plant(8) })
/** The fakes' profiles: Default signed in to another account, Profile 3 to Claude Code's. */
const CACHE = { Default: signedIn(SOMEONE), 'Profile 3': signedIn(OWNER) }
const NOW = 1_000_000
const MINUTE = 60_000
/** A tool of Claude in Chrome's. */
const IN_CHROME = 'mcp__claude-in-chrome__tabs_context_mcp'

/** What would quit, kill or restart a process: no script or argv of the plugin's may hold any of these. */
const KILLS = /Stop-Process|taskkill|\.Kill\(|CloseMainWindow|Restart-|killall|pkill|\bkill\b|osascript|\bquit\b/i

/** A browser process as the look reads it. */
type Proc = { pid: number; exe?: string; cmd: string }

/**
 * The path the plugin asked for, from the path a fake file hook is given. On Linux a Windows path (C:\...) is a relative
 * one, so the test kit resolves it against the plugin's folder before any hook sees it, as `<that folder>/C:\...`: that
 * prefix is taken off, and the drive and what follows it are what the plugin asked for. On Windows, and for a POSIX
 * path, the path is as given. Nothing is resolved with Node's path.
 */
const asked = (path: string): string => /^\/.*\/([A-Za-z]:\\[^/]*)$/.exec(path)?.[1] ?? path

/**
 * A file the fakes hold: its text; or what its stat or read shows instead: not there, a link, over 4 MiB, a folder, or a
 * plain file whose read fails.
 */
type FakeFile = { readonly text: string } | { readonly fault: 'missing' | 'link' | 'huge' | 'dir' | 'fails' }

type World = {
  platform?: 'windows' | 'macos' | 'linux' | 'wsl'
  isHosted?: boolean
  /** session.info answers without a platform. */
  noPlatform?: boolean
  env?: Record<string, string>
  /** The Chrome processes running now. */
  running?: Proc[]
  /** What runs once the start has run; left out, Chrome's browser process with the arguments the start passed. */
  after?: Proc[]
  /** Processes that show from the look after this many looks, as another session's start would make them. */
  appear?: { after: number; procs: Proc[] }
  /** The look's `start`: the chrome.exe that is there to start (null: none is). */
  start?: string | null
  /** What the start's run does. */
  startRun?: 'launched' | 'no-pid' | 'running' | 'fails' | 'hangs' | 'held' | 'mismatch'
  /** macOS's lock folder: there, made by another start now (`held`), or long ago (`stale`). */
  macLock?: 'held' | 'stale'
  /** The id the start's run says it launched. */
  launchedPid?: number
  /** What macOS's open does. */
  open?: 'opens' | 'fails' | 'hangs'
  /** The profile folders in Chrome's user data folder, each with its Preferences file. */
  profiles?: string[]
  /** Claude Code's .claude.json; left out, one whose account has OWNER's email. */
  claim?: FakeFile
  /** Chrome's Local State; left out, one with CACHE. */
  localState?: FakeFile
  /**
   * This session's sign-in as $.session.identity() answers it: a kind and an account id (left out: claude.ai, on the id
   * .claude.json records); or refused, as privacy refuses a plugin in the `user` tier; or a call that throws.
   */
  identity?: { readonly kind: string; readonly accountId?: string } | 'denied' | 'throws'
  /** Chrome's user data folder can't be listed. */
  listFails?: boolean
  /** The session's tools. */
  tools?: string[]
  /** What the look's script does. */
  look?: 'answers' | 'fails' | 'garbled'
  /** What the plugin's store holds at the start. */
  store?: Record<string, unknown>
  /** Writes of the session's reconnect count fail. */
  stateFails?: boolean
}

const ANSWERED = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as const
const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

/** The arguments a Windows start script passes Chrome: its `$arguments` literal, unquoted. */
function argumentsOf(script: string): string {
  const m = /^\$arguments = '((?:[^']|'')*)'\r?$/m.exec(script)
  return (m?.[1] ?? '').replace(/''/g, "'")
}

/** The engine beneath the plugin: the machine's processes, Chrome's folders, the store, the session's tools; and what the plugin ran. */
function engine(on: On, world: World = {}) {
  const platform = world.platform ?? 'windows'
  const isMac = platform === 'macos'
  let running: Proc[] = world.running ?? []
  let looks = 0
  /** How many times the plugin asked for the session's sign-in. */
  let asks = 0
  const scripts: string[] = []
  const starts: string[] = []
  const argvs: string[][] = []
  /** The paths the plugin read, stat'd, asked to exist and listed, each as it asked for it (asked). */
  const reads: string[] = []
  const stats: string[] = []
  const existed: string[] = []
  const lists: string[] = []
  const commands: string[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  const described: string[] = []
  /** The Windows release scripts run, and the macOS lock folder: there or not. */
  const releases: string[] = []
  let macLockThere = world.macLock !== undefined
  const store = new Map<string, unknown>(Object.entries(world.store ?? {}))
  const profiles = world.profiles ?? ['Default', 'Profile 3']
  const clock = mock.clock(on, { now: NOW })
  const session = mock.session(on)
  // The update check off, by its own switch (update-check.ts: trafficOff, before its read of the plugin's own
  // plugin.json): every file the records hold is then one chrome_ensure asked for. tests/update-check.test.ts runs the
  // check against this plugin's tool.
  mock.env(on, { ...(isMac ? MAC : platform === 'windows' ? WINDOWS : {}), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...world.env })
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('state.set', (_, e, next) => {
    if (world.stateFails === true && JSON.stringify(e).includes('reconnects')) return { deny: 'state refused' }
    return next(e)
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.info', () => ({ value: { transcriptPath: '', ...(world.noPlatform === true ? {} : { platform }), isHosted: world.isHosted === true } }))
  on('tool.register', (_, e) => {
    described.push(String(e.description))
    return { value: { tool: TOOL } }
  })
  on('tool.list', () => ({ value: (world.tools ?? [IN_CHROME]).map(name => ({ name, description: '', mcp: name.startsWith('mcp__') })) }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  /** The fake file at `path`, by its name: a host on Windows may spell a POSIX path its own way. */
  const fileAt = (path: string): FakeFile | undefined => {
    const spelt = path.replace(/\\/g, '/')
    if (spelt.endsWith('/.claude.json')) return world.claim ?? { text: claimText(accountRecord(OWNER)) }
    if (spelt.endsWith('/Local State')) return world.localState ?? { text: localStateText(CACHE) }
    return undefined
  }
  // This session's sign-in: its kind and account id, as the engine answers them; refused, or a call that throws.
  // Each call is counted, so a case can show that nothing was asked.
  on('session.identity', () => {
    asks += 1
    const identity = world.identity ?? { kind: 'claude.ai', accountId: accountId(1) }
    if (identity === 'denied') return { deny: 'privacy: a plugin in the user tier is not told who the session is' }
    if (identity === 'throws') throw new Error('the identity could not be read')
    return { value: { kind: identity.kind, isVerified: false, ...(identity.accountId === undefined ? {} : { accountId: identity.accountId }) } }
  })
  // A refusal names the path, as an OS error does: no answer may repeat it.
  on('fs.read', (_, e) => {
    reads.push(asked(e.path))
    const file = fileAt(e.path)
    return file !== undefined && 'text' in file ? { value: file.text } : { deny: `EACCES: ${e.path}` }
  })
  // Chrome's user data folder: its profile folders, and other folders and files that are no profile.
  on('fs.list', (_, e) => {
    lists.push(asked(e.path ?? ''))
    if (world.listFails === true) return { deny: `EACCES: ${e.path ?? ''}` }
    const dirs = [...profiles, 'Crashpad', 'ShaderCache', 'Stale', 'bad.name']
    return { value: [...dirs.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })), { name: 'Local State', kind: 'file' as const, size: 9, mtimeMs: 0, isLink: false }] }
  })
  // The fake files' stats; and the macOS lock folder's age: just made by another start, or long ago.
  on('fs.stat', (_, e) => {
    stats.push(asked(e.path))
    const file = fileAt(e.path)
    if (file === undefined) return { value: { kind: 'dir' as const, size: 0, mtimeMs: world.macLock === 'stale' ? NOW - START_LOCK_MS - 1 : NOW, isLink: false } }
    const fault = 'fault' in file ? file.fault : undefined
    if (fault === 'missing') return { deny: `ENOENT: ${e.path}` }
    const size = 'text' in file ? file.text.length : fault === 'huge' ? 4 * 1024 * 1024 + 1 : 10
    const kind: 'file' | 'dir' = fault === 'dir' ? 'dir' : 'file'
    return { value: { kind, size, mtimeMs: NOW, isLink: fault === 'link' } }
  })
  // The standard install is there, and each profile folder's Preferences. Matched by the tail: a host on Windows may
  // spell a POSIX path its own way.
  on('fs.exists', (_, e) => {
    existed.push(asked(e.path))
    const path = e.path.replace(/\\/g, '/')
    if (/\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome$/.test(path)) return { value: true }
    return { value: profiles.some(p => path.endsWith(`/${p}/Preferences`)) }
  })
  const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  const failed = (stderr: string, exitCode = 1) => ({ value: { exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  /** One more look: what another session's start makes shows once its looks are past. */
  const lookNow = (): Proc[] => {
    looks += 1
    if (world.appear !== undefined && looks > world.appear.after) running = world.appear.procs
    return running
  }
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    argvs.push(argv)
    if (!isMac) {
      const script = String(e.init?.stdin ?? '')
      scripts.push(script)
      if (script.includes('[System.Diagnostics.Process]::Start(')) {
        starts.push(script)
        const after = world.after ?? [{ pid: 4321, cmd: `"${CHROME}" ${argumentsOf(script)}` }]
        const run = world.startRun ?? 'launched'
        if (run === 'fails') return failed('Exception calling "Start" with "1" argument(s): "The system cannot find the file specified"')
        if (run === 'held') return ok('{"v":1,"held":true}\r\n')
        if (run === 'mismatch') return ok('{"v":1,"mismatch":true}\r\n')
        running = after
        if (run === 'hangs') return { deny: 'the command was still running after 30000 ms' }
        if (run === 'running') return ok(`${JSON.stringify({ v: 1, running: after[0]?.pid ?? 1 })}\r\n`)
        if (run === 'no-pid') return ok('{"v":1,"started":null}\r\n')
        return ok(`{"v":1,"started":${world.launchedPid ?? 4321}}\r\n`)
      }
      if (/^Free-Lock\r?$/m.test(script)) {
        releases.push(script)
        return ok('')
      }
      if (world.look === 'fails') return failed('Get-CimInstance : Access denied')
      if (world.look === 'garbled') return ok('not json\r\n')
      const procs = lookNow()
      const line = { v: 1, paths: [CHROME], start: world.start === undefined ? CHROME : world.start, userData: USER_DATA, procs: procs.map(p => ({ pid: p.pid, exe: p.exe ?? CHROME, cmd: p.cmd })) }
      return ok(`${JSON.stringify(line)}\r\n`)
    }
    if (argv[0] === '/usr/bin/id') return ok('501\n')
    if (argv[0] === '/usr/bin/pgrep') {
      const pids = lookNow().filter(p => p.cmd.startsWith(MAC_CHROME)).map(p => p.pid)
      return pids.length === 0 ? ok('', 1) : ok(`${pids.join('\n')}\n`)
    }
    if (argv[0] === '/bin/ps') {
      const pidsAsked = (argv.at(-1) ?? '').split(',').map(Number)
      return ok(running.filter(p => pidsAsked.includes(p.pid)).map(p => `${String(p.pid).padStart(5)} ${p.cmd}`).join('\n'))
    }
    if (argv[0] === '/bin/mkdir') {
      if (argv[1] === '-p') return ok('')
      if (macLockThere) return failed(`mkdir: ${argv[1]}: File exists`)
      macLockThere = true
      return ok('')
    }
    if (argv[0] === '/bin/rmdir') {
      macLockThere = false
      return ok('')
    }
    if (argv[0] === '/usr/bin/open') {
      if (world.open === 'fails') return failed('LSOpenURLsWithRole() failed with error -10810', 1)
      running = world.after ?? [{ pid: 4321, cmd: [MAC_CHROME, ...argv.slice(argv.indexOf('--args') + 1)].join(' ') }]
      if (world.open === 'hangs') return { deny: 'the command was still running after 10000 ms' }
      return ok('')
    }
    if (argv[0] === '/bin/sleep') return ok('')
    return failed(`no such command: ${argv[0]}`, 127)
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('command.run', (_, e) => {
    commands.push(`${e.command} ${e.args}`)
    return {}
  })
  return { scripts, starts, releases, argvs, reads, stats, existed, lists, commands, prompts, toasts, described, store, clock, session, macLock: () => macLockThere, identityAsks: () => asks }
}

/**
 * What every answer is held to: no email, no @, nothing planted, no path of the person's; and the plugin's file calls:
 * reads and stats of .claude.json and Local State alone (and the macOS lock's age), existence checks of Preferences
 * files and Chrome's binary alone, and nothing of .credentials.json.
 */
function heldToFolders(said: string, fakes: ReturnType<typeof engine>): void {
  expect(said).not.toContain(OWNER)
  expect(said).not.toContain(SOMEONE)
  expect(said).not.toContain('@')
  expect(said).not.toContain('example.test')
  expect(said).not.toContain('planted')
  // No account id, the file's or the session's: accountId() makes them, and ID_WITH_LETTERS is the other the tests use.
  expect(said).not.toContain('0000-')
  expect(said.toLowerCase()).not.toContain(ID_WITH_LETTERS.toLowerCase())
  expect(said).not.toContain(USERPROFILE)
  expect(said).not.toContain(HOME)
  const named = /[\\/](?:\.claude\.json|Local State)$/
  expect(fakes.reads.filter(path => !named.test(path))).toEqual([])
  expect(fakes.stats.filter(path => !named.test(path) && !/[\\/]chrome-start\.lock$/.test(path))).toEqual([])
  expect(fakes.existed.filter(path => !/[\\/]Preferences$/.test(path) && !/[\\/]Contents[\\/]MacOS[\\/]Google Chrome$/.test(path))).toEqual([])
  expect([...fakes.reads, ...fakes.stats, ...fakes.existed, ...fakes.lists].filter(path => /credentials/i.test(path))).toEqual([])
}

/** Every row whose answer isn't the one it wants, each as a line: all of them, never only the first. */
function differing<I, O>(rows: readonly (readonly [string, I, O])[], rule: (input: I) => O): string[] {
  const wrong: string[] = []
  for (const [name, input, want] of rows) {
    const got = rule(input)
    if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  }
  return wrong
}

/** The call's result, as text; it must not be refused. */
async function ensure($: Engine, input: Record<string, unknown> = {}): Promise<string> {
  const done = await $.tool.call({ tool: TOOL, ...input })
  expect(done.deny).toBeUndefined()
  return String(done.result)
}

/** Whether anything the plugin ran could quit, kill or restart a process. */
const killsAnything = (scripts: readonly string[], argvs: readonly string[][]) => [...scripts, ...argvs.map(a => a.join(' '))].some(text => KILLS.test(text))

/** A browser of the person's, as the answer's pure tests give it. */
const browser = (pid: number, flag: boolean, more: Partial<{ profile: string; namesProfile: boolean; background: boolean }> = {}) => ({ pid, flag, namesProfile: false, background: false, ...more })

// ---------------------------------------------------------------------------------------------
// The flag: the setting and the environment variable.

test('the flag: auto follows CLAUDE_CHROME_SILENT_DEBUGGER (1, true or on), and on and off override it', () => {
  expect(flagChoice('auto', undefined).on).toBe(false)
  for (const value of ['1', 'true', 'TRUE', ' on ', 'On']) expect(flagChoice('auto', value).on).toBe(true)
  for (const value of ['0', 'false', 'off', 'yes', '', '2']) expect(flagChoice('auto', value).on).toBe(false)
  expect(flagChoice('on', undefined).on).toBe(true)
  expect(flagChoice('on', '0').on).toBe(true)
  expect(flagChoice('off', '1').on).toBe(false)
  expect(flagChoice('auto', '1').why).toMatch(/auto, and CLAUDE_CHROME_SILENT_DEBUGGER turns it on/)
  // A stored value outside the options counts as unset, so auto.
  expect(silentSetting('maybe')).toBe('auto')
  expect(silentSetting(undefined)).toBe('auto')
  expect(silentSetting('off')).toBe('off')
})

test("not running, opted in by the variable, no profile named: Chrome starts with the flag on the account match's folder, and the reconnect runs once the turn ends", async ($, on) => {
  const fakes = engine(on, { env: { CLAUDE_CHROME_SILENT_DEBUGGER: '1' } })
  const { starts, releases, argvs, scripts, reads, commands, clock } = fakes
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Chrome: not running\.$/m)
  expect(said).toMatch(/^Flag: on: the silentDebugger setting is auto, and CLAUDE_CHROME_SILENT_DEBUGGER turns it on\.$/m)
  expect(said).toContain(`Did: started Chrome, with the profile folder "Profile 3" (its Google account has the email of Claude Code's account), --restore-last-session and ${FLAG}. It runs as PID 4321, and the flag took.`)
  expect(said).toMatch(/^Reconnect: \/mcp reconnect claude-in-chrome runs once this turn ends/m)
  // #67: the answer that says the reconnect is queued says what to do now in the shared words.
  expect(said).toContain(`Reconnect: /mcp reconnect claude-in-chrome runs once this turn ends, so ${GO_IDLE} ${WHY_IDLE} Then the session `)
  expect(said).toMatch(/^Left for the person: nothing\.$/m)
  // The start: one short launch, then a look of its own, on the folder whose Google account has Claude Code's email.
  expect(starts).toHaveLength(1)
  expect(argumentsOf(starts[0] ?? '')).toBe(`--profile-directory="Profile 3" --restore-last-session ${FLAG}`)
  expect(scripts.at(-2)).toContain('Start-Sleep -Milliseconds 700')
  // Windows PowerShell by its known path, the script on standard input; .claude.json beside the home folder's .claude,
  // and Local State in Chrome's user data folder, each read once.
  expect(argvs[0]?.[0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  expect(reads).toEqual([CLAIM_WINDOWS, LOCAL_STATE_WINDOWS])
  heldToFolders(said, fakes)
  expect(killsAnything(scripts, argvs)).toBe(false)
  // The start's lock is let go after the wait, under the start's own claim.
  const claim = /^\$claim = '([0-9a-f-]{36})'\r?$/m.exec(starts[0] ?? '')?.[1]
  expect(claim).toBeDefined()
  expect(releases).toHaveLength(1)
  expect(releases[0]).toContain(`$claim = '${claim}'`)
  expect(scripts.at(-1)).toBe(releases[0])

  expect(commands).toEqual([])
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual(['mcp reconnect claude-in-chrome'])
})

test('not running, auto and the variable unset: Chrome starts without the flag', async ($, on) => {
  const fakes = engine(on)
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toContain(`Did: started Chrome, with the profile folder "Profile 3" (its Google account has the email of Claude Code's account), --restore-last-session, without ${FLAG}. It runs as PID 4321.`)
  expect(said).toMatch(/^Flag: off: the silentDebugger setting is auto, and CLAUDE_CHROME_SILENT_DEBUGGER doesn't turn it on/m)
  expect(argumentsOf(fakes.starts[0] ?? '')).toBe('--profile-directory="Profile 3" --restore-last-session')
  heldToFolders(said, fakes)
})

test('the setting on overrides an unset variable: Chrome starts with the flag', { options: { silentDebugger: 'on' } }, async ($, on) => {
  const fakes = engine(on)
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Flag: on: the silentDebugger setting is on\.$/m)
  expect(argumentsOf(fakes.starts[0] ?? '')).toContain(FLAG)
  heldToFolders(said, fakes)
})

test('the setting off overrides the variable: Chrome starts without the flag', { options: { silentDebugger: 'off' } }, async ($, on) => {
  const fakes = engine(on, { env: { CLAUDE_CHROME_SILENT_DEBUGGER: 'true' } })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Flag: off: the silentDebugger setting is off\.$/m)
  expect(argumentsOf(fakes.starts[0] ?? '')).not.toContain(FLAG)
  heldToFolders(said, fakes)
})

// ---------------------------------------------------------------------------------------------
// Chrome running.

test('running with the flag: nothing to do, nothing started', async ($, on) => {
  const fakes = engine(on, { env: { CLAUDE_CHROME_SILENT_DEBUGGER: 'on' }, running: [{ pid: 777, cmd: `"${CHROME}" --profile-directory="Profile 3" ${FLAG}` }] })
  const { scripts, starts, argvs } = fakes
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Chrome: running \(PID 777\); with --silent-debugger-extension-api; its command line names the profile folder "Profile 3"\.$/m)
  expect(said).toMatch(/^Did: nothing: Chrome runs, with the flag\.$/m)
  expect(said).toMatch(/^Left for the person: nothing\.$/m)
  expect(scripts).toHaveLength(1)
  expect(starts).toEqual([])
  expect(killsAnything(scripts, argvs)).toBe(false)
  heldToFolders(said, fakes)
})

test('running without the flag while opted in: it says so and how the person fixes it, and never quits, kills or restarts Chrome', async ($, on) => {
  const fakes = engine(on, { env: { CLAUDE_CHROME_SILENT_DEBUGGER: '1' }, running: [{ pid: 777, cmd: `"${CHROME}" --restore-last-session` }] })
  const { scripts, starts, argvs, commands, clock } = fakes
  await $.session.start(START)
  const said = await ensure($)
  heldToFolders(said, fakes)
  expect(said).toMatch(/^Chrome: running \(PID 777\); without --silent-debugger-extension-api; its command line names no profile folder/m)
  expect(said).toContain("Did: nothing to Chrome. Chrome takes flags only when it starts, and this tool never quits, kills or restarts Chrome: that would close every session's tabs and tab groups.")
  expect(said).toMatch(/Left for the person: for the flag, quit Chrome fully .*then call chrome_ensure again; or add --silent-debugger-extension-api to the Target of the shortcut/)
  expect(said).toMatch(/so it is the person's call\.$/m)
  // One look, and nothing else: no start, no quit, no kill.
  expect(scripts).toHaveLength(1)
  expect(starts).toEqual([])
  expect(killsAnything(scripts, argvs)).toBe(false)
  // Chrome runs, so Claude in Chrome is still reconnected.
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual(['mcp reconnect claude-in-chrome'])
})

test('running without the flag and the flag off: nothing to do', async ($, on) => {
  const fakes = engine(on, { running: [{ pid: 777, cmd: `"${CHROME}"` }] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: nothing: Chrome runs, and the flag is off\.$/m)
  expect(said).toMatch(/^Left for the person: nothing\.$/m)
  expect(fakes.starts).toEqual([])
  heldToFolders(said, fakes)
})

test('a Chrome in the background with no window counts as running, and is said plainly', async ($, on) => {
  const fakes = engine(on, { running: [{ pid: 640, cmd: `"${CHROME}" --no-startup-window --win-session-start` }] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Chrome: running \(PID 640\), in the background with no window\. That counts as running: a start now would only hand off to it, and Chrome took its flags when it started; without --silent-debugger-extension-api; its command line names no profile folder\.$/m)
  // A Chrome in the background names no "profile it used last": it opened no window.
  expect(said).toMatch(/^Profile: Chrome's command line names no profile folder, so it can't tell whether that is "Profile 3", /m)
  expect(fakes.starts).toEqual([])
  heldToFolders(said, fakes)
})

test("a test or isolated Chrome with its own --user-data-dir isn't the person's: Chrome starts beside it", async ($, on) => {
  const fakes = engine(on, { running: [{ pid: 55, cmd: `"${CHROME}" --user-data-dir="C:\\Temp\\playwright-1" --remote-debugging-port=0` }] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Chrome: not running\. 1 other Chrome, with its own --user-data-dir \(a test or isolated Chrome\), isn't counted\.$/m)
  expect(said).toMatch(/Did: started Chrome/)
  // The isolated one's path never reaches the answer.
  expect(said).not.toContain('playwright')
  expect(fakes.starts).toHaveLength(1)
  heldToFolders(said, fakes)
})

test("a chrome.exe whose command line can't be read (an elevated Chrome) leaves the look unable to tell: nothing started", async ($, on) => {
  const { starts, commands, clock } = engine(on, { running: [{ pid: 90, exe: '', cmd: '' }] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Chrome: can't tell whether it runs \(1 Chrome process of this login has a command line that can't be read, as an elevated Chrome's can't\)\.$/m)
  expect(starts).toEqual([])
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual([])
})

test("the person's Chrome started with its own default folder named is still the person's", () => {
  const procs = [{ pid: 9, exe: CHROME, cmd: `"${CHROME}" --user-data-dir="${USER_DATA}\\" ${FLAG}` }]
  expect(judge(procs, { platform: 'windows', paths: [CHROME], userData: USER_DATA })).toEqual({ browsers: [browser(9, true)], isolated: 0, unreadable: 0 })
})

test("a child process (--type=) is never the browser, nor another program's chrome.exe; an unreadable one is counted apart", () => {
  const procs = [
    { pid: 10, exe: CHROME, cmd: `"${CHROME}" --type=renderer --profile-directory="Default"` },
    { pid: 11, exe: CHROME, cmd: `"${CHROME}" "--type=crashpad-handler"` },
    { pid: 12, exe: 'C:\\Tools\\ms-playwright\\chromium-1\\chrome-win\\chrome.exe', cmd: '"C:\\Tools\\ms-playwright\\chromium-1\\chrome-win\\chrome.exe"' },
    // ExecutablePath unread: the command line's first argument says which chrome.exe.
    { pid: 13, exe: '', cmd: `"${CHROME.toUpperCase()}" --profile-directory=Default` },
    { pid: 14, exe: '', cmd: '' },
  ]
  expect(judge(procs, { platform: 'windows', paths: [CHROME], userData: USER_DATA })).toEqual({ browsers: [browser(13, false, { profile: 'Default', namesProfile: true })], isolated: 0, unreadable: 1 })
})

test("a command line's switches, on Windows and on macOS", () => {
  expect(hasSwitch(`"${CHROME}" ${FLAG}`, FLAG)).toBe(true)
  expect(hasSwitch(`"${CHROME}" "${FLAG}"`, FLAG)).toBe(true)
  expect(hasSwitch(`"${CHROME}" ${FLAG}-not`, FLAG)).toBe(false)
  expect(hasSwitch(`"${CHROME}" --x=${FLAG}`, FLAG)).toBe(false)
  expect(switchValue(`"${CHROME}" --profile-directory="Profile 10" ${FLAG}`, '--profile-directory', 'windows')).toBe('Profile 10')
  expect(switchValue(`"${CHROME}" "--profile-directory=Profile 10"`, '--profile-directory', 'windows')).toBe('Profile 10')
  expect(switchValue(`"${CHROME}" --profile-directory=Default https://example.com`, '--profile-directory', 'windows')).toBe('Default')
  // ps on macOS shows the arguments with their quotes gone: a value runs to the next switch.
  expect(switchValue(`${MAC_CHROME} --profile-directory=Profile 10 ${FLAG}`, '--profile-directory', 'macos')).toBe('Profile 10')
  expect(switchValue(`${MAC_CHROME} --profile-directory=Profile 10`, '--profile-directory', 'macos')).toBe('Profile 10')
  expect(switchValue(`${MAC_CHROME} ${FLAG}`, '--profile-directory', 'macos')).toBeUndefined()
})

// ---------------------------------------------------------------------------------------------
// The profile.

test('which profile a start opens: the call, then the setting, then the account match, and nothing after it; a bad setting is refused by its length, never echoed', () => {
  const badSetting = mail('person')
  const refused = {
    refusal: `the profile setting isn't a profile folder's name (it is ${badSetting.length} characters long)`,
    fix: `set the profile setting to one of Chrome's profile folders, by its folder's name (Default, Profile 2), or empty it, so a start takes ${MATCH}`,
  }
  const rows: [string, [string | undefined, string], ReturnType<typeof chooseProfile>][] = [
    ['the call first, over the setting', ['Work', 'Profile 9'], { profile: 'Work', source: 'call' }],
    ['the call, with no setting', ['Default', ''], { profile: 'Default', source: 'call' }],
    ['the setting, with no call', [undefined, 'Profile 9'], { profile: 'Profile 9', source: 'setting' }],
    ['neither: the account match', [undefined, ''], { source: 'account' }],
    ['a setting that is no folder name, with no call', [undefined, badSetting], refused],
    ['a call over a bad setting', ['Default', badSetting], { profile: 'Default', source: 'call' }],
  ]
  expect(differing(rows, ([asked, setting]) => chooseProfile(asked, setting))).toEqual([])
  expect(JSON.stringify(chooseProfile(undefined, badSetting))).not.toContain('example')
  expect(MATCHED).toBe(MATCH)
})

test("the profile folders listed: plain directory names only, files and other names left out; a missing profile's refusal never names it", () => {
  const entries = [
    { name: 'Profile 3', kind: 'dir' },
    { name: 'Default', kind: 'dir' },
    { name: 'Local State', kind: 'file' },
    { name: 'bad.name', kind: 'dir' },
    { name: 'link', kind: 'other' },
  ]
  expect(profileCandidates(entries)).toEqual(['Default', 'Profile 3'])
  const call = missingProfile('call', ['Default', 'Profile 3'])
  expect(call.why).toBe("the profile asked for in this call names no profile folder in Chrome's user data folder, and Chrome would make a new, empty profile of that name")
  expect(call.fix).toBe(`call chrome_ensure again with \`profile\` set to one of Chrome's profile folders ("Default", "Profile 3"), or leave it out, so a start takes the profile setting, else ${MATCH}`)
  expect(missingProfile('setting', []).fix).toContain('(none was found)')
  expect(missingProfile('setting', undefined).fix).toBe(`set the profile setting to one of Chrome's profile folders, by its folder's name, or empty it, so a start takes ${MATCH}`)
})

test("a call's profile that is one of Chrome's folders is started with, quoted, and neither .claude.json nor Local State is read", { options: { profile: 'Profile 9' } }, async ($, on) => {
  const { starts, reads, stats } = engine(on)
  await $.session.start(START)
  const said = await ensure($, { profile: ' Profile 3 ' })
  expect(said).toContain('with the profile folder "Profile 3" (asked for in this call), --restore-last-session')
  expect(argumentsOf(starts[0] ?? '')).toBe('--profile-directory="Profile 3" --restore-last-session')
  expect([...reads, ...stats]).toEqual([])
})

test("a call's profile that isn't one of Chrome's folders starts nothing (Chrome would make a new, empty profile), and lists the folders that are, never the name asked", async ($, on) => {
  const { starts, lists } = engine(on)
  await $.session.start(START)
  const said = await ensure($, { profile: 'Work' })
  expect(said).toMatch(/^Did: nothing: the profile asked for in this call names no profile folder in Chrome's user data folder, and Chrome would make a new, empty profile of that name\.$/m)
  expect(said).toMatch(/^Left for the person: call chrome_ensure again with `profile` set to one of Chrome's profile folders \("Default", "Profile 3"\), or leave it out/m)
  expect(said).not.toContain('Work')
  expect(said).not.toMatch(/Crashpad|ShaderCache|Stale|bad\.name/)
  expect(lists).toEqual([USER_DATA])
  expect(starts).toEqual([])
})

test("a profile that differs only in case is no profile folder of Chrome's", async ($, on) => {
  const { starts } = engine(on)
  await $.session.start(START)
  expect(await ensure($, { profile: 'default' })).toMatch(/^Did: nothing: the profile asked for in this call names no profile folder/m)
  expect(starts).toEqual([])
})

test("the profile setting is started with when it names one of Chrome's folders, a pin over the account match", { options: { profile: 'Default' } }, async ($, on) => {
  const { starts, reads, stats } = engine(on)
  await $.session.start(START)
  expect(await ensure($)).toContain('with the profile folder "Default" (the profile setting)')
  expect(argumentsOf(starts[0] ?? '')).toBe('--profile-directory="Default" --restore-last-session')
  expect([...reads, ...stats]).toEqual([])
})

test("a profile setting that names no folder of Chrome's starts nothing, and says how to set it", { options: { profile: 'Profile 9' } }, async ($, on) => {
  const { starts } = engine(on)
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: nothing: the profile setting names no profile folder in Chrome's user data folder/m)
  expect(said).toMatch(/^Left for the person: set the profile setting to one of Chrome's profile folders \("Default", "Profile 3"\)/m)
  expect(said).not.toContain('Profile 9')
  expect(starts).toEqual([])
})

test("a profile setting that isn't a folder's name starts nothing, and isn't echoed", { options: { profile: 'person@example.com' } }, async ($, on) => {
  const { starts } = engine(on)
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: nothing: the profile setting isn't a profile folder's name \(it is 18 characters long\)\.$/m)
  expect(said).not.toContain('example')
  expect(starts).toEqual([])
})

test("a call's profile that isn't a folder's name is refused, and nothing runs", async ($, on) => {
  const { scripts } = engine(on)
  await $.session.start(START)
  for (const profile of ['..\\x', 'a"b', 'person@example.com', 7, 'x'.repeat(65)]) {
    expect((await $.tool.call({ tool: TOOL, profile })).deny).toMatch(/profile folder's name/)
  }
  expect((await $.tool.call({ tool: TOOL, reconnect: 'yes' })).deny).toMatch(/true or false/)
  expect(scripts).toEqual([])
})

// ---------------------------------------------------------------------------------------------
// The account match: its pure rules, each a table compared whole.

test("Claude Code's account from a .claude.json's text: oauthAccount's email, with a plain account id; none, or can't tell", () => {
  // The session asked, on the id the file records: the file's own rules decide.
  const same: SessionSignIn = { asked: true, kind: 'claude.ai', accountId: accountId(1) }
  const email = (value: string): ClaudeAccount => ({ kind: 'email', email: value, sessionAsked: true })
  const none: ClaudeAccount = { kind: 'none' }
  const unknown: ClaudeAccount = { kind: 'unknown' }
  const spaced = ` ${OWNER.toUpperCase()} `
  const rows: [string, string, ClaudeAccount][] = [
    ['an account', claimText(accountRecord(OWNER)), email(OWNER)],
    ['a BOM first', `${String.fromCharCode(0xfeff)}${claimText(accountRecord(OWNER))}`, email(OWNER)],
    ['the email as written: the match folds case and spaces', claimText(accountRecord(spaced)), email(spaced)],
    ['no oauthAccount (no login recorded)', claimText(undefined), none],
    ['oauthAccount null (logged out)', claimText(null), none],
    ['oauthAccount an array', claimText([accountRecord(OWNER)]), none],
    ['no accountUuid', claimText({ emailAddress: OWNER }), none],
    ['an accountUuid too short', claimText(accountRecord(OWNER, 'abc')), none],
    ['an accountUuid with a space', claimText(accountRecord(OWNER, 'abcd efgh')), none],
    ['an accountUuid too long', claimText(accountRecord(OWNER, 'a'.repeat(65))), none],
    ['an accountUuid not a string', claimText(accountRecord(OWNER, 12_345_678)), none],
    ['an email not a string', claimText(accountRecord(7)), none],
    ['an email that is an object', claimText(accountRecord({ address: OWNER })), none],
    ['an email with no @', claimText(accountRecord('owner')), none],
    ['an empty email', claimText(accountRecord('')), none],
    ['no email', claimText({ accountUuid: accountId(1) }), none],
    ['not JSON: caught mid-write', '{"oauthAccount": {"accountUuid"', unknown],
    ['empty', '', unknown],
    ['an array', JSON.stringify([accountRecord(OWNER)]), unknown],
    ['a string', JSON.stringify(OWNER), unknown],
    ['null', 'null', unknown],
  ]
  expect(differing(rows, text => claudeAccountOf(text, same))).toEqual([])
  // Nothing else of the file comes out: not the account id, the organization, the name or the rest of the state.
  expect(rows.filter(([, text]) => /planted|0000-/.test(JSON.stringify(claudeAccountOf(text, same)))).map(([name]) => name)).toEqual([])
})

test(".claude.json held against this session's own sign-in: only the same account id lets its email stand; the ids are only compared", () => {
  const file = claimText(accountRecord(OWNER))
  const signIn = (kind: string, id?: string): SessionSignIn => ({ asked: true, kind, accountId: id })
  const rows: [string, [string, SessionSignIn], ClaudeAccount][] = [
    ['claude.ai, the same id', [file, signIn('claude.ai', accountId(1))], { kind: 'email', email: OWNER, sessionAsked: true }],
    ["a host's token, the same id", [file, signIn('oauth-token', accountId(1))], { kind: 'email', email: OWNER, sessionAsked: true }],
    ['claude.ai, another id: the session runs on another account', [file, signIn('claude.ai', accountId(9))], { kind: 'session-other' }],
    ["a host's token, another id", [file, signIn('oauth-token', accountId(9))], { kind: 'session-other' }],
    ['the ids compared whole, case and all', [claimText(accountRecord(OWNER, ID_WITH_LETTERS)), signIn('claude.ai', ID_WITH_LETTERS.toUpperCase())], { kind: 'session-other' }],
    ['the same id with letters', [claimText(accountRecord(OWNER, ID_WITH_LETTERS)), signIn('claude.ai', ID_WITH_LETTERS)], { kind: 'email', email: OWNER, sessionAsked: true }],
    ["a host's token with no id yet: can't be confirmed", [file, signIn('oauth-token')], { kind: 'session-unconfirmed' }],
    ["claude.ai with no id: can't be confirmed", [file, signIn('claude.ai')], { kind: 'session-unconfirmed' }],
    ['an API key: no Claude account', [file, signIn('api-key', accountId(1))], { kind: 'session-none' }],
    ['a Console login: no Claude account', [file, signIn('console', accountId(1))], { kind: 'session-none' }],
    ['no login', [file, signIn('none')], { kind: 'session-none' }],
    ['a cloud provider (bedrock)', [file, signIn('bedrock')], { kind: 'session-none' }],
    ['a cloud provider (vertex)', [file, signIn('vertex')], { kind: 'session-none' }],
    ['a kind this plugin does not know, read as no identity', [file, signIn('some-later-kind', accountId(1))], { kind: 'session-none' }],
    ['an empty kind', [file, signIn('', accountId(1))], { kind: 'session-none' }],
    ['the kind decides before the file is read: no account, whatever the text', ['not json', signIn('api-key')], { kind: 'session-none' }],
    ['the file decides before the ids: no account in it', [claimText(undefined), signIn('claude.ai', accountId(9))], { kind: 'none' }],
    ["not asked (refused, or it failed): the file stands alone, and says so", [file, { asked: false }], { kind: 'email', email: OWNER, sessionAsked: false }],
    ['not asked, no account in the file', [claimText(null), { asked: false }], { kind: 'none' }],
  ]
  expect(differing(rows, ([text, session]) => claudeAccountOf(text, session))).toEqual([])
  // Neither id comes out, whatever the answer.
  expect(rows.filter(([, [text, session]]) => /0000-|abcdef01/i.test(JSON.stringify(claudeAccountOf(text, session)))).map(([name]) => name)).toEqual([])
  // Whether the session may run on a Claude account at all: claude.ai and oauth-token, or not asked.
  const kinds: [string, SessionSignIn, boolean][] = [
    ['claude.ai', signIn('claude.ai'), true],
    ['oauth-token', signIn('oauth-token'), true],
    ['not asked', { asked: false }, true],
    ['console', signIn('console'), false],
    ['api-key', signIn('api-key'), false],
    ['an unknown kind', signIn('Claude.AI'), false],
  ]
  expect(differing(kinds, mayHoldClaudeAccount)).toEqual([])
})

test(".claude.json's place: in CLAUDE_CONFIG_DIR when set and not blank, else the home folder; only a folder placed for sure", () => {
  const rows: [string, [Platform, ClaimEnv], string | undefined][] = [
    ['Windows, CLAUDE_CONFIG_DIR set', ['windows', { configDir: 'C:\\path\\to\\config', userProfile: USERPROFILE }], 'C:\\path\\to\\config\\.claude.json'],
    ['Windows, CLAUDE_CONFIG_DIR with trailing separators', ['windows', { configDir: 'C:\\path\\to\\config\\\\' }], 'C:\\path\\to\\config\\.claude.json'],
    ['Windows, CLAUDE_CONFIG_DIR with forward slashes', ['windows', { configDir: 'C:/path/to/config/' }], 'C:/path/to/config\\.claude.json'],
    ['Windows, a drive root', ['windows', { configDir: 'C:\\' }], 'C:\\.claude.json'],
    ['Windows, CLAUDE_CONFIG_DIR empty: the home folder', ['windows', { configDir: '', userProfile: USERPROFILE }], CLAIM_WINDOWS],
    ['Windows, CLAUDE_CONFIG_DIR blank: the home folder', ['windows', { configDir: '   ', userProfile: USERPROFILE }], CLAIM_WINDOWS],
    ['Windows, USERPROFILE before HOME', ['windows', { userProfile: USERPROFILE, home: 'C:\\path\\to\\home' }], CLAIM_WINDOWS],
    ['Windows, no USERPROFILE: HOME', ['windows', { home: 'C:\\path\\to\\home' }], 'C:\\path\\to\\home\\.claude.json'],
    ['Windows, USERPROFILE empty: HOME', ['windows', { userProfile: '', home: 'C:\\path\\to\\home' }], 'C:\\path\\to\\home\\.claude.json'],
    ['Windows, no folder at all', ['windows', {}], undefined],
    ['Windows, CLAUDE_CONFIG_DIR relative', ['windows', { configDir: 'config', userProfile: USERPROFILE }], undefined],
    ['Windows, drive-relative', ['windows', { configDir: 'C:config' }], undefined],
    ['Windows, rooted with no drive', ['windows', { configDir: '\\path\\to\\config' }], undefined],
    ['Windows, a network path', ['windows', { configDir: '\\\\host\\share\\config' }], undefined],
    ['Windows, a network path with forward slashes', ['windows', { configDir: '//host/share/config' }], undefined],
    ['Windows, a \\\\?\\ path', ['windows', { configDir: '\\\\?\\C:\\path\\to\\config' }], undefined],
    ['Windows, a \\\\.\\ device path', ['windows', { configDir: '\\\\.\\pipe\\config' }], undefined],
    ['Windows, a \\??\\ path', ['windows', { configDir: '\\??\\C:\\path\\to\\config' }], undefined],
    ['Windows, spaces around it', ['windows', { configDir: ' C:\\path\\to\\config' }], undefined],
    ['Windows, a NUL in it', ['windows', { configDir: `C:\\path${String.fromCharCode(0)}\\config` }], undefined],
    ['Windows, a home folder with a space after it', ['windows', { userProfile: `${USERPROFILE} ` }], undefined],
    ['macOS, the home folder', ['macos', { home: HOME }], CLAIM_MAC],
    ['macOS, USERPROFILE is no home folder there', ['macos', { userProfile: HOME }], undefined],
    ['macOS, CLAUDE_CONFIG_DIR with a trailing slash', ['macos', { configDir: '/path/to/config/', home: HOME }], '/path/to/config/.claude.json'],
    ['macOS, the root', ['macos', { home: '/' }], '/.claude.json'],
    ['macOS, CLAUDE_CONFIG_DIR relative', ['macos', { configDir: 'config', home: HOME }], undefined],
    ['macOS, a network path', ['macos', { configDir: '//host/config', home: HOME }], undefined],
    ['macOS, a Windows path', ['macos', { configDir: 'C:\\path\\to\\config', home: HOME }], undefined],
  ]
  expect(differing(rows, ([platform, env]) => claimPathOf(platform, env))).toEqual([])
})

test("each profile folder's Google account from Local State's text: info_cache's user_name alone, never os_crypt or any other key", () => {
  const pair = (folder: string, email: string): ProfileAccount => ({ folder, email })
  const rows: [string, string, ProfileAccount[] | undefined][] = [
    ['two profiles', localStateText(CACHE), [pair('Default', SOMEONE), pair('Profile 3', OWNER)]],
    ['a BOM first', `${String.fromCharCode(0xfeff)}${localStateText(CACHE)}`, [pair('Default', SOMEONE), pair('Profile 3', OWNER)]],
    ['a user_name as written: the match folds case and spaces', localStateText({ Default: signedIn(` ${OWNER} `) }), [pair('Default', ` ${OWNER} `)]],
    ['a folder name PROFILE_NAME refuses', localStateText({ 'bad.name': signedIn(OWNER), '..': signedIn(OWNER), ' Default': signedIn(OWNER), 'Profile 3': signedIn(OWNER) }), [pair('Profile 3', OWNER)]],
    ['no user_name (signed out)', localStateText({ Default: { name: plant(9) }, 'Profile 3': signedIn(OWNER) }), [pair('Profile 3', OWNER)]],
    ['a user_name not a string', localStateText({ Default: signedIn(7), 'Profile 3': signedIn([OWNER]) }), []],
    ['a user_name with no @', localStateText({ Default: signedIn('owner'), 'Profile 3': signedIn('') }), []],
    ['an entry not an object', localStateText({ Default: OWNER, 'Profile 3': [OWNER] }), []],
    ['an empty info_cache', localStateText({}), []],
    ['info_cache an array', localStateText([signedIn(OWNER)]), undefined],
    ['no info_cache', JSON.stringify({ os_crypt: { planted: plant(4) }, profile: { last_used: 'Default' } }), undefined],
    ['no profile', JSON.stringify({ os_crypt: { planted: plant(4) } }), undefined],
    ['not JSON: caught mid-write', '{"profile": {"info_cache"', undefined],
    ['an array', JSON.stringify([localStateText(CACHE)]), undefined],
  ]
  expect(differing(rows, profileAccountsOf)).toEqual([])
  // The planted os_crypt, the other top-level keys, and each profile's other attributes never come out.
  expect(rows.filter(([, text]) => /planted/.test(JSON.stringify(profileAccountsOf(text)) ?? '')).map(([name]) => name)).toEqual([])
})

test('the match: both emails trimmed and lower-cased, compared whole; one, none or several, among profile folders with their Preferences', () => {
  const pair = (folder: string, email: string): ProfileAccount => ({ folder, email })
  const both = ['Default', 'Profile 3']
  const rows: [string, { pairs: ProfileAccount[]; email: string; present: string[] }, AccountPick][] = [
    ['one', { pairs: [pair('Default', SOMEONE), pair('Profile 3', OWNER)], email: OWNER, present: both }, { kind: 'one', folder: 'Profile 3', sessionAsked: true }],
    ['none', { pairs: [pair('Default', SOMEONE), pair('Profile 3', OWNER)], email: mail('nobody'), present: both }, { kind: 'none', absent: 0 }],
    ['several', { pairs: [pair('Profile 3', OWNER), pair('Default', OWNER)], email: OWNER, present: both }, { kind: 'several', folders: both }],
    ['case and spaces aside', { pairs: [pair('Profile 3', ` ${OWNER.toUpperCase()}\t`)], email: ` ${OWNER} `, present: both }, { kind: 'one', folder: 'Profile 3', sessionAsked: true }],
    ['compared whole, never a part', { pairs: [pair('Default', `x${OWNER}`), pair('Profile 3', `${OWNER}.org`)], email: OWNER, present: both }, { kind: 'none', absent: 0 }],
    ['a folder without its Preferences file does not count', { pairs: [pair('Profile 7', OWNER)], email: OWNER, present: both }, { kind: 'none', absent: 1 }],
    ['one of two left once a folder without Preferences is out', { pairs: [pair('Profile 3', OWNER), pair('Profile 7', OWNER)], email: OWNER, present: both }, { kind: 'one', folder: 'Profile 3', sessionAsked: true }],
    ['a folder name PROFILE_NAME refuses, held again', { pairs: [pair('../x', OWNER)], email: OWNER, present: ['../x'] }, { kind: 'none', absent: 1 }],
  ]
  // `present`: the profile folders that pass register.ts's check (a folder of that name, with its Preferences file).
  expect(differing(rows, ({ pairs, email, present }) => accountMatch(accountFolders(pairs, email), present, true))).toEqual([])
  // One carries whether the session was asked, as it was given.
  expect(accountMatch(['Profile 3'], ['Profile 3'], false)).toEqual({ kind: 'one', folder: 'Profile 3', sessionAsked: false })
})

test("a file is read only when its stat shows a plain file, no link, within its cap", () => {
  const stat = (kind: string, size: number, isLink = false) => ({ kind, size, isLink })
  const rows: [string, [ReturnType<typeof stat>, number], FileFault | undefined][] = [
    ['a plain file within the cap', [stat('file', 10), CLAIM_MAX_BYTES], undefined],
    ['a plain file at the cap', [stat('file', CLAIM_MAX_BYTES), CLAIM_MAX_BYTES], undefined],
    ['a plain file over the cap', [stat('file', CLAIM_MAX_BYTES + 1), CLAIM_MAX_BYTES], 'too-big'],
    ["a size that isn't a number", [stat('file', Number.NaN), LOCAL_STATE_MAX_BYTES], 'too-big'],
    ['a link to a plain file', [stat('file', 10, true), CLAIM_MAX_BYTES], 'link'],
    ['a folder', [stat('dir', 0), CLAIM_MAX_BYTES], 'not-file'],
    ['another kind', [stat('other', 0), CLAIM_MAX_BYTES], 'not-file'],
  ]
  expect(differing(rows, ([s, max]) => fileFault(s, max))).toEqual([])
  expect([CLAIM_MAX_BYTES, LOCAL_STATE_MAX_BYTES]).toEqual([4 * 1024 * 1024, 4 * 1024 * 1024])
})

// ---------------------------------------------------------------------------------------------
// The account match through the plugin: each answer for a start, and for a Chrome that runs. Every answer holds no
// email, no @ and no path, and the plugin reads .claude.json and Local State alone.

/** A start's case: its world, the answer's lines it must hold, and the files it reads (left out: both). */
type StartCase = {
  readonly name: string
  readonly world?: World
  readonly lines: readonly string[]
  readonly started: boolean
  readonly reads?: readonly string[]
  /** How many times the session's sign-in is asked (left out: once). */
  readonly asks?: number
}

const PIN = "Left for the person: pin the profile: call chrome_ensure again with `profile` set to one of Chrome's profile folders (\"Default\", \"Profile 3\"), or set the profile setting to one."
const NOT_PICKED = `Did: nothing: ${MATCH} can't be picked:`
const STARTED_ON_3 = `Did: started Chrome, with the profile folder "Profile 3" (its Google account has the email of Claude Code's account), --restore-last-session, without ${FLAG}. It runs as PID 4321.`
/** The fixed words said when Claude Code didn't answer for the session's own sign-in, so .claude.json stood alone. */
const FILE_ONLY_WORDS = "Claude Code's account was taken from .claude.json alone: Claude Code didn't answer for this session's own sign-in"
const STARTED_ON_3_BY_FILE = `Did: started Chrome, with the profile folder "Profile 3" (its Google account has the email of Claude Code's account; ${FILE_ONLY_WORDS}), --restore-last-session, without ${FLAG}. It runs as PID 4321.`
const NO_ACCOUNT_IN_FILE = `${NOT_PICKED} Claude Code's .claude.json records no Claude account with an email.`
const SESSION_NONE = `${NOT_PICKED} this session isn't signed in to a Claude account (Claude Code calls its sign-in an API key, a Console login, a cloud provider or no login, or a kind this plugin reads as none).`
const AGAIN_OR_PIN = `Left for the person: call chrome_ensure again in a moment, or ${PIN.slice('Left for the person: '.length)}`

const START_CASES: readonly StartCase[] = [
  { name: 'exactly one folder matches: the start opens it', lines: [STARTED_ON_3], started: true },
  { name: 'case and spaces aside, one folder matches', world: { localState: { text: localStateText({ Default: signedIn(SOMEONE), 'Profile 3': signedIn(` ${OWNER.toUpperCase()} `) }) } }, lines: [STARTED_ON_3], started: true },
  {
    name: 'no folder matches: nothing starts, and the profile folders there are listed',
    world: { localState: { text: localStateText({ Default: signedIn(SOMEONE), 'Profile 3': signedIn(mail('another')) }) } },
    lines: [`${NOT_PICKED} no profile folder's Google account has it.`, PIN],
    started: false,
  },
  {
    name: 'several folders match: nothing starts, and the matching ones are listed',
    world: { localState: { text: localStateText({ Default: signedIn(OWNER), 'Profile 3': signedIn(OWNER) }) } },
    lines: [`${NOT_PICKED} 2 profile folders' Google accounts have it ("Default", "Profile 3"), and it doesn't guess.`, PIN],
    started: false,
  },
  {
    name: 'the one folder that matches has no Preferences file: it does not count',
    world: { localState: { text: localStateText({ Default: signedIn(SOMEONE), 'Profile 7': signedIn(OWNER) }) } },
    lines: [`${NOT_PICKED} no profile folder's Google account has it (1 folder Local State lists with it has no Preferences file, so it doesn't count).`, PIN],
    started: false,
  },
  {
    name: 'of two that match, the one without Preferences is out: the other starts',
    world: { localState: { text: localStateText({ 'Profile 3': signedIn(OWNER), 'Profile 7': signedIn(OWNER) }) } },
    lines: [STARTED_ON_3],
    started: true,
  },
  {
    name: 'no account in .claude.json: nothing starts, and Local State is not read',
    world: { claim: { text: claimText(undefined) } },
    lines: [NO_ACCOUNT_IN_FILE, PIN],
    started: false,
    reads: [CLAIM_WINDOWS],
  },
  {
    name: 'an account id that is no plain id is no account',
    world: { claim: { text: claimText(accountRecord(OWNER, 'not an id')) } },
    lines: [NO_ACCOUNT_IN_FILE, PIN],
    started: false,
    reads: [CLAIM_WINDOWS],
  },
  {
    name: ".claude.json caught mid-write: can't tell, and it says to call again",
    world: { claim: { text: '{"oauthAccount": {"accountUuid"' } },
    lines: [`${NOT_PICKED} Claude Code's .claude.json doesn't read as a JSON object just now (caught mid-write, say).`, AGAIN_OR_PIN],
    started: false,
    reads: [CLAIM_WINDOWS],
  },
  { name: "a host's token on the account .claude.json records: the start opens the match", world: { identity: { kind: 'oauth-token', accountId: accountId(1) } }, lines: [STARTED_ON_3], started: true },
  {
    name: 'the session on another account than .claude.json records: nothing starts, and Local State is not read',
    world: { identity: { kind: 'claude.ai', accountId: accountId(9) } },
    lines: [`${NOT_PICKED} this session runs on another account than the one .claude.json records.`, PIN],
    started: false,
    reads: [CLAIM_WINDOWS],
  },
  {
    name: "a host's token that names no account id: can't be confirmed, and the fix is a pin",
    world: { identity: { kind: 'oauth-token' } },
    lines: [`${NOT_PICKED} this session's own sign-in names no account id (a token its host handed it, before the server answered, say), so the one .claude.json records can't be confirmed.`, PIN],
    started: false,
    reads: [CLAIM_WINDOWS],
  },
  { name: 'the session on an API key: no Claude account, and neither file is read', world: { identity: { kind: 'api-key' } }, lines: [SESSION_NONE, PIN], started: false, reads: [] },
  { name: 'the session on a Console login: no Claude account', world: { identity: { kind: 'console', accountId: accountId(1) } }, lines: [SESSION_NONE, PIN], started: false, reads: [] },
  { name: 'the session with no login: no Claude account', world: { identity: { kind: 'none' } }, lines: [SESSION_NONE, PIN], started: false, reads: [] },
  { name: 'the session on a cloud provider: no Claude account', world: { identity: { kind: 'bedrock' } }, lines: [SESSION_NONE, PIN], started: false, reads: [] },
  { name: 'the session on a kind this plugin does not know: read as no identity', world: { identity: { kind: 'some-later-kind', accountId: accountId(1) } }, lines: [SESSION_NONE, PIN], started: false, reads: [] },
  { name: "the session's sign-in refused (privacy): .claude.json stands alone, and the answer says so", world: { identity: 'denied' }, lines: [STARTED_ON_3_BY_FILE], started: true },
  { name: "the session's sign-in call throws: .claude.json stands alone, and the answer says so", world: { identity: 'throws' }, lines: [STARTED_ON_3_BY_FILE], started: true },
  {
    name: "Chrome's user data folder can't be listed: nothing is asked or read, and no false reason is given",
    world: { listFails: true },
    lines: [`${NOT_PICKED} Chrome's user data folder can't be listed, so no profile folder can be checked.`, "Left for the person: call chrome_ensure again in a moment, or start Chrome by hand, on the profile whose Claude in Chrome is signed in to Claude Code's account."],
    started: false,
    reads: [],
    asks: 0,
  },
  { name: '.claude.json not there', world: { claim: { fault: 'missing' } }, lines: [`${NOT_PICKED} Claude Code's .claude.json isn't there, or can't be looked at.`, PIN], started: false, reads: [] },
  { name: '.claude.json over the cap: not read', world: { claim: { fault: 'huge' } }, lines: [`${NOT_PICKED} Claude Code's .claude.json is over 4 MiB, which isn't read.`, PIN], started: false, reads: [] },
  { name: '.claude.json a link: not read', world: { claim: { fault: 'link' } }, lines: [`${NOT_PICKED} Claude Code's .claude.json is a link, which isn't followed.`, PIN], started: false, reads: [] },
  { name: '.claude.json a folder: not read', world: { claim: { fault: 'dir' } }, lines: [`${NOT_PICKED} Claude Code's .claude.json isn't a plain file.`, PIN], started: false, reads: [] },
  { name: ".claude.json whose read fails: the error's path never shown", world: { claim: { fault: 'fails' } }, lines: [`${NOT_PICKED} Claude Code's .claude.json couldn't be read.`, PIN], started: false, reads: [CLAIM_WINDOWS] },
  { name: 'Local State not there', world: { localState: { fault: 'missing' } }, lines: [`${NOT_PICKED} Chrome's Local State isn't there, or can't be looked at.`, PIN], started: false, reads: [CLAIM_WINDOWS] },
  { name: 'Local State over the cap: not read', world: { localState: { fault: 'huge' } }, lines: [`${NOT_PICKED} Chrome's Local State is over 4 MiB, which isn't read.`, PIN], started: false, reads: [CLAIM_WINDOWS] },
  { name: 'Local State a link: not read', world: { localState: { fault: 'link' } }, lines: [`${NOT_PICKED} Chrome's Local State is a link, which isn't followed.`, PIN], started: false, reads: [CLAIM_WINDOWS] },
  { name: 'Local State a folder: not read', world: { localState: { fault: 'dir' } }, lines: [`${NOT_PICKED} Chrome's Local State isn't a plain file.`, PIN], started: false, reads: [CLAIM_WINDOWS] },
  { name: 'Local State whose read fails', world: { localState: { fault: 'fails' } }, lines: [`${NOT_PICKED} Chrome's Local State couldn't be read.`, PIN], started: false, reads: [CLAIM_WINDOWS, LOCAL_STATE_WINDOWS] },
  {
    name: 'Local State with no profile list',
    world: { localState: { text: JSON.stringify({ os_crypt: { planted: plant(4) }, profile: { info_cache: [] } }) } },
    lines: [`${NOT_PICKED} Chrome's Local State doesn't read as its list of profiles.`, PIN],
    started: false,
  },
  {
    name: 'CLAUDE_CONFIG_DIR set: .claude.json is read there',
    world: { env: { CLAUDE_CONFIG_DIR: 'C:\\path\\to\\config\\' } },
    lines: [STARTED_ON_3],
    started: true,
    reads: ['C:\\path\\to\\config\\.claude.json', LOCAL_STATE_WINDOWS],
  },
  {
    name: 'CLAUDE_CONFIG_DIR relative: nothing is read',
    world: { env: { CLAUDE_CONFIG_DIR: 'config' } },
    lines: [`${NOT_PICKED} Claude Code's .claude.json can't be placed for sure (CLAUDE_CONFIG_DIR, or the home folder, isn't an absolute local path).`, PIN],
    started: false,
    reads: [],
  },
  {
    name: 'CLAUDE_CONFIG_DIR a network path: nothing is read',
    world: { env: { CLAUDE_CONFIG_DIR: '\\\\host\\share\\config' } },
    lines: [`${NOT_PICKED} Claude Code's .claude.json can't be placed for sure (CLAUDE_CONFIG_DIR, or the home folder, isn't an absolute local path).`, PIN],
    started: false,
    reads: [],
  },
]

for (const c of START_CASES) {
  test(`not running, no profile named: ${c.name}`, async ($, on) => {
    const fakes = engine(on, c.world ?? {})
    await $.session.start(START)
    const said = await ensure($)
    const lines = said.split('\n')
    expect(c.lines.filter(line => !lines.includes(line))).toEqual([])
    expect(fakes.starts).toHaveLength(c.started ? 1 : 0)
    if (c.started) expect(argumentsOf(fakes.starts[0] ?? '')).toBe('--profile-directory="Profile 3" --restore-last-session')
    else expect(said).toMatch(/^Reconnect: not queued: Chrome isn't known to run\./m)
    expect(fakes.reads).toEqual([...(c.reads ?? [CLAIM_WINDOWS, LOCAL_STATE_WINDOWS])])
    expect(fakes.identityAsks()).toBe(c.asks ?? 1)
    heldToFolders(said, fakes)
  })
}

/** A running Chrome's case: its command line's switches, its world, and the Profile line (and what is left) it must say. */
type RunningCase = { readonly name: string; readonly args: string; readonly world?: World; readonly line: string; readonly left: string }

const RUNNING_CASES: readonly RunningCase[] = [
  { name: 'started on the matched folder', args: '--profile-directory="Profile 3"', line: `Profile: Chrome was started on "Profile 3", ${MATCH}.`, left: 'Left for the person: nothing.' },
  {
    name: 'started on another folder: both named, and opening the matched one is the person\'s',
    args: '--profile-directory=Default',
    line: `Profile: Chrome was started on "Default", but ${MATCH} is "Profile 3". A window opened from Chrome's profile menu shows on no command line, so that profile may be open already.`,
    left: 'Left for the person: open the profile "Profile 3" from Chrome\'s profile menu, if it isn\'t open already: this tool never opens a profile in a Chrome that runs.',
  },
  {
    name: "started with no --profile-directory: the command line can't tell",
    args: '--restore-last-session',
    line: `Profile: Chrome's command line names no profile folder (Chrome opened the profile it used last), so it can't tell whether that is "Profile 3", ${MATCH}.`,
    left: 'Left for the person: nothing.',
  },
  {
    name: "a read that fails: it can't tell, and why, and the tool answers",
    args: '--profile-directory="Profile 3"',
    world: { claim: { fault: 'missing' } },
    line: `Profile: can't tell whether Chrome runs on ${MATCH}: Claude Code's .claude.json isn't there, or can't be looked at.`,
    left: 'Left for the person: nothing.',
  },
  {
    name: "the session's sign-in refused: .claude.json stands alone, and the line says so",
    args: '--profile-directory="Profile 3"',
    world: { identity: 'denied' },
    line: `Profile: Chrome was started on "Profile 3", ${MATCH}. ${FILE_ONLY_WORDS}.`,
    left: 'Left for the person: nothing.',
  },
  {
    name: "the session on another account than .claude.json records: it can't tell",
    args: '--profile-directory="Profile 3"',
    world: { identity: { kind: 'claude.ai', accountId: accountId(9) } },
    line: `Profile: can't tell whether Chrome runs on ${MATCH}: this session runs on another account than the one .claude.json records.`,
    left: 'Left for the person: nothing.',
  },
  {
    name: "several folders match: it can't tell",
    args: '--profile-directory="Profile 3"',
    world: { localState: { text: localStateText({ Default: signedIn(OWNER), 'Profile 3': signedIn(OWNER) }) } },
    line: `Profile: can't tell whether Chrome runs on ${MATCH}: 2 profile folders' Google accounts have it ("Default", "Profile 3"), and it doesn't guess.`,
    left: 'Left for the person: nothing.',
  },
]

for (const c of RUNNING_CASES) {
  test(`running, no profile named: ${c.name}`, async ($, on) => {
    const fakes = engine(on, { ...c.world, running: [{ pid: 777, cmd: `"${CHROME}" ${c.args}` }] })
    await $.session.start(START)
    const said = await ensure($)
    const lines = said.split('\n')
    expect([c.line, c.left].filter(line => !lines.includes(line))).toEqual([])
    // The Profile line follows the Chrome line; nothing is started, and the reconnect is queued as ever.
    expect(lines[1]).toBe(c.line)
    expect(fakes.starts).toEqual([])
    expect(fakes.scripts).toHaveLength(1)
    expect(said).toMatch(/^Reconnect: \/mcp reconnect claude-in-chrome runs once this turn ends/m)
    heldToFolders(said, fakes)
  })
}

test('running, the profile setting names one: no Profile line, and neither file is read', { options: { profile: 'Default' } }, async ($, on) => {
  const fakes = engine(on, { running: [{ pid: 777, cmd: `"${CHROME}" --profile-directory=Default` }] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).not.toMatch(/^Profile:/m)
  expect([...fakes.reads, ...fakes.stats]).toEqual([])
})

test("running, the call names one: no Profile line, and neither file is read", async ($, on) => {
  const fakes = engine(on, { running: [{ pid: 777, cmd: `"${CHROME}"` }] })
  await $.session.start(START)
  const said = await ensure($, { profile: 'Default' })
  expect(said).not.toMatch(/^Profile:/m)
  expect([...fakes.reads, ...fakes.stats]).toEqual([])
})

test("a named profile when Chrome's user data folder can't be listed: nothing starts, and no false reason is given", async ($, on) => {
  const fakes = engine(on, { listFails: true })
  await $.session.start(START)
  const said = await ensure($, { profile: 'Profile 3' })
  const lines = said.split('\n')
  const want = [
    "Did: nothing: Chrome's user data folder can't be listed, so the profile named can't be checked against Chrome's profile folders.",
    'Left for the person: call chrome_ensure again in a moment, or start Chrome by hand on that profile.',
  ]
  expect(want.filter(line => !lines.includes(line))).toEqual([])
  expect(fakes.starts).toEqual([])
  expect([...fakes.reads, ...fakes.stats]).toEqual([])
  expect(fakes.identityAsks()).toBe(0)
  heldToFolders(said, fakes)
})

test("macOS with no home folder, a named profile: Chrome's user data folder isn't known, so nothing starts, and nothing is read", async ($, on) => {
  const fakes = engine(on, { platform: 'macos', env: { HOME: '' } })
  await $.session.start(START)
  const said = await ensure($, { profile: 'Profile 3' })
  const lines = said.split('\n')
  const want = [
    "Did: nothing: Chrome's user data folder isn't known here, so the profile named can't be checked against Chrome's profile folders.",
    'Left for the person: start Chrome by hand on that profile.',
  ]
  expect(want.filter(line => !lines.includes(line))).toEqual([])
  expect(fakes.argvs.some(a => a[0] === '/usr/bin/open')).toBe(false)
  expect(fakes.reads).toEqual([])
  expect(fakes.lists).toEqual([])
  expect(fakes.identityAsks()).toBe(0)
  heldToFolders(said, fakes)
})

test("macOS with no home folder, nothing named: the match can't check a folder, so nothing starts, and nothing is read", async ($, on) => {
  const fakes = engine(on, { platform: 'macos', env: { HOME: '' } })
  await $.session.start(START)
  const said = await ensure($)
  const lines = said.split('\n')
  const want = [
    `${NOT_PICKED} Chrome's user data folder isn't known here, so its Local State can't be read.`,
    "Left for the person: start Chrome by hand, on the profile whose Claude in Chrome is signed in to Claude Code's account.",
  ]
  expect(want.filter(line => !lines.includes(line))).toEqual([])
  expect(fakes.argvs.some(a => a[0] === '/usr/bin/open')).toBe(false)
  expect(fakes.reads).toEqual([])
  expect(fakes.lists).toEqual([])
  expect(fakes.identityAsks()).toBe(0)
  heldToFolders(said, fakes)
})

// ---------------------------------------------------------------------------------------------
// Starts that don't go as planned.

test('the flag asked for but not taken: it says so, and how the person adds it', async ($, on) => {
  const fakes = engine(on, { env: { CLAUDE_CHROME_SILENT_DEBUGGER: '1' }, after: [{ pid: 4321, cmd: `"${CHROME}"` }] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/It runs as PID 4321, but without the flag: a Chrome already starting may have taken the launch\./)
  expect(said).toMatch(/^Left for the person: for the flag, quit Chrome fully/m)
  heldToFolders(said, fakes)
})

test('a launch that handed off to a Chrome already starting is said: the PID found is not the one launched', async ($, on) => {
  const fakes = engine(on, { launchedPid: 9999 })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: launched Chrome, with .+, but the launch handed off to a Chrome that was starting already: it runs as PID 4321\.$/m)
  heldToFolders(said, fakes)
})

test('a launch Windows names no process for is still looked for', async ($, on) => {
  const fakes = engine(on, { startRun: 'no-pid' })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: started Chrome, with .+\. It runs as PID 4321\.$/m)
  heldToFolders(said, fakes)
})

test('started, but no browser process within 20 s: it says so after its looks, and the reconnect still goes', async ($, on) => {
  const fakes = engine(on, { after: [] })
  const { scripts, commands, clock } = fakes
  await $.session.start(START)
  const said = await ensure($)
  heldToFolders(said, fakes)
  expect(said).toMatch(/Did: asked Chrome to start, with .+, but no browser process of it showed within 20 s\./)
  // The first look, the start, then 20 looks of its own, each after a pause: never one long run; then the release.
  expect(scripts).toHaveLength(23)
  expect(scripts.slice(2, 22).every(s => s.includes('Start-Sleep -Milliseconds 700') && !s.includes('Process]::Start('))).toBe(true)
  expect(scripts[22]).toMatch(/^Free-Lock\r?$/m)
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual(['mcp reconnect claude-in-chrome'])
})

test("a start whose answer never came isn't a failed start: the looks find Chrome, and the answer says so", async ($, on) => {
  const fakes = engine(on, { startRun: 'hangs' })
  const { commands, clock } = fakes
  await $.session.start(START)
  const said = await ensure($)
  heldToFolders(said, fakes)
  expect(said).toMatch(/^Did: started Chrome, with .+; the start's own answer didn't come \(the start didn't answer \(.*still running after 30000 ms.*\)\)\. It runs as PID 4321\.$/m)
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual(['mcp reconnect claude-in-chrome'])
})

test('a start whose answer never came, and no browser after: nothing is said to run, and no reconnect is queued', async ($, on) => {
  const fakes = engine(on, { startRun: 'hangs', after: [] })
  const { commands, clock } = fakes
  await $.session.start(START)
  const said = await ensure($)
  heldToFolders(said, fakes)
  expect(said).toMatch(/^Did: asked Chrome to start, with .+; the start's own answer didn't come \(.+\), but no browser process of it showed within 20 s\.$/m)
  expect(said).toMatch(/^Reconnect: not queued: Chrome isn't known to run\./m)
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual([])
})

test('a start that fails says why, after one look, and queues no reconnect', async ($, on) => {
  const fakes = engine(on, { startRun: 'fails', after: [] })
  const { scripts } = fakes
  await $.session.start(START)
  const said = await ensure($)
  heldToFolders(said, fakes)
  expect(said).toMatch(/^Did: tried to start Chrome, but the start exited 1: Exception calling "Start" with "1" argument\(s\): "The system cannot find the file specified"\.$/m)
  expect(said).toMatch(/^Left for the person: start Chrome by hand\.$/m)
  expect(said).toMatch(/^Reconnect: not queued/m)
  // The look, the start, one look, and the release.
  expect(scripts).toHaveLength(4)
})

test('a Chrome that came up between the look and the start is never started again', async ($, on) => {
  const { starts, releases } = engine(on, { startRun: 'running', after: [{ pid: 808, cmd: `"${CHROME}" ${FLAG}` }] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: nothing: Chrome came up just before the start \(another session's start, or the person's\), PID 808, with the flag\.$/m)
  expect(starts).toHaveLength(1)
  // The start's own script let its lock go.
  expect(releases).toEqual([])
})

test("another session's start holding the lock: this call launches nothing, waits for it, and says what it found", async ($, on) => {
  const { starts, releases } = engine(on, { startRun: 'held', after: [], appear: { after: 2, procs: [{ pid: 515, cmd: `"${CHROME}" --restore-last-session` }] } })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: nothing: another session was starting Chrome, which runs as PID 515, without the flag\.$/m)
  // Its start script found the lock held, and launched nothing; the lock is the other start's to let go.
  expect(starts).toHaveLength(1)
  expect(releases).toEqual([])
})

test("another session's start that shows no browser: this call says so, and asks to call again later", async ($, on) => {
  engine(on, { startRun: 'held', after: [] })
  await $.session.start(START)
  expect(await ensure($)).toMatch(/^Did: nothing: another session is starting Chrome, and no browser process of it showed within 20 s\.$/m)
})

test("an environment that isn't the login's exactly launches nothing, and the answer names no variable", async ($, on) => {
  const { scripts, releases, commands, clock } = engine(on, { startRun: 'mismatch', after: [] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: tried to start Chrome, but the environment it would have started Chrome with wasn't the login environment exactly, so it launched nothing \(it never hands Chrome the session's\)\.$/m)
  expect(said).toMatch(/^Reconnect: not queued/m)
  // No look after it: nothing was launched, for sure; the start's own script let its lock go.
  expect(scripts).toHaveLength(2)
  expect(releases).toEqual([])
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual([])
})

test('a lock is stale once older than a start can take', () => {
  expect(START_LOCK_MS).toBeGreaterThanOrEqual(30_000 + 20_000 + 30_000)
  expect(isStaleLock(NOW - START_LOCK_MS - 1, NOW)).toBe(true)
  expect(isStaleLock(NOW - START_LOCK_MS, NOW)).toBe(false)
  expect(isStaleLock(NOW, NOW)).toBe(false)
  expect(macLockPath(HOME)).toBe(`${HOME}/Library/Caches/claude-self-tools/chrome-start.lock`)
  expect(macLockPath(undefined)).toBeUndefined()
})

test("Chrome not installed at its standard paths: nothing started, and the setting that fixes it named", async ($, on) => {
  const { starts, commands, clock } = engine(on, { start: null })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: nothing: Chrome isn't at its standard install paths/m)
  expect(said).toMatch(/^Left for the person: set the chromePath setting to chrome\.exe's absolute path\.$/m)
  expect(said).toMatch(/^Reconnect: not queued: Chrome isn't known to run\./m)
  expect(starts).toEqual([])
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual([])
})

test('the look fails: nothing started, nothing queued', async ($, on) => {
  const { scripts, commands, clock } = engine(on, { look: 'fails' })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Chrome: can't tell whether it runs \(the look exited 1: Get-CimInstance : Access denied\)\.$/m)
  expect(said).toMatch(/^Did: nothing\. It starts Chrome only when it can see that Chrome isn't running\.$/m)
  expect(said).toMatch(/^Reconnect: not queued/m)
  expect(scripts).toHaveLength(1)
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual([])
})

test("an answer from the look the plugin can't read starts nothing", async ($, on) => {
  const { scripts } = engine(on, { look: 'garbled' })
  await $.session.start(START)
  expect(await ensure($)).toMatch(/^Chrome: can't tell whether it runs \(the look's answer isn't the line it writes\)\.$/m)
  expect(scripts).toHaveLength(1)
})

test('a chromePath setting that is no chrome.exe runs nothing', { options: { chromePath: 'C:\\Tools\\other.exe' } }, async ($, on) => {
  const { scripts } = engine(on)
  await $.session.start(START)
  expect(await ensure($)).toMatch(/the chromePath setting does not end in \\chrome\.exe/)
  expect(scripts).toEqual([])
})

test('a chromePath setting with [, ] or a backtick runs nothing: PowerShell would read it as a wildcard', { options: { chromePath: 'C:\\Tools\\Chrome[1]\\chrome.exe' } }, async ($, on) => {
  const { scripts } = engine(on)
  await $.session.start(START)
  expect(await ensure($)).toMatch(/the chromePath setting holds \[, \] or a backtick/)
  expect(scripts).toEqual([])
  expect(windowsChromeFault('C:\\Tools\\Chro`me\\chrome.exe')).toBeDefined()
})

// ---------------------------------------------------------------------------------------------
// The reconnect.

test("the reconnect is queued whenever Chrome runs, though Claude in Chrome's tools are listed nowhere (a server that dropped lists none)", async ($, on) => {
  const { commands, clock } = engine(on, { running: [{ pid: 777, cmd: `"${CHROME}"` }], tools: ['Bash'] })
  await $.session.start(START)
  expect(await ensure($)).toMatch(/^Reconnect: \/mcp reconnect claude-in-chrome runs once this turn ends/m)
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual(['mcp reconnect claude-in-chrome'])
})

test('reconnect false queues nothing', async ($, on) => {
  const { commands, clock } = engine(on, { running: [{ pid: 777, cmd: `"${CHROME}"` }] })
  await $.session.start(START)
  expect(await ensure($, { reconnect: false })).toMatch(/^Reconnect: not asked for \(reconnect is false\)\.$/m)
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual([])
})

test('at most 3 reconnects in 10 minutes: the fourth says to ask the person, and queues nothing; 10 minutes on, one goes again', async ($, on) => {
  const { commands, clock } = engine(on, { running: [{ pid: 777, cmd: `"${CHROME}"` }] })
  await $.session.start(START)
  for (let i = 1; i <= 3; i += 1) {
    expect(await ensure($, { resume: 'Try the tab again.' })).toMatch(/^Reconnect: \/mcp reconnect/m)
    await $.turn.complete({ ...ANSWERED, turnId: `t${i}` })
    await clock.advance(MINUTE)
  }
  expect(commands).toHaveLength(3)
  const fourth = await ensure($, { resume: 'Try the tab again.' })
  expect(fourth).toMatch(/^Reconnect: not queued: this session has queued 3 reconnects of Claude in Chrome in the last 10 minutes, and it still isn't connected\. Ask the person rather than call chrome_ensure again\.$/m)
  expect(fourth).toMatch(/^Left for the person: check that Claude in Chrome is turned on, and signed in, in the Chrome profile it should use\.$/m)
  await $.turn.complete({ ...ANSWERED, turnId: 't4' })
  await clock.advance(MINUTE)
  expect(commands).toHaveLength(3)
  await clock.advance(10 * MINUTE)
  expect(await ensure($)).toMatch(/^Reconnect: \/mcp reconnect/m)
})

test('two calls in one turn queue one reconnect, counted once, with the last resume', async ($, on) => {
  const { commands, prompts, clock } = engine(on, { running: [{ pid: 777, cmd: `"${CHROME}"` }] })
  await $.session.start(START)
  await ensure($, { resume: 'First.' })
  await ensure($, { resume: 'Second.' })
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual(['mcp reconnect claude-in-chrome'])
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toMatch(/Resume: Second\.$/)
  for (let i = 2; i <= 3; i += 1) {
    expect(await ensure($)).toMatch(/^Reconnect: \/mcp reconnect/m)
    await $.turn.complete({ ...ANSWERED, turnId: `t${i}` })
  }
})

test("the reconnect's count that can't be written queues nothing, and says so", async ($, on) => {
  const { commands, clock } = engine(on, { running: [{ pid: 777, cmd: `"${CHROME}"` }], stateFails: true })
  await $.session.start(START)
  expect(await ensure($)).toMatch(/^Reconnect: not queued: queuing it failed\.$/m)
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual([])
})

test('with resume, the session resumes once the reconnect has run, saying how many of its tools are listed', async ($, on) => {
  const { commands, prompts, clock } = engine(on, { running: [{ pid: 777, cmd: `"${CHROME}"` }] })
  await $.session.start(START)
  expect(await ensure($, { resume: ' Take the screenshot again. ' })).toMatch(/Then the session resumes with: Take the screenshot again\.$/m)
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual(['mcp reconnect claude-in-chrome'])
  expect(prompts).toEqual(["Claude in Chrome reconnect ran: Claude Code's own line above says whether it reconnected. 1 of its tools is listed now. Resume: Take the screenshot again."])
})

test('without resume, the model is told on its next turn', async ($, on) => {
  const { prompts, session, clock } = engine(on, { running: [{ pid: 777, cmd: `"${CHROME}"` }] })
  await $.session.start(START)
  expect(await ensure($)).toMatch(/Then the session waits for the next message$/m)
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(prompts).toEqual([])
  expect(JSON.stringify(session.appended())).toContain('Claude in Chrome reconnect ran')
})

test("the person's message after the reconnect was queued: its resume goes to the model as a note, never as a turn", async ($, on) => {
  const { commands, prompts, toasts, session, clock } = engine(on, { running: [{ pid: 777, cmd: `"${CHROME}"` }] })
  await $.session.start(START)
  await ensure($, { resume: 'Carry on with X.' })
  await $.prompt.submit({ text: "stop, don't do X", wait: false, origin: { kind: 'composer' }, turnId: 't1' })
  await $.turn.complete(ANSWERED)
  await $.turn.start({ text: "stop, don't do X", turnId: 't2' })
  await $.turn.complete({ ...ANSWERED, turnId: 't2' })
  await clock.advance(1000)
  expect(commands).toEqual(['mcp reconnect claude-in-chrome'])
  expect(prompts.some(p => p.includes('Carry on with X.'))).toBe(false)
  expect(toasts).toContain('Resume not sent: your message came after the reconnect was queued, so the model has it as a note.')
  expect(JSON.stringify(session.appended())).toContain("its resume wasn't sent as a new message. It was: Carry on with X.")
})

test('an interrupted turn cancels the reconnect', async ($, on) => {
  const { commands, toasts, clock } = engine(on, { running: [{ pid: 777, cmd: `"${CHROME}"` }] })
  await $.session.start(START)
  await ensure($)
  await $.turn.complete({ ...ANSWERED, isAborted: true, reason: 'aborted' })
  await clock.advance(1000)
  expect(commands).toEqual([])
  expect(toasts.some(t => /cancelled/.test(t))).toBe(true)
})

test('a subagent is refused, and nothing runs', async ($, on) => {
  const { scripts, commands, clock } = engine(on)
  await $.session.start(START)
  expect((await $.tool.call({ tool: TOOL, agentId: 'a1' })).deny).toMatch(/subagent/)
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(scripts).toEqual([])
  expect(commands).toEqual([])
})

test('the description says it never quits Chrome, to end the turn once the reconnect is queued, and to ask the person when told', async ($, on) => {
  const { described } = engine(on)
  await $.session.start(START)
  const said = described.at(-1) ?? ''
  expect(said).toContain("It never quits, kills or restarts Chrome, which would close every session's tabs and tab groups")
  // #67: the shared words of every tool that queues for the idle moment.
  expect(said).toContain(idleWords('When it says the reconnect is queued'))
  expect(said).toContain(`${GO_IDLE} ${WHY_IDLE}`)
  expect(said).toContain("When it says to ask the person, ask them; don't call it again.")
})

// ---------------------------------------------------------------------------------------------
// The answer's other lines.

test("the answer's other lines: the flag kept though off, more browser processes, and a profile name that isn't plain", () => {
  const off = { on: false, why: 'the silentDebugger setting is off' }
  const read = (browsers: ReturnType<typeof browser>[]) => ({ kind: 'read' as const, judged: { browsers, isolated: 0, unreadable: 0 } })
  const kept = answer({ platform: 'windows', flag: off, look: read([browser(5, true)]), start: { kind: 'none' }, reconnect: { kind: 'not-asked' } })
  expect(kept).toMatch(/^Did: nothing\. Chrome runs with the flag though it is off here; Chrome keeps it until it next starts\.$/m)
  const more = answer({ platform: 'windows', flag: off, look: read([browser(5, false), browser(6, false), browser(7, false)]), start: { kind: 'none' }, reconnect: { kind: 'not-asked' } })
  expect(more).toMatch(/^Chrome: running \(PID 5 \(and 2 more browser processes of it\)\);/m)
  const odd = answer({ platform: 'macos', flag: off, look: read([browser(5, false, { namesProfile: true })]), start: { kind: 'none' }, reconnect: { kind: 'not-asked' } })
  expect(odd).toMatch(/its command line names a profile folder whose name isn't plain, so it isn't shown\.$/m)
})

// ---------------------------------------------------------------------------------------------
// Elsewhere than Windows and macOS.

test('on Linux: nothing looked for, started or queued', async ($, on) => {
  const linux = engine(on, { platform: 'linux' })
  await $.session.start(START)
  expect(await ensure($)).toBe('Chrome: not looked for. self-chrome looks after Chrome on Windows and macOS, on the machine Chrome runs on, and this session runs on linux. Nothing was started or queued.')
  expect(linux.argvs).toEqual([])
  await $.turn.complete(ANSWERED)
  await linux.clock.advance(1000)
  expect(linux.commands).toEqual([])
})

test("on WSL: its processes aren't Windows' own, so nothing runs", async ($, on) => {
  const { argvs } = engine(on, { platform: 'wsl' })
  await $.session.start(START)
  expect(await ensure($)).toMatch(/this session runs on WSL, whose processes are not Windows' own\./)
  expect(argvs).toEqual([])
})

test('a hosted server is not the machine Chrome runs on', async ($, on) => {
  const { argvs } = engine(on, { platform: 'macos', isHosted: true })
  await $.session.start(START)
  expect(await ensure($)).toMatch(/this session runs on a hosted server, not the machine Chrome runs on\./)
  expect(argvs).toEqual([])
})

test('a platform Claude Code leaves unsaid, with OS=Windows_NT, is Windows', async ($, on) => {
  const { starts } = engine(on, { noPlatform: true })
  await $.session.start(START)
  expect(await ensure($)).toMatch(/Did: started Chrome/)
  expect(starts).toHaveLength(1)
})

// ---------------------------------------------------------------------------------------------
// macOS.

test("macOS argument building: open -a with the .app, the arguments after --args; pgrep by the binary and this user's uid; ps of those alone", () => {
  expect(macBundle(MAC_CHROME)).toBe('/Applications/Google Chrome.app')
  expect(macOpenArgv(MAC_CHROME, 'Profile 3', true)).toEqual(['/usr/bin/open', '-a', '/Applications/Google Chrome.app', '--args', '--profile-directory=Profile 3', '--restore-last-session', FLAG])
  expect(macOpenArgv(MAC_CHROME, undefined, false)).toEqual(['/usr/bin/open', '-a', '/Applications/Google Chrome.app', '--args', '--restore-last-session'])
  expect(() => macOpenArgv('/usr/local/bin/chrome', undefined, false)).toThrow()
  expect(() => macOpenArgv(MAC_CHROME, '../x', false)).toThrow()
  expect(pgrepArgv([MAC_CHROME], 501)).toEqual(['/usr/bin/pgrep', '-U', '501', '-f', '^(/Applications/Google Chrome\\.app/Contents/MacOS/Google Chrome)( |$)'])
  expect(pgrepArgv([MAC_CHROME])).toEqual(['/usr/bin/pgrep', '-f', '^(/Applications/Google Chrome\\.app/Contents/MacOS/Google Chrome)( |$)'])
  expect(psArgv([12, 34])).toEqual(['/bin/ps', '-ww', '-o', 'pid=,command=', '-p', '12,34'])
  expect(macStandard(HOME)).toEqual([MAC_CHROME, `${HOME}${MAC_CHROME}`])
  expect(macStandard(undefined)).toEqual([MAC_CHROME])
  expect(macChromeFault(MAC_CHROME)).toBeUndefined()
  expect(macChromeFault('/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta')).toBeUndefined()
  expect(macChromeFault('/Applications/Safari.app/Contents/MacOS/Safari')).toBeDefined()
  expect(macChromeFault('/Applications/Google Chrome.app')).toBeDefined()
  expect(macChromeFault('/Applications/../Google Chrome.app/Contents/MacOS/Google Chrome')).toBeDefined()
  // ps's lines: a binary path with spaces in it, matched whole.
  expect(parsePs(`  412 ${MAC_CHROME} --profile-directory=Default\n 9 /usr/bin/other\n`, [MAC_CHROME])).toEqual([
    { pid: 412, exe: MAC_CHROME, cmd: `${MAC_CHROME} --profile-directory=Default` },
    { pid: 9, exe: '', cmd: '/usr/bin/other' },
  ])
})

test("macOS, not running: a last look, then open with the flag on the account match's folder, and the wait finds it", async ($, on) => {
  const fakes = engine(on, { platform: 'macos', env: { CLAUDE_CHROME_SILENT_DEBUGGER: '1' } })
  const { argvs, reads, commands, clock, macLock } = fakes
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toContain(`Did: started Chrome, with the profile folder "Profile 3" (its Google account has the email of Claude Code's account), --restore-last-session and ${FLAG}. It runs as PID 4321, and the flag took.`)
  expect(argvs.find(a => a[0] === '/usr/bin/open')).toEqual(['/usr/bin/open', '-a', '/Applications/Google Chrome.app', '--args', '--profile-directory=Profile 3', '--restore-last-session', FLAG])
  // .claude.json in the home folder, and Local State in Chrome's own folder under it, each read once; by the tail, as
  // a host on Windows may spell a POSIX path its own way.
  const macReads = reads.map(path => path.replace(/\\/g, '/'))
  expect(macReads).toHaveLength(2)
  expect([macReads[0]?.endsWith(CLAIM_MAC), macReads[1]?.endsWith(LOCAL_STATE_MAC)]).toEqual([true, true])
  heldToFolders(said, fakes)
  // This user's uid; the first look; the lock (its folder's parent, then the folder); the last look right before
  // open; open; then a sleep and a look until it shows; then the lock let go.
  expect(argvs.map(a => a[0])).toEqual(['/usr/bin/id', '/usr/bin/pgrep', '/bin/mkdir', '/bin/mkdir', '/usr/bin/pgrep', '/usr/bin/open', '/bin/sleep', '/usr/bin/pgrep', '/bin/ps', '/bin/rmdir'])
  const lock = `${HOME}/Library/Caches/claude-self-tools/chrome-start.lock`
  expect(argvs.filter(a => a[0] === '/bin/mkdir')).toEqual([['/bin/mkdir', '-p', `${HOME}/Library/Caches/claude-self-tools`], ['/bin/mkdir', lock]])
  expect(argvs.find(a => a[0] === '/bin/rmdir')).toEqual(['/bin/rmdir', lock])
  expect(macLock()).toBe(false)
  expect(argvs.filter(a => a[0] === '/usr/bin/pgrep').every(a => a[1] === '-U' && a[2] === '501')).toBe(true)
  expect(killsAnything([], argvs)).toBe(false)
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual(['mcp reconnect claude-in-chrome'])
})

test("macOS, a named profile is checked against Chrome's own folder under the home folder", async ($, on) => {
  const { lists, argvs } = engine(on, { platform: 'macos' })
  await $.session.start(START)
  expect(await ensure($, { profile: 'Profile 3' })).toContain('with the profile folder "Profile 3" (asked for in this call)')
  expect(lists.map(p => p.replace(/\\/g, '/')).every(p => p.endsWith(`${HOME}/Library/Application Support/Google/Chrome`))).toBe(true)
  expect(argvs.find(a => a[0] === '/usr/bin/open')).toEqual(['/usr/bin/open', '-a', '/Applications/Google Chrome.app', '--args', '--profile-directory=Profile 3', '--restore-last-session'])
})

test('macOS, open fails: the start says why, and no reconnect is queued', async ($, on) => {
  const fakes = engine(on, { platform: 'macos', open: 'fails', after: [] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: tried to start Chrome, but open exited 1: LSOpenURLsWithRole\(\) failed with error -10810\.$/m)
  expect(said).toMatch(/^Reconnect: not queued/m)
  heldToFolders(said, fakes)
})

test("macOS, open that never answers isn't a failed start: the looks find Chrome", async ($, on) => {
  const fakes = engine(on, { platform: 'macos', open: 'hangs' })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: started Chrome, with .+; the start's own answer didn't come \(open didn't answer \(.+\)\)\. It runs as PID 4321\.$/m)
  heldToFolders(said, fakes)
})

test('macOS, no browser within 20 s: it says so after its looks', async ($, on) => {
  const fakes = engine(on, { platform: 'macos', after: [] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/Did: asked Chrome to start, with .+, but no browser process of it showed within 20 s\./)
  expect(fakes.argvs.filter(a => a[0] === '/bin/sleep')).toHaveLength(20)
  heldToFolders(said, fakes)
})

test('macOS, running without the flag while opted in: it says so, and never quits Chrome', async ($, on) => {
  const fakes = engine(on, { platform: 'macos', env: { CLAUDE_CHROME_SILENT_DEBUGGER: '1' }, running: [{ pid: 412, cmd: `${MAC_CHROME} --profile-directory=Profile 3` }] })
  const { argvs } = fakes
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Chrome: running \(PID 412\); without --silent-debugger-extension-api; its command line names the profile folder "Profile 3"\.$/m)
  expect(said).toMatch(/quit Chrome fully \(Cmd\+Q, every window\), then call chrome_ensure again; or start Chrome with it by hand: open -a "Google Chrome" --args --silent-debugger-extension-api/)
  expect(argvs.map(a => a[0])).toEqual(['/usr/bin/id', '/usr/bin/pgrep', '/bin/ps'])
  expect(killsAnything([], argvs)).toBe(false)
  heldToFolders(said, fakes)
})

test("macOS, another start holding the lock: open never runs, and this call waits for what that start makes", async ($, on) => {
  const fakes = engine(on, { platform: 'macos', macLock: 'held', after: [], appear: { after: 2, procs: [{ pid: 515, cmd: `${MAC_CHROME} --restore-last-session` }] } })
  const { argvs, macLock } = fakes
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: nothing: another session was starting Chrome, which runs as PID 515, without the flag\.$/m)
  expect(argvs.some(a => a[0] === '/usr/bin/open')).toBe(false)
  expect(argvs.some(a => a[0] === '/bin/rmdir')).toBe(false)
  expect(macLock()).toBe(true)
  heldToFolders(said, fakes)
})

test('macOS, a lock older than a start can take is taken over', async ($, on) => {
  const fakes = engine(on, { platform: 'macos', macLock: 'stale' })
  const { argvs } = fakes
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: started Chrome/m)
  heldToFolders(said, fakes)
  // mkdir fails on the old lock; it is removed and made again; open runs; the lock is let go after the wait.
  expect(argvs.map(a => a[0]).filter(c => c === '/bin/mkdir' || c === '/bin/rmdir' || c === '/usr/bin/open')).toEqual(['/bin/mkdir', '/bin/mkdir', '/bin/rmdir', '/bin/mkdir', '/usr/bin/open', '/bin/rmdir'])
})

// ---------------------------------------------------------------------------------------------
// Windows' scripts.

test("Windows' look: fixed text around checked inputs, this login's processes only, an unreadable one read again", () => {
  const look = windowsLookScript(undefined)
  expect(look).toContain("[Environment]::GetFolderPath('ProgramFiles')")
  expect(look).toContain('$configured = $null')
  expect(look).not.toMatch(/\$env:ProgramFiles/)
  expect(look).toContain('[int]$_.SessionId -eq $own')
  expect(look).toContain('Start-Sleep -Milliseconds 300')
  expect(look).not.toMatch(/Start-Sleep -Milliseconds 700/)
  expect(windowsLookScript(undefined, 700)).toMatch(/^Start-Sleep -Milliseconds 700\r?$/m)
  expect(windowsLookScript(CHROME)).toContain(`$configured = '${CHROME}'`)
  expect(() => windowsLookScript("C:\\x'; Remove-Item C:\\ -Recurse; '\\chrome.exe")).toThrow()
  expect(() => windowsLookScript(undefined, 60_000)).toThrow()
  expect(killsAnything([look], [])).toBe(false)
  expect(windowsChromeFault(CHROME)).toBeUndefined()
  expect(windowsChromeFault('chrome.exe')).toBeDefined()
})

test("Windows' start: Add-Type and the login read first; then the lock; then the last look, the swap, the check and the launch, back to back; short, and nothing quit", () => {
  const CLAIM = '6b0e1c2a-3d4f-4a5b-9c6d-7e8f9a0b1c2d'
  const start = windowsStartScript(CHROME, windowsLaunchArgs('Profile 3', true), CLAIM)
  expect(argumentsOf(start)).toBe(`--profile-directory="Profile 3" --restore-last-session ${FLAG}`)
  const at = (needle: string) => {
    const i = start.indexOf(needle)
    expect(i).toBeGreaterThan(-1)
    return i
  }
  const compile = at("Add-Type -ErrorAction Stop -TypeDefinition '")
  const loginRead = at('$login = [SelfChromeLoginEnv]::Login()')
  const take = at('$taken = Take-Lock')
  const held = at(`if (-not $taken) { [Console]::Out.WriteLine('{"v":1,"held":true}'); return }`)
  const lastLook = at('foreach ($p in (Read-Browsers))')
  const swap = at('[SelfChromeLoginEnv]::Swap($login)')
  const check = at('if (-not [SelfChromeLoginEnv]::Same($login)) { Free-Lock;')
  const launch = at('$started = [System.Diagnostics.Process]::Start($launch)')
  // N3: what takes time first; then the lock; then the last look, the swap, the check and the launch, in that order.
  expect(compile < loginRead && loginRead < take && take < held && held < lastLook && lastLook < swap && swap < check && check < launch).toBe(true)
  // Between the last look and the launch: no cmdlet, no pipeline, no compile.
  expect(start.slice(swap)).not.toMatch(/Add-Type|Get-CimInstance|ConvertTo-Json|Start-Process|New-Object|Write-Output|\|/)
  // N1: the swap and the check are Windows' own calls, in C#: no variable is set through .NET or PowerShell, so no
  // host can leave a session variable in place.
  expect(start).not.toMatch(/\[Environment\]::SetEnvironmentVariable|\$env:[A-Za-z]+ = (?!@\()/)
  expect(LOGIN_ENV_CS).toContain('SetEnvironmentVariableW(name, null)')
  expect(LOGIN_ENV_CS).toContain('GetEnvironmentStringsW()')
  expect(LOGIN_ENV_CS).toContain('CreateEnvironmentBlock(out block, token, false)')
  expect(LOGIN_ENV_CS).not.toContain("'")
  // Nothing of the session's is named in the script, but its own module path in the preamble, which the swap clears.
  expect(start).not.toMatch(/CLAUDE/)
  expect(start.match(/\$env:/g)).toEqual(['$env:'])
  expect(start.indexOf('$env:PSModulePath = ')).toBeLessThan(swap)
  // N2: the lock, one file per user beside the self tools' own, made with an exclusive create, taken over when stale.
  expect(start).toContain(String.raw`$lockDir = [Environment]::GetFolderPath('LocalApplicationData').TrimEnd([char]92) + '\claude-self-tools'`)
  expect(start).toContain(String.raw`$lock = $lockDir + '\chrome-start.lock'`)
  expect(start).toContain('[IO.FileMode]::CreateNew')
  expect(start).toContain(`-gt ${START_LOCK_MS}) { try { [IO.File]::Delete($lock) } catch { }; $taken = Take-Lock }`)
  expect(start).toContain(`$claim = '${CLAIM}'`)
  // A last look that finds Chrome, and a refused check, each let the lock go before they answer.
  expect(start).toMatch(/Free-Lock; \[Console\]::Out\.WriteLine\('\{"v":1,"running":'/)
  expect(start).toMatch(/Free-Lock; \[Console\]::Out\.WriteLine\('\{"v":1,"mismatch":true\}'\)/)
  // ShellExecute, in Chrome's own folder, never -UseNewEnvironment or -NoNewWindow, which hand Chrome this script's pipes.
  expect(start).toContain('$launch.UseShellExecute = $true')
  expect(start).toContain('$launch.WorkingDirectory = [IO.Path]::GetDirectoryName($chrome)')
  expect(start).not.toMatch(/UseNewEnvironment|NoNewWindow|Start-Sleep -Milliseconds 500/)
  expect(windowsLaunchArgs(undefined, false)).toEqual(['--restore-last-session'])
  expect(() => windowsStartScript(CHROME, ['--profile-directory="a"; calc"'], CLAIM)).toThrow()
  expect(() => windowsStartScript('C:\\Windows\\notepad.exe', [], CLAIM)).toThrow()
  expect(() => windowsStartScript(CHROME, [], "x'; Remove-Item C:\\; '")).toThrow()
  expect(killsAnything([start], [])).toBe(false)
  // The release: the lock deleted only when it names this claim.
  const release = windowsReleaseScript(CLAIM)
  expect(release).toContain(`$claim = '${CLAIM}'`)
  expect(release).toContain(`if ([IO.File]::ReadAllText($lock).Contains('"by":"' + $claim + '"')) { [IO.File]::Delete($lock) }`)
  expect(release).toMatch(/^Free-Lock\r?$/m)
  expect(() => windowsReleaseScript('not-a-claim')).toThrow()
  expect(parseWindowsStart('{"v":1,"started":4321}\r\n')).toEqual({ kind: 'launched', pid: 4321 })
  expect(parseWindowsStart('{"v":1,"started":null}')).toEqual({ kind: 'launched' })
  expect(parseWindowsStart('{"v":1,"running":12}')).toEqual({ kind: 'running', pid: 12 })
  expect(parseWindowsStart('{"v":1,"held":true}')).toEqual({ kind: 'held' })
  expect(parseWindowsStart('{"v":1,"mismatch":true}')).toEqual({ kind: 'mismatch' })
  expect(typeof parseWindowsStart('nothing')).toBe('string')
})

test('the reconnect count: only times within the last 10 minutes, the cap at 3', () => {
  expect(reconnectsWithin(null, NOW)).toEqual({ kept: [], isCapped: false })
  expect(reconnectsWithin([NOW - 11 * MINUTE, NOW - MINUTE, NOW], NOW)).toEqual({ kept: [NOW - MINUTE, NOW], isCapped: false })
  expect(reconnectsWithin([NOW - 3, NOW - 2, NOW - 1], NOW)).toEqual({ kept: [NOW - 3, NOW - 2, NOW - 1], isCapped: true })
  expect(reconnectsWithin(['x', NOW + MINUTE], NOW)).toEqual({ kept: [], isCapped: false })
})
