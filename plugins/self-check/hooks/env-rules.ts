// The Bash env guard's rules, as pure functions on text: which files Claude Code inlines into every
// Bash call and in what order, how long that script is and how much room it leaves the command, and
// the dedupe of one file. No engine call and no runtime import, so scripts/env-guard-bash.test.mjs
// runs `dedupe` in Node against real Git Bash, and the plugin's own tests run it in the kit.
//
// Claude Code (2.1.319, read from its bundle) builds every Bash call as ONE `bash.exe -c` string:
//   source <snapshot> ... && export TEMP=... && <this session's env script>
//   : && shopt ... && eval '<command>' < /dev/null && pwd -P >| <cwd file>
// The env script is CLAUDE_ENV_FILE's text (when that is set in Claude Code's own environment), then
// each `(setup|sessionstart|cwdchanged|filechanged)-hook-<n>.sh` in <config>\session-env\<session id>,
// in that order and by number, each trimmed (JavaScript's trim), the non-empty ones joined by a
// newline. Git Bash (MSYS 3.6.x) runs only the first 8,186 characters of a `-c` string and drops the
// rest without a word. anthropics/claude-code#103861.
import type { EnvVerdict } from '../types'

/** Git Bash runs the first 8,186 characters of a `-c` string and drops the rest (measured). */
export const GIT_BASH_LIMIT = 8186

/** Claude Code's wrapper around the env script and the command, before and after it (measured, about 470). */
export const WRAPPER_CHARS = 470

/** Under this much room left for the command, the env is at risk: long commands are cut. */
export const AT_RISK_BELOW = 2000

/** The deduped files' total, in bytes, at or under which nothing is rewritten. */
export const DEDUPE_OVER = 2048

/** The files Claude Code inlines, by name, as its loader matches them. */
export const HOOK_FILE = /^(setup|sessionstart|cwdchanged|filechanged)-hook-(\d+)\.sh$/

/**
 * The files the dedupe may rewrite: setup and sessionstart only. Claude Code empties the cwdchanged
 * and filechanged files itself, at any time mid-session, so a rewrite of one could put back the
 * values it just cleared.
 */
export const DEDUPED_FILE = /^(setup|sessionstart)-hook-(\d+)\.sh$/

/** The loader's order of the kinds. */
const KIND_ORDER: Readonly<Record<string, number>> = { setup: 0, sessionstart: 1, cwdchanged: 2, filechanged: 3 }

/**
 * Claude Code's own test of a plain line (2.1.319): blank, a comment, or `NAME=value`, optionally
 * after `export ` or `declare -x `, the value made of plain characters, single-quoted text, or
 * double-quoted text with no `$` or backtick. Such a value expands nothing, so the order of the
 * assignments is all that matters. Tested against the line with its trailing white space trimmed.
 */
export const PLAIN = /^(?:\s*(?:#.*)?|(?:export +|declare -x +)?([A-Za-z_]\w*)=((?:[\w@%+=:,./-]|'[^'\0]*'|"(?:[^"\\$`\0]|\\[^\0])*")*))$/

/** A plain line that exports what it sets. */
const EXPORTED = /^(?:export +|declare -x +)/

/** White space other than the space, the tab and the carriage return (which Git Bash drops from a `-c` string). */
const ODD_SPACE = /[^ \t\r]/

/** Two hook file names in the order Claude Code's loader inlines them: by kind, then by number. */
export function byLoadOrder(a: string, b: string): number {
  const x = HOOK_FILE.exec(a)
  const y = HOOK_FILE.exec(b)
  const kind = (KIND_ORDER[x?.[1] ?? ''] ?? 99) - (KIND_ORDER[y?.[1] ?? ''] ?? 99)
  return kind !== 0 ? kind : Number.parseInt(x?.[2] ?? '0', 10) - Number.parseInt(y?.[2] ?? '0', 10)
}

/** The env script as Claude Code builds it from these texts: each trimmed, the non-empty ones joined by a newline. */
export function inlinedScript(texts: readonly string[]): string {
  return texts
    .map(text => text.trim())
    .filter(text => text !== '')
    .join('\n')
}

/** The env script's length, as Claude Code builds it from these texts. */
export const inlinedLength = (texts: readonly string[]): number => inlinedScript(texts).length

/** The room an env script of `inlined` characters leaves the command in one Bash call: negative when it is over. */
export const roomLeft = (inlined: number): number => GIT_BASH_LIMIT - WRAPPER_CHARS - inlined

/** BROKEN when no room is left, AT RISK under 2,000, else OK. */
export function verdictOf(inlined: number): EnvVerdict {
  const left = roomLeft(inlined)
  if (left <= 0) return 'BROKEN'
  return left < AT_RISK_BELOW ? 'AT RISK' : 'OK'
}

/** A file's text deduped: the new text and its line counts, or why it is left as it is. */
export type Deduped = { readonly text: string; readonly lines: number; readonly kept: number } | { readonly refused: string }

/**
 * `text` with only the last assignment of each variable kept, in the order those lines stand, each
 * line as it was; blank and comment lines go. Refused:
 * - when a line isn't plain;
 * - when a line ends in white space other than spaces, tabs and carriage returns (a no-break space,
 *   a vertical tab: JavaScript's trim drops it, Git Bash keeps it in a value), which dropping the
 *   comment after it would expose to Claude Code's trim of the file;
 * - when the text isn't clean UTF-8 (a U+FFFD stands for a byte that wasn't);
 * - when a variable any earlier line exported is set by its last line without `export`, which
 *   keeping that line alone would leave unexported.
 */
export function dedupe(text: string): Deduped {
  if (text.includes('\uFFFD')) return { refused: "it isn't clean UTF-8 text" }
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  const names: (string | undefined)[] = []
  let bad = 0
  let odd = 0
  for (const line of lines) {
    const m = PLAIN.exec(line.trimEnd())
    if (m === null) bad += 1
    else if (ODD_SPACE.test(line.slice(line.trimEnd().length))) odd += 1
    names.push(m?.[1])
  }
  if (bad > 0) return { refused: `${bad} line${bad === 1 ? " isn't a plain assignment" : "s aren't plain assignments"}` }
  if (odd > 0) return { refused: `${odd} line${odd === 1 ? ' ends' : 's end'} in white space a shell keeps (not a space, a tab or a carriage return)` }
  const last = new Map<string, number>()
  const exported = new Set<string>()
  names.forEach((name, i) => {
    if (name === undefined) return
    last.set(name, i)
    if (EXPORTED.test(lines[i] as string)) exported.add(name)
  })
  for (const [name, i] of last) {
    if (exported.has(name) && !EXPORTED.test(lines[i] as string)) return { refused: 'a variable exported by one line is set without export by a later one' }
  }
  const kept = lines.filter((_, i) => names[i] !== undefined && last.get(names[i] as string) === i)
  return { text: kept.length === 0 ? '' : `${kept.join('\n')}\n`, lines: lines.length, kept: kept.length }
}

/**
 * Whether `tail` is whole plain assignment lines and nothing else (each ending in a newline, each
 * `NAME=value` by PLAIN, none ending in white space a shell keeps): what another writer appending
 * after a rewrite leaves. A fragment (a line cut mid-quote, text with no newline) is not.
 */
export function isPlainAppend(tail: string): boolean {
  if (tail === '' || !tail.endsWith('\n') || tail.includes('�')) return false
  return tail
    .slice(0, -1)
    .split('\n')
    .every(line => {
      const m = PLAIN.exec(line.trimEnd())
      return m !== null && m[1] !== undefined && !ODD_SPACE.test(line.slice(line.trimEnd().length))
    })
}

/** `n` with a comma every three digits. */
export const grouped = (n: number): string => `${n < 0 ? '-' : ''}${String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`

/** The room an env script leaves, as a phrase: what is left for the command, or by how much it is over. */
export function roomPhrase(inlined: number): string {
  const left = roomLeft(inlined)
  if (left > 0) return `${grouped(left)} left for the command`
  return left === 0 ? 'none left for the command' : `none left for the command (${grouped(-left)} over)`
}
