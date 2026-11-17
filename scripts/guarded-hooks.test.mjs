// #53: Claude Code's built-in guard passes over a person's plugin's hooks on `classic.<Event>` and a few engine events
// (scripts/guarded-hooks.mjs keeps the list, from the mods admin docs' table). Every hook each plugin's modules
// register is read here, and any on a guarded event fails the suite unless KEPT keeps it, with its partner on events
// the guard lets through; and KEPT names exactly the guarded hooks there are, so dropping one drops its entry too.
// Run with `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { GUARDED_APPEND_DOORS, GUARDED_EVENTS, isGuarded, KEPT, registrations } from './guarded-hooks.mjs'
import { mods, ROOT } from './sync-shared.mjs'

/** Every hook each mod's modules register: plugin, module, event, door and line. */
function all() {
  return mods().flatMap(plugin => {
    const dir = join(ROOT, 'plugins', plugin, 'hooks')
    return readdirSync(dir)
      .filter(file => file.endsWith('.ts'))
      .flatMap(file => registrations(readFileSync(join(dir, file), 'utf8')).map(r => ({ plugin, file, ...r })))
  })
}

const key = r => `${r.plugin} ${r.file} ${r.event}`

test('the guarded events are the admin docs’ table, row by row', () => {
  assert.deepEqual(GUARDED_EVENTS, ['prompt.compose', 'prompt.section', 'prompt.context', 'prompt.attachment', 'skill.prompt', 'attribution.text', 'session.compact', 'settings.read'])
  assert.deepEqual(GUARDED_APPEND_DOORS, ['attachment', 'hook-context', 'compaction'])
})

test('a hook is guarded by its event, and session.append by its door', () => {
  for (const guarded of ['classic.SessionStart', 'classic.UserPromptSubmit', 'classic.StopFailure', 'classic.Stop', 'prompt.context', 'settings.read', 'session.compact']) assert.equal(isGuarded(guarded), true, guarded)
  assert.equal(isGuarded('session.append', 'attachment'), true)
  assert.equal(isGuarded('session.append', 'tool-result'), false)
  assert.equal(isGuarded('session.append'), false)
  for (const allowed of ['session.start', 'session.end', 'turn.start', 'turn.complete', 'prompt.submit', 'tool.call', 'command.run']) assert.equal(isGuarded(allowed), false, allowed)
})

test('the parse reads registrations, their doors, and none a comment or a string names', () => {
  const text = [
    "on('session.start', async ($, e, next) => next(e))",
    "  on('classic.Stop', ($, e, next) => next(e)) // on('classic.Notification', x)",
    '/* on(\'prompt.context\', x) */',
    "const said = \"on('classic.PreCompact', x)\"",
    "on('session.append', { door: 'attachment' }, ($, e, next) => next(e))",
    'on(name, () => undefined)',
    "$.on('classic.Ignored', x)",
  ].join('\n')
  assert.deepEqual(registrations(text), [
    { event: 'session.start', line: 1 },
    { event: 'classic.Stop', line: 2 },
    { event: 'session.append', door: 'attachment', line: 5 },
    { event: '<computed>', line: 6 },
  ])
  // What the plugins hook today is found.
  const found = all()
  assert.ok(found.some(r => r.plugin === 'self-restart' && r.event === 'session.start'))
  assert.ok(found.some(r => r.plugin === 'self-wake' && r.event === 'tool.call'))
  assert.ok(found.some(r => r.plugin === 'self-remote-control' && r.event === 'classic.StopFailure'))
})

test('every hook names its event literally', () => {
  assert.deepEqual(
    all().filter(r => r.event === '<computed>'),
    [],
  )
})

test('no plugin hooks a guarded event but those KEPT keeps, by plugin, module and event, once each', () => {
  const guarded = all()
    .filter(r => isGuarded(r.event, r.door))
    .map(key)
    .sort()
  assert.deepEqual(guarded, KEPT.map(key).sort())
  assert.equal(new Set(KEPT.map(key)).size, KEPT.length)
})

test('each kept hook has its partner on events the guard lets through, hooked beside it, and says what is missing', () => {
  const found = all()
  for (const k of KEPT) {
    assert.ok(k.partner.length > 40, key(k))
    assert.ok(typeof k.missing === 'string' && k.missing.length > 0, key(k))
    assert.ok(k.partnerEvents.length > 0, key(k))
    for (const event of k.partnerEvents) {
      assert.equal(isGuarded(event), false, `${key(k)}: ${event}`)
      assert.ok(
        found.some(r => r.plugin === k.plugin && r.file === k.file && r.event === event),
        `${key(k)}: its partner's ${event} is hooked in ${k.plugin}/hooks/${k.file}`,
      )
    }
  }
})

test('each kept hook says first, before anything is awaited, that classic hooks reach the process', () => {
  for (const k of KEPT) {
    const text = readFileSync(join(ROOT, 'plugins', k.plugin, 'hooks', k.file), 'utf8')
    const at = text.indexOf(`on('${k.event}'`)
    assert.ok(at >= 0, key(k))
    const body = text.slice(at)
    const firstAwait = body.indexOf('await ')
    const seen = body.indexOf('void classicSeen($')
    assert.ok(seen > 0 && seen < firstAwait, `${key(k)} calls classicSeen before its first await`)
  }
})

test('each plugin that keeps a guarded hook carries the shared partner code, configured under its own name', () => {
  for (const plugin of new Set(KEPT.map(k => k.plugin))) {
    assert.ok(existsSync(join(ROOT, 'plugins', plugin, 'hooks', 'classic.ts')), plugin)
    const text = readFileSync(join(ROOT, 'plugins', plugin, 'hooks', 'register.ts'), 'utf8')
    assert.match(text, /configureClassic\(\)/, plugin)
    // Its two keys, read and written by its own refs (classic.ts, ClassicIo).
    assert.match(text, new RegExp(`const classicRef = \\{ plugin: '${plugin}', key: 'classic' \\} as const`), plugin)
    assert.match(text, new RegExp(`const startedRef = \\{ plugin: '${plugin}', key: 'started' \\} as const`), plugin)
    // The keys the shared code keeps in $.state are declared in the plugin's own state.
    const types = readFileSync(join(ROOT, 'plugins', plugin, 'types', 'index.d.ts'), 'utf8')
    const declared = types.slice(types.indexOf(`'${plugin}': {`))
    assert.match(declared, /^'[a-z-]+': \{[^}]*\bclassic: boolean \| null\b[^}]*\bstarted: string \| null\b[^}]*\}/, plugin)
  }
})

test('a new hook on a guarded event fails the check', () => {
  // As the check above reads a module: a plugin that adds one finds it in the guarded list, and not in KEPT.
  const added = registrations("on('classic.Stop', ($, e, next) => next(e))\non('prompt.context', ($, e, next) => next(e))").map(r => ({ plugin: 'self-wake', file: 'register.ts', ...r }))
  const extra = added.filter(r => isGuarded(r.event, r.door) && !KEPT.some(k => key(k) === key(r)))
  assert.deepEqual(extra.map(key), ['self-wake register.ts classic.Stop', 'self-wake register.ts prompt.context'])
})
