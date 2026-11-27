# claude-layout.ps1: opens the Windows Terminal windows and tabs placement.json names, each tab an idle
# slot. Nothing runs it but you, by hand, once (or again after Windows Terminal lost its windows).
#
# Part of self-switch (claude-code-self-tools, plugins/self-switch/slot/claude-layout.ps1). Copy it,
# unchanged, beside the slot runner, to %LOCALAPPDATA%\claude-self-tools\claude-layout.ps1. Then:
#
#   powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%LOCALAPPDATA%\claude-self-tools\claude-layout.ps1"          prints every command, runs none
#   powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%LOCALAPPDATA%\claude-self-tools\claude-layout.ps1" -Apply   runs them
#
# -Placement <file> reads another file than %LOCALAPPDATA%\claude-self-tools\placement.json. The file's
# presets ship as plugins/self-switch/slot/placement.example.json, four windows of generic lanes to rename:
#   claude-1: lane-a, lane-b   claude-2: lane-c
#   claude-3: lane-d, lane-e, lane-f   claude-4: overflow
#
# What it does:
# - It checks the file by the rules of readPlacement in the plugins' machine code (one shared list of good
#   and bad files holds the two equal): window names of letters, digits, _ and -, never 0, last, new, _quake,
#   -1 or all digits; tab labels; folders absolute, there, with no quote, semicolon or % (Windows Terminal expands
#   a % in them); positions and sizes in range; maximized true; a rect only for the plain window (a launch's or a
#   restart's window with no name), never a named one; a grid (#91) of 1 to 16 named windows, each with one of a
#   rect and maximized, and session names as its tabs, each name in one window once; unknown keys refused, naming
#   them. Anything wrong, and it says what, and runs nothing. It opens nothing from the grid: self-switch's
#   launch_sessions tool does that.
# - It needs the slot runner at %LOCALAPPDATA%\claude-self-tools\claude-slot.ps1, with the SHA-256 the
#   plugins ship, read by .NET; and with -Apply, Windows Terminal of 1.19 or later (it forwards a tab's
#   environment, which the tab's stamp needs).
# - For each window in order, for each tab, it sets CLAUDE_SELF_TOOLS_WT_WINDOW and CLAUDE_SELF_TOOLS_WT_TAB
#   in its own process, then runs wt.exe, by its full path under %LOCALAPPDATA%\Microsoft\WindowsApps, by Start-Process with one quoted string: the window by its name,
#   -M when it is maximized, its position and size, on the first tab only, and the tab running the slot runner with -Idle. So no
#   tab starts a Claude Code: Enter does that, or a launch. 2 seconds between calls, since Windows Terminal
#   creates a window by name asynchronously. A window of that name that is there already simply gains tabs.
# - It clears NO_COLOR and the variables Claude Code sets in the processes it starts in its own process
#   first, so the tabs don't inherit them when you run this from a session's shell. It never touches
#   WT_SESSION or WT_PROFILE_ID. It never closes or changes a window; it never starts claude.
#
# Windows Terminal setting (your choice): firstWindowPreference "persistedWindowLayout" keeps the names,
# positions and tabs across a restart of Windows Terminal. Without it, run this again.

param([switch]$Apply, [switch]$WhatIf, [string]$Placement)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:PSModulePath = @([Environment]::GetFolderPath("MyDocuments") + "\WindowsPowerShell\Modules", [Environment]::GetFolderPath("ProgramFiles") + "\WindowsPowerShell\Modules", [Environment]::GetFolderPath("System") + "\WindowsPowerShell\v1.0\Modules") -join ";"

# The slot runner this release ships.
$SlotSha = 'f16afee8fa1487aaf6ea87f0b22b07cee18d8bd314d5ef5a28e4ba2b000703cf'
# Set by Claude Code in the processes it starts, and NO_COLOR: LAUNCH_ENV_CLEAR in the plugins' machine code.
$Clear = 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_JOB_DIR', 'AI_AGENT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_SSE_PORT', 'NO_COLOR'
foreach ($n in $Clear) { [Environment]::SetEnvironmentVariable($n, [NullString]::Value, [EnvironmentVariableTarget]::Process) }

function Stop-Layout($why) {
  Write-Host ('claude-layout: ' + $why + ' Nothing was run.')
  exit 2
}

function Get-Sha256($path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  if ([IO.FileInfo]::new($path).Length -gt 65536) { return $null }
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hasher.ComputeHash([IO.File]::ReadAllBytes($path))).Replace("-", "").ToLowerInvariant() } finally { $hasher.Dispose() }
}

# The rules of readPlacement in the plugins' machine code, in the same order.
$script:Errors = New-Object System.Collections.ArrayList
function Add-Fault($what) { [void]$script:Errors.Add($what) }
function Test-Object($value) { return ($value -is [Management.Automation.PSCustomObject]) }
# Whether the object has the key at all: a key given as null is there, as readPlacement reads it, and checked.
function Test-Has($value, $name) { return ($null -ne $value.PSObject.Properties[$name]) }
# A whole number however the JSON writes it (100, 100.0, 1e2), as readPlacement reads one: ConvertFrom-Json gives
# Int32, Int64, Decimal or Double in Windows PowerShell 5.1 and Int64, Double or BigInteger in PowerShell 7, and
# each is read as the double JSON.parse reads it, then held to whole, finite and the bounds. A string or a
# boolean is no number.
function Test-Whole($value, $low, $high) {
  if ($null -eq $value -or @('System.Int32', 'System.Int64', 'System.Decimal', 'System.Double', 'System.Numerics.BigInteger') -cnotcontains $value.GetType().FullName) { return $false }
  $number = [double]$value
  return (-not [double]::IsNaN($number) -and -not [double]::IsInfinity($number) -and [math]::Floor($number) -eq $number -and $number -ge $low -and $number -le $high)
}
function Test-WindowName($name) { return ($name -is [string] -and $name -cmatch '^[A-Za-z0-9_-]{1,40}\z' -and $name -notmatch '^-?\d+\z' -and $name -notmatch '^(new|last|_quake)\z') }
function Test-TabLabel($label) { return ($label -is [string] -and $label -cmatch '^[A-Za-z0-9 ._-]{1,40}\z') }
# A session's name, as --name and lanes.json take it: AREA_NAME in the plugins' machine code.
function Test-SessionName($name) { return ($name -is [string] -and $name -cmatch '^[a-z0-9][a-z0-9-]{0,39}\z') }
function Test-Rect($rect) { return ($rect -is [array] -and $rect.Count -eq 4 -and (Test-Whole $rect[0] -32768 32768) -and (Test-Whole $rect[1] -32768 32768) -and (Test-Whole $rect[2] 320 32768) -and (Test-Whole $rect[3] 200 32768)) }
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
function Test-WtFolder($path) { return ((Test-Shape $path) -and $path.IndexOf(';') -lt 0 -and $path.IndexOf('%') -lt 0) }
# A set of names, compared ordinal and ignoring case, never by culture (a bare @{} compares by the current culture's
# rules, from memory: under tr-TR, I and i are two letters): window names and tab labels, as readPlacement folds them.
function New-NameSet { return [System.Collections.Hashtable]::new([System.StringComparer]::OrdinalIgnoreCase) }
function Test-Keys($value, $allowed, $where) {
  foreach ($p in $value.PSObject.Properties) { if ($allowed -cnotcontains $p.Name) { Add-Fault ($where + ' has an unknown key ' + $p.Name) } }
}
function Test-Maximized($value, $where) {
  if ((Test-Has $value 'maximized') -and -not ($value.maximized -is [bool] -and $value.maximized)) { Add-Fault ($where + ' has a maximized that is not true (leave it out for a window that is not maximized)') }
}
# A named window's place (a layout window's too): pos, size and maximized; a rect is not built for one.
function Test-Place($value, $where) {
  if ((Test-Has $value 'pos') -and -not ($value.pos -is [array] -and $value.pos.Count -eq 2 -and (Test-Whole $value.pos[0] -32768 32768) -and (Test-Whole $value.pos[1] -32768 32768))) { Add-Fault ($where + ' has a pos that is not two whole numbers within 32768') }
  if ((Test-Has $value 'size') -and -not ($value.size -is [array] -and $value.size.Count -eq 2 -and (Test-Whole $value.size[0] 20 400) -and (Test-Whole $value.size[1] 5 200))) { Add-Fault ($where + ' has a size that is not 20-400 columns and 5-200 rows') }
  Test-Maximized $value $where
  if (Test-Has $value 'rect') { Add-Fault ($where + ' has a rect, which a named window does not take (not built): give it pos, in pixels, and size, in columns and rows') }
}
# The plain window's place (a window with no name): rect, maximized or both; never pos or size.
function Test-Plain($value, $where) {
  if ((Test-Has $value 'pos') -or (Test-Has $value 'size')) { Add-Fault ($where + ' has no name, so it is the plain window, which takes rect and maximized: pos and size are a named window''s') }
  if ((Test-Has $value 'rect') -and -not (Test-Rect $value.rect)) { Add-Fault ($where + ' has a rect that is not four whole numbers [x, y, width, height]: x and y within 32768, a width of 320 to 32768 and a height of 200 to 32768') }
  Test-Maximized $value $where
  if (-not (Test-Has $value 'rect') -and -not (Test-Has $value 'maximized')) { Add-Fault ($where + ' has no name and no rect or maximized: name a window, or give the plain window its place') }
}
function Test-Prefer($value, $where) {
  if (-not ($value -is [array] -and $value.Count -ge 1 -and $value.Count -le 3)) { Add-Fault ($where + '.prefer is not a list of slot, tab and window'); return }
  $seen = @{}
  foreach ($v in $value) {
    if ($v -cnotin 'slot', 'tab', 'window') { Add-Fault ($where + '.prefer holds something other than slot, tab and window') }
    elseif ($seen.ContainsKey($v)) { Add-Fault ($where + '.prefer holds ' + $v + ' twice') }
    else { $seen[$v] = $true }
  }
}
# A section's window: by its name, a named window of Windows Terminal; with none, the plain window's place.
function Test-Window($value, $where) {
  if (-not (Test-Object $value)) { Add-Fault ($where + '.window is not an object'); return }
  Test-Keys $value @('name', 'pos', 'size', 'rect', 'maximized') ($where + '.window')
  if (-not (Test-Has $value 'name')) { Test-Plain $value ($where + '.window'); return }
  if (-not (Test-WindowName $value.name)) { Add-Fault ($where + '.window.name is not a name Windows Terminal takes as one') }
  Test-Place $value ($where + '.window')
}
function Get-PlacementFaults($doc) {
  if (-not (Test-Object $doc)) { Add-Fault 'it is not a JSON object'; return }
  Test-Keys $doc @('v', 'layout', 'launch', 'restart', 'workspaces', 'limits', 'afterBoot', 'grid') 'the file'
  if (-not (Test-Whole $doc.v 1 1)) { Add-Fault 'it is not version 1' }
  if ($doc.layout -isnot [array]) { Add-Fault 'layout is not a list' }
  else {
    $names = New-NameSet
    $at = 0
    foreach ($w in $doc.layout) {
      $here = 'layout[' + $at + ']'
      $at++
      if (-not (Test-Object $w)) { Add-Fault ($here + ' is not an object'); continue }
      Test-Keys $w @('window', 'pos', 'size', 'maximized', 'rect', 'tabs', 'folder') $here
      if (-not (Test-WindowName $w.window)) { Add-Fault ($here + '.window is not a name Windows Terminal takes as one') }
      elseif ($names.ContainsKey($w.window)) { Add-Fault ($here + '.window names a window twice') }
      else { $names[$w.window] = $true }
      Test-Place $w $here
      if (-not ($w.tabs -is [array] -and $w.tabs.Count -ge 1)) { Add-Fault ($here + '.tabs is not a list of tab labels') }
      else {
        $labels = New-NameSet
        foreach ($t in $w.tabs) {
          if (-not (Test-TabLabel $t)) { Add-Fault ($here + '.tabs holds something that is not a tab label') }
          elseif ($labels.ContainsKey($t)) { Add-Fault ($here + '.tabs holds a label twice') }
          else { $labels[$t] = $true }
        }
      }
      if (-not (Test-WtFolder $w.folder)) { Add-Fault ($here + '.folder is not an absolute folder with no quote, semicolon or %') }
      elseif (-not (Test-Path -LiteralPath $w.folder -PathType Container)) { Add-Fault ($here + '.folder is not there') }
    }
  }
  if (Test-Has $doc 'launch') {
    if (-not (Test-Object $doc.launch)) { Add-Fault 'launch is not an object' }
    else {
      Test-Keys $doc.launch @('prefer', 'tab', 'window') 'launch'
      Test-Prefer $doc.launch.prefer 'launch'
      if (Test-Has $doc.launch 'tab') {
        if (-not (Test-Object $doc.launch.tab)) { Add-Fault 'launch.tab is not an object' }
        else {
          Test-Keys $doc.launch.tab @('window', 'maxTabs') 'launch.tab'
          if (-not (Test-WindowName $doc.launch.tab.window)) { Add-Fault 'launch.tab.window is not a name Windows Terminal takes as one' }
          elseif ($doc.launch.tab.window -ceq 'same') { Add-Fault 'launch.tab.window is same, which only restart.tab takes' }
          if (-not (Test-Whole $doc.launch.tab.maxTabs 1 16)) { Add-Fault 'launch.tab.maxTabs is not a whole number from 1 to 16' }
        }
      }
      if (Test-Has $doc.launch 'window') { Test-Window $doc.launch.window 'launch' }
    }
  }
  if (Test-Has $doc 'restart') {
    if (-not (Test-Object $doc.restart)) { Add-Fault 'restart is not an object' }
    else {
      Test-Keys $doc.restart @('prefer', 'tab', 'window') 'restart'
      Test-Prefer $doc.restart.prefer 'restart'
      if (Test-Has $doc.restart 'tab') {
        if (-not (Test-Object $doc.restart.tab)) { Add-Fault 'restart.tab is not an object' }
        else {
          Test-Keys $doc.restart.tab @('window') 'restart.tab'
          if ($doc.restart.tab.window -cne 'same' -and -not (Test-WindowName $doc.restart.tab.window)) { Add-Fault 'restart.tab.window is neither same nor a name Windows Terminal takes as one' }
        }
      }
      if (Test-Has $doc.restart 'window') { Test-Window $doc.restart.window 'restart' }
    }
  }
  if (Test-Has $doc 'workspaces') {
    if (-not (Test-Object $doc.workspaces)) { Add-Fault 'workspaces is not an object' }
    else {
      foreach ($p in $doc.workspaces.PSObject.Properties) {
        if (-not (Test-WindowName $p.Name)) { Add-Fault ('workspaces has a key that is not a window name: ' + $p.Name) }
        if ($p.Value -isnot [string] -or $p.Value -cnotmatch '^(default|w_[a-z0-9]{12})\z') { Add-Fault ('workspaces.' + $p.Name + ' is not a workspace id') }
      }
    }
  }
  if (Test-Has $doc 'limits') {
    if (-not (Test-Object $doc.limits)) { Add-Fault 'limits is not an object' }
    else {
      Test-Keys $doc.limits @('minFreeGb', 'maxSessions') 'limits'
      if ((Test-Has $doc.limits 'minFreeGb') -and -not (Test-Whole $doc.limits.minFreeGb 1 64)) { Add-Fault 'limits.minFreeGb is not a whole number from 1 to 64' }
      if ((Test-Has $doc.limits 'maxSessions') -and -not (Test-Whole $doc.limits.maxSessions 1 40)) { Add-Fault 'limits.maxSessions is not a whole number from 1 to 40' }
    }
  }
  if (Test-Has $doc 'afterBoot') {
    if (-not (Test-Object $doc.afterBoot)) { Add-Fault 'afterBoot is not an object' }
    else {
      Test-Keys $doc.afterBoot @('fltFix') 'afterBoot'
      if ((Test-Has $doc.afterBoot 'fltFix') -and -not ((Test-WtFolder $doc.afterBoot.fltFix) -and $doc.afterBoot.fltFix -match '\.ps1\z' -and (Test-Path -LiteralPath $doc.afterBoot.fltFix -PathType Leaf))) { Add-Fault 'afterBoot.fltFix is not an absolute .ps1 file that is there, with no quote, semicolon or %' }
    }
  }
  # The grid (#91): checked here, and nothing opened from it. launch_sessions, a self-switch tool, opens its windows.
  if (Test-Has $doc 'grid') {
    if (-not (Test-Object $doc.grid)) { Add-Fault 'grid is not an object' }
    else {
      Test-Keys $doc.grid @('windows') 'grid'
      $list = $doc.grid.windows
      if (-not ($list -is [array] -and $list.Count -ge 1 -and $list.Count -le 16)) { Add-Fault 'grid.windows is not a list of 1 to 16 windows' }
      else {
        # Two window names that differ only in case are one here, as readPlacement reads them (New-NameSet).
        $gridNames = New-NameSet
        $gridSessions = New-NameSet
        $at = 0
        foreach ($w in $list) {
          $here = 'grid.windows[' + $at + ']'
          $at++
          if (-not (Test-Object $w)) { Add-Fault ($here + ' is not an object'); continue }
          Test-Keys $w @('window', 'rect', 'maximized', 'tabs') $here
          if (-not (Test-WindowName $w.window)) { Add-Fault ($here + '.window is not a name Windows Terminal takes as one') }
          elseif ($gridNames.ContainsKey($w.window)) { Add-Fault ($here + '.window names a window twice') }
          else { $gridNames[$w.window] = $true }
          if ((Test-Has $w 'rect') -and -not (Test-Rect $w.rect)) { Add-Fault ($here + ' has a rect that is not four whole numbers [x, y, width, height]: x and y within 32768, a width of 320 to 32768 and a height of 200 to 32768') }
          Test-Maximized $w $here
          if ((Test-Has $w 'rect') -and (Test-Has $w 'maximized')) { Add-Fault ($here + ' has both a rect and maximized: a grid window takes one of them') }
          elseif (-not (Test-Has $w 'rect') -and -not (Test-Has $w 'maximized')) { Add-Fault ($here + ' has neither a rect nor maximized: a grid window takes one of them') }
          if (Test-Has $w 'tabs') {
            if (-not ($w.tabs -is [array] -and $w.tabs.Count -ge 1 -and $w.tabs.Count -le 16)) { Add-Fault ($here + '.tabs is not a list of 1 to 16 session names') }
            else {
              foreach ($t in $w.tabs) {
                if (-not (Test-SessionName $t)) { Add-Fault ($here + '.tabs holds something that is not a session name (lowercase letters, digits and hyphens, as --name takes)') }
                elseif ($gridSessions.ContainsKey($t)) { Add-Fault ($here + '.tabs names a session that a grid window names already') }
                else { $gridSessions[$t] = $true }
              }
            }
          }
        }
      }
    }
  }
}

# One element of wt's argument string, by Windows' quoting rules (CommandLineToArgvW): wrapped in double
# quotes when it holds a space; refused when it holds a double quote, or would end a quoted element in a
# backslash, which would escape the closing quote. wtArgument in the plugins' machine code.
function ConvertTo-WtArgument($element) {
  if ($element -eq '' -or $element.Contains('"') -or $element.Contains(';') -or $element.Contains('%')) { Stop-Layout ('an argument for Windows Terminal is empty, or holds a double quote, a semicolon or a percent sign: ' + $element + '.') }
  if ($element -notmatch '\s') { return $element }
  if ($element.EndsWith('\')) { Stop-Layout ('an argument with a space ends in a backslash: ' + $element + '.') }
  return '"' + $element + '"'
}

if ($Apply -and $WhatIf) { Stop-Layout 'give one of -Apply and -WhatIf.' }
if (-not $env:LOCALAPPDATA -or -not $env:SystemRoot) { Stop-Layout '%LOCALAPPDATA% or %SystemRoot% is not set.' }
$state = Join-Path $env:LOCALAPPDATA 'claude-self-tools'
if (-not $Placement) { $Placement = Join-Path $state 'placement.json' }
if (-not (Test-Path -LiteralPath $Placement -PathType Leaf)) { Stop-Layout ('there is no ' + $Placement + ': copy placement.example.json there, and edit it.') }
$doc = $null
try { $doc = [IO.File]::ReadAllText($Placement, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { Stop-Layout ($Placement + ' is not JSON.') }
Get-PlacementFaults $doc
if ($script:Errors.Count -gt 0) {
  foreach ($e in $script:Errors) { Write-Host ('refused: ' + $e) }
  Stop-Layout ($Placement + ' is not of its shape.')
}

$slotScript = Join-Path $state 'claude-slot.ps1'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-WtFolder $slotScript)) { Stop-Layout ('the slot runner''s path holds a quote, a semicolon or a %: ' + $slotScript + '.') }
if (-not (Test-WtFolder $powershell)) { Stop-Layout ('Windows PowerShell''s path holds a quote, a semicolon or a %: ' + $powershell + '.') }
# By its full path: a bare name would search the current folder too.
$wtExe = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wt.exe'

# Every tab's stamp and wt string, in order.
$commands = New-Object System.Collections.ArrayList
foreach ($w in $doc.layout) {
  $first = $true
  foreach ($tab in $w.tabs) {
    $folder = $w.folder
    if ($folder.Length -gt 3) { $folder = $folder.TrimEnd([char]92) }
    $elements = @('-w', $w.window)
    if ($first -and $w.maximized -eq $true) { $elements += @('-M') }
    # Checked whole above, however the JSON wrote them (100.0, 1e2): written to wt as whole numbers, as wtTabLine writes them.
    if ($first -and $null -ne $w.pos) { $elements += @('--pos', ('{0},{1}' -f [long][double]$w.pos[0], [long][double]$w.pos[1])) }
    if ($first -and $null -ne $w.size) { $elements += @('--size', ('{0},{1}' -f [long][double]$w.size[0], [long][double]$w.size[1])) }
    $elements += @('nt', '--title', $tab, '--suppressApplicationTitle', '-d', $folder, '--', $powershell, '-NoExit', '-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', $slotScript, '-Idle')
    $line = (@($elements | ForEach-Object { ConvertTo-WtArgument $_ }) -join ' ')
    [void]$commands.Add([ordered]@{ window = $w.window; tab = $tab; line = $line })
    $first = $false
  }
}

if (-not $Apply) {
  Write-Host ('claude-layout: -WhatIf, the default: ' + $commands.Count + ' tabs from ' + $Placement + ', nothing is run. -Apply runs these.')
  if ((Get-Sha256 $slotScript) -cne $SlotSha) { Write-Host ('note: the slot runner is not at ' + $slotScript + ' with the SHA-256 this release ships; -Apply refuses until it is.') }
  foreach ($c in $commands) { Write-Host ('[' + $c.window + ' / ' + $c.tab + '] wt.exe ' + $c.line) }
  exit 0
}

# The slot runner, by its pinned place and hash, before anything opens.
if ((Get-Sha256 $slotScript) -cne $SlotSha) { Stop-Layout ('the slot runner is not at ' + $slotScript + ' with the SHA-256 this release ships: copy it there, unchanged.') }
$terminal = $null
try {
  $found = @(Get-AppxPackage -Name 'Microsoft.WindowsTerminal*' | ForEach-Object { [version]$_.Version } | Sort-Object -Descending)
  if ($found.Count -gt 0) { $terminal = $found[0] }
} catch { $terminal = $null }
if ($null -eq $terminal -or $terminal -lt [version]'1.19') { Stop-Layout 'Windows Terminal of 1.19 or later is not installed: a tab''s stamp needs it to forward the environment.' }
if (-not (Test-Path -LiteralPath $wtExe -PathType Leaf)) { Stop-Layout ('Windows Terminal is not at ' + $wtExe + ', where this script runs it from.') }

foreach ($c in $commands) {
  $env:CLAUDE_SELF_TOOLS_WT_WINDOW = $c.window
  $env:CLAUDE_SELF_TOOLS_WT_TAB = $c.tab
  Write-Host ('[' + $c.window + ' / ' + $c.tab + '] wt.exe ' + $c.line)
  Start-Process $wtExe -ArgumentList $c.line
  Start-Sleep -Seconds 2
}
exit 0
