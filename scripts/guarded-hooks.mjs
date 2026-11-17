// The hooks Claude Code's built-in guard passes over (#53), and the ones these plugins keep: the one place both lists
// are kept. scripts/guarded-hooks.test.mjs reads every hook each plugin's modules register, and fails on any other
// guarded one.
//
// The guard (`cc-plugin-sec-default`) loads ahead of every plugin a person installs where the machine has managed
// settings, or where the session runs on `/login` credentials for a Team or Enterprise plan. Where it loads, a hook a
// person's plugin registers on one of these events never runs, and `/plugin`'s Errors tab says so. The source: the
// mods admin docs, "Know which hooks of a user's mod don't run"
// (https://code.claude.com/docs/en/plugins/mods/admin), its table row by row. DOCS_ROWS holds each row's first cell as
// the docs write it, the event names alone (this public repository vendors no copy of the docs' text), and the lists
// below are read out of those cells, never written beside them. The docs also say the guard passes over a hook on
// `tool.describe` for an organization's own tools, with no note: a hook on it counts as guarded here too (PARTLY).
//
// Every guarded hook a plugin keeps (KEPT) does its work as it always did wherever the guard isn't loaded, and has a
// partner on events the guard lets through, which does that work only where it is: where no classic hook has reached
// the process (shared/hooks/classic.ts). So a session without the guard loses nothing, and nothing is done twice.
// `missing` says what the partner can't do: each plugin's README says it too.

/**
 * The first cell of each row of the docs' table "Know which hooks of a user's mod don't run", in order, as the docs
 * write it (Claude Code's mods admin docs, read for 2.1.314 to 2.1.326).
 */
export const DOCS_ROWS = [
  '[`classic.<Event>`](https://code.claude.com/docs/en/plugins/mods/events#hook-the-settings-hook-events), such as `classic.Stop`',
  '[`prompt.compose`](https://code.claude.com/docs/en/plugins/mods/reference#prompts-and-what-claude-reads)',
  '`prompt.section`',
  '`prompt.context`',
  '`prompt.attachment`',
  '`skill.prompt`',
  '`attribution.text`',
  '[`session.compact`](https://code.claude.com/docs/en/plugins/mods/reference#session)',
  '`settings.read`',
  '`session.append{door=attachment}`',
  '`session.append{door=hook-context}`',
  '`session.append{door=compaction}`',
]

/** Each row's event, its first code span: `classic.<Event>`, `prompt.compose`, `session.append{door=attachment}`, ... */
export const DOCS_EVENTS = DOCS_ROWS.map(row => /`([^`]+)`/.exec(row)?.[1] ?? '')

/** Every settings hook event, as a hooks module names it (`classic.Stop`, `classic.SessionStart`, ...): the first row. */
export const GUARDED_PREFIX = DOCS_EVENTS[0]?.endsWith('<Event>') ? DOCS_EVENTS[0].slice(0, -'<Event>'.length) : 'classic.'

/** The engine events the guard passes over: the rows between the first and the doors. */
export const GUARDED_EVENTS = DOCS_EVENTS.slice(1).filter(event => !event.includes('{'))

/** `session.append` is passed over only for these doors (a hook filtered to one of them); one with no door filter runs. */
export const GUARDED_APPEND_DOORS = DOCS_EVENTS.map(event => /^session\.append\{door=([a-z-]+)\}$/.exec(event)?.[1]).filter(door => door !== undefined)

/** Events the guard passes over in some cases (the docs' prose after the table): counted as guarded, so none is hooked. */
export const PARTLY = ['tool.describe']

/**
 * Whether a hook on `event` (filtered to `door`, for `session.append`) never runs where the guard loads, or may not.
 * A wildcard or a negation (`*`, `classic.*`, `!tool.describe`) reaches guarded events too, and so does a door that
 * isn't one string (a list, a pattern, a name): each counts as guarded, so the check fails closed.
 */
export function isGuarded(event, door) {
  if (event.startsWith(GUARDED_PREFIX)) return true
  if (GUARDED_EVENTS.includes(event) || PARTLY.includes(event)) return true
  if (event.includes('*') || event.startsWith('!')) return true
  return event === 'session.append' && door !== undefined && (door === '<computed>' || GUARDED_APPEND_DOORS.includes(door))
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
    partner: "session.start on the process's first start (no user input yet), then 5 s later, once $.session.id() reads one conversation twice a second apart (else at the first turn): the restart that resumed it (its first prompt, its claim, its toast); session.end's /clear or /resume, then $.session.id() read as another conversation: the start folder put back, the transcript, a /resume's restart",
    missing: "a refusal names the start folder as where the plugin started again rather than where the session started (wording only); the move inside a process is taken up once the id reads it (a restart asked meanwhile waits)",
  },
  {
    plugin: 'self-switch',
    file: 'register.ts',
    event: 'classic.SessionStart',
    partnerEvents: ['session.start', 'session.end'],
    partner: "session.start on the process's first start, then 5 s later, once the id settles (else at the first turn): the arrival, and in a conversation with no prompt yet S11's baseline; session.end: an armed switch of the conversation ending taken back, then $.session.id() read as another conversation: the start folder, the conversation held, the left record, a /resume's heartbeat and arrival, a /clear's baseline carried",
    missing: "the move at once (a switch asked meanwhile waits); a startup's word that the folder it found is where it started (taken once the transcript is there, at its first prompt)",
  },
  {
    plugin: 'self-wake',
    file: 'register.ts',
    event: 'classic.SessionStart',
    partnerEvents: ['session.start', 'session.end'],
    partner: "session.start on the process's first start, then 5 s later, once the id settles: the conversation $.session.id() names is the one held; session.end's /clear or /resume, then $.session.id() read as another conversation: the wake-up carried on (a /clear) or dropped (a /resume to another), and both markers; a wake-up due meanwhile waits for the move",
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
    partner: "session.start on the process's first start, then 5 s later, once the id settles (else at the first turn): the env guard, and in a conversation with prompts the quiet check 10 s after; session.end's /clear or /resume, then $.session.id() read as another conversation: the env guard, and a /resume's quiet check",
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
    partner: "turn.complete on the main loop with reason 'error': rate_limit while a rate-limit window of the account reads used up and resets more than a minute later",
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
    const matcher = after.startsWith('{') ? balanced(after) : undefined
    let door
    if (matcher !== undefined && /\bdoor\s*:/.test(matcher)) {
      // A door of one string is read; any other (a list, a pattern, a name, nested) is `<computed>`, and guarded.
      const one = /\bdoor\s*:\s*(['"`])([^'"`]*)\1\s*[,}]/.exec(matcher)
      door = one === null ? '<computed>' : one[2]
    }
    // session.append's matcher, when its door can't be read off it: one held in a name (`on(event, M, h)`), or an object
    // with a spread or a quoted key (its door may hide there). `<computed>`, and guarded.
    if (literal[2] === 'session.append' && door === undefined) {
      const args = argumentsFrom(code, at + literal[0].length)
      const second = args.length >= 2 ? args[0].trim() : undefined
      if (second !== undefined && (!second.startsWith('{') || /\.\.\./.test(second) || /(['"`])[^'"`]*\1\s*:/.test(second))) door = '<computed>'
    }
    found.push({ event: literal[2], ...(door === undefined ? {} : { door }), line })
  }
  return found
}

/** The arguments of a call from `from` (after its first) to its closing parenthesis, at the call's own depth. */
function argumentsFrom(code, from) {
  const args = []
  let depth = 0
  let start = from
  for (let i = from; i < code.length; i += 1) {
    const c = code[i]
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        args.push(code.slice(start, i))
        return args
      }
      depth -= 1
    } else if (c === ',' && depth === 0) {
      args.push(code.slice(start, i))
      start = i + 1
    }
  }
  args.push(code.slice(start))
  return args
}

/** The object literal `text` starts with, its braces balanced (strings already blanked); undefined when it never closes. */
function balanced(text) {
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    if (text[i] === '}') depth -= 1
    if (depth === 0) return text.slice(0, i + 1)
  }
  return undefined
}

/**
 * Where a module's text hands `on` to anything but a call (`const hook = on`, `fn(on)`), so a hook could be registered
 * under another name: each such line. The register's own parameter list (`(on, options)`) is the one place it may sit.
 */
export function onAliases(text) {
  const code = withoutComments(text)
  const lines = []
  const name = /(?<![\w$.])on\b(?!\s*\()/g
  for (let m = name.exec(code); m !== null; m = name.exec(code)) {
    const before = code.slice(Math.max(0, m.index - 40), m.index)
    const after = code.slice(m.index, m.index + 20)
    if (/Register\s*=\s*\(\s*$/.test(before) && /^on\s*,/.test(after)) continue
    lines.push(code.slice(0, m.index).split('\n').length)
  }
  return lines
}

/** Whether a module that registers hooks names its register's first parameter `on`, where registrations() looks. */
export function registersAsOn(text) {
  const code = withoutComments(text)
  if (!/\bregister\b/.test(code) || !/:\s*Register\b/.test(code)) return true
  return /:\s*Register\s*=\s*\(\s*on\s*[,)]/.test(code)
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
    // A regex literal (a `/` where an expression starts), kept as it is: a quote inside it opens no string.
    if (c === '/' && /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof)\s*$/.test(out.slice(-16))) {
      let j = i + 1
      let inClass = false
      while (j < text.length && text[j] !== '\n' && (inClass || text[j] !== '/')) {
        if (text[j] === '\\') j += 1
        else if (text[j] === '[') inClass = true
        else if (text[j] === ']') inClass = false
        j += 1
      }
      out += text.slice(i, j + 1)
      i = j + 1
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
