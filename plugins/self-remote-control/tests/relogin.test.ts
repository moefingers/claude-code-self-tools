// After a login change: the reconnect and the resume (hooks/relogin.ts), and the Remote Control lock
// (hooks/rc-lock.ts), against a simulated machine. Nothing here touches a real login or a real
// file: the login file, the config file and the lock file are answers of the test's own hooks, and
// a "switch" is the test changing what they answer.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { RELEASE_SCRIPT, TAKE_SCRIPT } from '../hooks/rc-lock'
import { fingerprintOf, isCutOff, jitterOf, RC_WAIT_MS, RESUME } from '../hooks/relogin'

const CONNECTED = 'Disconnect Remote Control'
const NOT_CONNECTED = 'Control this session from your phone or claude.ai/code'
const HOME = 'C:\\Users\\tester'
const LOCAL = `${HOME}\\AppData\\Local`
const LOGIN = `${HOME}\\.claude\\.credentials.json`
const CLAIM = `${HOME}\\.claude.json`
/** An obviously made-up session id, in the shape Claude Code gives one. */
const SESSION = '00000000-0000-4000-8000-000000000002'
const LOCK = `${LOCAL}\\claude-self-tools\\rc\\${SESSION}.lock`
const TITLE = 'auth-refactor'
/** This session's own delay before a resume. */
const DELAY = jitterOf(SESSION)
const HOUR = 60 * 60_000

type Options = {
  /** What the remote-control command's description reads at the start; null: no such command. */
  description?: string | null
  /** The /config setting for all sessions. */
  remoteControl?: string
  /** How long after the account record changes Remote Control stops, as another session's does; null: never. */
  stopsAfterMs?: number | null
  /** What the account record holds instead of an account (a renamed field). */
  record?: Record<string, unknown>
  /** How long /remote-control takes to answer. */
  runTakesMs?: number
}

/**
 * The machine beneath the plugin: a login file (stat only: the test's fs.read refuses it), a config
 * file holding the account record, the lock file (created and deleted by the PowerShell calls the
 * test answers), and the session's Remote Control. `switchTo` swaps the login and the record, as
 * the account-switch tool does; Remote Control then stops `stopsAfterMs` later, as Claude Code's
 * own owner check does. `refresh` rewrites the login alone, as a token refresh does.
 */
function machine(on: On, { description = CONNECTED, remoteControl = 'false', stopsAfterMs = 12_000, record, runTakesMs = 0 }: Options = {}) {
  const clock = mock.clock(on, { now: 100 * HOUR })
  mock.env(on, { USERPROFILE: HOME, LOCALAPPDATA: LOCAL, SystemRoot: 'C:\\Windows' })
  const commands: string[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  const reads: string[] = []
  /** What happened when, for the timing tests. */
  const at: { what: string; at: number }[] = []
  /** The lock files the PowerShell calls made, by path. */
  const files = new Map<string, { text: string; mtimeMs: number }>()
  const lockOps: string[] = []
  /** Each lock script's call: what ran, and the environment it was given. */
  const scriptCalls: { stdin: string; env: Record<string, string> }[] = []
  /** The link: what the command reads, its title, and the account it was made under (the owner check stops it when that isn't the current one). */
  const rc: { description: string | null; title?: string; account: string | null } = { description, account: 'account-a' }
  /** What the lock file held at each run of /remote-control. */
  const lockAtRun: string[] = []
  const disk = { size: 400, mtimeMs: 1, account: 'account-a' as string | null, claimMtimeMs: 1 }
  /** How often the conversation's messages were listed: never, by this feature. */
  const listed = { count: 0 }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SESSION }))
  on('session.messages', () => {
    listed.count += 1
    return { value: [] }
  })
  on('tool.register', () => ({ value: { tool: 'mcp__self-remote-control__remote_control' } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    at.push({ what: 'prompt', at: clock.now() })
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.StopFailure', () => ({}))
  on('config.list', () => ({
    value: [
      {
        key: 'remoteControl',
        label: 'Remote Control for all sessions',
        kind: 'choice',
        value: remoteControl,
        options: ['true', 'false', 'default'],
        provider: { plugin: 'engine', tier: 'core' },
        isLocked: false,
      },
    ],
  }))
  on('command.list', () => ({
    value: rc.description === null ? [] : [{ name: 'remote-control', description: rc.description, source: 'builtin' as const }],
  }))
  on('command.run', async (_, e, next) => {
    if (e.command === 'login') return next(e)
    commands.push(e.args === '' ? e.command : `${e.command} ${e.args}`)
    at.push({ what: e.command, at: clock.now() })
    if (e.command === 'remote-control') lockAtRun.push(files.get(LOCK)?.text ?? 'none')
    // A slow command: it connects only once it answers.
    if (e.command === 'remote-control' && runTakesMs > 0) await clock.sleep(runTakesMs)
    if (e.command === 'remote-control' && rc.description === NOT_CONNECTED) {
      rc.description = CONNECTED
      rc.title = e.args === '' ? undefined : e.args
      rc.account = disk.account
    }
    return { text: '' }
  })
  // The canonical scripts, as they behave: TAKE creates, or overwrites a stale lock in place (over
  // 90 s old or 90 s ahead, by its `at` else its time), never deleting; RELEASE deletes only its own text.
  on('process.run', (_, e) => {
    const script = e.init?.stdin ?? ''
    const op = script === TAKE_SCRIPT ? 'take' : script === RELEASE_SCRIPT ? 'release' : undefined
    if (op === undefined || !/powershell\.exe$/i.test(e.argv[0] ?? '')) return { deny: 'not a canonical lock script' }
    scriptCalls.push({ stdin: script, env: { ...(e.init?.env ?? {}) } })
    const path = e.init?.env?.RC_LOCK_PATH ?? ''
    const text = e.init?.env?.RC_LOCK_TEXT ?? ''
    lockOps.push(op)
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout: `${stdout}\r\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const there = files.get(path)
    if (op === 'release') {
      if (there === undefined) return out('gone')
      if (there.text !== text) return out('kept')
      files.delete(path)
      return out('released')
    }
    if (there === undefined) {
      files.set(path, { text, mtimeMs: clock.now() })
      return out('taken')
    }
    let at = there.mtimeMs
    let by = 'unknown'
    try {
      const doc = JSON.parse(there.text) as { at?: unknown; by?: unknown }
      if (typeof doc.at === 'number') at = doc.at
      if (typeof doc.by === 'string') by = doc.by
    } catch {
      // Unreadable: its time decides.
    }
    const age = clock.now() - at
    if (age > 90_000 || age < -90_000) {
      files.set(path, { text, mtimeMs: clock.now() })
      return out('taken')
    }
    return out(`held|${by}|${Math.round(age)}`)
  })
  on('fs.stat', (_, e) => {
    if (e.path === LOGIN) return { value: { kind: 'file' as const, size: disk.size, mtimeMs: disk.mtimeMs, isLink: false } }
    if (e.path === CLAIM) return { value: { kind: 'file' as const, size: 2000, mtimeMs: disk.claimMtimeMs, isLink: false } }
    const file = files.get(e.path)
    if (file !== undefined) return { value: { kind: 'file' as const, size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
    return { deny: `ENOENT: ${e.path}` }
  })
  on('fs.read', (_, e) => {
    reads.push(e.path)
    const file = files.get(e.path)
    if (file !== undefined) return { value: file.text }
    if (e.path !== CLAIM) return { deny: `not readable here: ${e.path}` }
    const held = disk.account === null ? {} : { oauthAccount: record ?? { accountUuid: disk.account, organizationUuid: 'org-1', emailAddress: 'someone@example.invalid' } }
    return { value: JSON.stringify({ numStartups: 7, ...held }) }
  })
  return {
    clock,
    commands,
    prompts,
    toasts,
    reads,
    at,
    files,
    lockOps,
    scriptCalls,
    lockAtRun,
    listed,
    rc,
    disk,
    /** Swaps the login and the account record; Remote Control stops `stopsAfterMs` later if connected. */
    switchTo(account: string | null) {
      disk.size += 7
      disk.mtimeMs += 1000
      disk.account = account
      disk.claimMtimeMs += 1000
      if (stopsAfterMs !== null)
        void clock.sleep(stopsAfterMs).then(() => {
          if (rc.description === CONNECTED && rc.account !== disk.account) rc.description = NOT_CONNECTED
        })
    },
    /** A token refresh: the login file is rewritten, the account is the same. */
    refresh() {
      disk.mtimeMs += 1000
    },
    /** Another plugin's lock, taken `ago` ms before now. */
    lockedBy(by: string, ago = 0) {
      files.set(LOCK, { text: JSON.stringify({ v: 1, by, at: clock.now() - ago }), mtimeMs: clock.now() - ago })
    },
  }
}

type World = ReturnType<typeof machine>

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' } as const
const failed = { answer: '', durationMs: 1, isAborted: false, reason: 'error' } as const
/** Long enough for a change to settle: two looks, the old link's stop, a reading, the run and its check. */
const SETTLE = 45_000
/** Long enough for a change and its resume, after this session's own delay. */
const FLOW = SETTLE + DELAY + 15_000

/** A session titled TITLE, watched long enough for a baseline. */
async function begin($: Engine, w: World) {
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'startup', session_title: TITLE })
  await w.clock.advance(6000)
}

/** The main conversation's turn cut off by `error` (the usage limit unless said). */
async function cutOff($: Engine, w: World, turnId = 't1', error: 'rate_limit' | 'authentication_failed' | 'invalid_request' | 'unknown' = 'rate_limit') {
  await $.turn.start({ text: 'go on', turnId })
  await $.classic.StopFailure({ error })
  await $.turn.complete({ ...failed, turnId })
  await w.clock.advance(5000)
}

/** What was read of the machine's files: the update check's read of the plugin's own manifest, and the lock, left out. */
const machineReads = (w: World) => w.reads.filter(path => path !== LOCK && !/[\\/]\.claude-plugin[\\/]plugin\.json$/.test(path))

test('a switch after the limit: Remote Control reconnects under the title, then, after the session\'s own delay, the cut-off turn resumes once', async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await cutOff($, w)

  w.switchTo('account-b')
  await w.clock.advance(10_000)
  // Remote Control still reads connected (the old link, not stopped yet): nothing runs yet.
  expect(w.commands).toEqual([])
  await w.clock.advance(SETTLE - 10_000)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  expect(w.rc.title).toBe(TITLE)
  expect(w.prompts).toEqual([])
  await w.clock.advance(DELAY + 15_000)
  expect(w.prompts).toEqual([RESUME])
  expect(w.toasts).toEqual([`Login changed; Remote Control reconnected as "${TITLE}"; resumed the interrupted turn.`])

  await w.clock.advance(10 * 60_000)
  expect(w.commands).toHaveLength(1)
  expect(w.prompts).toEqual([RESUME])
  expect(w.toasts).toHaveLength(1)
  // The login file is only ever statted; the config file is read; the lock was given back.
  expect(machineReads(w)).toContain(CLAIM)
  expect(machineReads(w).every(path => path === CLAIM)).toBe(true)
  expect(w.files.has(LOCK)).toBe(false)
})

test("the resume waits for the session's own delay after the reconnect", async ($, on) => {
  expect(DELAY).toBeGreaterThan(10_000)
  const w = machine(on)
  await begin($, w)
  await cutOff($, w)

  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  const ran = w.at.find(e => e.what === 'remote-control')?.at ?? 0
  const sent = w.at.find(e => e.what === 'prompt')?.at ?? 0
  expect(ran).toBeGreaterThan(0)
  expect(sent - ran).toBeGreaterThanOrEqual(DELAY)
  expect(sent - ran).toBeLessThan(DELAY + 20_000)
})

test('a token refresh rewrites the login file, but the account is the same: nothing happens', async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await cutOff($, w)

  w.refresh()
  await w.clock.advance(2 * 60_000)
  expect(w.commands).toEqual([])
  expect(w.prompts).toEqual([])
  expect(w.toasts).toEqual([])
  expect(w.reads).not.toContain(LOGIN)
})

test('another account at one look only is no change', async ($, on) => {
  const w = machine(on, { stopsAfterMs: null })
  await begin($, w)
  await cutOff($, w)

  w.switchTo('account-b')
  await w.clock.advance(5000)
  // Back before the next look: the swap was undone.
  w.switchTo('account-a')
  await w.clock.advance(FLOW)
  expect(w.commands).toEqual([])
  expect(w.prompts).toEqual([])
  expect(w.toasts).toEqual([])
})

test('a session at a finished break gets no resume; its Remote Control still reconnects', async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await $.turn.start({ text: 'go on', turnId: 't1' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await w.clock.advance(5000)

  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  expect(w.prompts).toEqual([])
  expect(w.toasts).toEqual([`Login changed; Remote Control reconnected as "${TITLE}"; no turn was cut off.`])
})

test('Remote Control that was off stays off when the setting for all sessions is off; the cut-off turn still resumes', async ($, on) => {
  const w = machine(on, { description: NOT_CONNECTED })
  await begin($, w)
  await cutOff($, w)

  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.commands).toEqual([])
  expect(w.prompts).toEqual([RESUME])
  expect(w.toasts).toEqual(['Login changed; Remote Control was off, and is left off; resumed the interrupted turn.'])
})

test('Remote Control that was off connects when the setting for all sessions is on', async ($, on) => {
  const w = machine(on, { description: NOT_CONNECTED, remoteControl: 'true' })
  await begin($, w)

  w.switchTo('account-b')
  await w.clock.advance(SETTLE)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  expect(w.toasts).toEqual([`Login changed; Remote Control reconnected as "${TITLE}"; no turn was cut off.`])
})

test('a session with no title reconnects bare', async ($, on) => {
  const w = machine(on)
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'startup' })
  await w.clock.advance(6000)

  w.switchTo('account-b')
  await w.clock.advance(SETTLE)
  expect(w.commands).toEqual(['remote-control'])
  expect(w.toasts).toEqual(['Login changed; Remote Control reconnected; no turn was cut off.'])
})

test('a turn running at the change is waited for, and resumed when the change cut it off', async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await $.turn.start({ text: 'go on', turnId: 't1' })

  w.switchTo('account-b')
  await w.clock.advance(60_000)
  // Nothing runs while the turn does, the reconnect included.
  expect(w.commands).toEqual([])
  expect(w.toasts).toEqual([])
  await $.classic.StopFailure({ error: 'authentication_failed' })
  await $.turn.complete({ ...failed, turnId: 't1' })
  await w.clock.advance(FLOW)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  expect(w.prompts).toEqual([RESUME])
  expect(w.toasts).toEqual([`Login changed; Remote Control reconnected as "${TITLE}"; resumed the interrupted turn.`])
})

test('a turn running at the change that finishes with an answer is not resumed', async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await $.turn.start({ text: 'go on', turnId: 't1' })

  w.switchTo('account-b')
  await w.clock.advance(20_000)
  await $.turn.complete({ ...answered, turnId: 't1' })
  await w.clock.advance(FLOW)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  expect(w.prompts).toEqual([])
})

test('a turn the person started after the limit means nothing is cut off any more', async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await cutOff($, w)
  await $.turn.start({ text: 'try again', turnId: 't2' })
  await $.turn.complete({ ...answered, turnId: 't2' })

  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([])
})

test('errors a new login does not clear are not resumed: an invalid request, an unknown kind, or none given', async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await cutOff($, w, 't1', 'invalid_request')
  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([])

  await cutOff($, w, 't2', 'unknown')
  w.switchTo('account-c')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([])

  await $.turn.start({ text: 'go on', turnId: 't3' })
  await $.turn.complete({ ...failed, turnId: 't3' })
  w.switchTo('account-d')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([])
  expect(w.toasts.every(t => t.endsWith('no turn was cut off.'))).toBe(true)
})

test('a turn cut off more than six hours ago is not resumed', async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await cutOff($, w)
  await w.clock.advance(7 * HOUR)

  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  expect(w.prompts).toEqual([])
})

test("a subagent's failed turn is not the session's", async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await $.turn.start({ text: 'go on', turnId: 't1' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await $.turn.start({ text: 'sub', turnId: 'a-t1', agentId: 'a1' })
  await $.classic.StopFailure({ error: 'rate_limit', agent_id: 'a1' })
  await $.turn.complete({ ...failed, turnId: 'a-t1', agentId: 'a1' })
  await w.clock.advance(5000)

  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([])
})

test('a /clear forgets the cut-off turn: the new conversation is not resumed', async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await cutOff($, w)
  await $.classic.SessionStart({ source: 'clear', session_title: TITLE })

  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([])
})

test("the conversation's messages are never listed: a limit hit and a switch cost no copy of them", async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await cutOff($, w)

  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([RESUME])
  expect(w.listed.count).toBe(0)
})

test('a prompt the person queues while the resumed turn runs counts, though that turn then ends at once', async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await cutOff($, w)

  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([RESUME])
  await $.turn.start({ text: RESUME, turnId: 't2' })
  // Typed during the resumed turn, so queued behind it; then the turn hits the limit at once.
  await $.prompt.submit({ text: 'and then this', wait: false, origin: { kind: 'composer' } })
  await $.classic.StopFailure({ error: 'rate_limit' })
  await $.turn.complete({ ...failed, durationMs: 2000, turnId: 't2' })
  await w.clock.advance(5000)

  w.switchTo('account-c')
  await w.clock.advance(FLOW)
  expect(w.prompts.filter(t => t === RESUME)).toHaveLength(2)
})

test("a continuation turn (no text) after the resume was sent is not the resume's own", async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await cutOff($, w)

  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([RESUME])
  // A continuation starts first and dies at once: it must not block the next resume.
  await $.turn.start({ text: '', turnId: 't2' })
  await $.classic.StopFailure({ error: 'rate_limit' })
  await $.turn.complete({ ...failed, durationMs: 2000, turnId: 't2' })
  await w.clock.advance(5000)

  w.switchTo('account-c')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([RESUME, RESUME])
})

test('a resume whose turn ends on an error at once is not followed by another until a person types', async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await cutOff($, w)

  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([RESUME])
  // The resume's turn hits the limit again at once: no usage, two seconds.
  await $.turn.start({ text: `The self-remote-control plugin sent a message: ${RESUME}`, turnId: 't2' })
  await $.classic.StopFailure({ error: 'rate_limit' })
  await $.turn.complete({ ...failed, durationMs: 2000, turnId: 't2' })
  await w.clock.advance(5000)

  w.switchTo('account-c')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([RESUME])
  expect(w.toasts.at(-1)).toMatch(/no resume: the last one ended on an error at once, so it waits for you to type\.$/)

  // A person types; that turn hits the limit too; the next switch resumes again.
  await $.prompt.submit({ text: 'keep going', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'keep going', turnId: 't3' })
  await $.classic.StopFailure({ error: 'rate_limit' })
  await $.turn.complete({ ...failed, durationMs: 90_000, usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }, turnId: 't3' })
  await w.clock.advance(5000)
  w.switchTo('account-d')
  await w.clock.advance(FLOW)
  expect(w.prompts.filter(t => t === RESUME)).toHaveLength(2)
})

test('a resume whose turn did real work before the limit stays resumable', async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await cutOff($, w)

  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  await $.turn.start({ text: RESUME, turnId: 't2' })
  await $.classic.StopFailure({ error: 'rate_limit' })
  await $.turn.complete({ ...failed, durationMs: 10 * 60_000, usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }, turnId: 't2' })
  await w.clock.advance(5000)

  w.switchTo('account-c')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([RESUME, RESUME])
})

test('Remote Control that reads connected all along is never run over; the resume follows the wait', async ($, on) => {
  const w = machine(on, { stopsAfterMs: null })
  await begin($, w)
  await cutOff($, w)

  w.switchTo('account-b')
  await w.clock.advance(RC_WAIT_MS)
  expect(w.prompts).toEqual([])
  await w.clock.advance(RC_WAIT_MS + DELAY)
  expect(w.commands).toEqual([])
  expect(w.prompts).toEqual([RESUME])
  expect(w.toasts).toEqual(['Login changed; Remote Control still reads connected, so nothing ran; resumed the interrupted turn.'])
})

test('a reading it does not recognise runs nothing', async ($, on) => {
  const w = machine(on, { stopsAfterMs: null })
  await begin($, w)
  w.rc.description = 'Remote Control (beta)'

  w.switchTo('account-b')
  await w.clock.advance(3 * RC_WAIT_MS)
  expect(w.commands).toEqual([])
  expect(w.toasts).toEqual(['Login changed; Remote Control was off, and is left off; no turn was cut off.'])
})

test('a reading that turns unknown after the change runs nothing, and says so', async ($, on) => {
  const w = machine(on, { stopsAfterMs: null })
  await begin($, w)

  w.switchTo('account-b')
  await w.clock.advance(5000)
  w.rc.description = 'Remote Control (beta)'
  await w.clock.advance(3 * RC_WAIT_MS)
  expect(w.commands).toEqual([])
  expect(w.toasts).toEqual([
    'Login changed; Remote Control not reconnected: the remote-control command reads "Remote Control (beta)", which this plugin doesn\'t recognise; no turn was cut off.',
  ])
})

test('two changes in a row reconnect once and resume once', async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await cutOff($, w)

  w.switchTo('account-b')
  await w.clock.advance(11_000)
  w.switchTo('account-c')
  await w.clock.advance(2 * FLOW)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  expect(w.prompts).toEqual([RESUME])
  expect(w.toasts).toHaveLength(1)
})

test('a login that keeps flapping reconnects at most three times in ten minutes, with one toast for the cap', async ($, on) => {
  const w = machine(on, { remoteControl: 'true' })
  await begin($, w)

  for (const account of ['account-b', 'account-a', 'account-b', 'account-a', 'account-b']) {
    w.switchTo(account)
    await w.clock.advance(SETTLE + 10_000)
  }
  expect(w.commands).toHaveLength(3)
  const capped = w.toasts.filter(t => /already reconnected 3 times in 10 minutes/.test(t))
  expect(capped).toHaveLength(1)
  expect(w.toasts).toHaveLength(4)
})

test('a sign-out is no change to act on', async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await cutOff($, w)

  w.switchTo(null)
  await w.clock.advance(FLOW)
  expect(w.commands).toEqual([])
  expect(w.prompts).toEqual([])
  expect(w.toasts).toEqual([])
})

test("an account record the plugin can't use is said once, with nothing from the file, and nothing else happens", async ($, on) => {
  const w = machine(on, { record: { accountId: 'renamed-field', emailAddress: 'someone@example.invalid' } })
  await begin($, w)
  await w.clock.advance(30_000)
  expect(w.toasts).toEqual([
    "self-remote-control can't read the signed-in account from Claude Code's config file, so it can't tell when the login changes: no Remote Control reconnect and no resume after a login change.",
  ])
  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.toasts).toHaveLength(1)
  expect(w.commands).toEqual([])
})

test('the lock: taken while the command runs, with this plugin\'s name, and given back once connected', async ($, on) => {
  const w = machine(on)
  await begin($, w)

  w.switchTo('account-b')
  await w.clock.advance(SETTLE)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  expect(w.lockAtRun).toHaveLength(1)
  expect(JSON.parse(w.lockAtRun[0] ?? '{}')).toEqual({ v: 1, by: 'self-remote-control', at: expect.any(Number) })
  expect(w.files.has(LOCK)).toBe(false)
  expect(w.lockOps).toEqual(['take', 'release'])
})

test('a slow /remote-control keeps the lock until the session reads connected', async ($, on) => {
  const w = machine(on, { runTakesMs: 40_000 })
  await begin($, w)

  w.switchTo('account-b')
  await w.clock.advance(50_000)
  // The command started some 20 seconds ago and hasn't answered: the lock is still held.
  expect(w.lockAtRun).toHaveLength(1)
  expect(w.files.has(LOCK)).toBe(true)
  await w.clock.advance(60_000)
  expect(w.rc.description).toBe(CONNECTED)
  expect(w.files.has(LOCK)).toBe(false)
  expect(w.commands).toHaveLength(1)
  expect(w.toasts).toEqual([`Login changed; Remote Control reconnected as "${TITLE}"; no turn was cut off.`])
})

test("another plugin's fresh lock holds the reconnect back until it is given back", async ($, on) => {
  const w = machine(on)
  await begin($, w)

  w.switchTo('account-b')
  w.lockedBy('agent-coordinator')
  await w.clock.advance(SETTLE)
  expect(w.commands).toEqual([])
  // The coordinator's run gave up without connecting, and gave the lock back.
  w.files.delete(LOCK)
  await w.clock.advance(SETTLE)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  expect(w.toasts).toEqual([`Login changed; Remote Control reconnected as "${TITLE}"; no turn was cut off.`])
})

test('a stale lock (over 90 seconds old) is taken over', async ($, on) => {
  const w = machine(on)
  await begin($, w)

  w.switchTo('account-b')
  w.lockedBy('agent-coordinator', 2 * 60_000)
  await w.clock.advance(SETTLE)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  // Taken over in place: one TAKE, never a delete, then its own RELEASE.
  expect(w.lockOps).toEqual(['take', 'release'])
  expect(w.files.has(LOCK)).toBe(false)
})

test("a lock held past the reconnect's wait: nothing runs, and the toast says who holds it", async ($, on) => {
  const w = machine(on)
  await begin($, w)

  w.switchTo('account-b')
  for (let i = 0; i < 6; i += 1) {
    w.lockedBy('agent-coordinator')
    await w.clock.advance(20_000)
  }
  expect(w.commands).toEqual([])
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(/^Login changed; Remote Control not reconnected: agent-coordinator holds this session's Remote Control lock \(taken \d+ s ago\); no turn was cut off\.$/)
})

test("a queued connect doesn't run while another plugin holds the lock", async ($, on) => {
  const w = machine(on, { description: NOT_CONNECTED })
  await begin($, w)
  w.lockedBy('agent-coordinator')

  await $.tool.call({ tool: 'mcp__self-remote-control__remote_control', action: 'connect' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await w.clock.advance(5000)
  expect(w.commands).toEqual([])
  expect(w.toasts.some(t => t.includes("agent-coordinator holds this session's Remote Control lock"))).toBe(true)
  expect(w.files.has(LOCK)).toBe(true)
})

test('a queued connect takes the lock, and gives it back once connected', async ($, on) => {
  const w = machine(on, { description: NOT_CONNECTED })
  await begin($, w)

  await $.tool.call({ tool: 'mcp__self-remote-control__remote_control', action: 'connect' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await w.clock.advance(5000)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  expect(w.lockOps).toEqual(['take', 'release'])
  expect(w.files.has(LOCK)).toBe(false)
})

test("a release never deletes another's lock: one taken over meanwhile is kept", async ($, on) => {
  const w = machine(on, { description: NOT_CONNECTED, runTakesMs: 100_000 })
  await begin($, w)

  await $.tool.call({ tool: 'mcp__self-remote-control__remote_control', action: 'connect' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await w.clock.advance(1000)
  // The command hangs past the lock's life (90 s); the coordinator takes the stale lock over
  // before this plugin's release runs.
  await w.clock.advance(94_000)
  w.lockedBy('agent-coordinator')
  const theirs = w.files.get(LOCK)?.text
  await w.clock.advance(60_000)
  expect(w.lockOps.filter(op => op === 'release').length).toBeGreaterThan(0)
  expect(w.files.get(LOCK)?.text).toBe(theirs)
})

test('the lock goes through the canonical scripts, byte for byte, with the path and text in the environment', async ($, on) => {
  const w = machine(on)
  const calls = w.scriptCalls
  await begin($, w)

  w.switchTo('account-b')
  await w.clock.advance(SETTLE)
  expect(calls.map(c => c.stdin === TAKE_SCRIPT ? 'take' : c.stdin === RELEASE_SCRIPT ? 'release' : 'other')).toEqual(['take', 'release'])
  expect(calls[0]?.env.RC_LOCK_PATH).toBe(LOCK)
  expect(JSON.parse(calls[0]?.env.RC_LOCK_TEXT ?? '{}')).toEqual({ v: 1, by: 'self-remote-control', at: expect.any(Number) })
  expect(calls[1]?.env.RC_LOCK_TEXT).toBe(calls[0]?.env.RC_LOCK_TEXT)
})

test('a /login in this session holds the reconnect until its dialog closes', async ($, on) => {
  // Remote Control stops 12 seconds into the dialog (the owner check), and the dialog's close turns
  // it off again: a reconnect made in between would be lost.
  const w = machine(on)
  on('command.run', { command: 'login' }, async () => {
    // The login is stored while the dialog is open; closing it turns Remote Control off.
    w.switchTo('account-b')
    await w.clock.sleep(40_000)
    w.rc.description = NOT_CONNECTED
    return { text: 'Login successful. Remote Control disconnected.' }
  })
  await begin($, w)
  await cutOff($, w)

  const login = $.command.run({ command: 'login', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await w.clock.advance(35_000)
  expect(w.commands).toEqual([])
  await w.clock.advance(FLOW)
  await login
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  expect(w.rc.description).toBe(CONNECTED)
  expect(w.prompts).toEqual([RESUME])
})

test('a /login whose dialog closes at once still reconnects: Remote Control was read before it ran', async ($, on) => {
  const w = machine(on, { stopsAfterMs: null })
  on('command.run', { command: 'login' }, async () => {
    // Stored and closed within a second: Remote Control is off before the new account is first seen.
    w.switchTo('account-b')
    w.rc.description = NOT_CONNECTED
    await w.clock.sleep(1000)
    return { text: 'Login successful. Remote Control disconnected.' }
  })
  await begin($, w)

  const login = $.command.run({ command: 'login', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await w.clock.advance(SETTLE)
  await login
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  expect(w.rc.description).toBe(CONNECTED)
})

test('reconnectOnLoginChange off: Remote Control is left as it was', { options: { reconnectOnLoginChange: false } }, async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await cutOff($, w)

  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.commands).toEqual([])
  expect(w.prompts).toEqual([RESUME])
  expect(w.toasts).toEqual(['Login changed; Remote Control left as it was (reconnectOnLoginChange is off); resumed the interrupted turn.'])
})

test('resumeAfterLoginChange off: no resume', { options: { resumeAfterLoginChange: false } }, async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await cutOff($, w)

  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  expect(w.prompts).toEqual([])
  expect(w.toasts).toEqual([`Login changed; Remote Control reconnected as "${TITLE}"; no resume (resumeAfterLoginChange is off).`])
})

test('both off: nothing is watched', { options: { reconnectOnLoginChange: false, resumeAfterLoginChange: false } }, async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await cutOff($, w)

  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(machineReads(w)).toEqual([])
  expect(w.commands).toEqual([])
  expect(w.prompts).toEqual([])
  expect(w.toasts).toEqual([])
})

test('the fingerprint: the same ids give the same one, other ids another, no record none, and a record without an id is unusable', async () => {
  const a = fingerprintOf({ oauthAccount: { accountUuid: 'account-a', organizationUuid: 'org-1' } })
  expect(a).toMatch(/^[0-9a-f]{16}$/)
  expect(fingerprintOf({ oauthAccount: { accountUuid: 'account-a', organizationUuid: 'org-1', emailAddress: 'x@example.invalid' } })).toBe(a)
  expect(fingerprintOf({ oauthAccount: { accountUuid: 'account-b', organizationUuid: 'org-1' } })).not.toBe(a)
  expect(fingerprintOf({ oauthAccount: { accountUuid: 'account-a', organizationUuid: 'org-2' } })).not.toBe(a)
  expect(fingerprintOf({ numStartups: 1 })).toBeNull()
  expect(fingerprintOf({ oauthAccount: { accountUuid: '' } })).toBeUndefined()
  expect(fingerprintOf({ oauthAccount: { accountId: 'renamed' } })).toBeUndefined()
  expect(fingerprintOf([])).toBeUndefined()
  expect(fingerprintOf('text')).toBeUndefined()
})

test('a cut-off turn: a clearable error, ended within six hours, nothing since', async () => {
  const now = 100 * HOUR
  expect(isCutOff({ running: false, at: now - HOUR, outcome: 'error', error: 'rate_limit' }, now)).toBe(true)
  expect(isCutOff({ running: false, at: now - 7 * HOUR, outcome: 'error', error: 'rate_limit' }, now)).toBe(false)
  expect(isCutOff({ running: false, at: now, outcome: 'error' }, now)).toBe(false)
  expect(isCutOff({ running: false, at: now, outcome: 'error', error: 'unknown' }, now)).toBe(false)
  expect(isCutOff({ running: false, at: now, outcome: 'error', error: 'max_output_tokens' }, now)).toBe(false)
  expect(isCutOff({ running: false, at: now, outcome: 'answer' }, now)).toBe(false)
  expect(isCutOff({ running: true, at: now }, now)).toBe(false)
  expect(isCutOff(null, now)).toBe(false)
})

test("each session's delay is its own, within a minute", async () => {
  const delays = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', SESSION].map(jitterOf)
  expect(new Set(delays).size).toBe(3)
  expect(delays.every(d => d >= 0 && d <= 60_000)).toBe(true)
})
