# claude-launch.ps1: starts Claude Code as a top-level session. The one script in
# claude-code-self-tools that runs claude: every launch (a restart's or a switch's window, the
# coordinator's go, a steward's launch, a slot runner's every start, and you by hand) comes through it.
# claude-launch version 2
#
# Part of self-switch (claude-code-self-tools, plugins/self-switch/slot/claude-launch.ps1). Nobody
# copies it: a launch that opens a window puts the copy it carries in %LOCALAPPDATA%\claude-self-tools,
# as claude-launch-<the first 8 hex digits of its SHA-256>.ps1, one file per version of the plugins,
# and the window runs it from there only when its SHA-256 is the one the plugins ship
# (LAUNCH_SCRIPT_SHA256), checked right before it runs: that is the verified copy. The same launch keeps
# claude-launch.ps1 there, once a first launch has run: the highest version any launch has carried (the
# version line above), for you to run by hand. A slot runner runs the verified copy too, by the SHA-256 its
# record or argument names. A window or a slot runner never runs the copy for use by hand.
#
# By hand, in a terminal:
#   claude-launch.ps1 -Resume <session id> [-Dir <folder>]               resume a conversation
#   claude-launch.ps1 -Start <session id> -Name <name> [-Dir <folder>]   start one with that id and name
#   claude-launch.ps1 -Lane <name>                                        resume a session's current
#                                                                         conversation, by its name
#   claude-launch.ps1 [-Dir <folder>]                                     start a new session
# With -Resume, -Start or -Lane, -ConfigDir <folder>[,<folder>...] names other config folders whose
# session registries the last look reads too (a launch's window names every one it read). With -Resume,
# -LeftSize <bytes> -LeftMtime <ms>, or -LeftExitAt <ms>, is a left record's stat, which the last look
# checks the transcript against (a window passes it when its move rests on a left record).
#
# What it does, in order:
# 1. It checks its arguments: a session id is a lowercase UUID; a name is lowercase letters, digits and
#    hyphens; a folder is an absolute folder of the shape the plugins take (no quote, control character,
#    < > | ? * / or ';', no '.' or '..' part, no empty part, no part with spaces at either end), and is
#    there; an argument given empty refuses. -Lane reads lanes.json in the config folder
#    (CLAUDE_CONFIG_DIR, else %USERPROFILE%\.claude), takes that name's conversation and folder from its
#    entry, and says which; it never reads a transcript. Anything else stops it, saying why, before it
#    changes anything.
# 2. In Windows PowerShell 5.1, it sets PSModulePath to 5.1's own module folders: in a tab whose
#    environment puts PowerShell 7's first, 5.1 loads 7's modules and loses cmdlets.
# 3. It goes to the folder, and finds claude: %USERPROFILE%\.local\bin\claude.exe when it is there,
#    else the first claude application on PATH.
# 4. The last look, for -Resume, -Lane and -Start, as a launch's window and the claude wrapper take it
#    (RECHECK and LEFT_RECHECK in the plugins' machine code, line for line): no running Claude Code holds
#    the conversation, read again from the session registry of the config folder and of each -ConfigDir,
#    and from every process's command line; with a left record's stat, its transcript unchanged since.
#    Anything it can't read counts as held. Held, it stops, saying by what, and starts nothing: two
#    copies would both write the conversation.
# 5. Right before claude, the launch environment. It removes the variables Claude Code sets in the
#    processes it starts (a claude that inherits them is nested, and saves no transcript), NO_COLOR
#    among them; PSExecutionPolicyPreference (an -ExecutionPolicy on the command line that ran this
#    script was for this script alone); and CLAUDE_PANE_TOKEN (the claude wrapper's token for the tab a
#    session ran in: one resumed here has no tab of its own). It sets
#    CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 and CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1. It never
#    touches WT_SESSION or WT_PROFILE_ID: Claude Code reads WT_SESSION to draw its prompt and its links.
# 6. It runs claude with --resume <id>, or --session-id <id> --name <name>, or nothing else: never a
#    permission flag, so the session starts in the mode a new one would. Its exit code is claude's.

param([string]$Resume, [string]$Start, [string]$Name, [string]$Dir, [string]$Lane, [string[]]$ConfigDir, [string]$LeftSize, [string]$LeftMtime, [string]$LeftExitAt)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$SessionId = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z'
$AreaName = '^[a-z0-9][a-z0-9-]{0,39}\z'
$Whole = '^\d{1,16}\z'
# The launch environment: LAUNCH_ENV_CLEAR, LAUNCH_ENV_DROP and LAUNCH_ENV_SET in the plugins' machine code.
$Clear = 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_JOB_DIR', 'AI_AGENT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_SSE_PORT', 'NO_COLOR'
$Drop = 'PSExecutionPolicyPreference', 'CLAUDE_PANE_TOKEN'
$Set = [ordered]@{ CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1'; CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP = '1' }

function Stop-Launch($why) {
  Write-Host ('claude-launch: ' + $why + ' Nothing was started.')
  exit 2
}

# An absolute folder of the shape the plugins take (isSafeFolder in their machine code): a drive, a
# colon and a backslash first; at most 240 characters; no quote of any kind, control character,
# < > | ? * or /, and no second colon; no '.' or '..' part, no empty part but a last one, and no part
# with spaces at either end.
function Test-Shape($path) {
  if ($path -isnot [string] -or $path.Length -lt 3 -or $path.Length -gt 240) { return $false }
  if ($path -cnotmatch '^[A-Za-z]:\\' -or $path -match '[\x00-\x1f\x7f-\x9f\x22\x27\u2018-\u201e<>|?*/]' -or $path.IndexOf(':', 2) -ge 0) { return $false }
  $parts = $path.Substring(3).Split('\')
  for ($i = 0; $i -lt $parts.Count; $i++) {
    if ($parts[$i] -eq '') { if ($i -ne $parts.Count - 1) { return $false } }
    elseif ($parts[$i] -eq '.' -or $parts[$i] -eq '..' -or $parts[$i] -match '^[\s\ufeff]|[\s\ufeff]$') { return $false }
  }
  return $true
}

# A folder a launch takes: of that shape, with no ';', and there.
function Test-Folder($path) { return ((Test-Shape $path) -and $path.IndexOf(';') -lt 0 -and (Test-Path -LiteralPath $path -PathType Container)) }

# Whether a running Claude Code holds conversation $id now: $null when none does, else why. RECHECK in
# the plugins' machine code, line for line: the session registries of $configDirs and every process's
# command line, read again. Anything it can't read counts as held.
function Get-Live($id, $configDirs) {
  try {
    $live = $null
    function Test-Exited($p) { $h = $null; try { $h = [Diagnostics.Process]::GetProcessById([int]$p.ProcessId); return $h.HasExited } catch { return ($_.Exception -is [ArgumentException] -or $_.Exception.InnerException -is [ArgumentException]) } finally { if ($null -ne $h) { $h.Dispose() } } }
    $procs = @{}
    foreach ($p in (Get-CimInstance -ClassName Win32_Process -Property ProcessId, Name, CreationDate, CommandLine)) { $procs[[int]$p.ProcessId] = $p }
    $snapshotFt = [DateTime]::UtcNow.ToFileTimeUtc()
    $elsewhere = @{}
    foreach ($dir in $configDirs) {
      $reg = Join-Path $dir "sessions"
      if ($null -ne $live -or -not (Test-Path -LiteralPath $reg -PathType Container)) { continue }
      foreach ($f in @(Get-ChildItem -LiteralPath $reg -Filter "*.json" -File -Force)) {
        $p = $null
        if ($f.BaseName -match "^\d{1,10}\z") { $p = $procs[[int]$f.BaseName] }
        if ($null -eq $p -or $p.Name -ne "claude.exe") { continue }
        if (Test-Exited $p) { continue }
        $e = $null
        for ($try = 1; $try -le 3 -and $null -eq $e; $try++) {
          try { $e = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $e = $null }
          if ($null -ne $e -and ($e.sessionId -isnot [string] -or $null -eq $e.procStart)) { $e = $null }
          if ($null -eq $e -and $try -lt 3) { Start-Sleep -Milliseconds 250 }
        }
        if ($null -eq $e) { $live = "whether it is open elsewhere is unknown: the registry file of Claude Code $($f.BaseName) could not be read, three times, or has another shape"; break }
        $near = $false
        try { $near = [math]::Abs([double]$p.CreationDate.ToFileTimeUtc() - [double]$e.procStart) -le 10000 } catch { $near = $false }
        if ($e.sessionId -eq $id) {
          if ($near) { $live = "it is open elsewhere: Claude Code $($f.BaseName) holds it (L1)" } else { $live = "it may be open elsewhere: the registry file of running Claude Code $($f.BaseName) names it, though its procStart is not that process start time (a stale file, or a format this check does not know)" }
          break
        }
        $named = $false
        foreach ($prop in $e.PSObject.Properties) { if ($prop.Name -cne "sessionId" -and $prop.Name -cne "cwd" -and $prop.Name -cne "name" -and "$(ConvertTo-Json -InputObject $prop.Value -Compress -Depth 8)".IndexOf($id, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $named = $true } }
        if ($named) { $live = "it may be open elsewhere: the registry file of running Claude Code $($f.BaseName) names it outside its sessionId"; break }
        $pidOk = $false
        try { $pidOk = [long]$e.pid -eq [long]$p.ProcessId } catch { $pidOk = $false }
        if ($near -and $pidOk -and ($snapshotFt - [long]$p.CreationDate.ToFileTimeUtc()) -gt 600000000 -and $e.sessionId -match "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z") { $elsewhere[[int]$p.ProcessId] = $true }
      }
    }
    if ($null -eq $live) { foreach ($p in $procs.Values) { if ($null -eq $live -and $p.ProcessId -ne $PID -and -not $elsewhere.ContainsKey([int]$p.ProcessId) -and "$($p.CommandLine)" -match "(^|[\s\x22])(--resume|--session-id|-r)(\s+|=)[\x22\x27]?$id" -and -not (Test-Exited $p)) { $live = "it is open elsewhere: process $($p.ProcessId) names it on its command line (L2)" } } }
  } catch { $live = 'whether it is open elsewhere is unknown: the registry or the process table could not be read (' + $_.Exception.Message + ')' }
  return $live
}

# Whether conversation $id's transcript changed since its left record's stat: $null when it didn't,
# else why. LEFT_RECHECK in the plugins' machine code, line for line, after Get-Live found nothing.
# Anything it can't read counts as changed.
function Test-Left($id, $configDirs, $leftSize, $leftMtime, $leftExitAt) {
  $live = $null
  try {
    if ($null -eq $live) {
      $seen = @(foreach ($dir in $configDirs) { $projects = Join-Path $dir "projects"; if (Test-Path -LiteralPath $projects -PathType Container) { foreach ($d in @(Get-ChildItem -LiteralPath $projects -Directory -Force)) { $tx = Join-Path $d.FullName ($id + ".jsonl"); if (Test-Path -LiteralPath $tx -PathType Leaf) { Get-Item -LiteralPath $tx -Force } } } })
      if ($seen.Count -ne 1) { $live = "its transcript is not one file on this machine now (" + $seen.Count + " found), so whether it changed since it was left is unknown" }
      elseif ($null -ne $leftExitAt) { if (([DateTimeOffset]$seen[0].LastWriteTimeUtc).ToUnixTimeMilliseconds() -gt ([long]$leftExitAt + 10000)) { $live = "its transcript was written after it was left (another process may have resumed it)" } }
      elseif ([long]$seen[0].Length -ne [long]$leftSize -or ([DateTimeOffset]$seen[0].LastWriteTimeUtc).ToUnixTimeMilliseconds() -ne [long]$leftMtime) { $live = "its transcript changed since it was left (another process may have resumed it)" }
    }
  } catch { $live = 'whether its transcript changed since it was left is unknown (' + $_.Exception.Message + ')' }
  return $live
}

# 1. The arguments, each checked before anything changes.
foreach ($k in 'Resume', 'Start', 'Name', 'Dir', 'Lane', 'LeftSize', 'LeftMtime', 'LeftExitAt') {
  if ($PSBoundParameters.ContainsKey($k) -and [string]::IsNullOrEmpty($PSBoundParameters[$k])) { Stop-Launch ('-' + $k + ' was given empty.') }
}
$modes = 0
foreach ($given in $Resume, $Start, $Lane) { if ($given) { $modes++ } }
if ($modes -gt 1) { Stop-Launch 'give one of -Resume, -Start and -Lane.' }
if ($Name -and -not $Start) { Stop-Launch '-Name goes with -Start.' }
if ($PSBoundParameters.ContainsKey('ConfigDir')) {
  if ($modes -eq 0) { Stop-Launch '-ConfigDir goes with -Resume, -Start or -Lane.' }
  if (@($ConfigDir).Count -lt 1 -or @($ConfigDir).Count -gt 8) { Stop-Launch '-ConfigDir takes 1 to 8 config folders.' }
  foreach ($c in @($ConfigDir)) { if (-not (Test-Shape $c)) { Stop-Launch '-ConfigDir takes absolute folders, with no quote, control character, < > | ? * or /, and no . or .. part.' } }
}
$leftGiven = [bool]($LeftSize -or $LeftMtime -or $LeftExitAt)
if ($leftGiven) {
  if (-not $Resume) { Stop-Launch 'a left record''s stat goes with -Resume.' }
  if ($LeftExitAt) { if ($LeftSize -or $LeftMtime -or $LeftExitAt -cnotmatch $Whole) { Stop-Launch '-LeftExitAt goes alone, a whole number.' } }
  elseif (-not $LeftSize -or -not $LeftMtime -or $LeftSize -cnotmatch $Whole -or $LeftMtime -cnotmatch $Whole) { Stop-Launch '-LeftSize and -LeftMtime go together, whole numbers.' }
}
$config = $null
if ($env:CLAUDE_CONFIG_DIR) { $config = $env:CLAUDE_CONFIG_DIR } elseif ($env:USERPROFILE) { $config = Join-Path $env:USERPROFILE '.claude' }
if ($Lane) {
  if ($Dir) { Stop-Launch '-Lane takes its folder from lanes.json: give no -Dir.' }
  if ($Lane -cnotmatch $AreaName) { Stop-Launch 'a session name is lowercase letters, digits and hyphens.' }
  if ($null -eq $config) { Stop-Launch 'no config folder is known here (CLAUDE_CONFIG_DIR, else %USERPROFILE%\.claude).' }
  $lanesFile = Join-Path $config 'lanes.json'
  if (-not (Test-Path -LiteralPath $lanesFile -PathType Leaf)) { Stop-Launch ('there is no ' + $lanesFile + '.') }
  $doc = $null
  try { $doc = [IO.File]::ReadAllText($lanesFile, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { $doc = $null }
  if ($doc -isnot [Management.Automation.PSCustomObject] -or $doc.v -isnot [ValueType] -or $doc.v -ne 1 -or $doc.lanes -isnot [Management.Automation.PSCustomObject]) { Stop-Launch ($lanesFile + ' is not of its shape.') }
  $entry = $null
  foreach ($p in $doc.lanes.PSObject.Properties) { if ($p.Name -ceq $Lane) { $entry = $p.Value } }
  if ($null -eq $entry) { Stop-Launch ('lanes.json names no session ' + $Lane + '.') }
  if ($entry.session -isnot [string] -or $entry.session -cnotmatch $SessionId) { Stop-Launch ('the entry for ' + $Lane + ' names no conversation by its id.') }
  if (-not (Test-Folder $entry.folder)) { Stop-Launch ('the entry for ' + $Lane + ' names no folder that is there.') }
  # The conversation and its folder come from the entry, never from the name; said, so you know which.
  $Resume = $entry.session
  $Dir = $entry.folder
  Write-Host ('claude-launch: -Lane ' + $Lane + ' is conversation ' + $Resume + ', in ' + $Dir + '.')
}
if ($Resume -and $Resume -cnotmatch $SessionId) { Stop-Launch '-Resume takes a session id (a lowercase UUID).' }
if ($Start) {
  if ($Start -cnotmatch $SessionId) { Stop-Launch '-Start takes a session id (a lowercase UUID).' }
  if (-not $Name -or $Name -cnotmatch $AreaName) { Stop-Launch '-Start takes -Name: lowercase letters, digits and hyphens.' }
}
if ($Dir -and -not (Test-Folder $Dir)) { Stop-Launch '-Dir takes an absolute folder that is there, with no quote, control character, semicolon, < > | ? * or /, and no . or .. part.' }
# The config folders the last look reads: this one first, then each -ConfigDir, each once.
$lookIn = @()
if ($Resume -or $Start) {
  if (-not (Test-Shape $config)) { Stop-Launch 'the config folder (CLAUDE_CONFIG_DIR, else %USERPROFILE%\.claude) is not an absolute folder the last look can read.' }
  foreach ($c in @($config) + @($ConfigDir | Where-Object { $null -ne $_ })) {
    $plain = $c
    if ($plain.Length -gt 3) { $plain = $plain.TrimEnd([char]92) }
    if (@($lookIn | Where-Object { $_ -ieq $plain }).Count -eq 0) { $lookIn += $plain }
  }
}

# 2. Windows PowerShell 5.1's own module folders.
if ($PSVersionTable.PSEdition -ne 'Core') {
  $env:PSModulePath = @([Environment]::GetFolderPath('MyDocuments') + '\WindowsPowerShell\Modules', [Environment]::GetFolderPath('ProgramFiles') + '\WindowsPowerShell\Modules', [Environment]::GetFolderPath('System') + '\WindowsPowerShell\v1.0\Modules') -join ';'
}

# 3. The folder, and claude.
if ($Dir) { Set-Location -LiteralPath $Dir }
$exe = $null
if ($env:USERPROFILE) {
  $pinned = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
  if (Test-Path -LiteralPath $pinned -PathType Leaf) { $exe = $pinned }
}
if ($null -eq $exe) {
  $found = @(Get-Command -Name 'claude' -CommandType Application -ErrorAction SilentlyContinue)
  if ($found.Count -gt 0) { $exe = $found[0].Source }
}
if ($null -eq $exe) { Stop-Launch 'no claude.exe was found (in %USERPROFILE%\.local\bin, or on PATH).' }

# 4. The last look, right before the environment and claude.
if ($Resume -or $Start) {
  $lookId = $Resume
  if ($Start) { $lookId = $Start }
  $why = Get-Live $lookId $lookIn
  if ($null -eq $why -and $leftGiven) {
    $size = $null; $mtime = $null; $exitAt = $null
    if ($LeftExitAt) { $exitAt = [long]$LeftExitAt } else { $size = [long]$LeftSize; $mtime = [long]$LeftMtime }
    $why = Test-Left $lookId $lookIn $size $mtime $exitAt
  }
  if ($null -ne $why) { Stop-Launch ('conversation ' + $lookId + ' is not run here, so that two copies never write it: ' + $why + '.') }
}

# 5. The launch environment, right before claude. Removed, not set to empty: [NullString]::Value, since
# PowerShell passes $null to a .NET string as "", and PowerShell 7 keeps a variable set to "".
foreach ($n in $Clear) { [Environment]::SetEnvironmentVariable($n, [NullString]::Value, [EnvironmentVariableTarget]::Process) }
foreach ($n in $Drop) { [Environment]::SetEnvironmentVariable($n, [NullString]::Value, [EnvironmentVariableTarget]::Process) }
foreach ($n in $Set.Keys) { [Environment]::SetEnvironmentVariable($n, $Set[$n], [EnvironmentVariableTarget]::Process) }

# 6. claude, and its exit code.
if ($Resume) { & $exe --resume $Resume }
elseif ($Start) { & $exe --session-id $Start --name $Name }
else { & $exe }
exit $LASTEXITCODE
