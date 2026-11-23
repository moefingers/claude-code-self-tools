// While the session moves between conversations, `$.session.id()` may still read the conversation it left: after a
// /clear or a /resume (a typed one, clear_after_turn's, an in-place switch) until the id names the one it moved to, and
// in a process's first seconds (every new session, a restart, `claude --resume`). A conversation's own reminder levels
// are kept under its id, so in those windows compact_reminder sets nothing, says so, and the turn-end reminder waits.
//
// self-restart, self-switch and self-wake guard the same lag with the shared code (machine.ts's idLag, classic.ts's
// movePending and START_LAG_MS), led by the classic SessionStart's own id. self-compact hooks no classic event (Claude
// Code's built-in guard passes over them: scripts/guarded-hooks.mjs) and carries no copy of that code, whose copies
// other code pins by hash. So this is its own small guard, on the events every session has: a session.end of a /clear
// or a /resume, until the id reads another conversation, at most MOVE_LOOK_FOR_MS (the shared session.end-led wait:
// a /resume of a long transcript may take a while to load, and the lag starts only after it); and the process's first
// start (no mark in session state yet: a reload finds one), for START_LAG_MS. The constants restate the shared ones,
// and scripts/self-compact-lag.test.mjs holds them equal.
import type { EngineInterface } from 'claude-code'

/** How long a move a session end began is waited on, unless the id reads another conversation first (shared classic.ts's). */
export const MOVE_LOOK_FOR_MS = 2 * 60 * 1000

/** How long after a process's first start the id may still read the conversation before it (shared classic.ts's). */
export const START_LAG_MS = 15_000

/** How long a read on the start and turn-end paths may take; past it, it reads as nothing (shared classic.ts's STATE_READ_MS). */
export const READ_MS = 2000

/** The plugin's mark that this process has started, in session state: a reload's session.start finds it. */
const started = { plugin: 'self-compact', key: 'started' } as const

/** A move a session end began: the conversation left, and when. */
let left: { from: string; at: number } | undefined

/** When this process first started, while the id may still lag it. */
let startedAt: number | undefined

/** At register: a new load knows of no move. */
export function configureMoving(): void {
  left = undefined
  startedAt = undefined
}

/** `work`'s answer, or undefined once `ms` have passed without one, or when it fails. */
export function within<T>($: EngineInterface, work: Promise<T>, ms = READ_MS): Promise<T | undefined> {
  return new Promise(resolve => {
    let timer: { cancel: () => void } | undefined
    try {
      timer = $.clock.after(ms, () => resolve(undefined))
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
 * At session.start: the process's first start (no mark yet in session state, which a reload keeps) begins the start's
 * lag. A mark that can't be read within READ_MS begins it too: the guard fails closed.
 */
export async function startBegins($: EngineInterface): Promise<void> {
  try {
    const mark = await within($, $.state.get(started))
    if (mark !== undefined && mark.value === true) return
    startedAt = await $.clock.now()
    await within($, $.state.set(started, true))
  } catch {
    startedAt ??= await $.clock.now().catch(() => 0)
  }
}

/** At session.end: a /clear or a /resume begins a move away from the conversation ending. */
export async function moveBegins($: EngineInterface, e: { readonly reason: unknown; readonly sessionId: unknown }): Promise<void> {
  if ((e.reason !== 'clear' && e.reason !== 'resume') || typeof e.sessionId !== 'string') return
  try {
    left = { from: e.sessionId, at: await $.clock.now() }
  } catch {
    left = undefined
  }
}

/**
 * Whether the id, reading `id` now (undefined: unread), may still name a conversation other than the session's own,
 * and for how long at most: a move a session end began (`move`), until the id reads another conversation or
 * MOVE_LOOK_FOR_MS pass; or the process's first START_LAG_MS (`start`). Undefined when it can't.
 */
export async function moving($: EngineInterface, id: string | undefined): Promise<{ why: 'move' | 'start'; leftMs: number } | undefined> {
  const now = await $.clock.now()
  if (left !== undefined) {
    if (id !== undefined && id !== left.from) left = undefined
    else if (now - left.at > MOVE_LOOK_FOR_MS || now < left.at) left = undefined
    else return { why: 'move', leftMs: MOVE_LOOK_FOR_MS - (now - left.at) }
  }
  if (startedAt !== undefined) {
    if (now - startedAt >= START_LAG_MS || now < startedAt) startedAt = undefined
    else return { why: 'start', leftMs: START_LAG_MS - (now - startedAt) }
  }
  return undefined
}

/** How long to wait before trying again, in plain words: the seconds left for a start, a short wait for a move. */
export function waitSaid(state: { why: 'move' | 'start'; leftMs: number }): string {
  const seconds = Math.max(1, Math.ceil(state.leftMs / 1000))
  return state.why === 'start'
    ? `It is in its first seconds, while its id may still name the conversation before it. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`
    : `A /clear or a /resume has just ended the conversation, and its id may still name that one: this ends once the id names the conversation moved to, usually within seconds, and at most in ${seconds} second${seconds === 1 ? '' : 's'}. Try again in about 10 seconds.`
}
