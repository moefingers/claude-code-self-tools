// A session compacts itself as it closes one piece of work and moves to the next. The model calls
// compact_after_turn with what the summary must keep; compaction can't run while a turn does ($.session.compact
// rejects then), so the call is queued and runs once the turn has ended. An interrupted turn
// cancels it. Only the main conversation compacts this way, never a subagent. With `resume`, the
// session sends itself that message once compacted, a turn of its own; one per compaction, so a
// resumed turn compacts again only by calling the tool again.
//
// `when` (the owner's choice, given to the session): 'between-turns', the default, compacts from the turn's end
// itself, so it holds the session before a message queued during the turn can start its own; 'idle' waits a beat,
// as before, so anything queued goes first. Either way a turn that got there first puts it off to that turn's end.
// Compacting is the one step here Claude Code lets a plugin take between turns: a command (/exit, /clear,
// /resume, /reload-plugins, /mcp, /rename) is queued behind what is waiting, at the lowest priority.
import type { EngineInterface, Register } from 'claude-code'
import type { Queued } from '../types'
import { configureUpdateCheck, loadUpdateCheck, withUpdateNotice } from './update-check'

const queued = { plugin: 'self-compact', key: 'queued' } as const

/** A beat after the turn's end, so the turn is no longer running when compaction starts. */
const SETTLE_MS = 500

const DESCRIPTION = [
  'Compacts this conversation once the current turn ends, as /compact does, so the next piece of work starts with room to go deep.',
  'Call it when you are closing one piece of work in your area and moving to the next: the piece merged or handed off, and its notes written where your notes live.',
  'Never mid-piece, and never when the next step needs detail the summary would drop.',
  "`keep` is what the summary must hold on to: your area's open threads, PR numbers and heads, decisions, and where your notes are.",
  '`resume` is the message that starts your next turn once compacted: the next piece and where its details are.',
  'Give it whenever you have a next piece of your own, so the work goes on without a halt; leave it out only when the next step waits on someone else (the user, another session, a check).',
  "`when` chooses when it runs. 'between-turns' (the default) compacts right as this turn ends, ahead of anything queued meanwhile (a message typed during this turn, a background task's notification), which then runs on the compacted conversation: nothing is lost. If a turn queued during this one has started by then, it compacts at that turn's end instead.",
  "'idle' compacts half a second after a turn ends, and only if no turn has started by then, so anything queued goes first: under a nonstop stream of work and notifications that may be the distant future.",
  'End the turn after calling it; the compaction starts once your answer is shown.',
].join(' ')

/** When a compaction runs: as the turn ends (the default), or once the session is idle. */
const WHEN = ['between-turns', 'idle'] as const

/** What is queued: `resume` and `when` only when they say something, since stored state holds no undefined. */
const entry = (keep: string, resume: string | undefined, when?: Queued['when']): Queued => ({ keep, ...(resume === undefined ? {} : { resume }), ...(when === 'idle' ? { when } : {}) })

/** Trimmed text, or undefined when it is not a string or is blank. */
function text(raw: unknown): string | undefined {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed === '' ? undefined : trimmed
}

async function compactNow($: EngineInterface, { keep, resume, when }: Queued, retried = false): Promise<void> {
  $.ui.status(undefined)
  let skipped: string | undefined
  try {
    const done = await $.session.compact({ instructions: keep })
    skipped = done.skip
  } catch {
    // Between turns, the engine may still count the turn as running: once more, a beat later, as 'idle' would.
    if (when !== 'idle' && !retried) {
      $.clock.after(SETTLE_MS, () => void compactNow($, entry(keep, resume, when), true))
      return
    }
    // A turn started first (a queued message): run it when that turn ends.
    await $.state.set(queued, entry(keep, resume, when))
    $.ui.status('compaction queued for when this turn ends')
    return
  }
  if (skipped !== undefined) $.ui.toast(`Compaction skipped: ${skipped}`)
  if (resume === undefined) return
  const said = skipped === undefined ? 'Compacted.' : `Compaction was skipped (${skipped}).`
  try {
    const sent = await $.prompt.submit({ text: `${said} Resume: ${resume}` })
    if (sent.drop !== undefined) $.ui.toast(`Resume not sent: ${sent.drop}`)
  } catch {
    $.ui.toast('Resume not sent; the session waits for the next message.')
  }
}

export const register: Register = (on, options) => {
  configureUpdateCheck('self-compact', options)

  // First, so it is outermost on this plugin's tools: it sees each answer, and adds the update
  // notice when one is due. It never waits on the check; see update-check.ts.
  on('tool.call', { tool: /^mcp__self-compact__/ }, async ($, e, next) => withUpdateNotice($, e, await next(e))).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'compact_after_turn',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          keep: { type: 'string', description: 'What the summary must keep, as typed after /compact.' },
          resume: {
            type: 'string',
            description:
              'The message that starts your next turn once compacted: the next piece and where its details are. Leave it out only when the next step waits on someone else.',
          },
          when: {
            type: 'string',
            enum: [...WHEN],
            description:
              "'between-turns' (the default): as this turn ends, ahead of anything queued meanwhile, which then runs on the compacted conversation. 'idle': only at a turn's end that no turn follows within half a second; under a nonstop stream of work and notifications that may be the distant future.",
          },
        },
        required: ['keep'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    loadUpdateCheck($)
    return started
  })

  on('tool.call', { tool: 'mcp__self-compact__compact_after_turn' }, async ($, e) => {
    if (e.agentId !== undefined) {
      return {
        deny:
          "A subagent can't compact on demand; it compacts on its own near its context limit. To close a piece cleanly, finish it and return its result: the lead starts a fresh agent for the next piece.",
      }
    }
    const input = e as { keep?: unknown; resume?: unknown; when?: unknown }
    const keep = text(input.keep)
    if (keep === undefined) return { deny: 'Say what the summary must keep (`keep`).' }
    if (input.when !== undefined && !(WHEN as readonly unknown[]).includes(input.when)) return { deny: "`when` is 'between-turns' (the default) or 'idle'." }
    const when = input.when === 'idle' ? 'idle' : undefined
    const resume = text(input.resume)
    await $.state.set(queued, entry(keep, resume, when))
    $.ui.status('compaction queued for when this turn ends')
    const then = resume === undefined ? 'then waits for the next message' : `then resumes with: ${resume}`
    const at = when === 'idle' ? 'once the session is idle after this turn' : 'as this turn ends, ahead of anything queued meanwhile'
    return { result: `Queued. This conversation compacts ${at}, keeping: ${keep}. It ${then}` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-compact: queuing the compaction failed; nothing is queued.' }))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const { value } = await $.state.get(queued)
    if (!value) return done
    await $.state.set(queued, null)
    if (e.isAborted || e.reason !== 'answer') {
      $.ui.status(undefined)
      $.ui.toast("Compaction cancelled: the turn didn't finish.")
      return done
    }
    // Between turns: now, in the turn's end itself, before a queued message's turn can take the session (the
    // compaction holds it while it runs). When idle: a beat later, so whatever is queued goes first.
    if (value.when === 'idle') $.clock.after(SETTLE_MS, () => void compactNow($, value))
    else void compactNow($, value)
    return done
  })
}
