/**
 * A reload the session asked for, waiting for its turn to end: the message it resumes with once the
 * plugins have reloaded (absent: it waits for the next message).
 */
export type Queued = { resume?: string }

/**
 * A reload under way, written before the command runs so that the module the reload starts finds
 * it: what to resume with, and `at`, when it was written, in `$.clock.now()` milliseconds.
 */
export type Pending = Queued & {
  at: number
  /**
   * The person's message came after the reload was queued: its resume goes to the model as a note, never as a turn.
   * A mark alone: nothing of the message is kept.
   */
  turnSince?: true
}

declare module 'claude-code' {
  interface PluginState {
    'self-reload': { queued: Queued | null; pending: Pending | null }
  }
}
