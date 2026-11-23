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
//
// The compact reminder (#72, reminder.ts), off unless `compactReminder` sets context levels, adds one polite line to
// the session's next turn at a turn's end past a level, in case a session that finished a piece forgot to compact.
// compact_reminder (#76) sets a conversation's own levels in place of the setting's, or says where they stand.
import type { EngineInterface, Register } from 'claude-code'
import type { Queued } from '../types'
import { idleWords } from './at-idle'
import { configureMoving, moveBegins, startBegins } from './moving'
import { configureReminder, forgetReminded, MAX_LEVELS, NOTE_MAX, remind, reminderTool, sayWhyOff } from './reminder'
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
  idleWords(),
].join(' ')

/** compact_reminder: it answers at once and queues nothing, so it ends with no words about going idle. */
const REMINDER_DESCRIPTION = [
  "Sets this conversation's own compact reminder levels, in place of the compactReminder setting's, or says what they are now.",
  'The reminder is one polite line added to your next turn when the context window passes a level, pointing to compact_after_turn; nothing is required.',
  `\`levels\`: a comma-separated list of at most ${MAX_LEVELS}, each a percentage of the window (40%) or a token count (300k or 300000), such as "40%, 70%". "off" or "" drops this conversation's own levels, and the setting's stand again.`,
  'They last across a compaction, a restart and a resume of this conversation, and apply to no other.',
  `\`notes\` (optional, with \`levels\`): a note of your own for a level, one line of plain text (no angle brackets) of at most ${NOTE_MAX} characters, shown back to you with that level's reminder, such as {"60%": "write the notes file first"}.`,
  'Levels the window already stands past are marked reminded, with no line.',
  "In a process's first seconds (every new session included) and in the seconds after a /clear or a /resume, while the session's id may still name another conversation, it sets nothing and says how long to wait.",
  'With no arguments it says the levels, where they come from (this conversation or the setting), which have passed since the last compaction, and where the window stands.',
  'It answers at once and queues nothing.',
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
  // Its own compaction ran: every compact reminder level reminds again at its next passing.
  else await forgetReminded($)
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
  configureReminder(options.compactReminder)
  configureMoving()

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
    // Behind ToolSearch: a session sets its levels once in a while, and its name stays listed.
    await $.tool.register({
      name: 'compact_reminder',
      description: REMINDER_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          levels: {
            type: 'string',
            description: 'This conversation\'s own levels, such as "40%, 70%" or "300k"; "off" or "" goes back to the setting. Leave it out to see where the levels stand.',
          },
          notes: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: `With \`levels\`: a note of your own by level, as written in \`levels\`, one line of at most ${NOTE_MAX} characters each.`,
          },
        },
        additionalProperties: false,
      },
      isDeferred: true,
    })
    loadUpdateCheck($)
    await startBegins($)
    await sayWhyOff($, options.compactReminder)
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

  on('tool.call', { tool: 'mcp__self-compact__compact_reminder' }, async ($, e) => {
    if (e.agentId !== undefined) {
      return {
        deny: "A subagent has no reminder levels of its own: the levels and the window's reading are the main conversation's. A subagent compacts on its own near its context limit; to close a piece cleanly, finish it and return its result.",
      }
    }
    return reminderTool($, e as { levels?: unknown; notes?: unknown })
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'self-compact: reading or writing the reminder levels failed. Call compact_reminder with no arguments to see where they stand.' },
  )

  // A /clear or a /resume: the id may read the conversation left for a few seconds (moving.ts).
  on('session.end', async ($, e, next) => {
    await moveBegins($, e)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const { value } = await $.state.get(queued)
    if (!value) {
      // Nothing to compact: the compact reminder's moment, at a turn the model finished (an interrupted one is no break).
      if (!e.isAborted && e.reason === 'answer') await remind($)
      return done
    }
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
