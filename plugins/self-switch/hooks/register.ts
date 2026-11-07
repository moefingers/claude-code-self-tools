// A session switches this terminal to another conversation: once the current turn ends, this
// conversation ends here, its context untouched, and conversation `to` is resumed in its place. For
// the person's own use, where no coordinator runs: in coordinated mode (the coordinator's gate file
// for this conversation says `coordinated: true`) it refuses, since the coordinator runs switches
// there. The model calls switch_after_turn with `to`, `reason` and `notes`, all required; a command
// can't run while the turn the model is in waits on it, so the call is queued and the switch runs
// once the turn has ended with an answer. An interrupted turn, or a new one, cancels it; so does a
// resume or a clear that makes this session another conversation first: a queued switch runs only in
// the conversation that queued it. Only the main conversation switches this way, never a subagent,
// and only one run in a terminal.
//
// Before anything moves, one probe of the machine (machine.ts) reads every running claude.exe, the
// engine's session registry, the transcripts' project folders and the claim locks, and takes the
// claim lock on `to` in the same run. A verdict of unknown gets up to 3 more probes over about 10
// seconds (a claude.exe starting or exiting reads as unknown for a moment), the claim given back
// meanwhile. The switch goes ahead only when `to` is NOT LIVE (liveness) and this session is at a
// safe point (safePoint: no subagent, nothing busy under its claude.exe, git at rest, and for an
// in-place switch a clean checkout); anything that can't be read refuses, saying what. Then the
// leaving row goes into this conversation, the ticket into the plugin's store, keyed by `to`, and one
// transport runs (pickTransport):
// - in place, `/resume <to>`, when both conversations' transcripts sit in one project folder; the
//   session id must then read `to`, or the switch didn't take and is said not to have;
// - the slot, when this claude.exe runs in a pane's claude-slot.ps1 of the shipped hash: a record for
//   the slot, then `/exit`; the slot runner checks it all again and resumes `to` in the same pane;
// - the tab, when this session was started through the claude wrapper (a `claude` function in the
//   person's PowerShell profile, tools/claude-wrapper/claude-wrapper.ps1): it carries
//   CLAUDE_PANE_TOKEN, and the wrapper's pane file names the PowerShell that is this claude.exe's own
//   parent (paneFallback, on the probe that judged), and the pane file is of version 2, the wrapper
//   that checks the claim and takes the last look. A ticket for the wrapper naming the probe's claim,
//   written whole and moved into place, then `/exit`; the wrapper deletes the ticket, checks it (the
//   claim lock must still name its claim; right before claude runs, RECHECK), and resumes `to` in its
//   folder, in the same tab. Taken back, the ticket is overwritten as withdrawn, if it is there and
//   still names this switch's claim;
// - a new window otherwise, which waits for this process to exit, checks again, and runs
//   claude-launch.ps1 for `to`; then `/exit`. When this pane runs a slot runner that can't be used
//   (its script can't be hashed, or has another hash), the leaving row, the toast and the arrival say
//   why.
// The slot's record, the tab's ticket and the window are each placed by one run of the shared launcher
// (launch, machine.ts), which checks this is the claude.exe the probe judged and takes the claim again.
// S10w: a wake-up armed with self-wake for this conversation holds the switch, read from self-wake's
// marker (readWake) at the call, at the run, and once more right before the final command (a wake-up
// set in the same turn is marked as that turn ends, which nothing orders before the first read);
// self-wake on with no marker, or one that can't be read, holds too. The conversation it is read for
// is the one the last SessionStart of a startup, a resume or a clear named, as self-wake keys its
// markers: while `$.session.id()` reads another, within ID_LAG_MS of that event (the id lags it), the
// switch waits. Past that, or where no such event reached this plugin (a managed or Team/Enterprise
// guard keeps classic hooks from mods), it is `$.session.id()`'s, said in the log. A fork's
// SessionStart moves nothing. A session cron (CronCreate, /loop, ScheduleWakeup, read with CronList)
// holds a switch that ends this process (a slot, a tab, a window); one that can't be read holds too. A
// durable cron is named apart: it survives the exit, so the hold says to delete it.
// Other pending wake-ups are dropped by every transport (an in-place `/resume` swaps `$.state`; an
// exit ends them): the tool's result, the leaving row and the arrival say so, so they can be set again.
// The left record (\u00a73.4): this plugin writes one for the conversation it leaves, in place from the
// classic SessionStart of the one it arrives at (LEFT_SETTLE_MS after, keyed by the event's id), and on
// exit right before its own `/exit`, taken back (written over as withdrawn) when that `/exit` then
// doesn't run, or runs and leaves the session open (at the next turn's end, while the record is still
// that exit's); never for a typed `/exit`, a crash or a kill. Its probe reads the
// target's record, which may waive L3 and L5 (a return trip soon after a switch), and the last look
// in place, in the window or in a tab of pane file version 3 checks the transcript against it; this
// pane's slot runner doesn't until slots v2, nor does an older wrapper, so a move that rests on a record
// goes to a new window instead, saying why.
// No transport passes a permission flag: the resumed conversation starts in the mode a new session would.
//
// The process that resumes `to` (this one, in place; the slot's or the window's otherwise) finds the
// ticket at the classic SessionStart for `to`, at most 15 minutes old: it removes it, releases the
// claim lock, appends the arrival row, and submits `resume` as the first prompt, in the plugin's frame.
//
// Every conversation this plugin runs in keeps a heartbeat (`alive:<id>`: when, its start folder and
// project) at each turn's start and end and every 2 minutes; liveness reads it (L5), and a switch to a
// conversation of another project reads its folder from it. Heartbeats 30 days old are dropped.
// S11, uncommitted changes: in each worktree the call names (`trees`, each checked to be a worktree of
// the start folder's repository) and in the session's own folder when it is another tree, any hold; in
// the start folder (for an in-place switch), only changes made since the conversation started: the
// classic SessionStart of a startup keeps a fingerprint of the start folder's dirty state
// (`baseline:<id>` in the plugin's store), a `/clear` carries the baseline of the conversation it
// ends to the one it starts (none when that one had none, or one of another folder), and a resume or
// a fork takes none; the start folder's dirt holds only once that fingerprint has changed, or when
// there is none. A baseline is pruned 30 days after it was last used (read at a switch, or touched by
// the heartbeat), never by its age.
// `/resume` swaps `$.state` for the conversation resumed, start folder included, and at the classic
// SessionStart of the resume `$.session.id()` and `$.state` may still be the conversation that left
// (seen live on 2.1.318). So the start folder is read from the module first, where session.start keeps
// it for the life of the process, and the resume beats the resumed conversation by the id its event
// names, never by `$.session.id()`.
import type { EngineInterface, Register, Timer } from 'claude-code'
import type { Heartbeat, Queued, Ticket } from '../types'
import type { AgentLike, LaunchInput, LeftStat, Pane, Probe, ProcessRef, Transport } from './machine'
import {
  agentsHeld,
  agentsWayOut,
  blockersText,
  exitBlockers,
  isBusyAgent,
  LAUNCH_RUN_MS,
  leftPath,
  readCrons,
  paneFallback,
  paneNoLeft,
  paneReads,
  paneTicketPath,
  readPane,
  type Baseline,
  checkTrees,
  CLAIM_CHECK_LIVE,
  fingerprintOf,
  CLAIM_CHECKED,
  claimCheckScript,
  gatePath,
  isSafeFolder,
  launch as buildLaunch,
  LAUNCH_DEADLINE_MS,
  LAUNCH_RETRY_MS,
  LEFT_SETTLE_MS,
  LEFT_WRITTEN,
  leftScript,
  oneLine,
  liveness,
  newRegistryKeys,
  parseLaunch,
  pickTransport,
  parseProbe,
  powershellCall,
  powershellPath,
  probeScript,
  projectName,
  quoted,
  readGate,
  readGit,
  readWake,
  sameFolder,
  RELEASED,
  releaseScript,
  SESSION_ID,
  safePoint,
  SLOT_NO_LEFT,
  slotRecordPath,
  stateFolder,
  SYSTEM_ROOT,
  WAIT_SECONDS,
  wakeHold,
} from './machine'
import { configureUpdateCheck, loadUpdateCheck, withUpdateNotice } from './update-check'

const TOOL = 'mcp__self-switch__switch_after_turn'
const queued = { plugin: 'self-switch', key: 'queued' } as const
const folderKey = { plugin: 'self-switch', key: 'folder' } as const
const cancelsKey = { plugin: 'self-switch', key: 'cancels' } as const

/** After this many cancels in a row by a new turn, the row says the session is busy. */
const BUSY_AFTER = 3

/** The plugin's store key for switches under way, by the conversation each resumes. */
const SWITCHES = 'switches'
/** The plugin's store key for when each conversation last switched away or arrived, by session id. */
const RECENT = 'recentSwitches'
/** The plugin's store keys for heartbeats: `alive:<session id>`. */
const ALIVE = 'alive:'
/** The plugin's store keys for S11's baselines: `baseline:<session id>`, the start folder's dirty state at the conversation's start. */
const BASELINE = 'baseline:'

/**
 * The waits before each look again while the verdict is unknown: a claude.exe that is starting or
 * exiting, or a Claude Code command run from a shell (alive 5 to 7 s), reads that way for a moment.
 */
const RETRY_MS = [2500, 3500, 4000] as const
/** A beat after the turn's end, so the turn is no longer running when the switch starts. */
const SETTLE_MS = 500
/** How long after the exit command to look whether the session is still here. */
const CHECK_MS = 5000
/** How long the probe may take. */
const PROBE_MS = 60_000
/** How long releasing a claim lock may take. */
const RELEASE_MS = 15_000
/** A ticket older than this is dropped, not delivered: the switch failed, and it came back later by hand. */
const TICKET_MS = 15 * 60 * 1000
/** A second switch sooner than this after the last switch or arrival is refused: no switch loop. */
const LOOP_MS = 2 * 60 * 1000
/** How often the heartbeat is written between turns. */
const BEAT_MS = 2 * 60 * 1000
/** A day, in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000
/** Heartbeats older than this are dropped. */
const KEEP_BEATS_MS = 30 * 24 * 60 * 60 * 1000
/** How often old heartbeats are looked for. */
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000
/** After an in-place resume took, the switch delivers the arrival itself if the SessionStart hasn't by then. */
const ARRIVAL_FALLBACK_MS = 5000
/**
 * How long after a main-loop SessionStart `$.session.id()` may still read the conversation before it
 * (it lags the event, seen live on 2.1.318): within it, a disagreement holds a switch (idsDisagree);
 * past it, `$.session.id()` is trusted, so a disagreement that never resolves can't hold every switch.
 */
const ID_LAG_MS = 15_000
/** The most switches under way the store keeps. */
const MAX_KEPT = 50

const DESCRIPTION = [
  "Switches this terminal to another conversation once the current turn ends: this conversation ends here, its context untouched, and conversation `to` (a session id, as claude --resume takes) is resumed in its place: in this same process when both live in one project folder, else in this pane's slot (a Windows Terminal pane running self-switch's claude-slot.ps1), else in this same tab when Claude Code was started through the claude wrapper (the `claude` function from claude-code-self-tools in the person's PowerShell profile), else in a new window.",
  "For the person's own use: call it only when they ask you to switch to another conversation, at a finished break (never mid-merge, mid-push or mid-task), with your notes written first. Stop Monitor tasks first. A wake-up pending from wake_after holds the switch: cancel it (cancel_wake) or wait for it. A session cron (CronCreate, /loop, ScheduleWakeup) holds a switch that ends this process (to a slot, a tab or a window): delete it (CronDelete) first. Wake-ups of any other kind are dropped by the switch, so set them again in the conversation switched to if they are still needed.",
  'Where the coordinator runs, switches come from it: this tool refuses there.',
  '`reason` and `notes` (where your notes are) are required; both are recorded in this conversation and in the one resumed. `resume` is the message that starts the resumed conversation\'s first turn.',
  'Before anything runs it checks, and refuses saying why: when `to` is open, or may be open, anywhere on this machine; when anything still runs under this session (subagents, background Bash or Monitor jobs, git, builds, dev servers, a heavy slot); when an in-place switch would leave changes made since this conversation started uncommitted in the checkout both share; when a worktree named in `trees`, or the one this session works in, has uncommitted changes; within 2 minutes of a switch. Windows only, in a terminal.',
  '`trees` (optional): the git worktrees you worked in, absolute paths, each a worktree of the repository this session started in; each must be clean.',
  'End the turn after calling it; the switch starts once your answer is shown.',
].join(' ')

const SUBAGENT =
  "A subagent can't switch the session to another conversation. Finish your piece and return its result, saying a switch is wanted and to which conversation: the main session can switch."

const COORDINATED = 'The coordinator runs switches in this session: ask the merger or the owner for a wrap-up.'
const NO_GATE = "requireCoordinator is on and the coordinator's gate file for this session isn't there, so this session doesn't switch on its own."
const UNREADABLE_GATE = "the coordinator's gate file for this session can't be read, so whether the coordinator runs switches here is unknown"

/** The plugin's settings, read once at load. */
let settings = { requireCoordinator: false, configDirs: [] as readonly unknown[], heavySlotRoot: '' as unknown }

/** Whether this session runs in a terminal with a person at its prompt; read at each session.start. */
let isTerminal = true

/**
 * The switch the last turn's end armed, until its final command starts; a main-loop turn that starts
 * first takes it back. Module state, as the timer that runs it is.
 */
let armed: Queued | undefined

/** The heartbeat's timer, one per load of the module. */
let beat: Timer | undefined
/**
 * The folder this process started in, as session.start kept it: `/resume` swaps `$.state`, so this
 * is read first (startFolderOf). A reload of the module sets it again from `$.state`.
 */
let startFolder: string | undefined
/**
 * The conversation this process holds now: from each main-loop classic SessionStart's own id (the
 * event's: `$.session.id()` may still read the one before) of a startup, a resume or a clear, never a
 * fork's (the /fork background copy, a conversation moved to the background: the foreground stays) or
 * a source this plugin doesn't know; and at session.start when none is known yet. A `/clear` carries
 * the S11 baseline of this conversation to the one it starts.
 */
let current: string | undefined
/** Whether `current` was named by a classic SessionStart (else by a session.start, from `$.session.id()`). */
let currentFromEvent = false
/** When `current` was named (by a classic SessionStart, or a session.start), by the engine's clock. */
let currentAt: number | undefined
/**
 * The exit record a switch wrote right before an `/exit` that ran and came back with the session still
 * open (a dialog answered no): taken back at the next main-loop turn's end, if still that exit's.
 */
let exitLeft: { readonly state: string; readonly id: string; readonly leaving: ProcessRef } | undefined
/** The registry keys not in REGISTRY_KEYS already logged by this process: each is logged once. */
const seenKeys = new Set<string>()
/** When old heartbeats were last looked for. */
let prunedAt = Number.NEGATIVE_INFINITY
/** The conversations whose arrival is being delivered now: one delivery each. */
const arriving = new Set<string>()

/**
 * The model's text as it is kept and passed on: one line, control and format characters dropped, at
 * most 400 characters (oneLine); undefined when it is not a string or nothing is left.
 */
function text(raw: unknown): string | undefined {
  const line = typeof raw === 'string' ? oneLine(raw) : ''
  return line === '' ? undefined : line
}

/** Why a call was refused, as one line. */
function why(err: unknown): string {
  const said = (err instanceof Error ? err.message : String(err)).trim()
  return said === '' ? 'no reason given' : said
}

/** One line, at most 300 characters: a process's output can run over many. */
const brief = (said: string): string => {
  const line = said.replace(/\s*\n\s*/g, ' ').trim()
  return line.length > 300 ? `${line.slice(0, 299)}\u2026` : line
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A time as the rows say it: UTC, to the minute. */
const stamp = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`

/** Tells the model on its next turn, in a row it reads and the person doesn't see as typed. */
async function tellModel($: EngineInterface, note: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
  } catch {
    // The toast has told the person; there is no other way to reach the model.
  }
}

async function refuse($: EngineInterface, toast: string, note: string): Promise<void> {
  $.ui.toast(toast)
  await tellModel($, note)
}

/** A variable of this process's environment, or undefined when unset or unreadable. */
async function env(read: () => Promise<string | undefined>): Promise<string | undefined> {
  try {
    return await read()
  } catch {
    return undefined
  }
}

/**
 * This tab's claude wrapper: the session's CLAUDE_PANE_TOKEN and the pane file it names. `why` when a
 * session with a token has no pane file that reads; undefined when it has none (it wasn't started
 * through the wrapper). Whether the switch can use it is pickTransport's (paneFallback).
 */
async function tabOf($: EngineInterface, state: string): Promise<{ readonly token: string; readonly pane: Pane } | { readonly why: string } | undefined> {
  const token = await env(() => $.env.get('CLAUDE_PANE_TOKEN'))
  if (token === undefined || token === '') return undefined
  const pane = await readPane($, state, token)
  return 'why' in pane ? pane : { token, pane }
}

/** The session's id, or undefined when it can't be read. */
async function sessionId($: EngineInterface): Promise<string | undefined> {
  try {
    return await $.session.id()
  } catch {
    return undefined
  }
}

/**
 * Why the conversation this process holds is unclear now, or undefined when it isn't: `$.session.id()`
 * reads `own`, but the last main-loop SessionStart of a startup, a resume or a clear named another
 * (`current`, the event's own id, which self-wake keys its markers by), at most ID_LAG_MS ago. Right
 * after an in-place move the id lags its event; a switch then would read another conversation's wake
 * marker and write another's exit record, so it waits. Only an event's id holds: where none reached
 * this plugin (a managed or Team/Enterprise guard keeps classic hooks from mods, and session.start
 * doesn't run again after a /clear or a /resume), `current` is a session.start's own reading, and a
 * later `$.session.id()` is the better one. Past ID_LAG_MS, `$.session.id()` is trusted, said in the log.
 */
async function idsDisagree($: EngineInterface, own: string): Promise<string | undefined> {
  if (!currentFromEvent || current === undefined || current === own) return undefined
  const since = currentAt === undefined ? Number.NaN : (await $.clock.now()) - currentAt
  if (since >= 0 && since <= ID_LAG_MS) {
    return `this session's id reads ${own}, but its last SessionStart named ${current}: it is moving between conversations, so which one it would leave is unclear`
  }
  const when = Number.isFinite(since) && since > 0 ? `${Math.round(since / 1000)} seconds ago` : 'at a time the clock no longer agrees with'
  $.ui.log(`this session's id reads ${own}, but its last SessionStart named ${current} ${when}; past ${ID_LAG_MS / 1000} seconds the id is trusted, so the switch leaves ${own}.`)
  return undefined
}

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

/**
 * Takes back the exit record this process wrote for conversation `id` right before an /exit that then
 * didn't end it: written over as withdrawn (`{"v":1,"cancelled":true}`, which reads as not of its shape
 * and waives nothing), read first, only while it is still that record (how `exit`, this process). Else
 * a later /exit typed by hand within 10 minutes could pass for the switch's.
 */
async function withdrawLeft($: EngineInterface, state: string, id: string, leaving: ProcessRef): Promise<void> {
  await withdrawIfOurs($, leftPath(state, id), raw => raw.how === 'exit' && raw.id === id && raw.pid === String(leaving.pid) && raw.created === leaving.created)
}

/** The agents still to report (any that hasn't ended); undefined when the list can't be read. */
async function busyAgents($: EngineInterface): Promise<readonly AgentLike[] | undefined> {
  try {
    return (await $.agent.list()).filter(a => isBusyAgent(a.status))
  } catch {
    return undefined
  }
}

/** The session's agents as the safe point reads them, or why they can't be read. */
async function agentList($: EngineInterface): Promise<readonly AgentLike[] | string> {
  try {
    return await $.agent.list()
  } catch (err) {
    return why(err)
  }
}

/**
 * Why a switch can't go ahead with these agents, or undefined when none is still to report. One that
 * won't report on its own (an idle teammate, a status not known here) holds too, saying how to clear it.
 */
function blocked(busy: readonly AgentLike[] | undefined): string | undefined {
  if (busy === undefined) return "the session's subagents can't be read, so whether any is still running is unknown"
  if (busy.length === 0) return undefined
  const way = agentsWayOut(busy)
  return `${agentsHeld(busy)}, and ${busy.length === 1 ? 'its work' : 'their work'} would be left behind${way === undefined ? '' : `; ${way}`}`
}

/** What the switch needs to read and run, each from the engine and the settings, never from the tool's input. */
type Context = {
  readonly powershell: string
  readonly state: string
  readonly own: string
  readonly cwd: string
  readonly folder: string
  readonly configDirs: readonly string[]
  readonly heavySlotRoot?: string
}

/** Windows PowerShell and the plugins' state folder, or why they can't be found. */
async function machine($: EngineInterface): Promise<{ powershell: string; state: string } | { refusal: string }> {
  if ((await env(() => $.env.get('OS'))) !== 'Windows_NT') return { refusal: 'a switch runs only on Windows so far' }
  const root = await env(() => $.env.get('SystemRoot'))
  if (root === undefined || !SYSTEM_ROOT.test(root)) {
    return { refusal: `the Windows folder (SystemRoot) reads ${JSON.stringify(root ?? '')}, not a drive and one plain folder, so PowerShell can't be found by its known path` }
  }
  const local = await env(() => $.env.get('LOCALAPPDATA'))
  if (!isSafeFolder(local)) return { refusal: `%LOCALAPPDATA% reads ${JSON.stringify(local ?? '')}, not an absolute folder without quotes, so the claim locks can't be kept` }
  return { powershell: powershellPath(root), state: stateFolder(local) }
}

async function context($: EngineInterface): Promise<Context | { refusal: string }> {
  const found = await machine($)
  if ('refusal' in found) return found
  const own = await sessionId($)
  if (own === undefined || !SESSION_ID.test(own)) return { refusal: `this session's id (${JSON.stringify(own ?? '')}) is not a session id` }
  const folder = await startFolderOf($)
  if (!isSafeFolder(folder)) return { refusal: "the folder this session started in isn't known, or isn't an absolute folder without quotes" }
  let cwd: string
  try {
    cwd = await $.session.cwd()
  } catch (err) {
    return { refusal: `this session's folder can't be read: ${why(err)}` }
  }
  const dirs = await configDirsOf($)
  if ('refusal' in dirs) return dirs
  const heavy = settings.heavySlotRoot
  if (heavy !== '' && heavy !== undefined && !isSafeFolder(heavy)) return { refusal: `the heavySlotRoot setting reads ${JSON.stringify(heavy)}, not an absolute folder without quotes` }
  return { ...found, own, cwd, folder, configDirs: dirs.configDirs, ...(isSafeFolder(heavy) ? { heavySlotRoot: heavy.replace(/\\+$/, '') } : {}) }
}

/** The config folders the checks read: this session's own (CLAUDE_CONFIG_DIR, or %USERPROFILE%\.claude) first, then the configDirs setting's. */
async function configDirsOf($: EngineInterface): Promise<{ readonly configDirs: readonly string[] } | { readonly refusal: string }> {
  const configured = await env(() => $.env.get('CLAUDE_CONFIG_DIR'))
  const profile = await env(() => $.env.get('USERPROFILE'))
  const ownConfig = configured !== undefined && configured !== '' ? configured : profile === undefined ? undefined : `${profile}\\.claude`
  if (!isSafeFolder(ownConfig)) return { refusal: `this session's config folder (CLAUDE_CONFIG_DIR, or %USERPROFILE%\\.claude) reads ${JSON.stringify(ownConfig ?? '')}, not an absolute folder without quotes` }
  const configDirs = [ownConfig.replace(/\\+$/, '')]
  for (const dir of settings.configDirs) {
    if (!isSafeFolder(dir)) return { refusal: `the configDirs setting holds ${JSON.stringify(dir)}, not an absolute folder without quotes` }
    const plain = dir.replace(/\\+$/, '')
    if (!configDirs.some(known => known.toLowerCase() === plain.toLowerCase())) configDirs.push(plain)
  }
  if (configDirs.length > 8) return { refusal: 'the configDirs setting names more than 7 folders' }
  return { configDirs }
}

/**
 * Why the coordinator's gate refuses this switch, or undefined when it doesn't: a gate file for this
 * conversation, at most a day old, saying `coordinated: true`; or none at all with requireCoordinator
 * on. A file that is there but can't be read refuses too.
 */
async function gateRefusal($: EngineInterface, state: string, id: string, now: number): Promise<string | undefined> {
  const path = gatePath(state, id)
  let isThere: boolean
  try {
    isThere = await $.fs.exists(path)
  } catch {
    return UNREADABLE_GATE
  }
  if (!isThere) return settings.requireCoordinator ? NO_GATE : undefined
  let read: string
  try {
    const got = await $.fs.read(path)
    if (typeof got !== 'string') return UNREADABLE_GATE
    read = got
  } catch {
    return UNREADABLE_GATE
  }
  const gate = readGate(read, now)
  if (gate === 'coordinated') return COORDINATED
  if (gate === 'bad') return UNREADABLE_GATE
  if (gate === 'stale') return settings.requireCoordinator ? NO_GATE : undefined
  return undefined
}

/** The gate at the call, where it can be read already; otherwise the switch's own run reads it. */
async function gateAtCall($: EngineInterface): Promise<string | undefined> {
  const own = await sessionId($)
  const local = await env(() => $.env.get('LOCALAPPDATA'))
  if (own === undefined || !SESSION_ID.test(own) || !isSafeFolder(local)) return undefined
  return gateRefusal($, stateFolder(local), own, await $.clock.now())
}

/** When this conversation last switched away or arrived, if that was less than 2 minutes ago. */
async function lastSwitch($: EngineInterface, id: string): Promise<number | undefined> {
  const [stored, now] = await Promise.all([$.store.get(RECENT), $.clock.now()])
  const at = isRecord(stored) ? stored[id] : undefined
  return typeof at === 'number' && now >= at && now - at < LOOP_MS ? at : undefined
}

/** Notes that this conversation switched away or arrived now; drops the notes 2 minutes old. */
async function noteRecent($: EngineInterface, id: string): Promise<void> {
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

/** Why a switch this soon after the last is refused. */
async function loop($: EngineInterface, at: number): Promise<string> {
  const seconds = Math.max(1, Math.round(((await $.clock.now()) - at) / 1000))
  return `this conversation switched or arrived ${seconds} seconds ago, and another switch within 2 minutes is refused, so that switches can't loop unattended`
}

/** A stored ticket, checked; undefined when it isn't one. */
function ticketOf(value: unknown): Ticket | undefined {
  if (!isRecord(value)) return undefined
  const { at, from, by, transport, reason, notes, resume, fallback } = value
  if (typeof at !== 'number' || typeof from !== 'string' || !SESSION_ID.test(from) || typeof by !== 'string') return undefined
  if (transport !== 'in-place' && transport !== 'slot' && transport !== 'pane' && transport !== 'window') return undefined
  if (typeof reason !== 'string' || typeof notes !== 'string') return undefined
  // Masked again as it is read: another process may have written the store.
  return {
    at,
    from,
    by,
    transport,
    reason: oneLine(reason),
    notes: oneLine(notes),
    ...(typeof resume === 'string' ? { resume: oneLine(resume) } : {}),
    ...(typeof fallback === 'string' ? { fallback: oneLine(fallback, 300) } : {}),
  }
}

/** The switches under way in the store, each checked; anything else is dropped. */
async function tickets($: EngineInterface): Promise<Record<string, Ticket>> {
  const stored = await $.store.get(SWITCHES)
  const kept: Record<string, Ticket> = {}
  if (!isRecord(stored)) return kept
  for (const [id, value] of Object.entries(stored)) {
    const ticket = ticketOf(value)
    if (SESSION_ID.test(id) && ticket !== undefined) kept[id] = ticket
  }
  return kept
}

/** Keeps the ticket for the process that resumes `id`, or takes it back (`value` null). */
async function keepTicket($: EngineInterface, id: string, value: Ticket | null): Promise<void> {
  const all = await tickets($)
  delete all[id]
  const rest = Object.entries(all).slice(-(MAX_KEPT - 1))
  await $.store.set(SWITCHES, Object.fromEntries(value === null ? rest : [...rest, [id, value]]))
}

/** Removes the claim lock on `id` when it names `by`; says so in the log when it can't. */
async function release($: EngineInterface, powershell: string, state: string, id: string, by: string): Promise<void> {
  try {
    const call = powershellCall(powershell, releaseScript({ stateDir: state, id, by }))
    const run = await $.process.run(call.argv, { stdin: call.stdin, timeoutMs: RELEASE_MS })
    const said = run.exitCode === 0 ? RELEASED.exec(run.stdout)?.[1] : undefined
    if (said === 'released' || said === 'absent' || said === 'not-ours') return
    // `busy`: another process had it open throughout. Left in place, it refuses every other move on
    // that conversation until it goes stale, which is the safe side; said so, never taken as released.
    const what = said === 'busy' ? 'another process had it open throughout' : `exit ${run.exitCode}`
    $.ui.log(`the claim lock on ${id} wasn't released (${what}); it is left in place, and goes stale 15 minutes after its creator exits.`)
  } catch (err) {
    $.ui.log(`the claim lock on ${id} wasn't released (${why(err)}); it goes stale 15 minutes after its creator exits.`)
  }
}

/**
 * The last look before an in-place /resume: why `to` is held by another process now (L1, L2, read
 * again), or why the claim on it no longer names `by`; undefined when neither.
 */
async function claimStill($: EngineInterface, ctx: Context, to: string, by: string, left?: LeftStat): Promise<string | undefined> {
  try {
    const call = powershellCall(ctx.powershell, claimCheckScript({ stateDir: ctx.state, id: to, by, configDirs: ctx.configDirs, ...(left === undefined ? {} : { left }) }))
    const run = await $.process.run(call.argv, { stdin: call.stdin, timeoutMs: RELEASE_MS })
    const held = run.exitCode === 0 ? CLAIM_CHECK_LIVE.exec(run.stdout)?.[1] : undefined
    if (held !== undefined) return `at the last look before /resume, ${oneLine(held, 300)}`
    const said = run.exitCode === 0 ? CLAIM_CHECKED.exec(run.stdout)?.[1] : undefined
    if (said === 'ours') return undefined
    return said === undefined ? `the claim on ${to} couldn't be read again before the resume` : `the claim on ${to} no longer names this switch (${said})`
  } catch (err) {
    return `the claim on ${to} couldn't be read again before the resume: ${why(err)}`
  }
}

/** Tickets older than 15 minutes: their switch is over one way or another, so their locks are released. */
async function pruneTickets($: EngineInterface, now: number): Promise<void> {
  const all = await tickets($)
  const old = Object.entries(all).filter(([, t]) => now - t.at > TICKET_MS || now < t.at)
  if (old.length === 0) return
  const found = await machine($)
  for (const [id, t] of old) {
    if (!('refusal' in found)) await release($, found.powershell, found.state, id, t.by)
    await keepTicket($, id, null)
  }
}

/** The folder this process started in: the module's, else the one `$.state` kept; undefined when neither knows it. */
async function startFolderOf($: EngineInterface): Promise<string | undefined> {
  if (startFolder !== undefined && startFolder !== '') return startFolder
  const { value } = await $.state.get(folderKey)
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * A conversation's heartbeat: when, the folder its process started in, and that folder's project.
 * `resumed`, at a resume, names the conversation: `$.session.id()` may still read the one that left.
 */
async function heartbeat($: EngineInterface, resumed?: string): Promise<void> {
  try {
    const id = resumed ?? (await sessionId($))
    if (id === undefined || !SESSION_ID.test(id)) return
    const folder = await startFolderOf($)
    if (folder === undefined) return
    const value: Heartbeat = { at: await $.clock.now(), folder, project: projectName(folder) ?? '' }
    await $.store.set(`${ALIVE}${id}`, value)
    await touchBaseline($, id, value.at)
  } catch {
    // A heartbeat missed is one live sign fewer; the next one comes in 2 minutes.
  }
}

/** A stored S11 baseline, checked; undefined when it isn't one. */
function baselineOf(value: unknown): Baseline | undefined {
  if (!isRecord(value) || !isSafeFolder(value.folder) || typeof value.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.fingerprint) || typeof value.at !== 'number') return undefined
  return { folder: value.folder, fingerprint: value.fingerprint, at: value.at, ...(typeof value.usedAt === 'number' ? { usedAt: value.usedAt } : {}) }
}

/**
 * This conversation's S11 baseline, checked, and marked used now (it is pruned 30 days after its last
 * use); undefined when there is none, or it can't be read.
 */
async function readBaseline($: EngineInterface, id: string): Promise<Baseline | undefined> {
  try {
    const kept = baselineOf(await $.store.get(`${BASELINE}${id}`))
    if (kept === undefined) return undefined
    await $.store.set(`${BASELINE}${id}`, { ...kept, usedAt: await $.clock.now() })
    return kept
  } catch {
    return undefined
  }
}

/** Marks conversation `id`'s baseline used at `now`, when it was last used more than a day before. */
async function touchBaseline($: EngineInterface, id: string, now: number): Promise<void> {
  const kept = baselineOf(await $.store.get(`${BASELINE}${id}`))
  if (kept !== undefined && now - (kept.usedAt ?? kept.at) > DAY_MS) await $.store.set(`${BASELINE}${id}`, { ...kept, usedAt: now })
}

/**
 * Keeps a started conversation's S11 baseline: the fingerprint of `folder`'s dirty state now. Only
 * when nothing is stored under its key, a value that can't be read included: a baseline is never
 * replaced. Nothing when the folder can't be read whole: S11 then holds the start folder's dirt,
 * saying there is no baseline.
 */
async function keepBaseline($: EngineInterface, id: string, folder: string): Promise<void> {
  try {
    if ((await $.store.get(`${BASELINE}${id}`)) !== undefined) return
    const fingerprint = await fingerprintOf($, folder)
    if (fingerprint === null) return
    const at = await $.clock.now()
    const value: Baseline = { folder, fingerprint, at, usedAt: at }
    await $.store.set(`${BASELINE}${id}`, value)
  } catch {
    // No baseline: the start folder's dirt holds, and says why.
  }
}

/**
 * At a `/clear`: carries the S11 baseline of `from`, the conversation it ended, to `to`, the one it
 * started, when it is of `folder`: its fingerprint and `at` as they were, used now. Never a fresh
 * fingerprint: by now the folder holds `from`'s own changes, and one taken now would let them
 * through. Nothing when `from` had none, or one of another folder, or `to` has one already: S11
 * then holds the start folder's dirt, saying there is no baseline.
 */
async function carryBaseline($: EngineInterface, from: string | undefined, to: string, folder: string): Promise<void> {
  try {
    if (from === undefined || from === to) return
    if ((await $.store.get(`${BASELINE}${to}`)) !== undefined) return
    const kept = baselineOf(await $.store.get(`${BASELINE}${from}`))
    if (kept === undefined || !sameFolder(kept.folder, folder)) return
    const value: Baseline = { folder: kept.folder, fingerprint: kept.fingerprint, at: kept.at, usedAt: await $.clock.now() }
    await $.store.set(`${BASELINE}${to}`, value)
  } catch {
    // No baseline: the start folder's dirt holds, and says why.
  }
}

/** Another conversation's heartbeat, checked; undefined when there is none. */
async function readHeartbeat($: EngineInterface, id: string): Promise<Heartbeat | undefined> {
  const value = await $.store.get(`${ALIVE}${id}`)
  if (!isRecord(value) || typeof value.at !== 'number' || typeof value.folder !== 'string' || typeof value.project !== 'string') return undefined
  return { at: value.at, folder: value.folder, project: value.project }
}

/** Drops heartbeats older than 30 days, and anything under their keys that isn't one. */
async function pruneBeats($: EngineInterface, now: number): Promise<void> {
  if (now - prunedAt < PRUNE_EVERY_MS) return
  prunedAt = now
  for (const key of await $.store.keys()) {
    const prefix = key.startsWith(ALIVE) ? ALIVE : key.startsWith(BASELINE) ? BASELINE : undefined
    if (prefix === undefined) continue
    const value = await $.store.get(key)
    // A heartbeat by its time; a baseline by its last use, never by its age.
    const at = !isRecord(value) ? undefined : prefix === BASELINE && typeof value.usedAt === 'number' ? value.usedAt : value.at
    if (!SESSION_ID.test(key.slice(prefix.length)) || typeof at !== 'number' || now - at > KEEP_BEATS_MS) await $.store.delete(key)
  }
}

/** The 2-minute tick: the heartbeat, then whatever has run out. */
async function tick($: EngineInterface): Promise<void> {
  try {
    await heartbeat($)
    const now = await $.clock.now()
    await pruneTickets($, now)
    await pruneBeats($, now)
  } catch {
    // The next tick tries again.
  }
}

/**
 * Starts the 2-minute tick, again when it ran (one timer per process), and beats now: the whole tick,
 * or at a resume the heartbeat of `resumed` alone, its pruning left to the next tick.
 */
function startBeat($: EngineInterface, resumed?: string): void {
  beat?.cancel()
  beat = $.clock.every(BEAT_MS, () => void tick($))
  if (resumed !== undefined) void heartbeat($, resumed)
  else void tick($)
}

/** Each registry key the probe saw that isn't in REGISTRY_KEYS, logged the first time this process sees it; it is ignored. */
function logNewKeys($: EngineInterface, found: Probe): void {
  for (const key of newRegistryKeys(found, seenKeys)) {
    $.ui.log(`a session registry file holds the key "${key}", which Claude Code 2.1.318 didn't write; it is ignored (liveness reads pid, sessionId and procStart).`)
  }
}

/** The probe, with the claim on `to` taken in the same run; or why it gave no answer. */
async function probe($: EngineInterface, ctx: Context, to: string): Promise<Probe | { failure: string }> {
  try {
    const script = probeScript({ ids: [ctx.own, to], take: to, configDirs: ctx.configDirs, stateDir: ctx.state, left: true, ...(ctx.heavySlotRoot === undefined ? {} : { heavySlotRoot: ctx.heavySlotRoot }) })
    const call = powershellCall(ctx.powershell, script)
    const run = await $.process.run(call.argv, { stdin: call.stdin, cwd: ctx.folder, timeoutMs: PROBE_MS })
    if (run.exitCode !== 0) return { failure: `it exited ${run.exitCode}${brief(run.stderr) === '' ? '' : `: ${brief(run.stderr)}`}` }
    const parsed = parseProbe(run.stdout)
    return 'error' in parsed ? { failure: parsed.error } : parsed
  } catch (err) {
    return { failure: `it didn't run: ${why(err)}` }
  }
}

/**
 * One run of the shared launcher (launch, machine.ts): it checks this is the claude.exe the probe
 * judged, takes the claim the probe took again for this launch, and places it (this pane's slot's
 * record, this tab's ticket, or a new window). Why it wasn't placed, and whether the run ended without a
 * clean answer (an exit code, no answer, a timeout: it may have placed something); undefined when it was.
 */
async function placeLaunch($: EngineInterface, input: LaunchInput, cwd: string): Promise<{ readonly said: string; readonly unclean: boolean } | undefined> {
  // An input the launcher refuses to build (a folder with a semicolon, say) runs nothing: a clean refusal.
  let call: { readonly argv: readonly string[]; readonly stdin: string }
  try {
    call = buildLaunch(input)
  } catch (err) {
    return { said: `the launch can't be made: ${why(err)}`, unclean: false }
  }
  try {
    const run = await $.process.run(call.argv, { stdin: call.stdin, cwd, timeoutMs: LAUNCH_RUN_MS })
    const answer = parseLaunch(run.stdout)
    if (run.exitCode === 0 && 'launched' in answer) return undefined
    const said = 'refused' in answer ? answer.refused.why : brief(`${run.stdout} ${run.stderr}`)
    return { said: `${run.exitCode !== 0 ? `the launcher exited ${run.exitCode}` : 'the launcher refused'}${said === '' ? '' : `: ${said}`}`, unclean: run.exitCode !== 0 || !('refused' in answer) }
  } catch (err) {
    return { said: `the launcher didn't run: ${why(err)}`, unclean: true }
  }
}

/**
 * Writes the left record of conversation `id` (leftScript, \u00a73.4): this process left it, in place (from
 * the SessionStart of the conversation it arrived at, LEFT_SETTLE_MS after) or by exiting (right
 * before its own /exit). Only this plugin's own moves, never on a model's word; a record that isn't
 * written leaves the 10-minute rule. Never throws: it says in the log what went wrong.
 */
async function writeLeft($: EngineInterface, id: string, how: 'in-place' | 'exit', leaving?: ProcessRef): Promise<void> {
  try {
    const found = await machine($)
    if ('refusal' in found) return
    const dirs = await configDirsOf($)
    if ('refusal' in dirs) {
      $.ui.log(`the left record for ${id} wasn't written (${dirs.refusal}); it reads live for 10 minutes, as before.`)
      return
    }
    const call = powershellCall(found.powershell, leftScript({ stateDir: found.state, id, how, configDirs: dirs.configDirs, by: 'self-switch', ...(leaving === undefined ? {} : { process: leaving }) }))
    const run = await $.process.run(call.argv, { stdin: call.stdin, timeoutMs: RELEASE_MS })
    if (run.exitCode !== 0 || LEFT_WRITTEN.exec(run.stdout)?.[1] !== id) {
      const said = brief(`${run.stdout} ${run.stderr}`)
      $.ui.log(`the left record for ${id} wasn't written (exit ${run.exitCode}${said === '' ? '' : `: ${said}`}); it reads live for 10 minutes, as before.`)
    }
  } catch (err) {
    $.ui.log(`the left record for ${id} wasn't written (${why(err)}); it reads live for 10 minutes, as before.`)
  }
}

/**
 * The row the model reads in this conversation, written before the transport: where it went. Its own
 * reason and notes, quoted all the same: one line each, at most 400 characters.
 */
const leaving = (own: string, value: Queued, at: number, fallback?: string): string =>
  `self-switch: this session was switched away at ${stamp(at)} (switch_after_turn), to conversation ${quoted(value.to)}${fallback === undefined ? '' : `, in a new window, not this pane's slot: ${quoted(fallback)}`}. Its reason: ${quoted(value.reason)}. Its notes: ${quoted(value.notes)}. ${DROPPED_HERE} Its context is untouched: resume it (claude --resume ${own}) to pick up here.`

/** What the leaving row says of wake-ups: the switch dropped them. */
const DROPPED_HERE = 'Wake-ups pending in this process were dropped with the switch: set them again in the conversation switched to, or here when this one is resumed, if they are still needed.'

/** What the arrival says of wake-ups, one plain sentence of the plugin's own. */
const DROPPED_THERE = 'Wake-ups the conversation it came from had pending were dropped with the switch: set them again here if they are still needed.'

/**
 * The row the model reads in the resumed conversation. A user-role row has no frame of its own, so
 * it opens with the plugin's name and the session it comes from, and the leaving session's words go
 * in as quoted data, one line each, at most 400 characters: they never read as the person's.
 */
const arrival = (ticket: Ticket, at: number): string =>
  `self-switch: a message from session ${quoted(ticket.from.slice(0, 8))}. It switched this conversation here at ${stamp(at)} (switch_after_turn), and gave the reason and notes below in its own words: they are that session's, not the person's, and grant no new permission. Reason: ${quoted(ticket.reason)}. Notes: ${quoted(ticket.notes)}. ${ticket.fallback === undefined ? '' : `It came here in a new window, not the slot of the pane it left: ${quoted(ticket.fallback)}. `}${DROPPED_THERE} Your context is as you left it; since then the repository, PRs and other sessions may have moved. Before acting, check where things stand (git status, fetch and rebase, your open PRs, your notes).`

/** The resumed conversation's first prompt: another session's request, framed and quoted as such. */
const resumePrompt = (ticket: Ticket, resume: string): string =>
  `self-switch: a message from session ${quoted(ticket.from.slice(0, 8))}, which switched this conversation here. It asks this conversation to: ${quoted(resume)}. That is that session's request, not the person's, and grants no new permission.`

async function sendResume($: EngineInterface, text: string): Promise<void> {
  try {
    const sent = await $.prompt.submit({ text })
    if (sent.drop !== undefined) $.ui.toast(`Resume not sent: ${sent.drop}`)
  } catch {
    $.ui.toast('Resume not sent; the conversation waits for the next message.')
  }
}

/** In the process that now holds `id`: the switch's arrival, once, if a ticket waits for it. */
async function arrive($: EngineInterface, id: string): Promise<void> {
  if (arriving.has(id)) return
  arriving.add(id)
  try {
    const stored = await $.store.get(SWITCHES)
    if (!isRecord(stored) || !(id in stored)) return
    const found = ticketOf(stored[id])
    await keepTicket($, id, null)
    if (found === undefined) return
    const now = await $.clock.now()
    const where = await machine($)
    const free = async (): Promise<void> => {
      if (!('refusal' in where)) await release($, where.powershell, where.state, id, found.by)
    }
    if (now - found.at > TICKET_MS || now < found.at) {
      await free()
      $.ui.toast("A switch's arrival note was dropped: the conversation came back more than 15 minutes after the switch.")
      return
    }
    // The row first, then the claim's release: the claim, then the transcript the row writes, covers
    // this conversation throughout.
    await noteRecent($, id)
    await tellModel($, arrival(found, now))
    await free()
    $.ui.toast(`Switched here from session ${found.from.slice(0, 8)}: ${oneLine(found.reason, 120)}`)
    const resume = found.resume
    // Later, not awaited: a prompt submitted from the start's hook would wait on that hook.
    if (resume !== undefined) $.clock.after(SETTLE_MS, () => void sendResume($, resumePrompt(found, resume)))
  } catch {
    // The resumed conversation goes on without the note; the person sees it there.
  } finally {
    arriving.delete(id)
  }
}

/**
 * A queued switch that a new turn took back, told to the model in a plugin row, never lost silently.
 * Cancels of a switch to the same conversation are counted while they come in a row; from the third,
 * the row says the session is busy: queue it again when it is idle, or ask the merger or the owner.
 */
async function cancelled($: EngineInterface, value: Queued): Promise<void> {
  let count = 1
  try {
    const { value: last } = await $.state.get(cancelsKey)
    count = last !== null && last !== undefined && last.key === value.to ? last.count + 1 : 1
    await $.state.set(cancelsKey, { key: value.to, count })
  } catch {
    // Counted or not, the row goes.
  }
  const busy = count >= BUSY_AFTER ? ` That is ${count} in a row: this session is busy. Queue it again when it's idle, or ask the merger or the owner.` : ''
  await tellModel($, `self-switch: your queued switch to ${quoted(value.to)} was cancelled because a new turn started; queue it again at the next finished break.${busy}`)
}

/** Why a queued switch doesn't run in this session now: it isn't the conversation that queued it. */
function movedOn(value: Queued, own: string | undefined): string | undefined {
  if (value.from === undefined || own === value.from) return undefined
  return `this session is now conversation ${own ?? '(unknown)'}, not ${value.from}, which queued it (a /resume or /clear came in between)`
}

/** A switch whose conversation moved on: told here, as a switch another conversation queued. */
async function movedAway($: EngineInterface, value: Queued, said: string): Promise<void> {
  if (armed === value) armed = undefined
  await refuse(
    $,
    "Switch didn't run: this session became another conversation after it was queued.",
    `self-switch: a switch to ${quoted(value.to)}, queued in conversation ${quoted(value.from ?? '')}, didn't run: ${said}. Nothing moved.`,
  )
}

/** Runs the switch, step by step; says so at each step that didn't go ahead. */
async function switchNow($: EngineInterface, value: Queued): Promise<void> {
  if (armed !== value) return
  // The break held long enough for the run to start: the cancels in a row end here. A count that
  // can't be cleared never stops the run.
  try {
    await $.state.set(cancelsKey, null)
  } catch {
    // The next cancel counts on from it; nothing else depends on it.
  }
  $.ui.status(undefined)
  const { to } = value
  const notRun = async (said: string): Promise<void> => {
    if (armed === value) armed = undefined
    await refuse($, `Switch didn't run: ${said}.`, `The switch to ${to} you queued didn't run: ${said}. This conversation goes on.`)
  }
  const ctx = await context($)
  if ('refusal' in ctx) return notRun(ctx.refusal)
  const moved = movedOn(value, ctx.own)
  if (moved !== undefined) return movedAway($, value, moved)
  // The conversation this switch leaves is the one the last SessionStart named, as self-wake keys its
  // marker (S10w) and as the exit record names it: with `$.session.id()` reading another, it waits.
  const torn = await idsDisagree($, ctx.own)
  if (torn !== undefined) return notRun(torn)
  const gateSaid = (gated: string): string => (gated === COORDINATED ? 'the coordinator runs switches in this session; ask the merger or the owner for a wrap-up' : gated)
  const gated = await gateRefusal($, ctx.state, ctx.own, await $.clock.now())
  if (gated !== undefined) return notRun(gateSaid(gated))
  if (ctx.own === to) return notRun(`this session is already conversation ${to}`)
  const stop = blocked(await busyAgents($))
  if (stop !== undefined) return notRun(stop)
  // S10w: a wake-up pending for this conversation, or one whose state can't be read, holds the switch.
  const wake = wakeHold(await readWake($, ctx.state, ctx.own))
  if (wake !== undefined) return notRun(wake)
  const lately = await lastSwitch($, ctx.own)
  if (lately !== undefined) return notRun(await loop($, lately))
  // A turn that started while the checks above ran has taken it back, and said so.
  if (armed !== value) return
  await pruneTickets($, await $.clock.now())

  /**
   * The probe, the claim it took, and the verdict on `to`: with its left record, which may waive L3 and
   * L5 (liveness, \u00a73.4); `plain` is the verdict without it, for a transport whose last look can't check it.
   */
  const look = async () => {
    const found = await probe($, ctx, to)
    if ('failure' in found) return found
    logNewKeys($, found)
    const by = found.claim?.taken === true ? found.claim.by : undefined
    const beat = await readHeartbeat($, to)
    const opts = { ...(beat === undefined ? {} : { heartbeat: beat }), ...(by === undefined ? {} : { mine: by }) }
    const now = await $.clock.now()
    const live = liveness(found, to, now, { ...opts, left: true })
    const plain = live.waived === undefined ? live : liveness(found, to, now, opts)
    return { found, by, beat, live, plain }
  }
  let looked = await look()
  if ('failure' in looked) return notRun(`the machine probe failed (${looked.failure}), so whether ${to} is open elsewhere is unknown`)
  for (const [n, wait] of RETRY_MS.entries()) {
    if (looked.live.verdict !== 'unknown') break
    // A claude.exe that is starting or exiting reads as unknown for a moment: another look, with the
    // claim given back meanwhile and taken again by that probe.
    if (looked.by !== undefined) await release($, ctx.powershell, ctx.state, to, looked.by)
    $.ui.log(`whether ${to} is open elsewhere reads unknown (${looked.live.evidence.join('; ')}); looking again in ${wait / 1000} seconds (${n + 1} of ${RETRY_MS.length}).`)
    try {
      await $.clock.sleep(wait)
    } catch {
      // The plugin unloaded meanwhile: nothing more runs, and the claim is given back already.
      if (armed === value) armed = undefined
      return
    }
    // A turn that started meanwhile has taken it back, and said so.
    if (armed !== value) return
    // A resume or clear meanwhile, or a gate written meanwhile, stops it too.
    const movedNow = movedOn(value, await sessionId($))
    if (movedNow !== undefined) return movedAway($, value, movedNow)
    const gatedNow = await gateRefusal($, ctx.state, ctx.own, await $.clock.now())
    if (gatedNow !== undefined) return notRun(gateSaid(gatedNow))
    looked = await look()
    if ('failure' in looked) return notRun(`the machine probe failed (${looked.failure}), so whether ${to} is open elsewhere is unknown`)
  }
  const { found, by, beat, live, plain } = looked
  /**
   * The claim the launch names: the probe's, or a fresh launch's when a slot's claim must become a
   * window's (the launch takes it over: the same process holds both). Both are given back on a release.
   */
  let claim = by
  const free = async (): Promise<void> => {
    if (by !== undefined) await release($, ctx.powershell, ctx.state, to, by)
    if (claim !== undefined && claim !== by) await release($, ctx.powershell, ctx.state, to, claim)
  }
  const held = async (said: string): Promise<void> => {
    await free()
    await notRun(said)
  }
  if (live.verdict !== 'not-live') return held(`${to} is ${live.verdict === 'live' ? 'open' : 'possibly open'} elsewhere (${live.evidence.join('; ')})`)
  if (by === undefined) return held(`the claim lock on ${to} wasn't taken (${found.claim?.taken === false ? found.claim.why : 'none was asked for'})`)
  // This tab's claude wrapper, when the session carries its token: pickTransport uses it only when its
  // PowerShell is this claude.exe's own parent, on the probe that judged, and its last look reads every
  // config folder this switch reads (a wrapper of pane file version 2 reads its own alone).
  const tab = await tabOf($, ctx.state)
  const picked = pickTransport(found, ctx.own, to, beat?.folder, tab !== undefined && 'pane' in tab ? tab : undefined, ctx.configDirs.length)
  if ('refusal' in picked) return held(picked.refusal)
  // A left record waives L3 and L5 only where the last look checks the transcript against it: in place,
  // in the window, and in a tab whose claude wrapper is of pane file version 3. When the verdict rests on
  // it, this pane's slot runner (until slots v2) and an older wrapper pass the move to a new window,
  // saying why; the slot's claim becomes a launch's, which the launch takes over from it.
  const restsOnLeft = live.waived !== undefined && plain.verdict !== 'not-live'
  const tabNoLeft = restsOnLeft && picked.transport === 'pane' && tab !== undefined && 'pane' in tab ? paneNoLeft(tab.pane) : undefined
  const pick: Transport =
    restsOnLeft && picked.transport === 'slot'
      ? { transport: 'window', folder: picked.folder, fallback: SLOT_NO_LEFT }
      : tabNoLeft !== undefined && picked.transport === 'pane'
        ? { transport: 'window', folder: picked.folder }
        : picked
  if (picked.transport === 'slot' && by !== `slot:${picked.slot}`) return held("the claim lock doesn't name this pane's slot")
  if (picked.transport === 'slot' && pick.transport === 'window') claim = `launch:${crypto.randomUUID()}`
  /** The claim the ticket, the record or the window names. */
  const named = claim ?? by
  if ((pick.transport === 'window' || pick.transport === 'pane') && !named.startsWith('launch:')) return held("the claim lock doesn't name a launch")
  const left = pick.transport === 'slot' || (pick.transport === 'pane' && tab !== undefined && 'pane' in tab && paneNoLeft(tab.pane) !== undefined) ? undefined : live.waived
  const own: ProcessRef | undefined = found.session === null ? undefined : { pid: found.session.pid, created: found.session.created }
  // A tab with a token that a new window is used instead of: why, for the log.
  const tabPassed = pick.transport !== 'window' || tab === undefined ? undefined : 'why' in tab ? tab.why : (tabNoLeft ?? paneFallback(found, tab.pane) ?? paneReads(tab.pane, ctx.configDirs.length))
  // A move that ends this process (a slot, a tab, a window) ends its session crons with it (CronCreate,
  // /loop, ScheduleWakeup), and its /exit would stop to ask about one: it holds on one, or on crons
  // that can't be read (the shared reader, CronList, as self-exit's and self-restart's pre-check). A
  // durable cron doesn't end with it: it survives the exit, so it holds too, named apart, saying to
  // delete it.
  if (pick.transport !== 'in-place') {
    const jobs = await readCrons($)
    const ending = exitBlockers({ crons: typeof jobs === 'string' ? jobs : jobs.filter(job => job.durable !== true), agents: [] })
    const lasting = typeof jobs === 'string' ? [] : exitBlockers({ crons: jobs.filter(job => job.durable === true), agents: [] })
    const said = [...(ending.length > 0 ? [`this switch ends this process, and with it the session's crons: ${blockersText(ending)}`] : []), ...(lasting.length > 0 ? [blockersText(lasting)] : [])]
    if (said.length > 0) return held(said.join('; '))
  }
  // S11: the start folder (in place: the next conversation works in it) against its baseline; the named
  // worktrees, and the session's own folder when it is another tree, always.
  const git = await readGit($, { start: ctx.folder, trees: value.trees ?? [], cwd: ctx.cwd, folders: [ctx.cwd], dirty: pick.transport === 'in-place' })
  const safe = safePoint(found, git, await agentList($), await readBaseline($, ctx.own))
  if (safe.verdict !== 'clear') return held(`this session isn't at a safe point (${safe.reasons.join('; ')})`)
  if (armed !== value) return free()

  // Past the checks: the leaving row, then the ticket, then the transport.
  const at = await $.clock.now()
  const fallback = pick.transport === 'window' ? pick.fallback : undefined
  const ticket: Ticket = {
    at,
    from: ctx.own,
    by: named,
    transport: pick.transport,
    reason: value.reason,
    notes: value.notes,
    ...(value.resume === undefined ? {} : { resume: value.resume }),
    ...(fallback === undefined ? {} : { fallback }),
  }
  await tellModel($, leaving(ctx.own, value, at, fallback))
  await keepTicket($, to, ticket)
  /**
   * The ticket or the slot's record written over as withdrawn, only while it is this switch's: a ticket
   * naming this launch's claim, a slot's record resuming `to`. One a newer launch wrote is kept.
   */
  const withdraw = (record: string | undefined): Promise<void> => withdrawIfOurs($, record, raw => (pick.transport === 'pane' ? raw.by === named : raw.resume === to))
  /** Whether this switch wrote its exit record (right before its /exit): taken back with the rest. */
  let wroteLeft = false
  /**
   * Takes it all back: the lock, the ticket, the slot's record; says the switch didn't happen. After a
   * launch that failed (`again`), once more LAUNCH_RETRY_MS later: a run killed at its timeout may still
   * have been writing, and its own deadline check takes back what it placed late, but a write that
   * slipped past both is withdrawn here. Only a launch's claim is released again: a slot's names the
   * slot, which a later switch through it names too.
   */
  const undo = async (said: string, record?: string, again = false): Promise<void> => {
    if (armed === value) armed = undefined
    await withdraw(record)
    if (wroteLeft && own !== undefined) await withdrawLeft($, ctx.state, ctx.own, own)
    await free()
    await keepTicket($, to, null)
    if (again) {
      $.clock.after(LAUNCH_RETRY_MS, () => {
        void (async () => {
          await withdraw(record)
          if (named.startsWith('launch:')) await release($, ctx.powershell, ctx.state, to, named)
        })()
      })
    }
    await refuse($, `Switch didn't run: ${said}.`, `The switch to ${to} didn't happen after all: ${said}. This session is still its own conversation, and goes on.`)
  }

  if (pick.transport === 'in-place') {
    // The last look, as the window and the slot take theirs: no other process holds `to` now (L1, L2,
    // read again), its transcript is as its left record says when one waived L3 and L5, and the claim
    // still names this switch. Right before the command.
    const still = await claimStill($, ctx, to, by, left)
    if (still !== undefined) return undo(still)
    if (armed !== value) return undo('a new turn started')
    // S10w once more, right before the command: a wake-up set in the turn that queued the switch is
    // marked by self-wake as that turn ends, which nothing orders before the first read.
    const wakeNow = wakeHold(await readWake($, ctx.state, ctx.own))
    if (wakeNow !== undefined) return undo(wakeNow)
    await noteRecent($, ctx.own)
    $.ui.log(`Switching in place to ${to}: ${value.reason}`)
    // Taken back right before the command, after the last wait: a turn that starts up to here stops it.
    if (armed !== value) return undo('a new turn started')
    armed = undefined
    try {
      await $.command.run({ command: 'resume', args: to })
    } catch (err) {
      return undo(`/resume didn't run: ${why(err)}`)
    }
    const after = await sessionId($)
    if (after !== to) {
      $.ui.toast(`Switch didn't take: this session is still ${after === undefined ? 'its own conversation' : after.slice(0, 8)}. Its ticket waits 15 minutes in case the resume completes.`)
      await tellModel(
        $,
        `The switch ran /resume ${to}, but this session is still conversation ${after ?? ctx.own} (a dialog may be open, or it was answered no), so it did not switch. The ticket is kept: if the resume completes within 15 minutes, the resumed conversation gets its arrival note. Otherwise nothing changed, and the claim lock is released when the ticket runs out.`,
      )
      return
    }
    $.ui.toast(`Switched in place to ${to}.`)
    // The classic SessionStart delivers the arrival; if it hasn't by then, this does.
    $.clock.after(ARRIVAL_FALLBACK_MS, () => void arrive($, to))
    return
  }

  // The launch, through the shared launcher, in one run: this pane's slot's record, this tab's ticket, or
  // a new window running claude-launch.ps1; each waits for this process to exit, then takes its last look.
  if (own === undefined) return undo("this session's own claude.exe wasn't found above the probe")
  const base = {
    powershell: ctx.powershell,
    kind: 'resume',
    id: to,
    folder: pick.folder,
    claim: named,
    configDirs: ctx.configDirs,
    stateDir: ctx.state,
    waitForExit: own,
    tool: 'self-switch',
    deadline: (await $.clock.now()) + LAUNCH_DEADLINE_MS,
  } as const
  let record: string | undefined
  if (pick.transport === 'slot') {
    record = slotRecordPath(ctx.state, pick.slot)
    const failed = await placeLaunch($, { ...base, where: { slot: pick.slot } }, pick.folder)
    if (failed !== undefined) return undo(`the slot's record wasn't written (${failed.said})`, record, failed.unclean)
  } else if (pick.transport === 'pane') {
    // The ticket for this tab's claude wrapper, written whole and moved into place; taken back, it is
    // overwritten as withdrawn (undo), which the wrapper says and resumes nothing. It names the claim
    // the probe took: the wrapper resumes only while the lock still names it.
    record = paneTicketPath(ctx.state, pick.token)
    const failed = await placeLaunch($, { ...base, where: { pane: { token: pick.token } }, now: await $.clock.now(), ...(left === undefined ? {} : { left }) }, pick.folder)
    if (failed !== undefined) return undo(`this tab's ticket wasn't written (${failed.said})`, record, failed.unclean)
  } else {
    const failed = await placeLaunch($, { ...base, where: { window: true }, ...(left === undefined ? {} : { left }) }, pick.folder)
    if (failed !== undefined) return undo(`no window opened (${failed.said})`, undefined, failed.unclean)
  }
  // Right before the exit: a turn that started meanwhile, a subagent, or a wake-up marked since the
  // first read (S10w again: one set in the same turn as the switch is marked as that turn ends, which
  // nothing orders before the first read) stops it; the released claim then turns away the window or
  // the slot.
  const late = armed !== value ? 'a new turn started' : (blocked(await busyAgents($)) ?? wakeHold(await readWake($, ctx.state, ctx.own)))
  if (late !== undefined) return undo(late, record)
  // The left record of this conversation, how: exit, written by the leaving side right before its
  // /exit: the conversation switched back to soon after reads not live once this process has gone.
  // Taken back (undo) if the exit then doesn't run.
  await writeLeft($, ctx.own, 'exit', own)
  wroteLeft = true
  await noteRecent($, ctx.own)
  const where =
    pick.transport === 'slot'
      ? "this pane's slot resumes it here"
      : pick.transport === 'pane'
        ? 'this tab resumes it here'
        : fallback === undefined
          ? 'a new window resumes it'
          : `a new window resumes it, not this pane's slot (${fallback})`
  // Taken back right before the command, after the last wait: a turn that starts up to here stops it.
  if (armed !== value) return undo('a new turn started', record)
  armed = undefined
  $.ui.log(`Switching to ${to}: ${value.reason}`)
  if (fallback !== undefined) $.ui.log(`this pane's slot runner isn't used: ${fallback}. A new window resumes ${to}.`)
  if (tabPassed !== undefined) $.ui.log(`this tab's claude wrapper isn't used: ${oneLine(tabPassed, 300)}. A new window resumes ${to}.`)
  $.ui.toast(`Switching to ${to}: this session exits, and ${where} once this process has gone.`)
  try {
    await $.command.run({ command: 'exit' })
  } catch (err) {
    return undo(`the exit didn't run: ${why(err)}`, record)
  }
  // The exit ran and this module is still here: the session may stay open (a dialog answered no). Its
  // exit record is taken back at the next turn's end, if it is still this exit's: a turn that ends means
  // the session went on, and a typed /exit later must not pass for this one.
  exitLeft = { state: ctx.state, id: ctx.own, leaving: own }
  // An exit that took ends this module with the session, and this never fires.
  $.clock.after(CHECK_MS, () => {
    const waits =
      pick.transport === 'slot'
        ? 'The slot honours its record for 2 minutes'
        : pick.transport === 'pane'
          ? "This tab's claude wrapper honours its ticket for 2 minutes"
          : `The new window waits up to ${WAIT_SECONDS / 60} minutes for this session to exit`
    $.ui.toast(`The exit ran, but the session is still open. ${waits}.`)
    void tellModel($, `The switch's exit ran, but this session is still open (a dialog may have been answered no). ${waits}, then gives up; the claim on ${to} is released when its ticket runs out, 15 minutes after the switch.`)
  })
}

/**
 * switchNow, from its timer: a step that throws ends the switch, said in the log, never left as an
 * unhandled rejection (a module unloaded mid-switch refuses every call after).
 */
async function runSwitch($: EngineInterface, value: Queued): Promise<void> {
  try {
    await switchNow($, value)
  } catch (err) {
    if (armed === value) armed = undefined
    $.ui.log(`the switch to ${value.to} stopped: ${why(err)}`)
  }
}

export const register: Register = (on, options) => {
  configureUpdateCheck('self-switch', options)
  const dirs = options.configDirs
  settings = {
    requireCoordinator: options.requireCoordinator === 'on',
    configDirs: Array.isArray(dirs) ? dirs : typeof dirs === 'string' && dirs.trim() !== '' ? [dirs.trim()] : [],
    heavySlotRoot: typeof options.heavySlotRoot === 'string' ? options.heavySlotRoot.trim() : '',
  }

  // First, so it is outermost on this plugin's tools: it sees each answer, and adds the update
  // notice when one is due. It never waits on the check; see update-check.ts.
  on('tool.call', { tool: /^mcp__self-switch__/ }, async ($, e, next) => withUpdateNotice($, e, await next(e))).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    isTerminal = e.isInteractive && e.surface === 'terminal'
    // The first start's folder only: a reload starts the plugin again from wherever the session is now.
    const { value: first } = await $.state.get(folderKey)
    if (typeof first !== 'string' || first === '') await $.state.set(folderKey, e.cwd)
    startFolder = typeof first === 'string' && first !== '' ? first : e.cwd
    // Unknown, or known only from an earlier start: a new session in the same load (a /clear, a
    // resume) starts with its own id. One a SessionStart named stands: `$.session.id()` may lag it.
    if (current === undefined || !currentFromEvent) {
      const own = await sessionId($)
      if (own !== undefined && SESSION_ID.test(own)) {
        current = own
        currentAt = await $.clock.now()
      }
    }
    await $.tool.register({
      name: 'switch_after_turn',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'The id of the conversation to switch to: a session id, as claude --resume takes it.' },
          reason: { type: 'string', description: 'Why this terminal switches to that conversation. Recorded in both conversations.' },
          notes: { type: 'string', description: "Where this conversation's notes are, written before the switch: a path, a PR, a memory file. Recorded in both conversations." },
          trees: {
            type: 'array',
            items: { type: 'string' },
            description:
              "The git worktrees you worked in, absolute paths, each a worktree of the repository this session started in: each must have no uncommitted changes before the switch. The worktree this session works in is checked anyway, named or not, and the folder it started in for an in-place switch, against the changes it already had when this conversation started.",
          },
          resume: {
            type: 'string',
            description: 'The message that starts the resumed conversation\'s first turn: what to check or do next there. Leave it out only when the next step waits on someone else.',
          },
        },
        required: ['to', 'reason', 'notes'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    loadUpdateCheck($)
    startBeat($)
    return started
  })

  // The process that holds a conversation a switch moved here: the arrival, once. On a resume, first
  // the heartbeat, of the conversation the event names: `$.session.id()` may still read the one that
  // left, and its `$.state` may still be in place (the start folder comes from the module).
  on('classic.SessionStart', async ($, e, next) => {
    const done = await next(e)
    // A resume or a clear to another conversation before an armed switch has run takes it back: the
    // switch was that conversation's, not this one's.
    if (e.agent_id === undefined && armed !== undefined && armed.from !== undefined && e.session_id !== armed.from) {
      armed = undefined
      $.ui.status(undefined)
      $.ui.toast('Switch cancelled: this session became another conversation before it ran.')
    }
    const id = e.session_id
    // Only the main loop's startup, resume and clear move this process to a conversation: a fork's
    // SessionStart (the /fork background copy, a conversation moved to the background) leaves the
    // foreground where it was, and a source this plugin doesn't know moves nothing.
    if (e.agent_id !== undefined || (e.source !== 'resume' && e.source !== 'startup' && e.source !== 'clear')) return done
    if (typeof id !== 'string' || !SESSION_ID.test(id)) return done
    // The conversation this process held until now, and the one it holds from here, by the event's id.
    const previous = current
    current = id
    currentFromEvent = true
    currentAt = await $.clock.now()
    // In place (a /resume or /clear, this plugin's switch or one the person typed): this process left
    // the conversation it held. The arriving side writes its left record, keyed by this event's id,
    // LEFT_SETTLE_MS after it, so the engine's last write to the conversation left is inside the stat.
    if ((e.source === 'resume' || e.source === 'clear') && previous !== undefined && previous !== id) {
      const left = previous
      $.clock.after(LEFT_SETTLE_MS, () => void writeLeft($, left, 'in-place'))
    }
    // The heartbeat now; the tick's pruning waits for the next beat, after the arrival took its ticket.
    if (e.source === 'resume') startBeat($, id)
    // A clear starts a new conversation with nothing to deliver: its baseline only.
    if (e.source !== 'clear') $.clock.after(SETTLE_MS, () => void arrive($, id))
    // S11's baseline, by the event's id: a startup fingerprints the start folder's dirty state; a /clear
    // carries the baseline of the conversation it ends (the folder holds that one's changes by now: a
    // fresh fingerprint would let them through), or takes none. A resume takes none, nor a fork (its
    // source is `fork`, filtered out above), for the same reason: without one, the dirt holds.
    const folder = startFolder ?? (typeof e.cwd === 'string' && isSafeFolder(e.cwd) ? e.cwd : undefined)
    if (folder !== undefined && e.source === 'startup') $.clock.after(SETTLE_MS, () => void keepBaseline($, id, folder))
    if (folder !== undefined && e.source === 'clear') await carryBaseline($, previous, id, folder)
    return done
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: SUBAGENT }
    const gated = await gateAtCall($)
    if (gated !== undefined) return { deny: gated === COORDINATED ? COORDINATED : `Not queued: ${gated}.` }
    const input = e as { to?: unknown; reason?: unknown; notes?: unknown; resume?: unknown; trees?: unknown }
    const to = typeof input.to === 'string' ? input.to.trim() : ''
    if (!SESSION_ID.test(to)) return { deny: '`to` must be the id of the conversation to switch to: a session id, the lowercase UUID claude --resume takes.' }
    const reason = text(input.reason)
    if (reason === undefined) return { deny: 'Say why this terminal switches (`reason`); it is recorded in both conversations.' }
    const notes = text(input.notes)
    if (notes === undefined) return { deny: 'Say where your notes are (`notes`): write them first. A switch leaves this conversation, and the notes are how it is picked up again.' }
    if (!isTerminal) {
      return { deny: 'A switch moves a terminal to another conversation, for a session run in a terminal with a person at its prompt; this one is not (a -p run, an SDK host, or an app).' }
    }
    const own = await sessionId($)
    if (own === undefined || !SESSION_ID.test(own)) {
      return { deny: "Not queued: this session's id can't be read, so the switch can't be tied to this conversation. Try again; if it persists, switch by hand." }
    }
    if (own === to) return { deny: `This session is already conversation ${to}.` }
    const torn = await idsDisagree($, own)
    if (torn !== undefined) return { deny: `Not queued: ${torn}. Try again in a moment.` }
    const busy = await busyAgents($)
    const stop = blocked(busy)
    if (stop !== undefined) {
      const then = busy !== undefined && agentsWayOut(busy) !== undefined ? 'Once they have ended, call again.' : 'Wait for them to report, or stop them, then call again.'
      return { deny: `Not queued: ${stop}. ${then}` }
    }
    // S10w at the call: a pending wake-up, or one whose state can't be read, holds the switch.
    const where = await machine($)
    if (!('refusal' in where)) {
      const wake = wakeHold(await readWake($, where.state, own))
      if (wake !== undefined) return { deny: `Not queued: ${wake}.` }
    }
    const lately = await lastSwitch($, own)
    if (lately !== undefined) return { deny: `Not queued: ${await loop($, lately)}.` }
    const resume = text(input.resume)
    // The named trees: worktrees of this session's repository, checked now and again at the run.
    let trees: string[] = []
    if (input.trees !== undefined) {
      if (!Array.isArray(input.trees) || input.trees.some(tree => typeof tree !== 'string')) return { deny: '`trees` must be a list of absolute paths: the git worktrees you worked in.' }
      const start = await startFolderOf($)
      if (start === undefined) return { deny: "Not queued: the folder this session started in isn't known, so the trees named can't be checked against its repository." }
      const checked = await checkTrees($, start, input.trees as string[])
      if ('refusal' in checked) return { deny: `Not queued: ${checked.refusal}. Name only git worktrees of the repository this session started in.` }
      trees = [...checked.trees]
    }
    const asked = { to, reason, notes, from: own, ...(trees.length > 0 ? { trees } : {}) }
    await $.state.set(queued, resume === undefined ? asked : { ...asked, resume })
    $.ui.status('switch queued for when this turn ends')
    return {
      result: `Queued. Once this turn ends, this terminal switches to conversation ${to}: this conversation ends here, untouched, and ${to} resumes in this process, in this pane's slot, in this tab (when Claude Code was started through the claude wrapper), or in a new window, whichever applies. First the plugin checks that ${to} is open nowhere on this machine and that nothing runs under this session; if anything is, nothing moves and you are told on your next turn. If this pane runs a slot that can't be used, the switch says why, in the leaving row, a toast and the arrival, and a new window opens. A wake-up set with wake_after holds the switch until it is cancelled or has fired, and a session cron (CronCreate, /loop, ScheduleWakeup) holds one that ends this process until it is deleted; other pending wake-ups are dropped by the switch: set them again in ${to} if they are still needed. Reason: ${quoted(reason)}. Notes: ${quoted(notes)}.`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-switch: queuing the switch failed; nothing is queued.' }))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    // A switch's /exit ran, and a turn has ended since: the session stayed open. Its exit record is
    // taken back, if it is still that exit's, before anything this turn queued runs.
    const left = exitLeft
    exitLeft = undefined
    if (left !== undefined) await withdrawLeft($, left.state, left.id, left.leaving)
    void heartbeat($)
    const { value } = await $.state.get(queued)
    if (!value) return done
    await $.state.set(queued, null)
    if (e.isAborted || e.reason !== 'answer') {
      $.ui.status(undefined)
      $.ui.toast("Switch cancelled: the turn didn't finish.")
      return done
    }
    armed = value
    $.clock.after(SETTLE_MS, () => void runSwitch($, value))
    return done
  })

  // A message that starts a turn before the switch's final command has started takes it back.
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (e.agentId !== undefined) return started
    void heartbeat($)
    if (armed === undefined) return started
    const value = armed
    armed = undefined
    $.ui.status(undefined)
    $.ui.toast('Switch cancelled: a new turn started before it ran.')
    void cancelled($, value)
    return started
  })
}
