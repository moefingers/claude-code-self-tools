#!/usr/bin/env node
// Copies the shared code into every plugin. The plugins install separately, so each needs its own
// copy inside its folder: every file under shared/ is written to the same path under each
// plugins/<name>/ (shared/hooks/update-check.ts to plugins/<name>/hooks/update-check.ts).
//
//   node scripts/sync-shared.mjs           write the copies
//   node scripts/sync-shared.mjs --check   write nothing; exit 1 naming each copy that differs
//
// `node --test scripts` runs the same check as a test.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHARED = join(ROOT, 'shared')
const PLUGINS = join(ROOT, 'plugins')

/** Every file under `dir`, as paths relative to it with forward slashes, sorted. */
function files(dir, under = dir) {
  return readdirSync(dir)
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const isCheck = process.argv.includes('--check')
  const differ = copies().filter(c => !c.isSame)
  if (isCheck) {
    for (const c of differ) console.error(`differs from shared/${c.file}: plugins/${c.plugin}/${c.file}`)
    process.exit(differ.length === 0 ? 0 : 1)
  }
  for (const c of differ) {
    mkdirSync(dirname(c.target), { recursive: true })
    writeFileSync(c.target, readFileSync(c.source))
    console.log(`wrote plugins/${c.plugin}/${c.file}`)
  }
  if (differ.length === 0) console.log('every copy matches shared/')
}
