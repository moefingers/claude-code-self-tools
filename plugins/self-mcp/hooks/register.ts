// A session reconnects one of its MCP servers that broke, or all of them, once the current turn
// ends, as `/mcp reconnect <server>` does, and can carry on by itself afterwards. The model calls
// reconnect_mcp_after_turn; a command can't run while the turn the model is in waits on it, so the
// call is queued and the reconnect runs once the turn has ended with an answer. An interrupted turn
// cancels it. Only the main conversation reconnects this way, never a subagent.
//
// `/mcp reconnect` is the typed form of the /mcp menu's Reconnect: it opens no menu, so it runs
// unattended. Its outcome (reconnected, failed, no such server) is its own transcript line, as if
// typed; the toast and the resume, or a note the model reads, point to it.
import type { EngineInterface, Register } from 'claude-code'
import type { Queued } from '../types'
import { configureUpdateCheck, loadUpdateCheck, withUpdateNotice } from './update-check'

const queued = { plugin: 'self-mcp', key: 'queued' } as const

/**
 * When the reconnect starts after the turn's end: at once, the moment the turn's end returns (the owner's A). Input
 * already waiting when the turn ended still runs first, since Claude Code queues a plugin's command behind it, and the
 * reconnect then runs after that input's turn. The reconnect itself does no harm late, but its resume would: a person who
 * typed "stop" meanwhile would be answered by the old "go on". So a message the person sent after the arm marks it, and
 * the resume goes to the model as a note instead of starting a turn. Anything else first (a task's notification, a
 * wake-up, another plugin's prompt) leaves the resume as it was. (self-clear, self-exit, self-restart and self-switch
 * wait half a second instead, so that their step stands down when something is waiting.)
 */
const TURN_END_MS = 0

/**
 * The person's message, known by the turn it came in over, never by its words: no prompt text is held, hashed or
 * logged. A prompt from the composer or the app's bridge (prompt.submit's origin) counts, from its prompt.submit until
 * it settles:
 * - one that comes while a reconnect is armed marks that arm;
 * - one typed over a running main-loop turn (prompt.submit's `turnId`) marks the arm that turn's end makes, which comes
 *   before the prompt's own `next(e)` resolves ("once the prompt entered the session and its turn started"). So the
 *   marks are made before `next(e)`, and a prompt dropped beneath takes back its own, and only its own.
 * A task's notification, a peer's message and a plugin's prompt (this one's resume included) have other origins, and a
 * subagent's turn makes no arm. Known limit: a prompt the engine delivers into the running turn, which the model has
 * read already, marks the arm too, so that resume goes as a note, while the person is there to see the toast.
 */
type Typed = { entered: boolean; arms: Set<Arm> }
/** One reconnect armed at a turn's end: stale once a person's prompt that marked it entered, or while one in flight holds it. */
type Arm = { sure: boolean; marks: Set<Typed> }
/** The reconnects armed and not yet reported. */
const openArms = new Set<Arm>()
/** The main-loop turns a person's prompt was typed over, each with those prompts. Emptied at each main-loop turn's end, once its arm is made. */
const typedOver = new Map<string, Set<Typed>>()

const isStale = (arm: Arm): boolean => arm.sure || arm.marks.size > 0

function mark(arm: Arm, typed: Typed): void {
  if (typed.entered) arm.sure = true
  else {
    arm.marks.add(typed)
    typed.arms.add(arm)
  }
}

/** At a person's prompt, before it enters: every open arm marked, and the turn it was typed over noted. */
function personTyped(turnId: string | undefined): Typed {
  const typed: Typed = { entered: false, arms: new Set() }
  for (const arm of openArms) mark(arm, typed)
  if (turnId !== undefined) typedOver.set(turnId, (typedOver.get(turnId) ?? new Set<Typed>()).add(typed))
  return typed
}

/** The prompt entered: what it marked stays marked. */
function personEntered(typed: Typed): void {
  typed.entered = true
  for (const arm of typed.arms) {
    arm.marks.delete(typed)
    arm.sure = true
  }
  typed.arms.clear()
}

/** The prompt was dropped: its marks taken back, and its turn no longer held for it. */
function personDropped(typed: Typed, turnId: string | undefined): void {
  for (const arm of typed.arms) arm.marks.delete(typed)
  typed.arms.clear()
  if (turnId === undefined) return
  const held = typedOver.get(turnId)
  held?.delete(typed)
  if (held?.size === 0) typedOver.delete(turnId)
}

/** At a main-loop turn's end: its arm, marked by the person's prompts typed over the turn. */
function armAt(turnId: string): Arm {
  const arm: Arm = { sure: false, marks: new Set() }
  for (const typed of typedOver.get(turnId) ?? []) mark(arm, typed)
  openArms.add(arm)
  return arm
}

/** An arm whose reconnect has reported, or that queued nothing: it is marked no more. */
function closeArm(arm: Arm): void {
  openArms.delete(arm)
  for (const typed of arm.marks) typed.arms.delete(arm)
  arm.marks.clear()
}

const DESCRIPTION = [
  'Reconnects one of this session\'s MCP servers once the current turn ends, as /mcp reconnect does: for a server whose tools stopped answering (a browser extension that dropped, a server that crashed or timed out), where reconnecting is all it needs.',
  '`server` is its name as /mcp lists it; for a tool named mcp__<server>__<tool> that is usually <server>. `all` reconnects every server that is not connected.',
  'Not for a server that needs sign-in, or one turned off: /mcp is the person\'s for those.',
  '`resume` is the message that starts your next turn once the reconnect has run, with what the reconnect said: what to try again.',
  'Give it whenever you have a next step of your own; leave it out only when the next step waits on someone else (the user, another session, a check).',
  "It runs when the session is idle: Claude Code queues a plugin's command behind anything already waiting (a message typed during this turn, a background task's notification) and has no slot between turns ahead of them, so under a nonstop stream of work and notifications it may run in the distant future. Nothing waiting is lost.",
  'After calling it, end your turn and do nothing more until it has run; then carry on.',
].join(' ')

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

/** What is queued: `resume` only when there is one, since stored state holds no undefined. */
const entry = (server: string, resume: string | undefined): Queued => (resume === undefined ? { server } : { server, resume })

/** Tells the model on its next turn, in a row it reads and the person doesn't see as typed. */
async function tellModel($: EngineInterface, note: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
  } catch {
    // The toast has told the person; there is no other way to reach the model.
  }
}

async function sendResume($: EngineInterface, said: string, resume: string): Promise<void> {
  try {
    const sent = await $.prompt.submit({ text: `${said} Resume: ${resume}` })
    if (sent.drop !== undefined) $.ui.toast(`Resume not sent: ${sent.drop}`)
  } catch {
    $.ui.toast('Resume not sent; the session waits for the next message.')
  }
}

/** Runs the reconnect, then tells the person and the model what it said. Its arm is closed however it ends. */
async function reconnectNow($: EngineInterface, value: Queued, arm: Arm): Promise<void> {
  try {
    $.ui.status(undefined)
    let said: string
    try {
      const output = text((await $.command.run({ command: 'mcp', args: `reconnect ${value.server}` })).text)
      // /mcp shows its outcome as its own transcript line, which the person and the model both read,
      // and hands the caller no text; a version that hands one back has it passed on.
      said =
        output === undefined
          ? `MCP reconnect of ${value.server} ran: Claude Code's own line above says whether it reconnected.`
          : `MCP reconnect of ${value.server}: ${oneLine(output)}`
    } catch (err) {
      said = `MCP reconnect of ${value.server} didn't run: ${why(err)}.`
    }
    $.ui.toast(said)
    // The person's message after the arm came after the model asked to resume, and is answered first.
    if (value.resume === undefined) await tellModel($, said)
    else if (!isStale(arm)) await sendResume($, said, value.resume)
    else {
      $.ui.toast('Resume not sent: your message came after the reconnect was queued, so the model has it as a note.')
      await tellModel($, `${said} The person's message came after the reconnect was queued, so its resume wasn't sent as a new message. It was: ${value.resume}`)
    }
  } finally {
    closeArm(arm)
  }
}

export const register: Register = (on, options) => {
  configureUpdateCheck('self-mcp', options)

  // First, so it is outermost on this plugin's tools: it sees each answer, and adds the update
  // notice when one is due. It never waits on the check; see update-check.ts.
  on('tool.call', { tool: /^mcp__self-mcp__/ }, async ($, e, next) => withUpdateNotice($, e, await next(e))).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'reconnect_mcp_after_turn',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          server: {
            type: 'string',
            description: 'The MCP server to reconnect, by its name as /mcp lists it (usually the <server> in mcp__<server>__<tool>), or `all`.',
          },
          resume: {
            type: 'string',
            description:
              'The message that starts your next turn once the reconnect has run: what to try again. Leave it out only when the next step waits on someone else.',
          },
        },
        required: ['server'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    loadUpdateCheck($)
    return started
  })

  on('tool.call', { tool: 'mcp__self-mcp__reconnect_mcp_after_turn' }, async ($, e) => {
    if (e.agentId !== undefined) {
      return {
        deny: "A subagent can't reconnect the session's MCP servers. Finish your piece and return its result, saying which server needs a reconnect: the main session can reconnect it.",
      }
    }
    const input = e as { server?: unknown; resume?: unknown }
    const server = text(input.server)
    if (server === undefined || /[\r\n]/.test(server)) {
      return { deny: '`server` must be one MCP server\'s name as /mcp lists it, or `all`, on one line.' }
    }
    const resume = text(input.resume)
    await $.state.set(queued, entry(server, resume))
    $.ui.status(`MCP reconnect of ${server} queued for when this turn ends`)
    const then = resume === undefined ? 'then waits for the next message' : `then resumes with: ${resume}`
    return { result: `Queued. ${server} reconnects once this turn ends, and the session ${then}` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-mcp: queuing the reconnect failed; nothing is queued.' }))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // This turn's arm, made at once, marked by the person's prompts typed over the turn; closed below if nothing is queued.
    const arm = armAt(e.turnId)
    typedOver.clear()
    let isArmed = false
    try {
      const done = await next(e)
      const { value } = await $.state.get(queued)
      if (!value) return done
      await $.state.set(queued, null)
      if (e.isAborted || e.reason !== 'answer') {
        $.ui.status(undefined)
        $.ui.toast("MCP reconnect cancelled: the turn didn't finish.")
        return done
      }
      isArmed = true
      $.clock.after(TURN_END_MS, () => void reconnectNow($, value, arm))
      return done
    } finally {
      if (!isArmed) closeArm(arm)
    }
  })

  // The person's message, at the terminal or from the app: it marks the arms it comes after (see Typed). No text is kept.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)
    const typed = personTyped(e.turnId)
    const done = await next(e)
    if (done.drop === undefined) personEntered(typed)
    else personDropped(typed, e.turnId)
    return done
  }).catch(($, e, next) => next(e))
}
