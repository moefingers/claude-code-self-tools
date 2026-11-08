// How the plugins' scripts tell that a process has gone, and which claude.exe they set aside, run for real in Windows
// PowerShell 5.1 (F1, S3):
// - the wait (TEST_GONE's Wait-Gone, the window's and the slot runner's): a process's exit code reads set as soon as its
//   last thread ends, tens of milliseconds before the process is signaled and dropped from the process table (more for a
//   large one, and under load), and Wait-Process stops at the exit code. A 300 MB target, waited for just after its exit
//   code reads set: Wait-Gone returns with it signaled, every time; Wait-Process, the line it replaced, doesn't.
// - Get-Aside: Claude Code's /fork daemon and pty host, and a test stub by its folder, and nothing else.
// The target is a console program compiled into a temporary folder by Add-Type (never named claude.exe). Run with
// `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { stubWork, WINDOWS_POWERSHELL } from './stub.mjs'
import { ROOT } from './sync-shared.mjs'

const machine = await import(pathToFileURL(join(ROOT, 'shared', 'hooks', 'machine.ts')).href)
const isWindows = process.platform === 'win32'

/** The target: commits and touches `mb` MB, says it is ready, waits to be told to go, then returns from Main. */
const TARGET = `
using System;
using System.Threading;
public static class ExitTarget {
  public static int Main(string[] args) {
    int mb = int.Parse(args[0]);
    var blocks = new byte[mb][];
    for (int i = 0; i < mb; i++) { blocks[i] = new byte[1 << 20]; for (int j = 0; j < blocks[i].Length; j += 4096) blocks[i][j] = 1; }
    using (var ready = new EventWaitHandle(false, EventResetMode.ManualReset, args[1] + "-ready"))
    using (var go = new EventWaitHandle(false, EventResetMode.ManualReset, args[1])) {
      ready.Set();
      go.WaitOne();
    }
    GC.KeepAlive(blocks);
    return 0;
  }
}
`

let work
let target

before(() => {
  if (!isWindows) return
  work = stubWork('process-gone-')
  const source = join(work, 'ExitTarget.cs')
  writeFileSync(source, TARGET)
  target = join(work, 'exit-target.exe')
  const compile = spawnSync(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -TypeDefinition ([IO.File]::ReadAllText('${source}')) -OutputAssembly '${target}' -OutputType ConsoleApplication`], { encoding: 'utf8', windowsHide: true })
  assert.equal(compile.status, 0, compile.stderr)
  assert.ok(existsSync(target))
})

after(() => {
  if (work !== undefined) rmSync(work, { recursive: true, force: true })
})

/** Runs `script` in Windows PowerShell 5.1, as the window does (no profile, Bypass); its output. */
function ps(script, env = {}) {
  const file = join(work, `run-${Math.random().toString(16).slice(2)}.ps1`)
  writeFileSync(file, script)
  const ran = spawnSync(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', windowsHide: true, timeout: 240_000, env: { ...process.env, ...env } })
  assert.equal(ran.status, 0, `${ran.stdout}\n${ran.stderr}`)
  return ran.stdout
}

/**
 * `reps` targets of `mb` MB, each told to go, then waited for with `wait` (a line of PowerShell naming `$id` and
 * `$created`) as soon as its exit code reads set: whether it was signaled when the wait returned, one line each.
 */
function waited(wait, reps, mb = 300) {
  const out = ps([
    "$ErrorActionPreference = 'Stop'",
    ...machine.TEST_GONE,
    `for ($rep = 0; $rep -lt ${reps}; $rep++) {`,
    "  $name = 'process-gone-' + [guid]::NewGuid().ToString('N')",
    '  $ready = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, ($name + "-ready"))',
    '  $go = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, $name)',
    `  $info = New-Object Diagnostics.ProcessStartInfo('${target}', ('${mb} ' + $name))`,
    '  $info.UseShellExecute = $false; $info.CreateNoWindow = $true',
    '  $t = [Diagnostics.Process]::Start($info)',
    '  if (-not $ready.WaitOne(60000)) { throw "the target never came up" }',
    '  $id = $t.Id; $created = [string]$t.StartTime.ToFileTimeUtc()',
    '  [void]$go.Set()',
    // Its exit code read, as a wait that starts in the gap would find it.
    '  while (-not $t.HasExited) { }',
    `  ${wait}`,
    '  $signaled = $t.WaitForExit(0)',
    '  "signaled=" + $signaled',
    '  $t.WaitForExit(); $t.Dispose(); $ready.Dispose(); $go.Dispose()',
    '}',
  ].join('\r\n'))
  return out.split(/\r?\n/).filter(line => line.startsWith('signaled=')).map(line => line === 'signaled=True')
}

describe('the wait for an old process, by its handle (F1)', { skip: !isWindows && 'Windows only', concurrency: false }, () => {
  test('Wait-Gone, as the window and the slot runner run it: a 300 MB process waited for just after its exit code reads set is signaled when the wait returns, every time', () => {
    const shipped = waited('$gone = Wait-Gone $id $created 30', 3)
    assert.deepEqual(shipped, [true, true, true])
  })

  test('the line it replaced, Wait-Process, returns in the gap: the reason for the fix, shown on this machine', () => {
    const before = waited('Wait-Process -Id $id -Timeout 30 -ErrorAction SilentlyContinue', 3)
    assert.ok(before.includes(false), `Wait-Process returned with the process signaled every time (${before}): this machine shows no gap, so the test above can't tell the two apart`)
  })

  test('a process id another process holds now (its start time not the one waited for) reads as gone at once', () => {
    const out = ps([...machine.TEST_GONE, '$self = [Diagnostics.Process]::GetCurrentProcess()', '$off = [string]($self.StartTime.ToFileTimeUtc() - 36000000000)', '"gone=" + (Wait-Gone $self.Id $off 30)', '"here=" + (Test-Gone $self.Id ([string]$self.StartTime.ToFileTimeUtc()))'].join('\r\n'))
    assert.match(out, /gone=True/)
    assert.match(out, /here=False/)
  })
})

describe('Get-Aside: the claude.exe liveness passes over (M27 finding 2)', { skip: !isWindows && 'Windows only' }, () => {
  test("Claude Code's daemon and pty host, and a test stub by its folder; nothing else", () => {
    const stubs = join(tmpdir(), machine.TEST_STUB_FOLDER, 'some-test-x', 'claude.exe')
    const cases = [
      ['the /fork daemon', 'claude.exe', '"C:\\Tools\\claude.exe" daemon run --origin transient', 'C:\\Tools\\claude.exe', true],
      ['the pty host, its session named after --', 'claude.exe', '"C:\\Tools\\claude.exe" --bg-pty-host --session-id 1 -- --resume 2', 'C:\\Tools\\claude.exe', true],
      ['a test stub, by its folder', 'claude.exe', `"${stubs}" --resume 2`, stubs, true],
      ['an interactive session', 'claude.exe', '"C:\\Tools\\claude.exe" --resume 2', 'C:\\Tools\\claude.exe', false],
      ['a second install under the temp folder, elsewhere', 'claude.exe', 'claude.exe', join(tmpdir(), 'other', 'claude.exe'), false],
      ['a stub folder by a name that only begins the same', 'claude.exe', 'claude.exe', join(tmpdir(), `${machine.TEST_STUB_FOLDER}-not`, 'claude.exe'), false],
      ['daemon as a later argument', 'claude.exe', '"C:\\Tools\\claude.exe" --resume 2 daemon', 'C:\\Tools\\claude.exe', false],
      ['another program', 'node.exe', 'node.exe daemon', 'C:\\Tools\\node.exe', false],
    ]
    const lines = cases.map(([, name, line, path], i) => `"${i}=" + (Get-Aside ([pscustomobject]@{ Name = '${name}'; CommandLine = '${line.replace(/'/g, "''")}'; ExecutablePath = '${path}' }))`)
    const out = ps([...machine.GET_ASIDE, ...lines].join('\r\n'))
    cases.forEach(([what, , , , expected], i) => assert.match(out, new RegExp(`^${i}=${expected ? 'True' : 'False'}\\r?$`, 'm'), what))
  })
})
