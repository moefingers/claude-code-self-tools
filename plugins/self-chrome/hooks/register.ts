// A session makes sure Chrome runs for Claude in Chrome, and reconnects Claude in Chrome (#54). A session sometimes
// decides Claude in Chrome isn't connected when all it needs is Chrome started, or the MCP reconnected; the model
// calls chrome_ensure, and the plugin:
// 1. Looks for the person's Chrome: the browser process of the configured chrome.exe (or Google Chrome binary on
//    macOS) on the default user data folder, never a test or isolated Chrome with a --user-data-dir of its own; and
//    whether it started with --silent-debugger-extension-api. On Windows through a fixed Windows PowerShell script, as
//    the shared machine code reads processes (machine.ts: powershellCall); on macOS with pgrep and ps.
// 2. Starts Chrome when it isn't running, detached: the profile folder, --restore-last-session, and the flag when the
//    person opted in (the silentDebugger setting, or CLAUDE_CHROME_SILENT_DEBUGGER while it is auto). Then it waits up
//    to 20 s for the browser process, and says its PID and whether the flag took.
// 3. Never quits, kills or restarts Chrome: that closes every session's tabs and tab groups. A Chrome running without
//    the flag the person opted in to is said, with how the person fixes it.
// 4. Queues `/mcp reconnect claude-in-chrome` for when the turn ends, as self-mcp does, only while Claude in Chrome is
//    one of the session's MCP servers and Chrome runs; then resumes with `resume`, or tells the model.
// The rules are in chrome.ts, pure; this file runs them. It hooks no event Claude Code's built-in guard passes over.
import type { EngineInterface, Register } from 'claude-code'
import type { Queued } from '../types'
import {
  answer,
  type Browser,
  type ChromeProcess,
  chooseProfile,
  type FlagChoice,
  flagChoice,
  isProfileName,
  isRunning,
  judge,
  lastActiveProfile,
  type LocalStateRead,
  type Look,
  macChromeFault,
  macOpenArgv,
  macStandard,
  macUserData,
  parsePids,
  parsePs,
  parseWindowsLook,
  parseWindowsStart,
  pgrepArgv,
  type Platform,
  type ProfileChoice,
  psArgv,
  type Reconnect,
  SERVER,
  type SilentSetting,
  silentSetting,
  SLEEP,
  type Start,
  START_WAIT_S,
  windowsChromeFault,
  windowsLaunchArgs,
  windowsLookScript,
  windowsStartScript,
} from './chrome'
import { oneLine, plainOutput, powershellCall, powershellPath, SYSTEM_ROOT, within } from './machine'
import { configureUpdateCheck, loadUpdateCheck, withUpdateNotice } from './update-check'

const TOOL = 'mcp__self-chrome__chrome_ensure'
const queued = { plugin: 'self-chrome', key: 'queued' } as const

/** How long the look's script may take on Windows: Get-CimInstance can be slow on a loaded machine. */
const LOOK_MS = 30_000
/** How long the start's script may take on Windows: its wait for the browser process, and the look after it. */
const START_MS = (START_WAIT_S + 25) * 1000
/** How long each of macOS's open, pgrep and ps may take. */
const MAC_MS = 10_000
/** How long reading Chrome's Local State may take. */
const LOCAL_STATE_MS = 5_000

/** When the reconnect starts after the turn's end: at once, the moment the turn's end returns, as self-mcp's. */
const TURN_END_MS = 0

/** The plugin's settings, read at load. */
let silent: SilentSetting = 'auto'
let profileSetting = ''
let chromePathSetting = ''

// ---------------------------------------------------------------------------------------------
// The person's message after the reconnect was queued: self-mcp's rule, for the same reason. The reconnect does no
// harm late, but its resume would: a person who typed "stop" meanwhile would be answered by the old "go on". So a
// message from the person after the arm marks it, and the resume goes to the model as a note instead of starting a
// turn. The message is known by the turn it came in over, never by its words: no prompt text is held or logged.

type Typed = { entered: boolean; arms: Set<Arm> }
/** One reconnect armed at a turn's end: stale once a person's prompt that marked it entered, or while one in flight holds it. */
type Arm = { sure: boolean; marks: Set<Typed> }
/** The reconnects armed and not yet reported. */
const openArms = new Set<Arm>()
/** The main-loop turns a person's prompt was typed over, each with those prompts. Emptied at each main-loop turn's end. */
const typedOver = new Map<string, Set<Typed>>()

const isStale = (arm: Arm): boolean => arm.sure || arm.marks.size > 0

function mark(arm: Arm, typed: Typed): void {
  if (typed.entered) arm.sure = true
  else {
    arm.marks.add(typed)
    typed.arms.add(arm)
  }
}

/** At a person's prompt, before it enters: every open arm marked, and the turn it was typed over noted. */
function personTyped(turnId: string | undefined): Typed {
  const typed: Typed = { entered: false, arms: new Set() }
  for (const arm of openArms) mark(arm, typed)
  if (turnId !== undefined) typedOver.set(turnId, (typedOver.get(turnId) ?? new Set<Typed>()).add(typed))
  return typed
}

/** The prompt entered: what it marked stays marked. */
function personEntered(typed: Typed): void {
  typed.entered = true
  for (const arm of typed.arms) {
    arm.marks.delete(typed)
    arm.sure = true
  }
  typed.arms.clear()
}

/** The prompt was dropped: its marks taken back, and its turn no longer held for it. */
function personDropped(typed: Typed, turnId: string | undefined): void {
  for (const arm of typed.arms) arm.marks.delete(typed)
  typed.arms.clear()
  if (turnId === undefined) return
  const held = typedOver.get(turnId)
  held?.delete(typed)
  if (held?.size === 0) typedOver.delete(turnId)
}

/** At a main-loop turn's end: its arm, marked by the person's prompts typed over the turn. */
function armAt(turnId: string): Arm {
  const arm: Arm = { sure: false, marks: new Set() }
  for (const typed of typedOver.get(turnId) ?? []) mark(arm, typed)
  openArms.add(arm)
  return arm
}

/** An arm whose reconnect has reported, or that queued nothing: it is marked no more. */
function closeArm(arm: Arm): void {
  openArms.delete(arm)
  for (const typed of arm.marks) typed.arms.delete(arm)
  arm.marks.clear()
}

// ---------------------------------------------------------------------------------------------
// The tool.

const DESCRIPTION = [
  'Makes sure Chrome runs for Claude in Chrome, and reconnects Claude in Chrome: for when its tools say the browser is not connected, before asking the person.',
  "It looks for the person's Chrome (its browser process on the default user data folder; never a test or isolated Chrome), starts it when it isn't running (the profile folder, the last session restored, and --silent-debugger-extension-api when the person opted in), and queues /mcp reconnect claude-in-chrome for when this turn ends, when Claude in Chrome is one of this session's MCP servers.",
  "It never quits, kills or restarts Chrome, which would close every session's tabs and tab groups: when Chrome runs without the flag the person opted in to, it says how the person can fix it. It never signs in or types anything into Chrome.",
  '`profile` (optional) is the profile folder a start opens, by its name (Default, Profile 2), never an account; left out, the plugin\'s setting, else Chrome\'s last active profile, else Default. `reconnect` (default true) queues the reconnect. `resume` is the message that starts your next turn once the reconnect has run: what to try again.',
  "The reconnect runs when the session is idle: Claude Code queues a plugin's command behind anything already waiting (a message typed during this turn, a background task's notification), so under a nonstop stream of work and notifications it may run in the distant future. Nothing waiting is lost.",
  'Windows and macOS. When it says the reconnect is queued, end your turn and do nothing more until it has run; then carry on.',
].join(' ')

const SUBAGENT =
  "A subagent can't start Chrome or reconnect the session's MCP servers. Finish your piece and return its result, saying that Claude in Chrome isn't connected: the main session can call chrome_ensure."

/** Trimmed text, or undefined when it is not a string or is blank. */
function text(raw: unknown): string | undefined {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed === '' ? undefined : trimmed
}

/** Why something failed, as one line. */
function why(err: unknown): string {
  const said = oneLine(err instanceof Error ? err.message : String(err), 300)
  return said === '' ? 'no reason given' : said
}

/**
 * A variable of this process's environment, or undefined when unset or unreadable. `read` is the engine's read with
 * the variable's name written out: the engine lists the variables a module reads by the literal names at its call sites.
 */
async function env(read: () => Promise<string | undefined>): Promise<string | undefined> {
  try {
    return await read()
  } catch {
    return undefined
  }
}

/** Where the session runs: Windows or macOS, or a phrase saying where else (a hosted server, Linux, WSL). */
async function platformOf($: EngineInterface): Promise<Platform | string> {
  let platform: string | undefined
  let isHosted = false
  try {
    const info = await $.session.info()
    platform = info.platform
    isHosted = info.isHosted === true
  } catch {
    // Read from the environment below.
  }
  if (isHosted) return 'a hosted server, not the machine Chrome runs on'
  if (platform === 'windows' || platform === 'macos') return platform
  if ((platform === undefined || platform === 'unknown') && (await env(() => $.env.get('OS'))) === 'Windows_NT') return 'windows'
  if (platform === 'wsl') return 'WSL, whose processes are not Windows\' own'
  return platform === undefined || platform === 'unknown' ? 'a platform Claude Code does not name' : platform
}

/** What the look and the start came to. */
type Found = { readonly look: Look; readonly start: Start }

const none: Start = { kind: 'none' }
const lookFailed = (whyNot: string): Found => ({ look: { kind: 'failed', why: whyNot }, start: none })

/** Chrome's Local State's last active profile, read within LOCAL_STATE_MS; why not, when it can't be. */
async function readLocalState($: EngineInterface, path: string): Promise<LocalStateRead> {
  try {
    const read = await within($, LOCAL_STATE_MS, $.fs.read(path))
    if (read === undefined) return { why: `its Local State wasn't read within ${LOCAL_STATE_MS / 1000} s` }
    return lastActiveProfile(String(read.value))
  } catch {
    return { why: "its Local State can't be read" }
  }
}

/** The profile a start opens: Local State is read only when neither the call nor the setting names one. */
async function profileFor($: EngineInterface, asked: string | undefined, localState: string | undefined): Promise<ProfileChoice> {
  if (asked !== undefined || profileSetting !== '' || localState === undefined) return chooseProfile(asked, profileSetting, undefined)
  return chooseProfile(undefined, '', await readLocalState($, localState))
}

/** One fixed script in Windows PowerShell, by its known path: its output, or why it failed, as a phrase. */
async function powershell($: EngineInterface, exe: string, script: string, ms: number): Promise<{ readonly stdout: string } | string> {
  try {
    const call = powershellCall(exe, script)
    const run = await $.process.run(call.argv, { stdin: call.stdin, timeoutMs: ms })
    if (run.exitCode !== 0) {
      const err = plainOutput(run.stderr)
      return `exited ${run.exitCode}${err === '' ? '' : `: ${err}`}`
    }
    return { stdout: run.stdout }
  } catch (err) {
    return `didn't run (${why(err)})`
  }
}

async function ensureWindows($: EngineInterface, flag: FlagChoice, asked: string | undefined): Promise<Found> {
  const root = await env(() => $.env.get('SystemRoot'))
  if (root === undefined || !SYSTEM_ROOT.test(root)) return lookFailed(`the Windows folder (SystemRoot) reads ${JSON.stringify(root ?? '')}, so Windows PowerShell can't be found by its known path`)
  const exe = powershellPath(root)
  const configured = chromePathSetting === '' ? undefined : chromePathSetting
  const fault = configured === undefined ? undefined : windowsChromeFault(configured)
  if (fault !== undefined) return lookFailed(`the chromePath setting ${fault}; set it to chrome.exe's absolute path, or empty it for the standard installs`)
  const ran = await powershell($, exe, windowsLookScript(configured), LOOK_MS)
  if (typeof ran === 'string') return lookFailed(`the look ${ran}`)
  const look = parseWindowsLook(ran.stdout)
  if (typeof look === 'string') return lookFailed(look)
  const where = { platform: 'windows', paths: look.paths, userData: look.userData } as const
  const judged = judge(look.procs, where)
  const found: Look = { kind: 'read', judged }
  if (judged.browsers.length > 0) return { look: found, start: none }
  if (look.start === undefined) {
    return {
      look: found,
      start: {
        kind: 'refused',
        why: configured === undefined ? "Chrome isn't at its standard install paths (under Program Files, or the per-user install)" : 'the chromePath setting names no file',
        fix: "set the chromePath setting to chrome.exe's absolute path",
      },
    }
  }
  const profile = await profileFor($, asked, look.userData === undefined ? undefined : `${look.userData}\\Local State`)
  if ('refusal' in profile) return { look: found, start: { kind: 'refused', why: profile.refusal, fix: profile.fix } }
  const started = await powershell($, exe, windowsStartScript(look.start, windowsLaunchArgs(profile.profile, flag.on)), START_MS)
  if (typeof started === 'string') return { look: found, start: { kind: 'failed', why: `the start ${started}` } }
  const after = parseWindowsStart(started.stdout)
  if (typeof after === 'string') return { look: found, start: { kind: 'failed', why: after } }
  return { look: found, start: startedAs(profile, flag, judge(after, where).browsers[0]) }
}

/** The start that ran, with the browser process that showed after it, if any. */
const startedAs = (profile: { readonly profile: string; readonly from: string }, flag: FlagChoice, shown: Browser | undefined): Start => ({
  kind: 'started',
  profile: profile.profile,
  from: profile.from,
  flag: flag.on,
  ...(shown === undefined ? {} : { browser: shown }),
})

/** The look on macOS: pgrep for Chrome's binaries, then ps of those processes alone. A string says why it failed. */
async function lookMac($: EngineInterface, paths: readonly string[]): Promise<ChromeProcess[] | string> {
  try {
    const found = await $.process.run(pgrepArgv(paths), { timeoutMs: MAC_MS })
    // pgrep exits 1 when nothing matched.
    if (found.exitCode === 1) return []
    if (found.exitCode !== 0) return `pgrep exited ${found.exitCode}${found.stderr.trim() === '' ? '' : `: ${oneLine(found.stderr, 200)}`}`
    const pids = parsePids(found.stdout)
    if (pids.length === 0) return []
    const listed = await $.process.run(psArgv(pids), { timeoutMs: MAC_MS })
    // ps exits 1 when a process it was asked about has gone meanwhile; it lists the rest.
    if (listed.exitCode !== 0 && listed.exitCode !== 1) return `ps exited ${listed.exitCode}${listed.stderr.trim() === '' ? '' : `: ${oneLine(listed.stderr, 200)}`}`
    return parsePs(listed.stdout, paths)
  } catch (err) {
    return `the look didn't run (${why(err)})`
  }
}

/** The first of `paths` that is there. */
async function firstThere($: EngineInterface, paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      if (await $.fs.exists(path)) return path
    } catch {
      // Not there, as far as this read can tell.
    }
  }
  return undefined
}

async function ensureMac($: EngineInterface, flag: FlagChoice, asked: string | undefined): Promise<Found> {
  const home = await env(() => $.env.get('HOME'))
  const fault = chromePathSetting === '' ? undefined : macChromeFault(chromePathSetting)
  if (fault !== undefined) return lookFailed(`the chromePath setting ${fault}; set it to that binary, or empty it for the standard install`)
  const paths = chromePathSetting === '' ? macStandard(home) : [chromePathSetting]
  const where = { platform: 'macos', paths, userData: macUserData(home) } as const
  const first = await lookMac($, paths)
  if (typeof first === 'string') return lookFailed(first)
  const judged = judge(first, where)
  const found: Look = { kind: 'read', judged }
  if (judged.browsers.length > 0) return { look: found, start: none }
  const binary = await firstThere($, paths)
  if (binary === undefined) {
    return {
      look: found,
      start: {
        kind: 'refused',
        why: chromePathSetting === '' ? "Chrome isn't at its standard install path (/Applications/Google Chrome.app)" : 'the chromePath setting names no file',
        fix: 'set the chromePath setting to the Google Chrome binary inside its .app',
      },
    }
  }
  const profile = await profileFor($, asked, where.userData === undefined ? undefined : `${where.userData}/Local State`)
  if ('refusal' in profile) return { look: found, start: { kind: 'refused', why: profile.refusal, fix: profile.fix } }
  try {
    const opened = await $.process.run(macOpenArgv(binary, profile.profile, flag.on), { timeoutMs: MAC_MS })
    if (opened.exitCode !== 0) {
      return { look: found, start: { kind: 'failed', why: `open exited ${opened.exitCode}${opened.stderr.trim() === '' ? '' : `: ${oneLine(opened.stderr, 200)}`}` } }
    }
  } catch (err) {
    return { look: found, start: { kind: 'failed', why: `open didn't run (${why(err)})` } }
  }
  // A look a second, up to START_WAIT_S of them. The wait is a sleep process, never the hook's own clock: a hook's
  // own time is bounded, and the engine stops that clock while a `$` call is in flight.
  let shown: Browser | undefined
  for (let i = 0; i < START_WAIT_S && shown === undefined; i += 1) {
    try {
      await $.process.run([SLEEP, '1'], { timeoutMs: 5_000 })
    } catch {
      // The next look goes at once.
    }
    const now = await lookMac($, paths)
    if (typeof now !== 'string') shown = judge(now, where).browsers[0]
  }
  return { look: found, start: startedAs(profile, flag, shown) }
}

/**
 * The reconnect, queued for when the turn ends: only when it was asked for, Chrome runs (found, or started), and
 * Claude in Chrome is one of this session's MCP servers (one of its tools is listed).
 */
async function queueReconnect($: EngineInterface, asked: boolean, running: boolean, resume: string | undefined): Promise<Reconnect> {
  if (!asked) return { kind: 'not-asked' }
  if (!running) return { kind: 'not-running' }
  try {
    if (!(await $.tool.list()).some(t => t.name.startsWith(`mcp__${SERVER}__`))) return { kind: 'absent' }
  } catch (err) {
    return { kind: 'unlisted', why: why(err) }
  }
  try {
    await $.state.set(queued, resume === undefined ? {} : { resume })
  } catch {
    return { kind: 'failed' }
  }
  $.ui.status('Claude in Chrome reconnect queued for when this turn ends')
  return resume === undefined ? { kind: 'queued' } : { kind: 'queued', resume }
}

// ---------------------------------------------------------------------------------------------
// The reconnect, once the turn has ended.

/** Tells the model on its next turn, in a row it reads and the person doesn't see as typed. */
async function tellModel($: EngineInterface, note: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
  } catch {
    // The toast has told the person; there is no other way to reach the model.
  }
}

async function sendResume($: EngineInterface, said: string, resume: string): Promise<void> {
  try {
    const sent = await $.prompt.submit({ text: `${said} Resume: ${resume}` })
    if (sent.drop !== undefined) $.ui.toast(`Resume not sent: ${sent.drop}`)
  } catch {
    $.ui.toast('Resume not sent; the session waits for the next message.')
  }
}

/** How many of Claude in Chrome's tools the session lists now, as a sentence; empty when the list can't be read. */
async function toolsNow($: EngineInterface): Promise<string> {
  try {
    const count = (await $.tool.list()).filter(t => t.name.startsWith(`mcp__${SERVER}__`)).length
    return count === 0 ? ' None of its tools are listed now.' : count === 1 ? ' 1 of its tools is listed now.' : ` ${count} of its tools are listed now.`
  } catch {
    return ''
  }
}

/** Runs the reconnect, then tells the person and the model what it said. Its arm is closed however it ends. */
async function reconnectNow($: EngineInterface, value: Queued, arm: Arm): Promise<void> {
  try {
    $.ui.status(undefined)
    let said: string
    try {
      const output = text((await $.command.run({ command: 'mcp', args: `reconnect ${SERVER}` })).text)
      // /mcp shows its outcome as its own transcript line, which the person and the model both read, and hands the
      // caller no text; a version that hands one back has it passed on.
      said =
        output === undefined
          ? `Claude in Chrome reconnect ran: Claude Code's own line above says whether it reconnected.${await toolsNow($)}`
          : `Claude in Chrome reconnect: ${oneLine(output)}${await toolsNow($)}`
    } catch (err) {
      said = `Claude in Chrome reconnect didn't run: ${why(err)}.`
    }
    $.ui.toast(said)
    if (value.resume === undefined) await tellModel($, said)
    else if (!isStale(arm)) await sendResume($, said, value.resume)
    else {
      $.ui.toast('Resume not sent: your message came after the reconnect was queued, so the model has it as a note.')
      await tellModel($, `${said} The person's message came after the reconnect was queued, so its resume wasn't sent as a new message. It was: ${value.resume}`)
    }
  } finally {
    closeArm(arm)
  }
}

export const register: Register = (on, options) => {
  configureUpdateCheck('self-chrome', options)
  silent = silentSetting(options.silentDebugger)
  profileSetting = typeof options.profile === 'string' ? options.profile.trim() : ''
  chromePathSetting = typeof options.chromePath === 'string' ? options.chromePath.trim() : ''

  // First, so it is outermost on this plugin's tools: it sees each answer, and adds the update notice when one is
  // due. It never waits on the check; see update-check.ts.
  on('tool.call', { tool: /^mcp__self-chrome__/ }, async ($, e, next) => withUpdateNotice($, e, await next(e))).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'chrome_ensure',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          profile: {
            type: 'string',
            description: "The profile folder a start opens, by its folder's name (Default, Profile 2), never an account. Used only when Chrome isn't running. Left out: the plugin's profile setting, else Chrome's last active profile, else Default.",
          },
          reconnect: {
            type: 'boolean',
            description: 'Queue /mcp reconnect claude-in-chrome for when this turn ends (default true): only when Claude in Chrome is one of this session\'s MCP servers and Chrome runs.',
          },
          resume: {
            type: 'string',
            description: 'The message that starts your next turn once the reconnect has run: what to try again. Leave it out only when the next step waits on someone else.',
          },
        },
        additionalProperties: false,
      },
      isDeferred: false,
    })
    loadUpdateCheck($)
    return started
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: SUBAGENT }
    const input = e as { profile?: unknown; reconnect?: unknown; resume?: unknown }
    const asked = text(input.profile)
    if (input.profile !== undefined && (typeof input.profile !== 'string' || (asked !== undefined && !isProfileName(asked)))) {
      return { deny: "`profile` must be a profile folder's name, such as Default or Profile 2: letters, digits, spaces, _ and -, at most 64. Never an account." }
    }
    if (input.reconnect !== undefined && typeof input.reconnect !== 'boolean') return { deny: '`reconnect` is true or false.' }
    const resume = text(input.resume)
    const platform = await platformOf($)
    if (platform !== 'windows' && platform !== 'macos') {
      return { result: `Chrome: not looked for. self-chrome looks after Chrome on Windows and macOS, on the machine Chrome runs on, and this session runs on ${platform}. Nothing was started or queued.` }
    }
    const flag = flagChoice(silent, await env(() => $.env.get('CLAUDE_CHROME_SILENT_DEBUGGER')))
    const { look, start } = platform === 'windows' ? await ensureWindows($, flag, asked) : await ensureMac($, flag, asked)
    const reconnect = await queueReconnect($, input.reconnect !== false, isRunning(look, start), resume)
    return { result: answer({ platform, flag, look, start, reconnect }) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-chrome: chrome_ensure failed before it could answer. Call it again to see where Chrome stands.' }))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // This turn's arm, made at once, marked by the person's prompts typed over the turn; closed below if nothing is queued.
    const arm = armAt(e.turnId)
    typedOver.clear()
    let isArmed = false
    try {
      const done = await next(e)
      const { value } = await $.state.get(queued)
      if (!value) return done
      await $.state.set(queued, null)
      if (e.isAborted || e.reason !== 'answer') {
        $.ui.status(undefined)
        $.ui.toast("Claude in Chrome reconnect cancelled: the turn didn't finish.")
        return done
      }
      isArmed = true
      $.clock.after(TURN_END_MS, () => void reconnectNow($, value, arm))
      return done
    } finally {
      if (!isArmed) closeArm(arm)
    }
  })

  // The person's message, at the terminal or from the app: it marks the arms it comes after (see Typed). No text is kept.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)
    const typed = personTyped(e.turnId)
    const done = await next(e)
    if (done.drop === undefined) personEntered(typed)
    else personDropped(typed, e.turnId)
    return done
  }).catch(($, e, next) => next(e))
}
