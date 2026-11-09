// A session sets its own prompt bar color once the current turn ends, as `/color <color>` does, to mark
// its role so the person can tell sessions apart at a glance. The model calls color_after_turn; a
// command can't run while the turn the model is in waits on it, so the call is queued and /color runs
// after the turn has ended with an answer. An interrupted turn cancels it. Only the main conversation
// sets it this way, never a subagent.
//
// /color with an argument sets the color and prints one line, with no picker; with none it picks a
// color at random, so the plugin always passes one, from the list the call checked. `default` resets
// it. A change that runs late does no harm in the same conversation, and it has no resume that a
// person's message could make stale, so a person's turn in between only puts it off to that turn's
// end. A move to another conversation is different: a /color that ran after a /resume or a /clear
// would color the conversation moved to. So the change waits half a second after the turn's end, and
// while a turn or a /resume or /clear runs; a SessionStart of a resume or a clear meanwhile drops it.
//
// In an interactive session /color is a panel command (local-jsx) that prints its line itself and hands
// $.command.run no text, so the toast can't say whether it took: it says it ran, and points to
// Claude Code's own line. A headless /color hands its line back, and only its exact success line
// counts as set.
//
// What is queued lives in $.state for one turn: the turn's end takes it and clears it, and from then
// the module holds it until it runs or is dropped, so nothing here needs to outlive a /clear or a /resume.
import type { EngineInterface, Register, Timer } from 'claude-code'
import type { Color, Queued } from '../types'
import { didntRun, oneLine, text, why } from './text'
import { configureUpdateCheck, loadUpdateCheck, withUpdateNotice } from './update-check'

const queued = { plugin: 'self-color', key: 'queued' } as const

/**
 * How long after a turn's end the change waits before it goes to Claude Code: half a second, as self-clear's does.
 * Input waiting when the turn ended runs then (a person's /resume or /clear typed during the turn among it), and a
 * /color handed over at once could run after it, in the conversation it moved to. (Whether /color, an immediate
 * command, would wait behind waiting input or go ahead of it isn't known; the plugin doesn't rely on either.) In
 * the half second that input starts, and its command.run, which this plugin sees, holds the change until it ends.
 * This plugin can't look at its own /color as it leaves the queue: 2.1.319's re-entry rule leaves a plugin's own
 * command.run hooks out of a command it raised outside a hook.
 */
const SETTLE_MS = 500

/** The colors /color takes: Claude Code's own list (2.1.319), and `default`, which resets the prompt bar. */
const COLORS: readonly Color[] = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan', 'default']

/** The colors as a sentence lists them. */
const LISTED = `${COLORS.slice(0, -1).join(', ')}, or ${COLORS[COLORS.length - 1]}`

const DESCRIPTION = [
  "Sets this session's prompt bar color once the current turn ends, as /color does.",
  "Use it to mark the session's role, so the person can tell sessions apart at a glance: for example, one color for a coordinating session, another for workers.",
  'The color lasts for the session; `default` resets it.',
  "It runs once the session is idle, after anything already waiting, and a /resume or /clear that runs first drops it; you don't need to end your turn for it.",
].join(' ')

const SUBAGENT = "A subagent can't set the session's prompt bar color. Finish your piece and return its result; the main session can set it."

/** What the call answers: queued, not done, and what would take it back. */
const queuedResult = (color: Color) =>
  `Queued: /color ${color} runs once this turn ends; an interrupted turn, or a /resume or /clear that runs first, drops it.`

/** The toast, and the model's note, when the turn that queued a change didn't finish. */
const cancelledToast = (color: Color) => `Prompt bar color change to ${color} cancelled: the turn didn't finish.`
const cancelledNote = (color: Color) =>
  `The prompt bar color change to ${color} you queued was cancelled: the turn didn't finish. To set it, call color_after_turn again.`

/**
 * The toast when the session moved to another conversation before the change ran. The model isn't told: by then the
 * session is in the conversation moved to, which never asked for the change, and a note can only go there.
 */
const droppedToast = (color: Color) => `Prompt bar color change to ${color} dropped: this session moved to another conversation.`

/** The change a turn's end took from $.state and that hasn't gone to Claude Code yet. */
let waiting: Queued | undefined
/** Whether a main-loop turn is running: a waiting change goes after it. */
let isTurnRunning = false
/** The /resume and /clear runs under way: a waiting change goes once each has ended without moving the session. */
let moving = 0
/** The one look pending: a new one replaces it, and a main-loop turn's start cancels it, so no older look goes early. */
let look: Timer | undefined

const isColor = (raw: unknown): raw is Color => typeof raw === 'string' && (COLORS as readonly string[]).includes(raw)

/** /color's own line when it set the color, or reset it (2.1.319): only this, exactly, counts as set. */
const setLine = (color: Color) => (color === 'default' ? 'Session color reset to default' : `Session color set to: ${color}`)

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

/** Runs /color, then tells the person how it went, and the model when it didn't run or said something else. */
async function colorNow($: EngineInterface, value: Queued): Promise<void> {
  $.ui.status(undefined)
  let said: string | undefined
  try {
    said = text((await $.command.run({ command: 'color', args: value.color })).text)
  } catch (err) {
    $.ui.toast(`/color didn't run: ${why(err)}`)
    await tellModel($, didntRun(value.color, why(err)))
    return
  }
  // Interactive: /color prints its line itself and hands back none, so only Claude Code's line says whether it took.
  if (said === undefined) {
    $.ui.toast(`/color ${value.color} ran: Claude Code's line above says whether it took.`)
    return
  }
  if (said === setLine(value.color)) {
    $.ui.toast(changed(value.color))
    return
  }
  // Anything else: its refusal (a teammate session), or the color set with a warning (a cloud session's).
  $.ui.toast(`/color ${value.color} said: ${oneLine(said)}`)
  await tellModel($, `The prompt bar color change to ${value.color} you queued ran, and /color said: ${oneLine(said)}`)
}

/** Hands the waiting change to Claude Code, unless a turn or a move runs: then it goes when that has ended. */
function handOff($: EngineInterface): void {
  const value = waiting
  if (value === undefined || isTurnRunning || moving > 0) return
  waiting = undefined
  void colorNow($, value).catch(() => undefined)
}

/** Stops the look pending, if there is one. */
function stopLooking(): void {
  look?.cancel()
  look = undefined
}

/** Looks again half a second from now, in place of any look pending. */
function settle($: EngineInterface): void {
  stopLooking()
  look = $.clock.after(SETTLE_MS, () => {
    look = undefined
    handOff($)
  })
}

/** Holds a waiting change while a /resume or /clear runs, and looks again once it has ended. */
async function aroundMove<T>($: EngineInterface, run: () => Promise<T>): Promise<T> {
  moving += 1
  try {
    return await run()
  } finally {
    moving -= 1
    if (waiting !== undefined) settle($)
  }
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
    return { result: queuedResult(color) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-color: queuing the color change failed; nothing is queued.' }))

  // A main-loop turn: running from before its start passes down until its end has passed down; the look pending stops.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = true
      stopLooking()
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    try {
      const done = await next(e)
      const { value } = await $.state.get(queued)
      if (!value) return done
      await $.state.set(queued, null)
      if (e.isAborted || e.reason !== 'answer') {
        $.ui.status(undefined)
        $.ui.toast(cancelledToast(value.color))
        await tellModel($, cancelledNote(value.color))
        return done
      }
      waiting = value
      return done
    } finally {
      isTurnRunning = false
      if (waiting !== undefined) settle($)
    }
  })

  // A /resume or a /clear, the person's or another plugin's: a waiting change goes only once it has ended.
  on('command.run', { command: 'resume' }, ($, e, next) => aroundMove($, () => next(e))).catch(($, e, next) => next(e))
  on('command.run', { command: 'clear' }, ($, e, next) => aroundMove($, () => next(e))).catch(($, e, next) => next(e))

  // The session moved to another conversation before the change ran: it was for the one left, so it is dropped.
  on('classic.SessionStart', async ($, e, next) => {
    const done = await next(e)
    if (e.agent_id === undefined && (e.source === 'resume' || e.source === 'clear') && waiting !== undefined) {
      const { color } = waiting
      waiting = undefined
      stopLooking()
      $.ui.status(undefined)
      $.ui.toast(droppedToast(color))
    }
    return done
  }).catch(($, e, next) => next(e))
}
