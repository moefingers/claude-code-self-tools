// The resume claim's canonical script, its hash, and the file it makes (resume-claim.ts says the protocol). Kept
// apart, with no imports, so scripts/resume-claim.test.mjs can run the very bytes the plugin runs.

/** The name this plugin claims under. */
export const CLAIM_BY = 'self-remote-control'

// BEGIN canonical script (scratchpad s3\resume-claim\claim.ps1, byte for byte)
export const CLAIM_SCRIPT = `# claude-self-tools resume-claim, v1: the canonical script, run byte for byte by every plugin that resumes a stopped turn.
# In: RESUME_CLAIM_PATH, <state>\\resumed\\<session id>.<turn id>.json; RESUME_CLAIM_TEXT, this claimant's {"v":1,"by":"<name>","at":<ms>}.
# Out, one line: "claimed" (this run created the file: resume), "taken|<by>|<at>" (the file was there
# already: someone else resumes this stop, so don't), or "error|<why>" (no file could be made: don't).
# It never overwrites or deletes a claim of this stop. While here, it deletes other claim files
# untouched for 7 days.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$path = $env:RESUME_CLAIM_PATH
$text = $env:RESUME_CLAIM_TEXT
$sweepMs = 604800000
$utf8 = New-Object Text.UTF8Encoding($false)
$bytes = $utf8.GetBytes($text)
$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
try {
  $folder = [IO.Path]::GetDirectoryName($path)
  [void][IO.Directory]::CreateDirectory($folder)
} catch {
  'error|the claim folder could not be made'
  return
}
foreach ($other in [IO.Directory]::GetFiles($folder, '*.json')) {
  if ($other -eq $path) { continue }
  try {
    $written = ([DateTimeOffset][IO.File]::GetLastWriteTimeUtc($other)).ToUnixTimeMilliseconds()
    if ($nowMs - $written -gt $sweepMs) { [IO.File]::Delete($other) }
  } catch { }
}
$stream = $null
try { $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) } catch { $stream = $null }
if ($null -ne $stream) {
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush() } finally { $stream.Dispose() }
  'claimed'
  return
}
if (-not [IO.File]::Exists($path)) {
  'error|the claim file could not be made'
  return
}
$by = 'unknown'
$at = '0'
for ($try = 0; $try -lt 20; $try++) {
  try {
    $doc = [IO.File]::ReadAllText($path, $utf8) | ConvertFrom-Json
    if ($null -ne $doc) {
      if ($doc.by -is [string] -and $doc.by -cmatch '^[A-Za-z0-9._:-]{1,64}$') { $by = $doc.by }
      if ($doc.at -is [ValueType]) { $at = [string][long]$doc.at }
    }
    break
  } catch {
    Start-Sleep -Milliseconds 50
  }
}
'taken|' + $by + '|' + $at
`

/** The SHA-256 of CLAIM_SCRIPT's UTF-8 bytes: the coordinator plugin pins the same. */
export const CLAIM_SHA256 = '66cae0beaf1d4f9b78ba490606a5c03cf0126faec50cae951f508c6372ca07a9'
// END canonical script

/** The claim's path for a stop: `<LOCALAPPDATA>\claude-self-tools\resumed\<session>.<turn>.json`. */
export const claimPath = (localAppData: string, session: string, turn: string): string =>
  `${localAppData.replace(/\\+$/, '')}\\claude-self-tools\\resumed\\${session}.${turn}.json`

/** What the claim file holds for a claimant. */
export const claimText = (by: string, at: number): string => JSON.stringify({ v: 1, by, at })
