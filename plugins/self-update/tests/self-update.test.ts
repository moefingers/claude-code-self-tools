// self-update against the engine's own test kit. With `autoUpdate` empty (the default) nothing of it runs, reads or
// writes. Set, a session's start or a turn's end makes one look when the machine's last is five minutes old: the lock
// taken, each named marketplace with a plugin installed here refreshed, every install record of it updated in its own
// scope and from its own folder, the lock given back; one line and one toast per install, nothing when nothing changed.
// It never runs for a marketplace that isn't named or a plugin with no record. A session whose plugins were loaded
// before an install reloads itself at idle, twice at most for one install. Failures: tried again at the next look,
// which comes later for each look in a row that couldn't reach a marketplace (never for a plugin's own update failing);
// one toast after three. A command the script ended past its time, or that gave no answer at all, ends its
// marketplace's steps for the look. A step that couldn't be started is a failure like any other. Another session's
// fresh lock or fresh look: nothing; a lock a dead process left: taken over. Another plugin that keeps plugins current
// shares the lock and never the state file. A reload this plugin runs and a look never overlap in the session.
//
// The hooks registered here sit beneath the plugin and stand for the engine (its files, its commands) and for the
// machine: the lock's two scripts and UPDATE_SCRIPT are answered as their PowerShell would, the stand-in for `claude
// plugin` moving a record to the version its marketplace has. No real `claude`, PowerShell or network is reached. Paths
// are matched by their ends, so the file reads the same on any host.
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { ENDED, NO_CLAUDE, RELEASE_SCRIPT, TAKE_SCRIPT, UPDATE_SCRIPT } from '../hooks/scripts'
import { RELOAD_LINE, RESTART_LINE } from '../hooks/update-logic'

const START = 1_700_000_000_000
const MINUTE = 60_000
const HOME = 'C:\\Users\\tester'
const LOCAL = `${HOME}\\AppData\\Local`
const CACHE = `${HOME}\\.claude\\plugins\\cache`
const MINE = 'example-plugins'
const TOOLS = 'claude-code-self-tools'
const BOTH = `${MINE}, ${TOOLS}`
const WEB = 'D:\\work\\web'
const GONE = 'D:\\work\\gone'
const UNTIL_MS = 3000
const start = { cwd: '/work/web', surface: 'terminal', isInteractive: true } as const
const setTimer = (globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout
const RELOADS = 'sessions reload at their next idle moment'
const NO_RELOADS = 'reloadAfterUpdate is off, so a session loads it at its next start or /reload-plugins'

type Rec = { scope: string; installPath: string; version: string; projectPath?: string }
type Run = { kind: string; name: string; scope: string; cwd: string }

/** A path as compared here: each separator `/`, in one case. */
const norm = (path: string) => path.replace(/\\/g, '/').toLowerCase()
const STATE_FILE = /auto-update[\\/][0-9a-f]{8}\.self-update\.json$/
/** The state file another plugin that keeps plugins current keeps beside the same lock: never read or written here. */
const OTHER_STATE = /auto-update[\\/][0-9a-f]{8}\.json$/
const LOCK_FILE = /auto-update[\\/][0-9a-f]{8}\.lock$/
const rec = (plugin: string, marketplace: string, version: string, extra: Partial<Rec> = {}): Rec => ({ scope: 'user', installPath: `${CACHE}\\${marketplace}\\${plugin}\\${version}`, version, ...extra })

function world(on: On, how: { windows?: boolean } = {}) {
  const state = {
    /** installed_plugins.json's `plugins`: a plugin in the user's scope and two local ones (one whose project is gone), two self tools, and plugins of two marketplaces the setting doesn't name. */
    records: {
      'other-tool@vendor-plugins': [rec('other-tool', 'vendor-plugins', '0.51.0')],
      [`widget@${MINE}`]: [rec('widget', MINE, '1.4.0'), rec('widget', MINE, '1.4.0', { scope: 'local', projectPath: WEB }), rec('widget', MINE, '1.4.0', { scope: 'local', projectPath: GONE })],
      [`self-wake@${TOOLS}`]: [rec('self-wake', TOOLS, '0.4.0')],
      [`self-exit@${TOOLS}`]: [rec('self-exit', TOOLS, '0.1.11')],
      'other@someone-elses': [rec('other', 'someone-elses', '1.0.0')],
    } as Record<string, Rec[]>,
    /** What each marketplace has now: an update moves a record to it. */
    available: {} as Record<string, string>,
    /** Names (a marketplace, or <plugin>@<marketplace>) whose command fails. */
    failing: new Set<string>(),
    /** Names whose command the script ended past its time, with its whole tree. */
    ending: new Set<string>(),
    /** Names whose script never answers (the engine's own timeout is all that ends the wait). */
    silent: new Set<string>(),
    /** A command from the project's folder can't be started (the folder can't be a working folder). */
    webUnstartable: false,
    /** Names whose command can't be started at all. */
    unstartable: new Set<string>(),
    noClaude: false,
    /** The state file can't be written; the install records can't be read. */
    stateUnwritable: false,
    recordsUnreadable: false,
    /** A lock another look left, as its file holds it: there before this session's first take. */
    foreignLock: undefined as string | undefined,
    draft: '',
    agents: [] as Array<{ id: string; status: string }>,
    /** /reload-plugins answers only once released (the module it ran in is replaced, or it hangs); else at once. */
    reloadHangs: false,
  }
  /** The state file, as last written (or as a test puts it there, for another session's look). */
  let stateFile: string | undefined
  /** While set, every command of a look stays out (its script hasn't answered yet). */
  let gate: Promise<void> | undefined
  /** While set, /reload-plugins stays out. */
  let reloadGate: Promise<void> | undefined
  let openReload: () => void = () => undefined
  const locks = new Map<string, string>()
  const lockRuns: Array<{ op: 'take' | 'release'; answer: string }> = []
  const runs: Run[] = []
  /** Every program started that is not one of the three scripts by Windows PowerShell: its argument vector. */
  const others: string[][] = []
  const reads: string[] = []
  const writes: string[] = []
  const commands: Array<{ command: string }> = []
  /** For each /reload-plugins: whether the lock was held then, and how many looks had ended. */
  const reloadsAt: Array<{ lockHeld: boolean; looks: number }> = []
  const toasts: string[] = []
  /** The transcript's lines, and the debug log's. */
  const logs: string[] = []
  const debug: string[] = []
  const looks = () => lockRuns.filter(r => r.op === 'release').length
  // A Windows machine, unless told otherwise (then one with a home folder and none of Windows' variables).
  mock.env(on, how.windows === false ? { HOME: '/home/tester' } : { OS: 'Windows_NT', USERPROFILE: HOME, LOCALAPPDATA: LOCAL, SystemRoot: 'C:\\Windows' })
  on('fs.exists', (_, e) => ({ value: norm(e.path).endsWith(norm(WEB)) }))
  on('fs.read', (_, e) => {
    reads.push(e.path)
    if (e.path.endsWith('installed_plugins.json') && !state.recordsUnreadable) return { value: JSON.stringify({ version: 2, plugins: state.records }) }
    if (STATE_FILE.test(e.path) && stateFile !== undefined) return { value: stateFile }
    // The other plugin's state file is there, with an install of its own: never read by this plugin.
    if (OTHER_STATE.test(e.path)) return { value: JSON.stringify({ v: 1, at: START, fails: 0, told: false, installed: START + 999 * MINUTE }) }
    return { deny: `ENOENT: no such file or directory, open '${e.path}'` }
  })
  on('fs.stat', (_, e) => ({ deny: `ENOENT: no such file or directory, stat '${e.path}'` }))
  on('fs.list', () => ({ value: [] }))
  on('fs.write', (_, e) => {
    writes.push(e.path)
    if (!STATE_FILE.test(e.path) || state.stateUnwritable) return { deny: 'not in this test' }
    stateFile = e.text
    return { value: undefined }
  })
  const ran = (exitCode: number, stdout: string, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', async (_, e) => {
    const script = typeof e.init?.stdin === 'string' ? e.init.stdin : ''
    const env: Record<string, string | undefined> = e.init?.env ?? {}
    if (!String(e.argv[0]).toLowerCase().endsWith('\\system32\\windowspowershell\\v1.0\\powershell.exe') || (script !== TAKE_SCRIPT && script !== RELEASE_SCRIPT && script !== UPDATE_SCRIPT)) {
      others.push(e.argv.map(String))
      return ran(1, '')
    }
    if (script !== UPDATE_SCRIPT) {
      // The lock's two scripts: TAKE makes it, leaves a fresh one alone and overwrites one 90 s old; RELEASE gives back only its own text.
      const path = String(env.RC_LOCK_PATH)
      const text = String(env.RC_LOCK_TEXT)
      if (!LOCK_FILE.test(path)) return ran(1, '')
      if (state.foreignLock !== undefined) {
        locks.set(path, state.foreignLock)
        state.foreignLock = undefined
      }
      const answer = (() => {
        if (script === RELEASE_SCRIPT) {
          if (!locks.has(path)) return 'gone'
          if (locks.get(path) !== text) return 'kept'
          locks.delete(path)
          return 'released'
        }
        const held = locks.get(path)
        if (held !== undefined) {
          const lock = JSON.parse(held) as { by: string; at: number }
          const age = clock.now() - lock.at
          if (age <= 90_000 && age >= -90_000) return `held|${lock.by}|${age}`
        }
        locks.set(path, text)
        return 'taken'
      })()
      lockRuns.push({ op: script === TAKE_SCRIPT ? 'take' : 'release', answer })
      return ran(0, `${answer}\r\n`)
    }
    // UPDATE_SCRIPT, as its PowerShell would answer with a `claude plugin` that updates only what is installed.
    const run: Run = { kind: String(env.SELF_UPDATE_KIND), name: String(env.SELF_UPDATE_NAME), scope: String(env.SELF_UPDATE_SCOPE), cwd: String(e.init?.cwd) }
    runs.push(run)
    if (state.unstartable.has(run.name) || (state.webUnstartable && norm(run.cwd).endsWith(norm(WEB)))) return { deny: 'spawn ENOTDIR' }
    if (gate !== undefined) await gate
    if (state.silent.has(run.name)) await new Promise(() => undefined)
    if (state.noClaude) return ran(97, `${NO_CLAUDE}\r\n`)
    if (state.ending.has(run.name)) return ran(95, `Updating ${run.name}...\r\n\r\n${ENDED}\r\n`)
    if (state.failing.has(run.name)) return ran(1, 'Working...\r\n\r\nself-update: exit 1\r\n', `warning: one try left\r\nError: the ${run.kind} could not be ${run.kind === 'marketplace' ? 'refreshed' : 'updated'}\r\n`)
    if (run.kind === 'marketplace') return ran(0, `Updating marketplace: ${run.name}...\r\nSuccessfully updated marketplace: ${run.name}\r\n\r\nself-update: exit 0\r\n`)
    const mine = (state.records[run.name] ?? []).find(r => r.scope === run.scope && (r.scope === 'user' ? norm(run.cwd).endsWith(norm(HOME)) : r.projectPath !== undefined && norm(run.cwd).endsWith(norm(r.projectPath))))
    if (mine === undefined) return ran(1, '\r\nself-update: exit 1\r\n', `Plugin "${run.name}" is not installed in ${run.scope} scope\r\n`)
    const version = state.available[run.name]
    if (version === undefined || version === mine.version) return ran(0, `${run.name} is already at the latest version (${mine.version}).\r\n\r\nself-update: exit 0\r\n`)
    const from = mine.version
    mine.version = version
    mine.installPath = mine.installPath.replace(/[^\\]+$/, version)
    return ran(0, `Plugin "${run.name}" updated from ${from} to ${version}.\r\n\r\nself-update: exit 0\r\n`)
  })
  on('prompt.read', () => ({ value: { text: state.draft, cursor: state.draft.length } }))
  on('agent.list', () => ({ value: state.agents as never }))
  mock.store(on, {})
  const clock = mock.clock(on, { now: START })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.id', () => ({ value: 'aaaaaaaa-0000-4000-8000-000000000001' }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__self-update__${e.name}` } }))
  on('http.fetch', () => ({ deny: 'no network in this test' }))
  on('command.run', async (_, e) => {
    commands.push({ command: e.command })
    if (e.command === 'reload-plugins') {
      reloadsAt.push({ lockHeld: locks.size > 0, looks: looks() })
      if (state.reloadHangs) {
        reloadGate ??= new Promise<void>(resolve => (openReload = resolve))
        await reloadGate
      }
      return { text: 'Reloaded: 4 plugins · 2 skills' }
    }
    return { text: `unknown command ${e.command}` }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    const sink = e.to === 'debug' ? debug : logs
    sink.push(e.text)
    return { value: undefined }
  })
  const later = async (ms: number) => {
    await clock.advance(ms)
    await clock.advance(0)
  }
  const until = async (cond: () => boolean, what: string): Promise<void> => {
    const by = performance.now() + UNTIL_MS
    for (;;) {
      await clock.settle()
      if (cond()) return
      if (performance.now() >= by) throw new Error(`${what} didn't come within ${UNTIL_MS / 1000} s of real time, the clock held at ${(clock.now() - START) / 1000} s`)
      await new Promise<void>(resolve => {
        setTimer?.(resolve, 5)
      })
    }
  }
  /** Background work let run and the clock moved a second at a time (ten at most) until `cond` holds: for what a timer of the plugin's brings, as its reload a beat after it is asked for. */
  const soon = async (cond: () => boolean, what: string): Promise<void> => {
    for (let second = 0; second < 10; second += 1) {
      for (let i = 0; i < 40; i += 1) {
        await clock.settle()
        if (cond()) return
        await new Promise<void>(resolve => {
          setTimer?.(resolve, 5)
        })
      }
      await later(1_000)
    }
    await clock.settle()
    if (!cond()) throw new Error(`${what} didn't come within ten seconds of the clock`)
  }
  return {
    state,
    clock,
    locks,
    lockRuns,
    runs,
    others,
    reads,
    writes,
    commands,
    reloadsAt,
    toasts,
    logs,
    debug,
    later,
    until,
    soon,
    looks,
    /** Background work let run, then the clock moved a beat: what was going to happen has. */
    quiet: async () => {
      for (let i = 0; i < 3; i += 1) {
        await clock.settle()
        await later(1_000)
      }
    },
    /** From now, every command of a look stays out until `release` is called. */
    hold: () => {
      let open: () => void = () => undefined
      gate = new Promise<void>(resolve => (open = resolve))
      return {
        release: () => {
          gate = undefined
          open()
        },
      }
    },
    /** A /reload-plugins left out (reloadHangs) answers now. */
    answerReload: () => {
      state.reloadHangs = false
      openReload()
      reloadGate = undefined
    },
    /** The state file, read; and put there as another session's look would leave it. */
    kept: () => (stateFile === undefined ? undefined : (JSON.parse(stateFile) as { at: number; fails: number; told: boolean; failed?: string; installed?: number; unreached?: number })),
    put: (kept: { at: number; installed?: number; fails?: number }) => {
      stateFile = JSON.stringify({ v: 1, fails: 0, told: false, ...kept })
    },
    /** This look's commands as typed, with where each ran. */
    said: (from = 0) => runs.slice(from).map(r => `${r.kind === 'marketplace' ? `plugin marketplace update ${r.name}` : `plugin update ${r.name} --scope ${r.scope}`} @ ${norm(r.cwd).endsWith(norm(WEB)) ? 'web' : norm(r.cwd).endsWith(norm(HOME)) ? 'home' : r.cwd}`),
    reloads: () => commands.filter(c => c.command === 'reload-plugins').length,
  }
}

type World = ReturnType<typeof world>

async function begin($: Engine, w: World, how: { isInteractive?: boolean } = {}) {
  await $.session.start({ ...start, ...how })
  await w.later(1_000)
}

let turns = 0
/** A main-loop turn, its end, and the beat after it. */
async function turn($: Engine, w: World) {
  turns += 1
  await $.turn.start({ text: 'working', turnId: `t${turns}` })
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: `t${turns}`, reason: 'answer' })
  await w.later(1_000)
}

/** One look of this session's, from its lock taken to its lock given back. */
async function look(w: World, n: number) {
  await w.until(() => w.looks() >= n, `look ${n}'s end`)
}

const ONE_LOOK = [
  `plugin marketplace update ${MINE} @ home`,
  `plugin update widget@${MINE} --scope user @ home`,
  `plugin update widget@${MINE} --scope local @ web`,
  `plugin marketplace update ${TOOLS} @ home`,
  `plugin update self-wake@${TOOLS} --scope user @ home`,
  `plugin update self-exit@${TOOLS} --scope user @ home`,
]
/** A program that could only be the updater's: PowerShell, cmd, claude or taskkill by its name, or anything given the word `plugin`. */
const updaterLike = (argv: string[]) => /(?:^|[\\/])(?:powershell|pwsh|cmd|claude|taskkill)(?:\.exe|\.cmd)?$/i.test(argv[0] ?? '') || argv.includes('plugin')
/** What this plugin read or wrote of the machine's update files and install records. */
const touched = (paths: readonly string[]) => paths.filter(p => p.endsWith('installed_plugins.json') || /auto-update/.test(p))

describe('off by default', () => {
  test('with autoUpdate empty nothing of it runs, reads or writes, at a start, at turns’ ends, or hours on, and update_status says so', async ($, on) => {
    const w = world(on)
    w.state.available = { [`widget@${MINE}`]: '1.5.0', [`self-wake@${TOOLS}`]: '0.4.1' }
    // Another session's look installed something: with the setting empty, this one doesn't even read of it.
    w.put({ at: START + 30 * MINUTE, installed: START + 30 * MINUTE })
    await begin($, w)
    for (let i = 0; i < 4; i += 1) {
      await turn($, w)
      await w.later(20 * MINUTE)
    }
    const status = await $.tool.call({ tool: 'mcp__self-update__update_status' })
    await w.quiet()
    expect(String(status.result)).toBe('self-update is off on this machine: autoUpdate is empty, so nothing runs, is read or is written. Setting it to marketplace names, comma-separated, turns it on.')
    expect(w.runs).toEqual([])
    expect(w.lockRuns).toEqual([])
    // No PowerShell, cmd, claude or taskkill by any other path either, and nothing given the word `plugin`.
    expect(w.others.filter(updaterLike)).toEqual([])
    expect(w.writes).toEqual([])
    expect(touched(w.reads)).toEqual([])
    expect(w.reloads()).toBe(0)
    expect(w.toasts.filter(t => /updated|self-update/.test(t))).toEqual([])
    expect([...w.logs, ...w.debug].filter(l => /autoUpdate|self-update/.test(l))).toEqual([])
    expect(w.state.records[`widget@${MINE}`]!.map(r => r.version)).toEqual(['1.4.0', '1.4.0', '1.4.0'])
  })

  test('a value that is not marketplace names turns it off, the names that fit too, and says why once', { options: { autoUpdate: `${MINE}, --force` } }, async ($, on) => {
    const w = world(on)
    await begin($, w)
    for (let i = 0; i < 3; i += 1) {
      await turn($, w)
      await w.later(6 * MINUTE)
    }
    await w.quiet()
    expect(w.runs).toEqual([])
    expect(w.lockRuns).toEqual([])
    expect(w.others.filter(updaterLike)).toEqual([])
    expect(w.writes).toEqual([])
    expect(touched(w.reads)).toEqual([])
    expect(w.logs.filter(l => l.includes('autoUpdate is off'))).toEqual([`self-update: autoUpdate is off: "--force" is not a marketplace's name (letters, digits, dots, dashes and underscores, a letter or a digit first, 64 at most).`])
  })
})

describe('on: one look per five minutes, only what is named and installed', () => {
  // reloadAfterUpdate off here: no reload of this session's comes between.
  test('a start’s look: the lock, each named marketplace refreshed, each install record updated in its scope from its folder, one line and toast per install, the lock given back; then nothing for five minutes; then a look that changes nothing says nothing', { options: { autoUpdate: BOTH, reloadAfterUpdate: 'off' } }, async ($, on) => {
    const w = world(on)
    // What the marketplaces have: two installed here newer, one not installed here, and two of marketplaces the setting doesn't name.
    w.state.available = { [`widget@${MINE}`]: '1.5.0', [`self-wake@${TOOLS}`]: '0.4.1', [`self-check@${TOOLS}`]: '0.3.0', 'other-tool@vendor-plugins': '0.52.0', 'other@someone-elses': '2.0.0' }
    await begin($, w)
    await look(w, 1)
    // The user's scope from the home folder, a local one from its own project; the one whose project is gone, not at all.
    expect(w.said()).toEqual(ONE_LOOK)
    expect(w.lockRuns).toEqual([
      { op: 'take', answer: 'taken' },
      { op: 'release', answer: 'released' },
    ])
    expect(w.locks.size).toBe(0)
    // Never a marketplace that isn't named, never a plugin with no record, and no other program.
    expect(w.runs.some(r => /vendor|someone-elses|self-check/.test(r.name))).toBe(false)
    expect(w.others.filter(updaterLike)).toEqual([])
    expect(w.state.records['other-tool@vendor-plugins']![0]!.version).toBe('0.51.0')
    expect(w.state.records['other@someone-elses']![0]!.version).toBe('1.0.0')
    expect(w.state.records[`self-check@${TOOLS}`]).toBeUndefined()
    // What it installed, said once each (two scopes of one plugin are one line), in the transcript and as a toast;
    // with reloadAfterUpdate off no session reloads itself, and the line doesn't say one does.
    const lines = [`self-update: updated widget 1.4.0 to 1.5.0 from ${MINE}; ${NO_RELOADS}`, `self-update: updated self-wake 0.4.0 to 0.4.1 from ${TOOLS}; ${NO_RELOADS}`]
    expect(w.toasts.filter(t => t.startsWith('self-update: updated '))).toEqual(lines)
    expect(w.logs.filter(l => l.includes(': updated '))).toEqual(lines)
    expect(w.state.records[`widget@${MINE}`]!.map(r => r.version)).toEqual(['1.5.0', '1.5.0', '1.4.0'])
    // The machine's record: the look's time, no failure, and when it installed.
    const first = w.kept()!
    expect(first).toEqual({ v: 1, at: expect.any(Number), fails: 0, told: false, installed: first.at })
    expect(first.at).toBeGreaterThanOrEqual(START)
    // Turns' ends inside five minutes: no look, not even the lock.
    await turn($, w)
    await turn($, w)
    await w.later(4 * MINUTE)
    await turn($, w)
    await w.quiet()
    expect(w.runs).toHaveLength(ONE_LOOK.length)
    expect(w.lockRuns).toHaveLength(2)
    // Five minutes on, the next turn's end looks again: the same commands, nothing newer, nothing said.
    await w.later(MINUTE)
    await turn($, w)
    await look(w, 2)
    expect(w.said(ONE_LOOK.length)).toEqual(ONE_LOOK)
    expect(w.toasts.filter(t => t.startsWith('self-update: updated '))).toEqual(lines)
    expect(w.kept()).toMatchObject({ fails: 0, installed: first.installed })
    expect(w.kept()!.at).toBeGreaterThan(START + 5 * MINUTE)
    expect(w.reloads()).toBe(0)
  })

  test('only the marketplace named: the other’s plugins are never run for, though newer is there', { options: { autoUpdate: TOOLS, reloadAfterUpdate: 'off' } }, async ($, on) => {
    const w = world(on)
    w.state.available = { [`widget@${MINE}`]: '1.5.0', [`self-wake@${TOOLS}`]: '0.4.1' }
    await begin($, w)
    await look(w, 1)
    expect(w.said()).toEqual(ONE_LOOK.slice(3))
    expect(w.state.records[`widget@${MINE}`]!.map(r => r.version)).toEqual(['1.4.0', '1.4.0', '1.4.0'])
    expect(w.toasts.filter(t => t.startsWith('self-update: updated '))).toEqual([`self-update: updated self-wake 0.4.0 to 0.4.1 from ${TOOLS}; ${NO_RELOADS}`])
  })

  test('a named marketplace with nothing installed here (a misspelt name): the lock and the records, no command at all, and one line in the transcript, once', { options: { autoUpdate: `${TOOLS}, claude-code-self-tool`, reloadAfterUpdate: 'off' } }, async ($, on) => {
    const w = world(on)
    await begin($, w)
    await look(w, 1)
    expect(w.said()).toEqual(ONE_LOOK.slice(3))
    expect(w.kept()).toEqual({ v: 1, at: expect.any(Number), fails: 0, told: false })
    const idle = 'self-update: autoUpdate names claude-code-self-tool, but no plugin from a marketplace of that name is installed on this machine in a scope it updates, so nothing is updated for it (a name is matched exactly, capitals included).'
    expect(w.logs.filter(l => l.includes('autoUpdate names'))).toEqual([idle])
    // The next looks say nothing more of it.
    for (let n = 2; n <= 3; n += 1) {
      await w.later(6 * MINUTE)
      await turn($, w)
      await look(w, n)
    }
    expect(w.logs.filter(l => l.includes('autoUpdate names'))).toEqual([idle])
    expect(w.runs.some(r => r.name.includes('claude-code-self-tool') && !r.name.includes(TOOLS))).toBe(false)
  })

  test('headless: no look', { options: { autoUpdate: BOTH } }, async ($, on) => {
    const w = world(on)
    await begin($, w, { isInteractive: false })
    await turn($, w)
    await w.quiet()
    expect(w.runs).toEqual([])
    expect(w.lockRuns).toEqual([])
  })

  test('the state file can’t be written, or the install records can’t be read: the lock, no command at all, and the lock given back', { options: { autoUpdate: BOTH, reloadAfterUpdate: 'off' } }, async ($, on) => {
    const w = world(on)
    w.state.stateUnwritable = true
    await begin($, w)
    await look(w, 1)
    expect(w.runs).toEqual([])
    expect(w.debug.some(l => l.includes("self-update: no look now: its state file couldn't be written"))).toBe(true)
    w.state.stateUnwritable = false
    w.state.recordsUnreadable = true
    await w.later(6 * MINUTE)
    await turn($, w)
    await look(w, 2)
    expect(w.runs).toEqual([])
    expect(w.debug.some(l => l.includes("self-update: no look now: Claude Code's install records can't be read"))).toBe(true)
    expect(w.locks.size).toBe(0)
    w.state.recordsUnreadable = false
    await w.later(6 * MINUTE)
    await turn($, w)
    await look(w, 3)
    expect(w.said()).toEqual(ONE_LOOK)
  })

  test('update_status says what the machine keeps: the names, the last look, the failures and the last install', { options: { autoUpdate: BOTH, reloadAfterUpdate: 'off' } }, async ($, on) => {
    const w = world(on)
    w.state.failing.add(`self-exit@${TOOLS}`)
    w.state.available = { [`self-wake@${TOOLS}`]: '0.4.1' }
    // No look at the start (another session's was a minute before): the turn's end five minutes on makes one, after this session loaded.
    w.put({ at: START - MINUTE })
    await begin($, w)
    await w.later(5 * MINUTE)
    await turn($, w)
    await look(w, 1)
    await w.later(2 * MINUTE)
    const status = String((await $.tool.call({ tool: 'mcp__self-update__update_status' })).result)
    expect(status).toBe(
      `autoUpdate names ${MINE}, ${TOOLS}. reloadAfterUpdate is off. Last look: 2 min ago; the next comes at a turn's end 5 minutes after it. 1 look in a row had a failure; the last: claude plugin update self-exit@${TOOLS} --scope user: Error: the plugin could not be updated. Last install: 2 min ago; this session loaded its plugins before it, and reloadAfterUpdate is off: /reload-plugins or a new session loads it.`,
    )
    // A subagent is refused: the status is the main session's.
    expect((await $.tool.call({ tool: 'mcp__self-update__update_status', agentId: 'a1' })).deny).toContain("A subagent can't read self-update's status")
  })
})

describe('one updater per machine at a time', () => {
  test('another session looked a minute ago: nothing, not even the lock; once that look is five minutes old, a turn’s end looks', { options: { autoUpdate: BOTH, reloadAfterUpdate: 'off' } }, async ($, on) => {
    const w = world(on)
    w.put({ at: START - MINUTE })
    await begin($, w)
    await turn($, w)
    await w.later(3 * MINUTE)
    await turn($, w)
    await w.quiet()
    expect(w.runs).toEqual([])
    expect(w.lockRuns).toEqual([])
    await w.later(MINUTE)
    await turn($, w)
    await look(w, 1)
    expect(w.said()).toEqual(ONE_LOOK)
  })

  test('another plugin that keeps plugins current holds the lock: no command; a lock a dead process left is taken over once it is old, at this process’s next look; that plugin’s state file is never read or written', { options: { autoUpdate: BOTH, reloadAfterUpdate: 'off' } }, async ($, on) => {
    const w = world(on)
    w.state.foreignLock = JSON.stringify({ v: 1, by: 'another-updater', at: START - 10_000 })
    await begin($, w)
    await w.until(() => w.lockRuns.length >= 1, 'the first take')
    await w.quiet()
    expect(w.lockRuns).toEqual([{ op: 'take', answer: expect.stringMatching(/^held\|another-updater\|/) }])
    expect(w.runs).toEqual([])
    expect(w.debug.some(l => /^self-update: no look now: another look holds its lock \(taken \d+ s ago\)\.$/.test(l))).toBe(true)
    // Its holder never gave it back (it died). This process asks again no sooner than five minutes on.
    await turn($, w)
    await w.quiet()
    expect(w.lockRuns).toHaveLength(1)
    await w.later(5 * MINUTE)
    await turn($, w)
    await look(w, 1)
    expect(w.lockRuns.slice(1)).toEqual([
      { op: 'take', answer: 'taken' },
      { op: 'release', answer: 'released' },
    ])
    expect(w.said()).toEqual(ONE_LOOK)
    // The other plugin's state file, beside the same lock, is neither read nor written.
    expect([...w.reads, ...w.writes].filter(p => OTHER_STATE.test(p))).toEqual([])
    expect(w.writes.every(p => STATE_FILE.test(p))).toBe(true)
  })
})

describe('failures: tried again at the next look; the wait stretches only while a marketplace can’t be reached; one toast after three in a row', () => {
  test('one marketplace’s refresh fails and the other’s passes: its plugins are left for the next look, the other marketplace goes on, and the wait stretches (10, 20, 40 minutes, then an hour); the third such look says so once; a look that reaches both starts over', { options: { autoUpdate: BOTH, reloadAfterUpdate: 'off' } }, async ($, on) => {
    const w = world(on)
    w.state.failing.add(MINE)
    await begin($, w)
    await look(w, 1)
    const failed = [ONE_LOOK[0], ...ONE_LOOK.slice(3)]
    expect(w.said()).toEqual(failed)
    // What it said on standard error, not the progress it printed before.
    const why = `claude plugin marketplace update ${MINE}: Error: the marketplace could not be refreshed`
    expect(w.kept()).toMatchObject({ fails: 1, told: false, failed: why, unreached: 1 })
    // Never a fast loop: turns' ends right after run nothing; nor does one 6 minutes on, where a look that passed would have had its next.
    for (let i = 0; i < 3; i += 1) await turn($, w)
    await w.later(6 * MINUTE)
    await turn($, w)
    await w.quiet()
    expect(w.runs).toHaveLength(failed.length)
    expect(w.lockRuns).toHaveLength(2)
    const toastsOf = () => w.toasts.filter(t => t.includes('looks in a row'))
    // After one failing look the next comes 10 minutes on, then 20, then 40.
    for (const [n, minutes] of [
      [2, 10],
      [3, 20],
      [4, 40],
    ] as const) {
      // A minute short of its wait (counted from the last look's end): still nothing.
      await w.later((minutes - (n === 2 ? 8 : 1)) * MINUTE)
      await turn($, w)
      await w.quiet()
      expect(w.looks()).toBe(n - 1)
      await w.later(2 * MINUTE)
      await turn($, w)
      await look(w, n)
      expect(w.kept()).toMatchObject({ fails: n, told: n >= 3, unreached: n })
      expect(toastsOf()).toHaveLength(n >= 3 ? 1 : 0)
    }
    expect(toastsOf()).toEqual([`self-update: couldn't reach a marketplace 3 looks in a row; it goes on trying, less often (once an hour at the least), until a look reaches them all; the last: ${why}`])
    expect(w.runs).toHaveLength(4 * failed.length)
    // After four, an hour; and the marketplace answers again: the count starts over, and the five minutes come back.
    await w.later(58 * MINUTE)
    await turn($, w)
    await w.quiet()
    expect(w.looks()).toBe(4)
    w.state.failing.clear()
    await w.later(3 * MINUTE)
    await turn($, w)
    await look(w, 5)
    expect(w.said(4 * failed.length)).toEqual(ONE_LOOK)
    expect(w.kept()).toMatchObject({ fails: 0, told: false })
    expect(w.kept()).not.toHaveProperty('failed')
    expect(w.kept()).not.toHaveProperty('unreached')
    expect(toastsOf()).toHaveLength(1)
    await w.later(6 * MINUTE)
    await turn($, w)
    await look(w, 6)
  })

  test('a command the script ended past its time, with every process it started: a failure, and its marketplace’s other steps wait for the next look; the other marketplace goes on', { options: { autoUpdate: BOTH, reloadAfterUpdate: 'off' } }, async ($, on) => {
    const w = world(on)
    w.state.ending.add(`widget@${MINE}`)
    await begin($, w)
    await look(w, 1)
    // The user's scope ran past its time: the local scope of the same marketplace isn't tried in this look.
    expect(w.said()).toEqual([ONE_LOOK[0], ONE_LOOK[1], ...ONE_LOOK.slice(3)])
    expect(w.kept()).toMatchObject({ fails: 1, failed: `claude plugin update widget@${MINE} --scope user: its 75 s ran out, and whatever it had started was ended with it` })
    // Its marketplace was reached (the refresh passed): the wait to the next look is not stretched.
    expect(w.kept()).not.toHaveProperty('unreached')
    expect(w.locks.size).toBe(0)
    await w.later(6 * MINUTE)
    await turn($, w)
    await look(w, 2)
  })

  test('a plugin’s own update fails at every look (a retired plugin’s record, say), every refresh passing: recorded and said, one toast after three, and the looks keep coming every five minutes', { options: { autoUpdate: BOTH, reloadAfterUpdate: 'off' } }, async ($, on) => {
    const w = world(on)
    w.state.failing.add(`self-exit@${TOOLS}`)
    w.state.available = { [`self-wake@${TOOLS}`]: '0.4.1' }
    await begin($, w)
    await look(w, 1)
    const why = `claude plugin update self-exit@${TOOLS} --scope user: Error: the plugin could not be updated`
    // Eight looks, each six minutes after the last: none is put off, every step is tried each time, and the count that stretches the wait never starts.
    for (let n = 1; n <= 8; n += 1) {
      if (n > 1) {
        await w.later(6 * MINUTE)
        await turn($, w)
        await look(w, n)
      }
      expect(w.said((n - 1) * ONE_LOOK.length)).toEqual(ONE_LOOK)
      expect(w.kept()).toMatchObject({ fails: n, told: n >= 3, failed: why })
      expect(w.kept()).not.toHaveProperty('unreached')
    }
    // Said once, with no word of the looks coming less often; and the other plugin's newer version was installed at the first look all the same.
    expect(w.toasts.filter(t => t.includes('looks in a row'))).toEqual([`self-update: failed 3 looks in a row; it goes on trying at every look; the last: ${why}`])
    expect(w.toasts.filter(t => t.startsWith('self-update: updated '))).toEqual([`self-update: updated self-wake 0.4.0 to 0.4.1 from ${TOOLS}; ${NO_RELOADS}`])
  })

  test('a refresh that can’t be started is a marketplace not reached: its plugins wait, the other marketplace goes on, and the wait stretches', { options: { autoUpdate: BOTH, reloadAfterUpdate: 'off' } }, async ($, on) => {
    const w = world(on)
    w.state.unstartable.add(MINE)
    await begin($, w)
    await look(w, 1)
    expect(w.said()).toEqual([ONE_LOOK[0], ...ONE_LOOK.slice(3)])
    expect(w.kept()).toMatchObject({ fails: 1, unreached: 1, failed: `claude plugin marketplace update ${MINE}: it couldn't be started` })
    await w.later(6 * MINUTE)
    await turn($, w)
    await w.quiet()
    expect(w.looks()).toBe(1)
    await w.later(5 * MINUTE)
    await turn($, w)
    await look(w, 2)
    expect(w.kept()).toMatchObject({ fails: 2, unreached: 2 })
  })

  test('a script that never answers: the engine’s own timeout ends the wait, the marketplace’s steps are over for this look, and the look goes on and ends', { options: { autoUpdate: BOTH, reloadAfterUpdate: 'off' } }, async ($, on) => {
    const w = world(on)
    w.state.silent.add(MINE)
    await begin($, w)
    await w.until(() => w.runs.length === 1, 'the first command')
    await w.later(80_000)
    expect(w.looks()).toBe(0)
    await w.later(20_000)
    await look(w, 1)
    expect(w.said()).toEqual([ONE_LOOK[0], ...ONE_LOOK.slice(3)])
    expect(w.kept()).toMatchObject({ fails: 1, unreached: 1, failed: `claude plugin marketplace update ${MINE}: its script gave no answer in 90 s` })
  })

  test('a step that can’t be started (its folder can’t be a working folder): a failure like any other, the rest of the look runs, and the next look tries again; the updater is never turned off for it', { options: { autoUpdate: BOTH, reloadAfterUpdate: 'off' } }, async ($, on) => {
    const w = world(on)
    w.state.webUnstartable = true
    await begin($, w)
    await look(w, 1)
    expect(w.said()).toEqual(ONE_LOOK)
    expect(w.kept()).toMatchObject({ fails: 1, failed: `claude plugin update widget@${MINE} --scope local: it couldn't be started` })
    expect([...w.logs, ...w.debug].filter(l => l.includes('does nothing in this session') || l.includes('updates nothing'))).toEqual([])
    // Its marketplace was reached, so the next look comes five minutes on as ever, the same steps; with the folder usable, it passes.
    expect(w.kept()).not.toHaveProperty('unreached')
    w.state.webUnstartable = false
    await w.later(6 * MINUTE)
    await turn($, w)
    await look(w, 2)
    expect(w.said(ONE_LOOK.length)).toEqual(ONE_LOOK)
    expect(w.kept()).toMatchObject({ fails: 0 })
  })

  test('no claude that can be started: the first command says so, nothing more runs in this process, and one line says it in the transcript (not the debug log), with no toast', { options: { autoUpdate: BOTH, reloadAfterUpdate: 'off' } }, async ($, on) => {
    const w = world(on)
    w.state.noClaude = true
    await begin($, w)
    await look(w, 1)
    expect(w.runs).toHaveLength(1)
    for (let i = 0; i < 3; i += 1) {
      await w.later(6 * MINUTE)
      await turn($, w)
    }
    await w.quiet()
    expect(w.runs).toHaveLength(1)
    expect(w.looks()).toBe(1)
    expect(w.logs.filter(l => l.includes('no claude'))).toEqual(['self-update: autoUpdate is set, but no claude that Windows can start was found (in %USERPROFILE%\\.local\\bin, or on PATH), so this session updates nothing.'])
    expect(w.toasts.filter(t => /self-update/.test(t))).toEqual([])
    expect(w.kept()).toMatchObject({ fails: 0, told: false })
  })
})

describe('where it can’t run', () => {
  test('not on Windows: nothing runs, reads or writes, the debug log says so once, and update_status says why', { options: { autoUpdate: BOTH } }, async ($, on) => {
    const w = world(on, { windows: false })
    await begin($, w)
    for (let i = 0; i < 3; i += 1) {
      await w.later(6 * MINUTE)
      await turn($, w)
    }
    await w.quiet()
    expect(w.runs).toEqual([])
    expect(w.lockRuns).toEqual([])
    expect(w.others.filter(updaterLike)).toEqual([])
    expect(w.writes).toEqual([])
    expect(touched(w.reads)).toEqual([])
    expect(w.debug.filter(l => l.includes('autoUpdate is set'))).toEqual(['self-update: autoUpdate is set, but it does nothing in this session: it runs on Windows only.'])
    expect(w.logs.filter(l => /autoUpdate|self-update/.test(l))).toEqual([])
    expect(String((await $.tool.call({ tool: 'mcp__self-update__update_status' })).result)).toBe(`autoUpdate names ${MINE}, ${TOOLS}. reloadAfterUpdate is on. It does nothing in this session: it runs on Windows only.`)
  })
})

describe('sessions pick an install up: a reload of their own, at idle', () => {
  test('the session whose look installed reloads itself once the look ends, idle, with no turn’s end between: the lock given back first, a line and a toast saying why', { options: { autoUpdate: BOTH } }, async ($, on) => {
    const w = world(on)
    // No look at the start (another session's was a minute before); the turn's end five minutes on makes one.
    w.put({ at: START - MINUTE })
    await begin($, w)
    w.state.available = { [`self-wake@${TOOLS}`]: '0.4.1' }
    await w.later(5 * MINUTE)
    await turn($, w)
    await look(w, 1)
    // With reloadAfterUpdate on, the line says sessions reload.
    expect(w.toasts.filter(t => t.startsWith('self-update: updated '))).toEqual([`self-update: updated self-wake 0.4.0 to 0.4.1 from ${TOOLS}; ${RELOADS}`])
    await w.soon(() => w.reloads() === 1, 'its own reload')
    expect(w.commands).toEqual([{ command: 'reload-plugins' }])
    // Only after its look: the lock given back, the install recorded.
    expect(w.reloadsAt).toEqual([{ lockHeld: false, looks: 1 }])
    expect(w.logs.filter(l => l === RELOAD_LINE)).toHaveLength(1)
    expect(w.toasts.filter(t => t === RELOAD_LINE)).toHaveLength(1)
    expect(RELOAD_LINE).toBe('self-update: running /reload-plugins: a plugin was updated on this machine after this session loaded its plugins.')
  })

  test('another session’s look installed after this one loaded: it reloads at its next idle turn’s end, waiting out a draft and a subagent at work; an install from before it loaded is nothing', { options: { autoUpdate: BOTH } }, async ($, on) => {
    const w = world(on)
    // An install a minute before this session started, the look fresh: nothing to do.
    w.put({ at: START, installed: START - MINUTE })
    await begin($, w)
    await turn($, w)
    await w.quiet()
    expect(w.reloads()).toBe(0)
    // Another session's look installs now; the person is typing here.
    await w.later(MINUTE)
    w.put({ at: w.clock.now(), installed: w.clock.now() })
    w.state.draft = 'half a sente'
    await turn($, w)
    await w.quiet()
    expect(w.reloads()).toBe(0)
    expect(w.debug.some(l => l === 'self-update: a plugin was updated after this session loaded its plugins; its reload waits: a draft is in the prompt box.')).toBe(true)
    // The draft sent; a subagent at work holds it too.
    w.state.draft = ''
    w.state.agents = [{ id: 'a1', status: 'running' }]
    await turn($, w)
    await w.quiet()
    expect(w.reloads()).toBe(0)
    expect(w.debug.some(l => l.endsWith('its reload waits: a subagent is at work.'))).toBe(true)
    w.state.agents = [{ id: 'a1', status: 'completed' }]
    await turn($, w)
    await w.soon(() => w.reloads() === 1, 'its own reload')
    // This session ran no command of the updater's: the other session's look was fresh.
    expect(w.runs).toEqual([])
    expect(w.lockRuns).toEqual([])
  })

  test('a turn that starts before the reload runs takes it back to that turn’s end', { options: { autoUpdate: BOTH } }, async ($, on) => {
    const w = world(on)
    w.put({ at: START, installed: START - MINUTE })
    await begin($, w)
    await w.later(MINUTE)
    w.put({ at: w.clock.now(), installed: w.clock.now() })
    // The turn's end asks the reload a beat on; a new turn starts before that beat.
    await $.turn.start({ text: 'working', turnId: 'r1' })
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'r1', reason: 'answer' })
    await $.turn.start({ text: 'more', turnId: 'r2' })
    await w.quiet()
    expect(w.reloads()).toBe(0)
    expect(w.debug.some(l => l.endsWith('its reload waits: a turn is running.'))).toBe(true)
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'r2', reason: 'answer' })
    await w.soon(() => w.reloads() === 1, 'the reload at the turn’s end')
  })

  test('never a loop: a reload that leaves the session as it was is tried once more, 15 minutes on, then never again for that install; the person reads one line, once; a later install starts afresh', { options: { autoUpdate: 'not-installed-here' } }, async ($, on) => {
    const w = world(on)
    const kept: unknown[] = []
    on('state.set', { key: 'reload' }, async (_, e, next) => {
      kept.push(e.value)
      return next(e)
    })
    await begin($, w)
    await look(w, 1)
    await w.later(MINUTE)
    const installed = w.clock.now()
    // Every look of this session's own finds nothing to run (its marketplace has nothing installed here), and keeps the install's time.
    w.put({ at: installed, installed })
    await turn($, w)
    await w.soon(() => w.reloads() === 1, 'the first try')
    // The reload left the session as it was (the same module runs on): the next turns' ends wait out the 15 minutes.
    await turn($, w)
    await w.quiet()
    expect(w.reloads()).toBe(1)
    expect(w.debug.some(l => /its reload waits: this session reloaded for an update \d+ min ago, and reloads at most once every 15 minutes\.$/.test(l))).toBe(true)
    await w.later(15 * MINUTE)
    await turn($, w)
    await w.soon(() => w.reloads() === 2, 'the second try')
    for (let i = 0; i < 4; i += 1) {
      await w.later(20 * MINUTE)
      await turn($, w)
    }
    await w.quiet()
    expect(w.reloads()).toBe(2)
    expect(w.kept()).toMatchObject({ installed })
    expect(kept.at(-1)).toEqual({ install: installed, tries: 2, told: true })
    expect(w.logs.filter(l => l === RESTART_LINE)).toEqual([RESTART_LINE])
    // A later install is another record: its own two tries, the first now.
    const again = w.clock.now()
    w.put({ at: again, installed: again })
    await turn($, w)
    await w.soon(() => w.reloads() === 3, 'the later install’s first try')
    expect(kept.at(-1)).toMatchObject({ install: again, tries: 1 })
  })

  test('with reloadAfterUpdate off, a session behind an install never reloads, and never reads the install’s time for it', { options: { autoUpdate: 'not-installed-here', reloadAfterUpdate: 'off' } }, async ($, on) => {
    const w = world(on)
    await begin($, w)
    await look(w, 1)
    await w.later(MINUTE)
    w.put({ at: w.clock.now(), installed: w.clock.now() })
    const readsBefore = w.reads.length
    for (let i = 0; i < 3; i += 1) {
      await turn($, w)
      await w.later(20 * MINUTE)
    }
    await w.quiet()
    expect(w.reloads()).toBe(0)
    // Only looks read the state file now: one read, then one under the lock, per look; never one more for a reload.
    const stateReads = w.reads.slice(readsBefore).filter(p => STATE_FILE.test(p)).length
    expect(stateReads).toBe(2 * (w.looks() - 1))
  })
})

describe('a reload this plugin runs and a look never overlap in the session', () => {
  test('the session’s own reload, asked for while its look runs, waits for the look’s end: the lock is given back first', { options: { autoUpdate: BOTH } }, async ($, on) => {
    const w = world(on)
    w.put({ at: START - MINUTE })
    await begin($, w)
    await w.later(6 * MINUTE)
    // Another session's look installed a minute ago (this one loaded before it); that look is old enough now for this session's own.
    const now = w.clock.now()
    w.put({ at: now - 6 * MINUTE, installed: now - MINUTE })
    const gate = w.hold()
    await turn($, w)
    await w.until(() => w.runs.length === 1, 'the look’s first command')
    // Seconds pass, the look still at its first command: the reload is asked for, and held.
    await w.quiet()
    expect(w.reloads()).toBe(0)
    expect(w.looks()).toBe(0)
    expect(w.locks.size).toBe(1)
    expect(w.debug.some(l => l.endsWith("its reload waits: this session's look for updates is under way."))).toBe(true)
    gate.release()
    await look(w, 1)
    expect(w.said()).toEqual(ONE_LOOK)
    await w.soon(() => w.reloads() === 1, 'the reload, after the look')
    expect(w.reloadsAt).toEqual([{ lockHeld: false, looks: 1 }])
  })

  test('no look starts while a reload this plugin runs is out; once its command answers, the next turn’s end looks', { options: { autoUpdate: BOTH } }, async ($, on) => {
    const w = world(on)
    w.put({ at: START, installed: START - MINUTE })
    await begin($, w)
    // Another session installs; this one's reload runs at the next turn's end, and its command doesn't answer yet.
    await w.later(MINUTE)
    w.put({ at: w.clock.now(), installed: w.clock.now() })
    w.state.reloadHangs = true
    await turn($, w)
    await w.soon(() => w.reloads() === 1, 'the reload')
    // The machine's last look is old enough now, and turns end: no look, not even the lock.
    await w.later(6 * MINUTE)
    await turn($, w)
    await w.quiet()
    expect(w.lockRuns).toEqual([])
    expect(w.runs).toEqual([])
    // The reload is over: the next turn's end looks.
    w.answerReload()
    await w.quiet()
    await turn($, w)
    await look(w, 1)
    expect(w.said()).toEqual(ONE_LOOK)
  })
})
