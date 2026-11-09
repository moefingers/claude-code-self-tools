#!/usr/bin/env node
// Every check the repository has, in one run: the shared-copies test, the tools' tests, then for each plugin
// `claude plugin validate --strict` and, for each mod, `claude plugin test`, then the marketplace file. Exits 1
// when any of them fails. A plugin of skills alone (no hooks/hooks.json) has no hooks module for `test` to
// load, and `test` refuses one, so it is validated only.
//
//   node scripts/test-all.mjs
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { mods, plugins, ROOT } from './sync-shared.mjs'

const steps = [
  ['node', ['--test', 'scripts/*.test.mjs']],
  ['node', ['--test', 'tools/dev-run/dev-run.test.mjs']],
  ...plugins().flatMap(plugin => [
    ['claude', ['plugin', 'validate', join('plugins', plugin), '--strict']],
    ...(mods().includes(plugin) ? [['claude', ['plugin', 'test', join('plugins', plugin)]]] : []),
  ]),
  ['claude', ['plugin', 'validate', '.']],
]

// Never as a test file: `node --test` given a folder loads every .mjs in it.
if (process.env.NODE_TEST_CONTEXT) process.exit(0)

const failed = []
for (const [command, args] of steps) {
  const line = `${command} ${args.join(' ')}`
  console.log(`\n> ${line}`)
  // A shell on Windows, where `claude` is a command shim; the arguments are this script's own.
  const run = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
  if (run.status !== 0) failed.push(line)
}
console.log(failed.length === 0 ? '\nAll checks passed.' : `\nFailed:\n${failed.map(f => `  ${f}`).join('\n')}`)
process.exit(failed.length === 0 ? 0 : 1)
