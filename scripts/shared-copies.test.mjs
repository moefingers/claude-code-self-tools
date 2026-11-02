// The plugins' copies of the shared code are byte for byte the shared files, and no copy of a file
// since removed from shared/ is left behind, so they can't drift. Run with `node --test "scripts/*.test.mjs"`;
// `node scripts/sync-shared.mjs` rewrites the copies and removes the stale ones.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copies, plugins, stale } from './sync-shared.mjs'

test('every plugin has every shared file, unchanged', () => {
  const all = copies()
  assert.ok(plugins().length >= 6, `found plugins: ${plugins().join(', ')}`)
  assert.ok(all.length >= 12, `found copies: ${all.length}`)
  const differ = all.filter(c => !c.isSame).map(c => `plugins/${c.plugin}/${c.file}`)
  assert.deepEqual(differ, [], 'run `node scripts/sync-shared.mjs`, then commit the copies')
})

test('no plugin keeps a copy of a file that is not in shared/', () => {
  const left = stale().map(c => `plugins/${c.plugin}/${c.file}`)
  assert.deepEqual(left, [], 'run `node scripts/sync-shared.mjs` to remove them, then commit')
})
