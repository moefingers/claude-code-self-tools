/**
 * The reconnect of Claude in Chrome the session asked for, waiting for its turn to end: the message it resumes with
 * once the reconnect has run (absent: it waits for the next message).
 */
export type Queued = { resume?: string }

declare module 'claude-code' {
  interface PluginState {
    'self-chrome': { queued: Queued | null }
  }
}
