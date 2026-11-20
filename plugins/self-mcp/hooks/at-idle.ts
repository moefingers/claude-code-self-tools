// What a self tool that queues work for the session's idle moment says of it, in the same words on every such tool
// (#67). Claude Code runs a plugin's queued step only once the turn has ended and the session is idle, so a turn that
// goes on working after the call holds the step back, and with it whatever waits on it (a reconnect, a reload, the
// resume after it). Said in each tool's own words, it was left out of some and worded otherwise in others; so the
// words live here, once, and scripts/at-idle.test.mjs holds every tool's description to them, a new tool's too.
//
// Canonical copy: shared/hooks/at-idle.ts. Each plugin named below carries an identical copy at
// plugins/<name>/hooks/at-idle.ts, written by `node scripts/sync-shared.mjs`; edit the canonical copy only.
// Copies: self-chrome, self-clear, self-color, self-compact, self-exit, self-mcp, self-reload, self-remote-control, self-restart, self-switch, self-wake

/** What to do once the call is made, after the words that say when it applies (atIdle). */
export const GO_IDLE = 'go idle at once: end your turn, and do nothing more until it has run and your next turn starts with word that it ran; then carry on.'

/** Why: the one rule behind every such tool. */
export const WHY_IDLE = 'What it queues runs only once your turn has ended and the session is idle, so anything done meanwhile pushes it back.'

/**
 * For a tool nothing waits on, which brings no resume of its own (self-color): going idle after it would only halt
 * the session, with nothing to bring it back. It says WHY_IDLE, then this, in place of GO_IDLE.
 */
export const NO_WAIT = 'Nothing waits on it, though, and nothing resumes the session after it: you need not end your turn for it; it runs at the next idle moment.'

/** The words a queuing tool's description ends with: `after` says when they apply ("After calling it", "After `connect` or `rename`"). */
export const atIdle = (after = 'After calling it'): string => `${after}, ${GO_IDLE} ${WHY_IDLE}`
