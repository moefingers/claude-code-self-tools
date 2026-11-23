// self-update's pure side (hooks/update-logic.ts and hooks/scripts.ts): the settings read (empty is off; any entry that
// is not a name's shape turns the whole thing off), when a look is due, what is run for which install records (only a
// named marketplace's, only a plugin with a record, never a word but the fixed ones), what an install changed and the
// line it gets, the failures' counts and their toasts, the files the machine keeps (the lock shared with another plugin
// that keeps plugins current, a state file of its own), when a session reloads for an install (and at most twice for
// one), what a failing command's line keeps of a secret, and what update_status says. The script that runs a command is
// held to its text here; scripts/self-update.test.mjs runs it by a real Windows PowerShell where there is one.
import { describe, expect, test } from 'claude-code/testing'
import { COMMAND_MS, ENDED, INSIDE, LOCK_STALE_MS, NAME_SHAPE, NO_CLAUDE, REFUSED, RENEW_AFTER_MS, RUN_GRACE_MS, STEP_LEAST_MS, STEP_MS, TAKE_SCRIPT, UPDATE_SCRIPT } from '../hooks/scripts'
import {
  agoSaid,
  autoUpdateOf,
  behindInstall,
  ENDED_SAID,
  FAILS_TOLD,
  failureSaid,
  failuresNext,
  floorHolds,
  folderKey,
  INSTALL_AHEAD_MS,
  installedLine,
  installsChanged,
  installsOf,
  LINE_READ_MAX,
  lockText,
  LOOK_EVERY_MAX_MS,
  LOOK_EVERY_MS,
  lookDue,
  lookEveryMs,
  masked,
  maskedLine,
  NAME,
  NAMES_MAX,
  namesIdle,
  pluginsFolderOf,
  configFolderOf,
  PROJECT_FOLDER,
  quotedData,
  readReleaseReply,
  readReloadRecord,
  readStepReply,
  readTakeReply,
  readUpdateState,
  recordFor,
  RELOAD_EVERY_MS,
  RELOAD_HOLDS,
  RELOAD_TRIES,
  reloadAfterUpdateOf,
  reloadHold,
  reloadTook,
  RESTART_LINE,
  SECRET,
  secretName,
  statusText,
  stepEnv,
  stepSaid,
  stepWords,
  updateLockPath,
  updatePlan,
  updateStatePath,
  updateStateText,
  type Install,
  type ReloadInput,
  type Step,
} from '../hooks/update-logic'

const MINE = 'example-plugins'
const TOOLS = 'claude-code-self-tools'
const CACHE = 'C:\\Users\\tester\\.claude\\plugins\\cache'
const MINUTE = 60_000
const NOW = 1_700_000_000_000

const record = (plugin: string, marketplace: string, version: string, extra: Partial<Install> = {}): Install => ({ plugin, marketplace, scope: 'user', installPath: `${CACHE}\\${marketplace}\\${plugin}\\${version}`, version, ...extra })

/** A machine's records: a plugin in the user's scope and two local ones, two self tools, and plugins of two marketplaces the setting doesn't name. */
const INSTALLS: Install[] = [
  record('other-tool', 'vendor-plugins', '0.51.0'),
  record('self-wake', TOOLS, '0.4.0'),
  record('widget', MINE, '1.4.0', { scope: 'local', projectPath: 'D:\\work\\web' }),
  record('widget', MINE, '1.4.0'),
  record('widget', MINE, '1.4.0', { scope: 'local', projectPath: 'D:\\work\\api' }),
  record('self-exit', TOOLS, '0.1.11'),
  record('other', 'someone-elses', '1.0.0'),
]

describe('the settings', () => {
  test('autoUpdate unset or empty is off, and says nothing', () => {
    for (const raw of [undefined, null, '', '   ', '\n']) expect(autoUpdateOf(raw), String(raw)).toEqual({ names: [] })
  })

  test('autoUpdate names marketplaces, comma-separated: spaces around them and a comma too many are nothing, a name twice is once', () => {
    expect(autoUpdateOf(`${MINE}, ${TOOLS}`)).toEqual({ names: [MINE, TOOLS] })
    expect(autoUpdateOf(` ${MINE} ,${TOOLS},, ${MINE} ,`)).toEqual({ names: [MINE, TOOLS] })
    expect(autoUpdateOf('a.b_c-1')).toEqual({ names: ['a.b_c-1'] })
  })

  test('any entry that is not a name’s shape turns the whole feature off, the entries that fit too, and says why', () => {
    for (const bad of ['--force', '-f', 'a b', 'a/b', '../x', 'a@b', 'https://example.com/x', 'a;b', 'a|b', 'a$(b)', 'a`b', '"a"', 'a\nb', '.hidden', '_x', 'é', 'x'.repeat(65)]) {
      const read = autoUpdateOf(`${MINE}, ${bad}`)
      expect(read.names, bad).toEqual([])
      expect(read.why, bad).toContain("is not a marketplace's name")
      expect(NAME.test(bad), bad).toBe(false)
    }
    // A value of another kind, one that names nothing, and one that names too many.
    for (const raw of [5, true, [MINE], { names: [MINE] }]) expect(autoUpdateOf(raw)).toEqual({ names: [], why: 'its value is not text' })
    expect(autoUpdateOf(' , ,')).toEqual({ names: [], why: 'it names no marketplace' })
    expect(autoUpdateOf(Array.from({ length: NAMES_MAX + 1 }, (_, i) => `m${i}`).join(','))).toEqual({ names: [], why: `it names more than ${NAMES_MAX} marketplaces` })
    expect(autoUpdateOf(Array.from({ length: NAMES_MAX }, (_, i) => `m${i}`).join(',')).names).toHaveLength(NAMES_MAX)
    // The entry is quoted on one line, cut: never a line break of its own in the log.
    expect(autoUpdateOf(`ok,${'a b '.repeat(40)}`).why).not.toMatch(/[\r\n]/)
  })

  test('reloadAfterUpdate is on unless it says off', () => {
    for (const raw of [undefined, null, '', 'on', 'ON', 'yes', 5]) expect(reloadAfterUpdateOf(raw), String(raw)).toBe(true)
    for (const raw of ['off', 'OFF', ' off ']) expect(reloadAfterUpdateOf(raw), raw).toBe(false)
  })
})

describe('when a look is due', () => {
  test('none yet, or the last one five minutes ago or more; never sooner, however many sessions ask', () => {
    expect(LOOK_EVERY_MS).toBe(5 * MINUTE)
    expect(lookDue(undefined, NOW)).toBe(true)
    expect(lookDue(NOW, NOW)).toBe(false)
    expect(lookDue(NOW - LOOK_EVERY_MS + 1, NOW)).toBe(false)
    expect(lookDue(NOW - LOOK_EVERY_MS, NOW)).toBe(true)
    expect(lookDue(NOW - 60 * MINUTE, NOW)).toBe(true)
  })

  test('a time a little ahead is a look just made; one further ahead than the interval is never believed', () => {
    expect(lookDue(NOW + MINUTE, NOW)).toBe(false)
    expect(lookDue(NOW + LOOK_EVERY_MS, NOW)).toBe(false)
    expect(lookDue(NOW + LOOK_EVERY_MS + 1, NOW)).toBe(true)
    // One command's own timeout is well under the interval: a look under way always reads as fresh.
    expect(COMMAND_MS).toBeLessThan(LOOK_EVERY_MS)
  })

  test('this process’s own floor holds until its time, and never longer than the longest wait: a clock set back doesn’t silence the looks', () => {
    expect(floorHolds(NOW + MINUTE, NOW)).toBe(true)
    expect(floorHolds(NOW + LOOK_EVERY_MAX_MS, NOW)).toBe(true)
    expect(floorHolds(NOW, NOW)).toBe(false)
    expect(floorHolds(NOW - MINUTE, NOW)).toBe(false)
    // The clock set back two hours after a look: the floor, two hours and five minutes ahead, is not believed.
    expect(floorHolds(NOW + 2 * 60 * MINUTE + 5 * MINUTE, NOW)).toBe(false)
  })

  test('one step, the plugin’s backstop and its grace included, ends before a lock at most RENEW_AFTER_MS old as it starts is as old as TAKE’s own figure', () => {
    // scripts.ts: the script's own budget, the plugin's timeout on the script, the grace after it, and the renewal's age.
    expect(STEP_MS).toBe(55_000)
    expect(COMMAND_MS).toBe(75_000)
    expect(RENEW_AFTER_MS + COMMAND_MS + RUN_GRACE_MS).toBeLessThan(LOCK_STALE_MS)
    // The figure is TAKE's own: the lock script's bytes say it.
    expect(TAKE_SCRIPT).toContain(`$staleMs = ${LOCK_STALE_MS}\n`)
  })

  test('looks that can’t reach a marketplace in a row stretch the wait: 5 minutes, then 10, 20, 40, and an hour at most, until one reaches them all', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(n => lookEveryMs(n) / MINUTE)).toEqual([5, 10, 20, 40, 60, 60, 60])
    expect(LOOK_EVERY_MAX_MS).toBe(60 * MINUTE)
    // A count that is no count is none.
    for (const odd of [-3, Number.NaN, Number.POSITIVE_INFINITY, 0.9]) expect(lookEveryMs(odd), String(odd)).toBe(LOOK_EVERY_MS)
    // After one such look, 5 minutes on is too soon; after four, 59 minutes on is.
    expect(lookDue(NOW - 5 * MINUTE, NOW, 1)).toBe(false)
    expect(lookDue(NOW - 10 * MINUTE, NOW, 1)).toBe(true)
    expect(lookDue(NOW - 59 * MINUTE, NOW, 4)).toBe(false)
    expect(lookDue(NOW - 60 * MINUTE, NOW, 9)).toBe(true)
    // A day of such looks is 24 tries and the few on the way there, not 288.
    let at: number | undefined
    let n = 0
    for (let now = 0; now < 24 * 60 * MINUTE; now += MINUTE) {
      if (!lookDue(at, now, n)) continue
      at = now
      n += 1
    }
    expect(n).toBeGreaterThanOrEqual(24)
    expect(n).toBeLessThanOrEqual(28)
    // A look that reaches every marketplace brings the 5 minutes back, whether or not a plugin's own update failed in it.
    expect(lookDue(NOW - 5 * MINUTE, NOW, failuresNext({ fails: 9, told: true, unreached: 9 }, undefined).unreached)).toBe(true)
    expect(lookDue(NOW - 5 * MINUTE, NOW, failuresNext({ fails: 9, told: true, unreached: 9 }, 'a plugin step failed').unreached)).toBe(true)
    expect(lookDue(NOW - 5 * MINUTE, NOW, failuresNext({ fails: 9, told: true, unreached: 9 }, 'a refresh failed', 'a refresh failed').unreached)).toBe(false)
  })
})

describe('the install records, read', () => {
  const file = (plugins: unknown) => JSON.stringify({ version: 2, plugins })

  test('every record of every plugin, with its marketplace, scope, folder, project and version', () => {
    const text = file({
      [`widget@${MINE}`]: [
        { scope: 'user', installPath: `${CACHE}\\a`, version: '1.4.0', installedAt: 'x', lastUpdated: 'y', gitCommitSha: 'a'.repeat(40) },
        { scope: 'local', projectPath: 'D:\\work\\web', installPath: `${CACHE}\\a`, version: '1.4.0' },
      ],
      [`self-wake@${TOOLS}`]: [{ scope: 'user', installPath: `${CACHE}\\b` }],
    })
    expect(installsOf(text)).toEqual([
      { plugin: 'widget', marketplace: MINE, scope: 'user', installPath: `${CACHE}\\a`, version: '1.4.0' },
      { plugin: 'widget', marketplace: MINE, scope: 'local', installPath: `${CACHE}\\a`, projectPath: 'D:\\work\\web', version: '1.4.0' },
      { plugin: 'self-wake', marketplace: TOOLS, scope: 'user', installPath: `${CACHE}\\b` },
    ])
    expect(installsOf(`\ufeff${text}`)).toHaveLength(3)
  })

  test('a record with no scope or no folder, and a key that names no marketplace, are left out; a file of another shape tells nothing', () => {
    expect(installsOf(file({ [`a@${MINE}`]: [{ scope: 'user' }, { installPath: 'C:\\x' }, { scope: 'user', installPath: '' }, 'text', null], 'no-marketplace': [{ scope: 'user', installPath: 'C:\\x' }], [`@${MINE}`]: [{ scope: 'user', installPath: 'C:\\x' }], [`b@${MINE}`]: 'not a list' }))).toEqual([])
    for (const text of ['', 'not json', '[]', '{}', '{"plugins":[]}', '{"plugins":"x"}']) expect(installsOf(text), text).toBeUndefined()
  })
})

describe('what a look runs', () => {
  const steps = updatePlan([MINE, TOOLS], INSTALLS, true)

  test('for each named marketplace with a plugin installed here: its refresh, then one update per install record, in every scope', () => {
    expect(steps).toEqual([
      { kind: 'marketplace', marketplace: MINE },
      { kind: 'plugin', plugin: 'widget', marketplace: MINE, scope: 'local', folder: 'D:\\work\\web' },
      { kind: 'plugin', plugin: 'widget', marketplace: MINE, scope: 'user' },
      { kind: 'plugin', plugin: 'widget', marketplace: MINE, scope: 'local', folder: 'D:\\work\\api' },
      { kind: 'marketplace', marketplace: TOOLS },
      { kind: 'plugin', plugin: 'self-wake', marketplace: TOOLS, scope: 'user' },
      { kind: 'plugin', plugin: 'self-exit', marketplace: TOOLS, scope: 'user' },
    ])
    expect(steps.map(stepSaid)).toEqual([
      `claude plugin marketplace update ${MINE}`,
      `claude plugin update widget@${MINE} --scope local`,
      `claude plugin update widget@${MINE} --scope user`,
      `claude plugin update widget@${MINE} --scope local`,
      `claude plugin marketplace update ${TOOLS}`,
      `claude plugin update self-wake@${TOOLS} --scope user`,
      `claude plugin update self-exit@${TOOLS} --scope user`,
    ])
  })

  test('never a marketplace the setting doesn’t name, and with none named, nothing', () => {
    expect(steps.every(s => s.marketplace === MINE || s.marketplace === TOOLS)).toBe(true)
    expect(steps.some(s => s.marketplace === 'vendor-plugins' || s.marketplace === 'someone-elses')).toBe(false)
    expect(updatePlan([TOOLS], INSTALLS, true).every(s => s.marketplace === TOOLS)).toBe(true)
    expect(updatePlan([], INSTALLS, true)).toEqual([])
  })

  test('never a plugin that has no install record: a named marketplace with nothing installed here gets nothing, not even a refresh', () => {
    expect(updatePlan(['not-installed-here'], INSTALLS, true)).toEqual([])
    expect(updatePlan([MINE], [], true)).toEqual([])
    for (const s of steps) if (s.kind === 'plugin') expect(INSTALLS.some(i => i.plugin === s.plugin && i.marketplace === s.marketplace && i.scope === s.scope && i.projectPath === s.folder)).toBe(true)
  })

  test('a record is left out when its plugin’s name is not a name’s shape, its scope is not one that is run, or its project can’t be placed; one written twice runs once', () => {
    const odd: Install[] = [
      record('--force', MINE, '1'),
      record('a b', MINE, '1'),
      record('managed-one', MINE, '1', { scope: 'managed' }),
      record('flag-one', MINE, '1', { scope: 'flag' }),
      record('no-folder', MINE, '1', { scope: 'project' }),
      record('relative', MINE, '1', { scope: 'local', projectPath: 'work\\web' }),
      record('share', MINE, '1', { scope: 'local', projectPath: '\\\\server\\share\\web' }),
      record('no-drive', MINE, '1', { scope: 'project', projectPath: '\\work\\web' }),
      record('device', MINE, '1', { scope: 'project', projectPath: '\\\\?\\C:\\work\\web' }),
      record('posix', MINE, '1', { scope: 'project', projectPath: '/work/web' }),
      record('fine', MINE, '1', { scope: 'project', projectPath: 'D:\\work\\web' }),
      record('fine', MINE, '1', { scope: 'project', projectPath: 'd:/work/web/' }),
    ]
    expect(updatePlan([MINE, '--force', 'a b'], odd, true)).toEqual([
      { kind: 'marketplace', marketplace: MINE },
      { kind: 'plugin', plugin: 'fine', marketplace: MINE, scope: 'project', folder: 'D:\\work\\web' },
    ])
  })

  test('a project folder is one on a drive: never a network share, a device path or one with no drive', () => {
    for (const ok of ['C:\\work\\web', 'd:/work/web', "C:\\work\\O'Brien\\web"]) expect(PROJECT_FOLDER.test(ok), ok).toBe(true)
    for (const bad of ['\\\\server\\share', '\\work', '/work', '\\\\?\\C:\\work', 'work', 'C:', '']) expect(PROJECT_FOLDER.test(bad), bad).toBe(false)
  })

  test('a named marketplace the plan runs nothing for is told apart (a misspelt name, or one in another case)', () => {
    expect(namesIdle([MINE, TOOLS], steps)).toEqual([])
    const named = [MINE, 'claude-code-self-tool', TOOLS.toUpperCase(), 'claude-code-self-tool']
    expect(namesIdle(named, updatePlan(named, INSTALLS, true))).toEqual(['claude-code-self-tool', TOOLS.toUpperCase()])
    // One whose only records are in a scope that isn't updated runs nothing either.
    expect(namesIdle([MINE], updatePlan([MINE], [record('managed-one', MINE, '1', { scope: 'managed' })], true))).toEqual([MINE])
  })

  test('its words are the fixed ones and the checked names: never install, add, a version or --force', () => {
    const fixed = new Set(['plugin', 'marketplace', 'update', '--scope', 'user', 'local', 'project'])
    for (const s of steps) {
      const words = stepWords(s)
      const names = words.filter(w => !fixed.has(w))
      expect(names).toEqual([s.kind === 'marketplace' ? s.marketplace : `${s.plugin}@${s.marketplace}`])
      expect(words.slice(0, s.kind === 'marketplace' ? 3 : 2)).toEqual(s.kind === 'marketplace' ? ['plugin', 'marketplace', 'update'] : ['plugin', 'update'])
      expect(stepEnv(s)).toEqual({ SELF_UPDATE_KIND: s.kind, SELF_UPDATE_NAME: names[0], SELF_UPDATE_SCOPE: s.kind === 'marketplace' ? '' : s.scope })
    }
  })

  test('the script: plain ASCII with a final newline, the same words, claude found as the launcher finds it, and nothing that installs, adds, removes or forces', () => {
    expect(/^[\n\x20-\x7e]+$/.test(UPDATE_SCRIPT)).toBe(true)
    expect(UPDATE_SCRIPT.endsWith('exit $code\n')).toBe(true)
    expect(UPDATE_SCRIPT).toContain("$words = @('plugin', 'marketplace', 'update', $name)")
    expect(UPDATE_SCRIPT).toContain("$words = @('plugin', 'update', $name, '--scope', $scope)")
    expect(UPDATE_SCRIPT).toContain("Join-Path $env:USERPROFILE '.local\\bin\\claude.exe'")
    expect(UPDATE_SCRIPT).toContain("Get-Command -Name 'claude' -CommandType Application")
    expect(UPDATE_SCRIPT).toContain(`'${NO_CLAUDE}'; exit 97`)
    expect(UPDATE_SCRIPT).toContain(`'${REFUSED}'; exit 96`)
    expect(UPDATE_SCRIPT).not.toMatch(/\b(?:install|uninstall|add|remove|enable|disable)\b|--force|Invoke-Expression|\biex\b|Start-Process|-EncodedCommand/i)
    // Its inputs and its lines name self-update, and only self-update.
    for (const name of ['$env:SELF_UPDATE_KIND', '$env:SELF_UPDATE_NAME', '$env:SELF_UPDATE_SCOPE', "WriteLine('self-update: exit ' + $code)"]) expect(UPDATE_SCRIPT, name).toContain(name)
    expect([NO_CLAUDE, REFUSED, INSIDE, ENDED]).toEqual(['self-update: no claude', 'self-update: refused', 'self-update: claude inside its folder', `self-update: ended after ${STEP_MS / 1000} s`])
  })

  test('the script checks the names itself, anchored at both ends and by case: a name inside other text never passes', () => {
    // The two checks, whole: \A and \z around the name's shape, by -cmatch (never -match, which ignores case); nothing else decides the words.
    expect(UPDATE_SCRIPT).toContain("if ($kind -ceq 'marketplace' -and $name -cmatch ('\\A' + $one + '\\z')) {")
    expect(UPDATE_SCRIPT).toContain("} elseif ($kind -ceq 'plugin' -and $name -cmatch ('\\A' + $one + '@' + $one + '\\z') -and @('user', 'local', 'project') -ccontains $scope) {")
    expect(UPDATE_SCRIPT).toContain("$one = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}'")
    expect(NAME_SHAPE).toBe('[A-Za-z0-9][A-Za-z0-9._-]{0,63}')
    expect(NAME.source).toBe('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
    expect(UPDATE_SCRIPT.split('-cmatch').length - 1).toBe(2)
    expect(UPDATE_SCRIPT.split('$one').length - 1).toBe(4)
    expect(UPDATE_SCRIPT).not.toMatch(/-(?:i|not|cnot|inot)?match\b|-[ci]?like\b|-[ci]?replace\b/)
    // $words is set there alone (and to nothing first), and a refusal ends the script before a claude is looked for or anything is started.
    expect(UPDATE_SCRIPT.split('$words = ').length - 1).toBe(3)
    const refusal = UPDATE_SCRIPT.indexOf(`if ($null -eq $words) { '${REFUSED}'; exit 96 }`)
    expect(refusal).toBeGreaterThan(UPDATE_SCRIPT.indexOf('-ccontains $scope'))
    for (const later of ['Get-Command', 'Test-Path', '.Start()', 'taskkill']) expect(UPDATE_SCRIPT.indexOf(later), later).toBeGreaterThan(refusal)
  })

  test('the script starts the command once, as a child it can end, and ends its whole tree when its time runs out; nothing else is started', () => {
    expect(UPDATE_SCRIPT).toContain('$start.FileName = $exe')
    expect(UPDATE_SCRIPT).toContain("$start.Arguments = $words -join ' '")
    expect(UPDATE_SCRIPT).toContain('$start.UseShellExecute = $false')
    expect(UPDATE_SCRIPT).toContain("$start.EnvironmentVariables['NoDefaultCurrentDirectoryInExePath'] = '1'")
    expect(UPDATE_SCRIPT).toContain('$child.StandardInput.Close()')
    expect(UPDATE_SCRIPT).toContain("& (Join-Path ([Environment]::SystemDirectory) 'taskkill.exe') /T /F /PID $child.Id")
    expect(UPDATE_SCRIPT).toContain(`[Console]::Out.WriteLine('${ENDED}')`)
    // One start of a process, one program called by `&` (taskkill, to end a tree), and no other way to run one.
    expect(UPDATE_SCRIPT.split('.Start()').length - 1).toBe(1)
    expect(UPDATE_SCRIPT.split('\n').filter(line => !line.startsWith('#') && /(?:^|[\s{(;|])&\s/.test(line))).toEqual([expect.stringContaining('taskkill.exe')])
  })

  test('the script’s time counts from its own first line, so the engine’s timeout can never come before the tree is ended', () => {
    // The stopwatch is the first thing the script does, before a variable is read or a claude looked for.
    const lines = UPDATE_SCRIPT.split('\n').filter(line => line !== '' && !line.startsWith('#'))
    expect(lines[0]).toBe('$clock = [Diagnostics.Stopwatch]::StartNew()')
    expect(UPDATE_SCRIPT).toContain(`$limitMs = ${STEP_MS}`)
    expect(UPDATE_SCRIPT).toContain(`$leastMs = ${STEP_LEAST_MS}`)
    // What the command gets is what is left of the limit; with less than the least left it is never started, and the script says ENDED.
    const left = UPDATE_SCRIPT.indexOf('$left = $limitMs - [int]$clock.ElapsedMilliseconds\n')
    const none = UPDATE_SCRIPT.indexOf(`if ($left -lt $leastMs) { '${ENDED}'; exit 95 }\n`)
    const started = UPDATE_SCRIPT.indexOf('[void]$child.Start()\n')
    expect(left).toBeGreaterThan(UPDATE_SCRIPT.indexOf('Get-Command'))
    expect(none).toBeGreaterThan(left)
    expect(started).toBeGreaterThan(none)
    // Nothing between the reckoning and the start but the refusal to start.
    expect(UPDATE_SCRIPT.slice(left, started).split('\n').filter(line => line !== '')).toHaveLength(2)
    expect(UPDATE_SCRIPT).toContain('$ended = -not $child.WaitForExit($left)')
    // The whole limit is never waited from the child's start, and the only other waits are the fixed ones after the end.
    expect(UPDATE_SCRIPT).not.toContain('WaitForExit($limitMs)')
    expect([...UPDATE_SCRIPT.matchAll(/\.(?:WaitForExit|Wait)\(([^)]*)\)/g)].map(m => m[1])).toEqual(['$left', '5000', '3000', '1000'])
    // 15 s of room under the engine's timeout: the tree's end and those last waits (9 s at the most) fit in it.
    expect(STEP_LEAST_MS).toBe(5_000)
    expect(COMMAND_MS - STEP_MS).toBeGreaterThanOrEqual(15_000)
    expect(5_000 + 3_000 + 1_000).toBeLessThan(COMMAND_MS - STEP_MS)
  })

  test('the script never takes a claude the folder it runs from could supply: for a project’s or a local scope none anywhere under it, for a step run from the home folder none directly in it', () => {
    // The folder with a trailing separator, compared without regard to case, on the path made whole.
    expect(UPDATE_SCRIPT).toContain("$under = $here.TrimEnd('\\') + '\\'")
    expect(UPDATE_SCRIPT).toContain("$deep = ($kind -ceq 'plugin' -and $scope -cne 'user')")
    expect(UPDATE_SCRIPT).toContain('ForEach-Object { [IO.Path]::GetFullPath($_) }')
    expect(UPDATE_SCRIPT).toContain("if ($deep) { -not $_.StartsWith($under, [StringComparison]::OrdinalIgnoreCase) } else { -not [string]::Equals([IO.Path]::GetDirectoryName($_).TrimEnd('\\'), $here.TrimEnd('\\'), [StringComparison]::OrdinalIgnoreCase) }")
    // Only one that passed is ever the one started; when all that were found sit inside, the script says so and runs nothing.
    expect(UPDATE_SCRIPT).toContain(`if ($outside.Count -gt 0) { $exe = $outside[0] } elseif ($found.Count -gt 0) { '${INSIDE}'; exit 94 }`)
    expect(UPDATE_SCRIPT.split('$exe = ').length - 1).toBe(3)
    expect(UPDATE_SCRIPT).not.toMatch(/\$exe = \$found/)
    expect(UPDATE_SCRIPT.indexOf(`'${INSIDE}'; exit 94`)).toBeLessThan(UPDATE_SCRIPT.indexOf('.Start()'))
  })
})

describe('what a command’s run says', () => {
  test('its exit code from the script’s own last line, and the command’s last line before it', () => {
    expect(readStepReply(`Updating marketplace…\r\n\u001b[32m✔ Updated ${MINE}\u001b[0m\r\n\r\nself-update: exit 0\r\n`, '', 0)).toEqual({ code: 0, line: `✔ Updated ${MINE}` })
    expect(readStepReply('self-update: exit 1\n', 'warning: something\nError: the marketplace could not be refreshed\n\n', 1)).toEqual({ code: 1, line: 'Error: the marketplace could not be refreshed' })
    expect(readStepReply('self-update: exit 3\n', '', 3)).toEqual({ code: 3, line: '' })
    // One that failed says why on standard error, whatever progress it printed; one that passed, what it printed.
    expect(readStepReply('Checking for updates…\n\nself-update: exit 1\n', 'Error: nope\n', 1)).toEqual({ code: 1, line: 'Error: nope' })
    expect(readStepReply('Checking for updates…\n\nself-update: exit 1\n', '', 1)).toEqual({ code: 1, line: 'Checking for updates…' })
    expect(readStepReply('Updated\n\nself-update: exit 0\n', 'warning: something\n', 0)).toEqual({ code: 0, line: 'Updated' })
    expect(readStepReply('self-update: exit -1073741510\n', '', -1073741510)).toEqual({ code: -1073741510, line: '' })
    // The line is read long and unmasked (LINE_READ_MAX): whoever keeps or shows it masks it whole, then cuts it.
    const long = readStepReply(`${'word '.repeat(100)}\nself-update: exit 2\n`, '', 2)
    expect(long).toMatchObject({ code: 2 })
    expect((long as { line: string }).line.length).toBe('word '.repeat(100).trim().length)
    expect((readStepReply(`${'w'.repeat(9000)}\nself-update: exit 2\n`, '', 2) as { line: string }).line.length).toBeLessThanOrEqual(LINE_READ_MAX)
  })

  test('no claude, a refusal, a command ended past its time, and an end without its last line are each told apart', () => {
    expect(readStepReply(`${NO_CLAUDE}\r\n`, '', 97)).toBe('no-claude')
    expect(readStepReply(`Updating marketplace…\r\n\r\n${ENDED}\r\n`, '', 95)).toBe('ended')
    expect(ENDED_SAID).toBe(`its ${STEP_MS / 1000} s ran out, and whatever it had started was ended with it`)
    // The only claude found sits in the folder it would run from: told apart from none at all.
    expect(readStepReply(`${INSIDE}\r\n`, '', 94)).toBe('inside')
    expect(readStepReply(`${REFUSED}\n`, '', 96)).toBe('refused')
    expect(readStepReply('', 'powershell: something broke\n', 1)).toEqual({ broken: 'it exited 1 without saying what the command did' })
    // A command that prints a line like the script's own, then more: only the last line counts.
    expect(readStepReply('self-update: exit 0\nmore\n', '', 5)).toEqual({ broken: 'it exited 5 without saying what the command did' })
    // Another plugin's line is no answer of this script's.
    expect(readStepReply('some-other-plugin: exit 0\n', '', 0)).toEqual({ broken: 'it exited 0 without saying what the command did' })
  })

  test('a failure is said with the command as typed and its last line, else its exit code', () => {
    const step: Step = { kind: 'plugin', plugin: 'widget', marketplace: MINE, scope: 'user' }
    expect(failureSaid(step, { code: 1, line: 'Error: nope' })).toBe(`claude plugin update widget@${MINE} --scope user: Error: nope`)
    expect(failureSaid(step, { code: 7, line: '' })).toBe(`claude plugin update widget@${MINE} --scope user: it exited 7`)
    expect(failureSaid({ kind: 'marketplace', marketplace: MINE }, { broken: 'it exited 1 without saying what the command did' })).toBe(`claude plugin marketplace update ${MINE}: it exited 1 without saying what the command did`)
  })
})

describe('what a failing command’s line keeps of a secret', () => {
  // Every made-up value is built at run time from pieces of no secret's shape, and reaches a line only through a
  // template: no line of this file holds a value beside a secret's name, a flag or a header.
  /** Capitals, small letters and digits, in that order. */
  const ALNUM = [26, 26, 10].map((n, k) => Array.from({ length: n }, (_, i) => String.fromCharCode([65, 97, 48][k]! + i)).join('')).join('')
  /** `n` characters of ALNUM, seven apart, from `from`: capitals, small letters and digits mixed. */
  const mix = (n: number, from = 0): string => Array.from({ length: n }, (_, i) => ALNUM.charAt((from + i * 7) % ALNUM.length)).join('')
  /** `n` hex digits in a row, from `from`. */
  const hexRun = (n: number, from = 0): string => Array.from({ length: n }, (_, i) => ((from + i) % 16).toString(16)).join('')
  const random = mix(33)
  const ghLike = ['ghp', '_', mix(36, 5)].join('')
  // An AWS-style value with `/`, a short GitLab one, a JSON web token's shape, Slack's and AWS's ids.
  const slashed = [mix(13, 1), mix(7, 2), mix(13, 3)].join('/')
  const shortPrefixed = ['glpat', '-', mix(8, 4)].join('')
  const jwtLike = [`eyJ${mix(12, 6)}`, `eyJ${mix(12, 7)}`, mix(9, 8)].join('.')
  const slackLike = ['xoxb', String(10 ** 11 + 7), mix(8, 9)].join('-')
  const awsLike = ['AKIA', mix(16, 10).toUpperCase()].join('')
  // Plain made-up values: a word with a number, words with spaces, hex, a value with `@` in it.
  const word = ['word', 6 * 7].join('')
  const words = ['made', 'up', 'words'].join(' ')
  const hexValue = hexRun(20)
  const atWord = ['p', 'ss'].join('@')
  const prose = ['expi', 'red'].join('')

  test('a URL’s user and password, the word after Bearer, a value given by a secret’s name, a git host’s token, and a run that reads as random are masked whole', () => {
    expect(masked(`fatal: unable to access 'https://oauth2:${random}@git.example.com/team/plugins.git/'`)).toBe(`fatal: unable to access 'https://${SECRET}@git.example.com/team/plugins.git/'`)
    expect(masked(`Authorization: Bearer ${random}`)).toBe(`Authorization: Bearer ${SECRET}`)
    expect(masked(`GET https://example.com/x?access_token=${random}&page=2`)).toBe(`GET https://example.com/x?access_token=${SECRET}&page=2`)
    expect(masked(`{"password": "${words}"}`)).toBe(`{"password": "${SECRET}"}`)
    expect(masked(`remote: token ${ghLike} expired`)).toBe(`remote: token ${SECRET} expired`)
    expect(masked(`key ${random} refused`)).toBe(`key ${SECRET} refused`)
  })

  test('the colon and header forms, short values after a secret’s name, quoted ones, base64 with `/`, short prefixed tokens, and a raw `@` in a password', () => {
    expect(masked(`password: ${word}`)).toBe(`password: ${SECRET}`)
    expect(masked(`Authorization: token ${hexValue}`)).toBe(`Authorization: token ${SECRET}`)
    // Small letters and digits only: no rule for a random run takes it, so the header's name alone masks it.
    expect(masked(`PRIVATE-TOKEN: ${hexRun(20, 5)} sent`)).toBe(`PRIVATE-TOKEN: ${SECRET} sent`)
    expect(masked(`X-Api-Key: ${word}`)).toBe(`X-Api-Key: ${SECRET}`)
    expect(masked(`{'token': '${word}'}`)).toBe(`{'token': '${SECRET}'}`)
    expect(masked(`Cookie: ${['a', 1].join('=')}; sid=${word}`)).toBe(`Cookie: ${SECRET}`)
    expect(masked(`secret key ${slashed} rejected`)).toBe(`secret key ${SECRET} rejected`)
    expect(masked(`token ${shortPrefixed} revoked`)).toBe(`token ${SECRET} revoked`)
    expect(masked(`bearer-less ${jwtLike} expired`)).toBe(`bearer-less ${SECRET} expired`)
    expect(masked(`${slackLike} and ${awsLike}`)).toBe(`${SECRET} and ${SECRET}`)
    expect(masked(`https://u:${atWord}@git.example.com/x`)).toBe(`https://${SECRET}@git.example.com/x`)
  })

  test('a name led by `_`, as `.npmrc` writes them, and a flag with its value after a space', () => {
    // A legacy npm token's shape (a UUID, which no shape rule catches alone), a short base64-like value, and one padded.
    const uuidLike = [8, 4, 4, 4, 12].map((n, i) => hexRun(n, i * 3)).join('-')
    const made64 = mix(12, 12)
    const padded = `${mix(10, 13)}==`
    expect(masked(`//registry.npmjs.org/:_authToken=${uuidLike}`)).toBe(`//registry.npmjs.org/:_authToken=${SECRET}`)
    expect(masked(`_auth=${made64}`)).toBe(`_auth=${SECRET}`)
    expect(masked(`//npm.example.com/:_password=${padded}`)).toBe(`//npm.example.com/:_password=${SECRET}`)
    expect(masked(`npm ERR! config _auth = ${made64}; _password: "${padded}"`)).toBe(`npm ERR! config _auth = ${SECRET}; _password: "${SECRET}"`)
    // A flag with its value after a space; one with `=` already was; a flag's value is never another flag.
    expect(masked(`git clone --password ${word} --depth 1`)).toBe(`git clone --password ${SECRET} --depth 1`)
    expect(masked(`claude login --token ${made64} -v`)).toBe(`claude login --token ${SECRET} -v`)
    expect(masked(`--password=${word}`)).toBe(`--password=${SECRET}`)
    expect(masked('--token --verbose')).toBe('--token --verbose')
    // Names and flags that say nothing secret are left as they are.
    for (const plain of ['__dirname: /work/x', '--registry https://registry.npmjs.org/ --depth 1', 'self-update --scope user', '_comment = see the README', 'x_y=1']) expect(masked(plain), plain).toBe(plain)
    // Masking twice changes nothing.
    const once = masked(`:_authToken=${uuidLike} --password ${word} _auth=${made64}`)
    expect(masked(once)).toBe(once)
    for (const left of [uuidLike, word, made64]) expect(once).not.toContain(left)
  })

  test('which names say their value is a secret, word by word', () => {
    for (const name of ['password', 'GITHUB_TOKEN', 'access_token', 'client_secret', 'apiKey', 'X-Api-Key', 'PRIVATE-TOKEN', 'Set-Cookie', 'sessionId', 'key', 'passwd', 'Authorization', '_authToken', '_auth', '_password']) expect(secretName(name), name).toBe(true)
    for (const name of ['author', 'signal', 'passing', 'keyboard', 'https', 'Error', 'monkey', 'primary_key', 'tokenizer', 'marketplace']) expect(secretName(name), name).toBe(false)
  })

  test('what is no secret stays as it is: prose, names made of words, paths, versions; masking twice changes nothing', () => {
    for (const plain of [
      'Error: network unreachable: timed out',
      'Killed by signal: 9',
      `Plugin "self-wake@${TOOLS}" is not installed in user scope`,
      'Failed to update marketplace claude-code-self-tools-mirror-2026-11-23: network unreachable',
      'C:\\Users\\tester\\.claude\\plugins\\cache\\claude-code-self-tools\\self-wake\\0.4.1',
      'self-wake is already at the latest version (0.4.1).',
    ])
      expect(masked(plain), plain).toBe(plain)
    // The one known loss: a secret's name in prose takes the next word with it.
    expect(masked(`Error: invalid token: ${prose}`)).toBe(`Error: invalid token: ${SECRET}`)
    const once = masked(`https://u:${random}@h/x Bearer ${random} secret=${random} ${ghLike} password: ${word} ${slashed} ${jwtLike}`)
    expect(masked(once)).toBe(once)
    for (const left of [random, ghLike, slashed, jwtLike, word]) expect(once).not.toContain(left)
    // The line kept: masked, on one line, cut.
    expect(maskedLine(`first\nsecond ${ghLike}\n${'x '.repeat(300)}`, 200)).not.toMatch(/[\r\n]|ghp_/)
    expect(maskedLine(`first\nsecond ${ghLike}\n${'x '.repeat(300)}`, 200).length).toBeLessThanOrEqual(200)
  })

  test('a secret across the 200th character is masked whole, then the line is cut: nothing of it is kept', () => {
    for (const secret of [`https://oauth2:${random}@git.example.com/x`, `${shortPrefixed}${random}`, `password: ${random}`]) {
      const line = maskedLine(`${'x'.repeat(185)} ${secret} and more`, 200)
      expect(line.length, secret).toBeLessThanOrEqual(200)
      expect(line, secret).not.toContain(random.slice(0, 6))
      expect(line, secret).not.toContain('oauth2')
    }
  })
})

describe('the failures’ counts: any failure is recorded and said; only a marketplace that wasn’t reached stretches the wait', () => {
  const refresh = `claude plugin marketplace update ${MINE}: Error: nope`
  const plugin = `claude plugin update self-exit@${TOOLS} --scope user: Error: no such plugin`

  test('a marketplace not reached three looks in a row: one toast, saying the looks come less often; the fourth says nothing more', () => {
    expect(FAILS_TOLD).toBe(3)
    const one = failuresNext(undefined, refresh, refresh)
    expect(one).toEqual({ fails: 1, told: false, unreached: 1, failed: refresh })
    const two = failuresNext(one, refresh, refresh)
    expect(two).toEqual({ fails: 2, told: false, unreached: 2, failed: refresh })
    const three = failuresNext(two, refresh, refresh)
    expect(three).toEqual({ fails: 3, told: true, unreached: 3, failed: refresh, toast: `self-update: couldn't reach a marketplace 3 looks in a row; it goes on trying, less often (once an hour at the least), until a look reaches them all; the last: ${refresh}` })
    expect(failuresNext(three, refresh, refresh)).toEqual({ fails: 4, told: true, unreached: 4, failed: refresh })
    // The wait follows that count: 10, 20, 40 minutes, then an hour.
    expect([one, two, three, failuresNext(three, refresh, refresh)].map(c => lookEveryMs(c.unreached) / MINUTE)).toEqual([10, 20, 40, 60])
  })

  test('a plugin’s own update failing at every look (a retired plugin’s record, a half-deleted worktree’s): recorded, one toast after three, and the wait never stretches', () => {
    let counted = failuresNext(undefined, plugin)
    expect(counted).toEqual({ fails: 1, told: false, unreached: 0, failed: plugin })
    const toasts: string[] = []
    for (let look = 2; look <= 50; look += 1) {
      counted = failuresNext(counted, plugin)
      if (counted.toast !== undefined) toasts.push(counted.toast)
      expect([look, counted.unreached, lookEveryMs(counted.unreached)]).toEqual([look, 0, LOOK_EVERY_MS])
    }
    expect(counted).toMatchObject({ fails: 50, told: true, failed: plugin })
    // Said once, and with no word of the looks coming less often: they don't.
    expect(toasts).toEqual([`self-update: failed 3 looks in a row; it goes on trying at every look; the last: ${plugin}`])
  })

  test('a mix: one marketplace’s refresh fails and another’s passes, or a refresh fails beside a plugin that does: it stretches, and the record names the look’s first failure', () => {
    const mixed = failuresNext(undefined, plugin, refresh)
    expect(mixed).toEqual({ fails: 1, told: false, unreached: 1, failed: plugin })
    expect(lookEveryMs(mixed.unreached)).toBe(10 * MINUTE)
    // The toast for it names the refresh, which is what stretched the wait.
    expect(failuresNext({ fails: 2, told: false, unreached: 2 }, plugin, refresh).toast).toBe(`self-update: couldn't reach a marketplace 3 looks in a row; it goes on trying, less often (once an hour at the least), until a look reaches them all; the last: ${refresh}`)
  })

  test('a look that reaches every marketplace brings the five minutes back, though a plugin’s update still fails; one with no failure at all starts both counts over', () => {
    const reached = failuresNext({ fails: 7, told: true, unreached: 4 }, plugin)
    expect(reached).toEqual({ fails: 8, told: true, unreached: 0, failed: plugin })
    expect(lookEveryMs(reached.unreached)).toBe(LOOK_EVERY_MS)
    const passed = failuresNext({ fails: 7, told: true, unreached: 4 }, undefined)
    expect(passed).toEqual({ fails: 0, told: false, unreached: 0 })
    expect(failuresNext(failuresNext(passed, 'x'), 'x').toast).toBeUndefined()
    expect(failuresNext(failuresNext(failuresNext(passed, 'x'), 'x'), 'x').toast).toContain('failed 3 looks in a row; it goes on trying at every look')
  })

  test('a marketplace that stops answering on a machine already told of a failing plugin is still said, once', () => {
    let counted = { fails: 40, told: true, unreached: 0 } as ReturnType<typeof failuresNext>
    const toasts: string[] = []
    for (let look = 0; look < 6; look += 1) {
      counted = failuresNext(counted, plugin, refresh)
      if (counted.toast !== undefined) toasts.push(counted.toast)
    }
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain("couldn't reach a marketplace 3 looks in a row")
  })
})

describe('what a look installed', () => {
  const moved = (list: Install[], plugin: string, marketplace: string, version: string): Install[] => list.map(i => (i.plugin === plugin && i.marketplace === marketplace ? record(plugin, marketplace, version, { scope: i.scope, ...(i.projectPath === undefined ? {} : { projectPath: i.projectPath }) }) : i))

  test('a record of a named marketplace that names another version after: one entry per plugin, however many scopes moved', () => {
    const after = moved(moved(INSTALLS, 'widget', MINE, '1.5.0'), 'self-wake', TOOLS, '0.4.1')
    expect(installsChanged([MINE, TOOLS], INSTALLS, after, true)).toEqual([
      { plugin: 'self-wake', marketplace: TOOLS, from: '0.4.0', to: '0.4.1' },
      { plugin: 'widget', marketplace: MINE, from: '1.4.0', to: '1.5.0' },
    ])
    expect(installsChanged([MINE, TOOLS], INSTALLS, INSTALLS, true)).toEqual([])
  })

  test('never a record of a marketplace that isn’t named, and never one that wasn’t there before', () => {
    const after = [...moved(moved(INSTALLS, 'other-tool', 'vendor-plugins', '0.52.0'), 'other', 'someone-elses', '2.0.0'), record('self-check', TOOLS, '0.3.0')]
    expect(installsChanged([MINE, TOOLS], INSTALLS, after, true)).toEqual([])
    // Named only now, the same change counts.
    expect(installsChanged(['vendor-plugins'], INSTALLS, after, true)).toEqual([{ plugin: 'other-tool', marketplace: 'vendor-plugins', from: '0.51.0', to: '0.52.0' }])
  })

  test('the same version in another folder is an install too; the same folder spelt otherwise is none', () => {
    const before = [record('self-wake', TOOLS, '0.4.0')]
    expect(installsChanged([TOOLS], before, [{ ...before[0]!, installPath: `${CACHE}\\elsewhere` }], true)).toEqual([{ plugin: 'self-wake', marketplace: TOOLS, from: '0.4.0', to: '0.4.0' }])
    expect(installsChanged([TOOLS], before, [{ ...before[0]!, installPath: `${before[0]!.installPath.replace(/\\/g, '/').toUpperCase()}/` }], true)).toEqual([])
  })

  test('the line an install gets says sessions reload only where they do', () => {
    expect(installedLine({ plugin: 'widget', marketplace: MINE, from: '1.4.0', to: '1.5.0' }, true)).toBe(`self-update: updated widget 1.4.0 to 1.5.0 from ${MINE}; sessions reload at their next idle moment`)
    expect(installedLine({ plugin: 'self-wake', marketplace: TOOLS }, true)).toBe(`self-update: updated self-wake an unversioned copy to an unversioned copy from ${TOOLS}; sessions reload at their next idle moment`)
    // With reloadAfterUpdate off no session reloads itself, and the line says what loads it instead.
    const off = installedLine({ plugin: 'widget', marketplace: MINE, from: '1.4.0', to: '1.5.0' }, false)
    expect(off).toBe(`self-update: updated widget 1.4.0 to 1.5.0 from ${MINE}; reloadAfterUpdate is off, so a session loads it at its next start or /reload-plugins`)
    expect(off).not.toContain('sessions reload')
    // A version is the record's own text: shown on one line, cut.
    expect(installedLine({ plugin: 'p', marketplace: 'm', from: '1\n2', to: 'v'.repeat(100) }, true)).not.toMatch(/[\r\n]|v{41}/)
  })
})

describe('what the machine keeps between looks', () => {
  const local = 'C:\\Users\\tester\\AppData\\Local'
  const plugins = 'C:\\Users\\tester/.claude/plugins'

  test('one lock per plugins folder, the one another plugin that keeps plugins current takes, keyed the same way; a state file of self-update’s own beside it', () => {
    // The key is FNV-1a over the folder as compared: pinned, so a change here is a change to the lock both plugins take.
    expect(folderKey(plugins)).toBe('30b253d3')
    expect(folderKey('c:\\users\\TESTER\\.claude\\plugins\\')).toBe('30b253d3')
    expect(folderKey('D:\\other\\.claude\\plugins')).not.toBe('30b253d3')
    expect(updateLockPath(local, plugins)).toBe(`${local}\\claude-self-tools\\auto-update\\30b253d3.lock`)
    expect(updateStatePath(local, plugins)).toBe(`${local}\\claude-self-tools\\auto-update\\30b253d3.self-update.json`)
    // Never the other plugin's state file (<key>.json): only the lock is shared.
    expect(updateStatePath(local, plugins).endsWith('\\30b253d3.json')).toBe(false)
    expect(JSON.parse(lockText(NOW))).toEqual({ v: 1, by: 'self-update', at: NOW })
  })

  test('the plugins folder, as Claude Code places it', () => {
    expect(pluginsFolderOf(configFolderOf('C:\\Users\\tester', undefined, true), undefined, undefined, true)).toBe('C:\\Users\\tester/.claude/plugins')
    expect(pluginsFolderOf(configFolderOf('C:\\Users\\tester', 'D:\\claude-config\\', true), undefined, undefined, true)).toBe('D:\\claude-config/plugins')
    expect(pluginsFolderOf(configFolderOf('C:\\Users\\tester', undefined, true), undefined, '1', true)).toBe('C:\\Users\\tester/.claude/cowork_plugins')
    expect(pluginsFolderOf(configFolderOf('C:\\Users\\tester', undefined, true), 'E:\\plugin-cache\\', undefined, true)).toBe('E:\\plugin-cache')
    // What can't be placed for sure is nothing: a share, a relative folder, a folder with no drive on Windows.
    for (const odd of ['\\\\server\\share', 'relative\\x', '\\no-drive', ' C:\\spaces']) expect(configFolderOf(odd, undefined, true), odd).toBeUndefined()
    expect(pluginsFolderOf(undefined, undefined, undefined, true)).toBeUndefined()
  })

  test('the lock’s answers, read', () => {
    expect(readTakeReply('taken\r\n')).toBe('taken')
    expect(readTakeReply('held|self-update|12000\r\n')).toEqual({ held: { by: 'self-update', ageMs: 12000 } })
    expect(readTakeReply('held|busy|0')).toEqual({ held: { by: 'busy', ageMs: 0 } })
    for (const odd of ['', 'held', 'held|a b|1', 'took']) expect(readTakeReply(odd), odd).toBeUndefined()
    for (const said of ['released', 'kept', 'gone', 'busy'] as const) expect(readReleaseReply(`${said}\r\n`)).toBe(said)
    expect(readReleaseReply('deleted')).toBeUndefined()
  })

  test('the state reads back as written; anything else is no state, and a look is then decided under the lock', () => {
    const state = { at: NOW, fails: 2, failed: 'claude plugin update a@b --scope user: nope', told: false, installed: NOW - MINUTE }
    expect(readUpdateState(updateStateText(state))).toEqual(state)
    expect(readUpdateState(updateStateText({ at: NOW, fails: 0, told: false }))).toEqual({ at: NOW, fails: 0, told: false })
    // The count that stretches the wait: kept when there is one, absent for none, and never one that is no count.
    expect(readUpdateState(updateStateText({ ...state, unreached: 3 }))).toEqual({ ...state, unreached: 3 })
    for (const odd of ['0', '-2', '"many"', 'null', '0.4']) expect(readUpdateState(`{"v":1,"at":5,"fails":1,"told":false,"unreached":${odd}}`), odd).toEqual({ at: 5, fails: 1, told: false })
    expect(readUpdateState('{"v":1,"at":5,"fails":1,"told":false,"unreached":2.9}')).toEqual({ at: 5, fails: 1, told: false, unreached: 2 })
    for (const text of [undefined, '', 'timeout', '{', '[]', '{"v":2,"at":1}', '{"v":1}', '{"v":1,"at":"now"}', '{"v":1,"at":-5}']) expect(readUpdateState(text), String(text)).toBeUndefined()
    expect(readUpdateState('{"v":1,"at":5,"fails":"many","told":"yes","installed":"then"}')).toEqual({ at: 5, fails: 0, told: false })
  })
})

describe('a session behind an install reloads', () => {
  const LOADED = NOW
  const idle: ReloadInput = { interactive: true, on: true, tries: 0, turnRunning: false, draft: '', agents: [], looking: false, reloading: false, lastReload: undefined, now: NOW }

  test('only when its plugins were loaded before the install, both times known, and the install is not ahead of now', () => {
    expect(behindInstall(LOADED + 1, LOADED, LOADED + MINUTE)).toBe(true)
    expect(behindInstall(LOADED, LOADED, LOADED + MINUTE)).toBe(false)
    expect(behindInstall(LOADED - 1, LOADED, LOADED + MINUTE)).toBe(false)
    expect(behindInstall(undefined, LOADED, LOADED + MINUTE)).toBe(false)
    expect(behindInstall(LOADED + 1, undefined, LOADED + MINUTE)).toBe(false)
    expect(behindInstall(Number.NaN, LOADED, LOADED + MINUTE)).toBe(false)
    expect(behindInstall(LOADED + MINUTE + INSTALL_AHEAD_MS, LOADED, LOADED + MINUTE)).toBe(true)
    expect(behindInstall(LOADED + MINUTE + INSTALL_AHEAD_MS + 1, LOADED, LOADED + MINUTE)).toBe(false)
  })

  test('twice at most for one install: its tries are kept under its time, a later install starts afresh, and past two the reload is held for good', () => {
    expect(RELOAD_TRIES).toBe(2)
    const first = { ...recordFor(undefined, LOADED + 5), tries: RELOAD_TRIES }
    // The same install, looked at again: the tries stand.
    expect(recordFor(first, LOADED + 5)).toBe(first)
    expect(reloadHold({ ...idle, tries: first.tries })).toBe(`tried ${RELOAD_TRIES} times for this install already`)
    expect(reloadHold({ ...idle, tries: RELOAD_TRIES - 1 })).toBeUndefined()
    // A later install is another key.
    expect(recordFor(first, LOADED + 9)).toEqual({ install: LOADED + 9, tries: 0, told: false })
    expect(readReloadRecord({ install: 5, tries: 1.7, told: true })).toEqual({ install: 5, tries: 1, told: true })
    for (const odd of [null, 'x', { tries: 1 }, { install: -1 }, { install: 'now' }]) expect(readReloadRecord(odd), JSON.stringify(odd)).toBeUndefined()
  })

  test('each hold holds it, alone; with none, it runs; at most once every 15 minutes', () => {
    expect(reloadHold(idle)).toBeUndefined()
    const each: Array<[string, Partial<ReloadInput>, string]> = [
      ['headless', { interactive: false }, 'the session is headless'],
      ['off', { on: false }, 'reloadAfterUpdate is off'],
      ['turn', { turnRunning: true }, 'a turn is running'],
      ['draft', { draft: 'half a sente' }, 'a draft is in the prompt box'],
      ['draft', { draft: undefined }, "the prompt box can't be read"],
      ['subagent', { agents: [{ status: 'running' }] }, 'a subagent is at work'],
      ['subagent', { agents: [{ status: 'some-new-status' }] }, 'a subagent is at work'],
      ['subagent', { agents: undefined }, "the session's agents can't be read"],
      ['look', { looking: true }, "this session's look for updates is under way"],
      ['reloading', { reloading: true }, 'a reload of this plugin is still out'],
      ['rate', { lastReload: NOW - 14 * MINUTE }, 'this session reloaded for an update 14 min ago, and reloads at most once every 15 minutes'],
    ]
    for (const [name, change, why] of each) {
      expect(reloadHold({ ...idle, ...change }), name).toBe(why)
      // Taken out of the list, that hold no longer holds: each is a check of its own.
      expect(reloadHold({ ...idle, ...change }, RELOAD_HOLDS.filter(h => h.name !== name)), name).toBeUndefined()
    }
    // Quiet agents hold nothing; 15 minutes on, the rate lets it run; a last reload far ahead is not believed.
    expect(reloadHold({ ...idle, agents: [{ status: 'idle' }, { status: 'completed' }, { status: 'failed' }, { status: 'killed' }] })).toBeUndefined()
    expect(reloadHold({ ...idle, lastReload: NOW - RELOAD_EVERY_MS })).toBeUndefined()
    expect(reloadHold({ ...idle, lastReload: NOW + 2 * RELOAD_EVERY_MS })).toBeUndefined()
  })

  test('past two tries that didn’t reload, the person reads one line, which says what loads it', () => {
    expect(RESTART_LINE).toBe("self-update: a plugin was updated on this machine after this session loaded its plugins, and two tries at /reload-plugins didn't reload them (skipped, or not run), so it tries no more for that update; /reload-plugins --force, a restart of this session, or a new one loads it.")
  })

  test('a reload took only when Claude Code’s own line says it reloaded: never a skip, no answer, or an answer of another shape', () => {
    expect(reloadTook('Reloaded: 4 plugins · 2 skills')).toBe(true)
    expect(reloadTook('  Reloaded 3 plugins')).toBe(true)
    for (const odd of [undefined, '', 'Skipped: the MCP tools would change. Run /reload-plugins --force to reload them.', 'Reloaded, but run /reload-plugins --force for the MCP tools', 'done', 'unknown command reload-plugins', 'Not reloaded: refused by policy', 'ReloadedX']) expect(reloadTook(odd), String(odd)).toBe(false)
  })
})

describe('what update_status says', () => {
  const base = { reloads: true, now: NOW, loaded: NOW - 30 * MINUTE, interactive: true, record: undefined }

  test('off: the setting empty, or a value that turns it off; nothing else is said', () => {
    expect(statusText({ ...base, conf: { names: [] }, state: undefined })).toBe('self-update is off on this machine: autoUpdate is empty, so nothing runs, is read or is written. Setting it to marketplace names, comma-separated, turns it on.')
    expect(statusText({ ...base, conf: autoUpdateOf('--force'), state: undefined })).toBe(`self-update is off on this machine: autoUpdate "--force" is not a marketplace's name (letters, digits, dots, dashes and underscores, a letter or a digit first, 64 at most). Nothing runs, is read or is written until it names marketplaces.`)
  })

  test('on: where it can’t run, no look yet, and the machine’s record with this session’s place behind it', () => {
    const conf = autoUpdateOf(`${MINE}, ${TOOLS}`)
    const head = `autoUpdate names ${MINE}, ${TOOLS}. reloadAfterUpdate is on.`
    expect(statusText({ ...base, conf, cant: 'it runs on Windows only', state: undefined })).toBe(`${head} It does nothing in this session: it runs on Windows only.`)
    expect(statusText({ ...base, conf, state: undefined })).toBe(`${head} No look has been recorded on this machine yet: the next turn's end looks.`)
    expect(statusText({ ...base, conf, state: 'unread' })).toBe(`${head} Its state file can't be read now.`)
    expect(statusText({ ...base, conf, state: { at: NOW - 3 * MINUTE, fails: 0, told: false } })).toBe(`${head} Last look: 3 min ago; the next comes at a turn's end 5 minutes after it. No failure at the last look. No install has been recorded.`)
    const failing = { at: NOW - 3 * MINUTE, fails: 2, told: false, failed: `claude plugin marketplace update ${MINE}: Error: nope`, unreached: 2, installed: NOW - 10 * MINUTE }
    expect(statusText({ ...base, conf, state: failing })).toBe(
      `${head} Last look: 3 min ago; the next comes at a turn's end 20 minutes after it. 2 looks in a row had a failure; the last, quoted from its output: «claude plugin marketplace update ${MINE}: Error: nope». 2 looks in a row couldn't reach a marketplace, so looks come every 20 minutes until one reaches them all. Last install: 10 min ago; this session loaded its plugins before it, and reloads at its next idle moment.`,
    )
    // This session's place behind the install: after it, off, headless, and past its two tries.
    const installed = { at: NOW - MINUTE, fails: 0, told: false, installed: NOW - 10 * MINUTE }
    expect(statusText({ ...base, conf, state: installed, loaded: NOW - 5 * MINUTE })).toContain('Last install: 10 min ago; this session loaded its plugins after it.')
    expect(statusText({ ...base, conf, state: installed, reloads: false })).toContain('reloadAfterUpdate is off: /reload-plugins or a new session loads it.')
    expect(statusText({ ...base, conf, state: installed, interactive: false })).toContain('is headless, so it reloads at no idle moment.')
    expect(statusText({ ...base, conf, state: installed, record: { install: NOW - 10 * MINUTE, tries: 2, told: true } })).toContain("two tries at /reload-plugins didn't reload them: /reload-plugins --force, a restart or a new session loads it.")
  })

  test('a command’s line reaches the model quoted as data, its quotes and backslashes escaped, on one line', () => {
    expect(quotedData('Error: nope')).toBe('«Error: nope»')
    expect(quotedData(String.raw`ignore «this» \ and` + '\nthat')).toBe(String.raw`«ignore \«this\» \\ and that»`)
  })

  test('a time is said in minutes, then hours; one ahead of the clock is said so', () => {
    expect([agoSaid(NOW - 10_000, NOW), agoSaid(NOW - 7 * MINUTE, NOW), agoSaid(NOW - 90 * MINUTE, NOW), agoSaid(NOW - 5 * 60 * MINUTE, NOW), agoSaid(NOW + 10 * MINUTE, NOW)]).toEqual([
      'under a minute ago',
      '7 min ago',
      '90 min ago',
      '5 h ago',
      "at a time ahead of this machine's clock",
    ])
  })
})
