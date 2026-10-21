// A session switches its own effort level and model. Two settings, and only these two: the effort
// level through the /effort command, the model through the /config menu's Model row. Nothing here
// names any other row or command, and a test holds it to that.
//
// A switch takes effect from the next turn, and a command can't run while the turn the model is in
// waits on it, so a call queues the switch and it runs once the turn has ended with an answer. An
// interrupted turn cancels it. Only the main conversation switches this way, never a subagent.
// Every switch is announced as "from X to Y": to the model in the tool result, and to the person
// in a toast when it runs. The model's X is the Model row's value. The effort's X is the level the
// engine reported for the main loop at the last turn's end (the Stop event carries it), or, when
// it has none, what `/effort status` answers.
import type { EngineInterface, Register } from 'claude-code'
import type { Switches } from '../types'

const queued = { plugin: 'self-config', key: 'queued' } as const
const effortSeen = { plugin: 'self-config', key: 'effortSeen' } as const

/** A beat after the turn's end, so the turn is no longer running when the switch runs. */
const SETTLE_MS = 500

/** The effort levels: the engine's (`ModelEffort`), and `auto`, which /effort takes for the model's default. */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const

/** The one /config row this plugin changes. */
const MODEL_ROW = 'model'

const SUBAGENT =
  "A subagent can't switch the session's effort or model; they belong to the main conversation. Finish your piece and return its result, saying what the next piece needs."

const EFFORT_DESCRIPTION = [
  "Switches this session's effort level, how hard the model thinks, from the next turn on: low, medium, high, xhigh, max, or auto (the model's default).",
  'Call it when the user asks for another effort level, or when your instructions let you choose the level for the work ahead.',
  'Not for a single hard step: the level stays until it is switched again.',
  'It runs /effort with the level as this turn ends. A model takes only the levels it supports, and the toast reports what /effort answered.',
  'As a level typed after /effort is, any level but max is also kept as the default for new sessions.',
  'End the turn after calling it.',
].join(' ')

const MODEL_DESCRIPTION = [
  "Switches this session's model from the next turn on, as the /config menu's Model row does.",
  '`model` is one of that row\'s options (such as default, sonnet, opus or haiku); any other name is refused with the list.',
  'Call it when the user asks for another model, or when your instructions let you choose the model for the work ahead.',
  'It runs as this turn ends, and the change is kept as a change made in /config is.',
  'End the turn after calling it.',
].join(' ')

/** Trimmed text, or undefined when it is not a string or is blank. */
function text(raw: unknown): string | undefined {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed === '' ? undefined : trimmed
}

/** Why a call was refused, as one line. */
function why(err: unknown): string {
  const said = (err instanceof Error ? err.message : String(err)).trim()
  return said === '' ? 'no reason given' : said
}

/** The level `/effort status` reports: `Current effort level: high (...)`, `Effort level: auto (currently medium)`. */
function levelIn(answer: string | undefined): string | undefined {
  if (answer === undefined) return undefined
  const current = /Current effort level:\s*([A-Za-z]+)/.exec(answer)
  if (current?.[1] !== undefined) return current[1].toLowerCase()
  const auto = /Effort level:\s*auto(?:\s*\(currently\s+([A-Za-z]+))?/.exec(answer)
  if (auto === null) return undefined
  return auto[1] === undefined ? 'auto' : `auto (${auto[1].toLowerCase()})`
}

/** Tells the model on its next turn, in a row it reads and the person doesn't see as typed. */
async function tellModel($: EngineInterface, note: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
  } catch {
    // The toast has told the person; there is no other way to reach the model.
  }
}

async function modelRow($: EngineInterface) {
  return (await $.config.list()).find(row => row.key === MODEL_ROW)
}

/** Adds a switch to what this turn has queued; a second ask for the same setting replaces the first. */
async function queue($: EngineInterface, change: Switches): Promise<void> {
  const { value } = await $.state.get(queued)
  await $.state.set(queued, { ...value, ...change })
  $.ui.status('switch queued for when this turn ends')
}

/** The effort level now, for "from": as the engine last reported it, else as /effort status says. */
async function effortNow($: EngineInterface): Promise<string> {
  const { value } = await $.state.get(effortSeen)
  if (value) return value
  try {
    return levelIn((await $.command.run({ command: 'effort', args: 'status' })).text) ?? 'its previous level'
  } catch {
    return 'its previous level'
  }
}

/** Runs what the turn queued: the model first, since the levels /effort takes depend on the model. */
async function switchNow($: EngineInterface, { effort, model }: Switches): Promise<void> {
  $.ui.status(undefined)
  const failed: string[] = []
  if (model !== undefined) {
    try {
      const before = String((await modelRow($))?.value ?? 'its previous model')
      const set = await $.config.set({ key: MODEL_ROW, value: model })
      if (set.deny !== undefined) failed.push(`the model to ${model}: ${set.deny}`)
      else {
        $.ui.toast(`Model: from ${before} to ${String(set.value)}.`)
        // A new model can bring another default effort: the last level seen no longer holds.
        await $.state.set(effortSeen, null)
      }
    } catch (err) {
      failed.push(`the model to ${model}: ${why(err)}`)
    }
  }
  if (effort !== undefined) {
    try {
      const before = await effortNow($)
      const answer = text((await $.command.run({ command: 'effort', args: effort })).text)
      $.ui.toast(`Effort: from ${before} to ${effort}.${answer === undefined ? '' : ` ${answer}`}`)
      // The level that runs may differ from the one asked for (a cap, a model's limit): learn it at the next turn's end.
      await $.state.set(effortSeen, null)
    } catch (err) {
      failed.push(`effort to ${effort}: ${why(err)}`)
    }
  }
  if (failed.length > 0) {
    $.ui.toast(`Not switched: ${failed.join('; ')}`)
    await tellModel($, `A switch you queued did not happen: ${failed.join('; ')}.`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'set_effort',
      description: EFFORT_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: [...EFFORT_LEVELS], description: 'The effort level from the next turn on.' },
        },
        required: ['level'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'set_model',
      description: MODEL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          model: { type: 'string', description: "One of the /config Model row's options, such as sonnet or opus." },
        },
        required: ['model'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    return started
  })

  // The engine reports the main loop's effort level to the Stop event at each turn's end.
  on('classic.Stop', async ($, e, next) => {
    const done = await next(e)
    const level = e.effort?.level
    if (e.agent_id === undefined && typeof level === 'string' && level !== '') await $.state.set(effortSeen, level)
    return done
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__self-config__set_effort' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: SUBAGENT }
    const level = text((e as { level?: unknown }).level)?.toLowerCase()
    const known = EFFORT_LEVELS.find(l => l === level)
    if (known === undefined) return { deny: `\`level\` is one of: ${EFFORT_LEVELS.join(', ')}.` }
    const { value: seen } = await $.state.get(effortSeen)
    await queue($, { effort: known })
    return {
      result: `Queued: effort from ${seen ?? 'its current level'} to ${known}. It switches when this turn ends, for the turns after it.`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-config: queuing the effort switch failed; nothing is queued.' }))

  on('tool.call', { tool: 'mcp__self-config__set_model' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: SUBAGENT }
    const wanted = text((e as { model?: unknown }).model)
    if (wanted === undefined) return { deny: 'Name the model (`model`).' }
    const row = await modelRow($)
    if (row === undefined) return { deny: "This session's /config has no Model row, so there is no model to switch." }
    if (row.isLocked) return { deny: "The Model row is set by a managed policy; it can't be changed from here." }
    const options = row.options ?? []
    const model = options.find(option => option.toLowerCase() === wanted.toLowerCase())
    if (model === undefined) return { deny: `"${wanted}" is not one of the Model row's options: ${options.join(', ')}.` }
    const current = String(row.value)
    if (model === current) {
      // Asking for the model in use takes back a switch queued earlier this turn.
      const { value } = await $.state.get(queued)
      if (value?.model !== undefined) {
        await $.state.set(queued, value.effort === undefined ? null : { effort: value.effort })
        if (value.effort === undefined) $.ui.status(undefined)
      }
      return { result: `The model is already ${current}; no model switch is queued.` }
    }
    await queue($, { model })
    return { result: `Queued: model from ${current} to ${model}. It switches when this turn ends, for the turns after it.` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-config: queuing the model switch failed; nothing is queued.' }))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const { value } = await $.state.get(queued)
    if (!value) return done
    await $.state.set(queued, null)
    if (e.isAborted || e.reason !== 'answer') {
      $.ui.status(undefined)
      $.ui.toast("Switch cancelled: the turn didn't finish.")
      return done
    }
    $.clock.after(SETTLE_MS, () => void switchNow($, value))
    return done
  })
}
