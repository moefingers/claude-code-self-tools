/**
 * What this turn asked of Remote Control, run once it ends. `connect`: connect the session, if it is
 * not connected then. `rename`: rename the session (/rename) and, if Remote Control is connected,
 * reconnect it under the new name. `name` titles both, the last one the turn gave; a connect given
 * none takes the session's title, or runs bare when it has none.
 */
export type Queued = { connect: boolean; rename: true; name: string } | { connect: true; rename: false; name?: string }

/**
 * The session's custom title (`--name`, /rename, a hook's `sessionTitle`, a rename from the app) as
 * the last SessionStart or UserPromptSubmit hook input carried it; null when it had none.
 */
export type Title = string | null

declare module 'claude-code' {
  interface PluginState {
    'self-remote-control': { queued: Queued | null; title: Title }
  }
}
