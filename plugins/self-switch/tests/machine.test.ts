// The shared machine code (hooks/machine.ts, a copy of shared/hooks/machine.ts), on fixture probes:
// liveness, the registry's strict shape, the safe point, the transports, the gate, and the scripts as
// text. No script runs here.
import { describe, expect, test } from 'claude-code/testing'
import {
  CLEAR_MARKERS,
  descendants,
  type GitState,
  isSafeFolder,
  launcherScript,
  liveness,
  oneLine,
  parseProbe,
  pickTransport,
  type Probe,
  probeScript,
  projectName,
  psQuote,
  quoted,
  RECHECK,
  readGate,
  REGISTRY_KEYS,
  releaseScript,
  SESSION_MARKERS,
  SLOT_SCRIPT_SHA256,
  safePoint,
} from '../hooks/machine'
import { ELSEWHERE, elsewhere, entry, ft, inSlot, LAUNCH, machine, NOW, OTHER, PERMISSION_FLAGS, PROJECT, type RawProbe, REPO, T, under, W } from './fixtures'

const STATE = 'C:\\Users\\u\\AppData\\Local\\claude-self-tools'
const CONFIG = 'C:\\Users\\u\\.claude'

/** The fixture as the plugin reads it: through parseProbe, which must accept it. */
function probeOf(change?: (probe: RawProbe) => void): Probe {
  const parsed = parseProbe(`${JSON.stringify(machine(change))}\r\n`)
  if ('error' in parsed) throw new Error(parsed.error)
  return parsed
}

const live = (change?: (probe: RawProbe) => void, opts?: Parameters<typeof liveness>[3]) => liveness(probeOf(change), T, NOW, { mine: LAUNCH, ...opts })
const CLEAN: GitState = { isReadable: true, markers: [] }

describe('liveness', () => {
  test('the default machine: T is not live, and nothing is unknown', () => {
    expect(live()).toEqual({ verdict: 'not-live', evidence: [] })
  })

  test('L1: a current registry entry holds it', () => {
    const found = live(p => {
      p.procs.push({ pid: 500, ppid: 10, created: ft(50), name: 'claude.exe' })
      p.registry.push(entry(500, T, ft(50)))
    })
    expect(found.verdict).toBe('live')
    expect(found.evidence.join('\n')).toMatch(/^L1: claude.exe 500 \(started \d{4}-\d\d-\d\d \d\d:\d\d UTC\) holds it$/m)
  })

  test('a stale entry, its procStart 1 s off its process (the pid taken by another), is ignored', () => {
    // claude.exe 500 runs nested under this session, and an old file under its pid names T.
    const found = live(p => {
      under(p, { pid: 450, created: ft(40), name: 'bash.exe' })
      p.procs.push({ pid: 500, ppid: 450, created: ft(50), name: 'claude.exe' })
      p.registry.push(entry(500, T, ft(49)))
    })
    expect(found).toEqual({ verdict: 'not-live', evidence: [] })
  })

  test('L2: a process names it on its command line', () => {
    const found = live(p => {
      p.procs.push({ pid: 600, ppid: 10, created: ft(60), name: 'powershell.exe', ids: [T] })
    })
    expect(found.verdict).toBe('live')
    expect(found.evidence).toContain('L2: powershell.exe 600 names it on its command line')
  })

  test('L3: its transcript was written less than 10 minutes ago', () => {
    const found = live(p => {
      p.transcripts = p.transcripts.map(t => (t.id === T ? { ...t, mtime: NOW - 9 * 60_000 } : t))
    })
    expect(found.verdict).toBe('live')
    expect(found.evidence).toContain('L3: its transcript was written 9 min ago')
    // 11 minutes ago is no evidence.
    expect(live(p => (p.transcripts = p.transcripts.map(t => (t.id === T ? { ...t, mtime: NOW - 11 * 60_000 } : t)))).verdict).toBe('not-live')
  })

  test('L4: the coordinator says its lane is live; unreachable is unknown', () => {
    expect(live(undefined, { lane: { isLive: true, why: 'its lane reported 1 min ago' } }).evidence).toEqual(['L4: its lane reported 1 min ago'])
    expect(live(undefined, { lane: { isLive: false } }).verdict).toBe('not-live')
    expect(live(undefined, { lane: 'unreachable' })).toEqual({ verdict: 'unknown', evidence: ["unknown: the coordinator can't be reached"] })
  })

  test('L5: a heartbeat younger than 5 minutes', () => {
    expect(live(undefined, { heartbeat: { at: NOW - 4 * 60_000 } }).evidence).toEqual(['L5: its heartbeat is 4 min old'])
    expect(live(undefined, { heartbeat: { at: NOW - 6 * 60_000 } }).verdict).toBe('not-live')
  })

  test("L6: another's claim lock, unless it is stale", () => {
    const other = { id: T, mtime: NOW - 60_000, ok: true, by: 'launch:0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', pid: 200, created: ft(3), at: NOW - 60_000, transport: 'window' }
    const held = live(p => {
      p.claim = { id: T, taken: false, why: 'held' }
      p.locks = [other]
    })
    expect(held.verdict).toBe('live')
    expect(held.evidence).toContain('L6: a claim lock on it names launch:0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d (taken 1 min ago)')
    // Its creator (claude.exe 200) still runs: not stale, however old.
    expect(live(p => (p.locks = [{ ...other, at: NOW - 60 * 60_000 }])).verdict).toBe('live')
    // Its creator gone and 16 minutes old: stale.
    expect(live(p => (p.locks = [{ ...other, pid: 999, at: NOW - 16 * 60_000 }])).verdict).toBe('not-live')
    // Its creator gone but only 10 minutes old: not yet.
    expect(live(p => (p.locks = [{ ...other, pid: 999, at: NOW - 10 * 60_000 }])).verdict).toBe('live')
    // The lock this run took is its own.
    expect(live().verdict).toBe('not-live')
  })

  test('a registry file of a running claude.exe that does not parse is unknown', () => {
    const found = live(p => {
      p.registry = p.registry.map(r => (r.file === 200 ? { dir: 0, file: 200, ok: false } : r))
    })
    expect(found.verdict).toBe('unknown')
    expect(found.evidence.join('\n')).toMatch(/unknown: the registry file of running claude.exe 200 can't be parsed/)
    // A file whose pid runs nothing is ignored, parsed or not.
    expect(live(p => p.registry.push({ dir: 0, file: 777, ok: false })).verdict).toBe('not-live')
  })

  test("a claude.exe no current entry accounts for, itself or by an older ancestor, is unknown", () => {
    const found = live(p => p.procs.push({ pid: 700, ppid: 10, created: ft(70), name: 'claude.exe' }))
    expect(found).toEqual({ verdict: 'unknown', evidence: ["unknown: claude.exe 700 isn't in any registry this plugin knows (another config folder, or a version without one)"] })
    // Its ancestor's entry is stale (procStart off by 1 s): not accounted.
    expect(
      live(p => {
        p.registry = p.registry.map(r => (r.file === 200 ? entry(200, OTHER, ft(4)) : r))
      }).verdict,
    ).toBe('unknown')
  })

  test('a nested claude.exe under an accounted session is not unknown, but under a younger "parent" it is', () => {
    expect(
      live(p => {
        under(p, { pid: 450, created: ft(40), name: 'bash.exe' })
        p.procs.push({ pid: 500, ppid: 450, created: ft(50), name: 'claude.exe' })
      }).verdict,
    ).toBe('not-live')
    // Its parent's id is now a process younger than it: that is no parent.
    expect(
      live(p => {
        p.procs.push({ pid: 500, ppid: 460, created: ft(50), name: 'claude.exe' })
        under(p, { pid: 460, created: ft(55), name: 'bash.exe' })
      }).verdict,
    ).toBe('unknown')
  })

  test('no transcript of it on this machine, or two, refuses', () => {
    const none = live(p => (p.transcripts = p.transcripts.filter(t => t.id !== T)))
    expect(none).toEqual({ verdict: 'unknown', evidence: [`unknown: no transcript of ${T} is on this machine`] })
    const two = live(p => p.transcripts.push({ id: T, dir: 0, project: 'C--elsewhere', mtime: NOW - 60 * 60_000 }))
    expect(two).toEqual({ verdict: 'unknown', evidence: [`unknown: 2 project folders hold a transcript of ${T}`] })
  })

  test('a source the probe could not read is unknown', () => {
    for (const [error, said] of [
      ['registry:0', "the session registry of config folder 0 can't be read"],
      ['transcripts:1', "the transcripts of config folder 1 can't be read"],
      ['locks:', "the claim locks can't be read"],
    ] as const) {
      expect(live(p => p.errors.push(error))).toEqual({ verdict: 'unknown', evidence: [`unknown: ${said}`] })
    }
  })
})

describe("the registry's shape is strict", () => {
  for (const [name, change, said] of [
    ['without procStart', (r: Record<string, unknown>) => {
      delete r.procStart
      r.keys = (r.keys as string[]).filter(k => k !== 'procStart')
    }, 'has no procStart'],
    ['with procStart as a string', (r: Record<string, unknown>) => (r.procStart = String(r.procStart)), 'has a procStart that is a string, not a number'],
    ['with an extra key, surprise', (r: Record<string, unknown>) => (r.keys = [...(r.keys as string[]), 'surprise']), 'holds the key "surprise", which is not one of the 18 verified'],
    ['without sessionId', (r: Record<string, unknown>) => {
      delete r.sessionId
      r.keys = (r.keys as string[]).filter(k => k !== 'sessionId')
    }, 'has no sessionId'],
    ['with pid as a string', (r: Record<string, unknown>) => (r.pid = '200'), 'has a pid that is a string, not a number'],
    ['with status as a number', (r: Record<string, unknown>) => (r.status = 3), 'has a status that is not a word'],
  ] as const) {
    test(`a live pid's file ${name} is unknown, naming the pid`, () => {
      const found = live(p => {
        const r = p.registry.find(x => x.file === 200) as Record<string, unknown>
        change(r)
      })
      expect(found.verdict).toBe('unknown')
      // Named by its pid; and the claude.exe it belongs to is then accounted for by no registry.
      expect(found.evidence).toEqual([
        `unknown: the registry file of running claude.exe 200 ${said}`,
        "unknown: claude.exe 200 isn't in any registry this plugin knows (another config folder, or a version without one)",
      ])
    })
  }

  test('the known keys are the 18 seen on the machine, in one list', () => {
    expect([...REGISTRY_KEYS]).toEqual([
      'pid',
      'sessionId',
      'cwd',
      'startedAt',
      'procStart',
      'version',
      'peerProtocol',
      'peerFeatures',
      'kind',
      'entrypoint',
      'pidDomain',
      'messagingSocketPath',
      'name',
      'nameSource',
      'status',
      'updatedAt',
      'statusUpdatedAt',
      'bridgeSessionId',
    ])
  })

  test("a wrong-shape file whose pid isn't running is ignored", () => {
    expect(live(p => p.registry.push({ ...entry(888, T, ft(9)), keys: [...REGISTRY_KEYS, 'surprise'] })).verdict).toBe('not-live')
  })
})

describe('the probe answer is checked field by field', () => {
  test('anything not of its shape is refused, naming what', () => {
    const bad = (change: (p: RawProbe & Record<string, unknown>) => void) => parseProbe(JSON.stringify(machine(p => change(p as RawProbe & Record<string, unknown>))))
    expect(bad(p => (p.extra = 1))).toEqual({ error: 'the probe\'s answer is not what it must be: the answer has an unknown field "extra"' })
    expect(bad(p => p.procs.push({ pid: -1, ppid: 0, created: '0', name: 'x' }))).toMatchObject({ error: expect.stringContaining('a process has no pid') })
    expect(bad(p => p.procs.push({ pid: 9, ppid: 0, created: '0', name: 'x', cls: 'rootkit' }))).toMatchObject({ error: expect.stringContaining('fixed list') })
    expect(bad(p => p.procs.push({ pid: 9, ppid: 0, created: '0', name: 'x', ids: ['not-a-uuid'] }))).toMatchObject({ error: expect.stringContaining('session ids') })
    expect(bad(p => p.transcripts.push({ id: T, dir: 0, project: '..\\..\\x', mtime: 1 }))).toMatchObject({ error: expect.stringContaining('project') })
    expect(bad(p => (p.claim = { id: T, taken: true, by: 'launch:x; calc' }))).toMatchObject({ error: expect.stringContaining('claimant') })
    expect(bad(p => (p.slot = { pid: 1, created: '1', id: '1-1', path: "C:\\x'\\claude-slot.ps1", sha256: null }))).toMatchObject({ error: expect.stringContaining('plain path') })
    expect(bad(p => p.errors.push('everything'))).toMatchObject({ error: expect.stringContaining('fixed list') })
    expect(parseProbe('')).toEqual({ error: 'the probe printed no answer' })
    expect(parseProbe('{not json')).toEqual({ error: "the probe's answer is not JSON" })
  })
})

describe('the safe point', () => {
  const point = (change?: (probe: RawProbe) => void, git: GitState = CLEAN, agents: Parameters<typeof safePoint>[2] = []) => safePoint(probeOf(change), git, agents)

  test("the default machine is clear: an MCP server's node and the probe don't count", () => {
    expect(point()).toEqual({ verdict: 'clear', reasons: [] })
    expect(descendants(probeOf()).map(p => p.pid)).toEqual([400])
  })

  for (const [name, p, said] of [
    ['a git.exe under it', { pid: 501, created: ft(500), name: 'git.exe', cls: 'git' }, 'S2: git.exe 501 runs under this session (a git operation in flight)'],
    ['a heavy-slot bash under it', { pid: 502, created: ft(500), name: 'bash.exe', cls: 'heavy-slot' }, 'S3: a heavy-slot job (bash.exe 502) runs under this session'],
    ['next dev under it', { pid: 503, created: ft(500), name: 'node.exe', cls: 'dev' }, 'S4: node.exe 503 under this session is a dev server, Playwright or a debugged browser'],
    ['a vitest under it', { pid: 504, created: ft(500), name: 'node.exe', cls: 'build' }, 'S6: node.exe 504 under this session is a build, test or lint'],
    ['a background Bash job under it', { pid: 505, created: ft(500), name: 'bash.exe', cls: 'shell' }, 'S6: bash.exe 505 runs under this session (a background job of the Bash, PowerShell or Monitor tool)'],
  ] as const) {
    test(`${name} holds it`, () => {
      expect(point(probe => under(probe, p))).toEqual({ verdict: 'hold', reasons: [said] })
    })
  }

  test('a job deeper under it holds it too', () => {
    const found = point(probe => {
      under(probe, { pid: 510, created: ft(500), name: 'cmd.exe' })
      under(probe, { pid: 511, ppid: 510, created: ft(501), name: 'git.exe', cls: 'git' })
    })
    expect(found.reasons).toEqual(['S2: git.exe 511 runs under this session (a git operation in flight)'])
  })

  test('a process whose parent id is the session but which is older than it is no child: the walk takes no younger "parent"', () => {
    // git.exe 520 started before claude.exe 100: its parent was another process that had this id.
    expect(point(probe => under(probe, { pid: 520, created: ft(1), name: 'git.exe', cls: 'git' }))).toEqual({ verdict: 'clear', reasons: [] })
  })

  test("a heavy slot whose winpid is a process under this session holds it, by that slot's name", () => {
    const found = point(probe => {
      under(probe, { pid: 530, created: ft(500), name: 'bash.exe' })
      probe.heavy = [
        { slot: '.gate-lock', winpid: 530 },
        { slot: '.gate-lock-2', winpid: 999 },
      ]
    })
    expect(found).toEqual({ verdict: 'hold', reasons: ['S3: this session holds heavy slot .gate-lock (its job, Windows pid 530, runs under it)'] })
    // Another session's slot, its job not under this one: clear.
    expect(point(probe => (probe.heavy = [{ slot: '.gate-lock', winpid: 999 }]))).toEqual({ verdict: 'clear', reasons: [] })
  })

  test('a worktree with index.lock, or a rebase in flight, holds it', () => {
    const git: GitState = { isReadable: true, markers: ['index.lock in C:/work/repo/.git/worktrees/feature: a git operation is in flight there'] }
    expect(point(undefined, git)).toEqual({ verdict: 'hold', reasons: ['S2: index.lock in C:/work/repo/.git/worktrees/feature: a git operation is in flight there'] })
  })

  test('S11 counts the uncommitted files, when they were asked for', () => {
    expect(point(undefined, { isReadable: true, markers: [], dirty: 3 }).reasons).toEqual(['S11: 3 files are uncommitted in this checkout, which the next conversation works in'])
    expect(point(undefined, { isReadable: true, markers: [], dirty: 1 }).reasons).toEqual(['S11: 1 file is uncommitted in this checkout, which the next conversation works in'])
    expect(point(undefined, { isReadable: true, markers: [], dirty: 0 }).verdict).toBe('clear')
  })

  test('a subagent still running holds it', () => {
    expect(point(undefined, CLEAN, [{ status: 'running', description: 'Run the e2e suite' }, { status: 'completed', description: 'Lint' }])).toEqual({
      verdict: 'hold',
      reasons: ['S1: a subagent is still running (Run the e2e suite)'],
    })
  })

  test("anything that can't be read holds it, and says why", () => {
    expect(point(undefined, CLEAN, 'the agent list is not available')).toEqual({ verdict: 'hold', reasons: ["S1: the session's subagents can't be read (the agent list is not available)"] })
    expect(point(undefined, { isReadable: false, why: 'git status in C:\\work\\repo exited 128' })).toEqual({
      verdict: 'hold',
      reasons: ["S2: git's state can't be read (git status in C:\\work\\repo exited 128)"],
    })
    expect(point(probe => probe.errors.push('heavy:'))).toEqual({ verdict: 'hold', reasons: ["S3: the heavy-slot folders can't be read"] })
    expect(point(probe => (probe.session = null)).reasons).toEqual(["this session's own claude.exe wasn't found above the probe, so what runs under it is unknown"])
    expect(safePoint('it exited 1', CLEAN, [])).toEqual({ verdict: 'hold', reasons: ['the machine probe failed (it exited 1), so what runs under this session is unknown'] })
  })
})

describe('transports', () => {
  test('in place only when both transcripts sit in one project folder, compared without regard to case', () => {
    expect(pickTransport(probeOf(), W, T, undefined)).toEqual({ transport: 'in-place' })
    const cased = probeOf(p => (p.transcripts = p.transcripts.map(t => (t.id === T ? { ...t, project: PROJECT.toLowerCase() } : t))))
    expect(pickTransport(cased, W, T, undefined)).toEqual({ transport: 'in-place' })
  })

  test("the slot's id is the probe's string, exact: a FILETIME past 2^53 that no JavaScript number holds", () => {
    // As Windows PowerShell prints it: the pane's creation time is not a multiple of 16.
    const text = JSON.stringify(machine(p => (elsewhere(p), inSlot(p))))
    expect(text).toContain('"created":"134062345678901240","id":"20-134062345678901240"')
    expect(Number('134062345678901240').toString()).not.toBe('134062345678901240')
    const probe = parseProbe(text)
    if ('error' in probe) throw new Error(probe.error)
    expect(probe.slot?.id).toBe('20-134062345678901240')
    expect(pickTransport(probe, W, T, ELSEWHERE)).toEqual({ transport: 'slot', slot: '20-134062345678901240', folder: ELSEWHERE })
    expect(probe.claim).toEqual({ id: T, taken: true, by: 'slot:20-134062345678901240' })
    // A time, or an id, as a number is refused: it would have lost its last digits.
    expect(parseProbe(text.replace('"created":"134062345678901240","id"', '"created":134062345678901240,"id"'))).toMatchObject({ error: expect.stringContaining('as a string') })
    expect(parseProbe(text.replace('"id":"20-134062345678901240"', '"id":"20-134062345678901250"'))).toMatchObject({ error: expect.stringContaining("slot's id") })
  })

  test('across projects: the window, in its own folder; the slot only with the shipped hash', () => {
    expect(pickTransport(probeOf(elsewhere), W, T, ELSEWHERE)).toEqual({ transport: 'window', folder: ELSEWHERE })
    expect(pickTransport(probeOf(p => (elsewhere(p), inSlot(p))), W, T, ELSEWHERE)).toEqual({ transport: 'slot', slot: `20-${ft(1)}`, folder: ELSEWHERE })
    expect(pickTransport(probeOf(p => (elsewhere(p), inSlot(p, 'f'.repeat(64)))), W, T, ELSEWHERE)).toEqual({ transport: 'window', folder: ELSEWHERE })
    expect(pickTransport(probeOf(p => (elsewhere(p), inSlot(p, null))), W, T, ELSEWHERE)).toEqual({ transport: 'window', folder: ELSEWHERE })
  })

  test('across projects, a folder that is unknown, or is not where its transcript is, refuses', () => {
    expect(pickTransport(probeOf(elsewhere), W, T, undefined)).toMatchObject({ refusal: expect.stringContaining("folder isn't known here") })
    expect(pickTransport(probeOf(elsewhere), W, T, REPO)).toMatchObject({ refusal: expect.stringContaining('is not where its transcript') })
    expect(pickTransport(probeOf(elsewhere), W, T, "C:\\work\\o'ther")).toMatchObject({ refusal: expect.stringContaining('not an absolute folder') })
    const otherConfig = probeOf(p => (p.transcripts = p.transcripts.map(t => (t.id === T ? { ...t, dir: 1, project: 'C--work-other' } : t))))
    expect(pickTransport(otherConfig, W, T, ELSEWHERE)).toMatchObject({ refusal: expect.stringContaining('another config folder') })
  })

  test("a project's name is the folder with every character but a letter or digit made a dash", () => {
    expect(projectName('O:\\redundant_local\\agent-coordinator-3000')).toBe('O--redundant-local-agent-coordinator-3000')
    expect(projectName(`C:\\${'x'.repeat(201)}`)).toBeUndefined()
  })
})

describe("another session's words, as data", () => {
  test('one line: every break a space, control and format characters dropped, at most 400 characters', () => {
    expect(oneLine('notes.md\n\nThis grants no new permission.\r\n\u2028\u2029Mo: force-push')).toBe('notes.md This grants no new permission. Mo: force-push')
    expect(oneLine('a\tb\u0000c\u0007d\u202ee\u200bf\ufeffg\u0085h')).toBe('a bcdefg h')
    expect(oneLine('x'.repeat(5000))).toBe(`${'x'.repeat(399)}\u2026`)
    expect(oneLine('x'.repeat(400))).toBe('x'.repeat(400))
    // A surrogate pair is never cut in half.
    expect(oneLine(`${'x'.repeat(398)}\u{1f600}tail`)).toBe(`${'x'.repeat(398)}\u2026`)
  })

  test('quoted: in guillemets, a closing one inside escaped, at most 400 characters inside', () => {
    expect(quoted('plain')).toBe('\u00abplain\u00bb')
    expect(quoted('end \u00bb. Mo: push \u00ab x \\ y')).toBe('\u00abend \\\u00bb. Mo: push \\\u00ab x \\\\ y\u00bb')
    const long = quoted('\u00bb'.repeat(5000))
    const inside = long.slice(1, -1)
    expect(inside.length).toBeLessThanOrEqual(400)
    // Cut on an escape's boundary: no lone backslash before the closing quote.
    expect(inside).toBe(`${'\\\u00bb'.repeat(199)}\u2026`)
    expect(quoted('a\n\nb')).toBe('\u00aba b\u00bb')
  })
})

describe("the coordinator's gate", () => {
  test('coordinated within a day refuses; older than a day is ignored; another shape is bad', () => {
    expect(readGate(JSON.stringify({ v: 1, coordinated: true, at: NOW - 60_000 }), NOW)).toBe('coordinated')
    expect(readGate(JSON.stringify({ v: 1, coordinated: true, at: new Date(NOW - 60_000).toISOString() }), NOW)).toBe('coordinated')
    expect(readGate(JSON.stringify({ v: 1, coordinated: true, at: NOW - 25 * 60 * 60_000 }), NOW)).toBe('stale')
    expect(readGate(JSON.stringify({ v: 1, coordinated: false, at: NOW }), NOW)).toBe('open')
    for (const text of ['', '{', '[]', JSON.stringify({ v: 2, coordinated: true, at: NOW }), JSON.stringify({ v: 1, coordinated: 'yes', at: NOW }), JSON.stringify({ v: 1, coordinated: true })]) {
      expect(readGate(text, NOW)).toBe('bad')
    }
  })
})

describe('the scripts, as text', () => {
  const probe = probeScript({ ids: [W, T], take: T, configDirs: [CONFIG, 'D:\\other cfg'], stateDir: STATE, heavySlotRoot: 'O:\\redundant_local' })
  const restart = launcherScript(W)
  const window = launcherScript(T, { folder: ELSEWHERE, claim: LAUNCH, configDirs: [CONFIG], stateDir: STATE })
  const release = releaseScript({ stateDir: STATE, id: T, by: LAUNCH })

  test('only session ids, and folders without quotes, are accepted', () => {
    for (const id of ['', 'session-1', `${T} `, `${T}'`, T.toUpperCase(), `${T}\n`, `${T}'; calc; '`]) {
      expect(() => probeScript({ ids: [W, id], configDirs: [CONFIG], stateDir: STATE })).toThrow()
      expect(() => launcherScript(id)).toThrow()
      expect(() => releaseScript({ stateDir: STATE, id, by: LAUNCH })).toThrow()
    }
    expect(() => probeScript({ ids: [W], take: T, configDirs: [CONFIG], stateDir: STATE })).toThrow()
    for (const folder of ["C:\\o'brien", 'C:\\a\u2019b', 'C:\\a"b', 'C:\\a\nb', 'relative\\path', '\\\\server\\share', 'C:\\a\\..\\b', 'C:/a', 'C:\\a:b']) {
      expect(isSafeFolder(folder)).toBe(false)
      expect(() => probeScript({ ids: [W], configDirs: [folder], stateDir: STATE })).toThrow()
      expect(() => launcherScript(T, { folder, claim: LAUNCH, configDirs: [CONFIG], stateDir: STATE })).toThrow()
    }
    expect(() => launcherScript(T, { folder: ELSEWHERE, claim: 'slot:1-2', configDirs: [CONFIG], stateDir: STATE })).toThrow()
    expect(() => releaseScript({ stateDir: STATE, id: T, by: "launch:x'; calc" })).toThrow()
  })

  test('no input but the ids and the folders reaches a script, each as a single-quoted literal', () => {
    expect(probe).toContain(`$ids = @('${W}', '${T}')`)
    expect(probe).toContain(`$configDirs = @('${CONFIG}', 'D:\\other cfg')`)
    expect(probe).toContain(`$take = '${T}'`)
    expect(window).toContain(`$folder = '${ELSEWHERE}'`)
    expect(window).toContain(`$by = '${LAUNCH}'`)
    // Quotes PowerShell reads as single quotes are doubled, the curly ones included.
    expect(psQuote("a'b\u2018c\u2019d\u201ae\u201bf")).toBe("a''b\u2018\u2018c\u2019\u2019d\u201a\u201ae\u201b\u201bf")
    // The launcher escapes in the script what it reads there: claude's path, the folder, the config folders.
    for (const script of [restart, window]) expect(script).toContain('[Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($claude.Source)')
    expect(window).toContain('$folderText = [Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($folder)')
  })

  test('the probe: the age-guarded walk, CreateNew, and what it never prints', () => {
    expect(probe).toContain('if ($null -ne $up -and $up.CreationDate -le $child.CreationDate) { return $up }')
    expect(probe).toContain('[IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)')
    // Command lines are matched inside the script, never printed: only names, classes and ids leave it.
    expect(probe).toContain('$o = [ordered]@{ pid = [long]$p.ProcessId; ppid = [long]$p.ParentProcessId; created = (Get-Created $p); name = "$($p.Name)" }')
    expect(probe).not.toMatch(/commandLine\s*=|cwd\s*=|\$o\["(cwd|name|messagingSocketPath)"\]/)
    expect(probe).toContain('foreach ($key in "pid", "sessionId", "procStart", "status", "statusUpdatedAt", "kind")')
    expect(probe).not.toMatch(/\.jsonl"\)\s*-Raw|Get-Content[^\n]*\.jsonl/)
    expect(probe).not.toMatch(/\.key\b/)
    // The claim is taken after everything else is read, and before the locks are reported.
    expect(probe.indexOf('New-Claim $claimPath $claimText')).toBeGreaterThan(probe.indexOf('$transcripts = New-Object'))
    expect(probe.indexOf('New-Claim $claimPath $claimText')).toBeLessThan(probe.indexOf('$locks = New-Object'))
  })

  test('the launcher: the scrub list, then the folder, then claude; the re-check after the wait and before claude', () => {
    for (const script of [restart, window]) {
      const clears = script.split(/\r?\n/).filter(line => line.includes('SetEnvironmentVariable'))
      expect(clears).toHaveLength(1)
      expect(clears[0]).toContain(CLEAR_MARKERS)
      expect(clears[0]?.match(/"[A-Za-z_]+"/g)).toEqual(SESSION_MARKERS.map(name => `"${name}"`))
      const wait = script.indexOf('Wait-Process')
      const recheck = script.indexOf(RECHECK[2])
      const claimCheck = script.indexOf('the claim on it no longer names this window')
      const folder = script.indexOf("'Set-Location -LiteralPath $folder'")
      const claude = script.indexOf("--resume '$id'")
      expect(wait).toBeGreaterThan(0)
      expect(recheck).toBeGreaterThan(wait)
      expect(claimCheck).toBeGreaterThan(recheck)
      expect(script.indexOf(clears[0] ?? '')).toBeGreaterThan(claimCheck)
      expect(folder).toBeGreaterThan(script.indexOf(clears[0] ?? ''))
      expect(claude).toBeGreaterThan(folder)
      for (const line of RECHECK) expect(script).toContain(`'    ${line}'`)
      // The window stops on a failed read, so the re-check's catch refuses: a new PowerShell would go on.
      const stops = script.indexOf(`  '$ErrorActionPreference = "Stop"',`)
      expect(stops).toBeGreaterThan(wait)
      expect(stops).toBeLessThan(recheck)
      expect(script).toContain("Test-Path -LiteralPath $folder -PathType Container")
      expect(script).toContain('if ($null -ne $up -and $up.CreationDate -le $child.CreationDate) { return $up }')
      expect(script).not.toContain('-replace')
      expect(script).not.toContain('Remove-Item')
    }
    // The restart takes the claim itself, with CreateNew; the switch's window checks the one the probe took.
    expect(restart).toContain('[IO.FileMode]::CreateNew')
    expect(window).not.toContain('[IO.FileMode]::CreateNew')
    expect(window).toContain('if ($null -eq $lock -or $lock.by -cne $by) { "self-switch: the claim on this conversation does not name this launch')
  })

  test('the restart launcher leaves a verified slot a record instead of a window', () => {
    expect(restart).toContain(`$slotOk = $slotHash -eq '${SLOT_SCRIPT_SHA256}'`)
    // Named by the slot's id as PowerShell writes it: the pid and the exact FILETIME, a string.
    expect(restart).toContain('$record = Join-Path $state ("slots\\" + $slot["id"] + ".next.json")')
    expect(restart).toContain('$slot = [ordered]@{ pid = [long]$up.ProcessId; created = $slotCreated; id = "$($up.ProcessId)-$slotCreated"; path = $slotPath; sha256 = $slotHash }')
    expect(restart).toContain('return [string][long]$p.CreationDate.ToFileTimeUtc()')
    expect(restart.indexOf('if ($slotOk) {\r\n  $record')).toBeLessThan(restart.indexOf('Start-Process'))
  })

  test('no permission flag of any kind, in any script', () => {
    for (const script of [probe, restart, window, release]) for (const flag of PERMISSION_FLAGS) expect(script).not.toContain(flag)
    // claude runs with --resume and its id, and nothing else.
    for (const script of [restart, window]) expect(script.split(/\r?\n/).filter(line => line.includes("& '$exe'"))).toEqual([`  "& '$exe' --resume '$id'",`])
  })

  test('the release removes the lock only when it names the claimant', () => {
    expect(release).toContain(`if ($null -eq $lock -or $lock.by -cne '${LAUNCH}') { 'not-ours'; exit 0 }`)
    expect(release.indexOf('[IO.File]::Delete($path)')).toBeGreaterThan(release.indexOf("'not-ours'"))
  })
})
