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
  /**
   * #53: a /clear or a /resume ran before the reload, where no classic SessionStart reached the plugin, and its resume
   * was dropped at the session end: the module that reports the reload tells the model so.
   */
  dropped?: 'clear' | 'resume'
}

/**
 * The plugin's session state. #53, shared/hooks/classic.ts: `classic`, true once a classic hook reached this process
 * (Claude Code's built-in guard isn't loaded here); `started`, the conversation whose start this process took up,
 * so a reload doesn't take it again.
 */
declare module 'claude-code' {
  interface PluginState {
    'self-reload': { queued: Queued | null; pending: Pending | null; classic: boolean | null; started: string | null }
  }
}
