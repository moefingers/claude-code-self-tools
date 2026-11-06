// The Remote Control lock's two canonical scripts (plugins/self-remote-control/hooks/rc-lock.ts): that
// the hashes the plugins pin are theirs, and, on Windows, that they hold under real races: two
// takers on a stale lock, and a slow release against another's takeover. Run with
// `node --test "scripts/*.test.mjs"`. Each live test starts Windows PowerShell processes in a
// temporary folder of its own; nothing else is touched.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { ROOT } from './sync-shared.mjs'

const lock = await import(pathToFileURL(join(ROOT, 'plugins', 'self-remote-control', 'hooks', 'rc-lock.ts')).href)
const isWindows = process.platform === 'win32'
const POWERSHELL = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
const ENCODED = Buffer.from(lock.STDIN_BOOTSTRAP, 'utf16le').toString('base64')

/** One script run as the plugins run it: PowerShell, the bootstrap, the script on standard input. */
function run(script, path, text) {
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED], {
      env: { ...process.env, RC_LOCK_PATH: path, RC_LOCK_TEXT: text },
      windowsHide: true,
    })
    let out = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}: ${out}`))))
    child.stdin.end(script)
  })
}

const text = (by, at) => JSON.stringify({ v: 1, by, at })

/** A fresh lock path in a temporary folder, and its cleanup. */
function place(t) {
  const root = mkdtempSync(join(tmpdir(), 'rc-lock-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'rc'))
  return join(root, 'rc', '00000000-0000-4000-8000-000000000001.lock')
}

test('the hashes the plugins pin are the scripts\' own, and the scripts are ASCII with LF line ends', () => {
  for (const [script, sha] of [
    [lock.TAKE_SCRIPT, lock.TAKE_SHA256],
    [lock.RELEASE_SCRIPT, lock.RELEASE_SHA256],
  ]) {
    const bytes = Buffer.from(script, 'utf8')
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha)
    assert.ok(bytes.every(b => b < 128), 'Windows PowerShell reads its standard input as UTF-8 here, but keep it ASCII')
    assert.ok(!bytes.includes(13), 'LF line ends: the hash is of these bytes')
  }
  assert.ok(lock.TAKE_SCRIPT.startsWith('# claude-self-tools rc-lock take, v1'))
  assert.ok(lock.RELEASE_SCRIPT.startsWith('# claude-self-tools rc-lock release, v1'))
})

test('two takers racing on a stale lock: exactly one takes it, every time', { skip: !isWindows && 'Windows PowerShell only' }, async t => {
  const path = place(t)
  for (let i = 0; i < 20; i += 1) {
    writeFileSync(path, text('crashed', Date.now() - 5 * 60_000))
    const takers = ['alpha', 'beta'].map(by => text(by, Date.now()))
    const answers = await Promise.all(takers.map(mine => run(lock.TAKE_SCRIPT, path, mine)))
    const won = answers.filter(a => a === 'taken')
    assert.equal(won.length, 1, `round ${i}: ${answers.join(', ')}`)
    assert.equal(readFileSync(path, 'utf8'), takers[answers.indexOf('taken')], `round ${i}: the file holds the winner's text`)
    assert.ok(answers.every(a => a === 'taken' || a.startsWith('held|')), `round ${i}: ${answers.join(', ')}`)
  }
})

test('four takers racing on a stale lock, and on no lock at all: exactly one takes it', { skip: !isWindows && 'Windows PowerShell only' }, async t => {
  const path = place(t)
  for (let i = 0; i < 8; i += 1) {
    if (i % 2 === 0) writeFileSync(path, text('crashed', Date.now() - 5 * 60_000))
    else rmSync(path, { force: true })
    const takers = ['a', 'b', 'c', 'd'].map(by => text(by, Date.now()))
    const answers = await Promise.all(takers.map(mine => run(lock.TAKE_SCRIPT, path, mine)))
    assert.equal(answers.filter(a => a === 'taken').length, 1, `round ${i}: ${answers.join(', ')}`)
    assert.equal(readFileSync(path, 'utf8'), takers[answers.indexOf('taken')])
  }
})

test('with the judging window widened to 400 ms, so the two takers surely overlap, still exactly one takes it', { skip: !isWindows && 'Windows PowerShell only' }, async t => {
  // A test-only variant: the canonical script with a pause between judging the stale lock and
  // overwriting it. The takeover handle shares nothing, so the second taker can't even open it.
  const judged = '      $age = $nowMs - $at\n'
  const widened = lock.TAKE_SCRIPT.replace(judged, `${judged}      Start-Sleep -Milliseconds 400\n`)
  assert.notEqual(widened, lock.TAKE_SCRIPT)
  const path = place(t)
  for (let i = 0; i < 6; i += 1) {
    writeFileSync(path, text('crashed', Date.now() - 5 * 60_000))
    const takers = ['alpha', 'beta'].map(by => text(by, Date.now()))
    const answers = await Promise.all(takers.map(mine => run(widened, path, mine)))
    assert.equal(answers.filter(a => a === 'taken').length, 1, `round ${i}: ${answers.join(', ')}`)
    assert.equal(readFileSync(path, 'utf8'), takers[answers.indexOf('taken')])
  }
})

test("a slow release can't delete the lock another took over", { skip: !isWindows && 'Windows PowerShell only' }, async t => {
  const path = place(t)
  // In turn: the first holder overran (its lock is stale), the second took it over, then the
  // first's release ran late.
  const first = text('slow', Date.now() - 2 * 60_000)
  writeFileSync(path, first)
  const second = text('second', Date.now())
  assert.equal(await run(lock.TAKE_SCRIPT, path, second), 'taken')
  assert.equal(await run(lock.RELEASE_SCRIPT, path, first), 'kept')
  assert.equal(readFileSync(path, 'utf8'), second)
  // Its own release does delete it; a second one finds nothing.
  assert.equal(await run(lock.RELEASE_SCRIPT, path, second), 'released')
  assert.ok(!existsSync(path))
  assert.equal(await run(lock.RELEASE_SCRIPT, path, second), 'gone')

  // At once, many times: whenever the takeover says taken, the lock is there and is the taker's.
  for (let i = 0; i < 12; i += 1) {
    const late = text('slow', Date.now() - 2 * 60_000)
    writeFileSync(path, late)
    const mine = text('second', Date.now())
    const [took, released] = await Promise.all([run(lock.TAKE_SCRIPT, path, mine), run(lock.RELEASE_SCRIPT, path, late)])
    if (took === 'taken') assert.equal(readFileSync(path, 'utf8'), mine, `round ${i}: ${took}, ${released}`)
    else assert.ok(!existsSync(path) || readFileSync(path, 'utf8') !== mine, `round ${i}: ${took}, ${released}`)
    rmSync(path, { force: true })
  }
})

test('a fresh lock is held, its holder and age said; one far in the future is stale', { skip: !isWindows && 'Windows PowerShell only' }, async t => {
  const path = place(t)
  writeFileSync(path, text('coordinator', Date.now() - 5000))
  const answer = await run(lock.TAKE_SCRIPT, path, text('self-remote-control', Date.now()))
  assert.match(answer, /^held\|coordinator\|\d+$/)
  writeFileSync(path, text('clock-skew', Date.now() + 10 * 60_000))
  const mine = text('self-remote-control', Date.now())
  assert.equal(await run(lock.TAKE_SCRIPT, path, mine), 'taken')
  assert.equal(readFileSync(path, 'utf8'), mine)
})
