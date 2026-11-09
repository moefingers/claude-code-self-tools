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
// project folder, `<config>\projects\<project>\<id>.jsonl`, where <project> is the folder with every
// character but a letter or a digit made `-` (projectName, in the shared machine code).
import type { EngineInterface } from 'claude-code'
import { projectName, sameProject } from './machine'

/** A conversation's transcript as a classic hook named it (`transcript_path`): the conversation's id and the file's path. */
export type Transcript = { readonly id: string; readonly path: string }

/** A path's folder and its last name; undefined when it has no folder part. */
function split(path: string): { readonly folder: string; readonly name: string } | undefined {
  const at = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return at <= 0 || at === path.length - 1 ? undefined : { folder: path.slice(0, at), name: path.slice(at + 1) }
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

/**
 * Whether `folder` is where `claude --resume <id>` finds conversation `id`: the transcript a classic hook
 * named for it (`transcript`) sits in `folder`'s project folder; or, with none named, the file
 * `<config>\projects\<project>\<id>.jsonl` is there under one of `configDirs`. A folder past 200
 * characters, whose project folder the engine shortens, is never found here. Never throws.
 */
export async function holdsTranscript($: EngineInterface, folder: string, id: string, configDirs: readonly string[], transcript?: Transcript): Promise<boolean> {
  const project = projectName(folder)
  if (project === undefined || project === '') return false
  const named = transcriptFolder(transcript, id)
  if (named !== undefined) {
    const name = split(named)?.name
    return name !== undefined && sameProject(name, project)
  }
  for (const dir of configDirs) {
    try {
      if (await $.fs.exists(`${dir.replace(/[\\/]+$/, '')}\\projects\\${project}\\${id}.jsonl`)) return true
    } catch {
      // A path that can't be looked at holds nothing here.
    }
  }
  return false
}
