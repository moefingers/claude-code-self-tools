// The hooks Claude Code's built-in guard passes over (#53), and the ones these plugins keep: the one place both lists
// are kept. scripts/guarded-hooks.test.mjs reads every hook each plugin's modules register, and fails on any other
// guarded one.
//
// The guard (`cc-plugin-sec-default`) loads ahead of every plugin a person installs where the machine has managed
// settings, or where the session runs on `/login` credentials for a Team or Enterprise plan. Where it loads, a hook a
// person's plugin registers on one of these events never runs, and `/plugin`'s Errors tab says so. The source: the
// mods admin docs, "Know which hooks of a user's mod don't run"
// (https://code.claude.com/docs/en/plugins/mods/admin), its table row by row.
//
// Every guarded hook a plugin keeps (KEPT) does its work as it always did wherever the guard isn't loaded, and has a
// partner on events the guard lets through, which does that work only where it is: where no classic hook has reached
// the process (shared/hooks/classic.ts). So a session without the guard loses nothing, and nothing is done twice.
// `missing` says what the partner can't do: each plugin's README says it too.

/** Every settings hook event, as a hooks module names it (`classic.Stop`, `classic.SessionStart`, ...). */
export const GUARDED_PREFIX = 'classic.'

/** The engine events the guard passes over: the table's rows after `classic.<Event>`. */
export const GUARDED_EVENTS = ['prompt.compose', 'prompt.section', 'prompt.context', 'prompt.attachment', 'skill.prompt', 'attribution.text', 'session.compact', 'settings.read']

/** `session.append` is passed over only for these doors (a hook filtered to one of them); one with no door filter runs. */
export const GUARDED_APPEND_DOORS = ['attachment', 'hook-context', 'compaction']

/** Whether a hook on `event` (filtered to `door`, for `session.append`) never runs where the guard loads. */
export function isGuarded(event, door) {
  if (event.startsWith(GUARDED_PREFIX)) return true
  if (GUARDED_EVENTS.includes(event)) return true
  return event === 'session.append' && door !== undefined && GUARDED_APPEND_DOORS.includes(door)
}

/**
 * The guarded hooks the plugins keep, by plugin, module and event: the partner, on events the guard lets through, and
 * the engine events it hooks (each must be hooked in that module, and none guarded), and what it can't do.
 */
export const KEPT = [
  {
    plugin: 'self-restart',
    file: 'register.ts',
    event: 'classic.SessionStart',
    partnerEvents: ['session.start', 'session.end'],
    partner: "session.start, then 5 s later, for the conversation $.session.id() names: the restart that resumed it (its first prompt, its claim, its toast); session.end's /clear or /resume, then $.session.id() read as another conversation: the start folder put back, the transcript, a /resume's restart",
    missing: "a refusal names the start folder as where the plugin started again rather than where the session started (wording only); the move inside a process is taken up once the id reads it (a restart asked meanwhile waits)",
  },
  {
    plugin: 'self-switch',
    file: 'register.ts',
    event: 'classic.SessionStart',
    partnerEvents: ['session.start', 'session.end'],
    partner: "session.start, then 5 s later: the arrival, and in a conversation with no prompt yet S11's baseline; session.end: an armed switch of the conversation ending taken back, then $.session.id() read as another conversation: the start folder, the conversation held, the left record, a /resume's heartbeat and arrival, a /clear's baseline carried",
    missing: "the move at once (a switch asked meanwhile waits); a startup's word that the folder it found is where it started (taken once the transcript is there, at its first prompt)",
  },
  {
    plugin: 'self-wake',
    file: 'register.ts',
    event: 'classic.SessionStart',
    partnerEvents: ['session.start', 'session.end'],
    partner: "session.start, then 5 s later: the conversation $.session.id() names is the one held; session.end's /clear or /resume, then $.session.id() read as another conversation: the wake-up carried on (a /clear) or dropped (a /resume to another), and both markers; a wake-up due meanwhile waits for the move",
    missing: "the move at once: a wake marker written while the move is pending names the conversation left",
  },
  {
    plugin: 'self-reload',
    file: 'register.ts',
    event: 'classic.SessionStart',
    partnerEvents: ['session.end'],
    partner: "session.end's /clear or /resume: the waiting reload's resume dropped, from the module at once and from $.state after the end step, marked so the reload's report tells the model",
    missing: "the note to the model comes with the reload's report rather than at the move, and not at all when Claude Code's wipe of session state lands after the drop (the toast still says it)",
  },
  {
    plugin: 'self-check',
    file: 'register.ts',
    event: 'classic.SessionStart',
    partnerEvents: ['session.start', 'session.end'],
    partner: "session.start, then 5 s later: the env guard, and in a conversation with prompts the quiet check 10 s after; session.end's /clear or /resume, then $.session.id() read as another conversation: the env guard, and a /resume's quiet check",
    missing: "the dedupe right after the SessionStart hooks beneath have run (it comes at the partner's own time); a compaction's or a fork's start",
  },
  {
    plugin: 'self-color',
    file: 'register.ts',
    event: 'classic.SessionStart',
    partnerEvents: ['session.end'],
    partner: "session.end's /clear or /resume, inside the command's run: the waiting change dropped, and said",
    missing: 'nothing',
  },
  {
    plugin: 'self-remote-control',
    file: 'register.ts',
    event: 'classic.SessionStart',
    partnerEvents: ['session.end'],
    partner: "session.end's /clear or /resume: the last turn forgotten (the login record and the servers seen are put back by their mirrors at the next read, as before)",
    missing: "the session's title from --name or a resumed conversation; a fork's start; the conversation named while the id lags a move",
  },
  {
    plugin: 'self-remote-control',
    file: 'register.ts',
    event: 'classic.UserPromptSubmit',
    partnerEvents: ['command.run'],
    partner: "command.run for rename, the title as typed, and the plugin's own rename",
    missing: 'a title set by a hook, the SDK or the app, and a /rename with no title',
  },
  {
    plugin: 'self-remote-control',
    file: 'register.ts',
    event: 'classic.StopFailure',
    partnerEvents: ['turn.complete'],
    partner: "turn.complete on the main loop with reason 'error': rate_limit while a rate-limit window of the account reads used up",
    missing: 'every other error kind a login change could clear (a failed sign-in, billing, an outage), so no resume follows those',
  },
]

/**
 * Every `on(<event>, ...)` call in a module's text: its event, the `door` its matcher filters to, and its line. A
 * first argument that isn't a string literal is kept as `<computed>`. Comments and strings are read past, so a hook
 * named in a comment isn't one.
 */
export function registrations(text) {
  const code = withoutComments(text)
  const found = []
  const call = /(?<![\w$.])on\(\s*/g
  for (let m = call.exec(code); m !== null; m = call.exec(code)) {
    const at = m.index + m[0].length
    const line = code.slice(0, m.index).split('\n').length
    const literal = /^(['"`])([^'"`\\]*)\1\s*,\s*/.exec(code.slice(at))
    if (literal === null) {
      found.push({ event: '<computed>', line })
      continue
    }
    const after = code.slice(at + literal[0].length)
    const matcher = /^\{([^{}]*)\}/.exec(after)
    const door = matcher === null ? undefined : /\bdoor\s*:\s*(['"`])([^'"`]*)\1/.exec(matcher[1])?.[2]
    found.push({ event: literal[2], ...(door === undefined ? {} : { door }), line })
  }
  return found
}

/**
 * `text` with its comments blanked (line and block), and the contents of its strings and template literals too, but a
 * string that is a call's first argument to `on(` or a `door:`'s value: what a registration names, kept as it is.
 * Newlines are kept, so lines count as in the text.
 */
function withoutComments(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const d = text[i + 1]
    if (c === '/' && d === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? text.length : end + 2
      out += text.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1
      const whole = text.slice(i, j + 1)
      const before = out.slice(-64)
      const named = /(?:^|[^\w$.])on\(\s*$/.test(before) || /\bdoor\s*:\s*$/.test(before)
      out += named ? whole : c + whole.slice(1, -1).replace(/[^\n]/g, ' ') + (j < text.length ? c : '')
      i = j + 1
      continue
    }
    out += c
    i += 1
  }
  return out
}
