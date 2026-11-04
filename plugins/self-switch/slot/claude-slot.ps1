# claude-slot.ps1: a Windows Terminal pane that runs Claude Code, and runs it again here when told to.
#
# Part of self-switch (claude-code-self-tools, plugins/self-switch/slot/claude-slot.ps1). Copy it,
# unchanged, to %LOCALAPPDATA%\claude-self-tools\claude-slot.ps1, and give a Windows Terminal profile
# this command line:
#
#   powershell.exe -NoExit -NoProfile -ExecutionPolicy RemoteSigned -File "%LOCALAPPDATA%\claude-self-tools\claude-slot.ps1"
#
# -ExecutionPolicy RemoteSigned lets this unsigned local script run where the policy is Restricted,
# Windows' default; the script then clears it again before claude starts, so claude and every
# PowerShell it starts get the machine's own policy.
#
# self-switch and self-restart use a pane as a slot only when the script it runs has the SHA-256 they
# ship, so a copy that was edited is never used as one: that pane then works as a plain pane does.
# After copying a new version, restart the slot panes: a pane keeps running the script it started with.
#
# What it does:
# - It runs claude, with no flags, in the folder the pane opened in.
# - When Claude Code exits, it looks for the record a switch or a restart left for this pane:
#   %LOCALAPPDATA%\claude-self-tools\slots\<pid>-<created>.next.json, where <pid> is this script's
#   process id and <created> its creation time (a FILETIME), so a record names one run of one pane.
# - It deletes the record before anything else, so a record is used once. It honours it only when it
#   is at most 120 seconds old, names a conversation by its id (a UUID) and an existing folder that is
#   the conversation's own (its project holds the conversation's transcript), the claim lock on that
#   conversation names this slot, and no running Claude Code holds the conversation (read again right
#   then: the session registry and every process's command line). Then it runs claude --resume <id>
#   in that folder, in this same pane.
# - With no record it waits: Enter starts a new Claude Code here, and a record that arrives meanwhile
#   is honoured (it looks every 2 seconds). Ctrl+C leaves the slot, at a PowerShell prompt.
#
# It runs claude with no other argument: no permission flag of any kind. A resumed session starts in
# the mode a new session would.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$SessionId = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$MaxAgeMs = 120000
# The variables Claude Code sets in the processes it starts: a claude that inherits them is nested.
$Markers = 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_JOB_DIR', 'AI_AGENT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_SSE_PORT'

# This slot's id: its process id and creation time, as the probe reads them from its child's parent.
$me = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $PID" -Property ProcessId, CreationDate
$slotId = '{0}-{1}' -f $PID, $me.CreationDate.ToFileTimeUtc()
$state = Join-Path $env:LOCALAPPDATA 'claude-self-tools'
$recordPath = Join-Path $state ('slots\' + $slotId + '.next.json')

# Whether a running Claude Code holds conversation $id now: $null when none does, else which.
function Get-Live($id, $configDirs) {
  $live = $null
  $procs = @{}
  foreach ($p in (Get-CimInstance -ClassName Win32_Process -Property ProcessId, Name, CreationDate, CommandLine)) { $procs[[int]$p.ProcessId] = $p }
  foreach ($p in $procs.Values) { if ($null -eq $live -and $p.ProcessId -ne $PID -and "$($p.CommandLine)" -match "(^|[\s\x22])(--resume|--session-id|-r)(\s+|=)[\x22\x27]?$id") { $live = "it is open elsewhere: process $($p.ProcessId) names it on its command line (L2)" } }
  foreach ($dir in $configDirs) {
    $reg = Join-Path $dir "sessions"
    if ($null -ne $live -or -not (Test-Path -LiteralPath $reg -PathType Container)) { continue }
    foreach ($f in @(Get-ChildItem -LiteralPath $reg -Filter "*.json" -File -Force)) {
      $p = $null
      if ($f.BaseName -match "^\d{1,10}\z") { $p = $procs[[int]$f.BaseName] }
      if ($null -eq $p -or $p.Name -ne "claude.exe") { continue }
      $e = $null
      for ($try = 1; $try -le 3 -and $null -eq $e; $try++) {
        try { $e = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $e = $null }
        if ($null -ne $e -and ($e.sessionId -isnot [string] -or $null -eq $e.procStart)) { $e = $null }
        if ($null -eq $e -and $try -lt 3) { Start-Sleep -Milliseconds 250 }
      }
      if ($null -eq $e) { $live = "whether it is open elsewhere is unknown: the registry file of Claude Code $($f.BaseName) could not be read, three times, or has another shape"; break }
      if ($e.sessionId -ceq $id) {
        $near = $false
        try { $near = [math]::Abs([double]$p.CreationDate.ToFileTimeUtc() - [double]$e.procStart) -le 10000 } catch { $near = $false }
        if ($near) { $live = "it is open elsewhere: Claude Code $($f.BaseName) holds it (L1)" } else { $live = "it may be open elsewhere: the registry file of running Claude Code $($f.BaseName) names it, though its procStart is not that process start time (a stale file, or a format this check does not know)" }
        break
      }
    }
  }
  return $live
}

# An absolute folder with no quote or control character, that is there.
function Test-Folder($path) {
  if ($path -isnot [string] -or $path -cnotmatch '^[A-Za-z]:\\') { return $false }
  if ($path -match '[\x00-\x1f"''\u2018\u2019\u201a\u201b\u201c\u201d\u201e]') { return $false }
  return (Test-Path -LiteralPath $path -PathType Container)
}

# The record left for this pane, used once: $null, or the conversation and the folder to resume it in.
function Get-Next {
  if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) { return $null }
  $text = $null
  $written = [datetime]::MinValue
  try {
    $written = (Get-Item -LiteralPath $recordPath -Force).LastWriteTimeUtc
    $text = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8
  } finally {
    # Gone before anything is checked or run: a record is used once.
    [IO.File]::Delete($recordPath)
  }
  $why = $null
  $record = $null
  try { $record = $text | ConvertFrom-Json } catch { $why = 'it is not JSON' }
  # A switch or restart that took its record back overwrote it so (a plugin can't delete a file).
  if ($null -eq $why -and $null -ne $record -and $record.cancelled -is [bool] -and $record.cancelled) {
    Write-Host 'The switch that left this record was withdrawn; nothing to do.'
    return $null
  }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($null -eq $why -and ($null -eq $record -or $record.v -ne 1 -or $record.resume -isnot [string] -or $record.resume -cnotmatch $SessionId)) { $why = 'it names no conversation by its id' }
  if ($null -eq $why -and ($record.at -isnot [ValueType] -or ($now - [double]$record.at) -gt $MaxAgeMs -or ($now - [double]$record.at) -lt -5000 -or ([datetime]::UtcNow - $written).TotalMilliseconds -gt $MaxAgeMs)) { $why = 'it is more than 120 seconds old' }
  if ($null -eq $why -and -not (Test-Folder $record.folder)) { $why = 'its folder is not an existing folder' }
  # This runner's own config folder: the one the claude it starts uses.
  $own = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
  if ($null -eq $why) {
    # The folder must be the conversation's own: its project (the folder with every character but a
    # letter or digit made a dash, as Claude Code names it) holds the conversation's transcript, in
    # this runner's own config folder. Never in one the record names: a record can't vouch for itself.
    $name = $record.folder -replace '[^A-Za-z0-9]', '-'
    $inProject = $name.Length -le 200 -and (Test-Path -LiteralPath (Join-Path $own ('projects\' + $name + '\' + $record.resume + '.jsonl')) -PathType Leaf)
    if (-not $inProject) { $why = 'its folder is not that conversation''s own: no transcript of it under the folder''s project' }
  }
  # The config folders the re-check reads: this runner's own, and those the record names, since
  # reading more registries can only find the conversation held, never free it.
  $dirs = @($own)
  if ($null -ne $record) { foreach ($d in @($record.configDirs)) { if (Test-Folder $d) { $dirs += $d } } }
  if ($null -eq $why) {
    $lock = $null
    try { $lock = Get-Content -LiteralPath (Join-Path $state ('claims\' + $record.resume + '.lock')) -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $lock = $null }
    if ($null -eq $lock -or $lock.by -cne ('slot:' + $slotId)) { $why = 'the claim lock on that conversation does not name this slot' }
  }
  if ($null -eq $why) {
    try { $live = Get-Live $record.resume $dirs } catch { $live = 'whether it is open elsewhere is unknown: the registry or the process table could not be read (' + $_.Exception.Message + ')' }
    if ($null -ne $live) { $why = $live }
  }
  if ($null -ne $why) {
    Write-Host ('A record to resume a conversation in this pane was not used: ' + $why + '.')
    if ($null -ne $record -and $record.resume -is [string] -and $record.resume -cmatch $SessionId) { Write-Host ('Once it is safe, resume it yourself: claude --resume ' + $record.resume) }
    return $null
  }
  return $record
}

# Runs claude from PATH with these arguments, its environment clear of the markers.
function Start-Claude([string[]]$arguments) {
  # -ExecutionPolicy on the pane's command line was for this script alone: claude, and every PowerShell
  # it starts, gets the machine's own policy back.
  [Environment]::SetEnvironmentVariable('PSExecutionPolicyPreference', $null, [EnvironmentVariableTarget]::Process)
  foreach ($name in $Markers) { [Environment]::SetEnvironmentVariable($name, $null, [EnvironmentVariableTarget]::Process) }
  $claude = Get-Command -Name 'claude' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $claude) { Write-Host 'No claude on PATH.'; return }
  & $claude.Source @arguments
}

Start-Claude @()
while ($true) {
  $next = Get-Next
  if ($null -ne $next) {
    Set-Location -LiteralPath $next.folder
    Write-Host ('Resuming conversation ' + $next.resume + ' here.')
    Start-Claude @('--resume', $next.resume)
    continue
  }
  Write-Host 'Claude Code ended. Enter starts a new session here; Ctrl+C leaves this slot.'
  $enter = $false
  while (-not $enter -and -not (Test-Path -LiteralPath $recordPath -PathType Leaf)) {
    for ($i = 0; $i -lt 10 -and -not $enter; $i++) {
      while ([Console]::KeyAvailable) { if ([Console]::ReadKey($true).Key -eq 'Enter') { $enter = $true } }
      if (-not $enter) { Start-Sleep -Milliseconds 200 }
    }
  }
  if ($enter) { Start-Claude @() }
}
