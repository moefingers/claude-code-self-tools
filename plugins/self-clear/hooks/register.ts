// A session clears its own conversation between two independent pieces of work, as /clear does, and
// starts the next piece from a handoff it wrote. The model calls clear_after_turn with `handoff`,
// required, since a clear keeps nothing else; a command can't run while the turn the model is in
// waits on it, so the call is queued and the clear runs once the turn has ended with an answer. An
// interrupted turn cancels it. Only the main conversation clears this way, never a subagent.
//
// A /clear ends the conversation and the process goes on under a new session id; no session.start
// fires for it, so this module, its timers and its tools stay as they are. The continuation that ran
// the command sends the handoff as the cleared conversation's first prompt. It reads the session id
// before and after: an id that didn't change means the clear didn't take (a dialog the person
// answered no, a hook that refused it), and then the handoff is not sent as if it had.
//
// It refuses while a subagent is running: its result would come back to a conversation that no
// longer knows why it asked. That is checked at the call and again right before the command runs.
//
// The command waits for the session to be idle, so a message that arrives between the turn's end and
// the command would start a turn the clear then wipes. A main-loop turn that starts before the
// command has started cancels the clear, as an interrupted turn does.
import type { EngineInterface, Register } from 'claude-code'
import type { Queued } from '../types'
import { configureUpdateCheck, loadUpdateCheck, withUpdateNotice } from './update-check'

const queued = { plugin: 'self-clear', key: 'queued' } as const

/** A beat after the turn's end, so the turn is no longer running when the clear starts. */
const SETTLE_MS = 500

/** An agent in one of these is still to report. */
const BUSY: readonly string[] = ['pending', 'running', 'waiting']

const DESCRIPTION = [
  'Clears this conversation once the current turn ends, as /clear does: the context starts empty, and `handoff` is the first prompt it reads.',
  'Irreversible: nothing of this conversation is kept but `handoff` and what you wrote down. Before calling it, write what the next piece needs where your notes live (memory, files, the PR), and say where in `handoff`.',
  'Call it only between two independent pieces of work, when the next piece needs nothing of this conversation; never mid-task.',
  'When the next piece builds on this one, compact instead (compact_after_turn, if it is available), which keeps a summary.',
  'It refuses while subagents you started are still running. Background tasks you started report into the cleared conversation, which no longer knows why it asked: let them finish first.',
  'End the turn after calling it; the clear runs once your answer is shown.',
].join(' ')

const SUBAGENT =
  "A subagent can't clear the session's conversation. Finish your piece and return its result, saying the next piece can start from a cleared context: the main session can clear."

/**
 * The clear the last turn's end armed, until its command starts; a main-loop turn that starts first
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

/** Why a clear can't go ahead with these agents, or undefined when none is still to report. */
function blocked(busy: string[] | undefined): string | undefined {
  if (busy === undefined) return "the session's subagents can't be read, so whether any is still running is unknown"
  if (busy.length === 0) return undefined
  return `${busy.length === 1 ? 'a subagent is' : `${busy.length} subagents are`} still running (${busy.join('; ')}), and ${busy.length === 1 ? 'its result' : 'their results'} would come back to a conversation that no longer knows why it asked`
}

/** The session's id, or undefined when it can't be read. */
async function sessionId($: EngineInterface): Promise<string | undefined> {
  try {
    return await $.session.id()
  } catch {
    return undefined
  }
}

/** Runs the clear, then sends the handoff as the cleared conversation's first prompt. */
async function clearNow($: EngineInterface, value: Queued): Promise<void> {
  if (armed !== value) return
  const { handoff } = value
  $.ui.status(undefined)
  const stop = blocked(await busyAgents($))
  if (stop !== undefined) {
    $.ui.toast(`Clear cancelled: ${stop}.`)
    await tellModel($, `The clear you queued didn't run: ${stop}. The conversation is as it was; call clear_after_turn again once they have reported.`)
    return
  }
  const before = await sessionId($)
  // A turn that started while the checks above ran has taken it back, and said so.
  if (armed !== value) return
  armed = undefined
  try {
    await $.command.run({ command: 'clear' })
  } catch (err) {
    $.ui.toast(`Clear didn't run: ${why(err)}`)
    await tellModel($, `The clear you queued didn't run: ${why(err)}. The conversation is as it was, and the handoff was not sent.`)
    return
  }
  const after = await sessionId($)
  if (before !== undefined && after === before) {
    $.ui.toast("Clear didn't take: the session is still the same one.")
    await tellModel(
      $,
      `The clear you queued ran but didn't take (the session's id is unchanged), so the conversation is as it was, and the handoff was not sent. It was: ${handoff}`,
    )
    return
  }
  $.ui.toast('Conversation cleared; the handoff is its first prompt.')
  const prompt = `Context cleared at your own request (clear_after_turn). Handoff: ${handoff}`
  try {
    const sent = await $.prompt.submit({ text: prompt })
    if (sent.drop === undefined) return
    $.ui.toast(`Handoff not sent: ${sent.drop}. It waits as a note for the next message.`)
  } catch {
    $.ui.toast('Handoff not sent; it waits as a note for the next message.')
  }
  // Not lost: the cleared conversation reads it on its next turn.
  await tellModel($, prompt)
}

export const register: Register = (on, options) => {
  configureUpdateCheck('self-clear', options)

  // First, so it is outermost on this plugin's tools: it sees each answer, and adds the update
  // notice when one is due. It never waits on the check; see update-check.ts.
  on('tool.call', { tool: /^mcp__self-clear__/ }, async ($, e, next) => withUpdateNotice($, e, await next(e))).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'clear_after_turn',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          handoff: {
            type: 'string',
            description:
              'The first prompt of the cleared conversation, which knows nothing else: the next piece of work, where its notes and details are, and anything it must not redo.',
          },
        },
        required: ['handoff'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    loadUpdateCheck($)
    return started
  })

  on('tool.call', { tool: 'mcp__self-clear__clear_after_turn' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: SUBAGENT }
    const handoff = text((e as { handoff?: unknown }).handoff)
    if (handoff === undefined) {
      return { deny: 'Say what the cleared conversation starts from (`handoff`): the next piece of work and where its notes are. A clear keeps nothing else.' }
    }
    const stop = blocked(await busyAgents($))
    if (stop !== undefined) return { deny: `Not queued: ${stop}. Wait for them to report, or stop them, then call again.` }
    await $.state.set(queued, { handoff })
    $.ui.status('clear queued for when this turn ends')
    return {
      result: `Queued. This conversation clears once this turn ends, and nothing of it is kept but the handoff, which is the first prompt after the clear: ${handoff}`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-clear: queuing the clear failed; nothing is queued.' }))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const { value } = await $.state.get(queued)
    if (!value) return done
    await $.state.set(queued, null)
    if (e.isAborted || e.reason !== 'answer') {
      $.ui.status(undefined)
      $.ui.toast("Clear cancelled: the turn didn't finish.")
      return done
    }
    armed = value
    $.clock.after(SETTLE_MS, () => void clearNow($, value))
    return done
  })

  // A message that starts a turn before the clear's command has started takes the clear back.
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (e.agentId !== undefined || armed === undefined) return started
    armed = undefined
    $.ui.status(undefined)
    $.ui.toast('Clear cancelled: a new turn started before it ran.')
    void tellModel($, "The clear you queued didn't run: a new turn started before it could. The conversation is as it was; call clear_after_turn again at the next break.")
    return started
  })
}
