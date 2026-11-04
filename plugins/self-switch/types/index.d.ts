/**
 * A switch the session was asked for, waiting for its turn to end: the conversation to resume here
 * (a session id), why, where the leaving session's notes are, the message the resumed conversation's
 * first turn starts with (absent: it waits for the next message), and the conversation that asked
 * (its session id at the call): the switch runs only while this session is still that one.
 */
export type Queued = { to: string; reason: string; notes: string; resume?: string; from?: string }

/**
 * A switch under way, kept in the plugin's own store (`$.store`, key `switches`) by the conversation
 * it resumes, so that the copy of the plugin in the process that resumes it finds it: when it was
 * written (`$.clock.now()` milliseconds), the session it left, the claim lock's claimant, the
 * transport, why, the notes, and the first prompt.
 */
export type Ticket = {
  at: number
  from: string
  by: string
  transport: 'in-place' | 'slot' | 'window'
  reason: string
  notes: string
  resume?: string
  /** Why this pane's slot runner wasn't used, when the switch went to a new window instead. */
  fallback?: string
}

/**
 * A conversation's heartbeat, kept in the plugin's own store under `alive:<session id>`: when this
 * plugin last saw it running (at each turn's start and end, and every 2 minutes), the folder its
 * process started in, and that folder's project name. Liveness (L5) reads `at`; a switch to it reads
 * `folder`.
 */
export type Heartbeat = { at: number; folder: string; project: string }

/**
 * The folder the session started in, as the first session.start of this process gave it. Kept in
 * session state, so a reload of the plugin, which starts it again from wherever the session has
 * moved to, doesn't replace it.
 */
export type Folder = string | null

/**
 * How many times in a row a new turn has cancelled a queued switch to conversation `key`, before the
 * run began. Kept in session state; a run that begins clears it.
 */
export type Cancels = { key: string; count: number }

declare module 'claude-code' {
  interface PluginState {
    'self-switch': { queued: Queued | null; folder: Folder; cancels: Cancels | null }
  }
}
