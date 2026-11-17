import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import {
  answer,
  chooseProfile,
  flagChoice,
  hasSwitch,
  isHeld,
  judge,
  MAC_CHROME,
  macBundle,
  macChromeFault,
  macOpenArgv,
  macStandard,
  missingProfile,
  parsePs,
  parseWindowsStart,
  pgrepArgv,
  profileCandidates,
  psArgv,
  readMark,
  reconnectsWithin,
  silentSetting,
  START_MARK_MS,
  switchValue,
  windowsChromeFault,
  windowsLaunchArgs,
  windowsLookScript,
  windowsStartScript,
} from '../hooks/chrome'

const TOOL = 'mcp__self-chrome__chrome_ensure'
const FLAG = '--silent-debugger-extension-api'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const LOCAL = 'C:\\Users\\u\\AppData\\Local'
const USER_DATA = `${LOCAL}\\Google\\Chrome\\User Data`
const HOME = '/Users/u'
const WINDOWS = { OS: 'Windows_NT', SystemRoot: 'C:\\Windows' }
const MAC = { HOME }
const NOW = 1_000_000
const MINUTE = 60_000
/** A tool of Claude in Chrome's. */
const IN_CHROME = 'mcp__claude-in-chrome__tabs_context_mcp'

/** What would quit, kill or restart a process: no script or argv of the plugin's may hold any of these. */
const KILLS = /Stop-Process|taskkill|\.Kill\(|CloseMainWindow|Restart-|killall|pkill|\bkill\b|osascript|\bquit\b/i

/** A browser process as the look reads it. */
type Proc = { pid: number; exe?: string; cmd: string }

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
  startRun?: 'launched' | 'no-pid' | 'running' | 'fails' | 'hangs'
  /** The id the start's run says it launched. */
  launchedPid?: number
  /** What macOS's open does. */
  open?: 'opens' | 'fails' | 'hangs'
  /** The profile folders in Chrome's user data folder, each with its Preferences file. */
  profiles?: string[]
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
  const scripts: string[] = []
  const starts: string[] = []
  const argvs: string[][] = []
  const reads: string[] = []
  const lists: string[] = []
  const commands: string[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  const described: string[] = []
  /** Whether the start's mark stood in the store when each start ran. */
  const markedAtStart: boolean[] = []
  const store = new Map<string, unknown>(Object.entries(world.store ?? {}))
  const profiles = world.profiles ?? ['Default', 'Profile 3']
  const clock = mock.clock(on, { now: NOW })
  const session = mock.session(on)
  mock.env(on, { ...(isMac ? MAC : platform === 'windows' ? WINDOWS : {}), ...world.env })
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
  on('fs.read', (_, e) => {
    reads.push(e.path)
    return { deny: `ENOENT: ${e.path}` }
  })
  // Chrome's user data folder: its profile folders, and other folders and files that are no profile.
  on('fs.list', (_, e) => {
    lists.push(e.path ?? '')
    const dirs = [...profiles, 'Crashpad', 'ShaderCache', 'Stale', 'bad.name']
    return { value: [...dirs.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })), { name: 'Local State', kind: 'file' as const, size: 9, mtimeMs: 0, isLink: false }] }
  })
  // The standard install is there, and each profile folder's Preferences. Matched by the tail: a host on Windows may
  // spell a POSIX path its own way.
  on('fs.exists', (_, e) => {
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
        markedAtStart.push(store.has('starting'))
        const after = world.after ?? [{ pid: 4321, cmd: `"${CHROME}" ${argumentsOf(script)}` }]
        const run = world.startRun ?? 'launched'
        if (run === 'fails') return failed('Exception calling "Start" with "1" argument(s): "The system cannot find the file specified"')
        running = after
        if (run === 'hangs') return { deny: 'the command was still running after 30000 ms' }
        if (run === 'running') return ok(`${JSON.stringify({ v: 1, running: after[0]?.pid ?? 1 })}\r\n`)
        if (run === 'no-pid') return ok('{"v":1,"started":null}\r\n')
        return ok(`{"v":1,"started":${world.launchedPid ?? 4321}}\r\n`)
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
      const asked = (argv.at(-1) ?? '').split(',').map(Number)
      return ok(running.filter(p => asked.includes(p.pid)).map(p => `${String(p.pid).padStart(5)} ${p.cmd}`).join('\n'))
    }
    if (argv[0] === '/usr/bin/open') {
      markedAtStart.push(store.has('starting'))
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
  return { scripts, starts, argvs, reads, lists, commands, prompts, toasts, described, markedAtStart, store, clock, session }
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

test('not running, opted in by the variable, no profile named: Chrome starts with the flag and no --profile-directory, and the reconnect runs once the turn ends', async ($, on) => {
  const { starts, argvs, scripts, reads, commands, markedAtStart, store, clock } = engine(on, { env: { CLAUDE_CHROME_SILENT_DEBUGGER: '1' } })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Chrome: not running\.$/m)
  expect(said).toMatch(/^Flag: on: the silentDebugger setting is auto, and CLAUDE_CHROME_SILENT_DEBUGGER turns it on\.$/m)
  expect(said).toContain(`Did: started Chrome, with no profile folder named (Chrome opens the profile it used last), --restore-last-session and ${FLAG}. It runs as PID 4321, and the flag took.`)
  expect(said).toMatch(/^Reconnect: \/mcp reconnect claude-in-chrome runs once this turn ends/m)
  expect(said).toMatch(/^Left for the person: nothing\.$/m)
  // The start: one short launch, then a look of its own; no --profile-directory, so Chrome picks its own last profile.
  expect(starts).toHaveLength(1)
  expect(argumentsOf(starts[0] ?? '')).toBe(`--restore-last-session ${FLAG}`)
  expect(scripts.at(-1)).toContain('Start-Sleep -Milliseconds 700')
  // Windows PowerShell by its known path, the script on standard input; nothing of Local State read.
  expect(argvs[0]?.[0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  expect(reads.filter(path => /Local State/.test(path))).toEqual([])
  expect(killsAnything(scripts, argvs)).toBe(false)
  // The start's mark stood while it ran, and was taken back after.
  expect(markedAtStart).toEqual([true])
  expect(store.has('starting')).toBe(false)

  expect(commands).toEqual([])
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual(['mcp reconnect claude-in-chrome'])
})

test('not running, auto and the variable unset: Chrome starts without the flag', async ($, on) => {
  const { starts } = engine(on)
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toContain(`Did: started Chrome, with no profile folder named (Chrome opens the profile it used last), --restore-last-session, without ${FLAG}. It runs as PID 4321.`)
  expect(said).toMatch(/^Flag: off: the silentDebugger setting is auto, and CLAUDE_CHROME_SILENT_DEBUGGER doesn't turn it on/m)
  expect(argumentsOf(starts[0] ?? '')).toBe('--restore-last-session')
})

test('the setting on overrides an unset variable: Chrome starts with the flag', { options: { silentDebugger: 'on' } }, async ($, on) => {
  const { starts } = engine(on)
  await $.session.start(START)
  expect(await ensure($)).toMatch(/^Flag: on: the silentDebugger setting is on\.$/m)
  expect(argumentsOf(starts[0] ?? '')).toContain(FLAG)
})

test('the setting off overrides the variable: Chrome starts without the flag', { options: { silentDebugger: 'off' } }, async ($, on) => {
  const { starts } = engine(on, { env: { CLAUDE_CHROME_SILENT_DEBUGGER: 'true' } })
  await $.session.start(START)
  expect(await ensure($)).toMatch(/^Flag: off: the silentDebugger setting is off\.$/m)
  expect(argumentsOf(starts[0] ?? '')).not.toContain(FLAG)
})

// ---------------------------------------------------------------------------------------------
// Chrome running.

test('running with the flag: nothing to do, nothing started', async ($, on) => {
  const { scripts, starts, argvs } = engine(on, { env: { CLAUDE_CHROME_SILENT_DEBUGGER: 'on' }, running: [{ pid: 777, cmd: `"${CHROME}" --profile-directory="Profile 3" ${FLAG}` }] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Chrome: running \(PID 777\); with --silent-debugger-extension-api; its command line names the profile folder "Profile 3"\.$/m)
  expect(said).toMatch(/^Did: nothing: Chrome runs, with the flag\.$/m)
  expect(said).toMatch(/^Left for the person: nothing\.$/m)
  expect(scripts).toHaveLength(1)
  expect(starts).toEqual([])
  expect(killsAnything(scripts, argvs)).toBe(false)
})

test('running without the flag while opted in: it says so and how the person fixes it, and never quits, kills or restarts Chrome', async ($, on) => {
  const { scripts, starts, argvs, commands, clock } = engine(on, { env: { CLAUDE_CHROME_SILENT_DEBUGGER: '1' }, running: [{ pid: 777, cmd: `"${CHROME}" --restore-last-session` }] })
  await $.session.start(START)
  const said = await ensure($)
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
  const { starts } = engine(on, { running: [{ pid: 777, cmd: `"${CHROME}"` }] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: nothing: Chrome runs, and the flag is off\.$/m)
  expect(said).toMatch(/^Left for the person: nothing\.$/m)
  expect(starts).toEqual([])
})

test('a Chrome in the background with no window counts as running, and is said plainly', async ($, on) => {
  const { starts } = engine(on, { running: [{ pid: 640, cmd: `"${CHROME}" --no-startup-window --win-session-start` }] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Chrome: running \(PID 640\), in the background with no window\. That counts as running: a start now would only hand off to it, and Chrome took its flags when it started; without --silent-debugger-extension-api; its command line names no profile folder\.$/m)
  expect(starts).toEqual([])
})

test("a test or isolated Chrome with its own --user-data-dir isn't the person's: Chrome starts beside it", async ($, on) => {
  const { starts } = engine(on, { running: [{ pid: 55, cmd: `"${CHROME}" --user-data-dir="C:\\Temp\\playwright-1" --remote-debugging-port=0` }] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Chrome: not running\. 1 other Chrome, with its own --user-data-dir \(a test or isolated Chrome\), isn't counted\.$/m)
  expect(said).toMatch(/Did: started Chrome/)
  // The isolated one's path never reaches the answer.
  expect(said).not.toContain('playwright')
  expect(starts).toHaveLength(1)
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

test('which profile a start opens: the call, then the setting, else none; a bad setting is refused by its length, never echoed', () => {
  expect(chooseProfile('Work', 'Profile 9')).toEqual({ profile: 'Work', source: 'call' })
  expect(chooseProfile(undefined, 'Profile 9')).toEqual({ profile: 'Profile 9', source: 'setting' })
  expect(chooseProfile(undefined, '')).toEqual({ profile: undefined })
  const bad = chooseProfile(undefined, 'person@example.com')
  expect(bad).toEqual({
    refusal: "the profile setting isn't a profile folder's name (it is 18 characters long)",
    fix: "set the profile setting to one of Chrome's profile folders, by its folder's name (Default, Profile 2), or empty it, so Chrome opens the profile it used last",
  })
  expect(JSON.stringify(bad)).not.toContain('example')
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
  expect(call.fix).toBe('call chrome_ensure again with `profile` set to one of Chrome\'s profile folders ("Default", "Profile 3"), or leave it out, so Chrome opens the profile it used last')
  expect(missingProfile('setting', []).fix).toContain('(none was found)')
  expect(missingProfile('setting', undefined).fix).toBe("set the profile setting to one of Chrome's profile folders, by its folder's name, or leave it out, so Chrome opens the profile it used last")
})

test("a call's profile that is one of Chrome's folders is started with, quoted", { options: { profile: 'Profile 9' } }, async ($, on) => {
  const { starts } = engine(on)
  await $.session.start(START)
  const said = await ensure($, { profile: ' Profile 3 ' })
  expect(said).toContain('with the profile folder "Profile 3" (asked for in this call), --restore-last-session')
  expect(argumentsOf(starts[0] ?? '')).toBe('--profile-directory="Profile 3" --restore-last-session')
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

test('the profile setting is started with when it names one of Chrome\'s folders', { options: { profile: 'Default' } }, async ($, on) => {
  const { starts } = engine(on)
  await $.session.start(START)
  expect(await ensure($)).toContain('with the profile folder "Default" (the profile setting)')
  expect(argumentsOf(starts[0] ?? '')).toBe('--profile-directory="Default" --restore-last-session')
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
// Starts that don't go as planned.

test('the flag asked for but not taken: it says so, and how the person adds it', async ($, on) => {
  engine(on, { env: { CLAUDE_CHROME_SILENT_DEBUGGER: '1' }, after: [{ pid: 4321, cmd: `"${CHROME}"` }] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/It runs as PID 4321, but without the flag: a Chrome already starting may have taken the launch\./)
  expect(said).toMatch(/^Left for the person: for the flag, quit Chrome fully/m)
})

test('a launch that handed off to a Chrome already starting is said: the PID found is not the one launched', async ($, on) => {
  engine(on, { launchedPid: 9999 })
  await $.session.start(START)
  expect(await ensure($)).toMatch(/^Did: launched Chrome, with .+, but the launch handed off to a Chrome that was starting already: it runs as PID 4321\.$/m)
})

test('a launch Windows names no process for is still looked for', async ($, on) => {
  engine(on, { startRun: 'no-pid' })
  await $.session.start(START)
  expect(await ensure($)).toMatch(/^Did: started Chrome, with .+\. It runs as PID 4321\.$/m)
})

test('started, but no browser process within 20 s: it says so after its looks, and the reconnect still goes', async ($, on) => {
  const { scripts, commands, clock } = engine(on, { after: [] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/Did: asked Chrome to start, with .+, but no browser process of it showed within 20 s\./)
  // The first look, the start, then 20 looks of its own, each after a pause: never one long run.
  expect(scripts).toHaveLength(22)
  expect(scripts.slice(2).every(s => s.includes('Start-Sleep -Milliseconds 700') && !s.includes('Process]::Start('))).toBe(true)
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual(['mcp reconnect claude-in-chrome'])
})

test("a start whose answer never came isn't a failed start: the looks find Chrome, and the answer says so", async ($, on) => {
  const { commands, clock } = engine(on, { startRun: 'hangs' })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: started Chrome, with .+; the start's own answer didn't come \(the start didn't answer \(.*still running after 30000 ms.*\)\)\. It runs as PID 4321\.$/m)
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual(['mcp reconnect claude-in-chrome'])
})

test('a start whose answer never came, and no browser after: nothing is said to run, and no reconnect is queued', async ($, on) => {
  const { commands, clock } = engine(on, { startRun: 'hangs', after: [] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: asked Chrome to start, with .+; the start's own answer didn't come \(.+\), but no browser process of it showed within 20 s\.$/m)
  expect(said).toMatch(/^Reconnect: not queued: Chrome isn't known to run\./m)
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual([])
})

test('a start that fails says why, after one look, and queues no reconnect', async ($, on) => {
  const { scripts } = engine(on, { startRun: 'fails', after: [] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: tried to start Chrome, but the start exited 1: Exception calling "Start" with "1" argument\(s\): "The system cannot find the file specified"\.$/m)
  expect(said).toMatch(/^Left for the person: start Chrome by hand\.$/m)
  expect(said).toMatch(/^Reconnect: not queued/m)
  expect(scripts).toHaveLength(3)
})

test('a Chrome that came up between the look and the start is never started again', async ($, on) => {
  const { starts } = engine(on, { startRun: 'running', after: [{ pid: 808, cmd: `"${CHROME}" ${FLAG}` }] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: nothing: Chrome came up just before the start \(another session's start, or the person's\), PID 808, with the flag\.$/m)
  expect(starts).toHaveLength(1)
})

test("another session's start in flight: this call launches nothing, waits for it, and says what it found", async ($, on) => {
  const { starts, store } = engine(on, {
    store: { starting: { until: NOW + 30_000, by: 'another-call' } },
    appear: { after: 2, procs: [{ pid: 515, cmd: `"${CHROME}" --restore-last-session` }] },
  })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: nothing: another session was starting Chrome, which runs as PID 515, without the flag\.$/m)
  expect(starts).toEqual([])
  // Its mark is the other call's to take back.
  expect(store.get('starting')).toEqual({ until: NOW + 30_000, by: 'another-call' })
})

test("another session's start that shows no browser: this call says so, and asks to call again later", async ($, on) => {
  const { starts } = engine(on, { store: { starting: { until: NOW + 30_000, by: 'another-call' } } })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: nothing: another session is starting Chrome, and no browser process of it showed within 20 s\.$/m)
  expect(starts).toEqual([])
})

test('a mark past its time, or one further ahead than a start takes, holds nothing', async ($, on) => {
  expect(isHeld(readMark({ until: NOW - 1, by: 'x' }), NOW)).toBe(false)
  expect(isHeld(readMark({ until: NOW + START_MARK_MS + 1, by: 'x' }), NOW)).toBe(false)
  expect(isHeld(readMark({ until: NOW + 1, by: 'x' }), NOW)).toBe(true)
  expect(readMark({ until: 'soon' })).toBeUndefined()
  const { starts } = engine(on, { store: { starting: { until: NOW - 1, by: 'gone' } } })
  await $.session.start(START)
  await ensure($)
  expect(starts).toHaveLength(1)
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
  expect(said).toContain('When it says the reconnect is queued, end your turn and do nothing more until it has run; then carry on.')
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

test('macOS, not running: a last look, then open with the flag and no profile named, and the wait finds it', async ($, on) => {
  const { argvs, commands, markedAtStart, clock } = engine(on, { platform: 'macos', env: { CLAUDE_CHROME_SILENT_DEBUGGER: '1' } })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toContain(`Did: started Chrome, with no profile folder named (Chrome opens the profile it used last), --restore-last-session and ${FLAG}. It runs as PID 4321, and the flag took.`)
  expect(argvs.find(a => a[0] === '/usr/bin/open')).toEqual(['/usr/bin/open', '-a', '/Applications/Google Chrome.app', '--args', '--restore-last-session', FLAG])
  // This user's uid; the first look; the last look right before open; open; then a sleep and a look until it shows.
  expect(argvs.map(a => a[0])).toEqual(['/usr/bin/id', '/usr/bin/pgrep', '/usr/bin/pgrep', '/usr/bin/open', '/bin/sleep', '/usr/bin/pgrep', '/bin/ps'])
  expect(argvs.filter(a => a[0] === '/usr/bin/pgrep').every(a => a[1] === '-U' && a[2] === '501')).toBe(true)
  expect(markedAtStart).toEqual([true])
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
  engine(on, { platform: 'macos', open: 'fails', after: [] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: tried to start Chrome, but open exited 1: LSOpenURLsWithRole\(\) failed with error -10810\.$/m)
  expect(said).toMatch(/^Reconnect: not queued/m)
})

test("macOS, open that never answers isn't a failed start: the looks find Chrome", async ($, on) => {
  engine(on, { platform: 'macos', open: 'hangs' })
  await $.session.start(START)
  expect(await ensure($)).toMatch(/^Did: started Chrome, with .+; the start's own answer didn't come \(open didn't answer \(.+\)\)\. It runs as PID 4321\.$/m)
})

test('macOS, no browser within 20 s: it says so after its looks', async ($, on) => {
  const { argvs } = engine(on, { platform: 'macos', after: [] })
  await $.session.start(START)
  expect(await ensure($)).toMatch(/Did: asked Chrome to start, with .+, but no browser process of it showed within 20 s\./)
  expect(argvs.filter(a => a[0] === '/bin/sleep')).toHaveLength(20)
})

test('macOS, running without the flag while opted in: it says so, and never quits Chrome', async ($, on) => {
  const { argvs } = engine(on, { platform: 'macos', env: { CLAUDE_CHROME_SILENT_DEBUGGER: '1' }, running: [{ pid: 412, cmd: `${MAC_CHROME} --profile-directory=Profile 3` }] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Chrome: running \(PID 412\); without --silent-debugger-extension-api; its command line names the profile folder "Profile 3"\.$/m)
  expect(said).toMatch(/quit Chrome fully \(Cmd\+Q, every window\), then call chrome_ensure again; or start Chrome with it by hand: open -a "Google Chrome" --args --silent-debugger-extension-api/)
  expect(argvs.map(a => a[0])).toEqual(['/usr/bin/id', '/usr/bin/pgrep', '/bin/ps'])
  expect(killsAnything([], argvs)).toBe(false)
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

test("Windows' start: a last look, then the login environment in place of every variable of the session's, then the launch in Chrome's own folder; short, and nothing quit", () => {
  const start = windowsStartScript(CHROME, windowsLaunchArgs('Profile 3', true))
  expect(argumentsOf(start)).toBe(`--profile-directory="Profile 3" --restore-last-session ${FLAG}`)
  const at = (needle: string) => {
    const i = start.indexOf(needle)
    expect(i).toBeGreaterThan(-1)
    return i
  }
  const lastLook = at('foreach ($p in (Read-Browsers))')
  const running = at('running = [long]$p')
  const loginRead = at('$login = [SelfChromeLoginEnv]::Read()')
  const cleared = at("foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) { [Environment]::SetEnvironmentVariable([string]$name, $null, 'Process') }")
  const loginSet = at("foreach ($pair in $login)")
  const launch = at('$started = [System.Diagnostics.Process]::Start($launch)')
  // The last look comes first; every variable of the process is emptied, and only the login's set, before the launch.
  expect(lastLook < running && running < loginRead && loginRead < cleared && cleared < loginSet && loginSet < launch).toBe(true)
  // The login environment is Windows' own for this user's token, never inheriting the session's.
  expect(start).toContain('CreateEnvironmentBlock(out block, token, false)')
  // Nothing of the session's is named, kept or passed: no variable is set but from the login environment.
  expect(start.match(/SetEnvironmentVariable\(/g)).toHaveLength(2)
  expect(start).not.toMatch(/CLAUDE/)
  // The one variable the script sets by name is its own module path, in the preamble, which the emptying then clears.
  expect(start.match(/\$env:/g)).toEqual(['$env:'])
  expect(start.indexOf('$env:PSModulePath = ')).toBeLessThan(cleared)
  // After the environment is emptied, .NET calls only: no cmdlet to look up, no pipeline.
  const after = start.slice(cleared)
  expect(after).not.toMatch(/ConvertTo-Json|Start-Process|New-Object|Write-Output|\|/)
  // ShellExecute, in Chrome's own folder, never -UseNewEnvironment or -NoNewWindow, which hand Chrome this script's pipes.
  expect(start).toContain('$launch.UseShellExecute = $true')
  expect(start).toContain('$launch.WorkingDirectory = [IO.Path]::GetDirectoryName($chrome)')
  expect(start).not.toMatch(/UseNewEnvironment|NoNewWindow|Start-Sleep -Milliseconds 500/)
  expect(windowsLaunchArgs(undefined, false)).toEqual(['--restore-last-session'])
  expect(() => windowsStartScript(CHROME, ['--profile-directory="a"; calc"'])).toThrow()
  expect(() => windowsStartScript('C:\\Windows\\notepad.exe', [])).toThrow()
  expect(killsAnything([start], [])).toBe(false)
  expect(parseWindowsStart('{"v":1,"started":4321}\r\n')).toEqual({ kind: 'launched', pid: 4321 })
  expect(parseWindowsStart('{"v":1,"started":null}')).toEqual({ kind: 'launched' })
  expect(parseWindowsStart('{"v":1,"running":12}')).toEqual({ kind: 'running', pid: 12 })
  expect(typeof parseWindowsStart('nothing')).toBe('string')
})

test('the reconnect count: only times within the last 10 minutes, the cap at 3', () => {
  expect(reconnectsWithin(null, NOW)).toEqual({ kept: [], isCapped: false })
  expect(reconnectsWithin([NOW - 11 * MINUTE, NOW - MINUTE, NOW], NOW)).toEqual({ kept: [NOW - MINUTE, NOW], isCapped: false })
  expect(reconnectsWithin([NOW - 3, NOW - 2, NOW - 1], NOW)).toEqual({ kept: [NOW - 3, NOW - 2, NOW - 1], isCapped: true })
  expect(reconnectsWithin(['x', NOW + MINUTE], NOW)).toEqual({ kept: [], isCapped: false })
})
