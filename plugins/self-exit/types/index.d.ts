/**
 * An exit the session asked for, waiting for its turn to end: why, and a note for whoever resumes
 * the session (absent: none).
 */
export type Queued = { reason: string; note?: string }

declare module 'claude-code' {
  interface PluginState {
    'self-exit': { queued: Queued | null }
  }
}
