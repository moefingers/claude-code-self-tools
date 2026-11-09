// The resume claim's canonical script (plugins/self-remote-control/hooks/claim-script.ts): that the hash the
// plugins pin is its own, and, on Windows, that it holds under real races: claimants at once on one stop, a late
// one, the sweep of old claims, a folder that can't be made, and rc-lock's RELEASE giving a claim back. Run with
// `node --test "scripts/*.test.mjs"`. Each live test starts Windows PowerShell processes in a temporary folder of
// its own; nothing else is touched.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { ROOT } from './sync-shared.mjs'

const claim = await import(pathToFileURL(join(ROOT, 'plugins', 'self-remote-control', 'hooks', 'claim-script.ts')).href)
const lock = await import(pathToFileURL(join(ROOT, 'plugins', 'self-remote-control', 'hooks', 'rc-lock.ts')).href)
const isWindows = process.platform === 'win32'
const POWERSHELL = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
const ENCODED = Buffer.from(lock.STDIN_BOOTSTRAP, 'utf16le').toString('base64')

/** One script run as the plugins run it: PowerShell, the bootstrap, the script on standard input, `env` given. */
function run(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED], { env: { ...process.env, ...env }, windowsHide: true })
    let out = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}: ${out}`))))
    child.stdin.end(script)
  })
}

const SESSION = '00000000-0000-4000-8000-000000000001'
const turn = n => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`
const claimOf = (path, by) => run(claim.CLAIM_SCRIPT, { RESUME_CLAIM_PATH: path, RESUME_CLAIM_TEXT: claim.claimText(by, Date.now()) })

/** A fresh state folder in a temporary folder, and its cleanup: claims go in its resumed\ folder. */
function place(t) {
  const root = mkdtempSync(join(tmpdir(), 'resume-claim-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, path: n => claim.claimPath(root, SESSION, turn(n)).replace('\\claude-self-tools\\', '\\') }
}

test("the hash the plugins pin is the script's own, the script is ASCII with LF line ends, and the file is the spec's", () => {
  const bytes = Buffer.from(claim.CLAIM_SCRIPT, 'utf8')
  assert.equal(createHash('sha256').update(bytes).digest('hex'), claim.CLAIM_SHA256)
  assert.equal(claim.CLAIM_SHA256, '66cae0beaf1d4f9b78ba490606a5c03cf0126faec50cae951f508c6372ca07a9')
  assert.ok(bytes.every(b => b < 128), 'Windows PowerShell reads its standard input as UTF-8 here, but keep it ASCII')
  assert.ok(!bytes.includes(13), 'LF line ends: the hash is of these bytes')
  assert.ok(claim.CLAIM_SCRIPT.startsWith('# claude-self-tools resume-claim, v1'))
  assert.equal(claim.claimPath('C:\\Users\\u\\AppData\\Local\\', SESSION, turn(7)), `C:\\Users\\u\\AppData\\Local\\claude-self-tools\\resumed\\${SESSION}.${turn(7)}.json`)
  assert.equal(claim.claimText('coordinator', 5), '{"v":1,"by":"coordinator","at":5}')
})

test('claimants at once on one stop: exactly one claims it, and the others are told who', { skip: !isWindows && 'Windows PowerShell only' }, async t => {
  const { path } = place(t)
  for (let i = 0; i < 6; i += 1) {
    const at = path(i + 1)
    const names = ['self-remote-control', 'coordinator', 'coordinator:owner', 'self-remote-control']
    const answers = await Promise.all(names.map(by => claimOf(at, by)))
    const won = answers.filter(a => a === 'claimed')
    assert.equal(won.length, 1, `round ${i}: ${answers.join(', ')}`)
    const winner = JSON.parse(readFileSync(at, 'utf8'))
    assert.equal(winner.by, names[answers.indexOf('claimed')], `round ${i}: the file holds the winner's text`)
    for (const answer of answers.filter(a => a !== 'claimed')) assert.match(answer, new RegExp(`^taken\\|${winner.by.replace(/[.:]/g, '\\$&')}\\|\\d+$`), `round ${i}`)
  }
})

test('a later claim of the same stop is taken, naming the first; another stop is claimed afresh', { skip: !isWindows && 'Windows PowerShell only' }, async t => {
  const { path } = place(t)
  assert.equal(await claimOf(path(1), 'coordinator'), 'claimed')
  assert.match(await claimOf(path(1), 'self-remote-control'), /^taken\|coordinator\|\d+$/)
  assert.equal(JSON.parse(readFileSync(path(1), 'utf8')).by, 'coordinator')
  assert.equal(await claimOf(path(2), 'self-remote-control'), 'claimed')
})

test('the sweep: other claims untouched for 7 days go; younger ones, other files and the one given stay', { skip: !isWindows && 'Windows PowerShell only' }, async t => {
  const { path } = place(t)
  const folder = path(1).replace(/\\[^\\]+$/, '')
  mkdirSync(folder, { recursive: true })
  const old = (p, days) => {
    writeFileSync(p, claim.claimText('coordinator', 1))
    const when = new Date(Date.now() - days * 24 * 60 * 60_000)
    utimesSync(p, when, when)
  }
  old(path(2), 8)
  old(path(3), 6)
  old(path(1), 9)
  const note = join(folder, 'note.txt')
  writeFileSync(note, 'not a claim')
  utimesSync(note, new Date(0), new Date(0))
  assert.match(await claimOf(path(1), 'self-remote-control'), /^taken\|coordinator\|1$/)
  assert.ok(!existsSync(path(2)), 'an 8-day-old claim of another stop is swept')
  assert.ok(existsSync(path(3)), 'a 6-day-old one stays')
  assert.ok(existsSync(path(1)), 'the one it was given is never touched')
  assert.ok(existsSync(note), 'only claims are swept')
})

test("a folder that can't be made: error, and no claim", { skip: !isWindows && 'Windows PowerShell only' }, async t => {
  const { root } = place(t)
  // A file where the folder would go.
  writeFileSync(join(root, 'resumed'), 'in the way')
  const answer = await claimOf(join(root, 'resumed', `${SESSION}.${turn(1)}.json`), 'self-remote-control')
  assert.match(answer, /^error\|/)
})

test("rc-lock's RELEASE gives a claim back only with the winner's own text", { skip: !isWindows && 'Windows PowerShell only' }, async t => {
  const { path } = place(t)
  const mine = claim.claimText('self-remote-control', Date.now())
  assert.equal(await run(claim.CLAIM_SCRIPT, { RESUME_CLAIM_PATH: path(1), RESUME_CLAIM_TEXT: mine }), 'claimed')
  assert.equal(await run(lock.RELEASE_SCRIPT, { RC_LOCK_PATH: path(1), RC_LOCK_TEXT: claim.claimText('coordinator', 1) }), 'kept')
  assert.ok(existsSync(path(1)))
  assert.equal(await run(lock.RELEASE_SCRIPT, { RC_LOCK_PATH: path(1), RC_LOCK_TEXT: mine }), 'released')
  assert.ok(!existsSync(path(1)))
  // Given back, the stop can be claimed again: by the owner's Resume, say.
  assert.equal(await claimOf(path(1), 'coordinator:owner'), 'claimed')
})
