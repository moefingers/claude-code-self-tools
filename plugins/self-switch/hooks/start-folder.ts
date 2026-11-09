// The folder a session started in, checked against its conversation's transcript: what self-restart and
// self-switch go by before they trust a start folder Claude Code may have lost.
//
// Canonical copy: shared/hooks/start-folder.ts. It is copied, identical, to the plugins named on the next
// line, at plugins/<name>/hooks/start-folder.ts; `node scripts/sync-shared.mjs` writes those copies and
// `node --test "scripts/*.test.mjs"` fails when one differs, or sits in a plugin not named. Edit the
// canonical copy only.
// Copies: self-restart, self-switch
//
// Claude Code empties a plugin's `$.state` when a session ends inside the process, at a /clear or a
// /resume (typed, or run by a plugin or a switch), and no session.start follows. A start folder kept only
// there is lost, and a reload of the plugin then sets it again from wherever the session is now. So each
// plugin keeps its own copy in the module, and checks any folder it hasn't kept since the process started
// against the transcript: `claude --resume <id>` finds a conversation only under its start folder's
// project folder, `<config>\projects\<project>\<id>.jsonl`.
//
// The project folder's name, by Claude Code's own rule (read from the 2.1.3xx engine's text, where one
// function names the projects, the logs and the caches alike): the folder with every character but a
// letter or a digit made `-` (projectName, in the shared machine code); past 200 characters, its first 200,
// a `-`, and a hash of the folder as given (the 31-multiplier string hash, its absolute value in base 36).
// The hash is of the folder's exact spelling, which may differ from the one Claude Code was given (the
// drive letter's case), so a long folder is also found by a prefix: a project folder whose name is the
// first 200 and a `-`, holding `<id>.jsonl`.
import type { EngineInterface } from 'claude-code'
import { projectName, sameProject } from './machine'

/** A conversation's transcript as a classic hook named it (`transcript_path`): the conversation's id and the file's path. */
export type Transcript = { readonly id: string; readonly path: string }

/** What the check found: the folder holds the transcript (in project folder `project`), doesn't, or couldn't be checked (`error`, what failed). */
export type TranscriptCheck = { readonly holds: true; readonly project: string } | { readonly holds: false } | { readonly error: string }

/** How long a project folder's name is before Claude Code shortens it. */
const NAME_MAX = 200

/** A path's folder and its last name; undefined when it has no folder part. */
function split(path: string): { readonly folder: string; readonly name: string } | undefined {
  const at = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return at <= 0 || at === path.length - 1 ? undefined : { folder: path.slice(0, at), name: path.slice(at + 1) }
}

/** The 31-multiplier string hash Claude Code names a long project folder by, over UTF-16 units, kept to 32 bits. */
function stringHash(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
  return hash
}

/**
 * The name of `folder`'s project folder, as Claude Code makes it: projectName's, or past 200 characters
 * the first 200, a `-`, and the folder's hash in base 36.
 */
export function projectFolderName(folder: string): string {
  const short = projectName(folder)
  if (short !== undefined) return short
  return `${folder.replace(/[^A-Za-z0-9]/g, '-').slice(0, NAME_MAX)}-${Math.abs(stringHash(folder)).toString(36)}`
}

/** Whether a project folder named `name` is `folder`'s: the name Claude Code makes, or for a long folder its first 200 and a `-` (the hash spelled from another spelling). */
export function isProjectOf(name: string, folder: string): boolean {
  const own = projectFolderName(folder)
  if (sameProject(name, own)) return true
  if (projectName(folder) !== undefined) return false
  const prefix = `${own.slice(0, NAME_MAX)}-`
  return name.length > prefix.length && sameProject(name.slice(0, prefix.length), prefix)
}

/**
 * The project folder conversation `id`'s transcript sits in (`<config>\projects\<project>`), as `transcript`
 * names it; undefined when `transcript` is another conversation's, or not a path to `<id>.jsonl`.
 */
export function transcriptFolder(transcript: Transcript | undefined, id: string): string | undefined {
  if (transcript === undefined || transcript.id !== id) return undefined
  const file = split(transcript.path)
  return file !== undefined && file.name.toLowerCase() === `${id}.jsonl` ? file.folder : undefined
}

/** Why a call on the files failed, as one line. */
const failure = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim() || 'no reason given'

/**
 * Whether `folder` is where `claude --resume <id>` finds conversation `id`. With the transcript a classic
 * hook named for it (`transcript`), whether that sits in `folder`'s project folder (isProjectOf). Without,
 * under each of `configDirs`: `<config>\projects\<project>\<id>.jsonl` exists; or, for a long folder, a
 * project folder named by its first 200 characters and a `-` holds `<id>.jsonl` (found with `$.fs.list`).
 * A look that fails, and nothing else found, is `error`. Never throws.
 */
export async function checkTranscript($: EngineInterface, folder: string, id: string, configDirs: readonly string[], transcript?: Transcript): Promise<TranscriptCheck> {
  const own = projectFolderName(folder)
  if (own === '') return { holds: false }
  const named = transcriptFolder(transcript, id)
  if (named !== undefined) {
    const name = split(named)?.name
    return name !== undefined && isProjectOf(name, folder) ? { holds: true, project: named } : { holds: false }
  }
  let error: string | undefined
  const isLong = projectName(folder) === undefined
  for (const dir of configDirs) {
    const projects = `${dir.replace(/[\\/]+$/, '')}\\projects`
    try {
      if (await $.fs.exists(`${projects}\\${own}\\${id}.jsonl`)) return { holds: true, project: `${projects}\\${own}` }
    } catch (err) {
      error ??= `looking for ${projects}\\${own}\\${id}.jsonl failed (${failure(err)})`
    }
    if (!isLong) continue
    try {
      for (const entry of await $.fs.list(projects)) {
        if (entry.kind !== 'dir' || !isProjectOf(entry.name, folder)) continue
        if (await $.fs.exists(`${projects}\\${entry.name}\\${id}.jsonl`)) return { holds: true, project: `${projects}\\${entry.name}` }
      }
    } catch (err) {
      error ??= `listing ${projects} failed (${failure(err)})`
    }
  }
  return error === undefined ? { holds: false } : { error }
}

/** The most project folders findTranscript looks in. */
const MAX_PROJECTS = 500

/**
 * The project folder conversation `id`'s transcript is in, under any of `configDirs` (`<config>\projects\
 * <project>` holding `<id>.jsonl`), at most MAX_PROJECTS looked in; undefined when none holds it, or they
 * can't be listed. For a refusal to name where the conversation is. Never throws.
 */
export async function findTranscript($: EngineInterface, id: string, configDirs: readonly string[]): Promise<string | undefined> {
  let looked = 0
  for (const dir of configDirs) {
    const projects = `${dir.replace(/[\\/]+$/, '')}\\projects`
    try {
      for (const entry of await $.fs.list(projects)) {
        if (entry.kind !== 'dir') continue
        looked += 1
        if (looked > MAX_PROJECTS) return undefined
        if (await $.fs.exists(`${projects}\\${entry.name}\\${id}.jsonl`)) return `${projects}\\${entry.name}`
      }
    } catch {
      // Not there, or not to be listed: nothing found under it.
    }
  }
  return undefined
}
