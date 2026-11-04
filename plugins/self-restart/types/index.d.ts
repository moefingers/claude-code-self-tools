/**
 * A restart the session asked for, waiting for its turn to end: why, and the message the restarted
 * session's first turn starts with (absent: it waits for the next message).
 */
export type Queued = { reason: string; resume?: string }

/**
 * A restart under way, kept in the plugin's own store (`$.store`, key `restarts`) by session id, so
 * that the copy of the plugin in the process that resumes the session finds it: when it was written
 * (`$.clock.now()` milliseconds), why, the first prompt, and the claim lock's claimant (`slot:...` or
 * `launch:...`), which that copy releases.
 */
export type Restart = { at: number; reason: string; resume?: string; claim?: string }

/**
 * The folder the session started in, as the first session.start of this process gave it: where
 * `claude --resume <id>` finds the session. Kept in session state, so a reload of the plugin, which
 * starts it again from wherever the session has moved to (a worktree, /cd), doesn't replace it.
 */
export type Folder = string | null

declare module 'claude-code' {
  interface PluginState {
    'self-restart': { queued: Queued | null; folder: Folder }
  }
}
