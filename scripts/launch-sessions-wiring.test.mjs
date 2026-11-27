// launch_sessions' Esc wiring (#91), read as text: the hook hands its own `next.signal` to the run, the run reads it
// before each step, and the pause between launches takes it. The test kit can't abort a tool call it raises (its
// `$.tool.call` takes no signal, and a test's hooks sit beneath the plugin's, so none settles first), so the engine
// path is shown as text here; plugins/self-switch/tests/grid-run.test.ts runs the loop itself with an AbortSignal.
// Run with `node --test "scripts/*.test.mjs"`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ROOT } from './sync-shared.mjs'

const register = readFileSync(join(ROOT, 'plugins', 'self-switch', 'hooks', 'register.ts'), 'utf8')
const run = readFileSync(join(ROOT, 'plugins', 'self-switch', 'hooks', 'grid-run.ts'), 'utf8')

/** Every place the wiring would break, each found missing. */
function wiringProblems(hook, loop) {
  const problems = []
  const need = (ok, what) => {
    if (!ok) problems.push(what)
  }
  need(hook.includes("on('tool.call', { tool: LAUNCH_TOOL }, async ($, e, next) => {") && hook.includes('return launchSessions($, e as { sessions?: unknown; plan?: unknown }, next.signal)'), "the hook hands its own next.signal to launchSessions")
  need(hook.includes('...(signal === undefined ? {} : { signal }),'), 'launchSessions hands the signal to the run')
  need(hook.includes('pause: stop => $.clock.sleep(LAUNCH_PAUSE_MS, stop === undefined ? undefined : { signal: stop }),'), 'the pause between launches takes the signal')
  need(loop.includes('const stopped = (): boolean => run.signal?.aborted === true') && loop.includes("    if (stopped()) {\n      lines.push(...rest(n, 'interrupted'))"), 'the run reads the signal before each step')
  need(loop.includes('        await run.pause(run.signal)') && loop.includes("stopped() ? 'interrupted' : 'the plugin stopped before its turn'"), 'the run reads the signal again after a pause that failed')
  return problems
}

test("launch_sessions' Esc: next.signal reaches the run, which reads it before each step and gives it to the pause", () => {
  assert.deepEqual(wiringProblems(register, run), [])
})

for (const [name, file, from, to, expect] of [
  ['the hook keeping its signal', 'hook', ', next.signal)', ')', /next\.signal/],
  ['the run given no signal', 'hook', '...(signal === undefined ? {} : { signal }),', '', /hands the signal to the run/],
  ['a pause that ignores the Stop', 'hook', 'stop === undefined ? undefined : { signal: stop }', 'undefined', /pause between launches/],
  ['no look before a step', 'loop', "    if (stopped()) {\n      lines.push(...rest(n, 'interrupted'))", "    if (false) {\n      lines.push(...rest(n, 'interrupted'))", /before each step/],
]) {
  test(`planted: ${name}`, () => {
    const hook = file === 'hook' ? register.split(from).join(to) : register
    const loop = file === 'loop' ? run.split(from).join(to) : run
    assert.ok(hook !== register || loop !== run, 'the fault changed nothing')
    assert.ok(wiringProblems(hook, loop).some(p => expect.test(p)), `not caught: ${JSON.stringify(wiringProblems(hook, loop))}`)
  })
}
