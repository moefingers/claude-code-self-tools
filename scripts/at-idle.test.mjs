// Every self tool that queues work for the session's idle moment says so in the same words (#67): the shared
// sentences of shared/hooks/at-idle.ts, pinned here word for word, end the description of every tool any mod
// registers, but for the tools that queue nothing (each named here, with why) and the one nothing waits on, which says
// so in shared words of its own. A new tool fails here until it carries the words or is named here, so none can leave
// them out by accident. The rule is written once more where every session reads it: the repository's README and the
// self-hierarchy skill. Run with `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { copiesOf, mods, ROOT } from './sync-shared.mjs'

const words = await import(pathToFileURL(join(ROOT, 'shared', 'hooks', 'at-idle.ts')).href)

/** The tools that queue nothing for the turn's end, with why: each answers at once, so there is nothing to go idle for. */
const QUEUES_NOTHING = new Map([
  ['tools_check', 'answers at once with what it found'],
  ['context_usage', 'answers at once, and only reads'],
  ['secret_run_command', 'answers at once with a command line, which the session then runs itself'],
  ['cancel_wake', 'takes the wake-up back at once'],
])

/**
 * The tools nothing waits on, which bring no resume of their own: going idle after one would halt the session with
 * nothing to bring it back. Each says WHY_IDLE, then NO_WAIT, and never GO_IDLE.
 */
const NOTHING_WAITS = new Map([['color_after_turn', 'a prompt bar color, which nothing waits on, and which has no resume']])

/** Every tool the mods register today. A new one changes this list, and is then held to the words below. */
const TOOLS = [
  'cancel_wake',
  'chrome_ensure',
  'clear_after_turn',
  'color_after_turn',
  'compact_after_turn',
  'context_usage',
  'exit_after_turn',
  'reconnect_mcp_after_turn',
  'reload_plugins_after_turn',
  'remote_control',
  'restart_after_turn',
  'secret_run_command',
  'switch_after_turn',
  'tools_check',
  'wake_after',
]

/** A shared copy in a plugin: its text names its canonical path. Its tools, if it had any, are counted where they live. */
const isSharedCopy = text => /Canonical copy: shared\//.test(text)

/**
 * Each tool a mod registers (`$.tool.register({ name: '...'`), in any of its own hooks modules, with the text its
 * description is: the declaration of the name it passes (from `const <name> =` to the next blank line), or the
 * literal it passes.
 */
function toolsOf(root) {
  return mods(root).flatMap(plugin => {
    const dir = join(root, 'plugins', plugin, 'hooks')
    return readdirSync(dir)
      .filter(file => file.endsWith('.ts'))
      .map(file => readFileSync(join(dir, file), 'utf8'))
      .filter(source => !isSharedCopy(source))
      .flatMap(source =>
        [...source.matchAll(/\$\.tool\.register\(\{\s*name:\s*'([^']+)'/g)].map(found => {
          // The first `description:` after the name is the tool's own; its input's come after it.
          const after = source.slice(found.index, found.index + 400)
          const from = after.indexOf('description:')
          const value = from === -1 ? '' : after.slice(from + 'description:'.length).trimStart()
          const given = /^([A-Za-z_][A-Za-z0-9_]*)\s*,/.exec(value)?.[1]
          if (given === undefined) return { plugin, name: found[1], declared: value.split('\n')[0] }
          const at = source.search(new RegExp(`^(?:export )?const ${given}\\b`, 'm'))
          const end = at === -1 ? -1 : source.indexOf('\n\n', at)
          return { plugin, name: found[1], declared: at === -1 ? '' : source.slice(at, end === -1 ? undefined : end) }
        }),
      )
  })
}

/** What a tool's description leaves out of the shared words, one line per tool; none when every tool says them. */
function unsaid(root) {
  return toolsOf(root).flatMap(({ plugin, name, declared }) => {
    if (QUEUES_NOTHING.has(name)) return name.endsWith('_after_turn') ? [`${plugin} ${name}: a tool named _after_turn queues for the turn's end, so it can't be one that queues nothing`] : []
    if (NOTHING_WAITS.has(name)) {
      const isSaid = /\bWHY_IDLE\b/.test(declared) && /\bNO_WAIT\b/.test(declared) && !/\batIdle\(|\bGO_IDLE\b/.test(declared)
      return isSaid ? [] : [`${plugin} ${name}: nothing waits on it, so its description says WHY_IDLE, then NO_WAIT, from hooks/at-idle.ts, and never GO_IDLE`]
    }
    return /\batIdle\(/.test(declared) ? [] : [`${plugin} ${name}: it queues for the session's idle moment, so its description ends with atIdle(...) from hooks/at-idle.ts`]
  })
}

test('the shared words, word for word', () => {
  assert.equal(words.GO_IDLE, 'go idle at once: end your turn, and do nothing more until it has run and your next turn starts with word that it ran; then carry on.')
  assert.equal(words.WHY_IDLE, 'What it queues runs only once your turn has ended and the session is idle, so anything done meanwhile pushes it back.')
  assert.equal(words.NO_WAIT, 'Nothing waits on it, though, and nothing resumes the session after it: you need not end your turn for it; it runs at the next idle moment.')
  assert.equal(words.atIdle(), `After calling it, ${words.GO_IDLE} ${words.WHY_IDLE}`)
  assert.equal(words.atIdle('After `connect` or `rename`'), `After \`connect\` or \`rename\`, ${words.GO_IDLE} ${words.WHY_IDLE}`)
})

test('every tool the mods register is found, and is one of the tools this test knows', () => {
  assert.deepEqual(
    toolsOf(ROOT)
      .map(t => t.name)
      .sort(),
    TOOLS,
    'a tool was added or removed: name it in TOOLS, and in QUEUES_NOTHING (with why) only if it answers at once',
  )
  for (const name of [...QUEUES_NOTHING.keys(), ...NOTHING_WAITS.keys()]) assert.ok(TOOLS.includes(name), `${name} is no tool any more`)
})

test('every tool that queues for the idle moment ends its description with the shared words', () => {
  assert.deepEqual(unsaid(ROOT), [])
})

test('the shared words go to exactly the plugins whose tools say them', () => {
  const saying = [...new Set(toolsOf(ROOT).filter(t => !QUEUES_NOTHING.has(t.name)).map(t => t.plugin))].sort()
  assert.deepEqual(copiesOf(readFileSync(join(ROOT, 'shared', 'hooks', 'at-idle.ts'), 'utf8'))?.sort(), saying)
  assert.deepEqual(saying, ['self-chrome', 'self-clear', 'self-color', 'self-compact', 'self-exit', 'self-mcp', 'self-reload', 'self-remote-control', 'self-restart', 'self-switch', 'self-wake'])
})

test('a new tool that queues and leaves the words out fails; with them, or one that queues nothing, it passes', () => {
  const root = mkdtempSync(join(tmpdir(), 'at-idle-'))
  try {
    const put = (path, text) => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    put('plugins/self-new/.claude-plugin/plugin.json', '{}')
    put('plugins/self-new/hooks/hooks.json', '{ "modules": ["./register.ts"] }')
    const plugin = (description, name = 'snooze_after_turn') =>
      `const DESCRIPTION = [\n  'Snoozes once the current turn ends.',\n  ${description}\n].join(' ')\n\nexport const register = on => {\n  on('session.start', async $ => {\n    await $.tool.register({\n      name: '${name}',\n      description: DESCRIPTION,\n    })\n  })\n}\n`
    put('plugins/self-new/hooks/register.ts', plugin("'After calling it, end your turn.',"))
    assert.deepEqual(unsaid(root), ["self-new snooze_after_turn: it queues for the session's idle moment, so its description ends with atIdle(...) from hooks/at-idle.ts"])
    put('plugins/self-new/hooks/register.ts', plugin('atIdle(),'))
    assert.deepEqual(unsaid(root), [])
    // A literal description, with no declaration, is read as it stands.
    put('plugins/self-new/hooks/register.ts', "await $.tool.register({ name: 'nap_after', description: 'Naps once the turn ends.', inputSchema: {} })\n")
    assert.deepEqual(unsaid(root), ["self-new nap_after: it queues for the session's idle moment, so its description ends with atIdle(...) from hooks/at-idle.ts"])
    // Named as queuing nothing, a tool needs no words; but no _after_turn tool can be named so.
    put('plugins/self-new/hooks/register.ts', plugin("'Answers at once.',", 'tools_check'))
    assert.deepEqual(unsaid(root), [])
    // A shared copy is never read for tools.
    put('plugins/self-new/hooks/register.ts', `// Canonical copy: shared/hooks/register.ts.\n${plugin("'After calling it, end your turn.',")}`)
    assert.deepEqual(unsaid(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the rule is written where every session reads it: the README and the self-hierarchy skill', () => {
  const rule = `${words.GO_IDLE} ${words.WHY_IDLE}`
  for (const path of ['README.md', 'plugins/self-hierarchy/skills/session-hierarchy/SKILL.md', 'plugins/self-hierarchy/skills/session-hierarchy/reference.md']) {
    const text = readFileSync(join(ROOT, path), 'utf8')
    assert.ok(text.includes(rule), `${path} says the rule in the shared words`)
    assert.ok(text.includes(words.NO_WAIT), `${path} says why color_after_turn is the exception, in its shared words`)
  }
})
