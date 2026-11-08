// A session ends itself once the current turn ends, as /exit does. The model calls exit_after_turn
// with `reason`, required, since an exit is irreversible for the session: nothing runs here again
// until someone resumes it. A command can't run while the turn the model is in waits on it, so the
// call is queued and the exit runs once the turn has ended with an answer. An interrupted turn
// cancels it. Only the main conversation exits this way, never a subagent, and only a session a
// person runs at a prompt: a -p run or an SDK host ends the session itself.
//
// The reason is logged twice before the command runs: as a row of the conversation, which the model
// reads when the session is resumed (`claude --resume`), together with the optional `note` for
// whoever resumes it; and as a transcript line the person sees, which the debug log keeps too.
//
// The pre-check (exitBlockers, in the shared machine code): it refuses while anything would make /exit
// stop at its confirmation, or end work still running: a session cron (the built-in CronList, read
// through $.tool.call once $.tool.check allows it, so never a dialog), a background job under the
// session (the probe's S6, on Windows), a subagent, a wake-up pending with self-wake (its marker;
// self-wake on with one that can't be read holds too). Each is named with how to stop it.
// Anything it can't read refuses too, saying so. It runs at the call, so nothing is queued while a
// blocker stands, and again when the exit is armed, right before the command.
//
// The pending marker: while the exit is queued or armed, %LOCALAPPDATA%\claude-self-tools\pending\
// <conversation>.json says so ({ v: 1, kind: 'exit', at }), and the coordinator holds its deliveries
// meanwhile, so that none starts a turn that would cancel the exit. It says done ({ v: 1, done: true })
// once the exit runs or is cancelled.
//
// The command waits for the session to be idle, so a message that arrives between the turn's end and
// the command would start a turn the exit then cuts off. A main-loop turn that starts before the
// command has started cancels the exit, as an interrupted turn does.
import type { EngineInterface, Register } from 'claude-code'
import type { Queued } from '../types'
import { blockersText, exitBlockers, isSafeFolder, markPending, powershellPath, readExit, SESSION_ID, stateFolder, SYSTEM_ROOT } from './machine'
import type { PendingKind } from './machine'
import { configureUpdateCheck, loadUpdateCheck, withUpdateNotice } from './update-check'

const queued = { plugin: 'self-exit', key: 'queued' } as const

/**
 * When the step starts after the turn's end: at once, the moment the turn's end returns, so its command is queued
 * ahead of anything that arrives after (the owner's A). The 500 ms beat once copied here from self-compact (where
 * compacting rejects while a turn still runs) guarded nothing for a command: $.command.run queues it either way,
 * and a turn that starts before it runs takes it back (turn.start), as before.
 */
const TURN_END_MS = 0
/** How long after the exit command to look whether the session is still here. */
const CHECK_MS = 5000

const DESCRIPTION = [
  'Ends this session once the current turn ends, as /exit does: Claude Code closes, and nothing more happens here until someone resumes the session (claude --resume).',
  'Call it only when the person asked you to end the session, or your instructions say to close it once its work is done or handed off. Only at a finished break: never mid-merge, mid-push or mid-task. Never to get out of a task, and not to restart (restart_after_turn, if it is available, does that).',
  '`reason` (required) says why; it is recorded in the transcript. `note` is for whoever resumes this session: what was left, and where its notes are. Write your notes down first.',
  "It refuses while anything would make /exit stop at its confirmation or cut work off, naming each with how to stop it: a session cron (delete it with CronDelete), a background Bash, PowerShell or Monitor job (stop it with TaskStop), a subagent still running, a wake-up from wake_after still pending (cancel it with cancel_wake); and while any of that can't be read. Stop them, then call again.",
  'What still ends with the session: Remote Control (the phone and browser lose the session).',
  "It can run only when the session is idle: Claude Code queues a plugin's command behind anything already waiting (a message typed during this turn, a background task's notification) and has no slot between turns ahead of them. A turn that starts first cancels the exit, and you are told, so nothing waiting is lost or carried into another conversation; under a nonstop stream of work and notifications it may not run for a long time, so call it again when the stream pauses.",
  'After calling it, end your turn and do nothing more until it has run.',
].join(' ')

const SUBAGENT =
  "A subagent can't end the session. Finish your piece and return its result, saying the session can close: the main session can exit."

/** Whether a person is at this session's prompt; read at each session.start. */
let isInteractive = true

/**
 * The exit the last turn's end armed, until its command starts; a main-loop turn that starts first
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

/** What is queued: `note` only when there is one, since stored state holds no undefined. */
const entry = (reason: string, note: string | undefined): Queued => (note === undefined ? { reason } : { reason, note })

/** Tells the model on its next turn, in a row it reads and the person doesn't see as typed. */
async function tellModel($: EngineInterface, note: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
  } catch {
    // The toast has told the person; there is no other way to reach the model.
  }
}

/**
 * A variable of this process's environment, or undefined when unset or unreadable. `read` is the
 * engine's read with the variable's name written out: the engine lists the variables a module reads by
 * the literal names at its call sites.
 */
async function env(read: () => Promise<string | undefined>): Promise<string | undefined> {
  try {
    return await read()
  } catch {
    return undefined
  }
}

/**
 * Where the probe runs from: Windows PowerShell by its known path, for this session's id. Undefined
 * off Windows, where there is no probe; on Windows, a string says why it can't run, which refuses.
 */
async function probeTarget($: EngineInterface): Promise<{ powershell: string; id: string } | string | undefined> {
  if ((await env(() => $.env.get('OS'))) !== 'Windows_NT') return undefined
  const root = await env(() => $.env.get('SystemRoot'))
  if (root === undefined || !SYSTEM_ROOT.test(root)) return `the Windows folder (SystemRoot) reads ${JSON.stringify(root ?? '')}, so PowerShell can't be found by its known path`
  let id: string
  try {
    id = await $.session.id()
  } catch (err) {
    return `this session's id can't be read: ${why(err)}`
  }
  if (!SESSION_ID.test(id)) return `this session's id (${JSON.stringify(id)}) is not a session id`
  return { powershell: powershellPath(root), id }
}

/** What stands in the exit's way now, each with how to stop it, as one line; undefined when nothing does. */
async function blockers($: EngineInterface): Promise<string | undefined> {
  const target = await probeTarget($)
  // This conversation's wake-up, by self-wake's marker: only where there are markers at all.
  const local = await env(() => $.env.get('LOCALAPPDATA'))
  const wake = typeof target === 'object' && isSafeFolder(local) ? { wake: { state: stateFolder(local), id: target.id } } : {}
  const found = exitBlockers(await readExit($, target, wake))
  return found.length === 0 ? undefined : blockersText(found)
}

/** The pending marker: `kind` while the exit is queued or armed, null once it ran or was cancelled. */
async function mark($: EngineInterface, kind: PendingKind | null): Promise<void> {
  const failed = await markPending($, kind)
  if (failed !== undefined) $.ui.log(`the pending marker wasn't written (${failed}); the coordinator ignores an old one after 15 minutes.`)
}

/**
 * The row the model reads when the session is resumed: why it asked to end, and the note. Written before /exit
 * runs, so it says what was asked, never that it ended: in a background session (/background) /exit leaves the
 * session running, and the row is read there too.
 */
const record = ({ reason, note }: Queued): string =>
  `This session asked to end here (exit_after_turn). Reason: ${reason}${note === undefined ? '' : ` Note for whoever resumes it: ${note}`}`

/** Logs the reason, then runs the exit; says so when it didn't run, or the session is still here after it. */
async function exitNow($: EngineInterface, value: Queued): Promise<void> {
  if (armed !== value) return
  $.ui.status(undefined)
  // The pre-check again, right before the command: anything set since the call holds it.
  const stop = await blockers($)
  // A turn that started while the check above ran has taken it back, and said so.
  if (armed !== value) return
  if (stop !== undefined) {
    armed = undefined
    await mark($, null)
    $.ui.toast(`Exit cancelled: ${stop}.`)
    await tellModel($, `The exit you queued didn't run: ${stop}. The session goes on; stop them, then call exit_after_turn again.`)
    return
  }
  armed = undefined
  await tellModel($, record(value))
  $.ui.log(`Exiting at the session's own request: ${value.reason}`)
  $.ui.toast(`Exiting: ${value.reason}`)
  // Done as the exit runs: the coordinator delivers again, to whoever resumes the conversation.
  await mark($, null)
  try {
    await $.command.run({ command: 'exit' })
  } catch (err) {
    $.ui.toast(`Exit didn't run: ${why(err)}`)
    await tellModel($, `The exit you queued didn't run: ${why(err)}. The session goes on.`)
    return
  }
  // An exit that took ends this module with the session, and this never fires.
  $.clock.after(CHECK_MS, () => {
    $.ui.toast('The exit ran, but the session is still open.')
    void tellModel($, 'The exit you queued ran, but the session is still open (a dialog may have been answered no). It goes on.')
  })
}

export const register: Register = (on, options) => {
  configureUpdateCheck('self-exit', options)

  // First, so it is outermost on this plugin's tools: it sees each answer, and adds the update
  // notice when one is due. It never waits on the check; see update-check.ts.
  on('tool.call', { tool: /^mcp__self-exit__/ }, async ($, e, next) => withUpdateNotice($, e, await next(e))).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    isInteractive = e.isInteractive
    await $.tool.register({
      name: 'exit_after_turn',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the session ends: who asked, or what is done. Recorded in the transcript.' },
          note: {
            type: 'string',
            description: 'For whoever resumes this session: what was left, and where its notes are. Leave it out when there is nothing to pick up.',
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

  on('tool.call', { tool: 'mcp__self-exit__exit_after_turn' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: SUBAGENT }
    const input = e as { reason?: unknown; note?: unknown }
    const reason = text(input.reason)
    if (reason === undefined) return { deny: 'Say why the session ends (`reason`); it is recorded in the transcript.' }
    if (!isInteractive) return { deny: 'This session has no one at its prompt (a -p run or an SDK host), which ends it by itself; nothing to exit.' }
    // The pre-check at the call: nothing is queued while anything stands.
    const stop = await blockers($)
    if (stop !== undefined) {
      return { deny: `Not queued: ${stop}. Each would make /exit stop at its confirmation, or end with the session: stop them, then call again.` }
    }
    const note = text(input.note)
    await $.state.set(queued, entry(reason, note))
    await mark($, 'exit')
    $.ui.status('exit queued for when this turn ends')
    const kept = note === undefined ? '' : ' The note goes in with it, for whoever resumes the session.'
    return {
      result: `Queued. This session exits once this turn ends; the reason is recorded in the transcript: ${reason}.${kept} Remote Control ends with it. Right before the exit it checks again for session crons, background jobs, subagents and a pending wake-up.`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-exit: queuing the exit failed; nothing is queued.' }))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const { value } = await $.state.get(queued)
    if (!value) return done
    await $.state.set(queued, null)
    if (e.isAborted || e.reason !== 'answer') {
      $.ui.status(undefined)
      $.ui.toast("Exit cancelled: the turn didn't finish.")
      await mark($, null)
      return done
    }
    armed = value
    await mark($, 'exit')
    $.clock.after(TURN_END_MS, () => void exitNow($, value))
    return done
  })

  // A message that starts a turn before the exit's command has started takes the exit back.
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (e.agentId !== undefined || armed === undefined) return started
    armed = undefined
    $.ui.status(undefined)
    $.ui.toast('Exit cancelled: a new turn started before it ran.')
    void mark($, null)
    void tellModel($, "The exit you queued didn't run: a new turn started before it could. The session goes on; call exit_after_turn again when the work is done.")
    return started
  })
}
