// The Bash env guard. Claude Code (2.1.319, read from its bundle) builds every Bash call as ONE
// `bash.exe -c` string:
//   source <snapshot> ... && export TEMP=... && <this session's env script>
//   : && shopt ... && eval '<command>' < /dev/null && pwd -P >| <cwd file>
// The env script is CLAUDE_ENV_FILE's text (when that is set in Claude Code's own environment), then
// each `(setup|sessionstart|cwdchanged|filechanged)-hook-<n>.sh` in
// <config>\session-env\<session id>, in that order and by number, each trimmed, the non-empty ones
// joined by a newline. Git Bash (MSYS 3.6.x) runs only the first 8,186 characters of a `-c` string
// and drops the rest without a word. SessionStart hooks that append to their env file on every
// start (the Vercel plugin adds 3 export lines at each startup, resume, clear and compact, and never
// clears them) grow that script until the command is cut: first long commands (`unexpected EOF`),
// then every command (exit 0, no output). anthropics/claude-code#103861.
//
// What the guard does:
// - It measures the script, and says how much room it leaves the command (roomLeft, verdictOf).
// - It dedupes this session's hook files (dedupe, dedupeFolder): in each, only the last assignment
//   of each variable is kept, in order, so a shell that sources it ends up with the same environment.
//   A file holding any line that isn't a plain assignment (Claude Code's own test, PLAIN) is left
//   as it is; so is one where a later line sets, without `export`, a variable an earlier line
//   exported. A file is rewritten only when that makes it shorter, and only when the folder's hook
//   files total over 2 KB, so a healthy session is never touched. Before a rewrite the file's text
//   goes to `<name>.bak`, one per file, overwritten each time; the loader reads only names ending
//   in `-hook-<n>.sh`, so a backup is never inlined.
// - It never reads, prints or keeps a value: names, counts and lengths only.
//
// When it runs is register.ts's business: right after the SessionStart hooks beneath have run, and
// when tools_check finds the env at risk.
import type { EngineInterface } from 'claude-code'
import type { EnvVerdict } from '../types'
import { isSafeFolder, SESSION_ID } from './machine'

/** Git Bash runs the first 8,186 characters of a `-c` string and drops the rest (measured). */
export const GIT_BASH_LIMIT = 8186

/** Claude Code's wrapper around the env script and the command, before and after it (measured, about 470). */
export const WRAPPER_CHARS = 470

/** Under this much room left for the command, the env is at risk: long commands are cut. */
export const AT_RISK_BELOW = 2000

/** The hook files' total, in bytes, at or under which nothing is rewritten. */
export const DEDUPE_OVER = 2048

/** The files Claude Code inlines, by name, as its loader matches them. */
export const HOOK_FILE = /^(setup|sessionstart|cwdchanged|filechanged)-hook-(\d+)\.sh$/

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

/** Two hook file names in the order Claude Code's loader inlines them: by kind, then by number. */
export function byLoadOrder(a: string, b: string): number {
  const x = HOOK_FILE.exec(a)
  const y = HOOK_FILE.exec(b)
  const kind = (KIND_ORDER[x?.[1] ?? ''] ?? 99) - (KIND_ORDER[y?.[1] ?? ''] ?? 99)
  return kind !== 0 ? kind : Number.parseInt(x?.[2] ?? '0', 10) - Number.parseInt(y?.[2] ?? '0', 10)
}

/** The env script's length, as Claude Code builds it from these texts: each trimmed, the non-empty ones joined by a newline. */
export function inlinedLength(texts: readonly string[]): number {
  return texts
    .map(text => text.trim())
    .filter(text => text !== '')
    .join('\n').length
}

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
 * line as it was (a `\r` before its newline included); blank and comment lines go. Refused when a
 * line isn't plain, when the text isn't clean UTF-8 (a U+FFFD stands for a byte that wasn't), or
 * when a variable an earlier line exported is set by its last line without `export`, which keeping
 * that line alone would leave unexported.
 */
export function dedupe(text: string): Deduped {
  if (text.includes('\uFFFD')) return { refused: "it isn't clean UTF-8 text" }
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  const names: (string | undefined)[] = []
  let bad = 0
  for (const line of lines) {
    const m = PLAIN.exec(line.trimEnd())
    if (m === null) bad += 1
    names.push(m?.[1])
  }
  if (bad > 0) return { refused: `${bad} line${bad === 1 ? " isn't a plain assignment" : "s aren't plain assignments"}` }
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

/** One hook file: its name, path and size in bytes, as the folder lists it. */
export type HookFile = { readonly name: string; readonly path: string; readonly bytes: number }

/** An environment variable's value; undefined when unset or unreadable. */
async function variable(read: () => Promise<string | undefined>): Promise<string | undefined> {
  try {
    const value = await read()
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Session `id`'s env folder, <config>\session-env\<id>, the config folder being CLAUDE_CONFIG_DIR or
 * %USERPROFILE%\.claude. Undefined when the id isn't a session id, or the config folder isn't a
 * plain drive-absolute Windows folder: off Windows there is no 8,186-character cut to guard.
 */
export async function envFolder($: EngineInterface, id: string | undefined): Promise<string | undefined> {
  if (id === undefined || !SESSION_ID.test(id)) return undefined
  const configured = await variable(() => $.env.get('CLAUDE_CONFIG_DIR'))
  const profile = await variable(() => $.env.get('USERPROFILE'))
  const config = configured ?? (profile === undefined ? undefined : `${profile.replace(/\\+$/, '')}\\.claude`)
  if (!isSafeFolder(config)) return undefined
  return `${config.replace(/\\+$/, '')}\\session-env\\${id}`
}

/** The hook files in `folder` Claude Code inlines, in its order; none when the folder isn't there. */
export async function hookFiles($: EngineInterface, folder: string): Promise<HookFile[]> {
  if (!(await $.fs.exists(folder))) return []
  const entries = await $.fs.list(folder)
  return entries
    .filter(entry => entry.kind === 'file' && !entry.isLink && HOOK_FILE.test(entry.name))
    .map(entry => ({ name: entry.name, path: `${folder}\\${entry.name}`, bytes: entry.size }))
    .sort((a, b) => byLoadOrder(a.name, b.name))
}

/** The env script's length now, in characters, and the hook files it came from. */
export type EnvReading = { readonly inlined: number; readonly files: number; readonly bytes: number }

/**
 * Measures the env script Claude Code builds for session `folder`: CLAUDE_ENV_FILE's text when that
 * is set in this process's environment and is there, then the hook files. Reads lengths only.
 */
export async function readEnv($: EngineInterface, folder: string): Promise<EnvReading> {
  const texts: string[] = []
  const extra = await variable(() => $.env.get('CLAUDE_ENV_FILE'))
  if (extra !== undefined && (await $.fs.exists(extra))) texts.push(await $.fs.read(extra))
  const files = await hookFiles($, folder)
  for (const file of files) texts.push(await $.fs.read(file.path))
  return { inlined: inlinedLength(texts), files: files.length, bytes: files.reduce((sum, f) => sum + f.bytes, 0) }
}

/** What became of one hook file: rewritten (`before` and `after` in characters), left as it was and why, or not read. */
export type FileOutcome =
  | { readonly name: string; readonly before: number; readonly after: number }
  | { readonly name: string; readonly left: 'refused' | 'nothing-to-drop' | 'changed-meanwhile' | 'unreadable'; readonly why?: string }

/** What a dedupe of a folder did: nothing (its hook files total `bytes`, at or under the threshold), or each file's outcome. */
export type DedupeOutcome = { readonly kind: 'under'; readonly bytes: number } | { readonly kind: 'done'; readonly bytes: number; readonly files: readonly FileOutcome[] }

/** What an error says, as a short line. */
const why = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim().slice(0, 160) || 'no reason given'

/**
 * Dedupes the hook files of `folder` when they total over `over` bytes: each file whose deduped text
 * is shorter is backed up to `<name>.bak` (one per file, overwritten) and rewritten. A file is read
 * again right before its rewrite, and left as it is when it changed since the first read, so a
 * write by someone else in between isn't lost.
 */
export async function dedupeFolder($: EngineInterface, folder: string, over = DEDUPE_OVER): Promise<DedupeOutcome> {
  const files = await hookFiles($, folder)
  const bytes = files.reduce((sum, f) => sum + f.bytes, 0)
  if (bytes <= over) return { kind: 'under', bytes }
  const outcomes: FileOutcome[] = []
  for (const file of files) {
    try {
      const text = await $.fs.read(file.path)
      const result = dedupe(text)
      if ('refused' in result) {
        outcomes.push({ name: file.name, left: 'refused', why: result.refused })
        continue
      }
      if (result.text.length >= text.length) {
        outcomes.push({ name: file.name, left: 'nothing-to-drop' })
        continue
      }
      await $.fs.write(`${file.path}.bak`, text)
      if ((await $.fs.read(file.path)) !== text) {
        outcomes.push({ name: file.name, left: 'changed-meanwhile' })
        continue
      }
      await $.fs.write(file.path, result.text)
      outcomes.push({ name: file.name, before: text.length, after: result.text.length })
    } catch (err) {
      outcomes.push({ name: file.name, left: 'unreadable', why: why(err) })
    }
  }
  return { kind: 'done', bytes, files: outcomes }
}

/** The files a dedupe rewrote. */
export const rewritten = (outcome: DedupeOutcome): { readonly name: string; readonly before: number; readonly after: number }[] =>
  outcome.kind === 'done' ? outcome.files.flatMap(f => ('before' in f ? [f] : [])) : []

/** A dedupe's outcome as one line for the debug log: names and counts only. */
export function outcomeLine(outcome: DedupeOutcome): string {
  if (outcome.kind === 'under') return `session env: ${outcome.bytes} bytes of hook files, at or under ${DEDUPE_OVER}: left as they are`
  const parts = outcome.files.map(f => ('before' in f ? `${f.name} ${f.before} -> ${f.after}` : `${f.name} left (${f.left}${f.why === undefined ? '' : `: ${f.why}`})`))
  return `session env: ${outcome.bytes} bytes of hook files deduped: ${parts.join('; ')}`
}

/** `n` with a comma every three digits. */
export const grouped = (n: number): string => `${n < 0 ? '-' : ''}${String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`

/** The room an env script leaves, as a phrase: what is left for the command, or by how much it is over. */
export function roomPhrase(inlined: number): string {
  const left = roomLeft(inlined)
  if (left > 0) return `${grouped(left)} left for the command`
  return left === 0 ? 'none left for the command' : `none left for the command (${grouped(-left)} over)`
}
