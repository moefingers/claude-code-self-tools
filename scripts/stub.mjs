// The stub claude.exe (scripts/claude-wrapper-stub.cs), for the tests that run the plugins' scripts for
// real: compiled into a test's temporary folder by Windows PowerShell's Add-Type, and a way to run a
// script under it as Claude Code runs a plugin's script (powershellCall: Windows PowerShell, the fixed
// bootstrap, the script on standard input), so that a script that finds "its" claude.exe by walking up
// its parents finds the stub. It never runs Claude Code, and refuses a USERPROFILE or LOCALAPPDATA
// outside the test's temporary folder. Not a test file: scripts/*.test.mjs import it.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from './sync-shared.mjs'

const machine = await import(pathToFileURL(join(ROOT, 'shared', 'hooks', 'machine.ts')).href)

export const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows'
export const WINDOWS_POWERSHELL = join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** The stub, compiled into `dir` as claude.exe; its path. */
export function compileStub(dir) {
  const stub = join(dir, 'claude.exe')
  const source = join(ROOT, 'scripts', 'claude-wrapper-stub.cs')
  const compile = spawnSync(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -TypeDefinition ([IO.File]::ReadAllText('${source}')) -OutputAssembly '${stub}' -OutputType ConsoleApplication`], { encoding: 'utf8', windowsHide: true })
  if (compile.status !== 0 || !existsSync(stub)) throw new Error(`the stub didn't compile: ${compile.stderr}`)
  return stub
}

/** Throws unless USERPROFILE and LOCALAPPDATA (and CLAUDE_CONFIG_DIR, when set) are in `work`: a run that found the real claude.exe would start Claude Code. */
export function fence(env, work) {
  for (const name of ['USERPROFILE', 'LOCALAPPDATA']) {
    if (typeof env[name] !== 'string' || !env[name].startsWith(work)) throw new Error(`${name} must be in the test's temporary folder`)
  }
  if (env.CLAUDE_CONFIG_DIR !== undefined && !env.CLAUDE_CONFIG_DIR.startsWith(work)) throw new Error("CLAUDE_CONFIG_DIR must be in the test's temporary folder")
}

/** Waits for `path` to be there, up to `ms`. */
async function until(path, ms) {
  const end = Date.now() + ms
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error(`${path} never came`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
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
