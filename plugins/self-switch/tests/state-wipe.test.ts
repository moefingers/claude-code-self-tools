// Claude Code empties a plugin's `$.state` at an in-process /clear or /resume, and no session.start follows
// (claude-code-self-tools#24). self-switch's start folder outlives it in the module: it goes back to
// `$.state` at the move's SessionStart and at the heartbeat that finds it empty. A session.start that finds
// none kept anywhere holds its own folder provisional, taken only once known: this process's own startup
// named the conversation, or the folder holds its transcript. The heartbeat goes on meanwhile, without a
// folder. Nothing here touches a real file: the transcript is the test's answer.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__self-switch__switch_after_turn'
const ID = '00000000-0000-0000-0000-00000000000a'
const REPO = 'C:\\work\\repo'
const WORKTREE = 'C:\\work\\repo\\.claude\\worktrees\\feature'
const CONFIG = 'C:\\Users\\u\\.claude'
const PROJECTS = `${CONFIG}\\projects`
const TRANSCRIPT = `${PROJECTS}\\C--work-repo\\${ID}.jsonl`
const WINDOWS = { OS: 'Windows_NT', SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', USERPROFILE: 'C:\\Users\\u' }
const FOLDER = 'self-switch/folder'
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0)

type Options = {
  /** How many prompts the conversation has had: none at a first start, nor after a /clear. */
  turns?: number
  /** Whether the transcript is on disk under the repo's project folder at the start. */
  onDisk?: boolean
  /** `$.fs.exists` refuses: the check can't run. */
  existsFails?: boolean
  /** What the plugin's store holds at the start. */
  store?: Record<string, unknown>
}

/** The engine beneath the plugin, its `$.state` the test's own, so a test can empty it as Claude Code does. */
function engine(on: On, { turns = 3, onDisk = true, existsFails = false, store = {} }: Options = {}) {
  const state = new Map<string, { value: unknown; version: number }>()
  const held = new Map<string, unknown>(Object.entries(store))
  const disk = new Set(onDisk ? [TRANSCRIPT] : [])
  const logs: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, WINDOWS)
  on('state.get', (_, e) => ({ value: state.get(`${e.plugin}/${e.key}`) ?? { value: undefined, version: 0 } }))
  on('state.set', (_, e) => {
    const key = `${e.plugin}/${e.key}`
    const version = (state.get(key)?.version ?? 0) + 1
    state.set(key, { value: JSON.parse(JSON.stringify(e.value ?? null)), version })
    return { value: { isSet: true, version } }
  })
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
  on('fs.exists', (_, e) => (existsFails ? { deny: 'EACCES: permission denied' } : { value: disk.has(e.path) }))
  on('fs.list', (_, e) => (e.path === PROJECTS ? { value: ['C--work-other', 'C--work-repo'].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) } : { deny: `ENOENT: ${e.path}` }))
  on('fs.read', (_, e) => ({ deny: `ENOENT: ${e.path}` }))
  on('fs.write', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: ID }))
  on('session.turns', () => ({ value: turns }))
  on('session.cwd', () => ({ value: REPO }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('tool.list', () => ({ value: [] }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', (_, e) => {
    logs.push(String(e.text))
    return { value: undefined }
  })
  on('classic.SessionStart', () => ({}))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  // The left record's script and the rest of the machine: none of them runs here.
  on('process.run', () => ({ deny: 'no machine in this test' }))
  /** Claude Code at an in-process /clear or /resume: every value of the plugin's `$.state` gone, and no session.start. */
  const wipe = () => state.clear()
  return { state, held, disk, logs, clock, wipe }
}

const start = (cwd = REPO) => ({ cwd, surface: 'terminal', isInteractive: true }) as const
/** The heartbeat this conversation keeps, as liveness reads it. */
const beat = (held: Map<string, unknown>) => held.get(`alive:${ID}`) as { at?: number; folder?: string; project?: string } | undefined

test('a /resume empties $.state and no session.start follows: the start folder goes back at its SessionStart', async ($, on) => {
  const w = engine(on)
  await $.session.start(start())
  expect(w.state.get(FOLDER)?.value).toBe(REPO)
  w.wipe()
  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  expect(w.state.get(FOLDER)?.value).toBe(REPO)
  // A /clear's does the same, and again is safe: the one value this process started with.
  w.wipe()
  await $.classic.SessionStart({ source: 'clear', session_id: ID })
  await $.classic.SessionStart({ source: 'clear', session_id: ID })
  expect(w.state.get(FOLDER)?.value).toBe(REPO)
})

test('a wipe that lands after the SessionStart: the heartbeat that finds the start folder empty puts it back', async ($, on) => {
  const w = engine(on)
  await $.session.start(start())
  await $.classic.SessionStart({ source: 'clear', session_id: ID })
  w.wipe()
  await $.turn.start({ text: 'go on', turnId: 't1' })
  await w.clock.settle()
  expect(w.state.get(FOLDER)?.value).toBe(REPO)
  expect(beat(w.held)?.folder).toBe(REPO)
  // And between turns, at the 2-minute beat.
  w.wipe()
  await w.clock.advance(2 * 60 * 1000)
  expect(w.state.get(FOLDER)?.value).toBe(REPO)
})

test("a reload after the wipe starts the plugin in a worktree, its transcript elsewhere: the worktree isn't taken, the log says why and where the transcript is, and the heartbeat goes on without a folder", async ($, on) => {
  const w = engine(on, { turns: 3 })
  // No start folder kept anywhere (the module is new, `$.state` empty), and the session is in a worktree now.
  await $.session.start(start(WORKTREE))
  await w.clock.settle()
  expect(w.state.get(FOLDER)).toBeUndefined()
  expect(beat(w.held)).toMatchObject({ folder: '', project: '' })
  expect(typeof beat(w.held)?.at).toBe('number')
  expect(w.logs).toContain(
    `self-switch: the folder this session started in isn't known (Claude Code empties plugin state at a /clear or /resume, and nothing kept it), and ${WORKTREE}, where the plugin started again, doesn't hold this conversation's transcript; Claude Code keeps it in ${PROJECTS}\\C--work-repo. It isn't taken as the start folder, and a switch here refuses until the session restarts.`,
  )
  // Said once, however many heartbeats look again.
  await $.turn.start({ text: 'go on', turnId: 't1' })
  await w.clock.advance(5 * 60 * 1000)
  expect(w.logs.filter(line => line.startsWith('self-switch: the folder this session started in'))).toHaveLength(1)
  expect(w.state.get(FOLDER)).toBeUndefined()
})

test('a reload after the wipe in the folder that holds the transcript: that folder is the start folder again', async ($, on) => {
  const w = engine(on, { turns: 3 })
  await $.session.start(start(REPO))
  await w.clock.settle()
  expect(w.state.get(FOLDER)?.value).toBe(REPO)
  expect(beat(w.held)?.folder).toBe(REPO)
})

test("a first start, before any prompt: this process's own startup names the conversation, so its folder is taken, the startup's SessionStart before session.start or after it", async ($, on) => {
  const w = engine(on, { turns: 0, onDisk: false })
  await $.session.start(start(WORKTREE))
  expect(w.state.get(FOLDER)).toBeUndefined()
  await $.classic.SessionStart({ source: 'startup', session_id: ID })
  expect(w.state.get(FOLDER)?.value).toBe(WORKTREE)
})

test('the startup SessionStart before session.start: taken at session.start', async ($, on) => {
  const w = engine(on, { turns: 0, onDisk: false })
  await $.classic.SessionStart({ source: 'startup', session_id: ID })
  await $.session.start(start(WORKTREE))
  expect(w.state.get(FOLDER)?.value).toBe(WORKTREE)
})

test("a reload after a /clear, before its first prompt: no prompt is no proof, so the folder waits, and isn't taken where the transcript then doesn't appear", async ($, on) => {
  const w = engine(on, { turns: 0, onDisk: false })
  // The /clear's conversation has no prompt, nor a transcript yet; this module saw no startup.
  await $.session.start(start(WORKTREE))
  await w.clock.settle()
  expect(w.state.get(FOLDER)).toBeUndefined()
  // Its first prompt writes the transcript under the folder the process really started in.
  w.disk.add(TRANSCRIPT)
  await $.turn.start({ text: 'go on', turnId: 't1' })
  await w.clock.settle()
  expect(w.state.get(FOLDER)).toBeUndefined()
  expect(beat(w.held)?.folder).toBe('')
})

test('a folder held provisional is taken once the transcript appears under its project', async ($, on) => {
  const w = engine(on, { turns: 0, onDisk: false })
  await $.session.start(start(REPO))
  expect(w.state.get(FOLDER)).toBeUndefined()
  w.disk.add(TRANSCRIPT)
  await $.turn.start({ text: 'go on', turnId: 't1' })
  await w.clock.settle()
  expect(w.state.get(FOLDER)?.value).toBe(REPO)
  expect(beat(w.held)?.folder).toBe(REPO)
})

test("a check that can't run: the folder isn't taken, and the log says the check couldn't be made", async ($, on) => {
  const w = engine(on, { turns: 3, existsFails: true })
  await $.session.start(start(WORKTREE))
  await w.clock.settle()
  expect(w.state.get(FOLDER)).toBeUndefined()
  const said = w.logs.find(line => line.startsWith(`self-switch: whether ${WORKTREE}, where the plugin started again, is the folder this session started in can't be checked: looking for `))
  expect(said).toBeDefined()
  expect(said).toContain('EACCES: permission denied')
  expect(said?.endsWith("It isn't taken as the start folder until it can be, and a switch here refuses meanwhile.")).toBe(true)
})

test("the heartbeat with the start folder unknown carries the last beat's folder forward: after a wipe and a reload in a worktree, the alive record keeps its folder", async ($, on) => {
  const w = engine(on, { turns: 3, store: { [`alive:${ID}`]: { at: NOW - 60_000, folder: REPO, project: 'C--work-repo' } } })
  await $.session.start(start(WORKTREE))
  await w.clock.settle()
  expect(w.state.get(FOLDER)).toBeUndefined()
  expect(beat(w.held)).toEqual({ at: NOW, folder: REPO, project: 'C--work-repo' })
  await w.clock.advance(2 * 60 * 1000)
  expect(beat(w.held)).toEqual({ at: NOW + 2 * 60 * 1000, folder: REPO, project: 'C--work-repo' })
})
