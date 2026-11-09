// Embeds plugins/self-switch/slot/claude-launch.ps1 in shared/hooks/machine.ts as LAUNCH_SCRIPT_TEXT
// (one JSON string per line, right after launchHandPath), replacing the copy there, and writes the
// script's SHA-256 into LAUNCH_SCRIPT_SHA256 and its version line (`# claude-launch version <n>`) into
// LAUNCH_SCRIPT_VERSION. First it pins the claude wrapper (tools/claude-wrapper/claude-wrapper.ps1): its
// SHA-256 into claude-launch.ps1's `$WrapperSha256` and into WRAPPER_SCRIPT_SHA256, and its text into
// WRAPPER_SCRIPT_TEXT (right after wrapperScriptPath), so a change to the wrapper is a change to the
// launcher too. It pins the slot runner too: its SHA-256 into claude-layout.ps1's `$SlotSha`, and
// into SLOT_SCRIPT_SHA256; then the layout script's own into LAYOUT_SCRIPT_SHA256. Run after any edit to
// one of the four, with claude-launch's version line one higher if it changed (an edit to the wrapper
// changes it), then `node scripts/sync-shared.mjs`; scripts/claude-launch.test.mjs and
// scripts/slot-runner.test.mjs hold them equal.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './sync-shared.mjs'

const SLOT_FOLDER = join(ROOT, 'plugins', 'self-switch', 'slot')
const sha256 = text => createHash('sha256').update(text).digest('hex')
const plain = (name, text) => {
  if (/[^\x00-\x7f]/.test(text) || text.includes('\r')) throw new Error(`${name} must be ASCII with LF line ends`)
  return text
}

// The claude wrapper first: its pin goes into claude-launch.ps1, whose own hash then covers it.
const wrapper = plain('claude-wrapper.ps1', readFileSync(join(ROOT, 'tools', 'claude-wrapper', 'claude-wrapper.ps1'), 'utf8'))
const wrapperSha = sha256(wrapper)
const launchFile = join(SLOT_FOLDER, 'claude-launch.ps1')
const wrapperPin = /^\$WrapperSha256 = '[^']*'$/m
const unpinned = plain('claude-launch.ps1', readFileSync(launchFile, 'utf8'))
if (!wrapperPin.test(unpinned)) throw new Error('claude-launch.ps1 has no $WrapperSha256 line')
const ps1 = unpinned.replace(wrapperPin, () => `$WrapperSha256 = '${wrapperSha}'`)
if (ps1 !== unpinned) writeFileSync(launchFile, ps1)
const version = /^# claude-launch version (\d{1,6})$/m.exec(ps1)?.[1]
if (version === undefined) throw new Error('claude-launch.ps1 has no `# claude-launch version <n>` line')
const sha = sha256(ps1)
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
// The wrapper's text, the same way, right after wrapperScriptPath.
const wrapperAnchor = '  return `${state}\\\\claude-wrapper-${sha.slice(0, 8)}.ps1`\n}\n'
if (!text.includes(wrapperAnchor)) throw new Error('wrapperScriptPath is not where this script expects it')
const wrapperHead = '\n/** The claude wrapper as this release ships it'
const wrapperBegin = text.indexOf(wrapperHead)
if (wrapperBegin !== -1) text = text.slice(0, wrapperBegin) + text.slice(text.indexOf(tail, wrapperBegin) + tail.length)
const wrapperBlock = [
  '',
  '/** The claude wrapper as this release ships it, byte for byte (ASCII, LF line ends): tools/claude-wrapper/claude-wrapper.ps1, the copy a launch that opens a window puts at wrapperScriptPath when the one there is missing or has another SHA-256 (WRAPPER_SCRIPT_SHA256), for claude-launch.ps1 -Wrapper. scripts/claude-launch.test.mjs holds it equal to the file; after an edit to the wrapper, run `node scripts/embed-launch.mjs`. */',
  'export const WRAPPER_SCRIPT_TEXT = [',
  ...wrapper.split('\n').map(line => `  ${JSON.stringify(line)},`),
  "].join('\\n')",
  '',
].join('\n')
text = text.replace(wrapperAnchor, () => wrapperAnchor + wrapperBlock)
const lines = {
  LAUNCH_SCRIPT_SHA256: /^export const LAUNCH_SCRIPT_SHA256 = '[0-9a-f]{64}'$/m,
  LAUNCH_SCRIPT_VERSION: /^export const LAUNCH_SCRIPT_VERSION = \d{1,6}$/m,
  WRAPPER_SCRIPT_SHA256: /^export const WRAPPER_SCRIPT_SHA256 = '[0-9a-f]{64}'$/m,
  SLOT_SCRIPT_SHA256: /^export const SLOT_SCRIPT_SHA256 = '[0-9a-f]{64}'$/m,
  LAYOUT_SCRIPT_SHA256: /^export const LAYOUT_SCRIPT_SHA256 = '[0-9a-f]{64}'$/m,
}
for (const [name, line] of Object.entries(lines)) if (!line.test(text)) throw new Error(`${name} is not where this script expects it`)

const slotSha = sha256(plain('claude-slot.ps1', readFileSync(join(SLOT_FOLDER, 'claude-slot.ps1'), 'utf8')))
const layoutFile = join(SLOT_FOLDER, 'claude-layout.ps1')
const layoutLine = /^\$SlotSha = '[^']*'$/m
const oldLayout = plain('claude-layout.ps1', readFileSync(layoutFile, 'utf8'))
if (!layoutLine.test(oldLayout)) throw new Error('claude-layout.ps1 has no $SlotSha line')
const layout = oldLayout.replace(layoutLine, () => `$SlotSha = '${slotSha}'`)
writeFileSync(layoutFile, layout)
const layoutSha = sha256(layout)

text = text
  .replace(lines.LAUNCH_SCRIPT_SHA256, () => `export const LAUNCH_SCRIPT_SHA256 = '${sha}'`)
  .replace(lines.LAUNCH_SCRIPT_VERSION, () => `export const LAUNCH_SCRIPT_VERSION = ${version}`)
  .replace(lines.WRAPPER_SCRIPT_SHA256, () => `export const WRAPPER_SCRIPT_SHA256 = '${wrapperSha}'`)
  .replace(lines.SLOT_SCRIPT_SHA256, () => `export const SLOT_SCRIPT_SHA256 = '${slotSha}'`)
  .replace(lines.LAYOUT_SCRIPT_SHA256, () => `export const LAYOUT_SCRIPT_SHA256 = '${layoutSha}'`)
writeFileSync(file, text)
// The README prints the layout script's hash, for the person to compare.
const readmeFile = join(ROOT, 'README.md')
const readmeLine = /LAYOUT_SCRIPT_SHA256: `[0-9a-f]{64}`/
const readme = readFileSync(readmeFile, 'utf8')
if (!readmeLine.test(readme)) throw new Error('the README prints no LAYOUT_SCRIPT_SHA256')
writeFileSync(readmeFile, readme.replace(readmeLine, () => `LAYOUT_SCRIPT_SHA256: \`${layoutSha}\``))
console.log(`WRAPPER_SCRIPT_TEXT embedded; WRAPPER_SCRIPT_SHA256 = '${wrapperSha}'; LAUNCH_SCRIPT_TEXT embedded; LAUNCH_SCRIPT_SHA256 = '${sha}'; LAUNCH_SCRIPT_VERSION = ${version}; SLOT_SCRIPT_SHA256 = '${slotSha}'; LAYOUT_SCRIPT_SHA256 = '${layoutSha}'`)
