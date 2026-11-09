// Claude Code empties a plugin's `$.state` at an in-process /clear or /resume, and no session.start follows
// (claude-code-self-tools#24). The start folder outlives it in the module, goes back at the move's
// SessionStart and at the first read that finds it empty, and is checked against the conversation's
// transcript before anything exits, a long folder by Claude Code's own shortened name; with no folder that
// holds the transcript, the call is refused, saying why and what to tell the person. A call while
// `$.session.id()` lags a move is refused too. Nothing here touches a real file: the disk is the test's.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__self-restart__restart_after_turn'
const ID = '00000000-0000-0000-0000-00000000000a'
/** The conversation a /resume brings the process to, while `$.session.id()` still reads ID. */
const OTHER = '00000000-0000-0000-0000-00000000000b'
const REPO = 'C:\\work\\repo'
const WORKTREE = 'C:\\work\\repo\\.claude\\worktrees\\feature'
/** A start folder over 200 characters: Claude Code shortens its project folder's name. */
const LONG = `C:\\work\\${'a'.repeat(100)}\\${'b'.repeat(100)}\\repo`
const CONFIG = 'C:\\Users\\u\\.claude'
const PROJECTS = `${CONFIG}\\projects`
/** Where `claude --resume ID` finds the conversation: under the repo's project folder. */
const PROJECT = `${PROJECTS}\\C--work-repo`
const TRANSCRIPT = `${PROJECT}\\${ID}.jsonl`
const WINDOWS = { OS: 'Windows_NT', SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', USERPROFILE: 'C:\\Users\\u' }
const FOLDER = 'self-restart/folder'

/**
 * Claude Code's name for a folder's project folder, written out here as the engine has it, apart from the
 * plugin's: every character but a letter or a digit made `-`; past 200, the first 200, a `-`, and the
 * folder's 31-multiplier string hash, its absolute value in base 36.
 */
function engineName(folder: string): string {
  const name = folder.replace(/[^a-zA-Z0-9]/g, '-')
  if (name.length <= 200) return name
  let h = 0
  for (let n = 0; n < folder.length; n++) h = ((h << 5) - h + folder.charCodeAt(n)) | 0
  return `${name.slice(0, 200)}-${Math.abs(h).toString(36)}`
}

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
  /** What `$.session.root()` and `$.session.cwd()` read; null: they can't be read. */
  root?: string | null
  cwd?: string | null
  /** The files on the test's disk; by default this conversation's transcript under the repo's project folder. */
  disk?: readonly string[]
  /** The folders `$.fs.list` finds under the projects folder. */
  projects?: readonly string[]
  /** `$.fs.exists` refuses: the check can't run. */
  existsFails?: boolean
}

/** The engine beneath the plugin, its `$.state` the test's own, so a test can empty it as Claude Code does. */
function engine(on: On, { root = REPO, cwd = REPO, disk = [TRANSCRIPT], projects = [], existsFails = false }: Options = {}) {
  const state = new Map<string, { value: unknown; version: number }>()
  const world = { id: ID }
  const files = new Set(disk)
  const exists: string[] = []
  const launched: string[] = []
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
    if (existsFails) return { deny: 'EACCES: permission denied' }
    return { value: files.has(e.path) }
  })
  on('fs.list', (_, e) => (e.path === PROJECTS ? { value: projects.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) } : { deny: `ENOENT: ${e.path}` }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: world.id }))
  on('session.root', () => (root === null ? { deny: 'no root' } : { value: root }))
  on('session.cwd', () => (cwd === null ? { deny: 'no folder' } : { value: cwd }))
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
  return { state, world, files, wipe, exists, launched, toasts, clock, session }
}

const start = (cwd = REPO) => ({ cwd, surface: 'terminal', isInteractive: true }) as const
const answered = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as const
const BY_HAND = `Tell the person to restart by hand: exit (/exit), then run \`claude --resume ${ID}\` in`

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
  expect(w.exists).toContain(`${PROJECTS}\\C--work-repo--claude-worktrees-feature\\${ID}.jsonl`)
})

test('then the session folder, when it alone holds the transcript', async ($, on) => {
  const w = engine(on, { root: WORKTREE, cwd: REPO })
  await $.session.start(start(WORKTREE))
  expect((await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })).deny).toBeUndefined()
  await $.turn.complete(answered)
  await w.clock.advance(1000)
  expect(w.launched).toEqual([REPO])
})

test('folders known, none holding the transcript: refused at the call, each named once with what it is, and the project folder the transcript path names', async ($, on) => {
  const w = engine(on, { root: WORKTREE, cwd: WORKTREE, disk: [] })
  await $.session.start(start(WORKTREE))
  await $.classic.SessionStart({ source: 'resume', session_id: ID, transcript_path: TRANSCRIPT })

  const refused = await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  expect(refused.deny).toBe(
    `Not queued: none of this session's folders holds its transcript: not ${WORKTREE} (the folder it started in, its project root, its folder); Claude Code keeps its transcript in ${PROJECT}. ${BY_HAND} the folder the session started in, the one that project folder is named for.`,
  )
  await $.turn.complete(answered)
  await w.clock.advance(1000)
  expect(w.launched).toEqual([])
  expect(w.toasts).toEqual([])
  expect(w.session.appended()).toEqual([])
})

test('folders known, none holding it, no transcript path: the project folder found on disk is named; with none found, none is', async ($, on) => {
  const w = engine(on, { root: REPO, cwd: WORKTREE, disk: [`${PROJECTS}\\C--work-elsewhere\\${ID}.jsonl`], projects: ['C--work-other', 'C--work-elsewhere'] })
  await $.session.start(start(WORKTREE))
  const refused = await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  expect(refused.deny).toBe(
    `Not queued: none of this session's folders holds its transcript: not ${WORKTREE} (the folder it started in, its folder), nor ${REPO} (its project root); Claude Code keeps its transcript in ${PROJECTS}\\C--work-elsewhere. ${BY_HAND} the folder the session started in, the one that project folder is named for.`,
  )
  w.files.clear()
  expect((await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })).deny).toBe(
    `Not queued: none of this session's folders holds its transcript: not ${WORKTREE} (the folder it started in, its folder), nor ${REPO} (its project root). ${BY_HAND} the folder the session started in.`,
  )
})

test("no start folder known, the other folders known: the refusal says the state was emptied, and names them", async ($, on) => {
  // No session.start in this module (nothing kept the start folder), and $.state empty.
  engine(on, { root: WORKTREE, cwd: WORKTREE, disk: [] })
  const refused = await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  expect(refused.deny).toBe(
    `Not queued: the folder it started in isn't known (Claude Code emptied plugin state at a /clear or /resume), and none of this session's folders holds its transcript: not ${WORKTREE} (its project root, its folder). ${BY_HAND} the folder the session started in.`,
  )
})

test('nothing known at all: no start folder, and the session folders unreadable', async ($, on) => {
  engine(on, { root: null, cwd: null, disk: [] })
  const refused = await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  expect(refused.deny).toBe(
    `Not queued: no folder of this session is known, not even the one it started in: Claude Code emptied plugin state at a /clear or /resume, and the session's folders can't be read. ${BY_HAND} the folder the session started in.`,
  )
})

test("the check can't run (the look at the disk refused): the refusal says so, and names the folder to try", async ($, on) => {
  const w = engine(on, { existsFails: true })
  await $.session.start(start())
  const refused = String((await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })).deny)
  // The engine's own words for the refused look go in the brackets.
  expect(refused.startsWith(`Not queued: whether ${REPO} (the folder it started in) holds this conversation's transcript can't be checked: looking for ${TRANSCRIPT} failed (`)).toBe(true)
  expect(refused).toContain('EACCES: permission denied')
  expect(refused.endsWith(`). ${BY_HAND} ${REPO}, if that is the folder the session started in.`)).toBe(true)
  await $.turn.complete(answered)
  await w.clock.advance(1000)
  expect(w.launched).toEqual([])
})

test('the transcript path a classic hook named is enough: the start folder whose project folder holds it passes, with nothing on disk to find', async ($, on) => {
  const w = engine(on, { root: WORKTREE, cwd: WORKTREE, disk: [] })
  await $.session.start(start())
  await $.classic.SessionStart({ source: 'startup', session_id: ID, transcript_path: TRANSCRIPT })
  expect((await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })).deny).toBeUndefined()
  await $.turn.complete(answered)
  await w.clock.advance(1000)
  expect(w.launched).toEqual([REPO])
})

test("another conversation's transcript path says nothing of this one: the start folder is looked for on disk", async ($, on) => {
  const w = engine(on, { disk: [] })
  await $.session.start(start())
  await $.classic.SessionStart({ source: 'startup', session_id: OTHER, transcript_path: `${PROJECT}\\${OTHER}.jsonl` })
  // Past the id's lag, so the call is the session's own.
  await w.clock.advance(16_000)
  const refused = await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  expect(refused.deny).toMatch(/^Not queued: none of this session's folders holds its transcript/)
  expect(w.exists).toContain(TRANSCRIPT)
})

test('a transcript path in another project folder: the start folder fails the check, though a file of that name were found', async ($, on) => {
  const w = engine(on)
  await $.session.start(start())
  await $.classic.SessionStart({ source: 'resume', session_id: ID, transcript_path: `${PROJECTS}\\C--work-other\\${ID}.jsonl` })
  const refused = await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  expect(refused.deny).toContain(`; Claude Code keeps its transcript in ${PROJECTS}\\C--work-other.`)
  expect(w.launched).toEqual([])
})

test("a start folder over 200 characters: Claude Code's shortened project folder holds the transcript, so it restarts with no wipe, and after one", async ($, on) => {
  const name = engineName(LONG)
  expect(name).toMatch(/^C--work-a{100}-b{91}-[0-9a-z]+$/)
  const w = engine(on, { root: LONG, cwd: LONG, disk: [`${PROJECTS}\\${name}\\${ID}.jsonl`] })
  await $.session.start(start(LONG))
  expect((await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })).deny).toBeUndefined()
  await $.turn.complete(answered)
  await w.clock.advance(1000)
  expect(w.launched).toEqual([LONG])

  // Past the loop guard's 2 minutes, a /resume empties $.state: the long folder goes back, and passes again.
  await w.clock.advance(3 * 60 * 1000)
  w.wipe()
  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  expect((await $.tool.call({ tool: TOOL, reason: 'Switched accounts again.' })).deny).toBeUndefined()
})

test('a long start folder whose shortened name was hashed from another spelling: found by its first 200 characters, holding the transcript', async ($, on) => {
  const prefix = engineName(LONG).slice(0, 200)
  const other = `${prefix}-x1y2`
  const w = engine(on, { root: WORKTREE, cwd: WORKTREE, disk: [`${PROJECTS}\\${other}\\${ID}.jsonl`], projects: ['C--work-repo', `${prefix}-nothere`, other] })
  await $.session.start(start(LONG))
  expect((await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })).deny).toBeUndefined()
  await $.turn.complete(answered)
  await w.clock.advance(1000)
  expect(w.launched).toEqual([LONG])
})

test('a long start folder and the transcript path a classic hook named, in its shortened project folder: it passes', async ($, on) => {
  const w = engine(on, { root: WORKTREE, cwd: WORKTREE, disk: [] })
  await $.session.start(start(LONG))
  await $.classic.SessionStart({ source: 'startup', session_id: ID, transcript_path: `${PROJECTS}\\${engineName(LONG)}\\${ID}.jsonl` })
  expect((await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })).deny).toBeUndefined()
  await $.turn.complete(answered)
  await w.clock.advance(1000)
  expect(w.launched).toEqual([LONG])
})

test("right after a move, while $.session.id() still reads the conversation left: refused, saying so; past the lag, the id is the conversation's", async ($, on) => {
  const w = engine(on, { disk: [TRANSCRIPT, `${PROJECT}\\${OTHER}.jsonl`] })
  await $.session.start(start())
  await w.clock.advance(5000)
  // A /resume to OTHER: its SessionStart names it; $.session.id() still reads ID.
  await $.classic.SessionStart({ source: 'resume', session_id: OTHER })
  await w.clock.advance(3000)
  const refused = await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  expect(refused.deny).toBe(
    `Not queued: this session's id reads ${ID}, but its last SessionStart named ${OTHER} 3 seconds ago: it is moving between conversations, so which one a restart would resume is unclear. Try again in a moment.`,
  )
  // The id catches up: the call is queued, for the conversation it reads.
  w.world.id = OTHER
  expect((await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })).deny).toBeUndefined()
})
