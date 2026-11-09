// After a login change: the reconnect and the resume (hooks/relogin.ts), and the Remote Control lock
// (hooks/rc-lock.ts), against a simulated machine. Nothing here touches a real login or a real
// file: the login file, the config file and the lock file are answers of the test's own hooks, and
// a "switch" is the test changing what they answer.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { CLAIM_SCRIPT } from '../hooks/claim-script'
import { RELEASE_SCRIPT, TAKE_SCRIPT } from '../hooks/rc-lock'
import { CHROME_LOOK_MS, fingerprintOf, isCutOff, jitterOf, RC_WAIT_MS, resumedSaid, RESUME, RUN_WAIT_MS } from '../hooks/relogin'

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
/** Turn ids, made up, in the shape Claude Code gives one. */
const T1 = '00000000-0000-4000-8000-0000000000a1'
const T2 = '00000000-0000-4000-8000-0000000000a2'
const T3 = '00000000-0000-4000-8000-0000000000a3'
/** The resume claim of the stop turn T1 ended on. */
const CLAIM_FILE = `${LOCAL}\\claude-self-tools\\resumed\\${SESSION}.${T1}.json`
/** Claude in Chrome's tools, and the coordinator plugin's, as $.tool.list names them. */
const CHROME_TOOL = { name: 'mcp__claude-in-chrome__navigate', description: 'Opens a page.', mcp: true }
const COORDINATOR_TOOL = { name: 'mcp__coordinator__ask_owner', description: 'Posts a question.', mcp: true }

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
  /** Whether Claude in Chrome's tools, and the coordinator's, are listed at the start. */
  chrome?: boolean
  coordinator?: boolean
  /** What /mcp reconnect does: answers, is refused, or answers only after RUN_WAIT_MS. */
  mcp?: 'answers' | 'refused' | 'slow'
  /** Why the engine drops a prompt a plugin submits; left out, it enters. */
  drops?: string
  /** How long the claim script takes to answer. */
  claimTakesMs?: number
  /** A submit that answers only after this long (then with `drops`, if given), or one that throws. */
  submitTakesMs?: number
  submitThrows?: boolean
  /** No %LOCALAPPDATA% and no %SystemRoot%: the claim and the lock are the session's own. */
  offWindows?: boolean
  /** The plugin's state, answered by the test: seeded before the start; a set with ifVersion on `conflictOn` loses. */
  state?: Map<string, { value: unknown; version: number }>
  conflictOn?: string
}

/**
 * The machine beneath the plugin: a login file (stat only: the test's fs.read refuses it), a config
 * file holding the account record, the lock file (created and deleted by the PowerShell calls the
 * test answers), and the session's Remote Control. `switchTo` swaps the login and the record, as
 * the account-switch tool does; Remote Control then stops `stopsAfterMs` later, as Claude Code's
 * own owner check does. `refresh` rewrites the login alone, as a token refresh does.
 */
function machine(on: On, { description = CONNECTED, remoteControl = 'false', stopsAfterMs = 12_000, record, runTakesMs = 0, chrome = false, coordinator = false, mcp = 'answers', drops, claimTakesMs = 0, submitTakesMs = 0, submitThrows = false, offWindows = false, state, conflictOn }: Options = {}) {
  if (state !== undefined) {
    on('state.get', (_, e) => ({ value: state.get(`${e.plugin}/${e.key}`) ?? { value: undefined, version: 0 } }))
    on('state.set', (_, e) => {
      const key = `${e.plugin}/${e.key}`
      const held = state.get(key) ?? { value: undefined, version: 0 }
      // Another writer got there first.
      if (e.key === conflictOn && e.ifVersion !== undefined) return { value: { isSet: false, version: held.version + 1 } }
      if (e.ifVersion !== undefined && e.ifVersion !== held.version) return { value: { isSet: false, version: held.version } }
      const next = { value: JSON.parse(JSON.stringify(e.value ?? null)), version: held.version + 1 }
      state.set(key, next)
      return { value: { isSet: true, version: next.version } }
    })
  }
  /** The session's tools, as the test changes them: Claude in Chrome's, the coordinator's, or a list that fails. */
  const tools = { chrome, coordinator, fails: false, looks: 0 }
  on('tool.list', () => {
    tools.looks += 1
    if (tools.fails) return { deny: 'the tool list is being rebuilt' }
    return { value: [...(tools.chrome ? [CHROME_TOOL] : []), ...(tools.coordinator ? [COORDINATOR_TOOL] : [])] }
  })
  const clock = mock.clock(on, { now: 100 * HOUR })
  mock.env(on, offWindows ? { USERPROFILE: HOME } : { USERPROFILE: HOME, LOCALAPPDATA: LOCAL, SystemRoot: 'C:\\Windows' })
  const commands: string[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  const reads: string[] = []
  /** What happened when, for the timing tests. */
  const at: { what: string; at: number }[] = []
  /** The lock files the PowerShell calls made, by path. */
  const files = new Map<string, { text: string; mtimeMs: number }>()
  const lockOps: string[] = []
  /** The resume claims asked for, by path; who wins the race to one, when another does; and a claim that fails. */
  const claims: string[] = []
  let claimRace: string | undefined
  let claimFails = false
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
  on('prompt.submit', async (_, e) => {
    if (submitThrows) throw new Error('the session is closing')
    if (submitTakesMs > 0) await clock.sleep(submitTakesMs)
    if (drops !== undefined) return { drop: drops }
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
    if (e.command === 'mcp' && mcp === 'refused') throw new Error('mcp: no such server')
    if (e.command === 'mcp' && mcp === 'slow') await clock.sleep(RUN_WAIT_MS + 5000)
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
  on('process.run', async (_, e) => {
    const script = e.init?.stdin ?? ''
    const op = script === TAKE_SCRIPT ? 'take' : script === RELEASE_SCRIPT ? 'release' : script === CLAIM_SCRIPT ? 'claim' : undefined
    if (op === undefined || !/powershell\.exe$/i.test(e.argv[0] ?? '')) return { deny: 'not a canonical lock script' }
    scriptCalls.push({ stdin: script, env: { ...(e.init?.env ?? {}) } })
    if (op === 'claim') {
      // CLAIM, as it behaves: the file made exclusively, or there already (who claimed it, and when).
      const path = e.init?.env?.RESUME_CLAIM_PATH ?? ''
      const mine = e.init?.env?.RESUME_CLAIM_TEXT ?? ''
      claims.push(path)
      if (claimTakesMs > 0) await clock.sleep(claimTakesMs)
      const ok = (stdout: string) => ({ value: { exitCode: 0, stdout: `${stdout}\r\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
      if (claimFails) return ok('error|the claim folder could not be made')
      // Another claimant that gets there first, at the same moment (the coordinator's auto-resume).
      if (claimRace !== undefined && !files.has(path)) files.set(path, { text: JSON.stringify({ v: 1, by: claimRace, at: clock.now() }), mtimeMs: clock.now() })
      const there = files.get(path)
      if (there === undefined) {
        files.set(path, { text: mine, mtimeMs: clock.now() })
        return ok('claimed')
      }
      const doc = JSON.parse(there.text) as { by: string; at: number }
      return ok(`taken|${doc.by}|${doc.at}`)
    }
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
    tools,
    claims,
    /** Another claimant (the coordinator's auto-resume, or the owner's Resume) claims the next stop first. */
    raceClaim(by: string) {
      claimRace = by
    },
    /** The claim script answers that no claim could be made. */
    failClaim() {
      claimFails = true
    },
    /** The coordinator's own claim of a stop, as its CLAIM run would: true when it wins and so resumes. */
    coordinatorClaims(path: string): boolean {
      if (files.has(path)) return false
      files.set(path, { text: JSON.stringify({ v: 1, by: 'coordinator', at: clock.now() }), mtimeMs: clock.now() })
      return true
    },
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

/** A session titled TITLE, watched long enough for a baseline; its SessionStart names it as the engine does, by its id. */
async function begin($: Engine, w: World) {
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'startup', session_id: SESSION, session_title: TITLE })
  await w.clock.advance(6000)
}

/** The main conversation's turn cut off by `error` (the usage limit unless said). */
async function cutOff($: Engine, w: World, turnId = T1, error: 'rate_limit' | 'authentication_failed' | 'invalid_request' | 'unknown' = 'rate_limit') {
  await $.turn.start({ text: 'go on', turnId })
  await $.classic.StopFailure({ error })
  await $.turn.complete({ ...failed, turnId })
  await w.clock.advance(5000)
}

/** The toasts, a resume's error kind and how long ago put aside: a test's clock makes that up. The words themselves have a test of their own. */
const noAgo = (toasts: readonly string[]): string[] => toasts.map(said => said.replace(/ended on \w+ \d+ (?:s|min|h) ago/, 'ended on KIND AGO ago'))

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
  expect(noAgo(w.toasts)).toEqual([`Login changed; Remote Control reconnected as "${TITLE}"; resumed: the turn ended on KIND AGO ago.`])

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
  await $.turn.start({ text: 'go on', turnId: T1 })
  await $.turn.complete({ ...answered, turnId: T1 })
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
  expect(noAgo(w.toasts)).toEqual([`Login changed; Remote Control was off, and is left off; resumed: the turn ended on KIND AGO ago.`])
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
  await $.turn.start({ text: 'go on', turnId: T1 })

  w.switchTo('account-b')
  await w.clock.advance(60_000)
  // Nothing runs while the turn does, the reconnect included.
  expect(w.commands).toEqual([])
  expect(w.toasts).toEqual([])
  await $.classic.StopFailure({ error: 'authentication_failed' })
  await $.turn.complete({ ...failed, turnId: T1 })
  await w.clock.advance(FLOW)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  expect(w.prompts).toEqual([RESUME])
  expect(noAgo(w.toasts)).toEqual([`Login changed; Remote Control reconnected as "${TITLE}"; resumed: the turn ended on KIND AGO ago.`])
})

test('a turn running at the change that finishes with an answer is not resumed', async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await $.turn.start({ text: 'go on', turnId: T1 })

  w.switchTo('account-b')
  await w.clock.advance(20_000)
  await $.turn.complete({ ...answered, turnId: T1 })
  await w.clock.advance(FLOW)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  expect(w.prompts).toEqual([])
})

test('a turn the person started after the limit means nothing is cut off any more', async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await cutOff($, w)
  await $.turn.start({ text: 'try again', turnId: T2 })
  await $.turn.complete({ ...answered, turnId: T2 })

  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([])
})

test('errors a new login does not clear are not resumed: an invalid request, an unknown kind, or none given', async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await cutOff($, w, T1, 'invalid_request')
  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([])

  await cutOff($, w, T2, 'unknown')
  w.switchTo('account-c')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([])

  await $.turn.start({ text: 'go on', turnId: T3 })
  await $.turn.complete({ ...failed, turnId: T3 })
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
  await $.turn.start({ text: 'go on', turnId: T1 })
  await $.turn.complete({ ...answered, turnId: T1 })
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
  await $.turn.start({ text: RESUME, turnId: T2 })
  // Typed during the resumed turn, so queued behind it; then the turn hits the limit at once.
  await $.prompt.submit({ text: 'and then this', wait: false, origin: { kind: 'composer' } })
  await $.classic.StopFailure({ error: 'rate_limit' })
  await $.turn.complete({ ...failed, durationMs: 2000, turnId: T2 })
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
  await $.turn.start({ text: '', turnId: T2 })
  await $.classic.StopFailure({ error: 'rate_limit' })
  await $.turn.complete({ ...failed, durationMs: 2000, turnId: T2 })
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
  await $.turn.start({ text: `The self-remote-control plugin sent a message: ${RESUME}`, turnId: T2 })
  await $.classic.StopFailure({ error: 'rate_limit' })
  await $.turn.complete({ ...failed, durationMs: 2000, turnId: T2 })
  await w.clock.advance(5000)

  w.switchTo('account-c')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([RESUME])
  expect(w.toasts.at(-1)).toMatch(/no resume: the last one ended on an error at once, so it waits for you to type\.$/)

  // A person types; that turn hits the limit too; the next switch resumes again.
  await $.prompt.submit({ text: 'keep going', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'keep going', turnId: T3 })
  await $.classic.StopFailure({ error: 'rate_limit' })
  await $.turn.complete({ ...failed, durationMs: 90_000, usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }, turnId: T3 })
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
  await $.turn.start({ text: RESUME, turnId: T2 })
  await $.classic.StopFailure({ error: 'rate_limit' })
  await $.turn.complete({ ...failed, durationMs: 10 * 60_000, usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }, turnId: T2 })
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
  expect(noAgo(w.toasts)).toEqual([`Login changed; Remote Control still reads connected, so nothing ran; resumed: the turn ended on KIND AGO ago.`])
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
  await $.turn.complete({ ...answered, turnId: T1 })
  await w.clock.advance(5000)
  expect(w.commands).toEqual([])
  expect(w.toasts.some(t => t.includes("agent-coordinator holds this session's Remote Control lock"))).toBe(true)
  expect(w.files.has(LOCK)).toBe(true)
})

test('a queued connect takes the lock, and gives it back once connected', async ($, on) => {
  const w = machine(on, { description: NOT_CONNECTED })
  await begin($, w)

  await $.tool.call({ tool: 'mcp__self-remote-control__remote_control', action: 'connect' })
  await $.turn.complete({ ...answered, turnId: T1 })
  await w.clock.advance(5000)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  expect(w.lockOps).toEqual(['take', 'release'])
  expect(w.files.has(LOCK)).toBe(false)
})

test("a release never deletes another's lock: one taken over meanwhile is kept", async ($, on) => {
  const w = machine(on, { description: NOT_CONNECTED, runTakesMs: 100_000 })
  await begin($, w)

  await $.tool.call({ tool: 'mcp__self-remote-control__remote_control', action: 'connect' })
  await $.turn.complete({ ...answered, turnId: T1 })
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
  expect(noAgo(w.toasts)).toEqual([`Login changed; Remote Control left as it was (reconnectOnLoginChange is off); resumed: the turn ended on KIND AGO ago.`])
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

test('a resume says which error its turn ended on, and how long ago, in the toast and the debug line', async ($, on) => {
  expect(resumedSaid('rate_limit', 12_000)).toBe('resumed: the turn ended on rate_limit 12 s ago')
  expect(resumedSaid('authentication_failed', 5 * 60_000)).toBe('resumed: the turn ended on authentication_failed 5 min ago')
  expect(resumedSaid('overloaded', 3 * 3_600_000)).toBe('resumed: the turn ended on overloaded 3 h ago')
  const w = machine(on)
  const debug: string[] = []
  on('ui.log', (_, e) => {
    debug.push(String(e.text))
    return { value: undefined }
  })
  await begin($, w)
  await cutOff($, w)
  w.switchTo('account-b')
  await w.clock.advance(SETTLE + DELAY + 15_000)
  expect(w.prompts).toEqual([RESUME])
  expect(w.toasts[0]).toMatch(/resumed: the turn ended on rate_limit \d+ (?:s|min) ago\.$/)
  expect(debug.some(line => /self-remote-control: resumed: the turn ended on rate_limit \d+ (?:s|min) ago/.test(line))).toBe(true)
})

/** Long enough for a change with Claude in Chrome: its three looks for the coordinator, then the resume. */
const CHROME_FLOW = FLOW + CHROME_LOOK_MS[1] + 5000
const CHROME_RAN = "Claude in Chrome: /mcp reconnect ran, so its tab group starts over (Claude Code's own line says whether it reconnected)"

test('in a session with Claude in Chrome and no coordinator, a login change reconnects it after Remote Control, after three looks for the coordinator, and before the resume', async ($, on) => {
  const w = machine(on, { chrome: true })
  await begin($, w)
  await cutOff($, w)
  const looked = w.tools.looks
  w.switchTo('account-b')
  await w.clock.advance(CHROME_FLOW)
  // Three looks for the coordinator's tools, the last CHROME_LOOK_MS[1] after the first: then the reconnect.
  expect(w.tools.looks - looked).toBe(3)
  expect(w.commands).toEqual([`remote-control ${TITLE}`, 'mcp reconnect claude-in-chrome'])
  const when = (what: string) => w.at.find(e => e.what === what)?.at ?? 0
  expect(when('mcp') - when('remote-control')).toBeGreaterThanOrEqual(CHROME_LOOK_MS[1])
  expect(w.prompts).toEqual([RESUME])
  // In order: Remote Control, Claude in Chrome, then the resume.
  expect(w.at.map(e => e.what)).toEqual(['remote-control', 'mcp', 'prompt'])
  expect(noAgo(w.toasts)).toEqual([`Login changed; Remote Control reconnected as "${TITLE}"; ${CHROME_RAN}; resumed: the turn ended on KIND AGO ago.`])
})

test('in a session the coordinator runs in, Claude in Chrome is left to the coordinator: no reconnect, and the toast says so, with the command if it doesn\'t', async ($, on) => {
  const w = machine(on, { chrome: true, coordinator: true })
  await begin($, w)
  await cutOff($, w)
  w.switchTo('account-b')
  await w.clock.advance(CHROME_FLOW)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  expect(w.prompts).toEqual([RESUME])
  expect(noAgo(w.toasts)).toEqual([`Login changed; Remote Control reconnected as "${TITLE}"; Claude in Chrome left to the coordinator (run /mcp reconnect claude-in-chrome if it doesn't reconnect); resumed: the turn ended on KIND AGO ago.`])
})

test("the coordinator's tools missing at the first look but listed at a later one (a reload): no reconnect", async ($, on) => {
  const w = machine(on, { chrome: true })
  await begin($, w)
  await cutOff($, w)
  const looked = w.tools.looks
  w.switchTo('account-b')
  // Until the first look for the coordinator's tools, which finds none.
  for (let i = 0; i < 180 && w.tools.looks === looked; i += 1) await w.clock.advance(1000)
  expect(w.tools.looks).toBe(looked + 1)
  // The coordinator comes back between the first look and the second.
  w.tools.coordinator = true
  await w.clock.advance(CHROME_FLOW)
  expect(w.tools.looks).toBe(looked + 2)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  expect(w.prompts).toEqual([RESUME])
})

test("the coordinator's tools listed before, and missing at all three looks: Claude in Chrome is left alone, and the toast says why", async ($, on) => {
  const w = machine(on, { chrome: true, coordinator: true })
  await begin($, w)
  // A turn's end notes the servers: the coordinator's is there.
  await $.turn.start({ text: 'go on', turnId: T3 })
  await $.turn.complete({ ...answered, turnId: T3 })
  await w.clock.advance(1000)
  w.tools.coordinator = false
  await cutOff($, w)
  w.switchTo('account-b')
  await w.clock.advance(CHROME_FLOW)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  expect(w.prompts).toEqual([RESUME])
  expect(noAgo(w.toasts)[0]).toContain("Claude in Chrome left as it was: the coordinator's tools were here before and aren't now, and the coordinator may reconnect it (run /mcp reconnect claude-in-chrome if it doesn't)")
})

test('a tool list that fails: Claude in Chrome is left alone, said in the toast; the resume still goes', async ($, on) => {
  const w = machine(on, { chrome: true })
  await begin($, w)
  await cutOff($, w)
  w.tools.fails = true
  w.switchTo('account-b')
  await w.clock.advance(CHROME_FLOW)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  expect(w.prompts).toEqual([RESUME])
  expect(noAgo(w.toasts)[0]).toContain("Claude in Chrome left as it was: this session's tools can't be listed (run /mcp reconnect claude-in-chrome if it needs it)")
})

test("Claude in Chrome listed before but not at the change (its server dropped with the account): still reconnected", async ($, on) => {
  const w = machine(on, { chrome: true })
  await begin($, w)
  await $.turn.start({ text: 'go on', turnId: T3 })
  await $.turn.complete({ ...answered, turnId: T3 })
  await w.clock.advance(1000)
  w.tools.chrome = false
  await cutOff($, w)
  w.switchTo('account-b')
  await w.clock.advance(CHROME_FLOW)
  expect(w.commands).toEqual([`remote-control ${TITLE}`, 'mcp reconnect claude-in-chrome'])
})

test('/mcp reconnect refused: the toast says to run it by hand', async ($, on) => {
  const w = machine(on, { chrome: true, mcp: 'refused' })
  await begin($, w)
  await cutOff($, w)
  w.switchTo('account-b')
  await w.clock.advance(CHROME_FLOW)
  expect(w.prompts).toEqual([RESUME])
  expect(noAgo(w.toasts)[0]).toContain("Claude in Chrome didn't reconnect: run /mcp reconnect claude-in-chrome")
})

test('/mcp reconnect still queued after RUN_WAIT_MS: said to be queued, never failed', async ($, on) => {
  const w = machine(on, { chrome: true, mcp: 'slow' })
  await begin($, w)
  await cutOff($, w)
  w.switchTo('account-b')
  await w.clock.advance(CHROME_FLOW + RUN_WAIT_MS)
  expect(w.prompts).toEqual([RESUME])
  const said = noAgo(w.toasts)[0] ?? ''
  expect(said).toContain("Claude in Chrome: /mcp reconnect hadn't finished within 15 s (queued or still running; its tab group starts over when it runs)")
  expect(said).not.toContain("didn't reconnect")
})

test('a second change folded into the first reconnects Claude in Chrome again', async ($, on) => {
  const w = machine(on, { chrome: true })
  await begin($, w)
  await cutOff($, w)
  w.switchTo('account-b')
  const reconnects = () => w.commands.filter(c => c.startsWith('mcp')).length
  for (let i = 0; i < 180 && reconnects() === 0; i += 1) await w.clock.advance(1000)
  expect(reconnects()).toBe(1)
  // A turn the person starts holds the rest of the change back, and another switch comes meanwhile: folded in.
  await $.turn.start({ text: 'one more thing', turnId: T2 })
  w.switchTo('account-c')
  await w.clock.advance(20_000)
  await $.turn.complete({ ...answered, turnId: T2 })
  await w.clock.advance(CHROME_FLOW)
  expect(reconnects()).toBe(2)
  expect(w.toasts).toHaveLength(1)
})

test('a login change with no turn cut off still reconnects Claude in Chrome, and sends no resume', async ($, on) => {
  const w = machine(on, { chrome: true })
  await begin($, w)
  await $.turn.start({ text: 'go on', turnId: T1 })
  await $.turn.complete({ ...answered, turnId: T1 })
  await w.clock.advance(5000)
  w.switchTo('account-b')
  await w.clock.advance(CHROME_FLOW)
  expect(w.commands).toEqual([`remote-control ${TITLE}`, 'mcp reconnect claude-in-chrome'])
  expect(w.prompts).toEqual([])
  expect(w.toasts).toEqual([`Login changed; Remote Control reconnected as "${TITLE}"; ${CHROME_RAN}; no turn was cut off.`])
})

test('the resume claim: taken right before the resume, under the stop\'s session and turn ids', async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await cutOff($, w)
  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([RESUME])
  expect(w.claims).toEqual([CLAIM_FILE])
  expect(JSON.parse(w.files.get(CLAIM_FILE)?.text ?? '{}')).toMatchObject({ v: 1, by: 'self-remote-control' })
})

test('the resume claim, both at once: the coordinator claims the same stop first, so this sends nothing and says who resumed', async ($, on) => {
  const w = machine(on)
  const debug: string[] = []
  on('ui.log', (_, e) => {
    debug.push(String(e.text))
    return { value: undefined }
  })
  await begin($, w)
  await cutOff($, w)
  w.raceClaim('coordinator')
  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  // Exactly one resume: the coordinator's (it won the claim), none from here.
  expect(w.prompts).toEqual([])
  expect(w.toasts[0]).toMatch(/no resume: the coordinator's auto-resume claimed the resume of the interrupted turn \d+ s ago\.$/)
  expect(debug.some(line => line.startsWith("self-remote-control: no resume: the coordinator's auto-resume claimed the resume"))).toBe(true)
})

test("the owner's Resume on the coordinator's page claimed the stop: no resume from here, and the toast says so", async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await cutOff($, w)
  w.raceClaim('coordinator:owner')
  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([])
  expect(w.toasts[0]).toMatch(/no resume: the owner \(from the coordinator's page\) claimed the resume of the interrupted turn \d+ s ago\.$/)
})

test('a claim that fails sends nothing: one resume or none, never two', async ($, on) => {
  const w = machine(on)
  await begin($, w)
  await cutOff($, w)
  w.failClaim()
  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([])
  expect(w.toasts[0]).toContain("no resume: the resume claim couldn't be taken (the claim folder could not be made)")
})

test('a resume the engine drops gives its claim back, so a later resume of that stop can claim it', async ($, on) => {
  const w = machine(on, { drops: "plugins' input is held" })
  await begin($, w)
  await cutOff($, w)
  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.claims).toEqual([CLAIM_FILE])
  expect(w.files.has(CLAIM_FILE)).toBe(false)
  expect(w.coordinatorClaims(CLAIM_FILE)).toBe(true)
})

test('reconnectChromeOnLoginChange off: Claude in Chrome is left as it was', { options: { reconnectChromeOnLoginChange: false } }, async ($, on) => {
  const w = machine(on, { chrome: true })
  await begin($, w)
  await cutOff($, w)
  w.switchTo('account-b')
  await w.clock.advance(SETTLE + DELAY + 15_000)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  expect(w.prompts).toEqual([RESUME])
})

test('a turn that starts while the resume is being claimed: the claim is given back, and nothing is sent', async ($, on) => {
  const w = machine(on, { claimTakesMs: 5000 })
  await begin($, w)
  await cutOff($, w)
  w.switchTo('account-b')
  for (let i = 0; i < 240 && w.claims.length === 0; i += 1) await w.clock.advance(1000)
  expect(w.claims).toEqual([CLAIM_FILE])
  // The person types while the claim script runs.
  await $.turn.start({ text: 'one more thing', turnId: T2 })
  await w.clock.advance(10_000)
  expect(w.prompts).toEqual([])
  expect(w.files.has(CLAIM_FILE)).toBe(false)
  expect(w.toasts[0]).toContain('no resume: a turn started while the resume was being claimed')
})

test('a submit still waiting after SUBMIT_WAIT_MS, then dropped: said as a resume, queued, and the claim is given back when the drop comes', async ($, on) => {
  const w = machine(on, { submitTakesMs: 45_000, drops: "plugins' input is held" })
  await begin($, w)
  await cutOff($, w)
  w.switchTo('account-b')
  for (let i = 0; i < 300 && w.toasts.length === 0; i += 1) await w.clock.advance(1000)
  expect(noAgo(w.toasts)[0]).toMatch(/; resumed: the turn ended on KIND AGO ago \(queued, to run once the session is idle\)\.$/)
  expect(w.files.has(CLAIM_FILE)).toBe(true)
  await w.clock.advance(30_000)
  expect(w.files.has(CLAIM_FILE)).toBe(false)
})

test('a submit that throws gives the claim back', async ($, on) => {
  const w = machine(on, { submitThrows: true })
  await begin($, w)
  await cutOff($, w)
  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([])
  expect(w.claims).toEqual([CLAIM_FILE])
  expect(w.files.has(CLAIM_FILE)).toBe(false)
  // The kit hands a hook's throw back as no answer at all: the submit is refused either way.
  expect(w.toasts[0]).toMatch(/; resume not sent: .+\.$/)
})

test('off Windows the claim is the session\'s own: the resume goes once, and no claim script runs', async ($, on) => {
  const w = machine(on, { offWindows: true })
  await begin($, w)
  await cutOff($, w)
  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([RESUME])
  expect(w.claims).toEqual([])
  expect(w.scriptCalls).toEqual([])
})

test("Claude in Chrome's reconnect has Remote Control's cap: a flapping login reconnects it at most three times in ten minutes, and the toast says why not", async ($, on) => {
  const w = machine(on, { chrome: true })
  await begin($, w)
  for (const account of ['account-b', 'account-c', 'account-d', 'account-e']) {
    w.switchTo(account)
    await w.clock.advance(CHROME_FLOW)
  }
  expect(w.commands.filter(c => c.startsWith('mcp'))).toHaveLength(3)
  expect(w.toasts.at(-1)).toContain("Claude in Chrome not reconnected: it already reconnected 3 times in 10 minutes, so it waits for the login to settle (run /mcp reconnect claude-in-chrome yourself to reconnect now)")
})

/** The account record's fingerprint for an account the machine names: what the login watch keeps. */
const fingerprint = (account: string) => fingerprintOf({ oauthAccount: { accountUuid: account, organizationUuid: 'org-1' } }) ?? ''

test('a turn that starts and ends on the limit again while the resume is being claimed: another stop, so the old claim is given back and nothing is sent', async ($, on) => {
  const w = machine(on, { claimTakesMs: 5000 })
  await begin($, w)
  await cutOff($, w)
  w.switchTo('account-b')
  for (let i = 0; i < 240 && w.claims.length === 0; i += 1) await w.clock.advance(1000)
  expect(w.claims).toEqual([CLAIM_FILE])
  // The person types, and that turn too ends on the limit, while the claim script runs.
  await $.turn.start({ text: 'one more thing', turnId: T2 })
  await $.classic.StopFailure({ error: 'rate_limit' })
  await $.turn.complete({ ...failed, turnId: T2 })
  await w.clock.advance(10_000)
  expect(w.prompts).toEqual([])
  expect(w.files.has(CLAIM_FILE)).toBe(false)
  expect(w.toasts[0]).toContain('no resume: a turn started while the resume was being claimed')
})

test("a flapping login in a session the coordinator runs in: one toast while the cap holds, though Claude in Chrome's part is never empty", async ($, on) => {
  // Remote Control for all sessions: each change after the cap is capped again, not left off.
  const w = machine(on, { chrome: true, coordinator: true, remoteControl: 'true' })
  await begin($, w)
  for (const account of ['account-b', 'account-c', 'account-d', 'account-e', 'account-f']) {
    w.switchTo(account)
    await w.clock.advance(FLOW)
  }
  // Three reconnects, then the cap's one toast, then nothing for the fifth.
  expect(w.commands.filter(c => c.startsWith('remote-control'))).toHaveLength(3)
  expect(w.toasts).toHaveLength(4)
  expect(w.toasts[3]).toContain('it already reconnected 3 times in 10 minutes')
})

test('after a burst the cap held back, the last login is reconnected once the oldest run leaves the window', async ($, on) => {
  const w = machine(on, { chrome: true })
  await begin($, w)
  for (const account of ['account-b', 'account-c', 'account-d', 'account-e']) {
    w.switchTo(account)
    await w.clock.advance(CHROME_FLOW)
  }
  expect(w.commands.filter(c => c.startsWith('remote-control'))).toHaveLength(3)
  expect(w.commands.filter(c => c.startsWith('mcp'))).toHaveLength(3)
  // The window passes: Remote Control and Claude in Chrome, once each, for account-e.
  await w.clock.advance(10 * 60_000)
  expect(w.commands.filter(c => c.startsWith('remote-control'))).toHaveLength(4)
  expect(w.commands.filter(c => c.startsWith('mcp'))).toHaveLength(4)
  expect(w.toasts.at(-1)).toBe(`Login settled after the reconnect cap; Remote Control reconnected as "${TITLE}"; ${CHROME_RAN}.`)
  // Once: nothing more after another window.
  await w.clock.advance(15 * 60_000)
  expect(w.commands.filter(c => c.startsWith('remote-control'))).toHaveLength(4)
})

test('a reconnect started before this plugin reloaded is not run again, and the toast says so', async ($, on) => {
  const now = 100 * HOUR
  const state = new Map<string, { value: unknown; version: number }>()
  state.set('self-remote-control/login', {
    version: 1,
    value: { account: fingerprint('account-a'), pending: { at: now - 30_000, wasConnected: false, settingOn: false, rc: 'was-off', idleAt: now - 20_000, chromeRanAt: now - 5000 } },
  })
  const w = machine(on, { chrome: true, state })
  await begin($, w)
  await w.clock.advance(10_000)
  expect(w.commands.filter(c => c.startsWith('mcp'))).toEqual([])
  expect(w.toasts).toEqual([
    "Login changed; Remote Control was off, and is left off; Claude in Chrome: /mcp reconnect was started before this plugin reloaded, so it isn't run again (its tab group starts over if it ran); no turn was cut off.",
  ])
})

test("off Windows, another writer that takes the session's own claim first: this one sends nothing", async ($, on) => {
  const w = machine(on, { offWindows: true, state: new Map(), conflictOn: 'resumeClaims' })
  await begin($, w)
  await cutOff($, w)
  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([])
  expect(w.toasts[0]).toContain('no resume: another run of this plugin claimed the resume of the interrupted turn')
})

/** The reconnect cap's line, in Remote Control's part of a toast. */
const RC_CAPPED = 'Remote Control not reconnected: it already reconnected 3 times in 10 minutes'
const CHROME_CAPPED = 'Claude in Chrome not reconnected: it already reconnected 3 times in 10 minutes'
const runsOf = (w: World, command: string) => w.commands.filter(c => c.startsWith(command)).length

test("a burst of five with the setting for all sessions off, the coordinator's session: Remote Control the cap left down stays owed, and reconnects once the window passes", async ($, on) => {
  const w = machine(on, { chrome: true, coordinator: true })
  await begin($, w)
  for (const account of ['account-b', 'account-c', 'account-d', 'account-e', 'account-f']) {
    w.switchTo(account)
    await w.clock.advance(SETTLE + 10_000)
  }
  // Three reconnects; the fourth change is capped and leaves it down; the fifth reads it down, and still counts it owed.
  expect(runsOf(w, 'remote-control')).toBe(3)
  expect(w.rc.description).toBe(NOT_CONNECTED)
  expect(w.toasts.filter(t => t.includes(RC_CAPPED))).toHaveLength(1)
  expect(w.toasts.some(t => t.includes('Remote Control was off, and is left off'))).toBe(false)
  expect(w.toasts).toHaveLength(4)
  await w.clock.advance(10 * 60_000)
  expect(runsOf(w, 'remote-control')).toBe(4)
  expect(w.rc.description).toBe(CONNECTED)
  expect(w.toasts.at(-1)).toBe(`Login settled after the reconnect cap; Remote Control reconnected as "${TITLE}".`)
  // Owed no more: nothing after another window.
  await w.clock.advance(15 * 60_000)
  expect(runsOf(w, 'remote-control')).toBe(4)
  expect(w.toasts).toHaveLength(5)
})

test("a login that flaps back to the last reconnect's account: Claude Code stopped Remote Control at the switch away, so it is still reconnected once the window passes", async ($, on) => {
  const w = machine(on, { remoteControl: 'true' })
  await begin($, w)
  // account-d is the last reconnect's; account-e is capped and stops it; back to account-d, capped too.
  for (const account of ['account-b', 'account-c', 'account-d', 'account-e', 'account-d']) {
    w.switchTo(account)
    await w.clock.advance(SETTLE + 10_000)
  }
  expect(runsOf(w, 'remote-control')).toBe(3)
  expect(w.rc.description).toBe(NOT_CONNECTED)
  await w.clock.advance(10 * 60_000)
  expect(runsOf(w, 'remote-control')).toBe(4)
  expect(w.rc.description).toBe(CONNECTED)
  expect(w.toasts.at(-1)).toBe(`Login settled after the reconnect cap; Remote Control reconnected as "${TITLE}".`)
})

test('signed out when the window passes: no retry runs; signing in again is a change that counts Remote Control as owed', async ($, on) => {
  const w = machine(on)
  await begin($, w)
  for (const account of ['account-b', 'account-c', 'account-d', 'account-e']) {
    w.switchTo(account)
    await w.clock.advance(SETTLE + 10_000)
  }
  expect(runsOf(w, 'remote-control')).toBe(3)
  expect(w.toasts).toHaveLength(4)
  w.switchTo(null)
  await w.clock.advance(10 * 60_000)
  expect(runsOf(w, 'remote-control')).toBe(3)
  expect(w.toasts).toHaveLength(4)
  // The setting for all sessions is off and Remote Control reads down: only the debt says to reconnect it.
  w.switchTo('account-f')
  await w.clock.advance(SETTLE + 10_000)
  expect(runsOf(w, 'remote-control')).toBe(4)
  expect(w.rc.description).toBe(CONNECTED)
  expect(w.toasts.at(-1)).toBe(`Login changed; Remote Control reconnected as "${TITLE}"; no turn was cut off.`)
})

test("a real change folded into a retry reads the setting itself: with Remote Control for all sessions on, it reconnects, though the retry wasn't owed it", async ($, on) => {
  const now = 100 * HOUR
  const state = new Map<string, { value: unknown; version: number }>()
  // A retry owed only Claude in Chrome's reconnect: its Remote Control placeholders are "was off" and "setting off".
  state.set('self-remote-control/login', { version: 1, value: { account: fingerprint('account-a'), owedAt: now - 1000, chromeAccount: fingerprint('account-z') } })
  const w = machine(on, { chrome: true, remoteControl: 'true', description: NOT_CONNECTED, state })
  await begin($, w)
  // The retry is looking for the coordinator's tools when another account comes: the change folds the retry in.
  w.switchTo('account-b')
  await w.clock.advance(CHROME_FLOW)
  expect(w.commands).toContain(`remote-control ${TITLE}`)
  expect(w.rc.description).toBe(CONNECTED)
  expect(w.toasts.at(-1)).toBe(`Login changed; Remote Control reconnected as "${TITLE}"; ${CHROME_RAN}; no turn was cut off.`)
})

test("Claude in Chrome's cap is told once while it holds, though Remote Control isn't capped (it was off)", async ($, on) => {
  const w = machine(on, { chrome: true, description: NOT_CONNECTED })
  await begin($, w)
  for (const account of ['account-b', 'account-c', 'account-d', 'account-e', 'account-f']) {
    w.switchTo(account)
    await w.clock.advance(SETTLE + CHROME_LOOK_MS[1] + 10_000)
  }
  expect(runsOf(w, 'mcp')).toBe(3)
  expect(w.toasts.filter(t => t.includes(CHROME_CAPPED))).toHaveLength(1)
  // Three reconnects, the cap's one toast, then nothing new for the fifth.
  expect(w.toasts).toHaveLength(4)
})

test("Claude in Chrome left as it was (its tools can't be listed) is no news while Remote Control's cap holds", async ($, on) => {
  const w = machine(on, { chrome: true, remoteControl: 'true' })
  await begin($, w)
  w.tools.fails = true
  for (const account of ['account-b', 'account-c', 'account-d', 'account-e', 'account-f']) {
    w.switchTo(account)
    await w.clock.advance(SETTLE + 10_000)
  }
  expect(runsOf(w, 'remote-control')).toBe(3)
  expect(w.toasts.filter(t => t.includes(RC_CAPPED))).toHaveLength(1)
  expect(w.toasts).toHaveLength(4)
})

test('after a retry settles, a cap within the next minutes is told again', async ($, on) => {
  const now = 100 * HOUR
  const state = new Map<string, { value: unknown; version: number }>()
  // A cap told a minute ago left Remote Control owed; two runs are still in the window, and the retry is due.
  state.set('self-remote-control/login', {
    version: 1,
    value: { account: fingerprint('account-a'), runs: [now - 100_000, now - 90_000], cappedAt: now - 60_000, rcOwed: true, owedAt: now - 1000 },
  })
  const w = machine(on, { description: NOT_CONNECTED, state })
  await begin($, w)
  await w.clock.advance(SETTLE)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
  expect(w.toasts).toEqual([`Login settled after the reconnect cap; Remote Control reconnected as "${TITLE}".`])
  // Three runs in the window now: the next change is capped, and that cap is new.
  w.switchTo('account-b')
  await w.clock.advance(SETTLE + 10_000)
  expect(runsOf(w, 'remote-control')).toBe(1)
  expect(w.toasts).toHaveLength(2)
  expect(w.toasts[1]).toContain(RC_CAPPED)
})

// Claude Code empties a plugin's `$.state` at an in-process /clear or /resume, and no session.start follows
// (claude-code-self-tools#24). The login record and the servers seen are the machine's and the session's, so
// they outlive it in the module's mirrors; the resume claim is keyed by the conversation the stop was recorded
// in (#23). `wipe` empties the state as Claude Code does.

/** The conversation a /resume brings this process back to, while `$.session.id()` still answers SESSION. */
const A = '00000000-0000-4000-8000-00000000000a'
const LOGIN_KEY = 'self-remote-control/login'
const SERVERS_KEY = 'self-remote-control/servers'

test('a /resume empties $.state and no session.start follows: the login record goes back at its SessionStart, so the next login change reconnects', async ($, on) => {
  const state = new Map<string, { value: unknown; version: number }>()
  const w = machine(on, { state })
  await begin($, w)
  expect(state.get(LOGIN_KEY)?.value).toMatchObject({ account: fingerprint('account-a') })

  state.clear()
  await $.classic.SessionStart({ source: 'resume', session_id: SESSION, session_title: TITLE })
  // Back before the watch's next look.
  expect(state.get(LOGIN_KEY)?.value).toMatchObject({ account: fingerprint('account-a') })

  w.switchTo('account-b')
  await w.clock.advance(SETTLE)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
})

test("a wipe that lands after a /clear's SessionStart: the next look finds the login record empty, writes the mirror back, and the change is still seen", async ($, on) => {
  const state = new Map<string, { value: unknown; version: number }>()
  const w = machine(on, { state })
  await begin($, w)
  await $.classic.SessionStart({ source: 'clear', session_id: SESSION, session_title: TITLE })
  state.clear()

  // Without the record, the new account would be taken as the baseline, and nothing would reconnect. (Bare: the
  // title went with the wipe, and comes back with the next prompt or SessionStart that carries it.)
  w.switchTo('account-b')
  await w.clock.advance(SETTLE)
  expect(w.commands).toEqual(['remote-control'])
  expect(state.get(LOGIN_KEY)?.value).toMatchObject({ account: fingerprint('account-b') })
})

test('a change being handled when the wipe comes is not dropped: Remote Control still reconnects', async ($, on) => {
  const state = new Map<string, { value: unknown; version: number }>()
  const w = machine(on, { state })
  await begin($, w)
  w.switchTo('account-b')
  // Confirmed, and waiting for the old link to stop.
  await w.clock.advance(10_000)
  expect((state.get(LOGIN_KEY)?.value as { pending?: unknown } | undefined)?.pending).toBeDefined()
  state.clear()
  await w.clock.advance(SETTLE)
  // Bare: the title went with the wipe.
  expect(w.commands).toEqual(['remote-control'])
})

test('the servers seen outlive a wipe: Claude in Chrome, listed before it and dropped with the account, is still reconnected', async ($, on) => {
  const state = new Map<string, { value: unknown; version: number }>()
  const w = machine(on, { state, chrome: true })
  await begin($, w)
  await $.turn.start({ text: 'go on', turnId: T3 })
  await $.turn.complete({ ...answered, turnId: T3 })
  await w.clock.advance(1000)
  expect(state.get(SERVERS_KEY)?.value).toEqual({ chrome: true })

  state.clear()
  await $.classic.SessionStart({ source: 'resume', session_id: SESSION, session_title: TITLE })
  expect(state.get(SERVERS_KEY)?.value).toEqual({ chrome: true })
  // And once more after it: the read that finds it empty puts it back.
  state.clear()
  w.tools.chrome = false
  await cutOff($, w)
  w.switchTo('account-b')
  await w.clock.advance(CHROME_FLOW)
  // Remote Control bare: the title went with the second wipe.
  expect(w.commands).toEqual(['remote-control', 'mcp reconnect claude-in-chrome'])
})

test("the resume claim right after a move back to another conversation, while $.session.id() still names the one left: keyed by the stop's own conversation", async ($, on) => {
  const w = machine(on)
  await begin($, w)
  // A /resume back to A: its SessionStart names A; `$.session.id()` still answers SESSION, the one left.
  await $.classic.SessionStart({ source: 'resume', session_id: A, session_title: TITLE })
  // The stop comes within the id's lag, and the claim after it; `$.session.id()` answers SESSION throughout.
  await cutOff($, w)
  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([RESUME])
  expect(w.claims).toEqual([`${LOCAL}\\claude-self-tools\\resumed\\${A}.${T1}.json`])
})

test('a stop recorded with no conversation (a turn written before this version) claims nothing and resumes nothing, saying why', async ($, on) => {
  const now = 100 * HOUR
  const state = new Map<string, { value: unknown; version: number }>()
  const w = machine(on, { state })
  await begin($, w)
  state.set('self-remote-control/turn', { version: 9, value: { running: false, at: now + 5000, outcome: 'error', error: 'rate_limit', turnId: T1 } })
  w.switchTo('account-b')
  await w.clock.advance(FLOW)
  expect(w.prompts).toEqual([])
  expect(w.claims).toEqual([])
  expect(w.toasts[0]).toContain("no resume: the conversation the interrupted turn ran in isn't known, so the resume can't be claimed")
})

test("a stale login record a /resume brings back doesn't replace the mirror: the change from the account this session saw is still seen", async ($, on) => {
  const state = new Map<string, { value: unknown; version: number }>()
  const w = machine(on, { state })
  await begin($, w)
  expect(state.get(LOGIN_KEY)?.value).toMatchObject({ account: fingerprint('account-a') })
  // What $.state held for the conversation resumed, from before: the account the login is about to switch to.
  state.set(LOGIN_KEY, { value: { account: fingerprint('account-b') }, version: 99 })
  await $.classic.SessionStart({ source: 'resume', session_id: SESSION, session_title: TITLE })
  expect(state.get(LOGIN_KEY)?.value).toMatchObject({ account: fingerprint('account-a') })

  // Taken as the baseline, the stale record would make the switch to account-b no change at all.
  w.switchTo('account-b')
  await w.clock.advance(SETTLE)
  expect(w.commands).toEqual([`remote-control ${TITLE}`])
})

test('a SessionStart that finds the login record and the servers seen as the mirrors have them writes nothing; emptied, it writes them back', async ($, on) => {
  const state = new Map<string, { value: unknown; version: number }>()
  const w = machine(on, { state, chrome: true })
  await begin($, w)
  const login = state.get(LOGIN_KEY)?.version
  const servers = state.get(SERVERS_KEY)?.version
  expect(login).toBeDefined()
  expect(servers).toBeDefined()
  await $.classic.SessionStart({ source: 'resume', session_id: SESSION, session_title: TITLE })
  expect(state.get(LOGIN_KEY)?.version).toBe(login)
  expect(state.get(SERVERS_KEY)?.version).toBe(servers)
  state.clear()
  await $.classic.SessionStart({ source: 'clear', session_id: SESSION, session_title: TITLE })
  expect(state.get(LOGIN_KEY)?.value).toMatchObject({ account: fingerprint('account-a') })
  expect(state.get(SERVERS_KEY)?.value).toEqual({ chrome: true })
  void w
})
