/**
 * A compaction the session asked for, waiting for its turn to end: what the summary must keep, and
 * what the session resumes with once compacted (absent: it stays idle until the next message), and
 * `when` 'idle' when it waits for an idle session (absent: between turns, the default).
 */
export type Queued = { keep: string; resume?: string; when?: 'idle' }

declare module 'claude-code' {
  interface PluginState {
    /**
     * `queued`: the compaction waiting for its turn to end. `reminded`: the keys of the reminder levels in force (the
     * conversation's own, set with compact_reminder, else the `compactReminder` setting's) that the window had passed at
     * the last answered turn end or when the levels changed (`40%`, or a token count as digits). `warned`: the
     * `compactReminder` value the session was last told is not levels, so it is said once. `started`: true once this
     * process has started, so a reload's session.start isn't taken for the process's first.
     */
    'self-compact': { queued: Queued | null; reminded: string[] | null; warned: string | null; started: boolean | null }
  }
}
