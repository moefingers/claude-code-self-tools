// lanesUpdateScript (lanes.json, D65), run for real on Windows in temporary folders only: two writers
// at once both land (a slow writer, stood in for by a copy of the script that sleeps between its read
// and its write, holds the lock while a second waits); a lock file another left behind is opened, not
// waited out; a lanes.json not of its shape is left as it is. Then the lock removed, planted in copies
// of the script: an entry is lost. The file it writes reads back through readLanes, and through
// claude-launch.ps1 -Lane (scripts/claude-launch.test.mjs). Run with `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { ROOT } from './sync-shared.mjs'

const machine = await import(pathToFileURL(join(ROOT, 'shared', 'hooks', 'machine.ts')).href)
const isWindows = process.platform === 'win32'
const POWERSHELL = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

let work

before(() => {
  if (isWindows) work = mkdtempSync(join(tmpdir(), 'lanes-test-'))
})

after(() => {
  if (work !== undefined) rmSync(work, { recursive: true, force: true })
})

/** One script run as the plugins run it: powershellCall, the script on standard input. */
function run(script) {
  const call = machine.powershellCall(POWERSHELL, script)
  return new Promise(resolve => {
    const child = spawn(call.argv[0], call.argv.slice(1), { windowsHide: true, env: { ...process.env, LOCALAPPDATA: join(work, 'local'), USERPROFILE: join(work, 'home') } })
    let stdout = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stdout += chunk))
    const timer = setTimeout(() => child.kill(), 60_000)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout })
    })
    child.stdin.end(call.stdin)
  })
}

/** A config folder of its own, and a work folder for the entries. */
function lab() {
  const root = mkdtempSync(join(work, 'run-'))
  const config = join(root, 'config')
  const folder = join(root, 'work')
  mkdirSync(config, { recursive: true })
  mkdirSync(folder, { recursive: true })
  return { config, folder }
}

const entry = folder => ({ session: randomUUID(), folder, ws: 'default', at: Date.now() })

/** The script, slowed: it sleeps between its read and its write, so a second writer comes while it holds the lock. */
const slowed = script => {
  const anchor = '  $lanes[$name] = $entryText | ConvertFrom-Json'
  assert.ok(script.includes(anchor))
  return script.split(anchor).join(`  Start-Sleep -Milliseconds 2500\r\n${anchor}`)
}

/** The lock removed: no handle held, nothing waited for. */
const unlocked = script => {
  const anchor = '  try { $lock = [IO.FileStream]::new($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose) }'
  assert.ok(script.includes(anchor))
  return script.split(anchor).join('  try { $lock = [IO.MemoryStream]::new() }')
}

/** Two writers, the second starting while the first (slowed) is between its read and its write. */
async function both(dirs, change = s => s) {
  const one = entry(dirs.folder)
  const two = entry(dirs.folder)
  const first = run(change(slowed(machine.lanesUpdateScript({ configDir: dirs.config, name: 'first-lane', entry: one }))))
  await new Promise(resolve => setTimeout(resolve, 1200))
  const second = run(change(machine.lanesUpdateScript({ configDir: dirs.config, name: 'second-lane', entry: two })))
  const answers = await Promise.all([first, second])
  return { answers, one, two }
}

describe('lanes.json, written for real', { skip: !isWindows && 'Windows only', concurrency: false }, () => {
  test('one entry: written whole, read back by readLanes; a second for the same name replaces it, the rest kept', async () => {
    const dirs = lab()
    const a = entry(dirs.folder)
    const b = entry(dirs.folder)
    assert.match((await run(machine.lanesUpdateScript({ configDir: dirs.config, name: 'dealerwrap', entry: a }))).stdout, /^lanes dealerwrap\s*$/m)
    assert.match((await run(machine.lanesUpdateScript({ configDir: dirs.config, name: 'ui-general', entry: b }))).stdout, /^lanes ui-general\s*$/m)
    const c = entry(dirs.folder)
    await run(machine.lanesUpdateScript({ configDir: dirs.config, name: 'dealerwrap', entry: c }))
    const read = machine.readLanes(readFileSync(machine.lanesPath(dirs.config), 'utf8'))
    assert.ok(!('error' in read), JSON.stringify(read))
    assert.deepEqual(read.lanes, { dealerwrap: c, 'ui-general': b })
  })

  test('two writers at once both land: the second waits for the lock the first holds', async () => {
    const dirs = lab()
    const { answers, one, two } = await both(dirs)
    for (const answer of answers) assert.equal(answer.code, 0, answer.stdout)
    const read = machine.readLanes(readFileSync(machine.lanesPath(dirs.config), 'utf8'))
    assert.ok(!('error' in read))
    assert.deepEqual(read.lanes, { 'first-lane': one, 'second-lane': two })
  })

  test('a lock file another left behind is opened at once, never waited out', async () => {
    const dirs = lab()
    writeFileSync(`${machine.lanesPath(dirs.config)}.lock`, 'left behind')
    const started = Date.now()
    const answer = await run(machine.lanesUpdateScript({ configDir: dirs.config, name: 'dealerwrap', entry: entry(dirs.folder) }))
    assert.match(answer.stdout, /^lanes dealerwrap\s*$/m)
    assert.ok(Date.now() - started < 8000, 'no stale-lock wait')
  })

  test('a lanes.json not of its shape is left as it is', async () => {
    const dirs = lab()
    writeFileSync(machine.lanesPath(dirs.config), '{"v":2,"lanes":{}}')
    const answer = await run(machine.lanesUpdateScript({ configDir: dirs.config, name: 'dealerwrap', entry: entry(dirs.folder) }))
    assert.match(answer.stdout, /^refused file lanes\.json is not of its shape, so it is left as it is/m)
    assert.equal(readFileSync(machine.lanesPath(dirs.config), 'utf8'), '{"v":2,"lanes":{}}')
  })

  test('planted: the lock removed, two writers at once lose an entry', async () => {
    const dirs = lab()
    const { one, two } = await both(dirs, unlocked)
    const read = machine.readLanes(readFileSync(machine.lanesPath(dirs.config), 'utf8'))
    assert.ok(!('error' in read))
    assert.notDeepEqual(read.lanes, { 'first-lane': one, 'second-lane': two })
  })
})
