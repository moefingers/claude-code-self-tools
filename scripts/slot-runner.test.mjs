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

  need(has('param([switch]$Idle, [string]$Start, [string]$Name, [string]$Resume, [string]$WaitFor, [string]$ConfigDirs, [string]$LeftSize, [string]$LeftMtime, [string]$LeftExitAt, [string]$Launcher, [string]$Claim)'), 'its parameters')
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
  need(has("if ($null -eq $why -and -not (Test-Claim $id $Claim)) { $why = 'the claim lock on that conversation does not name this tab''s launch' }"), "-Start and -Resume need the lock naming this launch's own -Claim")
  need(has("if ($null -eq $why -and $Claim -cnotmatch $LaunchClaim) { $why = 'it names no claim of its own (-Claim),"), "-Claim of a launch's shape required")
  // A tab that waits isn't idle (F2); keys typed meanwhile never reach claude (F5); a refusal gives the claim back and says the line (F7).
  const waiting = text.indexOf("Write-Beacon 'running'\n    $asked = Get-Asked")
  need(waiting > 0 && text.indexOf('$asked = Get-Asked', waiting) > waiting && code.includes("if ($null -ne $asked) { Start-Claude $asked }\n    Write-Beacon 'idle'"), 'a tab says running while it waits, idle once it has refused')
  need(has("if ($null -eq $why -and (Test-KeyPending)) { $why = 'you were typing here, and claude would have read it as its prompt'; Clear-Keys }") && text.indexOf('(Test-KeyPending)) { $why = ') > text.indexOf('$why = Get-Live $id $dirs\n      if ($null -eq $why -and $leftArgs.Count -gt 0) {', text.indexOf('function Get-Asked')), 'a tab refuses console input, after the wait and the last look')
  need(has('if ($id -cmatch $SessionId -and $Claim -cmatch $LaunchClaim) { Give-Back $id $Claim }') && has('Say-ByHand $id $(if ($Start) { $Name } else { $null }) $here') && text.indexOf('{ Give-Back $id $Claim }') < text.indexOf("Write-Host ('This tab did not run"), 'a refusing tab gives its claim back and says the line')
  need((code.match(/Refuse-Record \$text/g) ?? []).length === 2 && has("if ($named) { Give-Back $id ('slot:' + $slotId) }") && has('if ($named) { Say-ByHand $id'), 'a refused record gives the claim back and says the line')
  need(has('{ Give-Back $run.Resume $held }') && has('{ Give-Back $run.Start $held }') && has('{ Say-ByHand $run.Resume $null $run.Dir }'), 'a changed launcher gives the claim back and says the line')
  need(has("if (Test-Shape $folder) { \" -Dir '\" + $folder + \"'\" }"), 'the line names its folder')
  // The launcher refusing or throwing: a tab's claim back on either, a record's on a throw alone, before anything is said (D2).
  const judgedRun = text.indexOf('$gaveBack = $null -ne $heldId -and ($null -ne $threw -or ($held -cmatch $LaunchClaim -and $code -ne 0))')
  const gaveBack = text.indexOf('if ($gaveBack) { Give-Back $heldId $held }')
  const errorSaid = text.indexOf("if ($null -ne $threw) { Write-Host ('claude-launch.ps1 stopped on an error")
  const lineSaid = text.indexOf('if ($gaveBack) { Say-ByHand $heldId $(if ($run.ContainsKey(\'Start\')) { $run.Name } else { $null }) $run.Dir }')
  need(judgedRun > text.indexOf('$code = $LASTEXITCODE') && text.indexOf('$code = $LASTEXITCODE') > text.indexOf('try { & $launcherPath @run }') && has('catch { $threw = $_.Exception.Message }'), "a launcher that refused or threw: a tab's claim back on either, a record's on a throw alone")
  need(judgedRun > 0 && judgedRun < gaveBack && gaveBack < errorSaid, 'its claim back before the error is said')
  need(errorSaid > 0 && errorSaid < lineSaid, 'whenever the claim goes back, the line to run it by hand')
  const cleared = text.indexOf('$global:LASTEXITCODE = 0')
  need(cleared > 0 && cleared < text.indexOf('try { & $launcherPath @run }'), 'the exit code this run left, not an earlier one')
  // Never ending the runner before the refusal is said, and the delete tried again as releaseScript does (D4).
  need(has('function Give-Back($id, $by) {\n  try {\n') && has('    Release-Claim\n  } catch { }\n}'), 'a give-back that fails never ends the runner')
  need(has('  } catch { } finally { $stream.Dispose() }\n'), 'Release-Claim never throws')
  need(has('      for ($try = 0; $try -lt 3; $try++) {\n') && has('        if ($try -gt 0) { Start-Sleep -Milliseconds 250 }\n') && has('        try { [IO.File]::Delete($claimPath); break } catch { }\n'), 'the delete tried three times, 250 ms apart')
  // The beacon says what this process runs (F4), read once as it starts.
  // The wait: by the process's handle and its start (WaitForExit): its exit code reads set tens of milliseconds before it is
  // signaled and dropped from the table, so a wait that stops at the exit code can return with it still listed. Never a
  // look at the table; and one that outlasts the first wait is looked at again until it goes (F1, S3).
  need(has('          $gone = Wait-Gone $parts[0] $parts[1] 30\n') && !code.includes('Wait-Process') && !code.includes('Get-Process -Id'), 'the old process waited for by its handle and asked whether it has exited')
  need(has('        while (-not $gone) {\n') && !code.includes('the old process is still running'), 'a tab keeps waiting for a process that outlasts the first look')
  need(has('          $claimSays = Get-ClaimSays $id $Claim\n') && has('          if (-not $toldLong -and $waitClock.Elapsed.TotalSeconds -ge $WaitSeconds) {'), 'the claim read at every look, and the 10-minute line by the clock')
  need(has("($parts[1] -eq '0' -or [math]::Abs($old.CreationDate.ToFileTimeUtc() - [long]$parts[1]) -le 10000)"), 'an unread start time waits by the pid')
  need(has("; if ($run.ContainsKey('Resume') -or $run.ContainsKey('Start')) { Write-Refused $(if ($run.ContainsKey('Start')) { $run.Start } else { $run.Resume }) $held"), "the launcher's hash refusal recorded")
  // F1 4: the session count passes over a Claude Code that has exited and is on its way out of the table.
  need(has("      if ($p.Name -ne 'claude.exe' -or (Get-Cli $p) -or (Test-Exited $p)) { continue }"), 'the cap counts no Claude Code that has exited')
  // S3: every refusal recorded for whoever comes looking, at <state>\refused\<id>.json.
  need(has("  if ($named) { Write-Refused $id ('slot:' + $slotId)"), "a record's refusal recorded")
  need(has("    if ($id -cmatch $SessionId) { Write-Refused $id $Claim $(if ($Start) { 'start' } else { 'resume' }) $here"), "a tab's refusal recorded")
  need(has("  if ($null -ne $heldId -and ($null -ne $threw -or ($code -eq 2 -and ((Get-Date) - $ranFrom).TotalSeconds -lt 60))) { Write-Refused $heldId $held"), "a launcher's refusal (exit 2 at once) or error recorded")
  need(has("          if ($claimSays -eq 'gone' -or $claimSays -eq 'other') { $why = ") && has("[IO.FileShare]'ReadWrite, Delete'"), 'a look that cannot read the claim keeps waiting, and never blocks a writer')
  need(has("          if ($claimSays -eq 'unknown') { $unread++ } else { $unread = 0 }\n") && has("          if ($unread -ge 10) { $why = "), 'a claim unreadable for 10 looks in a row ends the wait')
  need(has("    $final = Join-Path $state ('refused\\' + $id + '.json')"), 'at its id-shaped path')
  need(has('try { $ownSha = Get-Sha256 $PSCommandPath }') && has("$beacon['sha256'] = $ownSha"), 'its beacon says the hash it started from')
  need(has('if ($dirs.Count -gt 1) { $run.ConfigDir = @($dirs[1..($dirs.Count - 1)]) }') && !code.includes('ConfigDir = $dirs'), 'the launcher told only the folders it does not read already')
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
  need(has("if ($stampWindow -cnotmatch '^[A-Za-z0-9_-]{1,40}\\z' -or $stampWindow -match '^-?\\d+\\z' -or $stampWindow -match '^(new|last|_quake)\\z') { $stampWindow = $null }"), 'a bad stamp dropped')
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
  for (const line of machine.RELEASE_CLAIM) assert.ok(script.includes(`${line}\n`), `missing from the slot runner's Release-Claim: ${line}`)
  for (const line of machine.TEST_GONE) assert.ok(script.includes(`${line}\n`), `missing from the slot runner's Test-Gone: ${line}`)
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
  ['-Resume without its claim check', "if ($null -eq $why -and -not (Test-Claim $id $Claim)) {", 'if ($false) {', /this launch's own -Claim/],
  ['F1: the claim back to one per conversation', "(Test-Claim $id $Claim)", "(Test-Claim $id ('launch:' + $id))", /this launch's own -Claim/],
  ['F1: a tab with no -Claim used all the same', "if ($null -eq $why -and $Claim -cnotmatch $LaunchClaim) {", 'if ($false) {', /-Claim of a launch's shape/],
  ['F1: the old process waited for by Wait-Process again', '          $gone = Wait-Gone $parts[0] $parts[1] 30\n', '          Wait-Process -Id ([int]$parts[0]) -Timeout 30 -ErrorAction SilentlyContinue; $gone = Test-Gone $parts[0] $parts[1]\n', /asked whether it has exited/],
  ['S3: a tab that gives up after its first look', '        while (-not $gone) {\n', '        if (-not $gone) {\n', /keeps waiting/],
  ['R4: the claim not read while waiting', "          $claimSays = Get-ClaimSays $id $Claim\n", "          $claimSays = 'ours'\n", /claim read at every look/],
  ['R5: the hash refusal not recorded', "; if ($run.ContainsKey('Resume') -or $run.ContainsKey('Start')) { Write-Refused", "; if ($false) { Write-Refused", /hash refusal recorded/],
  ['R5: exit 2 after a long session recorded', " -or ($code -eq 2 -and ((Get-Date) - $ranFrom).TotalSeconds -lt 60))) {", " -or $code -eq 2)) {", /exit 2 at once/],
  ['R5 (final): a claim unreadable for ever holds the wait for ever', "          if ($unread -ge 10) { $why = ", "          if ($false) { $why = ", /unreadable for 10 looks/],
  ['R3: a claim that cannot be read now ends the wait', "          if ($claimSays -eq 'gone' -or $claimSays -eq 'other') { $why = ", "          if ($claimSays -ne 'ours') { $why = ", /keeps waiting, and never blocks/],
  ['F1 4: the cap counting a Claude Code that has exited', " -or (Get-Cli $p) -or (Test-Exited $p)) { continue }", " -or (Get-Cli $p)) { continue }", /has exited/],
  ["S3: a tab's refusal no one hears of", "    if ($id -cmatch $SessionId) { Write-Refused $id $Claim", "    if ($false) { Write-Refused $id $Claim", /refusal recorded/],
  ['F2: a tab that waits saying idle', "Write-Beacon 'running'\n    $asked = Get-Asked", "Write-Beacon 'idle'\n    $asked = Get-Asked", /says running while it waits/],
  ['F4: a beacon that says no hash', "$beacon['sha256'] = $ownSha", "$beacon['x'] = $ownSha", /the hash it started from/],
  ['F5: a tab letting typed keys through', "if ($null -eq $why -and (Test-KeyPending)) {", 'if ($false) {', /refuses console input/],
  ['F7: a refusing tab keeping its claim', 'if ($id -cmatch $SessionId -and $Claim -cmatch $LaunchClaim) { Give-Back $id $Claim }', '', /gives its claim back/],
  ['F7: a refused record keeping its claim', "if ($named) { Give-Back $id ('slot:' + $slotId) }", '', /refused record gives the claim back/],
  ['F7: the line without its folder', "if (Test-Shape $folder) { \" -Dir '\" + $folder + \"'\" } else { '' }", "''", /the line names its folder/],
  ["D2: a tab keeping its claim when the launcher refuses", '($held -cmatch $LaunchClaim -and $code -ne 0)', '$false', /a record's on a throw alone/],
  ['D2: a throw keeping the claim', '$null -ne $threw -or ', '', /a record's on a throw alone/],
  ["D2: a record's claim given back on a normal return", '$held -cmatch $LaunchClaim -and ', '', /a record's on a throw alone/],
  ['D2: the error said before the claim is back', "  $code = $LASTEXITCODE\n", "  if ($null -ne $threw) { Write-Host ('claude-launch.ps1 stopped on an error, so Claude Code may not have started here: ' + $threw) }\n  $code = $LASTEXITCODE\n", /before the error is said/],
  ['D2: no line to run it by hand when the launcher refuses', "  if ($gaveBack) { Say-ByHand $heldId $(if ($run.ContainsKey('Start')) { $run.Name } else { $null }) $run.Dir }\n", '', /the line to run it by hand/],
  ['D2: an exit code an earlier run left', '$global:LASTEXITCODE = 0', '$null = 0', /not an earlier one/],
  ['D4: a give-back that can end the runner', '    Release-Claim\n  } catch { }\n}', '    Release-Claim\n  } finally { }\n}', /never ends the runner/],
  ['D4: Release-Claim that can throw', '  } catch { } finally { $stream.Dispose() }\n', '  } finally { $stream.Dispose() }\n', /never throws/],
  ['D4: the delete tried once', '$try -lt 3', '$try -lt 1', /tried three times/],
  ['D4: the delete tried at once, with no wait', '        if ($try -gt 0) { Start-Sleep -Milliseconds 250 }\n', '', /250 ms apart/],
  ['N5: the launcher told every folder', '$run.ConfigDir = @($dirs[1..($dirs.Count - 1)])', '$run.ConfigDir = $dirs', /does not read already/],
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
