// self-check against the engine's kit, fakes only: the tools the session lists, the permission
// verdicts, the Bash and PowerShell tools as the engine answers them, the MCP servers' probes and the
// file the check writes. No real tool, process or file is touched; the session id was generated for
// these tests.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__self-check__tools_check'
const HOUR = 60 * 60 * 1000
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const LOCAL = 'C:\\Users\\u\\AppData\\Local'
const RECORD = `${LOCAL}\\claude-self-tools\\selfcheck\\${ID}.json`
const RESTART_HINT =
  "A fresh process usually repairs a dead tool: restart_after_turn (self-restart; it needs a safe point). Where the coordinator runs, the merger can restart this lane (`next: 'restart'`)."
const MCP_HINT = 'An MCP server that failed may need only a reconnect: reconnect_mcp_after_turn (self-mcp).'

/** How a shell tool answers: with the echo, with nothing, with something else, never, with an error, or refused by a hook. */
type Shell = 'echoes' | 'empty' | 'wrong' | 'hangs' | 'errors' | 'refused'
/** How an MCP probe answers. */
type Probe = 'ok' | 'error' | 'hangs'

type Options = {
  bash?: Shell
  powershell?: Shell
  /** The permission verdicts, by tool; allow when not said. */
  verdicts?: Record<string, 'allow' | 'ask' | 'deny'>
  /** The tools the session lists, by name. */
  tools?: string[]
  /** How each server's probe answers, by server; ok when not said. */
  probes?: Record<string, Probe>
  env?: Record<string, string>
}

const TOOLS = ['Bash', 'PowerShell', 'Read', 'mcp__linear__whoami', 'mcp__linear__list_issues', 'mcp__coordinator__lanes_list']

/** The engine beneath the plugin, and what the plugin asked of it. */
function engine(on: On, { bash = 'echoes', powershell = 'echoes', verdicts = {}, tools = TOOLS, probes = {}, env = { LOCALAPPDATA: LOCAL } }: Options = {}) {
  const world = { bash, powershell, verdicts, tools, probes }
  const commands: { tool: string; command: string }[] = []
  const checked: string[] = []
  /** Each permission check and each call, in order (the kit may check again inside a call). */
  const events: string[] = []
  /** What each permission check put under `input`, and the keys each shell call carried. */
  const checkInputs: unknown[] = []
  const callShapes: string[][] = []
  const probed: string[] = []
  const writes: { path: string; text: string }[] = []
  const toasts: string[] = []
  const prompts: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  const session = mock.session(on)
  mock.env(on, env)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: ID }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('tool.list', () => ({ value: world.tools.map(name => ({ name, description: '', mcp: name.startsWith('mcp__') })) }))
  on('tool.check', (_, e) => {
    checked.push(e.tool)
    checkInputs.push(e.input)
    events.push(`check ${e.tool}`)
    return { decision: world.verdicts[e.tool] ?? 'allow' }
  })
  /**
   * A shell tool's answer, as the engine gives one (`as never`: its record's type is the engine's own).
   * The arguments are at the top level of a `$.tool.call`: one that puts them under `input` is an
   * error result, as the engine answers it (live check SS2).
   */
  const shell = async (how: Shell, e: Record<string, unknown>) => {
    callShapes.push(Object.keys(e).filter(key => key !== 'tool_use_id' && key !== 'agentId' && key !== 'consent').sort())
    if ('input' in e || typeof e.command !== 'string') return { isError: true, result: 'InputValidationError', text: 'InputValidationError: The required parameter `command` is missing' } as never
    const command = e.command
    const token = /selfcheck-[0-9a-f]+/.exec(command)?.[0] ?? ''
    if (how === 'hangs') await clock.sleep(HOUR)
    if (how === 'errors') return { isError: true, result: 'Exit code 127', text: 'Exit code 127: the shell could not start' } as never
    if (how === 'refused') return { deny: 'a hook refused it' } as never
    const stdout = how === 'echoes' ? `${token}\n` : how === 'wrong' ? 'selfcheck-0000\n' : ''
    return { result: { stdout, stderr: '', interrupted: false }, text: stdout.trim() } as never
  }
  on('tool.call', { tool: 'Bash' }, (_, e) => {
    commands.push({ tool: 'Bash', command: String(e.command) })
    events.push('call Bash')
    return shell(world.bash, e as unknown as Record<string, unknown>)
  })
  on('tool.call', { tool: 'PowerShell' }, (_, e) => {
    commands.push({ tool: 'PowerShell', command: String(e.command) })
    events.push('call PowerShell')
    return shell(world.powershell, e as unknown as Record<string, unknown>)
  })
  on('mcp.call', async (_, e) => {
    probed.push(`${e.server}=${e.tool}`)
    const how = world.probes[e.server] ?? 'ok'
    if (how === 'hangs') await clock.sleep(HOUR)
    return { value: how === 'error' ? { content: [{ type: 'text' as const, text: 'unauthorized' }], isError: true } : { content: [{ type: 'text' as const, text: 'me' }], isError: false } }
  })
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('classic.SessionStart', () => ({}))
  return { world, commands, checked, events, checkInputs, callShapes, probed, writes, toasts, prompts, clock, session }
}

const start = { cwd: 'C:\\work\\repo', surface: 'terminal', isInteractive: true } as const
const answered = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as const

/** The check's answer, as text. */
async function check($: Engine): Promise<string> {
  const done = await $.tool.call({ tool: TOOL })
  expect(done.deny).toBeUndefined()
  return String(done.result)
}

test('every tool answers: Bash and PowerShell echo a fresh nonce each, the MCP servers are listed, and the record says none failed', async ($, on) => {
  const { commands, events, probed, writes } = engine(on)
  await $.session.start(start)

  expect(await check($)).toBe(
    [
      'self-check: no tool failed.',
      'Bash: ok',
      'PowerShell: ok',
      'MCP server coordinator: listed (1 tool), not exercised',
      'MCP server linear: listed (2 tools), not exercised',
    ].join('\n'),
  )
  // The permission verdict first, then the call; a harmless echo, a fresh nonce each.
  expect(events[0]).toBe('check Bash')
  expect(events.indexOf('check Bash')).toBeLessThan(events.indexOf('call Bash'))
  expect(events.indexOf('call Bash')).toBeLessThan(events.indexOf('check PowerShell'))
  expect(events.indexOf('check PowerShell')).toBeLessThan(events.indexOf('call PowerShell'))
  expect(commands.map(c => c.tool)).toEqual(['Bash', 'PowerShell'])
  expect(commands[0]?.command).toMatch(/^echo selfcheck-[0-9a-f]{16}$/)
  expect(commands[1]?.command).toMatch(/^Write-Output selfcheck-[0-9a-f]{16}$/)
  expect(commands[0]?.command.slice(5)).not.toBe(commands[1]?.command.slice(13))
  // No server is called without a probe naming it.
  expect(probed).toEqual([])
  expect(writes).toEqual([{ path: RECORD, text: '{"v":1,"at":1000000,"failed":[]}' }])
})

test('the two shapes: the check takes the command under `input`, the call at the top level', async ($, on) => {
  const { checkInputs, callShapes, commands } = engine(on)
  await $.session.start(start)
  await check($)
  const [bash, powershell] = commands
  // Each permission check first, with the command under `input` (the kit may check again inside a call).
  expect(checkInputs[0]).toEqual({ command: bash?.command })
  expect(checkInputs).toContainEqual({ command: powershell?.command })
  // Each call with `command` and `description` beside `tool`, and no `input` key.
  expect(callShapes).toHaveLength(2)
  for (const keys of callShapes) {
    for (const key of ['command', 'description', 'tool']) expect(keys).toContain(key)
    expect(keys).not.toContain('input')
  }
})

test('a call the engine answers with an error result fails, as an `input:`-shaped call would', async ($, on) => {
  engine(on, { bash: 'errors', powershell: 'errors' })
  await $.session.start(start)
  const said = (await check($)).split('\n')
  expect(said.slice(0, 3)).toEqual(['self-check: 2 failed (Bash, PowerShell).', 'Bash: failed: Exit code 127: the shell could not start', 'PowerShell: failed: Exit code 127: the shell could not start'])
})

test('an empty Bash result is failed: no output, and the answer says how a fresh process repairs it', async ($, on) => {
  const { writes } = engine(on, { bash: 'empty' })
  await $.session.start(start)

  const said = await check($)
  expect(said.split('\n')).toEqual([
    'self-check: 1 failed (Bash).',
    'Bash: failed: no output',
    'PowerShell: ok',
    'MCP server coordinator: listed (1 tool), not exercised',
    'MCP server linear: listed (2 tools), not exercised',
    RESTART_HINT,
  ])
  expect(writes).toEqual([{ path: RECORD, text: '{"v":1,"at":1000000,"failed":["Bash"]}' }])
})

test("output that doesn't hold the nonce fails", async ($, on) => {
  engine(on, { powershell: 'wrong' })
  await $.session.start(start)
  expect((await check($)).split('\n')).toContain("PowerShell: failed: the output didn't hold the nonce (it read \u00abselfcheck-0000\u00bb)")
})

test('a call that never answers fails after 10 s, and the check goes on', async ($, on) => {
  const { clock } = engine(on, { bash: 'hangs' })
  await $.session.start(start)
  const pending = $.tool.call({ tool: TOOL })
  // The check runs as far as it can (Bash's call is under way, its 10 s counting), then 10 s pass.
  await clock.settle()
  await clock.advance(10_000)
  const said = String((await pending).result)
  expect(said.split('\n').slice(0, 3)).toEqual(['self-check: 1 failed (Bash).', 'Bash: failed: timed out after 10 s', 'PowerShell: ok'])
  await clock.advance(HOUR)
})

test('a tool that reports an error fails, saying it', async ($, on) => {
  engine(on, { bash: 'errors' })
  await $.session.start(start)
  expect((await check($)).split('\n')).toContain('Bash: failed: Exit code 127: the shell could not start')
})

test('a permission verdict other than allow is not tested: no call is made, so no dialog can open', async ($, on) => {
  const { commands, checked } = engine(on, { verdicts: { Bash: 'ask', PowerShell: 'deny' } })
  await $.session.start(start)

  const said = await check($)
  expect(said.split('\n').slice(0, 3)).toEqual(['self-check: no tool failed.', 'Bash: not tested: needs permission (ask)', 'PowerShell: not tested: refused by permissions (deny)'])
  expect(checked).toEqual(['Bash', 'PowerShell'])
  // Neither tool was called: no call, no dialog.
  expect(commands).toEqual([])
  expect(said).not.toContain(RESTART_HINT)
})

test('a call a hook refuses is not tested, never failed', async ($, on) => {
  engine(on, { bash: 'refused' })
  await $.session.start(start)
  expect((await check($)).split('\n').slice(0, 2)).toEqual(['self-check: no tool failed.', 'Bash: not tested: refused (a hook refused it)'])
})

test("a tool the session doesn't have is said, never called and never failed", async ($, on) => {
  const { commands, checked } = engine(on, { tools: ['Bash', 'Read'] })
  await $.session.start(start)
  expect(await check($)).toBe(['self-check: no tool failed.', 'Bash: ok', "PowerShell: not among this session's tools"].join('\n'))
  expect(checked.includes('PowerShell')).toBe(false)
  expect(commands.map(c => c.tool)).toEqual(['Bash'])
})

test(
  "MCP servers: exercised only through a probe named in the settings; isError or no answer in 10 s fails; a probe for a server that isn't listed fails",
  { options: { probes: ['linear=whoami', 'coordinator=lanes_list', 'github=get_me', 'notion=search', ' not a probe '] } },
  async ($, on) => {
    const { probed, writes, clock } = engine(on, {
      tools: ['Bash', 'PowerShell', 'mcp__linear__whoami', 'mcp__coordinator__lanes_list', 'mcp__notion__fetch', 'mcp__slack__post'],
      probes: { coordinator: 'error' },
    })
    await $.session.start(start)
    const said = (await check($)).split('\n')
    expect(said).toEqual([
      'self-check: 2 failed (mcp:coordinator, mcp:github).',
      'Bash: ok',
      'PowerShell: ok',
      'probe \u00abnot a probe\u00bb: ignored, not server=tool',
      'MCP server coordinator: failed: its probe lanes_list reported an error (unauthorized)',
      "MCP server github: failed: not connected (no tools listed), so its probe get_me wasn't run",
      'MCP server linear: ok (probe whoami)',
      "MCP server notion: listed (1 tool); its probe search isn't one of its tools, so not exercised",
      'MCP server slack: listed (1 tool), not exercised',
      RESTART_HINT,
      MCP_HINT,
    ])
    // Only the two probes whose tools are listed were called; slack, with none named, never.
    expect(probed.sort()).toEqual(['coordinator=lanes_list', 'linear=whoami'])
    expect(writes.map(w => w.text)).toEqual(['{"v":1,"at":1000000,"failed":["mcp:coordinator","mcp:github"]}'])
    await clock.advance(0)
  },
)

test('an MCP probe that never answers fails after 10 s', { options: { probes: ['linear=whoami'] } }, async ($, on) => {
  const { clock } = engine(on, { probes: { linear: 'hangs' } })
  await $.session.start(start)
  const pending = $.tool.call({ tool: TOOL })
  await clock.settle()
  await clock.advance(10_000)
  expect(String((await pending).result).split('\n')).toContain('MCP server linear: failed: its probe whoami timed out after 10 s')
  await clock.advance(HOUR)
})

test('the record holds names only, at the id-shaped path', async ($, on) => {
  const first = engine(on, { bash: 'errors', powershell: 'empty' })
  await $.session.start(start)
  await check($)
  expect(first.writes).toEqual([{ path: RECORD, text: '{"v":1,"at":1000000,"failed":["Bash","PowerShell"]}' }])
})

test('without a plain %LOCALAPPDATA% the check writes nothing', async ($, on) => {
  const { writes } = engine(on, { bash: 'empty', env: { LOCALAPPDATA: '..\\x' } })
  await $.session.start(start)
  await check($)
  expect(writes).toEqual([])
})

test('a subagent is refused, and nothing is run', async ($, on) => {
  const { commands, checked } = engine(on)
  await $.session.start(start)
  const refused = await $.tool.call({ tool: TOOL, agentId: 'a1' })
  expect(refused.deny).toMatch(/subagent/)
  expect(checked).toEqual([])
  expect(commands).toEqual([])
})

// At resume, quietly.

test('at resume, a passing check says nothing: no toast, no row, no turn; its record is written', async ($, on) => {
  const { commands, toasts, prompts, writes, session, clock } = engine(on)
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  await clock.advance(9_999)
  expect(commands).toEqual([])
  await clock.advance(1)
  expect(commands.map(c => c.tool)).toEqual(['Bash', 'PowerShell'])
  expect(toasts).toEqual([])
  expect(session.appended()).toEqual([])
  expect(prompts).toEqual([])
  expect(writes).toEqual([{ path: RECORD, text: '{"v":1,"at":1010000,"failed":[]}' }])
})

test('at resume, a failure is said: one toast and one row read with the next message, never a turn', async ($, on) => {
  const { toasts, prompts, session, writes, clock } = engine(on, { bash: 'empty' })
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  await clock.advance(10_000)
  expect(toasts).toEqual(['self-check at resume: Bash failed. A fresh process usually repairs a dead tool (restart_after_turn).'])
  const rows = session.appended().flatMap(row => ((row as { message?: { content?: { text?: unknown }[] } }).message?.content ?? []).map(block => String(block.text)))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toContain('self-check ran at resume. self-check: 1 failed (Bash).')
  expect(rows[0]).toContain('Bash: failed: no output')
  expect(rows[0]).toContain(RESTART_HINT)
  expect(prompts).toEqual([])
  expect(writes.map(w => w.text)).toEqual(['{"v":1,"at":1010000,"failed":["Bash"]}'])
})

test('at resume, it waits for a running turn to end', async ($, on) => {
  const { commands, clock } = engine(on)
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  await $.turn.start({ text: 'Restarted. Resume: go on.', turnId: 't1' })
  await clock.advance(60_000)
  expect(commands).toEqual([])
  // A subagent's turn ending is not the session's.
  await $.turn.complete({ ...answered, turnId: 'a-t1', agentId: 'a1' })
  await clock.advance(1000)
  expect(commands).toEqual([])
  await $.turn.complete(answered)
  await clock.advance(1000)
  expect(commands.map(c => c.tool)).toEqual(['Bash', 'PowerShell'])
})

test('a startup, a clear, or a subagent start checks nothing', async ($, on) => {
  const { commands, clock } = engine(on)
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'startup' })
  await $.classic.SessionStart({ source: 'clear' })
  await $.classic.SessionStart({ source: 'resume', session_id: ID, agent_id: 'a1' })
  await clock.advance(60_000)
  expect(commands).toEqual([])
})

test('with checkAtResume off, nothing runs at resume', { options: { checkAtResume: 'off' } }, async ($, on) => {
  const { commands, toasts, clock } = engine(on, { bash: 'empty' })
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  await clock.advance(60_000)
  expect(commands).toEqual([])
  expect(toasts).toEqual([])
})
