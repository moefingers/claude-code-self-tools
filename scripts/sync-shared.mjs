#!/usr/bin/env node
// Copies the shared code into every plugin. The plugins install separately, so each needs its own
// copy inside its folder: every file under shared/ is written to the same path under each
// plugins/<name>/ (shared/hooks/update-check.ts to plugins/<name>/hooks/update-check.ts).
//
// Every shared file names itself on a line `Canonical copy: shared/<path>`. A file in a plugin that
// carries that line for a path no longer under shared/ is a stale copy, and is removed.
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
const SHARED = join(ROOT, 'shared')
const PLUGINS = join(ROOT, 'plugins')

/** The line each shared file carries, naming its canonical path. */
const MARK = /Canonical copy: shared\/(\S+?)\.?(?:\s|$)/

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

/** The plugin folders: each directory under plugins/ that has a .claude-plugin/plugin.json. */
export function plugins() {
  return readdirSync(PLUGINS)
    .filter(name => {
      try {
        return statSync(join(PLUGINS, name, '.claude-plugin', 'plugin.json')).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

/** Each copy that should exist: the shared file, the plugin's copy, and whether the copy matches. */
export function copies() {
  return plugins().flatMap(plugin =>
    files(SHARED).map(file => {
      const source = join(SHARED, file)
      const target = join(PLUGINS, plugin, file)
      let current
      try {
        current = readFileSync(target)
      } catch {
        current = undefined
      }
      const wanted = readFileSync(source)
      return { plugin, file, source, target, isSame: current !== undefined && current.equals(wanted) }
    }),
  )
}

/** Each file in a plugin that names a canonical path no longer under shared/, or sits where no shared file does. */
export function stale() {
  const wanted = new Set(files(SHARED))
  return plugins().flatMap(plugin =>
    files(join(PLUGINS, plugin))
      .filter(file => {
        const named = MARK.exec(readFileSync(join(PLUGINS, plugin, file), 'utf8'))?.[1]
        return named !== undefined && (!wanted.has(named) || named !== file)
      })
      .map(file => ({ plugin, file, target: join(PLUGINS, plugin, file) })),
  )
}

// Run as a command only: never when the test runner loads this file (it sets NODE_TEST_CONTEXT).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && !process.env.NODE_TEST_CONTEXT) {
  const isCheck = process.argv.includes('--check')
  const differ = copies().filter(c => !c.isSame)
  const left = stale()
  if (isCheck) {
    for (const c of differ) console.error(`differs from shared/${c.file}: plugins/${c.plugin}/${c.file}`)
    for (const c of left) console.error(`stale copy, not in shared/: plugins/${c.plugin}/${c.file}`)
    process.exit(differ.length + left.length === 0 ? 0 : 1)
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
}
