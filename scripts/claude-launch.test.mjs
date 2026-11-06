// claude-launch.ps1 (plugins/self-switch/slot/claude-launch.ps1), the one script that starts claude:
// its pinned hash; the launch environment it applies, equal to the machine code's LAUNCH_ENV_CLEAR and
// LAUNCH_ENV_SET, right before claude, WT_SESSION and WT_PROFILE_ID never named; its argument checks
// before anything changes; -Lane through lanes.json. And a scan: nothing else in the repository starts
// claude but the two known places (the slot runner, until slots v2; the claude wrapper, the person's
// own `claude`). Then, on Windows, it runs for real in Windows PowerShell 5.1 and PowerShell 7 against
// the stub claude.exe (scripts/claude-wrapper-stub.cs, compiled into a temporary folder), whose
// USERPROFILE, LOCALAPPDATA and CLAUDE_CONFIG_DIR are temporary folders, and faults are planted in a
// copy of the script, each caught. Run with `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
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

test('its lists are the machine code\'s: LAUNCH_ENV_CLEAR (SESSION_MARKERS, NO_COLOR among them) cleared, LAUNCH_ENV_SET set', () => {
  assert.ok(script.includes(`$Clear = ${machine.LAUNCH_ENV_CLEAR.map(name => `'${name}'`).join(', ')}\n`))
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
  const noClaude = script.lastIndexOf('Stop-Launch')
  const modules = script.indexOf("  $env:PSModulePath = @([Environment]::GetFolderPath('MyDocuments')")
  const location = script.indexOf('if ($Dir) { Set-Location -LiteralPath $Dir }')
  const pinned = script.indexOf("$pinned = Join-Path $env:USERPROFILE '.local\\bin\\claude.exe'")
  const clear = script.indexOf('foreach ($n in $Clear)')
  const policy = script.indexOf("[Environment]::SetEnvironmentVariable('PSExecutionPolicyPreference', [NullString]::Value, [EnvironmentVariableTarget]::Process)")
  const set = script.indexOf('foreach ($n in $Set.Keys)')
  const claude = script.indexOf('if ($Resume) { & $exe --resume $Resume }')
  assert.ok(lastCheck > 0 && lastCheck < modules, 'every check of the arguments stops it before anything changes')
  assert.ok(noClaude > pinned && noClaude < clear, 'no claude found stops it before the environment changes')
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
  assert.ok(!/\.jsonl/.test(script))
  assert.ok(script.includes("if ($Dir) { Stop-Launch '-Lane takes its folder from lanes.json: give no -Dir.' }"))
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

test('nothing but claude-launch.ps1 starts claude, but the two known places; and they clear the same list', () => {
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
  assert.deepEqual(starters.sort(), ['plugins/self-switch/slot/claude-launch.ps1', 'plugins/self-switch/slot/claude-slot.ps1', 'tools/claude-wrapper/claude-wrapper.ps1'])
  // The two known places clear exactly the launch environment's list, never a WT name.
  const slot = readFileSync(join(ROOT, 'plugins', 'self-switch', 'slot', 'claude-slot.ps1'), 'utf8')
  const wrapper = readFileSync(join(ROOT, 'tools', 'claude-wrapper', 'claude-wrapper.ps1'), 'utf8')
  assert.ok(slot.includes(`$Markers = ${machine.LAUNCH_ENV_CLEAR.map(name => `'${name}'`).join(', ')}\n`))
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
  work = mkdtempSync(join(tmpdir(), 'claude-launch-test-'))
  stub = join(work, 'claude.exe')
  const compile = spawnSync(
    WINDOWS_POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -TypeDefinition ([IO.File]::ReadAllText('${join(ROOT, 'scripts', 'claude-wrapper-stub.cs')}')) -OutputAssembly '${stub}' -OutputType ConsoleApplication`],
    { encoding: 'utf8', windowsHide: true },
  )
  assert.equal(compile.status, 0, compile.stderr)
  assert.ok(existsSync(stub), 'the stub was compiled')
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

/** The script run as a window runs it: -File, -ExecutionPolicy RemoteSigned; the markers, NO_COLOR and WT_* set, so what changes shows. */
function run(shell, dirs, args, { script: path = LAUNCH, extra = {} } = {}) {
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
    ...Object.fromEntries(machine.LAUNCH_ENV_CLEAR.map(name => [name, 'marker-test'])),
    ...extra,
  }
  // Never outside the temporary folder: a run that found the real claude.exe would start Claude Code.
  for (const name of ['USERPROFILE', 'LOCALAPPDATA', 'CLAUDE_CONFIG_DIR']) {
    if (typeof env[name] !== 'string' || !env[name].startsWith(work)) throw new Error(`${name} must be in the test's temporary folder`)
  }
  return new Promise(resolve => {
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', path, ...args], { env, cwd: dirs.start, windowsHide: true })
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
  check(only.cwd === cwd, `in its folder (${only.cwd})`)
  for (const name of [...machine.LAUNCH_ENV_CLEAR, 'PSExecutionPolicyPreference']) check(!only.env.includes(name), `${name} is cleared`)
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
        assert.deepEqual(launched(await run(shell, dirs, ['-Start', id, '-Name', 'dealerwrap', '-Dir', dirs.work]), ['--session-id', id, '--name', 'dealerwrap'], dirs.work), [])
      })

      test('no arguments: plain claude, where it is run (a slot\'s Enter)', async () => {
        const dirs = lab()
        assert.deepEqual(launched(await run(shell, dirs, []), [], dirs.start), [])
      })

      test('-Lane <name>: the entry\'s conversation in the entry\'s folder; an unknown name, a bad entry, or -Dir with it: nothing started', async () => {
        const dirs = lab()
        const id = randomUUID()
        const lanes = { v: 1, at: Date.now(), lanes: { dealerwrap: { session: id, folder: dirs.work, ws: 'default', at: Date.now() }, broken: { session: 'not-a-uuid', folder: dirs.work, ws: 'default', at: 1 } } }
        writeFileSync(join(dirs.config, 'lanes.json'), JSON.stringify(lanes))
        assert.deepEqual(launched(await run(shell, dirs, ['-Lane', 'dealerwrap']), ['--resume', id], dirs.work), [])
        for (const args of [['-Lane', 'nobody'], ['-Lane', 'broken'], ['-Lane', 'dealerwrap', '-Dir', dirs.work], ['-Lane', 'Dealer Wrap']]) {
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

/** What the folder holds besides the script: no temporary file may be left. */
const leftovers = dir => readdirSync(dir).filter(name => name !== 'claude-launch.ps1')

describe('the install of claude-launch.ps1 by a launch', { skip: !isWindows && 'Windows only' }, () => {
  test('missing (its folder too): put there, byte for byte, nothing else left', () => {
    const state = join(mkdtempSync(join(work, 'install-')), 'claude-self-tools')
    const path = join(state, 'claude-launch.ps1')
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
