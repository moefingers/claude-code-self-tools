// The slot runner v2, plugins/self-switch/slot/claude-slot.ps1, read as text: what it checks before it
// starts or resumes a conversation, and that the hash the plugins compare it with is its own. A fault
// planted in a copy of the text must show up in runnerProblems, the same checks; scripts/slot-live.test.mjs
// runs the script against the stub. Run with `node --test "scripts/*.test.mjs"`.
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
const launcher = readFileSync(join(ROOT, 'plugins', 'self-switch', 'slot', 'claude-launch.ps1'), 'utf8')
const machine = await import(pathToFileURL(join(ROOT, 'shared', 'hooks', 'machine.ts')).href)

test("the hash the plugins check is the runner's own, and the runner is plain ASCII with LF line ends, under the 64 KB the probe reads", () => {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), machine.SLOT_SCRIPT_SHA256)
  assert.ok(bytes.every(b => b < 128), 'Windows PowerShell 5.1 reads a file without a BOM as ANSI: keep it ASCII')
  assert.ok(!bytes.includes(13), 'committed with LF line ends (.gitattributes), so the hash is of that')
  assert.ok(bytes.length < 65536)
})

/** Every check of the runner, each problem found. */
function runnerProblems(text) {
  const problems = []
  const need = (ok, what) => {
    if (!ok) problems.push(what)
  }
  const has = line => text.includes(line)
  const code = text.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')

  need(has('param([switch]$Idle, [string]$Start, [string]$Name, [string]$Resume, [string]$WaitFor, [string]$ConfigDirs, [string]$LeftSize, [string]$LeftMtime, [string]$LeftExitAt, [string]$Launcher)'), 'its parameters')
  need(text.indexOf(machine.PSMODULEPATH_RESET) > 0 && text.indexOf(machine.PSMODULEPATH_RESET) < text.indexOf('$me = Get-CimInstance'), 'PSModulePath reset at the top')
  need(!code.includes('Get-FileHash') && !/\bbash\b|\bmsys\b|\/proc\//i.test(code), 'no Get-FileHash, no bash')
  for (const flag of ['--permission-mode', '--dangerously-skip-permissions', 'bypassPermissions', '--allow-dangerously', 'acceptEdits']) need(!has(flag), `no ${flag}`)
  need(has('$slotId = \'{0}-{1}\' -f $PID, $me.CreationDate.ToFileTimeUtc()'), 'its id')

  // Every claude through claude-launch.ps1: no environment code of its own.
  need(!/&\s*\$claude|&\s*\$exe|['"]--(resume|session-id)['"]/.test(code), 'it starts no claude itself')
  need(has('try { & $launcherPath @run }'), 'every claude through claude-launch.ps1')
  // The launcher by the hash a record or an argument names, read right before it runs; never the hand copy.
  need(has("$launcherPath = Join-Path $state ('claude-launch-' + $sha.Substring(0, 8) + '.ps1')"), 'the launcher at the name its hash gives')
  const hashed = text.indexOf('$actual = Get-Sha256 $launcherPath')
  const judgedHash = text.indexOf('if ($actual -cne $sha) {')
  const ran = text.indexOf('try { & $launcherPath @run }')
  need(hashed > 0 && hashed < judgedHash && judgedHash < ran && text.slice(judgedHash, ran).split('\n').length < 12, 'its hash verified just before it runs')
  need(has("if ($null -eq $why -and ($record.launcher -isnot [string] -or $record.launcher -cnotmatch $Sha256)) { $why = 'it names no launcher by its SHA-256,"), "a record's launcher field required, and what to do said")
  need(has("if ($null -eq $why -and $Launcher -cnotmatch $Sha256) { $why = 'it names no launcher by its SHA-256 (-Launcher),"), "a tab's -Launcher required, and what to do said")
  need(has('$run = @{ Launcher = $record.launcher;') && has('$run = @{ Launcher = $Launcher;'), 'the launcher named is the one run')
  need((code.match(/&\s*\$[A-Za-z]+/g) ?? []).join() === '& $launcherPath', 'it runs one script, the launcher by its hash')
  need(code.split('\n').filter(line => line.includes('$handCopy')).every(line => line.startsWith('$handCopy = Join-Path') || line.includes('Write-Host')), 'the hand copy only ever named in a line printed for the person')
  need(!text.includes(machine.LAUNCH_SCRIPT_SHA256), 'no launcher hash of its own: a new launcher needs no new runner')
  // Enter has no record: only a copy of a launch's, verified against its name.
  need(has("if ($f.Name -cnotmatch '^claude-launch-([0-9a-f]{8})\\.ps1\\z') { continue }"), 'Enter reads only names with the hash in them')
  need(has('if ($null -eq $sha -or -not $sha.StartsWith($digits, [StringComparison]::Ordinal)) { continue }'), 'an edited copy passed over at Enter')
  need(has('if ([int]$Matches[1] -gt $bestVersion) { $best = $sha; $bestVersion = [int]$Matches[1] }'), 'the highest version at Enter')
  need(!code.includes('CLAUDE_CODE_FORCE_SESSION_PERSISTENCE') && !code.includes('CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP') && !code.includes('NO_COLOR') && !code.includes('CLAUDECODE'), 'no launch environment of its own')
  need(!code.includes('WT_SESSION') && !code.includes('WT_PROFILE_ID'), 'WT_SESSION and WT_PROFILE_ID untouched')
  // The launcher removes the execution policy's variable for claude's sake: put back, for its next run here.
  const policy = "[Environment]::SetEnvironmentVariable('PSExecutionPolicyPreference', $policy, [EnvironmentVariableTarget]::Process)"
  need(has(policy) && text.indexOf(policy) > text.indexOf('try { & $launcherPath @run }'), 'the execution policy put back after each run')
  need(!has('[Environment]::SetEnvironmentVariable($name'), 'clears nothing itself')

  // -Start, -Name, -Resume, each with its checks.
  need(has("if ($null -eq $why -and $id -cnotmatch $SessionId) { $why = 'its id is not a session id (a lowercase UUID)' }"), 'an argument\'s id checked')
  need(has("if ($null -eq $why -and $Start -and $Name -cnotmatch $AreaName) { $why = '-Start takes -Name: lowercase letters, digits and hyphens' }"), 'the name pattern for -Start')
  need(has("if ($null -eq $why -and -not (Test-Claim $id ('launch:' + $id))) { $why = 'the claim lock on that conversation does not name this tab''s launch' }"), "-Start and -Resume need the claim naming launch:<id>")
  need(has("if ($null -eq $why -and $Resume -and -not (Test-Project $here $id)) { $why ="), "-Resume's folder must be its project")
  need(has('if ($Start) { $why = Get-NotFresh $id $dirs }'), '-Start re-checks freshness')

  // A record: each check, the record deleted first.
  const read = text.indexOf('$text = [IO.File]::ReadAllText($recordPath, [Text.Encoding]::UTF8)')
  const deleted = text.indexOf('[IO.File]::Delete($recordPath)')
  const judged = text.indexOf("$why = 'it names no conversation by its id'")
  need(read > 0 && read < deleted && deleted < judged, 'the record deleted before anything in it is checked')
  need(has("elseif ($id -isnot [string] -or $id -cnotmatch $SessionId) { $why = 'it names no conversation by its id' }"), "a record's id")
  need(has("elseif ($isStart -and ($record.name -isnot [string] -or $record.name -cnotmatch $AreaName)) { $why = 'it names no session name' }"), "a start record's name pattern")
  need(has('$MaxAgeMs = 120000') && has('($now - [double]$record.at) -gt $MaxAgeMs'), 'at most 120 seconds old')
  need(has("if ($null -eq $why -and -not (Test-Folder $record.folder)) { $why ="), 'an existing folder with no quote or semicolon')
  need(has("if ($null -eq $why -and -not (Test-Claim $id ('slot:' + $slotId))) { $why = 'the claim lock on that conversation does not name this slot' }"), 'the claim names this slot')
  need(has("if ($null -eq $why -and -not $isStart -and -not (Test-Project $record.folder $id)) { $why ="), "a resume record's folder must be its project")
  need(has('if ($isStart) { $why = Get-NotFresh $id $dirs }'), 'a start record re-checks freshness')
  need((code.match(/if \(\$null -eq \$why -and \$leftArgs\.Count -gt 0\) \{/g) ?? []).length === 2 && (code.match(/\$why = Test-Left \$id \$dirs/g) ?? []).length === 4, "a left record's stat in both last looks")
  need(has("$leftArgs = @{ LeftSize = \"$($record.left.size)\"; LeftMtime = \"$($record.left.mtime)\" }") && has("$leftArgs = @{ LeftExitAt = \"$($record.left.exitAt)\" }"), "a record's left stat handed to the launcher's own look")

  // You win.
  need(has("if ($keyed -or (Test-KeyPending)) {"), 'a record that arrives while console input is pending is refused')
  need(has('function Test-KeyPending { try { return [Console]::KeyAvailable } catch { return $false } }'), 'KeyAvailable read')
  need(text.indexOf('if ($keyed -or (Test-KeyPending)) {') > deleted && text.indexOf('if ($keyed -or (Test-KeyPending)) {') < judged, 'refused after it is deleted, and said')
  need(has('$keyed = $true; if ([Console]::ReadKey($true).Key -eq \'Enter\') { $enter = $true }'), 'Enter in the poll')
  need(has('if ($keyed) { [void](Get-Next $true) }'), 'a key read in the same poll as a record refuses the record')
  need(has('if ($enter) {\n      Start-Claude @{ Launcher = (Get-NewestLauncher) }'), 'Enter starts claude')

  // The floor and the cap.
  need(has('if ($null -eq $why) { $why = Get-FloorWhy $isStart }'), 'a start record its floor and cap; a resume record the cap only')
  need(has('if ($null -eq $why) { $why = Get-FloorWhy $true }'), '-Start and -Resume, the floor and the cap')
  need(has('$DefaultMinFreeGb = 5') && has('$DefaultMaxSessions = 12'), 'the defaults')
  need(has('if ($given.minFreeGb -is [int] -and $given.minFreeGb -ge 1 -and $given.minFreeGb -le 64)') && has('if ($given.maxSessions -is [int] -and $given.maxSessions -ge 1 -and $given.maxSessions -le 40)'), 'limits checked as readPlacement checks them')
  need(has('if ($freeKb -lt ([long]$limits.minFreeGb * 1024 * 1024))') && has('if ($count -ge $limits.maxSessions)'), 'each compared')

  // Beacons.
  need(has('$beaconPath = Join-Path $state (\'slots\\\' + $slotId + \'.state.json\')'), 'its beacon')
  need(has("Write-Beacon 'running'") && has("Write-Beacon 'idle'") && has("Write-Beacon 'left'"), 'at each state')
  need(has("$stampWindow = $env:CLAUDE_SELF_TOOLS_WT_WINDOW") && has("$stampTab = $env:CLAUDE_SELF_TOOLS_WT_TAB"), 'its stamp')
  need(has("if ($stampWindow -cnotmatch '^[A-Za-z0-9_-]{1,40}\\z' -or $stampWindow -match '^-?\\d+\\z' -or $stampWindow -match '^(new|last)\\z') { $stampWindow = $null }"), 'a bad stamp dropped')
  need(has("$beacon['claude'] = $used"), 'the beacon records which claude')
  need(text.split('\n')[6].includes('-File "%LOCALAPPDATA%\\claude-self-tools\\claude-slot.ps1" -Idle'), 'the header documents the profile line with -Idle')
  return problems
}

test('the runner as text: its arguments, its records, your input, its floor and cap, its beacon; every claude through claude-launch.ps1', () => {
  assert.deepEqual(runnerProblems(script), [])
})

test('its last look is RECHECK and LEFT_RECHECK, line for line, and its folder rule and Get-Cli the machine code\'s and the launcher\'s', () => {
  for (const line of machine.RECHECK) assert.ok(script.includes(`    ${line}\n`), `missing from the slot runner's re-check: ${line}`)
  for (const line of machine.LEFT_RECHECK) assert.ok(script.includes(`    ${line}\n`), `missing from the slot runner's left look: ${line}`)
  for (const line of machine.GET_CLI) assert.ok(script.includes(`${line}\n`), `missing from the slot runner's Get-Cli: ${line}`)
  for (const line of machine.GET_SHA256) assert.ok(script.includes(`${line}\n`), `missing from the slot runner's Get-Sha256: ${line}`)
  const shape = text => text.slice(text.indexOf('function Test-Shape($path) {'), text.indexOf('# Whether a running Claude Code holds conversation'))
  assert.equal(shape(script), shape(launcher))
})

test('its record is written by a launch with CreateNew, held open while it is written: the runner reads it at the next look', () => {
  assert.ok(script.includes('} catch { return $null }\n  # You win'))
})

for (const [name, from, to, expect] of [
  ['the name pattern dropped from -Start', " -and $Name -cnotmatch $AreaName) { $why = '-Start takes -Name", ') { $why = \'-Start takes -Name', /name pattern for -Start/],
  ['the name pattern dropped from a start record', " -or $record.name -cnotmatch $AreaName)", ')', /start record's name pattern/],
  ['the KeyAvailable refusal removed', 'if ($keyed -or (Test-KeyPending)) {', 'if ($false) {', /console input is pending/],
  ['Enter in the same poll no longer refusing the record', 'if ($keyed) { [void](Get-Next $true) }', '', /same poll as a record/],
  ['the floor self-check removed for a start record', 'if ($null -eq $why) { $why = Get-FloorWhy $isStart }', '', /floor and cap/],
  ['the floor self-check removed for -Start and -Resume', 'if ($null -eq $why) { $why = Get-FloorWhy $true }', '', /the floor and the cap/],
  ['-Resume without its claim check', "if ($null -eq $why -and -not (Test-Claim $id ('launch:' + $id))) {", 'if ($false) {', /naming launch:<id>/],
  ['a start record without its claim check', "if ($null -eq $why -and -not (Test-Claim $id ('slot:' + $slotId))) {", 'if ($false) {', /names this slot/],
  ['the record deleted after it is judged', '    [IO.File]::Delete($recordPath)\n', '', /deleted before anything/],
  ['the left look removed from a resume record', 'if ($null -eq $why -and $leftArgs.Count -gt 0) {', 'if ($false) {', /left record's stat in both/],
  ['Get-FileHash used', '$me = Get-CimInstance', '$x = Get-FileHash $PSCommandPath; $me = Get-CimInstance', /Get-FileHash/],
  ['a bash call added', '$me = Get-CimInstance', 'bash -c true; $me = Get-CimInstance', /no bash/],
  ['claude started by the runner itself', 'try { & $launcherPath @run }', 'try { & $exe --resume $run.Resume }', /no claude itself|through claude-launch/],
  ['a record with no launcher field used all the same', 'if ($null -eq $why -and ($record.launcher -isnot [string] -or $record.launcher -cnotmatch $Sha256)) {', 'if ($false) {', /launcher field required/],
  ['a tab with no -Launcher used all the same', 'if ($null -eq $why -and $Launcher -cnotmatch $Sha256) {', 'if ($false) {', /-Launcher required/],
  ['a changed file run all the same', 'if ($actual -cne $sha) {', 'if ($false) {', /verified just before/],
  ['the hash read once, not just before it runs', '$actual = Get-Sha256 $launcherPath', '$actual = $sha', /verified just before/],
  ['the hand copy run for a record or a tab', "$launcherPath = Join-Path $state ('claude-launch-' + $sha.Substring(0, 8) + '.ps1')", '$launcherPath = $handCopy', /at the name its hash gives/],
  ['the hand copy run by name', 'try { & $launcherPath @run }', 'try { & $handCopy @run }', /through claude-launch|one script|only ever named/],
  ['the hand copy read at Enter', "'^claude-launch-([0-9a-f]{8})\\.ps1\\z'", "'^claude-launch(-[0-9a-f]{8})?\\.ps1\\z'", /only names with the hash/],
  ['an edited copy taken at Enter', '$null -eq $sha -or -not $sha.StartsWith($digits, [StringComparison]::Ordinal)', '$null -eq $sha', /edited copy passed over/],
  ['the launcher pinned in the runner', '$MaxAgeMs = 120000', `$MaxAgeMs = 120000\n$pin = '${machine.LAUNCH_SCRIPT_SHA256}'`, /no launcher hash of its own/],
  ['a marker cleared here', '$policy = [Environment]', "$env:NO_COLOR = ''; $policy = [Environment]", /no launch environment/],
  ['WT_SESSION cleared', '$policy = [Environment]', "Remove-Item Env:WT_SESSION; $policy = [Environment]", /WT_SESSION/],
  ['the execution policy not put back', "finally { [Environment]::SetEnvironmentVariable('PSExecutionPolicyPreference', $policy, [EnvironmentVariableTarget]::Process) }", 'finally { }', /execution policy put back/],
]) {
  test(`planted: ${name}`, () => {
    const faulty = script.split(from).join(to)
    assert.notEqual(faulty, script, 'the fault changed nothing')
    const found = runnerProblems(faulty)
    assert.ok(found.some(p => expect.test(p)), `not caught: ${JSON.stringify(found)}`)
  })
}
