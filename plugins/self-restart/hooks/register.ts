// A session restarts itself on Windows: once the current turn ends, it opens a new terminal window in
// the session's folder, exits, and the new window resumes the same conversation (`claude --resume
// <id>`) once the old process has gone. Useful after an account switch, a setting that takes effect
// at startup, or a plugin that won't reload. The model calls restart_after_turn with `reason`,
// required, since the exit is irreversible for this process; a command can't run while the turn the
// model is in waits on it, so the call is queued and the restart runs once the turn has ended with
// an answer. An interrupted turn cancels it. Only the main conversation restarts this way, never a
// subagent, and only one run in a terminal with a person at its prompt.
//
// The launch: one fixed PowerShell script by Windows PowerShell's known path, its only variable the
// session's id, which must be a UUID; see launcher.ts. Nothing from the tool's input reaches the
// launch. The new window waits for this session's claude.exe to exit before it resumes, so two
// copies never write one session.
//
// The first prompt never goes on a command line. It waits in the plugin's own store, under the
// session's id, and the copy of this plugin in the process that resumes the session sends it, once,
// at the classic SessionStart with `source: "resume"` for that id. One older than 15 minutes is
// dropped: the window had given up, and the session was resumed later by hand.
//
// It refuses while a subagent is running, whose work would end with this process; checked at the
// call and again right before the launch.
import type { EngineInterface, Register } from 'claude-code'
import type { Queued, Restart } from '../types'
import { encodeCommand, LAUNCHED, launcherScript, powershellPath, SESSION_ID, SYSTEM_ROOT, WAIT_SECONDS } from './launcher'
import { configureUpdateCheck, loadUpdateCheck, withUpdateNotice } from './update-check'

const queued = { plugin: 'self-restart', key: 'queued' } as const

/** The plugin's store key for restarts under way, by session id. */
const RESTARTS = 'restarts'

/** A beat after the turn's end, so the turn is no longer running when the restart starts. */
const SETTLE_MS = 500
/** How long after the exit command to look whether the session is still here. */
const CHECK_MS = 5000
/** How long the launcher may take to open the window. */
const LAUNCH_MS = 30_000
/** A restart's first prompt older than this is dropped, not sent: the window waits 10 minutes at most. */
const STALE_MS = 15 * 60 * 1000
/** The most restarts under way the store keeps. */
const MAX_KEPT = 50

/** An agent in one of these is still to report. */
const BUSY: readonly string[] = ['pending', 'running', 'waiting']

const DESCRIPTION = [
  "Restarts this session once the current turn ends: it opens a new terminal window in this session's folder, this session exits, and the window resumes it (claude --resume <this session's id>) once this process has gone. The conversation carries on there.",
  'Call it when a restart is the fix: the person switched accounts, changed a setting that takes effect at startup, or a plugin won\'t reload (try reload_plugins_after_turn first, if it is available). Never on your own to clear a problem a restart doesn\'t fix.',
  'Windows only, in a session run in a terminal.',
  '`reason` (required) says why; it is recorded in the transcript. `resume` is the message that starts your first turn in the restarted session: what to check or do next. Give it whenever you have a next step of your own; leave it out only when the next step waits on someone else.',
  'Everything this process runs ends with it: wake-ups, background tasks, Remote Control (with Remote Control on for all sessions, the resumed session connects again). It refuses while subagents you started are still running.',
  'End the turn after calling it; the restart starts once your answer is shown.',
].join(' ')

const SUBAGENT =
  "A subagent can't restart the session. Finish your piece and return its result, saying a restart is needed and why: the main session can restart."

/** Whether this session runs in a terminal with a person at its prompt; read at each session.start. */
let isTerminal = true

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

/** What the launch needs, each from the engine, never from the tool's input; or why it can't go ahead. */
async function plan($: EngineInterface): Promise<{ powershell: string; id: string } | { refusal: string }> {
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
  return { powershell: powershellPath(root), id }
}

/** The restarts under way in the store, each one checked; dropped: anything else, and those gone stale. */
async function restarts($: EngineInterface, now: number): Promise<Record<string, Restart>> {
  const stored = await $.store.get(RESTARTS)
  const kept: Record<string, Restart> = {}
  if (!isRecord(stored)) return kept
  for (const [id, value] of Object.entries(stored)) {
    if (!SESSION_ID.test(id) || !isRecord(value) || typeof value.at !== 'number' || typeof value.reason !== 'string') continue
    if (now - value.at > STALE_MS && now >= value.at) continue
    kept[id] = typeof value.resume === 'string' ? { at: value.at, reason: value.reason, resume: value.resume } : { at: value.at, reason: value.reason }
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
async function refuse($: EngineInterface, toast: string, note: string): Promise<void> {
  $.ui.toast(toast)
  await tellModel($, note)
}

/** The row the model reads in the restarted session: why it restarted. */
const record = ({ reason }: Queued): string => `This session restarted at its own request (restart_after_turn). Reason: ${reason}`

/** Opens the window, then exits; says so at each step that didn't go ahead. */
async function restartNow($: EngineInterface, value: Queued): Promise<void> {
  $.ui.status(undefined)
  const stop = blocked(await busyAgents($))
  if (stop !== undefined) {
    await refuse($, `Restart cancelled: ${stop}.`, `The restart you queued didn't run: ${stop}. The session goes on; call restart_after_turn again once they have reported.`)
    return
  }
  const launch = await plan($)
  if ('refusal' in launch) {
    await refuse($, `Restart didn't run: ${launch.refusal}.`, `The restart you queued didn't run: ${launch.refusal}. The session goes on.`)
    return
  }
  // Kept before the window opens: the process it starts reads it once this one has exited.
  const kept: Restart = { at: await $.clock.now(), ...value }
  await keep($, launch.id, kept)
  let opened: string | undefined
  try {
    const run = await $.process.run([launch.powershell, '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(launcherScript(launch.id))], {
      timeoutMs: LAUNCH_MS,
    })
    if (run.exitCode !== 0 || !LAUNCHED.test(run.stdout)) {
      const said = brief(`${run.stdout} ${run.stderr}`)
      opened = `the launcher exited ${run.exitCode}${said === '' ? '' : `: ${said}`}`
    }
  } catch (err) {
    opened = `the launcher didn't run: ${why(err)}`
  }
  if (opened !== undefined) {
    await keep($, launch.id, null)
    await refuse($, `Restart didn't run: ${opened}`, `The restart you queued didn't run, and no window opened (${opened}). The session goes on.`)
    return
  }
  await tellModel($, record(value))
  $.ui.log(`Restarting at the session's own request: ${value.reason}`)
  $.ui.toast(`Restarting: a new window resumes this session once it has exited. ${value.reason}`)
  try {
    await $.command.run({ command: 'exit' })
  } catch (err) {
    const minutes = WAIT_SECONDS / 60
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
    const stop = blocked(await busyAgents($))
    if (stop !== undefined) return { deny: `Not queued: ${stop}. Wait for them to report, or stop them, then call again.` }
    const resume = text(input.resume)
    await $.state.set(queued, entry(reason, resume))
    $.ui.status('restart queued for when this turn ends')
    const then = resume === undefined ? 'then waits for the next message' : `then resumes with: ${resume}`
    return {
      result: `Queued. Once this turn ends, a new terminal window opens in this session's folder, this session exits, and the window resumes it once this process has gone; the reason is recorded in the transcript: ${reason}. The restarted session ${then}. On anything but Windows nothing runs, and you are told on your next turn.`,
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
      return done
    }
    $.clock.after(SETTLE_MS, () => void restartNow($, value))
    return done
  })
}
