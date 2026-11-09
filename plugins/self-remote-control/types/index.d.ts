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

/**
 * Claude in Chrome's step after a login change. `ran`: /mcp reconnect ran (its own line says whether it reconnected).
 * `queued`: the command was queued and hadn't run within RUN_WAIT_MS; it runs once the session is idle. `failed`: the
 * command was refused. `none`: this session has no Claude in Chrome, now or before. `coordinator`: the coordinator
 * plugin runs in this session and reconnects it itself. `unread`: the session's tools couldn't be listed, so it was
 * left alone. `unsure`: the coordinator's tools were listed before and not at three looks (a reload, or turned off),
 * so it was left alone rather than reconnected twice. `capped`: it was reconnected RECONNECT_CAP times in the window
 * already, so a flapping login doesn't start its tab group over each time. `reloaded`: its reconnect was started
 * before this plugin reloaded, and isn't run a second time.
 */
export type ChromeOutcome = 'ran' | 'queued' | 'reloaded' | 'failed' | 'none' | 'coordinator' | 'unread' | 'unsure' | 'capped'

/** The MCP servers this session has listed tools of, at any look: one the login change dropped lists none. */
export type Servers = { chrome?: true; coordinator?: true }

/** A login change being handled, from when it was confirmed until its toast. */
export type Pending = {
  /** When the change was confirmed (ms). */
  at: number
  /** Whether Remote Control read connected when the new account was first seen. */
  wasConnected: boolean
  /**
   * Claude in Chrome's step, once the Remote Control step has settled and before the resume (relogin.ts says each):
   * absent until it is decided.
   */
  chrome?: ChromeOutcome
  /** How many looks for the coordinator's tools found none so far, before Claude in Chrome's reconnect. */
  chromeLooks?: number
  /** When the first of those looks was (ms). */
  chromeFirstAt?: number
  /** When the next look is due (ms). */
  chromeAt?: number
  /** When /mcp reconnect was started (ms), saved before it runs: a reload while it runs doesn't run it twice. */
  chromeRanAt?: number
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
  /**
   * A reconnect the cap held back, tried again once the oldest run has left the window, for the login as it is
   * now: no resume, and its own toast. A real change that comes meanwhile folds it in and becomes that change.
   */
  retry?: true
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
  /** When the cap's toast was shown (ms): once while the cap holds, and again after a retry. */
  cappedAt?: number
  /** When Claude in Chrome's reconnect ran, within the last RECONNECT_WINDOW_MS (ms): the same cap as Remote Control's. */
  chromeRuns?: number[]
  /** When the Chrome cap's toast was shown (ms): once while that cap holds, and again after a retry. */
  chromeCappedAt?: number
  /** The account (fingerprint) Claude in Chrome's reconnect last ran under: a retry after the cap runs it only for another one. */
  chromeAccount?: string | null
  /**
   * A change the cap held back left Remote Control down (Claude Code stopped it at the switch): a change after it counts
   * it as connected before, and the retry after the cap runs it whatever account the login settled on. Kept until a
   * change ran it or read it connected; the retry is its one try.
   */
  rcOwed?: true
  /** When a reconnect the cap held back may be tried again (ms): the oldest run's leaving the window. */
  owedAt?: number
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
  /** Its id, as turn.start and turn.complete carried it: the resume claim's key for a turn that ended on an error. */
  turnId?: string
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
      servers: Servers | null
      resumeClaims: string[] | null
    }
  }
}
