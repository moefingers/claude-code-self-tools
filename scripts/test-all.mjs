#!/usr/bin/env node
// Every check the repository has, in one run: the shared-copies test, the tools' tests (self-secret's secret-run
// among them), then for each plugin
// `claude plugin validate --strict` and, for each mod, `claude plugin test`, then the marketplace file. Exits 1
// when any of them fails. A plugin of skills alone (no hooks/ folder) has no hooks module for `test` to
// load, and `test` refuses one, so it is validated only. A plugin with a hooks/ folder but no
// hooks/hooks.json is an error, named, and nothing runs.
//
//   node scripts/test-all.mjs
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mods, plugins, ROOT } from './sync-shared.mjs'

/**
 * The checks, in the order they run, as [command, args]. Throws, naming the plugin (mods), when a plugin has
 * a hooks/ folder but no hooks/hooks.json.
 */
export function steps(root = ROOT) {
  const tested = new Set(mods(root))
  return [
    ['node', ['--test', 'scripts/*.test.mjs']],
    ['node', ['--test', 'tools/dev-run/dev-run.test.mjs']],
    // self-secret's secret-run is a Node script beside its hooks module: its tests run under Node, not `claude plugin test`.
    ['node', ['--test', 'plugins/self-secret/tools/secret-run/*.test.mjs']],
    ...plugins(root).flatMap(plugin => [
      ['claude', ['plugin', 'validate', join('plugins', plugin), '--strict']],
      ...(tested.has(plugin) ? [['claude', ['plugin', 'test', join('plugins', plugin)]]] : []),
    ]),
    ['claude', ['plugin', 'validate', '.']],
  ]
}

// Run as a command only: never when a test imports this file, or `node --test` given a folder loads it as a
// test file (it sets NODE_TEST_CONTEXT).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && !process.env.NODE_TEST_CONTEXT) {
  let list
  try {
    list = steps()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  const failed = []
  for (const [command, args] of list) {
    const line = `${command} ${args.join(' ')}`
    console.log(`\n> ${line}`)
    // A shell on Windows, where `claude` is a command shim; the arguments are this script's own.
    const run = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
    if (run.status !== 0) failed.push(line)
  }
  console.log(failed.length === 0 ? '\nAll checks passed.' : `\nFailed:\n${failed.map(f => `  ${f}`).join('\n')}`)
  process.exit(failed.length === 0 ? 0 : 1)
}
