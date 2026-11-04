/**
 * A restart the session asked for, waiting for its turn to end: why, and the message the restarted
 * session's first turn starts with (absent: it waits for the next message).
 */
export type Queued = { reason: string; resume?: string }

/**
 * A restart under way, kept in the plugin's own store (`$.store`, key `restarts`) by session id, so
 * that the copy of the plugin in the process that resumes the session finds it: when it was written
 * (`$.clock.now()` milliseconds), why, and the first prompt.
 */
export type Restart = { at: number; reason: string; resume?: string }

declare module 'claude-code' {
  interface PluginState {
    'self-restart': { queued: Queued | null }
  }
}
