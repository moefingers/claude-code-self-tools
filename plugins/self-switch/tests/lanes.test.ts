// lanes.json (D65), in the shared machine code: the strict reader that drops a malformed entry and
// keeps the rest, and the fixed script that merges one entry under a lock, as text. The script runs
// for real, two at once, in scripts/lanes.test.mjs (Windows, temporary folders only).
import { describe, expect, test } from 'claude-code/testing'
import { isWindowName, laneEntry, lanesPath, lanesUpdateScript, LANES_WRITTEN, readLanes } from '../hooks/machine'
import { ELSEWHERE, NOW, REPO, T, W } from './fixtures'

const CONFIG = 'C:\\Users\\u\\.claude'
const ENTRY = { session: T, folder: ELSEWHERE, window: 'claude-1', tab: 'dealerwrap', ws: 'default', at: NOW }

describe('readLanes: strict, a malformed entry dropped, the rest kept', () => {
  test('a well-formed file', () => {
    const text = JSON.stringify({ v: 1, at: NOW, lanes: { dealerwrap: ENTRY, 'ui-general': { session: W, folder: REPO, ws: 'w_abcdef012345', at: NOW } } })
    expect(readLanes(text)).toEqual({ at: NOW, lanes: { dealerwrap: ENTRY, 'ui-general': { session: W, folder: REPO, ws: 'w_abcdef012345', at: NOW } } })
    // A BOM is read past.
    expect(readLanes(`\uFEFF${text}`)).toEqual(readLanes(text))
  })

  test('each malformed entry is dropped, by itself', () => {
    const bad: Record<string, unknown> = {
      'Upper-Case': ENTRY,
      'not a name': ENTRY,
      'bad-id': { ...ENTRY, session: 'not-a-uuid' },
      'upper-id': { ...ENTRY, session: T.toUpperCase() },
      'quote-folder': { ...ENTRY, folder: "C:\\o'brien" },
      'semicolon-folder': { ...ENTRY, folder: 'C:\\a;b' },
      'relative-folder': { ...ENTRY, folder: 'work\\x' },
      'window-0': { ...ENTRY, window: '0' },
      'window-last': { ...ENTRY, window: 'last' },
      'window-new': { ...ENTRY, window: 'NEW' },
      'window-minus': { ...ENTRY, window: '-1' },
      'window-digits': { ...ENTRY, window: '12' },
      'window-space': { ...ENTRY, window: 'claude 1' },
      'tab-bad': { ...ENTRY, tab: 'tab;calc' },
      'ws-bad': { ...ENTRY, ws: 'w_short' },
      'at-bad': { ...ENTRY, at: -1 },
      'extra-key': { ...ENTRY, prompt: 'do things' },
      'not-object': 'x',
      good: ENTRY,
    }
    const read = readLanes(JSON.stringify({ v: 1, at: NOW, lanes: bad }))
    expect(read).toEqual({ at: NOW, lanes: { good: ENTRY } })
  })

  test('the file itself strict: not JSON, another version, an unknown field, no lanes', () => {
    expect(readLanes('{')).toEqual({ error: 'lanes.json is not JSON' })
    expect(readLanes(JSON.stringify({ v: 2, at: NOW, lanes: {} }))).toEqual({ error: 'lanes.json is not version 1' })
    expect(readLanes(JSON.stringify({ v: 1, at: NOW, lanes: {}, extra: 1 }))).toEqual({ error: 'lanes.json has an unknown field "extra"' })
    expect(readLanes(JSON.stringify({ v: 1, at: NOW }))).toEqual({ error: 'lanes.json has no time or no lanes' })
  })

  test('window names WT reads as special are never names', () => {
    for (const name of ['0', '1', '42', '-1', 'last', 'Last', 'new', 'NEW', '', 'a;b', 'a b', 'x'.repeat(41)]) expect(isWindowName(name)).toBe(false)
    for (const name of ['claude-1', 'claude_overflow', 'w1', 'newer', 'lastly']) expect(isWindowName(name)).toBe(true)
  })
})

describe('lanesUpdateScript: one entry merged under a lock, the file replaced whole', () => {
  const script = lanesUpdateScript({ configDir: CONFIG, name: 'dealerwrap', entry: ENTRY })

  test('the path, the name and the entry, each a literal of a checked value', () => {
    expect(lanesPath(CONFIG)).toBe(`${CONFIG}\\lanes.json`)
    expect(lanesPath(`${CONFIG}\\`)).toBe(`${CONFIG}\\lanes.json`)
    expect(script).toContain(`$path = '${CONFIG}\\lanes.json'`)
    expect(script).toContain("$name = 'dealerwrap'")
    expect(script).toContain(`$entryText = '${JSON.stringify(laneEntry('dealerwrap', ENTRY))}'`)
    expect(LANES_WRITTEN.exec('lanes dealerwrap\r\n')?.[1]).toBe('dealerwrap')
  })

  test('a bad name, id, folder, window, tab or workspace is refused before anything is written', () => {
    expect(() => lanesUpdateScript({ configDir: CONFIG, name: 'Dealer Wrap', entry: ENTRY })).toThrow()
    expect(() => lanesUpdateScript({ configDir: CONFIG, name: "x'; calc", entry: ENTRY })).toThrow()
    for (const change of [{ session: 'x' }, { folder: 'C:\\a;b' }, { folder: "C:\\o'brien" }, { window: 'last' }, { window: '0' }, { tab: "a'b" }, { ws: 'nope' }, { at: Number.NaN }]) {
      expect(() => lanesUpdateScript({ configDir: CONFIG, name: 'dealerwrap', entry: { ...ENTRY, ...change } as never })).toThrow()
    }
    expect(() => lanesUpdateScript({ configDir: 'relative', name: 'dealerwrap', entry: ENTRY })).toThrow()
  })

  test('the lock: a handle no one else may open, held from before the read to after the write, gone with its process (DeleteOnClose)', () => {
    const lock = script.indexOf('$lock = [IO.FileStream]::new($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose)')
    expect(lock).toBeGreaterThan(0)
    expect(lock).toBeLessThan(script.indexOf('[IO.File]::ReadAllText($path'))
    expect(script.indexOf('} finally { $lock.Dispose() }')).toBeGreaterThan(script.indexOf('[IO.File]::Replace($temp, $final, [NullString]::Value)'))
    // A writer that can't have it within 40 tries, 250 ms apart, writes nothing.
    expect(script).toContain('for ($try = 0; $try -lt 40 -and $null -eq $lock; $try++) {')
    expect(script).toContain("if ($null -eq $lock) { 'refused lock another writer held lanes.json for 10 seconds'; exit 0 }")
    // A lock file being deleted (closed while a scanner has it open) refuses access: waited for too (S1-12).
    expect(script).toContain('$_.Exception -is [UnauthorizedAccessException] -or $_.Exception.InnerException -is [UnauthorizedAccessException])) { throw }; Start-Sleep -Milliseconds 250 }')
  })

  test('every other entry is kept as it is, names compared exactly (S1-12); a file not of its shape is left alone, saying how to start again; the write is a temporary file and a Replace, never a write in place', () => {
    // An ordinal dictionary: a hand-written `Foo` beside this `foo` stays its own entry, never folded into one.
    expect(script).toContain('$lanes = [Collections.Specialized.OrderedDictionary]::new([StringComparer]::Ordinal)')
    expect(script).not.toContain('[ordered]@{}')
    expect(script).toContain("foreach ($p in $doc.lanes.PSObject.Properties) { if ($p.Name -cne $name -and $p.Name -cmatch '^[a-z0-9][a-z0-9-]{0,39}\\z') { $lanes[$p.Name] = $p.Value } }")
    expect(script).toContain("'refused file lanes.json is not of its shape, so it is left as it is: not JSON, not version 1, no lanes object, or two names in it that differ only in case. Fix it by hand, or move it aside (rename it lanes.json.bad), and the next write starts a new one'; exit 0")
    expect(script).toContain('[IO.File]::WriteAllText($temp, $text)')
    expect(script).toContain('[IO.File]::Replace($temp, $final, [NullString]::Value)')
    expect(script).not.toMatch(/WriteAllText\(\$path|WriteAllText\(\$final|Set-Content|Out-File/)
    // No transcript is read, and nothing but lanes.json and its lock is touched.
    expect(script).not.toMatch(/\.jsonl/)
  })
})
