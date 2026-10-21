/** The switches the session asked for this turn, waiting for it to end: an effort level, a model. */
export type Switches = { effort?: string; model?: string }

declare module 'claude-code' {
  interface PluginState {
    'self-config': {
      queued: Switches | null
      /** The main loop's effort level as the engine last reported it at a turn's end; null when unknown. */
      effortSeen: string | null
    }
  }
}
