# claude-launch.ps1: starts Claude Code as a top-level session. The one script in
# claude-code-self-tools that runs claude: every launch (a restart's or a switch's window, the
# coordinator's go, a steward's launch, and you by hand) comes through it.
#
# Part of self-switch (claude-code-self-tools, plugins/self-switch/slot/claude-launch.ps1). Copy it,
# unchanged, beside the slot runner: %LOCALAPPDATA%\claude-self-tools\claude-launch.ps1. The plugins
# run it only from there, and only when its SHA-256 is the one they ship (LAUNCH_SCRIPT_SHA256).
#
# By hand, in a terminal:
#   claude-launch.ps1 -Resume <session id> [-Dir <folder>]               resume a conversation
#   claude-launch.ps1 -Start <session id> -Name <name> [-Dir <folder>]   start one with that id and name
#   claude-launch.ps1 -Lane <name>                                        resume a session's current
#                                                                         conversation, by its name
#   claude-launch.ps1 [-Dir <folder>]                                     start a new session
#
# What it does, in order:
# 1. It checks its arguments: a session id is a lowercase UUID; a name is lowercase letters, digits and
#    hyphens; a folder is an absolute folder with no quote, control character or ';', and is there.
#    -Lane reads lanes.json in the config folder (CLAUDE_CONFIG_DIR, else %USERPROFILE%\.claude), and
#    takes that name's conversation and folder from its entry; it never reads a transcript. Anything
#    else stops it, saying why, before it changes anything.
# 2. In Windows PowerShell 5.1, it sets PSModulePath to 5.1's own module folders: in a tab whose
#    environment puts PowerShell 7's first, 5.1 loads 7's modules and loses cmdlets.
# 3. It goes to the folder, and finds claude: %USERPROFILE%\.local\bin\claude.exe when it is there,
#    else the first claude application on PATH.
# 4. Right before claude, the launch environment. It removes the variables Claude Code sets in the
#    processes it starts (a claude that inherits them is nested, and saves no transcript), NO_COLOR
#    among them, and PSExecutionPolicyPreference (an -ExecutionPolicy on the command line that ran this
#    script was for this script alone). It sets CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 and
#    CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1. It never touches WT_SESSION or WT_PROFILE_ID: Claude
#    Code reads WT_SESSION to draw its prompt and its links.
# 5. It runs claude with --resume <id>, or --session-id <id> --name <name>, or nothing else: never a
#    permission flag, so the session starts in the mode a new one would. Its exit code is claude's.

param([string]$Resume, [string]$Start, [string]$Name, [string]$Dir, [string]$Lane)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$SessionId = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z'
$AreaName = '^[a-z0-9][a-z0-9-]{0,39}\z'
# The launch environment: LAUNCH_ENV_CLEAR and LAUNCH_ENV_SET in the plugins' machine code.
$Clear = 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_JOB_DIR', 'AI_AGENT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_SSE_PORT', 'NO_COLOR'
$Set = [ordered]@{ CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1'; CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP = '1' }

function Stop-Launch($why) {
  Write-Host ('claude-launch: ' + $why + ' Nothing was started.')
  exit 2
}

# An absolute folder with no quote, control character or ';', no . or .. part, at most 240 characters, that is there.
function Test-Folder($path) {
  if ($path -isnot [string] -or $path.Length -lt 3 -or $path.Length -gt 240) { return $false }
  if ($path -cnotmatch '^[A-Za-z]:\\' -or $path -match '[\x00-\x1f\x22\x27\u2018-\u201e<>|?*;/]' -or $path.IndexOf(':', 2) -ge 0) { return $false }
  foreach ($part in $path.Substring(3).Split('\')) { if ($part -eq '.' -or $part -eq '..') { return $false } }
  return (Test-Path -LiteralPath $path -PathType Container)
}

# 1. The arguments, each checked before anything changes.
$modes = 0
foreach ($given in $Resume, $Start, $Lane) { if ($given) { $modes++ } }
if ($modes -gt 1) { Stop-Launch 'give one of -Resume, -Start and -Lane.' }
if ($Name -and -not $Start) { Stop-Launch '-Name goes with -Start.' }
if ($Lane) {
  if ($Dir) { Stop-Launch '-Lane takes its folder from lanes.json: give no -Dir.' }
  if ($Lane -cnotmatch $AreaName) { Stop-Launch 'a session name is lowercase letters, digits and hyphens.' }
  $config = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
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
  # The conversation and its folder come from the entry, never from the name.
  $Resume = $entry.session
  $Dir = $entry.folder
}
if ($Resume -and $Resume -cnotmatch $SessionId) { Stop-Launch '-Resume takes a session id (a lowercase UUID).' }
if ($Start) {
  if ($Start -cnotmatch $SessionId) { Stop-Launch '-Start takes a session id (a lowercase UUID).' }
  if (-not $Name -or $Name -cnotmatch $AreaName) { Stop-Launch '-Start takes -Name: lowercase letters, digits and hyphens.' }
}
if ($Dir -and -not (Test-Folder $Dir)) { Stop-Launch '-Dir takes an absolute folder that is there, with no quote, control character or semicolon.' }

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

# 4. The launch environment, right before claude. Removed, not set to empty: [NullString]::Value, since
# PowerShell passes $null to a .NET string as "", and PowerShell 7 keeps a variable set to "".
foreach ($n in $Clear) { [Environment]::SetEnvironmentVariable($n, [NullString]::Value, [EnvironmentVariableTarget]::Process) }
[Environment]::SetEnvironmentVariable('PSExecutionPolicyPreference', [NullString]::Value, [EnvironmentVariableTarget]::Process)
foreach ($n in $Set.Keys) { [Environment]::SetEnvironmentVariable($n, $Set[$n], [EnvironmentVariableTarget]::Process) }

# 5. claude, and its exit code.
if ($Resume) { & $exe --resume $Resume }
elseif ($Start) { & $exe --session-id $Start --name $Name }
else { & $exe }
exit $LASTEXITCODE
