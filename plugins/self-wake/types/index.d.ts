/** A wake-up asked for this turn, armed once the turn ends with an answer: how long after, and its note. */
export type QueuedWake = { minutes: number; note: string }

/** A wake-up armed: its id, when it is due in `$.clock.now()` milliseconds, and the note it sends. */
export type Wake = { id: string; dueAt: number; note: string }

declare module 'claude-code' {
  interface PluginState {
    'self-wake': { queued: QueuedWake | null; armed: Wake | null }
  }
}
