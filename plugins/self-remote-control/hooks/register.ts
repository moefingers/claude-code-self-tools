// A session reads, turns on and names its own Remote Control: the link that lets the user follow and
// steer it from a phone or a browser, whose session list shows each session by its title. `status`
// reports. `connect` runs the remote-control command once the turn ends, only when this session is
// not connected, titled with the name it was given, else with the session's own title: the app takes
// a session's title as it connects. `rename` runs /rename once the turn ends and touches nothing
// else. An optional `resume` is the message that starts the session's next turn once the action has
// run, led by what happened; without one, the person gets a toast and the model a note on its next
// turn when something didn't take.
//
// The remote-control command never runs while this session is connected. In the interactive terminal
// it then opens the Remote Control panel (the session's link, Disconnect this session, Show QR code,
// Continue) and waits for the person, so a run from here would hold the plugin on a panel nobody may
// be there to close. So `connect` runs it only on a reading it recognises as "not connected", taken
// again right before it runs, and refuses on any reading it doesn't recognise.
//
// The reading: the remote-control command's own description, which the engine works out from this
// session's connection each time it lists the command. It is the one place the API says whether
// this session is connected. The attached surfaces say which clients draw the session now (a
// connected session with no phone attached shows the terminal alone), session.attach and
// session.detach carry those same clients, and the `remoteControl` setting is the default for all
// sessions; none of them says whether this session is connected.
//
// The session's title: the custom title (`--name`, /rename, a hook's `sessionTitle`, a rename from
// the app) that the SessionStart and UserPromptSubmit hook inputs carry as `session_title`, kept in
// session state as each arrives; the API has no other read of it. A generated title is not a custom
// title and is not carried. With none, `connect` runs the command bare, as the person would.
//
// Only the main conversation acts this way, never a subagent. An interrupted turn cancels what it
// queued, its resume included.
//
// After a login change, the session reconnects Remote Control and resumes a turn the change (or
// the limit before it) cut off, on its own: relogin.ts. Both a queued connect and that reconnect
// run the command only under the Remote Control lock, which the coordinator plugin takes too:
// rc-lock.ts.
import type { EngineInterface, Register } from 'claude-code'
import type { Held, Queued } from '../types'
import { read, readNow, runRemoteControl, sessionTitle, why, type Reading } from './connection'
import { LOCK_HOLD_MS, releaseLock, takeLock } from './rc-lock'
import { aroundLogin, configureRelogin, forgetTurn, noteFailure, notePersonPrompt, noteServers, noteTurnEnd, noteTurnStart, startWatch } from './relogin'
import { configureUpdateCheck, loadUpdateCheck, withUpdateNotice } from './update-check'

const queued = { plugin: 'self-remote-control', key: 'queued' } as const
const title = { plugin: 'self-remote-control', key: 'title' } as const

/**
 * When the connect or rename starts after the turn's end: at once, the moment the turn's end returns (the owner's A). Input
 * already waiting when the turn ended still runs first, since Claude Code queues a plugin's command behind it; the
 * connect or rename then runs after that input's turn, which does no harm. (self-clear, self-exit, self-restart and self-switch
 * wait half a second instead, so that their step stands down when something is waiting.)
 */
const TURN_END_MS = 0
/** How long after a connect to look again, for whether it took. */
const CHECK_MS = 3000
/** While a connect that hasn't read connected holds the lock: how often to look again. */
const HOLD_LOOK_MS = 15_000
/** The longest title /rename keeps. */
const NAME_MAX = 200

const DESCRIPTION = [
  'Reports on, connects or renames this session for Remote Control: the link that lets the user follow and steer the session from a phone or a browser, whose session list shows each session by its title.',
  '`status` says whether this session is connected now, its title, what the Remote Control for all sessions setting holds, and which clients are attached.',
  "`connect` connects this session once the current turn ends, only if it is not connected then: titled `name` when given, else the session's own title (its /rename title) when it has one. The app takes the title as the session connects.",
  "`rename` is how to give the session a proper title, a few words on what it is working on: once the turn ends it runs /rename with `name`, and nothing else. If the session is connected and the app doesn't show the new title, the session needs reconnecting, or renaming in the app.",
  'Call `status` when the user asks whether they can reach this session remotely, and `connect` when they ask to be able to, such as before stepping away, with a `name` unless the session already has a title.',
  "It never disconnects, and never runs /remote-control while connected; disconnecting is the user's to do from its panel.",
  '`resume` is the message that starts your next turn once the action has run, after what happened: what to do next. Leave it out when the next step waits on someone else (the user, another session, a check).',
  "`connect` and `rename` run when the session is idle: Claude Code queues a plugin's command behind anything already waiting (a message typed during this turn, a background task's notification) and has no slot between turns ahead of them, so under a nonstop stream of work and notifications they may run in the distant future. Nothing waiting is lost.",
  'After `connect` or `rename`, end your turn and do nothing more until it has run; then carry on.',
].join(' ')

const SUBAGENT =
  "A subagent can't read or change the session's Remote Control. Finish your piece and return its result; the main session can connect."

/** How an action ended: a toast for the person, and for one that didn't take, a note for the model. */
type Outcome = { toast: string; note?: string }

/** Trimmed text, or undefined when it is not a string or is blank. */
function text(raw: unknown): string | undefined {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed === '' ? undefined : trimmed
}

/** Why `name` won't do as a title, or undefined when it will. */
function badName(name: string): string | undefined {
  if (/[\r\n]/.test(name)) return '`name` is a title on one line.'
  if (name.length > NAME_MAX) return `\`name\` is at most ${NAME_MAX} characters, as /rename keeps.`
  return undefined
}

/** ` as "<name>"`, or nothing when there is no name. */
const titled = (name: string | undefined) => (name === undefined ? '' : ` as "${name}"`)

/** Tells the model on its next turn, in a row it reads and the person doesn't see as typed. */
async function tellModel($: EngineInterface, note: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
  } catch {
    // The toast has told the person; there is no other way to reach the model.
  }
}

/** Starts the next turn with what happened and the resume; whether it was sent. */
async function sendResume($: EngineInterface, said: string, resume: string): Promise<boolean> {
  try {
    const sent = await $.prompt.submit({ text: `${said} Resume: ${resume}` })
    if (sent.drop === undefined) return true
    $.ui.toast(`Resume not sent: ${sent.drop}`)
  } catch {
    $.ui.toast('Resume not sent; the session waits for the next message.')
  }
  return false
}

/**
 * Says how an action ended: a toast, then the resume, led by the note (or the toast's words when it
 * took). Without a resume, or when it can't be sent, the model gets the note, if there is one.
 */
async function report($: EngineInterface, { toast, note }: Outcome, resume: string | undefined): Promise<void> {
  $.ui.toast(toast)
  if (resume !== undefined && (await sendResume($, note ?? toast, resume))) return
  if (note !== undefined) await tellModel($, note)
}

/** Why `connect` won't run the command on this reading. */
function refusal(reading: Reading): string {
  if (reading.state === 'unavailable') {
    return "This session has no remote-control command (it needs a claude.ai subscription, and a policy can turn it off), so there is nothing to connect."
  }
  if (reading.state === 'unknown') {
    return `Can't tell whether Remote Control is connected: the remote-control command reads "${reading.description}", which this plugin doesn't recognise. Run while connected, that command opens its panel and waits for the user, so it isn't run.`
  }
  return 'Remote Control is already connected; nothing to do.'
}

/** Keeps the session's custom title as a hook input carries it: absent, the session has none. */
async function remember($: EngineInterface, e: { session_title?: string; agent_id?: string }): Promise<void> {
  if (e.agent_id !== undefined) return
  try {
    await $.state.set(title, text(e.session_title) ?? null)
  } catch {
    // The next prompt carries it again.
  }
}

async function status($: EngineInterface): Promise<string> {
  const [reading, rows, surfaces, held] = await Promise.all([read($), $.config.list(), $.session.surfaces(), $.state.get(title)])
  const connection =
    reading.state === 'unavailable'
      ? 'Remote Control: unavailable in this session (no remote-control command).'
      : reading.state === 'unknown'
        ? `Remote Control: unknown (the remote-control command reads "${reading.description}").`
        : `Remote Control: ${reading.state}.`
  const named =
    held.value === undefined
      ? 'Session title: not read yet (each prompt carries it).'
      : held.value === null
        ? 'Session title: none, so the app titles the session from its conversation or a generated name; give it one with rename.'
        : `Session title: "${held.value}".`
  const row = rows.find(r => r.key === 'remoteControl')
  const setting =
    row === undefined
      ? 'The Remote Control for all sessions setting is not listed in /config.'
      : `Remote Control for all sessions (/config remoteControl): ${String(row.value)}.`
  const attached = `Attached clients: ${surfaces.length === 0 ? 'none' : surfaces.join(', ')}.`
  return `${connection} ${named} ${setting} ${attached}`
}

/** What a queued action's answer ends with: what starts the turn after it. */
const then = (resume: string | undefined) =>
  resume === undefined ? ' Then the session waits for the next message.' : ` Then the session resumes with: ${resume}`

/** What is queued, with `name` and `resume` only when there are some: stored state holds no undefined. */
function entry(connect: boolean, rename: boolean, name: string | undefined, resume: string | undefined): Queued {
  const extra = { ...(name === undefined ? {} : { name }), ...(resume === undefined ? {} : { resume }) }
  if (rename && name !== undefined) return { connect, rename: true, name, ...extra }
  return { connect: true, rename: false, ...extra }
}

/** Queues a connect, folded into a rename this turn already queued; answers the call. */
async function queueConnect($: EngineInterface, name: string | undefined, resume: string | undefined, earlier: Queued | null): Promise<string> {
  const value =
    earlier?.rename === true
      ? entry(true, true, name ?? earlier.name, resume ?? earlier.resume)
      : entry(true, false, name, resume ?? earlier?.resume)
  await $.state.set(queued, value)
  $.ui.status('Remote Control connects when this turn ends')
  const known = value.name ?? (await sessionTitle($))
  const under =
    value.rename
      ? `, as "${value.name}", after the session is renamed to it`
      : value.name !== undefined
        ? `, as "${value.name}"`
        : known !== undefined
          ? `, as "${known}", the session's title`
          : ', with no name: the session has no title, so the app titles it from its conversation or a generated <hostname>-<adjective>-<noun>; to title it, pass `name` or call rename first'
  return `Queued: Remote Control connects once this turn ends (it reads not connected now)${under}. The session checks again right before, and runs nothing if it is connected by then.${then(value.resume)}`
}

/** Queues a rename, keeping a connect this turn already queued; answers the call. */
async function queueRename($: EngineInterface, name: string, resume: string | undefined, reading: Reading, earlier: Queued | null): Promise<string> {
  const connect = earlier?.connect === true
  const value = entry(connect, true, name, resume ?? earlier?.resume)
  await $.state.set(queued, value)
  $.ui.status(`Session renamed "${name}" when this turn ends`)
  const renamed = `Queued: once this turn ends, the session's local title is set to "${name}" (/rename)`
  const plan =
    reading.state === 'connected'
      ? `${renamed}; Remote Control isn't touched. The app normally shows the new title; if it doesn't, the session needs reconnecting, or renaming in the app.`
      : connect && reading.state === 'not connected'
        ? `${renamed}, then Remote Control connects under that name.`
        : reading.state === 'not connected'
          ? `${renamed}. Remote Control isn't connected; connect takes this title when it connects.`
          : `${renamed}; Remote Control isn't touched.`
  return `${plan}${then(value.resume)}`
}

/** At the turn's end: the rename, then the connect if one is queued, then the report. */
async function runQueued($: EngineInterface, value: Queued): Promise<void> {
  $.ui.status(undefined)
  if (value.rename) {
    try {
      await $.command.run({ command: 'rename', args: value.name })
    } catch (err) {
      const rest = value.connect ? ' Nothing else ran, the Remote Control connect included.' : ''
      await report(
        $,
        { toast: `Session not renamed: ${why(err)}`, note: `The rename to "${value.name}" you queued didn't run: ${why(err)}.${rest}` },
        value.resume,
      )
      return
    }
    if (!value.connect) {
      await report($, { toast: `Session renamed "${value.name}".` }, value.resume)
      return
    }
  }
  const lead = value.rename ? `Session renamed "${value.name}". ` : ''
  await connectNow($, value.name ?? (await sessionTitle($)), value.resume, lead)
}

/**
 * Connects under the Remote Control lock (rc-lock.ts), only on a "not connected" reading taken once
 * the lock is held, then says whether it took, after `lead`. The lock is held until the session
 * reads connected, or LOCK_HOLD_MS.
 */
async function connectNow($: EngineInterface, name: string | undefined, resume: string | undefined, lead: string): Promise<void> {
  const taken = await takeLock($, await $.clock.now())
  if ('busy' in taken) {
    const busy = `${taken.busy}, so nothing ran; check with remote_control status.`
    await report($, { toast: `${lead}Remote Control: ${busy}`, note: `${lead}The Remote Control connect you queued didn't run: ${busy}` }, resume)
    return
  }
  const reading = await readNow($)
  if (reading.state === 'connected') {
    await releaseLock($, taken.held)
    await report($, { toast: `${lead}Remote Control was already connected; nothing ran.` }, resume)
    return
  }
  if (reading.state !== 'not connected') {
    await releaseLock($, taken.held)
    await report(
      $,
      { toast: `${lead}Remote Control not connected: ${refusal(reading)}`, note: `${lead}The Remote Control connect you queued did not run. ${refusal(reading)}` },
      resume,
    )
    return
  }
  try {
    await runRemoteControl($, name)
  } catch (err) {
    await releaseLock($, taken.held)
    await report(
      $,
      { toast: `${lead}Remote Control didn't connect: ${why(err)}`, note: `${lead}The Remote Control connect you queued didn't run: ${why(err)}` },
      resume,
    )
    return
  }
  $.clock.after(CHECK_MS, () => void checkConnected($, name, resume, lead, taken.held))
}

/** Gives the lock back once the session reads connected, or once it has been held LOCK_HOLD_MS. */
async function holdUntilConnected($: EngineInterface, held: Held): Promise<void> {
  if ((await $.clock.now()) - held.at >= LOCK_HOLD_MS || (await readNow($)).state === 'connected') {
    await releaseLock($, held)
    return
  }
  $.clock.after(HOLD_LOOK_MS, () => void holdUntilConnected($, held))
}

async function checkConnected($: EngineInterface, name: string | undefined, resume: string | undefined, lead: string, held: Held): Promise<void> {
  const reading = await readNow($)
  if (reading.state === 'connected') {
    await releaseLock($, held)
    await report($, { toast: `${lead}Remote Control connected${titled(name)}.` }, resume)
    return
  }
  $.clock.after(HOLD_LOOK_MS, () => void holdUntilConnected($, held))
  await report(
    $,
    {
      toast: `${lead}Remote Control: the command ran, but the session does not read as connected yet.`,
      note: `${lead}The remote-control command ran, but this session did not read as connected a few seconds later; check with remote_control status.`,
    },
    resume,
  )
}

export const register: Register = (on, options) => {
  configureUpdateCheck('self-remote-control', options)
  configureRelogin(options)

  // First, so it is outermost on this plugin's tools: it sees each answer, and adds the update
  // notice when one is due. It never waits on the check; see update-check.ts.
  on('tool.call', { tool: /^mcp__self-remote-control__/ }, async ($, e, next) => withUpdateNotice($, e, await next(e))).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'remote_control',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'connect', 'rename'],
            description:
              '`status` to report; `connect` to connect this session once the turn ends, if it is not connected; `rename` to set the session\'s title (/rename) once the turn ends.',
          },
          name: {
            type: 'string',
            description: `The session's title: for \`rename\` (required), its new title; for \`connect\` (optional), the title it connects under, else the session's own. One line, at most ${NAME_MAX} characters: a few words on what the session is working on.`,
          },
          resume: {
            type: 'string',
            description:
              'For `connect` and `rename`: the message that starts your next turn once the action has run, after what happened: what to do next. Leave it out only when the next step waits on someone else.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    loadUpdateCheck($)
    startWatch($)
    void noteServers($)
    return started
  })

  on('classic.SessionStart', async ($, e, next) => {
    const done = await next(e)
    await remember($, e)
    // Another conversation: its last turn isn't the one this plugin saw end.
    if (e.agent_id === undefined && (e.source === 'clear' || e.source === 'resume' || e.source === 'fork')) await forgetTurn($)
    return done
  })

  // The main conversation's turns, for whether a login change cut one off.
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (e.agentId === undefined) await noteTurnStart($, e.text, e.turnId)
    return started
  })

  on('classic.StopFailure', async ($, e, next) => {
    const done = await next(e)
    if (e.agent_id === undefined) await noteFailure($, String(e.error))
    return done
  })

  // A prompt the person typed, at the terminal or from the app: a resume the loop-breaker held may go again.
  on('prompt.submit', async ($, e, next) => {
    const done = await next(e)
    if (done.drop === undefined && (e.origin.kind === 'composer' || e.origin.kind === 'bridge')) await notePersonPrompt($)
    return done
  }).catch(($, e, next) => next(e))

  // A /login here: a login change waits until its dialog has closed (relogin.ts).
  on('command.run', { command: 'login' }, ($, e, next) => aroundLogin($, () => next(e))).catch(($, e, next) => next(e))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const done = await next(e)
    await remember($, e)
    return done
  })

  on('tool.call', { tool: 'mcp__self-remote-control__remote_control' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: SUBAGENT }
    const input = e as { action?: unknown; name?: unknown; resume?: unknown }
    if (input.action === 'status') return { result: await status($) }
    if (input.action !== 'connect' && input.action !== 'rename') return { deny: '`action` is `status`, `connect` or `rename`.' }
    const name = text(input.name)
    if (name === undefined && input.action === 'rename') return { deny: "`rename` needs `name`: the session's new title." }
    const bad = name === undefined ? undefined : badName(name)
    if (bad !== undefined) return { deny: bad }
    const resume = text(input.resume)
    const [reading, earlier] = await Promise.all([read($), $.state.get(queued)])
    if (input.action === 'rename' && name !== undefined) return { result: await queueRename($, name, resume, reading, earlier.value ?? null) }
    if (reading.state === 'connected') {
      const retitle = name === undefined ? '' : ` To title it "${name}", call rename.`
      return { result: `${refusal(reading)}${retitle}` }
    }
    if (reading.state !== 'not connected') return { deny: refusal(reading) }
    return { result: await queueConnect($, name, resume, earlier.value ?? null) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-remote-control: the call failed; nothing is queued.' }))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    await noteTurnEnd($, { reason: e.reason, durationMs: e.durationMs, turnId: e.turnId, ...(e.usage === undefined ? {} : { usage: e.usage }) })
    void noteServers($)
    const { value } = await $.state.get(queued)
    if (!value) return done
    await $.state.set(queued, null)
    if (e.isAborted || e.reason !== 'answer') {
      $.ui.status(undefined)
      $.ui.toast(`Remote Control ${value.rename ? 'rename' : 'connect'} cancelled: the turn didn't finish.`)
      return done
    }
    $.clock.after(TURN_END_MS, () => void runQueued($, value))
    return done
  })
}
