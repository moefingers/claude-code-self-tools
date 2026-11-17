/** A wake-up asked for this turn, armed once the turn ends with an answer: how long after, and its note. */
export type QueuedWake = { minutes: number; note: string }

/**
 * A wake-up armed: its id, when it is due in `$.clock.now()` milliseconds, the note it sends, and the
 * conversation it was armed in (the event-tracked id at the turn's end), which its marker names; absent
 * in one armed by self-wake before 0.2.0, which then belongs to the conversation the session starts in.
 */
export type Wake = { id: string; dueAt: number; note: string; conversation?: string }

/**
 * The plugin's session state. #53, shared/hooks/classic.ts: `classic`, true once a classic hook reached this process
 * (Claude Code's built-in guard isn't loaded here); `started`, the conversation whose start this process took up,
 * so a reload doesn't take it again.
 */
declare module 'claude-code' {
  interface PluginState {
    'self-wake': { queued: QueuedWake | null; armed: Wake | null; classic: boolean | null; started: string | null }
  }
}
