// launch_sessions' run (#91): the plan's steps, one at a time, each a launch of its own. Which window is open is read
// as the run goes, not fixed at plan time: a window is open once the probe saw it or a launch into it answered
// `launched`, so a step whose window's first tab was refused opens that window itself, at its place. A pure function
// of its inputs: the launch and the pause are given, so a test runs it with an AbortSignal of its own.
import type { Grid, GridStep, PixelRect } from './machine'

/** A step as it runs: `new` when its window isn't open yet (it then carries its grid window's place), else `join`. */
export type RunStep = { readonly step: GridStep; readonly runsAs: 'new' | 'join'; readonly place?: { readonly rect: PixelRect } | { readonly maximized: true } }

/** What one launch came to: its line, and whether it answered `launched` (its window is open from then on). */
export type StepOutcome = { readonly line: string; readonly launched: boolean }

/** What runGridSteps is given: the steps, the grid, the windows open before it, the person's Stop, and how to pause and launch. */
export type GridRun = {
  readonly steps: readonly GridStep[]
  readonly grid: Grid
  readonly open: ReadonlySet<string>
  readonly signal?: AbortSignal
  /** The pause between two launches; rejects when `signal` aborts or the plugin unloads. */
  readonly pause: (signal?: AbortSignal) => Promise<void>
  readonly launch: (run: RunStep) => Promise<StepOutcome>
}

/** A grid window's place, as the first tab of a new window carries it: its rect, or maximized. */
function placeOf(grid: Grid, window: string): RunStep['place'] {
  const w = grid.windows.find(g => g.window === window)
  return w === undefined ? undefined : w.rect !== undefined ? { rect: w.rect } : w.maximized === true ? { maximized: true } : undefined
}

/**
 * Runs the steps in order, one line each: a pause before every launch but the first; the person's Stop (`signal`)
 * read before each, so the steps not run say so; each launch in its own catch, so a throw costs that step's line alone.
 */
export async function runGridSteps(run: GridRun): Promise<string[]> {
  const opened = new Set(run.open)
  const lines: string[] = []
  const rest = (from: number, why: string): string[] => run.steps.slice(from).map(s => `${s.session.name}: not opened: ${why}.`)
  for (const [n, step] of run.steps.entries()) {
    if (run.signal?.aborted === true) {
      lines.push(...rest(n, 'interrupted'))
      break
    }
    if (n > 0) {
      try {
        await run.pause(run.signal)
      } catch {
        lines.push(...rest(n, run.signal?.aborted === true ? 'interrupted' : 'the plugin stopped before its turn'))
        break
      }
    }
    const isNew = !opened.has(step.window)
    const place = isNew ? placeOf(run.grid, step.window) : undefined
    let outcome: StepOutcome
    try {
      outcome = await run.launch({ step, runsAs: isNew ? 'new' : 'join', ...(place === undefined ? {} : { place }) })
    } catch (err) {
      outcome = { line: `${step.session.name}: not opened: its launch failed before it answered (${err instanceof Error ? err.message : String(err)}).`, launched: false }
    }
    if (outcome.launched) opened.add(step.window)
    lines.push(outcome.line)
  }
  return lines
}
