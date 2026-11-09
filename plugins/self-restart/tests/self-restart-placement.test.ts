// self-restart and placement.json: `restart.prefer`, the stamp `tab: same` goes by, the place tried next
// when one is refused, and the trampoline of its /exit; and what the exit's pre-check reads besides the
// machine: a wake-up pending, and the turn's in-flight tasks. No script runs here.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { go } from '../hooks/go'
import { goAnswer, GO_NOTHING, GO_VIA, placementPath, wakeMarker, wakePath } from '../hooks/machine'

const TOOL = 'mcp__self-restart__restart_after_turn'
/** A transcript under the repo's project folder, in any config folder: where `claude --resume` finds the session. */
const TRANSCRIPT = /\\projects\\C--work-repo\\[0-9a-f-]{36}\.jsonl$/
const ID = '00000000-0000-4000-a000-000000000011'
const LOCAL = 'C:\\Users\\u\\AppData\\Local'
const STATE = `${LOCAL}\\claude-self-tools`
const FILE = JSON.stringify({ v: 1, layout: [], launch: { prefer: ['slot', 'tab', 'window'], tab: { window: 'claude-4', maxTabs: 2 }, window: { name: 'claude-overflow', pos: [1920, 0], size: [140, 60] } }, restart: { prefer: ['slot', 'tab', 'window'], tab: { window: 'same' } } })

/** A probe's answer: claude.exe 100 in a pane, the probe under it. */
const PROBE = `${JSON.stringify({
  v: 1,
  self: 300,
  session: { pid: 100, created: '134062345688901240' },
  slot: null,
  procs: [
    { pid: 20, ppid: 10, created: '134062345678901240', name: 'powershell.exe', cls: 'shell' },
    { pid: 100, ppid: 20, created: '134062345688901240', name: 'claude.exe' },
    { pid: 300, ppid: 100, created: '134062355668901240', name: 'powershell.exe', cls: 'shell' },
  ],
  registry: [],
  transcripts: [],
  locks: [],
  claim: null,
  heavy: null,
  freeKb: null,
  errors: [],
})}\r\n`

type Options = { env?: Record<string, string>; placement?: string; refuses?: (script: string) => string | undefined; wake?: string | null; exit?: 'exits' | 'stays'; busyFrom?: number }

function engine(on: On, { env = {}, placement, refuses = () => undefined, wake, exit = 'stays', busyFrom }: Options = {}) {
  let probeCount = 0
  let releaseCount = 0
  const scripts: string[] = []
  const commands: { command: string; args?: string }[] = []
  const toasts: string[] = []
  const logs: string[] = []
  const registered: string[] = []
  const files = new Map<string, string>(placement === undefined ? [] : [[placementPath(STATE), placement]])
  const marker = wakePath(STATE, ID)
  const held = new Map<string, unknown>()
  const clock = mock.clock(on, { now: 1_000_000 })
  const session = mock.session(on)
  mock.env(on, { OS: 'Windows_NT', SystemRoot: 'C:\\Windows', LOCALAPPDATA: LOCAL, USERPROFILE: 'C:\\Users\\u', ...env })
  on('tool.check', { tool: 'CronList' }, () => ({ decision: 'allow' as const }))
  on('tool.call', { tool: 'CronList' }, () => ({ result: { jobs: [] }, text: '0 scheduled jobs.' }) as never)
  on('tool.list', () => ({ value: wake === undefined ? [] : [{ name: 'mcp__self-wake__wake_after', description: 'Wakes this session later.', mcp: true }] }))
  // This conversation's transcript, under the repo's project folder: the start folder holds it.
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || (e.path === marker && typeof wake === 'string') || TRANSCRIPT.test(e.path) }))
  on('fs.read', (_, e) => (files.has(e.path) ? { value: files.get(e.path) as string } : e.path === marker && typeof wake === 'string' ? { value: wake } : { deny: `ENOENT: ${e.path}` }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('store.get', (_, e) => ({ value: held.get(e.key) }))
  on('store.set', (_, e) => {
    held.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: ID }))
  on('session.cwd', () => ({ value: 'C:\\work\\repo' }))
  on('command.register', (_, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', () => ({ value: { tool: TOOL } }))
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
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('process.run', (_, e) => {
    const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const argv = e.argv as readonly string[]
    if (argv[0] === 'git') return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    const script = String(e.init?.stdin ?? '')
    if (script.includes('$ids = @(')) {
      probeCount += 1
      if (busyFrom === undefined || probeCount < busyFrom) return ok(PROBE)
      const raw = JSON.parse(PROBE) as { procs: unknown[] }
      raw.procs.push({ pid: 500, ppid: 100, created: '134062355668901241', name: 'bash.exe', cls: 'shell' })
      return ok(`${JSON.stringify(raw)}\r\n`)
    }
    if (script.includes("'not-ours'")) {
      releaseCount += 1
      return ok('released\r\n')
    }
    scripts.push(script)
    const by = /^\$by = '((?:launch|slot):[0-9a-f-]{1,40})'$/m.exec(script)?.[1] ?? 'none'
    const refused = refuses(script)
    if (refused !== undefined) return ok(`${refused}\r\n`)
    if (script.includes('Start-Process $wtExe') && !script.includes('Start-Process -FilePath')) return ok(`claim ${by}\r\nlaunched tab claude-1\r\n`)
    if (script.includes('Start-Process $wtExe')) return ok(`claim ${by}\r\nlaunched window claude-overflow\r\n`)
    return ok(`claim ${by}\r\nlaunched window - 17716\r\n`)
  })
  /** The trampoline's own command, once queued: a test dequeues it, as the engine would. */
  const queuedGo = { args: '' }
  on('command.run', async (_, e) => {
    if (e.command === 'self-restart-go') {
      queuedGo.args = e.args
      return {}
    }
    commands.push({ command: e.command, ...(e.args ? { args: e.args } : {}) })
    if (exit === 'exits') await clock.sleep(3_600_000)
    return {}
  })
  return { scripts, commands, toasts, logs, registered, files, clock, session, held, probes: () => probeCount, released: () => releaseCount, queuedGo }
}

const start = { cwd: 'C:\\work\\repo', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as const
const STAMP = { CLAUDE_SELF_TOOLS_WT_WINDOW: 'claude-1', CLAUDE_SELF_TOOLS_WT_TAB: 'lane-z' }

type TestDollar = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

async function restart($: TestDollar, clock: { advance: (ms: number) => Promise<void> }): Promise<void> {
  expect((await $.tool.call({ tool: TOOL, reason: 'Testing.' })).deny).toBeUndefined()
  await $.turn.complete(answered)
  await clock.advance(1000)
}

test('tab: same goes by this tab\'s stamp: a tab in that window, running the slot runner, under the claim naming launch:<id>, waiting for this process', async ($, on) => {
  const { scripts, commands, toasts, clock } = engine(on, { env: STAMP, placement: FILE })
  await $.session.start(start)
  await restart($, clock)
  expect(scripts).toHaveLength(1)
  const script = scripts[0] ?? ''
  // This restart's own claim, on the tab's line too: a later launch that takes the lock over turns this tab away.
  const by = /^\$by = '(launch:[0-9a-f-]{36})'\r?$/m.exec(script)?.[1]
  expect(by).not.toBe(`launch:${ID}`)
  expect(script).toContain(`-Claim ${by} `)
  expect(script).toContain('Start-Process $wtExe -ArgumentList $wtLine -PassThru')
  expect(script).toContain("$env:CLAUDE_SELF_TOOLS_WT_WINDOW = 'claude-1'")
  expect(script).toContain("$env:CLAUDE_SELF_TOOLS_WT_TAB = 'lane-z'")
  expect(script).toContain(`-Resume ${ID} -WaitFor 100-134062345688901240`)
  expect(commands).toEqual([{ command: 'exit' }])
  expect(toasts.join(' ')).toContain('a new tab in window claude-1 resumes this session')
})

test('a hand-started tab has no stamp: past the tab, to the placement\'s window', async ($, on) => {
  const { scripts, commands, clock } = engine(on, { placement: FILE })
  await $.session.start(start)
  await restart($, clock)
  expect(scripts[0]).toContain('-w claude-overflow --pos 1920,0 --size 140,60 nt ')
  expect(commands).toEqual([{ command: 'exit' }])
})

test('a stamp that is not of its shape counts as none', async ($, on) => {
  const { scripts, clock } = engine(on, { env: { CLAUDE_SELF_TOOLS_WT_WINDOW: 'last' }, placement: FILE })
  await $.session.start(start)
  await restart($, clock)
  expect(scripts).toHaveLength(1)
  expect(scripts[0]).not.toContain('-w last')
})

test('no placement.json: today\'s window', async ($, on) => {
  const { scripts, clock } = engine(on, { env: STAMP })
  await $.session.start(start)
  await restart($, clock)
  expect(scripts[0]).not.toContain('Start-Process $wtExe')
  expect(scripts[0]).toContain('$window = Start-Process -FilePath')
})

test('a bad file means no placement: today\'s window, said once in the log', async ($, on) => {
  const { scripts, logs, clock } = engine(on, { env: STAMP, placement: JSON.stringify({ v: 1, layout: [{ window: '0', tabs: ['t'], folder: 'C:\\x' }] }) })
  await $.session.start(start)
  await restart($, clock)
  expect(scripts[0]).not.toContain('Start-Process $wtExe')
  expect(logs.filter(line => line.startsWith('placement.json is not of its shape')).length).toBeLessThanOrEqual(1)
})

test('refused for want of Windows Terminal, or the slot runner: the next place, then today\'s window; nothing else moves on', async ($, on) => {
  let n = 0
  const { scripts, commands, clock } = engine(on, {
    env: STAMP,
    placement: FILE,
    refuses: () => {
      n += 1
      return n === 1 ? 'refused wt self-restart: a tab needs Windows Terminal 1.19 or later' : n === 2 ? 'refused slotscript self-restart: the slot runner is not in place' : undefined
    },
  })
  await $.session.start(start)
  await restart($, clock)
  expect(scripts).toHaveLength(3)
  expect(scripts[0]).toContain('-w claude-1 nt')
  expect(scripts[1]).toContain('-w claude-overflow')
  expect(scripts[2]).not.toContain('Start-Process $wtExe')
  expect(commands).toEqual([{ command: 'exit' }])
})

test("a place the launch can't be built for (a config folder Windows Terminal would expand): the next place, not a refused restart (N3)", async ($, on) => {
  const { scripts, commands, clock } = engine(on, { env: { ...STAMP, CLAUDE_CONFIG_DIR: 'C:\\config%x' }, placement: FILE })
  await $.session.start(start)
  await restart($, clock)
  expect(scripts).toHaveLength(1)
  expect(scripts[0]).toContain('$window = Start-Process -FilePath')
  expect(commands).toEqual([{ command: 'exit' }])
})

test('any other refusal stops the restart: nothing more is tried, and nothing exits', async ($, on) => {
  const { scripts, commands, clock } = engine(on, { env: STAMP, placement: FILE, refuses: () => 'refused claim self-restart: another holds the claim' })
  await $.session.start(start)
  await restart($, clock)
  expect(scripts).toHaveLength(1)
  expect(commands).toEqual([])
})

test('a wake-up pending, by self-wake\'s marker, refuses the restart at the call (S1-9)', async ($, on) => {
  const { clock } = engine(on, { wake: wakeMarker({ armed: true, due: 2_000_000, at: 1 }) })
  void clock
  await $.session.start(start)
  const refused = await $.tool.call({ tool: TOOL, reason: 'Testing.' })
  expect(refused.deny).toContain('a wake-up is pending')
})

test("the trampoline: GO_VIA ships as 'direct', its command registered all the same, and typing it does nothing", async ($, on) => {
  const { registered, commands } = engine(on)
  await $.session.start(start)
  expect(GO_VIA).toBe('direct')
  expect(go.via).toBe('direct')
  expect(registered).toContain('self-restart-go')
  expect((await $.command.run({ command: 'self-restart-go', args: 'typed by a person', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })).text).toBe(GO_NOTHING)
  expect(await goAnswer($ as never, go, 'typed')).toEqual({ text: GO_NOTHING })
  expect(commands).toEqual([])
})

// The plugin's hooks load apart from a test's modules, so a test can't flip the `go` they use: these run
// once GO_VIA itself is flipped. The S2 round ran them so, against a copy of the plugin with the constant changed:
// the stand-down passes; the /exit does not yet, as the kit refuses a command from a command.run hook (M17b).
// On a flip, 'through it: dequeued' fails until the design's Trampoline C: the flip's checklist names it.
const afterFlip: typeof test = GO_VIA === 'trampoline' ? test : (...args) => test(`skipped until GO_VIA flips: ${args[0]}`, () => undefined)
/** What the engine does with the queued command: runs it, through the plugin's own hook. */
async function dequeue($: TestDollar, clock: { advance: (ms: number) => Promise<void> }, args: string): Promise<void> {
  await $.command.run({ command: 'self-restart-go', args, origin: { kind: 'plugin', name: 'self-restart' }, presentation: { isFullscreen: false, columns: 120 } })
  await clock.advance(1)
}

afterFlip('through it: dequeued with nothing changed, /exit runs, after a look at the process tree', async ($, on) => {
  const { probes, commands, clock, queuedGo } = engine(on)
  await $.session.start(start)
  await restart($, clock)
  expect(commands).toEqual([])
  await dequeue($, clock, queuedGo.args)
  expect(probes()).toBe(3)
  expect(commands).toEqual([{ command: 'exit' }])
})

afterFlip('through it: a job under this session at dequeue stands it down: no /exit, the claim released, the restart gone from the store, and said', async ($, on) => {
  const { commands, toasts, released, held, clock, queuedGo } = engine(on, { busyFrom: 3 })
  await $.session.start(start)
  await restart($, clock)
  await dequeue($, clock, queuedGo.args)
  expect(commands).toEqual([])
  expect(released()).toBeGreaterThan(0)
  expect(held.get('restarts')).toEqual({})
  expect(toasts.join(' ')).toContain('Restart stood down')
})
