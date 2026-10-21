// A session reads how full its context window is, to decide at the break between two pieces of
// work whether to compact now rather than let auto-compact run in the middle of the next one.
// Read-only. The figures are the main conversation's, the ones the status line shows: the API has
// no reading of a subagent's own window, so a subagent is refused rather than handed figures that
// are not its own.
import type { EngineInterface, Register } from 'claude-code'

/** The compaction tool of the self-compact plugin, named when it is installed. */
const COMPACT_TOOL = 'mcp__self-compact__compact_after_turn'

const DESCRIPTION = [
  "Reports how full this conversation's context window is: tokens used, the window's size, the percentage, and whether auto-compact is on.",
  'Call it at the break between two pieces of work, to decide whether to compact now, before the next piece starts, rather than have auto-compact run in the middle of it.',
  'If the compact_after_turn tool is available, that is how to compact at the break.',
  'Not needed mid-piece or on every turn. Read-only: it changes nothing.',
].join(' ')

/** A whole number with thousands separators, written out: the module has no locale to ask. */
const grouped = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** Whether auto-compact is on, as the /config menu's row says; undefined when there is no such row. */
async function autoCompact($: EngineInterface): Promise<boolean | undefined> {
  try {
    const row = (await $.config.list()).find(r => r.key === 'autoCompact')
    return typeof row?.value === 'boolean' ? row.value : undefined
  } catch {
    return undefined
  }
}

/** Whether the self-compact tool is one the model can call now. */
async function canCompact($: EngineInterface): Promise<boolean> {
  try {
    return (await $.tool.list()).some(t => t.name === COMPACT_TOOL)
  } catch {
    return false
  }
}

async function reading($: EngineInterface): Promise<string> {
  const [{ context }, auto, compact] = await Promise.all([$.session.usage(), autoCompact($), canCompact($)])
  const window = `${grouped(context.window)} tokens`
  const used =
    context.tokens === undefined
      ? `Context: no reading yet. The window holds ${window}; it is measured from the model's next response, so a new or just-compacted conversation has none.`
      : `Context: ${grouped(context.tokens)} of ${window} (${context.percent ?? Math.round((context.tokens * 100) / context.window)}%).`
  const autoLine =
    auto === undefined ? 'Auto-compact: not listed in /config.' : `Auto-compact is ${auto ? 'on' : 'off'}.`
  const how = compact ? ' To compact at this break, call compact_after_turn.' : ''
  return `${used} ${autoLine}${how}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'context_usage',
      description: DESCRIPTION,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      isDeferred: false,
    })
    return started
  })

  on('tool.call', { tool: 'mcp__self-context__context_usage' }, async ($, e) => {
    if (e.agentId !== undefined) {
      return {
        deny: "A subagent has no reading of its own window: these figures are the main conversation's. A subagent compacts on its own near its limit; to close a piece cleanly, finish it and return its result.",
      }
    }
    return { result: await reading($) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-context: reading the context window failed.' }))
}
