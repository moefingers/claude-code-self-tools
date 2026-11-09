// Claude Code empties a plugin's `$.state` at an in-process /clear or /resume, and no session.start follows
// (claude-code-self-tools#24). self-switch's start folder outlives it in the module: it goes back to
// `$.state` at the move's SessionStart and at the heartbeat that finds it empty, and a session.start that
// finds none kept anywhere takes its own folder only when that holds the conversation's transcript, or the
// conversation has no prompt yet. Nothing here touches a real file: the transcript is the test's answer.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__self-switch__switch_after_turn'
const ID = '5d2b8e14-7a3c-4f9e-b6d1-0c4e8a2f7b39'
const REPO = 'C:\\work\\repo'
const WORKTREE = 'C:\\work\\repo\\.claude\\worktrees\\feature'
const CONFIG = 'C:\\Users\\u\\.claude'
const TRANSCRIPT = `${CONFIG}\\projects\\C--work-repo\\${ID}.jsonl`
const WINDOWS = { OS: 'Windows_NT', SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', USERPROFILE: 'C:\\Users\\u' }
const FOLDER = 'self-switch/folder'
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0)

type Options = {
  /** How many prompts the conversation has had: none at a first start. */
  turns?: number
  /** Whether the transcript is on disk under the repo's project folder. */
  onDisk?: boolean
}

/** The engine beneath the plugin, its `$.state` the test's own, so a test can empty it as Claude Code does. */
function engine(on: On, { turns = 3, onDisk = true }: Options = {}) {
  const state = new Map<string, { value: unknown; version: number }>()
  const held = new Map<string, unknown>()
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
  on('fs.exists', (_, e) => ({ value: onDisk && e.path === TRANSCRIPT }))
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
  return { state, held, logs, clock, wipe }
}

const start = (cwd = REPO) => ({ cwd, surface: 'terminal', isInteractive: true }) as const
/** The heartbeat this conversation keeps, as liveness reads it. */
const beat = (held: Map<string, unknown>) => held.get(`alive:${ID}`) as { folder?: string; project?: string } | undefined

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

test("a reload after the wipe starts the plugin in a worktree: with prompts in the conversation and its transcript elsewhere, the worktree isn't taken", async ($, on) => {
  const w = engine(on, { turns: 3 })
  // No start folder kept anywhere (the module is new, `$.state` empty), and the session is in a worktree now.
  await $.session.start(start(WORKTREE))
  await w.clock.settle()
  expect(w.state.get(FOLDER)).toBeUndefined()
  // No heartbeat names it either: liveness would read a folder the conversation isn't under.
  expect(beat(w.held)).toBeUndefined()
  expect(w.logs.some(line => line.includes(`${WORKTREE}, where the plugin starts again, doesn't hold this conversation's transcript`))).toBe(true)
})

test('a reload after the wipe in the folder that holds the transcript: that folder is the start folder again', async ($, on) => {
  const w = engine(on, { turns: 3 })
  await $.session.start(start(REPO))
  await w.clock.settle()
  expect(w.state.get(FOLDER)?.value).toBe(REPO)
  expect(beat(w.held)?.folder).toBe(REPO)
})

test('a first start, before any prompt: its own folder, though no transcript is written yet', async ($, on) => {
  const w = engine(on, { turns: 0, onDisk: false })
  await $.session.start(start(WORKTREE))
  expect(w.state.get(FOLDER)?.value).toBe(WORKTREE)
})
