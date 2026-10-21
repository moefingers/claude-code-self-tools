// A session reloads its own plugins once the current turn ends, as /reload-plugins does, and can
// carry on by itself afterwards. The model calls reload_plugins_after_turn; a command can't run
// while the turn the model is in waits on it, so the call is queued and the reload runs once the
// turn has ended with an answer. An interrupted turn cancels it. Only the main conversation reloads
// this way, never a subagent.
//
// The reload replaces this plugin's own module, and with it every module variable and timer; only
// $.state survives. So the resume is written to $.state before the command runs, and whichever
// comes first sends it, once: session.start in the module the reload started, or this module when
// the command returns and it is still running (the reload left it in place, or failed). Each takes
// it with a compare-and-set on its version, so the two can't both send it.
import type { EngineInterface, Register } from 'claude-code'
import type { Pending, Queued } from '../types'

const queued = { plugin: 'self-reload', key: 'queued' } as const
const pending = { plugin: 'self-reload', key: 'pending' } as const

/** A beat after the turn's end, so the turn is no longer running when the reload starts. */
const SETTLE_MS = 500

/** A pending resume older than this is dropped, not sent: the turn that asked for it is long gone. */
const STALE_MS = 10 * 60 * 1000

/**
 * How /reload-plugins says it skipped the reload: it does when the reload would change which MCP
 * tools are loaded, until it is run with --force, which this plugin leaves to the user.
 */
const SKIPPED = /\/reload-plugins --force/

const DESCRIPTION = [
  "Reloads this session's plugins once the current turn ends, as /reload-plugins does, so a plugin change made in this session takes effect without a restart.",
  'Call it after you have changed plugin files (a hooks module, a skill, a manifest) and the next step needs the change live, such as trying a tool you just edited.',
  'Not mid-edit: finish the change first. Not for a change that needs a new session anyway.',
  '`resume` is the message that starts your next turn once the plugins have reloaded: what to check or do next.',
  'Give it whenever you have a next step of your own; leave it out only when the next step waits on someone else (the user, another session, a check).',
  'End the turn after calling it; the reload runs once your answer is shown.',
].join(' ')

/** What is queued: `resume` only when there is one, since stored state holds no undefined. */
const entry = (resume: string | undefined): Queued => (resume === undefined ? {} : { resume })

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

/** Tells the model on its next turn, in a row it reads and the person doesn't see as typed. */
async function tellModel($: EngineInterface, note: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
  } catch {
    // The toast has told the person; there is no other way to reach the model.
  }
}

/** Takes the pending resume, if it is still there and no one took it first. */
async function claim($: EngineInterface): Promise<Pending | undefined> {
  const held = await $.state.get(pending)
  if (!held.value) return undefined
  const taken = await $.state.set(pending, null, { ifVersion: held.version })
  return taken.isSet ? held.value : undefined
}

async function sendResume($: EngineInterface, said: string, resume: string): Promise<void> {
  try {
    const sent = await $.prompt.submit({ text: `${said} Resume: ${resume}` })
    if (sent.drop !== undefined) $.ui.toast(`Resume not sent: ${sent.drop}`)
  } catch {
    $.ui.toast('Resume not sent; the session waits for the next message.')
  }
}

/** Runs the reload; then, if this module is still the one running, sends what is pending. */
async function reloadNow($: EngineInterface): Promise<void> {
  $.ui.status(undefined)
  let failed: string | undefined
  let output: string | undefined
  try {
    output = text((await $.command.run({ command: 'reload-plugins' })).text)
  } catch (err) {
    failed = why(err)
  }
  const value = await claim($)
  if (value === undefined) return
  if (failed !== undefined) {
    $.ui.toast(`Plugin reload didn't run: ${failed}`)
    if (value.resume !== undefined) await sendResume($, `Plugin reload didn't run (${failed}).`, value.resume)
    else await tellModel($, `The plugin reload you queued didn't run: ${failed}`)
    return
  }
  if (output !== undefined && SKIPPED.test(output)) {
    $.ui.toast(`Plugin reload skipped: ${output}`)
    if (value.resume !== undefined) await sendResume($, `Plugin reload was skipped (${output}).`, value.resume)
    else await tellModel($, `The plugin reload you queued was skipped: ${output}`)
    return
  }
  $.ui.toast(output === undefined ? 'Plugins reloaded.' : `Plugins reloaded. ${output}`)
  if (value.resume !== undefined) await sendResume($, 'Plugins reloaded.', value.resume)
}

/** At a module's start: after a reload this session asked for, send its resume, once. */
async function resumeAfterReload($: EngineInterface): Promise<void> {
  const value = await claim($)
  if (value === undefined) return
  $.ui.status(undefined)
  if ((await $.clock.now()) - value.at > STALE_MS) {
    $.ui.toast('A queued resume was dropped: its plugin reload never reported back.')
    return
  }
  $.ui.toast('Plugins reloaded.')
  // Not awaited: a submitted prompt starts its turn only once this start has finished.
  if (value.resume !== undefined) void sendResume($, 'Plugins reloaded.', value.resume)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'reload_plugins_after_turn',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          resume: {
            type: 'string',
            description:
              'The message that starts your next turn once the plugins have reloaded: what to check or do next. Leave it out only when the next step waits on someone else.',
          },
        },
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await resumeAfterReload($)
    return started
  })

  on('tool.call', { tool: 'mcp__self-reload__reload_plugins_after_turn' }, async ($, e) => {
    if (e.agentId !== undefined) {
      return {
        deny: "A subagent can't reload the session's plugins. Finish your piece and return its result, saying a reload is needed: the main session can reload.",
      }
    }
    const resume = text((e as { resume?: unknown }).resume)
    await $.state.set(queued, entry(resume))
    $.ui.status('plugin reload queued for when this turn ends')
    const then = resume === undefined ? 'then waits for the next message' : `then resumes with: ${resume}`
    return { result: `Queued. Plugins reload once this turn ends, and the session ${then}` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-reload: queuing the reload failed; nothing is queued.' }))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const { value } = await $.state.get(queued)
    if (!value) return done
    await $.state.set(queued, null)
    if (e.isAborted || e.reason !== 'answer') {
      $.ui.status(undefined)
      $.ui.toast("Plugin reload cancelled: the turn didn't finish.")
      return done
    }
    // Written before the reload replaces this module, so the module it starts finds it.
    await $.state.set(pending, { ...value, at: await $.clock.now() })
    $.clock.after(SETTLE_MS, () => void reloadNow($))
    return done
  })
}
