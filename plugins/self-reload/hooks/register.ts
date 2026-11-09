// A session reloads its own plugins once the current turn ends, as /reload-plugins does, and can
// carry on by itself afterwards. The model calls reload_plugins_after_turn; a command can't run
// while the turn the model is in waits on it, so the call is queued and the reload runs once the
// turn has ended with an answer. An interrupted turn cancels it. Only the main conversation reloads
// this way, never a subagent.
//
// The reload replaces this plugin's own module, and with it every module variable and timer; only
// $.state survives. So the resume is written to $.state before the command runs, and whichever
// comes first sends it, once: session.start in the module the reload started, or this module when
// the command returns and it is still running (the reload left it in place, or failed). Each takes
// it with a compare-and-set on its version, so the two can't both send it.
//
// A /clear or a /resume that runs before the queued reload makes the session another conversation, and
// Claude Code empties $.state then (now or a moment after), with no session.start. The reload still runs,
// but its resume was the conversation left's: so at that classic SessionStart, while a reload this module
// armed waits, the resume is dropped, from the module's copy of the record and from $.state if it is still
// there, and a toast and a note to the model say so. It is never sent into the conversation arrived at.
import type { EngineInterface, Register } from 'claude-code'
import type { Pending, Queued } from '../types'
import { configureUpdateCheck, loadUpdateCheck, withUpdateNotice } from './update-check'

const queued = { plugin: 'self-reload', key: 'queued' } as const
const pending = { plugin: 'self-reload', key: 'pending' } as const

/**
 * When the reload starts after the turn's end: at once, the moment the turn's end returns (the owner's A). Input
 * already waiting when the turn ended still runs first, since Claude Code queues a plugin's command behind it, and the
 * reload then runs after that input's turn. The reload itself does no harm late, but its resume would: a person who
 * typed "stop" meanwhile would be answered by the old "go on". So a message the person sent after the arm marks the
 * pending resume (in $.state, which the reload keeps), and the resume goes to the model as a note instead of starting a
 * turn. Anything else first (a task's notification, a wake-up, another plugin's prompt) leaves the resume as it was.
 * (self-clear, self-exit, self-restart and self-switch wait half a second instead, so that their step stands down when
 * something is waiting.)
 */
const TURN_END_MS = 0

/**
 * The person's message, known by the turn it came in over, never by its words: no prompt text is held, hashed, stored
 * or logged. A prompt from the composer or the app's bridge (prompt.submit's origin) counts, from its prompt.submit
 * until it settles:
 * - one that comes while a reload is armed (its pending record written) marks that arm;
 * - one typed over a running main-loop turn (prompt.submit's `turnId`) marks the arm that turn's end makes, which comes
 *   before the prompt's own `next(e)` resolves ("once the prompt entered the session and its turn started"). So the
 *   marks are made before `next(e)`, and a prompt dropped beneath takes back its own, and only its own.
 * The mark the next module reads is the pending record's `turnSince`, written once a marking prompt has entered: one
 * still in flight marks the arm in this module only, and the claim here counts it, so a drop has nothing in $.state to
 * take back. The reload runs after the prompt has settled, since Claude Code queues the command behind it. The prompt's
 * own hook writes it when it can see the record; one typed over the turn that wrote the record can't ("every `get` of
 * one dispatch reads one moment", and its dispatch began before the record was there), so each main-loop turn.start
 * writes what is marked, before that turn can end and the reload run. A task's notification, a peer's message
 * and a plugin's prompt (this one's resume included) have other origins, and a subagent's turn makes no arm. Known
 * limit: a prompt the engine delivers into the running turn, which the model has read already, marks the arm too, so
 * that resume goes as a note, while the person is there to see the toast.
 */
type Typed = { entered: boolean; arms: Set<Arm> }
/**
 * The pending reload as this module marks it: its record's `at` (absent until written), stale once a person's prompt
 * that marked it entered (or its record was marked by an earlier load of this module), or while one in flight holds it.
 */
type Arm = { at?: number; sure: boolean; marks: Set<Typed> }
/** The reloads armed and not yet taken. */
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

/** An arm whose record was taken or replaced, or that queued nothing: it is marked no more. */
function closeArm(arm: Arm): void {
  openArms.delete(arm)
  for (const typed of arm.marks) typed.arms.delete(arm)
  arm.marks.clear()
}

/**
 * The pending record this module wrote at a turn's end and hasn't taken back: the copy a /clear or a /resume
 * doesn't empty, so the resume can be dropped, and said to be, after Claude Code emptied $.state.
 */
let written: Pending | undefined

/** The state steps on the pending record, one at a time: its writing, a mark and the claim never interleave. */
let chain: Promise<unknown> = Promise.resolve()
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work)
  chain = run.catch(() => undefined)
  return run
}

/**
 * Writes the mark into the pending record (`turnSince: true`) once a prompt that marked its arm has entered. Only the
 * record the arm was written as (its `at`); a write that lost to another reads it again.
 */
function syncMark($: EngineInterface, arm: Arm): Promise<void> {
  return serial(async () => {
    for (let tries = 0; tries < 3; tries += 1) {
      if (arm.at === undefined || !arm.sure) return
      const held = await $.state.get(pending)
      if (!held.value || held.value.at !== arm.at || held.value.turnSince === true) return
      if ((await $.state.set(pending, { ...held.value, turnSince: true }, { ifVersion: held.version })).isSet) return
    }
  })
}

/** A pending record no open arm stands for (an earlier load of this module wrote it): it gets an arm, and the prompt marks it too. */
function adopt($: EngineInterface, typed: Typed): Promise<void> {
  return serial(async () => {
    const { value } = await $.state.get(pending)
    if (!value || [...openArms].some(arm => arm.at === value.at)) return
    const arm: Arm = { at: value.at, sure: value.turnSince === true, marks: new Set() }
    openArms.add(arm)
    mark(arm, typed)
  })
}

/** A pending resume older than this is dropped, not sent: the turn that asked for it is long gone. */
const STALE_MS = 10 * 60 * 1000

/**
 * How /reload-plugins says it skipped the reload: it does when the reload would change which MCP
 * tools are loaded, until it is run with --force, which this plugin leaves to the user.
 */
const SKIPPED = /\/reload-plugins --force/

const DESCRIPTION = [
  "Reloads this session's plugins once the current turn ends, as /reload-plugins does, so a plugin change made in this session takes effect without a restart.",
  'Call it after you have changed plugin files (a hooks module, a skill, a manifest) and the next step needs the change live, such as trying a tool you just edited.',
  'Not mid-edit: finish the change first. Not for a change that needs a new session anyway.',
  '`resume` is the message that starts your next turn once the plugins have reloaded: what to check or do next.',
  'Give it whenever you have a next step of your own; leave it out only when the next step waits on someone else (the user, another session, a check).',
  "It runs when the session is idle: Claude Code queues a plugin's command behind anything already waiting (a message typed during this turn, a background task's notification) and has no slot between turns ahead of them, so under a nonstop stream of work and notifications it may run in the distant future. Nothing waiting is lost.",
  'After calling it, end your turn and do nothing more until it has run; then carry on.',
].join(' ')

/** What is queued: `resume` only when there is one, since stored state holds no undefined. */
const entry = (resume: string | undefined): Queued => (resume === undefined ? {} : { resume })

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

/**
 * Takes the pending resume, if it is still there and no one took it first, with this module's mark of it: a person's
 * prompt still in flight counts. A take that lost to a mark written meanwhile (by another load of this module) reads
 * the record again; one that lost to another take finds it gone.
 */
function claim($: EngineInterface): Promise<Pending | undefined> {
  return serial(async () => {
    for (let tries = 0; tries < 3; tries += 1) {
      const held = await $.state.get(pending)
      const value = held.value
      if (!value) return undefined
      if ((await $.state.set(pending, null, { ifVersion: held.version })).isSet) {
        if (written?.at === value.at) written = undefined
        const isMarked = [...openArms].some(arm => arm.at === value.at && isStale(arm))
        for (const arm of openArms) if (arm.at === value.at) closeArm(arm)
        return isMarked && value.turnSince !== true ? { ...value, turnSince: true } : value
      }
    }
    return undefined
  })
}

async function sendResume($: EngineInterface, said: string, resume: string): Promise<void> {
  try {
    const sent = await $.prompt.submit({ text: `${said} Resume: ${resume}` })
    if (sent.drop !== undefined) $.ui.toast(`Resume not sent: ${sent.drop}`)
  } catch {
    $.ui.toast('Resume not sent; the session waits for the next message.')
  }
}

/**
 * Sends the resume, or, when the person's message came after the reload was queued, hands it to the model as a note:
 * their message came after the model asked to resume, and is answered first.
 */
async function resumeOrNote($: EngineInterface, said: string, value: Pending): Promise<void> {
  if (value.resume === undefined) return
  if (value.turnSince !== true) return await sendResume($, said, value.resume)
  $.ui.toast('Resume not sent: your message came after the reload was queued, so the model has it as a note.')
  await tellModel($, `${said} The person's message came after the reload was queued, so its resume wasn't sent as a new message. It was: ${value.resume}`)
}

/** A pending record with its resume left out. */
function withoutResume(value: Pending): Pending {
  const copy: Pending = { ...value }
  delete copy.resume
  return copy
}

/**
 * At a /clear's or a /resume's classic SessionStart, while a reload this module armed still waits: its resume
 * is dropped (the conversation it was for was left), from the module's copy and from $.state when the record
 * is still there (read fresh, so the compare-and-set's version is from after the move); when the wipe came
 * first, the record goes back without it, so the reload's end still reports. The person and the model are
 * told. The reload itself still runs. Nothing when the waiting reload has no resume.
 */
function dropResume($: EngineInterface, source: 'clear' | 'resume'): Promise<void> {
  return serial(async () => {
    const mine = written
    if (mine === undefined || mine.resume === undefined) return
    const kept = withoutResume(mine)
    written = kept
    for (let tries = 0; tries < 3; tries += 1) {
      const held = await $.state.get(pending)
      // The wipe came first: the record goes back without its resume, so the reload's end still says how it went.
      if (!held.value) {
        await $.state.set(pending, kept)
        break
      }
      if (held.value.at !== mine.at || held.value.resume === undefined) break
      if ((await $.state.set(pending, withoutResume(held.value), { ifVersion: held.version })).isSet) break
    }
    const move = source === 'clear' ? '/clear' : '/resume'
    $.ui.toast(`Resume dropped: a ${move} ran before the queued plugin reload, so its resume, which was for the conversation left, isn't sent. The reload still runs.`)
    await tellModel($, `self-reload: a plugin reload queued before this ${move} still runs, but its resume was dropped: it was for the conversation the ${move} left, not this one.`)
  })
}

/** Runs the reload; then, if this module is still the one running, sends what is pending. */
async function reloadNow($: EngineInterface): Promise<void> {
  $.ui.status(undefined)
  let failed: string | undefined
  let output: string | undefined
  try {
    output = text((await $.command.run({ command: 'reload-plugins' })).text)
  } catch (err) {
    failed = why(err)
  }
  const value = await claim($)
  if (value === undefined) return
  if (failed !== undefined) {
    $.ui.toast(`Plugin reload didn't run: ${failed}`)
    if (value.resume !== undefined) await resumeOrNote($, `Plugin reload didn't run (${failed}).`, value)
    else await tellModel($, `The plugin reload you queued didn't run: ${failed}`)
    return
  }
  if (output !== undefined && SKIPPED.test(output)) {
    $.ui.toast(`Plugin reload skipped: ${output}`)
    if (value.resume !== undefined) await resumeOrNote($, `Plugin reload was skipped (${output}).`, value)
    else await tellModel($, `The plugin reload you queued was skipped: ${output}`)
    return
  }
  $.ui.toast(output === undefined ? 'Plugins reloaded.' : `Plugins reloaded. ${output}`)
  await resumeOrNote($, 'Plugins reloaded.', value)
}

/** At a module's start: after a reload this session asked for, send its resume, once. */
async function resumeAfterReload($: EngineInterface): Promise<void> {
  const value = await claim($)
  if (value === undefined) return
  $.ui.status(undefined)
  if ((await $.clock.now()) - value.at > STALE_MS) {
    $.ui.toast('A queued resume was dropped: its plugin reload never reported back.')
    return
  }
  $.ui.toast('Plugins reloaded.')
  // Not awaited: a submitted prompt starts its turn only once this start has finished.
  void resumeOrNote($, 'Plugins reloaded.', value)
}

export const register: Register = (on, options) => {
  configureUpdateCheck('self-reload', options)

  // First, so it is outermost on this plugin's tools: it sees each answer, and adds the update
  // notice when one is due. It never waits on the check; see update-check.ts.
  on('tool.call', { tool: /^mcp__self-reload__/ }, async ($, e, next) => withUpdateNotice($, e, await next(e))).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'reload_plugins_after_turn',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          resume: {
            type: 'string',
            description:
              'The message that starts your next turn once the plugins have reloaded: what to check or do next. Leave it out only when the next step waits on someone else.',
          },
        },
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await resumeAfterReload($)
    loadUpdateCheck($)
    return started
  })

  on('tool.call', { tool: 'mcp__self-reload__reload_plugins_after_turn' }, async ($, e) => {
    if (e.agentId !== undefined) {
      return {
        deny: "A subagent can't reload the session's plugins. Finish your piece and return its result, saying a reload is needed: the main session can reload.",
      }
    }
    const resume = text((e as { resume?: unknown }).resume)
    await $.state.set(queued, entry(resume))
    $.ui.status('plugin reload queued for when this turn ends')
    const then = resume === undefined ? 'then waits for the next message' : `then resumes with: ${resume}`
    return { result: `Queued. Plugins reload once this turn ends, and the session ${then}` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-reload: queuing the reload failed; nothing is queued.' }))

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
        $.ui.toast("Plugin reload cancelled: the turn didn't finish.")
        return done
      }
      // Written before the reload replaces this module, so the module it starts finds it, marked when a person's
      // prompt typed over this turn has entered already.
      const at = await $.clock.now()
      await serial(async () => {
        arm.at = at
        const record: Pending = { ...value, at, ...(arm.sure ? { turnSince: true as const } : {}) }
        written = record
        await $.state.set(pending, record)
      })
      isArmed = true
      // An arm of a record this one replaced stands for nothing now.
      for (const other of openArms) if (other !== arm) closeArm(other)
      $.clock.after(TURN_END_MS, () => void reloadNow($))
      return done
    } finally {
      if (!isArmed) closeArm(arm)
    }
  })

  // A /clear or a /resume before the queued reload ran: the resume was the conversation's it left, and is dropped.
  on('classic.SessionStart', async ($, e, next) => {
    const done = await next(e)
    if (e.agent_id === undefined && (e.source === 'clear' || e.source === 'resume')) await dropResume($, e.source).catch(() => undefined)
    return done
  }).catch(($, e, next) => next(e))

  // A main-loop turn's start: a mark the prompt's own hook couldn't write into the record (see Typed) is written now,
  // before the turn can end and the reload run. Only a mark; nothing of the turn's text is read.
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (e.agentId === undefined) for (const arm of openArms) if (arm.sure) await syncMark($, arm).catch(() => undefined)
    return started
  }).catch(($, e, next) => next(e))

  // The person's message, at the terminal or from the app: it marks the arms it comes after (see Typed), here before it
  // enters, and in the pending record once it has; a drop takes back its own marks. No text is kept.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)
    const typed = personTyped(e.turnId)
    try {
      await adopt($, typed)
    } catch {
      // A record an earlier load wrote goes unmarked by this prompt; this module's own arms are marked all the same.
    }
    const done = await next(e)
    if (done.drop !== undefined) {
      personDropped(typed, e.turnId)
      return done
    }
    const marked = [...typed.arms]
    personEntered(typed)
    for (const arm of marked) await syncMark($, arm).catch(() => undefined)
    return done
  }).catch(($, e, next) => next(e))
}
