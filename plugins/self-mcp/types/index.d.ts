/**
 * A reconnect the session asked for, waiting for its turn to end: the server, as /mcp lists it or
 * `all`, and the message it resumes with once the reconnect has run (absent: it waits for the next
 * message).
 */
export type Queued = { server: string; resume?: string }

declare module 'claude-code' {
  interface PluginState {
    'self-mcp': { queued: Queued | null }
  }
}
