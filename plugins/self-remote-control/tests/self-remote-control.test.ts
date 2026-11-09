import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

const TOOL = 'mcp__self-remote-control__remote_control'
const ENGINE = { plugin: 'engine', tier: 'core' } as const
const CONNECTED = 'Disconnect Remote Control'
const NOT_CONNECTED = 'Control this session from your phone or claude.ai/code'

type Options = {
  description?: string | null
  remoteControl?: string
  surfaces?: RenderSurface[]
  /** Commands the engine refuses. */
  refused?: readonly string[]
  /** A remote-control run while not connected doesn't connect. */
  failsToConnect?: boolean
  /** Why the engine drops a prompt a plugin submits; left out, it enters. */
  dropped?: string
}

/**
 * The engine beneath the plugin. Its remote-control command, run while not connected, connects,
 * titled with its argument; run while connected, it changes nothing, as the real one opens its panel
 * in the terminal (the tests hold that the plugin never runs it then). `rc` is what the command list
 * shows for it (`description` null: no such command in this session) and the title the app shows;
 * `local` is the session's own title, which /rename sets.
 */
function engine(on: On, { description = NOT_CONNECTED, remoteControl = 'false', surfaces = ['terminal'], refused = [], failsToConnect, dropped }: Options = {}) {
  const commands: string[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  const described: string[] = []
  /** Everything the plugin handed the engine, as JSON (the person's own prompts aside): where the no-leak test looks. */
  const seen: string[] = []
  /**
   * The person's prompts the test holds at the bottom (`hold`), by text, each entering or dropped when the test says, as
   * Claude Code holds one typed over a running turn until its own turn; and those it drops at once (`block`).
   */
  const plan = new Map<string, 'hold' | { drop: string }>()
  const held = new Map<string, (drop: string | undefined) => void>()
  const rc: { description: string | null; title?: string } = { description }
  const local: { title?: string } = {}
  const clock = mock.clock(on)
  const session = mock.session(on)
  on('state.set', (_, e, next) => (seen.push(JSON.stringify(e)), next(e)))
  on('ui.log', (_, e) => (seen.push(JSON.stringify(e)), { value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => (described.push(String(e.description)), { value: { tool: TOOL } }))
  on('ui.status', (_, e) => (seen.push(JSON.stringify(e)), { value: undefined }))
  on('ui.toast', (_, e) => {
    seen.push(JSON.stringify(e))
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('prompt.submit', async (_, e) => {
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!isPerson) seen.push(JSON.stringify(e))
    const planned = isPerson ? plan.get(e.text) : undefined
    if (planned === 'hold') {
      const drop = await new Promise<string | undefined>(resolve => held.set(e.text, resolve))
      if (drop !== undefined) return { drop }
    } else if (planned !== undefined) return { drop: planned.drop }
    if (!isPerson && dropped !== undefined) return { drop: dropped }
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('session.surfaces', () => ({ value: surfaces }))
  on('config.list', () => ({
    value: [
      {
        key: 'remoteControl',
        label: 'Remote Control for all sessions',
        kind: 'choice',
        value: remoteControl,
        options: ['true', 'false', 'default'],
        provider: ENGINE,
        isLocked: false,
      },
    ],
  }))
  on('command.list', () => ({
    value: [
      { name: 'compact', description: 'Clear conversation history but keep a summary in context', source: 'builtin' },
      ...(rc.description === null ? [] : [{ name: 'remote-control', description: rc.description, source: 'builtin' as const }]),
    ],
  }))
  on('command.run', (_, e, next) => {
    seen.push(JSON.stringify(e))
    commands.push(e.args === '' ? e.command : `${e.command} ${e.args}`)
    if (refused.includes(e.command)) return next(e)
    if (e.command === 'rename') local.title = e.args
    if (e.command === 'remote-control' && rc.description !== CONNECTED && !failsToConnect) {
      rc.description = CONNECTED
      rc.title = e.args === '' ? undefined : e.args
    }
    return { text: '' }
  })
  /** Lets a held prompt enter, or drops it with `why`; the test then awaits its submit, the clock still. */
  const release = (text: string, why?: string) => {
    held.get(text)?.(why)
    held.delete(text)
  }
  return {
    commands,
    prompts,
    toasts,
    described,
    rc,
    local,
    clock,
    session,
    seen,
    hold: (text: string) => void plan.set(text, 'hold'),
    block: (text: string, why: string) => void plan.set(text, { drop: why }),
    enter: (text: string) => release(text),
    drop: (text: string, why: string) => release(text, why),
  }
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' } as const

/** A prompt the person typed at the terminal (or, `bridge`, from the app): over the running turn `over`, else while idle. */
const typed = (text: string, over?: string, kind: 'composer' | 'bridge' = 'composer') => ({ text, wait: false, origin: { kind }, ...(over === undefined ? {} : { turnId: over }) })

const STALE_TOAST = 'Resume not sent: your message came after the Remote Control action was queued, so the model has it as a note.'
const STALE_NOTE = "The person's message came after the Remote Control action was queued, so its resume wasn't sent as a new message. It was: "

test('status reports the connection, the title, the setting for all sessions and the attached clients', async ($, on) => {
  engine(on, { description: CONNECTED, remoteControl: 'false', surfaces: ['terminal'] })
  await $.session.start(start)

  const read = await $.tool.call({ tool: TOOL, action: 'status' })
  expect(read.result).toBe(
    'Remote Control: connected. Session title: not read yet (each prompt carries it). Remote Control for all sessions (/config remoteControl): false. Attached clients: terminal.',
  )
  await $.classic.UserPromptSubmit({ prompt: 'go', session_title: 'auth-refactor' })
  expect((await $.tool.call({ tool: TOOL, action: 'status' })).result).toMatch(/ Session title: "auth-refactor"\. /)
  await $.classic.UserPromptSubmit({ prompt: 'go on' })
  expect((await $.tool.call({ tool: TOOL, action: 'status' })).result).toMatch(/ Session title: none, /)
})

test('status says so when the reading is not one it knows, or there is no command', async ($, on) => {
  const { rc } = engine(on, { description: 'Something new' })
  await $.session.start(start)

  expect((await $.tool.call({ tool: TOOL, action: 'status' })).result).toMatch(/^Remote Control: unknown \(the remote-control command reads "Something new"\)\./)
  rc.description = null
  expect((await $.tool.call({ tool: TOOL, action: 'status' })).result).toMatch(/^Remote Control: unavailable in this session/)
})

test('connect runs the command once the turn ends, when not connected, and says it took', async ($, on) => {
  const { commands, toasts, clock } = engine(on)
  await $.session.start(start)

  const queued = await $.tool.call({ tool: TOOL, action: 'connect' })
  expect(queued.result).toMatch(/^Queued: Remote Control connects once this turn ends \(it reads not connected now\), with no name: /)
  expect(queued.result).toMatch(/ Then the session waits for the next message\.$/)
  expect(commands).toEqual([])

  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(1000)
  expect(commands).toEqual(['remote-control'])
  await clock.advance(3000)
  expect(toasts).toContain('Remote Control connected.')
})

test('connect with a name connects under that name', async ($, on) => {
  const { commands, toasts, rc, clock } = engine(on)
  await $.session.start(start)
  await $.classic.UserPromptSubmit({ prompt: 'go', session_title: 'old title' })

  const queued = await $.tool.call({ tool: TOOL, action: 'connect', name: '  billing export  ' })
  expect(queued.result).toMatch(/^Queued: Remote Control connects once this turn ends \(it reads not connected now\), as "billing export"\. /)
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(5000)
  expect(commands).toEqual(['remote-control billing export'])
  expect(rc.title).toBe('billing export')
  expect(toasts).toContain('Remote Control connected as "billing export".')
})

test('connect without a name takes the session title, as the last prompt carried it', async ($, on) => {
  const { commands, rc, clock } = engine(on)
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'resume', session_title: 'auth-refactor' })

  const queued = await $.tool.call({ tool: TOOL, action: 'connect' })
  expect(queued.result).toMatch(/, as "auth-refactor", the session's title\. /)
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(5000)
  expect(commands).toEqual(['remote-control auth-refactor'])
  expect(rc.title).toBe('auth-refactor')
})

test('a prompt that carries no title clears it, and connect runs bare', async ($, on) => {
  const { commands, rc, clock } = engine(on)
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'startup', session_title: 'old title' })
  await $.classic.UserPromptSubmit({ prompt: 'go' })

  await $.tool.call({ tool: TOOL, action: 'connect' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(5000)
  expect(commands).toEqual(['remote-control'])
  expect(rc.title).toBeUndefined()
})

test("a subagent's prompt doesn't set the session title", async ($, on) => {
  const { commands, clock } = engine(on)
  await $.session.start(start)
  await $.classic.UserPromptSubmit({ prompt: 'go', session_title: 'main title' })
  await $.classic.UserPromptSubmit({ prompt: 'sub', agent_id: 'a1' })

  await $.tool.call({ tool: TOOL, action: 'connect' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(5000)
  expect(commands).toEqual(['remote-control main title'])
})

test('connect never runs the command while connected', async ($, on) => {
  const { commands, rc, clock } = engine(on, { description: CONNECTED })
  await $.session.start(start)

  const already = await $.tool.call({ tool: TOOL, action: 'connect' })
  expect(already.result).toBe('Remote Control is already connected; nothing to do.')
  const named = await $.tool.call({ tool: TOOL, action: 'connect', name: 'billing export' })
  expect(named.result).toBe('Remote Control is already connected; nothing to do. To title it "billing export", call rename.')
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(5000)
  expect(commands).toEqual([])
  expect(rc.description).toBe(CONNECTED)
})

test('connect checks again at the turn end, and runs nothing if it connected meanwhile', async ($, on) => {
  const { commands, toasts, rc, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, action: 'connect' })
  rc.description = CONNECTED
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(5000)
  expect(commands).toEqual([])
  expect(rc.description).toBe(CONNECTED)
  expect(toasts).toContain('Remote Control was already connected; nothing ran.')
})

test('connect refuses a reading it does not recognise, and when there is no command', async ($, on) => {
  const { commands, rc, clock } = engine(on, { description: 'Remote Control (beta)' })
  await $.session.start(start)

  const unknown = await $.tool.call({ tool: TOOL, action: 'connect' })
  expect(unknown.deny).toMatch(/doesn't recognise/)
  rc.description = null
  const missing = await $.tool.call({ tool: TOOL, action: 'connect' })
  expect(missing.deny).toMatch(/no remote-control command/)
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(5000)
  expect(commands).toEqual([])
})

test('a reading that turns unknown by the turn end runs nothing, and the model is told', async ($, on) => {
  const { commands, toasts, rc, clock, session } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, action: 'connect' })
  rc.description = 'Remote Control (beta)'
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(5000)
  expect(commands).toEqual([])
  expect(toasts.some(t => t.startsWith('Remote Control not connected:'))).toBe(true)
  expect(JSON.stringify(session.appended())).toMatch(/connect you queued did not run/)
})

test('an interrupted turn cancels a queued connect', async ($, on) => {
  const { commands, toasts, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, action: 'connect' })
  await $.turn.complete({ ...answered, turnId: 't1', isAborted: true, reason: 'aborted' })
  await clock.advance(5000)
  expect(commands).toEqual([])
  expect(toasts.some(t => /cancelled/.test(t))).toBe(true)
})

test('a refused command is told to the person and to the model', async ($, on) => {
  const { toasts, clock, session } = engine(on, { refused: ['remote-control'] })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, action: 'connect' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(5000)
  expect(toasts.some(t => t.startsWith("Remote Control didn't connect:"))).toBe(true)
  expect(JSON.stringify(session.appended())).toMatch(/connect you queued didn't run/)
})

test('a subagent is refused', async ($, on) => {
  const { commands, clock } = engine(on)
  await $.session.start(start)

  expect((await $.tool.call({ tool: TOOL, action: 'status', agentId: 'a1' })).deny).toMatch(/subagent/)
  expect((await $.tool.call({ tool: TOOL, action: 'connect', agentId: 'a1' })).deny).toMatch(/subagent/)
  expect((await $.tool.call({ tool: TOOL, action: 'rename', name: 'billing export', agentId: 'a1' })).deny).toMatch(/subagent/)
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(5000)
  expect(commands).toEqual([])
})

test('rename while connected runs /rename only, and says the app may need a reconnect', async ($, on) => {
  const { commands, toasts, rc, local, clock } = engine(on, { description: CONNECTED })
  await $.session.start(start)

  const queued = await $.tool.call({ tool: TOOL, action: 'rename', name: 'billing export' })
  expect(queued.result).toMatch(/^Queued: once this turn ends, the session's local title is set to "billing export" \(\/rename\); Remote Control isn't touched\. /)
  expect(queued.result).toMatch(/if it doesn't, the session needs reconnecting, or renaming in the app\./)
  expect(commands).toEqual([])
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(20000)
  expect(commands).toEqual(['rename billing export'])
  expect(local.title).toBe('billing export')
  expect(rc.description).toBe(CONNECTED)
  expect(toasts).toContain('Session renamed "billing export".')
})

test('rename while not connected only renames, and does not connect', async ($, on) => {
  const { commands, toasts, rc, local, clock } = engine(on)
  await $.session.start(start)

  const queued = await $.tool.call({ tool: TOOL, action: 'rename', name: 'billing export' })
  expect(queued.result).toMatch(/Remote Control isn't connected; connect takes this title when it connects\./)
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(20000)
  expect(commands).toEqual(['rename billing export'])
  expect(local.title).toBe('billing export')
  expect(rc.description).toBe(NOT_CONNECTED)
  expect(toasts).toContain('Session renamed "billing export".')
})

test('rename and connect in one turn rename, then connect under the new name', async ($, on) => {
  const { commands, rc, toasts, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, action: 'rename', name: 'billing export' })
  const connect = await $.tool.call({ tool: TOOL, action: 'connect' })
  expect(connect.result).toMatch(/, as "billing export", after the session is renamed to it\. /)
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(20000)
  expect(commands).toEqual(['rename billing export', 'remote-control billing export'])
  expect(rc.title).toBe('billing export')
  expect(toasts).toContain('Session renamed "billing export". Remote Control connected as "billing export".')
})

test('a refused rename runs nothing else, and is told to the person and the model', async ($, on) => {
  const { commands, toasts, rc, clock, session } = engine(on, { refused: ['rename'] })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, action: 'rename', name: 'billing export' })
  await $.tool.call({ tool: TOOL, action: 'connect' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(20000)
  expect(commands).toEqual(['rename billing export'])
  expect(rc.description).toBe(NOT_CONNECTED)
  expect(toasts.some(t => t.startsWith('Session not renamed:'))).toBe(true)
  expect(JSON.stringify(session.appended())).toMatch(/rename to \\"billing export\\" you queued didn't run: .*Nothing else ran, the Remote Control connect included\./)
})

test('rename needs a name on one line, within what /rename keeps', async ($, on) => {
  const { commands, clock } = engine(on, { description: CONNECTED })
  await $.session.start(start)

  expect((await $.tool.call({ tool: TOOL, action: 'rename' })).deny).toMatch(/`rename` needs `name`/)
  expect((await $.tool.call({ tool: TOOL, action: 'rename', name: '   ' })).deny).toMatch(/`rename` needs `name`/)
  expect((await $.tool.call({ tool: TOOL, action: 'rename', name: 'two\nlines' })).deny).toMatch(/one line/)
  expect((await $.tool.call({ tool: TOOL, action: 'rename', name: 'x'.repeat(201) })).deny).toMatch(/at most 200 characters/)
  expect((await $.tool.call({ tool: TOOL, action: 'connect', name: 'two\nlines' })).deny).toMatch(/one line/)
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(20000)
  expect(commands).toEqual([])
})

test('an interrupted turn cancels a queued rename', async ($, on) => {
  const { commands, toasts, clock } = engine(on, { description: CONNECTED })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, action: 'rename', name: 'billing export' })
  await $.turn.complete({ ...answered, turnId: 't1', isAborted: true, reason: 'aborted' })
  await clock.advance(20000)
  expect(commands).toEqual([])
  expect(toasts).toContain("Remote Control rename cancelled: the turn didn't finish.")
})

test('with resume, the next turn starts with what happened, and the model gets no note', async ($, on) => {
  const { commands, prompts, toasts, clock, session } = engine(on)
  await $.session.start(start)

  const queued = await $.tool.call({ tool: TOOL, action: 'connect', name: 'billing export', resume: ' Tell the owner it is reachable. ' })
  expect(queued.result).toMatch(/ Then the session resumes with: Tell the owner it is reachable\.$/)
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(5000)
  expect(commands).toEqual(['remote-control billing export'])
  expect(toasts).toContain('Remote Control connected as "billing export".')
  expect(prompts).toEqual(['Remote Control connected as "billing export". Resume: Tell the owner it is reachable.'])
  expect(session.appended()).toEqual([])
})

test('with resume, a rename starts the next turn saying so', async ($, on) => {
  const { commands, prompts, clock } = engine(on, { description: CONNECTED })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, action: 'rename', name: 'billing export', resume: 'Carry on with the export.' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(20000)
  expect(commands).toEqual(['rename billing export'])
  expect(prompts).toEqual(['Session renamed "billing export". Resume: Carry on with the export.'])
})

test('with resume, a connect that does not take starts a turn that says so', async ($, on) => {
  const { commands, prompts, toasts, rc, clock, session } = engine(on, { failsToConnect: true })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, action: 'connect', name: 'billing export', resume: 'Tell the owner how it went.' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(20000)
  expect(commands).toEqual(['remote-control billing export'])
  expect(rc.description).toBe(NOT_CONNECTED)
  expect(toasts).toContain('Remote Control: the command ran, but the session does not read as connected yet.')
  expect(prompts).toEqual([
    'The remote-control command ran, but this session did not read as connected a few seconds later; check with remote_control status. Resume: Tell the owner how it went.',
  ])
  expect(session.appended()).toEqual([])
})

test('a resume the engine drops falls back to the note', async ($, on) => {
  const { prompts, toasts, clock, session } = engine(on, { failsToConnect: true, dropped: 'a Stop hook blocked it' })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, action: 'connect', name: 'billing export', resume: 'Tell the owner how it went.' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(20000)
  expect(prompts).toEqual([])
  expect(toasts).toContain('Resume not sent: a Stop hook blocked it')
  expect(JSON.stringify(session.appended())).toMatch(/did not read as connected a few seconds later/)
})

test('rename and connect in one turn keep the resume either one gave', async ($, on) => {
  const { prompts, clock } = engine(on)
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, action: 'connect', resume: 'Go on.' })
  const rename = await $.tool.call({ tool: TOOL, action: 'rename', name: 'billing export' })
  expect(rename.result).toMatch(/then Remote Control connects under that name\. Then the session resumes with: Go on\.$/)
  await $.turn.complete({ ...answered, turnId: 't1' })
  await clock.advance(20000)
  expect(prompts).toEqual(['Session renamed "billing export". Remote Control connected as "billing export". Resume: Go on.'])
})

test('an interrupted turn cancels the resume with what it queued', async ($, on) => {
  const { commands, prompts, clock } = engine(on, { description: CONNECTED })
  await $.session.start(start)

  await $.tool.call({ tool: TOOL, action: 'rename', name: 'billing export', resume: 'Go on.' })
  await $.turn.complete({ ...answered, turnId: 't1', isAborted: true, reason: 'aborted' })
  await clock.advance(20000)
  expect(commands).toEqual([])
  expect(prompts).toEqual([])
})

test("the owner's A: a rename starts the moment the turn's end returns, with no half-second beat", async ($, on) => {
  const { commands, clock } = engine(on)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, action: 'rename', name: 'billing export' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  expect(commands).toEqual([])
  await clock.advance(1)
  expect(commands).toHaveLength(1)
})

test("the owner's note: the description says, after connect or rename, to end the turn and do nothing more until it has run, then carry on", async ($, on) => {
  const { described } = engine(on)
  await $.session.start(start)
  expect(described.join(' ')).toContain('After `connect` or `rename`, end your turn and do nothing more until it has run; then carry on.')
})

test("the person's turn after a rename was queued, before it ran: the rename runs, and its resume goes to the model as a note, never as a turn", async ($, on) => {
  const { commands, prompts, toasts, session, clock } = engine(on)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, action: 'rename', name: 'billing export', resume: 'Carry on with X.' })
  await $.prompt.submit(typed("stop, don't do X", 't1'))
  await $.turn.complete({ ...answered, turnId: 't1' })
  await $.turn.start({ text: "stop, don't do X", turnId: 't2' })
  await $.turn.complete({ ...answered, turnId: 't2' })
  await clock.advance(1000)
  expect(commands).toEqual(['rename billing export'])
  expect(prompts.some(p => p.includes('Carry on with X.'))).toBe(false)
  expect(toasts).toContain(STALE_TOAST)
  expect(JSON.stringify(session.appended())).toContain(`${STALE_NOTE}Carry on with X.`)
})

test("the person's turn after a connect was queued, before it ran: it connects, and its resume goes to the model as a note", async ($, on) => {
  const { commands, prompts, toasts, session, clock } = engine(on)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, action: 'connect', name: 'billing export', resume: 'Carry on with X.' })
  await $.prompt.submit(typed("stop, don't do X", 't1'))
  await $.turn.complete({ ...answered, turnId: 't1' })
  await $.turn.start({ text: "stop, don't do X", turnId: 't2' })
  await $.turn.complete({ ...answered, turnId: 't2' })
  await clock.advance(5000)
  expect(commands).toEqual(['remote-control billing export'])
  expect(prompts.some(p => p.includes('Carry on with X.'))).toBe(false)
  expect(toasts).toContain(STALE_TOAST)
  expect(JSON.stringify(session.appended())).toContain('It was: Carry on with X.')
})

test("a task's notification turn first, not the person's: a rename's resume still goes as a new message", async ($, on) => {
  const { prompts, clock } = engine(on)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, action: 'rename', name: 'billing export', resume: 'Run the tests.' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  const note = '<task-notification>The tests finished: 3 failed.</task-notification>'
  await $.prompt.submit({ text: note, wait: false, origin: { kind: 'task-notification' } })
  await $.turn.start({ text: note, turnId: 't2' })
  await $.turn.complete({ ...answered, turnId: 't2' })
  await clock.advance(1000)
  expect(prompts.filter(p => p.includes('Run the tests.'))).toHaveLength(1)
})

test("two renames armed one after the other, the person's turn between them: the first's resume is a note, the second's a new message", async ($, on) => {
  const { prompts, session, clock } = engine(on)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, action: 'rename', name: 'billing export', resume: 'First resume.' })
  await $.prompt.submit(typed("stop, don't do X", 't1'))
  await $.turn.complete({ ...answered, turnId: 't1' })
  await $.turn.start({ text: "stop, don't do X", turnId: 't2' })
  await $.tool.call({ tool: TOOL, action: 'rename', name: 'billing export two', resume: 'Second resume.' })
  await $.turn.complete({ ...answered, turnId: 't2' })
  await clock.advance(1000)
  expect(prompts.some(p => p.includes('First resume.'))).toBe(false)
  expect(JSON.stringify(session.appended())).toContain('It was: First resume.')
  expect(prompts.filter(p => p.includes('Second resume.'))).toHaveLength(1)
})

// The person's message, by turn id: no prompt text is held. The turn a prompt was typed over ends before that
// prompt's own next(e) resolves, so these hold the person's prompt at the bottom, as Claude Code does, until its turn.

/** Queues a rename in the running turn, `resume` to follow it. */
const queueRename = (resume: string) => ({ tool: TOOL, action: 'rename', name: 'billing export', resume }) as const

test("the person types mid-turn and the model arms at that turn's end: a rename's resume is a note, no new message", async ($, on) => {
  const w = engine(on)
  w.hold('do Y instead')
  await $.session.start(start)
  await $.tool.call(queueRename('Carry on with X.'))
  const sent = $.prompt.submit(typed('do Y instead', 't1'))
  await w.clock.settle()
  await $.turn.complete({ ...answered, turnId: 't1' })
  w.enter('do Y instead')
  await sent
  await $.turn.start({ text: 'do Y instead', turnId: 't2' })
  await $.turn.complete({ ...answered, turnId: 't2' })
  await w.clock.advance(1000)
  expect(w.commands).toEqual(['rename billing export'])
  expect(w.prompts).toEqual(['do Y instead'])
  expect(w.toasts).toContain(STALE_TOAST)
  expect(JSON.stringify(w.session.appended())).toContain(`${STALE_NOTE}Carry on with X.`)
})

test('the person types mid-turn and the rename reports before that prompt has entered: the mark made at Enter holds', async ($, on) => {
  const w = engine(on)
  w.hold('do Y instead')
  await $.session.start(start)
  await $.tool.call(queueRename('Carry on with X.'))
  const sent = $.prompt.submit(typed('do Y instead', 't1'))
  await w.clock.settle()
  await $.turn.complete({ ...answered, turnId: 't1' })
  await w.clock.advance(1000)
  expect(w.commands).toEqual(['rename billing export'])
  expect(w.prompts.some(p => p.includes('Carry on with X.'))).toBe(false)
  expect(w.toasts).toContain(STALE_TOAST)
  w.enter('do Y instead')
  await sent
})

test("another plugin's resume runs first, not the person's: a rename's resume still goes as a new message", async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await $.tool.call(queueRename('Run the tests.'))
  await $.turn.complete({ ...answered, turnId: 't1' })
  const woke = 'The self-wake plugin sent a message: check the deploy.'
  await $.prompt.submit({ text: woke, wait: false, origin: { kind: 'plugin', name: 'self-wake' } })
  await $.turn.start({ text: woke, turnId: 't2' })
  await $.turn.complete({ ...answered, turnId: 't2' })
  await w.clock.advance(1000)
  expect(w.prompts.filter(p => p.includes('Run the tests.'))).toHaveLength(1)
  expect(w.toasts).not.toContain(STALE_TOAST)
})

test("the person types while idle after the arm, before the rename reports, from the app's bridge: the resume is a note", async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await $.tool.call(queueRename('Carry on with X.'))
  await $.turn.complete({ ...answered, turnId: 't1' })
  await $.prompt.submit(typed('hold on', undefined, 'bridge'))
  await w.clock.advance(1000)
  expect(w.prompts.some(p => p.includes('Carry on with X.'))).toBe(false)
  expect(JSON.stringify(w.session.appended())).toContain(`${STALE_NOTE}Carry on with X.`)
})

test('a connect armed: the person typing during its check, before it reports, makes the resume a note', async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, action: 'connect', name: 'billing export', resume: 'Carry on with X.' })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await w.clock.advance(1000)
  expect(w.commands).toEqual(['remote-control billing export'])
  await $.prompt.submit(typed('one more thing'))
  await w.clock.advance(3000)
  expect(w.toasts).toContain('Remote Control connected as "billing export".')
  expect(w.prompts.some(p => p.includes('Carry on with X.'))).toBe(false)
  expect(w.toasts).toContain(STALE_TOAST)
})

test("a dropped person's prompt leaves no mark: typed mid-turn and dropped after the arm, or dropped while idle", async ($, on) => {
  const w = engine(on)
  w.hold('blocked one')
  w.block('blocked two', 'a UserPromptSubmit hook blocked it')
  await $.session.start(start)
  await $.tool.call(queueRename('First resume.'))
  const sent = $.prompt.submit(typed('blocked one', 't1'))
  await w.clock.settle()
  await $.turn.complete({ ...answered, turnId: 't1' })
  w.drop('blocked one', 'a UserPromptSubmit hook blocked it')
  expect((await sent).drop).toBe('a UserPromptSubmit hook blocked it')
  await w.clock.advance(1000)
  expect(w.prompts.filter(p => p.includes('First resume.'))).toHaveLength(1)

  await $.tool.call(queueRename('Second resume.'))
  await $.turn.complete({ ...answered, turnId: 't3' })
  expect((await $.prompt.submit(typed('blocked two'))).drop).toBe('a UserPromptSubmit hook blocked it')
  await w.clock.advance(1000)
  expect(w.prompts.filter(p => p.includes('Second resume.'))).toHaveLength(1)
  expect(w.toasts).not.toContain(STALE_TOAST)
})

test("a dropped prompt takes back only its own mark: another person's prompt that entered keeps the arm marked", async ($, on) => {
  const w = engine(on)
  w.hold('first')
  w.hold('second')
  await $.session.start(start)
  await $.tool.call(queueRename('Carry on with X.'))
  const one = $.prompt.submit(typed('first', 't1'))
  const two = $.prompt.submit(typed('second', 't1'))
  await w.clock.settle()
  await $.turn.complete({ ...answered, turnId: 't1' })
  w.enter('first')
  w.drop('second', 'blocked')
  await one
  await two
  await w.clock.advance(1000)
  expect(w.prompts.some(p => p.includes('Carry on with X.'))).toBe(false)
  expect(w.toasts).toContain(STALE_TOAST)
})

test("a slash command typed mid-turn is the person's message too: the resume is a note", async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await $.tool.call(queueRename('Carry on with X.'))
  await $.prompt.submit({ ...typed('/review the diff', 't1'), command: { name: 'review', args: 'the diff' } })
  await $.turn.complete({ ...answered, turnId: 't1' })
  await w.clock.advance(1000)
  expect(w.prompts.some(p => p.includes('Carry on with X.'))).toBe(false)
  expect(w.toasts).toContain(STALE_TOAST)
})

test('two prompts queued over one turn and batched into the next leave nothing behind to mark a later arm', async ($, on) => {
  const w = engine(on)
  w.hold('first')
  w.hold('second')
  await $.session.start(start)
  const one = $.prompt.submit(typed('first', 't0'))
  const two = $.prompt.submit(typed('second', 't0'))
  await w.clock.settle()
  await $.turn.complete({ ...answered, turnId: 't0' })
  w.enter('first')
  w.enter('second')
  await one
  await two
  await $.turn.start({ text: 'first\nsecond', turnId: 't1' })
  await $.tool.call(queueRename('Carry on with X.'))
  await $.turn.complete({ ...answered, turnId: 't1' })
  await w.clock.advance(1000)
  expect(w.prompts.filter(p => p.includes('Carry on with X.'))).toHaveLength(1)
  expect(w.toasts).not.toContain(STALE_TOAST)
})

test("the review's case: an earlier short reply ('y') never marks a later, unrelated arm", async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await $.prompt.submit(typed('y', 't0'))
  await $.turn.complete({ ...answered, turnId: 't0' })
  await $.turn.start({ text: 'go on with the deploy', turnId: 't1' })
  await $.tool.call(queueRename('Retry the deploy.'))
  await $.turn.complete({ ...answered, turnId: 't1' })
  const note = '<task-notification>yes: the build finished, and every test passed.</task-notification>'
  await $.prompt.submit({ text: note, wait: false, origin: { kind: 'task-notification' } })
  await $.turn.start({ text: note, turnId: 't2' })
  await $.turn.complete({ ...answered, turnId: 't2' })
  await w.clock.advance(1000)
  expect(w.prompts.filter(p => p.includes('Retry the deploy.'))).toHaveLength(1)
  expect(w.toasts).not.toContain(STALE_TOAST)
})

test("the turns a prompt was typed over are all forgotten at each main-loop turn end; a subagent's turn end forgets none", async ($, on) => {
  const w = engine(on)
  await $.session.start(start)
  await $.prompt.submit(typed('first', 'tX'))
  await $.turn.complete({ ...answered, turnId: 't1' })
  await $.tool.call(queueRename('First resume.'))
  await $.turn.complete({ ...answered, turnId: 'tX' })
  await w.clock.advance(1000)
  expect(w.prompts.filter(p => p.includes('First resume.'))).toHaveLength(1)

  await $.tool.call(queueRename('Second resume.'))
  await $.prompt.submit(typed('second', 't3'))
  await $.turn.complete({ ...answered, turnId: 'a-t1', agentId: 'a1' })
  await $.turn.complete({ ...answered, turnId: 't3' })
  await w.clock.advance(1000)
  expect(w.prompts.some(p => p.includes('Second resume.'))).toBe(false)
  expect(w.toasts).toContain(STALE_TOAST)
})

/** A marker no file holds: 16 random bytes, made as the test runs. */
function marker(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return `marker-${[...bytes].map(b => b.toString(16).padStart(2, '0')).join('')}`
}

test("no prompt text is kept: the person's words reach no state, toast, note, log line or command", async ($, on) => {
  const w = engine(on)
  const words = marker()
  const dropped = marker()
  expect(words).not.toBe(dropped)
  w.hold(words)
  w.hold(dropped)
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, action: 'connect', name: 'billing export', resume: 'Carry on with X.' })
  const sent = $.prompt.submit(typed(words, 't1'))
  const blocked = $.prompt.submit(typed(dropped, 't1', 'bridge'))
  await w.clock.settle()
  await $.turn.complete({ ...answered, turnId: 't1' })
  w.enter(words)
  w.drop(dropped, 'blocked')
  await sent
  await blocked
  // The person's turn, as Claude Code raises it: the settings hook's input and the turn both carry the words.
  await $.classic.UserPromptSubmit({ prompt: words })
  await $.turn.start({ text: words, turnId: 't2' })
  await $.turn.complete({ ...answered, turnId: 't2' })
  await w.clock.advance(5000)
  expect(w.toasts).toContain(STALE_TOAST)
  // State was written all along: the queued connect, the turns, the person's prompt for the loop-breaker.
  expect(w.seen.filter(said => said.includes('"key":"queued"')).length).toBeGreaterThanOrEqual(2)
  expect(w.seen.some(said => said.includes('"key":"resumes"'))).toBe(true)
  const everything = [...w.seen, ...w.toasts, ...w.commands, JSON.stringify(w.session.appended())].join('\n')
  expect(everything).not.toContain(words)
  expect(everything).not.toContain(dropped)
})
