// Where Claude Code's built-in guard loads, the classic hooks don't run: what does their work there (#53, #52).
//
// Canonical copy: shared/hooks/classic.ts. It is copied, identical, to the plugins named on the next
// line, each at hooks/classic.ts; `node scripts/sync-shared.mjs` writes them. Edit this copy only.
// Copies: self-check, self-color, self-reload, self-remote-control, self-restart, self-switch, self-wake
//
// Claude Code loads a built-in guard (`cc-plugin-sec-default`) ahead of every plugin a person installs where the
// machine has managed settings, or where the session runs on `/login` credentials for a Team or Enterprise plan.
// Where it loads, a hook a person's plugin registers on a `classic.<Event>` never runs, and `/plugin`'s Errors tab
// says so (the mods admin docs, "Know which hooks of a user's mod don't run"). scripts/guarded-hooks.mjs keeps that
// list, and the guarded hooks each plugin keeps, each with its partner; its test fails on any other.
//
// Each classic hook a plugin keeps stays as it was, for every session the guard doesn't load in, and says first of
// all, before anything is awaited, that it ran (classicSeen). Beside it, a partner on the engine's own events, which
// the guard lets through, does that hook's work only while no classic hook has reached this process:
//   - the work of a process's start (startPartner), only on the process's own first start: before any user input of
//     the process (`$.session.info().promptId` is absent until then, by the engine's word, read inside session.start,
//     which the engine awaits before turn one), never a reload or a plugin enabled partway through a session, which
//     come after input. START_GRACE_MS after session.start, once the id reads the same conversation on two reads
//     ID_SETTLE_EVERY_MS apart, the second of them START_LAG_MS after session.start (the id may still read the one
//     before that long), or sooner for an id with work of its own waiting (the plugin's `ready`); within
//     ID_SETTLE_FOR_MS, else at the first main-loop turn (takeOwedStart). Once per conversation in a process, kept in
//     $.state (`started`);
//   - the work of an in-process /clear or /resume (moveBegins, moveLook): session.end names the conversation ending
//     and why, and the first read of `$.session.id()` that names another conversation takes the move up, as the
//     classic SessionStart of that move would have. Read every MOVE_LOOK_MS for MOVE_LOOK_FOR_MS, and whenever the
//     plugin looks itself (before it reads the conversation, before a timer of its own acts).
// The moment a classic hook arrives, every partner stands down (onClassicSeen): its timers stop, and a move pending
// is left to that hook.
//
// Whether one arrived is kept in $.state (`classic`), so a reload knows it. Claude Code empties a plugin's $.state at
// an in-process /clear or /resume, now or a moment after that move's SessionStart; a reload that then read nothing
// would take an unguarded process for a guarded one, and both paths could act. So every classic hook writes it, each
// SessionStart writes it again MARK_AGAIN_MS later, and each plugin writes it back wherever it puts its own state back
// after a wipe (keepClassic); the start a SessionStart names is marked taken up the same way. So in a session the guard
// doesn't load in, the classic hook does the work as before, and the partner does nothing. A plugin loaded partway
// through such a session counts as guarded until its first classic hook arrives (nothing came before it to say
// otherwise); its start partner never runs there (a load after input is no first start), and each move partner's work
// is taken once, whichever path comes first, so even then nothing is done twice.
//
// The two keys live in each plugin's own $.state, which a module reads only by refs written in its own file, so each
// plugin reads and writes them (its ClassicIo) and hands that in. Every function here answers or settles; none
// throws. Each read of $.state is bounded (STATE_READ_MS).
import type { EngineInterface, Timer } from 'claude-code'

/** How long after session.start a start's work waits for a classic hook to say the guard isn't loaded. */
export const START_GRACE_MS = 5000
/** How often a move a session end began is looked for, while it is pending. */
export const MOVE_LOOK_MS = 1000
/** How long a move a session end began is looked for; past it, nothing is taken up, and the plugin reads `$.session.id()` as before. */
export const MOVE_LOOK_FOR_MS = 2 * 60 * 1000
/** How often the id is read after the grace, until two reads in a row name the same conversation. */
export const ID_SETTLE_EVERY_MS = 1000
/** How long the id is read for that; past it, the start is owed to the first main-loop turn (takeOwedStart). */
export const ID_SETTLE_FOR_MS = 20_000
/**
 * How long after a start `$.session.id()` may still read the conversation before it, steady: the shared machine code's
 * ID_LAG_MS (seen live at in-place moves on 2.1.318). Two reads that agree count only from then on, unless the id read
 * has work of its own waiting (a restart's record, a switch's ticket).
 */
export const START_LAG_MS = 15_000
/** When a mark is written again after a move: Claude Code's wipe of $.state may land a moment after the move. */
export const MARK_AGAIN_MS = 5000
/** How long a read of $.state here may take; past it, it reads as nothing known. */
export const STATE_READ_MS = 2000

/** A session id, as `claude --resume` takes it. */
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The plugin's own $.state, for the two keys here (each plugin's types declare them, ClassicState): `classic`, true
 * once a classic hook reached this process; `started`, the conversation whose start this process took up.
 */
export type ClassicIo = {
  readonly get: (key: 'classic' | 'started') => Promise<unknown>
  readonly set: (key: 'classic' | 'started', value: boolean | string) => Promise<unknown>
}

/** A move of this process's conversation, in place, as the partner took it up: the conversation left, the one now held, and why. */
export type Move = { readonly from: string; readonly to: string; readonly reason: 'clear' | 'resume' }

/** What a plugin does when a move is taken up: the work of that move's classic SessionStart. */
export type TakeMove = (move: Move) => Promise<void>

/** How the process's conversation began (startSource): `resume` when a read at session.start or at the take-up says so. */
export type StartSource = 'startup' | 'resume' | undefined

/** Whether conversation `id` has work of the plugin's own waiting for it (a restart's record, a switch's ticket). */
export type StartReady = (id: string) => Promise<boolean>

/** What a plugin does when its start is taken up: the work of that start's classic SessionStart, for conversation `id`. */
export type StartWork = (id: string, source: StartSource) => Promise<void>

// What this load of the plugin knows. Module state, so a reload starts it afresh; configureClassic starts it over.
/** Whether a classic hook reached this process, in this load or (from $.state) one before; undefined until read. */
let classic: boolean | undefined
/** What stands down the moment a classic hook arrives: the partners' timers. */
let standDowns: Array<() => void> = []
/** A move a session end began, not yet taken up: the conversation it left, why, and when. */
let left: { readonly from: string; readonly reason: 'clear' | 'resume'; readonly at: number } | undefined
/** The look timer, while a move is pending. */
let looking: Timer | undefined
/** A take-up running now: another look waits for it. */
let taking: Promise<void> | undefined
/** The conversation whose start this load last marked taken up (`started`): written back with `classic` after a wipe. */
let startedOf: string | undefined
/** The start partner's timer, while it waits or reads the id. */
let startTimer: Timer | undefined
/** A start whose id never settled: taken at the first main-loop turn (takeOwedStart). */
let owed: { readonly source: StartSource; readonly work: StartWork } | undefined
/** How many moves this load took up: a start partner stands down for a move taken since its session.start. */
let movesTaken = 0

/** Starts this module over, at register. */
export function configureClassic(): void {
  classic = undefined
  standDowns = []
  left = undefined
  looking?.cancel()
  looking = undefined
  taking = undefined
  startedOf = undefined
  startTimer?.cancel()
  startTimer = undefined
  owed = undefined
  movesTaken = 0
}

/** A value of the plugin's, read within STATE_READ_MS; undefined when it can't be, or isn't there. */
function readKept($: EngineInterface, io: ClassicIo, key: 'classic' | 'started'): Promise<unknown> {
  return new Promise(resolve => {
    let timer: Timer | undefined
    try {
      timer = $.clock.after(STATE_READ_MS, () => resolve(undefined))
    } catch {
      timer = undefined
    }
    let reading: Promise<unknown>
    try {
      reading = io.get(key)
    } catch {
      reading = Promise.resolve(undefined)
    }
    reading.then(
      value => {
        timer?.cancel()
        resolve(value)
      },
      () => {
        timer?.cancel()
        resolve(undefined)
      },
    )
  })
}

/** Writes a value of the plugin's; never throws. */
async function writeKept(io: ClassicIo, key: 'classic' | 'started', value: boolean | string): Promise<void> {
  try {
    await io.set(key, value)
  } catch {
    // Written again at the next classic hook, or the plugin's next write-back.
  }
}

/** Whether classic hook events reach this plugin in this process: one did, in this load or (from $.state) one before. */
export async function classicRuns($: EngineInterface, io: ClassicIo): Promise<boolean> {
  if (classic === undefined) {
    // Read into a local first: a classic hook that arrives while the read is in flight sets it, and stands.
    const value = await readKept($, io, 'classic')
    classic ??= value === true
  }
  return classic
}

/** As classicRuns, from memory alone: true once a classic hook reached this load, or $.state said so. */
export const classicKnown = (): boolean => classic === true

/** What a partner stops when a classic hook arrives (its timers). */
export function onClassicSeen(fn: () => void): void {
  standDowns.push(fn)
}

/**
 * A classic hook reached the plugin: every partner stands down. Each classic hook calls it first, before anything is
 * awaited; memory is set at once, and $.state every time. A SessionStart (`start`, its event), whose move may empty
 * $.state a moment after it, writes it again MARK_AGAIN_MS later; and the main loop's of a startup, a resume or a clear
 * marks that conversation's start taken up, so a reload in an unguarded process never has a partner take it again.
 */
export async function classicSeen($: EngineInterface, io: ClassicIo, start?: { readonly source?: unknown; readonly session_id?: unknown; readonly agent_id?: unknown }): Promise<void> {
  if (classic !== true) {
    classic = true
    const stopping = standDowns
    standDowns = []
    for (const fn of stopping) {
      try {
        fn()
      } catch {
        // The next one still stands down.
      }
    }
    left = undefined
    looking?.cancel()
    looking = undefined
  }
  const id = start?.session_id
  const moves = start !== undefined && start.agent_id === undefined && (start.source === 'startup' || start.source === 'resume' || start.source === 'clear')
  const named = moves && typeof id === 'string' && SESSION.test(id) ? id : undefined
  if (start !== undefined) {
    try {
      $.clock.after(MARK_AGAIN_MS, () => {
        void writeKept(io, 'classic', true)
        if (named !== undefined && startedOf === named) void writeKept(io, 'started', named)
      })
    } catch {
      // The plugin's own write-back after a wipe puts it back (keepClassic).
    }
  }
  await writeKept(io, 'classic', true)
  if (named !== undefined) await startTaken(io, named)
}

/**
 * Where a plugin puts its own state back after Claude Code emptied $.state (a /clear, a /resume): `classic` back too,
 * when this load knows a classic hook reached it, and the start last taken up, so a later reload reads both. Never
 * throws.
 */
export async function keepClassic($: EngineInterface, io: ClassicIo): Promise<void> {
  if (classic !== true) return
  if ((await readKept($, io, 'classic')) !== true) await writeKept(io, 'classic', true)
  const was = startedOf
  if (was !== undefined && (await readKept($, io, 'started')) !== was) await writeKept(io, 'started', was)
}

/** The conversation this process holds as `$.session.id()` reads it now, or undefined when it reads none. */
async function idNow($: EngineInterface): Promise<string | undefined> {
  try {
    const id = await $.session.id()
    return typeof id === 'string' && SESSION.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

/** Marks the start of conversation `id` as taken up in this process, so a reload's session.start doesn't take it again. */
export async function startTaken(io: ClassicIo, id: string): Promise<void> {
  startedOf = id
  await writeKept(io, 'started', id)
}

/**
 * Whether this load of the plugin is the process's first start: no user input yet in the process's lifetime, which
 * `$.session.info().promptId` says by being absent (the engine's own word: "absent until the first user input of the
 * process lifetime"). A reload and a plugin enabled partway through a session come after input: false. False too when
 * it can't be read, so a start partner never runs on a guess.
 */
export async function firstStart($: EngineInterface): Promise<boolean> {
  try {
    const info = await within($, $.session.info())
    if (info === undefined) return false
    return info.promptId === undefined || info.promptId === ''
  } catch {
    return false
  }
}

/** `work`'s answer, or undefined once STATE_READ_MS have passed without one, or when it fails. */
function within<T>($: EngineInterface, work: Promise<T>): Promise<T | undefined> {
  return new Promise(resolve => {
    let timer: Timer | undefined
    try {
      timer = $.clock.after(STATE_READ_MS, () => resolve(undefined))
    } catch {
      timer = undefined
    }
    work.then(
      value => {
        timer?.cancel()
        resolve(value)
      },
      () => {
        timer?.cancel()
        resolve(undefined)
      },
    )
  })
}

/**
 * The start of conversation `id` taken up, once in this process: never when it was taken already, or a classic hook
 * arrived. A resume when the read at session.start (`source`) or the one now says so: a transcript not counted yet at
 * the start reads as no prompts, and a resume taken for a new conversation errs the safe way (no baseline of its dirt).
 */
async function takeStart($: EngineInterface, io: ClassicIo, id: string, source: StartSource, work: StartWork): Promise<void> {
  const taken = await readKept($, io, 'started')
  if (taken === id || classicKnown()) return
  const now = await within($, startSource($))
  await startTaken(io, id)
  await work(id, source === 'resume' || now === 'resume' ? 'resume' : (source ?? now))
}

/**
 * At session.start, awaited inside it (the engine awaits it before turn one), on the process's first start (firstStart,
 * read there, so a first prompt that comes right after the start can't make it read as a reload) where no classic hook
 * has reached it: `work`, for the conversation the process holds. START_GRACE_MS later, unless a classic hook arrives
 * first, the id is read every ID_SETTLE_EVERY_MS until two reads in a row name the same conversation, the second of
 * them START_LAG_MS after session.start (the id may still read the conversation before that long), or sooner when
 * `ready` says that conversation has work of the plugin's own waiting; and that start is taken up then, unless this
 * process took it up already. An id that hasn't settled ID_SETTLE_FOR_MS after the grace leaves the start owed to the
 * first main-loop turn (takeOwedStart), never dropped. A move a session end began, or one taken up, since session.start
 * stands it down: the move's take-up does that conversation's work. Its reads are bounded; it never throws.
 */
export async function startPartner($: EngineInterface, io: ClassicIo, work: StartWork, ready?: StartReady): Promise<void> {
  try {
    if (await classicRuns($, io)) return
    if (!(await firstStart($))) return
    // Read now, at the start (a prompt typed within the grace would make a new conversation read as a resume); the
    // take-up reads it again, and a resume either time counts.
    const source = await within($, startSource($))
    const begun = await $.clock.now()
    const moves = movesTaken
    let last: string | undefined
    let since: number | undefined
    const look = async (): Promise<void> => {
      startTimer = undefined
      if (classicKnown() || movePending() || movesTaken !== moves) return
      const [id, now] = await Promise.all([idNow($), $.clock.now()])
      // A classic hook, or a move, that came while these were read stands it down too.
      if (classicKnown() || movePending() || movesTaken !== moves) return
      since ??= now
      if (id !== undefined && id === last) {
        // Past the id's lag, two reads that agree name the conversation; before it, only one with its own work waiting.
        const settled = now - begun >= START_LAG_MS || (ready !== undefined && (await ready(id).catch(() => false)))
        if (classicKnown() || movePending() || movesTaken !== moves) return
        if (settled) return await takeStart($, io, id, source, work)
      }
      last = id
      if (now - since >= ID_SETTLE_FOR_MS) {
        owed = { source, work }
        return
      }
      startTimer = $.clock.after(ID_SETTLE_EVERY_MS, () => void look().catch(() => undefined))
    }
    startTimer?.cancel()
    startTimer = $.clock.after(START_GRACE_MS, () => void look().catch(() => undefined))
    onClassicSeen(() => {
      startTimer?.cancel()
      startTimer = undefined
      owed = undefined
    })
  } catch {
    // No partner: the session goes on as it would without one.
  }
}

/**
 * At a main-loop turn: a start whose id never settled (startPartner), taken up now for the conversation the id names,
 * so a restart's first prompt or a switch's arrival waits for the next turn rather than being dropped. Nothing when
 * none is owed, a classic hook has arrived, or a move is pending. Never throws.
 */
export async function takeOwedStart($: EngineInterface, io: ClassicIo): Promise<void> {
  const was = owed
  if (was === undefined || classicKnown() || movePending()) return
  owed = undefined
  try {
    const id = await idNow($)
    if (id === undefined || classicKnown()) return
    await takeStart($, io, id, was.source, was.work)
  } catch {
    // Owed once: a start that can't be read now is not taken.
  }
}

/**
 * How this process's conversation began, where no classic SessionStart says: `resume` when its transcript holds a
 * prompt (--resume, --continue), `startup` when none (a new conversation), undefined when it can't be read.
 */
export async function startSource($: EngineInterface): Promise<'startup' | 'resume' | undefined> {
  try {
    const turns = await $.session.turns()
    return typeof turns !== 'number' ? undefined : turns > 0 ? 'resume' : 'startup'
  } catch {
    return undefined
  }
}

/**
 * At session.end: where no classic hook has reached this process, a /clear or a /resume begins a move of its
 * conversation. Answers the move begun (the conversation ending, and why), else undefined: another reason, or a
 * process whose classic SessionStart takes the move up. For a plugin with work at a move taken up (`take`), the move
 * is looked for from here (moveLook).
 */
export async function moveBegins($: EngineInterface, io: ClassicIo, e: { readonly reason: unknown; readonly sessionId: unknown }, take?: TakeMove): Promise<{ readonly from: string; readonly reason: 'clear' | 'resume' } | undefined> {
  try {
    if (e.reason !== 'clear' && e.reason !== 'resume') return undefined
    if (await classicRuns($, io)) return undefined
    const from = typeof e.sessionId === 'string' ? e.sessionId : ''
    if (take !== undefined) {
      const at = await $.clock.now()
      // A classic hook that arrived meanwhile takes this move up itself.
      if (classicKnown()) return undefined
      left = { from, reason: e.reason, at }
      looking?.cancel()
      looking = $.clock.every(MOVE_LOOK_MS, () => void moveLook($, io, take))
    }
    return { from, reason: e.reason }
  } catch {
    return undefined
  }
}

/** Whether a move a session end began is pending: begun, and `$.session.id()` not yet read as another conversation. */
export const movePending = (): boolean => left !== undefined

/**
 * Looks for the move a session end began: the first read of `$.session.id()` that names another conversation takes
 * it up (`take`), once. Past MOVE_LOOK_FOR_MS, the move is no longer looked for. Settles once a take-up running now
 * has.
 */
export async function moveLook($: EngineInterface, io: ClassicIo, take: TakeMove): Promise<void> {
  if (taking !== undefined) return taking
  const was = left
  if (was === undefined || classicKnown()) return
  try {
    const [id, now] = await Promise.all([idNow($), $.clock.now()])
    // Another look took it up meanwhile: this one settles once that take-up has, so its caller never reads the move as
    // done while it is still being taken up. The winner sets `taking` in the same step as it clears `left`.
    if (left !== was) return taking
    if (classicKnown()) return
    if (now - was.at > MOVE_LOOK_FOR_MS || now < was.at) {
      left = undefined
      looking?.cancel()
      looking = undefined
      return
    }
    if (id === undefined || id === was.from) return
    left = undefined
    looking?.cancel()
    looking = undefined
    movesTaken += 1
    const move: Move = { from: was.from, to: id, reason: was.reason }
    const run = (async () => {
      // The move's start is taken up here: a reload after it doesn't take it again, the wipe's late landing included.
      await startTaken(io, id)
      $.clock.after(MARK_AGAIN_MS, () => {
        if (classic !== true && startedOf === id) void writeKept(io, 'started', id)
      })
      await take(move)
    })().catch(() => undefined)
    taking = run
    await run
    if (taking === run) taking = undefined
  } catch {
    // The next look tries again.
  }
}
