import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import {
  chooseProfile,
  flagChoice,
  hasSwitch,
  judge,
  lastActiveProfile,
  MAC_CHROME,
  macBundle,
  macChromeFault,
  macOpenArgv,
  macStandard,
  parsePs,
  pgrepArgv,
  psArgv,
  silentSetting,
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
const MAC_USER_DATA = `${HOME}/Library/Application Support/Google/Chrome`
const WINDOWS = { OS: 'Windows_NT', SystemRoot: 'C:\\Windows' }
const MAC = { HOME }
/** A tool of Claude in Chrome's, so the session has it as one of its MCP servers. */
const IN_CHROME = 'mcp__claude-in-chrome__tabs_context_mcp'

/** What would quit, kill or restart a process: no script or argv of the plugin's may hold any of these. */
const KILLS = /Stop-Process|taskkill|\.Kill\(|CloseMainWindow|Restart-|killall|pkill|\bkill\b|osascript|quit/i

/**
 * A fixture Local State, as Chrome writes one: the last active profiles, and beside them what the plugin must never
 * read out, the accounts signed in to each profile (made up here).
 */
const localState = (last: unknown) =>
  JSON.stringify({
    browser: { enabled_labs_experiments: [] },
    profile: {
      info_cache: {
        Default: { name: 'Person One', user_name: 'person.one@example.com', gaia_name: 'Person One' },
        'Profile 3': { name: 'Work', user_name: 'person.work@example.com', gaia_name: 'Person Work' },
      },
      last_active_profiles: last,
      last_used: 'Profile 3',
    },
  })

/** A browser process as the look reads it. */
type Proc = { pid: number; exe?: string; cmd: string }

type World = {
  platform?: 'windows' | 'macos' | 'linux' | 'wsl'
  isHosted?: boolean
  env?: Record<string, string>
  /** The Chrome processes running now (no children: the script passes none on). */
  running?: Proc[]
  /** What the start's wait finds; left out, Chrome's browser process with the arguments the start passed. */
  after?: Proc[]
  /** The look's `start`: the chrome.exe that is there to start (null: none is). */
  start?: string | null
  /** Local State's text, or missing. */
  localState?: string | 'missing'
  /** The session's tools. */
  tools?: string[]
  /** What the look's script does. */
  look?: 'answers' | 'fails' | 'garbled'
}

const ANSWERED = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as const
const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

/** The arguments a Windows start script passes Chrome, as its `$arguments` line lists them. */
function argumentsOf(script: string): string[] {
  const list = /\$arguments = @\((.*)\)/.exec(script)?.[1] ?? ''
  return [...list.matchAll(/'((?:[^']|'')*)'/g)].map(m => (m[1] as string).replace(/''/g, "'"))
}

/** The engine beneath the plugin: the machine's processes, Chrome's Local State, the session's tools; and what the plugin ran. */
function engine(on: On, world: World = {}) {
  const platform = world.platform ?? 'windows'
  const isMac = platform === 'macos'
  let running: Proc[] = world.running ?? []
  const scripts: string[] = []
  const argvs: string[][] = []
  const reads: string[] = []
  const commands: string[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  const described: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  const session = mock.session(on)
  mock.env(on, { ...(isMac ? MAC : platform === 'windows' ? WINDOWS : {}), ...world.env })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.info', () => ({ value: { transcriptPath: '', platform, isHosted: world.isHosted === true } }))
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
    if (/[\\/]Local State$/.test(e.path) && world.localState !== undefined && world.localState !== 'missing') return { value: world.localState }
    return { deny: `ENOENT: ${e.path}` }
  })
  // The standard install is there. Matched by its tail: a host on Windows may spell a POSIX path its own way.
  on('fs.exists', (_, e) => ({ value: /[\\/]Google Chrome\.app[\\/]Contents[\\/]MacOS[\\/]Google Chrome$/.test(e.path) }))
  const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    argvs.push(argv)
    if (!isMac) {
      const script = String(e.init?.stdin ?? '')
      scripts.push(script)
      if (/Start-Process/.test(script)) {
        const procs = world.after ?? [{ pid: 4321, cmd: [`"${CHROME}"`, ...argumentsOf(script)].join(' ') }]
        running = procs
        return ok(`${JSON.stringify({ v: 1, procs: procs.map(p => ({ pid: p.pid, exe: p.exe ?? CHROME, cmd: p.cmd })) })}\r\n`)
      }
      if (world.look === 'fails') return { value: { exitCode: 1, stdout: '', stderr: 'Get-CimInstance : Access denied', isStdoutTruncated: false, isStderrTruncated: false } }
      if (world.look === 'garbled') return ok('not json\r\n')
      const line = { v: 1, paths: [CHROME], start: world.start === undefined ? CHROME : world.start, userData: USER_DATA, procs: running.map(p => ({ pid: p.pid, exe: p.exe ?? CHROME, cmd: p.cmd })) }
      return ok(`${JSON.stringify(line)}\r\n`)
    }
    if (argv[0] === '/usr/bin/pgrep') {
      const pids = running.filter(p => p.cmd.startsWith(MAC_CHROME)).map(p => p.pid)
      return pids.length === 0 ? ok('', 1) : ok(`${pids.join('\n')}\n`)
    }
    if (argv[0] === '/bin/ps') {
      const asked = (argv.at(-1) ?? '').split(',').map(Number)
      return ok(running.filter(p => asked.includes(p.pid)).map(p => `${String(p.pid).padStart(5)} ${p.cmd}`).join('\n'))
    }
    if (argv[0] === '/usr/bin/open') {
      running = world.after ?? [{ pid: 4321, cmd: [MAC_CHROME, ...argv.slice(argv.indexOf('--args') + 1)].join(' ') }]
      return ok('')
    }
    if (argv[0] === '/bin/sleep') return ok('')
    return { value: { exitCode: 127, stdout: '', stderr: `no such command: ${argv[0]}`, isStdoutTruncated: false, isStderrTruncated: false } }
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
  return { scripts, argvs, reads, commands, prompts, toasts, described, clock, session }
}

/** The call's result, as text; it must not be refused. */
async function ensure($: Engine, input: Record<string, unknown> = {}): Promise<string> {
  const done = await $.tool.call({ tool: TOOL, ...input })
  expect(done.deny).toBeUndefined()
  return String(done.result)
}

/** Whether anything the plugin ran could quit, kill or restart a process. */
const killsAnything = (scripts: readonly string[], argvs: readonly string[][]) => [...scripts, ...argvs.map(a => a.join(' '))].some(text => KILLS.test(text))

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

test('not running, opted in by the environment variable: Chrome starts with the flag, and the reconnect runs once the turn ends', async ($, on) => {
  const { scripts, argvs, commands, clock } = engine(on, { env: { CLAUDE_CHROME_SILENT_DEBUGGER: '1' }, localState: localState(['Profile 3', 'Default']) })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Chrome: not running\.$/m)
  expect(said).toMatch(/^Flag: on: the silentDebugger setting is auto, and CLAUDE_CHROME_SILENT_DEBUGGER turns it on\.$/m)
  expect(said).toContain(`Did: started Chrome, with the profile folder "Profile 3" (Chrome's last active profile, from its Local State), --restore-last-session and ${FLAG}. It runs as PID 4321, and the flag took.`)
  expect(said).toMatch(/^Reconnect: \/mcp reconnect claude-in-chrome runs once this turn ends/m)
  expect(said).toMatch(/^Left for the person: nothing\.$/m)
  // The look, then the start: Chrome detached, in its own folder, with the profile quoted and the flag.
  expect(scripts).toHaveLength(2)
  expect(argumentsOf(scripts[1] ?? '')).toEqual(['--profile-directory="Profile 3"', '--restore-last-session', FLAG])
  expect(scripts[1]).toContain('Start-Process -FilePath $chrome -ArgumentList $arguments -WorkingDirectory (Split-Path -Parent $chrome)')
  // Windows PowerShell by its known path, the script on standard input.
  expect(argvs[0]?.[0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  expect(killsAnything(scripts, argvs)).toBe(false)
  // Nothing of Local State but the profile folder's name reaches the answer.
  expect(said).not.toMatch(/example\.com|Person|Work"/)

  expect(commands).toEqual([])
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual(['mcp reconnect claude-in-chrome'])
})

test('not running, auto and the variable unset: Chrome starts without the flag', async ($, on) => {
  const { scripts } = engine(on, { localState: localState(['Default']) })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toContain(`Did: started Chrome, with the profile folder "Default" (Chrome's last active profile, from its Local State), --restore-last-session, without ${FLAG}. It runs as PID 4321.`)
  expect(said).toMatch(/^Flag: off: the silentDebugger setting is auto, and CLAUDE_CHROME_SILENT_DEBUGGER doesn't turn it on/m)
  expect(argumentsOf(scripts[1] ?? '')).toEqual(['--profile-directory="Default"', '--restore-last-session'])
})

test('the setting on overrides an unset variable: Chrome starts with the flag', { options: { silentDebugger: 'on' } }, async ($, on) => {
  const { scripts } = engine(on)
  await $.session.start(START)
  expect(await ensure($)).toMatch(/^Flag: on: the silentDebugger setting is on\.$/m)
  expect(argumentsOf(scripts[1] ?? '')).toContain(FLAG)
})

test('the setting off overrides the variable: Chrome starts without the flag', { options: { silentDebugger: 'off' } }, async ($, on) => {
  const { scripts } = engine(on, { env: { CLAUDE_CHROME_SILENT_DEBUGGER: 'true' } })
  await $.session.start(START)
  expect(await ensure($)).toMatch(/^Flag: off: the silentDebugger setting is off\.$/m)
  expect(argumentsOf(scripts[1] ?? '')).not.toContain(FLAG)
})

// ---------------------------------------------------------------------------------------------
// Chrome running.

test('running with the flag: nothing to do, nothing started', async ($, on) => {
  const { scripts, argvs } = engine(on, { env: { CLAUDE_CHROME_SILENT_DEBUGGER: 'on' }, running: [{ pid: 777, cmd: `"${CHROME}" --profile-directory="Profile 3" ${FLAG}` }] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Chrome: running \(PID 777\), with --silent-debugger-extension-api; its command line names the profile folder "Profile 3"\.$/m)
  expect(said).toMatch(/^Did: nothing: Chrome runs, with the flag\.$/m)
  expect(said).toMatch(/^Left for the person: nothing\.$/m)
  expect(scripts).toHaveLength(1)
  expect(scripts[0]).not.toMatch(/Start-Process/)
  expect(killsAnything(scripts, argvs)).toBe(false)
})

test('running without the flag while opted in: it says so and how the person fixes it, and never quits, kills or restarts Chrome', async ($, on) => {
  const { scripts, argvs, commands, clock } = engine(on, { env: { CLAUDE_CHROME_SILENT_DEBUGGER: '1' }, running: [{ pid: 777, cmd: `"${CHROME}" --restore-last-session` }] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Chrome: running \(PID 777\), without --silent-debugger-extension-api; its command line names no profile folder/m)
  expect(said).toContain("Did: nothing to Chrome. Chrome takes flags only when it starts, and this tool never quits, kills or restarts Chrome: that would close every session's tabs and tab groups.")
  expect(said).toMatch(/Left for the person: for the flag, quit Chrome fully .*then call chrome_ensure again; or add --silent-debugger-extension-api to the Target of the shortcut/)
  expect(said).toMatch(/so it is the person's call\.$/m)
  // One look, and nothing else: no start, no quit, no kill.
  expect(scripts).toHaveLength(1)
  expect(scripts[0]).not.toMatch(/Start-Process/)
  expect(killsAnything(scripts, argvs)).toBe(false)
  // Chrome runs, so Claude in Chrome is still reconnected.
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual(['mcp reconnect claude-in-chrome'])
})

test('running without the flag and the flag off: nothing to do', async ($, on) => {
  const { scripts } = engine(on, { running: [{ pid: 777, cmd: `"${CHROME}"` }] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: nothing: Chrome runs, and the flag is off\.$/m)
  expect(said).toMatch(/^Left for the person: nothing\.$/m)
  expect(scripts).toHaveLength(1)
})

test("a test or isolated Chrome with its own --user-data-dir isn't the person's: Chrome starts beside it", async ($, on) => {
  const { scripts } = engine(on, { running: [{ pid: 55, cmd: `"${CHROME}" --user-data-dir="C:\\Temp\\playwright-1" --remote-debugging-port=0` }] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Chrome: not running\. 1 other Chrome, with its own --user-data-dir \(a test or isolated Chrome\), isn't counted\.$/m)
  expect(said).toMatch(/Did: started Chrome/)
  // The isolated one's path never reaches the answer.
  expect(said).not.toContain('playwright')
  expect(scripts).toHaveLength(2)
})

test('the person\'s Chrome started with its own default folder named is still the person\'s', () => {
  const procs = [{ pid: 9, exe: CHROME, cmd: `"${CHROME}" --user-data-dir="${USER_DATA}\\" ${FLAG}` }]
  expect(judge(procs, { platform: 'windows', paths: [CHROME], userData: USER_DATA })).toEqual({ browsers: [{ pid: 9, flag: true, namesProfile: false }], isolated: 0 })
})

test("a child process (--type=) is never the browser, nor another program's chrome.exe", () => {
  const procs = [
    { pid: 10, exe: CHROME, cmd: `"${CHROME}" --type=renderer --profile-directory="Default"` },
    { pid: 11, exe: CHROME, cmd: `"${CHROME}" "--type=crashpad-handler"` },
    { pid: 12, exe: 'C:\\Tools\\ms-playwright\\chromium-1\\chrome-win\\chrome.exe', cmd: '"C:\\Tools\\ms-playwright\\chromium-1\\chrome-win\\chrome.exe"' },
    // ExecutablePath unread (access denied): the command line's first argument says which chrome.exe.
    { pid: 13, exe: '', cmd: `"${CHROME.toUpperCase()}" --profile-directory=Default` },
  ]
  expect(judge(procs, { platform: 'windows', paths: [CHROME], userData: USER_DATA })).toEqual({ browsers: [{ pid: 13, flag: false, profile: 'Default', namesProfile: true }], isolated: 0 })
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

test('the profile default from a fixture Local State: its first last active profile, and nothing else of the file', () => {
  expect(lastActiveProfile(localState(['Profile 3', 'Default']))).toEqual({ profile: 'Profile 3' })
  expect(lastActiveProfile(`\uFEFF${localState(['Default'])}`)).toEqual({ profile: 'Default' })
  expect(lastActiveProfile(localState([]))).toEqual({ why: 'its Local State lists no last active profile' })
  expect(lastActiveProfile(localState(undefined))).toEqual({ why: 'its Local State lists no last active profile' })
  expect(lastActiveProfile(localState(['..\\elsewhere']))).toEqual({ why: "the first of its last active profiles isn't a plain folder name" })
  expect(lastActiveProfile('{ torn')).toEqual({ why: "its Local State isn't JSON" })
  // Nothing of an account ever comes back.
  expect(JSON.stringify(lastActiveProfile(localState(['Profile 3'])))).not.toMatch(/example\.com|Person/)
})

test('which profile a start opens: the call, then the setting, then Local State, then Default', () => {
  const read = { profile: 'Profile 3' }
  expect(chooseProfile('Work', 'Profile 9', read)).toEqual({ profile: 'Work', from: 'asked for in this call' })
  expect(chooseProfile(undefined, 'Profile 9', read)).toEqual({ profile: 'Profile 9', from: 'the profile setting' })
  expect(chooseProfile(undefined, '', read)).toEqual({ profile: 'Profile 3', from: "Chrome's last active profile, from its Local State" })
  expect(chooseProfile(undefined, '', { why: "its Local State can't be read" })).toEqual({ profile: 'Default', from: "Chrome's first profile: its Local State can't be read" })
  expect(chooseProfile(undefined, '', undefined)).toEqual({ profile: 'Default', from: "Chrome's first profile" })
  expect('refusal' in chooseProfile(undefined, 'a"b', read)).toBe(true)
})

test("the call's profile wins, and Local State isn't read", { options: { profile: 'Profile 9' } }, async ($, on) => {
  const { scripts, reads } = engine(on, { localState: localState(['Profile 3']) })
  await $.session.start(START)
  const said = await ensure($, { profile: ' Work ' })
  expect(said).toContain('with the profile folder "Work" (asked for in this call)')
  expect(argumentsOf(scripts[1] ?? '')[0]).toBe('--profile-directory="Work"')
  expect(reads.filter(path => /Local State$/.test(path))).toEqual([])
})

test("the profile setting wins over Local State, which isn't read", { options: { profile: 'Profile 9' } }, async ($, on) => {
  const { scripts, reads } = engine(on, { localState: localState(['Profile 3']) })
  await $.session.start(START)
  expect(await ensure($)).toContain('with the profile folder "Profile 9" (the profile setting)')
  expect(argumentsOf(scripts[1] ?? '')[0]).toBe('--profile-directory="Profile 9"')
  expect(reads.filter(path => /Local State$/.test(path))).toEqual([])
})

test("no Local State: the start opens Default, saying why; Local State is read at Chrome's own folder", async ($, on) => {
  const { reads } = engine(on, { localState: 'missing' })
  await $.session.start(START)
  expect(await ensure($)).toContain(`with the profile folder "Default" (Chrome's first profile: its Local State can't be read)`)
  expect(reads.filter(path => /Local State$/.test(path))).toEqual([`${USER_DATA}\\Local State`])
})

test("a profile setting that isn't a folder's name starts nothing", { options: { profile: 'Profile "x"' } }, async ($, on) => {
  const { scripts } = engine(on)
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: nothing: the profile setting reads .+, which is no profile folder's name\.$/m)
  expect(said).toMatch(/^Left for the person: set it to a profile folder's name/m)
  expect(scripts).toHaveLength(1)
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
// Starts that don't go as planned, and looks that fail.

test('the flag asked for but not taken: it says so, and how the person adds it', async ($, on) => {
  const { scripts } = engine(on, { env: { CLAUDE_CHROME_SILENT_DEBUGGER: '1' }, after: [{ pid: 4321, cmd: `"${CHROME}"` }] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/It runs as PID 4321, but without the flag: a Chrome already starting may have taken the launch\./)
  expect(said).toMatch(/^Left for the person: for the flag, quit Chrome fully/m)
  expect(scripts).toHaveLength(2)
})

test('started, but no browser process within 20 s: it says so, and the reconnect still goes', async ($, on) => {
  const { commands, clock } = engine(on, { after: [] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/Did: asked Chrome to start, with .+, but no browser process of it showed within 20 s\./)
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual(['mcp reconnect claude-in-chrome'])
})

test("Chrome not installed at its standard paths: nothing started, and the setting that fixes it named", async ($, on) => {
  const { scripts, commands, clock } = engine(on, { start: null })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Did: nothing: Chrome isn't at its standard install paths/m)
  expect(said).toMatch(/^Left for the person: set the chromePath setting to chrome\.exe's absolute path\.$/m)
  expect(said).toMatch(/^Reconnect: not queued: Chrome isn't known to run\./m)
  expect(scripts).toHaveLength(1)
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual([])
})

test("the look fails: nothing started, nothing queued", async ($, on) => {
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

// ---------------------------------------------------------------------------------------------
// The reconnect.

test("the reconnect is queued only when Claude in Chrome is one of the session's MCP servers", async ($, on) => {
  const { commands, clock } = engine(on, { running: [{ pid: 777, cmd: `"${CHROME}"` }], tools: ['Bash', 'mcp__other__tool'] })
  await $.session.start(START)
  expect(await ensure($)).toMatch(/^Reconnect: not queued: Claude in Chrome isn't one of this session's MCP servers \(no mcp__claude-in-chrome__ tool is listed\)\.$/m)
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual([])
})

test('reconnect false queues nothing', async ($, on) => {
  const { commands, clock } = engine(on, { running: [{ pid: 777, cmd: `"${CHROME}"` }] })
  await $.session.start(START)
  expect(await ensure($, { reconnect: false })).toMatch(/^Reconnect: not asked for \(reconnect is false\)\.$/m)
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

test("without resume, the model is told on its next turn", async ($, on) => {
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

test('the description says it never quits Chrome, and to end the turn once the reconnect is queued', async ($, on) => {
  const { described } = engine(on)
  await $.session.start(START)
  const said = described.at(-1) ?? ''
  expect(said).toContain("It never quits, kills or restarts Chrome, which would close every session's tabs and tab groups")
  expect(said).toContain('When it says the reconnect is queued, end your turn and do nothing more until it has run; then carry on.')
})

// ---------------------------------------------------------------------------------------------
// Elsewhere than Windows and macOS.

test('on Linux, WSL or a hosted server: nothing looked for, started or queued', async ($, on) => {
  const linux = engine(on, { platform: 'linux' })
  await $.session.start(START)
  expect(await ensure($)).toBe('Chrome: not looked for. self-chrome looks after Chrome on Windows and macOS, on the machine Chrome runs on, and this session runs on linux. Nothing was started or queued.')
  expect(linux.argvs).toEqual([])
  await $.turn.complete(ANSWERED)
  await linux.clock.advance(1000)
  expect(linux.commands).toEqual([])
})

test('a hosted server is not the machine Chrome runs on', async ($, on) => {
  const { argvs } = engine(on, { platform: 'macos', isHosted: true })
  await $.session.start(START)
  expect(await ensure($)).toMatch(/this session runs on a hosted server, not the machine Chrome runs on\./)
  expect(argvs).toEqual([])
})

// ---------------------------------------------------------------------------------------------
// macOS.

test('macOS argument building: open -a with the .app, the arguments after --args; pgrep by the binary; ps of those alone', () => {
  expect(macBundle(MAC_CHROME)).toBe('/Applications/Google Chrome.app')
  expect(macOpenArgv(MAC_CHROME, 'Profile 3', true)).toEqual(['/usr/bin/open', '-a', '/Applications/Google Chrome.app', '--args', '--profile-directory=Profile 3', '--restore-last-session', FLAG])
  expect(macOpenArgv(MAC_CHROME, 'Default', false)).toEqual(['/usr/bin/open', '-a', '/Applications/Google Chrome.app', '--args', '--profile-directory=Default', '--restore-last-session'])
  expect(() => macOpenArgv('/usr/local/bin/chrome', 'Default', false)).toThrow()
  expect(() => macOpenArgv(MAC_CHROME, '../x', false)).toThrow()
  expect(pgrepArgv([MAC_CHROME])).toEqual(['/usr/bin/pgrep', '-f', '^(/Applications/Google Chrome\\.app/Contents/MacOS/Google Chrome)( |$)'])
  expect(psArgv([12, 34])).toEqual(['/bin/ps', '-ww', '-o', 'pid=,command=', '-p', '12,34'])
  expect(macStandard(HOME)).toEqual([MAC_CHROME, `${HOME}${MAC_CHROME}`])
  expect(macStandard(undefined)).toEqual([MAC_CHROME])
  expect(macChromeFault(MAC_CHROME)).toBeUndefined()
  expect(macChromeFault('/Applications/Google Chrome.app')).toBeDefined()
  expect(macChromeFault('/Applications/../Google Chrome.app/Contents/MacOS/Google Chrome')).toBeDefined()
  // ps's lines: a binary path with spaces in it, matched whole.
  expect(parsePs(`  412 ${MAC_CHROME} --profile-directory=Default\n 9 /usr/bin/other\n`, [MAC_CHROME])).toEqual([
    { pid: 412, exe: MAC_CHROME, cmd: `${MAC_CHROME} --profile-directory=Default` },
    { pid: 9, exe: '', cmd: '/usr/bin/other' },
  ])
})

test('macOS, not running: open starts Chrome with the profile and the flag, and the wait finds it', async ($, on) => {
  const { argvs, commands, clock } = engine(on, { platform: 'macos', env: { CLAUDE_CHROME_SILENT_DEBUGGER: '1' }, localState: localState(['Profile 3']) })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toContain(`Did: started Chrome, with the profile folder "Profile 3" (Chrome's last active profile, from its Local State), --restore-last-session and ${FLAG}. It runs as PID 4321, and the flag took.`)
  expect(argvs.find(a => a[0] === '/usr/bin/open')).toEqual(['/usr/bin/open', '-a', '/Applications/Google Chrome.app', '--args', '--profile-directory=Profile 3', '--restore-last-session', FLAG])
  // The first look, open, then a sleep and a look until the browser shows.
  expect(argvs.map(a => a[0])).toEqual(['/usr/bin/pgrep', '/usr/bin/open', '/bin/sleep', '/usr/bin/pgrep', '/bin/ps'])
  expect(killsAnything([], argvs)).toBe(false)
  await $.turn.complete(ANSWERED)
  await clock.advance(1000)
  expect(commands).toEqual(['mcp reconnect claude-in-chrome'])
})

test("macOS, Local State is read in Chrome's own folder under the home folder", async ($, on) => {
  const { reads } = engine(on, { platform: 'macos', localState: 'missing' })
  await $.session.start(START)
  await ensure($)
  const read = reads.filter(path => /Local State$/.test(path))
  expect(read).toHaveLength(1)
  expect(read[0]?.replace(/\\/g, '/').endsWith(`${MAC_USER_DATA}/Local State`)).toBe(true)
})

test('macOS, running without the flag while opted in: it says so, and never quits Chrome', async ($, on) => {
  const { argvs } = engine(on, { platform: 'macos', env: { CLAUDE_CHROME_SILENT_DEBUGGER: '1' }, running: [{ pid: 412, cmd: `${MAC_CHROME} --profile-directory=Profile 3` }] })
  await $.session.start(START)
  const said = await ensure($)
  expect(said).toMatch(/^Chrome: running \(PID 412\), without --silent-debugger-extension-api; its command line names the profile folder "Profile 3"\.$/m)
  expect(said).toMatch(/quit Chrome fully \(Cmd\+Q, every window\), then call chrome_ensure again; or start Chrome with it by hand: open -a "Google Chrome" --args --silent-debugger-extension-api/)
  expect(argvs.map(a => a[0])).toEqual(['/usr/bin/pgrep', '/bin/ps'])
  expect(killsAnything([], argvs)).toBe(false)
})

// ---------------------------------------------------------------------------------------------
// Windows' scripts.

test("Windows' scripts: fixed text around checked inputs, Chrome's own folder, Claude Code's markers cleared, nothing quit", () => {
  const look = windowsLookScript(undefined)
  expect(look).toContain("[Environment]::GetFolderPath('ProgramFiles')")
  expect(look).toContain('$configured = $null')
  expect(look).not.toMatch(/\$env:ProgramFiles/)
  expect(windowsLookScript(CHROME)).toContain(`$configured = '${CHROME}'`)
  expect(() => windowsLookScript("C:\\x'; Remove-Item C:\\ -Recurse; '\\chrome.exe")).toThrow()
  const start = windowsStartScript(CHROME, windowsLaunchArgs('Profile 3', true))
  expect(argumentsOf(start)).toEqual(['--profile-directory="Profile 3"', '--restore-last-session', FLAG])
  expect(start).toMatch(/foreach \(\$name in @\([^)]*'CLAUDECODE'[^)]*'CLAUDE_CODE_SESSION_ID'[^)]*\)\) \{ Remove-Item -LiteralPath \('Env:' \+ \$name\)/)
  expect(start).toContain('-WorkingDirectory (Split-Path -Parent $chrome)')
  expect(() => windowsStartScript(CHROME, ['--profile-directory="a"; calc"'])).toThrow()
  expect(() => windowsStartScript('C:\\Windows\\notepad.exe', [])).toThrow()
  expect(killsAnything([look, start], [])).toBe(false)
  expect(windowsChromeFault(CHROME)).toBeUndefined()
  expect(windowsChromeFault('chrome.exe')).toBeDefined()
})
