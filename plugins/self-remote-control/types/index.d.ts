/** Whether this turn asked to connect Remote Control once it ends. */
export type ConnectQueued = boolean

declare module 'claude-code' {
  interface PluginState {
    'self-remote-control': { connectQueued: ConnectQueued }
  }
}
