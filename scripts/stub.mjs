// The stub claude.exe (scripts/claude-wrapper-stub.cs), for the tests that run the plugins' scripts for
// real: compiled into a test's temporary folder by Windows PowerShell's Add-Type, and a way to run a
// script under it as Claude Code runs a plugin's script (powershellCall: Windows PowerShell, the fixed
// bootstrap, the script on standard input), so that a script that finds "its" claude.exe by walking up
// its parents finds the stub. It never runs Claude Code, and refuses a USERPROFILE or LOCALAPPDATA
// outside the test's temporary folder. Not a test file: scripts/*.test.mjs import it.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from './sync-shared.mjs'

const machine = await import(pathToFileURL(join(ROOT, 'shared', 'hooks', 'machine.ts')).href)

export const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows'
export const WINDOWS_POWERSHELL = join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/**
 * A test's own temporary folder, under the one folder every stub claude.exe runs from (machine.TEST_STUB_FOLDER in
 * the temp folder): the probe sets a claude.exe there aside (Get-Aside), so a stub that runs while a real session
 * switches doesn't refuse that switch as an unaccounted Claude Code.
 */
export function stubWork(prefix) {
  const root = join(tmpdir(), machine.TEST_STUB_FOLDER)
  mkdirSync(root, { recursive: true })
  return mkdtempSync(join(root, prefix))
}

/** The stub, compiled into `dir` as claude.exe; its path. A dir outside stubWork's folder is refused: the stub would hold up every switch while it runs. */
export function compileStub(dir) {
  if (!dir.toLowerCase().startsWith(join(tmpdir(), machine.TEST_STUB_FOLDER).toLowerCase() + '\\')) throw new Error(`a stub claude.exe goes under ${join(tmpdir(), machine.TEST_STUB_FOLDER)} (stubWork), not ${dir}`)
  const stub = join(dir, 'claude.exe')
  const source = join(ROOT, 'scripts', 'claude-wrapper-stub.cs')
  const compile = spawnSync(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -TypeDefinition ([IO.File]::ReadAllText('${source}')) -OutputAssembly '${stub}' -OutputType ConsoleApplication`], { encoding: 'utf8', windowsHide: true })
  if (compile.status !== 0 || !existsSync(stub)) throw new Error(`the stub didn't compile: ${compile.stderr}`)
  return stub
}

/**
 * Throws unless USERPROFILE and LOCALAPPDATA (and CLAUDE_CONFIG_DIR, when set) are in `work`, and no folder
 * on PATH outside `work` holds a claude program: a run that found the real claude.exe (in the person's
 * %USERPROFILE%\.local\bin, or on their PATH) would start Claude Code. claude-launch.ps1 and the claude
 * wrapper look in exactly those two places.
 */
export function fence(env, work) {
  for (const name of ['USERPROFILE', 'LOCALAPPDATA']) {
    if (typeof env[name] !== 'string' || !env[name].startsWith(work)) throw new Error(`${name} must be in the test's temporary folder`)
  }
  if (env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR !== null && !env.CLAUDE_CONFIG_DIR.startsWith(work)) throw new Error("CLAUDE_CONFIG_DIR must be in the test's temporary folder")
  const paths = Object.keys(env).filter(name => name.toLowerCase() === 'path')
  if (paths.length !== 1 || typeof env[paths[0]] !== 'string') throw new Error('a run names its own PATH, once')
  for (const dir of env[paths[0]].split(';').filter(Boolean)) {
    if (dir.startsWith(work)) continue
    if (holdsClaude(dir)) throw new Error(`${dir} holds a claude program, and is on the run's PATH`)
  }
}

const holdsClaude = dir => ['.exe', '.com', '.cmd', '.bat'].some(ext => existsSync(join(dir, `claude${ext}`)))

/** `env` (process.env and the like) with every folder that holds a claude program taken off its PATH, for fence. */
export function withoutClaude(env) {
  const out = Object.fromEntries(Object.entries(env).filter(([name]) => name.toLowerCase() !== 'path'))
  const path = Object.entries(env).find(([name]) => name.toLowerCase() === 'path')?.[1] ?? ''
  out.PATH = path
    .split(';')
    .filter(dir => dir !== '' && !holdsClaude(dir))
    .join(';')
  return out
}

/** Waits for `path` to be there, up to `ms`. */
async function until(path, ms) {
  const end = Date.now() + ms
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error(`${path} never came`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** A launch script with Start-Process replaced by a throw: a fault in a test can never open a window. It throws itself when one is left that isn't so guarded (D3): a renamed anchor can't silently take the guard away. */
export function noWindow(script) {
  const at = '$window = Start-Process'
  const guarded = script.includes(at) ? script.split(at).join(`throw 'a test never opens a window'; ${at}`) : script
  const starts = (guarded.match(/Start-Process/g) ?? []).length
  const held = (guarded.match(/throw 'a test never opens a window'; \$window = Start-Process/g) ?? []).length
  if (starts !== held) throw new Error('every Start-Process in a script a test runs is guarded')
  return guarded
}

/**
 * A launch script whose Start-Process is a function of the test's own, defined first: it opens nothing,
 * and writes to `file` what the window would have been started with (`{ file, args }`: the program and
 * its argument list), so a test can read the interpreter chosen and run that very command hidden. It
 * throws when the script could reach the real cmdlet past the function (by its module's name, or .NET).
 */
export function recordWindow(script, file) {
  if (/\\Start-Process|Diagnostics\.Process\]::Start|ProcessStartInfo/.test(script)) throw new Error('the script reaches a process start past the recording function')
  if (/['"]/.test(file)) throw new Error('a record file without quotes')
  const shadow = [
    'function Start-Process { param([string]$FilePath, [string[]]$ArgumentList, [switch]$PassThru)',
    `  [IO.File]::WriteAllText('${file}', (ConvertTo-Json -Compress -InputObject ([ordered]@{ file = $FilePath; args = @($ArgumentList) })))`,
    '  [pscustomobject]@{ Id = 0 } | Add-Member -MemberType ScriptMethod -Name Kill -Value { } -PassThru',
    '}',
  ]
  return [...shadow, script].join('\r\n')
}

/**
 * Starts the stub (as a session's claude.exe) with `args`, and keeps it running `ms`: a holder of a
 * conversation, for a last look to find. Its pid and creation time (a FILETIME string), and `stop`.
 */
export async function holder({ stub, work, env, args = [], ms = 60_000 }) {
  fence(env, work)
  const dir = mkdtempSync(join(work, 'holder-'))
  const self = join(dir, 'self.json')
  const child = spawn(stub, args, { env: { ...env, STUB_SELF: self, STUB_LOG: join(dir, 'log.jsonl'), STUB_SLEEP_MS: String(ms) }, windowsHide: true, stdio: 'ignore' })
  await until(self, 20_000)
  const { pid, created } = JSON.parse(readFileSync(self, 'utf8'))
  return { pid, created, stop: () => child.kill() }
}

/**
 * Runs a script under the stub, as Claude Code runs a plugin's: the stub, started with `env`, runs
 * Windows PowerShell (powershellCall's argv) as its child, the script on standard input. `script` is
 * text, or a function of the stub's `{ pid, created }`, called once the stub is running (a launch that
 * waits for its caller names that process). Its answer: the child's standard output and error, and the
 * stub's own pid and creation time.
 */
export async function underStub({ stub, work, env, script }) {
  fence(env, work)
  const dir = mkdtempSync(join(work, 'under-'))
  const files = { self: join(dir, 'self.json'), stdin: join(dir, 'stdin.ps1'), out: join(dir, 'out.txt'), err: join(dir, 'err.txt') }
  const call = machine.powershellCall(WINDOWS_POWERSHELL, '')
  const child = spawn(stub, [], {
    env: { ...env, STUB_SELF: files.self, STUB_LOG: join(dir, 'log.jsonl'), STUB_CHILD_EXE: call.argv[0], STUB_CHILD_ARGS: call.argv.slice(1).join(' '), STUB_CHILD_STDIN: files.stdin, STUB_CHILD_OUT: files.out, STUB_CHILD_ERR: files.err },
    windowsHide: true,
    stdio: 'ignore',
  })
  const ended = new Promise(resolve => child.on('close', resolve))
  const timer = setTimeout(() => child.kill(), 90_000)
  try {
    await until(files.self, 20_000)
    const self = JSON.parse(readFileSync(files.self, 'utf8'))
    const text = typeof script === 'function' ? script(self) : script
    // Whole, by a move: the stub hands the file on as soon as it is there.
    writeFileSync(`${files.stdin}.tmp`, text)
    renameSync(`${files.stdin}.tmp`, files.stdin)
    await ended
    const read = path => (existsSync(path) ? readFileSync(path, 'utf8') : '')
    return { stdout: read(files.out), stderr: read(files.err), self }
  } finally {
    clearTimeout(timer)
  }
}
