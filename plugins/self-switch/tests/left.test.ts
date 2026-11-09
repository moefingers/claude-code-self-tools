// The left record (\u00a73.4 of the design) and liveness's `self` (\u00a77.4), in the shared machine code, on
// fixture probes: when a record waives L3 and L5, each of the six conditions that refuse it (LR1-LR10),
// the last look that checks it again (LR12), and the scripts that write and read it as text (LR13,
// LR14). No script runs here; scripts/left-record.test.mjs runs them on Windows with a canary key.
import { describe, expect, test } from 'claude-code/testing'
import {
  claimCheckScript,
  LEFT_EXIT_FLUSH_MS,
  LEFT_MAX_AGE_MS,
  LEFT_RECHECK,
  leftRecheck,
  leftScript,
  liveness,
  parseProbe,
  type Probe,
  probeScript,
  RECHECK,
} from '../hooks/machine'
import { entry, ft, LAUNCH, leftExit, machine, NOW, PROJECT, type RawProbe, T, W, X } from './fixtures'

const STATE = 'C:\\Users\\u\\AppData\\Local\\claude-self-tools'
const CONFIG = 'C:\\Users\\u\\.claude'

/** The fixture as the plugin reads it: through parseProbe, which must accept it. */
function probeOf(change?: (probe: RawProbe) => void): Probe {
  const parsed = parseProbe(`${JSON.stringify(machine(change))}\r\n`)
  if ('error' in parsed) throw new Error(parsed.error)
  return parsed
}

/** T's verdict with its left record taken into account. */
const judged = (change?: (probe: RawProbe) => void, opts: Parameters<typeof liveness>[3] = {}) => liveness(probeOf(change), T, NOW, { mine: LAUNCH, left: true, ...opts })

/** T left in place a minute ago by process 777, which now holds conversation W: its transcript untouched since. */
function leftInPlace(probe: RawProbe, change: (record: Record<string, unknown>) => void = () => undefined): void {
  leftExit(probe, record => {
    record.how = 'in-place'
    record.transcript = { dir: 0, project: PROJECT, size: 4096, mtime: NOW - 55_000 }
    change(record)
  })
  probe.procs.push({ pid: 777, ppid: 10, created: ft(50), name: 'claude.exe' })
  probe.registry.push(entry(777, W, ft(50)))
}

describe('a left record waives L3 and L5, and only those', () => {
  test('without it, T left 55 s ago reads live by L3; with it, an exit record whose process is gone waives L3', () => {
    expect(liveness(probeOf(p => leftExit(p)), T, NOW, { mine: LAUNCH }).verdict).toBe('live')
    const live = judged(p => leftExit(p))
    expect(live.verdict).toBe('not-live')
    expect(live.evidence).toEqual(['L3 and L5 waived: it was left cleanly (exit) by claude.exe 777 1 min ago, and its transcript is untouched since'])
    expect(live.waived).toEqual({ exitAt: NOW - 60_000 })
  })

  test('L5 too: a heartbeat no later than 10 s after the record', () => {
    const live = judged(p => leftExit(p), { heartbeat: { at: NOW - 60_000 + 5000 } })
    expect(live.verdict).toBe('not-live')
  })

  test('in place: equal size and time, and the process that left it now holds another conversation', () => {
    const live = judged(p => leftInPlace(p))
    expect(live.verdict).toBe('not-live')
    expect(live.waived).toEqual({ size: 4096, mtime: NOW - 55_000 })
  })

  test('a probe that was not asked for left records, or a caller that does not take them, waives nothing', () => {
    expect(liveness(probeOf(p => leftExit(p)), T, NOW, { mine: LAUNCH, left: false }).verdict).toBe('live')
    expect(liveness(probeOf(p => (leftExit(p), delete p.left)), T, NOW, { mine: LAUNCH, left: true }).verdict).toBe('live')
  })

  // Each planted fault the brief names (LR1-LR10): with it, the record would waive where it must not.
  for (const [lr, name, change, said] of [
    ['LR1', "a MAC that doesn't match", (p: RawProbe) => leftExit(p, r => (r.macOk = false)), "its MAC doesn't match under this machine's key"],
    ['LR1', 'a record not of its shape', (p: RawProbe) => leftExit(p, r => { for (const key of Object.keys(r)) if (key !== 'asked') delete r[key]; r.ok = false }), 'it is not of its shape'],
    ['LR2', 'an in-place record whose transcript grew since', (p: RawProbe) => leftInPlace(p, r => (r.transcript = { dir: 0, project: PROJECT, size: 4000, mtime: NOW - 55_000 })), 'the transcript changed since it was written'],
    ['LR2', 'an in-place record whose transcript was written since', (p: RawProbe) => leftInPlace(p, r => (r.transcript = { dir: 0, project: PROJECT, size: 4096, mtime: NOW - 56_000 })), 'the transcript changed since it was written'],
    ['LR2', 'an exit record whose transcript was written more than 10 s after it', (p: RawProbe) => leftExit(p, r => (r.at = NOW - 70_000)), 'the transcript was written 15 s after it'],
    ['LR6', 'an exit record whose process still runs', (p: RawProbe) => (leftExit(p), p.procs.push({ pid: 777, ppid: 10, created: ft(50), name: 'claude.exe' }), p.registry.push(entry(777, W, ft(50)))), 'the process that left it (777) is still running'],
    ['LR6', 'an in-place record whose process holds no other conversation', (p: RawProbe) => (leftInPlace(p), (p.registry = p.registry.filter(e => e.file !== 777))), 'the process that left it (777) has no current registry entry naming another conversation'],
    ['LR8', 'a record 11 minutes old', (p: RawProbe) => leftExit(p, r => (r.at = NOW - 11 * 60_000)), `it is 11 min old, more than ${LEFT_MAX_AGE_MS / 60_000} minutes`],
    ['LR8', 'a record a minute in the future', (p: RawProbe) => leftExit(p, r => (r.at = NOW + 60_000)), 'it is dated in the future'],
    ['LR9', 'left\\<X>.json renamed to T\'s name (the record names another conversation)', (p: RawProbe) => leftExit(p, r => (r.id = W)), `it names another conversation (${W})`],
    ['LR10', 'a record whose transcript is in another config folder', (p: RawProbe) => leftExit(p, r => (r.transcript = { dir: -1, project: PROJECT, size: 4096, mtime: NOW - 55_000 })), 'its transcript is in another config folder or project than the record names'],
    ['LR10', 'a record whose transcript is in another project', (p: RawProbe) => leftExit(p, r => (r.transcript = { dir: 0, project: 'C--work-other', size: 4096, mtime: NOW - 55_000 })), 'its transcript is in another config folder or project than the record names'],
  ] as const) {
    test(`${lr}: ${name} waives nothing, and says why`, () => {
      const live = judged(change)
      expect(live.verdict).toBe('live')
      expect(live.waived).toBeUndefined()
      expect(live.evidence).toContain(`left record ignored: ${said}`)
      expect(live.evidence.some(line => line.startsWith('L3:'))).toBe(true)
    })
  }

  test('LR7: a heartbeat 30 s after the record waives nothing: the conversation ran again', () => {
    const live = judged(p => leftExit(p), { heartbeat: { at: NOW - 60_000 + 30_000 } })
    expect(live.verdict).toBe('live')
    expect(live.evidence).toContain('left record ignored: its heartbeat came after it')
    expect(live.evidence.some(line => line.startsWith('L5:'))).toBe(true)
  })

  test('LR4: a current registry entry naming T reads live, record or not (L1 is never waived)', () => {
    const live = judged(p => (leftExit(p), p.registry.push(entry(200, T, ft(3))), (p.registry = p.registry.filter(e => !(e.file === 200 && e.sessionId !== T)))))
    expect(live.verdict).toBe('live')
    expect(live.evidence.some(line => line.startsWith('L1: claude.exe 200'))).toBe(true)
  })

  test('LR5: a claude.exe under 60 s old with --resume T reads live, record or not (L2 is never waived)', () => {
    const live = judged(p => (leftExit(p), p.procs.push({ pid: 900, ppid: 10, created: String(BigInt(ft(1000)) - BigInt(30) * BigInt(10_000_000)), name: 'claude.exe', ids: [T] }), p.registry.push(entry(900, W, String(BigInt(ft(1000)) - BigInt(30) * BigInt(10_000_000))))))
    expect(live.verdict).toBe('live')
    expect(live.evidence.some(line => line.startsWith('L2: claude.exe 900'))).toBe(true)
  })

  test('L6 and every unknown stand: another claim lock, a registry that cannot be read', () => {
    expect(judged(p => (leftExit(p), (p.locks = [{ id: T, mtime: NOW, ok: true, by: 'launch:00000000-0000-4000-a000-000000000009', pid: 100, created: ft(2), at: NOW, transport: 'window' }]))).verdict).toBe('live')
    expect(judged(p => (leftExit(p), (p.errors = ['registry:0']))).verdict).toBe('unknown')
  })

  test("left records that couldn't be read waive nothing, and that is no unknown of its own", () => {
    const live = judged(p => (leftExit(p), (p.errors = ['left:'])))
    expect(live.verdict).toBe('live')
    expect(live.evidence).toContain("left record ignored: the left records can't be read")
  })
})

describe("liveness's self: a lane restart's own conversation (\u00a77.4)", () => {
  /** W, this session's own conversation, held by claude.exe 100 (this very process), its transcript and heartbeat fresh. */
  const own = (change?: (probe: RawProbe) => void) =>
    probeOf(p => {
      p.procs = p.procs.map(x => (x.pid === 100 ? { ...x, ids: [W] } : x))
      change?.(p)
    })

  test("this process's own registry entry, command line, transcript writes and heartbeat are no evidence against it", () => {
    const probe = own()
    expect(liveness(probe, W, NOW, { heartbeat: { at: NOW - 1000 } }).verdict).toBe('live')
    const live = liveness(probe, W, NOW, { heartbeat: { at: NOW - 1000 }, self: { pid: 100, created: ft(2) } })
    expect(live.verdict).toBe('not-live')
    expect(live.evidence).toEqual([`L3 and L5 are not read: ${W} is this process's own conversation (claude.exe 100)`])
  })

  test('another claude.exe naming the same id, on its command line or in its registry entry, still reads live (self is by pid and start, never by id)', () => {
    const byLine = liveness(own(p => p.procs.push({ pid: 901, ppid: 10, created: ft(5), name: 'claude.exe', ids: [W] })), W, NOW, { self: { pid: 100, created: ft(2) } })
    expect(byLine.verdict).toBe('live')
    expect(byLine.evidence.some(line => line.startsWith('L2: claude.exe 901'))).toBe(true)
    const byEntry = liveness(own(p => (p.procs.push({ pid: 902, ppid: 10, created: ft(6), name: 'claude.exe' }), p.registry.push(entry(902, W, ft(6))))), W, NOW, { self: { pid: 100, created: ft(2) } })
    expect(byEntry.verdict).toBe('live')
    expect(byEntry.evidence.some(line => line.startsWith('L1: claude.exe 902'))).toBe(true)
  })

  test('a self whose start time is not this process\'s is no self: the pid alone excludes nothing', () => {
    const live = liveness(own(), W, NOW, { self: { pid: 100, created: ft(9) } })
    expect(live.verdict).toBe('live')
    expect(live.evidence.some(line => line.startsWith('L1: claude.exe 100'))).toBe(true)
  })

  test('an unknown is still unknown', () => {
    expect(liveness(own(p => p.procs.push({ pid: 903, ppid: 10, created: ft(7), name: 'claude.exe' })), W, NOW, { self: { pid: 100, created: ft(2) } }).verdict).toBe('unknown')
  })

  test('a self whose own current registry entry names another conversation waives nothing: a fresh transcript of the id still reads live (S1-4)', () => {
    // This process moved in place to X a minute ago; W, still on its command line, was written 30 s ago
    // by a holder the probe doesn't see. L1 and L2 are clean; L3 must stand.
    const moved = own(p => (p.registry = p.registry.map(r => (r.file === 100 ? entry(100, X, ft(2)) : r))))
    const live = liveness(moved, W, NOW, { heartbeat: { at: NOW - 1000 }, self: { pid: 100, created: ft(2) } })
    expect(live.verdict).toBe('live')
    expect(live.evidence).toContain('L3: its transcript was written 30 s ago')
    expect(live.evidence).toContain('L5: its heartbeat is 1 s old')
    expect(live.evidence).toContain(`L3 and L5 are read: this process's own current registry entry (claude.exe 100) doesn't name ${W}, so it isn't known to be its own conversation`)
    // Its own entry naming W: waived, as before.
    expect(liveness(own(), W, NOW, { heartbeat: { at: NOW - 1000 }, self: { pid: 100, created: ft(2) } }).verdict).toBe('not-live')
  })

  test('a self the probe doesn\'t see running with that start waives nothing either (S1-4)', () => {
    const live = liveness(own(), W, NOW, { self: { pid: 100, created: ft(9) } })
    expect(live.evidence.some(line => line.startsWith('L3 and L5 are read: this process (claude.exe 100, started '))).toBe(true)
    expect(live.evidence).toContain('L3: its transcript was written 30 s ago')
  })
})

describe('the last look checks the record again (LR12)', () => {
  test('in place: the size and the time exactly; on exit: no write after at + 10 s; each after RECHECK, inside its catch', () => {
    const inPlace = claimCheckScript({ stateDir: STATE, id: T, by: LAUNCH, configDirs: [CONFIG], left: { size: 4096, mtime: NOW - 55_000 } })
    expect(inPlace).toContain(`$leftSize = 4096; $leftMtime = ${NOW - 55_000}; $leftExitAt = $null`)
    expect(inPlace).toContain('  elseif ([long]$seen[0].Length -ne [long]$leftSize -or ([DateTimeOffset]$seen[0].LastWriteTimeUtc).ToUnixTimeMilliseconds() -ne [long]$leftMtime) { $live = "its transcript changed since it was left (another process may have resumed it)" }')
    const exit = claimCheckScript({ stateDir: STATE, id: T, by: LAUNCH, configDirs: [CONFIG], left: { exitAt: NOW - 60_000 } })
    expect(exit).toContain(`$leftSize = $null; $leftMtime = $null; $leftExitAt = ${NOW - 60_000}`)
    expect(exit).toContain(`elseif ($null -ne $leftExitAt) { if (([DateTimeOffset]$seen[0].LastWriteTimeUtc).ToUnixTimeMilliseconds() -gt ([long]$leftExitAt + ${LEFT_EXIT_FLUSH_MS})) {`)
    for (const script of [inPlace, exit]) {
      // The block itself is LEFT_RECHECK, line for line: the claude wrapper carries the same lines.
      for (const line of LEFT_RECHECK) expect(script).toContain(line)
      expect(script.indexOf('$leftSize = ')).toBeLessThan(script.indexOf('$seen = @('))
      expect(script.indexOf('$seen = @(')).toBeGreaterThan(script.indexOf(RECHECK[RECHECK.length - 1] ?? ''))
      expect(script.indexOf('$seen = @(')).toBeLessThan(script.indexOf('} catch { $live = "whether it is open elsewhere is unknown'))
      // Not one transcript now: unknown, which refuses.
      expect(script).toContain('if ($seen.Count -ne 1) { $live = "its transcript is not one file on this machine now (" + $seen.Count + " found), so whether it changed since it was left is unknown" }')
    }
    // Without a record, the check is as it was.
    expect(claimCheckScript({ stateDir: STATE, id: T, by: LAUNCH, configDirs: [CONFIG] })).not.toContain('$seen = @(')
  })

  test('a stat that is not whole numbers is refused before it is spliced in', () => {
    expect(() => leftRecheck({ size: 1.5, mtime: 1 })).toThrow()
    expect(() => leftRecheck({ exitAt: Number.NaN })).toThrow()
    expect(() => claimCheckScript({ stateDir: STATE, id: T, by: LAUNCH, configDirs: [CONFIG], left: { size: -1, mtime: 1 } })).toThrow()
  })
})

describe('the scripts that write and read it, as text', () => {
  const write = leftScript({ stateDir: STATE, id: W, how: 'in-place', configDirs: [CONFIG], by: 'self-switch' })
  const read = probeScript({ ids: [W, T], configDirs: [CONFIG], stateDir: STATE, left: true })

  test('LR14: left.key is made whole under another name (CreateNew) and moved into place, which a key already there refuses: never replaced, never torn where it is read; 32 bytes from RandomNumberGenerator', () => {
    expect(write).toContain('$keyStream = [IO.File]::Open($keyTmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)')
    expect(write).toContain('    [IO.File]::Move($keyTmp, $leftKeyPath)')
    expect(write.indexOf('$keyStream.Write($fresh, 0, 32); $keyStream.Flush($true)')).toBeLessThan(write.indexOf('[IO.File]::Move($keyTmp, $leftKeyPath)'))
    expect(write).not.toMatch(/Replace\(\$keyTmp|Delete\(\$leftKeyPath/)
    // A key of another length (one torn by an earlier version) is said, with how to start again (S1-11).
    expect(write).toMatch(/'refused key the left key \(' \+ \$leftKeyPath \+ '\) can not be read as 32 bytes: .+delete it, and the next record makes a new one/)
    expect(write).toContain('$rng = [Security.Cryptography.RandomNumberGenerator]::Create(); try { $rng.GetBytes($fresh) }')
    expect(write).toContain('$fresh = New-Object byte[] 32')
    // The lock alone is opened or made (a leftover no one holds is just opened), sharing nothing, deleted on close.
    const lockLine = write.split(/\r?\n/).filter(line => line.includes('$leftLock = [IO.FileStream]::new($leftLockPath'))
    expect(lockLine).toHaveLength(1)
    expect(lockLine[0]).toContain('[IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose')
    expect(write.split(/\r?\n/).filter(line => !line.includes('$leftLockPath')).join('\n')).not.toMatch(/FileMode\]::(Create|OpenOrCreate|Truncate)\b(?!New)/)
    expect(write).not.toMatch(/WriteAllBytes\(\$leftKeyPath/)
    // The reader never makes the key: every line that names it reads it, or asks whether it is there.
    const keyLines = read.split(/\r?\n/).filter(line => line.includes('$leftKeyPath'))
    expect(keyLines.length).toBeGreaterThan(1)
    for (const line of keyLines) expect(line).not.toMatch(/FileMode|WriteAll|Create|Set-Content|Out-File/)
    expect(write).toContain(`$leftKeyPath = '${STATE}\\left.key'`)
  })

  test('LR13: the key never reaches output: no statement prints it, and it is let go once the MAC is made', () => {
    for (const script of [write, read]) {
      // The key is only ever assigned, read by Get-LeftMac, compared or let go: never a bare statement, never in a string.
      const uses = script.split(/\r?\n/).filter(line => /\$leftKey\b/.test(line))
      expect(uses.length).toBeGreaterThan(0)
      for (const line of uses) {
        // Each mention of the key is one of these, and no other: assigned, measured, compared, MAC'd, let go.
        const rest = line.replace(/\$leftKey = |\$leftKey\.Length|Get-LeftMac \$leftKey|\$null -eq \$leftKey|\$null -ne \$leftKey/g, '')
        expect(rest).not.toMatch(/\$leftKey\b/)
        expect(line).not.toMatch(/"[^"\r\n]*\$leftKey\b[^"\r\n]*"/)
        expect(line).not.toMatch(/Write-(Host|Output)/)
      }
    }
    expect(write.indexOf('$leftKey = $null', write.indexOf('$mac = Get-LeftMac'))).toBeGreaterThan(0)
    // The probe says only whether the MAC matched.
    expect(read).toContain('$macOk = (Get-LeftMac $leftKey (Get-LeftText $f)) -ceq $r.mac')
    expect(read).not.toMatch(/\$o\["?(mac|key)"?\]\s*=|mac = \$r\.mac/)
  })

  test('the MAC is over every field in a fixed order, the same text for the writer and the reader', () => {
    const text = 'function Get-LeftText($f) { return "ac3k-left/1`n" + (@($f.id, $f.how, $f.pid, $f.created, $f.at, $f.dir, $f.project, $f.size, $f.mtime, $f.by, $f.go) -join "`n") }'
    expect(write).toContain(text)
    expect(read).toContain(text)
    // The reader checks each field against its pattern before it is MAC'd or printed.
    expect(read).toContain('foreach ($k in $rules.Keys) { if ($f[$k] -isnot [string] -or $f[$k] -cnotmatch $rules[$k]) { return $null } }')
    // The writer stats the one transcript, writes the record whole (a temporary file, then a move or a replace).
    expect(write).toContain('if ($found.Count -ne 1) { "refused transcript " + $found.Count + " transcripts of it are on this machine, not one"; exit 0 }')
    expect(write).toContain('[IO.File]::Replace($temp, $final, [NullString]::Value)')
    expect(write).toContain(`$leftPath = '${STATE}\\left\\${W}.json'`)
  })

  test('the writer is the coordinator or self-switch, never self-restart; every input is checked', () => {
    expect(() => leftScript({ stateDir: STATE, id: W, how: 'exit', configDirs: [CONFIG], by: 'self-restart' as never })).toThrow(/self-restart resumes its own conversation/)
    for (const id of ['', '..\\x', `${W}'`, W.toUpperCase()]) expect(() => leftScript({ stateDir: STATE, id, how: 'exit', configDirs: [CONFIG], by: 'self-switch' })).toThrow()
    expect(() => leftScript({ stateDir: STATE, id: W, how: 'gone' as never, configDirs: [CONFIG], by: 'self-switch' })).toThrow()
    expect(() => leftScript({ stateDir: STATE, id: W, how: 'exit', configDirs: [CONFIG], by: 'coordinator', go: "wu_x'; calc" })).toThrow()
    expect(() => leftScript({ stateDir: STATE, id: W, how: 'exit', configDirs: [], by: 'self-switch' })).toThrow()
    const named = leftScript({ stateDir: STATE, id: W, how: 'exit', configDirs: [CONFIG], by: 'coordinator', go: 'wu_abc123', process: { pid: 100, created: ft(2) } })
    expect(named).toContain("$go = 'wu_abc123'")
    expect(named).toContain(`if ([long]$session.ProcessId -ne 100 -or [math]::Abs([long](Get-Created $session) - [long]'${ft(2)}') -gt 10000) { 'refused process`)
  })

  test("the probe reads each asked id's record at a path built from the checked id, and answers only checked fields", () => {
    // One pair added whole per conversation: @(@(a, b)) would unroll a lone pair into two strings.
    expect(read).toContain('$leftPaths = New-Object System.Collections.ArrayList')
    expect(read).toContain(`[void]$leftPaths.Add(@('${W}', '${STATE}\\left\\${W}.json'))`)
    expect(read).toContain(`[void]$leftPaths.Add(@('${T}', '${STATE}\\left\\${T}.json'))`)
    expect(read).toContain('if ((Get-Item -LiteralPath $lp -Force).Length -le 8192)')
    expect(() => probeScript({ ids: [W], configDirs: [CONFIG], left: true })).toThrow(/state folder/)
    // An answer's left records are checked field by field.
    const answer = (left: unknown) => parseProbe(`${JSON.stringify({ ...machine(), left })}\r\n`)
    expect('error' in answer([{ asked: T, ok: false }])).toBe(false)
    expect('error' in answer([{ asked: T, ok: false, id: T }])).toBe(true)
    expect('error' in answer([{ asked: T, ok: true, id: T, how: 'exit', pid: 1, created: '1', at: 1, transcript: { dir: 0, project: PROJECT, size: 1, mtime: 1 }, by: 'self-restart', macOk: true }])).toBe(true)
    expect('error' in answer([{ asked: T, ok: true, id: T, how: 'exit', pid: 1, created: '1', at: 1, transcript: { dir: 0, project: PROJECT, size: 1, mtime: 1 }, by: 'self-switch', macOk: true, key: 'x' }])).toBe(true)
  })
})
