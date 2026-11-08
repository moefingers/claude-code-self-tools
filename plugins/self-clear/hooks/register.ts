// A session clears its own conversation, as /clear does, and starts the next piece from a handoff it
// wrote; only when its work is complete or its context is contaminated. The model calls
// clear_after_turn with `why` and `handoff`, both required: a clear loses the session's memory of the
// whole story, which compacting (self-compact) keeps a summary of and a restart (self-restart) keeps
// whole, so `why` must be 'complete' or 'contaminated', or the call is refused and nothing is queued;
// and the handoff is all the cleared conversation has. A command can't run while the turn the model is
// in waits on it, so the call is queued and the clear runs once the turn has ended with an answer. An
// interrupted turn cancels it. Only the main conversation clears this way, never a subagent.
//
// Before the command, a leaving row (the conversation's last) records why it was cleared and the
// handoff, for whoever reads or resumes it later; the toast says why too.
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
import type { Queued, Why } from '../types'
import { configureUpdateCheck, loadUpdateCheck, withUpdateNotice } from './update-check'

const queued = { plugin: 'self-clear', key: 'queued' } as const

/** A beat after the turn's end, so the turn is no longer running when the clear starts. */
const SETTLE_MS = 500

/**
 * An agent in one of these has ended. Every other status is still to report: `pending`, `running`,
 * `waiting`, `idle` (a teammate between turns, whose work a clear cuts from its context without a word),
 * and any status a later Claude Code adds, so an unknown one holds rather than passes. As isBusyAgent in
 * the machine code the other plugins share (this plugin carries none of it).
 */
const AGENT_DONE: readonly string[] = ['completed', 'failed', 'killed']

/** An agent in one of these reports on its own. Any other that holds says how to clear it: TaskStop. */
const AT_WORK: readonly string[] = ['pending', 'running', 'waiting']

/** The two reasons a clear is for, and how the leaving row and the toast say each. */
const WHY: Readonly<Record<Why, string>> = {
  complete: 'its work is complete',
  contaminated: 'its context was contaminated',
}

/** Whether `raw` is one of the two reasons, exactly. */
const isWhy = (raw: unknown): raw is Why => raw === 'complete' || raw === 'contaminated'

/** Why a clear without one of the two reasons is refused, and what to do instead. */
const NOT_WHY =
  "A clear loses this session's memory of the whole story. Compact instead (compact_after_turn), or restart into the same conversation (restart_after_turn). Clear only when the work is complete (why: 'complete') or the context is contaminated (why: 'contaminated'), with the notes named in handoff."

const DESCRIPTION = [
  "Prefer compact_after_turn, which keeps a summary of this conversation, or restart_after_turn, which gives a fresh process and resumes this same conversation: a clear loses this session's memory of the whole story.",
  'Clears this conversation once the current turn ends, as /clear does: the context starts empty, and `handoff` is the first prompt it reads.',
  "Only when `why` is 'complete' (the work is done, and its notes are written down) or 'contaminated' (what this context holds misleads the work); any other call is refused, and nothing is queued.",
  'Irreversible: nothing of this conversation is kept but `handoff` and what you wrote down. Before calling it, write what the next piece needs where your notes live (memory, files, the PR), and say where in `handoff`. Never mid-task.',
  'It refuses while subagents you started are still running. Background tasks you started report into the cleared conversation, which no longer knows why it asked: let them finish first.',
  "It can run only when the session is idle: Claude Code queues a plugin's command behind anything already waiting (a message typed during this turn, a background task's notification) and has no slot between turns ahead of them. A turn that starts first cancels the clear, and you are told, so nothing waiting is lost or carried into another conversation; under a nonstop stream of work and notifications it may not run for a long time, so call it again when the stream pauses.",
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
    return (await $.agent.list())
      .filter(a => !AGENT_DONE.includes(a.status))
      .map(a => {
        const name = a.description.trim() === '' ? a.type : a.description
        return AT_WORK.includes(a.status) ? name : `${name}: ${a.status}, so it won't report on its own: stop it with TaskStop`
      })
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

/** The leaving row, the conversation's last before the clear: why it was cleared, and the handoff. */
const leaving = ({ why: reason, handoff }: Queued): string =>
  `This conversation was cleared at its own request (clear_after_turn), because ${WHY[reason]} (why: ${reason}). The cleared conversation starts from the handoff: ${handoff}`

/** Runs the clear, then sends the handoff as the cleared conversation's first prompt. */
async function clearNow($: EngineInterface, value: Queued): Promise<void> {
  if (armed !== value) return
  const { handoff, why: reason } = value
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
  await tellModel($, leaving(value))
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
  $.ui.toast(`Conversation cleared because ${WHY[reason]}; the handoff is its first prompt.`)
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
          why: {
            type: 'string',
            enum: ['complete', 'contaminated'],
            description:
              "Why this conversation clears: 'complete' (its work is done, and its notes are written down) or 'contaminated' (what this context holds misleads the work). Nothing else clears: compact or restart instead.",
          },
          handoff: {
            type: 'string',
            description:
              'The first prompt of the cleared conversation, which knows nothing else: the next piece of work, where its notes and details are, and anything it must not redo.',
          },
        },
        required: ['why', 'handoff'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    loadUpdateCheck($)
    return started
  })

  on('tool.call', { tool: 'mcp__self-clear__clear_after_turn' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: SUBAGENT }
    const input = e as { why?: unknown; handoff?: unknown }
    // Checked at the call, exactly: nothing is queued for a clear that isn't one of the two.
    if (!isWhy(input.why)) return { deny: NOT_WHY }
    const reason = input.why
    const handoff = text(input.handoff)
    if (handoff === undefined) {
      return { deny: 'Say what the cleared conversation starts from (`handoff`): the next piece of work and where its notes are. A clear keeps nothing else.' }
    }
    const stop = blocked(await busyAgents($))
    if (stop !== undefined) return { deny: `Not queued: ${stop}. Wait for them to report, or stop them, then call again.` }
    await $.state.set(queued, { why: reason, handoff })
    $.ui.status('clear queued for when this turn ends')
    return {
      result: `Queued (why: ${reason}). This conversation clears once this turn ends, and nothing of it is kept but the handoff, which is the first prompt after the clear: ${handoff}`,
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
    // A clear queued before `why` was required (an older copy of this plugin, reloaded mid-turn).
    if (!isWhy(value.why)) {
      $.ui.status(undefined)
      $.ui.toast('Clear cancelled: it was queued without a why.')
      await tellModel($, `The clear you queued didn't run: it was queued without a why. ${NOT_WHY}`)
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
