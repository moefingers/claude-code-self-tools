// tools/lanes-seed/lanes-seed.mjs, on a CSV built here (generated ids, made-up folders): one entry per
// marked row, by its name, with its home window; each entry one readLanes takes; a bad row and a name
// marked twice left out and said; and it writes nothing (a dry run is all it does). Run with
// `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { ROOT } from './sync-shared.mjs'

const SEED = join(ROOT, 'tools', 'lanes-seed', 'lanes-seed.mjs')
const seed = await import(pathToFileURL(SEED).href)
const machine = await import(pathToFileURL(join(ROOT, 'shared', 'hooks', 'machine.ts')).href)

const ids = Array.from({ length: 5 }, () => randomUUID())
const CSV = [
  'folder_key,folder,session_id,lane,display_name',
  `C--work-repo,C:\\work\\repo,${ids[0]},system-overhaul,"system-overhaul, the merger"`,
  `C--work-repo,C:\\work\\repo,${ids[1]},,an unmarked conversation`,
  `C--work-lab,C:\\work\\lab,${ids[2]},video-lab,"a ""quoted"" title"`,
  `C--work-other,C:\\work\\other,${ids[3]},dealerwrap,dealerwrap`,
  `C--work-bad,C:\\a;b,${ids[4]},bad-folder,x`,
  `C--work-repo,C:\\work\\repo,${randomUUID()},dealerwrap,a second dealerwrap`,
].join('\r\n')

test('one entry per marked row, by its name, its home window where it has one; a bad row and a second mark left out', () => {
  const rows = seed.parseCsv(CSV)
  assert.equal(rows.length, 6)
  assert.equal(rows[0].display_name, 'system-overhaul, the merger')
  assert.equal(rows[2].display_name, 'a "quoted" title')
  const { file, skipped } = seed.propose(rows, { at: 1000 })
  assert.deepEqual(file, {
    v: 1,
    at: 1000,
    lanes: {
      'system-overhaul': { session: ids[0], folder: 'C:\\work\\repo', window: 'claude-1', tab: 'system-overhaul', ws: 'default', at: 1000 },
      'video-lab': { session: ids[2], folder: 'C:\\work\\lab', window: 'claude-2', tab: 'video-lab', ws: 'default', at: 1000 },
      dealerwrap: { session: ids[3], folder: 'C:\\work\\other', tab: 'dealerwrap', ws: 'default', at: 1000 },
    },
  })
  assert.equal(skipped.length, 2)
  assert.match(skipped[0], /^bad-folder: not an entry lanes\.json takes/)
  assert.match(skipped[1], new RegExp(`^dealerwrap: marked twice; kept ${ids[3]}`))
  // Every entry is one readLanes takes.
  assert.deepEqual(machine.readLanes(JSON.stringify(file)), { at: 1000, lanes: file.lanes })
})

test('the homes: Mo\'s defaults, an override, a removal; another workspace', () => {
  assert.deepEqual(seed.HOMES, {
    'agent-coordinator-3000': 'claude-1',
    'system-overhaul': 'claude-1',
    'video-lab': 'claude-2',
    'olivia-work': 'claude-3',
    'ui-general': 'claude-3',
    'package-bumper': 'claude-3',
  })
  const args = seed.parseArgs(['--csv', 'x.csv', '--home', 'dealerwrap=claude-4', '--home', 'video-lab=', '--ws', 'w_abcdef012345'])
  const { file } = seed.propose(seed.parseCsv(CSV), { ws: args.ws, homes: args.homes, at: 1 })
  assert.equal(file.lanes.dealerwrap.window, 'claude-4')
  assert.equal(file.lanes['video-lab'].window, undefined)
  assert.equal(file.lanes.dealerwrap.ws, 'w_abcdef012345')
  assert.throws(() => seed.parseArgs([]), /--csv/)
  assert.throws(() => seed.parseArgs(['--csv', 'x', '--write']), /not an argument/)
})

/** The command's environment: a home of its own, and not under the test runner (NODE_TEST_CONTEXT would keep it from running as a command). */
function commandEnv(home) {
  const env = { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') }
  delete env.NODE_TEST_CONTEXT
  return env
}

test('it only prints: run as a command, it writes no file anywhere', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lanes-seed-'))
  try {
    const csv = join(dir, 'inventory.csv')
    writeFileSync(csv, CSV)
    const home = join(dir, 'home')
    const run = spawnSync(process.execPath, [SEED, '--csv', csv, '--at', '5'], { encoding: 'utf8', cwd: dir, env: commandEnv(home) })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(JSON.parse(run.stdout).lanes['system-overhaul'].session, ids[0])
    assert.match(run.stderr, /left out: bad-folder/)
    assert.deepEqual(readdirSync(dir), ['inventory.csv'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
