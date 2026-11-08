// A session restarts itself on Windows: once the current turn ends, it opens a new terminal window in
// the folder the session started in, exits, and the new window resumes the same conversation
// (`claude --resume <id>`, which finds the session under that folder's project) once the old process
// has gone. Useful after an account switch, a setting that takes effect
// at startup, or a plugin that won't reload. The model calls restart_after_turn with `reason`,
// required, since the exit is irreversible for this process; a command can't run while the turn the
// model is in waits on it, so the call is queued and the restart runs once the turn has ended with
// an answer. An interrupted turn cancels it. Only the main conversation restarts this way, never a
// subagent, and only one run in a terminal with a person at its prompt.
//
// The launch: one run of the shared launcher (launch, in the shared machine code; see launcher.ts), by
// Windows PowerShell's known path, its inputs the session's id (a UUID), the folder it started in, its
// config folder and its own claude.exe from the probe that judged the safe point. Nothing from the
// tool's input reaches the launch. It takes the claim lock on the conversation, so a switch moving it
// at the same time can't resume it too. The new window waits for this session's claude.exe to exit,
// then reads the session registry and the process table again, and resumes only when nothing else
// holds the conversation, so two copies never write one session; it runs claude-launch.ps1, the one
// script that starts claude, with the launch environment. When this session runs in a slot (a Windows
// Terminal pane running self-switch's claude-slot.ps1 of the shipped hash), the launch leaves the slot
// a record instead, and the slot resumes the session in the same pane once it has exited. The resumed
// session's copy of this plugin releases the claim lock. self-restart writes no left record: it
// resumes its own conversation.
//
// The tab, tried first: when this session was started through the claude wrapper (a `claude`
// function in the person's PowerShell profile, tools/claude-wrapper/claude-wrapper.ps1), it carries
// CLAUDE_PANE_TOKEN, and the wrapper's pane file names the PowerShell that runs it. When that
// PowerShell is this claude.exe's own parent (paneFallback, on the probe that judged the safe point),
// the launch ({ pane }) takes the claim lock and leaves the wrapper a ticket naming that claim,
// written whole and moved into place, and no window opens: once this session exits, the wrapper
// deletes the ticket, checks it (the claim lock must still name its claim, and right before claude
// runs, the window's last look: no running Claude Code holds the conversation), and runs
// `claude --resume <id>` in the same tab. Only a pane file of version 2, the wrapper that makes those
// checks, gets a ticket. Without a token, or with one whose pane file is older or doesn't name
// claude.exe's parent, the slot or the window, as before; a token's tab passed over is said in the
// log and in the row the restarted session reads.
//
// The placement: where no tab and no slot takes the restart, it follows placement.json's `restart.prefer`
// when the file reads: a tab in this tab's own window (`same`, from the stamp CLAUDE_SELF_TOOLS_WT_WINDOW
// in this process's environment; a hand-started tab has none, and falls through), or the placement's
// window, each running the slot runner, which waits for this process to exit; else today's window. Each
// is tried in turn while it is refused for want of Windows Terminal or the slot runner.
//
// The final command goes through the trampoline when GO_VIA says so (it ships as 'direct'): a command of
// this plugin's own, self-restart-go, whose hook never reads `next` and checks again when the engine
// dequeues it; a turn that came first stands the restart down.
//
// The first prompt never goes on a command line. It waits in the plugin's own store, under the
// session's id, and the copy of this plugin in the process that resumes the session sends it, once,
// at the classic SessionStart with `source: "resume"` for that id. One older than 15 minutes is
// dropped: the window had given up, and the session was resumed later by hand.
//
// The pre-check (exitBlockers, in the shared machine code), as self-exit's: it refuses while anything
// would make the exit stop at its confirmation, or end work still running: a session cron (the
// built-in CronList, read through $.tool.call once $.tool.check allows it, so never a dialog), a
// background job under the session (the probe's S6), a subagent, a wake-up pending with self-wake (its
// marker; one that can't be read holds); each named with how to stop it, and anything unreadable refuses
// too. It runs at the call, so nothing is queued while a blocker stands,
// and again when the restart is armed, with the rest of the safe point. A subagent is checked again
// right before the exit. And no restart loop: a session whose restart opened its window less than 2
// minutes ago is refused another, at the call and right before the launch (the plugin's store keeps
// when, by session id).
//
// The pending marker: while the restart is queued or armed, %LOCALAPPDATA%\claude-self-tools\pending\
// <conversation>.json says so ({ v: 1, kind: 'restart', at }), and the coordinator holds its
// deliveries meanwhile, so that none starts a turn that would cancel the restart. It says done
// ({ v: 1, done: true }) once the exit runs or the restart is cancelled; the resumed session gets the
// deliveries.
//
// The exit waits for the session to be idle, so a message that arrives between the turn's end and the
// exit would start a turn the exit then cuts off. A main-loop turn that starts before the exit has
// started cancels the restart, as an interrupted turn does. If the window has opened by then, it is
// left waiting, and the person and the model are told so.
import type { EngineInterface, Register } from 'claude-code'
import type { Queued, Restart } from '../types'
import { go } from './go'
import { launch as buildLaunch, parseLaunch, powershellPath, RELEASED, releaseScript, SESSION_ID, stateFolder, SYSTEM_ROOT } from './launcher'
import type { AgentLike, LaunchInput, LaunchWhere, PendingKind, Placement, Probe } from './machine'
import { goAnswer, goRun, agentsHeld, agentsWayOut, blockersText, claimOf, exitBlockers, isBusyAgent, isSafeFolder, isWindowName, LAUNCH_DEADLINE_MS, LAUNCH_RETRY_MS, LAUNCH_RUN_MS, launchFolderFault, launchFolderSaid, loadPlacement, markPending, oneLine, paneFallback, paneTicketPath, pickLaunchTransport, plainOutput, powershellCall, quoted, readExit, readGit, readPane, resumeTitle, runProbe, safePoint, SLOT_SCRIPT_SHA256, idPathOrNone, TAB_LABEL } from './machine'
import { configureUpdateCheck, loadUpdateCheck, withUpdateNotice } from './update-check'

const queued = { plugin: 'self-restart', key: 'queued' } as const
const folder = { plugin: 'self-restart', key: 'folder' } as const
const cancelsKey = { plugin: 'self-restart', key: 'cancels' } as const

/** After this many cancels in a row by a new turn, the row says the session is busy. */
const BUSY_AFTER = 3

/** The plugin's store key for restarts under way, by session id. */
const RESTARTS = 'restarts'
/** The plugin's store key for when each session last opened a restart's window, by session id. */
const RECENT = 'recentRestarts'

/** A beat after the turn's end, so the turn is no longer running when the restart starts. */
const SETTLE_MS = 500
/** How long after the exit command to look whether the session is still here. */
const CHECK_MS = 5000
/** How long releasing the claim lock may take. */
const RELEASE_MS = 15_000
/** How long a slot honours the record the launcher left it, in seconds. */
const SLOT_SECONDS = 120
/** A restart's first prompt older than this is dropped, not sent: a window that waited this long for the old process, the session resumed later by hand. */
const STALE_MS = 15 * 60 * 1000
/** The most restarts under way the store keeps. */
const MAX_KEPT = 50
/** A second restart of one session sooner than this after the first is refused: no restart loop. */
const LOOP_MS = 2 * 60 * 1000

const DESCRIPTION = [
  "Restarts this session once the current turn ends: when Claude Code was started through the claude wrapper (the `claude` function from claude-code-self-tools in the person's PowerShell profile), it restarts in this same terminal tab; otherwise it opens a new terminal window in the folder this session started in. This session exits, and the tab or the window resumes it (claude --resume <this session's id>) once this process has gone. The conversation carries on there.",
  'Call it when a restart is the fix: the person switched accounts, changed a setting that takes effect at startup, or a plugin won\'t reload (try reload_plugins_after_turn first, if it is available). Only at a finished break: never mid-merge, mid-push or mid-task. Never on your own to clear a problem a restart doesn\'t fix.',
  'Windows only, in a session run in a terminal.',
  '`reason` (required) says why; it is recorded in the transcript. `resume` is the message that starts your first turn in the restarted session: what to check or do next. Give it whenever you have a next step of your own; leave it out only when the next step waits on someone else.',
  'It refuses unless the session is at a safe point: while a session cron is set (delete it with CronDelete), while subagents you started are still running, while a wake-up from wake_after is pending (cancel it with cancel_wake), while anything runs under this session (a background Bash, PowerShell or Monitor job, git, a build, test or lint, a dev server or Playwright, a heavy-slot job), while a git operation is in flight in the repo, and while any of that can\'t be read; each is named with how to stop it. It refuses a second restart within 2 minutes of the last. What still ends with this process: Remote Control (with Remote Control on for all sessions, the resumed session connects again).',
  "It can run only when the session is idle: Claude Code queues a plugin's command behind anything already waiting (a message typed during this turn, a background task's notification) and has no slot between turns ahead of them. A turn that starts first cancels the restart, and you are told, so nothing waiting is lost or carried into another conversation; under a nonstop stream of work and notifications it may not run for a long time, so call it again when the stream pauses.",
  'End the turn after calling it; the restart starts once your answer is shown.',
].join(' ')

const SUBAGENT =
  "A subagent can't restart the session. Finish your piece and return its result, saying a restart is needed and why: the main session can restart."

/** Whether this session runs in a terminal with a person at its prompt; read at each session.start. */
let isTerminal = true

/**
 * The restart the last turn's end armed, until its exit starts; a main-loop turn that starts first
 * takes it back. Module state, as the timer that runs it is.
 */
let armed: Queued | undefined

/**
 * The conversation this process holds, from each main-loop classic SessionStart's own id: the one a
 * ticket for the claude wrapper's tab resumes. Unknown after a reload of the plugin (no start since),
 * when `$.session.id()` is read alone.
 */
let current: string | undefined

/** Whether the log has said this tab's claude wrapper is an older one: once per process. */
let toldOldWrapper = false
/** Whether the log has said what is wrong with placement.json: once per process. */
let toldPlacement = false

/** Trimmed text, or undefined when it is not a string or is blank. */
function text(raw: unknown): string | undefined {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed === '' ? undefined : trimmed
}

/** Why a call was refused, as one line. */
function why(err: unknown): string {
  const said = (err instanceof Error ? err.message : String(err)).trim()
  return said === '' ? 'no reason given' : said
}

/** What is queued: `resume` only when there is one, since stored state holds no undefined. */
const entry = (reason: string, resume: string | undefined): Queued => (resume === undefined ? { reason } : { reason, resume })

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Writes `{"v":1,"cancelled":true}` over a ticket or a slot's record at `path`, read first, only while it
 * is still this launch's (`ours`): nothing there (a run that wrote nothing), or one a newer launch wrote,
 * is left as it is. A plugin can't delete a file; one left is honoured only within 120 seconds, and
 * only with its claim, which the caller releases.
 */
async function withdrawIfOurs($: EngineInterface, path: string | undefined, ours: (raw: Record<string, unknown>) => boolean): Promise<void> {
  if (path === undefined) return
  try {
    const text = await $.fs.read(path)
    if (typeof text !== 'string') return
    const raw: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    if (!isRecord(raw) || !ours(raw)) return
    await $.fs.write(path, JSON.stringify({ v: 1, cancelled: true }))
  } catch {
    // Not there, or not of its shape: nothing of this launch's to take back.
  }
}

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

/** The agents still to report (any that hasn't ended); undefined when the list can't be read. */
async function busyAgents($: EngineInterface): Promise<readonly AgentLike[] | undefined> {
  try {
    return (await $.agent.list()).filter(a => isBusyAgent(a.status))
  } catch {
    return undefined
  }
}

/**
 * Why a restart can't go ahead with these agents, or undefined when none is still to report. One that
 * won't report on its own (an idle teammate, a status not known here) holds too, saying how to clear it.
 */
function blocked(busy: readonly AgentLike[] | undefined): string | undefined {
  if (busy === undefined) return "the session's subagents can't be read, so whether any is still running is unknown"
  if (busy.length === 0) return undefined
  const way = agentsWayOut(busy)
  return `${agentsHeld(busy)}, and ${busy.length === 1 ? 'its work' : 'their work'} would end with this process${way === undefined ? '' : `; ${way}`}`
}

/** A variable of this process's environment, or undefined when unset or unreadable. */
async function env($: EngineInterface, read: () => Promise<string | undefined>): Promise<string | undefined> {
  try {
    return await read()
  } catch {
    return undefined
  }
}

/**
 * What stands in the exit's way now (the pre-check: crons, the probe's S6 when the launch can be
 * planned, subagents, a wake-up pending), each with how to stop it, as one
 * line; undefined when nothing does. Off Windows, or where the launch can't be planned, the probe isn't
 * run: the restart is refused when armed, saying why, and nothing exits.
 */
async function blockers($: EngineInterface, launch: { powershell: string; id: string } | undefined): Promise<string | undefined> {
  const found = exitBlockers(await readExit($, launch, await exitMore($, launch?.id)))
  return found.length === 0 ? undefined : blockersText(found)
}

/** What the pre-check reads besides the machine: this conversation's wake-up. */
async function exitMore($: EngineInterface, id: string | undefined): Promise<{ readonly wake?: { readonly state: string; readonly id: string } }> {
  const local = await env($, () => $.env.get('LOCALAPPDATA'))
  return id !== undefined && isSafeFolder(local) ? { wake: { state: stateFolder(local), id } } : {}
}

/**
 * Why this session isn't at a safe point to exit, or undefined when it is. First the pre-check
 * (exitBlockers: a session cron, a background job under the session, a subagent, each with how to
 * stop it); then the shared safePoint, on the same probe of the process tree (this session's id, no
 * config folder, no claim) and git's state where the session started and works: git, a dev server or
 * a heavy-slot job under this claude.exe, or git in flight, holds it too. Anything that can't be read
 * holds it. At a safe point, the probe it judged on: its process table says whether this claude.exe
 * runs right under the claude wrapper's tab.
 */
async function notSafe($: EngineInterface, launch: { powershell: string; id: string; cwd: string }): Promise<{ readonly unsafe: string } | { readonly probe: Probe }> {
  const read = await readExit($, launch, await exitMore($, launch.id))
  const found = exitBlockers(read)
  if (found.length > 0) return { unsafe: blockersText(found) }
  let cwd: string
  try {
    cwd = await $.session.cwd()
  } catch (err) {
    return { unsafe: `this session's folder can't be read, so git's state there is unknown (${why(err)})` }
  }
  const git = await readGit($, { start: launch.cwd, folders: [cwd], dirty: false })
  // The probe and the agents were read whole above, or the pre-check would have held.
  const safe = safePoint(read.busy ?? 'it was not run', git, read.agents)
  if (safe.verdict !== 'clear') return { unsafe: `this session isn't at a safe point (${safe.reasons.join('; ')})` }
  return typeof read.busy === 'object' ? { probe: read.busy } : { unsafe: 'the machine probe was not run, so what runs under this session is unknown' }
}

/**
 * This tab's claude wrapper, when the restart can use it: the session carries CLAUDE_PANE_TOKEN, the
 * wrapper's pane file for it reads, and the PowerShell it names is this claude.exe's own parent on
 * `probe`, the one the safe point was judged on (paneFallback). `fallback` says why a session with a
 * token can't use its tab; undefined when it has none (it wasn't started through the wrapper).
 */
async function paneOf($: EngineInterface, launch: { id: string; cwd: string }, probe: Probe): Promise<{ readonly token: string; readonly state: string } | { readonly fallback: string } | undefined> {
  const token = await env($, () => $.env.get('CLAUDE_PANE_TOKEN'))
  if (token === undefined || token === '') return undefined
  const local = await env($, () => $.env.get('LOCALAPPDATA'))
  if (!isSafeFolder(local)) return { fallback: `%LOCALAPPDATA% reads ${JSON.stringify(local ?? '')}, not an absolute folder without quotes, so the tab's pane file can't be found` }
  if (current !== undefined && current !== launch.id) return { fallback: `this session's id reads ${launch.id}, but the start of this conversation named ${current}` }
  if (!isSafeFolder(launch.cwd)) return { fallback: `the folder this session started in (${JSON.stringify(launch.cwd)}) is not an absolute folder without quotes or control characters` }
  const state = stateFolder(local)
  const pane = await readPane($, state, token)
  if ('why' in pane) return { fallback: pane.why }
  if (pane.v < 3 && !toldOldWrapper) {
    toldOldWrapper = true
    $.ui.log("this tab's claude wrapper is an older one (its pane file is version 2): a session it resumes gets no CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP, and its last look reads less. Copy the current claude-wrapper.ps1 into place.")
  }
  const passed = paneFallback(probe, pane)
  return passed === undefined ? { token, state } : { fallback: passed }
}

/** placement.json, or null: a bad file means no placement, said in the log once. */
async function placementOf($: EngineInterface, state: string): Promise<Placement | null> {
  const read = await loadPlacement($, state)
  if (read.errors !== undefined && !toldPlacement) {
    toldPlacement = true
    $.ui.log(`placement.json is not of its shape, so it isn't used: ${oneLine(read.errors.join('; '), 400)}`)
  }
  return read.placement
}

/** This tab's stamp, as its environment says, each checked: what `tab: same` goes by. A hand-started tab has none. */
async function stampOf($: EngineInterface): Promise<{ readonly window?: string; readonly tab?: string }> {
  const window = await env($, () => $.env.get('CLAUDE_SELF_TOOLS_WT_WINDOW'))
  const tab = await env($, () => $.env.get('CLAUDE_SELF_TOOLS_WT_TAB'))
  return { ...(isWindowName(window) ? { window } : {}), ...(typeof tab === 'string' && TAB_LABEL.test(tab) ? { tab } : {}) }
}

/**
 * Where the launch keeps its files and reads its checks: the plugins' state folder under
 * %LOCALAPPDATA%, and this session's own config folder (CLAUDE_CONFIG_DIR, or %USERPROFILE%\.claude),
 * whose registry the window's last look reads; `refusal` when either isn't an absolute folder.
 */
async function places($: EngineInterface): Promise<{ readonly state: string; readonly configDirs: readonly string[] } | { readonly refusal: string }> {
  const local = await env($, () => $.env.get('LOCALAPPDATA'))
  if (!isSafeFolder(local)) return { refusal: `%LOCALAPPDATA% reads ${JSON.stringify(local ?? '')}, not an absolute folder without quotes, so the claim lock can't be kept` }
  const configured = await env($, () => $.env.get('CLAUDE_CONFIG_DIR'))
  const profile = await env($, () => $.env.get('USERPROFILE'))
  const own = configured !== undefined && configured !== '' ? configured : profile === undefined ? undefined : `${profile}\\.claude`
  if (!isSafeFolder(own)) return { refusal: `this session's config folder (CLAUDE_CONFIG_DIR, or %USERPROFILE%\\.claude) reads ${JSON.stringify(own ?? '')}, not an absolute folder without quotes` }
  return { state: stateFolder(local), configDirs: [own.replace(/\\+$/, '')] }
}

/** The pending marker: `kind` while the restart is queued or armed, null once it ran or was cancelled. */
async function mark($: EngineInterface, kind: PendingKind | null): Promise<void> {
  const failed = await markPending($, kind)
  if (failed !== undefined) $.ui.log(`the pending marker wasn't written (${failed}); the coordinator ignores an old one after 15 minutes.`)
}

/** What the launch needs, each from the engine, never from the tool's input; or why it can't go ahead. */
async function plan($: EngineInterface): Promise<{ powershell: string; id: string; cwd: string } | { refusal: string }> {
  const os = await env($, () => $.env.get('OS'))
  if (os !== 'Windows_NT') return { refusal: 'a restart opens its new window only on Windows so far' }
  const root = await env($, () => $.env.get('SystemRoot'))
  if (root === undefined || !SYSTEM_ROOT.test(root)) {
    return { refusal: `the Windows folder (SystemRoot) reads ${JSON.stringify(root ?? '')}, not a drive and one plain folder, so PowerShell can't be found by its known path` }
  }
  let id: string
  try {
    id = await $.session.id()
  } catch (err) {
    return { refusal: `this session's id can't be read: ${why(err)}` }
  }
  if (!SESSION_ID.test(id)) return { refusal: `this session's id (${JSON.stringify(id)}) is not one claude --resume takes` }
  // Where it started, not where it is now: `--resume <id>` looks the session up under the folder's project.
  const { value: cwd } = await $.state.get(folder)
  if (typeof cwd !== 'string' || cwd === '') return { refusal: "the folder this session started in isn't known" }
  return { powershell: powershellPath(root), id, cwd }
}

/** The restarts under way in the store, each one checked; dropped: anything else, and those gone stale. */
async function restarts($: EngineInterface, now: number): Promise<Record<string, Restart>> {
  const stored = await $.store.get(RESTARTS)
  const kept: Record<string, Restart> = {}
  if (!isRecord(stored)) return kept
  for (const [id, value] of Object.entries(stored)) {
    if (!SESSION_ID.test(id) || !isRecord(value) || typeof value.at !== 'number' || typeof value.reason !== 'string') continue
    if (now - value.at > STALE_MS && now >= value.at) continue
    kept[id] = {
      at: value.at,
      reason: value.reason,
      ...(typeof value.resume === 'string' ? { resume: value.resume } : {}),
      ...(typeof value.claim === 'string' ? { claim: value.claim } : {}),
    }
  }
  return kept
}

/** Keeps this restart for the process that resumes the session, or takes it back (`value` null). */
async function keep($: EngineInterface, id: string, value: Restart | null): Promise<void> {
  const now = await $.clock.now()
  const all = await restarts($, now)
  delete all[id]
  const rest = Object.entries(all).slice(-(MAX_KEPT - 1))
  await $.store.set(RESTARTS, Object.fromEntries(value === null ? rest : [...rest, [id, value]]))
}

/** Says a restart didn't go ahead: a toast for the person, a note for the model. */
/** When the window of this session's last restart opened, if that was less than 2 minutes ago. */
async function lastRestart($: EngineInterface, id: string): Promise<number | undefined> {
  const [stored, now] = await Promise.all([$.store.get(RECENT), $.clock.now()])
  const at = isRecord(stored) ? stored[id] : undefined
  return typeof at === 'number' && now >= at && now - at < LOOP_MS ? at : undefined
}

/** Notes that this session's restart opened its window now; drops the notes 2 minutes old. */
async function noteRestart($: EngineInterface, id: string): Promise<void> {
  const [stored, now] = await Promise.all([$.store.get(RECENT), $.clock.now()])
  const kept: Record<string, number> = {}
  if (isRecord(stored)) {
    for (const [other, at] of Object.entries(stored)) {
      if (SESSION_ID.test(other) && typeof at === 'number' && now >= at && now - at < LOOP_MS) kept[other] = at
    }
  }
  kept[id] = now
  await $.store.set(RECENT, kept)
}

/** Why a restart this soon after the last is refused. */
async function loop($: EngineInterface, at: number): Promise<string> {
  const seconds = Math.max(1, Math.round(((await $.clock.now()) - at) / 1000))
  return `this session restarted ${seconds} seconds ago, and a second restart within 2 minutes is refused, so that restarts can't loop unattended`
}

/** Says an armed restart didn't go ahead: the pending marker done, a toast for the person, a note for the model. */
async function refuse($: EngineInterface, toast: string, note: string): Promise<void> {
  await mark($, null)
  $.ui.toast(toast)
  await tellModel($, note)
}

/**
 * The row the model reads in the restarted session: why it restarted, and, when this pane's slot
 * runner was passed over for a new window, why (the launcher's own words, quoted); when a tab with a
 * claude wrapper's token was, why too.
 */
const record = ({ reason }: Queued, fallback?: string, tab?: string): string =>
  `This session restarted at its own request (restart_after_turn). Reason: ${reason}${fallback === undefined ? '' : ` It restarted in a new window, not this pane's slot: ${quoted(fallback)}.`}${tab === undefined ? '' : ` It restarted in a new window, not in its tab through the claude wrapper: ${quoted(tab)}.`}`

/**
 * A queued restart that a new turn took back, told to the model in a plugin row, never lost silently;
 * `then` says what became of it. Cancels are counted while they come in a row; from the third, the row
 * says the session is busy: queue it again when it is idle, or ask the merger or the owner.
 */
async function cancelled($: EngineInterface, then: string): Promise<void> {
  let count = 1
  try {
    const { value: last } = await $.state.get(cancelsKey)
    count = last !== null && last !== undefined && last.key === 'restart' ? last.count + 1 : 1
    await $.state.set(cancelsKey, { key: 'restart', count })
  } catch {
    // Counted or not, the row goes.
  }
  const busy = count >= BUSY_AFTER ? ` That is ${count} in a row: this session is busy. Queue it again when it's idle, or ask the merger or the owner.` : ''
  await tellModel($, `self-restart: your queued restart was cancelled because a new turn started; queue it again at the next finished break.${busy} ${then}`)
}

/** Opens the window, then exits; says so at each step that didn't go ahead. */
async function restartNow($: EngineInterface, value: Queued): Promise<void> {
  if (armed !== value) return
  // The break held long enough for the run to start: the cancels in a row end here. A count that
  // can't be cleared never stops the run.
  try {
    await $.state.set(cancelsKey, null)
  } catch {
    // The next cancel counts on from it; nothing else depends on it.
  }
  $.ui.status(undefined)
  const busy = await busyAgents($)
  const stop = blocked(busy)
  if (stop !== undefined) {
    armed = undefined
    const once = busy !== undefined && agentsWayOut(busy) !== undefined ? 'they have ended' : 'they have reported'
    await refuse($, `Restart cancelled: ${stop}.`, `The restart you queued didn't run: ${stop}. The session goes on; call restart_after_turn again once ${once}.`)
    return
  }
  const launch = await plan($)
  if ('refusal' in launch) {
    armed = undefined
    await refuse($, `Restart didn't run: ${launch.refusal}.`, `The restart you queued didn't run: ${launch.refusal}. The session goes on.`)
    return
  }
  const lately = await lastRestart($, launch.id)
  if (lately !== undefined) {
    armed = undefined
    const said = await loop($, lately)
    await refuse($, `Restart didn't run: ${said}.`, `The restart you queued didn't run: ${said}. The session goes on; if a restart is still the fix, tell the person, who can restart by hand.`)
    return
  }
  // The pre-check again, and the safe point (S1-S6), as a switch's: nothing may still run under this
  // session when it exits, and no cron may make the exit ask.
  const judged = await notSafe($, launch)
  if ('unsafe' in judged) {
    armed = undefined
    await refuse($, `Restart didn't run: ${judged.unsafe}.`, `The restart you queued didn't run: ${judged.unsafe}. The session goes on; call restart_after_turn again once they are done.`)
    return
  }
  // A turn that started while the checks above ran has taken it back, and said so.
  if (armed !== value) return
  // This tab's claude wrapper, tried first; without a token, or with one it can't use, the launcher.
  const pane = await paneOf($, launch, judged.probe)
  const tabFallback = pane !== undefined && 'fallback' in pane ? oneLine(pane.fallback, 300) : undefined
  // Kept before the window opens: the process it starts reads it once this one has exited.
  const kept: Restart = { at: await $.clock.now(), ...value }
  await keep($, launch.id, kept)
  let opened: string | undefined
  let slot: string | undefined
  let fallback: string | undefined
  let tab = false
  /** Where the placement put it: a new tab, or a named window. */
  let placedAt: string | undefined
  /** The claim the ticket, the slot's record or the window holds, once it is in place. */
  let claimed: string | undefined
  // One run of the shared launcher (launch, machine.ts): it checks this is the claude.exe the probe
  // judged, takes the claim on this conversation for one launch, and places the restart: this tab's
  // ticket when the claude wrapper runs it; else this pane's slot when its runner is verified and takes
  // the folder; else a new window running claude-launch.ps1. The wrapper, the slot and the window each
  // resume only while the claim lock still names it, and right before claude look again.
  const site = await places($)
  const own = judged.probe.session
  const folderFault = launchFolderFault(launch.cwd)
  if ('refusal' in site) opened = site.refusal
  else if (folderFault !== undefined) opened = launchFolderSaid(launch.cwd, folderFault)
  else if (own === null) opened = "this session's own claude.exe wasn't found above the probe"
  else {
    /** The claim the script printed it took, once it took one. */
    let claim: string | undefined
    /** This launch's own claim: a fresh launch's, which the script names and takes, and a tab or a named window is told. */
    let ours = ''
    /** The run ended without a clean answer (an exit code, no answer, a timeout): it may have placed something. */
    let unclean = false
    // The places, in turn: this tab's wrapper; or this pane's slot ('auto' decides it in the script); or
    // placement.json's tab and window, then 'auto'. The next only when one is refused for want of Windows
    // Terminal or the slot runner.
    const legs = await restartLegs($, site.state, judged.probe, launch, pane)
    for (const [n, where] of legs.entries()) {
      ours = claimOf(where) ?? `launch:${crypto.randomUUID()}`
      claim = undefined
      unclean = false
      opened = undefined
      let refusedFor: string | undefined
      try {
        const now = await $.clock.now()
        const input: LaunchInput = {
          powershell: launch.powershell,
          kind: 'resume',
          id: launch.id,
          folder: launch.cwd,
          claim: ours,
          configDirs: site.configDirs,
          stateDir: site.state,
          where,
          waitForExit: { pid: own.pid, created: own.created },
          now,
          tool: 'self-restart',
          deadline: now + LAUNCH_DEADLINE_MS,
        }
        let call: ReturnType<typeof buildLaunch>
        try {
          call = buildLaunch(input)
        } catch (err) {
          refusedFor = 'build'
          opened = `the launch can't be made: ${why(err)}`
          if (n === legs.length - 1) break
          $.ui.log(`the placed restart wasn't used: ${oneLine(opened, 300)}. The next place is tried.`)
          continue
        }
        const run = await $.process.run(call.argv, {
          stdin: call.stdin,
          cwd: launch.cwd,
          timeoutMs: LAUNCH_RUN_MS,
        })
        const answer = parseLaunch(run.stdout)
        claim = answer.claim
        if (run.exitCode !== 0 || !('launched' in answer)) {
          unclean = run.exitCode !== 0 || !('refused' in answer)
          refusedFor = 'refused' in answer ? answer.refused.code : undefined
          const said = 'refused' in answer ? answer.refused.why : plainOutput(`${run.stdout} ${run.stderr}`)
          const nothing = pane !== undefined && 'token' in pane ? "the ticket for this tab wasn't written" : "the launcher didn't place the restart"
          opened = `${nothing} (${run.exitCode !== 0 ? `exit ${run.exitCode}` : 'refused'}${said === '' ? '' : `: ${said}`})`
        } else {
          const placed = answer.launched
          if (placed.transport === 'slot') slot = placed.label
          if (placed.transport === 'pane') tab = true
          if (placed.transport === 'tab') placedAt = `a new tab in window ${placed.label}`
          if (placed.transport === 'window' && placed.label !== '-') placedAt = `a new window, ${placed.label}`
          // The claim the launch took: the resumed session's copy of this plugin releases it.
          claimed = claim
          if (claim !== undefined) await keep($, launch.id, { ...kept, claim })
          // A slot runner found but not used: the launcher says why, and so does the restart.
          if (placed.transport === 'window' && answer.fallback !== undefined) fallback = oneLine(answer.fallback, 300)
        }
      } catch (err) {
        unclean = true
        opened = `the launcher didn't run: ${why(err)}`
      }
      if (opened === undefined || n === legs.length - 1 || (refusedFor !== 'wt' && refusedFor !== 'slotscript')) break
      $.ui.log(`the placed restart wasn't used: ${oneLine(opened, 300)}. The next place is tried.`)
    }
    // A claim taken for a launch that isn't in place is given back at once (a clean refusal gave back
    // its own already). After a run that ended without a clean answer, a ticket that may be there is
    // written over as withdrawn and this launch's claim released, and once more LAUNCH_RETRY_MS later: a
    // run killed at its timeout may still have been writing (its own deadline check takes back what it
    // placed late; this catches a write that slipped past it). This launch's own claim; and the slot's,
    // on this conversation, when 'auto' may have gone to this pane's slot (the run printed nothing).
    if (opened !== undefined && claim !== undefined && claim !== ours) await release($, launch.id, claim)
    if (opened !== undefined && !unclean && claim === ours) await release($, launch.id, ours)
    if (opened !== undefined && unclean) {
      const ticket = pane !== undefined && 'token' in pane ? paneTicketPath(site.state, pane.token) : undefined
      // 'auto' may have gone to this pane's slot (verified on the probe that judged): its record, and the
      // slot's claim the script took on this conversation, taken back too.
      const autoSlot = ticket === undefined && judged.probe.slot !== null && judged.probe.slot.sha256 === SLOT_SCRIPT_SHA256 ? judged.probe.slot.id : undefined
      const autoRecord = autoSlot === undefined ? undefined : idPathOrNone(site.state, 'slotRecord', autoSlot)
      const given = ours
      const takeBack = async (first: boolean): Promise<void> => {
        // Each only while it is still this launch's: a ticket naming its claim, a record resuming this
        // conversation. A run that wrote nothing leaves nothing to withdraw. The slot's claim and record
        // aren't one launch's, so only the first time: a newer launch of the same conversation through
        // this slot, within the seconds of the retry, keeps its own.
        await withdrawIfOurs($, ticket, raw => raw.by === given)
        if (first) await withdrawIfOurs($, autoRecord, raw => raw.resume === launch.id)
        await release($, launch.id, given)
        if (first && autoSlot !== undefined) await release($, launch.id, `slot:${autoSlot}`)
      }
      await takeBack(true)
      $.clock.after(LAUNCH_RETRY_MS, () => void takeBack(false))
    }
  }
  if (opened === undefined) await noteRestart($, launch.id)
  if (opened !== undefined) {
    if (armed === value) armed = undefined
    await keep($, launch.id, null)
    const nothing = pane !== undefined && 'token' in pane ? 'nothing was left for this tab' : 'no window opened'
    await refuse($, `Restart didn't run: ${opened}`, `The restart you queued didn't run, and ${nothing} (${opened}). The session goes on.`)
    return
  }
  /** Where the session resumes when it isn't a new window: this pane's slot, or this tab's claude wrapper. */
  const spot =
    slot !== undefined
      ? { Name: "This pane's slot", left: "left this pane's slot a record", it: 'the slot resumes it in this pane', session: 'the slot resumes the session in this pane', kept: 'the record' }
      : tab
        ? { Name: 'This tab', left: "left this tab's claude wrapper a ticket", it: 'the wrapper resumes it in this tab', session: 'the wrapper resumes the session in this tab', kept: 'the ticket' }
        : undefined
  // Right before the exit: a turn that started meanwhile, or a subagent, leaves the window waiting.
  const late = armed !== value ? 'a new turn started' : blocked(await busyAgents($))
  if (late !== undefined || armed !== value) {
    armed = undefined
    // The ticket, the slot's record or the waiting window still resumes the session if it exits in
    // time, and holds the claim meanwhile: the record stays, with the claim, so that whichever process
    // resumes it releases it. Not the first prompt: the session went on, and it may be out of date.
    await keep($, launch.id, claimed === undefined ? null : { at: kept.at, reason: kept.reason, claim: claimed })
    if (spot !== undefined) {
      await refuse(
        $,
        `Restart stopped before the exit: ${late ?? 'a new turn started'}. ${spot.Name} resumes the session if it exits (/exit) within ${SLOT_SECONDS / 60} minutes.`,
        `The restart ${spot.left}, but this session didn't exit: ${late ?? 'a new turn started'}. The session goes on. If it exits within ${SLOT_SECONDS / 60} minutes, ${spot.it}; after that ${spot.kept} is ignored.`,
      )
      return
    }
    await refuse(
      $,
      `Restart stopped before the exit: ${late ?? 'a new turn started'}. Its window keeps waiting for this session to exit, and resumes it there when it does: exit (/exit) to resume there, or close the window to give up.`,
      `The restart's window opened, but this session didn't exit: ${late ?? 'a new turn started'}. The session goes on. The window keeps waiting for this process to exit, and resumes the session there when it does; the person can close it to give up.`,
    )
    return
  }
  armed = undefined
  // A tab with a token that couldn't be used is said only when a new window opened instead.
  const passedTab = spot === undefined ? tabFallback : undefined
  await tellModel($, record(value, fallback, passedTab))
  $.ui.log(`Restarting at the session's own request: ${value.reason}`)
  if (fallback !== undefined) $.ui.log(`this pane's slot runner isn't used: ${fallback}. A new window resumes the session.`)
  if (passedTab !== undefined) $.ui.log(`this tab's claude wrapper isn't used: ${passedTab}. A new window resumes the session.`)
  const where = slot !== undefined ? "this pane's slot" : tab ? 'this tab' : (placedAt ?? 'a new window')
  $.ui.toast(`Restarting: ${where} resumes this session once it has exited${fallback === undefined ? '' : `, not this pane's slot (${fallback})`}. ${value.reason}`)
  // Done as the exit runs: the coordinator delivers again, to the resumed session.
  await mark($, null)
  const siteState = 'refusal' in site ? undefined : site.state
  await goRun($, go, {
    command: 'exit',
    conversation: launch.id,
    holds: async () => current ?? (await $.session.id()),
    agents: async () => {
      try {
        return await $.agent.list()
      } catch (err) {
        return why(err)
      }
    },
    probe: () => runProbe($, launch),
    runs: `self-restart: /exit runs now; ${where} resumes this session once it has exited.`,
    // Stood down at dequeue (only through the trampoline): what was placed is taken back, and the
    // released claim turns away a waiting tab or window.
    withdraw: async said => {
      if (tab && siteState !== undefined) {
        const token = await env($, () => $.env.get('CLAUDE_PANE_TOKEN'))
        await withdrawIfOurs($, token === undefined ? undefined : paneTicketPath(siteState, token), raw => raw.by === claimed)
      }
      if (slot !== undefined && siteState !== undefined) await withdrawIfOurs($, idPathOrNone(siteState, 'slotRecord', slot), raw => raw.resume === launch.id)
      if (claimed !== undefined) await release($, launch.id, claimed)
      await keep($, launch.id, null)
      await refuse($, `Restart stood down: ${said}.`, `The restart stood down when its exit came up: ${said}. What it had placed was taken back. The session goes on.`)
    },
    failed: async err => {
      if (spot !== undefined) {
        $.ui.toast(`Exit didn't run: ${why(err)}. ${spot.Name} resumes the session if it exits (/exit) within ${SLOT_SECONDS / 60} minutes.`)
        await tellModel($, `The restart ${spot.left}, but the exit didn't run: ${why(err)}. If this process exits within ${SLOT_SECONDS / 60} minutes, ${spot.session}; after that this session goes on as it is.`)
        return
      }
      $.ui.toast(`Exit didn't run: ${why(err)}. The new window keeps waiting for this session to exit (/exit), and resumes it there when it does; close the window to give up.`)
      await tellModel(
        $,
        `The restart's new window opened, but the exit didn't run: ${why(err)}. The window keeps waiting for this process to exit, and then resumes the session there; the person can exit (/exit) for that, or close the window to give up. Until then this session goes on.`,
      )
    },
    after: async () => {
      // An exit that took ends this module with the session, and this never fires.
      $.clock.after(CHECK_MS, () => {
        if (tab) {
          $.ui.toast(`The exit ran, but the session is still open. This tab resumes it if it exits within ${SLOT_SECONDS / 60} minutes.`)
          void tellModel($, `The restart's exit ran, but the session is still open (a dialog may have been answered no). If it exits within ${SLOT_SECONDS / 60} minutes, the wrapper resumes it in this tab; after that the ticket is ignored.`)
          return
        }
        $.ui.toast('The exit ran, but the session is still open. The new window keeps waiting for it to exit, and resumes it there when it does.')
        void tellModel($, 'The restart\'s exit ran, but the session is still open (a dialog may have been answered no). The new window waits for it to exit, then resumes it there.')
      })
    },
  })
}

/**
 * The places a restart tries, in turn: this tab's claude wrapper, when it runs this claude.exe; else this
 * pane's slot, verified on the probe that judged ('auto' decides it in the script); else placement.json's
 * `restart.prefer` (a tab in this tab's own window, by its stamp, or the placement's window), then 'auto',
 * today's window. A hand-started tab has no stamp, and falls through.
 */
async function restartLegs($: EngineInterface, state: string, probe: Probe, launch: { readonly id: string; readonly cwd: string }, pane: { readonly token: string } | { readonly fallback: string } | undefined): Promise<readonly LaunchWhere[]> {
  if (pane !== undefined && 'token' in pane) return [{ pane: { token: pane.token } }]
  if (probe.slot !== null && probe.slot.sha256 === SLOT_SCRIPT_SHA256) return ['auto']
  const placement = await placementOf($, state)
  if (placement === null) return ['auto']
  const stamp = await stampOf($)
  const placed = pickLaunchTransport(probe, placement, { replacing: true, using: 'restart', configCount: 1, needsLeft: false, stamp, title: stamp.tab ?? resumeTitle(launch.id), folder: launch.cwd })
  if ('wait' in placed) return ['auto']
  return [...[placed.where, ...(placed.then ?? [])].filter(where => where === 'auto' || !('window' in where) || where.window !== true), 'auto']
}

/** Removes the claim lock the restart's launcher took, once the resumed session holds the conversation. */
async function release($: EngineInterface, id: string, claim: string): Promise<void> {
  try {
    const root = await $.env.get('SystemRoot')
    const local = await $.env.get('LOCALAPPDATA')
    if (root === undefined || !SYSTEM_ROOT.test(root) || !isSafeFolder(local)) return
    const call = powershellCall(powershellPath(root), releaseScript({ stateDir: stateFolder(local), id, by: claim }))
    const run = await $.process.run(call.argv, { stdin: call.stdin, timeoutMs: RELEASE_MS })
    const said = run.exitCode === 0 ? RELEASED.exec(run.stdout)?.[1] : undefined
    if (said !== 'released' && said !== 'absent' && said !== 'not-ours') {
      const what = said === 'busy' ? 'another process had it open throughout' : `exit ${run.exitCode}`
      $.ui.log(`the claim lock on ${id} wasn't released (${what}); it is left in place, and goes stale 15 minutes after the old process exited.`)
    }
  } catch (err) {
    $.ui.log(`the claim lock on ${id} wasn't released (${why(err)}); it goes stale 15 minutes after the old process exited.`)
  }
}

/** In the process that resumed a session: the restart's first prompt, if one waits for this session. */
async function welcome($: EngineInterface, id: unknown): Promise<void> {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) return
  const stored = await $.store.get(RESTARTS)
  if (!isRecord(stored) || !(id in stored)) return
  const now = await $.clock.now()
  const all = await restarts($, now)
  const found = all[id]
  await keep($, id, null)
  if (found === undefined) {
    $.ui.toast("A restart's first prompt was dropped: the session came back more than 15 minutes after it.")
    return
  }
  $.ui.toast(`Restarted: ${found.reason}`)
  // The claim lock the launcher took on this conversation: this process holds it now.
  const claim = found.claim
  if (claim !== undefined) $.clock.after(SETTLE_MS, () => void release($, id, claim))
  const resume = found.resume
  // Later, not awaited: a prompt submitted from the start's hook would wait on that hook.
  if (resume !== undefined) $.clock.after(SETTLE_MS, () => void sendResume($, 'Restarted.', resume))
}

export const register: Register = (on, options) => {
  configureUpdateCheck('self-restart', options)

  // First, so it is outermost on this plugin's tools: it sees each answer, and adds the update
  // notice when one is due. It never waits on the check; see update-check.ts.
  on('tool.call', { tool: /^mcp__self-restart__/ }, async ($, e, next) => withUpdateNotice($, e, await next(e))).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    isTerminal = e.isInteractive && e.surface === 'terminal'
    // The first start's folder only: a reload starts the plugin again from wherever the session is now.
    const { value: first } = await $.state.get(folder)
    if (typeof first !== 'string' || first === '') await $.state.set(folder, e.cwd)
    // The trampoline's command: registered whichever way GO_VIA says, so its hook answers a person's
    // typing or a stale entry, and validate sees it as a hook that answers its own command.
    try {
      await $.command.register({ name: 'self-restart-go', description: "self-restart's own step when it runs a restart. Typing it does nothing." })
    } catch (err) {
      $.ui.log(`self-restart's step command wasn't registered (${why(err)}); a restart through the trampoline then says so and doesn't run.`)
    }
    await $.tool.register({
      name: 'restart_after_turn',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the session restarts: what changed, or what a restart fixes. Recorded in the transcript.' },
          resume: {
            type: 'string',
            description:
              'The message that starts your first turn in the restarted session: what to check or do next. Leave it out only when the next step waits on someone else.',
          },
        },
        required: ['reason'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    loadUpdateCheck($)
    return started
  })

  // The trampoline's handler. It never reads `next`: it answers its own command, and is no gate.
  on('command.run', { command: 'self-restart-go' }, ($, e) => goAnswer($, go, e.args)).catch(() => ({ text: "self-restart: the restart's step failed, so it did not run." }))

  // The process that resumed a session this plugin restarted: send that restart's first prompt.
  on('classic.SessionStart', async ($, e, next) => {
    const done = await next(e)
    // The conversation this process holds from here, by the event's own id.
    if (e.agent_id === undefined && typeof e.session_id === 'string' && SESSION_ID.test(e.session_id)) current = e.session_id
    if (e.agent_id !== undefined || e.source !== 'resume') return done
    try {
      await welcome($, e.session_id)
    } catch {
      // The person sees the resumed session waiting; nothing else to do.
    }
    return done
  })

  on('tool.call', { tool: 'mcp__self-restart__restart_after_turn' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: SUBAGENT }
    const input = e as { reason?: unknown; resume?: unknown }
    const reason = text(input.reason)
    if (reason === undefined) return { deny: 'Say why the session restarts (`reason`); it is recorded in the transcript.' }
    if (!isTerminal) {
      return { deny: 'A restart opens a terminal window for a session run in a terminal with a person at its prompt; this one is not (a -p run, an SDK host, or an app).' }
    }
    // What the launch needs: where it can't be planned (off Windows, an id claude --resume doesn't
    // take), the restart is refused when armed, saying why; the probe is run only where it can be.
    const planned = await plan($)
    const launch = 'refusal' in planned ? undefined : planned
    // No restart loop: a session that restarted less than 2 minutes ago is refused another.
    const id = launch?.id ?? (await $.session.id().catch(() => undefined))
    const lately = id !== undefined && SESSION_ID.test(id) ? await lastRestart($, id) : undefined
    if (lately !== undefined) return { deny: `Not queued: ${await loop($, lately)}. If a restart is still the fix, tell the person, who can restart by hand.` }
    // The pre-check at the call: nothing is queued while anything stands.
    const stop = await blockers($, launch)
    if (stop !== undefined) {
      return { deny: `Not queued: ${stop}. Each would make the restart's exit stop at its confirmation, or end with this process: stop them, then call again.` }
    }
    const resume = text(input.resume)
    await $.state.set(queued, entry(reason, resume))
    await mark($, 'restart')
    $.ui.status('restart queued for when this turn ends')
    const then = resume === undefined ? 'then waits for the next message' : `then resumes with: ${resume}`
    return {
      result: `Queued. Once this turn ends, a new terminal window opens in the folder this session started in, this session exits, and the window resumes it once this process has gone; the reason is recorded in the transcript: ${reason}. The restarted session ${then}. When Claude Code was started through the claude wrapper, this same tab resumes it instead, with no new window; in a pane running self-switch's slot runner, the pane does. When the tab or the slot can't be used, the restart says why. On anything but Windows nothing runs, and you are told on your next turn.`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-restart: queuing the restart failed; nothing is queued.' }))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    go.turnEnded()
    const { value } = await $.state.get(queued)
    if (!value) return done
    await $.state.set(queued, null)
    if (e.isAborted || e.reason !== 'answer') {
      $.ui.status(undefined)
      $.ui.toast("Restart cancelled: the turn didn't finish.")
      await mark($, null)
      return done
    }
    armed = value
    await mark($, 'restart')
    $.clock.after(SETTLE_MS, () => void restartNow($, value))
    return done
  })

  // A message that starts a turn before the restart's exit has started takes the restart back.
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (e.agentId === undefined) go.turnStarted()
    if (e.agentId !== undefined || armed === undefined) return started
    armed = undefined
    $.ui.status(undefined)
    $.ui.toast('Restart cancelled: a new turn started before this session exited.')
    void mark($, null)
    void cancelled($, "The restart you queued didn't go ahead: a new turn started before this session exited. The session goes on.")
    return started
  })
}
