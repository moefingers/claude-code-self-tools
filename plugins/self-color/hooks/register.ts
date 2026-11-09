// A session sets its own prompt bar color once the current turn ends, as `/color <color>` does, to mark
// its role so the person can tell sessions apart at a glance. The model calls color_after_turn; a
// command can't run while the turn the model is in waits on it, so the call is queued and /color runs
// once the turn has ended with an answer. An interrupted turn cancels it. Only the main conversation
// sets it this way, never a subagent.
//
// /color with an argument sets the color and prints one line, with no picker; with none it picks a
// color at random, so the plugin always passes one, from the list the call checked. The color lasts
// for the session, and `default` resets it. A change that runs late does no harm, and it has no resume
// that a person's message could make stale, so it runs whatever came between. What is queued lives for
// one turn: the turn's end takes it and clears it, and the run holds it in memory, so a /clear or a
// /resume emptying the plugin's state never strands it.
import type { EngineInterface, Register } from 'claude-code'
import type { Color, Queued } from '../types'
import { configureUpdateCheck, loadUpdateCheck, withUpdateNotice } from './update-check'

const queued = { plugin: 'self-color', key: 'queued' } as const

/**
 * When /color starts after the turn's end: at once, the moment the turn's end returns, as self-reload, self-mcp and
 * self-remote-control's rename do. Input already waiting when the turn ended still runs first, since Claude Code queues
 * a plugin's command behind it; the color then changes after that input's turn.
 */
const TURN_END_MS = 0

/** The colors /color takes: Claude Code's own list (2.1.319), and `default`, which resets the prompt bar. */
const COLORS: readonly Color[] = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan', 'default']

/** The colors as a sentence lists them. */
const LISTED = `${COLORS.slice(0, -1).join(', ')}, or ${COLORS[COLORS.length - 1]}`

const DESCRIPTION = [
  "Sets this session's prompt bar color once the current turn ends, as /color does.",
  'Use it to mark the session\'s role, so the person can tell sessions apart at a glance: for example, one color for a merger and another for a worker.',
  'The color lasts for the session; `default` resets it.',
  "It runs once the session is idle, after anything already waiting; you don't need to end your turn for it.",
].join(' ')

const SUBAGENT = "A subagent can't set the session's prompt bar color. Finish your piece and return its result; the main session can set it."

/** How /color says it set the color, or reset it: anything else it hands back is its refusal. */
const DID_SET = /^Session color /

const isColor = (raw: unknown): raw is Color => typeof raw === 'string' && (COLORS as readonly string[]).includes(raw)

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

/** One line: the command's output can run over several. */
const oneLine = (said: string) => said.replace(/\s*\n\s*/g, ' ')

/** What the toast says once the color has changed. */
const changed = (color: Color) => (color === 'default' ? 'Prompt bar color reset to default.' : `Prompt bar color set to ${color}.`)

/** Tells the model on its next turn, in a row it reads and the person doesn't see as typed. */
async function tellModel($: EngineInterface, note: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
  } catch {
    // The toast has told the person; there is no other way to reach the model.
  }
}

/** Runs /color, then tells the person how it went, and the model when it didn't take. */
async function colorNow($: EngineInterface, value: Queued): Promise<void> {
  $.ui.status(undefined)
  let said: string | undefined
  try {
    said = text((await $.command.run({ command: 'color', args: value.color })).text)
  } catch (err) {
    $.ui.toast(`/color didn't run: ${why(err)}`)
    await tellModel($, `The prompt bar color change to ${value.color} you queued didn't run: ${why(err)}.`)
    return
  }
  // /color prints its outcome as its own transcript line; a version that hands it back has it read here.
  if (said !== undefined && !DID_SET.test(said)) {
    $.ui.toast(`Prompt bar color not set: ${oneLine(said)}`)
    await tellModel($, `The prompt bar color change to ${value.color} you queued didn't take: ${oneLine(said)}`)
    return
  }
  $.ui.toast(changed(value.color))
}

export const register: Register = (on, options) => {
  configureUpdateCheck('self-color', options)

  // First, so it is outermost on this plugin's tools: it sees each answer, and adds the update
  // notice when one is due. It never waits on the check; see update-check.ts.
  on('tool.call', { tool: /^mcp__self-color__/ }, async ($, e, next) => withUpdateNotice($, e, await next(e))).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'color_after_turn',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          color: {
            type: 'string',
            enum: [...COLORS],
            description: 'The prompt bar color: red, blue, green, yellow, purple, orange, pink or cyan; `default` resets it.',
          },
        },
        required: ['color'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    loadUpdateCheck($)
    return started
  })

  on('tool.call', { tool: 'mcp__self-color__color_after_turn' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: SUBAGENT }
    const color = (e as { color?: unknown }).color
    if (!isColor(color)) return { deny: `\`color\` must be one of: ${LISTED} (which resets it).` }
    await $.state.set(queued, { color })
    $.ui.status(`/color ${color} queued for when this turn ends`)
    return {
      result:
        color === 'default'
          ? 'Queued. The prompt bar goes back to its default color once this turn ends.'
          : `Queued. The prompt bar turns ${color} once this turn ends, and stays ${color} for the session.`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-color: queuing the color change failed; nothing is queued.' }))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const done = await next(e)
    const { value } = await $.state.get(queued)
    if (!value) return done
    await $.state.set(queued, null)
    if (e.isAborted || e.reason !== 'answer') {
      $.ui.status(undefined)
      $.ui.toast("Prompt bar color change cancelled: the turn didn't finish.")
      return done
    }
    $.clock.after(TURN_END_MS, () => void colorNow($, value).catch(() => undefined))
    return done
  })
}
