// The shared launcher (launch, in the shared machine code), as text: what each place's script checks,
// in what order, what it never does, and its answer; the transport a replacing launch picks; and the
// one helper that builds every path named by an id. No script runs here: scripts/claude-launch.test.mjs
// runs claude-launch.ps1 against a stub claude.exe.
import { describe, expect, test } from 'claude-code/testing'
import {
  asciiBase64,
  claimCheckScript,
  idPath,
  INSTALL_HAND_COPY,
  INSTALL_LAUNCHER,
  launchHandPath,
  launchScriptPath,
  LAUNCH_SCRIPT_VERSION,
  PANE_VERSION,
  launchFolderFault,
  launchFolderSaid,
  LAUNCH_SCRIPT_TEXT,
  idPathOrNone,
  launch,
  LAUNCH_SCRIPT_SHA256,
  launchScriptText,
  type LaunchInput,
  lanesUpdateScript,
  leftScript,
  panePath,
  paneTicket,
  paneTicketPath,
  parseLaunch,
  parseProbe,
  pendingPath,
  paneNoLeft,
  pickLaunchTransport,
  type Probe,
  probeScript,
  PSMODULEPATH_RESET,
  RECHECK,
  releaseScript,
  selfcheckPath,
  SLOT_NOT_RECOGNISED,
  SLOT_SCRIPT_SHA256,
  STDIN_BOOTSTRAP,
  wakePath,
} from '../hooks/machine'
import { decode, ELSEWHERE, ft, inSlot, LAUNCH, machine, NOW, PERMISSION_FLAGS, type RawProbe, REPO, T, W } from './fixtures'

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const STATE = 'C:\\Users\\u\\AppData\\Local\\claude-self-tools'
const CONFIG = 'C:\\Users\\u\\.claude'
const OTHER_CONFIG = 'D:\\other cfg'
const TOKEN = '00000000-0000-4000-a000-000000000001'
const SLOT = `20-${ft(1)}`

/** A launch: T resumed in its folder, under a launch's claim, after this session's claude.exe 100. */
const input = (change: Partial<LaunchInput> = {}): LaunchInput => ({
  powershell: POWERSHELL,
  kind: 'resume',
  id: T,
  folder: ELSEWHERE,
  claim: LAUNCH,
  configDirs: [CONFIG, OTHER_CONFIG],
  stateDir: STATE,
  where: { window: true },
  waitForExit: { pid: 100, created: ft(2) },
  maxSessions: 12,
  heavySlotRoot: null,
  ...change,
})

/** A launch that waits for nothing: a steward's, or a start. */
function noWait(change: Partial<LaunchInput> = {}): LaunchInput {
  const { waitForExit, ...rest } = input(change)
  void waitForExit
  return rest
}

/** A start's launch: a new id and name in a window, its id checked new, after nothing. */
const START = noWait({ kind: 'start', name: 'dealerwrap', checks: { fresh: true, floor: true, input: true } })

/** The checks a launch of another process must ask for. */
const ANOTHER = { floor: true, input: true, live: true }

/** Every place a launch goes in this version, one script each. */
const SCRIPTS: [string, string][] = [
  ['the window', launchScriptText(input())],
  ['the window, a left record checked', launchScriptText(input({ left: { exitAt: NOW - 60_000 } }))],
  ['the window, not waiting, NOT LIVE checked now', launchScriptText(noWait({ checks: ANOTHER }))],
  ['the window, a start', launchScriptText(START)],
  ['this tab', launchScriptText(input({ where: { pane: { token: TOKEN } }, now: NOW }))],
  ["this pane's slot", launchScriptText(input({ where: { slot: SLOT }, claim: `slot:${SLOT}` }))],
  ["'auto' (self-restart's)", launchScriptText(input({ id: W, folder: REPO, where: 'auto' }))],
  ['an idle slot elsewhere, a resume', launchScriptText(noWait({ where: { slot: SLOT }, claim: `slot:${SLOT}`, checks: ANOTHER, left: { size: 12, mtime: 34 } }))],
  ['an idle slot elsewhere, a start', launchScriptText(noWait({ kind: 'start', name: 'dealerwrap', where: { slot: SLOT }, claim: `slot:${SLOT}`, checks: { fresh: true, floor: true, input: true }, heavySlotRoot: 'O:\\heavy' }))],
  ['a tab, a resume that waits', launchScriptText(input({ where: { tab: { window: 'claude-1', title: 'tab one' } }, claim: `launch:${T}`, left: { exitAt: NOW - 60_000 } }))],
  ['a tab, a start', launchScriptText(noWait({ kind: 'start', name: 'dealerwrap', where: { tab: { window: 'claude-4', title: 'dealerwrap', pos: [960, 540], size: [160, 42] } }, claim: `launch:${T}`, checks: { fresh: true, floor: true, input: true } }))],
  ['a named window', launchScriptText(noWait({ where: { window: { name: 'claude-overflow', pos: [1920, 0], size: [140, 60] } }, claim: `launch:${T}`, checks: ANOTHER }))],
]

/** The window's own script, as it is put in the launch script: one single-quoted literal, its quotes doubled. */
function innerOf(script: string): string {
  const from = script.indexOf("$inner = '") + "$inner = '".length
  const to = script.indexOf("'\r\n", from + 1)
  let end = from
  // The literal ends at the first single quote that isn't doubled.
  for (let i = from; i < script.length; i += 1) {
    if (script[i] === "'" && script[i + 1] === "'") {
      i += 1
      continue
    }
    if (script[i] === "'") {
      end = i
      break
    }
  }
  expect(to).toBeGreaterThan(from)
  return script.slice(from, end).split("''").join("'")
}

describe('launch(): one powershellCall, the script on standard input', () => {
  test('its argv is the fixed bootstrap, never the script (never back on -EncodedCommand of the script itself)', () => {
    for (const where of [{ window: true } as const, { pane: { token: TOKEN } }, { slot: SLOT }, 'auto' as const]) {
      const claim = typeof where === 'object' && 'slot' in where ? `slot:${SLOT}` : LAUNCH
      const call = launch(input({ where, claim, now: NOW }))
      expect(call.argv.slice(0, 4)).toEqual([POWERSHELL, '-NoProfile', '-NonInteractive', '-EncodedCommand'])
      expect(call.argv).toHaveLength(5)
      expect(decode(String(call.argv[4]))).toBe(STDIN_BOOTSTRAP)
      expect(call.stdin).toBe(launchScriptText(input({ where, claim, now: NOW })))
    }
  })

  test('every script resets PSModulePath to Windows PowerShell 5.1\'s own folders before anything else runs', () => {
    expect(PSMODULEPATH_RESET).toBe(
      '$env:PSModulePath = @([Environment]::GetFolderPath("MyDocuments") + "\\WindowsPowerShell\\Modules", [Environment]::GetFolderPath("ProgramFiles") + "\\WindowsPowerShell\\Modules", [Environment]::GetFolderPath("System") + "\\WindowsPowerShell\\v1.0\\Modules") -join ";"',
    )
    const others = [
      probeScript({ ids: [T], configDirs: [CONFIG], stateDir: STATE, left: true }),
      releaseScript({ stateDir: STATE, id: T, by: LAUNCH }),
      claimCheckScript({ stateDir: STATE, id: T, by: LAUNCH, configDirs: [CONFIG] }),
      leftScript({ stateDir: STATE, id: T, how: 'exit', configDirs: [CONFIG], by: 'self-switch' }),
      lanesUpdateScript({ configDir: CONFIG, name: 'dealerwrap', entry: { session: T, folder: ELSEWHERE, ws: 'default', at: NOW } }),
    ]
    for (const script of [...SCRIPTS.map(([, s]) => s), ...others]) {
      const lines = script.split('\r\n')
      expect(lines.indexOf(PSMODULEPATH_RESET)).toBe(2)
      expect(lines.slice(0, 2)).toEqual(["$ErrorActionPreference = 'Stop'", "$ProgressPreference = 'SilentlyContinue'"])
    }
    // The window's own script too, first thing.
    expect(innerOf(SCRIPTS[0]?.[1] ?? '').split('\r\n')[2]).toBe(PSMODULEPATH_RESET)
  })

  test('nothing but claude-launch.ps1 is ever started as claude: no claude.exe, no Get-Command claude, no call but & $launchPath', () => {
    for (const [name, script] of SCRIPTS) {
      expect(script).not.toMatch(/Get-Command -Name ['"]?claude/)
      // A line that says how to run it by hand is words, not a call.
      const code = script.split(/\r?\n/).filter(line => !line.includes('Write-Host')).join('\n')
      const calls = code.match(/&\s+(\$\w+|'[^'\r\n]*'|"[^"\r\n]*")/g) ?? []
      expect([name, calls.filter(call => call !== '& $launchPath')]).toEqual([name, []])
      // And no flag of claude's at all: claude-launch.ps1 takes -Resume/-Start, -Name and -Dir.
      expect(script).not.toMatch(/&\s+\$launchPath[^\r\n]*--/)
    }
    expect(launchScriptText(input())).toContain('& $launchPath -Resume $id -Dir $folder')
    expect(launchScriptText(START)).toContain('& $launchPath -Start $id -Name $name -Dir $folder')
  })

  test('the window hands claude-launch.ps1 every config folder it read and the left record\'s stat, so its own last look is the same (F1)', () => {
    expect(innerOf(launchScriptText(input()))).toContain('  & $launchPath -Resume $id -Dir $folder -ConfigDir $configDirs\r\n')
    expect(innerOf(launchScriptText(input({ left: { exitAt: NOW - 60_000 } })))).toContain(`  & $launchPath -Resume $id -Dir $folder -ConfigDir $configDirs -LeftExitAt '${NOW - 60_000}'\r\n`)
    expect(innerOf(launchScriptText(input({ left: { size: 4096, mtime: NOW - 1000 } })))).toContain(`  & $launchPath -Resume $id -Dir $folder -ConfigDir $configDirs -LeftSize '4096' -LeftMtime '${NOW - 1000}'\r\n`)
    expect(innerOf(launchScriptText(START))).toContain('  & $launchPath -Start $id -Name $name -Dir $folder -ConfigDir $configDirs\r\n')
    expect(innerOf(launchScriptText(input()))).toContain(`$configDirs = @('${CONFIG}', '${OTHER_CONFIG}')`)
  })

  test('the run of claude-launch.ps1 is caught: an error (a policy, a locked claude.exe) is said with the way by hand, never a window that closes on it (F3)', () => {
    const inner = innerOf(SCRIPTS[0]?.[1] ?? '')
    const run = inner.indexOf('  & $launchPath -Resume')
    expect(inner.lastIndexOf('try {', run)).toBeGreaterThan(inner.indexOf('$started = Get-Date'))
    const caught = inner.indexOf('} catch {', run)
    expect(caught).toBeGreaterThan(run)
    expect(inner.slice(caught)).toMatch(/^\} catch \{\r\n  Write-Refused \("claude-launch\.ps1 stopped on an error: " \+ \$_\.Exception\.Message\)\r\n  Write-Host \("claude-launch\.ps1 stopped on an error, so the session may not have resumed here: " \+ \$_\.Exception\.Message\)\r\n  Write-Host \("Once it is safe, resume it yourself: " \+ "& '" \+ \$handPath \+ "' -Resume " \+ \$id \+ " -Dir '" \+ \$folder \+ "'"\)\r\n  Release-Claim\r\n  Read-Host "Press Enter to close this window" \| Out-Null\r\n  exit 1\r\n\}/)
  })

  test('no environment is changed but PSModulePath: the launch environment is claude-launch.ps1\'s alone', () => {
    for (const [, script] of SCRIPTS) {
      expect(script).not.toContain('SetEnvironmentVariable')
      expect(script).not.toMatch(/Remove-Item[^\r\n]*Env:|Set-Item[^\r\n]*Env:/)
      const sets = script.match(/\$env:\w+\s*=/g) ?? []
      // But the stamps a tab's process forwards to it: named, never a variable of the launch environment.
      expect(sets.every(set => ['$env:PSModulePath =', '$env:CLAUDE_SELF_TOOLS_WT_WINDOW =', '$env:CLAUDE_SELF_TOOLS_WT_TAB ='].includes(set))).toBe(true)
      for (const name of ['WT_SESSION', 'WT_PROFILE_ID', 'NO_COLOR', 'CLAUDECODE', 'CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP']) expect(script).not.toContain(name)
    }
  })

  test('no permission flag, no Git Bash, no MSYS and no /proc in any script', () => {
    for (const [, script] of SCRIPTS) {
      for (const flag of PERMISSION_FLAGS) expect(script).not.toContain(flag)
      expect(script).not.toMatch(/\bbash(\.exe)?\b|\bsh\.exe\b|msys|\/proc\//i)
    }
  })

  test('claude-launch.ps1 only from its pinned place: the copy the launch carries put there when it is missing or has another SHA-256, refused only when that fails, before anything is taken or opened; checked again in the window right before it runs', () => {
    for (const script of [SCRIPTS[0]?.[1] ?? '', SCRIPTS[6]?.[1] ?? '']) {
      // Its own name, by its hash: plugins of another version write another file (F2).
      expect(script).toContain(`$launchPath = '${STATE}\\claude-launch-${LAUNCH_SCRIPT_SHA256.slice(0, 8)}.ps1'`)
      expect(script).toContain(`$handPath = '${STATE}\\claude-launch.ps1'`)
      // The copy it carries: LAUNCH_SCRIPT_TEXT's bytes, whole.
      expect(script).toContain(`$launcherCopy = '${asciiBase64(LAUNCH_SCRIPT_TEXT)}'`)
      for (const line of INSTALL_LAUNCHER) expect(script).toContain(line)
      for (const line of INSTALL_HAND_COPY) expect(script).toContain(line)
      // The copy for use by hand after the launcher is in place, and never refused on.
      const hand = script.indexOf(`Install-HandCopy $handPath $launchPath ${LAUNCH_SCRIPT_VERSION}`)
      expect(hand).toBeGreaterThan(script.indexOf("if ($null -ne $installWhy) { Refuse 'launcher'"))
      expect(script.slice(hand, script.indexOf('\r\n', hand))).not.toContain('Refuse')
      expect(INSTALL_HAND_COPY.join('\n')).not.toContain('Replace(')
      const install = script.indexOf(`$installWhy = Install-Launcher $launchPath $launcherCopy '${LAUNCH_SCRIPT_SHA256}'`)
      const early = script.indexOf("if ($null -ne $installWhy) { Refuse 'launcher'")
      expect(install).toBeGreaterThan(0)
      expect(early).toBeGreaterThan(install)
      expect(early).toBeLessThan(script.indexOf('$taken = New-Claim $claimPath $claimText'))
      // Written whole under another name, checked, then moved over: never written in place.
      expect(INSTALL_LAUNCHER.join('\n')).toContain('[IO.FileMode]::CreateNew')
      expect(INSTALL_LAUNCHER.join('\n')).toContain('[IO.File]::Replace($tmp, $path, [NullString]::Value)')
      expect(INSTALL_LAUNCHER.join('\n')).not.toMatch(/WriteAllBytes\(\$path|WriteAllText\(\$path|Set-Content|Out-File/)
      const inner = innerOf(script)
      expect(inner.indexOf(`(Get-Sha256 $launchPath) -cne '${LAUNCH_SCRIPT_SHA256}'`)).toBeLessThan(inner.indexOf('& $launchPath'))
      expect(inner.indexOf(`(Get-Sha256 $launchPath) -cne '${LAUNCH_SCRIPT_SHA256}'`)).toBeGreaterThan(inner.indexOf('$gone = Wait-Gone'))
      expect(script).toContain('[Security.Cryptography.SHA256]::Create()')
      expect(script).not.toContain('Get-FileHash')
    }
    // This tab and this pane's slot start nothing of their own: the wrapper and the slot runner do, after this process.
    for (const script of [SCRIPTS[4]?.[1] ?? '', SCRIPTS[5]?.[1] ?? '']) {
      expect(script).not.toContain('Start-Process')
      expect(script).not.toContain('& $launchPath')
    }
  })

  test('Windows PowerShell by its known path, -ExecutionPolicy Bypass for the window alone (it pins claude-launch.ps1 by its hash), the window script compressed into a fixed bootstrap', () => {
    const script = SCRIPTS[0]?.[1] ?? ''
    expect(script).toContain(`$window = Start-Process -FilePath '${POWERSHELL}' -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded -PassThru`)
    expect(script).not.toContain('RemoteSigned')
    expect(script).not.toContain('$PSHOME')
    expect(script).toContain('$gzip = [IO.Compression.GZipStream]::new($packed, [IO.Compression.CompressionMode]::Compress)')
    expect(() => launchScriptText(input({ powershell: 'C:\\evil\\powershell.exe' }))).toThrow()
    expect(() => launchScriptText(input({ powershell: 'powershell.exe' }))).toThrow()
  })
})

describe('the checks, the claim and the place, in one run, in that order', () => {
  test('the process waited for is this script\'s own claude.exe, by its pid and its start, before anything else is done', () => {
    for (const [, script] of SCRIPTS.filter(([name]) => !name.includes('not waiting') && !name.includes('a start') && !name.includes('elsewhere') && !name.includes('named window'))) {
      const wait = script.indexOf(`if ([long]$session.ProcessId -ne 100 -or [math]::Abs([long](Get-Created $session) - [long]'${ft(2)}') -gt 10000) { Refuse 'wait'`)
      expect(wait).toBeGreaterThan(0)
      expect(wait).toBeLessThan(script.indexOf('$taken = New-Claim'))
    }
  })

  test('a launch that waits takes its last look after the wait: in the window, RECHECK and the folder and the claim, then claude-launch.ps1', () => {
    const inner = innerOf(SCRIPTS[0]?.[1] ?? '')
    // F1: waited for by its handle, then looked at again until it goes (S3): no refusal for one still running.
    const wait = inner.search(/\$gone = Wait-Gone 100 '\d+' 600\r\n/)
    expect(wait).toBeGreaterThan(0)
    expect(inner.indexOf('while (-not $gone) { $gone = Wait-Gone 100 ')).toBeGreaterThan(wait)
    expect(inner).not.toContain('The old process is still running')
    // Read from the wait on: RECHECK has lines as plain as a closing brace, which the functions above it hold too.
    for (const line of RECHECK) expect(inner.indexOf(`    ${line}`, wait)).toBeGreaterThan(wait)
    expect(inner.indexOf('$lock.by -cne $by')).toBeGreaterThan(inner.indexOf(`    ${RECHECK[RECHECK.length - 1]}`, wait))
    expect(inner.indexOf('& $launchPath')).toBeGreaterThan(inner.indexOf('$lock.by -cne $by'))
    // waitForExit skipped: no wait, no last look after it. A test that plants it must fail here.
    expect(innerOf(launchScriptText(noWait({ checks: ANOTHER })))).not.toContain('Wait-Gone ')
  })

  test('a launch that does not wait checks NOT LIVE now (and the left record), before the claim; one that waits is refused that check', () => {
    const now = SCRIPTS[2]?.[1] ?? ''
    const recheck = now.indexOf(`  ${RECHECK[2]}`)
    expect(recheck).toBeGreaterThan(0)
    expect(recheck).toBeLessThan(now.indexOf("Refuse 'live' $live"))
    expect(now.indexOf("Refuse 'live' $live")).toBeLessThan(now.indexOf('$taken = New-Claim'))
    expect(() => launchScriptText(input({ checks: { live: true } }))).toThrow(/last look after the wait/)
  })

  test('a start: its id new in every config folder (transcripts, registry files, command lines), then the claim; its name checked', () => {
    const script = launchScriptText(START)
    const fresh = script.indexOf('$fresh = $null')
    expect(fresh).toBeGreaterThan(0)
    expect(fresh).toBeLessThan(script.indexOf('$taken = New-Claim'))
    // Every config folder's projects, not the first alone.
    expect(script).toContain(`$configDirs = @('${CONFIG}', '${OTHER_CONFIG}')`)
    expect(script).toContain('foreach ($dir in $configDirs) {\r\n  $projects = Join-Path $dir "projects"')
    expect(script).toContain('$text.IndexOf($id, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $fresh = "the registry file " + $f.Name + " names it" }')
    expect(script).toContain('"$($p.CommandLine)".IndexOf($id, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $fresh = "process " + $p.ProcessId + " names it on its command line" }')
    expect(script).toContain("if ($null -ne $fresh) { Refuse 'fresh' $fresh }")
    expect(script).toContain("$name = ''dealerwrap''")
    for (const name of ['', 'Dealerwrap', 'deal wrap', "x'; calc", '-x', 'a'.repeat(41)]) expect(() => launchScriptText({ ...START, name })).toThrow()
    expect(() => launchScriptText({ ...START, checks: { floor: true, input: true } })).toThrow(/checks\.fresh/)
    expect(() => launchScriptText({ ...START, where: { pane: { token: TOKEN } }, now: NOW })).toThrow(/window/)
  })

  test('the claim is taken after every check, and a refusal after it gives it back first: nothing is written after a failed check', () => {
    for (const [, script] of SCRIPTS) {
      const claim = script.indexOf('$taken = New-Claim $claimPath $claimText')
      expect(claim).toBeGreaterThan(0)
      for (const refusal of ["Refuse 'session'", "Refuse 'wait'", "Refuse 'slot'", "Refuse 'pane'", "Refuse 'launcher'", "Refuse 'live'", "Refuse 'fresh'"]) {
        const at = script.indexOf(refusal)
        if (at >= 0) expect(at).toBeLessThan(claim)
      }
      // What is placed comes after the claim.
      for (const place of ['[IO.File]::WriteAllText($temp, $text)', '$window = Start-Process']) {
        const at = script.indexOf(place)
        if (at >= 0) expect(at).toBeGreaterThan(claim)
      }
      expect(script).toContain('function Refuse($code, $why) {\r\n  if ($taken) { Release-Claim }')
      expect(script).toContain('if ($null -ne $lock -and $lock.by -ceq $by) {\r\n      for ($try = 0; $try -lt 3; $try++) {\r\n        if ($try -gt 0) { Start-Sleep -Milliseconds 250 }\r\n        try { [IO.File]::Delete($claimPath); break } catch { }\r\n')
      expect(script).toContain("} catch { Refuse 'place' ($tool + ': the launch could not be placed: ' + $_.Exception.Message) }")
    }
  })

  test("this tab: the ticket paneTicket builds, written whole after the claim the ticket names", () => {
    const script = SCRIPTS[4]?.[1] ?? ''
    // The ticket names every config folder this launch reads: the wrapper's last look reads them all.
    const ticket = paneTicket({ token: TOKEN, resume: T, by: LAUNCH, dir: ELSEWHERE, at: NOW, configDirs: [CONFIG, OTHER_CONFIG] })
    expect(JSON.parse(ticket).configDirs).toEqual([CONFIG, OTHER_CONFIG])
    expect(script).toContain(`$text = '${ticket}'`)
    expect(script).toContain(`$final = '${paneTicketPath(STATE, TOKEN)}'`)
    expect(script).toContain('[IO.File]::Replace($temp, $final, [NullString]::Value)')
    expect(script).toContain("$placed = 'pane " + TOKEN + "'")
    expect(() => launchScriptText(input({ where: { pane: { token: TOKEN } } }))).toThrow(/time/)
    expect(() => launchScriptText(input({ where: { pane: { token: 'not-a-token' } }, now: NOW }))).toThrow()
    expect(() => launchScriptText(noWait({ where: { pane: { token: TOKEN } }, now: NOW, checks: ANOTHER }))).toThrow(/replaces its caller/)
    // A move that rests on a left record: the ticket carries its stat, for the wrapper's last look (pane file version 3).
    const withLeft = launchScriptText(input({ where: { pane: { token: TOKEN } }, now: NOW, left: { exitAt: NOW - 60_000 } }))
    const leftTicket = paneTicket({ token: TOKEN, resume: T, by: LAUNCH, dir: ELSEWHERE, at: NOW, configDirs: [CONFIG, OTHER_CONFIG], left: { exitAt: NOW - 60_000 } })
    expect(withLeft).toContain(`$text = '${leftTicket}'`)
    expect(JSON.parse(leftTicket).left).toEqual({ exitAt: NOW - 60_000 })
    expect(() => launchScriptText(input({ where: { pane: { token: TOKEN } }, now: NOW, left: { size: 1.5, mtime: 1 } }))).toThrow()
  })

  test('a ticket naming more than one config folder, or carrying a left record\'s stat, needs pane file version 3, read by the launch itself before the claim, whatever its caller judged (F4)', () => {
    const versionRead = `if ($null -eq $paneV -or $paneV -lt ${PANE_VERSION}) { Refuse 'pane'`
    expect(PANE_VERSION).toBe(3)
    const two = SCRIPTS[4]?.[1] ?? ''
    const oneLeft = launchScriptText(input({ where: { pane: { token: TOKEN } }, now: NOW, configDirs: [CONFIG], left: { exitAt: NOW - 60_000 } }))
    for (const script of [two, oneLeft]) {
      expect(script).toContain(`$paneFile = '${panePath(STATE, TOKEN)}'`)
      expect(script).toContain('try { $paneDoc = [IO.File]::ReadAllText($paneFile) | ConvertFrom-Json; if ($paneDoc.v -is [ValueType]) { $paneV = [long]$paneDoc.v } } catch { $paneV = $null }')
      const read = script.indexOf(versionRead)
      expect(read).toBeGreaterThan(script.indexOf("$transport = 'pane'"))
      expect(read).toBeLessThan(script.indexOf('$taken = New-Claim $claimPath $claimText'))
    }
    // One config folder and no left record: a version 2 wrapper takes it, so nothing is read.
    expect(launchScriptText(input({ where: { pane: { token: TOKEN } }, now: NOW, configDirs: [CONFIG] }))).not.toContain('$paneFile')
  })

  test("this pane's slot: its runner verified (the shipped hash, the id asked for) before the claim, then the record written whole", () => {
    const script = SCRIPTS[5]?.[1] ?? ''
    expect(script).toContain(`$slotOk = $slotHash -eq '${SLOT_SCRIPT_SHA256}'`)
    const check = script.indexOf(`if (-not $slotOk -or $slot["id"] -cne '${SLOT}')`)
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(script.indexOf('$taken = New-Claim'))
    expect(script).toContain(`$final = '${STATE}\\slots\\${SLOT}.next.json'`)
    expect(script).toContain('$text = [ordered]@{ v = 1; resume = $id; folder = $folder; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); configDirs = [object[]]$configDirs; launcher = \'' + LAUNCH_SCRIPT_SHA256 + "' } | ConvertTo-Json -Compress -Depth 3")
    expect(() => launchScriptText(input({ where: { slot: SLOT } }))).toThrow(/slot's claim/)
    expect(() => launchScriptText(input({ where: { slot: '..\\x' }, claim: 'slot:1-2' }))).toThrow()
    // A verified runner is version 2: its last look checks a left record, carried in the record.
    expect(launchScriptText(input({ where: { slot: SLOT }, claim: `slot:${SLOT}`, left: { exitAt: NOW } }))).toContain(`; left = [ordered]@{ exitAt = ${NOW} } } | ConvertTo-Json -Compress -Depth 3`)
  })

  test('a launch of another process must ask for the floor and the input idle, and a resume for NOT LIVE: never a launch that skips them', () => {
    expect(() => launchScriptText(noWait({ checks: { live: true } }))).toThrow(/checks the floor and the input idle/)
    expect(() => launchScriptText(noWait({ checks: { live: true, floor: true } }))).toThrow(/checks the floor and the input idle/)
    expect(() => launchScriptText(noWait({ checks: { floor: true, input: true } }))).toThrow(/NOT LIVE/)
    // One that replaces its caller adds no process: no floor, and it may ask for the input idle.
    expect(launchScriptText(input())).not.toContain("Refuse 'memory'")
    expect(launchScriptText(input({ checks: { input: true } }))).toContain("Refuse 'input'")
  })

  test('every input is checked: ids, folders (quotes, a semicolon), config folders, claimants, names', () => {
    for (const id of ['', '..\\x', `${T}'`, T.toUpperCase()]) expect(() => launchScriptText(input({ id }))).toThrow()
    for (const folder of ["C:\\o'brien", 'C:\\a;b', 'C:\\a"b', 'relative', 'C:\\a\\..\\b']) expect(() => launchScriptText(input({ folder }))).toThrow()
    expect(() => launchScriptText(input({ configDirs: [] }))).toThrow()
    expect(() => launchScriptText(input({ configDirs: Array.from({ length: 9 }, (_, i) => `C:\\c${i}`) }))).toThrow()
    expect(() => launchScriptText(input({ claim: "launch:x'; calc" }))).toThrow()
    expect(() => launchScriptText(input({ name: 'x' }))).toThrow(/no name/)
    expect(() => launchScriptText(input({ tool: "x'; calc" }))).toThrow()
    expect(() => launchScriptText(input({ waitForExit: { pid: -1, created: '1' } }))).toThrow()
  })

  test('a folder a launch never takes is said by its class of character', () => {
    const cases: [string, string][] = [
      ['C:\\a;b', 'holds a semicolon (;)'],
      ["C:\\o'brien", 'holds a quote (straight or typographic)'],
      [`C:\\a${String.fromCharCode(7)}b`, 'holds a control character'],
      ['C:\\a|b', 'holds a character Windows does not take in a folder name'],
      ['relative', 'is not an absolute folder'],
      ['C:\\a\\..\\b', "has a '.' or '..' part"],
    ]
    for (const [folder, said] of cases) {
      expect(launchFolderFault(folder)).toContain(said)
      expect(() => launchScriptText(input({ folder }))).toThrow(new RegExp(said.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
    expect(launchFolderFault(ELSEWHERE)).toBeUndefined()
    expect(launchFolderSaid('C:\\a;b', 'holds a semicolon (;)')).toBe(
      `the folder "C:\\\\a;b" holds a semicolon (;), so a launch never takes it: it takes an absolute folder with no quote, control character, semicolon, < > | ? * or /, and no '.' or '..' part`,
    )
  })
})

describe('a deadline: a run its caller gave up on places nothing, and takes back what it placed late', () => {
  const DEADLINE = NOW + 20_000
  const late = (where: LaunchInput['where'], claim = LAUNCH) => launchScriptText(input({ where, claim, now: NOW, deadline: DEADLINE }))

  test('past the deadline before the claim: refused, nothing taken or placed', () => {
    for (const script of [late({ window: true }), late({ pane: { token: TOKEN } }), late({ slot: SLOT }, `slot:${SLOT}`), late('auto')]) {
      const check = script.indexOf(`if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -gt ${DEADLINE}) { Refuse 'late'`)
      expect(check).toBeGreaterThan(0)
      expect(check).toBeLessThan(script.indexOf('$taken = New-Claim $claimPath $claimText'))
    }
  })

  test('once placed, past the deadline or with the claim no longer its own: the ticket or the record written over as withdrawn, the claim given back (which turns a window away)', () => {
    for (const script of [late({ window: true }), late({ pane: { token: TOKEN } }), late({ slot: SLOT }, `slot:${SLOT}`), late('auto')]) {
      const after = script.indexOf(`if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -gt ${DEADLINE} -or $null -eq $lockNow -or $lockNow.by -cne $by) {`)
      expect(after).toBeGreaterThan(script.indexOf("} catch { Refuse 'place'"))
      expect(after).toBeLessThan(script.indexOf('[Console]::Out.WriteLine("launched " + $placed)'))
      expect(script).toContain('  if ($null -ne $final -and $transport -ne "window") { try { [IO.File]::WriteAllText($final, \'{"v":1,"cancelled":true}\') } catch { } }')
      // Refuse gives the claim back, this run's having been taken.
      expect(script).toContain("  Refuse 'late' ($tool + ': the launch was placed past its deadline, or its claim was taken back meanwhile, so it is withdrawn')")
    }
    // Without a deadline, no such step.
    expect(launchScriptText(input())).not.toContain("Refuse 'late'")
    expect(() => launchScriptText(input({ deadline: Number.NaN }))).toThrow(/deadline/)
  })
})

describe('parseLaunch', () => {
  test('reads both answers, the claim and a fallback', () => {
    expect(parseLaunch(`claim ${LAUNCH}\r\nlaunched window - 17716\r\n`)).toEqual({ launched: { transport: 'window', label: '-', pid: 17716 }, claim: LAUNCH })
    expect(parseLaunch(`claim slot:${SLOT}\r\nlaunched slot ${SLOT}\r\n`)).toEqual({ launched: { transport: 'slot', label: SLOT }, claim: `slot:${SLOT}` })
    expect(parseLaunch(`claim ${LAUNCH}\r\nlaunched pane ${TOKEN}\r\n`)).toEqual({ launched: { transport: 'pane', label: TOKEN }, claim: LAUNCH })
    expect(parseLaunch(`claim ${LAUNCH}\r\nfallback slot hash unreadable: denied\r\nlaunched window - 9\r\n`)).toEqual({ launched: { transport: 'window', label: '-', pid: 9 }, claim: LAUNCH, fallback: 'slot hash unreadable: denied' })
    expect(parseLaunch('refused claim self-switch: another switch, restart or launch holds the claim on this conversation\r\n')).toEqual({
      refused: { code: 'claim', why: 'self-switch: another switch, restart or launch holds the claim on this conversation' },
    })
    // A refusal after the claim was taken (and given back) still names it.
    expect(parseLaunch(`claim ${LAUNCH}\r\nrefused place the launch could not be placed: denied\r\n`)).toEqual({ refused: { code: 'place', why: 'the launch could not be placed: denied' }, claim: LAUNCH })
    expect(parseLaunch('')).toEqual({ error: 'the launch script printed no answer' })
    expect(parseLaunch('launched elsewhere x\r\n')).toEqual({ error: 'the launch script printed no answer' })
  })
})

describe('pickLaunchTransport: the coordinating note\'s order, for a launch that replaces its caller', () => {
  const probeOf = (change?: (probe: RawProbe) => void): Probe => {
    const parsed = parseProbe(`${JSON.stringify(machine(change))}\r\n`)
    if ('error' in parsed) throw new Error(parsed.error)
    return parsed
  }
  const PANE = { token: TOKEN, pane: { pid: 20, started: ft(1), v: 3 as const } }

  test('this tab first (its wrapper is claude.exe\'s parent), then this pane\'s slot, then a window saying why a slot runner was passed over', () => {
    expect(pickLaunchTransport(probeOf(), null, { replacing: true, pane: PANE, configCount: 1, needsLeft: false })).toEqual({ where: { pane: { token: TOKEN } } })
    expect(pickLaunchTransport(probeOf(p => inSlot(p)), null, { replacing: true, configCount: 1, needsLeft: false })).toEqual({ where: { slot: SLOT } })
    expect(pickLaunchTransport(probeOf(), null, { replacing: true, configCount: 1, needsLeft: false })).toEqual({ where: { window: true } })
    expect(pickLaunchTransport(probeOf(p => inSlot(p, 'e'.repeat(64))), null, { replacing: true, configCount: 1, needsLeft: false })).toEqual({
      where: { window: true },
      fallback: "this pane's claude-slot.ps1 has another SHA-256 than the one shipped (an edited or older copy: copy the shipped script and restart the pane)",
    })
    expect(pickLaunchTransport(probeOf(p => (p.slotSeen = true)), null, { replacing: true, configCount: 1, needsLeft: false })).toEqual({ where: { window: true }, fallback: SLOT_NOT_RECOGNISED })
    // A pane file of another PowerShell: not this tab.
    expect(pickLaunchTransport(probeOf(), null, { replacing: true, pane: { token: TOKEN, pane: { pid: 21, started: ft(1), v: 3 } }, configCount: 1, needsLeft: false })).toEqual({ where: { window: true } })
    // A wrapper of version 2 reads its own config folder alone: not for a launch that reads two.
    const older = { token: TOKEN, pane: { pid: 20, started: ft(1), v: 2 as const } }
    expect(pickLaunchTransport(probeOf(), null, { replacing: true, pane: older, configCount: 1, needsLeft: false })).toEqual({ where: { pane: { token: TOKEN } } })
    expect(pickLaunchTransport(probeOf(), null, { replacing: true, pane: older, configCount: 2, needsLeft: false })).toEqual({ where: { window: true } })
    expect(pickLaunchTransport(probeOf(), null, { replacing: true, pane: PANE, configCount: 2, needsLeft: false })).toEqual({ where: { pane: { token: TOKEN } } })
  })

  test("a launch that rests on a left record: a tab of pane file version 3, or this pane's slot, whose runner of the shipped hash is version 2; else a window", () => {
    expect(pickLaunchTransport(probeOf(), null, { replacing: true, pane: PANE, configCount: 1, needsLeft: true })).toEqual({ where: { pane: { token: TOKEN } } })
    const older = { token: TOKEN, pane: { pid: 20, started: ft(1), v: 2 as const } }
    expect(pickLaunchTransport(probeOf(), null, { replacing: true, pane: older, configCount: 1, needsLeft: true })).toEqual({ where: { window: true } })
    expect(pickLaunchTransport(probeOf(p => inSlot(p)), null, { replacing: true, configCount: 1, needsLeft: true })).toEqual({ where: { slot: SLOT } })
    expect(paneNoLeft(older.pane)).toMatch(/pane file is version 2/)
    expect(paneNoLeft(PANE.pane)).toBeUndefined()
  })

  test('configCount and needsLeft are required, never defaulted: a caller that leaves either out is refused, not given a weaker tab (F4)', () => {
    expect(() => pickLaunchTransport(probeOf(), null, { replacing: true, pane: PANE } as never)).toThrow(/1 to 8 config folders/)
    expect(() => pickLaunchTransport(probeOf(), null, { replacing: true, pane: PANE, configCount: 2 } as never)).toThrow(/needsLeft/)
    expect(() => pickLaunchTransport(probeOf(), null, { replacing: true, configCount: 0, needsLeft: false })).toThrow(/1 to 8/)
    expect(() => pickLaunchTransport(probeOf(), null, { replacing: true, configCount: 9, needsLeft: false })).toThrow(/1 to 8/)
    expect(() => pickLaunchTransport(probeOf(), null, { replacing: true, configCount: 1.5, needsLeft: false })).toThrow(/1 to 8/)
  })

})

describe('every path named by an id is built by one helper, which refuses any other id before joining', () => {
  const BAD = ['..\\x', '..%5cx', '../x', 'C:\\Windows\\x', `${T}x`, `${T.slice(0, 35)}`, T.toUpperCase(), `${T}\\..\\x`, '1'.repeat(80), '', '20-5\\..\\x']

  test('claims, left records, pokes, wake markers, pending markers, self-checks, the gate: session ids', () => {
    for (const file of ['claim', 'left', 'poke', 'wake', 'pending', 'selfcheck', 'gate'] as const) {
      expect(idPath(STATE, file, T).startsWith(`${STATE}\\`)).toBe(true)
      for (const id of BAD) expect(() => idPath(STATE, file, id)).toThrow()
      expect(() => idPath(STATE, file, SLOT)).toThrow()
      expect(() => idPath(STATE, file, 5)).toThrow()
    }
    expect(idPath(STATE, 'left', T)).toBe(`${STATE}\\left\\${T}.json`)
    expect(idPath(STATE, 'poke', T)).toBe(`${STATE}\\poke\\${T}.json`)
    expect(wakePath(STATE, T)).toBe(`${STATE}\\wake\\${T}.json`)
    expect(() => wakePath(STATE, '..\\x')).toThrow()
  })

  test('slots: a runner\'s id, `<pid>-<created>`; the wrapper\'s panes: a token', () => {
    expect(idPath(STATE, 'slotRecord', SLOT)).toBe(`${STATE}\\slots\\${SLOT}.next.json`)
    expect(idPath(STATE, 'slotBeacon', SLOT)).toBe(`${STATE}\\slots\\${SLOT}.state.json`)
    for (const id of [...BAD, T, '20-', '-5', `${'1'.repeat(11)}-5`]) expect(() => idPath(STATE, 'slotRecord', id)).toThrow()
    expect(idPath(STATE, 'pane', TOKEN)).toBe(`${STATE}\\panes\\${TOKEN}.json`)
    for (const id of BAD) expect(() => idPath(STATE, 'paneTicket', id)).toThrow()
  })

  test('the launcher\'s own path is named by its hash, refusing anything else; the copy for use by hand keeps the name the README gives', () => {
    expect(launchScriptPath(STATE)).toBe(`${STATE}\\claude-launch-${LAUNCH_SCRIPT_SHA256.slice(0, 8)}.ps1`)
    expect(launchScriptPath(STATE, 'ab'.repeat(32))).toBe(`${STATE}\\claude-launch-abababab.ps1`)
    for (const sha of ['', 'x', 'AB'.repeat(32), `${'ab'.repeat(32)}\\..`, '..\\x']) expect(() => launchScriptPath(STATE, sha)).toThrow(/not a SHA-256/)
    expect(launchHandPath(STATE)).toBe(`${STATE}\\claude-launch.ps1`)
  })

  test('the readers and writers that never throw get no path at all for another id', () => {
    for (const id of BAD) {
      expect(idPathOrNone(STATE, 'left', id)).toBeUndefined()
      expect(pendingPath(STATE, id)).toBeUndefined()
      expect(selfcheckPath(STATE, id)).toBeUndefined()
      expect(panePath(STATE, id)).toBeUndefined()
      expect(paneTicketPath(STATE, id)).toBeUndefined()
    }
  })
})
