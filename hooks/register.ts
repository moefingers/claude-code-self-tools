// A session compacts itself as it closes one piece of work and moves to the next. The model calls
// compact_after_turn with what the summary must keep; compaction can't run while a turn does ($.session.compact
// rejects then), so the call is queued and runs once the turn has ended. An interrupted turn
// cancels it. Only the main conversation compacts this way, never a subagent. With `resume`, the
// session sends itself that message once compacted, a turn of its own; one per compaction, so a
// resumed turn compacts again only by calling the tool again.
import type { EngineInterface, Register } from 'claude-code'
import type { Queued } from '../types'

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
  'End the turn after calling it; the compaction starts once your answer is shown.',
].join(' ')

/** What is queued: `resume` only when there is one, since stored state holds no undefined. */
const entry = (keep: string, resume: string | undefined): Queued => (resume === undefined ? { keep } : { keep, resume })

/** Trimmed text, or undefined when it is not a string or is blank. */
function text(raw: unknown): string | undefined {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed === '' ? undefined : trimmed
}

async function compactNow($: EngineInterface, { keep, resume }: Queued): Promise<void> {
  $.ui.status(undefined)
  let skipped: string | undefined
  try {
    const done = await $.session.compact({ instructions: keep })
    skipped = done.skip
  } catch {
    // A turn started first (a queued message): run it when that turn ends.
    await $.state.set(queued, entry(keep, resume))
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

export const register: Register = on => {
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
        },
        required: ['keep'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    return started
  })

  on('tool.call', { tool: 'mcp__self-compact__compact_after_turn' }, async ($, e) => {
    if (e.agentId !== undefined) {
      return {
        deny:
          "A subagent can't compact on demand; it compacts on its own near its context limit. To close a piece cleanly, finish it and return its result: the lead starts a fresh agent for the next piece.",
      }
    }
    const input = e as { keep?: unknown; resume?: unknown }
    const keep = text(input.keep)
    if (keep === undefined) return { deny: 'Say what the summary must keep (`keep`).' }
    const resume = text(input.resume)
    await $.state.set(queued, entry(keep, resume))
    $.ui.status('compaction queued for when this turn ends')
    const then = resume === undefined ? 'then waits for the next message' : `then resumes with: ${resume}`
    return { result: `Queued. This conversation compacts once this turn ends, keeping: ${keep}. It ${then}` }
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
    $.clock.after(SETTLE_MS, () => void compactNow($, value))
    return done
  })
}
