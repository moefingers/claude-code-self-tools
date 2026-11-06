# claude-wrapper.ps1: restart in the same tab, for Claude Code in PowerShell on Windows.
#
# Part of claude-code-self-tools (tools/claude-wrapper/claude-wrapper.ps1). Dot-source it from your
# PowerShell profile ($PROFILE), so that typing `claude` runs the function below:
#
#   . "$env:LOCALAPPDATA\claude-self-tools\claude-wrapper.ps1"
#
# What it does:
# - It runs the real claude.exe with your arguments, in this tab, and waits for it, as before.
# - It gives this run a fresh token, CLAUDE_PANE_TOKEN, which claude inherits, and writes a pane file,
#   %LOCALAPPDATA%\claude-self-tools\panes\<token>.json (version 3), naming this PowerShell by its
#   process id and start time. self-restart and self-switch leave this tab a ticket only when claude's
#   parent process is that one; otherwise they open a new window, as they do without this function.
# - When claude exits, it looks for that ticket, panes\<token>.next.json, and deletes it before anything
#   else. It uses it only when the ticket is for this token, names a conversation by its id and the
#   claim on it, is at most 120 seconds old, names an existing folder whose project holds that
#   conversation's transcript (by name; it is never read), and names its config folders, if it does,
#   as absolute folders, and its left record's stat, if it does, as whole numbers; when the claim lock
#   on that conversation names the ticket's claim; and when, read again right before claude runs, no
#   running Claude Code holds the conversation (the same last look a switch's window and slot take), in
#   this tab's own config folder or any the ticket names: a switch that reads more than one gets the
#   same look here as in its window; and, for a switch back to a conversation left moments ago (one that
#   rests on a left record), its transcript is as the record says, unchanged since. Then it runs
#   claude --resume <id> in that folder, in this tab, and loops: a resumed session can restart again.
#   At most 10 resumes, and never a fourth within 30 seconds. A ticket it doesn't use is said in one
#   line, and you are back at the prompt.
# - A resumed claude gets no argument but --resume <id>, and the environment a new session would:
#   the variables Claude Code sets in the processes it starts are cleared, NO_COLOR among them, and
#   CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 and CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1 are set (the
#   launch environment, as claude-launch.ps1 sets it). WT_SESSION and WT_PROFILE_ID are left alone.
# - When it returns, your environment and folder are as they were, and the pane file is gone.
# - With no LOCALAPPDATA (an SSH or remoting shell), it just runs claude: no token, no pane file.

function claude {
  # Reads of a property a ticket may lack are plain $null here, whatever mode the profile set.
  Set-StrictMode -Off
  # The real claude.exe: the native installer's, else the first on PATH. Applications only, never
  # this function, so it can't call itself.
  $exe = if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.local\bin\claude.exe' }
  if (-not $exe -or -not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    $exe = Get-Command -Name 'claude' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
  }
  if (-not $exe) { Write-Host 'claude: no claude.exe was found.'; return }

  $config = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } elseif ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.claude' }
  # With no LOCALAPPDATA (an SSH or remoting shell, some service accounts), or no config folder, there
  # is nowhere to keep a pane file or look for a transcript: claude just runs, as without this function.
  if (-not $env:LOCALAPPDATA -or -not $config) {
    if ($MyInvocation.ExpectingInput) { $input | & $exe @args } else { & $exe @args }
    return
  }
  $state = Join-Path $env:LOCALAPPDATA 'claude-self-tools'
  $panes = Join-Path $state 'panes'
  $uuid = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z'
  $claim = '^launch:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z'
  # Set by Claude Code in the processes it starts, and NO_COLOR: a resumed claude must not inherit them.
  $markers = 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_JOB_DIR', 'AI_AGENT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_SSE_PORT', 'NO_COLOR'
  # Set for a resumed claude: LAUNCH_ENV_SET in the plugins' machine code, as claude-launch.ps1 sets it.
  $launchSet = [ordered]@{ CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1'; CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP = '1' }
  # Everything this function changes in the environment, kept to be put back when it returns.
  $names = @('CLAUDE_PANE_TOKEN') + @($launchSet.Keys) + $markers
  $saved = @{}
  foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name) }
  $isNumber = { param($x) $x -is [int] -or $x -is [long] -or $x -is [double] -or $x -is [decimal] }
  # A ticket's config folders: 1 to 8, each an absolute folder of at most 240 characters with no quote
  # or control character (the rule its own folder is read by).
  $isFolders = { param($list) $list -is [array] -and $list.Count -ge 1 -and $list.Count -le 8 -and @($list | Where-Object { $_ -isnot [string] -or $_.Length -gt 240 -or $_ -cnotmatch '^[A-Za-z]:\\' -or $_ -match '[\x00-\x1f"''\u2018-\u201e]' }).Count -eq 0 }
  # A ticket's left record stat: { size, mtime } or { exitAt }, whole numbers, nothing else.
  $isWhole = { param($x) (& $isNumber $x) -and $x -ge 0 -and [math]::Floor([double]$x) -eq [double]$x }
  $isLeft = { param($l) if ($l -isnot [Management.Automation.PSCustomObject]) { return $false }; $keys = @($l.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object) -join ','; return (($keys -ceq 'mtime,size' -and (& $isWhole $l.size) -and (& $isWhole $l.mtime)) -or ($keys -ceq 'exitAt' -and (& $isWhole $l.exitAt))) }

  # Whether a running Claude Code holds conversation $id now: $null when none does, else why. The last
  # look a switch's window and the slot runner take before claude runs (RECHECK in the plugins' machine
  # code), line for line: the session registries and every process's command line, read again.
  # Anything it can't read counts as held.
  function Get-Live($id, $configDirs) {
    $ErrorActionPreference = 'Stop'
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

  # Whether conversation $id's transcript changed since the left record the ticket carries said how it
  # was left: $null when it didn't, else why. The window's last look for a move that rests on a left
  # record (LEFT_RECHECK in the plugins' machine code), line for line, after Get-Live found nothing.
  # Anything it can't read counts as changed.
  function Test-Left($id, $configDirs, $leftSize, $leftMtime, $leftExitAt) {
    $ErrorActionPreference = 'Stop'
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

  # This run: a fresh token, and the pane file naming this PowerShell by its process id and start time.
  # If it can't be written, claude runs all the same, without a token: a restart opens a new window.
  $token = [guid]::NewGuid().ToString()
  $paneFile = Join-Path $panes "$token.json"
  $ticketFile = Join-Path $panes "$token.next.json"
  try {
    [void][IO.Directory]::CreateDirectory($panes)
    # Files a closed tab left behind (its PowerShell is gone), once they are a day old.
    foreach ($old in @(Get-ChildItem -LiteralPath $panes -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) })) {
      $owner = $null
      try { $owner = [IO.File]::ReadAllText($old.FullName) | ConvertFrom-Json } catch { }
      if (-not ((& $isNumber $owner.pid) -and (Get-Process -Id $owner.pid -ErrorAction SilentlyContinue))) { Remove-Item -LiteralPath $old.FullName -Force -ErrorAction SilentlyContinue }
    }
    $started = [string](Get-Process -Id $PID).StartTime.ToFileTimeUtc()
    [IO.File]::WriteAllText($paneFile, (ConvertTo-Json -Compress -InputObject ([ordered]@{ v = 3; pid = $PID; started = $started })))
    $env:CLAUDE_PANE_TOKEN = $token
  } catch {
    Write-Host "claude: this tab's pane file was not written ($($_.Exception.Message)), so a restart opens a new window."
  }

  $resumes = @()
  $code = 0
  Push-Location
  try {
    if ($MyInvocation.ExpectingInput) { $input | & $exe @args } else { & $exe @args }
    $code = $LASTEXITCODE
    while (Test-Path -LiteralPath $ticketFile -PathType Leaf) {
      # Used once: read, then deleted before anything in it is checked or run.
      $text = $null
      try { $text = [IO.File]::ReadAllText($ticketFile) } catch { }
      $deleted = $true
      try { [IO.File]::Delete($ticketFile) } catch { $deleted = $false }
      $t = $null
      try { $t = $text | ConvertFrom-Json } catch { }
      $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $(if (& $isNumber $t.at) { $t.at } else { 0 })
      # The claim lock on the conversation: a switch or restart took it, and the ticket names it.
      $lock = $null
      if ($t.resume -is [string] -and $t.resume -cmatch $uuid) { try { $lock = [IO.File]::ReadAllText((Join-Path $state "claims\$($t.resume).lock")) | ConvertFrom-Json } catch { } }
      $why = if (-not $deleted) { 'it could not be deleted' }
        elseif ($t -isnot [Management.Automation.PSCustomObject] -or $text -notmatch '^\s*\{') { 'it is not a JSON object' }
        elseif ($t.cancelled -is [bool] -and $t.cancelled) { 'it was withdrawn' }
        elseif (-not ((& $isNumber $t.v) -and $t.v -eq 1)) { 'it is not version 1' }
        elseif ($t.token -isnot [string] -or $t.token -cne $token) { 'it is for another tab' }
        elseif ($t.resume -isnot [string] -or $t.resume -cnotmatch $uuid) { 'it names no conversation by its id' }
        elseif ($t.by -isnot [string] -or $t.by -cnotmatch $claim) { 'it names no claim' }
        elseif (-not (& $isNumber $t.at) -or $age -gt 120000 -or $age -lt -5000) { 'its time is not within the last 120 seconds' }
        elseif ($t.dir -isnot [string] -or $t.dir -cnotmatch '^[A-Za-z]:\\' -or $t.dir -match '[\x00-\x1f"''\u2018-\u201e]' -or -not (Test-Path -LiteralPath $t.dir -PathType Container)) { 'its folder is not an existing folder' }
        elseif ($null -ne $t.configDirs -and -not (& $isFolders $t.configDirs)) { 'its config folders are not absolute folders' }
        elseif ($null -ne $t.left -and -not (& $isLeft $t.left)) { 'its left record''s stat is not a size and a time, or an exit time' }
        elseif (-not (Test-Path -LiteralPath (Join-Path $config ('projects\' + ($t.dir -replace '[^A-Za-z0-9]', '-') + '\' + $t.resume + '.jsonl')) -PathType Leaf)) { "no transcript of it is under its folder's project" }
        elseif ($null -eq $lock -or $lock.by -cne $t.by) { 'the claim lock on that conversation does not name this ticket' }
        elseif ($resumes.Count -ge 10) { 'this tab has resumed 10 times already' }
        elseif (@($resumes | Where-Object { ([datetime]::UtcNow - $_).TotalSeconds -lt 30 }).Count -ge 3) { 'this tab resumed 3 times within 30 seconds' }
      # The last look, right before claude runs: is the conversation open anywhere now? In this tab's own
      # config folder and every one the ticket names, as the switch read them: reading more registries
      # can only find the conversation held, never free it. Then, for a move that rests on a left record,
      # its transcript as the record says.
      if ($null -eq $why) {
        $lookIn = @($config)
        if ($null -ne $t.configDirs) { foreach ($dir in @($t.configDirs)) { if (@($lookIn | Where-Object { $_.TrimEnd('\') -eq $dir.TrimEnd('\') }).Count -eq 0) { $lookIn += $dir } } }
        $why = Get-Live $t.resume $lookIn
        if ($null -eq $why -and $null -ne $t.left) { $why = Test-Left $t.resume $lookIn $t.left.size $t.left.mtime $t.left.exitAt }
      }
      if ($null -ne $why) {
        $hint = if ($t.resume -is [string] -and $t.resume -cmatch $uuid) { " Once it is safe, resume it yourself: claude --resume $($t.resume)" } else { '' }
        Write-Host "claude: the ticket to resume a session in this tab was not used: $why.$hint"
        break
      }
      $resumes += [datetime]::UtcNow
      # The environment a new session gets: Claude Code's markers and NO_COLOR removed (not set to empty,
      # which PowerShell 7 keeps), then the launch environment's set: transcripts on, shells not reaped.
      foreach ($name in $markers) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
      foreach ($name in $launchSet.Keys) { Set-Item -LiteralPath "Env:$name" -Value $launchSet[$name] }
      Set-Location -LiteralPath $t.dir
      Write-Host "Resuming $($t.resume) here, in $($t.dir)."
      & $exe --resume $t.resume
      $code = $LASTEXITCODE
    }
  } finally {
    Pop-Location
    foreach ($name in $names) {
      if ($null -eq $saved[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue } else { Set-Item -LiteralPath "Env:$name" -Value $saved[$name] }
    }
    Remove-Item -LiteralPath $paneFile, $ticketFile -Force -ErrorAction SilentlyContinue
  }
  $global:LASTEXITCODE = $code
}
