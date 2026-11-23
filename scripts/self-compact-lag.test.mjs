// self-compact guards the session id's lag on its own (plugins/self-compact/hooks/moving.ts), since it carries no copy
// of the shared machine and classic code. Its constants restate the shared ones; this holds them equal, so a change to
// the shared lag reaches self-compact too. Run with `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { ROOT } from './sync-shared.mjs'

const load = (...path) => import(pathToFileURL(join(ROOT, ...path)).href)
const classic = await load('shared', 'hooks', 'classic.ts')
const moving = await load('plugins', 'self-compact', 'hooks', 'moving.ts')

test("self-compact's lag constants are the shared ones", () => {
  assert.equal(moving.MOVE_LOOK_FOR_MS, classic.MOVE_LOOK_FOR_MS)
  assert.equal(moving.START_LAG_MS, classic.START_LAG_MS)
  assert.equal(moving.READ_MS, classic.STATE_READ_MS)
})
