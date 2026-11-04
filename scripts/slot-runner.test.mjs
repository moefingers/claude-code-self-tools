// The slot runner, plugins/self-switch/slot/claude-slot.ps1, read as text: what it checks before it
// resumes a conversation, and that the hash the plugins compare it with is its own. Run with
// `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { ROOT } from './sync-shared.mjs'

const PATH = join(ROOT, 'plugins', 'self-switch', 'slot', 'claude-slot.ps1')
const bytes = readFileSync(PATH)
const script = bytes.toString('utf8')
const machine = await import(pathToFileURL(join(ROOT, 'shared', 'hooks', 'machine.ts')).href)

test("the hash the plugins check is the runner's own, and the runner is plain ASCII with LF line ends", () => {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), machine.SLOT_SCRIPT_SHA256)
  assert.ok(bytes.every(b => b < 128), 'Windows PowerShell 5.1 reads a file without a BOM as ANSI: keep it ASCII')
  assert.ok(!bytes.includes(13), 'committed with LF line ends (.gitattributes), so the hash is of that')
})

test('a record is honoured only when it is a UUID, at most 120 seconds old, of an existing folder, and the claim names this slot', () => {
  assert.ok(script.includes(`$SessionId = '${machine.SESSION_ID.source}'`))
  assert.ok(script.includes('$record.resume -cnotmatch $SessionId'))
  assert.ok(script.includes('$MaxAgeMs = 120000'))
  assert.ok(script.includes('($now - [double]$record.at) -gt $MaxAgeMs'))
  assert.ok(script.includes('return (Test-Path -LiteralPath $path -PathType Container)'))
  assert.ok(script.includes('$lock.by -cne (\'slot:\' + $slotId)'))
  // Its id: its own process id and creation time, as the probe reads it from its child's parent.
  assert.ok(script.includes("$slotId = '{0}-{1}' -f $PID, $me.CreationDate.ToFileTimeUtc()"))
})

test('right before claude runs, it reads the registry and the process table again: the same lines as the window', () => {
  const at = script.indexOf('function Get-Live')
  assert.ok(at > 0)
  for (const line of machine.RECHECK) assert.ok(script.includes(`  ${line}\n`), `missing from the slot runner's re-check: ${line}`)
  // Called in the record's checks, inside a catch that resumes nothing when they can't be read.
  assert.ok(script.includes("try { $live = Get-Live $record.resume $dirs } catch { $live = 'the registry or the process table could not be read ("))
})

test('the record is deleted before anything is checked or run', () => {
  const read = script.indexOf('$text = Get-Content -LiteralPath $recordPath')
  const deleted = script.indexOf('[IO.File]::Delete($recordPath)')
  const checked = script.indexOf("$why = 'it names no conversation by its id'")
  const resumed = script.indexOf("Start-Claude @('--resume', $next.resume)")
  assert.ok(read > 0 && read < deleted && deleted < checked && checked < resumed)
  // In a finally: a record that can't be read is gone all the same.
  assert.ok(script.lastIndexOf('} finally {', deleted) > read)
})

test('it runs claude with no flag but --resume, clears the markers first, and never a permission flag', () => {
  for (const flag of ['--permission-mode', '--dangerously-skip-permissions', 'bypassPermissions', '--allow-dangerously', 'acceptEdits']) {
    assert.ok(!script.includes(flag), `the slot runner names ${flag}`)
  }
  const runs = script.split('\n').filter(line => /Start-Claude @\(/.test(line))
  assert.deepEqual(runs.map(line => line.trim()), ['Start-Claude @()', "Start-Claude @('--resume', $next.resume)", 'if ($enter) { Start-Claude @() }'])
  assert.ok(script.includes('& $claude.Source @arguments'))
  assert.ok(script.includes(`$Markers = ${machine.SESSION_MARKERS.map(name => `'${name}'`).join(', ')}`))
  assert.ok(script.indexOf('SetEnvironmentVariable($name, $null') < script.indexOf('& $claude.Source @arguments'))
})

test('with no record it waits, looking for one every 2 seconds, and Enter starts claude', () => {
  assert.ok(script.includes('for ($i = 0; $i -lt 10 -and -not $enter; $i++) {'))
  assert.ok(script.includes('Start-Sleep -Milliseconds 200'))
  assert.ok(script.includes("if ([Console]::ReadKey($true).Key -eq 'Enter') { $enter = $true }"))
  assert.ok(script.includes("Write-Host 'Claude Code ended. Enter starts a new session here; Ctrl+C leaves this slot.'"))
})
