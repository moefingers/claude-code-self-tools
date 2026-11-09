// The resume claim: one resume per stop. Two things can resume a session a usage limit (or another API error a
// login can clear) stopped: this plugin's resume after a login change, and the coordinator plugin's auto-resume or
// the owner's Resume on its page. Each checks "no turn since the stop" and then acts, so both could pass; the claim
// lets exactly one act.
//
// The protocol, the same in both plugins (the README, "The resume claim"):
//   - the file <state>\resumed\<session id>.<turn id>.json, where <state> is
//     %LOCALAPPDATA%\claude-self-tools (the shared machine code's stateFolder), the session id is
//     `$.session.id()`, and the turn id is the `turnId` of the main-loop turn.complete that ended on the error,
//     which every plugin's hook is handed alike (2.1.319 makes one per turn with crypto.randomUUID). Both must be
//     UUIDs; anything else claims nothing and resumes nothing;
//   - holding {"v":1,"by":"<name>","at":<ms>} (UTF-8, no BOM): by is self-remote-control, coordinator (its
//     auto-resume) or coordinator:owner (the page's Resume);
//   - taken ONLY by the canonical CLAIM script below, run byte for byte (its SHA-256 pinned here and in the
//     coordinator plugin), right before the resume's $.prompt.submit: "claimed" (this run created the file: resume),
//     "taken|<by>|<at>" (someone else resumes this stop: don't), or "error|<why>" (don't). It never overwrites or
//     deletes a claim of the stop it was given, and sweeps other claims untouched for 7 days;
//   - given back only by a winner whose submit was refused or dropped, with rc-lock's RELEASE script byte for
//     byte (RC_LOCK_PATH the claim's path, RC_LOCK_TEXT the winner's own text), so a later resume can claim it.
// Off Windows (no %LOCALAPPDATA% or %SystemRoot%), where no coordinator runs, the claim is a key in this session's
// state: this plugin resumes each stop once. On Windows a claim that can't be taken resumes nothing.
import type { EngineInterface } from 'claude-code'
import { CLAIM_BY, CLAIM_SCRIPT, claimPath, claimText } from './claim-script'
import { isSafeFolder, RELEASE_SCRIPT, runCanonical, SESSION_ID } from './rc-lock'

const memoryRef = { plugin: 'self-remote-control', key: 'resumeClaims' } as const

/** How many stops the state's own claim remembers. */
const MEMORY_KEEP = 20

/** What claiming came to: won (with what gives it back), or lost, saying why in the toast's words. */
export type Claim = { won: true; giveBack: () => Promise<void> } | { lost: string }

/** Who an answer names, in the toast's words. */
function whoOf(by: string): string {
  if (by === 'coordinator') return "the coordinator's auto-resume"
  if (by === 'coordinator:owner') return "the owner (from the coordinator's page)"
  if (by === CLAIM_BY) return 'another run of this plugin'
  return /^[A-Za-z0-9._:-]{1,64}$/.test(by) && by !== 'unknown' ? by : 'another plugin'
}

/** How long ago, roughly. */
const ago = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`
}

/** The state's own claim, off Windows: one per stop, in this session, taken with a compare-and-set on its version. */
async function claimMemory($: EngineInterface, key: string): Promise<Claim> {
  const got = await $.state.get(memoryRef)
  const held = got.value ?? []
  const lost = { lost: 'no resume: another run of this plugin claimed the resume of the interrupted turn' }
  if (held.includes(key)) return lost
  const taken = await $.state.set(memoryRef, [...held, key].slice(-MEMORY_KEEP), { ifVersion: got.version })
  if (!taken.isSet) return lost
  return {
    won: true,
    giveBack: async () => {
      try {
        const now = (await $.state.get(memoryRef)).value ?? []
        await $.state.set(memoryRef, now.filter(k => k !== key))
      } catch {
        // It stays claimed: no second resume of this stop.
      }
    },
  }
}

/**
 * Claims the resume of the stop that turn `turnId` ended on, at `now`: one CLAIM. Never throws: a claim that
 * can't be taken, for any reason, is lost, saying why, and nothing is sent.
 */
export async function claimResume($: EngineInterface, turnId: string | undefined, now: number): Promise<Claim> {
  try {
    if (turnId === undefined || !SESSION_ID.test(turnId)) return { lost: "no resume: the interrupted turn's id isn't known, so the resume can't be claimed" }
    const [local, root, session] = await Promise.all([$.env.get('LOCALAPPDATA'), $.env.get('SystemRoot'), $.session.id()])
    if (!SESSION_ID.test(session)) return { lost: "no resume: this session's id isn't one, so the resume can't be claimed" }
    if (local === undefined && root === undefined) return await claimMemory($, `${session}.${turnId}`)
    if (!isSafeFolder(local) || typeof root !== 'string' || !/^[A-Za-z]:\\[^\\/:*?"<>|]+\\?$/.test(root)) return { lost: "no resume: the resume claim can't be placed (no usable %LOCALAPPDATA% or %SystemRoot%)" }
    const powershell = `${root.replace(/\\+$/, '')}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    const path = claimPath(local, session, turnId)
    const text = claimText(CLAIM_BY, now)
    const line = await runCanonical($, powershell, CLAIM_SCRIPT, { RESUME_CLAIM_PATH: path, RESUME_CLAIM_TEXT: text })
    if (line === 'claimed') {
      return {
        won: true,
        giveBack: async () => {
          try {
            await runCanonical($, powershell, RELEASE_SCRIPT, { RC_LOCK_PATH: path, RC_LOCK_TEXT: text })
          } catch {
            // It stays claimed: no second resume of this stop.
          }
        },
      }
    }
    if (line.startsWith('taken|')) {
      const [, by = 'unknown', at = '0'] = line.split('|')
      const when = Number(at) > 0 ? ` ${ago(now - Number(at))} ago` : ''
      return { lost: `no resume: ${whoOf(by)} claimed the resume of the interrupted turn${when}` }
    }
    const why = line.startsWith('error|') ? line.slice('error|'.length).trim() : "an answer this plugin doesn't know"
    return { lost: `no resume: the resume claim couldn't be taken (${why === '' ? 'no reason given' : why})` }
  } catch (err) {
    const said = (err instanceof Error ? err.message : String(err)).trim()
    return { lost: `no resume: the resume claim couldn't be taken (${said === '' ? 'no reason given' : said})` }
  }
}
