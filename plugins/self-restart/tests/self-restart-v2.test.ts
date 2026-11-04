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
const SLOT = '20-133000000010000000'
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

/** The engine beneath the plugin, its launcher answering `answer`; and what it was asked to run. */
function engine(on: On, { answer, store = {} }: { answer: { exitCode: number; stdout: string }; store?: Record<string, unknown> }) {
  const scripts: string[] = []
  const commands: string[] = []
  const toasts: string[] = []
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
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('classic.SessionStart', () => ({}))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: 'done' }))
  on('process.run', (_, e) => {
    const script = decode(String(e.argv[4]))
    scripts.push(script)
    if (script.includes("'not-ours'")) return { value: { exitCode: 0, stdout: 'released\r\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { ...answer, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.run', async (_, e) => {
    commands.push(e.command)
    await clock.sleep(HOUR)
    return {}
  })
  return { scripts, commands, toasts, held, clock, session }
}

const start = { cwd: 'C:\\work\\repo', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as const

test("the launcher v2 for this session's own id: the claim, the re-check after the wait, the scrub, and claude with no other flag", () => {
  const script = launcherScript(ID)
  // The claim on this conversation, taken in the launcher's own run, with CreateNew.
  expect(script).toContain('[IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)')
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
