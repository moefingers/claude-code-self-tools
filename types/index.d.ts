/**
 * A compaction the session asked for, waiting for its turn to end: what the summary must keep, and
 * what the session resumes with once compacted (absent: it stays idle until the next message).
 */
export type Queued = { keep: string; resume?: string }

declare module 'claude-code' {
  interface PluginState {
    'self-compact': { queued: Queued | null }
  }
}
