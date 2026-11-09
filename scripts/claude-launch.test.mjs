// claude-launch.ps1 (plugins/self-switch/slot/claude-launch.ps1), the one script that starts claude:
// its pinned hash and its version line; the launch environment it applies, equal to the machine code's
// LAUNCH_ENV_CLEAR, LAUNCH_ENV_DROP and LAUNCH_ENV_SET, right before claude, WT_SESSION and WT_PROFILE_ID
// never named; its argument checks before anything changes; -Lane through lanes.json, saying which
// conversation; its own last look (RECHECK and LEFT_RECHECK, line for line), by hand too, against a
// holder the stub plays. And a scan: nothing else in the repository starts
// claude but the claude wrapper, the person's own `claude`; the slot runner goes through this script.
// -Wrapper: the claude wrapper's copy the machine code carries (WRAPPER_SCRIPT_TEXT, the tools/ file byte
// for byte, pinned by WRAPPER_SCRIPT_SHA256 and by the script's own $WrapperSha256), checked by its bytes
// and run from them, before the last look. Then, on Windows, it runs for real in Windows PowerShell 5.1 and PowerShell 7 against
// the stub claude.exe (scripts/claude-wrapper-stub.cs, compiled into a temporary folder), whose
// USERPROFILE, LOCALAPPDATA and CLAUDE_CONFIG_DIR are temporary folders and whose PATH holds no claude
// (stub.mjs's fence), with and without the wrapper's copy, and under a Restricted execution policy set
// for the process alone; and faults are planted in a copy of the script, each caught. Run with
// `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { compileStub, fence, holder, stubWork } from './stub.mjs'
import { ROOT } from './sync-shared.mjs'

const LAUNCH = join(ROOT, 'plugins', 'self-switch', 'slot', 'claude-launch.ps1')
const bytes = readFileSync(LAUNCH)
const script = bytes.toString('utf8')
const machine = await import(pathToFileURL(join(ROOT, 'shared', 'hooks', 'machine.ts')).href)
const WRAPPER = join(ROOT, 'tools', 'claude-wrapper', 'claude-wrapper.ps1')
const wrapperBytes = readFileSync(WRAPPER)
const sha256 = data => createHash('sha256').update(data).digest('hex')
/** The one line said before a direct start with -Wrapper. */
const SAID_LINE = "if ($Wrapper) { Write-Host ('claude-launch: ' + $wrapperWhy + '. Claude starts directly, so a restart from this session opens in a new window or tab.') }"

const isWindows = process.platform === 'win32'
const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows'
const WINDOWS_POWERSHELL = join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const PWSH = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
const SHELLS = [
  ['Windows PowerShell 5.1', WINDOWS_POWERSHELL],
  ['PowerShell 7', PWSH],
].filter(([, path]) => existsSync(path))

test('the hash the plugins pin is the script\'s own, and the script is plain ASCII with LF line ends', () => {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), machine.LAUNCH_SCRIPT_SHA256)
  assert.ok(bytes.every(b => b < 128), 'Windows PowerShell 5.1 reads a file without a BOM as ANSI: keep it ASCII')
  assert.ok(!bytes.includes(13), 'committed with LF line ends (.gitattributes), so the hash is of that')
})

test('the copy the machine code carries (LAUNCH_SCRIPT_TEXT) is the script, byte for byte, and travels whole in base64', () => {
  assert.equal(machine.LAUNCH_SCRIPT_TEXT, script, 'run `node scripts/embed-launch.mjs` after an edit to claude-launch.ps1')
  assert.equal(createHash('sha256').update(machine.LAUNCH_SCRIPT_TEXT).digest('hex'), machine.LAUNCH_SCRIPT_SHA256)
  assert.equal(Buffer.from(machine.asciiBase64(machine.LAUNCH_SCRIPT_TEXT), 'base64').toString('utf8'), script)
  assert.throws(() => machine.asciiBase64('caf\u00e9'), /not ASCII/)
})

test('its version line is the machine code\'s LAUNCH_SCRIPT_VERSION: the copy kept for use by hand is replaced only by a higher one', () => {
  assert.equal(script.match(/^# claude-launch version (\d{1,6})$/gm)?.length, 1)
  assert.equal(Number(/^# claude-launch version (\d{1,6})$/m.exec(script)?.[1]), machine.LAUNCH_SCRIPT_VERSION)
  // The header says how it gets there: no one copies it.
  assert.ok(!/Copy it/.test(script))
  assert.ok(script.includes('# as claude-launch-<the first 8 hex digits of its SHA-256>.ps1, one file per version of the plugins,'))
})

test('its lists are the machine code\'s: LAUNCH_ENV_CLEAR (SESSION_MARKERS, NO_COLOR among them) and LAUNCH_ENV_DROP (CLAUDE_PANE_TOKEN among them) cleared, LAUNCH_ENV_SET set', () => {
  assert.ok(script.includes(`$Clear = ${machine.LAUNCH_ENV_CLEAR.map(name => `'${name}'`).join(', ')}\n`))
  assert.ok(script.includes(`$Drop = ${machine.LAUNCH_ENV_DROP.map(name => `'${name}'`).join(', ')}\n`))
  assert.deepEqual(machine.LAUNCH_ENV_DROP, ['PSExecutionPolicyPreference', 'CLAUDE_PANE_TOKEN'])
  assert.ok(script.includes('foreach ($n in $Drop) { [Environment]::SetEnvironmentVariable($n, [NullString]::Value, [EnvironmentVariableTarget]::Process) }'))
  assert.deepEqual(machine.LAUNCH_ENV_CLEAR, [...machine.SESSION_MARKERS])
  assert.ok(machine.LAUNCH_ENV_CLEAR.includes('NO_COLOR'))
  const set = Object.entries(machine.LAUNCH_ENV_SET).map(([name, value]) => `${name} = '${value}'`).join('; ')
  assert.ok(script.includes(`$Set = [ordered]@{ ${set} }\n`))
  assert.deepEqual(Object.keys(machine.LAUNCH_ENV_SET), ['CLAUDE_CODE_FORCE_SESSION_PERSISTENCE', 'CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP'])
})

test('WT_SESSION and WT_PROFILE_ID are never cleared or set; the REAP setting is never cleared', () => {
  const code = script.split('\n').filter(line => !line.trimStart().startsWith('#'))
  for (const name of ['WT_SESSION', 'WT_PROFILE_ID']) assert.ok(!code.some(line => line.includes(name)), `${name} is named only in comments`)
  assert.ok(!machine.LAUNCH_ENV_CLEAR.includes('CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP'))
  assert.ok(!machine.LAUNCH_ENV_CLEAR.includes('WT_SESSION') && !machine.LAUNCH_ENV_CLEAR.includes('WT_PROFILE_ID'))
  // Removed by [NullString]::Value (PowerShell would pass $null as "", which PowerShell 7 keeps), never set to $null.
  assert.ok(script.includes('foreach ($n in $Clear) { [Environment]::SetEnvironmentVariable($n, [NullString]::Value, [EnvironmentVariableTarget]::Process) }'))
  assert.ok(!/SetEnvironmentVariable\([^)]*,\s*\$null/.test(script))
})

test('the launch environment comes after the arguments, the module path, the folder and claude\'s path, and right before claude', () => {
  // The last check of the arguments; claude's path, which can only be looked for in the folder, is
  // checked after it, and before the environment changes.
  const lastCheck = script.indexOf("if ($Dir -and -not (Test-Folder $Dir)) { Stop-Launch")
  const noClaude = script.indexOf("if ($null -eq $exe) { Stop-Launch 'no claude.exe was found")
  const look = script.indexOf('  $why = Get-Live $lookId $lookIn')
  const held = script.lastIndexOf('Stop-Launch')
  const modules = script.indexOf("  $env:PSModulePath = @(([Environment]::GetFolderPath('MyDocuments')")
  const location = script.indexOf('if ($Dir) { Set-Location -LiteralPath $Dir }')
  const pinned = script.indexOf("$pinned = Join-Path $env:USERPROFILE '.local\\bin\\claude.exe'")
  const clear = script.indexOf('foreach ($n in $Clear)')
  const policy = script.indexOf('foreach ($n in $Drop) { [Environment]::SetEnvironmentVariable($n, [NullString]::Value, [EnvironmentVariableTarget]::Process) }')
  const set = script.indexOf('foreach ($n in $Set.Keys)')
  const claude = script.indexOf('if ($Resume) { & $exe --resume $Resume }')
  assert.ok(lastCheck > 0 && lastCheck < modules, 'every check of the arguments stops it before anything changes')
  assert.ok(noClaude > pinned && noClaude < clear, 'no claude found stops it before the environment changes')
  // The last look, right before the environment: held, it stops there, the last stop of all.
  assert.ok(look > noClaude && look < clear, 'the last look comes after claude is found, and before the environment')
  assert.ok(held > look && held < clear, 'a conversation held stops it before the environment changes')
  assert.ok(modules < location && location < pinned && pinned < clear, 'the module path, the folder and claude\'s path come first')
  assert.ok(clear < policy && policy < set && set < claude, 'then the environment, right before claude')
  // Nothing between the environment and claude could set a marker again: no profile, no module, no location.
  const between = script.slice(clear, claude)
  assert.ok(!/Set-Location|Import-Module|\$PROFILE|\. \$|Invoke-Expression/.test(between))
  // The module path only in Windows PowerShell 5.1: PowerShell 7 keeps its own.
  assert.ok(script.includes("if ($PSVersionTable.PSEdition -ne 'Core') {"))
})

test('claude is %USERPROFILE%\\.local\\bin\\claude.exe when it is there, else the first claude application on PATH; never a permission flag', () => {
  assert.ok(script.indexOf("$pinned = Join-Path $env:USERPROFILE '.local\\bin\\claude.exe'") < script.indexOf("@(Get-Command -Name 'claude' -CommandType Application -ErrorAction SilentlyContinue)"))
  assert.ok(script.includes('if ($null -eq $exe) {\n  $found = @(Get-Command'))
  const runs = script.split('\n').filter(line => line.includes('& $exe'))
  assert.deepEqual(runs.map(line => line.trim()), ['if ($Resume) { & $exe --resume $Resume }', 'elseif ($Start) { & $exe --session-id $Start --name $Name }', 'else { & $exe }'])
  for (const flag of ['--permission-mode', '--dangerously-skip-permissions', 'bypassPermissions', 'acceptEdits', '--allow-dangerously']) assert.ok(!script.includes(flag))
  assert.ok(script.includes('exit $LASTEXITCODE'))
})

test('-Lane: the conversation and the folder from the entry, never from the name; no transcript read', () => {
  assert.ok(script.includes('$Resume = $entry.session'))
  assert.ok(script.includes('$Dir = $entry.folder'))
  assert.ok(script.includes('foreach ($p in $doc.lanes.PSObject.Properties) { if ($p.Name -ceq $Lane) { $entry = $p.Value } }'))
  // No transcript is read: the one line that names one is the left look's, which takes its size and time.
  assert.deepEqual(script.split('\n').filter(line => line.includes('.jsonl')), [`    ${machine.LEFT_RECHECK[1]}`])
  assert.ok(!/Get-Content[^\n]*\$tx|ReadAll\w*\(\$tx/.test(script))
  assert.ok(script.includes("if ($Dir) { Stop-Launch '-Lane takes its folder from lanes.json: give no -Dir.' }"))
  // It says which conversation the name resolved to.
  assert.ok(script.includes("  Write-Host ('claude-launch: -Lane ' + $Lane + ' is conversation ' + $Resume + ', in ' + $Dir + '.')"))
})

test('its last look is RECHECK and LEFT_RECHECK, line for line, as the window and the claude wrapper take it (F1, S1-3)', () => {
  for (const line of machine.RECHECK) assert.ok(script.includes(`    ${line}\n`), `missing from the launcher's last look: ${line}`)
  for (const line of machine.LEFT_RECHECK) assert.ok(script.includes(`    ${line}\n`), `missing from the launcher's left look: ${line}`)
  assert.ok(script.includes('function Get-Live($id, $configDirs) {\n  try {\n'))
  assert.ok(script.includes('function Test-Left($id, $configDirs, $leftSize, $leftMtime, $leftExitAt) {\n  $live = $null\n  try {\n'))
  // For -Resume, -Lane and -Start; this config folder, then each -ConfigDir, once each.
  assert.ok(script.includes('if ($Resume -or $Start) {\n  $lookId = $Resume'))
  assert.ok(script.includes("  foreach ($c in @($config) + @($ConfigDir | Where-Object { $null -ne $_ })) {"))
  assert.ok(script.includes("  if ($null -ne $why) { Stop-Launch ('conversation ' + $lookId + ' is not run here, so that two copies never write it: ' + $why + '.') }"))
})

test("the claude wrapper's copy (WRAPPER_SCRIPT_TEXT) is tools/claude-wrapper/claude-wrapper.ps1 byte for byte, pinned by WRAPPER_SCRIPT_SHA256 and by the script's own $WrapperSha256", () => {
  assert.equal(machine.WRAPPER_SCRIPT_TEXT, wrapperBytes.toString('utf8'), 'run `node scripts/embed-launch.mjs` after an edit to the wrapper')
  assert.equal(sha256(wrapperBytes), machine.WRAPPER_SCRIPT_SHA256)
  assert.ok(wrapperBytes.every(b => b < 128) && !wrapperBytes.includes(13), 'ASCII with LF line ends, so its hash is of that')
  assert.equal(script.match(/^\$WrapperSha256 = '([0-9a-f]{64})'$/m)?.[1], machine.WRAPPER_SCRIPT_SHA256)
  assert.equal(Buffer.from(machine.asciiBase64(machine.WRAPPER_SCRIPT_TEXT), 'base64').toString('utf8'), machine.WRAPPER_SCRIPT_TEXT)
  // Its own name beside the launcher, by its hash; never the person's claude-wrapper.ps1.
  const state = ['C:', 'x', 'claude-self-tools'].join('\\')
  assert.equal(machine.wrapperScriptPath(state), `${state}\\claude-wrapper-${machine.WRAPPER_SCRIPT_SHA256.slice(0, 8)}.ps1`)
  assert.ok(script.includes("$wrapperPath = Join-Path $env:LOCALAPPDATA ('claude-self-tools\\claude-wrapper-' + $WrapperSha256.Substring(0, 8) + '.ps1')"))
  const code = script.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')
  assert.ok(!code.includes('claude-wrapper.ps1'), "the person's own copy is never named in code")
  assert.throws(() => machine.wrapperScriptPath(state, 'not-a-sha'), /not a SHA-256/)
  // The formats a window's copy and a profile's copy share: it writes the pane file of PANE_VERSION (3), and
  // reads the ticket of version 1 the plugins write (paneTicket), with its config folders and left record.
  assert.equal(machine.PANE_VERSION, 3)
  assert.ok(machine.WRAPPER_SCRIPT_TEXT.includes(`[ordered]@{ v = ${machine.PANE_VERSION}; pid = $PID; started = $started }`))
  assert.ok(machine.WRAPPER_SCRIPT_TEXT.includes("elseif (-not ((& $isNumber $t.v) -and $t.v -eq 1)) { 'it is not version 1' }"))
  assert.equal(JSON.parse(machine.paneTicket({ token: '00000000-0000-4000-8000-000000000000', resume: '00000000-0000-4000-8000-000000000001', by: 'launch:00000000-0000-4000-8000-000000000002', dir: state, at: 1, configDirs: [state] })).v, 1)
})

test("the wrapper's top level defines its claude function and nothing else, so loading it changes nothing until claude is called", () => {
  const lines = wrapperBytes.toString('utf8').split('\n')
  const open = lines.indexOf('function claude {')
  const close = lines.lastIndexOf('}')
  assert.ok(open > 0 && close > open)
  assert.deepEqual(lines.slice(0, open).filter(line => line !== '' && !line.startsWith('#')), [])
  assert.deepEqual(lines.slice(close + 1).filter(line => line !== ''), [])
})

test("-Wrapper: the copy's bytes read once, their SHA-256 checked, the function made from those same bytes (no file dot-sourced, no policy asked), before the last look; claude through it after the environment; said when it isn't used", () => {
  const read = script.indexOf('try { $wrapperBytes = [IO.File]::ReadAllBytes($wrapperPath) }')
  const hash = script.indexOf('$wrapperGot = [BitConverter]::ToString($hasher.ComputeHash($wrapperBytes))')
  const compare = script.indexOf('if ($wrapperGot -cne $WrapperSha256)')
  const load = script.indexOf('. ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($wrapperBytes)))')
  const look = script.indexOf('  $why = Get-Live $lookId $lookIn')
  const clear = script.indexOf('foreach ($n in $Clear)')
  const via = script.indexOf('if ($Wrapper -and $null -eq $wrapperWhy) {')
  const said = script.indexOf(SAID_LINE)
  const direct = script.indexOf('if ($Resume) { & $exe --resume $Resume }')
  const kept = script.indexOf('if ($null -eq $wrapperWhy) { $wrapperClaude = ${function:claude} }')
  assert.ok(read > 0 && read < hash && hash < compare && compare < load, 'read, hashed, compared, then loaded')
  assert.ok(load < kept && kept < look, 'the function it made kept right after, before the last look')
  assert.ok(load < look && look < clear && clear < via && via < said && said < direct, 'loaded before the last look; run through after the environment; said before a direct start')
  assert.equal(script.split('ReadAllBytes($wrapperPath)').length - 1, 1, 'read once')
  // Never by its path: a file dot-sourced asks the execution policy, and could change between the check and the run.
  const code = script.split('\n').filter(line => !line.trimStart().startsWith('#'))
  assert.deepEqual(code.filter(line => /(^|[;{]\s*)\.\s+[$'"]/.test(line.trim())), [], 'no file is dot-sourced')
  assert.deepEqual(code.filter(line => /Invoke-Expression|\biex\b|Import-Module/.test(line)), [])
  // By the function it made, never by the name, which an alias in the session that ran it would take.
  const runs = code.filter(line => /\$wrapperClaude( |\s*\})/.test(line) && line.includes('&'))
  assert.deepEqual(runs.map(line => line.trim()), ['if ($Resume) { & $wrapperClaude --resume $Resume }', 'elseif ($Start) { & $wrapperClaude --session-id $Start --name $Name }', 'else { & $wrapperClaude }'])
  assert.deepEqual(code.filter(line => /\{ claude( |\s*\})/.test(line)), [], 'claude is never called by its name')
  // Hosted: the wrapper reads $ClaudeWrapperHosted in this script's scope, set right before the call; what it leaves goes to the window.
  const host = script.indexOf('  $script:ClaudeWrapperHosted = $true\n')
  assert.ok(host > via && host < script.indexOf('if ($Resume) { & $wrapperClaude --resume $Resume }'))
  assert.ok(script.includes('  $global:ClaudeLaunchLast = $script:ClaudeWrapperLast\n  $global:ClaudeLaunchUnused = $script:ClaudeWrapperUnused\n'))
  // The flag taken away once the wrapper returns, whatever it threw: a session that ran this by hand doesn't keep it.
  assert.ok(script.includes('  } finally { $script:ClaudeWrapperHosted = $null }\n'))
  assert.ok(script.includes(`  if ($null -ne $script:ClaudeWrapperUnused) { exit ${machine.WRAPPER_UNUSED_EXIT} }\n  exit $code\n`))
  assert.equal(machine.WRAPPER_UNUSED_EXIT, 3)
  for (const flag of ['--permission-mode', '--dangerously-skip-permissions', 'bypassPermissions']) assert.ok(!script.includes(flag))
  // The wrapper runs as from a prompt: this script's Stop is lifted first. A native exit code is never an error here.
  assert.ok(script.slice(via, said).includes("  $ErrorActionPreference = 'Continue'\n"))
  assert.ok(script.includes('$PSNativeCommandUseErrorActionPreference = $false\n'))
  // A slot runner never asks for it: it has its own loop.
  assert.ok(!readFileSync(join(ROOT, 'plugins', 'self-switch', 'slot', 'claude-slot.ps1'), 'utf8').includes('-Wrapper'))
})

test("every PSModulePath reset sets Windows PowerShell 5.1's three module folders, not one path made of them", { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const slot = join(ROOT, 'plugins', 'self-switch', 'slot')
  const lineOf = (text, name) => {
    const lines = text.split('\n').filter(line => /^\s*\$env:PSModulePath = /.test(line))
    assert.equal(lines.length, 1, `${name} resets the module path once`)
    return lines[0].trim()
  }
  const resets = [
    ['the machine code (PSMODULEPATH_RESET)', machine.PSMODULEPATH_RESET],
    ['claude-launch.ps1', lineOf(script, 'claude-launch.ps1')],
    ['claude-slot.ps1', lineOf(readFileSync(join(slot, 'claude-slot.ps1'), 'utf8'), 'claude-slot.ps1')],
    ['claude-layout.ps1', lineOf(readFileSync(join(slot, 'claude-layout.ps1'), 'utf8'), 'claude-layout.ps1')],
  ]
  for (const [name, line] of resets) {
    const ran = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', `${line}; $env:PSModulePath`], { encoding: 'utf8', windowsHide: true })
    const folders = ran.stdout.trim().split(';')
    assert.equal(folders.length, 3, `${name}: ${ran.stdout.trim()}`)
    assert.ok(folders.every(folder => /^[A-Za-z]:\\.+\\Modules$/.test(folder) && !folder.includes(' C:\\')), `${name}: ${ran.stdout.trim()}`)
  }
})

/** Every file of the repository that could start claude: scripts, the plugins' hooks, the tools. */
function sources(dir = ROOT) {
  return readdirSync(dir).flatMap(name => {
    if (name === 'node_modules' || name.startsWith('.') || name === 'types') return []
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ps1|ts|mjs)$/.test(name) && !/\.test\.(ts|mjs)$/.test(name) && !name.endsWith('.fixture.ts') ? [path] : []
  })
}

test('nothing but claude-launch.ps1 starts claude, but the claude wrapper; the slot runner runs it; each list of what to clear is the one list', () => {
  const starters = []
  for (const path of sources()) {
    // The machine code carries claude-launch.ps1 itself (LAUNCH_SCRIPT_TEXT) and the claude wrapper
    // (WRAPPER_SCRIPT_TEXT), byte for byte (the tests above): the same starters, not others. Everything
    // else in it is scanned.
    let text = readFileSync(path, 'utf8')
    for (const name of ['LAUNCH_SCRIPT_TEXT', 'WRAPPER_SCRIPT_TEXT']) {
      const from = text.indexOf(`export const ${name} = [`)
      if (from !== -1) text = text.slice(0, from) + text.slice(text.indexOf("].join('\\n')", from))
    }
    const code = text
      .split('\n')
      .filter(line => !/^\s*(#|\/\/|\*)/.test(line))
      .join('\n')
    // A PowerShell call of a claude (& $exe, & $claude.Source, & '...claude.exe'), or an argv that starts
    // a claude session (--resume, --session-id). `claude plugin ...` (scripts/test-all.mjs) starts none.
    if (/&\s*(\$exe\b|\$claude\.Source\b|'[^'\n]*claude(\.exe)?')|\[\s*['"]claude(\.exe)?['"]\s*,\s*\[?\s*['"]--(resume|session-id)|--resume ['"]?\$id/.test(code)) starters.push(relative(ROOT, path).split('\\').join('/'))
  }
  assert.deepEqual(starters.sort(), ['plugins/self-switch/slot/claude-launch.ps1', 'tools/claude-wrapper/claude-wrapper.ps1'])
  // The slot runner holds no such list; the wrapper and the layout script clear exactly the launch environment's, never a WT name.
  const slot = readFileSync(join(ROOT, 'plugins', 'self-switch', 'slot', 'claude-slot.ps1'), 'utf8')
  const layout = readFileSync(join(ROOT, 'plugins', 'self-switch', 'slot', 'claude-layout.ps1'), 'utf8')
  const wrapper = readFileSync(join(ROOT, 'tools', 'claude-wrapper', 'claude-wrapper.ps1'), 'utf8')
  assert.ok(!slot.includes('$Markers') && !slot.includes('NO_COLOR'))
  assert.ok(layout.includes(`$Clear = ${machine.LAUNCH_ENV_CLEAR.map(name => `'${name}'`).join(', ')}\n`))
  assert.ok(wrapper.includes(`$markers = ${machine.LAUNCH_ENV_CLEAR.map(name => `'${name}'`).join(', ')}\n`))
  // The plugins start no process but Windows PowerShell and git: never claude.
  for (const plugin of ['self-switch', 'self-restart', 'self-wake', 'self-exit', 'self-check']) {
    const text = readFileSync(join(ROOT, 'plugins', plugin, 'hooks', 'register.ts'), 'utf8')
    assert.ok(!/process\.(run|spawn)\(\s*\[\s*['"]claude/.test(text), `${plugin} starts claude itself`)
  }
})

test('self-switch writes a left record only from its SessionStart (in place) and right before its own /exit; it hooks no session end (LR11)', () => {
  // A typed /exit, a crash or a kill never reaches either: the 10-minute rule stands for those.
  const text = readFileSync(join(ROOT, 'plugins', 'self-switch', 'hooks', 'register.ts'), 'utf8')
  assert.ok(!/on\('session\.end'|classic\.SessionEnd/.test(text))
  assert.equal(text.split('writeLeft($, ').length - 1, 2)
  assert.ok(text.includes("$.clock.after(LEFT_SETTLE_MS, () => void writeLeft($, left, 'in-place'))"))
  assert.ok(text.includes("await writeLeft($, ctx.own, 'exit', own)"))
  // self-restart writes none (review gap 5).
  const restart = readFileSync(join(ROOT, 'plugins', 'self-restart', 'hooks', 'register.ts'), 'utf8')
  assert.ok(!restart.includes('leftScript'))
})

// ---------------------------------------------------------------------------------------------
// Live, against the stub.

let work
let stub

before(() => {
  if (!isWindows) return
  work = stubWork('claude-launch-test-')
  stub = compileStub(work)
})

after(() => {
  if (work !== undefined) rmSync(work, { recursive: true, force: true })
})

/** A folder of its own for one run: a home whose .local\bin holds the stub, a LOCALAPPDATA, a config folder, a work folder. */
function lab() {
  const root = mkdtempSync(join(work, 'run-'))
  const dirs = { root, home: join(root, 'home'), local: join(root, 'local'), config: join(root, 'config'), work: join(root, 'work with space'), start: join(root, 'start') }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  mkdirSync(join(dirs.home, '.local', 'bin'), { recursive: true })
  copyFileSync(stub, join(dirs.home, '.local', 'bin', 'claude.exe'))
  return dirs
}

/** A run's environment: the lab's folders, and the markers, NO_COLOR, CLAUDE_PANE_TOKEN and WT_* set, so what changes shows. */
function envOf(dirs, extra = {}) {
  const keep = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'CommonProgramFiles']
  const env = {
    ...Object.fromEntries(keep.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])),
    PATH: [join(SYSTEM_ROOT, 'System32'), SYSTEM_ROOT, join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0'), join(PWSH, '..')].join(';'),
    USERPROFILE: dirs.home,
    APPDATA: join(dirs.home, 'AppData', 'Roaming'),
    LOCALAPPDATA: dirs.local,
    CLAUDE_CONFIG_DIR: dirs.config,
    STUB_LOG: join(dirs.root, 'log.jsonl'),
    STUB_EXIT: '7',
    WT_SESSION: 'wt-test',
    WT_PROFILE_ID: 'wt-profile-test',
    CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP: '0',
    CLAUDE_PANE_TOKEN: '00000000-0000-4000-a000-0000000000ff',
    ...Object.fromEntries(machine.LAUNCH_ENV_CLEAR.map(name => [name, 'marker-test'])),
    ...extra,
  }
  // Never outside the temporary folder: a run that found the real claude.exe would start Claude Code.
  for (const name of ['USERPROFILE', 'LOCALAPPDATA', 'CLAUDE_CONFIG_DIR']) {
    if (typeof env[name] !== 'string' || !env[name].startsWith(work)) throw new Error(`${name} must be in the test's temporary folder`)
  }
  fence(env, work)
  return env
}

/**
 * The script run as a window runs it, -ExecutionPolicy Bypass (here by -File), in envOf's environment;
 * or, with `restricted`, under -ExecutionPolicy Restricted for this process alone, the script made a
 * script block from its text (a file can't run under Restricted), as the window's own bootstrap runs one.
 * Its exit code, output, the claude runs the stub logged, and the shell's own pid.
 */
function run(shell, dirs, args, { script: path = LAUNCH, extra = {}, restricted = false, prelude = undefined, timeoutMs = 60_000 } = {}) {
  const env = envOf(dirs, extra)
  const quoted = args.map(arg => (arg.startsWith('-') ? arg : `'${arg}'`)).join(' ')
  // `prelude`: commands run first in the same session (a person's alias, say), then the script by its path.
  const argv = restricted
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-Command', `& ([scriptblock]::Create([IO.File]::ReadAllText('${path}'))) ${quoted}`]
    : prelude !== undefined
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${prelude}; & '${path}' ${quoted}; exit $LASTEXITCODE`]
      : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path, ...args]
  if (restricted || prelude !== undefined) assert.ok(![path, ...args].some(arg => arg.includes("'")), 'no quote in a value spliced into the command')
  return new Promise(resolve => {
    const child = spawn(shell, argv, { env, cwd: dirs.start, windowsHide: true })
    let stdout = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stdout += chunk))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('close', code => {
      clearTimeout(timer)
      const log = join(dirs.root, 'log.jsonl')
      const runs = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
      resolve({ code, stdout, runs, pid: child.pid })
    })
  })
}

/** The claude wrapper's copy in a lab, where a launch that opens a window puts it: `text` (the carried copy, unless a fault is planted) under the name of `sha`. */
function placeWrapper(dirs, text = machine.WRAPPER_SCRIPT_TEXT, sha = machine.WRAPPER_SCRIPT_SHA256) {
  const path = machine.wrapperScriptPath(join(dirs.local, 'claude-self-tools'), sha)
  mkdirSync(join(dirs.local, 'claude-self-tools'), { recursive: true })
  writeFileSync(path, text)
  return path
}

/** The pane file's start and its process's, 1 ms apart at most, as the plugins compare them. */
const near = (a, b) => {
  const apart = BigInt(a) - BigInt(b)
  return apart <= 10_000n && apart >= -10_000n
}

/**
 * What a launch through the claude wrapper must look like in claude's process, beside launched()'s: claude
 * runs right under the PowerShell that ran the script (`shell`, process `pid`), with a fresh
 * CLAUDE_PANE_TOKEN, not the one inherited, and the wrapper's pane file (version 3) naming that PowerShell
 * by its id and start; everything else of the launch environment as without it.
 */
function throughWrapper(result, args, cwd, shell) {
  const found = launched({ ...result, runs: result.runs.map(r => ({ ...r, env: r.env.filter(name => name !== 'CLAUDE_PANE_TOKEN') })) }, args, cwd)
  const check = (ok, what) => {
    if (!ok) found.push(what)
  }
  const [only] = result.runs
  if (only === undefined) return found
  check(only.parent?.pid === result.pid, `claude.exe's parent is the PowerShell that ran the launch (${only.parent?.pid}, the shell ${result.pid})`)
  check(only.parent?.path?.toLowerCase() === shell.toLowerCase(), `that PowerShell is ${shell} (${only.parent?.path})`)
  check(only.env.includes('CLAUDE_PANE_TOKEN') && typeof only.token === 'string' && only.token !== '00000000-0000-4000-a000-0000000000ff', `claude carries a fresh CLAUDE_PANE_TOKEN (${only.token})`)
  const pane = only.pane === null ? undefined : machine.parsePane(only.pane)
  check(pane !== undefined && !('why' in pane) && pane.v === 3 && pane.hosted === true, `the pane file is written, version 3, hosted (${only.pane})`)
  if (pane !== undefined && !('why' in pane) && only.parent) {
    check(pane.pid === only.parent.pid, `the pane file names claude.exe's parent (${pane.pid})`)
    check(near(pane.started, only.parent.created), `the pane file's start is that process's (${pane.started}, ${only.parent.created})`)
  }
  check(!result.stdout.includes('the claude wrapper is not used'), `nothing says the wrapper is not used (${result.stdout.slice(0, 300)})`)
  return found
}

/** A person's alias named claude, in the session that runs the script: it would print its arguments and run nothing. */
const ALIAS = 'Set-Alias -Name claude -Value Write-Output -Scope Global'

/**
 * A conversation of a lab's own, ready for the wrapper's tickets: its transcript under the work folder's
 * project, and the claim lock on it naming a launch's claim; and the stub's plan (STUB_PLAN) of `tickets`,
 * each a ticket the plugins write (paneTicket) for that conversation, `at` its time (the stub's {NOW}, {OLD}).
 */
function ticketLab(dirs, tickets, at = '{NOW}') {
  const id = randomUUID()
  const by = `launch:${randomUUID()}`
  const project = join(dirs.config, 'projects', machine.projectName(dirs.work))
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, `${id}.jsonl`), '')
  mkdirSync(join(dirs.local, 'claude-self-tools', 'claims'), { recursive: true })
  writeFileSync(join(dirs.local, 'claude-self-tools', 'claims', `${id}.lock`), JSON.stringify({ v: 1, by, pid: 4, created: '1', at: Date.now(), transport: 'pane' }))
  const plan = join(dirs.root, 'plan')
  mkdirSync(plan, { recursive: true })
  const built = JSON.parse(machine.paneTicket({ token: '00000000-0000-4000-8000-000000000000', resume: id, by, dir: dirs.work, at: 1, configDirs: [dirs.config] }))
  for (let n = 1; n <= tickets; n++) writeFileSync(join(plan, `${n}.json`), JSON.stringify({ ...built, token: '{TOKEN}', at }))
  return { id, by, plan }
}

/** A ticket too old for the wrapper, in a run hosted by the script at `path`: its result. */
async function unusedTicket(shell, path = LAUNCH) {
  const dirs = lab()
  placeWrapper(dirs)
  const t = ticketLab(dirs, 1, '{OLD}')
  return run(shell, dirs, ['-Resume', t.id, '-Dir', dirs.work, '-Wrapper'], { script: path, extra: { STUB_PLAN: t.plan } })
}

/** Eleven moves out of one hosted run, 10.5 seconds apart (past the 30-second guard): its result. */
async function manyMoves(shell, path = LAUNCH) {
  const dirs = lab()
  placeWrapper(dirs)
  const t = ticketLab(dirs, 11)
  return run(shell, dirs, ['-Resume', t.id, '-Dir', dirs.work, '-Wrapper'], { script: path, extra: { STUB_PLAN: t.plan, STUB_SLEEP_MS: '10500' }, timeoutMs: 240_000 })
}

/** A direct start with -Wrapper: claude.exe as without it (no token, no pane file), and one line saying why. */
function directSaid(result, args, why) {
  const found = launched(result, args, undefined)
  const [only] = result.runs
  if (only !== undefined && (only.token !== null || only.pane !== null)) found.push(`no token and no pane file (${only.token}, ${only.pane})`)
  const said = result.stdout.split(/\r?\n/).filter(line => line.startsWith('claude-launch: the claude wrapper is not used: '))
  if (said.length !== 1 || !why.test(said[0]) || !said[0].endsWith('. Claude starts directly, so a restart from this session opens in a new window or tab.')) found.push(`one line says why it is not used (${JSON.stringify(said)})`)
  return found
}

/** What a launch must look like in claude's process: the args, the folder, the environment. */
function launched(result, args, cwd) {
  const found = []
  const check = (ok, what) => {
    if (!ok) found.push(what)
  }
  const [only, more] = result.runs
  check(only !== undefined && more === undefined, `claude ran once (${result.runs.length}): ${result.stdout.slice(0, 400)}`)
  if (only === undefined) return found
  check(JSON.stringify(only.args) === JSON.stringify(args), `claude's arguments are exactly ${JSON.stringify(args)} (${JSON.stringify(only.args)})`)
  if (cwd !== undefined) check(only.cwd === cwd, `in its folder (${only.cwd})`)
  for (const name of [...machine.LAUNCH_ENV_CLEAR, ...machine.LAUNCH_ENV_DROP]) check(!only.env.includes(name), `${name} is cleared`)
  for (const name of ['WT_SESSION', 'WT_PROFILE_ID']) check(only.env.includes(name), `${name} is kept`)
  check(only.forceIsOne === true, 'CLAUDE_CODE_FORCE_SESSION_PERSISTENCE is 1')
  check(only.reapIsOne === true, 'CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP is 1')
  check(result.code === 7, `its exit code is claude's (${result.code})`)
  return found
}

/** A copy of the script with `from` made `to`, for a planted fault. */
function planted(from, to) {
  assert.ok(script.includes(from), `the fault's anchor is in the script: ${from}`)
  const path = join(mkdtempSync(join(work, 'fault-')), 'claude-launch.ps1')
  writeFileSync(path, script.split(from).join(to))
  return path
}

describe('claude-launch.ps1, run for real against the stub', { skip: !isWindows && 'Windows only', concurrency: true }, () => {
  for (const [name, shell] of SHELLS) {
    describe(name, { concurrency: 3 }, () => {
      test('-Resume <id> -Dir <folder>: claude --resume <id> there, the environment cleared and set, WT_* kept', async () => {
        const dirs = lab()
        const id = randomUUID()
        assert.deepEqual(launched(await run(shell, dirs, ['-Resume', id, '-Dir', dirs.work]), ['--resume', id], dirs.work), [])
      })

      test('-Start <id> -Name <name>: claude --session-id <id> --name <name>', async () => {
        const dirs = lab()
        const id = randomUUID()
        assert.deepEqual(launched(await run(shell, dirs, ['-Start', id, '-Name', 'lane-x', '-Dir', dirs.work]), ['--session-id', id, '--name', 'lane-x'], dirs.work), [])
      })

      test('no arguments: plain claude, where it is run (a slot\'s Enter)', async () => {
        const dirs = lab()
        assert.deepEqual(launched(await run(shell, dirs, []), [], dirs.start), [])
      })

      test('-Lane <name>: the entry\'s conversation in the entry\'s folder; an unknown name, a bad entry, or -Dir with it: nothing started', async () => {
        const dirs = lab()
        const id = randomUUID()
        const lanes = { v: 1, at: Date.now(), lanes: { 'lane-x': { session: id, folder: dirs.work, ws: 'default', at: Date.now() }, broken: { session: 'not-a-uuid', folder: dirs.work, ws: 'default', at: 1 } } }
        writeFileSync(join(dirs.config, 'lanes.json'), JSON.stringify(lanes))
        assert.deepEqual(launched(await run(shell, dirs, ['-Lane', 'lane-x']), ['--resume', id], dirs.work), [])
        for (const args of [['-Lane', 'nobody'], ['-Lane', 'broken'], ['-Lane', 'lane-x', '-Dir', dirs.work], ['-Lane', 'Lane X']]) {
          const other = lab()
          writeFileSync(join(other.config, 'lanes.json'), JSON.stringify(lanes))
          const result = await run(shell, other, args)
          assert.equal(result.runs.length, 0, `${args.join(' ')}: nothing started (${result.stdout})`)
          assert.equal(result.code, 2)
          assert.match(result.stdout, /claude-launch: .+ Nothing was started\./)
        }
      })

      test('a bad id, name or folder (a semicolon, a quote, one not there) refuses before anything changes', async () => {
        const id = randomUUID()
        for (const args of [
          ['-Resume', 'not-a-uuid'],
          ['-Resume', id.toUpperCase()],
          ['-Start', id, '-Name', 'Bad Name'],
          ['-Start', id],
          ['-Name', 'x'],
          ['-Resume', id, '-Start', id, '-Name', 'x'],
          ['-Resume', id, '-Dir', 'C:\\a;b'],
          ['-Resume', id, "-Dir", "C:\\o'brien"],
          ['-Resume', id, '-Dir', 'relative\\folder'],
        ]) {
          const dirs = lab()
          const result = await run(shell, dirs, args)
          assert.equal(result.runs.length, 0, `${args.join(' ')}: nothing started (${result.stdout})`)
          assert.equal(result.code, 2, `${args.join(' ')}: exit 2`)
        }
        const dirs = lab()
        const gone = await run(shell, dirs, ['-Resume', id, '-Dir', join(dirs.root, 'gone')])
        assert.equal(gone.runs.length, 0)
      })

      test('-Resume by hand: a running Claude Code whose registry entry names it (L1) stops it, saying so; nothing is started (F1)', async () => {
        const dirs = lab()
        const id = randomUUID()
        const held = await holder({ stub, work, env: envOf(dirs) })
        try {
          mkdirSync(join(dirs.config, 'sessions'), { recursive: true })
          writeFileSync(join(dirs.config, 'sessions', `${held.pid}.json`), JSON.stringify({ pid: held.pid, sessionId: id, procStart: held.created, cwd: dirs.work }))
          const result = await run(shell, dirs, ['-Resume', id, '-Dir', dirs.work])
          assert.equal(result.runs.length, 0, result.stdout)
          assert.equal(result.code, 2)
          assert.match(result.stdout, new RegExp(`claude-launch: conversation ${id} is not run here, so that two copies never write it: it is open elsewhere: Claude Code ${held.pid} holds it \\(L1\\)\\. Nothing was started\\.`))
        } finally {
          held.stop()
        }
      })

      test('a running process naming it on its command line (L2) stops it too; -Start as well as -Resume', async () => {
        const dirs = lab()
        const id = randomUUID()
        const held = await holder({ stub, work, env: envOf(dirs), args: ['--resume', id] })
        try {
          for (const args of [['-Resume', id], ['-Start', id, '-Name', 'lane-x']]) {
            const result = await run(shell, dirs, args)
            assert.equal(result.runs.length, 0, `${args.join(' ')}: ${result.stdout}`)
            assert.match(result.stdout, new RegExp(`it is open elsewhere: process ${held.pid} names it on its command line \\(L2\\)`))
          }
        } finally {
          held.stop()
        }
      })

      test('-ConfigDir: another config folder\'s registry is read too; without it, by hand reads its own alone', async () => {
        const dirs = lab()
        const id = randomUUID()
        const second = join(dirs.root, 'config two')
        mkdirSync(join(second, 'sessions'), { recursive: true })
        const held = await holder({ stub, work, env: envOf(dirs) })
        try {
          writeFileSync(join(second, 'sessions', `${held.pid}.json`), JSON.stringify({ pid: held.pid, sessionId: id, procStart: held.created }))
          const refused = await run(shell, dirs, ['-Resume', id, '-ConfigDir', second])
          assert.equal(refused.runs.length, 0, refused.stdout)
          assert.match(refused.stdout, /holds it \(L1\)/)
          assert.deepEqual(launched(await run(shell, lab(), ['-Resume', id]), ['--resume', id], undefined).filter(f => !f.startsWith('in its folder')), [])
        } finally {
          held.stop()
        }
      })

      test('a left record\'s stat: the transcript changed since (in place), or written after (on exit), stops it; unchanged, it runs (F1)', async () => {
        const dirs = lab()
        const id = randomUUID()
        const project = join(dirs.config, 'projects', 'C--work')
        mkdirSync(project, { recursive: true })
        const tx = join(project, `${id}.jsonl`)
        writeFileSync(tx, '{"type":"user"}\n')
        const stat = statSync(tx)
        const mtime = String(Math.trunc(stat.mtimeMs))
        assert.deepEqual(launched(await run(shell, dirs, ['-Resume', id, '-Dir', dirs.work, '-LeftSize', String(stat.size), '-LeftMtime', mtime]), ['--resume', id], dirs.work), [])
        for (const args of [
          ['-LeftSize', String(stat.size + 1), '-LeftMtime', mtime],
          ['-LeftExitAt', String(Math.trunc(stat.mtimeMs) - 60_000)],
        ]) {
          const other = lab()
          const there = join(other.config, 'projects', 'C--work')
          mkdirSync(there, { recursive: true })
          copyFileSync(tx, join(there, `${id}.jsonl`))
          utimesSync(join(there, `${id}.jsonl`), stat.atime, stat.mtime)
          const result = await run(shell, other, ['-Resume', id, ...args])
          assert.equal(result.runs.length, 0, `${args.join(' ')}: ${result.stdout}`)
          assert.match(result.stdout, /its transcript (changed since it was left|was written after it was left)/)
        }
      })

      test('-Lane says the conversation the name resolved to, then takes the same last look: held, nothing starts (S1-3)', async () => {
        const dirs = lab()
        const id = randomUUID()
        writeFileSync(join(dirs.config, 'lanes.json'), JSON.stringify({ v: 1, at: Date.now(), lanes: { 'lane-z': { session: id, folder: dirs.work, ws: 'default', at: Date.now() } } }))
        const free = await run(shell, dirs, ['-Lane', 'lane-z'])
        assert.ok(free.stdout.includes(`claude-launch: -Lane lane-z is conversation ${id}, in ${dirs.work}.`), free.stdout)
        assert.deepEqual(launched(free, ['--resume', id], dirs.work), [])
        const held = await holder({ stub, work, env: envOf(dirs), args: ['--resume', id] })
        try {
          const other = lab()
          writeFileSync(join(other.config, 'lanes.json'), JSON.stringify({ v: 1, at: Date.now(), lanes: { 'lane-z': { session: id, folder: other.work, ws: 'default', at: Date.now() } } }))
          const refused = await run(shell, other, ['-Lane', 'lane-z'])
          assert.equal(refused.runs.length, 0, refused.stdout)
          assert.ok(refused.stdout.includes(`is conversation ${id}`))
          assert.match(refused.stdout, /\(L2\)\. Nothing was started\./)
        } finally {
          held.stop()
        }
      })

      test('an argument given empty refuses, never a plain new session (N7); a folder the plugins would refuse refuses here too (N8)', async () => {
        const id = randomUUID()
        for (const args of [
          ['-Resume', ''],
          ['-Start', '', '-Name', 'x'],
          ['-Lane', ''],
          ['-Dir', ''],
          ['-Resume', id, '-LeftExitAt', 'soon'],
          ['-Resume', id, '-LeftSize', '5'],
          ['-Resume', id, '-ConfigDir', 'relative'],
          ['-ConfigDir', 'C:\\'],
        ]) {
          const dirs = lab()
          const result = await run(shell, dirs, args)
          assert.equal(result.runs.length, 0, `${JSON.stringify(args)}: nothing started (${result.stdout})`)
          // Exit 2, the script's own refusal; or, for an empty value -File may not hand on, PowerShell's own.
          assert.notEqual(result.code, 0, `${JSON.stringify(args)}: not a success`)
        }
        const dirs = lab()
        // A part with a space at its end, and an empty part: Windows strips or folds them, the plugins refuse them.
        for (const folder of [`${dirs.work}\\sub `, `${dirs.work}\\\\sub`, `${dirs.work}${String.fromCharCode(127)}`]) {
          const result = await run(shell, dirs, ['-Resume', id, '-Dir', folder])
          assert.equal(result.runs.length, 0, `${JSON.stringify(folder)}: ${result.stdout}`)
          assert.match(result.stdout, /-Dir takes an absolute folder/)
        }
      })

      test('no claude.exe in .local\\bin: the first claude application on PATH', async () => {
        const dirs = lab()
        rmSync(join(dirs.home, '.local'), { recursive: true, force: true })
        const bin = join(dirs.root, 'bin')
        mkdirSync(bin)
        copyFileSync(stub, join(bin, 'claude.exe'))
        const result = await run(shell, dirs, [], { extra: { PATH: [bin, join(SYSTEM_ROOT, 'System32'), SYSTEM_ROOT].join(';') } })
        assert.equal(result.runs.length, 1)
        assert.equal(result.runs[0].exe, join(bin, 'claude.exe'))
      })

      test('-Resume -Wrapper: claude --resume <id> through the wrapper\'s verified copy, right under this PowerShell, a fresh token and its pane file; the launch environment as ever, NO_COLOR cleared', async () => {
        const dirs = lab()
        placeWrapper(dirs)
        const id = randomUUID()
        assert.deepEqual(throughWrapper(await run(shell, dirs, ['-Resume', id, '-Dir', dirs.work, '-Wrapper']), ['--resume', id], dirs.work, shell), [])
      })

      test('-Start -Wrapper and -Lane -Wrapper: every mode a window or a person runs goes through it', async () => {
        const dirs = lab()
        placeWrapper(dirs)
        const id = randomUUID()
        assert.deepEqual(throughWrapper(await run(shell, dirs, ['-Start', id, '-Name', 'lane-x', '-Dir', dirs.work, '-Wrapper']), ['--session-id', id, '--name', 'lane-x'], dirs.work, shell), [])
        const lane = lab()
        placeWrapper(lane)
        const other = randomUUID()
        writeFileSync(join(lane.config, 'lanes.json'), JSON.stringify({ v: 1, at: Date.now(), lanes: { 'lane-w': { session: other, folder: lane.work, ws: 'default', at: Date.now() } } }))
        assert.deepEqual(throughWrapper(await run(shell, lane, ['-Lane', 'lane-w', '-Wrapper']), ['--resume', other], lane.work, shell), [])
      })

      test('-Wrapper with no verified copy, or one changed since: claude starts directly, and one line says why', async () => {
        const id = randomUUID()
        const none = lab()
        assert.deepEqual(directSaid(await run(shell, none, ['-Resume', id, '-Wrapper']), ['--resume', id], /its verified copy is not at .+claude-wrapper-[0-9a-f]{8}\.ps1 \(a launch that opens a window puts it there\)\. /), [])
        const changed = lab()
        placeWrapper(changed, `${machine.WRAPPER_SCRIPT_TEXT}# one line more\n`)
        assert.deepEqual(directSaid(await run(shell, changed, ['-Resume', id, '-Wrapper']), ['--resume', id], /is not the copy this launcher pins \(another SHA-256\)\. /), [])
        // The person's own copy, beside it under the name the README gives, is never read.
        const theirs = lab()
        mkdirSync(join(theirs.local, 'claude-self-tools'), { recursive: true })
        writeFileSync(join(theirs.local, 'claude-self-tools', 'claude-wrapper.ps1'), machine.WRAPPER_SCRIPT_TEXT)
        assert.deepEqual(directSaid(await run(shell, theirs, ['-Resume', id, '-Wrapper']), ['--resume', id], /its verified copy is not at /), [])
      })

      test('-Wrapper run from a session with an alias named claude: the function it made runs, never the alias', async () => {
        const dirs = lab()
        placeWrapper(dirs)
        const id = randomUUID()
        assert.deepEqual(throughWrapper(await run(shell, dirs, ['-Resume', id, '-Dir', dirs.work, '-Wrapper'], { prelude: ALIAS }), ['--resume', id], dirs.work, shell), [])
      })

      test("-Wrapper with a %LOCALAPPDATA% the plugins don't take: a direct start, and the line says what is wrong with it", async () => {
        const id = randomUUID()
        const dirs = lab()
        const odd = `${dirs.local}\\sub `
        assert.deepEqual(directSaid(await run(shell, dirs, ['-Resume', id, '-Wrapper'], { extra: { LOCALAPPDATA: odd } }), ['--resume', id], /^claude-launch: the claude wrapper is not used: %LOCALAPPDATA% has a '\.' or '\.\.' part, an empty part, or a part with spaces at either end\. /), [])
      })

      test(`a ticket the wrapper doesn't use (too old): said by the wrapper, and the launcher ends with ${machine.WRAPPER_UNUSED_EXIT}, for the window to record it`, async () => {
        const r = await unusedTicket(shell)
        assert.equal(r.runs.length, 1, r.stdout)
        assert.match(r.stdout, /claude: the ticket to resume a session in this tab was not used: its time is not within the last 120 seconds\./)
        assert.equal(r.code, machine.WRAPPER_UNUSED_EXIT)
      })

      test('eleven moves out of one hosted run: all resumed here, no cap of 10 (the 30-second guard still stands; about two minutes)', { skip: shell !== SHELLS.at(-1)?.[1] && 'one shell is enough for the long run' }, async () => {
        const r = await manyMoves(shell)
        assert.equal(r.runs.length, 12, r.stdout.slice(-600))
        assert.ok(!r.stdout.includes('resumed 10 times'), r.stdout.slice(-600))
        assert.equal(r.code, 7)
      })

      test('-Wrapper under a Restricted execution policy, set for this process alone: the copy loads all the same (its bytes, never a script file)', async () => {
        const dirs = lab()
        placeWrapper(dirs)
        const id = randomUUID()
        assert.deepEqual(throughWrapper(await run(shell, dirs, ['-Resume', id, '-Dir', dirs.work, '-Wrapper'], { restricted: true }), ['--resume', id], dirs.work, shell), [])
      })
    })
  }
})

describe('planted faults in claude-launch.ps1, each caught', { skip: !isWindows && 'Windows only', concurrency: 2 }, () => {
  const shell = SHELLS.at(-1)?.[1] ?? WINDOWS_POWERSHELL
  const resume = async path => {
    const dirs = lab()
    const id = randomUUID()
    return launched(await run(shell, dirs, ['-Resume', id, '-Dir', dirs.work], { script: path }), ['--resume', id], dirs.work)
  }

  test('a script that clears WT_SESSION', async () => {
    assert.notDeepEqual(await resume(planted("'NO_COLOR'\n", "'NO_COLOR', 'WT_SESSION'\n")), [])
  })
  test('NO_COLOR dropped from the list', async () => {
    assert.notDeepEqual(await resume(planted(", 'NO_COLOR'\n", '\n')), [])
  })
  test('CLAUDE_CODE_FORCE_SESSION_PERSISTENCE not set', async () => {
    assert.notDeepEqual(await resume(planted("CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1'; ", '')), [])
  })
  test('the REAP setting cleared (and no longer set): a person\'s 0 or nothing reaches claude', async () => {
    const cleared = planted("'NO_COLOR'\n", "'NO_COLOR', 'CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP'\n")
    const text = readFileSync(cleared, 'utf8').split("; CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP = '1' }").join(' }')
    writeFileSync(cleared, text)
    assert.notDeepEqual(await resume(cleared), [])
  })
  test('a --permission-mode passed through', async () => {
    assert.notDeepEqual(await resume(planted('& $exe --resume $Resume', '& $exe --resume $Resume --permission-mode bypassPermissions')), [])
  })
  test('the last look left out: a conversation held elsewhere (L1) is resumed again by hand', async () => {
    const dirs = lab()
    const id = randomUUID()
    const held = await holder({ stub, work, env: envOf(dirs) })
    try {
      mkdirSync(join(dirs.config, 'sessions'), { recursive: true })
      writeFileSync(join(dirs.config, 'sessions', `${held.pid}.json`), JSON.stringify({ pid: held.pid, sessionId: id, procStart: held.created }))
      const path = planted('  $why = Get-Live $lookId $lookIn\n', '  $why = $null\n')
      assert.notDeepEqual((await run(shell, dirs, ['-Resume', id, '-Dir', dirs.work], { script: path })).runs, [])
    } finally {
      held.stop()
    }
  })
  test('CLAUDE_PANE_TOKEN no longer dropped: a session resumed here inherits the tab\'s token (N1)', async () => {
    assert.notDeepEqual(await resume(planted("$Drop = 'PSExecutionPolicyPreference', 'CLAUDE_PANE_TOKEN'\n", "$Drop = 'PSExecutionPolicyPreference'\n")), [])
  })
  const wrapped = async (path, { place = dirs => placeWrapper(dirs), restricted = false } = {}) => {
    const dirs = lab()
    place(dirs)
    const id = randomUUID()
    return throughWrapper(await run(shell, dirs, ['-Resume', id, '-Dir', dirs.work, '-Wrapper'], { script: path, restricted }), ['--resume', id], dirs.work, shell)
  }
  const VIA = 'if ($Wrapper -and $null -eq $wrapperWhy) {'
  const SAID = `${SAID_LINE}\n`
  const LOAD = '. ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($wrapperBytes)))'

  test('no wrapper use: -Wrapper given, the copy loaded, and claude.exe run directly all the same', async () => {
    assert.notDeepEqual(await wrapped(planted(VIA, 'if ($false) {')), [])
  })
  test('the fallback silent: no copy, a direct start, and nothing said', async () => {
    const dirs = lab()
    const id = randomUUID()
    assert.notDeepEqual(directSaid(await run(shell, dirs, ['-Resume', id, '-Wrapper'], { script: planted(SAID, '') }), ['--resume', id], /its verified copy is not at /), [])
  })
  test('the hash check skipped: a copy changed since the launch put it there is run', async () => {
    const dirs = lab()
    placeWrapper(dirs, `${machine.WRAPPER_SCRIPT_TEXT}# one line more\n`)
    const id = randomUUID()
    assert.notDeepEqual(directSaid(await run(shell, dirs, ['-Resume', id, '-Wrapper'], { script: planted('if ($wrapperGot -cne $WrapperSha256)', 'if ($false)') }), ['--resume', id], /is not the copy this launcher pins/), [])
  })
  test('the function called by its name: an alias named claude in the session that ran the script runs instead', async () => {
    const dirs = lab()
    placeWrapper(dirs)
    const id = randomUUID()
    const path = planted('if ($Resume) { & $wrapperClaude --resume $Resume }', 'if ($Resume) { claude --resume $Resume }')
    assert.notDeepEqual(throughWrapper(await run(shell, dirs, ['-Resume', id, '-Dir', dirs.work, '-Wrapper'], { script: path, prelude: ALIAS }), ['--resume', id], dirs.work, shell), [])
  })
  test("a ticket the wrapper doesn't use left unsaid: the launcher ends with claude's code, and the window can't tell", async () => {
    const path = planted(`  if ($null -ne $script:ClaudeWrapperUnused) { exit ${machine.WRAPPER_UNUSED_EXIT} }\n`, '')
    const r = await unusedTicket(shell, path)
    assert.notEqual(r.code, machine.WRAPPER_UNUSED_EXIT)
  })
  test('the cap of 10 kept in a window: the eleventh move out of it is refused (about two minutes)', async () => {
    const path = planted("$script:ClaudeWrapperHosted = $true\n", "$script:ClaudeWrapperHosted = $false\n")
    const r = await manyMoves(shell, path)
    assert.notEqual(r.runs.length, 12)
  })
  test('the token dropped: a wrapper copy that gives claude no CLAUDE_PANE_TOKEN (pinned as its own)', async () => {
    const TOKEN = '    $env:CLAUDE_PANE_TOKEN = $token\n'
    assert.ok(machine.WRAPPER_SCRIPT_TEXT.includes(TOKEN))
    const faulty = machine.WRAPPER_SCRIPT_TEXT.replace(TOKEN, '')
    const faultySha = sha256(faulty)
    const path = planted(`$WrapperSha256 = '${machine.WRAPPER_SCRIPT_SHA256}'`, `$WrapperSha256 = '${faultySha}'`)
    assert.notDeepEqual(await wrapped(path, { place: dirs => placeWrapper(dirs, faulty, faultySha) }), [])
  })
  test('the copy dot-sourced by its path: under a Restricted policy it does not load', async () => {
    assert.notDeepEqual(await wrapped(planted(LOAD, '. $wrapperPath'), { restricted: true }), [])
  })

  test('the environment block placed before a later step that sets a marker again (a profile, say)', async () => {
    // The block moved above the folder and claude's path, and a marker set after it: claude inherits it.
    const block = "foreach ($n in $Clear) { [Environment]::SetEnvironmentVariable($n, [NullString]::Value, [EnvironmentVariableTarget]::Process) }\n"
    const moved = script.split(block).join('').split('# 3. The folder, and claude.\n').join(`${block}# 3. The folder, and claude.\n$env:CLAUDECODE = '1'\n`)
    const path = join(mkdtempSync(join(work, 'fault-')), 'claude-launch.ps1')
    writeFileSync(path, moved)
    assert.notDeepEqual(await resume(path), [])
  })
})

// ---------------------------------------------------------------------------------------------
// The install: a launch puts the copy it carries in place when the one there is missing or has another
// SHA-256, and is refused only when it can't (INSTALL_LAUNCHER, run here by itself, as the launch
// script runs it, against temporary folders only).

/** Install-Launcher run once on `path`, with `copy` (the launch's own, unless a fault is planted): its answer. */
function install(path, copy = machine.LAUNCH_SCRIPT_TEXT, sha = machine.LAUNCH_SCRIPT_SHA256) {
  if (!path.startsWith(work)) throw new Error('the install runs in the test\'s temporary folder only')
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    ...machine.GET_SHA256,
    ...machine.INSTALL_LAUNCHER,
    `$why = Install-Launcher '${path}' '${machine.asciiBase64(copy)}' '${sha}'`,
    "if ($null -eq $why) { 'INSTALLED' } else { 'REFUSED ' + $why }",
  ]
  const call = machine.powershellCall(WINDOWS_POWERSHELL, lines.join('\r\n'))
  const env = { ...process.env, LOCALAPPDATA: join(work, 'install-local'), USERPROFILE: join(work, 'install-home') }
  const ran = spawnSync(call.argv[0], call.argv.slice(1), { input: call.stdin, encoding: 'utf8', windowsHide: true, env })
  // Standard output alone: PowerShell writes its progress (CLIXML) and errors to standard error.
  return { code: ran.status, out: ran.stdout.trim() }
}

/** What the folder holds besides the scripts: no temporary file may be left. */
const leftovers = dir => readdirSync(dir).filter(name => !/^claude-launch(-[0-9a-f]{8})?\.ps1$/.test(name))

/** Install-HandCopy run once: the copy for use by hand at `hand`, from the installed script at `from`. It answers nothing. */
function installHand(hand, from, version = machine.LAUNCH_SCRIPT_VERSION) {
  if (!hand.startsWith(work) || !from.startsWith(work)) throw new Error('the install runs in the test\'s temporary folder only')
  const lines = ["$ErrorActionPreference = 'Stop'", "$ProgressPreference = 'SilentlyContinue'", ...machine.INSTALL_HAND_COPY, `Install-HandCopy '${hand}' '${from}' ${version}`, "'DONE'"]
  const call = machine.powershellCall(WINDOWS_POWERSHELL, lines.join('\r\n'))
  const ran = spawnSync(call.argv[0], call.argv.slice(1), { input: call.stdin, encoding: 'utf8', windowsHide: true, env: { ...process.env, LOCALAPPDATA: join(work, 'install-local'), USERPROFILE: join(work, 'install-home') } })
  return { code: ran.status, out: ran.stdout.trim() }
}

describe('the install of claude-launch.ps1 by a launch', { skip: !isWindows && 'Windows only' }, () => {
  test('missing (its folder too): put there, at its hash\'s own name, byte for byte, nothing else left', () => {
    const state = join(mkdtempSync(join(work, 'install-')), 'claude-self-tools')
    const path = machine.launchScriptPath(state)
    assert.ok(path.endsWith(`\\claude-launch-${machine.LAUNCH_SCRIPT_SHA256.slice(0, 8)}.ps1`))
    assert.deepEqual(install(path), { code: 0, out: 'INSTALLED' })
    assert.equal(readFileSync(path, 'utf8'), script)
    assert.deepEqual(leftovers(state), [])
  })

  test('a tampered copy: replaced by the launch\'s own, byte for byte', () => {
    const state = mkdtempSync(join(work, 'install-'))
    const path = join(state, 'claude-launch.ps1')
    writeFileSync(path, script.replace('& $exe --resume $Resume', '& $exe --resume $Resume --permission-mode bypassPermissions'))
    assert.deepEqual(install(path), { code: 0, out: 'INSTALLED' })
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), machine.LAUNCH_SCRIPT_SHA256)
    assert.deepEqual(leftovers(state), [])
  })

  test('already in place: left as it is', () => {
    const state = mkdtempSync(join(work, 'install-'))
    const path = join(state, 'claude-launch.ps1')
    writeFileSync(path, script)
    const before = statSync(path).mtimeMs
    assert.deepEqual(install(path), { code: 0, out: 'INSTALLED' })
    assert.equal(statSync(path).mtimeMs, before)
  })

  test('an unwritable folder (under a file), or a folder where the script goes: refused, saying why, nothing written', () => {
    const root = mkdtempSync(join(work, 'install-'))
    writeFileSync(join(root, 'not-a-folder'), 'x')
    const under = install(join(root, 'not-a-folder', 'claude-launch.ps1'))
    assert.equal(under.code, 0)
    assert.match(under.out, /^REFUSED it could not be written there \(/)
    mkdirSync(join(root, 'taken', 'claude-launch.ps1'), { recursive: true })
    const taken = install(join(root, 'taken', 'claude-launch.ps1'))
    assert.match(taken.out, /^REFUSED /)
    assert.deepEqual(readdirSync(join(root, 'taken')), ['claude-launch.ps1'])
  })

  test('two versions of the plugins side by side: each installs its own file, and never overwrites the other\'s (F2)', () => {
    const state = mkdtempSync(join(work, 'install-'))
    const older = `${script.replace('# claude-launch version ', '# an older release\n# claude-launch version ')}`
    const olderSha = createHash('sha256').update(older).digest('hex')
    const olderPath = machine.launchScriptPath(state, olderSha)
    assert.deepEqual(install(olderPath, older, olderSha), { code: 0, out: 'INSTALLED' })
    const olderBefore = statSync(olderPath).mtimeMs
    const path = machine.launchScriptPath(state)
    assert.notEqual(path, olderPath)
    assert.deepEqual(install(path), { code: 0, out: 'INSTALLED' })
    // Each again, in turn, as sessions of both versions launch: neither file is written over.
    assert.deepEqual(install(olderPath, older, olderSha), { code: 0, out: 'INSTALLED' })
    assert.deepEqual(install(path), { code: 0, out: 'INSTALLED' })
    assert.equal(readFileSync(olderPath, 'utf8'), older)
    assert.equal(statSync(olderPath).mtimeMs, olderBefore)
    assert.equal(readFileSync(path, 'utf8'), script)
  })

  test('the copy for use by hand: put there when missing or of a lower version, never one of the same or a higher, never by Replace; and never refused on', () => {
    const state = mkdtempSync(join(work, 'install-'))
    const from = machine.launchScriptPath(state)
    writeFileSync(from, script)
    const hand = join(state, 'claude-launch.ps1')
    assert.deepEqual(installHand(hand, from), { code: 0, out: 'DONE' })
    assert.equal(readFileSync(hand, 'utf8'), script)
    // A lower version, or one with no version line (an edited copy): replaced.
    for (const old of [script.replace(/^# claude-launch version \d+$/m, '# claude-launch version 0'), '# a copy made by hand\n']) {
      writeFileSync(hand, old)
      assert.deepEqual(installHand(hand, from), { code: 0, out: 'DONE' })
      assert.equal(readFileSync(hand, 'utf8'), script)
    }
    // The same version or a higher: left as it is, so two versions never trade it back and forth.
    for (const newer of [script.replace('# Part of self-switch', '# Edited by hand.\n# Part of self-switch'), script.replace(/^# claude-launch version \d+$/m, `# claude-launch version ${machine.LAUNCH_SCRIPT_VERSION + 1}`)]) {
      writeFileSync(hand, newer)
      assert.deepEqual(installHand(hand, from), { code: 0, out: 'DONE' })
      assert.equal(readFileSync(hand, 'utf8'), newer)
    }
    // A folder where the copy goes: nothing written, no error out of it.
    const blocked = join(mkdtempSync(join(work, 'install-')), 'claude-launch.ps1')
    mkdirSync(blocked)
    assert.deepEqual(installHand(blocked, from), { code: 0, out: 'DONE' })
    assert.deepEqual(leftovers(state), [])
    assert.ok(!machine.INSTALL_HAND_COPY.join('\n').includes('Replace('))
  })

  test('planted: a carried copy that is not the pinned script is never put in place', () => {
    const state = mkdtempSync(join(work, 'install-'))
    const path = join(state, 'claude-launch.ps1')
    writeFileSync(path, 'old')
    const faulty = install(path, `${script}# one line more\n`)
    assert.equal(faulty.out, 'REFUSED the copy this plugin carries does not have the SHA-256 it pins')
    assert.equal(readFileSync(path, 'utf8'), 'old')
    assert.deepEqual(leftovers(state), [])
  })
})
