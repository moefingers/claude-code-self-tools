// The env guard against the engine's kit, fakes only. The env folder is held in memory, under a fake
// profile in a Temp folder; its variables are fake (FAKE_*), with low-entropy values built here
// ('v' repeated); the session id is generated here. No real file is read or written: every fs call
// is answered by the fake below, and one outside the fake root is refused and counted, so a test
// that reached for the real ~/.claude/session-env fails.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { AT_RISK_BELOW, byLoadOrder, dedupe, DEDUPE_OVER, GIT_BASH_LIMIT, grouped, inlinedLength, PLAIN, roomLeft, roomPhrase, verdictOf, WRAPPER_CHARS } from '../hooks/env-guard'

const TOOL = 'mcp__self-check__tools_check'
/** A session id generated here: each group one hex digit repeated, the shape Claude Code's ids have. */
const ID = [8, 4, 4, 4, 12].map((n, i) => String.fromCharCode(97 + i).repeat(n)).join('-')
/** Everything the fake file system holds sits under this root, in a Temp folder. */
const ROOT = 'C:\\Temp\\self-check-env-fake'
const PROFILE = `${ROOT}\\profile`
const LOCAL = `${ROOT}\\local`
const FOLDER = `${PROFILE}\\.claude\\session-env\\${ID}`
/** A value's characters, never seen in an answer, a toast or a log. */
const MARK = 'vvvvvvvvvv'

const ENV_HINT = [
  "A Bash that runs nothing (no output, or `unexpected EOF` from a short command) is most often this session's env grown too long: Claude Code puts the session's env hook files (`~/.claude/session-env/<session>/*-hook-<n>.sh`) into every Bash call, and Git Bash drops everything past the call's 8,186th character, the command first (anthropics/claude-code#103861).",
  "The repair: dedupe those files, keeping each variable's last assignment, which leaves the same environment (self-check does it at each session start and in a check that finds the env at risk, while its envDedupe setting is on; the Bash env line says what it did), then have Claude Code read them again: in the main session, move the PowerShell tool's directory and back in two calls (`Set-Location ..`, then `Set-Location` to the folder it was in), and try Bash `echo ok`.",
  "A fresh process alone doesn't repair it: a resume reads the same files, unless the dedupe at its start shrinks them.",
].join(' ')
/** What a check's line says once it has deduped: the cached copy stays until the shell's directory moves. */
const AFTER_DEDUPE =
  "Claude Code still holds the old copy: now move the PowerShell tool's directory away and back, in two calls in the main session (`Set-Location ..`, then `Set-Location` to the folder it was in), then retry Bash"
const RESTART_HINT =
  "A fresh process usually repairs a dead tool: restart_after_turn (self-restart; it needs a safe point). Where the coordinator runs, the merger can restart this lane (`next: 'restart'`)."

/** The three fake variables one session start appends, as the Vercel plugin appends its own, each value `size` characters. */
const round = (size: number): string => ['FAKE_HINTS', 'FAKE_RESOURCES', 'FAKE_MODE'].map(name => `export ${name}="${'v'.repeat(size)}"`).join('\n') + '\n'
/** `count` session starts' appends, the values a character longer each time. */
const rounds = (count: number, from = 40): string => Array.from({ length: count }, (_, i) => round(from + i)).join('')
/** A file of exactly `total` bytes: ten copies of one variable, then a filler variable. */
function sized(total: number): string {
  const head = 'export FAKE_A=1\n'.repeat(10)
  return `${head}export FAKE_PAD="${'v'.repeat(total - head.length - 'export FAKE_PAD=""\n'.length)}"\n`
}
/** One variable holding a value long enough that the env script is `inlined` characters. */
const single = (inlined: number): string => `export FAKE_BIG="${'v'.repeat(inlined - 'export FAKE_BIG=""'.length)}"\n`

/** A text's UTF-8 bytes. */
function bytes(text: string): number {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

/** What sourcing a plain env script leaves: each variable's value and whether it is exported. */
function sourced(text: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = PLAIN.exec(line.trimEnd())
    if (m === null) throw new Error('not plain')
    const name = m[1]
    if (name === undefined) continue
    const exported = /^(?:export +|declare -x +)/.test(line) || vars[name]?.startsWith('x:') === true
    vars[name] = `${exported ? 'x' : '-'}:${m[2] ?? ''}`
  }
  return vars
}

type World = {
  /** The env folder's files, by name. */
  files?: Record<string, string>
  /** More variables of the process environment. */
  env?: Record<string, string>
  /** Without the fake profile: no Windows config folder. */
  isOffWindows?: boolean
  bash?: 'echoes' | 'empty'
  /** What the test's own SessionStart hook, beneath every plugin, appends to sessionstart-hook-1.sh: a settings hook's appends. */
  appends?: () => string
  /** A file someone appends a line to once its backup is written, between the guard's two reads of it. */
  appendBetween?: string
}

/** The engine beneath the plugin, a fake file system under ROOT, and what the plugin did. */
function engine(on: On, world: World = {}) {
  const env: Record<string, string> = world.isOffWindows ? { LOCALAPPDATA: LOCAL } : { USERPROFILE: PROFILE, LOCALAPPDATA: LOCAL }
  Object.assign(env, world.env ?? {})
  // The harness refuses a profile or local app data outside a Temp folder.
  for (const name of ['USERPROFILE', 'LOCALAPPDATA']) {
    const value = env[name]
    if (value !== undefined && !/\\Temp\\/i.test(value)) throw new Error(`${name} is outside a Temp folder`)
  }
  const disk = new Map<string, string>(Object.entries(world.files ?? {}).map(([name, text]) => [`${FOLDER}\\${name}`, text]))
  const writes: string[] = []
  const outside: string[] = []
  const logs: string[] = []
  const toasts: string[] = []
  const fsCalls: string[] = []
  const isInside = (path: string): boolean => path.startsWith(`${ROOT}\\`)
  const refuse = (path: string) => {
    outside.push(path)
    return { deny: 'outside the fake root' }
  }
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
  on('ui.log', (_, e) => {
    logs.push(String(e.text))
    return { value: undefined }
  })
  on('tool.list', () => ({ value: ['Bash', 'PowerShell'].map(name => ({ name, description: '', mcp: false })) }))
  on('tool.check', () => ({ decision: 'allow' }))
  const echo = (command: string, isEmpty: boolean) => {
    const out = isEmpty ? '' : `${/selfcheck-[0-9a-f]+/.exec(command)?.[0] ?? ''}\n`
    return { result: { stdout: out, stderr: '', interrupted: false }, text: out.trim() } as never
  }
  on('tool.call', { tool: 'Bash' }, (_, e) => echo(String(e.command), world.bash === 'empty'))
  on('tool.call', { tool: 'PowerShell' }, (_, e) => echo(String(e.command), false))
  on('fs.exists', (_, e) => {
    fsCalls.push(`exists ${e.path}`)
    if (!isInside(e.path)) return refuse(e.path)
    return { value: disk.has(e.path) || [...disk.keys()].some(key => key.startsWith(`${e.path}\\`)) }
  })
  on('fs.list', (_, e) => {
    fsCalls.push(`list ${e.path}`)
    if (!isInside(e.path)) return refuse(e.path)
    const under = `${e.path}\\`
    const entries = [...disk.entries()]
      .filter(([key]) => key.startsWith(under) && !key.slice(under.length).includes('\\'))
      .map(([key, text]) => ({ name: key.slice(under.length), kind: 'file' as const, size: bytes(text), mtimeMs: 0, isLink: false }))
    return { value: entries }
  })
  on('fs.read', (_, e) => {
    // The update check reads the plugin's own installed manifest at the session's start: it is not
    // under test here, so it is answered with no file, read from nowhere, and not counted.
    if (/[\\/]\.claude-plugin[\\/]plugin\.json$/.test(e.path)) return { deny: 'the update check is not under test here' }
    fsCalls.push(`read ${e.path}`)
    if (!isInside(e.path)) return refuse(e.path)
    const text = disk.get(e.path)
    return text === undefined ? { deny: `ENOENT: no such file, ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e) => {
    fsCalls.push(`write ${e.path}`)
    if (!isInside(e.path)) return refuse(e.path)
    disk.set(e.path, e.text)
    if (e.path.startsWith(FOLDER)) writes.push(e.path.slice(FOLDER.length + 1))
    if (world.appendBetween !== undefined && e.path === `${FOLDER}\\${world.appendBetween}.bak`) {
      const path = `${FOLDER}\\${world.appendBetween}`
      disk.set(path, `${disk.get(path) ?? ''}export FAKE_LATE=1\n`)
    }
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('classic.SessionStart', () => {
    if (world.appends !== undefined) {
      const path = `${FOLDER}\\sessionstart-hook-1.sh`
      disk.set(path, `${disk.get(path) ?? ''}${world.appends()}`)
    }
    return {}
  })
  /** A file of the env folder, by name. */
  const file = (name: string): string | undefined => disk.get(`${FOLDER}\\${name}`)
  /** The env folder's file names. */
  const names = (): string[] =>
    [...disk.keys()]
      .filter(key => key.startsWith(`${FOLDER}\\`))
      .map(key => key.slice(FOLDER.length + 1))
      .sort()
  /** Everything the plugin said: answers are checked where they are read; these are its toasts and logs. */
  const said = (): string[] => [...toasts, ...logs]
  return { disk, file, names, writes, outside, logs, toasts, fsCalls, said, clock, session }
}

const start = { cwd: 'C:\\work\\repo', surface: 'terminal', isInteractive: true } as const

/** The check's answer, as text. */
async function check($: Engine): Promise<string> {
  const done = await $.tool.call({ tool: TOOL })
  expect(done.deny).toBeUndefined()
  return String(done.result)
}

/** The env line a check gives for an env script of `inlined` characters, before what it did about it. */
const envHead = (verdict: string, inlined: number): string => {
  const left = GIT_BASH_LIMIT - WRAPPER_CHARS - inlined
  const room = left > 0 ? `${grouped(left)} left for the command` : left === 0 ? 'none left for the command' : `none left for the command (${grouped(-left)} over)`
  return `Bash env: ${verdict}: every Bash call carries ${grouped(inlined)} characters of session env, ${room} before Git Bash's cut at 8,186`
}

// The rules, on text.

test("a line that isn't a plain assignment refuses the whole file; blank and comment lines are plain, and go", () => {
  const bad = [
    'echo hello',
    'export FAKE_A=$(fake)',
    'export FAKE_A="$FAKE_B"',
    'export FAKE_A="unclosed',
    'export FAKE_A',
    'FAKE_A=one two',
    'export FAKE_A=`fake`',
    'EXPORT FAKE_A=1',
    '  export FAKE_A=1',
    'export FAKE_A=1; echo hello',
  ]
  for (const line of bad) expect(dedupe(`export FAKE_A=1\n${line}\nexport FAKE_A=2\n`)).toEqual({ refused: "1 line isn't a plain assignment" })
  expect(dedupe('echo one\necho two\nexport FAKE_A=1\n')).toEqual({ refused: "2 lines aren't plain assignments" })
  // Plain: single quotes keep a dollar sign, double quotes an escaped one; `declare -x` exports.
  const plain = ['# a note', '', '   ', "export FAKE_A='single $quoted'", 'declare -x FAKE_B=plain:/path,ok', 'FAKE_C="esc\\"aped \\$"', 'export FAKE_A=2']
  expect(dedupe(`${plain.join('\n')}\n`)).toEqual({ text: ['declare -x FAKE_B=plain:/path,ok', 'FAKE_C="esc\\"aped \\$"', 'export FAKE_A=2'].join('\n') + '\n', lines: 7, kept: 3 })
  // A byte that wasn't UTF-8 (read back as U+FFFD) is refused, not rewritten.
  expect(dedupe('export FAKE_A="\uFFFD"\nexport FAKE_A=1\n')).toEqual({ refused: "it isn't clean UTF-8 text" })
})

test("the plain test is Claude Code's own (2.1.319), character for character", () => {
  expect(PLAIN.source).toBe(String.raw`^(?:\s*(?:#.*)?|(?:export +|declare -x +)?([A-Za-z_]\w*)=((?:[\w@%+=:,./-]|'[^'\0]*'|"(?:[^"\\$` + '`' + String.raw`\0]|\\[^\0])*")*))$`)
  expect(PLAIN.flags).toBe('')
})

test('a variable an earlier line exported, set without export by its last line, refuses the file: keeping that line alone would unexport it', () => {
  expect(dedupe('export FAKE_A=1\nFAKE_A=2\n')).toEqual({ refused: 'a variable exported by one line is set without export by a later one' })
  expect(dedupe('declare -x FAKE_A=1\nFAKE_A=2\n')).toEqual({ refused: 'a variable exported by one line is set without export by a later one' })
  // The other way round is the same environment: the last line exports it.
  expect(dedupe('FAKE_A=1\nexport FAKE_A=2\n')).toEqual({ text: 'export FAKE_A=2\n', lines: 2, kept: 1 })
})

test('the last assignment of each variable is kept, in the order those lines stand, and sourcing either leaves the same variables', () => {
  const text = ['export FAKE_A=1', 'export FAKE_B=1', 'export FAKE_A=2', 'export FAKE_C=1', 'export FAKE_B=2'].join('\n') + '\n'
  expect(dedupe(text)).toEqual({ text: 'export FAKE_A=2\nexport FAKE_C=1\nexport FAKE_B=2\n', lines: 5, kept: 3 })

  // Thirty session starts' appends, each value a character longer than the last: the last start's three lines stay.
  const grown = rounds(30)
  const done = dedupe(grown)
  if ('refused' in done) throw new Error(done.refused)
  expect(done.text).toBe(round(69))
  expect(sourced(done.text)).toEqual(sourced(grown))

  // Each kept line is kept as it was: a CRLF file stays CRLF, and its last line needs no newline.
  expect(dedupe('export FAKE_A=1\r\nexport FAKE_A=2\r\n')).toEqual({ text: 'export FAKE_A=2\r\n', lines: 2, kept: 1 })
  expect(dedupe('export FAKE_A=1\nexport FAKE_A=2')).toEqual({ text: 'export FAKE_A=2\n', lines: 2, kept: 1 })
  // Nothing to drop: the same text back.
  expect(dedupe('export FAKE_A=1\n')).toEqual({ text: 'export FAKE_A=1\n', lines: 1, kept: 1 })
})

test('the verdict: BROKEN with no room left, AT RISK under 2,000, OK from 2,000', () => {
  expect(GIT_BASH_LIMIT).toBe(8186)
  expect(WRAPPER_CHARS).toBe(470)
  expect(AT_RISK_BELOW).toBe(2000)
  expect(roomLeft(7716)).toBe(0)
  expect(verdictOf(7716)).toBe('BROKEN')
  expect(verdictOf(7717)).toBe('BROKEN')
  expect(verdictOf(7715)).toBe('AT RISK')
  expect(roomLeft(5717)).toBe(1999)
  expect(verdictOf(5717)).toBe('AT RISK')
  expect(roomLeft(5716)).toBe(2000)
  expect(verdictOf(5716)).toBe('OK')
  expect(verdictOf(0)).toBe('OK')
})

test("the script is measured as Claude Code builds it: its files in the loader's order, each trimmed, the empty ones left out", () => {
  const names = ['filechanged-hook-0.sh', 'sessionstart-hook-10.sh', 'cwdchanged-hook-1.sh', 'sessionstart-hook-2.sh', 'setup-hook-3.sh']
  expect([...names].sort(byLoadOrder)).toEqual(['setup-hook-3.sh', 'sessionstart-hook-2.sh', 'sessionstart-hook-10.sh', 'cwdchanged-hook-1.sh', 'filechanged-hook-0.sh'])
  expect(inlinedLength(['  export FAKE_A=1\n', '', '\n\n', 'export FAKE_B=2\n'])).toBe('export FAKE_A=1\nexport FAKE_B=2'.length)
  expect(grouped(1234567)).toBe('1,234,567')
  expect(grouped(-284)).toBe('-284')
  expect(roomPhrase(7715)).toBe('1 left for the command')
  expect(roomPhrase(7716)).toBe('none left for the command')
  expect(roomPhrase(8000)).toBe('none left for the command (284 over)')
})

// At a session start.

test("a compaction's start dedupes the folder after the hooks beneath have appended: each variable's last line, one backup, nothing else touched", async ($, on) => {
  const before = rounds(12)
  const appended = round(99)
  const { file, names, writes, outside, said } = engine(on, {
    files: { 'sessionstart-hook-1.sh': before, 'notes.txt': 'not a hook file\n', 'sessionstart-hook-1.sh.bak-old': rounds(2) },
    appends: () => appended,
  })
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'compact', session_id: ID })
  // The appended start's three lines are all that is left: the dedupe ran after them.
  expect(file('sessionstart-hook-1.sh')).toBe(appended)
  expect(file('sessionstart-hook-1.sh.bak')).toBe(before + appended)
  expect(writes).toEqual(['sessionstart-hook-1.sh.bak', 'sessionstart-hook-1.sh'])
  expect(file('notes.txt')).toBe('not a hook file\n')
  expect(file('sessionstart-hook-1.sh.bak-old')).toBe(rounds(2))
  expect(names()).toEqual(['notes.txt', 'sessionstart-hook-1.sh', 'sessionstart-hook-1.sh.bak', 'sessionstart-hook-1.sh.bak-old'])
  expect(outside).toEqual([])
  // The debug log has names and counts, never a value.
  expect(said().some(line => line.includes(MARK))).toBe(false)
  expect(said().some(line => line.includes('sessionstart-hook-1.sh'))).toBe(true)
})

test('forty starts: the hook files never stay over 2 KB, and each keeps one backup, the text before its latest dedupe', async ($, on) => {
  let n = 0
  const { file, names, outside } = engine(on, { files: { 'sessionstart-hook-1.sh': '', 'sessionstart-hook-2.sh': '' }, appends: () => round(40 + n++) })
  await $.session.start(start)
  let deduped = 0
  for (let i = 0; i < 40; i += 1) {
    const grown = (file('sessionstart-hook-1.sh') ?? '') + round(40 + n)
    await $.classic.SessionStart({ source: i === 0 ? 'startup' : 'compact', session_id: ID })
    const now = file('sessionstart-hook-1.sh') ?? ''
    expect(bytes(now)).toBeLessThanOrEqual(DEDUPE_OVER)
    if (bytes(grown) > DEDUPE_OVER) {
      deduped += 1
      expect(now).toBe(round(40 + n - 1))
      expect(file('sessionstart-hook-1.sh.bak')).toBe(grown)
    } else expect(now).toBe(grown)
  }
  expect(deduped).toBeGreaterThan(3)
  // One backup for the file that grew; none for the empty one, which was never rewritten.
  expect(names()).toEqual(['sessionstart-hook-1.sh', 'sessionstart-hook-1.sh.bak', 'sessionstart-hook-2.sh'])
  expect(outside).toEqual([])
})

test('the threshold: hook files of exactly 2,048 bytes are left alone, duplicates and all', async ($, on) => {
  expect(bytes(sized(2048))).toBe(2048)
  const at = engine(on, { files: { 'sessionstart-hook-1.sh': sized(2048) } })
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'compact', session_id: ID })
  expect(at.writes).toEqual([])
  expect(at.file('sessionstart-hook-1.sh')).toBe(sized(2048))
  expect(at.outside).toEqual([])
})

test('the threshold, just over: 2,049 bytes are deduped', async ($, on) => {
  const over = engine(on, { files: { 'sessionstart-hook-1.sh': sized(2049) } })
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'compact', session_id: ID })
  expect(over.writes).toEqual(['sessionstart-hook-1.sh.bak', 'sessionstart-hook-1.sh'])
  expect(over.file('sessionstart-hook-1.sh')).toBe(`export FAKE_A=1\nexport FAKE_PAD="${'v'.repeat(2049 - 160 - 19)}"\n`)
})

test('the threshold counts every hook file and nothing else: two files over it together are deduped, a big non-hook file is not counted', async ($, on) => {
  const half = rounds(6)
  const { writes } = engine(on, { files: { 'sessionstart-hook-1.sh': half, 'cwdchanged-hook-0.sh': half, 'other.sh': rounds(30) } })
  expect(bytes(half)).toBeLessThan(DEDUPE_OVER)
  expect(bytes(half) * 2).toBeGreaterThan(DEDUPE_OVER)
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'compact', session_id: ID })
  expect(writes.sort()).toEqual(['cwdchanged-hook-0.sh', 'cwdchanged-hook-0.sh.bak', 'sessionstart-hook-1.sh', 'sessionstart-hook-1.sh.bak'])
})

test('a file holding a line that is not a plain assignment is left as it is; the others are still deduped', async ($, on) => {
  const odd = `${rounds(10)}echo hello\n`
  const { file, writes } = engine(on, { files: { 'sessionstart-hook-1.sh': rounds(10), 'sessionstart-hook-2.sh': odd } })
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'compact', session_id: ID })
  expect(file('sessionstart-hook-1.sh')).toBe(round(49))
  expect(file('sessionstart-hook-2.sh')).toBe(odd)
  expect(writes).toEqual(['sessionstart-hook-1.sh.bak', 'sessionstart-hook-1.sh'])
})

test('a file that changes between the read and the rewrite is left as it now is', async ($, on) => {
  const before = rounds(12)
  const { file } = engine(on, { files: { 'sessionstart-hook-1.sh': before }, appendBetween: 'sessionstart-hook-1.sh' })
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'compact', session_id: ID })
  expect(file('sessionstart-hook-1.sh')).toBe(`${before}export FAKE_LATE=1\n`)
})

test('with envDedupe off, a start rewrites nothing', { options: { envDedupe: 'off' } }, async ($, on) => {
  const { writes, fsCalls } = engine(on, { files: { 'sessionstart-hook-1.sh': rounds(30) } })
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'compact', session_id: ID })
  expect(writes).toEqual([])
  expect(fsCalls).toEqual([])
})

test("a subagent's start, or an id that isn't a session id: nothing is read or written", async ($, on) => {
  const { fsCalls } = engine(on, { files: { 'sessionstart-hook-1.sh': rounds(30) } })
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'startup', session_id: ID, agent_id: 'a1' })
  await $.classic.SessionStart({ source: 'compact', session_id: '..\\..\\elsewhere' })
  expect(fsCalls).toEqual([])
})

test('off Windows (no profile folder), a start reads nothing and a check has no env line', async ($, on) => {
  const { fsCalls } = engine(on, { files: { 'sessionstart-hook-1.sh': rounds(30) }, isOffWindows: true })
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'compact', session_id: ID })
  expect(await check($)).toBe(['self-check: no tool failed.', 'Bash: ok', 'PowerShell: ok'].join('\n'))
  // The check's own record is the only file it touches.
  expect(fsCalls.filter(call => call.includes('\\session-env\\'))).toEqual([])
})

// In a check.

test('a check says OK, with the room left, and adds no hint', async ($, on) => {
  const { writes } = engine(on, { files: { 'sessionstart-hook-1.sh': 'export FAKE_A=1\n' } })
  await $.session.start(start)
  expect(await check($)).toBe(
    [
      'self-check: no tool failed.',
      'Bash: ok',
      "Bash env: OK: every Bash call carries 15 characters of session env, 7,701 left for the command before Git Bash's cut at 8,186",
      'PowerShell: ok',
    ].join('\n'),
  )
  expect(writes).toEqual([])
})

test('a check says AT RISK, and the repair, when there is nothing to dedupe', async ($, on) => {
  const { writes } = engine(on, { files: { 'sessionstart-hook-1.sh': single(6000) } })
  await $.session.start(start)
  expect((await check($)).split('\n')).toEqual([
    'self-check: no tool failed.',
    'Bash: ok',
    "Bash env: AT RISK: every Bash call carries 6,000 characters of session env, 1,716 left for the command before Git Bash's cut at 8,186. Nothing to dedupe: each variable is set once",
    'PowerShell: ok',
    ENV_HINT,
  ])
  expect(writes).toEqual([])
})

test('a dead Bash with a BROKEN env gets the env repair, never the fresh-process one', async ($, on) => {
  engine(on, { files: { 'sessionstart-hook-1.sh': single(8000) }, bash: 'empty' })
  await $.session.start(start)
  const said = await check($)
  expect(said.split('\n')).toEqual([
    'self-check: 1 failed (Bash).',
    'Bash: failed: no output',
    "Bash env: BROKEN: every Bash call carries 8,000 characters of session env, none left for the command (284 over) before Git Bash's cut at 8,186. Nothing to dedupe: each variable is set once",
    'PowerShell: ok',
    ENV_HINT,
  ])
  expect(said).not.toContain(RESTART_HINT)
})

test('a check that finds the env at risk dedupes it, says to what, and gives the next step: the directory away and back in two calls, then Bash again', async ($, on) => {
  const grown = rounds(4, 600)
  const { file, writes, said } = engine(on, { files: { 'sessionstart-hook-1.sh': grown } })
  await $.session.start(start)
  const answer = (await check($)).split('\n')
  const inlined = grown.trim().length
  const after = round(603).trim().length
  expect(verdictOf(inlined)).toBe('AT RISK')
  expect(answer[2]).toBe(`${envHead('AT RISK', inlined)}. Deduped now to ${grouped(after)} characters (OK), the same environment. ${AFTER_DEDUPE}`)
  // The dedupe doesn't drop Claude Code's cached copy, so the line itself says what to do next.
  expect(answer[2]).toContain("now move the PowerShell tool's directory away and back, in two calls")
  expect(answer[2]).toEndWith('then retry Bash')
  expect(answer.at(-1)).toBe(ENV_HINT)
  expect(file('sessionstart-hook-1.sh')).toBe(round(603))
  expect(writes).toEqual(['sessionstart-hook-1.sh.bak', 'sessionstart-hook-1.sh'])
  expect(answer.some(line => line.includes(MARK))).toBe(false)
  expect(said().some(line => line.includes(MARK))).toBe(false)
})

test('a dead Bash with a BROKEN env of duplicates: the check dedupes it, its line gives the next step, and the env repair follows', async ($, on) => {
  const grown = rounds(5, 600)
  const { file } = engine(on, { files: { 'sessionstart-hook-1.sh': grown }, bash: 'empty' })
  await $.session.start(start)
  const said = (await check($)).split('\n')
  expect(verdictOf(grown.trim().length)).toBe('BROKEN')
  expect(said).toEqual([
    'self-check: 1 failed (Bash).',
    'Bash: failed: no output',
    `${envHead('BROKEN', grown.trim().length)}. Deduped now to ${grouped(round(604).trim().length)} characters (OK), the same environment. ${AFTER_DEDUPE}`,
    'PowerShell: ok',
    ENV_HINT,
  ])
  expect(file('sessionstart-hook-1.sh')).toBe(round(604))
})

test('with envDedupe off, a check still measures, and says the dedupe is off', { options: { envDedupe: 'off' } }, async ($, on) => {
  const grown = rounds(4, 600)
  const { writes } = engine(on, { files: { 'sessionstart-hook-1.sh': grown } })
  await $.session.start(start)
  const answer = (await check($)).split('\n')
  expect(answer[2]).toBe(`${envHead('AT RISK', grown.trim().length)}. Not deduped: the envDedupe setting is off`)
  expect(writes).toEqual([])
})

test("a check counts CLAUDE_ENV_FILE's text too, and never writes it", async ($, on) => {
  const extra = `${ROOT}\\extra-env.sh`
  const { disk, writes } = engine(on, { files: { 'sessionstart-hook-1.sh': 'export FAKE_A=1\n' }, env: { CLAUDE_ENV_FILE: extra } })
  disk.set(extra, single(6000))
  await $.session.start(start)
  const answer = (await check($)).split('\n')
  expect(answer[2]).toBe(`${envHead('AT RISK', 6000 + 1 + 15)}. Not deduped: its hook files hold 16 bytes, at or under 2,048`)
  expect(writes).toEqual([])
  expect(disk.get(extra)).toBe(single(6000))
})

test('a dead Bash with an OK env gets the fresh-process repair, not the env one', async ($, on) => {
  engine(on, { files: { 'sessionstart-hook-1.sh': 'export FAKE_A=1\n' }, bash: 'empty' })
  await $.session.start(start)
  const said = (await check($)).split('\n')
  expect(said.at(-1)).toBe(RESTART_HINT)
  expect(said).not.toContain(ENV_HINT)
})

test('at resume, a dead Bash with a BROKEN env is toasted as such, and the row carries the env repair', async ($, on) => {
  const { toasts, session, clock } = engine(on, { files: { 'sessionstart-hook-1.sh': single(8000) }, bash: 'empty' })
  await $.session.start(start)
  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  await clock.advance(10_000)
  expect(toasts).toEqual(["self-check at resume: Bash failed. Bash's session env may have grown too long; the note Claude reads says how to repair it."])
  const rows = session.appended().flatMap(row => ((row as { message?: { content?: { text?: unknown }[] } }).message?.content ?? []).map(block => String(block.text)))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toContain(ENV_HINT)
  expect(rows[0]).not.toContain(RESTART_HINT)
})
