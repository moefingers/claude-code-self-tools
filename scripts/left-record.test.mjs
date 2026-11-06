// The left record's two scripts, run for real on Windows against temporary folders only: leftScript
// writes a record under a key it finds in place (a canary, built here at run time) and never replaces
// that key (LR14); leftReadScript checks the record's MAC inside the script and says only whether it
// matched; a record changed on disk no longer matches (LR1); and the canary never reaches any output,
// the record or an error (LR13). leftScript finds the claude.exe it runs under by walking up its
// parents: run outside a Claude Code session, the live tests skip. Run with
// `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
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
  if (isWindows) work = mkdtempSync(join(tmpdir(), 'left-record-test-'))
})

after(() => {
  if (work !== undefined) rmSync(work, { recursive: true, force: true })
})

/** One script run as the plugins run it: powershellCall, the script on standard input. Output and errors both kept. */
function run(script) {
  const call = machine.powershellCall(POWERSHELL, script)
  return new Promise(resolve => {
    const child = spawn(call.argv[0], call.argv.slice(1), { windowsHide: true, env: { ...process.env, LOCALAPPDATA: join(work, 'local'), USERPROFILE: join(work, 'home') } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    const timer = setTimeout(() => child.kill(), 60_000)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(call.stdin)
  })
}

/** A state folder, a config folder with conversation `id`'s transcript, and the canary key in place. */
function lab() {
  const root = mkdtempSync(join(work, 'run-'))
  const state = join(root, 'state')
  const config = join(root, 'config')
  const id = randomUUID()
  const project = machine.projectName(join(root, 'work'))
  mkdirSync(join(config, 'projects', project), { recursive: true })
  writeFileSync(join(config, 'projects', project, `${id}.jsonl`), '{"type":"user"}\n')
  mkdirSync(state, { recursive: true })
  // The canary: 32 random bytes, made now, so no test file ever holds a key.
  const key = randomBytes(32)
  writeFileSync(join(state, 'left.key'), key)
  return { root, state, config, id, project, key }
}

/** Every way the canary could be written out: hex either case, base64, the bytes as decimals. */
const canaryForms = key => [key.toString('hex'), key.toString('hex').toUpperCase(), key.toString('base64'), [...key].join(' '), [...key].join(','), [...key].map(b => b.toString(16).padStart(2, '0')).join('-').toUpperCase()]

describe('the left record, written and read for real', { skip: !isWindows && 'Windows only', concurrency: false }, () => {
  test('written under the key in place, which it never replaces (LR14); read back with its MAC matched; the key nowhere in any output (LR13)', async t => {
    const dirs = lab()
    const write = await run(machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'exit', configDirs: [dirs.config], by: 'self-switch' }))
    if (write.stdout.includes('refused session')) return t.skip('no claude.exe above this test: run it under a Claude Code session')
    assert.equal(write.code, 0, write.stderr)
    assert.equal(machine.LEFT_WRITTEN.exec(write.stdout)?.[1], dirs.id, write.stdout)
    // The key is the canary still: CreateNew found it there and left it.
    assert.deepEqual(readFileSync(join(dirs.state, 'left.key')), dirs.key)
    const recordText = readFileSync(join(dirs.state, 'left', `${dirs.id}.json`), 'utf8')
    const record = JSON.parse(recordText)
    assert.equal(record.v, 1)
    assert.equal(record.id, dirs.id)
    assert.equal(record.how, 'exit')
    assert.equal(record.by, 'self-switch')
    assert.equal(record.transcript.dir, dirs.config)
    assert.equal(record.transcript.project, dirs.project)
    assert.equal(record.transcript.size, String('{"type":"user"}\n'.length))
    assert.match(record.mac, /^[0-9a-f]{64}$/)

    const read = await run(machine.leftReadScript({ stateDir: dirs.state, ids: [dirs.id], configDirs: [dirs.config] }))
    assert.equal(read.code, 0, read.stderr)
    const parsed = machine.parseLeftRead(read.stdout)
    assert.ok(!('error' in parsed), JSON.stringify(parsed))
    assert.equal(parsed.unreadable, false)
    assert.equal(parsed.left.length, 1)
    const [entry] = parsed.left
    assert.equal(entry.ok, true)
    assert.equal(entry.macOk, true)
    assert.equal(entry.id, dirs.id)
    assert.equal(entry.transcript.dir, 0)
    assert.equal(entry.transcript.size, '{"type":"user"}\n'.length)

    for (const form of canaryForms(dirs.key)) {
      for (const [name, text] of [['the writer\'s output', write.stdout + write.stderr], ['the reader\'s output', read.stdout + read.stderr], ['the record', recordText]]) {
        assert.ok(!text.includes(form), `the canary key reached ${name}`)
      }
    }

    // A second record: the key stays the canary (LR14, a second creation never replaces it).
    const again = await run(machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'in-place', configDirs: [dirs.config], by: 'self-switch' }))
    assert.equal(again.code, 0, again.stderr)
    assert.deepEqual(readFileSync(join(dirs.state, 'left.key')), dirs.key)
  })

  test('a record changed on disk no longer matches its MAC (LR1); one under another key neither; no key at all: none matches', async t => {
    const dirs = lab()
    const write = await run(machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'exit', configDirs: [dirs.config], by: 'self-switch' }))
    if (write.stdout.includes('refused session')) return t.skip('no claude.exe above this test: run it under a Claude Code session')
    const path = join(dirs.state, 'left', `${dirs.id}.json`)
    const record = JSON.parse(readFileSync(path, 'utf8'))
    const readOne = async () => {
      const read = await run(machine.leftReadScript({ stateDir: dirs.state, ids: [dirs.id], configDirs: [dirs.config] }))
      const parsed = machine.parseLeftRead(read.stdout)
      assert.ok(!('error' in parsed), JSON.stringify(parsed))
      return parsed.left[0]
    }
    // Its transcript's size made larger: the MAC no longer matches.
    writeFileSync(path, JSON.stringify({ ...record, transcript: { ...record.transcript, size: String(Number(record.transcript.size) + 1) } }))
    assert.equal((await readOne()).macOk, false)
    // Back as written: it matches again.
    writeFileSync(path, JSON.stringify(record))
    assert.equal((await readOne()).macOk, true)
    // Another key in place: it doesn't.
    writeFileSync(join(dirs.state, 'left.key'), randomBytes(32))
    assert.equal((await readOne()).macOk, false)
    // A key of another length: no key, nothing matches.
    writeFileSync(join(dirs.state, 'left.key'), randomBytes(16))
    assert.equal((await readOne()).macOk, false)
    // A record not of its shape: reported as such, no field of it.
    writeFileSync(path, JSON.stringify({ ...record, how: 'gone' }))
    assert.deepEqual(await readOne(), { asked: dirs.id, ok: false })
  })

  test('no transcript of it, or two: nothing written', async t => {
    const dirs = lab()
    const second = join(dirs.root, 'config2')
    mkdirSync(join(second, 'projects', 'C--elsewhere'), { recursive: true })
    writeFileSync(join(second, 'projects', 'C--elsewhere', `${dirs.id}.jsonl`), '')
    const two = await run(machine.leftScript({ stateDir: dirs.state, id: dirs.id, how: 'exit', configDirs: [dirs.config, second], by: 'self-switch' }))
    if (two.stdout.includes('refused session')) return t.skip('no claude.exe above this test: run it under a Claude Code session')
    assert.match(two.stdout, /refused transcript 2 transcripts of it are on this machine, not one/)
    assert.ok(!existsSync(join(dirs.state, 'left', `${dirs.id}.json`)))
    const none = await run(machine.leftScript({ stateDir: dirs.state, id: randomUUID(), how: 'exit', configDirs: [dirs.config], by: 'self-switch' }))
    assert.match(none.stdout, /refused transcript 0 transcripts/)
  })
})
