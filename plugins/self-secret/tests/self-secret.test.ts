// self-secret's hooks: the shim written at the session's start and before each answer, the exact
// lines for each mode, the refusals at the call, and nothing of a value anywhere. The lines themselves
// are run for real, against secret-run, in tools/secret-run/invocation.test.mjs.
import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { bashLine, fileUrl, powershellLine, shimText } from '../hooks/shim'

const TOOL = 'mcp__self-secret__secret_run_command'
const OFF = { options: { updateCheck: 'off' } } as const
const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const

const LOCAL = 'C:\\Users\\u\\AppData\\Local'
const STATE = `${LOCAL}\\claude-self-tools`
const SHIM = `${STATE}\\secret-run.mjs`
const PROFILES = `${STATE}\\secret-profiles.json`
const WINDOWS = { OS: 'Windows_NT', LOCALAPPDATA: LOCAL } as const

/** A made-up value in the variables a command would read, built at run time: never in a result, a log or a write. */
const PLANTED = ['planted', 'value', Math.random().toString(36).slice(2), 'end'].join('-')

type World = {
  env?: Readonly<Record<string, string>>
  /** What a read of the shim answers: its text, or nothing there. */
  shimNow?: string
  /** A write of the shim fails, saying this. */
  writeFails?: string
}

/** The engine beneath the plugin: the environment, the files, and everything the plugin asked of it. */
function engine(on: On, { env = WINDOWS, shimNow, writeFails }: World = {}) {
  const variables: Record<string, string> = { GH_TOKEN: PLANTED, SECRET: PLANTED, ...env }
  const asked: string[] = []
  const writes: { path: string; text: string }[] = []
  const reads: string[] = []
  const logs: string[] = []
  const toasts: string[] = []
  const processes: string[] = []
  const fetches: string[] = []
  const registered: { name: string; description: string }[] = []
  let shim = shimNow
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => {
    registered.push({ name: e.name, description: e.description })
    return { value: { tool: `mcp__self-secret__${e.name}` } }
  })
  on('env.get', (_, e) => {
    asked.push(e.name)
    return { value: variables[e.name] }
  })
  on('fs.read', (_, e) => {
    reads.push(e.path)
    if (/secret-run\.mjs$/.test(e.path) && shim !== undefined) return { value: shim }
    return { deny: `ENOENT: no such file or directory, open '${e.path}'` }
  })
  on('fs.write', (_, e) => {
    if (writeFails !== undefined) return { deny: writeFails }
    writes.push({ path: e.path, text: e.text })
    if (/secret-run\.mjs$/.test(e.path)) shim = e.text
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    logs.push(String(e.text))
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    processes.push(e.argv.join(' '))
    return { deny: 'no process in this test' }
  })
  on('http.fetch', (_, e) => {
    fetches.push(e.url)
    return { deny: 'no network in this test' }
  })
  return { asked, writes, reads, logs, toasts, processes, fetches, registered }
}

/** The shim's target, read back from the line the shim imports: the plugin's own copy of the command. */
function targetOf(text: string): string {
  const url = /^import "([^"]+)";$/m.exec(text)?.[1] ?? ''
  return decodeURIComponent(new URL(url).pathname).replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\')
}

test('the session start writes the shim in the state folder, naming the copy this load carries', OFF, async ($, on) => {
  const { writes } = engine(on)
  await $.session.start(start)
  expect(writes.map(w => w.path)).toEqual([SHIM])
  const text = writes[0]?.text ?? ''
  const target = targetOf(text)
  expect(target).toMatch(/\\tools\\secret-run\.mjs$/)
  expect(text).toBe(shimText(target))
  expect(text).toContain(`import "${fileUrl(target)}";`)
})

test('a shim that already names this copy is left as it is', OFF, async ($, on) => {
  const { writes, reads } = engine(on)
  await $.session.start(start)
  expect(writes.length).toBe(1)
  await $.tool.call({ tool: TOOL, mode: 'hold-status' })
  await $.tool.call({ tool: TOOL, mode: 'list' })
  expect(reads).toEqual([SHIM, SHIM, SHIM])
  expect(writes.length).toBe(1)
})

test('a stale shim, from another version, is written again before the answer', OFF, async ($, on) => {
  const { writes } = engine(on, { shimNow: shimText('C:\\old\\self-secret\\0.0.9\\tools\\secret-run.mjs') })
  await $.session.start(start)
  expect(writes.length).toBe(1)
  expect(targetOf(writes[0]?.text ?? '')).not.toContain('0.0.9')
})

test('once: the exact Bash and PowerShell lines on the stable shim, and what happens', OFF, async ($, on) => {
  engine(on)
  await $.session.start(start)
  const command = ['gh', 'secret', 'set', 'DEPLOY_TOKEN']
  const options = ['--prompt', "Paste the repository's deploy token", '--no-check', '--env-var', 'GH_TOKEN']
  const { result, deny } = await $.tool.call({ tool: TOOL, profile: 'generic', options, command })
  expect(deny).toBeUndefined()
  const args = ['generic', ...options, '--', ...command]
  const text = String(result)
  expect(text.split('\n')[0]).toBe('Run it with the Bash tool, in the foreground, with timeout 600000:')
  expect(text).toContain(`\n${bashLine(SHIM, args, true)}\n`)
  expect(bashLine(SHIM, args, true)).toBe(
    "MSYS_NO_PATHCONV=1 node C:/Users/u/AppData/Local/claude-self-tools/secret-run.mjs generic --prompt 'Paste the repository'\\''s deploy token' --no-check --env-var GH_TOKEN -- gh secret set DEPLOY_TOKEN",
  )
  expect(text).toContain(`From PowerShell 7.3 or later: ${powershellLine(SHIM, args)}`)
  expect(powershellLine(SHIM, args)).toBe(
    "node C:\\Users\\u\\AppData\\Local\\claude-self-tools\\secret-run.mjs generic '--prompt' 'Paste the repository''s deploy token' '--no-check' '--env-var' GH_TOKEN '--' gh secret set DEPLOY_TOKEN",
  )
  expect(text).toContain("It opens a form in the person's browser on this machine")
  expect(text).toContain('Tell the person first what to paste and why')
  expect(text).toContain("you never see it")
  expect(text).toContain(`The person's profiles are in ${PROFILES} (mode list shows them); generic is built in.`)
})

test('hold, use-hold, end-hold, hold-status and list: each its exact words', OFF, async ($, on) => {
  engine(on)
  await $.session.start(start)
  const line = async (input: Record<string, unknown>) => String((await $.tool.call({ tool: TOOL, ...input })).result).split('\n')[2]
  expect(await line({ mode: 'hold', profile: 'github-token', minutes: 30, command: ['gh', 'pr', 'list'] })).toBe(
    'MSYS_NO_PATHCONV=1 node C:/Users/u/AppData/Local/claude-self-tools/secret-run.mjs github-token --hold 30 -- gh pr list',
  )
  expect(await line({ mode: 'use-hold', profile: 'github-token', options: ['--redact', 'ex_[0-9]+'], command: ['gh', 'api', 'user'] })).toBe(
    "MSYS_NO_PATHCONV=1 node C:/Users/u/AppData/Local/claude-self-tools/secret-run.mjs github-token --use-hold --redact 'ex_[0-9]+' -- gh api user",
  )
  expect(await line({ mode: 'end-hold', profile: 'github-token' })).toBe(
    'MSYS_NO_PATHCONV=1 node C:/Users/u/AppData/Local/claude-self-tools/secret-run.mjs --end-hold github-token',
  )
  expect(await line({ mode: 'hold-status' })).toBe('MSYS_NO_PATHCONV=1 node C:/Users/u/AppData/Local/claude-self-tools/secret-run.mjs --hold-status')
  expect(await line({ mode: 'list' })).toBe('MSYS_NO_PATHCONV=1 node C:/Users/u/AppData/Local/claude-self-tools/secret-run.mjs --list')
  const held = String((await $.tool.call({ tool: TOOL, mode: 'hold', profile: 'github-token', minutes: 1, command: ['gh'] })).result)
  expect(held).toContain('stays held in memory for 1 minute:')
  const status = String((await $.tool.call({ tool: TOOL, mode: 'hold-status' })).result)
  expect(status.split('\n')[0]).toBe('Run it with the Bash tool:')
  expect(status).toContain('Never a value.')
})

/** A path as the engine hands a write to its hooks, with forward slashes: the engine resolves it on the host it runs on. */
const slashed = (path: string) => path.replace(/\\/g, '/')

test('off Windows: the XDG state folder, else ~/.local/state, and no Git Bash prefix', OFF, async ($, on) => {
  const xdg = engine(on, { env: { XDG_STATE_HOME: '/home/u/.state', HOME: '/home/u' } })
  await $.session.start(start)
  expect(xdg.writes.length).toBe(1)
  expect(slashed(xdg.writes[0]?.path ?? '')).toMatch(/\/home\/u\/\.state\/claude-self-tools\/secret-run\.mjs$/)
  const text = String((await $.tool.call({ tool: TOOL, mode: 'list' })).result)
  expect(text).toContain('\nnode /home/u/.state/claude-self-tools/secret-run.mjs --list\n')
  expect(text).toContain("The person's profiles are in /home/u/.state/claude-self-tools/secret-profiles.json")
})

test('off Windows with no XDG_STATE_HOME: ~/.local/state; a relative one is passed over', OFF, async ($, on) => {
  engine(on, { env: { XDG_STATE_HOME: 'relative/state', HOME: '/home/u/' } })
  await $.session.start(start)
  const text = String((await $.tool.call({ tool: TOOL, mode: 'list' })).result)
  expect(text).toContain('\nnode /home/u/.local/state/claude-self-tools/secret-run.mjs --list\n')
})

test('SELF_SECRET_HOME moves the state folder, a Git Bash spelling read as Windows reads it', OFF, async ($, on) => {
  const { writes } = engine(on, { env: { ...WINDOWS, SELF_SECRET_HOME: '/d/keep/secrets' } })
  await $.session.start(start)
  expect(writes.map(w => slashed(w.path))).toEqual(['D:/keep/secrets/secret-run.mjs'])
  const text = String((await $.tool.call({ tool: TOOL, mode: 'list' })).result)
  expect(text).toContain('\nMSYS_NO_PATHCONV=1 node D:/keep/secrets/secret-run.mjs --list\n')
})

test('without %LOCALAPPDATA% the call is refused, and the start writes nothing', OFF, async ($, on) => {
  const { writes } = engine(on, { env: { OS: 'Windows_NT' } })
  await $.session.start(start)
  expect(writes).toEqual([])
  const { deny } = await $.tool.call({ tool: TOOL, mode: 'list' })
  expect(deny).toBe('self-secret: %LOCALAPPDATA% is not set, so there is no state folder for secret-run.')
})

test("a shim that can't be written: the lines name the plugin's own copy, and say why", OFF, async ($, on) => {
  const { logs } = engine(on, { writeFails: 'EPERM: operation not permitted' })
  await $.session.start(start)
  expect(logs.length).toBe(1)
  expect(logs[0]).toMatch(new RegExp(`^self-secret: couldn't write ${SHIM.replace(/\\/g, '\\\\')}: .*EPERM: operation not permitted$`))
  const text = String((await $.tool.call({ tool: TOOL, mode: 'list' })).result)
  expect(text).toMatch(/\nMSYS_NO_PATHCONV=1 node \S+\/tools\/secret-run\.mjs --list\n/)
  expect(text).not.toContain('node C:/Users/u/AppData/Local/claude-self-tools/secret-run.mjs')
  expect(text).toMatch(/\(The stable copy at \S+ couldn't be written: .*EPERM: operation not permitted\. These lines name the plugin's own copy, whose path changes with its version\.\)$/)
})

test('what a line is made of is checked at the call', OFF, async ($, on) => {
  const { writes } = engine(on)
  await $.session.start(start)
  const before = writes.length
  const refused = async (input: Record<string, unknown>) => (await $.tool.call({ tool: TOOL, ...input })).deny
  expect(await refused({ mode: 'remote', profile: 'generic' })).toBe('`mode` is one of once, hold, use-hold, end-hold, hold-status, list.')
  expect(await refused({ profile: 'Generic', command: ['x'] })).toMatch(/^`profile` is a profile's name/)
  expect(await refused({ profile: '../holds', command: ['x'] })).toMatch(/^`profile` is a profile's name/)
  expect(await refused({ command: ['x'] })).toMatch(/^`profile` is a profile's name/)
  expect(await refused({ mode: 'list', profile: 'generic' })).toBe('mode list takes no `profile`.')
  for (const minutes of [undefined, 0, -1, 121, Number.NaN, '30'])
    expect(await refused({ mode: 'hold', profile: 'p', minutes, command: ['x'] })).toBe('mode hold takes `minutes`: more than 0 and at most 120.')
  expect(await refused({ profile: 'p', minutes: 5, command: ['x'] })).toBe('`minutes` goes with mode hold only.')
  expect(await refused({ profile: 'p' })).toMatch(/^`command` is the command to run/)
  expect(await refused({ profile: 'p', command: [] })).toMatch(/^`command` is the command to run/)
  expect(await refused({ profile: 'p', command: [''] })).toMatch(/^`command` is the command to run/)
  expect(await refused({ profile: 'p', command: 'gh secret set X' })).toMatch(/^`command` is the command to run/)
  expect(await refused({ profile: 'p', command: ['gh', 7] })).toMatch(/^`command` is the command to run/)
  expect(await refused({ mode: 'hold-status', command: ['x'] })).toBe('mode hold-status runs no command: leave out `command`.')
  expect(await refused({ profile: 'p', options: ['--no-check', '--'], command: ['x'] })).toBe('`options` holds no `--`: the line puts it before the command.')
  expect(await refused({ profile: 'p', options: '--no-check', command: ['x'] })).toBe('`options` is a list of words.')
  expect(await refused({ mode: 'end-hold', profile: 'p', options: ['--x'] })).toBe('mode end-hold takes no `options`.')
  expect(await refused({ profile: 'p', command: Array(300).fill('w') })).toBe('at most 256 words in all, each at most 8192 characters.')
  expect(writes.length).toBe(before)
})

test('a subagent is refused, and nothing is written', OFF, async ($, on) => {
  const { writes } = engine(on)
  await $.session.start(start)
  const before = writes.length
  const { deny, result } = await $.tool.call({ tool: TOOL, mode: 'list', agentId: 'a1' })
  expect(result).toBeUndefined()
  expect(deny).toMatch(/^A subagent doesn't ask for secrets/)
  expect(writes.length).toBe(before)
})

test('no value anywhere: the plugin reads five variables, starts no process, and nothing it says or writes holds a value', OFF, async ($, on) => {
  const world = engine(on)
  await $.session.start(start)
  const results: string[] = []
  for (const input of [
    { profile: 'generic', options: ['--prompt', 'x', '--no-check'], command: ['node', '-e', 'console.log(process.env.SECRET)'] },
    { mode: 'hold', profile: 'github-token', minutes: 5, command: ['gh', 'auth', 'status'] },
    { mode: 'use-hold', profile: 'github-token', command: ['gh', 'api', 'user'] },
    { mode: 'end-hold', profile: 'github-token' },
    { mode: 'hold-status' },
    { mode: 'list' },
  ]) {
    const done = await $.tool.call({ tool: TOOL, ...input })
    results.push(String(done.result ?? done.deny))
  }
  expect(new Set(world.asked)).toEqual(new Set(['OS', 'SELF_SECRET_HOME', 'LOCALAPPDATA']))
  expect(world.processes).toEqual([])
  expect(world.fetches).toEqual([])
  for (const said of [...results, ...world.logs, ...world.toasts, ...world.writes.map(w => `${w.path} ${w.text}`)]) expect(said).not.toContain(PLANTED)
})

test('the description says when to call it, and never to ask for a secret in the chat', OFF, async ($, on) => {
  const { registered } = engine(on)
  await $.session.start(start)
  expect(registered.map(r => r.name)).toEqual(['secret_run_command'])
  const description = registered.find(r => r.name === 'secret_run_command')?.description ?? ''
  expect(description).toContain('Never ask the person to paste a secret into the chat')
  expect(description).toContain('Run the line it returns with the Bash tool, in the foreground, with timeout 600000')
  expect(description).toContain('It runs nothing itself, and its answer never holds a value.')
})
