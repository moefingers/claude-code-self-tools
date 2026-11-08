// claude-launch.ps1 (plugins/self-switch/slot/claude-launch.ps1), the one script that starts claude:
// its pinned hash and its version line; the launch environment it applies, equal to the machine code's
// LAUNCH_ENV_CLEAR, LAUNCH_ENV_DROP and LAUNCH_ENV_SET, right before claude, WT_SESSION and WT_PROFILE_ID
// never named; its argument checks before anything changes; -Lane through lanes.json, saying which
// conversation; its own last look (RECHECK and LEFT_RECHECK, line for line), by hand too, against a
// holder the stub plays. And a scan: nothing else in the repository starts
// claude but the claude wrapper, the person's own `claude`; the slot runner goes through this script. Then, on Windows, it runs for real in Windows PowerShell 5.1 and PowerShell 7 against
// the stub claude.exe (scripts/claude-wrapper-stub.cs, compiled into a temporary folder), whose
// USERPROFILE, LOCALAPPDATA and CLAUDE_CONFIG_DIR are temporary folders, and faults are planted in a
// copy of the script, each caught. Run with `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { compileStub, holder, stubWork } from './stub.mjs'
import { ROOT } from './sync-shared.mjs'

const LAUNCH = join(ROOT, 'plugins', 'self-switch', 'slot', 'claude-launch.ps1')
const bytes = readFileSync(LAUNCH)
const script = bytes.toString('utf8')
const machine = await import(pathToFileURL(join(ROOT, 'shared', 'hooks', 'machine.ts')).href)

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
  const modules = script.indexOf("  $env:PSModulePath = @([Environment]::GetFolderPath('MyDocuments')")
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
    // The machine code carries claude-launch.ps1 itself (LAUNCH_SCRIPT_TEXT), byte for byte (the next
    // test): the same starter, not another. Everything else in it is scanned.
    const whole = readFileSync(path, 'utf8')
    const from = whole.indexOf('export const LAUNCH_SCRIPT_TEXT = [')
    const text = from === -1 ? whole : whole.slice(0, from) + whole.slice(whole.indexOf("].join('\\n')", from))
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
  return env
}

/** The script run as a window runs it, -ExecutionPolicy Bypass (here by -File), in envOf's environment. */
function run(shell, dirs, args, { script: path = LAUNCH, extra = {} } = {}) {
  const env = envOf(dirs, extra)
  return new Promise(resolve => {
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path, ...args], { env, cwd: dirs.start, windowsHide: true })
    let stdout = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stdout += chunk))
    const timer = setTimeout(() => child.kill(), 60_000)
    child.on('close', code => {
      clearTimeout(timer)
      const log = join(dirs.root, 'log.jsonl')
      const runs = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
      resolve({ code, stdout, runs })
    })
  })
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
        for (const args of [['-Lane', 'nobody'], ['-Lane', 'broken'], ['-Lane', 'lane-x', '-Dir', dirs.work], ['-Lane', 'Dealer Wrap']]) {
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
