/**
 * A clear the session asked for, waiting for its turn to end: the handoff that is the first prompt
 * of the cleared conversation.
 */
export type Queued = { handoff: string }

declare module 'claude-code' {
  interface PluginState {
    'self-clear': { queued: Queued | null }
  }
}
