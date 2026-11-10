// self-secret's hooks: the exact lines for each mode, on the copy of secret-run this session loaded;
// the shim for use by hand, never written from a copy that isn't an installed one; the refusals at the
// call; and nothing of a value anywhere. The lines themselves are run for real, against secret-run, and
// the shim's rule (written only from an installed copy, only over a lower version) is held, in
// tools/secret-run/invocation.test.mjs.
import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { bashLine, inFolder, powershellLine, psQuote, shQuote } from '../hooks/shim'

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
}

/** The engine beneath the plugin: the environment, the files, and everything the plugin asked of it. */
function engine(on: On, { env = WINDOWS, shimNow }: World = {}) {
  const variables: Record<string, string> = { GH_TOKEN: PLANTED, SECRET: PLANTED, ...env }
  const asked: string[] = []
  const writes: { path: string; text: string }[] = []
  const reads: string[] = []
  const logs: string[] = []
  const toasts: string[] = []
  const processes: string[] = []
  const fetches: string[] = []
  const registered: { name: string; description: string }[] = []
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
    if (/secret-run\.mjs$/.test(e.path) && shimNow !== undefined) return { value: shimNow }
    return { deny: `ENOENT: no such file or directory, open '${e.path}'` }
  })
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })
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
  /** This copy's folder, as the start's debug line names it: the folder the engine loaded the plugin from. */
  const root = () => logs.map(line => /this copy, at (.+), is not an installed one\.$/.exec(line)?.[1]).find(Boolean) ?? ''
  return { asked, writes, reads, logs, toasts, processes, fetches, registered, root }
}

/** The copy of secret-run this load of the plugin carries, as the plugin names it on Windows or elsewhere. */
const ownCopy = (root: string, isWindows: boolean) => inFolder(inFolder(root, 'tools', isWindows), 'secret-run.mjs', isWindows)

/** The Bash line's start: the program, as the line names it. */
const bashStart = (root: string) => `MSYS_NO_PATHCONV=1 node ${shQuote(ownCopy(root, true).replace(/\\/g, '/'))}`

test("a session from a copy that isn't an installed one (a --plugin-dir folder, a worktree) never writes the shim, nor reads it, and says why in the debug log", OFF, async ($, on) => {
  const { writes, reads, logs, root } = engine(on, { shimNow: '// a shim of some other version' })
  await $.session.start(start)
  await $.tool.call({ tool: TOOL, mode: 'list' })
  expect(writes).toEqual([])
  expect(reads.filter(path => /secret-run\.mjs$|plugin\.json$/.test(path))).toEqual([])
  expect(logs.length).toBe(1)
  expect(logs[0]?.startsWith(`self-secret: the stable command at ${SHIM} is left as it is: this copy, at `)).toBe(true)
  expect(logs[0]?.endsWith(', is not an installed one.')).toBe(true)
  expect(root()).toMatch(/[\\/]self-secret$/)
})

test('once: the exact Bash and PowerShell lines, on the copy this session loaded and never the shim, and what happens', OFF, async ($, on) => {
  const { root } = engine(on)
  await $.session.start(start)
  const command = ['gh', 'secret', 'set', 'DEPLOY_TOKEN']
  const options = ['--prompt', "Paste the repository's deploy token", '--no-check', '--env-var', 'GH_TOKEN']
  const { result, deny } = await $.tool.call({ tool: TOOL, profile: 'generic', options, command })
  expect(deny).toBeUndefined()
  const args = ['generic', ...options, '--', ...command]
  const target = ownCopy(root(), true)
  const text = String(result)
  expect(text.split('\n')[0]).toBe('Run it with the Bash tool, in the foreground, with timeout 600000:')
  expect(text.split('\n')[2]).toBe(bashLine(target, args, true))
  expect(bashLine(target, args, true)).toBe(
    `${bashStart(root())} generic --prompt 'Paste the repository'\\''s deploy token' --no-check --env-var GH_TOKEN -- gh secret set DEPLOY_TOKEN`,
  )
  const ps = `node.exe ${psQuote(target)} generic '--prompt' 'Paste the repository''s deploy token' '--no-check' '--env-var' GH_TOKEN '--' gh secret set DEPLOY_TOKEN`
  expect(powershellLine(target, args, true)).toEqual({ line: ps })
  expect(text.split('\n')[4]).toBe(`From PowerShell 7.3 or later (Standard argument passing): ${ps}`)
  expect(text).not.toContain('claude-self-tools\\secret-run.mjs')
  expect(text).not.toContain('claude-self-tools/secret-run.mjs')
  expect(text).toContain("It opens a form in the person's browser on this machine")
  expect(text).toContain('Tell the person first what to paste and why')
  expect(text).toContain("you never see it")
  expect(text).toContain(`The person's profiles are in ${PROFILES} (mode list shows them); generic is built in.`)
})

test('a word with a double quote gets no PowerShell line, which says to use the Bash line, and node.exe by name on Windows alone', OFF, async ($, on) => {
  const { root } = engine(on)
  await $.session.start(start)
  const options = ['--prompt', 'Paste the "deploy" token', '--no-check']
  const text = String((await $.tool.call({ tool: TOOL, profile: 'generic', options, command: ['gh'] })).result)
  expect(text.split('\n')[2]).toBe(`${bashStart(root())} generic --prompt 'Paste the "deploy" token' --no-check -- gh`)
  expect(text.split('\n')[4]).toBe(
    'No PowerShell line: a word holds a double quote ("), which Windows PowerShell 5.1 or Legacy argument passing would split into several words; use the Bash line.',
  )
  expect(text).not.toContain('From PowerShell')
  const inCommand = String((await $.tool.call({ tool: TOOL, profile: 'generic', options: ['--prompt', 'x', '--no-check'], command: ['echo', 'a"b'] })).result)
  expect(inCommand.split('\n')[4]).toMatch(/^No PowerShell line: a word holds a double quote/)
  const elsewhere = powershellLine('/opt/self-secret/tools/secret-run.mjs', ['--list'], false)
  expect(elsewhere).toEqual({ line: "node /opt/self-secret/tools/secret-run.mjs '--list'" })
})

test('hold, use-hold, end-hold, hold-status and list: each its exact words', OFF, async ($, on) => {
  const { root } = engine(on)
  await $.session.start(start)
  const line = async (input: Record<string, unknown>) => String((await $.tool.call({ tool: TOOL, ...input })).result).split('\n')[2]
  const at = bashStart(root())
  expect(await line({ mode: 'hold', profile: 'github-token', minutes: 30, command: ['gh', 'pr', 'list'] })).toBe(`${at} github-token --hold 30 -- gh pr list`)
  expect(await line({ mode: 'use-hold', profile: 'github-token', options: ['--redact', 'ex_[0-9]+'], command: ['gh', 'api', 'user'] })).toBe(
    `${at} github-token --use-hold --redact 'ex_[0-9]+' -- gh api user`,
  )
  expect(await line({ mode: 'end-hold', profile: 'github-token' })).toBe(`${at} --end-hold github-token`)
  expect(await line({ mode: 'hold-status' })).toBe(`${at} --hold-status`)
  expect(await line({ mode: 'list' })).toBe(`${at} --list`)
  const held = String((await $.tool.call({ tool: TOOL, mode: 'hold', profile: 'github-token', minutes: 1, command: ['gh'] })).result)
  expect(held).toContain('stays held in memory for 1 minute:')
  const status = String((await $.tool.call({ tool: TOOL, mode: 'hold-status' })).result)
  expect(status.split('\n')[0]).toBe('Run it with the Bash tool:')
  expect(status).toContain('Never a value.')
})

/** A path with forward slashes, to compare a path the plugin built with either separator. */
const slashed = (path: string) => path.replace(/\\/g, '/')

test('off Windows: the XDG state folder, else ~/.local/state, no Git Bash prefix, and node by its name', OFF, async ($, on) => {
  const xdg = engine(on, { env: { XDG_STATE_HOME: '/home/u/.state', HOME: '/home/u' } })
  await $.session.start(start)
  expect(xdg.writes).toEqual([])
  expect(xdg.logs[0]).toContain('the stable command at /home/u/.state/claude-self-tools/secret-run.mjs is left as it is')
  const text = String((await $.tool.call({ tool: TOOL, mode: 'list' })).result)
  const target = ownCopy(xdg.root(), false)
  expect(text.split('\n')[2]).toBe(`node ${shQuote(target)} --list`)
  expect(text.split('\n')[4]).toMatch(/^From PowerShell 7\.3 or later \(Standard argument passing\): node /)
  expect(text).toContain("The person's profiles are in /home/u/.state/claude-self-tools/secret-profiles.json")
})

test('off Windows with no XDG_STATE_HOME: ~/.local/state; a relative one is passed over', OFF, async ($, on) => {
  engine(on, { env: { XDG_STATE_HOME: 'relative/state', HOME: '/home/u/' } })
  await $.session.start(start)
  const text = String((await $.tool.call({ tool: TOOL, mode: 'list' })).result)
  expect(text).toContain("The person's profiles are in /home/u/.local/state/claude-self-tools/secret-profiles.json")
})

test('SELF_SECRET_HOME moves the state folder, a Git Bash spelling read as Windows reads it', OFF, async ($, on) => {
  const { logs } = engine(on, { env: { ...WINDOWS, SELF_SECRET_HOME: '/d/keep/secrets' } })
  await $.session.start(start)
  expect(slashed(logs[0] ?? '')).toContain('the stable command at D:/keep/secrets/secret-run.mjs is left as it is')
  const text = String((await $.tool.call({ tool: TOOL, mode: 'list' })).result)
  expect(slashed(text)).toContain("The person's profiles are in D:/keep/secrets/secret-profiles.json")
})

test('without %LOCALAPPDATA% the call is refused, and the start writes nothing', OFF, async ($, on) => {
  const { writes } = engine(on, { env: { OS: 'Windows_NT' } })
  await $.session.start(start)
  expect(writes).toEqual([])
  const { deny } = await $.tool.call({ tool: TOOL, mode: 'list' })
  expect(deny).toBe('self-secret: %LOCALAPPDATA% is not set, so there is no state folder for secret-run.')
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

test("`options` holds no flag that `mode` chooses, and no --profiles, alone or as --flag=value", OFF, async ($, on) => {
  engine(on)
  await $.session.start(start)
  const refused = async (options: string[], mode = 'once') =>
    (await $.tool.call({ tool: TOOL, mode, profile: 'github-token', options, command: ['gh', 'pr', 'list'] })).deny
  for (const [word, flag] of [
    ['--hold', '--hold'],
    ['--hold=5', '--hold'],
    ['--use-hold', '--use-hold'],
    ['--end-hold', '--end-hold'],
    ['--end-hold=github-token', '--end-hold'],
    ['--hold-status', '--hold-status'],
    ['--list', '--list'],
    ['--help', '--help'],
    ['-h', '-h'],
  ] as const)
    expect(await refused(['--redact', 'x_[0-9]+', word])).toBe(`\`options\` holds no \`${flag}\`: \`mode\` says what the line does.`)
  for (const word of ['--profiles', '--profiles=/tmp/p.json'])
    expect(await refused([word, '/tmp/p.json'])).toBe("`options` holds no `--profiles`: the line reads the person's own profiles file.")
  expect(await refused(['--profiles', 'x'], 'use-hold')).toBe("`options` holds no `--profiles`: the line reads the person's own profiles file.")
  expect((await $.tool.call({ tool: TOOL, mode: 'list', options: ['--profiles', 'x'] })).deny).toBe(
    "`options` holds no `--profiles`: the line reads the person's own profiles file.",
  )
  // A word that only starts like one is a word: a prompt, a pattern.
  expect(await refused(['--redact', '--holdings-[0-9]+'])).toBeUndefined()
  expect(await refused(['--timeout', '60'])).toBeUndefined()
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
