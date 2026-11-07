// The Bash env guard's file work: where this session's env folder is, what its script measures, and
// the dedupe of its files on disk. The rules themselves are pure, in env-rules.ts.
//
// The dedupe (dedupeFolder), file by file:
// - Only setup and sessionstart files, and only when they total over 2 KB, so a healthy session is
//   never touched. Claude Code empties cwdchanged and filechanged files itself mid-session; those
//   are measured, never rewritten.
// - A file is rewritten only when `dedupe` keeps the same environment and makes it shorter.
// - Backups, bounded: `<name>.orig`, written once, the file as it was before the guard first touched
//   it, so a wrong dedupe can always be undone; and `<name>.bak`, the text before the latest dedupe,
//   overwritten each time. A backup path that is a link, or anything but a plain file, leaves the
//   file as it is. The loader reads only names ending in `-hook-<n>.sh`, so neither is inlined.
// - The file is read again right before the rewrite and left as it is when it changed. That narrows
//   the window for a write by someone else; `$.fs.write` is no atomic rename, so it can't close it.
// - After the rewrite the file is read back. Exactly what was written, or that followed only by whole
//   plain assignment lines (another writer's append, landing between the write and the read), is
//   kept, the append with it. Anything else (a write that failed half-way, a torn tail) puts the
//   text first read back, and checks that.
// - A stop flag, checked before every write: once the caller's deadline has passed, no write starts.
//   A write already under way, and putting a file back after it, can still land after it.
// - It never prints or keeps a value: names, counts and lengths only. Text from outside the plugin
//   (another plugin's refusal of a read or a write) is kept apart, as `error`, for the caller to quote.
import type { EngineInterface } from 'claude-code'
import { DEDUPE_OVER, DEDUPED_FILE, dedupe, HOOK_FILE, byLoadOrder, inlinedLength, isPlainAppend } from './env-rules'
import { isSafeFolder, oneLine, SESSION_ID } from './machine'

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
 * plain drive-absolute Windows folder (a CLAUDE_CONFIG_DIR that isn't one turns the guard off, never
 * falls back): off Windows there is no 8,186-character cut to guard.
 */
export async function envFolder($: EngineInterface, id: string | undefined): Promise<string | undefined> {
  if (id === undefined || !SESSION_ID.test(id)) return undefined
  const configured = await variable(() => $.env.get('CLAUDE_CONFIG_DIR'))
  const profile = await variable(() => $.env.get('USERPROFILE'))
  const config = configured ?? (profile === undefined ? undefined : `${profile.replace(/\\+$/, '')}\\.claude`)
  if (!isSafeFolder(config)) return undefined
  return `${config.replace(/\\+$/, '')}\\session-env\\${id}`
}

/** The hook files in `folder` Claude Code inlines, in its order: plain files only, never a link or a folder; none when the folder isn't there. */
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
 * is set in this process's environment and is there, then every hook file. Reads lengths only.
 */
export async function readEnv($: EngineInterface, folder: string): Promise<EnvReading> {
  const texts: string[] = []
  const extra = await variable(() => $.env.get('CLAUDE_ENV_FILE'))
  if (extra !== undefined && (await $.fs.exists(extra))) texts.push(await $.fs.read(extra))
  const files = await hookFiles($, folder)
  for (const file of files) texts.push(await $.fs.read(file.path))
  return { inlined: inlinedLength(texts), files: files.length, bytes: files.reduce((sum, f) => sum + f.bytes, 0) }
}

/** Why a file was left as it was. */
export type LeftReason =
  | 'refused' // `dedupe` refused it, or a backup path isn't a plain file (`why` says which)
  | 'nothing-to-drop' // the dedupe wouldn't make it shorter
  | 'changed-meanwhile' // it changed between the first read and the one right before the rewrite
  | 'stopped' // the deadline had passed before its next write
  | 'unreadable' // a read or a backup's write failed before the file was touched
  | 'restored' // the rewrite didn't read back as written, or failed; the text first read is back
  | 'restore-failed' // and putting it back didn't read back either

/**
 * What became of one hook file: rewritten (`before` and `after` in characters), or left as it was:
 * why, in the plugin's words (`why`), and any error text from outside the plugin (`error`).
 */
export type FileOutcome =
  | { readonly name: string; readonly before: number; readonly after: number; readonly appended?: number }
  | { readonly name: string; readonly left: LeftReason; readonly why?: string; readonly error?: string }

/** What a dedupe of a folder did: nothing (its dedupable files total `bytes`, at or under the threshold), or each file's outcome. */
export type DedupeOutcome = { readonly kind: 'under'; readonly bytes: number } | { readonly kind: 'done'; readonly bytes: number; readonly files: readonly FileOutcome[] }

/** A caller's deadline: once `isStopped` says so, no write starts. */
export type Stop = { readonly isStopped: () => boolean }

/** No deadline. */
const NEVER: Stop = { isStopped: () => false }

/** What an error says, as one line. */
const errorText = (err: unknown): string => oneLine(err instanceof Error ? err.message : String(err), 200) || 'no reason given'

/** Whether a path is absent, a plain file, or anything else (a link, a folder, a path that can't be looked at). */
async function pathKind($: EngineInterface, path: string): Promise<'absent' | 'file' | 'other'> {
  try {
    const stat = await $.fs.stat(path)
    return stat.kind === 'file' && !stat.isLink ? 'file' : 'other'
  } catch {
    return (await $.fs.exists(path)) ? 'other' : 'absent'
  }
}

/** Dedupes one file; see the top of this file. */
async function dedupeFile($: EngineInterface, file: HookFile, stop: Stop): Promise<FileOutcome> {
  const name = file.name
  const left = (reason: LeftReason, more: { why?: string; error?: string } = {}): FileOutcome => ({ name, left: reason, ...more })
  let text: string
  try {
    text = await $.fs.read(file.path)
  } catch (err) {
    return left('unreadable', { error: errorText(err) })
  }
  const result = dedupe(text)
  if ('refused' in result) return left('refused', { why: result.refused })
  if (result.text.length >= text.length) return left('nothing-to-drop')
  const orig = `${file.path}.orig`
  const bak = `${file.path}.bak`
  try {
    const [origKind, bakKind] = [await pathKind($, orig), await pathKind($, bak)]
    if (origKind === 'other' || bakKind === 'other') return left('refused', { why: 'a backup path (.orig or .bak) is a link or not a plain file' })
    if (stop.isStopped()) return left('stopped')
    if (origKind === 'absent') await $.fs.write(orig, text)
    if (stop.isStopped()) return left('stopped')
    await $.fs.write(bak, text)
    if ((await $.fs.read(file.path)) !== text) return left('changed-meanwhile')
  } catch (err) {
    return left('unreadable', { error: errorText(err) })
  }
  if (stop.isStopped()) return left('stopped')
  let error: string | undefined
  try {
    await $.fs.write(file.path, result.text)
    const back = await $.fs.read(file.path)
    if (back === result.text) return { name, before: text.length, after: result.text.length }
    // Whole plain assignment lines after ours: another writer's append, which is kept.
    if (back.startsWith(result.text) && isPlainAppend(back.slice(result.text.length))) return { name, before: text.length, after: result.text.length, appended: back.length - result.text.length }
  } catch (err) {
    error = errorText(err)
  }
  // It didn't read back as written: put back the text first read, which the backups also hold.
  const why = error === undefined ? "it didn't read back as written" : 'the rewrite failed'
  try {
    await $.fs.write(file.path, text)
    if ((await $.fs.read(file.path)) === text) return left('restored', { why, ...(error === undefined ? {} : { error }) })
  } catch (err) {
    error = errorText(err)
  }
  return left('restore-failed', { why: `${why}, and putting it back didn't read back either`, ...(error === undefined ? {} : { error }) })
}

/**
 * Dedupes the setup and sessionstart files of `folder` when they total over `over` bytes. `stop` is
 * checked before every write: once it says so, the files not yet written are left as `stopped`.
 */
export async function dedupeFolder($: EngineInterface, folder: string, { over = DEDUPE_OVER, stop = NEVER }: { over?: number; stop?: Stop } = {}): Promise<DedupeOutcome> {
  const files = (await hookFiles($, folder)).filter(f => DEDUPED_FILE.test(f.name))
  const bytes = files.reduce((sum, f) => sum + f.bytes, 0)
  if (bytes <= over) return { kind: 'under', bytes }
  const outcomes: FileOutcome[] = []
  for (const file of files) outcomes.push(stop.isStopped() ? { name: file.name, left: 'stopped' } : await dedupeFile($, file, stop))
  return { kind: 'done', bytes, files: outcomes }
}

/** The files a dedupe rewrote. */
export const rewritten = (outcome: DedupeOutcome): { readonly name: string; readonly before: number; readonly after: number }[] =>
  outcome.kind === 'done' ? outcome.files.flatMap(f => ('before' in f ? [f] : [])) : []

/** The files a dedupe refused. */
export const refusedFiles = (outcome: DedupeOutcome): string[] =>
  outcome.kind === 'done' ? outcome.files.flatMap(f => ('left' in f && f.left === 'refused' ? [f.name] : [])) : []

/** A dedupe's outcome as one line for the debug log: names, counts and reasons, never a value. */
export function outcomeLine(outcome: DedupeOutcome): string {
  if (outcome.kind === 'under') return `session env: ${outcome.bytes} bytes of setup and sessionstart files, at or under ${DEDUPE_OVER}: left as they are`
  const parts = outcome.files.map(f => {
    if ('before' in f) return `${f.name} ${f.before} -> ${f.after}${f.appended === undefined ? '' : ` (and ${f.appended} appended meanwhile, kept)`}`
    const why = [f.why, f.error === undefined ? undefined : oneLine(f.error, 160)].filter(part => part !== undefined).join(': ')
    return `${f.name} left (${f.left}${why === '' ? '' : `: ${why}`})`
  })
  return `session env: ${outcome.bytes} bytes of setup and sessionstart files deduped: ${parts.join('; ')}`
}
