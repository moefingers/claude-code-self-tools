// A session reads, and can turn on, its own Remote Control: the link that lets the user follow and
// steer it from a phone or a browser. `status` reports; `connect` runs the remote-control command,
// once the turn ends, and only when this session is not connected. That command is a toggle: run
// while connected, it disconnects. So `connect` runs it only on a reading it recognises as "not
// connected", taken again right before it runs, and refuses on any reading it doesn't recognise.
//
// The reading: the remote-control command's own description, which the engine works out from this
// session's connection each time it lists the command. It is the one place the API says whether
// this session is connected. The attached surfaces say which clients draw the session now (a
// connected session with no phone attached shows the terminal alone), session.attach and
// session.detach carry those same clients, and the `remoteControl` setting is the default for all
// sessions; none of them says whether this session is connected.
//
// Only the main conversation acts this way, never a subagent. An interrupted turn cancels a
// queued connect.
import type { EngineInterface, Register } from 'claude-code'

const connectQueued = { plugin: 'self-remote-control', key: 'connectQueued' } as const

/** A beat after the turn's end, so the turn is no longer running when the command starts. */
const SETTLE_MS = 500
/** How long after the command to look again, for the toast that says whether it took. */
const CHECK_MS = 3000

/** The remote-control command's description while this session is connected, and while it is not. */
const CONNECTED = 'Disconnect Remote Control'
const NOT_CONNECTED = 'Control this session from your phone or claude.ai/code'

const DESCRIPTION = [
  'Reports on, or turns on, Remote Control for this session: the link that lets the user follow and steer the session from a phone or a browser.',
  '`status` says whether this session is connected now, what the Remote Control for all sessions setting holds, and which clients are attached.',
  '`connect` connects this session once the current turn ends, only if it is not connected then; it never disconnects.',
  'Call `status` when the user asks whether they can reach this session remotely, and `connect` when they ask to be able to, such as before stepping away.',
  'Not for disconnecting, which is the user\'s to do with /remote-control.',
  'After `connect`, end the turn; it runs once your answer is shown.',
].join(' ')

const SUBAGENT =
  "A subagent can't read or change the session's Remote Control. Finish your piece and return its result; the main session can connect."

type Reading =
  | { state: 'connected' | 'not connected' }
  | { state: 'unavailable' }
  | { state: 'unknown'; description: string }

/** Why a call was refused, as one line. */
function why(err: unknown): string {
  const said = (err instanceof Error ? err.message : String(err)).trim()
  return said === '' ? 'no reason given' : said
}

/** Tells the model on its next turn, in a row it reads and the person doesn't see as typed. */
async function tellModel($: EngineInterface, note: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
  } catch {
    // The toast has told the person; there is no other way to reach the model.
  }
}

/** Whether this session's Remote Control is connected, from the remote-control command's description. */
async function read($: EngineInterface): Promise<Reading> {
  const command = (await $.command.list()).find(c => c.name === 'remote-control' && c.source === 'builtin')
  if (command === undefined) return { state: 'unavailable' }
  if (command.description === CONNECTED) return { state: 'connected' }
  if (command.description === NOT_CONNECTED) return { state: 'not connected' }
  return { state: 'unknown', description: command.description }
}

/** Why `connect` won't run the command on this reading. */
function refusal(reading: Reading): string {
  if (reading.state === 'unavailable') {
    return "This session has no remote-control command (it needs a claude.ai subscription, and a policy can turn it off), so there is nothing to connect."
  }
  if (reading.state === 'unknown') {
    return `Can't tell whether Remote Control is connected: the remote-control command reads "${reading.description}", which this plugin doesn't recognise. Run while connected, that command disconnects, so it isn't run.`
  }
  return 'Remote Control is already connected; nothing to do.'
}

async function status($: EngineInterface): Promise<string> {
  const [reading, rows, surfaces] = await Promise.all([read($), $.config.list(), $.session.surfaces()])
  const connection =
    reading.state === 'unavailable'
      ? 'Remote Control: unavailable in this session (no remote-control command).'
      : reading.state === 'unknown'
        ? `Remote Control: unknown (the remote-control command reads "${reading.description}").`
        : `Remote Control: ${reading.state}.`
  const row = rows.find(r => r.key === 'remoteControl')
  const setting =
    row === undefined
      ? 'The Remote Control for all sessions setting is not listed in /config.'
      : `Remote Control for all sessions (/config remoteControl): ${String(row.value)}.`
  const attached = `Attached clients: ${surfaces.length === 0 ? 'none' : surfaces.join(', ')}.`
  return `${connection} ${setting} ${attached}`
}

/** At the turn's end: connect, only on a fresh "not connected" reading, then say whether it took. */
async function connectNow($: EngineInterface): Promise<void> {
  $.ui.status(undefined)
  let reading: Reading
  try {
    reading = await read($)
  } catch (err) {
    reading = { state: 'unknown', description: `no reading: ${why(err)}` }
  }
  if (reading.state === 'connected') {
    $.ui.toast('Remote Control was already connected; nothing ran.')
    return
  }
  if (reading.state !== 'not connected') {
    $.ui.toast(`Remote Control not connected: ${refusal(reading)}`)
    await tellModel($, `The Remote Control connect you queued did not run. ${refusal(reading)}`)
    return
  }
  try {
    await $.command.run({ command: 'remote-control' })
  } catch (err) {
    $.ui.toast(`Remote Control didn't connect: ${why(err)}`)
    await tellModel($, `The Remote Control connect you queued didn't run: ${why(err)}`)
    return
  }
  $.clock.after(CHECK_MS, () => void checkConnected($))
}

async function checkConnected($: EngineInterface): Promise<void> {
  const reading = await read($)
  if (reading.state === 'connected') {
    $.ui.toast('Remote Control connected.')
    return
  }
  $.ui.toast('Remote Control: the command ran, but the session does not read as connected yet.')
  await tellModel($, 'The remote-control command ran, but this session did not read as connected a few seconds later; check with remote_control status.')
}

export const register: Register = on => {
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
            enum: ['status', 'connect'],
            description: '`status` to report; `connect` to connect this session once the turn ends, if it is not connected.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    return started
  })

  on('tool.call', { tool: 'mcp__self-remote-control__remote_control' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: SUBAGENT }
    const action = (e as { action?: unknown }).action
    if (action === 'status') return { result: await status($) }
    if (action !== 'connect') return { deny: '`action` is `status` or `connect`.' }
    const reading = await read($)
    if (reading.state !== 'not connected') {
      return reading.state === 'connected' ? { result: refusal(reading) } : { deny: refusal(reading) }
    }
    await $.state.set(connectQueued, true)
    $.ui.status('Remote Control connects when this turn ends')
    return {
      result: 'Queued: Remote Control connects once this turn ends (it reads not connected now). The session checks again right before, and runs nothing if it is connected by then.',
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-remote-control: the call failed; nothing is queued.' }))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const { value } = await $.state.get(connectQueued)
    if (!value) return done
    await $.state.set(connectQueued, false)
    if (e.isAborted || e.reason !== 'answer') {
      $.ui.status(undefined)
      $.ui.toast("Remote Control connect cancelled: the turn didn't finish.")
      return done
    }
    $.clock.after(SETTLE_MS, () => void connectNow($))
    return done
  })
}
