// The plugins' copies of the shared code are byte for byte the shared files, and no copy of a file
// since removed from shared/, or kept from a plugin its `Copies:` line leaves out, is left behind,
// so they can't drift. Run with `node --test "scripts/*.test.mjs"`; `node scripts/sync-shared.mjs`
// rewrites the copies and removes the stale ones.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { copies, copiesOf, plugins, stale } from './sync-shared.mjs'

test('every plugin has every shared file meant for it, unchanged', () => {
  const all = copies()
  assert.ok(plugins().length >= 6, `found plugins: ${plugins().join(', ')}`)
  assert.ok(all.length >= 12, `found copies: ${all.length}`)
  assert.deepEqual(
    all.filter(c => !c.isPlugin).map(c => `${c.file} -> ${c.plugin}`),
    [],
    'a Copies: line names a plugin that is not in plugins/',
  )
  const differ = all.filter(c => !c.isSame).map(c => `plugins/${c.plugin}/${c.file}`)
  assert.deepEqual(differ, [], 'run `node scripts/sync-shared.mjs`, then commit the copies')
})

test('no plugin keeps a copy of a file that is not in shared/, or not meant for it', () => {
  const left = stale().map(c => `plugins/${c.plugin}/${c.file}`)
  assert.deepEqual(left, [], 'run `node scripts/sync-shared.mjs` to remove them, then commit')
})

test('a Copies: line limits a file to the plugins it names; without one, a file goes to every plugin', () => {
  assert.equal(copiesOf('// Canonical copy: shared/hooks/x.ts.\n// nothing else\n'), undefined)
  assert.deepEqual(copiesOf('// Canonical copy: shared/hooks/x.ts.\n// Copies: self-restart, self-switch\nexport {}\n'), ['self-restart', 'self-switch'])
  assert.deepEqual(copiesOf('# Copies: self-exit.\r\n'), ['self-exit'])
  // Only a line of its own: a mention inside a sentence limits nothing.
  assert.equal(copiesOf('// the Copies: line names plugins\n'), undefined)

  const root = mkdtempSync(join(tmpdir(), 'shared-copies-'))
  try {
    const put = (path, text) => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    for (const name of ['alpha', 'beta', 'gamma']) put(`plugins/${name}/.claude-plugin/plugin.json`, '{}')
    const everyone = '// Canonical copy: shared/hooks/all.ts.\n'
    const some = '// Canonical copy: shared/hooks/some.ts.\n// Copies: alpha, beta\n'
    put('shared/hooks/all.ts', everyone)
    put('shared/hooks/some.ts', some)
    put('plugins/alpha/hooks/all.ts', everyone)
    put('plugins/alpha/hooks/some.ts', some)
    put('plugins/beta/hooks/all.ts', everyone)
    put('plugins/gamma/hooks/all.ts', everyone)
    // A copy in a plugin the line leaves out is stale.
    put('plugins/gamma/hooks/some.ts', some)

    const wanted = copies(root).map(c => `${c.plugin}:${c.file}:${c.isSame ? 'same' : 'missing'}`)
    assert.deepEqual(wanted, [
      'alpha:hooks/all.ts:same',
      'beta:hooks/all.ts:same',
      'gamma:hooks/all.ts:same',
      'alpha:hooks/some.ts:same',
      'beta:hooks/some.ts:missing',
    ])
    assert.deepEqual(
      stale(root).map(c => `${c.plugin}:${c.file}`),
      ['gamma:hooks/some.ts'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
