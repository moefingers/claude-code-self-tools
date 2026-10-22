// A session reconnects one of its MCP servers that broke, or all of them, once the current turn
// ends, as `/mcp reconnect <server>` does, and can carry on by itself afterwards. The model calls
// reconnect_mcp_after_turn; a command can't run while the turn the model is in waits on it, so the
// call is queued and the reconnect runs once the turn has ended with an answer. An interrupted turn
// cancels it. Only the main conversation reconnects this way, never a subagent.
//
// `/mcp reconnect` is the typed form of the /mcp menu's Reconnect: it opens no menu, so it runs
// unattended. Its outcome (reconnected, failed, no such server) is its own transcript line, as if
// typed; the toast and the resume, or a note the model reads, point to it.
import type { EngineInterface, Register } from 'claude-code'
import type { Queued } from '../types'

const queued = { plugin: 'self-mcp', key: 'queued' } as const

/** A beat after the turn's end, so the turn is no longer running when the command starts. */
const SETTLE_MS = 500

const DESCRIPTION = [
  'Reconnects one of this session\'s MCP servers once the current turn ends, as /mcp reconnect does: for a server whose tools stopped answering (a browser extension that dropped, a server that crashed or timed out), where reconnecting is all it needs.',
  '`server` is its name as /mcp lists it; for a tool named mcp__<server>__<tool> that is usually <server>. `all` reconnects every server that is not connected.',
  'Not for a server that needs sign-in, or one turned off: /mcp is the person\'s for those.',
  '`resume` is the message that starts your next turn once the reconnect has run, with what the reconnect said: what to try again.',
  'Give it whenever you have a next step of your own; leave it out only when the next step waits on someone else (the user, another session, a check).',
  'End the turn after calling it; the reconnect runs once your answer is shown.',
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

/** One line: the command's output can run over several. */
const oneLine = (said: string) => said.replace(/\s*\n\s*/g, ' ')

/** What is queued: `resume` only when there is one, since stored state holds no undefined. */
const entry = (server: string, resume: string | undefined): Queued => (resume === undefined ? { server } : { server, resume })

/** Tells the model on its next turn, in a row it reads and the person doesn't see as typed. */
async function tellModel($: EngineInterface, note: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
  } catch {
    // The toast has told the person; there is no other way to reach the model.
  }
}

async function sendResume($: EngineInterface, said: string, resume: string): Promise<void> {
  try {
    const sent = await $.prompt.submit({ text: `${said} Resume: ${resume}` })
    if (sent.drop !== undefined) $.ui.toast(`Resume not sent: ${sent.drop}`)
  } catch {
    $.ui.toast('Resume not sent; the session waits for the next message.')
  }
}

/** Runs the reconnect, then tells the person and the model what it said. */
async function reconnectNow($: EngineInterface, value: Queued): Promise<void> {
  $.ui.status(undefined)
  let said: string
  try {
    const output = text((await $.command.run({ command: 'mcp', args: `reconnect ${value.server}` })).text)
    // /mcp shows its outcome as its own transcript line, which the person and the model both read,
    // and hands the caller no text; a version that hands one back has it passed on.
    said =
      output === undefined
        ? `MCP reconnect of ${value.server} ran: Claude Code's own line above says whether it reconnected.`
        : `MCP reconnect of ${value.server}: ${oneLine(output)}`
  } catch (err) {
    said = `MCP reconnect of ${value.server} didn't run: ${why(err)}.`
  }
  $.ui.toast(said)
  if (value.resume !== undefined) await sendResume($, said, value.resume)
  else await tellModel($, said)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'reconnect_mcp_after_turn',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          server: {
            type: 'string',
            description: 'The MCP server to reconnect, by its name as /mcp lists it (usually the <server> in mcp__<server>__<tool>), or `all`.',
          },
          resume: {
            type: 'string',
            description:
              'The message that starts your next turn once the reconnect has run: what to try again. Leave it out only when the next step waits on someone else.',
          },
        },
        required: ['server'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    return started
  })

  on('tool.call', { tool: 'mcp__self-mcp__reconnect_mcp_after_turn' }, async ($, e) => {
    if (e.agentId !== undefined) {
      return {
        deny: "A subagent can't reconnect the session's MCP servers. Finish your piece and return its result, saying which server needs a reconnect: the main session can reconnect it.",
      }
    }
    const input = e as { server?: unknown; resume?: unknown }
    const server = text(input.server)
    if (server === undefined || /[\r\n]/.test(server)) {
      return { deny: '`server` must be one MCP server\'s name as /mcp lists it, or `all`, on one line.' }
    }
    const resume = text(input.resume)
    await $.state.set(queued, entry(server, resume))
    $.ui.status(`MCP reconnect of ${server} queued for when this turn ends`)
    const then = resume === undefined ? 'then waits for the next message' : `then resumes with: ${resume}`
    return { result: `Queued. ${server} reconnects once this turn ends, and the session ${then}` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-mcp: queuing the reconnect failed; nothing is queued.' }))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const { value } = await $.state.get(queued)
    if (!value) return done
    await $.state.set(queued, null)
    if (e.isAborted || e.reason !== 'answer') {
      $.ui.status(undefined)
      $.ui.toast("MCP reconnect cancelled: the turn didn't finish.")
      return done
    }
    $.clock.after(SETTLE_MS, () => void reconnectNow($, value))
    return done
  })
}
