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
// It refuses while a subagent is running, whose work would end with the session; checked at the
// call and again right before the command runs. Background tasks can't be listed, so the
// description warns about them.
import type { EngineInterface, Register } from 'claude-code'
import type { Queued } from '../types'
import { configureUpdateCheck, loadUpdateCheck, withUpdateNotice } from './update-check'

const queued = { plugin: 'self-exit', key: 'queued' } as const

/** A beat after the turn's end, so the turn is no longer running when the exit starts. */
const SETTLE_MS = 500
/** How long after the exit command to look whether the session is still here. */
const CHECK_MS = 5000

/** An agent in one of these is still to report. */
const BUSY: readonly string[] = ['pending', 'running', 'waiting']

const DESCRIPTION = [
  'Ends this session once the current turn ends, as /exit does: Claude Code closes, and nothing more happens here until someone resumes the session (claude --resume).',
  'Call it only when the person asked you to end the session, or your instructions say to close it once its work is done or handed off. Never to get out of a task, and not to restart (restart_after_turn, if it is available, does that).',
  '`reason` (required) says why; it is recorded in the transcript. `note` is for whoever resumes this session: what was left, and where its notes are. Write your notes down first.',
  'Everything the session runs ends with it: Remote Control (the phone and browser lose the session), wake-ups, background tasks. It refuses while subagents you started are still running.',
  'End the turn after calling it; the exit runs once your answer is shown.',
].join(' ')

const SUBAGENT =
  "A subagent can't end the session. Finish your piece and return its result, saying the session can close: the main session can exit."

/** Whether a person is at this session's prompt; read at each session.start. */
let isInteractive = true

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

/** The agents still to report, by their task's description; undefined when the list can't be read. */
async function busyAgents($: EngineInterface): Promise<string[] | undefined> {
  try {
    return (await $.agent.list()).filter(a => BUSY.includes(a.status)).map(a => (a.description.trim() === '' ? a.type : a.description))
  } catch {
    return undefined
  }
}

/** Why an exit can't go ahead with these agents, or undefined when none is still to report. */
function blocked(busy: string[] | undefined): string | undefined {
  if (busy === undefined) return "the session's subagents can't be read, so whether any is still running is unknown"
  if (busy.length === 0) return undefined
  return `${busy.length === 1 ? 'a subagent is' : `${busy.length} subagents are`} still running (${busy.join('; ')}), and ${busy.length === 1 ? 'its work' : 'their work'} would end with the session`
}

/** The row the model reads when the session is resumed: why it ended, and the note. */
const record = ({ reason, note }: Queued): string =>
  `This session ended at its own request (exit_after_turn). Reason: ${reason}${note === undefined ? '' : ` Note for whoever resumes it: ${note}`}`

/** Logs the reason, then runs the exit; says so when it didn't run, or the session is still here after it. */
async function exitNow($: EngineInterface, value: Queued): Promise<void> {
  $.ui.status(undefined)
  const stop = blocked(await busyAgents($))
  if (stop !== undefined) {
    $.ui.toast(`Exit cancelled: ${stop}.`)
    await tellModel($, `The exit you queued didn't run: ${stop}. The session goes on; call exit_after_turn again once they have reported.`)
    return
  }
  await tellModel($, record(value))
  $.ui.log(`Exiting at the session's own request: ${value.reason}`)
  $.ui.toast(`Exiting: ${value.reason}`)
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
    const stop = blocked(await busyAgents($))
    if (stop !== undefined) return { deny: `Not queued: ${stop}. Wait for them to report, or stop them, then call again.` }
    const note = text(input.note)
    await $.state.set(queued, entry(reason, note))
    $.ui.status('exit queued for when this turn ends')
    const kept = note === undefined ? '' : ' The note goes in with it, for whoever resumes the session.'
    return {
      result: `Queued. This session exits once this turn ends; the reason is recorded in the transcript: ${reason}.${kept} Remote Control, wake-ups and background tasks end with it.`,
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
      return done
    }
    $.clock.after(SETTLE_MS, () => void exitNow($, value))
    return done
  })
}
