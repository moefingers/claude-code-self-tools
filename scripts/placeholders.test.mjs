// What ships names no one and no machine (S3 on): the plugins' code, scripts, manifests, types and READMEs, the
// shared code, the tools and the repository's README hold no person's name, no machine's own path and no email.
// Examples use placeholders (C:\path\to\work, "the owner"). The CHANGELOG is history and is left as it was written;
// tests are fixtures. Run with `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { ROOT } from './sync-shared.mjs'

/** Each file under `dir`, but tests and dot folders. */
function files(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (name.startsWith('.') && name !== '.claude-plugin') return []
    if (name === 'node_modules' || name === 'tests') return []
    if (statSync(path).isDirectory()) return files(path)
    return /\.test\.[a-z]+$/.test(name) ? [] : [path]
  })
}

const SHIPPED = [...files(join(ROOT, 'plugins')), ...files(join(ROOT, 'shared')), ...files(join(ROOT, 'tools')), ...files(join(ROOT, '.claude-plugin')), join(ROOT, 'README.md')]

/** What a shipped file must not hold: a person's name, this machine's folders, a user profile's path, an email. */
const NOT = [
  ['the owner, by name', /\bMo\b|\bMo's\b|Mohammad/],
  ['a folder of the machine these were written on', /redundant_local/i],
  ["a user profile's own path", /\b[A-Za-z]:\\{1,2}Users\\{1,2}[A-Za-z]/],
  ['an email address', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}\b/],
]

test('no shipped file names a person, a machine folder, a user profile or an email', () => {
  assert.ok(SHIPPED.length > 50, `the files to scan were found (${SHIPPED.length})`)
  const found = []
  for (const path of SHIPPED) {
    const text = readFileSync(path, 'utf8')
    for (const [what, pattern] of NOT) {
      const at = pattern.exec(text)
      if (at !== null) found.push(`${relative(ROOT, path)}: ${what} (${JSON.stringify(at[0])})`)
    }
  }
  assert.deepEqual(found, [])
})

/** The generic names the shipped presets use for lanes and spare tabs: what a person renames to their own. */
const GENERIC = /^(lane-[a-z]|spare-\d+|overflow-\d+)$/
/** The hyphenated words a sentence that describes the presets may name besides them: the windows. */
const WINDOW = /^claude-\d+$/
/** Its hyphenated words, paths left out (plugins/self-switch/slot/... names a folder, not a lane). */
const names = text => text.replace(/[\w.-]*\/[\w./-]*/g, ' ').match(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g) ?? []

test('the shipped presets name generic lanes only, and what describes them names only those', async () => {
  const example = JSON.parse(readFileSync(join(ROOT, 'plugins', 'self-switch', 'slot', 'placement.example.json'), 'utf8'))
  const tabs = example.layout.flatMap(w => w.tabs ?? [])
  assert.ok(tabs.length > 0)
  assert.deepEqual(tabs.filter(t => !GENERIC.test(t)), [], 'placement.example.json: a tab that is no generic lane')
  const seed = await import(pathToFileURL(join(ROOT, 'tools', 'lanes-seed', 'lanes-seed.mjs')).href)
  assert.deepEqual(Object.keys(seed.HOMES).filter(name => !GENERIC.test(name)), [], "lanes-seed's homes: a lane that is no generic one")
  const known = new Set(tabs)
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8').split('\n').find(line => line.includes('placement.example.json') && line.includes('presets')) ?? ''
  const layout = readFileSync(join(ROOT, 'plugins', 'self-switch', 'slot', 'claude-layout.ps1'), 'utf8')
  const header = layout.slice(layout.indexOf('presets ship as'), layout.indexOf('\n#\n', layout.indexOf('presets ship as')))
  for (const [where, text] of [['README.md', readme.slice(readme.indexOf('presets'))], ['claude-layout.ps1', header]]) {
    assert.ok(text.length > 0, `${where}: the presets are described`)
    assert.deepEqual(names(text).filter(n => !known.has(n) && !WINDOW.test(n)), [], `${where}: names a lane the presets don't`)
  }
})

test("the README's launch() examples name generic lanes only", () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const examples = readme.split('\n').filter(line => /^launch\(\{/.test(line.trim()))
  assert.ok(examples.length > 0, 'the README has launch() examples')
  const named = examples.flatMap(line => [...line.matchAll(/\b(?:name|title): '([^']*)'/g)].map(m => m[1]))
  assert.ok(named.length > 0, 'they name a lane')
  assert.deepEqual(named.filter(n => !GENERIC.test(n)), [])
})

test("a plugin's own tests, which install with it, name no machine folder and no person", () => {
  const tests = readdirSync(join(ROOT, 'plugins')).flatMap(plugin => {
    const dir = join(ROOT, 'plugins', plugin, 'tests')
    try { return readdirSync(dir).map(name => join(dir, name)) } catch { return [] }
  })
  assert.ok(tests.length > 10)
  const found = tests.filter(path => /redundant_local|\bMo\b|Mohammad/i.test(readFileSync(path, 'utf8'))).map(path => relative(ROOT, path))
  assert.deepEqual(found, [])
})

/**
 * Real lane and project names to keep out of what ships, one per line: a local file, gitignored, so the names
 * themselves are never committed. Without it, this part of the scan is skipped, said in the run.
 */
const NAMES_FILE = join(ROOT, 'scripts', 'real-names.local.txt')
/** Text as a name is looked for in it: lowercase, spaces, hyphens and underscores dropped. */
const squash = text => text.toLowerCase().replace(/[\s_-]+/g, '')
/** The user names a test's profile path may give: placeholders. */
const PLACEHOLDER_USERS = new Set(['u', 'tester', 'user', 'you', 'me'])
/** An email a test may use: a reserved domain (example.com, .invalid), or a URL's user:password@host. */
const FAKE_EMAIL = /(?:^|\.)(?:example\.(?:com|org|net)|[a-z0-9-]+\.invalid)$/i

test("a plugin's own tests name no real lane, no email, and no user profile's path", t => {
  const tests = readdirSync(join(ROOT, 'plugins')).flatMap(plugin => {
    const dir = join(ROOT, 'plugins', plugin, 'tests')
    try { return readdirSync(dir).map(name => join(dir, name)) } catch { return [] }
  })
  const names = existsSync(NAMES_FILE) ? readFileSync(NAMES_FILE, 'utf8').split(/\r?\n/).map(squash).filter(n => n.length >= 4) : []
  if (names.length === 0) t.diagnostic(`no ${relative(ROOT, NAMES_FILE)}: the real-name part of this scan is skipped`)
  const found = []
  for (const path of tests) {
    const text = readFileSync(path, 'utf8')
    const where = relative(ROOT, path)
    const flat = squash(text)
    for (const name of names) if (flat.includes(name)) found.push(`${where}: a real lane's name`)
    for (const m of text.matchAll(/([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)) {
      const before = text[(m.index ?? 0) - 1] ?? ''
      if (FAKE_EMAIL.test(m[2] ?? '') || /:\/\/[^\s'"]*$/.test(text.slice(Math.max(0, (m.index ?? 0) - 40), m.index)) || before === ':') continue
      found.push(`${where}: an email (${m[0]})`)
    }
    // A profile path names a placeholder user (u, tester, user), never a real one.
    for (const m of text.matchAll(/\b[A-Za-z]:\\{1,2}Users\\{1,2}([A-Za-z0-9._-]+)/g)) if (!PLACEHOLDER_USERS.has((m[1] ?? '').toLowerCase())) found.push(`${where}: a user profile's path (${m[0]})`)
  }
  assert.deepEqual(found, [])
})
