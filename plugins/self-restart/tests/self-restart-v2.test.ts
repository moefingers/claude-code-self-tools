// self-restart on the launcher v2 (the shared machine code): the claim lock it takes, the slot it
// uses when its pane is one, the re-check after the wait, and the release once the session resumed.
// The tests in self-restart.test.ts are the rest, unchanged.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { launcherScript, SESSION_MARKERS } from '../hooks/launcher'
import { RECHECK, SLOT_SCRIPT_SHA256 } from '../hooks/machine'

const TOOL = 'mcp__self-restart__restart_after_turn'
const HOUR = 60 * 60 * 1000
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const WINDOWS = { OS: 'Windows_NT', SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }
const SLOT = '20-134062345678901240'
const LAUNCH = 'launch:5e1a9c3b-7d2f-4b8e-a6c4-1f9d3e7b2a5c'

/** Base64 back to text, as PowerShell reads an -EncodedCommand: UTF-16LE. */
function decode(encoded: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  const clean = encoded.replace(/=+$/, '')
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].reduce((acc, k) => (acc << 6) | Math.max(0, alphabet.indexOf(clean.charAt(i + k) || 'A')), 0)
    bytes.push((n >> 16) & 255, (n >> 8) & 255, n & 255)
  }
  const used = Math.floor((clean.length * 6) / 8)
  let out = ''
  for (let i = 0; i + 1 < used; i += 2) out += String.fromCharCode((bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8))
  return out
}

/** A probe's answer: claude.exe 100 in a pane, the probe under it, and `under`, what else runs under the session. */
const probeOf = (under: Record<string, unknown>[] = []) =>
  `${JSON.stringify({
    v: 1,
    self: 300,
    session: { pid: 100, created: '134062345688901240' },
    slot: null,
    procs: [
      { pid: 20, ppid: 10, created: '134062345678901240', name: 'powershell.exe', cls: 'shell' },
      { pid: 100, ppid: 20, created: '134062345688901240', name: 'claude.exe' },
      { pid: 300, ppid: 100, created: '134062355668901240', name: 'powershell.exe', cls: 'shell' },
      { pid: 400, ppid: 100, created: '134062345788901240', name: 'node.exe' },
      ...under,
    ],
    registry: [],
    transcripts: [],
    locks: [],
    claim: null,
    heavy: null,
    freeKb: null,
    errors: [],
  })}\r\n`

type Machine = {
  /** What the probe answers: a machine (its stdout), or a failure. */
  probe?: string | 'fails'
  /** What git answers: no repository, or a failure. */
  git?: 'no-repo' | 'fails'
  /** Whether the session's folder can be read. */
  cwd?: 'reads' | 'fails'
}

/** The engine beneath the plugin, its launcher answering `answer`; and what it was asked to run. */
function engine(
  on: On,
  { answer, store = {}, probe = probeOf(), git = 'no-repo', cwd = 'reads', released = 'released' }: { answer: { exitCode: number; stdout: string }; store?: Record<string, unknown>; released?: 'released' | 'busy' } & Machine,
) {
  const probes: string[] = []
  const described: string[] = []
  const scripts: string[] = []
  const commands: string[] = []
  const toasts: string[] = []
  const logs: string[] = []
  const held = new Map<string, unknown>(Object.entries(store))
  const clock = mock.clock(on, { now: 1_000_000 })
  const session = mock.session(on)
  mock.env(on, WINDOWS)
  on('store.get', (_, e) => ({ value: held.get(e.key) }))
  on('store.set', (_, e) => {
    held.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: ID }))
  on('session.cwd', () => (cwd === 'reads' ? { value: 'C:\\work\\repo' } : { deny: 'no folder' }))
  on('tool.register', (_, e) => {
    described.push(String(e.description))
    return { value: { tool: TOOL } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    logs.push(String(e.text))
    return { value: undefined }
  })
  on('agent.list', () => ({ value: [] }))
  on('classic.SessionStart', () => ({}))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git') {
      return git === 'no-repo'
        ? { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
        : { value: { exitCode: 128, stdout: '', stderr: 'fatal: detected dubious ownership in repository', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const script = decode(String(e.argv[4]))
    if (script.includes('$ids = @(')) {
      probes.push(script)
      return probe === 'fails'
        ? { value: { exitCode: 1, stdout: '', stderr: 'Get-CimInstance : Access denied', isStdoutTruncated: false, isStderrTruncated: false } }
        : { value: { exitCode: 0, stdout: probe, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    scripts.push(script)
    if (script.includes("'not-ours'")) return { value: { exitCode: 0, stdout: `${released}\r\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { ...answer, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.run', async (_, e) => {
    commands.push(e.command)
    await clock.sleep(HOUR)
    return {}
  })
  return { probes, described, scripts, commands, toasts, logs, held, clock, session }
}

const start = { cwd: 'C:\\work\\repo', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as const

test("the launcher v2 for this session's own id: the claim, the re-check after the wait, the scrub, and claude with no other flag", () => {
  const script = launcherScript(ID)
  // The claim on this conversation, taken in the launcher's own run, with CreateNew.
  expect(script).toContain('[IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)')
  expect(script).toContain('if (-not $taken) { $taken = Set-Claim $claimPath $claimText }')
  expect(script).toContain('$claimPath = Join-Path $state ("claims\\" + $id + ".lock")')
  expect(script).toContain('"self-restart: another switch or restart holds the claim on this conversation ($claimPath), so it is not resumed"; exit 5')
  // The window re-reads the registry and the process table after the wait, and checks the claim, before claude.
  const wait = script.indexOf('Wait-Process')
  const claude = script.indexOf("--resume '$id'")
  for (const line of RECHECK) {
    expect(script.indexOf(`'    ${line}'`)).toBeGreaterThan(wait)
    expect(script.indexOf(`'    ${line}'`)).toBeLessThan(claude)
  }
  expect(script.indexOf('the claim on it no longer names this window')).toBeGreaterThan(wait)
  expect(script.indexOf('the claim on it no longer names this window')).toBeLessThan(claude)
  // In the folder it was started in (the launcher runs there), checked to be a folder.
  expect(script).toContain('$folder = (Get-Location).ProviderPath')
  expect(script.indexOf("'Set-Location -LiteralPath $folder'")).toBeLessThan(claude)
  // The scrub, once, naming the markers.
  expect(script.split(/\r?\n/).filter(line => line.includes('SetEnvironmentVariable'))).toHaveLength(1)
  for (const name of SESSION_MARKERS) expect(script).toContain(`"${name}"`)
  for (const flag of ['--permission-mode', '--dangerously-skip-permissions', 'bypassPermissions']) expect(script).not.toContain(flag)
  // A slot whose script has the shipped hash gets a record instead of a window.
  expect(script).toContain(`$slotOk = $slotHash -eq '${SLOT_SCRIPT_SHA256}'`)
  expect(script.indexOf('[IO.File]::WriteAllText($record, $text)')).toBeLessThan(script.indexOf('Start-Process'))
})

test('a pane that is a verified slot: the launcher leaves the slot a record, no window opens, and the session exits', async ($, on) => {
  const { scripts, commands, toasts, held, session, clock } = engine(on, { answer: { exitCode: 0, stdout: `slot ${SLOT}\r\nclaim slot:${SLOT}\r\n` } })
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.', resume: 'Go on.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(scripts).toEqual([launcherScript(ID)])
  expect(commands).toEqual(['exit'])
  expect(toasts.some(t => /Restarting: this pane's slot resumes this session once it has exited/.test(t))).toBe(true)
  expect(JSON.stringify(session.appended())).toContain('restarted at its own request (restart_after_turn). Reason: Switched accounts.')
  expect((held.get('restarts') as Record<string, { claim?: string }>)[ID]?.claim).toBe(`slot:${SLOT}`)
})

test("a slot runner the launcher passed over for a window: the restart says why, in the row, the toast and the log", async ($, on) => {
  const why = 'slot hash unreadable: Exception calling "ReadAllBytes" with "1" argument(s): "Access to the path is denied."'
  const { commands, toasts, logs, session, clock } = engine(on, { answer: { exitCode: 0, stdout: `launched 17716\r\nclaim ${LAUNCH}\r\nfallback ${why}\r\n` } })
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual(['exit'])
  const rows = session.appended().flatMap(row => ((row as { message?: { content?: { text?: unknown }[] } }).message?.content ?? []).map(block => String(block.text)))
  expect(rows).toContain(`This session restarted at its own request (restart_after_turn). Reason: Switched accounts. It restarted in a new window, not this pane's slot: \u00ab${why}\u00bb.`)
  expect(toasts).toContain(`Restarting: a new window resumes this session once it has exited, not this pane's slot (${why}). Switched accounts.`)
  expect(logs).toContain(`this pane's slot runner isn't used: ${why}. A new window resumes the session.`)
})

test('a window with no slot passed over, or the slot itself, says nothing of a fallback', async ($, on) => {
  const { toasts, session, clock } = engine(on, { answer: { exitCode: 0, stdout: `launched 17716\r\nclaim ${LAUNCH}\r\n` } })
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(JSON.stringify(session.appended())).not.toContain("not this pane's slot")
  expect(toasts).toContain('Restarting: a new window resumes this session once it has exited. Switched accounts.')
})

test('the claim the window took is kept for the resumed session, which releases it once', async ($, on) => {
  const opened = engine(on, { answer: { exitCode: 0, stdout: `launched 17716\r\nclaim ${LAUNCH}\r\n` } })
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await opened.clock.advance(1000)
  const kept = (opened.held.get('restarts') as Record<string, { claim?: string; at: number }>)[ID]
  expect(kept?.claim).toBe(LAUNCH)

  // The resumed process: its copy of the plugin releases that claim, and only that one.
  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  await opened.clock.advance(1000)
  const release = opened.scripts.filter(s => s.includes("'not-ours'"))
  expect(release).toHaveLength(1)
  expect(release[0]).toContain(`$lock.by -cne '${LAUNCH}'`)
  expect(release[0]).toContain(`Join-Path 'C:\\Users\\u\\AppData\\Local\\claude-self-tools' 'claims\\${ID}.lock'`)
  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  await opened.clock.advance(1000)
  expect(opened.scripts.filter(s => s.includes("'not-ours'"))).toHaveLength(1)
})

test('a claim another switch holds: the launcher resumes nothing, no window opens, nothing exits', async ($, on) => {
  const { commands, toasts, session, held, clock } = engine(on, {
    answer: { exitCode: 5, stdout: 'self-restart: another switch or restart holds the claim on this conversation (C:\\x\\claims\\y.lock), so it is not resumed\r\n' },
  })
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual([])
  expect(toasts.some(t => /Restart didn't run/.test(t))).toBe(true)
  expect(JSON.stringify(session.appended())).toMatch(/launcher exited 5: self-restart: another switch or restart holds the claim/)
  expect(held.get('restarts')).toEqual({})
})

test('before the launch, the full safe point: the probe asks of this session alone, and claims nothing', async ($, on) => {
  const { probes, scripts, commands, clock } = engine(on, { answer: { exitCode: 0, stdout: `launched 17716\r\nclaim ${LAUNCH}\r\n` } })
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(probes).toHaveLength(1)
  expect(probes[0]).toContain(`$ids = @('${ID}')`)
  expect(probes[0]).toContain('$configDirs = @()')
  expect(probes[0]).toContain('$take = $null')
  expect(probes[0]).toContain('$state = $null')
  // An MCP server's node under the session doesn't count: the launch goes ahead.
  expect(scripts).toEqual([launcherScript(ID)])
  expect(commands).toEqual(['exit'])
})

for (const [name, machine, said] of [
  [
    'a background Bash job under the session',
    { probe: probeOf([{ pid: 505, ppid: 100, created: '134062355678901240', name: 'bash.exe', cls: 'shell' }]) },
    /isn't at a safe point \(S6: bash\.exe 505 runs under this session \(a background job of the Bash, PowerShell or Monitor tool\)\)/,
  ],
  ['a git process under the session', { probe: probeOf([{ pid: 501, ppid: 100, created: '134062355678901240', name: 'git.exe', cls: 'git' }]) }, /S2: git\.exe 501 runs under this session/],
  ['a probe that fails (an unreadable process table)', { probe: 'fails' as const }, /the machine probe failed \(it exited 1: Get-CimInstance : Access denied\), so what runs under this session is unknown/],
  ['git that cannot be read', { git: 'fails' as const }, /S2: git's state can't be read \(git rev-parse in C:\\\\work\\\\repo exited 128\)/],
  ['a session folder that cannot be read', { cwd: 'fails' as const }, /this session's folder can't be read, so git's state there is unknown/],
] as const) {
  test(`${name} holds the restart: no window, no exit, and the model is told why`, async ($, on) => {
    const { scripts, commands, toasts, held, session, clock } = engine(on, { answer: { exitCode: 0, stdout: `launched 17716\r\nclaim ${LAUNCH}\r\n` }, ...machine })
    await $.session.start(start)
    await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
    await $.turn.complete(answered)
    await clock.advance(1000)
    expect(scripts).toEqual([])
    expect(commands).toEqual([])
    expect(toasts.some(t => /Restart didn't run/.test(t))).toBe(true)
    expect(JSON.stringify(session.appended())).toMatch(said)
    expect(held.get('restarts')).toBeUndefined()
  })
}

test('a queued restart a new turn cancels is told in a plugin row; the third in a row says the session is busy', async ($, on) => {
  const { scripts, commands, session, clock } = engine(on, { answer: { exitCode: 0, stdout: `launched 17716\r\nclaim ${LAUNCH}\r\n` } })
  await $.session.start(start)
  for (const turnId of ['t2', 't3', 't4']) {
    await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
    await $.turn.complete(answered)
    await $.turn.start({ text: 'a message', turnId })
    await clock.advance(1000)
  }
  expect(scripts).toEqual([])
  expect(commands).toEqual([])
  const said = session.appended().map(row => JSON.stringify(row))
  expect(said).toHaveLength(3)
  const row = 'self-restart: your queued restart was cancelled because a new turn started; queue it again at the next finished break.'
  expect(said[0]).toContain(`${row} The restart you queued didn't go ahead`)
  expect(said[1]).toContain(`${row} The restart you queued didn't go ahead`)
  expect(said[1]).not.toContain('in a row')
  expect(said[2]).toContain(
    `${row} That is 3 in a row: this session is busy. Queue it again when it's idle, or ask the merger or the owner.`,
  )
  // The break holds: the restart runs, and the count is over.
  await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands).toEqual(['exit'])
})

test("the tool's description says it holds on the full safe point, and what still ends with the process", async ($, on) => {
  const { described } = engine(on, { answer: { exitCode: 0, stdout: '' } })
  await $.session.start(start)
  const [text] = described
  expect(text).toContain('It refuses unless the session is at a safe point')
  expect(text).toContain('while anything runs under this session (a background Bash, PowerShell or Monitor job, git, a build, test or lint, a dev server or Playwright, a heavy-slot job)')
  expect(text).toContain("while any of that can't be read")
  expect(text).toContain("What still ends with this process: wake-ups, background tasks it can't see")
})

test('a release that finds the lock held open throughout is logged, never taken as released', async ($, on) => {
  const { logs, clock } = engine(on, {
    answer: { exitCode: 0, stdout: '' },
    released: 'busy',
    store: { restarts: { [ID]: { at: 1_000_000 - 60_000, reason: 'Switched accounts.', claim: LAUNCH } } },
  })
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  await clock.advance(1000)
  expect(logs).toContain(`the claim lock on ${ID} wasn't released (another process had it open throughout); it is left in place, and goes stale 15 minutes after the old process exited.`)
})
