// The fixed Windows PowerShell scripts self-update runs, and how it runs them. Self-contained: it imports nothing, so
// scripts/self-update.test.mjs can load it under Node, hold its pieces equal to the copies they were taken from, and
// run UPDATE_SCRIPT by a real Windows PowerShell where there is one.
//
// - How a script runs (STDIN_BOOTSTRAP, powershellCall, powershellPath, SYSTEM_ROOT, isSafeFolder, stateFolder): the
//   same as the shared machine code's (shared/hooks/machine.ts), which this plugin doesn't carry: it needs these few
//   lines of it. Windows PowerShell by its known path, no profile, no prompts, a fixed bootstrap as its command, and
//   the script on standard input; its inputs in the environment.
// - The lock's two scripts (TAKE_SCRIPT, RELEASE_SCRIPT): self-remote-control's Remote Control lock scripts
//   (plugins/self-remote-control/hooks/rc-lock.ts), byte for byte, pinned by the same SHA-256s. self-update runs them on
//   a lock file of its own, in the auto-update folder, which another plugin that keeps plugins current takes the same
//   way, so the two never run commands at once.
// - UPDATE_SCRIPT: the one script that runs a `claude plugin` command, its words fixed here.

/** Windows' own folder, as %SystemRoot% names it: a drive, and one folder of plain characters. */
export const SYSTEM_ROOT = /^[A-Za-z]:\\[A-Za-z0-9_ -]{1,64}$/

/** Characters a folder given to a script may not hold: quotes of any kind, control characters, and what Windows refuses in a name. */
const UNSAFE = /["'\u2018\u2019\u201a\u201b\u201c\u201d\u201e<>|?*\u0000-\u001f\u007f-\u009f]/

/**
 * Whether `path` is fit to reach a script: a drive-absolute Windows path (C:\...), at most 240 characters, with no
 * quote or control character, no `.` or `..` part, and only one colon, the drive's.
 */
export function isSafeFolder(path: unknown): path is string {
  if (typeof path !== 'string' || path.length < 3 || path.length > 240) return false
  if (!/^[A-Za-z]:\\/.test(path) || UNSAFE.test(path) || path.indexOf(':', 2) !== -1 || path.includes('/')) return false
  return path
    .slice(3)
    .split('\\')
    .every((part, i, all) => (part === '' ? i === all.length - 1 : part !== '.' && part !== '..' && part.trim() === part))
}

/** The self tools' folder under %LOCALAPPDATA%. */
export const stateFolder = (localAppData: string): string => `${localAppData.replace(/\\+$/, '')}\\claude-self-tools`

/** Windows PowerShell by its known path under the Windows folder. */
export const powershellPath = (systemRoot: string): string => `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** `script` as PowerShell's -EncodedCommand takes it: UTF-16LE, then base64. */
function encodeCommand(script: string): string {
  const bytes: number[] = []
  for (let i = 0; i < script.length; i += 1) {
    const unit = script.charCodeAt(i)
    bytes.push(unit & 0xff, unit >> 8)
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += BASE64.charAt((n >> 18) & 63) + BASE64.charAt((n >> 12) & 63)
    out += b === undefined ? '=' : BASE64.charAt((n >> 6) & 63)
    out += c === undefined ? '=' : BASE64.charAt(n & 63)
  }
  return out
}

/** The one -EncodedCommand every script runs under: it reads standard input to its end, as UTF-8, and runs it as one script block. */
export const STDIN_BOOTSTRAP =
  '& ([scriptblock]::Create([IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false)).ReadToEnd()))'

/** How `$.process.run` runs `script`: Windows PowerShell by its known path, no profile, no prompts, STDIN_BOOTSTRAP as its command, and the script on standard input. */
export function powershellCall(powershell: string, script: string): { readonly argv: readonly string[]; readonly stdin: string } {
  return { argv: [powershell, '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(STDIN_BOOTSTRAP)], stdin: script }
}

// The lock's two scripts: self-remote-control's Remote Control lock scripts (plugins/self-remote-control/hooks/rc-lock.ts),
// byte for byte. TAKE makes the file exclusively, and takes over one that is over 90 s old (a holder that died); RELEASE
// deletes it only while it holds the taker's own text. They get the path and the text in the environment (RC_LOCK_PATH,
// RC_LOCK_TEXT), so their bytes never change. scripts/self-update.test.mjs holds them equal to self-remote-control's.
// BEGIN the lock scripts
export const TAKE_SCRIPT = `# claude-self-tools rc-lock take, v1: the canonical script, run byte for byte by every plugin that takes the lock.
# In: RC_LOCK_PATH, the session's lock file; RC_LOCK_TEXT, this taker's {"v":1,"by":"<plugin>","at":<ms>}.
# Out, one line: "taken", or "held|<by>|<age ms>". It never deletes the lock it takes: a stale one
# (over 90 s old, or over 90 s in the future) is overwritten in place, under a handle no one else
# can open. While here, it deletes other sessions' lock files untouched for a day.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$path = $env:RC_LOCK_PATH
$text = $env:RC_LOCK_TEXT
$staleMs = 90000
$sweepMs = 86400000
$utf8 = New-Object Text.UTF8Encoding($false)
$bytes = $utf8.GetBytes($text)
$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$folder = [IO.Path]::GetDirectoryName($path)
[void][IO.Directory]::CreateDirectory($folder)
foreach ($other in [IO.Directory]::GetFiles($folder, '*.lock')) {
  if ($other -eq $path) { continue }
  try {
    $handle = [IO.File]::Open($other, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Delete)
    try {
      $written = ([DateTimeOffset][IO.File]::GetLastWriteTimeUtc($other)).ToUnixTimeMilliseconds()
      if ($nowMs - $written -gt $sweepMs) { [IO.File]::Delete($other) }
    } finally { $handle.Dispose() }
  } catch { }
}
$result = 'held|busy|0'
$stream = $null
try { $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) } catch { $stream = $null }
if ($null -ne $stream) {
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush() } finally { $stream.Dispose() }
  $result = 'taken'
} else {
  try { $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) } catch { $stream = $null }
  if ($null -ne $stream) {
    try {
      $reader = New-Object IO.StreamReader($stream, $utf8, $false, 4096, $true)
      $old = $reader.ReadToEnd()
      $reader.Dispose()
      $at = $null
      $by = 'unknown'
      try {
        $doc = $old | ConvertFrom-Json
        if ($doc.at -is [ValueType]) { $at = [double]$doc.at }
        if ($doc.by -is [string] -and $doc.by -cmatch '^[A-Za-z0-9._:-]{1,64}$') { $by = $doc.by }
      } catch { $at = $null }
      if ($null -eq $at -or [double]::IsNaN($at) -or [double]::IsInfinity($at)) {
        $at = [double]([DateTimeOffset][IO.File]::GetLastWriteTimeUtc($path)).ToUnixTimeMilliseconds()
      }
      $age = $nowMs - $at
      if ($age -gt $staleMs -or $age -lt (0 - $staleMs)) {
        $stream.SetLength(0)
        $stream.Position = 0
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
        $result = 'taken'
      } else {
        $result = 'held|' + $by + '|' + [string][long][math]::Round($age)
      }
    } finally { $stream.Dispose() }
  }
}
$result
`

export const RELEASE_SCRIPT = `# claude-self-tools rc-lock release, v1: the canonical script, run byte for byte by every plugin that takes the lock.
# In: RC_LOCK_PATH, the session's lock file; RC_LOCK_TEXT, the text this taker wrote when it took it.
# Out, one line: "released" (it held exactly that text, and is deleted), "kept" (it holds another
# taker's text, and is untouched), "gone" (there is no lock), or "busy" (another process kept it
# open for the whole second this waits). The text is compared, and the file deleted, under one
# handle that lets no one else read or write it in between.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$path = $env:RC_LOCK_PATH
$text = $env:RC_LOCK_TEXT
$utf8 = New-Object Text.UTF8Encoding($false)
$result = 'busy'
for ($try = 0; $try -lt 20; $try++) {
  $stream = $null
  try {
    $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Delete)
  } catch {
    $cause = $_.Exception
    if ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
    if ($cause -is [IO.FileNotFoundException] -or $cause -is [IO.DirectoryNotFoundException]) { $result = 'gone'; break }
    Start-Sleep -Milliseconds 50
    continue
  }
  try {
    $reader = New-Object IO.StreamReader($stream, $utf8, $false, 4096, $true)
    $held = $reader.ReadToEnd()
    $reader.Dispose()
    if ($held -ceq $text) {
      [IO.File]::Delete($path)
      $result = 'released'
    } else {
      $result = 'kept'
    }
  } finally { $stream.Dispose() }
  break
}
$result
`

/** The SHA-256 of TAKE_SCRIPT's UTF-8 bytes: self-remote-control pins the same. */
export const TAKE_SHA256 = 'd9adaec581d817ca46f10fbd1e6fbb6ba845ea26dd2ab01fc5ab04cbf7999dd6'
/** The SHA-256 of RELEASE_SCRIPT's UTF-8 bytes: self-remote-control pins the same. */
export const RELEASE_SHA256 = 'caeb549b91af66bebe634710889da5600d263c43b9bc77c36e61cc8f83e4f9c2'
// END the lock scripts

/**
 * A marketplace's or a plugin's name as it is written: letters, digits, dots, dashes and underscores, 64 at most, a
 * letter or a digit first (a dash first would read as an option to the command). UPDATE_SCRIPT checks the same shape.
 */
export const NAME_SHAPE = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}'

/**
 * How long the script gives one command, counted from the script's own first line (not from the command's start): past
 * it the script ends the command, with every process it started.
 */
export const STEP_MS = 75_000
/** With less than this left of STEP_MS when the command would start, the script doesn't start it at all. */
export const STEP_LEAST_MS = 5_000
/**
 * The engine's own timeout on the script: 15 s above STEP_MS, room for ending a tree and the last waits, so it is only
 * the backstop, and under the 5 minutes between looks, so a look under way always reads as fresh.
 */
export const COMMAND_MS = 90_000

/** UPDATE_SCRIPT's inputs: the step's kind, its name, and its scope. */
export const KIND_VAR = 'SELF_UPDATE_KIND'
export const NAME_VAR = 'SELF_UPDATE_NAME'
export const SCOPE_VAR = 'SELF_UPDATE_SCOPE'

/** UPDATE_SCRIPT's last line when no claude was found: the feature does nothing on this machine. */
export const NO_CLAUDE = 'self-update: no claude'
/** UPDATE_SCRIPT's last line when its inputs are not the shapes it runs. */
export const REFUSED = 'self-update: refused'
/** UPDATE_SCRIPT's last line when the only claude on PATH sits in (for a project's or a local scope: anywhere under) the folder the command would run from: it is never run. */
export const INSIDE = 'self-update: claude inside its folder'
/** UPDATE_SCRIPT's last line when the command's time (STEP_MS, from the script's first line) ran out: the script ended it, with every process it started, or never started it. */
export const ENDED = `self-update: ended after ${STEP_MS / 1000} s`
/** UPDATE_SCRIPT's last line when the command ran: this, then its exit code. */
export const EXIT_SAID = 'self-update: exit '

/**
 * The one script a look runs, once per step, by Windows PowerShell (powershellCall: the script on standard input, its
 * inputs in the environment). It builds the command's words from fixed text and the checked inputs, finds claude as
 * the self tools' launcher finds it (the native install's claude.exe, else the first claude on PATH that Windows can
 * start: an npm install's claude.cmd too), and starts it as a child of its own, with those words and nothing on its
 * standard input.
 *
 * Its time. STEP_MS is counted from the script's own first line (a stopwatch started there), so finding claude, a
 * cold PowerShell or a busy machine all come out of it: the child gets what is left of it, and with less than
 * STEP_LEAST_MS left it is never started. A command that ends in time: its exit code, on a last line of the script's
 * own. One that doesn't: the script ends its whole process tree (taskkill /T /F: claude, and the git or node it
 * started), says so on its last line (ENDED), and exits 95, so nothing is left running when the look goes on, and the
 * engine's own timeout (COMMAND_MS) can't arrive before that. The command's own output passes through.
 *
 * Which claude. Never one the folder it runs from could supply: for a project's or a local scope (run from that
 * project's folder, a repository), none anywhere under that folder, however PATH names it (a relative
 * `node_modules\.bin`, say); for the steps run from the home folder, none directly in it (an npm install's claude.cmd
 * lives under the home folder, and is the one to run). When the only claude there is sits inside, the script says so
 * (INSIDE) and runs nothing.
 *
 * The child's command line is the fixed words and the name, joined by single spaces: every word is fixed text or was
 * checked just above to hold only letters, digits, dots, dashes, underscores and one `@`, so none needs a quote and
 * none means anything to cmd.exe (which runs a claude.cmd). No shell reads a string made here. The child gets
 * NoDefaultCurrentDirectoryInExePath=1, so cmd.exe never looks in the folder it runs from for a program a claude.cmd
 * names bare, `node` say. ASCII, LF, a final newline.
 */
export const UPDATE_SCRIPT = [
  '# self-update, v1: one `claude plugin` command, its words fixed here, ended with its',
  '# whole process tree when its time, counted from this first line, runs out.',
  `# In: ${KIND_VAR} (marketplace or plugin), ${NAME_VAR} (a marketplace, or`,
  `# <plugin>@<marketplace>), ${SCOPE_VAR} (user, local or project; a plugin only).`,
  '# Out, the last line: "self-update: exit <code>" after the command ran, "... ended after',
  '# <n> s" when its time ran out (it was ended with every process it started, or never started),',
  '# "... no claude" when none was found, "... claude inside its folder" when the only one found sits in',
  '# the folder it would run from, "... refused" when an input is not the shape it runs.',
  '$clock = [Diagnostics.Stopwatch]::StartNew()',
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  `$kind = "$env:${KIND_VAR}"`,
  `$name = "$env:${NAME_VAR}"`,
  `$scope = "$env:${SCOPE_VAR}"`,
  `$limitMs = ${STEP_MS}`,
  `$leastMs = ${STEP_LEAST_MS}`,
  `$one = '${NAME_SHAPE}'`,
  '$words = $null',
  "if ($kind -ceq 'marketplace' -and $name -cmatch ('\\A' + $one + '\\z')) {",
  "  $words = @('plugin', 'marketplace', 'update', $name)",
  "} elseif ($kind -ceq 'plugin' -and $name -cmatch ('\\A' + $one + '@' + $one + '\\z') -and @('user', 'local', 'project') -ccontains $scope) {",
  "  $words = @('plugin', 'update', $name, '--scope', $scope)",
  '}',
  `if ($null -eq $words) { '${REFUSED}'; exit 96 }`,
  '$here = (Get-Location -PSProvider FileSystem).ProviderPath',
  "$under = $here.TrimEnd('\\') + '\\'",
  "$deep = ($kind -ceq 'plugin' -and $scope -cne 'user')",
  '$exe = $null',
  'if ($env:USERPROFILE) {',
  "  $pinned = Join-Path $env:USERPROFILE '.local\\bin\\claude.exe'",
  '  if (Test-Path -LiteralPath $pinned -PathType Leaf) { $exe = $pinned }',
  '}',
  'if ($null -eq $exe) {',
  "  $found = @(Get-Command -Name 'claude' -CommandType Application -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Source)\" } | Where-Object { (@('.exe', '.cmd', '.bat', '.com') -contains [IO.Path]::GetExtension($_).ToLowerInvariant()) -and [IO.Path]::IsPathRooted($_) } | ForEach-Object { [IO.Path]::GetFullPath($_) })",
  '  $outside = @($found | Where-Object {',
  "    if ($deep) { -not $_.StartsWith($under, [StringComparison]::OrdinalIgnoreCase) } else { -not [string]::Equals([IO.Path]::GetDirectoryName($_).TrimEnd('\\'), $here.TrimEnd('\\'), [StringComparison]::OrdinalIgnoreCase) }",
  '  })',
  `  if ($outside.Count -gt 0) { $exe = $outside[0] } elseif ($found.Count -gt 0) { '${INSIDE}'; exit 94 }`,
  '}',
  `if ($null -eq $exe) { '${NO_CLAUDE}'; exit 97 }`,
  '$utf8 = New-Object Text.UTF8Encoding($false)',
  'try { [Console]::OutputEncoding = $utf8 } catch { }',
  '$start = New-Object Diagnostics.ProcessStartInfo',
  '$start.FileName = $exe',
  "$start.Arguments = $words -join ' '",
  '$start.WorkingDirectory = $here',
  '$start.UseShellExecute = $false',
  '$start.CreateNoWindow = $true',
  '$start.RedirectStandardInput = $true',
  '$start.RedirectStandardOutput = $true',
  '$start.RedirectStandardError = $true',
  '$start.StandardOutputEncoding = $utf8',
  '$start.StandardErrorEncoding = $utf8',
  "$start.EnvironmentVariables['NoDefaultCurrentDirectoryInExePath'] = '1'",
  '$child = New-Object Diagnostics.Process',
  '$child.StartInfo = $start',
  '$left = $limitMs - [int]$clock.ElapsedMilliseconds',
  `if ($left -lt $leastMs) { '${ENDED}'; exit 95 }`,
  '[void]$child.Start()',
  '$child.StandardInput.Close()',
  '$out = $child.StandardOutput.ReadToEndAsync()',
  '$err = $child.StandardError.ReadToEndAsync()',
  '$ended = -not $child.WaitForExit($left)',
  'if ($ended) {',
  "  $ErrorActionPreference = 'Continue'",
  "  try { & (Join-Path ([Environment]::SystemDirectory) 'taskkill.exe') /T /F /PID $child.Id 2>&1 | Out-Null } catch { }",
  '  try { [void]$child.WaitForExit(5000) } catch { }',
  '}',
  'try { if ($out.Wait(3000)) { [Console]::Out.Write($out.Result) } } catch { }',
  'try { if ($err.Wait(1000)) { [Console]::Error.Write($err.Result) } } catch { }',
  '[Console]::Out.WriteLine()',
  'if ($ended) {',
  `  [Console]::Out.WriteLine('${ENDED}')`,
  '  [Console]::Out.Flush()',
  '  exit 95',
  '}',
  '$code = [int]$child.ExitCode',
  `[Console]::Out.WriteLine('${EXIT_SAID}' + $code)`,
  '[Console]::Out.Flush()',
  'exit $code',
  '',
].join('\n')
