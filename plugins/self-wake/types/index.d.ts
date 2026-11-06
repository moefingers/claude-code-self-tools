/** A wake-up asked for this turn, armed once the turn ends with an answer: how long after, and its note. */
export type QueuedWake = { minutes: number; note: string }

/**
 * A wake-up armed: its id, when it is due in `$.clock.now()` milliseconds, the note it sends, and the
 * conversation it was armed in (the event-tracked id at the turn's end), which its marker names; absent
 * in one armed by self-wake before 0.2.0, which then belongs to the conversation the session starts in.
 */
export type Wake = { id: string; dueAt: number; note: string; conversation?: string }

declare module 'claude-code' {
  interface PluginState {
    'self-wake': { queued: QueuedWake | null; armed: Wake | null }
  }
}
