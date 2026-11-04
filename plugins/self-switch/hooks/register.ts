// A session switches this terminal to another conversation: once the current turn ends, this
// conversation ends here, its context untouched, and conversation `to` is resumed in its place. For
// the person's own use, where no coordinator runs: in coordinated mode (the coordinator's gate file
// for this conversation says `coordinated: true`) it refuses, since the coordinator runs switches
// there. The model calls switch_after_turn with `to`, `reason` and `notes`, all required; a command
// can't run while the turn the model is in waits on it, so the call is queued and the switch runs
// once the turn has ended with an answer. An interrupted turn, or a new one, cancels it. Only the
// main conversation switches this way, never a subagent, and only one run in a terminal.
//
// Before anything moves, one probe of the machine (machine.ts) reads every running claude.exe, the
// engine's session registry, the transcripts' project folders and the claim locks, and takes the
// claim lock on `to` in the same run. The switch goes ahead only when `to` is NOT LIVE (liveness) and
// this session is at a safe point (safePoint: no subagent, nothing busy under its claude.exe, git at
// rest, and for an in-place switch a clean checkout); anything that can't be read refuses, saying
// what. Then the leaving row goes into this conversation, the ticket into the plugin's store, keyed
// by `to`, and one transport runs (pickTransport):
// - in place, `/resume <to>`, when both conversations' transcripts sit in one project folder; the
//   session id must then read `to`, or the switch didn't take and is said not to have;
// - the slot, when this claude.exe runs in a pane's claude-slot.ps1 of the shipped hash: a record for
//   the slot, then `/exit`; the slot runner checks it all again and resumes `to` in the same pane;
// - a new window otherwise: the launcher, which waits for this process to exit, checks again, and
//   resumes `to`; then `/exit`.
// No transport passes a permission flag: the resumed conversation starts in the mode a new session would.
//
// The process that resumes `to` (this one, in place; the slot's or the window's otherwise) finds the
// ticket at the classic SessionStart for `to`, at most 15 minutes old: it removes it, releases the
// claim lock, appends the arrival row, and submits `resume` as the first prompt, in the plugin's frame.
//
// Every conversation this plugin runs in keeps a heartbeat (`alive:<id>`: when, its start folder and
// project) at each turn's start and end and every 2 minutes; liveness reads it (L5), and a switch to a
// conversation of another project reads its folder from it. Heartbeats 30 days old are dropped.
import type { EngineInterface, Register, Timer } from 'claude-code'
import type { Heartbeat, Queued, Ticket } from '../types'
import type { AgentLike, Probe } from './machine'
import {
  BUSY_AGENTS,
  gatePath,
  isSafeFolder,
  LAUNCHED,
  launcherScript,
  liveness,
  pickTransport,
  parseProbe,
  powershellArgv,
  powershellPath,
  probeScript,
  projectName,
  readGate,
  readGit,
  RELEASED,
  releaseScript,
  SESSION_ID,
  safePoint,
  slotRecordPath,
  stateFolder,
  SYSTEM_ROOT,
  WAIT_SECONDS,
} from './machine'
import { configureUpdateCheck, loadUpdateCheck, withUpdateNotice } from './update-check'

const TOOL = 'mcp__self-switch__switch_after_turn'
const queued = { plugin: 'self-switch', key: 'queued' } as const
const folderKey = { plugin: 'self-switch', key: 'folder' } as const

/** The plugin's store key for switches under way, by the conversation each resumes. */
const SWITCHES = 'switches'
/** The plugin's store key for when each conversation last switched away or arrived, by session id. */
const RECENT = 'recentSwitches'
/** The plugin's store keys for heartbeats: `alive:<session id>`. */
const ALIVE = 'alive:'

/** A beat after the turn's end, so the turn is no longer running when the switch starts. */
const SETTLE_MS = 500
/** How long after the exit command to look whether the session is still here. */
const CHECK_MS = 5000
/** How long the probe may take. */
const PROBE_MS = 60_000
/** How long the launcher may take to open the window. */
const LAUNCH_MS = 30_000
/** How long releasing a claim lock may take. */
const RELEASE_MS = 15_000
/** A ticket older than this is dropped, not delivered: the switch failed, and it came back later by hand. */
const TICKET_MS = 15 * 60 * 1000
/** A second switch sooner than this after the last switch or arrival is refused: no switch loop. */
const LOOP_MS = 2 * 60 * 1000
/** How often the heartbeat is written between turns. */
const BEAT_MS = 2 * 60 * 1000
/** Heartbeats older than this are dropped. */
const KEEP_BEATS_MS = 30 * 24 * 60 * 60 * 1000
/** How often old heartbeats are looked for. */
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000
/** After an in-place resume took, the switch delivers the arrival itself if the SessionStart hasn't by then. */
const ARRIVAL_FALLBACK_MS = 5000
/** The most switches under way the store keeps. */
const MAX_KEPT = 50

const DESCRIPTION = [
  "Switches this terminal to another conversation once the current turn ends: this conversation ends here, its context untouched, and conversation `to` (a session id, as claude --resume takes) is resumed in its place: in this same process when both live in one project folder, else in this pane's slot (a Windows Terminal pane running self-switch's claude-slot.ps1), else in a new window.",
  "For the person's own use: call it only when they ask you to switch to another conversation, at a finished break (never mid-merge, mid-push or mid-task), with your notes written first. Cancel wake-ups and Monitor tasks first: an in-place switch carries this process's timers into the next conversation.",
  'Where the coordinator runs, switches come from it: this tool refuses there.',
  '`reason` and `notes` (where your notes are) are required; both are recorded in this conversation and in the one resumed. `resume` is the message that starts the resumed conversation\'s first turn.',
  'Before anything runs it checks, and refuses saying why: when `to` is open, or may be open, anywhere on this machine; when anything still runs under this session (subagents, background Bash or Monitor jobs, git, builds, dev servers, a heavy slot); when an in-place switch would leave uncommitted changes in the checkout both share; within 2 minutes of a switch. Windows only, in a terminal.',
  'End the turn after calling it; the switch starts once your answer is shown.',
].join(' ')

const SUBAGENT =
  "A subagent can't switch the session to another conversation. Finish your piece and return its result, saying a switch is wanted and to which conversation: the main session can switch."

const COORDINATED = 'The coordinator runs switches in this session: ask the merger or Mo for a wrap-up.'
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
/** When old heartbeats were last looked for. */
let prunedAt = Number.NEGATIVE_INFINITY
/** The conversations whose arrival is being delivered now: one delivery each. */
const arriving = new Set<string>()

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

/** One line, at most 300 characters: a process's output can run over many. */
const brief = (said: string): string => {
  const line = said.replace(/\s*\n\s*/g, ' ').trim()
  return line.length > 300 ? `${line.slice(0, 299)}…` : line
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

/** The session's id, or undefined when it can't be read. */
async function sessionId($: EngineInterface): Promise<string | undefined> {
  try {
    return await $.session.id()
  } catch {
    return undefined
  }
}

/** The agents still to report, by their task's description; undefined when the list can't be read. */
async function busyAgents($: EngineInterface): Promise<string[] | undefined> {
  try {
    return (await $.agent.list()).filter(a => BUSY_AGENTS.includes(a.status)).map(a => (a.description.trim() === '' ? a.type : a.description))
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

/** Why a switch can't go ahead with these agents, or undefined when none is still to report. */
function blocked(busy: string[] | undefined): string | undefined {
  if (busy === undefined) return "the session's subagents can't be read, so whether any is still running is unknown"
  if (busy.length === 0) return undefined
  return `${busy.length === 1 ? 'a subagent is' : `${busy.length} subagents are`} still running (${busy.join('; ')}), and ${busy.length === 1 ? 'its work' : 'their work'} would be left behind`
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
  const { value: folder } = await $.state.get(folderKey)
  if (!isSafeFolder(folder)) return { refusal: "the folder this session started in isn't known, or isn't an absolute folder without quotes" }
  let cwd: string
  try {
    cwd = await $.session.cwd()
  } catch (err) {
    return { refusal: `this session's folder can't be read: ${why(err)}` }
  }
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
  const heavy = settings.heavySlotRoot
  if (heavy !== '' && heavy !== undefined && !isSafeFolder(heavy)) return { refusal: `the heavySlotRoot setting reads ${JSON.stringify(heavy)}, not an absolute folder without quotes` }
  return { ...found, own, cwd, folder, configDirs, ...(isSafeFolder(heavy) ? { heavySlotRoot: heavy.replace(/\\+$/, '') } : {}) }
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
  const { at, from, by, transport, reason, notes, resume } = value
  if (typeof at !== 'number' || typeof from !== 'string' || !SESSION_ID.test(from) || typeof by !== 'string') return undefined
  if (transport !== 'in-place' && transport !== 'slot' && transport !== 'window') return undefined
  if (typeof reason !== 'string' || typeof notes !== 'string') return undefined
  return { at, from, by, transport, reason, notes, ...(typeof resume === 'string' ? { resume } : {}) }
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
    const run = await $.process.run(powershellArgv(powershell, releaseScript({ stateDir: state, id, by })), { timeoutMs: RELEASE_MS })
    if (run.exitCode === 0 && RELEASED.test(run.stdout)) return
    $.ui.log(`self-switch: the claim lock on ${id} wasn't released (exit ${run.exitCode}); it goes stale 15 minutes after its creator exits.`)
  } catch (err) {
    $.ui.log(`self-switch: the claim lock on ${id} wasn't released (${why(err)}); it goes stale 15 minutes after its creator exits.`)
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

/** This conversation's heartbeat: when, the folder its process started in, and that folder's project. */
async function heartbeat($: EngineInterface): Promise<void> {
  try {
    const id = await sessionId($)
    if (id === undefined || !SESSION_ID.test(id)) return
    const { value: folder } = await $.state.get(folderKey)
    if (typeof folder !== 'string' || folder === '') return
    const value: Heartbeat = { at: await $.clock.now(), folder, project: projectName(folder) ?? '' }
    await $.store.set(`${ALIVE}${id}`, value)
  } catch {
    // A heartbeat missed is one live sign fewer; the next one comes in 2 minutes.
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
    if (!key.startsWith(ALIVE)) continue
    const value = await $.store.get(key)
    const at = isRecord(value) ? value.at : undefined
    if (!SESSION_ID.test(key.slice(ALIVE.length)) || typeof at !== 'number' || now - at > KEEP_BEATS_MS) await $.store.delete(key)
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

/** The probe, with the claim on `to` taken in the same run; or why it gave no answer. */
async function probe($: EngineInterface, ctx: Context, to: string): Promise<Probe | { failure: string }> {
  try {
    const script = probeScript({ ids: [ctx.own, to], take: to, configDirs: ctx.configDirs, stateDir: ctx.state, ...(ctx.heavySlotRoot === undefined ? {} : { heavySlotRoot: ctx.heavySlotRoot }) })
    const run = await $.process.run(powershellArgv(ctx.powershell, script), { cwd: ctx.folder, timeoutMs: PROBE_MS })
    if (run.exitCode !== 0) return { failure: `it exited ${run.exitCode}${brief(run.stderr) === '' ? '' : `: ${brief(run.stderr)}`}` }
    const parsed = parseProbe(run.stdout)
    return 'error' in parsed ? { failure: parsed.error } : parsed
  } catch (err) {
    return { failure: `it didn't run: ${why(err)}` }
  }
}

/** The row the model reads in this conversation, written before the transport: where it went. */
const leaving = (own: string, value: Queued, at: number): string =>
  `This session was switched away at ${stamp(at)} (switch_after_turn), to conversation ${value.to}: ${value.reason} Its notes: ${value.notes} Its context is untouched: resume it (claude --resume ${own}) to pick up here.`

/** The row the model reads in the resumed conversation. */
const arrival = (ticket: Ticket, at: number): string =>
  `This conversation was resumed at ${stamp(at)} by a switch (switch_after_turn) from session ${ticket.from.slice(0, 8)}, which said why: ${ticket.reason} Its notes: ${ticket.notes} Your context is as you left it; since then the repository, PRs and other sessions may have moved. Before acting, check where things stand (git status, fetch and rebase, your open PRs, your notes). This grants no new permission.`

async function sendResume($: EngineInterface, resume: string): Promise<void> {
  try {
    const sent = await $.prompt.submit({ text: `Switched here. Resume: ${resume}` })
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
    if (!('refusal' in where)) await release($, where.powershell, where.state, id, found.by)
    if (now - found.at > TICKET_MS || now < found.at) {
      $.ui.toast("A switch's arrival note was dropped: the conversation came back more than 15 minutes after the switch.")
      return
    }
    await noteRecent($, id)
    await tellModel($, arrival(found, now))
    $.ui.toast(`Switched here from session ${found.from.slice(0, 8)}: ${found.reason}`)
    const resume = found.resume
    // Later, not awaited: a prompt submitted from the start's hook would wait on that hook.
    if (resume !== undefined) $.clock.after(SETTLE_MS, () => void sendResume($, resume))
  } catch {
    // The resumed conversation goes on without the note; the person sees it there.
  } finally {
    arriving.delete(id)
  }
}

/** Runs the switch, step by step; says so at each step that didn't go ahead. */
async function switchNow($: EngineInterface, value: Queued): Promise<void> {
  if (armed !== value) return
  $.ui.status(undefined)
  const { to } = value
  const notRun = async (said: string): Promise<void> => {
    if (armed === value) armed = undefined
    await refuse($, `Switch didn't run: ${said}.`, `The switch to ${to} you queued didn't run: ${said}. This conversation goes on.`)
  }
  const ctx = await context($)
  if ('refusal' in ctx) return notRun(ctx.refusal)
  const gated = await gateRefusal($, ctx.state, ctx.own, await $.clock.now())
  if (gated !== undefined) return notRun(gated === COORDINATED ? 'the coordinator runs switches in this session; ask the merger or Mo for a wrap-up' : gated)
  if (ctx.own === to) return notRun(`this session is already conversation ${to}`)
  const stop = blocked(await busyAgents($))
  if (stop !== undefined) return notRun(stop)
  const lately = await lastSwitch($, ctx.own)
  if (lately !== undefined) return notRun(await loop($, lately))
  // A turn that started while the checks above ran has taken it back, and said so.
  if (armed !== value) return
  await pruneTickets($, await $.clock.now())

  const found = await probe($, ctx, to)
  if ('failure' in found) return notRun(`the machine probe failed (${found.failure}), so whether ${to} is open elsewhere is unknown`)
  const by = found.claim?.taken === true ? found.claim.by : undefined
  const free = async (): Promise<void> => {
    if (by !== undefined) await release($, ctx.powershell, ctx.state, to, by)
  }
  const held = async (said: string): Promise<void> => {
    await free()
    await notRun(said)
  }
  const beat = await readHeartbeat($, to)
  const live = liveness(found, to, await $.clock.now(), { ...(beat === undefined ? {} : { heartbeat: beat }), ...(by === undefined ? {} : { mine: by }) })
  if (live.verdict !== 'not-live') return held(`${to} is ${live.verdict === 'live' ? 'open' : 'possibly open'} elsewhere (${live.evidence.join('; ')})`)
  if (by === undefined) return held(`the claim lock on ${to} wasn't taken (${found.claim?.taken === false ? found.claim.why : 'none was asked for'})`)
  const pick = pickTransport(found, ctx.own, to, beat?.folder)
  if ('refusal' in pick) return held(pick.refusal)
  if (pick.transport === 'slot' && by !== `slot:${pick.slot}`) return held("the claim lock doesn't name this pane's slot")
  if (pick.transport === 'window' && !by.startsWith('launch:')) return held("the claim lock doesn't name a launch")
  const git = await readGit($, { cwd: ctx.cwd, folders: [ctx.folder], dirty: pick.transport === 'in-place' })
  const safe = safePoint(found, git, await agentList($))
  if (safe.verdict !== 'clear') return held(`this session isn't at a safe point (${safe.reasons.join('; ')})`)
  if (armed !== value) return free()

  // Past the checks: the leaving row, then the ticket, then the transport.
  const at = await $.clock.now()
  const ticket: Ticket = { at, from: ctx.own, by, transport: pick.transport, reason: value.reason, notes: value.notes, ...(value.resume === undefined ? {} : { resume: value.resume }) }
  await tellModel($, leaving(ctx.own, value, at))
  await keepTicket($, to, ticket)
  /** Takes it all back: the lock, the ticket, the slot's record; says the switch didn't happen. */
  const undo = async (said: string, record?: string): Promise<void> => {
    if (armed === value) armed = undefined
    if (record !== undefined) {
      try {
        await $.fs.write(record, JSON.stringify({ v: 1, cancelled: true }))
      } catch {
        // A record left there is honoured only within 120 seconds, and only with the claim, which is released now.
      }
    }
    await free()
    await keepTicket($, to, null)
    await refuse($, `Switch didn't run: ${said}.`, `The switch to ${to} didn't happen after all: ${said}. This session is still its own conversation, and goes on.`)
  }

  if (pick.transport === 'in-place') {
    if (armed !== value) return undo('a new turn started')
    armed = undefined
    await noteRecent($, ctx.own)
    $.ui.log(`Switching in place to ${to}: ${value.reason}`)
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

  let record: string | undefined
  if (pick.transport === 'slot') {
    record = slotRecordPath(ctx.state, pick.slot)
    try {
      await $.fs.write(record, JSON.stringify({ v: 1, resume: to, folder: pick.folder, at: await $.clock.now(), configDirs: ctx.configDirs }))
    } catch (err) {
      return undo(`the slot's record wasn't written: ${why(err)}`, record)
    }
  } else {
    let opened: string | undefined
    try {
      const script = launcherScript(to, { folder: pick.folder, claim: by, configDirs: ctx.configDirs, stateDir: ctx.state })
      const run = await $.process.run(powershellArgv(ctx.powershell, script), { cwd: pick.folder, timeoutMs: LAUNCH_MS })
      if (run.exitCode !== 0 || !LAUNCHED.test(run.stdout)) {
        const said = brief(`${run.stdout} ${run.stderr}`)
        opened = `the launcher exited ${run.exitCode}${said === '' ? '' : `: ${said}`}`
      }
    } catch (err) {
      opened = `the launcher didn't run: ${why(err)}`
    }
    if (opened !== undefined) return undo(`no window opened (${opened})`)
  }
  // Right before the exit: a turn that started meanwhile, or a subagent, stops it; the released claim
  // then turns away the window or the slot.
  const late = armed !== value ? 'a new turn started' : blocked(await busyAgents($))
  if (late !== undefined) return undo(late, record)
  armed = undefined
  await noteRecent($, ctx.own)
  const where = pick.transport === 'slot' ? "this pane's slot resumes it here" : 'a new window resumes it'
  $.ui.log(`Switching to ${to}: ${value.reason}`)
  $.ui.toast(`Switching to ${to}: this session exits, and ${where} once this process has gone.`)
  try {
    await $.command.run({ command: 'exit' })
  } catch (err) {
    return undo(`the exit didn't run: ${why(err)}`, record)
  }
  // An exit that took ends this module with the session, and this never fires.
  $.clock.after(CHECK_MS, () => {
    const waits = pick.transport === 'slot' ? 'The slot honours its record for 2 minutes' : `The new window waits up to ${WAIT_SECONDS / 60} minutes for this session to exit`
    $.ui.toast(`The exit ran, but the session is still open. ${waits}.`)
    void tellModel($, `The switch's exit ran, but this session is still open (a dialog may have been answered no). ${waits}, then gives up; the claim on ${to} is released when its ticket runs out, 15 minutes after the switch.`)
  })
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
    await $.tool.register({
      name: 'switch_after_turn',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'The id of the conversation to switch to: a session id, as claude --resume takes it.' },
          reason: { type: 'string', description: 'Why this terminal switches to that conversation. Recorded in both conversations.' },
          notes: { type: 'string', description: "Where this conversation's notes are, written before the switch: a path, a PR, a memory file. Recorded in both conversations." },
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
    beat?.cancel()
    beat = $.clock.every(BEAT_MS, () => void tick($))
    void tick($)
    return started
  })

  // The process that holds a conversation a switch moved here: the arrival, once.
  on('classic.SessionStart', async ($, e, next) => {
    const done = await next(e)
    if (e.agent_id !== undefined || (e.source !== 'resume' && e.source !== 'startup')) return done
    const id = e.session_id
    if (typeof id === 'string' && SESSION_ID.test(id)) $.clock.after(SETTLE_MS, () => void arrive($, id))
    return done
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: SUBAGENT }
    const gated = await gateAtCall($)
    if (gated !== undefined) return { deny: gated === COORDINATED ? COORDINATED : `Not queued: ${gated}.` }
    const input = e as { to?: unknown; reason?: unknown; notes?: unknown; resume?: unknown }
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
    if (own === to) return { deny: `This session is already conversation ${to}.` }
    const stop = blocked(await busyAgents($))
    if (stop !== undefined) return { deny: `Not queued: ${stop}. Wait for them to report, or stop them, then call again.` }
    const lately = own !== undefined && SESSION_ID.test(own) ? await lastSwitch($, own) : undefined
    if (lately !== undefined) return { deny: `Not queued: ${await loop($, lately)}.` }
    const resume = text(input.resume)
    await $.state.set(queued, resume === undefined ? { to, reason, notes } : { to, reason, notes, resume })
    $.ui.status('switch queued for when this turn ends')
    return {
      result: `Queued. Once this turn ends, this terminal switches to conversation ${to}: this conversation ends here, untouched, and ${to} resumes in this process, in this pane's slot, or in a new window, whichever applies. First the plugin checks that ${to} is open nowhere on this machine and that nothing runs under this session; if anything is, nothing moves and you are told on your next turn. Reason: ${reason} Notes: ${notes}`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-switch: queuing the switch failed; nothing is queued.' }))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
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
    $.clock.after(SETTLE_MS, () => void switchNow($, value))
    return done
  })

  // A message that starts a turn before the switch's final command has started takes it back.
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (e.agentId !== undefined) return started
    void heartbeat($)
    if (armed === undefined) return started
    armed = undefined
    $.ui.status(undefined)
    $.ui.toast('Switch cancelled: a new turn started before it ran.')
    void tellModel($, "The switch you queued didn't go ahead: a new turn started before it ran. This conversation goes on; call switch_after_turn again at the next break.")
    return started
  })
}
