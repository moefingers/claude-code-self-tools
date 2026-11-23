/** The reloads a session tried for one install, keyed by the install's time, and whether the person was told, past two, that a restart loads it. */
export type ReloadRecord = { install: number; tries: number; told: boolean }

declare module 'claude-code' {
  interface PluginState {
    /**
     * `reload`: the reloads this session tried for the machine's last install. `lastReload`: when this session last ran
     * /reload-plugins for an install, so it reloads at most once every 15 minutes.
     */
    'self-update': { reload: ReloadRecord | null; lastReload: number | null }
  }
}
