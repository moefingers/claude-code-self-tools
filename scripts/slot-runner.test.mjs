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

test("a record's folder must be its conversation's own: the folder's project holds the conversation's transcript", () => {
  assert.ok(script.includes("$name = $record.folder -replace '[^A-Za-z0-9]', '-'"))
  // Only in the runner's own config folder: never in one the record names, which can't vouch for itself.
  assert.ok(script.includes("$own = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }"))
  const check = "    $inProject = $name.Length -le 200 -and (Test-Path -LiteralPath (Join-Path $own ('projects\\' + $name + '\\' + $record.resume + '.jsonl')) -PathType Leaf)\n"
  assert.ok(script.includes(check))
  assert.equal(script.split('$inProject =').length - 1, 1)
  assert.ok(script.indexOf('$record.configDirs') > script.indexOf(check), "the record's config folders are read only after the project check, for the re-check")
  assert.ok(script.includes("if (-not $inProject) { $why = 'its folder is not that conversation''s own"))
  // Before the claim and the re-check, and so before claude.
  assert.ok(script.indexOf(check) < script.indexOf("$lock.by -cne ('slot:' + $slotId)"))
})

test('the pane\'s -ExecutionPolicy is for the runner alone: it is cleared before claude starts, and the README asks for RemoteSigned', () => {
  const clear = "[Environment]::SetEnvironmentVariable('PSExecutionPolicyPreference', $null, [EnvironmentVariableTarget]::Process)"
  assert.ok(script.includes(clear))
  assert.ok(script.indexOf(clear) < script.indexOf('& $claude.Source @arguments'))
  assert.ok(script.indexOf(clear) > script.indexOf('function Start-Claude'))
  assert.ok(script.includes('-ExecutionPolicy RemoteSigned -File'))
  assert.ok(!script.includes('Bypass'))
  const readme = readFileSync(join(ROOT, 'plugins', 'self-switch', 'README.md'), 'utf8')
  assert.ok(readme.includes('-ExecutionPolicy RemoteSigned -File "%LOCALAPPDATA%\\claude-self-tools\\claude-slot.ps1"'))
  assert.ok(!readme.includes('Bypass'))
})

test('right before claude runs, it reads the registry and the process table again: the same lines as the window', () => {
  const at = script.indexOf('function Get-Live')
  assert.ok(at > 0)
  for (const line of machine.RECHECK) assert.ok(script.includes(`  ${line}\n`), `missing from the slot runner's re-check: ${line}`)
  // Called in the record's checks, inside a catch that resumes nothing when they can't be read.
  assert.ok(script.includes("try { $live = Get-Live $record.resume $dirs } catch { $live = 'whether it is open elsewhere is unknown: the registry or the process table could not be read ("))
  // A registry file that doesn't read is read again twice, 250 ms apart, before it counts as unknown.
  assert.ok(script.includes('      for ($try = 1; $try -le 3 -and $null -eq $e; $try++) {\n'))
  assert.ok(script.includes('        if ($null -eq $e -and $try -lt 3) { Start-Sleep -Milliseconds 250 }\n'))
  // A record not used says why, and how to resume it by hand; the pane waits, it never closes.
  assert.ok(script.includes("Write-Host ('A record to resume a conversation in this pane was not used: ' + $why + '.')"))
  assert.ok(script.includes("Write-Host ('Once it is safe, resume it yourself: claude --resume ' + $record.resume)"))
})

test('a record a switch or restart withdrew (overwritten with cancelled: true) is said as withdrawn, and nothing runs', () => {
  const withdrawn = "  if ($null -eq $why -and $null -ne $record -and $record.cancelled -is [bool] -and $record.cancelled) {\n    Write-Host 'The switch that left this record was withdrawn; nothing to do.'\n    return $null\n  }\n"
  assert.ok(script.includes(withdrawn))
  // After the record is read, before it is judged as one naming a conversation.
  assert.ok(script.indexOf(withdrawn) > script.indexOf("try { $record = $text | ConvertFrom-Json } catch { $why = 'it is not JSON' }"))
  assert.ok(script.indexOf(withdrawn) < script.indexOf("$why = 'it names no conversation by its id'"))
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
  // NO_COLOR among them; never WT_SESSION or WT_PROFILE_ID (the pane's own: Claude Code reads
  // WT_SESSION to draw its Unicode prompt and its links), never the REAP setting.
  assert.ok(machine.SESSION_MARKERS.includes('NO_COLOR'))
  assert.ok(!machine.SESSION_MARKERS.includes('WT_SESSION') && !machine.SESSION_MARKERS.includes('WT_PROFILE_ID'))
  assert.ok(!script.includes('WT_SESSION'))
  assert.ok(!script.includes('WT_PROFILE_ID'))
  assert.ok(!script.includes('CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP'))
  // Transcripts on, after the clear and before claude.
  const force = script.indexOf("  $env:CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1'\n")
  assert.ok(force > script.indexOf('foreach ($name in $Markers)'))
  assert.ok(force < script.indexOf('& $claude.Source @arguments'))
  assert.ok(script.indexOf('SetEnvironmentVariable($name, $null') < script.indexOf('& $claude.Source @arguments'))
})

test('with no record it waits, looking for one every 2 seconds, and Enter starts claude', () => {
  assert.ok(script.includes('for ($i = 0; $i -lt 10 -and -not $enter; $i++) {'))
  assert.ok(script.includes('Start-Sleep -Milliseconds 200'))
  assert.ok(script.includes("if ([Console]::ReadKey($true).Key -eq 'Enter') { $enter = $true }"))
  assert.ok(script.includes("Write-Host 'Claude Code ended. Enter starts a new session here; Ctrl+C leaves this slot.'"))
})
