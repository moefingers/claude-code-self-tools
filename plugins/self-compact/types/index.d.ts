/**
 * A compaction the session asked for, waiting for its turn to end: what the summary must keep, and
 * what the session resumes with once compacted (absent: it stays idle until the next message), and
 * `when` 'idle' when it waits for an idle session (absent: between turns, the default).
 */
export type Queued = { keep: string; resume?: string; when?: 'idle' }

declare module 'claude-code' {
  interface PluginState {
    /**
     * `queued`: the compaction waiting for its turn to end. `reminded`: the keys of the `compactReminder` levels the
     * window had reached at the last answered turn end (`40%`, or a token count as digits), each reminded once.
     * `warned`: the `compactReminder` value the session was last told is not levels, so it is said once.
     */
    'self-compact': { queued: Queued | null; reminded: string[] | null; warned: string | null }
  }
}
