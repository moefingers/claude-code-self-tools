// Embeds plugins/self-switch/slot/claude-launch.ps1 in shared/hooks/machine.ts as LAUNCH_SCRIPT_TEXT
// (one JSON string per line, right after launchHandPath), replacing the copy there, and writes the
// script's SHA-256 into LAUNCH_SCRIPT_SHA256 and its version line (`# claude-launch version <n>`) into
// LAUNCH_SCRIPT_VERSION. Run after any edit to the script, with its version line one higher, then
// `node scripts/sync-shared.mjs`; scripts/claude-launch.test.mjs holds the four equal.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './sync-shared.mjs'

const ps1 = readFileSync(join(ROOT, 'plugins', 'self-switch', 'slot', 'claude-launch.ps1'), 'utf8')
if (/[^\x00-\x7f]/.test(ps1) || ps1.includes('\r')) throw new Error('claude-launch.ps1 must be ASCII with LF line ends')
const version = /^# claude-launch version (\d{1,6})$/m.exec(ps1)?.[1]
if (version === undefined) throw new Error('claude-launch.ps1 has no `# claude-launch version <n>` line')
const sha = createHash('sha256').update(ps1).digest('hex')
const file = join(ROOT, 'shared', 'hooks', 'machine.ts')
let text = readFileSync(file, 'utf8')
const anchor = "export const launchHandPath = (state: string): string => `${state}\\\\claude-launch.ps1`\n"
if (!text.includes(anchor)) throw new Error('launchHandPath is not where this script expects it')
const head = '\n/** claude-launch.ps1 as this release ships it'
const tail = "].join('\\n')\n"
const begin = text.indexOf(head)
if (begin !== -1) text = text.slice(0, begin) + text.slice(text.indexOf(tail, begin) + tail.length)
const block = [
  '',
  '/** claude-launch.ps1 as this release ships it, byte for byte (ASCII, LF line ends): the copy a launch puts at launchScriptPath when the one there is missing or has another SHA-256. scripts/claude-launch.test.mjs holds it equal to plugins/self-switch/slot/claude-launch.ps1 and to LAUNCH_SCRIPT_SHA256; after an edit to the script, run `node scripts/embed-launch.mjs`. */',
  'export const LAUNCH_SCRIPT_TEXT = [',
  ...ps1.split('\n').map(line => `  ${JSON.stringify(line)},`),
  "].join('\\n')",
  '',
].join('\n')
// Functions, never strings, as the replacements: the script's text holds `$'` and the like, which a
// replacement string would read as patterns.
text = text.replace(anchor, () => anchor + block)
const shaLine = /^export const LAUNCH_SCRIPT_SHA256 = '[0-9a-f]{64}'$/m
const versionLine = /^export const LAUNCH_SCRIPT_VERSION = \d{1,6}$/m
if (!shaLine.test(text) || !versionLine.test(text)) throw new Error('LAUNCH_SCRIPT_SHA256 or LAUNCH_SCRIPT_VERSION is not where this script expects it')
text = text.replace(shaLine, () => `export const LAUNCH_SCRIPT_SHA256 = '${sha}'`).replace(versionLine, () => `export const LAUNCH_SCRIPT_VERSION = ${version}`)
writeFileSync(file, text)
console.log(`LAUNCH_SCRIPT_TEXT embedded; LAUNCH_SCRIPT_SHA256 = '${sha}'; LAUNCH_SCRIPT_VERSION = ${version}`)
