// launch_sessions' run (grid-run.ts), with a launch and a pause of the test's own: which window is open is read as the
// run goes, the person's Stop ends it, and a launch that throws costs its own line alone. Nothing here starts a process.
import { expect, test } from 'claude-code/testing'
import { runGridSteps, type RunStep, type StepOutcome } from '../hooks/grid-run'
import { planGrid, type Grid } from '../hooks/machine'

/** A made-up grid: a fixed slot at a rect, a free cell maximized. */
const GRID: Grid = { windows: [{ window: 'one', rect: [-7, 0, 494, 523], tabs: ['alpha', 'beta'] }, { window: 'two', maximized: true }] }
const FOLDER = 'C:\\path\\to\\work'
/** The plan's steps, which the run takes (its `steps`), never the plan itself. */
const steps = planGrid(['alpha', 'beta', 'gamma', 'delta'].map(name => ({ name, folder: FOLDER })), GRID, new Set()).steps

/** What each launch was given, and a launch that answers `launched` unless its session is in `refuse`, or throws for `throws`. */
function launcher(refuse: readonly string[] = [], throws: readonly string[] = []) {
  const given: RunStep[] = []
  const launch = async (run: RunStep): Promise<StepOutcome> => {
    given.push(run)
    const name = run.step.session.name
    if (throws.includes(name)) throw new Error('the launcher could not be built')
    return refuse.includes(name) ? { line: `${name}: not opened (live): refused.`, launched: false } : { line: `${name}: launched.`, launched: true }
  }
  return { given, launch }
}

/** What each step ran as: `<name> <new|join> <rect|max|->`. */
const ranAs = (given: readonly RunStep[]): string[] => given.map(r => `${r.step.session.name} ${r.runsAs} ${r.place === undefined ? '-' : 'rect' in r.place ? 'rect' : 'max'}`)

test('a window whose first tab was refused is opened by its next tab, with its place; one launched is joined after (Medium 1)', async () => {
  const { given, launch } = launcher(['alpha'])
  const lines = await runGridSteps({ steps, grid: GRID, open: new Set(), pause: async () => undefined, launch })
  expect(ranAs(given)).toEqual(['alpha new rect', 'beta new rect', 'gamma new max', 'delta join -'])
  expect(lines).toEqual(['alpha: not opened (live): refused.', 'beta: launched.', 'gamma: launched.', 'delta: launched.'])
})

test('a window open before the run is joined, never opened again', async () => {
  const { given, launch } = launcher()
  await runGridSteps({ steps, grid: GRID, open: new Set(['one']), pause: async () => undefined, launch })
  expect(ranAs(given).slice(0, 2)).toEqual(['alpha join -', 'beta join -'])
})

test("the person's Stop: no launch after it, and every step not run says interrupted (Medium 2)", async () => {
  const stop = new AbortController()
  const { given, launch } = launcher()
  // The Stop comes during the pause after the first launch, as Esc would, and the pause rejects as $.clock.sleep does.
  const pause = async (signal?: AbortSignal): Promise<void> => {
    stop.abort()
    if (signal?.aborted === true) throw new Error('aborted')
  }
  const lines = await runGridSteps({ steps, grid: GRID, open: new Set(), signal: stop.signal, pause, launch })
  expect(given.map(r => r.step.session.name)).toEqual(['alpha'])
  expect(lines).toEqual(['alpha: launched.', 'beta: not opened: interrupted.', 'gamma: not opened: interrupted.', 'delta: not opened: interrupted.'])
})

test('a Stop before the run: nothing launches', async () => {
  const stop = new AbortController()
  stop.abort()
  const { given, launch } = launcher()
  const lines = await runGridSteps({ steps, grid: GRID, open: new Set(), signal: stop.signal, pause: async () => undefined, launch })
  expect(given).toEqual([])
  expect(lines).toHaveLength(4)
  for (const line of lines) expect(line).toMatch(/: not opened: interrupted\.$/)
})

test('a launch that throws costs its own line alone; the lines earned before and after are kept (Info 11)', async () => {
  const { launch } = launcher([], ['beta'])
  const lines = await runGridSteps({ steps, grid: GRID, open: new Set(), pause: async () => undefined, launch })
  expect(lines).toEqual(['alpha: launched.', 'beta: not opened: its launch failed before it answered (the launcher could not be built).', 'gamma: launched.', 'delta: launched.'])
})

test('a pause that fails without a Stop (the plugin unloading) says so for the steps not run', async () => {
  const { launch } = launcher()
  const lines = await runGridSteps({ steps, grid: GRID, open: new Set(), pause: async () => Promise.reject(new Error('unloaded')), launch })
  expect(lines).toEqual(['alpha: launched.', 'beta: not opened: the plugin stopped before its turn.', 'gamma: not opened: the plugin stopped before its turn.', 'delta: not opened: the plugin stopped before its turn.'])
})
