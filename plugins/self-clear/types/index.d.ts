/**
 * Why a session clears its conversation: its work is complete (and documented), or its context is
 * contaminated. Nothing else clears: compact or restart instead.
 */
export type Why = 'complete' | 'contaminated'

/**
 * A clear the session asked for, waiting for its turn to end: why, and the handoff that is the first
 * prompt of the cleared conversation.
 */
export type Queued = { why: Why; handoff: string }

declare module 'claude-code' {
  interface PluginState {
    'self-clear': { queued: Queued | null }
  }
}
