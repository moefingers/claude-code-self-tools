// lanesUpdateScript (lanes.json, D65), run for real on Windows in temporary folders only: two writers
// at once both land (the first, a copy of the script that marks a file once it has read and then waits
// for the test, holds the lock while the second waits: no head start to win by luck); a lock file
// another left behind is opened, not waited out; a lanes.json not of its shape is left as it is, saying
// how to start again; names are merged exactly. Then faults planted in copies of the script, each
// caught: the lock removed (an entry is lost), and the Replace swapped for a write in place (a reader
// sees a torn file). The file it writes reads back through readLanes, and through
// claude-launch.ps1 -Lane (scripts/claude-launch.test.mjs). Run with `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  return { root, config, folder }
}

const entry = folder => ({ session: randomUUID(), folder, ws: 'default', at: Date.now() })

/**
 * The script, held between its read and its write: it marks `gate` once it has read (holding the lock,
 * when it has one), then waits for `go`, the test's word that the second writer has run, up to 5 s.
 */
const held = (script, gate, go) => {
  const anchor = '  $lanes[$name] = $entryText | ConvertFrom-Json'
  assert.ok(script.includes(anchor))
  const wait = `  [IO.File]::WriteAllText('${gate}', 'read')\r\n  for ($i = 0; $i -lt 50 -and -not (Test-Path -LiteralPath '${go}'); $i++) { Start-Sleep -Milliseconds 100 }\r\n`
  return script.split(anchor).join(`${wait}${anchor}`)
}

/** Waits for `path` to be there, up to 30 s. */
async function until(path) {
  const end = Date.now() + 30_000
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error(`${path} never came`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** The lock removed: no handle held, nothing waited for. */
const unlocked = script => {
  const anchor = '  try { $lock = [IO.FileStream]::new($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose) }'
  assert.ok(script.includes(anchor))
  return script.split(anchor).join('  try { $lock = [IO.MemoryStream]::new() }')
}

/**
 * Two writers: the second starts only once the first has read (its gate file), and the first writes
 * only once the second has run (the test's go file) or 5 s have passed. With the lock, the second waits
 * for the first throughout; without it, the second writes in between, every time.
 */
async function both(dirs, change = s => s) {
  const one = entry(dirs.folder)
  const two = entry(dirs.folder)
  const gate = join(dirs.root, 'gate')
  const go = join(dirs.root, 'go')
  const first = run(change(held(machine.lanesUpdateScript({ configDir: dirs.config, name: 'first-lane', entry: one }), gate, go)))
  await until(gate)
  const second = await run(change(machine.lanesUpdateScript({ configDir: dirs.config, name: 'second-lane', entry: two })))
  writeFileSync(go, 'go')
  const answers = [await first, second]
  return { answers, one, two }
}

/**
 * The Replace swapped for a write in place, done slowly (half the text, a pause, the rest), and the
 * real script's own temporary file written just as slowly: what a reader polling the file sees while it
 * is written. Each read that is not JSON of lanes.json's shape is a torn file.
 */
async function torn(dirs, change) {
  const slow = '  $half = [int]($text.Length / 2); $stream = [IO.File]::Open($temp, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite); $bytes = [Text.Encoding]::UTF8.GetBytes($text); $stream.Write($bytes, 0, $half); $stream.Flush(); Start-Sleep -Milliseconds 1500; $stream.Write($bytes, $half, $bytes.Length - $half); $stream.Dispose()'
  const anchor = '  [IO.File]::WriteAllText($temp, $text)'
  const script = machine.lanesUpdateScript({ configDir: dirs.config, name: 'second-lane', entry: entry(dirs.folder) })
  assert.ok(script.includes(anchor))
  const written = change(script.split(anchor).join(slow))
  const path = machine.lanesPath(dirs.config)
  const reads = { whole: 0, torn: 0 }
  let done = false
  const polling = (async () => {
    while (!done) {
      try {
        const read = machine.readLanes(readFileSync(path, 'utf8'))
        if ('error' in read) reads.torn += 1
        else reads.whole += 1
      } catch {
        // Not there for a moment (a Replace), or held: neither is a torn read.
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  })()
  const answer = await run(written)
  done = true
  await polling
  return { answer, reads }
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

  test('a lanes.json not of its shape (another version; two names that differ only in case) is left as it is, saying how to start again (S1-12)', async () => {
    for (const text of ['{"v":2,"lanes":{}}', `{"v":1,"at":1,"lanes":{"Foo":${JSON.stringify(entry(lab().folder))},"foo":${JSON.stringify(entry(lab().folder))}}}`]) {
      const dirs = lab()
      writeFileSync(machine.lanesPath(dirs.config), text)
      const answer = await run(machine.lanesUpdateScript({ configDir: dirs.config, name: 'dealerwrap', entry: entry(dirs.folder) }))
      assert.match(answer.stdout, /^refused file lanes\.json is not of its shape, so it is left as it is: .+ Fix it by hand, or move it aside \(rename it lanes\.json\.bad\), and the next write starts a new one/m)
      assert.equal(readFileSync(machine.lanesPath(dirs.config), 'utf8'), text)
    }
  })

  test('names are merged exactly: a hand-written Foo beside this foo is never folded into it; a name that is not a session\'s is dropped (S1-12)', async () => {
    const dirs = lab()
    const foo = entry(dirs.folder)
    writeFileSync(machine.lanesPath(dirs.config), JSON.stringify({ v: 1, at: 1, lanes: { Foo: entry(dirs.folder), keep: foo } }))
    const mine = entry(dirs.folder)
    assert.match((await run(machine.lanesUpdateScript({ configDir: dirs.config, name: 'foo', entry: mine }))).stdout, /^lanes foo\s*$/m)
    const raw = JSON.parse(readFileSync(machine.lanesPath(dirs.config), 'utf8'))
    assert.deepEqual(Object.keys(raw.lanes).sort(), ['foo', 'keep'])
    const read = machine.readLanes(JSON.stringify(raw))
    assert.deepEqual(read.lanes, { foo: mine, keep: foo })
  })

  test('planted: the lock removed, two writers at once lose an entry, every time (the second writes between the first\'s read and write)', async () => {
    const dirs = lab()
    const { one, two } = await both(dirs, unlocked)
    const read = machine.readLanes(readFileSync(machine.lanesPath(dirs.config), 'utf8'))
    assert.ok(!('error' in read))
    assert.deepEqual(read.lanes, { 'first-lane': one })
    assert.notDeepEqual(read.lanes, { 'first-lane': one, 'second-lane': two })
  })

  test('a reader never sees half a file: the write goes to a temporary file, then a Replace (S1-13)', async () => {
    const dirs = lab()
    await run(machine.lanesUpdateScript({ configDir: dirs.config, name: 'first-lane', entry: entry(dirs.folder) }))
    const { answer, reads } = await torn(dirs, s => s)
    assert.match(answer.stdout, /^lanes second-lane\s*$/m)
    assert.equal(reads.torn, 0, JSON.stringify(reads))
    assert.ok(reads.whole > 0, JSON.stringify(reads))
  })

  test('planted: the Replace swapped for a write in place, a reader sees a torn file (S1-13)', async () => {
    const dirs = lab()
    await run(machine.lanesUpdateScript({ configDir: dirs.config, name: 'first-lane', entry: entry(dirs.folder) }))
    const inPlace = s => s.split('$stream = [IO.File]::Open($temp,').join('$temp = $final; $stream = [IO.File]::Open($temp,').split('[IO.File]::Replace($temp, $final, [NullString]::Value)').join('$null').split('[IO.File]::Move($temp, $final)').join('$null')
    const { reads } = await torn(dirs, inPlace)
    assert.ok(reads.torn > 0, JSON.stringify(reads))
  })
})
