// The plugins' copies of the shared code are byte for byte the shared files, and no copy of a file
// since removed from shared/, or kept from a plugin its `Copies:` line leaves out, is left behind,
// so they can't drift. Run with `node --test "scripts/*.test.mjs"`; `node scripts/sync-shared.mjs`
// rewrites the copies and removes the stale ones.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { copies, copiesOf, hooksWithoutManifest, missingManifest, mods, plugins, ROOT, stale } from './sync-shared.mjs'
import { steps } from './test-all.mjs'

test('every plugin has every shared file meant for it, unchanged', () => {
  const all = copies()
  assert.ok(plugins().length >= 6, `found plugins: ${plugins().join(', ')}`)
  assert.ok(all.length >= 12, `found copies: ${all.length}`)
  assert.deepEqual(
    all.filter(c => !c.isPlugin).map(c => `${c.file} -> ${c.plugin}`),
    [],
    'a Copies: line names a plugin that is not in plugins/',
  )
  const differ = all.filter(c => !c.isSame).map(c => `plugins/${c.plugin}/${c.file}`)
  assert.deepEqual(differ, [], 'run `node scripts/sync-shared.mjs`, then commit the copies')
})

test('no plugin keeps a copy of a file that is not in shared/, or not meant for it', () => {
  const left = stale().map(c => `plugins/${c.plugin}/${c.file}`)
  assert.deepEqual(left, [], 'run `node scripts/sync-shared.mjs` to remove them, then commit')
})

test('the machine code goes to self-check, self-exit, self-restart, self-switch and self-wake only', () => {
  const machine = copies().filter(c => c.file === 'hooks/machine.ts')
  assert.deepEqual(machine.map(c => c.plugin).sort(), ['self-check', 'self-exit', 'self-restart', 'self-switch', 'self-wake'])
  // The update check, which names no plugins, still goes to every mod.
  assert.deepEqual(copies().filter(c => c.file === 'hooks/update-check.ts').map(c => c.plugin), mods())
})

test('a plugin of skills alone, with no hooks module, gets no shared code', () => {
  const skillsOnly = plugins().filter(plugin => !mods().includes(plugin))
  assert.deepEqual(skillsOnly, ['self-hierarchy'])
  assert.deepEqual(copies().filter(c => skillsOnly.includes(c.plugin)).map(c => `${c.plugin}:${c.file}`), [])
})

test('a Copies: line limits a file to the plugins it names; without one, a file goes to every mod', () => {
  assert.equal(copiesOf('// Canonical copy: shared/hooks/x.ts.\n// nothing else\n'), undefined)
  assert.deepEqual(copiesOf('// Canonical copy: shared/hooks/x.ts.\n// Copies: self-restart, self-switch\nexport {}\n'), ['self-restart', 'self-switch'])
  assert.deepEqual(copiesOf('# Copies: self-exit.\r\n'), ['self-exit'])
  // Only a line of its own: a mention inside a sentence limits nothing.
  assert.equal(copiesOf('// the Copies: line names plugins\n'), undefined)

  const root = mkdtempSync(join(tmpdir(), 'shared-copies-'))
  try {
    const put = (path, text) => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    for (const name of ['alpha', 'beta', 'gamma']) {
      put(`plugins/${name}/.claude-plugin/plugin.json`, '{}')
      put(`plugins/${name}/hooks/hooks.json`, '{ "modules": ["./register.ts"] }')
    }
    // A plugin of skills alone: no hooks module, so no shared file goes to it.
    put('plugins/delta/.claude-plugin/plugin.json', '{}')
    put('plugins/delta/skills/x/SKILL.md', '---\nname: x\ndescription: x\n---\n')
    const everyone = '// Canonical copy: shared/hooks/all.ts.\n'
    const some = '// Canonical copy: shared/hooks/some.ts.\n// Copies: alpha, beta\n'
    const tests = '// Canonical copy: shared/tests/t.ts.\n'
    put('shared/hooks/all.ts', everyone)
    put('shared/hooks/some.ts', some)
    put('shared/tests/t.ts', tests)
    put('plugins/alpha/hooks/all.ts', everyone)
    put('plugins/alpha/hooks/some.ts', some)
    put('plugins/beta/hooks/all.ts', everyone)
    put('plugins/gamma/hooks/all.ts', everyone)
    for (const name of ['alpha', 'beta', 'gamma']) put(`plugins/${name}/tests/t.ts`, tests)
    // A copy in a plugin the line leaves out is stale, and so is any copy in a plugin of skills alone.
    put('plugins/gamma/hooks/some.ts', some)
    put('plugins/delta/tests/t.ts', tests)

    const wanted = copies(root).map(c => `${c.plugin}:${c.file}:${c.isSame ? 'same' : 'missing'}`)
    assert.deepEqual(wanted, [
      'alpha:hooks/all.ts:same',
      'beta:hooks/all.ts:same',
      'gamma:hooks/all.ts:same',
      'alpha:hooks/some.ts:same',
      'beta:hooks/some.ts:missing',
      'alpha:tests/t.ts:same',
      'beta:tests/t.ts:same',
      'gamma:tests/t.ts:same',
    ])
    assert.deepEqual(
      stale(root).map(c => `${c.plugin}:${c.file}`),
      ['delta:tests/t.ts', 'gamma:hooks/some.ts'],
    )
    assert.deepEqual(mods(root), ['alpha', 'beta', 'gamma'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a hooks/ folder without hooks/hooks.json is an error in sync-shared and test-all, never a plugin of skills alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-copies-'))
  try {
    const put = (path, text) => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    const everyone = '// Canonical copy: shared/hooks/all.ts.\n'
    put('shared/hooks/all.ts', everyone)
    // A mod, a plugin of skills alone, and a mod whose hooks.json is gone: its hooks/ folder is still there.
    put('plugins/alpha/.claude-plugin/plugin.json', '{}')
    put('plugins/alpha/hooks/hooks.json', '{ "modules": ["./register.ts"] }')
    put('plugins/alpha/hooks/all.ts', everyone)
    put('plugins/delta/.claude-plugin/plugin.json', '{}')
    put('plugins/delta/skills/x/SKILL.md', '---\nname: x\ndescription: x\n---\n')
    put('plugins/broken/.claude-plugin/plugin.json', '{}')
    put('plugins/broken/hooks/register.ts', 'export const register = () => {}\n')
    put('plugins/broken/hooks/all.ts', everyone)

    const message = missingManifest('broken')
    assert.equal(message, 'plugins/broken has a hooks/ folder but no hooks/hooks.json: a mod needs hooks/hooks.json naming its hooks module, and a plugin of skills alone has no hooks/ folder. Put hooks/hooks.json back, or remove hooks/.')
    assert.deepEqual(hooksWithoutManifest(root), ['broken'])
    // sync-shared: every way in throws, so nothing is written or removed.
    assert.throws(() => mods(root), { message })
    assert.throws(() => copies(root), { message })
    assert.throws(() => stale(root), { message })
    // test-all: no step list, so nothing runs.
    assert.throws(() => steps(root), { message })

    // sync-shared as a command, on this tree (a copy of the script, so ROOT is the fixture), with and without --check.
    mkdirSync(join(root, 'scripts'))
    copyFileSync(join(ROOT, 'scripts', 'sync-shared.mjs'), join(root, 'scripts', 'sync-shared.mjs'))
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    for (const args of [['--check'], []]) {
      const run = spawnSync(process.execPath, [join(root, 'scripts', 'sync-shared.mjs'), ...args], { env, encoding: 'utf8' })
      assert.equal(run.status, 1, `sync-shared ${args.join(' ')}: ${run.stdout}${run.stderr}`)
      assert.equal(run.stderr.trim(), message)
      assert.equal(run.stdout, '')
    }
    assert.ok(existsSync(join(root, 'plugins', 'broken', 'hooks', 'all.ts')), 'its copy is not removed as stale')

    // Its hooks.json back, it is a mod again; the plugin of skills alone is validated and never tested.
    put('plugins/broken/hooks/hooks.json', '{ "modules": ["./register.ts"] }')
    assert.deepEqual(hooksWithoutManifest(root), [])
    assert.deepEqual(mods(root), ['alpha', 'broken'])
    const lines = steps(root).map(([command, args]) => `${command} ${args.join(' ')}`)
    assert.ok(lines.includes(`claude plugin validate ${join('plugins', 'delta')} --strict`))
    assert.ok(!lines.includes(`claude plugin test ${join('plugins', 'delta')}`))
    assert.ok(lines.includes(`claude plugin test ${join('plugins', 'broken')}`))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the machine code imports nothing but the engine\'s types, so it can be vendored byte for byte', () => {
  const text = readFileSync(join(ROOT, 'shared', 'hooks', 'machine.ts'), 'utf8')
  const imports = text
    .split(/\r?\n/)
    .filter(line => /^\s*import\b/.test(line) || /^\s*export\b.*\bfrom\s*['"]/.test(line) || /\bimport\s*\(/.test(line) || /\brequire\s*\(/.test(line))
  assert.ok(imports.length >= 1)
  for (const line of imports) assert.match(line, /^import type \{[^}]*\} from 'claude-code'$/, `not a type-only import of claude-code: ${line}`)
  assert.match(text, /Canonical copy: shared\/hooks\/machine\.ts/)
  assert.match(text, /pinned by this file's SHA-256/)
})
