// The plugins' copies of the shared code are byte for byte the shared files, so they can't drift.
// Run with `node --test scripts`; `node scripts/sync-shared.mjs` rewrites any that differ.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copies, plugins } from './sync-shared.mjs'

test('every plugin has every shared file, unchanged', () => {
  const all = copies()
  assert.ok(plugins().length >= 6, `found plugins: ${plugins().join(', ')}`)
  assert.ok(all.length >= 12, `found copies: ${all.length}`)
  const differ = all.filter(c => !c.isSame).map(c => `plugins/${c.plugin}/${c.file}`)
  assert.deepEqual(differ, [], 'run `node scripts/sync-shared.mjs`, then commit the copies')
})
