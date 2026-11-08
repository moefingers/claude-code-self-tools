// What ships names no one and no machine (S3 on): the plugins' code, scripts, manifests, types and READMEs, the
// shared code, the tools and the repository's README hold no person's name, no machine's own path and no email.
// Examples use placeholders (C:\path\to\work, "the owner"). The CHANGELOG is history and is left as it was written;
// tests are fixtures. Run with `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'
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
