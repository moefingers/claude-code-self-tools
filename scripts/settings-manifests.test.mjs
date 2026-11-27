// self-settings' list and table against every manifest in the repository (#88). settings_set refuses every userConfig
// field of every plugin with exactly `owner only: /config by hand` unless MAY_SET names it, its row there, shown and
// unlocked, so an option a plugin adds later is read only from its first day. Every MAY_SET entry names a field that is
// there and isn't sensitive, and the list is the frozen one, nothing else on it. KNOWN, what settings_read knows of each
// field's default and whether it is sensitive, is the manifests' own, row for row. The rules are
// plugins/self-settings/hooks/settings.ts, loaded here as they are. Run with `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { plugins, ROOT } from './sync-shared.mjs'

const settings = await import(pathToFileURL(join(ROOT, 'plugins', 'self-settings', 'hooks', 'settings.ts')).href)

/** Every plugin's manifest under plugins/: its folder, its name, and its userConfig ({} when it declares none). */
const MANIFESTS = plugins().map(folder => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'plugins', folder, '.claude-plugin', 'plugin.json'), 'utf8'))
  return { folder, name: manifest.name, userConfig: manifest.userConfig ?? {} }
})

/** Every userConfig field of every manifest, as `<plugin>.<field>`, with what the manifest declares of it. */
const FIELDS = MANIFESTS.flatMap(({ name, userConfig }) => Object.entries(userConfig).map(([field, spec]) => ({ plugin: name, field, key: `${name}.${field}`, spec })))

/** The /config row a field would have: its plugin's own, shown, unlocked, holding its default. */
function rowOf({ plugin, key, spec }) {
  const kind = spec.type === 'boolean' ? 'boolean' : spec.type === 'number' ? 'number' : Array.isArray(spec.options) ? 'choice' : 'text'
  const value = spec.default ?? (spec.multiple === true ? [] : kind === 'boolean' ? false : kind === 'number' ? 0 : '')
  return { key, label: spec.title ?? key, kind, value, ...(Array.isArray(spec.options) ? { options: spec.options } : {}), provider: { plugin, tier: 'user' }, isLocked: false }
}

/** A value of the row's kind other than the one it holds: what a change would ask for. */
function otherValue(row) {
  if (row.kind === 'boolean') return !row.value
  if (row.kind === 'number') return row.value + 1
  if (row.kind === 'choice') return row.options.find(option => option !== row.value) ?? row.value
  return Array.isArray(row.value) ? [...row.value, 'x'] : `${row.value}x`
}

/** Every plugin here, and every plugin LATER names, enabled from this marketplace alone: so only the list refuses a field. */
const OURS = new Map([...MANIFESTS.map(m => m.name), 'self-new'].map(name => [name, [settings.MARKETPLACE]]))

/** Fields no manifest declares today, as a plugin might add them later: read only, like any field off the list. */
const LATER = [
  { plugin: 'self-compact', field: 'newOption', key: 'self-compact.newOption', spec: { type: 'string', default: '' } },
  { plugin: 'self-settings', field: 'enabled', key: 'self-settings.enabled', spec: { type: 'string', default: 'on', options: ['on', 'off'] } },
  { plugin: 'self-new', field: 'updateCheck', key: 'self-new.updateCheck', spec: { type: 'string', default: 'on', options: ['on', 'off'] } },
  { plugin: 'self-switch', field: 'allowEverything', key: 'self-switch.allowEverything', spec: { type: 'boolean', default: false } },
]

test('the manifests were found, every plugin with a userConfig among them', () => {
  assert.ok(MANIFESTS.length >= 17, `manifests: ${MANIFESTS.map(m => m.name).join(', ')}`)
  assert.ok(MANIFESTS.some(m => m.name === 'self-settings'))
  assert.deepEqual(MANIFESTS.filter(m => m.name !== m.folder).map(m => m.folder), [], "a plugin's folder is its name")
  assert.ok(FIELDS.length >= 30, `fields: ${FIELDS.length}`)
})

test('every field off the list is refused with exactly the owner-only line, at the call and at the serving, its row there, shown and unlocked', () => {
  assert.equal(settings.OWNER_ONLY, 'owner only: /config by hand')
  assert.equal(settings.MARKETPLACE, 'claude-code-self-tools')
  const off = [...FIELDS.filter(f => !settings.MAY_SET.includes(f.key)), ...LATER]
  assert.ok(off.length >= 15 + LATER.length, `fields off the list: ${off.length}`)
  const said = off.map(f => {
    const row = rowOf(f)
    const input = { key: f.key, value: otherValue(row) }
    // A subagent asking for one gets the same line: it is the owner's, whoever asks.
    return [f.key, settings.setInputOf(input), settings.callRefusal('settings_set', input), settings.callRefusal('settings_set', { ...input, agentId: 'a1' }), settings.planSet(input, [row], OURS)]
  })
  const refused = { deny: settings.OWNER_ONLY }
  assert.deepEqual(said, off.map(f => [f.key, refused, refused, refused, refused]))
})

test("every entry on the list names a field that is there and isn't sensitive, and goes through with its row there", () => {
  const byKey = new Map(FIELDS.map(f => [f.key, f]))
  const what = key => {
    const f = byKey.get(key)
    if (f === undefined) return 'no such field'
    if (f.spec.sensitive === true) return 'sensitive'
    const row = rowOf(f)
    const plan = settings.planSet({ key, value: otherValue(row) }, [row], OURS)
    return 'change' in plan ? 'a field, changed' : `a field, not changed: ${JSON.stringify(plan)}`
  }
  assert.deepEqual(
    settings.MAY_SET.map(key => [key, what(key)]),
    settings.MAY_SET.map(key => [key, 'a field, changed']),
  )
})

test('the list is the frozen one: self-compact\'s compact reminder and the update check of each plugin that declares one, by name, nothing else', () => {
  assert.ok(Object.isFrozen(settings.MAY_SET))
  assert.deepEqual(
    [...settings.MAY_SET],
    [
      'self-compact.compactReminder',
      'self-check.updateCheck',
      'self-chrome.updateCheck',
      'self-clear.updateCheck',
      'self-color.updateCheck',
      'self-compact.updateCheck',
      'self-context.updateCheck',
      'self-desktop.updateCheck',
      'self-exit.updateCheck',
      'self-mcp.updateCheck',
      'self-reload.updateCheck',
      'self-remote-control.updateCheck',
      'self-restart.updateCheck',
      'self-secret.updateCheck',
      'self-settings.updateCheck',
      'self-switch.updateCheck',
      'self-update.updateCheck',
      'self-wake.updateCheck',
    ],
  )
  // Nothing else: each entry is the compact reminder, or the update check of a plugin whose manifest declares one.
  const declares = new Set(MANIFESTS.filter(m => 'updateCheck' in m.userConfig).map(m => `${m.name}.updateCheck`))
  assert.deepEqual(
    settings.MAY_SET.filter(key => key !== 'self-compact.compactReminder' && !declares.has(key)),
    [],
  )
})

test("KNOWN is the manifests' own: each field's default, its options and whether it is sensitive, row for row", () => {
  const line = (key, spec) => `${key} default=${JSON.stringify(spec.default)} options=${JSON.stringify(spec.options)} sensitive=${spec.sensitive === true}`
  const fromManifests = FIELDS.map(f => line(f.key, f.spec)).sort()
  const fromKnown = Object.entries(settings.KNOWN)
    .flatMap(([plugin, fields]) => Object.entries(fields).map(([field, spec]) => line(`${plugin}.${field}`, spec)))
    .sort()
  assert.deepEqual(
    fromKnown,
    fromManifests,
    "KNOWN differs from the manifests: edit KNOWN in plugins/self-settings/hooks/settings.ts to name each plugin's userConfig fields as its plugin.json declares them",
  )
  assert.ok(Object.isFrozen(settings.KNOWN))
})
