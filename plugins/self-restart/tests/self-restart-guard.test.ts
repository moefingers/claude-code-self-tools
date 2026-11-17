// #52, #53: where Claude Code's built-in guard loads (managed settings, or a Team or Enterprise login), a person's
// plugin's classic.SessionStart never runs, so the process a restart resumed never sent the restart's first prompt.
// Its partner (hooks/classic.ts) takes the restart up instead, 5 seconds after session.start, only while no classic
// hook has reached the process; an in-process /resume, from session.end and the id read as another. Where the classic
// SessionStart does run, it does the work as before, and the partner nothing: once, either way.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__self-restart__restart_after_turn'
/** The conversation the restart resumes, and another the process held before an in-process /resume. */
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const WINDOWS = { OS: 'Windows_NT', SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', USERPROFILE: 'C:\\Users\\u' }
const NOW = 1_000_000
/** How long the partner waits for a classic hook at a start, and how long after the take-up the prompt goes. */
const GRACE = 5000
const SETTLE = 500
/** The restart the old process kept: its reason, its first prompt and its claim. */
const RESTART = { at: NOW - 30_000, reason: 'Switched accounts.', resume: 'Go on with the review.', claim: 'launch:00000000-0000-4000-a000-000000000004' }
const PROMPT = 'Restarted. Resume: Go on with the review.'

type Options = {
  /** The restarts in the plugin's store. */
  restarts?: Record<string, unknown>
  /** What the plugin's session state holds at the start: a load after an earlier one in this process. */
  state?: Record<string, unknown>
  /** The conversation `$.session.id()` reads at the start. */
  id?: string
}

/** The engine beneath the plugin: its store, its session state (which a test empties as Claude Code does), and what it was asked. */
function engine(on: On, { restarts = { [ID]: RESTART }, state: kept = {}, id = ID }: Options = {}) {
  const store = new Map<string, unknown>([['restarts', restarts]])
  const state = new Map<string, unknown>(Object.entries(kept))
  const world = { id }
  const prompts: string[] = []
  const toasts: string[] = []
  const releases: string[] = []
  const clock = mock.clock(on, { now: NOW })
  const session = mock.session(on)
  mock.env(on, WINDOWS)
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('state.get', (_, e) => ({ value: { value: state.get(`${e.plugin}/${e.key}`), version: 1 } }))
  on('state.set', (_, e) => {
    state.set(`${e.plugin}/${e.key}`, JSON.parse(JSON.stringify(e.value ?? null)))
    return { value: { isSet: true, version: 2 } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: world.id }))
  on('session.info', () => ({ value: { transcriptPath: `C:\\Users\\u\\.claude\\projects\\C--work-repo\\${world.id}.jsonl` } }))
  on('session.turns', () => ({ value: 3 }))
  on('session.cwd', () => ({ value: 'C:\\work\\repo' }))
  on('fs.exists', () => ({ value: true }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('classic.SessionStart', () => ({}))
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('process.run', (_, e) => {
    const script = String(e.init?.stdin ?? '')
    if (script.includes("'not-ours'")) releases.push(script)
    return { value: { exitCode: 0, stdout: 'released\r\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { store, state, world, prompts, toasts, releases, clock, session }
}

const start = { cwd: 'C:\\work\\repo', surface: 'terminal', isInteractive: true } as const

test('#52, guarded: no classic SessionStart reaches the plugin, and the restart is taken up 5 s after session.start: its first prompt sent once, its claim released, its record gone', async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await w.clock.advance(GRACE - 1)
  expect(w.prompts).toEqual([])
  expect(w.toasts).toEqual([])
  await w.clock.advance(1 + SETTLE)
  expect(w.prompts).toEqual([PROMPT])
  expect(w.toasts).toContain('Restarted: Switched accounts.')
  expect(w.releases).toHaveLength(1)
  expect(w.releases[0]).toContain(`$lock.by -cne '${RESTART.claim}'`)
  expect(w.store.get('restarts')).toEqual({})
  // The start is marked taken up in the plugin's session state, and nothing goes twice.
  expect(w.state.get('self-restart/started')).toBe(ID)
  expect(w.state.get('self-restart/classic')).toBeUndefined()
  await w.clock.advance(60_000)
  expect(w.prompts).toEqual([PROMPT])
  expect(w.releases).toHaveLength(1)
})

test('unguarded: the classic SessionStart of the resume sends the first prompt as before, and the partner stands down: once', async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  await w.clock.advance(SETTLE)
  expect(w.prompts).toEqual([PROMPT])
  // The partner's grace passes: it took nothing, since a classic hook reached the process.
  await w.clock.advance(60_000)
  expect(w.prompts).toEqual([PROMPT])
  expect(w.toasts.filter(t => t.startsWith('Restarted:'))).toEqual(['Restarted: Switched accounts.'])
  expect(w.releases).toHaveLength(1)
  // It says so in its session state, for a reload, with the start it took up.
  expect(w.state.get('self-restart/classic')).toBe(true)
  expect(w.state.get('self-restart/started')).toBe(ID)
})

test('unguarded, the classic SessionStart late (after the grace): the partner took it up, and the classic SessionStart finds it gone: once', async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await w.clock.advance(GRACE + SETTLE)
  expect(w.prompts).toEqual([PROMPT])
  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  await w.clock.advance(60_000)
  expect(w.prompts).toEqual([PROMPT])
  expect(w.releases).toHaveLength(1)
})

test('a /clear in an unguarded process whose state Claude Code empties after its SessionStart: the word that classic hooks run here is written again, so a reload reads it', async ($, on) => {
  const w = engine(on, { restarts: {} })
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'startup', session_id: ID })
  await $.classic.SessionStart({ source: 'clear', session_id: OTHER })
  // Claude Code's wipe lands a moment after the SessionStart.
  w.state.clear()
  await w.clock.advance(5000)
  expect(w.state.get('self-restart/classic')).toBe(true)
  expect(w.state.get('self-restart/started')).toBe(OTHER)
})

test('a reload after that /clear: the load reads that classic hooks run here, so no partner acts, and a restart waiting for the conversation is the classic hook’s, never sent by this load', async ($, on) => {
  const w = engine(on, { state: { 'self-restart/classic': true, 'self-restart/started': ID } })
  // The reload's session.start: no classic SessionStart follows a reload.
  await $.session.start(start)
  await w.clock.advance(60_000)
  expect(w.prompts).toEqual([])
  expect(w.releases).toEqual([])
  expect(w.store.get('restarts')).toEqual({ [ID]: RESTART })
})

test('guarded, a reload in the process that kept the record: its start was taken up already, so it never takes its own restart for one that arrived', async ($, on) => {
  const w = engine(on, { state: { 'self-restart/started': ID } })
  await $.session.start(start)
  await w.clock.advance(60_000)
  expect(w.prompts).toEqual([])
  expect(w.store.get('restarts')).toEqual({ [ID]: RESTART })
})

test('guarded, an in-process /resume to the conversation a restart waits for: session.end, then the id read as that one, takes it up once', async ($, on) => {
  const w = engine(on, { id: OTHER })
  await $.session.start(start)
  await w.clock.advance(GRACE + SETTLE)
  // OTHER's start: no restart waits for it.
  expect(w.prompts).toEqual([])
  await $.session.end({ reason: 'resume', sessionId: OTHER, resume: { id: OTHER } })
  // The id lags the move: nothing yet.
  await w.clock.advance(3000)
  expect(w.prompts).toEqual([])
  w.world.id = ID
  await w.clock.advance(1000 + SETTLE)
  expect(w.prompts).toEqual([PROMPT])
  expect(w.state.get('self-restart/started')).toBe(ID)
  await w.clock.advance(120_000)
  expect(w.prompts).toEqual([PROMPT])
})

test('guarded, a restart asked while a /clear is moving the session and the id still reads the conversation it ended: refused, saying why', async ($, on) => {
  const w = engine(on, { restarts: {} })
  await $.session.start(start)
  await w.clock.advance(GRACE)
  await $.session.end({ reason: 'clear', sessionId: ID, resume: { id: ID } })
  const asked = await $.tool.call({ tool: TOOL, reason: 'Switched accounts.' })
  expect(asked.deny).toContain('a /clear or a /resume has just ended that conversation')
  expect(w.store.get('restarts')).toEqual({})
})

test('unguarded, a /clear: session.end leaves the move to the classic SessionStart, which comes before the id moves', async ($, on) => {
  const w = engine(on, { restarts: {} })
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'startup', session_id: ID })
  await $.session.end({ reason: 'clear', sessionId: ID, resume: { id: ID } })
  await $.classic.SessionStart({ source: 'clear', session_id: OTHER })
  w.world.id = OTHER
  await w.clock.advance(5000)
  // No move was looked for, so nothing took the start of OTHER up but the classic SessionStart.
  expect(w.state.get('self-restart/started')).toBe(OTHER)
  expect(w.prompts).toEqual([])
})
