# claude-slot.ps1: a Windows Terminal pane that runs Claude Code, and runs it again here when told to.
#
# Part of self-switch (claude-code-self-tools, plugins/self-switch/slot/claude-slot.ps1). Slot runner
# version 2. Copy it, unchanged, to %LOCALAPPDATA%\claude-self-tools\claude-slot.ps1, and give a Windows
# Terminal profile this command line (the layout script, claude-layout.ps1, makes such tabs too):
#
#   powershell.exe -NoExit -NoProfile -ExecutionPolicy RemoteSigned -File "%LOCALAPPDATA%\claude-self-tools\claude-slot.ps1" -Idle
#
# -Idle starts in the waiting loop: Enter starts a session here, so opening the tab starts nothing.
# Without -Idle, it starts claude at once. -ExecutionPolicy RemoteSigned lets this unsigned local script
# run where the policy is Restricted, Windows' default; claude-launch.ps1 clears it again before claude
# starts, so claude and every PowerShell it starts get the machine's own policy.
#
# self-switch, self-restart and the coordinator use a pane as a slot only when the script it runs has the
# SHA-256 they ship, so a copy that was edited is never used as one: that pane then works as a plain pane
# does. After copying a new version, restart the slot panes: a pane keeps running the script it started with.
#
# Every claude it starts goes through claude-launch.ps1, and only the copy a launch put at its hash's own
# name in the same folder, claude-launch-<the first 8 hex digits of its SHA-256>.ps1. A record's `launcher`
# field, or -Launcher for a tab, names that SHA-256, from the plugin's pin; the runner reads the file's
# hash again right before it runs it. A field missing, or a file with another hash, starts nothing and
# says what to do. So a new launcher needs no new runner, and no pane needs a restart for one. Enter has
# no record to name one: it runs the highest version among the copies there whose SHA-256 begins with the
# digits in their name. It never runs claude-launch.ps1 itself: that copy is yours, to run by hand. It
# holds no launch environment of its own: the launcher applies it.
#
# What it does:
# - It keeps a beacon, %LOCALAPPDATA%\claude-self-tools\slots\<pid>-<created>.state.json: idle or running,
#   since when, the window and tab it was stamped with (CLAUDE_SELF_TOOLS_WT_WINDOW, _TAB, each checked,
#   else left out), its config folder, which claude it runs, and the SHA-256 this process started from, which
#   tells a launch what it really runs. It says running from before a tab's wait, so no launch takes it for idle. Written at its start, at each claude
#   start and each time it goes idle. A launch of another session uses a slot only when it says idle.
# - With -Start <uuid> -Name <name> -Claim launch:<uuid> -Launcher <sha256> (a tab a launch opened): the claim
#   lock on that id must name that launch's own -Claim, so a later launch that took it over turns this tab
#   away; console input pending refuses it, or claude would read it as its prompt; the id must be new on this machine, and its floor and cap below must hold; then
#   claude --session-id <uuid> --name <name> here.
# - With -Resume <uuid> -Claim launch:<uuid> -Launcher <sha256> (a tab a launch opened): the same claim and input; this folder must be that conversation's
#   own (its project holds its transcript); no running Claude Code holds it (read right then), and, given
#   a left record's stat (-LeftSize and -LeftMtime, or -LeftExitAt), its transcript is unchanged since; its
#   floor and cap; then claude --resume <uuid> here. -WaitFor <pid>-<created> first waits for that process to
#   exit, as long as this tab's claim holds (read at every look). -ConfigDirs "<folder>|<folder>" names other config folders the look reads.
# - With -Place r<x>,<y>,<width>,<height> as well (#91: the first tab of a new window of placement.json's grid), it
#   first places its own window there, before anything else that waits: PLACE_CS in the plugins' machine code, byte
#   for byte ($PlaceCs), which finds its window from this process's own console and moves it only when that Windows
#   Terminal window holds this console alone (a tab joining a window with other tabs places nothing). Its only inputs
#   are those four whole numbers, checked here as a rect is (x and y within 32768, 320 to 32768 wide, 200 to 32768
#   tall). Then it sets one of the two events its launch alone made for its -Claim (placed, or not: it says why here),
#   so the launch's next tab for that window comes after the place. A failure is said here, and the tab goes on.
# - With -Prompt as well (#91): its launch wrote a first prompt to prompts\<the uuid of -Claim>.txt beside this
#   script; it hands that file to claude-launch.ps1 -PromptFile, which reads and checks it, and deletes it once claude
#   has ended, or when this tab refuses (its checks, or a launcher of another hash). The path is built from -Claim,
#   never read off the command line.
# - When Claude Code exits, it looks for the record a switch, a restart or a launch left for this pane:
#   slots\<pid>-<created>.next.json, where <pid> is this script's process id and <created> its creation
#   time (a FILETIME), so a record names one run of one pane. It deletes the record before anything else,
#   so a record is used once.
# - You win: a record that arrives while console input is pending, or in the same poll as a key, is
#   refused, deleted and said, and Enter still starts a session here.
# - A record is honoured only when it is at most 120 seconds old, names an id (a UUID), a launcher by its
#   SHA-256 and an existing folder with no quote or semicolon, and the claim lock on that id names this slot. A `resume` record's
#   folder must be the conversation's own, no running Claude Code holds the conversation, and with a left
#   record's stat its transcript is unchanged since; then claude --resume <id> in that folder. A `start`
#   record names a name too, and its id must be new on this machine; then
#   claude --session-id <id> --name <name> in that folder.
# - Its own floor and cap, whatever a record or an argument says: before a start, or a -Resume, free
#   memory of at least limits.minFreeGb (default 5) and fewer Claude Codes running than
#   limits.maxSessions (default 12), from placement.json beside this script; before a `resume` record
#   (a switch, which replaces a process), the cap only.
# - A refusal is printed here, with the line to run by hand, and the claim it holds is given back, so the
#   conversation doesn't read as held for 15 minutes on nothing. The launcher refusing (its exit 2), ending
#   non-zero or throwing gives a tab's claim back too, and says that line. A record's only on a throw, saying
#   it too: a session that ran in this pane and restarted holds that same claim, and its record, waiting
#   here, needs it.
# - With no record it waits: Enter starts a new Claude Code here, and a record that arrives meanwhile is
#   honoured (it looks every 200 ms). Ctrl+C leaves the slot, at a PowerShell prompt.
#
# It passes claude no other argument: no permission flag of any kind. A resumed session starts in the
# mode a new session would.

param([switch]$Idle, [string]$Start, [string]$Name, [string]$Resume, [string]$WaitFor, [string]$ConfigDirs, [string]$LeftSize, [string]$LeftMtime, [string]$LeftExitAt, [string]$Launcher, [string]$Claim, [string]$Place, [switch]$Prompt)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:PSModulePath = @([Environment]::GetFolderPath("MyDocuments") + "\WindowsPowerShell\Modules", [Environment]::GetFolderPath("ProgramFiles") + "\WindowsPowerShell\Modules", [Environment]::GetFolderPath("System") + "\WindowsPowerShell\v1.0\Modules") -join ";"

$SessionId = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z'
$AreaName = '^[a-z0-9][a-z0-9-]{0,39}\z'
$ProcessRef = '^\d{1,10}-\d{1,20}\z'
$Whole = '^\d{1,16}\z'
$Sha256 = '^[0-9a-f]{64}\z'
$LaunchClaim = '^launch:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z'
$MaxAgeMs = 120000
$WaitSeconds = 600
$DefaultMinFreeGb = 5
$DefaultMaxSessions = 12
# A tab's own window's place (#91): -Place's shape, the events its launch made (PLACE_SIGNAL_PREFIX in the plugins'
# machine code), and the C# that places it (PLACE_CS, written here by scripts/embed-launch.mjs, never by hand).
$PlaceArg = '^r(-?[0-9]{1,5}),(-?[0-9]{1,5}),([0-9]{1,5}),([0-9]{1,5})\z'
$PlacedSignal = 'Local\claude-self-tools-placed-'
$UnplacedSignal = 'Local\claude-self-tools-unplaced-'
$PlaceCs = 'using System; using System.Runtime.InteropServices; using System.Text; public static class ClaudeSelfToolsPlace { [StructLayout(LayoutKind.Sequential)] public struct Box { public int Left; public int Top; public int Right; public int Bottom; } [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public uint Size; public Box Whole; public Box Work; public uint Flags; } [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint relation); [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr window, StringBuilder name, int size); [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window); [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr window); [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context); [DllImport("user32.dll")] static extern IntPtr MonitorFromRect(ref Box rect, uint fallback); [DllImport("user32.dll")] static extern bool GetMonitorInfoW(IntPtr monitor, ref MonitorInfo info); [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags); [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr window, int show); public delegate bool EachWindow(IntPtr found, IntPtr data); [DllImport("user32.dll")] static extern bool EnumWindows(EachWindow each, IntPtr data); [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Box box); [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out Box value, int size); static string ClassOf(IntPtr window) { StringBuilder name = new StringBuilder(256); return GetClassNameW(window, name, name.Capacity) > 0 ? name.ToString() : ""; } static bool Same(IntPtr a, IntPtr b) { return (a.ToInt64() & 0xffffffffL) == (b.ToInt64() & 0xffffffffL); } public static int Hosted(IntPtr window, IntPtr console) { int count = 0; bool seen = false; EachWindow each = delegate(IntPtr found, IntPtr data) { if (ClassOf(found) == "PseudoConsoleWindow" && Same(GetWindow(found, 4), window)) { count++; if (Same(found, console)) seen = true; } return true; }; bool listed = EnumWindows(each, IntPtr.Zero); GC.KeepAlive(each); if (!listed) return -1; return seen ? count : -1; } static int Side(int d) { return d >= 2 && d <= 64 ? d : 0; } public static int[] Overhang(int left, int top, int right, int bottom, int frameLeft, int frameTop, int frameRight, int frameBottom) { return new int[] { Side(frameLeft - left), Side(right - frameRight), Side(bottom - frameBottom) }; } public static int[] BorderOf(IntPtr window) { Box rect; Box frame; if (!GetWindowRect(window, out rect) || DwmGetWindowAttribute(window, 9, out frame, Marshal.SizeOf(typeof(Box))) != 0) return new int[] { 0, 0, 0 }; return Overhang(rect.Left, rect.Top, rect.Right, rect.Bottom, frame.Left, frame.Top, frame.Right, frame.Bottom); } public static int[] Clamp(int x, int y, int width, int height, int left, int top, int right, int bottom, int borderLeft, int borderRight, int borderBottom) { left = left - borderLeft; right = right + borderRight; bottom = bottom + borderBottom; int w = Math.Min(width, right - left); int h = Math.Min(height, bottom - top); return new int[] { Math.Max(left, Math.Min(x, right - w)), Math.Max(top, Math.Min(y, bottom - h)), w, h }; } public static string Place(int x, int y, int width, int height, bool hasRect, bool maximized) { IntPtr console = GetConsoleWindow(); if (console == IntPtr.Zero) return "it has no console window"; string kind = ClassOf(console); IntPtr own = IntPtr.Zero; if (kind == "ConsoleWindowClass") own = console; else if (kind == "PseudoConsoleWindow") { own = GetWindow(console, 4); if (own == IntPtr.Zero || ClassOf(own) != "CASCADIA_HOSTING_WINDOW_CLASS") return "its console is a pseudoconsole that no Windows Terminal window owns"; int hosted = Hosted(own, console); if (hosted != 1) return "its Windows Terminal window holds other tabs or panes, or its own console could not be counted among them (" + hosted + "), so it is left where it is"; } else return "its console window is of class " + kind + ", neither the classic console nor Windows Terminal"; if (!hasRect && maximized && IsZoomed(own) && !IsIconic(own)) return "placed"; if (IsIconic(own) || IsZoomed(own)) return "it opened minimized or maximized, so it is left as it is"; IntPtr before = SetThreadDpiAwarenessContext(new IntPtr(-4)); if (before == IntPtr.Zero) return "per-monitor DPI awareness could not be set for its thread"; try { if (hasRect) { Box asked = new Box(); asked.Left = x; asked.Top = y; asked.Right = x + width; asked.Bottom = y + height; MonitorInfo info = new MonitorInfo(); info.Size = (uint)Marshal.SizeOf(typeof(MonitorInfo)); IntPtr monitor = MonitorFromRect(ref asked, 2); if (monitor == IntPtr.Zero || !GetMonitorInfoW(monitor, ref info)) return "the monitor for its rectangle could not be read"; int[] border = BorderOf(own); int[] at = Clamp(x, y, width, height, info.Work.Left, info.Work.Top, info.Work.Right, info.Work.Bottom, border[0], border[1], border[2]); if (!SetWindowPos(own, IntPtr.Zero, at[0], at[1], at[2], at[3], 0x4214)) return "SetWindowPos failed with error " + Marshal.GetLastWin32Error(); } if (maximized && !ShowWindowAsync(own, 3)) return "it could not be maximized"; return "placed"; } finally { SetThreadDpiAwarenessContext(before); } } }'

# This slot's id: its process id and creation time, as the probe reads them.
$me = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $PID" -Property ProcessId, CreationDate
$slotId = '{0}-{1}' -f $PID, $me.CreationDate.ToFileTimeUtc()
$state = Join-Path $env:LOCALAPPDATA 'claude-self-tools'
$recordPath = Join-Path $state ('slots\' + $slotId + '.next.json')
$beaconPath = Join-Path $state ('slots\' + $slotId + '.state.json')
$placementPath = Join-Path $state 'placement.json'
# The copy kept for you to run by hand: only ever named in a line printed for you. This script never runs it.
$handCopy = Join-Path $state 'claude-launch.ps1'
# This runner's own config folder: the one the claude it starts uses.
$own = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }

# The stamps a layout or an overflow tab carries: each checked, a bad one dropped.
$stampWindow = $env:CLAUDE_SELF_TOOLS_WT_WINDOW
if ($stampWindow -cnotmatch '^[A-Za-z0-9_-]{1,40}\z' -or $stampWindow -match '^-?\d+\z' -or $stampWindow -match '^(new|last|_quake)\z') { $stampWindow = $null }
$stampTab = $env:CLAUDE_SELF_TOOLS_WT_TAB
if ($stampTab -cnotmatch '^[A-Za-z0-9 ._-]{1,40}\z') { $stampTab = $null }

function Get-Sha256($path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  if ([IO.FileInfo]::new($path).Length -gt 65536) { return $null }
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hasher.ComputeHash([IO.File]::ReadAllBytes($path))).Replace("-", "").ToLowerInvariant() } finally { $hasher.Dispose() }
}

# Whether the process waited for has gone, by asking it (Test-Gone), and the wait for it by its handle (Wait-Gone):
# TEST_GONE in the plugins' machine code, line for line. An exit code reads set tens of milliseconds before a process
# is signaled and dropped from the table, so Wait-Process alone can return with it still listed.
function Test-Gone($processId, $created) {
  $h = $null
  try { $h = [Diagnostics.Process]::GetProcessById([int]$processId); $other = $false; if ($created -and "$created" -ne "0") { try { $other = [math]::Abs($h.StartTime.ToFileTimeUtc() - [long]$created) -gt 10000 } catch { $other = $false } }; if ($other) { return $true }; return $h.HasExited }
  catch { return ($_.Exception -is [ArgumentException] -or $_.Exception.InnerException -is [ArgumentException]) }
  finally { if ($null -ne $h) { $h.Dispose() } }
}
function Wait-Gone($processId, $created, $seconds) {
  $h = $null
  try { $h = [Diagnostics.Process]::GetProcessById([int]$processId); $same = $true; if ($created -and "$created" -ne "0") { try { $same = [math]::Abs($h.StartTime.ToFileTimeUtc() - [long]$created) -le 10000 } catch { $same = $true } }; if ($same) { [void]$h.WaitForExit([int]$seconds * 1000) } } catch { } finally { if ($null -ne $h) { $h.Dispose() } }
  return (Test-Gone $processId $created)
}

# The record of a refusal, for whoever comes looking: this tab may be the only place it is said, and nobody may be
# watching it (a refused restart otherwise tells no one). <state>\refused\<conversation>.json: the coordinator
# reads it; a person, by hand. Whole, and it never throws.
function Write-Refused($id, $by, $kind, $folder, $said) {
  try {
    $final = Join-Path $state ('refused\' + $id + '.json')
    $text = [ordered]@{ v = 1; id = $id; kind = $kind; by = $by; at = [string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); folder = [string]$folder; why = [string]$said } | ConvertTo-Json -Compress
    $temp = $final + '.' + [guid]::NewGuid().ToString() + '.tmp'
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($final))
    [IO.File]::WriteAllText($temp, $text)
    try { if ([IO.File]::Exists($final)) { [IO.File]::Replace($temp, $final, [NullString]::Value) } else { [IO.File]::Move($temp, $final) } }
    catch { [IO.File]::Delete($temp); throw }
  } catch { }
}

function Test-Exited($p) { $h = $null; try { $h = [Diagnostics.Process]::GetProcessById([int]$p.ProcessId); return $h.HasExited } catch { return ($_.Exception -is [ArgumentException] -or $_.Exception.InnerException -is [ArgumentException]) } finally { if ($null -ne $h) { $h.Dispose() } } }

# What this process runs: the file as it starts, once. A newer copy over it later changes nothing here.
$ownSha = $null
try { $ownSha = Get-Sha256 $PSCommandPath } catch { $ownSha = $null }

# The claude claude-launch.ps1 finds, for the beacon: its first choice, else the first on PATH.
function Get-ClaudePath {
  try {
    if ($env:USERPROFILE) {
      $pinned = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
      if (Test-Path -LiteralPath $pinned -PathType Leaf) { return $pinned }
    }
    $found = @(Get-Command -Name 'claude' -CommandType Application -ErrorAction SilentlyContinue)
    if ($found.Count -gt 0) { return $found[0].Source }
  } catch { }
  return $null
}

# The beacon, written whole. One that can't be written is no reason to stop: a slot with no beacon is
# never picked for a launch.
function Write-Beacon($now) {
  try {
    $beacon = [ordered]@{ v = 1; state = $now; since = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); configDir = $own }
    if ($null -ne $stampWindow) { $beacon['window'] = $stampWindow }
    if ($null -ne $stampTab) { $beacon['tab'] = $stampTab }
    $used = Get-ClaudePath
    if ($null -ne $used) { $beacon['claude'] = $used }
    if ($null -ne $ownSha) { $beacon['sha256'] = $ownSha }
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($beaconPath))
    $temp = $beaconPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temp, ($beacon | ConvertTo-Json -Compress))
    try { if ([IO.File]::Exists($beaconPath)) { [IO.File]::Replace($temp, $beaconPath, [NullString]::Value) } else { [IO.File]::Move($temp, $beaconPath) } }
    catch { [IO.File]::Delete($temp); throw }
  } catch { }
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

# Whether id is new on this machine: $null when it is, else why. No transcript of it in any of
# $configDirs' projects, and nothing holds it (the registries and the command lines, as above).
function Get-NotFresh($id, $configDirs) {
  try {
    foreach ($dir in $configDirs) {
      $projects = Join-Path $dir 'projects'
      if (-not (Test-Path -LiteralPath $projects -PathType Container)) { continue }
      foreach ($d in @(Get-ChildItem -LiteralPath $projects -Directory -Force)) {
        if (Test-Path -LiteralPath (Join-Path $d.FullName ($id + '.jsonl')) -PathType Leaf) { return ('a transcript of it is already in the projects of ' + $dir) }
      }
    }
  } catch { return 'whether it is new here is unknown: the projects could not be read (' + $_.Exception.Message + ')' }
  return (Get-Live $id $configDirs)
}

# Get-Cli in the plugins' machine code, line for line: a claude.exe running a Claude Code command, which
# holds no conversation and doesn't count as a session.
function Get-Cli($p) {
  if ("$($p.Name)".ToLowerInvariant() -ne "claude.exe") { return $false }
  if ("$($p.CommandLine)" -notmatch '^\s*("[^"]*"|\S+)\s*(?<rest>.*)$') { return $false }
  $rest = $Matches["rest"]
  if ($rest -notmatch '^(plugin|mcp|doctor|update|install|config|auth|--version|-v|--help|-h)(\s|$)') { return $false }
  if ($rest -match '(^|\s)(--resume|-r|--session-id|--continue|-c|-p|--print)(\s|=|$)') { return $false }
  return $true
}

# The limits this runner holds a start to: placement.json's, each value checked as readPlacement checks
# it; absent, or not of its shape, the default.
function Get-Limits {
  $limits = @{ minFreeGb = $DefaultMinFreeGb; maxSessions = $DefaultMaxSessions }
  try {
    if (Test-Path -LiteralPath $placementPath -PathType Leaf) {
      $doc = [IO.File]::ReadAllText($placementPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
      $given = $doc.limits
      if ($given.minFreeGb -is [int] -and $given.minFreeGb -ge 1 -and $given.minFreeGb -le 64) { $limits.minFreeGb = $given.minFreeGb }
      if ($given.maxSessions -is [int] -and $given.maxSessions -ge 1 -and $given.maxSessions -le 40) { $limits.maxSessions = $given.maxSessions }
    }
  } catch { }
  return $limits
}

# Why this runner won't start a session now, or $null: its own floor (free memory, when $memory: a new
# process) and cap (Claude Codes running, Claude Code's own commands left out, each counted once), read
# through Win32. Anything it can't read refuses.
function Get-FloorWhy($memory) {
  $limits = Get-Limits
  try {
    if ($memory) {
      $freeKb = [long](Get-CimInstance -ClassName Win32_OperatingSystem -Property FreePhysicalMemory).FreePhysicalMemory
      if ($freeKb -lt ([long]$limits.minFreeGb * 1024 * 1024)) { return ('only ' + [math]::Round($freeKb / 1048576, 1) + ' GB of memory is free, under this slot''s floor of ' + $limits.minFreeGb + ' GB') }
    }
    $all = @{}
    foreach ($p in (Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate, CommandLine)) { $all[[int]$p.ProcessId] = $p }
    $count = 0
    foreach ($p in $all.Values) {
      # A Claude Code that has exited and is on its way out of the table is no session: it would refuse at the cap for nothing.
      if ($p.Name -ne 'claude.exe' -or (Get-Cli $p) -or (Test-Exited $p)) { continue }
      $up = $all[[int]$p.ParentProcessId]
      if ($null -ne $up -and $up.Name -eq 'claude.exe' -and $up.CreationDate -le $p.CreationDate) { continue }
      $count++
    }
    if ($count -ge $limits.maxSessions) { return ($count.ToString() + ' Claude Codes are running, at this slot''s cap of ' + $limits.maxSessions) }
  } catch { return 'the free memory or the Claude Codes running could not be read (' + $_.Exception.Message + ')' }
  return $null
}

# What the claim lock on conversation $id says of $by, for a wait: 'gone', 'other', 'ours', or 'unknown' (being
# written, or a sharing violation: looked at again next time). Read sharing everything, so it never blocks a writer.
function Get-ClaimSays($id, $by) {
  $path = Join-Path $state ('claims\' + $id + '.lock')
  if (-not (Test-Path -LiteralPath $path)) { return 'gone' }
  try {
    $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite, Delete')
    try { $text = (New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)).ReadToEnd() } finally { $stream.Dispose() }
    $lock = $text | ConvertFrom-Json
    if ($null -ne $lock -and $lock.by -is [string]) { if ($lock.by -ceq $by) { return 'ours' } else { return 'other' } }
  } catch { }
  return 'unknown'
}

# Whether the claim lock on conversation $id names $by.
function Test-Claim($id, $by) {
  $lock = $null
  try { $lock = [IO.File]::ReadAllText((Join-Path $state ('claims\' + $id + '.lock')), [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { $lock = $null }
  return ($null -ne $lock -and $lock.by -ceq $by)
}

# Whether conversation $id's transcript is under $folder's project, in this runner's own config folder:
# the folder with every character but a letter or digit made a dash, as Claude Code names it. Never in
# one a record or an argument names: they can't vouch for themselves.
function Test-Project($folder, $id) {
  $name = $folder -replace '[^A-Za-z0-9]', '-'
  return ($name.Length -le 200 -and (Test-Path -LiteralPath (Join-Path $own ('projects\' + $name + '\' + $id + '.jsonl')) -PathType Leaf))
}

# The config folders a look reads: this runner's own first, then those given that are of a folder's shape,
# each once. Reading more registries can only find a conversation held, never free it.
function Join-Dirs($more) {
  $dirs = @($own)
  foreach ($d in @($more)) { if ((Test-Shape $d) -and @($dirs | Where-Object { $_.TrimEnd([char]92) -ieq $d.TrimEnd([char]92) }).Count -eq 0) { $dirs += $d } }
  return ,$dirs
}

function Test-KeyPending { try { return [Console]::KeyAvailable } catch { return $false } }

# Keys typed while a tab waited, read off: they were never for its Enter.
function Clear-Keys { try { while ([Console]::KeyAvailable) { [void][Console]::ReadKey($true) } } catch { } }

# Gives the claim back while it names $by: RELEASE_CLAIM in the plugins' machine code, line for line.
function Release-Claim {
  try { $stream = [IO.File]::Open($claimPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'Read, Delete') } catch { return }
  try {
    $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8, $true, 4096, $true)
    $text = $reader.ReadToEnd()
    $reader.Dispose()
    $lock = $null
    try { $lock = $text | ConvertFrom-Json } catch { $lock = $null }
    if ($null -ne $lock -and $lock.by -ceq $by) {
      for ($try = 0; $try -lt 3; $try++) {
        if ($try -gt 0) { Start-Sleep -Milliseconds 250 }
        try { [IO.File]::Delete($claimPath); break } catch { }
      }
    }
  } catch { } finally { $stream.Dispose() }
}
# Never throws: what a caller says next is said whatever happens here, and a lock left behind goes stale.
function Give-Back($id, $by) {
  try {
    $claimPath = Join-Path $state ('claims\' + $id + '.lock')
    Release-Claim
  } catch { }
}

# The line that runs a refused conversation by hand: in its own folder, or --resume looks in another project.
function Say-ByHand($id, $name, $folder) {
  $dir = if (Test-Shape $folder) { " -Dir '" + $folder + "'" } else { '' }
  if ($null -eq $name) { Write-Host ('Once it is safe, resume it yourself: & ''' + $handCopy + ''' -Resume ' + $id + $dir) }
  elseif ($name -cmatch $AreaName) { Write-Host ('Once it is safe, start it yourself: & ''' + $handCopy + ''' -Start ' + $id + ' -Name ' + $name + $dir) }
}

# A refused record: its claim, this slot's, given back first, so that once this is said the lock is free; then
# what was wrong, and the line to run it by hand.
function Refuse-Record($text, $said) {
  $r = $null
  try { $r = $text | ConvertFrom-Json } catch { $r = $null }
  $id = $null
  if ($null -ne $r) { $id = if ($null -ne $r.start) { $r.start } else { $r.resume } }
  $named = $id -is [string] -and $id -cmatch $SessionId
  if ($named) { Give-Back $id ('slot:' + $slotId) }
  if ($named) { Write-Refused $id ('slot:' + $slotId) $(if ($null -ne $r.start) { 'start' } else { 'resume' }) $r.folder $said }
  Write-Host $said
  if ($named) { Say-ByHand $id $(if ($null -ne $r.start) { "$($r.name)" } else { $null }) $r.folder }
}

# The record left for this pane, used once: $null, or what to run. $keyed: a key was read in this poll.
function Get-Next($keyed) {
  if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) { return $null }
  # Being written (a launch holds it open while it writes it): read and deleted at the next look.
  $text = $null
  $written = [datetime]::MinValue
  try {
    $written = [IO.File]::GetLastWriteTimeUtc($recordPath)
    $text = [IO.File]::ReadAllText($recordPath, [Text.Encoding]::UTF8)
    # Gone before anything is checked or run: a record is used once.
    [IO.File]::Delete($recordPath)
  } catch { return $null }
  # You win: console input pending, or a key in this same poll, refuses it.
  if ($keyed -or (Test-KeyPending)) {
    Refuse-Record $text 'A record to run a conversation in this pane was refused: you were typing here. Nothing started.'
    return $null
  }
  $why = $null
  $record = $null
  try { $record = $text | ConvertFrom-Json } catch { $why = 'it is not JSON' }
  # A switch or restart that took its record back overwrote it so (a plugin can't delete a file).
  if ($null -eq $why -and $null -ne $record -and $record.cancelled -is [bool] -and $record.cancelled) {
    Write-Host 'The launch that left this record was withdrawn; nothing to do.'
    return $null
  }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $id = $null
  $isStart = $false
  if ($null -eq $why -and ($null -eq $record -or $record.v -ne 1)) { $why = 'it is not version 1' }
  if ($null -eq $why) {
    if ($null -ne $record.start) { $isStart = $true; $id = $record.start } else { $id = $record.resume }
    if ($isStart -and $null -ne $record.resume) { $why = 'it names both a start and a resume' }
    elseif ($id -isnot [string] -or $id -cnotmatch $SessionId) { $why = 'it names no conversation by its id' }
    elseif ($isStart -and ($record.name -isnot [string] -or $record.name -cnotmatch $AreaName)) { $why = 'it names no session name' }
  }
  # Which launcher runs it: the SHA-256 the plugin pinned, whose copy the launch put at that hash's name.
  if ($null -eq $why -and ($record.launcher -isnot [string] -or $record.launcher -cnotmatch $Sha256)) { $why = 'it names no launcher by its SHA-256, so a plugin older than this slot runner wrote it: update the plugins, then launch it again' }
  if ($null -eq $why -and ($record.at -isnot [ValueType] -or ($now - [double]$record.at) -gt $MaxAgeMs -or ($now - [double]$record.at) -lt -5000 -or ([datetime]::UtcNow - $written).TotalMilliseconds -gt $MaxAgeMs)) { $why = 'it is more than 120 seconds old' }
  if ($null -eq $why -and -not (Test-Folder $record.folder)) { $why = 'its folder is not an existing folder with no quote or semicolon' }
  if ($null -eq $why -and -not $isStart -and -not (Test-Project $record.folder $id)) { $why = 'its folder is not that conversation''s own: no transcript of it under the folder''s project' }
  # A left record's stat: a size and a time, or an exit time, whole numbers, nothing else.
  $leftArgs = @{}
  if ($null -eq $why -and $null -ne $record.left) {
    if ($isStart) { $why = 'a start has no left record' }
    else {
      $keys = @($record.left.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object) -join ','
      if ($keys -ceq 'mtime,size' -and "$($record.left.size)" -cmatch $Whole -and "$($record.left.mtime)" -cmatch $Whole) { $leftArgs = @{ LeftSize = "$($record.left.size)"; LeftMtime = "$($record.left.mtime)" } }
      elseif ($keys -ceq 'exitAt' -and "$($record.left.exitAt)" -cmatch $Whole) { $leftArgs = @{ LeftExitAt = "$($record.left.exitAt)" } }
      else { $why = 'its left record''s stat is not a size and a time, or an exit time' }
    }
  }
  # Its own floor and cap: a start adds a process; a resume record replaces one.
  if ($null -eq $why) { $why = Get-FloorWhy $isStart }
  $dirs = Join-Dirs $(if ($null -ne $record) { @($record.configDirs) } else { @() })
  if ($null -eq $why -and -not (Test-Claim $id ('slot:' + $slotId))) { $why = 'the claim lock on that conversation does not name this slot' }
  if ($null -eq $why) {
    if ($isStart) { $why = Get-NotFresh $id $dirs }
    else {
      $why = Get-Live $id $dirs
      if ($null -eq $why -and $leftArgs.Count -gt 0) {
        if ($leftArgs.ContainsKey('LeftExitAt')) { $why = Test-Left $id $dirs $null $null ([long]$leftArgs.LeftExitAt) }
        else { $why = Test-Left $id $dirs ([long]$leftArgs.LeftSize) ([long]$leftArgs.LeftMtime) $null }
      }
    }
  }
  if ($null -ne $why) {
    Refuse-Record $text ('A record to run a conversation in this pane was not used: ' + $why + '.')
    return $null
  }
  $run = @{ Launcher = $record.launcher; Claim = ('slot:' + $slotId); Dir = $record.folder }
  if ($dirs.Count -gt 1) { $run.ConfigDir = @($dirs[1..($dirs.Count - 1)]) }
  if ($isStart) { $run.Start = $id; $run.Name = $record.name } else { $run.Resume = $id; foreach ($k in $leftArgs.Keys) { $run[$k] = $leftArgs[$k] } }
  return $run
}

# This tab's own window, placed at -Place (#91): 'placed', or why not, said here too. PLACE_CS finds the window from this
# process's console, and moves it only when that Windows Terminal window holds this console alone; it takes no handle,
# name, title or process id from anywhere. Its inputs are -Place's four whole numbers, each checked here. Never throws.
function Set-OwnPlace {
  $said = 'not tried'
  try {
    if ($Claim -cnotmatch $LaunchClaim) { $said = '-Place goes with a launch''s own -Claim' }
    elseif (-not ($Place -cmatch $PlaceArg)) { $said = '-Place takes r<x>,<y>,<width>,<height> in whole pixels' }
    else {
      $x = [int]$Matches[1]; $y = [int]$Matches[2]; $w = [int]$Matches[3]; $h = [int]$Matches[4]
      if ([math]::Abs($x) -gt 32768 -or [math]::Abs($y) -gt 32768 -or $w -lt 320 -or $w -gt 32768 -or $h -lt 200 -or $h -gt 32768) { $said = '-Place is not a rect: x and y within 32768, a width of 320 to 32768 and a height of 200 to 32768' }
      else {
        Add-Type -ErrorAction Stop -TypeDefinition $PlaceCs
        $said = [ClaudeSelfToolsPlace]::Place([int]$x, [int]$y, [int]$w, [int]$h, $true, $false)
      }
    }
  } catch { $said = 'it could not be placed (' + $_.Exception.Message + ')' }
  if ($said -cne 'placed') { Write-Host ('This window is not where placement.json''s grid puts it: ' + $said + '. The session goes on here.') }
  return $said
}

# Tells the launch that opened this tab that its place was tried, by the event that launch made for its own -Claim:
# placed, or not. Named from the checked -Claim alone; an event that is gone (the launch stopped waiting) is passed over.
function Send-PlaceWord($said) {
  if ($Claim -cnotmatch $LaunchClaim) { return }
  $signalName = $(if ($said -ceq 'placed') { $PlacedSignal } else { $UnplacedSignal }) + $Claim.Substring(7)
  try { $signal = [Threading.EventWaitHandle]::OpenExisting($signalName); try { [void]$signal.Set() } finally { $signal.Dispose() } } catch { }
}

# Deletes a first prompt's file (#91), its launch's own, by the path built from -Claim. Never throws.
function Remove-Prompt($path) {
  if ($null -ne $path) { try { [IO.File]::Delete($path) } catch { } }
}

# What this tab was opened to run (-Start or -Resume): $null, or what to run. Each checked; a refusal is
# printed here, and the tab goes on as an idle slot.
function Get-Asked {
  $why = $null
  if ($Name -and -not $Start) { $why = '-Name goes with -Start' }
  if ($Start -and $Resume) { $why = 'give one of -Start and -Resume' }
  $id = $Resume
  if ($Start) { $id = $Start }
  if ($null -eq $why -and $id -cnotmatch $SessionId) { $why = 'its id is not a session id (a lowercase UUID)' }
  if ($null -eq $why -and $Start -and $Name -cnotmatch $AreaName) { $why = '-Start takes -Name: lowercase letters, digits and hyphens' }
  if ($null -eq $why -and $Launcher -cnotmatch $Sha256) { $why = 'it names no launcher by its SHA-256 (-Launcher), so a plugin older than this slot runner opened it: update the plugins, then launch it again' }
  if ($null -eq $why -and $Claim -cnotmatch $LaunchClaim) { $why = 'it names no claim of its own (-Claim), so a plugin older than this slot runner opened it: update the plugins, then launch it again' }
  # A first prompt (#91): its launch's own file, by this tab's -Claim, never a path off the command line; claude-launch.ps1
  # reads and checks it. Built whenever -Claim is a launch's, so a refusal below deletes it too.
  $promptPath = $null
  if ($Prompt -and $Claim -cmatch $LaunchClaim) { $promptPath = Join-Path $state ('prompts\' + $Claim.Substring(7) + '.txt') }
  if ($null -eq $why -and $Prompt -and ($null -eq $promptPath -or -not (Test-Path -LiteralPath $promptPath -PathType Leaf))) { $why = 'its launch''s first prompt is not there (prompts\<the uuid of -Claim>.txt beside this script)' }
  $named = @()
  if ($null -eq $why -and $ConfigDirs) {
    $named = @($ConfigDirs.Split('|'))
    if (@($named | Where-Object { -not (Test-Shape $_) }).Count -gt 0) { $why = '-ConfigDirs takes absolute folders' }
  }
  $dirs = Join-Dirs $named
  $leftArgs = @{}
  if ($null -eq $why -and ($LeftSize -or $LeftMtime -or $LeftExitAt)) {
    if (-not $Resume) { $why = 'a left record''s stat goes with -Resume' }
    elseif ($LeftExitAt) { if ($LeftSize -or $LeftMtime -or $LeftExitAt -cnotmatch $Whole) { $why = '-LeftExitAt goes alone, a whole number' } else { $leftArgs = @{ LeftExitAt = $LeftExitAt } } }
    elseif (-not $LeftSize -or -not $LeftMtime -or $LeftSize -cnotmatch $Whole -or $LeftMtime -cnotmatch $Whole) { $why = '-LeftSize and -LeftMtime go together, whole numbers' }
    else { $leftArgs = @{ LeftSize = $LeftSize; LeftMtime = $LeftMtime } }
  }
  # The process this tab replaces, by its id and its start: waited for, however long it takes (the claim and the last look below still decide).
  if ($null -eq $why -and $WaitFor) {
    if (-not $Resume -or $WaitFor -cnotmatch $ProcessRef) { $why = '-WaitFor goes with -Resume, as <pid>-<created>' }
    else {
      $parts = $WaitFor.Split('-')
      $old = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $([long]$parts[0])" -Property ProcessId, CreationDate
      if ($null -ne $old -and ($parts[1] -eq '0' -or [math]::Abs($old.CreationDate.ToFileTimeUtc() - [long]$parts[1]) -le 10000)) {
        Write-Host ('Waiting for the old Claude Code process (' + $parts[0] + ') to exit, then resuming here.')
        $waitClock = [Diagnostics.Stopwatch]::StartNew()
        $toldLong = $false
        $unread = 0
        $gone = $false
        while (-not $gone) {
          $gone = Wait-Gone $parts[0] $parts[1] 30
          if ($gone) { break }
          # The claim at every look: a launch taken back (its claim released, or taken over) ends the wait at once.
          $claimSays = Get-ClaimSays $id $Claim
          if ($claimSays -eq 'unknown') { $unread++ } else { $unread = 0 }
          if ($unread -ge 10) { $why = 'the claim lock on that conversation could not be read for 10 looks in a row (about 5 minutes), so whether the move that opened it still stands is unknown'; break }
          if ($claimSays -eq 'gone' -or $claimSays -eq 'other') { $why = 'the claim lock on that conversation no longer names this tab''s launch: the move that opened it was taken back, or its time ran out'; break }
          if (-not $toldLong -and $waitClock.Elapsed.TotalSeconds -ge $WaitSeconds) { $toldLong = $true; Write-Host ('It has not exited after ' + [int]($WaitSeconds / 60) + ' minutes. This tab keeps waiting while the move that opened it stands, and resumes the session when it goes. Close this tab to give up.') }
          Start-Sleep -Seconds 1
        }
      }
    }
  }
  if ($null -eq $why) { $why = Get-FloorWhy $true }
  if ($null -eq $why -and -not (Test-Claim $id $Claim)) { $why = 'the claim lock on that conversation does not name this tab''s launch' }
  $here = (Get-Location).ProviderPath
  if ($null -eq $why -and $Resume -and -not (Test-Project $here $id)) { $why = 'this folder is not that conversation''s own: no transcript of it under the folder''s project' }
  if ($null -eq $why) {
    if ($Start) { $why = Get-NotFresh $id $dirs }
    else {
      $why = Get-Live $id $dirs
      if ($null -eq $why -and $leftArgs.Count -gt 0) {
        if ($leftArgs.ContainsKey('LeftExitAt')) { $why = Test-Left $id $dirs $null $null ([long]$leftArgs.LeftExitAt) }
        else { $why = Test-Left $id $dirs ([long]$leftArgs.LeftSize) ([long]$leftArgs.LeftMtime) $null }
      }
    }
  }
  # You win: what was typed while this tab waited would land in claude's prompt, an Enter submitting it.
  if ($null -eq $why -and (Test-KeyPending)) { $why = 'you were typing here, and claude would have read it as its prompt'; Clear-Keys }
  if ($null -ne $why) {
    # Its claim back first: once this is said, the lock is free.
    if ($id -cmatch $SessionId -and $Claim -cmatch $LaunchClaim) { Give-Back $id $Claim }
    if ($id -cmatch $SessionId) { Write-Refused $id $Claim $(if ($Start) { 'start' } else { 'resume' }) $here ('This tab did not run what it was opened for: ' + $why + '.') }
    Remove-Prompt $promptPath
    Write-Host ('This tab did not run what it was opened for: ' + $why + '.')
    if ($id -cmatch $SessionId) { Say-ByHand $id $(if ($Start) { $Name } else { $null }) $here }
    return $null
  }
  $run = @{ Launcher = $Launcher; Claim = $Claim; Dir = $here }
  if ($dirs.Count -gt 1) { $run.ConfigDir = @($dirs[1..($dirs.Count - 1)]) }
  if ($Start) { $run.Start = $id; $run.Name = $Name } else { $run.Resume = $id; foreach ($k in $leftArgs.Keys) { $run[$k] = $leftArgs[$k] } }
  if ($null -ne $promptPath) { $run.PromptFile = $promptPath }
  return $run
}

# What Enter runs, having no record to name a launcher: the SHA-256 of the highest version among the copies
# launches put here, each only when its SHA-256 begins with the 8 hex digits in its name, so an edited copy
# is passed over; $null when there is none. Never the copy kept for use by hand, whose name holds no digits.
function Get-NewestLauncher {
  $best = $null
  $bestVersion = -1
  try {
    foreach ($f in @(Get-ChildItem -LiteralPath $state -Filter 'claude-launch-*.ps1' -File -Force)) {
      if ($f.Name -cnotmatch '^claude-launch-([0-9a-f]{8})\.ps1\z') { continue }
      $digits = $Matches[1]
      $sha = Get-Sha256 $f.FullName
      if ($null -eq $sha -or -not $sha.StartsWith($digits, [StringComparison]::Ordinal)) { continue }
      if ([IO.File]::ReadAllText($f.FullName) -cnotmatch '(?m)^# claude-launch version (\d{1,6})\r?$') { continue }
      if ([int]$Matches[1] -gt $bestVersion) { $best = $sha; $bestVersion = [int]$Matches[1] }
    }
  } catch { $best = $null }
  return $best
}

# Runs claude through claude-launch.ps1, the one script that starts it, and the launch environment: the
# copy at the name $run.Launcher gives, only with that SHA-256, read right before it runs (the threat model
# is N9's in the plugins' machine code: it stops a stale or an edited copy). The launcher removes
# PSExecutionPolicyPreference for claude's sake, in this same process; it is put back after, or the next
# run of a launcher here would meet the machine's own policy (Restricted, by default).
function Start-Claude($run) {
  $sha = $run.Launcher
  $held = $run.Claim
  $run.Remove('Launcher')
  $run.Remove('Claim')
  if ($null -eq $sha) {
    Write-Host ('Nothing started: no claude-launch-<hash>.ps1 in ' + $state + ' has the SHA-256 its name gives, and only such a copy starts claude here. A launch (a switch, a restart) puts one there, and the copy for you to run by hand, ' + $handCopy + ', beside it. Then leave this slot with Ctrl+C to run that.')
    return
  }
  $launcherPath = Join-Path $state ('claude-launch-' + $sha.Substring(0, 8) + '.ps1')
  $actual = $null
  try { $actual = Get-Sha256 $launcherPath } catch { $actual = $null }
  if ($actual -cne $sha) {
    if ($run.ContainsKey('Resume')) { Give-Back $run.Resume $held } elseif ($run.ContainsKey('Start')) { Give-Back $run.Start $held }; if ($run.ContainsKey('Resume') -or $run.ContainsKey('Start')) { Write-Refused $(if ($run.ContainsKey('Start')) { $run.Start } else { $run.Resume }) $held $(if ($run.ContainsKey('Start')) { 'start' } else { 'resume' }) $run.Dir ('claude-launch.ps1 is missing at ' + $launcherPath + ', or does not have the SHA-256 ' + $sha) }
    Write-Host ('Nothing started: ' + $launcherPath + ' does not have the SHA-256 ' + $sha + '. It is missing, or it changed after a launch put it there. Launch it again: a launch puts it back.')
    if ($run.ContainsKey('Resume')) { Say-ByHand $run.Resume $null $run.Dir } elseif ($run.ContainsKey('Start')) { Say-ByHand $run.Start $run.Name $run.Dir }
    if ($run.ContainsKey('PromptFile')) { Remove-Prompt $run.PromptFile }; return
  }
  Write-Beacon 'running'
  $policy = [Environment]::GetEnvironmentVariable('PSExecutionPolicyPreference', [EnvironmentVariableTarget]::Process)
  $global:LASTEXITCODE = 0 # this run's exit code below, not one an earlier run here left
  $threw = $null; $ranFrom = Get-Date
  try { & $launcherPath @run }
  catch { $threw = $_.Exception.Message }
  finally { [Environment]::SetEnvironmentVariable('PSExecutionPolicyPreference', $policy, [EnvironmentVariableTarget]::Process) }
  $code = $LASTEXITCODE
  # A first prompt goes once (#91): its file goes once claude has ended, whatever the end.
  if ($run.ContainsKey('PromptFile')) { Remove-Prompt $run.PromptFile }
  # Its claim back first: once this is said, the lock is free. A tab's is this launch's own, so it can be no one
  # else's. A record's, slot:<id>, only on a throw: see the top of this file. Then the line to run it by hand.
  $heldId = if ($run.ContainsKey('Resume')) { $run.Resume } elseif ($run.ContainsKey('Start')) { $run.Start } else { $null }
  $gaveBack = $null -ne $heldId -and ($null -ne $threw -or ($held -cmatch $LaunchClaim -and $code -ne 0))
  if ($gaveBack) { Give-Back $heldId $held }
  if ($null -ne $heldId -and ($null -ne $threw -or ($code -eq 2 -and ((Get-Date) - $ranFrom).TotalSeconds -lt 60))) { Write-Refused $heldId $held $(if ($run.ContainsKey('Start')) { 'start' } else { 'resume' }) $run.Dir $(if ($null -ne $threw) { 'claude-launch.ps1 stopped on an error: ' + $threw } else { 'claude-launch.ps1 ended within a minute with exit code 2: its last look refused the conversation (open elsewhere, or no way to tell), or Claude Code could not start' }) }
  if ($null -ne $threw) { Write-Host ('claude-launch.ps1 stopped on an error, so Claude Code may not have started here: ' + $threw) }
  if ($gaveBack) { Say-ByHand $heldId $(if ($run.ContainsKey('Start')) { $run.Name } else { $null }) $run.Dir }
  Write-Beacon 'idle'
}

try {
  if ($Start -or $Resume -or $Name -or $WaitFor -or $Launcher -or $Claim -or $Place -or $Prompt) {
    # Its own window first, when its launch asked (#91): before anything that waits, so that launch's next tab comes after it.
    if ($Place) { Send-PlaceWord (Set-OwnPlace) }
    # A tab that waits to run what it was opened for is no idle slot: a launch's record would lie unread until
    # that claude has gone, by when it is too old.
    Write-Beacon 'running'
    $asked = Get-Asked
    if ($null -ne $asked) { Start-Claude $asked }
    Write-Beacon 'idle'
  } else {
    Write-Beacon 'idle'
    if (-not $Idle) { Start-Claude @{ Launcher = (Get-NewestLauncher) } }
  }
  $said = $false
  while ($true) {
    $next = Get-Next $false
    if ($null -ne $next) {
      if ($next.ContainsKey('Start')) { Write-Host ('Starting conversation ' + $next.Start + ' here.') } else { Write-Host ('Resuming conversation ' + $next.Resume + ' here.') }
      Start-Claude $next
      $said = $false
      continue
    }
    if (-not $said) {
      Write-Host 'Enter starts a new session here; Ctrl+C leaves this slot.'
      $said = $true
    }
    $enter = $false
    for ($i = 0; $i -lt 10 -and -not $enter; $i++) {
      # One poll: every key waiting is read; a record seen in this same poll loses to it.
      $keyed = $false
      try { while ([Console]::KeyAvailable) { $keyed = $true; if ([Console]::ReadKey($true).Key -eq 'Enter') { $enter = $true } } } catch { }
      if (Test-Path -LiteralPath $recordPath -PathType Leaf) {
        if ($keyed) { [void](Get-Next $true) }
        Start-Sleep -Milliseconds 50
        break
      }
      if (-not $enter) { Start-Sleep -Milliseconds 200 }
    }
    if ($enter) {
      Start-Claude @{ Launcher = (Get-NewestLauncher) }
      $said = $false
    }
  }
} finally {
  # Ctrl+C: this script no longer reads records, though its process goes on at a prompt.
  Write-Beacon 'left'
}
