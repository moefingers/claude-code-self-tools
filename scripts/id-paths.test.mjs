// Every file named by an id is built by idPath (shared/hooks/machine.ts), which checks the id before
// joining: no plugin's code, and no other line of the machine code, joins one of those folders with a
// value of its own (a template, a `+`, a join call, an array joined, on one line or over several). The
// folders are the machine code's own (ID_FOLDERS, from ID_FILES), never a copy kept here. The PowerShell
// inside the generated scripts joins only its own variables, set from literals of ids checked before
// they were spliced in, so it is not what this scans. Then the faults: a call site joining a raw id,
// planted in a copy, is found, in each shape. Run with `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { plugins, ROOT } from './sync-shared.mjs'

const machine = await import(pathToFileURL(join(ROOT, 'shared', 'hooks', 'machine.ts')).href)

/** The folders under the state folder whose files are named by an id: ID_FILES' own, as the machine code exports them. */
const FOLDERS = machine.ID_FOLDERS.join('|')

/** A string literal holding exactly one of those folders. */
const FOLDER_LITERAL = String.raw`['"\x60](?:${FOLDERS})['"\x60]`

/** The shapes of a join of one of those folders with a value, each on one line. */
const LINE_JOINS = [
  // `${state}\\claims\\${id}.lock`
  new RegExp(String.raw`\b(?:${FOLDERS})\\\\\$\{`),
  // state + '\\claims\\' + id   (a PowerShell `+ $id` inside a script is not a TS value)
  new RegExp(String.raw`\b(?:${FOLDERS})\\\\['"\x60]\s*\+\s*[A-Za-z_(]`),
]

/** The shapes that may run over several lines: a join call (path.join, resolve) and an array joined. */
const SPAN_JOINS = [
  // join(state, 'claims', id), or one split over lines
  new RegExp(String.raw`\b(?:join|resolve)\s*\([^()]*${FOLDER_LITERAL}\s*,`, 'g'),
  // [state, 'left', id].join('\\'), or one split over lines
  new RegExp(String.raw`\[[^\[\]]*${FOLDER_LITERAL}[^\[\]]*\]\s*\.join\(`, 'g'),
]

/** Every place in `text` that joins an id folder with a value outside idPath, as `<file>:<line>: <text>`. */
function rawJoins(file, text) {
  const found = []
  const lines = text.split(/\r?\n/)
  // idPath's own body is the one place a folder and an id are joined.
  const start = lines.findIndex(line => /^export function idPath\(/.test(line))
  const end = start === -1 ? -1 : lines.findIndex((line, i) => i > start && line === '}')
  const isComment = line => /^\s*(?:\/\/|\*|\/\*\*)/.test(line)
  const inIdPath = i => start !== -1 && i >= start && i <= end
  lines.forEach((line, i) => {
    if (inIdPath(i) || isComment(line)) return
    if (LINE_JOINS.some(re => re.test(line))) found.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`)
  })
  // The text without comments and idPath's body, its line breaks kept so a match can say its line.
  const code = lines.map((line, i) => (inIdPath(i) || isComment(line) ? '' : line)).join('\n')
  for (const re of SPAN_JOINS) {
    for (const match of code.matchAll(re)) {
      const at = code.slice(0, match.index).split('\n').length
      const said = `${file}:${at}: ${match[0].replace(/\s+/g, ' ').trim().slice(0, 160)}`
      if (!found.some(f => f.startsWith(`${file}:${at}:`))) found.push(said)
    }
  }
  return found
}

/** The TypeScript of the machine code and of every plugin's hooks. */
function sources() {
  const files = [join('shared', 'hooks', 'machine.ts')]
  for (const name of plugins()) {
    const dir = join('plugins', name, 'hooks')
    let entries = []
    try {
      entries = readdirSync(join(ROOT, dir))
    } catch {
      continue
    }
    for (const entry of entries) if (entry.endsWith('.ts') && entry !== 'machine.ts') files.push(join(dir, entry))
  }
  return files
}

test('the folders scanned for are the machine code\'s own, each once', () => {
  assert.deepEqual([...machine.ID_FOLDERS].sort(), ['claims', 'gate', 'left', 'panes', 'pending', 'poke', 'refused', 'selfcheck', 'slots', 'wake', 'windows'])
  for (const folder of machine.ID_FOLDERS) assert.ok(machine.idPathOrNone('C:\\state', 'left', '00000000-0000-4000-a000-000000000001') !== undefined && typeof folder === 'string')
})

test('no call site joins an id folder with a value of its own: every such path goes through idPath', () => {
  const files = sources()
  assert.ok(files.length >= 8, `scanned: ${files.join(', ')}`)
  const found = files.flatMap(file => rawJoins(file, readFileSync(join(ROOT, file), 'utf8')))
  assert.deepEqual(found, [])
})

test('each path helper of the machine code delegates to idPath', () => {
  const text = readFileSync(join(ROOT, 'shared', 'hooks', 'machine.ts'), 'utf8')
  const helpers = { claimPath: 'claim', slotRecordPath: 'slotRecord', slotBeaconPath: 'slotBeacon', gatePath: 'gate', panePath: 'pane', paneTicketPath: 'paneTicket', leftPath: 'left', pokePath: 'poke', wakePath: 'wake', pendingPath: 'pending', selfcheckPath: 'selfcheck', windowScriptPath: 'window' }
  for (const [name, file] of Object.entries(helpers)) {
    const line = text.split(/\r?\n/).find(l => l.startsWith(`export const ${name} = `))
    assert.ok(line !== undefined, `${name} is defined`)
    assert.match(line, new RegExp(String.raw`=> idPath(?:OrNone)?\(state, '${file}', \w+\)$`), `${name} goes through idPath`)
  }
})

test('planted: a call site joining a raw id is found, in each shape, on one line or over several', () => {
  const text = readFileSync(join(ROOT, 'plugins', 'self-switch', 'hooks', 'register.ts'), 'utf8')
  assert.deepEqual(rawJoins('register.ts', text), [])
  const plants = [
    '  const lock = `${state}\\\\claims\\\\${id}.lock`',
    "  const record = state + '\\\\left\\\\' + id + '.json'",
    "  const marker = join(state, 'wake', `${id}.json`)",
    '  const ticket = `${state}\\\\panes\\\\${token}.next.json`',
    // S1-13: an array joined, and a join split over lines.
    "  const left = [state, 'left', `${id}.json`].join('\\\\')",
    "  const slot = [\n    state,\n    'slots',\n    `${id}.next.json`,\n  ].join('\\\\')",
    "  const poke = join(\n    state,\n    'poke',\n    `${id}.json`,\n  )",
  ]
  for (const plant of plants) {
    const faulty = text.replace(/\n/, `\n${plant}\n`)
    assert.equal(rawJoins('register.ts', faulty).length, 1, `not found: ${plant}`)
  }
  // The scripts' own PowerShell joins of a checked variable are not TS values.
  assert.deepEqual(rawJoins('x.ts', `    '$claimPath = Join-Path $state ("claims\\\\" + $take + ".lock")',`), [])
  // A kind or a verdict spelled as a folder is no path: `kind: 'wake'`, `e.source === 'left'`, idPath's own key.
  assert.deepEqual(rawJoins('x.ts', "  found.push({ kind: 'wake', what })\n  if (e.source === 'left') x()\n  const p = idPath(state, 'left', id)\n"), [])
})
