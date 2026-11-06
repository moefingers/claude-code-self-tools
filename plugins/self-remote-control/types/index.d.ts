/**
 * What this turn asked of Remote Control, run once it ends. `connect`: connect the session, if it is
 * not connected then. `rename`: rename the session (/rename), nothing more; with a connect, the
 * rename runs first. `name` titles both, the last one the turn gave; a connect given
 * none takes the session's title, or runs bare when it has none. `resume`, the last one the turn
 * gave: the message that starts the next turn once the action has run, after what happened (absent:
 * the session waits for the next message).
 */
export type Queued =
  | { connect: boolean; rename: true; name: string; resume?: string }
  | { connect: true; rename: false; name?: string; resume?: string }

/**
 * The session's custom title (`--name`, /rename, a hook's `sessionTitle`, a rename from the app) as
 * the last SessionStart or UserPromptSubmit hook input carried it; null when it had none.
 */
export type Title = string | null

/** The Remote Control reading, as one word: what the remote-control command's description says. */
export type RcWord = 'connected' | 'not connected' | 'unavailable' | 'unknown'

/**
 * The Remote Control lock as a taker holds it (hooks/rc-lock.ts): the file shared with other
 * plugins, with the PowerShell that deletes it, or this session's state's own; `at` is what the
 * taker wrote, and a release deletes only a lock that still says it.
 */
export type Held = { kind: 'file'; path: string; powershell: string; at: number } | { kind: 'memory'; at: number }

/** The state's own Remote Control lock, where there is no lock file: when it was taken (ms). */
export type MemoryLock = { at: number }

/**
 * How the reconnect after a login change went. `ran`: the command ran and its check is under way.
 * `reconnected`: it ran and the session reads connected. `connected`: it read connected without a
 * run (connected again by something else). `stayed`: it read connected all the while, so nothing
 * ran. `was-off`: Remote Control was off before the change and the setting for all sessions is not
 * on, so it was left off. `setting-off`: reconnectOnLoginChange is off. `unavailable`: there is no
 * remote-control command. `unknown`: the reading was never one this plugin recognises (`detail`
 * holds it). `not-taken`: the command ran, but the session didn't read connected while the lock was
 * held. `failed`: the command was refused (`detail` says why). `capped`: RECONNECT_CAP runs in the
 * window already. `busy`: the Remote Control lock stayed held by another run (`detail` says whose).
 */
export type RcOutcome =
  | 'ran'
  | 'reconnected'
  | 'connected'
  | 'stayed'
  | 'was-off'
  | 'setting-off'
  | 'unavailable'
  | 'unknown'
  | 'not-taken'
  | 'failed'
  | 'capped'
  | 'busy'

/** A login change being handled, from when it was confirmed until its toast. */
export type Pending = {
  /** When the change was confirmed (ms). */
  at: number
  /** Whether Remote Control read connected when the new account was first seen. */
  wasConnected: boolean
  /** Whether the /config setting for all sessions (`remoteControl`) was true then. */
  settingOn: boolean
  /** The first moment no turn was running after the change: the reconnect's wait counts from here. */
  idleAt?: number
  /** When Remote Control is next read (ms): it is read at most every RC_READ_MS. */
  readAt?: number
  /** Remote Control read not connected at some look after the change. */
  sawDown?: true
  /** How the reconnect has gone so far; absent until it is decided. */
  rc?: RcOutcome
  /** What the `unknown` reading said, why the command was refused, or who held the lock. */
  detail?: string
  /** The title the command ran under; absent when it ran bare. */
  name?: string
  /** When the command returned, or was given up waiting for (ms). */
  ranAt?: number
  /** The Remote Control lock, while this change holds it: from the fresh reading until connected or LOCK_HOLD_MS. */
  lock?: Held
  /** When the resume goes, once due: the session's own delay after the reconnect settled (ms). */
  resumeAt?: number
  /** Set right before the resume message is sent, so it is never sent twice. */
  resumed?: true
}

/**
 * The account this session's machine is signed in as, as the login watch last read it, and what it
 * needs to handle a change.
 */
export type Login = {
  /**
   * A fingerprint of the signed-in account: a hash of the account and organization ids that the
   * `oauthAccount` record in Claude Code's config file names. Never the ids themselves, an email or
   * any token. Null when the record names no account (signed out).
   */
  account: string | null
  /** Another account seen at one look; it becomes a change when the next look reads it again. */
  candidate?: string
  /** The Remote Control reading when the candidate was first seen: whether it was connected before. */
  candidateRc?: RcWord
  /** The change being handled, if one is. */
  pending?: Pending
  /** When the reconnect ran /remote-control, within the last RECONNECT_WINDOW_MS (ms). */
  runs?: number[]
  /** When the cap's toast was shown (ms): once while the cap holds. */
  cappedAt?: number
}

/** The main conversation's latest turn, as turn.start, turn.complete and StopFailure told it. */
export type Turn = {
  /** True from its turn.start until its turn.complete. */
  running: boolean
  /** When it started, or ended once it has (ms). */
  at: number
  /** Why it ended (turn.complete's `reason`); absent while it runs. */
  outcome?: 'answer' | 'aborted' | 'refusal' | 'error'
  /** The API error kind StopFailure gave for it (`rate_limit`, `authentication_failed`, ...). */
  error?: string
  /** The turn the resume message started. */
  fromResume?: true
}

/** The resume's own record, across changes. */
export type Resumes = {
  /** When the resume message was sent (ms): the next main turn to start with it is its turn. */
  sentAt?: number
  /** A resume's turn ended on an error at once: no resume again until a person types. */
  blocked?: true
  /** When the person last typed a prompt (ms): a resume's turn that started before it doesn't block. */
  personAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'self-remote-control': {
      queued: Queued | null
      title: Title
      login: Login | null
      turn: Turn | null
      resumes: Resumes | null
      rcLock: MemoryLock | null
    }
  }
}
