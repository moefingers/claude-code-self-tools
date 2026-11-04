#!/usr/bin/env node
// Copies the shared code into the plugins. The plugins install separately, so each needs its own
// copy inside its folder: a file under shared/ is written to the same path under plugins/<name>/
// (shared/hooks/update-check.ts to plugins/<name>/hooks/update-check.ts).
//
// Every shared file names itself on a line `Canonical copy: shared/<path>`. By default it is copied
// into every plugin. A file that also carries a line `Copies: <plugin>, <plugin>` is copied only into
// those plugins (shared/hooks/machine.ts: `Copies: self-restart, self-switch`).
//
// A file in a plugin that carries the canonical line is stale, and is removed, when its path is no
// longer under shared/, when it sits at another path than the one it names, or when it sits in a
// plugin its shared file's `Copies:` line doesn't name.
//
//   node scripts/sync-shared.mjs           write the copies, remove the stale ones
//   node scripts/sync-shared.mjs --check   change nothing; exit 1 naming each copy that differs or is stale
//
// `node --test "scripts/*.test.mjs"` runs the same check as a test; `node scripts/test-all.mjs` runs it with
// every plugin's validate and tests.
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The line each shared file carries, naming its canonical path. */
const MARK = /Canonical copy: shared\/(\S+?)\.?(?:\s|$)/

/** The line that limits a shared file to some plugins: `Copies: self-restart, self-switch`, after a comment's marker. */
const COPIES = /^[ \t]*(?:\/\/|#|\*)?[ \t]*Copies:[ \t]*([a-z0-9][a-z0-9-]*(?:[ \t]*,[ \t]*[a-z0-9][a-z0-9-]*)*)[ \t]*\.?[ \t]*\r?$/m

/** Every file under `dir`, as paths relative to it with forward slashes, sorted; never node_modules or dot folders. */
function files(dir, under = dir) {
  return readdirSync(dir)
    .filter(name => name !== 'node_modules' && !name.startsWith('.'))
    .flatMap(name => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? files(path, under) : [relative(under, path).split('\\').join('/')]
    })
    .sort()
}

/** The plugins a shared file's text limits it to, or undefined when it names none and so goes to every plugin. */
export function copiesOf(text) {
  const line = COPIES.exec(text)
  return line === null ? undefined : line[1].split(',').map(name => name.trim())
}

/** The plugin folders: each directory under plugins/ that has a .claude-plugin/plugin.json. */
export function plugins(root = ROOT) {
  const dir = join(root, 'plugins')
  return readdirSync(dir)
    .filter(name => {
      try {
        return statSync(join(dir, name, '.claude-plugin', 'plugin.json')).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

/** Each shared file, with the plugins it goes to. */
export function shared(root = ROOT) {
  const all = plugins(root)
  return files(join(root, 'shared')).map(file => {
    const only = copiesOf(readFileSync(join(root, 'shared', file), 'utf8'))
    return { file, plugins: only === undefined ? all : only }
  })
}

/** Each copy that should exist: the shared file, the plugin's copy, and whether the copy matches. */
export function copies(root = ROOT) {
  const known = new Set(plugins(root))
  return shared(root).flatMap(({ file, plugins: to }) =>
    to.map(plugin => {
      const source = join(root, 'shared', file)
      const target = join(root, 'plugins', plugin, file)
      let current
      try {
        current = readFileSync(target)
      } catch {
        current = undefined
      }
      const wanted = readFileSync(source)
      return { plugin, file, source, target, isPlugin: known.has(plugin), isSame: current !== undefined && current.equals(wanted) }
    }),
  )
}

/**
 * Each file in a plugin that names a canonical path no longer under shared/, sits where no shared
 * file does, or sits in a plugin its shared file's `Copies:` line leaves out.
 */
export function stale(root = ROOT) {
  const wanted = new Map(shared(root).map(s => [s.file, new Set(s.plugins)]))
  return plugins(root).flatMap(plugin =>
    files(join(root, 'plugins', plugin))
      .filter(file => {
        const named = MARK.exec(readFileSync(join(root, 'plugins', plugin, file), 'utf8'))?.[1]
        return named !== undefined && (!wanted.has(named) || named !== file || !wanted.get(named).has(plugin))
      })
      .map(file => ({ plugin, file, target: join(root, 'plugins', plugin, file) })),
  )
}

// Run as a command only: never when the test runner loads this file (it sets NODE_TEST_CONTEXT).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && !process.env.NODE_TEST_CONTEXT) {
  const isCheck = process.argv.includes('--check')
  const all = copies()
  const unknown = all.filter(c => !c.isPlugin)
  const differ = all.filter(c => c.isPlugin && !c.isSame)
  const left = stale()
  for (const c of unknown) console.error(`shared/${c.file} names a plugin that isn't here: ${c.plugin}`)
  if (isCheck) {
    for (const c of differ) console.error(`differs from shared/${c.file}: plugins/${c.plugin}/${c.file}`)
    for (const c of left) console.error(`stale copy, not in shared/ or not for this plugin: plugins/${c.plugin}/${c.file}`)
    process.exit(differ.length + left.length + unknown.length === 0 ? 0 : 1)
  }
  for (const c of differ) {
    mkdirSync(dirname(c.target), { recursive: true })
    writeFileSync(c.target, readFileSync(c.source))
    console.log(`wrote plugins/${c.plugin}/${c.file}`)
  }
  for (const c of left) {
    unlinkSync(c.target)
    console.log(`removed stale plugins/${c.plugin}/${c.file}`)
  }
  if (differ.length + left.length === 0) console.log('every copy matches shared/')
  if (unknown.length > 0) process.exit(1)
}
