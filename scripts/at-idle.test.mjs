// Every self tool that queues work for the session's idle moment says so in the same words (#67): the shared
// sentences of shared/hooks/at-idle.ts, pinned here word for word, end the description of every tool any mod
// registers, but for the tools that queue nothing (each named here, with why) and the one nothing waits on, which ends
// with shared words of its own. The rule is written once more where every session reads it: the repository's README
// and the self-hierarchy skill. Run with `node --test "scripts/*.test.mjs"`.
//
// What it reads, and what it demands. It reads every file of each mod's folder but its tests, its types and its dot
// folders, and skips a file that is a shared copy (it names its canonical path). In each, every `tool.register(` is a
// registration, comment or not, and each must be in the house form, or the test fails, naming the file:
//   $.tool.register({ name: '<the tool>', description: <NAME>, ...
// with `const <NAME> = [ ... ].join(' ')` in the same file. Of that declaration, with its comment lines left out, the
// last part must be idleWords(...) (a tool that queues), or WHY_IDLE then NO_WAIT (one nothing waits on). So a tool
// written any other way, or in any other file of the plugin, fails here rather than slip past.
//
// What it can't see, so a registration written so goes uncounted: one not spelled `tool.register(` (as
// `$.tool['register'](`, a destructured `register(`, `tool.register?.(` or `tool.register.call(`); one in a file that
// carries the text "Canonical copy: shared/" (a shared copy, skipped whole); and one under shared/, which it doesn't
// read. None is in the repository today; write a registration as the house form above.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
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
 * nothing to bring it back. Each ends with WHY_IDLE, then NO_WAIT, and never says GO_IDLE.
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

/** A registration of any form: what the test counts. */
const ANY_REGISTRATION = /\btool\.register\s*\(/g
/** A registration in the house form: what the test reads. */
const HOUSE_FORM = /\$\.tool\.register\(\{\s*name:\s*'([^']+)',\s*description:\s*([A-Za-z_][A-Za-z0-9_]*)\s*,/g

/** Every file under `dir` but tests, types, node_modules and dot folders, as absolute paths. */
function filesOf(dir) {
  return readdirSync(dir).flatMap(name => {
    if (name.startsWith('.') || name === 'tests' || name === 'types' || name === 'node_modules') return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesOf(path) : [path]
  })
}

/** A declaration's text with its comment lines left out, so a comment can't stand in for the words. */
const withoutComments = text =>
  text
    .split('\n')
    .filter(line => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n')

/**
 * What the mods register: each tool read in the house form, with its declaration (comments left out), and one finding
 * for each file whose registrations are not all in that form.
 */
function registrations(root) {
  const tools = []
  const unread = []
  for (const plugin of mods(root)) {
    for (const path of filesOf(join(root, 'plugins', plugin))) {
      const source = readFileSync(path, 'utf8')
      if (/Canonical copy: shared\//.test(source)) continue
      const counted = [...source.matchAll(ANY_REGISTRATION)].length
      if (counted === 0) continue
      const read = [...source.matchAll(HOUSE_FORM)].map(([, name, given]) => {
        const at = source.search(new RegExp(`^(?:export )?const ${given} = \\[`, 'm'))
        const end = at === -1 ? -1 : source.indexOf("].join(' ')", at)
        return { plugin, name, declared: at === -1 || end === -1 ? undefined : withoutComments(source.slice(at, end + "].join(' ')".length)) }
      })
      const file = relative(root, path).split('\\').join('/')
      if (read.length !== counted) unread.push(`${file}: ${counted} tool.register( and ${read.length} in the house form`)
      for (const tool of read) {
        if (tool.declared === undefined) unread.push(`${file}: ${tool.name}'s description is no const [ ... ].join(' ') of this file`)
        else tools.push(tool)
      }
    }
  }
  return { tools, unread }
}

/** What a tool's description leaves out of the shared words, one line per tool; none when every tool says them. */
function unsaid(root) {
  const { tools, unread } = registrations(root)
  return [
    ...unread.map(line => `not in the house form, so not read: ${line}`),
    ...tools.flatMap(({ plugin, name, declared }) => {
      if (QUEUES_NOTHING.has(name)) return name.endsWith('_after_turn') ? [`${plugin} ${name}: a tool named _after_turn queues for the turn's end, so it can't be one that queues nothing`] : []
      if (NOTHING_WAITS.has(name)) {
        const isSaid = /\bWHY_IDLE,\s*NO_WAIT,?\s*\]\.join\(' '\)$/.test(declared) && !/\bidleWords\(|\bGO_IDLE\b/.test(declared)
        return isSaid ? [] : [`${plugin} ${name}: nothing waits on it, so its description ends with WHY_IDLE, then NO_WAIT, from hooks/at-idle.ts, and never says GO_IDLE`]
      }
      return /\bidleWords\([^()]*\),?\s*\]\.join\(' '\)$/.test(declared) ? [] : [`${plugin} ${name}: it queues for the session's idle moment, so its description ends with idleWords(...) from hooks/at-idle.ts`]
    }),
  ]
}

test('the shared words, word for word', () => {
  assert.equal(
    words.GO_IDLE,
    'go idle at once: end your turn, and do nothing more until it has run; then carry on in the turn that follows it, started by its resume message when it sends one, else by the next message.',
  )
  assert.equal(words.WHY_IDLE, 'What it queues runs only once your turn has ended and the session is idle, so anything done meanwhile pushes it back.')
  assert.equal(words.NO_WAIT, 'Nothing waits on it, though, and nothing resumes the session after it: you need not end your turn for it; it runs at the next idle moment.')
  assert.equal(words.idleWords(), `After calling it, ${words.GO_IDLE} ${words.WHY_IDLE}`)
  assert.equal(words.idleWords('After `connect` or `rename`'), `After \`connect\` or \`rename\`, ${words.GO_IDLE} ${words.WHY_IDLE}`)
})

test('every registration in the mods is read, and every tool found is one this test knows', () => {
  const { tools, unread } = registrations(ROOT)
  assert.deepEqual(unread, [], 'write each registration in the house form this test reads (its header says which)')
  assert.deepEqual(
    tools.map(t => t.name).sort(),
    TOOLS,
    'a tool was added or removed: name it in TOOLS, and in QUEUES_NOTHING (with why) only if it answers at once',
  )
  for (const name of [...QUEUES_NOTHING.keys(), ...NOTHING_WAITS.keys()]) assert.ok(TOOLS.includes(name), `${name} is no tool any more`)
})

test('every tool that queues for the idle moment ends its description with the shared words', () => {
  assert.deepEqual(unsaid(ROOT), [])
})

test('the shared words go to exactly the plugins whose tools say them', () => {
  const saying = [...new Set(registrations(ROOT).tools.filter(t => !QUEUES_NOTHING.has(t.name)).map(t => t.plugin))].sort()
  assert.deepEqual(copiesOf(readFileSync(join(ROOT, 'shared', 'hooks', 'at-idle.ts'), 'utf8'))?.sort(), saying)
  assert.deepEqual(saying, ['self-chrome', 'self-clear', 'self-color', 'self-compact', 'self-exit', 'self-mcp', 'self-reload', 'self-remote-control', 'self-restart', 'self-switch', 'self-wake'])
})

test("a new tool fails unless its description ends with the words, and a registration the test can't read fails too", () => {
  const root = mkdtempSync(join(tmpdir(), 'at-idle-'))
  try {
    const put = (path, text) => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    put('plugins/self-new/.claude-plugin/plugin.json', '{}')
    put('plugins/self-new/hooks/hooks.json', '{ "modules": ["./register.ts"] }')
    const plugin = (parts, name = 'snooze_after_turn') =>
      `const DESCRIPTION = [\n  'Snoozes once the current turn ends.',\n${parts.map(part => `  ${part},\n`).join('')}].join(' ')\n\nexport const register = on => {\n  on('session.start', async $ => {\n    await $.tool.register({\n      name: '${name}',\n      description: DESCRIPTION,\n    })\n  })\n}\n`
    const left = "self-new snooze_after_turn: it queues for the session's idle moment, so its description ends with idleWords(...) from hooks/at-idle.ts"
    put('plugins/self-new/hooks/register.ts', plugin(["'After calling it, end your turn.'"]))
    assert.deepEqual(unsaid(root), [left])
    put('plugins/self-new/hooks/register.ts', plugin(['idleWords()']))
    assert.deepEqual(unsaid(root), [])
    // The words somewhere else than last, or only in a comment, are not the words a description ends with.
    put('plugins/self-new/hooks/register.ts', plugin(['idleWords()', "'And one more thing.'"]))
    assert.deepEqual(unsaid(root), [left])
    put('plugins/self-new/hooks/register.ts', plugin(['// idleWords(),', "'After calling it, end your turn.'"]))
    assert.deepEqual(unsaid(root), [left])
    // Named as queuing nothing, a tool needs no words; but no _after_turn tool can be named so.
    put('plugins/self-new/hooks/register.ts', plugin(["'Answers at once.'"], 'tools_check'))
    assert.deepEqual(unsaid(root), [])
    // A registration in any other form is not read, so it fails: a literal description, the name after the
    // description, a spec held in a name, and one in a file of its own under the plugin.
    const form = "not in the house form, so not read: plugins/self-new/hooks/register.ts: 1 tool.register( and 0 in the house form"
    put('plugins/self-new/hooks/register.ts', "await $.tool.register({ name: 'nap_after', description: 'Naps once the turn ends.', inputSchema: {} })\n")
    assert.deepEqual(unsaid(root), [form])
    put('plugins/self-new/hooks/register.ts', "await $.tool.register({ description: DESCRIPTION, name: 'nap_after' })\n")
    assert.deepEqual(unsaid(root), [form])
    put('plugins/self-new/hooks/register.ts', 'await $.tool.register(spec)\n')
    assert.deepEqual(unsaid(root), [form])
    put('plugins/self-new/hooks/register.ts', plugin(['idleWords()']))
    put('plugins/self-new/hooks/tools/nap.js', 'await engine.tool.register({ name: "nap" })\n')
    assert.deepEqual(unsaid(root), ['not in the house form, so not read: plugins/self-new/hooks/tools/nap.js: 1 tool.register( and 0 in the house form'])
    // A name with no declaration of its own in the file is not read either.
    put('plugins/self-new/hooks/tools/nap.js', "await $.tool.register({ name: 'nap', description: ELSEWHERE, inputSchema: {} })\n")
    assert.deepEqual(unsaid(root), ["not in the house form, so not read: plugins/self-new/hooks/tools/nap.js: nap's description is no const [ ... ].join(' ') of this file"])
    // A shared copy is never read for tools.
    put('plugins/self-new/hooks/tools/nap.js', `// Canonical copy: shared/hooks/tools/nap.js.\nawait $.tool.register(spec)\n`)
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
