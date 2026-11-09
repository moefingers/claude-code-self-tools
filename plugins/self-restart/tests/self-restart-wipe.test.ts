// Claude Code empties a plugin's `$.state` at an in-process /clear or /resume, and no session.start follows
// (claude-code-self-tools#24). The start folder outlives it in the module, goes back at the move's
// SessionStart and at the first read that finds it empty, and is checked against the conversation's
// transcript before anything exits; with no folder that holds the transcript, the call is refused, saying
// how to restart by hand. Nothing here touches a real file: the transcript is an answer of the test's own.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__self-restart__restart_after_turn'
const ID = '7c1e9a42-5b3d-4f6e-8a19-2d4c6b8e0f13'
/** The conversation the process held before a /resume brought it to ID. */
const OTHER = '3a5c7e91-2b4d-4c6f-9e8a-1b3d5f7a9c2e'
const REPO = 'C:\\work\\repo'
const WORKTREE = 'C:\\work\\repo\\.claude\\worktrees\\feature'
const CONFIG = 'C:\\Users\\u\\.claude'
/** Where `claude --resume ID` finds the conversation: under the repo's project folder. */
const PROJECT = `${CONFIG}\\projects\\C--work-repo`
const TRANSCRIPT = `${PROJECT}\\${ID}.jsonl`
const WINDOWS = { OS: 'Windows_NT', SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', USERPROFILE: 'C:\\Users\\u' }
const FOLDER = 'self-restart/folder'

/** The probe's answer for a session with nothing running under it. */
const AT_REST = `${JSON.stringify({
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

type Options = {
  /** What `$.session.root()` and `$.session.cwd()` read. */
  root?: string
  cwd?: string
  /** Whether the transcript is on disk where the repo's project keeps it. */
  onDisk?: boolean
}

/** The engine beneath the plugin, its `$.state` the test's own, so a test can empty it as Claude Code does. */
function engine(on: On, { root = REPO, cwd = REPO, onDisk = true }: Options = {}) {
  const state = new Map<string, { value: unknown; version: number }>()
  const exists: string[] = []
  const launched: string[] = []
  const commands: string[] = []
  const toasts: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  const session = mock.session(on)
  mock.env(on, WINDOWS)
  on('state.get', (_, e) => ({ value: state.get(`${e.plugin}/${e.key}`) ?? { value: undefined, version: 0 } }))
  on('state.set', (_, e) => {
    const key = `${e.plugin}/${e.key}`
    const version = (state.get(key)?.version ?? 0) + 1
    state.set(key, { value: JSON.parse(JSON.stringify(e.value ?? null)), version })
    return { value: { isSet: true, version } }
  })
  const held = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: held.get(e.key) }))
  on('store.set', (_, e) => {
    held.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    held.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...held.keys()] }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', (_, e) => {
    exists.push(e.path)
    return { value: onDisk && e.path === TRANSCRIPT }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: ID }))
  on('session.root', () => ({ value: root }))
  on('session.cwd', () => ({ value: cwd }))
  on('tool.list', () => ({ value: [] }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('tool.check', { tool: 'CronList' }, () => ({ decision: 'allow' as const }))
  on('tool.call', { tool: 'CronList' }, (_, e) => ('input' in e ? { isError: true, result: 'InputValidationError', text: 'InputValidationError' } : { result: { jobs: [] }, text: 'No scheduled jobs.' }) as never)
  on('classic.SessionStart', () => ({}))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git') return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    if (String(e.init?.stdin ?? '').includes('$ids = @(')) return { value: { exitCode: 0, stdout: AT_REST, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    launched.push(String(e.init?.cwd ?? ''))
    const by = /^\$by = '(launch:[0-9a-f-]{36})'$/m.exec(String(e.init?.stdin ?? ''))?.[1] ?? 'none'
    return { value: { exitCode: 0, stdout: `claim ${by}\r\nlaunched window - 17716\r\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.run', () => ({}))
  /** Claude Code at an in-process /clear or /resume: every value of the plugin's `$.state` gone, and no session.start. */
  const wipe = () => state.clear()
  return { state, wipe, exists, launched, commands, toasts, clock, session }
}

const start = (cwd = REPO) => ({ cwd, surface: 'terminal', isInteractive: true }) as const
const answered = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as const

test('a /resume empties $.state and no session.start follows: the start folder goes back at its SessionStart, and the restart runs there', async ($, on) => {
  const w = engine(on, { root: WORKTREE, cwd: WORKTREE })
  await $.session.start(start())
  expect(w.state.get(FOLDER)?.value).toBe(REPO)

  // The /resume: the state emptied, no session.start, then the classic SessionStart of the resume.
  w.wipe()
  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  expect(w.state.get(FOLDER)?.value).toBe(REPO)

  // The session has moved into a worktree since; the restart still opens in the folder it started in.
  const queued = await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  expect(queued.deny).toBeUndefined()
  await $.turn.complete(answered)
  await w.clock.advance(1000)
  expect(w.launched).toEqual([REPO])
})

test('a /clear whose wipe lands after its SessionStart: the first read that finds the start folder empty puts it back', async ($, on) => {
  const w = engine(on, { root: WORKTREE, cwd: WORKTREE })
  await $.session.start(start())
  await $.classic.SessionStart({ source: 'clear', session_id: ID })
  expect(w.state.get(FOLDER)?.value).toBe(REPO)
  // The wipe comes a moment after the SessionStart.
  w.wipe()

  const queued = await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  expect(queued.deny).toBeUndefined()
  // The read at the call found it empty and put it back, with a plain set.
  expect(w.state.get(FOLDER)?.value).toBe(REPO)
  await $.turn.complete(answered)
  await w.clock.advance(1000)
  expect(w.launched).toEqual([REPO])
  expect(w.state.get(FOLDER)?.value).toBe(REPO)
})

test('each put-back is safe to repeat: a SessionStart that finds the folder still there sets it again, unchanged', async ($, on) => {
  const w = engine(on)
  await $.session.start(start())
  for (const source of ['resume', 'clear', 'resume'] as const) await $.classic.SessionStart({ source, session_id: ID })
  expect(w.state.get(FOLDER)?.value).toBe(REPO)
  // A compact, a fork and a subagent's start put nothing back: they move nothing.
  w.wipe()
  await $.classic.SessionStart({ source: 'compact', session_id: ID })
  await $.classic.SessionStart({ source: 'fork', session_id: OTHER })
  await $.classic.SessionStart({ source: 'resume', session_id: ID, agent_id: 'a1' })
  expect(w.state.get(FOLDER)).toBeUndefined()
})

test('a start folder that does not hold the transcript (a reload after the wipe set it from a worktree) gives way to the root that does', async ($, on) => {
  // The module's start folder is the worktree, as a reload after a wipe would set it; the root is the repo.
  const w = engine(on, { root: REPO, cwd: WORKTREE })
  await $.session.start(start(WORKTREE))

  const queued = await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  expect(queued.deny).toBeUndefined()
  await $.turn.complete(answered)
  await w.clock.advance(1000)
  // Never the worktree, whose project folder holds no transcript of this conversation.
  expect(w.launched).toEqual([REPO])
  expect(w.exists).toContain(`${CONFIG}\\projects\\C--work-repo--claude-worktrees-feature\\${ID}.jsonl`)
})

test('then the session folder, when it alone holds the transcript', async ($, on) => {
  const w = engine(on, { root: WORKTREE, cwd: REPO })
  await $.session.start(start(WORKTREE))
  expect((await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })).deny).toBeUndefined()
  await $.turn.complete(answered)
  await w.clock.advance(1000)
  expect(w.launched).toEqual([REPO])
})

test('no folder holds the transcript: refused at the call, not after the turn, saying how to restart by hand, and the project folder from the transcript path', async ($, on) => {
  const w = engine(on, { root: WORKTREE, cwd: WORKTREE, onDisk: false })
  await $.session.start(start(WORKTREE))
  await $.classic.SessionStart({ source: 'resume', session_id: ID, transcript_path: TRANSCRIPT })

  const refused = await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  expect(refused.deny).toBe(
    `Not queued: this session's start folder was lost when Claude Code emptied plugin state at a /clear or /resume. Restart by hand: exit (/exit), then run \`claude --resume ${ID}\` in the folder it started in (Claude Code keeps its transcript in ${PROJECT}).`,
  )
  await $.turn.complete(answered)
  await w.clock.advance(1000)
  expect(w.launched).toEqual([])
  expect(w.toasts).toEqual([])
  expect(w.session.appended()).toEqual([])
})

test('no folder holds the transcript, and no transcript path is known: the refusal names no folder', async ($, on) => {
  const w = engine(on, { root: WORKTREE, cwd: WORKTREE, onDisk: false })
  await $.session.start(start(WORKTREE))
  const refused = await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  expect(refused.deny).toBe(
    `Not queued: this session's start folder was lost when Claude Code emptied plugin state at a /clear or /resume. Restart by hand: exit (/exit), then run \`claude --resume ${ID}\` in the folder it started in.`,
  )
  await $.turn.complete(answered)
  await w.clock.advance(1000)
  expect(w.launched).toEqual([])
})

test('the transcript path a classic hook named is enough: the start folder whose project folder holds it passes, with nothing on disk to find', async ($, on) => {
  const w = engine(on, { root: WORKTREE, cwd: WORKTREE, onDisk: false })
  await $.session.start(start())
  await $.classic.SessionStart({ source: 'startup', session_id: ID, transcript_path: TRANSCRIPT })
  expect((await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })).deny).toBeUndefined()
  await $.turn.complete(answered)
  await w.clock.advance(1000)
  expect(w.launched).toEqual([REPO])
})

test("another conversation's transcript path says nothing of this one: the start folder is looked for on disk", async ($, on) => {
  const w = engine(on, { onDisk: false })
  await $.session.start(start())
  await $.classic.SessionStart({ source: 'startup', session_id: OTHER, transcript_path: `${PROJECT}\\${OTHER}.jsonl` })
  const refused = await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  expect(refused.deny).toMatch(/^Not queued: this session's start folder was lost/)
  expect(w.exists).toContain(TRANSCRIPT)
})

test('a transcript path in another project folder: the start folder fails the check, though a file of that name were found', async ($, on) => {
  const w = engine(on, { onDisk: true })
  await $.session.start(start())
  await $.classic.SessionStart({ source: 'resume', session_id: ID, transcript_path: `${CONFIG}\\projects\\C--work-other\\${ID}.jsonl` })
  const refused = await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  expect(refused.deny).toContain(`(Claude Code keeps its transcript in ${CONFIG}\\projects\\C--work-other)`)
  expect(w.launched).toEqual([])
})
