// What self-secret works out without any engine call: the state folder, the stable copy of the
// command written there (the shim), what a call of the tool asks for, and the exact lines that run it
// from Bash and from PowerShell. The hooks module and the Node tests share it
// (tools/secret-run/invocation.test.mjs runs this file under Node's type stripping, and runs the lines
// it builds), so it imports nothing and holds only TypeScript that Node can strip.

/** The environment the rules read, by name. */
export type Env = Readonly<Record<string, string | undefined>>

/** The shim's and the profiles file's names, in the state folder. */
export const SHIM_NAME = 'secret-run.mjs'
export const PROFILES_NAME = 'secret-profiles.json'

/** The longest form wait a Bash call allows for: the Bash tool's own longest timeout, in milliseconds. */
export const BASH_TIMEOUT_MS = 600000

/** A path as Git Bash writes it (/c/Users/...) in the form Windows reads (C:/Users/...). */
export function nativePath(path: string, isWindows: boolean): string {
  if (!isWindows) return path
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(path)
  return m === null ? path : `${(m[1] ?? '').toUpperCase()}:${m[2] ?? '/'}`
}

/**
 * The state folder, by tools/secret-run/where.mjs's rule: SELF_SECRET_HOME when set; on Windows
 * %LOCALAPPDATA%\claude-self-tools; elsewhere $XDG_STATE_HOME/claude-self-tools when that is an
 * absolute path, else $HOME/.local/state/claude-self-tools. Undefined when the rule finds none.
 */
export function stateFolder(env: Env, isWindows: boolean): string | undefined {
  const own = env['SELF_SECRET_HOME']
  if (own) return nativePath(own, isWindows)
  if (isWindows) {
    const local = env['LOCALAPPDATA']
    if (!local) return undefined
    const base = local.replace(/\//g, '\\').replace(/(?!^)\\{2,}/g, '\\').replace(/\\+$/, '')
    return `${base}\\claude-self-tools`
  }
  const xdg = env['XDG_STATE_HOME']
  const home = env['HOME']
  const base = xdg !== undefined && xdg.startsWith('/') ? xdg : home ? `${home.replace(/\/+$/, '')}/.local/state` : undefined
  return base === undefined ? undefined : `${base.replace(/\/{2,}/g, '/').replace(/\/+$/, '')}/claude-self-tools`
}

/** A file in a folder, with the folder's own separator. */
export const inFolder = (folder: string, name: string, isWindows: boolean): string =>
  `${folder.replace(/[\\/]+$/, '')}${isWindows ? '\\' : '/'}${name}`

/** An absolute path as a file: URL, the one form Node's import takes on every system. */
export function fileUrl(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/%/g, '%25').replace(/#/g, '%23').replace(/\?/g, '%3F')
  return new URL(slashed.startsWith('/') ? `file://${slashed}` : `file:///${slashed}`).href
}

/**
 * The shim: a file that only starts the plugin's own copy of the command at `target`, so a path to the
 * shim stays the same across the plugin's updates. Nothing secret is in it.
 */
export function shimText(target: string): string {
  return [
    '#!/usr/bin/env node',
    "// secret-run, as the self-secret plugin installs it. This file only starts the plugin's own copy,",
    "// so a path to it stays the same across the plugin's updates: self-secret writes it again when a",
    '// session starts, naming the copy that session loaded. Nothing secret is in it; removing it is safe.',
    `import ${JSON.stringify(fileUrl(target))};`,
    '',
  ].join('\n')
}

/** What a call can ask for. */
export const MODES = ['once', 'hold', 'use-hold', 'end-hold', 'hold-status', 'list'] as const
export type Mode = (typeof MODES)[number]

/** A profile's name, as secret-run takes it (and its hold's file is named). */
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

/** The most a hold lasts, in minutes: secret-run's own cap. */
export const MAX_HOLD_MINUTES = 120

/** The most words a call may carry in all, and the longest word. */
const MAX_WORDS = 256
const MAX_WORD = 8192

/** What a call asked for, checked: the mode, and the words that follow the program. */
export type Asked = { mode: Mode; profile?: string; minutes?: number; args: string[] }

const isWords = (v: unknown): v is string[] => Array.isArray(v) && v.every(w => typeof w === 'string')

/**
 * The words secret-run takes for a call's input, or why the call is refused. The words themselves
 * (the prompt, a check's URL, the command) are secret-run's to judge when it runs; this checks only
 * what the line is made of.
 */
export function askedOf(input: Readonly<Record<string, unknown>>): Asked | { refusal: string } {
  const mode = input['mode'] ?? 'once'
  if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode)) return { refusal: `\`mode\` is one of ${MODES.join(', ')}.` }
  const m = mode as Mode
  const { profile, minutes, options = [], command } = input as { profile?: unknown; minutes?: unknown; options?: unknown; command?: unknown }
  const named = m === 'once' || m === 'hold' || m === 'use-hold' || m === 'end-hold'
  const runs = m === 'once' || m === 'hold' || m === 'use-hold'
  if (named) {
    if (typeof profile !== 'string' || !PROFILE_NAME.test(profile))
      return { refusal: '`profile` is a profile\'s name (lowercase letters, digits and hyphens; mode list shows them) or `generic`.' }
  } else if (profile !== undefined) return { refusal: `mode ${m} takes no \`profile\`.` }
  if (m === 'hold') {
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || !(minutes > 0 && minutes <= MAX_HOLD_MINUTES))
      return { refusal: `mode hold takes \`minutes\`: more than 0 and at most ${MAX_HOLD_MINUTES}.` }
  } else if (minutes !== undefined) return { refusal: '`minutes` goes with mode hold only.' }
  if (!isWords(options)) return { refusal: '`options` is a list of words.' }
  if (options.includes('--')) return { refusal: '`options` holds no `--`: the line puts it before the command.' }
  if ((m === 'hold-status' || m === 'end-hold') && options.length > 0) return { refusal: `mode ${m} takes no \`options\`.` }
  if (runs) {
    if (!isWords(command) || command.length === 0 || command[0] === '') return { refusal: '`command` is the command to run, one word each: ["gh", "secret", "set", "NAME"].' }
  } else if (command !== undefined) return { refusal: `mode ${m} runs no command: leave out \`command\`.` }
  const words = [...options, ...(runs && isWords(command) ? command : [])]
  if (words.length > MAX_WORDS || words.some(w => w.length > MAX_WORD))
    return { refusal: `at most ${MAX_WORDS} words in all, each at most ${MAX_WORD} characters.` }
  const name = typeof profile === 'string' ? profile : ''
  const cmd = runs && isWords(command) ? command : []
  const args =
    m === 'list' ? ['--list', ...options]
    : m === 'hold-status' ? ['--hold-status']
    : m === 'end-hold' ? ['--end-hold', name]
    : m === 'hold' ? [name, '--hold', String(minutes), ...options, '--', ...cmd]
    : m === 'use-hold' ? [name, '--use-hold', ...options, '--', ...cmd]
    : [name, ...options, '--', ...cmd]
  return { mode: m, ...(named ? { profile: name } : {}), ...(m === 'hold' ? { minutes: minutes as number } : {}), args }
}

/** A word as POSIX sh reads it back exactly: bare when it holds nothing the shell would change. */
export function shQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/**
 * A word as PowerShell hands it to a program exactly: bare only when it is plain letters, digits and
 * path characters, not starting with a hyphen; else single-quoted, each single quote (PowerShell takes
 * the curly ones as quotes too) doubled.
 */
export function psQuote(word: string): string {
  return /^[A-Za-z0-9_.\\/:][A-Za-z0-9_.\\/:-]*$/.test(word) ? word : `'${word.replace(/['\u2018\u2019\u201A\u201B]/g, c => c + c)}'`
}

/**
 * The Bash line. On Windows it says MSYS_NO_PATHCONV=1, so that Git Bash hands node every word as
 * written (it would rewrite one that starts with a slash as a Windows path), and names the shim with
 * forward slashes.
 */
export function bashLine(program: string, args: readonly string[], isWindows: boolean): string {
  const path = isWindows ? program.replace(/\\/g, '/') : program
  return [...(isWindows ? ['MSYS_NO_PATHCONV=1'] : []), 'node', shQuote(path), ...args.map(shQuote)].join(' ')
}

/** The PowerShell line (PowerShell 7.3 or later passes an empty word, and a double quote, as written). */
export function powershellLine(program: string, args: readonly string[]): string {
  return ['node', psQuote(program), ...args.map(psQuote)].join(' ')
}
