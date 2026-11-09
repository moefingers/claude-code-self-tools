// A return trip in place (#31), in the shared machine code, on fixture probes. Claude Code's session
// registry keeps the conversation a process left in place in `formerNames[].sessionId`. liveness reads
// that as a conversation the process held earlier, not one it holds now, only for this very process
// (`self`: its pid and start) and only with its own left record of that conversation (its shape, its
// MAC, its id, its pid and start). Any other process naming it there, or anywhere outside its sessionId,
// is unknown as before. Each test pairs its refusal with the return trip that passes, so each fails
// without the fix. scripts/former-names.test.mjs runs the probe's and the last look's PowerShell for real.
import { describe, expect, test } from 'claude-code/testing'
import { claimCheckScript, liveness, parseProbe, type Probe, probeScript, RECHECK, RECHECK_SELF } from '../hooks/machine'
import { entry, ft, LAUNCH, machine, NOW, PROJECT, type RawProbe, T, W } from './fixtures'

const STATE = 'C:\\Users\\u\\AppData\\Local\\claude-self-tools'
const CONFIG = 'C:\\Users\\u\\.claude'

/** This session's claude.exe, 100, by its pid and start: the one that goes back to T. */
const SELF = { pid: 100, created: ft(2) }
/** A conversation the other process (200) held earlier, for a formerNames of two entries. */
const Y = '00000000-0000-0000-0000-00000000000a'

/** The fixture as the plugin reads it: through parseProbe, which must accept it. */
function probeOf(change?: (probe: RawProbe) => void): Probe {
  const parsed = parseProbe(`${JSON.stringify(machine(change))}\r\n`)
  if ('error' in parsed) throw new Error(parsed.error)
  return parsed
}

type Record_ = Record<string, unknown>

/**
 * The return trip: claude.exe 100 held T, moved in place to W a minute ago, and now goes back. Its
 * registry file: sessionId W, and formerNames naming T, which the probe reports as `former`. Its left
 * record of T: in place, by 100 started ft(2), its MAC matched, T's transcript untouched since (written
 * 55 s ago, which alone reads live by L3). `record` and `file` alter the record and 100's file.
 */
function returnTrip(probe: RawProbe, record: (r: Record_) => void = () => undefined, file: (r: Record_) => void = () => undefined): void {
  probe.transcripts = probe.transcripts.map(t => (t.id === T ? { ...t, mtime: NOW - 55_000, size: 4096 } : t))
  probe.registry = probe.registry.map(r => {
    if (r.file !== 100) return r
    const mine: Record_ = { ...r, keys: [...(r.keys ?? []), 'formerNames'], former: [T] }
    file(mine)
    return mine as typeof r
  })
  const left: Record_ = {
    asked: T,
    ok: true,
    id: T,
    how: 'in-place',
    pid: 100,
    created: ft(2),
    at: NOW - 60_000,
    transcript: { dir: 0, project: PROJECT, size: 4096, mtime: NOW - 55_000 },
    by: 'coordinator',
    macOk: true,
  }
  record(left)
  probe.left = [left]
}

/** T's verdict as an in-place go judges it: its left record taken into account, this process its self. */
const judged = (change?: (probe: RawProbe) => void, opts: Parameters<typeof liveness>[3] = {}) => liveness(probeOf(change), T, NOW, { mine: LAUNCH, left: true, self: SELF, ...opts })

const UNKNOWN_100 = 'unknown: the registry file of running claude.exe 100 names it outside its sessionId'
const UNKNOWN_200 = 'unknown: the registry file of running claude.exe 200 names it outside its sessionId'
const EARLIER_100 = "held earlier, not now: the registry file of claude.exe 100, this process, names it only in formerNames, and this process's left record says it left it"

describe('a return trip in place: formerNames is a conversation held earlier, for this process with its left record (#31)', () => {
  test("this process's own formerNames naming T, with its own left record of T: not live, saying why", () => {
    const live = judged(p => returnTrip(p))
    expect(live.verdict).toBe('not-live')
    expect(live.evidence).toEqual([
      EARLIER_100,
      `L3 and L5 are read: this process's own current registry entry (claude.exe 100) doesn't name ${T}, so it isn't known to be its own conversation`,
      'L3 and L5 waived: it was left cleanly (in-place) by claude.exe 100 1 min ago, and its transcript is untouched since',
    ])
    expect(live.waived).toEqual({ size: 4096, mtime: NOW - 55_000 })
    // Started as `claude --resume T` (its command line still names T): the same, it is this process.
    const resumed = judged(p => (returnTrip(p), (p.procs = p.procs.map(x => (x.pid === 100 ? { ...x, ids: [T] } : x)))))
    expect(resumed.verdict).toBe('not-live')
  })

  test('the same formerNames entry with no left record: unknown, as before', () => {
    const none = judged(p => (returnTrip(p), (p.left = [])))
    expect(none.verdict).toBe('live')
    expect(none.evidence).toContain(UNKNOWN_100)
    expect(none.evidence).not.toContain(EARLIER_100)
    // Its transcript an hour old (no L3 without a waiver): the registry's unknown alone.
    const quiet = judged(p => (returnTrip(p), (p.left = []), (p.transcripts = p.transcripts.map(t => (t.id === T ? { ...t, mtime: NOW - 60 * 60_000 } : t)))))
    expect(quiet).toEqual({ verdict: 'unknown', evidence: [UNKNOWN_100, `L3 and L5 are read: this process's own current registry entry (claude.exe 100) doesn't name ${T}, so it isn't known to be its own conversation`] })
    expect(judged(p => returnTrip(p)).verdict).toBe('not-live')
  })

  // The left record must be this process's, of this conversation: each field the rule reads, broken in turn.
  for (const [name, record] of [
    ['by another pid (777, gone)', (r: Record_) => (r.pid = 777)],
    ['by this pid at another start (an earlier process of the same pid)', (r: Record_) => (r.created = ft(9))],
    ['whose MAC does not match', (r: Record_) => (r.macOk = false)],
    ['not of its shape (another version)', (r: Record_) => { for (const key of Object.keys(r)) if (key !== 'asked') delete r[key]; r.ok = false }],
    ['naming another conversation (left\\<W>.json renamed to T\'s name)', (r: Record_) => (r.id = W)],
  ] as const) {
    test(`a left record ${name}: unknown, as before`, () => {
      const live = judged(p => returnTrip(p, record))
      expect(live.verdict).not.toBe('not-live')
      expect(live.evidence).toContain(UNKNOWN_100)
      expect(live.evidence).not.toContain(EARLIER_100)
      expect(judged(p => returnTrip(p)).verdict).toBe('not-live')
    })
  }

  test('two left records of T read, or left records that could not be read, or a caller that takes none: unknown', () => {
    const two = judged(p => (returnTrip(p), (p.left = [...(p.left ?? []), { ...(p.left?.[0] ?? {}) }])))
    expect(two.evidence).toContain(UNKNOWN_100)
    const unread = judged(p => (returnTrip(p), (p.errors = ['left:'])))
    expect(unread.evidence).toContain(UNKNOWN_100)
    // A caller that takes no left records: no waiver either, so L3 reads it live as well.
    const notTaken = judged(p => returnTrip(p), { left: false })
    expect(notTaken.verdict).toBe('live')
    expect(notTaken.evidence).toContain(UNKNOWN_100)
    expect(judged(p => returnTrip(p)).verdict).toBe('not-live')
  })

  test('the self check: without `self`, or a self of another start, unknown; a self of this pid and start, not live', () => {
    const noSelf = liveness(probeOf(p => returnTrip(p)), T, NOW, { mine: LAUNCH, left: true })
    expect(noSelf.verdict).toBe('unknown')
    expect(noSelf.evidence).toContain(UNKNOWN_100)
    // A self, and a record, both of a start that isn't the running 100's: no process of this start runs.
    const otherStart = judged(p => returnTrip(p, r => (r.created = ft(9))), { self: { pid: 100, created: ft(9) } })
    expect(otherStart.verdict).toBe('unknown')
    expect(otherStart.evidence).toContain(UNKNOWN_100)
    // Another process as `self` (200, with a record of its own): 100's formerNames is still unknown.
    const otherSelf = judged(p => returnTrip(p, r => ((r.pid = 200), (r.created = ft(3)))), { self: { pid: 200, created: ft(3) } })
    expect(otherSelf.verdict).toBe('unknown')
    expect(otherSelf.evidence).toContain(UNKNOWN_100)
    expect(judged(p => returnTrip(p)).verdict).toBe('not-live')
  })

  test('this process\'s file naming T in formerNames and anywhere else too: unknown', () => {
    const elsewhere = judged(p => returnTrip(p, undefined, r => (r.mentions = [T])))
    expect(elsewhere.verdict).toBe('unknown')
    expect(elsewhere.evidence).toContain(UNKNOWN_100)
    expect(judged(p => returnTrip(p)).verdict).toBe('not-live')
  })

  test("a stale file of this pid (its procStart is not this process's start): unknown", () => {
    const stale = judged(p => returnTrip(p, undefined, r => (r.procStart = ft(9))))
    expect(stale.verdict).not.toBe('not-live')
    expect(stale.evidence).toContain(UNKNOWN_100)
    expect(judged(p => returnTrip(p)).verdict).toBe('not-live')
  })

  test('another running process with T in its formerNames: unknown, beside this process\'s own return trip', () => {
    const other = (r: Record_) => ((r.keys = [...(r.keys as string[]), 'formerNames']), (r.former = [Y, T]))
    const live = judged(p => (returnTrip(p), other(p.registry.find(x => x.file === 200) as Record_)))
    expect(live.verdict).toBe('unknown')
    expect(live.evidence).toContain(UNKNOWN_200)
    // This process's own is settled all the same; only 200's is unknown.
    expect(live.evidence).toContain(EARLIER_100)
    expect(live.evidence).not.toContain(UNKNOWN_100)
    // 200 with a left record of its own of T: 200 isn't this process, so it is still unknown.
    const recorded = judged(p => (returnTrip(p, r => ((r.pid = 200), (r.created = ft(3)))), other(p.registry.find(x => x.file === 200) as Record_)))
    expect(recorded.evidence).toContain(UNKNOWN_200)
    expect(recorded.evidence).toContain(UNKNOWN_100)
    expect(judged(p => returnTrip(p)).verdict).toBe('not-live')
  })

  test('T in the sessionId of another live process: live (L1), unchanged; with that process gone, the return trip passes', () => {
    const held = judged(p => (returnTrip(p), (p.registry = p.registry.map(r => (r.file === 200 ? entry(200, T, ft(3)) : r)))))
    expect(held.verdict).toBe('live')
    expect(held.evidence.some(line => line.startsWith('L1: claude.exe 200'))).toBe(true)
    const gone = judged(p => (returnTrip(p), (p.registry = p.registry.map(r => (r.file === 200 ? entry(200, T, ft(3)) : r))), (p.procs = p.procs.filter(x => x.pid !== 200))))
    expect(gone.verdict).toBe('not-live')
  })

  test("what the probe says a file names as formerNames is checked: session ids, at most 8, only in a file that parsed", () => {
    const bad = (change: (r: Record_) => void) => parseProbe(JSON.stringify(machine(p => change(p.registry.find(x => x.file === 200) as Record_))))
    expect(bad(r => (r.former = ['not-an-id']))).toMatchObject({ error: expect.stringContaining('former conversations are not session ids') })
    expect(bad(r => (r.former = Array.from({ length: 9 }, () => T)))).toMatchObject({ error: expect.stringContaining('former conversations are not session ids') })
    expect(bad(r => (r.former = T))).toMatchObject({ error: expect.stringContaining('former conversations are not session ids') })
    expect(parseProbe(JSON.stringify(machine(p => p.registry.push({ dir: 0, file: 500, ok: false, former: [T] }))))).toMatchObject({ error: expect.stringContaining('former conversations are not session ids') })
    const read = probeOf(p => returnTrip(p))
    expect(read.registry.find(r => r.file === 100)).toMatchObject({ shape: 'ok', former: [T], mentions: [] })
    expect(read.registry.find(r => r.file === 200)).toMatchObject({ shape: 'ok', former: [], mentions: [] })
  })
})

describe("the in-place last look of a return trip: RECHECK_SELF, given this process (#31)", () => {
  test('one line more than RECHECK, right before its refusal of a conversation named outside its sessionId', () => {
    const at = RECHECK.findIndex(line => line.startsWith('    if ($named) {'))
    expect(at).toBeGreaterThan(0)
    expect(RECHECK_SELF).toHaveLength(RECHECK.length + 1)
    expect(RECHECK_SELF.slice(0, at)).toEqual(RECHECK.slice(0, at))
    expect(RECHECK_SELF.slice(at + 1)).toEqual(RECHECK.slice(at))
    const line = RECHECK_SELF[at] ?? ''
    // This process's own current file (its pid, its procStart its start, and its start the one given),
    // naming T only as a formerNames entry's sessionId, with its own left record of T.
    expect(line).toContain('if ($named -and $selfLeft -and [long]$f.BaseName -eq $selfPid -and $near)')
    expect(line).toContain('[long]$e.pid -eq $selfPid -and [math]::Abs([decimal]$p.CreationDate.ToFileTimeUtc() - [decimal]$selfCreated) -le 10000')
    expect(line).toContain('$said = Get-Mentions $e @($id); if ($selfStart -and $said.former -ccontains $id -and $said.mentions.Count -eq 0) { $named = $false }')
  })

  test("with self: this process, Get-Mentions and its own left record read first, then RECHECK_SELF; without: as it was", () => {
    const check = claimCheckScript({ stateDir: STATE, id: T, by: LAUNCH, configDirs: [CONFIG], self: SELF })
    expect(check).toContain('$selfPid = 100')
    expect(check).toContain(`$selfCreated = '${ft(2)}'`)
    expect(check).toContain('function Get-Mentions($e, $ids) {')
    expect(check).toContain(`$leftKeyPath = '${STATE}\\left.key'`)
    expect(check).toContain(`[void]$leftPaths.Add(@('${T}', '${STATE}\\left\\${T}.json'))`)
    expect(check).toContain('$macOk = (Get-LeftMac $leftKey (Get-LeftText $f)) -ceq $r.mac')
    expect(check).toContain('try { if ($errors.Count -eq 0 -and $leftOut.Count -eq 1) { $l = $leftOut[0]; $selfLeft = ($l.ok -eq $true -and $l.macOk -eq $true -and $l.id -ceq $id -and [long]$l.pid -eq $selfPid -and [math]::Abs([decimal]$l.created - [decimal]$selfCreated) -le 10000) } } catch { $selfLeft = $false }')
    let from = check.indexOf('$selfLeft = $false')
    expect(from).toBeLessThan(check.indexOf('$live = $null'))
    for (const line of RECHECK_SELF) {
      const at = check.indexOf(`  ${line}`, from)
      expect(at).toBeGreaterThan(from)
      from = at
    }
    // Without self, the in-place check is RECHECK alone, as before: no Get-Mentions, no left record read.
    const plain = claimCheckScript({ stateDir: STATE, id: T, by: LAUNCH, configDirs: [CONFIG] })
    expect(plain).not.toContain('Get-Mentions')
    expect(plain).not.toContain('$selfLeft')
    expect(plain).not.toContain('left.key')
    // A self that isn't a pid and a FILETIME is refused before it is spliced in.
    expect(() => claimCheckScript({ stateDir: STATE, id: T, by: LAUNCH, configDirs: [CONFIG], self: { pid: -1, created: ft(2) } })).toThrow(/not a pid/)
    expect(() => claimCheckScript({ stateDir: STATE, id: T, by: LAUNCH, configDirs: [CONFIG], self: { pid: 100, created: "1'; exit" } })).toThrow(/not a pid/)
  })

  test("the probe reads formerNames with the same Get-Mentions", () => {
    const probe = probeScript({ ids: [W, T], configDirs: [CONFIG], stateDir: STATE })
    const check = claimCheckScript({ stateDir: STATE, id: T, by: LAUNCH, configDirs: [CONFIG], self: SELF })
    const fn = (text: string) => text.slice(text.indexOf('function Get-Mentions($e, $ids) {'), text.indexOf("  return @{ mentions = $mentioned; former = $former }"))
    expect(fn(probe).length).toBeGreaterThan(100)
    expect(fn(check)).toBe(fn(probe))
    expect(probe).toContain('    if ($prop.Name -ceq "formerNames" -and $prop.Value -is [Array]) {')
    expect(probe).toContain('            if ($q.Name -ceq "sessionId" -and $q.Value -is [string]) { [void]$held.Add($q.Value) }')
    expect(probe).toContain('      if (-not $former.Contains($a) -and $held -ccontains $a) { [void]$former.Add($a) }')
  })
})
