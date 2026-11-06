// Embeds plugins/self-switch/slot/claude-launch.ps1 in shared/hooks/machine.ts as LAUNCH_SCRIPT_TEXT
// (one JSON string per line, right after launchScriptPath), replacing the copy there, and prints the
// script's SHA-256 for LAUNCH_SCRIPT_SHA256. Run after any edit to the script, then
// `node scripts/sync-shared.mjs`; scripts/claude-launch.test.mjs holds the three equal.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './sync-shared.mjs'

const ps1 = readFileSync(join(ROOT, 'plugins', 'self-switch', 'slot', 'claude-launch.ps1'), 'utf8')
if (/[^\x00-\x7f]/.test(ps1) || ps1.includes('\r')) throw new Error('claude-launch.ps1 must be ASCII with LF line ends')
const file = join(ROOT, 'shared', 'hooks', 'machine.ts')
let text = readFileSync(file, 'utf8')
const anchor = "export const launchScriptPath = (state: string): string => `${state}\\\\claude-launch.ps1`\n"
if (!text.includes(anchor)) throw new Error('launchScriptPath is not where this script expects it')
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
text = text.replace(anchor, anchor + block)
writeFileSync(file, text)
console.log(`LAUNCH_SCRIPT_TEXT embedded; LAUNCH_SCRIPT_SHA256 = '${createHash('sha256').update(ps1).digest('hex')}'`)
