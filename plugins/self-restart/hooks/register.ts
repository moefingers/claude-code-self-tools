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
// The launch: one fixed PowerShell script by Windows PowerShell's known path, its only variable the
// session's id, which must be a UUID; see launcher.ts. Nothing from the tool's input reaches the
// launch. It takes the claim lock on the conversation, so a switch moving it at the same time can't
// resume it too. The new window waits for this session's claude.exe to exit, then reads the session
// registry and the process table again, and resumes only when nothing else holds the conversation,
// so two copies never write one session. When this session runs in a slot (a Windows Terminal pane
// running self-switch's claude-slot.ps1 of the shipped hash), the launcher leaves the slot a record
// instead, and the slot resumes the session in the same pane once it has exited. The resumed session's
// copy of this plugin releases the claim lock.
//
// The first prompt never goes on a command line. It waits in the plugin's own store, under the
// session's id, and the copy of this plugin in the process that resumes the session sends it, once,
// at the classic SessionStart with `source: "resume"` for that id. One older than 15 minutes is
// dropped: the window had given up, and the session was resumed later by hand.
//
// The pre-check (exitBlockers, in the shared machine code), as self-exit's: it refuses while anything
// would make the exit stop at its confirmation, or end work still running: a session cron (the
// built-in CronList, read through $.tool.call once $.tool.check allows it, so never a dialog), a
// background job under the session (the probe's S6), a subagent; each named with how to stop it, and
// anything unreadable refuses too. It runs at the call, so nothing is queued while a blocker stands,
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
import { CLAIMED, FALLBACK, LAUNCHED, launcherScript, powershellPath, RELEASED, releaseScript, SESSION_ID, SLOTTED, stateFolder, SYSTEM_ROOT, WAIT_SECONDS } from './launcher'
import type { PendingKind } from './machine'
import { blockersText, exitBlockers, isSafeFolder, markPending, oneLine, powershellCall, quoted, readExit, readGit, safePoint } from './machine'
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
/** How long the launcher may take to open the window. */
const LAUNCH_MS = 30_000
/** How long releasing the claim lock may take. */
const RELEASE_MS = 15_000
/** How long a slot honours the record the launcher left it, in seconds. */
const SLOT_SECONDS = 120
/** A restart's first prompt older than this is dropped, not sent: the window waits 10 minutes at most. */
const STALE_MS = 15 * 60 * 1000
/** The most restarts under way the store keeps. */
const MAX_KEPT = 50
/** A second restart of one session sooner than this after the first is refused: no restart loop. */
const LOOP_MS = 2 * 60 * 1000

/** An agent in one of these is still to report. */
const BUSY: readonly string[] = ['pending', 'running', 'waiting']

const DESCRIPTION = [
  "Restarts this session once the current turn ends: it opens a new terminal window in the folder this session started in, this session exits, and the window resumes it (claude --resume <this session's id>) once this process has gone. The conversation carries on there.",
  'Call it when a restart is the fix: the person switched accounts, changed a setting that takes effect at startup, or a plugin won\'t reload (try reload_plugins_after_turn first, if it is available). Only at a finished break: never mid-merge, mid-push or mid-task. Never on your own to clear a problem a restart doesn\'t fix.',
  'Windows only, in a session run in a terminal.',
  '`reason` (required) says why; it is recorded in the transcript. `resume` is the message that starts your first turn in the restarted session: what to check or do next. Give it whenever you have a next step of your own; leave it out only when the next step waits on someone else.',
  'It refuses unless the session is at a safe point: while a session cron is set (delete it with CronDelete), while subagents you started are still running, while anything runs under this session (a background Bash, PowerShell or Monitor job, git, a build, test or lint, a dev server or Playwright, a heavy-slot job), while a git operation is in flight in the repo, and while any of that can\'t be read; each is named with how to stop it. It refuses a second restart within 2 minutes of the last. What still ends with this process: wake-ups, background tasks it can\'t see, Remote Control (with Remote Control on for all sessions, the resumed session connects again).',
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

/** What is queued: `resume` only when there is one, since stored state holds no undefined. */
const entry = (reason: string, resume: string | undefined): Queued => (resume === undefined ? { reason } : { reason, resume })

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

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

/** The agents still to report, by their task's description; undefined when the list can't be read. */
async function busyAgents($: EngineInterface): Promise<string[] | undefined> {
  try {
    return (await $.agent.list()).filter(a => BUSY.includes(a.status)).map(a => (a.description.trim() === '' ? a.type : a.description))
  } catch {
    return undefined
  }
}

/** Why a restart can't go ahead with these agents, or undefined when none is still to report. */
function blocked(busy: string[] | undefined): string | undefined {
  if (busy === undefined) return "the session's subagents can't be read, so whether any is still running is unknown"
  if (busy.length === 0) return undefined
  return `${busy.length === 1 ? 'a subagent is' : `${busy.length} subagents are`} still running (${busy.join('; ')}), and ${busy.length === 1 ? 'its work' : 'their work'} would end with this process`
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
 * planned, subagents), each with how to stop it, as one line; undefined when nothing does. Off
 * Windows, or where the launch can't be planned, the probe isn't run: the restart is refused when
 * armed, saying why, and nothing exits.
 */
async function blockers($: EngineInterface, launch: { powershell: string; id: string } | undefined): Promise<string | undefined> {
  const found = exitBlockers(await readExit($, launch))
  return found.length === 0 ? undefined : blockersText(found)
}

/**
 * Why this session isn't at a safe point to exit, or undefined when it is. First the pre-check
 * (exitBlockers: a session cron, a background job under the session, a subagent, each with how to
 * stop it); then the shared safePoint, on the same probe of the process tree (this session's id, no
 * config folder, no claim) and git's state where the session started and works: git, a dev server or
 * a heavy-slot job under this claude.exe, or git in flight, holds it too. Anything that can't be read
 * holds it.
 */
async function notSafe($: EngineInterface, launch: { powershell: string; id: string; cwd: string }): Promise<string | undefined> {
  const read = await readExit($, launch)
  const found = exitBlockers(read)
  if (found.length > 0) return blockersText(found)
  let cwd: string
  try {
    cwd = await $.session.cwd()
  } catch (err) {
    return `this session's folder can't be read, so git's state there is unknown (${why(err)})`
  }
  const git = await readGit($, { start: launch.cwd, folders: [cwd], dirty: false })
  // The probe and the agents were read whole above, or the pre-check would have held.
  const safe = safePoint(read.busy ?? 'it was not run', git, read.agents)
  return safe.verdict === 'clear' ? undefined : `this session isn't at a safe point (${safe.reasons.join('; ')})`
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
 * runner was passed over for a new window, why (the launcher's own words, quoted).
 */
const record = ({ reason }: Queued, fallback?: string): string =>
  `This session restarted at its own request (restart_after_turn). Reason: ${reason}${fallback === undefined ? '' : ` It restarted in a new window, not this pane's slot: ${quoted(fallback)}.`}`

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
  const stop = blocked(await busyAgents($))
  if (stop !== undefined) {
    armed = undefined
    await refuse($, `Restart cancelled: ${stop}.`, `The restart you queued didn't run: ${stop}. The session goes on; call restart_after_turn again once they have reported.`)
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
  const unsafe = await notSafe($, launch)
  if (unsafe !== undefined) {
    armed = undefined
    await refuse($, `Restart didn't run: ${unsafe}.`, `The restart you queued didn't run: ${unsafe}. The session goes on; call restart_after_turn again once they are done.`)
    return
  }
  // A turn that started while the checks above ran has taken it back, and said so.
  if (armed !== value) return
  // Kept before the window opens: the process it starts reads it once this one has exited.
  const kept: Restart = { at: await $.clock.now(), ...value }
  await keep($, launch.id, kept)
  let opened: string | undefined
  let slot: string | undefined
  let fallback: string | undefined
  try {
    const call = powershellCall(launch.powershell, launcherScript(launch.id))
    const run = await $.process.run(call.argv, {
      stdin: call.stdin,
      cwd: launch.cwd,
      timeoutMs: LAUNCH_MS,
    })
    slot = SLOTTED.exec(run.stdout)?.[1]
    if (run.exitCode !== 0 || (slot === undefined && !LAUNCHED.test(run.stdout))) {
      const said = brief(`${run.stdout} ${run.stderr}`)
      opened = `the launcher exited ${run.exitCode}${said === '' ? '' : `: ${said}`}`
    } else {
      // The claim the launcher took: the resumed session's copy of this plugin releases it.
      const claim = CLAIMED.exec(run.stdout)?.[1]
      if (claim !== undefined) await keep($, launch.id, { ...kept, claim })
      // A slot runner found but not used: the launcher says why, and so does the restart.
      const passed = slot === undefined ? FALLBACK.exec(run.stdout)?.[1] : undefined
      if (passed !== undefined) fallback = oneLine(passed, 300)
    }
  } catch (err) {
    opened = `the launcher didn't run: ${why(err)}`
  }
  if (opened === undefined) await noteRestart($, launch.id)
  if (opened !== undefined) {
    if (armed === value) armed = undefined
    await keep($, launch.id, null)
    await refuse($, `Restart didn't run: ${opened}`, `The restart you queued didn't run, and no window opened (${opened}). The session goes on.`)
    return
  }
  // Right before the exit: a turn that started meanwhile, or a subagent, leaves the window waiting.
  const late = armed !== value ? 'a new turn started' : blocked(await busyAgents($))
  if (late !== undefined || armed !== value) {
    armed = undefined
    await keep($, launch.id, null)
    const minutes = WAIT_SECONDS / 60
    if (slot !== undefined) {
      await refuse(
        $,
        `Restart stopped before the exit: ${late ?? 'a new turn started'}. This pane's slot resumes the session if it exits (/exit) within ${SLOT_SECONDS / 60} minutes.`,
        `The restart left this pane's slot a record, but this session didn't exit: ${late ?? 'a new turn started'}. The session goes on. If it exits within ${SLOT_SECONDS / 60} minutes, the slot resumes it in this pane; after that the record is ignored.`,
      )
      return
    }
    await refuse(
      $,
      `Restart stopped before the exit: ${late ?? 'a new turn started'}. Its window waits up to ${minutes} minutes for this session to exit, then gives up; close it, or exit (/exit) to resume there.`,
      `The restart's window opened, but this session didn't exit: ${late ?? 'a new turn started'}. The session goes on. The window waits up to ${minutes} minutes for this process to exit, then resumes the session there, or gives up and says so; the person can close it.`,
    )
    return
  }
  armed = undefined
  await tellModel($, record(value, fallback))
  $.ui.log(`Restarting at the session's own request: ${value.reason}`)
  if (fallback !== undefined) $.ui.log(`this pane's slot runner isn't used: ${fallback}. A new window resumes the session.`)
  const where = slot !== undefined ? "this pane's slot" : 'a new window'
  $.ui.toast(`Restarting: ${where} resumes this session once it has exited${fallback === undefined ? '' : `, not this pane's slot (${fallback})`}. ${value.reason}`)
  // Done as the exit runs: the coordinator delivers again, to the resumed session.
  await mark($, null)
  try {
    await $.command.run({ command: 'exit' })
  } catch (err) {
    const minutes = WAIT_SECONDS / 60
    if (slot !== undefined) {
      $.ui.toast(`Exit didn't run: ${why(err)}. This pane's slot resumes the session if it exits (/exit) within ${SLOT_SECONDS / 60} minutes.`)
      await tellModel($, `The restart left this pane's slot a record, but the exit didn't run: ${why(err)}. If this process exits within ${SLOT_SECONDS / 60} minutes, the slot resumes the session in this pane; after that this session goes on as it is.`)
      return
    }
    $.ui.toast(`Exit didn't run: ${why(err)}. The new window waits ${minutes} minutes for this session to exit (/exit), then gives up.`)
    await tellModel(
      $,
      `The restart's new window opened, but the exit didn't run: ${why(err)}. The window waits up to ${minutes} minutes for this process to exit and then resumes the session there; the person can exit (/exit) for that. After that it gives up and says so, and this session goes on.`,
    )
    return
  }
  // An exit that took ends this module with the session, and this never fires.
  $.clock.after(CHECK_MS, () => {
    $.ui.toast(`The exit ran, but the session is still open. The new window waits up to ${WAIT_SECONDS / 60} minutes for it to exit.`)
    void tellModel($, 'The restart\'s exit ran, but the session is still open (a dialog may have been answered no). The new window waits for it to exit, then resumes it there.')
  })
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

  // The process that resumed a session this plugin restarted: send that restart's first prompt.
  on('classic.SessionStart', async ($, e, next) => {
    const done = await next(e)
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
      result: `Queued. Once this turn ends, a new terminal window opens in the folder this session started in, this session exits, and the window resumes it once this process has gone; the reason is recorded in the transcript: ${reason}. The restarted session ${then}. In a pane running self-switch's slot runner, the pane resumes it instead; when that slot can't be used, the restart says why. On anything but Windows nothing runs, and you are told on your next turn.`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-restart: queuing the restart failed; nothing is queued.' }))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
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
    if (e.agentId !== undefined || armed === undefined) return started
    armed = undefined
    $.ui.status(undefined)
    $.ui.toast('Restart cancelled: a new turn started before this session exited.')
    void mark($, null)
    void cancelled($, "The restart you queued didn't go ahead: a new turn started before this session exited. The session goes on.")
    return started
  })
}
