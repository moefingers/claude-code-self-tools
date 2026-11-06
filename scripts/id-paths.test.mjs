// Every file named by an id is built by idPath (shared/hooks/machine.ts), which checks the id before
// joining: no plugin's code, and no other line of the machine code, joins one of those folders with a
// value of its own (a template, a `+`, a join call). The PowerShell inside the generated scripts joins
// only its own variables, set from literals of ids checked before they were spliced in, so it is not
// what this scans. Then the fault: a call site joining a raw id, planted in a copy, is found. Run with
// `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { plugins, ROOT } from './sync-shared.mjs'

/** The folders under the state folder whose files are named by an id (ID_FILES). */
const FOLDERS = 'claims|left|poke|wake|pending|selfcheck|gate|panes|slots'

/** The shapes of a join of one of those folders with a value: a template, a `+` of a TS value, a join call. */
const JOINS = [
  // `${state}\\claims\\${id}.lock`
  new RegExp(String.raw`\b(?:${FOLDERS})\\\\\$\{`),
  // state + '\\claims\\' + id   (a PowerShell `+ $id` inside a script is not a TS value)
  new RegExp(String.raw`\b(?:${FOLDERS})\\\\['"\x60]\s*\+\s*[A-Za-z_(]`),
  // join(state, 'claims', id) or join(state, 'claims', `${id}.lock`)
  new RegExp(String.raw`\bjoin\s*\([^)]*['"\x60](?:${FOLDERS})['"\x60]\s*,`),
]

/** Every line of `text` that joins an id folder with a value outside idPath, as `<file>:<line>: <text>`. */
function rawJoins(file, text) {
  const found = []
  const lines = text.split(/\r?\n/)
  // idPath's own body is the one place a folder and an id are joined.
  const start = lines.findIndex(line => /^export function idPath\(/.test(line))
  const end = start === -1 ? -1 : lines.findIndex((line, i) => i > start && line === '}')
  lines.forEach((line, i) => {
    if (i >= start && i <= end && start !== -1) return
    if (/^\s*(?:\/\/|\*|\/\*\*)/.test(line)) return
    if (JOINS.some(re => re.test(line))) found.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`)
  })
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

test('no call site joins an id folder with a value of its own: every such path goes through idPath', () => {
  const files = sources()
  assert.ok(files.length >= 8, `scanned: ${files.join(', ')}`)
  const found = files.flatMap(file => rawJoins(file, readFileSync(join(ROOT, file), 'utf8')))
  assert.deepEqual(found, [])
})

test('each path helper of the machine code delegates to idPath', () => {
  const text = readFileSync(join(ROOT, 'shared', 'hooks', 'machine.ts'), 'utf8')
  const helpers = { claimPath: 'claim', slotRecordPath: 'slotRecord', gatePath: 'gate', panePath: 'pane', paneTicketPath: 'paneTicket', leftPath: 'left', pokePath: 'poke', wakePath: 'wake', pendingPath: 'pending', selfcheckPath: 'selfcheck' }
  for (const [name, file] of Object.entries(helpers)) {
    const line = text.split(/\r?\n/).find(l => l.startsWith(`export const ${name} = `))
    assert.ok(line !== undefined, `${name} is defined`)
    assert.match(line, new RegExp(String.raw`=> idPath(?:OrNone)?\(state, '${file}', \w+\)$`), `${name} goes through idPath`)
  }
})

test('planted: a call site joining a raw id is found, in each shape', () => {
  const text = readFileSync(join(ROOT, 'plugins', 'self-switch', 'hooks', 'register.ts'), 'utf8')
  assert.deepEqual(rawJoins('register.ts', text), [])
  const plants = [
    '  const lock = `${state}\\\\claims\\\\${id}.lock`',
    "  const record = state + '\\\\left\\\\' + id + '.json'",
    "  const marker = join(state, 'wake', `${id}.json`)",
    '  const ticket = `${state}\\\\panes\\\\${token}.next.json`',
  ]
  for (const plant of plants) {
    const faulty = text.replace(/\n/, `\n${plant}\n`)
    assert.equal(rawJoins('register.ts', faulty).length, 1, `not found: ${plant}`)
  }
  // The scripts' own PowerShell joins of a checked variable are not TS values.
  assert.deepEqual(rawJoins('x.ts', `    '$claimPath = Join-Path $state ("claims\\\\" + $take + ".lock")',`), [])
})
