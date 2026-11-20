// A session wakes itself later: `minutes` (or `seconds`, for a wait of under a few minutes) after the current turn
// ends, it sends itself "Wake-up: <note>" as a prompt, a turn of its own. The model calls wake_after; the wake is armed
// once the turn ends with an answer and counts from there, and an interrupted turn drops it (a
// wake armed before stands). One wake at a time: a new one replaces the one before it, and says
// so. cancel_wake takes it back at once. Only the main conversation wakes this way, never a
// subagent.
//
// The armed wake lives in $.state, which survives a reload of this plugin; its timer doesn't. So
// session.start arms it again for the time left, or fires it at once if that has passed. Firing
// takes the wake with a compare-and-set on its version (read just before), so it is sent once.
//
// Claude Code empties $.state at an in-process /clear or /resume, and no session.start follows; a /resume
// may also bring back what $.state held for that conversation before. So the module keeps the whole
// wake-up (`kept`), set at every write and loaded once from $.state at the module's first read; once
// loaded, it stands, and a $.state value that differs from it is overwritten with it (armedWake), at every
// read, the SessionStart of a move included. $.state is only the copy that outlives a reload.
//
// A wake-up belongs to one conversation, and a move decides what becomes of it (follow), at the main
// loop's SessionStart of a clear or a resume:
//   - a /clear carries it on: it moves to the conversation the /clear started (the module's copy, its
//     timer's hold and $.state), whose marker then says armed, and the one left's not; so does a /branch,
//     once `$.session.id()` reads the fork past the id's lag (its fork's SessionStart names nothing here);
//   - a /resume, or a switch in place, to another conversation drops it, with a toast that names it, and
//     a note to the model in the conversation now held that doesn't (the other's task stays there): it
//     never fires into an unrelated task, nor waits hidden for a move back;
//   - a /resume of the conversation it belongs to keeps it.
// The module's copy decides, once loaded: a $.state that can't be read then doesn't keep a wake-up alive.
// A timer that loses the take (a write landed between its read and its compare-and-set) looks again a
// moment later, the wake-up still armed and pinned; one that sends nothing leaves the status line
// pinned to a wake-up still armed, else clear.
//
// Where Claude Code's built-in guard passes over this plugin's classic hooks (#53: managed settings, or a Team or
// Enterprise login), no SessionStart names the conversation a move goes to. A partner on the engine's own events does
// that hook's work there instead, and only there (classic.ts): session.end says a /clear or a /resume began, and the
// first read of `$.session.id()` as another conversation takes the move up (moved), as that SessionStart would, with
// follow's rule. Until it has, a wake-up that comes due waits for it, so it never fires into a conversation a /resume
// moved to; and one armed meanwhile, in a turn of the conversation moved to, goes with the move. At the process's
// start, the conversation `$.session.id()` names is the one held, so a /branch is seen as it is where the event names it.
//
// The wake marker (S10w's read, for self-switch and the coordinator): %LOCALAPPDATA%\claude-self-tools\
// wake\<conversation>.json = { v: 1, armed, due?, at }, `armed` true only while this process holds a
// timer for that conversation's wake-up. Written at the start of each conversation this process holds
// (session.start, and each classic SessionStart by its event's id: a fork's writes its own marker and
// moves nothing, by the rule self-switch reads the same id by, movesConversation), when a wake-up is armed or
// replaced, when it fires, when it is cancelled, and when a move carries it on or drops it; and for the
// conversation an in-place /resume or /clear left, which no timer of this process holds any more. Each
// write replaces the file whole. The path is built from the conversation's id by the shared machine
// code (wakePath), which refuses anything but a session id. A wake-up keeps the conversation it was
// armed in, in $.state with it, so a reload arms it again for that one. The armed marker is awaited,
// and written once more when it fails: a marker left saying none is armed would let a switch or a go
// drop the wake-up. Failing twice, it is removed (a fixed script: a plugin can't delete a file), which
// reads as unknown and holds, and a toast says so; if it can't be removed either, the toast says a
// switch may not see the wake-up.
import type { EngineInterface, Register, Timer } from 'claude-code'
import type { QueuedWake, Wake } from '../types'
import { idleWords } from './at-idle'
import { type ClassicIo, classicSeen, configureClassic, keepClassic, type Move, moveBegins, moveLook, movePending, startPartner, takeOwedStart } from './classic'
import { ID_LAG_MS, idLag, isSafeFolder, movesConversation, powershellPath, removeWakeMarker, SESSION_ID, stateFolder, SYSTEM_ROOT, wakeMarker, wakePath } from './machine'
import { configureUpdateCheck, loadUpdateCheck, withUpdateNotice } from './update-check'

const queued = { plugin: 'self-wake', key: 'queued' } as const
const armed = { plugin: 'self-wake', key: 'armed' } as const

const MINUTE = 60 * 1000
/** How long a timer that lost the take waits before it looks again, and how many looks it takes in all. */
const FIRE_RETRY_MS = 1000
const FIRE_TRIES = 3
const MIN_MINUTES = 1
const MAX_MINUTES = 1440
/**
 * #67: a wait shorter than a few minutes, in seconds. Its floor keeps a wake-up from standing in for a wait within a
 * turn; its ceiling is a day, as `minutes`' is.
 */
const MIN_SECONDS = 30
const MAX_SECONDS = 86_400

const WAKE_DESCRIPTION = [
  'Wakes this session later: `minutes` or `seconds` after the current turn ends, the session sends itself "Wake-up: <note>", which starts a turn of its own.',
  'Call it when the next step has to wait for something that takes time (a deploy, a long job, a check that reports later) and nothing will tell you when it is done, so you can check back without the user prompting you.',
  'Not for waiting within a turn, not when a message or notification will arrive on its own, and not when a message says another plugin keeps the timer for you.',
  `Give one of \`minutes\` (${MIN_MINUTES} to ${MAX_MINUTES}) or \`seconds\` (${MIN_SECONDS} to ${MAX_SECONDS}, for a wait of under a few minutes).`,
  '`note` is what to check or do on waking, with where its details are.',
  'One wake-up at a time: a new one replaces the one before. A wake-up lasts as long as the session stays in this conversation: a /clear carries it into the new one, and a /resume or a switch to another conversation drops it, and says so.',
  'The wait starts once your answer is shown.',
  idleWords(),
].join(' ')

const CANCEL_DESCRIPTION = [
  'Cancels the wake-up set with wake_after, if there is one. Call it when what you were waiting for has arrived or no longer matters.',
].join(' ')

const SUBAGENT =
  "A subagent can't set or cancel the session's wake-ups. Finish your piece and return its result, saying what to check later and when: the main session can set the wake-up."

/** This module's timer for the armed wake; a reload drops it, and session.start arms a new one. */
let timer: Timer | undefined

/**
 * The conversation this process holds: each main-loop classic SessionStart's own id, of a startup, a
 * resume or a clear (`$.session.id()` may still read the one before at an in-place resume), and at
 * session.start until one comes. A fork's names nothing here: the foreground stays.
 */
let current: string | undefined

/** When the SessionStart that named `current` came, by the engine's clock; undefined once it was read from `$.session.id()`. */
let currentAt: number | undefined

/** The wake-up this module's timer holds: the conversation it was armed in, its id, and when it is due. */
let held: { conversation: string | undefined; readonly id: string; readonly dueAt: number } | undefined

/**
 * The armed wake-up as this module knows it: undefined until loaded (its first read of $.state, after a
 * start or a reload), null once known to be none (fired, cancelled, dropped, or none there), else the
 * wake-up. Once loaded it stands over $.state: the copy a /clear or a /resume doesn't empty, nor a /resume
 * bring back stale.
 */
let kept: Wake | null | undefined

/**
 * #53: a wake-up armed while a move a session end began was pending (classic.ts, movePending): the turn that armed it
 * ran in the conversation moved to, which `$.session.id()` didn't name yet, so the move takes it there.
 */
let adoptOnMove: string | undefined

/** Whether two armed wake-ups are one, as $.state would hold them. */
const sameWake = (a: Wake | null, b: Wake | null): boolean =>
  a === null || b === null ? a === b : a.id === b.id && a.dueAt === b.dueAt && a.note === b.note && a.conversation === b.conversation

/** Whether a failed marker write was logged already: once per process. */
let warned = false

/**
 * The conversation this process holds now, or undefined when it can't be read: by the rule self-switch
 * holds a switch by (idLag). The SessionStart's id stands while `$.session.id()` lags it; past that the
 * id is the conversation, from here (a /branch, whose fork's SessionStart names nothing here).
 */
async function conversation($: EngineInterface): Promise<string | undefined> {
  // #53: a /clear or a /resume no classic SessionStart named, taken up first, once the id reads the conversation it moved to.
  if (movePending()) await lookForMove($)
  let own: string | undefined
  try {
    const id = await $.session.id()
    own = SESSION_ID.test(id) ? id : undefined
  } catch {
    own = undefined
  }
  if (current === undefined) return own
  if (own === undefined) return current
  if (idLag(current, currentAt, own, await $.clock.now()) === 'stale') {
    const left = current
    current = own
    currentAt = undefined
    // A /branch: the foreground is the fork now, and the id says so. The wake-up goes with it, as at a /clear.
    if (held !== undefined && held.conversation === left) {
      const value = kept !== undefined ? kept : (await armedWake($)).value
      if (value !== null && value.id === held.id) await carry($, left, own, value)
    }
  }
  return current
}

/**
 * Writes conversation `id`'s wake marker: armed, with when it is due, while this module's timer holds
 * that conversation's wake-up; else not armed. Whether it was written (or there is none to write: no
 * conversation, no state folder); never throws. A write that fails is logged once per process. It
 * leaves the marker before it in place, which a switch or a go reads as it stands: for the armed
 * marker, arm() tries again, then removes it (unmark).
 */
async function mark($: EngineInterface, id: string | undefined): Promise<boolean> {
  if (id === undefined || !SESSION_ID.test(id)) return true
  // No %LOCALAPPDATA% (off Windows), or one that can't be read: there are no markers here at all.
  let local: string | undefined
  try {
    local = await $.env.get('LOCALAPPDATA')
  } catch {
    return true
  }
  if (!isSafeFolder(local)) return true
  try {
    const path = wakePath(stateFolder(local), id)
    const armedHere = held !== undefined && held.conversation === id ? held : undefined
    await $.fs.write(path, wakeMarker({ armed: armedHere !== undefined, ...(armedHere === undefined ? {} : { due: armedHere.dueAt }), at: await $.clock.now() }))
    return true
  } catch (err) {
    if (!warned) {
      warned = true
      try {
        $.ui.log(`self-wake: the wake marker for ${id} wasn't written (${err instanceof Error ? err.message : String(err)}); the marker there before, if any, still stands.`)
      } catch {
        // Nowhere to say it.
      }
    }
    return false
  }
}

/**
 * The armed marker for conversation `id` couldn't be written, twice, and the one in place may say no
 * wake-up is armed, which a switch or a go would read as none, dropping this one. So it is removed, by
 * the one fixed script, run from the machine code (removeWakeMarker; a plugin can't delete a file): with self-wake on and no
 * marker, the wake-up reads as unknown, which holds. A toast and the log say which came of it.
 */
async function unmark($: EngineInterface, id: string): Promise<void> {
  let removed = false
  try {
    const root = await $.env.get('SystemRoot')
    const local = await $.env.get('LOCALAPPDATA')
    if (root !== undefined && SYSTEM_ROOT.test(root) && isSafeFolder(local)) {
      removed = await removeWakeMarker($, powershellPath(root), stateFolder(local), id)
    }
  } catch {
    removed = false
  }
  const said = removed
    ? "Wake-up set, but its marker couldn't be written, so it was removed: a switch or a go here reads this wake-up as unknown, and holds, until it fires or is cancelled."
    : "Wake-up set, but its marker couldn't be written or removed: a switch or a go here may not see this wake-up. Cancel it (cancel_wake) before switching away, or set it again."
  try {
    $.ui.toast(said)
    $.ui.log(`self-wake: ${said} (conversation ${id})`)
  } catch {
    // Nowhere to say it.
  }
}

/** Trimmed text, or undefined when it is not a string or is blank. */
function text(raw: unknown): string | undefined {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed === '' ? undefined : trimmed
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/** Whether a call gave a field: anything but undefined or null. */
const isGiven = (raw: unknown): boolean => raw !== undefined && raw !== null

/** How long until `dueAt`, in whole minutes, at least one. */
const dueIn = (dueAt: number, now: number): string => plural(Math.max(1, Math.ceil((dueAt - now) / MINUTE)), 'minute')

/** The status line while a wake is armed, its note cut short. */
const pinned = (note: string): string => `wake-up pending: ${note.length > 60 ? `${note.slice(0, 59)}…` : note}`

/**
 * The armed wake-up, with the version $.state stands at. The module's first read loads its copy from
 * $.state (after a start or a reload); from then on the module's copy stands, and a $.state value that
 * differs (emptied at a /clear or a /resume, or a stale one a /resume brought back) is written over with
 * it, a plain set.
 */
async function armedWake($: EngineInterface): Promise<{ readonly value: Wake | null; readonly version: number }> {
  const stored = await $.state.get(armed)
  const value = stored.value ?? null
  if (kept === undefined) {
    kept = value
    return { value, version: stored.version }
  }
  if (sameWake(value, kept)) return { value: kept, version: stored.version }
  const back = await $.state.set(armed, kept)
  // #53: the wipe took the word that classic hooks reach this process too: it goes back with the wake-up (classic.ts).
  await keepClassic($, classicIo($))
  return { value: kept, version: back.version }
}

/** The status line once a timer sent nothing: pinned to the wake-up still armed, if there is one, else clear. */
function restatus($: EngineInterface): void {
  $.ui.status(kept === undefined || kept === null ? undefined : pinned(kept.note))
}

/** Tells the model on its next turn, in a row it reads and the person doesn't see as typed. */
async function tellModel($: EngineInterface, note: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
  } catch {
    // The toast has told the person; there is no other way to reach the model.
  }
}

/** When a wake-up is due, as the person's clock reads it: HH:MM. */
function clockOf(at: number): string {
  const when = new Date(at)
  return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
}

/** The armed marker for `id` written, awaited, once more when it fails, and removed when it fails again (as arm() does). */
async function markArmed($: EngineInterface, id: string | undefined): Promise<void> {
  if (!(await mark($, id)) && !(await mark($, id)) && id !== undefined) await unmark($, id)
}

/** This timer's hold on wake-up `id` ends: the marker of the conversation it held it for says so. */
async function letGo($: EngineInterface, id: string): Promise<void> {
  const was = held !== undefined && held.id === id ? held.conversation : undefined
  if (held !== undefined && held.id === id) held = undefined
  await mark($, was)
}

async function fire($: EngineInterface, id: string, tries = 1): Promise<void> {
  // #53: a /clear or a /resume no classic SessionStart named, not yet taken up: what becomes of the wake-up waits for it
  // (the look settles it within seconds), so it never fires into a conversation a /resume moved to.
  if (movePending()) {
    await lookForMove($)
    if (movePending()) {
      timer = $.clock.after(FIRE_RETRY_MS, () => void fire($, id, tries))
      return
    }
  }
  const stored = await armedWake($)
  const wake = stored.value
  if (wake?.id !== id) {
    // Not this wake-up any more (cancelled, replaced or dropped meanwhile): nothing to send.
    await letGo($, id)
    restatus($)
    return
  }
  const taken = await $.state.set(armed, null, { ifVersion: stored.version })
  if (!taken.isSet) {
    // A write landed between the read and the take: the wake-up is still armed, and the timer looks again.
    if (tries < FIRE_TRIES) {
      timer = $.clock.after(FIRE_RETRY_MS, () => void fire($, id, tries + 1))
      restatus($)
      return
    }
    // Lost every take: it is dropped, said, never left armed with no timer.
    kept = null
    await $.state.set(armed, null)
    await letGo($, id)
    $.ui.status(undefined)
    $.ui.toast(`Wake-up not sent: it couldn't be taken from session state (another write came first, ${FIRE_TRIES} times), so it is dropped.`)
    await tellModel($, `self-wake: your wake-up ("${wake.note}") wasn't sent: it couldn't be taken from session state, so it is dropped. Set it again if it is still needed.`)
    return
  }
  // Taken: only now is the module's copy none.
  kept = null
  await letGo($, id)
  $.ui.status(undefined)
  try {
    const sent = await $.prompt.submit({ text: `Wake-up: ${wake.note}` })
    if (sent.drop !== undefined) $.ui.toast(`Wake-up not sent: ${sent.drop}`)
  } catch {
    $.ui.toast('Wake-up not sent; the session waits for the next message.')
  }
}

/**
 * Starts this module's timer for `wake`, in place of any it had; one already due fires at once. The
 * wake-up belongs to `conversation`, whose marker then says armed (and the one a replaced wake-up
 * belonged to, if another, not). The armed marker is awaited, so a switch or a go queued in the same
 * turn reads it, and written once more if that fails; failing again, it is removed (unmark), awaited
 * too: a switch's read right after must not find the stale marker saying none.
 */
async function arm($: EngineInterface, wake: Wake, now: number, conversationOf: string | undefined): Promise<void> {
  timer?.cancel()
  const replaced = held?.conversation
  held = { conversation: conversationOf, id: wake.id, dueAt: wake.dueAt }
  timer = $.clock.after(Math.max(0, wake.dueAt - now), () => void fire($, wake.id))
  $.ui.status(pinned(wake.note))
  if (!(await mark($, conversationOf)) && !(await mark($, conversationOf)) && conversationOf !== undefined) await unmark($, conversationOf)
  if (replaced !== undefined && replaced !== conversationOf) void mark($, replaced)
}

/** The conversation a stored wake-up belongs to: its own, kept with it; else (one armed before 0.2.0) `here`. */
const ownerOf = (wake: Wake, here: string | undefined): string | undefined => (typeof wake.conversation === 'string' && SESSION_ID.test(wake.conversation) ? wake.conversation : here)

/**
 * The armed wake-up carried on from conversation `owner` to `here`: re-keyed in the module's copy, the
 * timer's hold and $.state, `here`'s marker armed (awaited, as arm's is) and the one it belonged to not.
 */
async function carry($: EngineInterface, owner: string | undefined, here: string, value: Wake): Promise<void> {
  const moved: Wake = { ...value, conversation: here }
  kept = moved
  if (held !== undefined && held.id === value.id) held.conversation = here
  await $.state.set(armed, moved)
  await markArmed($, here)
  if (owner !== undefined && owner !== here) void mark($, owner)
}

/**
 * What a move makes of the armed wake-up, at the main loop's SessionStart of a clear or a resume, from
 * `previous` (the conversation held until now) to `here`, decided by the module's copy once loaded. A
 * /clear carries it on (carry). A /resume (a switch in place too) to another conversation drops it: its
 * timer stopped, $.state none, the status line cleared, a toast naming it, and a note to the model in
 * `here` that doesn't, so the other conversation's task doesn't carry over. A /resume of the conversation it
 * belongs to keeps it. Where nothing moves, $.state is made the module's copy.
 */
async function follow($: EngineInterface, source: 'clear' | 'resume', previous: string | undefined, here: string): Promise<void> {
  const value = kept !== undefined ? kept : (await armedWake($)).value
  const owner = value === null ? undefined : ownerOf(value, previous)
  if (value === null || owner === here) {
    await armedWake($)
    return
  }
  if (source === 'clear') return await carry($, owner, here, value)
  timer?.cancel()
  timer = undefined
  if (held !== undefined && held.id === value.id) held = undefined
  kept = null
  $.ui.status(undefined)
  const note = value.note.length > 60 ? `${value.note.slice(0, 59)}…` : value.note
  $.ui.toast(`Wake-up dropped: it was set in another conversation (due ${clockOf(value.dueAt)}: "${note}"), and this session moved.`)
  await tellModel($, 'self-wake: a wake-up from another conversation was dropped when this session moved here.')
  if (owner !== undefined) void mark($, owner)
  await $.state.set(armed, null)
}

/**
 * #53: the classic SessionStart's work at this process's start, where no classic hook reached the plugin within
 * START_GRACE_MS of session.start (classic.ts, startPartner): the conversation `$.session.id()` names is the one held,
 * so a later id that names another without a move (a /branch) carries the wake-up there (conversation), as it does
 * where the event names it. session.start armed the wake-up and wrote the marker already.
 */
async function guardedStart(id: string): Promise<void> {
  if (current !== undefined) return
  current = id
  currentAt = undefined
}

/**
 * #53: the classic SessionStart's work at an in-process /clear or /resume, where none reached the plugin: the move a
 * session end began, taken up at the first read of `$.session.id()` as another conversation (classic.ts, moveLook).
 * The conversation held moves; a /clear carries the armed wake-up on and a /resume to another conversation drops it
 * (follow), except one armed in a turn of the conversation moved to while the move was pending, which goes with it;
 * and both conversations' markers say so.
 */
async function moved($: EngineInterface, move: Move): Promise<void> {
  const previous = current ?? move.from
  current = move.to
  currentAt = undefined
  const adopted = adoptOnMove
  adoptOnMove = undefined
  try {
    const value = kept !== undefined ? kept : (await armedWake($)).value
    if (value !== null && value.id === adopted) await carry($, ownerOf(value, previous), move.to, value)
    else await follow($, move.reason, previous, move.to)
  } catch {
    // The next read puts $.state right; the timer goes by the module's copy.
  }
  void mark($, move.to)
  if (previous !== move.to) void mark($, previous)
}

/** #53: the shared partner code's two keys (classic.ts), in this plugin's own $.state, read and written here by name. */
const classicRef = { plugin: 'self-wake', key: 'classic' } as const
const startedRef = { plugin: 'self-wake', key: 'started' } as const

/** #53: this plugin's $.state, as the shared partner code reads and writes it (classic.ts, ClassicIo). */
function classicIo($: EngineInterface): ClassicIo {
  return {
    get: async key => (key === 'classic' ? (await $.state.get(classicRef)).value : (await $.state.get(startedRef)).value),
    set: (key, value) => (key === 'classic' ? $.state.set(classicRef, value === true) : $.state.set(startedRef, typeof value === 'string' ? value : null)),
  }
}

/** #53: a move a session end began, looked for now (classic.ts, moveLook), and taken up here when found (moved). */
function lookForMove($: EngineInterface): Promise<void> {
  return moveLook($, classicIo($), move => moved($, move))
}

export const register: Register = (on, options) => {
  configureUpdateCheck('self-wake', options)
  // #53: the classic SessionStart's partners, which act only where no classic hook reaches this process (classic.ts).
  configureClassic()

  // First, so it is outermost on this plugin's tools: it sees each answer, and adds the update
  // notice when one is due. It never waits on the check; see update-check.ts.
  on('tool.call', { tool: /^mcp__self-wake__/ }, async ($, e, next) => withUpdateNotice($, e, await next(e))).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'wake_after',
      description: WAKE_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          minutes: {
            type: 'number',
            description: `How long after this turn ends, in minutes: ${MIN_MINUTES} to ${MAX_MINUTES} (a day); a number outside that is brought within it. Give this or \`seconds\`.`,
          },
          seconds: {
            type: 'number',
            description: `How long after this turn ends, in seconds: ${MIN_SECONDS} to ${MAX_SECONDS} (a day); a number outside that is brought within it. Give this or \`minutes\`.`,
          },
          note: { type: 'string', description: 'What to check or do on waking, and where its details are.' },
        },
        required: ['note'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'cancel_wake',
      description: CANCEL_DESCRIPTION,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      isDeferred: false,
    })
    // After a reload: the wake is still in $.state, its timer gone. It is armed again for the
    // conversation it was armed in, kept with it: never the one a later SessionStart names.
    const { value } = await armedWake($)
    const here = await conversation($)
    if (value) await arm($, value, await $.clock.now(), ownerOf(value, here))
    // The marker of the conversation this process starts in: armed or not, as its timer says.
    else void mark($, here)
    loadUpdateCheck($)
    // #53: where the classic SessionStart doesn't reach this plugin, its partner takes this process's start up.
    // Awaited for its bounded reads (whether this is the first start), which must come before turn one.
    await startPartner($, classicIo($), guardedStart)
    return started
  })

  // #53: a /clear or a /resume, where no classic SessionStart will name the conversation it moves to: looked for from
  // here (moveLook), and taken up as that SessionStart would take it (moved). Before the engine's end step: a memory
  // read, a clock read and the look's timer, inside the session end's one short bound.
  on('session.end', async ($, e, next) => {
    await moveBegins($, classicIo($), e, move => moved($, move))
    return next(e)
  }).catch(($, e, next) => next(e))

  // Each conversation this process comes to holds its marker, by the event's own id: at a startup, a
  // resume or a clear. A timer armed at session.start belongs to the conversation its wake-up names (a
  // reload's first SessionStart is a move to another, never the conversation it was armed in), or, when
  // none could be read then, to the first one named here. An in-place move leaves a conversation whose
  // wake-up no timer of this process holds any more: a /clear carries the wake-up on to the conversation
  // it starts, and a /resume to another drops it (follow), and the marker of the one left says none.
  // A fork's event (the /fork background copy, a conversation moved to the background) writes the
  // fork's marker and moves nothing: the foreground stays where it was, and a wake-up set there is
  // that conversation's, or a switch from it would read none and drop the wake-up.
  // It answers what the chain beneath answered, always, and quickly (the markers are written after,
  // unawaited); a failure here passes the start through unchanged (the .catch).
  // #53: first, before anything is awaited, it says classic hooks reach this process, and the partners stand down.
  on('classic.SessionStart', async ($, e, next) => {
    void classicSeen($, classicIo($), e)
    const done = await next(e)
    if (e.agent_id !== undefined || typeof e.session_id !== 'string' || !SESSION_ID.test(e.session_id)) return done
    if (!movesConversation(e.source)) {
      void mark($, e.session_id)
      // A fork's start: if it was a /branch, `$.session.id()` reads the fork once past its lag, and the
      // wake-up goes with it (conversation). Looked at then, and at each main-loop turn's end.
      if (e.source === 'fork' && held !== undefined) $.clock.after(ID_LAG_MS + 1000, () => void conversation($).catch(() => undefined))
      return done
    }
    const previous = current
    current = e.session_id
    currentAt = await $.clock.now()
    // A /clear carries the armed wake-up on; a /resume to another conversation drops it (follow). $.state,
    // which the move empties now or a moment after, is made the module's copy; a later read does it again.
    if (e.source === 'clear' || e.source === 'resume') {
      try {
        await follow($, e.source, previous, current)
      } catch {
        // The next read puts $.state right; the timer goes by the module's copy.
      }
    }
    if (previous === undefined && held !== undefined && held.conversation === undefined) {
      held.conversation = current
      if (kept !== undefined && kept !== null && kept.id === held.id && kept.conversation === undefined) kept = { ...kept, conversation: current }
    }
    void mark($, current)
    if (previous !== undefined && previous !== current) void mark($, previous)
    return done
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__self-wake__wake_after' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: SUBAGENT }
    const input = e as { minutes?: unknown; seconds?: unknown; note?: unknown }
    // #67: `seconds` beside `minutes`, for a wait of under a few minutes; a call of before, with `minutes`, works as it did.
    // A field given as null is read as left out, as a caller that sends every field may send the other.
    const inSeconds = isGiven(input.seconds)
    if (inSeconds && isGiven(input.minutes)) return { deny: 'Give `minutes` or `seconds`, not both.' }
    const range: readonly [number, number, 'second' | 'minute'] = inSeconds ? [MIN_SECONDS, MAX_SECONDS, 'second'] : [MIN_MINUTES, MAX_MINUTES, 'minute']
    const [low, high, unit] = range
    const raw = inSeconds ? input.seconds : input.minutes
    const asked = typeof raw === 'number' ? raw : Number(text(raw) ?? Number.NaN)
    if (!Number.isFinite(asked)) return { deny: `\`${unit}s\` is a number from ${low} to ${high}${inSeconds ? '' : `, or give \`seconds\` (${MIN_SECONDS} to ${MAX_SECONDS})`}.` }
    const note = text(input.note)
    if (note === undefined) return { deny: 'Say what to wake up to (`note`).' }
    const amount = Math.min(high, Math.max(low, asked))
    const [before, earlier, now] = await Promise.all([$.state.get(queued), armedWake($), $.clock.now()])
    const wait: QueuedWake = inSeconds ? { seconds: amount, note } : { minutes: amount, note }
    await $.state.set(queued, wait)
    $.ui.status(`wake-up queued for when this turn ends: ${note.length > 40 ? `${note.slice(0, 39)}…` : note}`)
    const clamped = amount === asked ? '' : ` (${asked} is outside ${low} to ${high})`
    const replaces = before.value
      ? ` It replaces the wake-up queued earlier this turn ("${before.value.note}").`
      : earlier.value
        ? ` It replaces the wake-up due in ${dueIn(earlier.value.dueAt, now)} ("${earlier.value.note}").`
        : ''
    return {
      result: `Queued: ${plural(amount, unit)} after this turn ends${clamped}, the session sends itself "Wake-up: ${note}".${replaces}`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-wake: queuing the wake-up failed; nothing is queued.' }))

  on('tool.call', { tool: 'mcp__self-wake__cancel_wake' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: SUBAGENT }
    const [before, earlier, now] = await Promise.all([$.state.get(queued), armedWake($), $.clock.now()])
    await $.state.set(queued, null)
    kept = null
    await $.state.set(armed, null)
    timer?.cancel()
    timer = undefined
    const was = held?.conversation
    held = undefined
    // Cancelled: the marker says no wake-up is armed, for this conversation and the one it was armed in.
    const here = await conversation($)
    await mark($, here)
    if (was !== undefined && was !== here) await mark($, was)
    $.ui.status(undefined)
    const gone = [
      ...(earlier.value ? [`the wake-up due in ${dueIn(earlier.value.dueAt, now)} ("${earlier.value.note}")`] : []),
      ...(before.value ? [`the wake-up queued this turn ("${before.value.note}")`] : []),
    ]
    return { result: gone.length === 0 ? 'No wake-up was set; nothing to cancel.' : `Cancelled ${gone.join(' and ')}.` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-wake: cancelling failed; a wake-up may still be set.' }))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    // #53: the word that classic hooks reach this process, put back after a /clear's or a /resume's wipe (classic.ts);
    // and a start whose id never settled, taken up now.
    await keepClassic($, classicIo($))
    await takeOwedStart($, classicIo($))
    // The conversation as the id now reads it: a /branch past its lag carries the wake-up to the fork.
    if (held !== undefined) await conversation($).catch(() => undefined)
    const { value } = await $.state.get(queued)
    if (!value) return done
    await $.state.set(queued, null)
    if (e.isAborted || e.reason !== 'answer') {
      const { value: standing } = await armedWake($)
      $.ui.status(standing ? pinned(standing.note) : undefined)
      $.ui.toast(`Wake-up not set: the turn didn't finish.${standing ? ' The one set before stands.' : ''}`)
      return done
    }
    const now = await $.clock.now()
    const here = await conversation($)
    // #53: a move no SessionStart named, pending still: this turn ran in the conversation it moves to, and the wake-up goes there with it.
    const isMoving = movePending()
    const wake: Wake = {
      id: `${now}-${Math.random().toString(36).slice(2, 10)}`,
      dueAt: now + ('seconds' in value ? value.seconds * 1000 : value.minutes * MINUTE),
      note: value.note,
      ...(here === undefined ? {} : { conversation: here }),
    }
    kept = wake
    adoptOnMove = isMoving ? wake.id : undefined
    await $.state.set(armed, wake)
    await arm($, wake, now, here)
    return done
  })
}
