/**
 * The reconnect of Claude in Chrome the session asked for, waiting for its turn to end: the message it resumes with
 * once the reconnect has run (absent: it waits for the next message).
 */
export type Queued = { resume?: string }

declare module 'claude-code' {
  interface PluginState {
    /**
     * `queued`: the reconnect waiting for its turn to end. `reconnects`: when this session queued each of its recent
     * reconnects (milliseconds since the epoch), which the cap of 3 in 10 minutes counts.
     */
    'self-chrome': { queued: Queued | null; reconnects: number[] | null }
  }
}
