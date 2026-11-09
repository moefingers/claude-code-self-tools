/**
 * The colors /color takes (Claude Code's own list, 2.1.319), and `default`, which resets the prompt bar.
 */
export type Color = 'red' | 'blue' | 'green' | 'yellow' | 'purple' | 'orange' | 'pink' | 'cyan' | 'default'

/**
 * A color change the session asked for, waiting for its turn to end. It lives for that one turn: the turn's end
 * takes it and clears it, so nothing here needs to outlive a /clear or a /resume.
 */
export type Queued = { color: Color }

declare module 'claude-code' {
  interface PluginState {
    'self-color': { queued: Queued | null }
  }
}
