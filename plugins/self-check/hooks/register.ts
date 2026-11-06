// A session checks that its own tools are alive. The model calls tools_check when a tool seems dead
// (one lane's Bash once answered every command with nothing, while bash.exe itself worked), and the
// plugin runs the same tools the model does, through the same door:
// - Bash and PowerShell: `$.tool.check` first, the engine's permission verdict, which opens no dialog;
//   only on `allow`, `$.tool.call` with a harmless echo of a fresh nonce (`echo selfcheck-<nonce>`,
//   `Write-Output selfcheck-<nonce>`), the same call the engine makes for the model's tool calls. Ok
//   only when the output holds the nonce within 10 s; an empty answer is "no output". Any other
//   verdict is "not tested", and nothing runs. Never bash.exe or powershell.exe started directly.
// - MCP servers: listed, from the tools the session has (`mcp__<server>__<tool>`). There is no ping
//   for an MCP server, so one is exercised only through a probe the person names in the `probes`
//   setting (`server=tool`, a tool that only reads), by `$.mcp.call` within 10 s: ok unless it
//   reports an error. Every other server is "listed, not exercised".
// The answer is one line per tool; on a failure it says how a fresh process repairs one.
//
// At resume, quietly: on the classic SessionStart with `source: "resume"`, 10 s later and once no
// turn is running, the same check runs, and only a failure is said: a toast, and one row the model
// reads with the next message (it never starts a turn). The `checkAtResume` setting turns that off.
//
// Each check writes one record, %LOCALAPPDATA%\claude-self-tools\selfcheck\<conversation>.json:
// `{ v: 1, at, failed }`, the failed tools by name only, which the coordinator's lane report carries.
// That is all the plugin writes.
import type { EngineInterface, Register, ToolInfo } from 'claude-code'
import type { CheckLine } from '../types'
import { isSafeFolder, oneLine, quoted, selfcheckPath, selfcheckRecord, stateFolder, within } from './machine'
import { configureUpdateCheck, loadUpdateCheck, withUpdateNotice } from './update-check'

const TOOL = 'mcp__self-check__tools_check'

/** How long each tool, and each probe, may take to answer. */
const CALL_MS = 10_000
/** How long after a resume the quiet check runs, once the session is idle. */
const RESUME_MS = 10_000
/** A beat after a turn's end, so the turn is no longer running when a waiting check starts. */
const SETTLE_MS = 500

/** A probe as the setting names it: a server as its tools are named, `=`, and one of its tools. */
const PROBE = /^([A-Za-z0-9_-]{1,64})=([A-Za-z0-9_-]{1,128})$/
/** An MCP tool's name: its server, then the tool. */
const MCP_TOOL = /^mcp__([A-Za-z0-9_-]+?)__([A-Za-z0-9_-]+)$/

/** What a failure adds: a fresh process usually repairs a dead tool. */
const RESTART_HINT =
  "A fresh process usually repairs a dead tool: restart_after_turn (self-restart; it needs a safe point). Where the coordinator runs, the merger can restart this lane (`next: 'restart'`)."
/** What a failed MCP server adds: a reconnect may be all it needs. */
const MCP_HINT = 'An MCP server that failed may need only a reconnect: reconnect_mcp_after_turn (self-mcp).'

const DESCRIPTION = [
  "Checks that this session's own tools answer: it runs a harmless echo of a fresh nonce through the Bash and the PowerShell tools, as you would call them, each within 10 s, and checks the output holds it; it lists the MCP servers whose tools are connected, and exercises a server only through a probe the person named in the plugin's settings.",
  'Call it when a tool seems dead (an empty result where there should be output, a call that never answers), before working around it.',
  'Read-only: it opens no permission dialog (a tool whose call would ask is "not tested"), and writes only its own record of what failed.',
  'One line per tool: ok, or failed and why; on a failure it says how a fresh process repairs a dead tool.',
].join(' ')

const SUBAGENT =
  "A subagent can't run the session's tool check. Finish your piece and return its result, saying which tool seemed dead: the main session can check."

/** The plugin's settings, read at load. */
let checkAtResume = true
let probes: readonly string[] = []

/** Whether a main-loop turn is running now: the quiet check waits for it to end. */
let inTurn = false
/** The conversation whose quiet check waits for the running turn to end. */
let waiting: string | undefined

/** What an error says, as one line. */
function why(err: unknown): string {
  const said = oneLine(err instanceof Error ? err.message : String(err), 200)
  return said === '' ? 'no reason given' : said
}

/** A fresh nonce: 16 hex digits. */
function nonce(): string {
  const bytes = new Uint8Array(8)
  try {
    crypto.getRandomValues(bytes)
  } catch {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** What a shell tool's call printed: its stdout when its record has one, else the text the model reads. */
function output(run: { readonly result?: unknown; readonly text?: string }): string {
  if (isRecord(run.result) && typeof run.result.stdout === 'string') return run.result.stdout
  return typeof run.text === 'string' ? run.text : ''
}

/**
 * One shell tool, checked: its permission verdict, then, on `allow` only, the echo of a fresh nonce,
 * within 10 s. `listed` false: the session has no such tool.
 */
async function shell($: EngineInterface, tool: 'Bash' | 'PowerShell', listed: boolean): Promise<CheckLine> {
  const line = (status: CheckLine['status'], said: string): CheckLine => ({ name: tool, status, said: `${tool}: ${said}` })
  if (!listed) return line('absent', "not among this session's tools")
  const token = `selfcheck-${nonce()}`
  const command = tool === 'Bash' ? `echo ${token}` : `Write-Output ${token}`
  try {
    const verdict = await within($, CALL_MS, $.tool.check({ tool, input: { command } }))
    if (verdict === undefined) return line('not-tested', `not tested: its permission wasn't answered within ${CALL_MS / 1000} s`)
    const { decision, reason } = verdict.value
    if (decision !== 'allow') return line('not-tested', `not tested: ${denied(decision, reason)}`)
  } catch (err) {
    return line('not-tested', `not tested: its permission can't be read (${quoted(why(err))})`)
  }
  try {
    // The tool's arguments at the top level, as `$.tool.call` takes them (`$.tool.check` takes them
    // under `input`); a call with `input:` is an error result, which fails.
    const description = 'Echo a nonce to check this tool answers'
    const call = tool === 'Bash' ? $.tool.call({ tool: 'Bash', command, description }) : $.tool.call({ tool: 'PowerShell', command, description })
    const ran = await within($, CALL_MS, call)
    if (ran === undefined) return line('failed', `failed: timed out after ${CALL_MS / 1000} s`)
    const run = ran.value as { readonly deny?: string; readonly isError?: boolean; readonly result?: unknown; readonly text?: string }
    // Text from outside the plugin (a hook's refusal, the tool's error, its output) is quoted, one
    // line: the row at resume carries it to the model as data.
    if (typeof run.deny === 'string') return line('not-tested', `not tested: refused (${quoted(oneLine(run.deny, 160))})`)
    if (run.isError === true) return line('failed', `failed: it reported an error (${quoted(oneLine(String(run.text ?? ''), 200))})`)
    const out = output(run)
    if (out.trim() === '') return line('failed', 'failed: no output')
    if (!out.includes(token)) return line('failed', `failed: the output didn't hold the nonce (it read ${quoted(oneLine(out, 80))})`)
    return line('ok', 'ok')
  } catch (err) {
    return line('failed', `failed: it didn't run (${quoted(why(err))})`)
  }
}

/** A permission verdict other than allow, as a line says it: the reason, if any, quoted. */
function denied(decision: string, reason: string | undefined): string {
  const because = typeof reason === 'string' && reason.trim() !== '' ? `: ${quoted(oneLine(reason, 160))}` : ''
  return `${decision === 'ask' ? 'needs permission' : 'refused by permissions'} (${decision}${because})`
}

/** The text an MCP result's first text block holds, if any. */
function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  for (const block of content) if (isRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') return block.text
  return undefined
}

/**
 * The MCP servers: each listed one, by the tools the session has, and each a probe names. A server
 * is exercised only by its probe, and only when that tool is one of its listed tools.
 */
async function servers($: EngineInterface, tools: readonly ToolInfo[] | string): Promise<CheckLine[]> {
  if (typeof tools === 'string') return [{ name: 'MCP', status: 'failed', said: `MCP servers: failed: the session's tools can't be listed (${quoted(tools)})` }]
  const counts = new Map<string, number>()
  const names = new Set<string>()
  for (const t of tools) {
    const m = MCP_TOOL.exec(t.name)
    if (m === null) continue
    names.add(t.name)
    counts.set(m[1] as string, (counts.get(m[1] as string) ?? 0) + 1)
  }
  const lines: CheckLine[] = []
  const named = new Map<string, string>()
  for (const raw of probes) {
    const m = PROBE.exec(raw.trim())
    if (m === null) lines.push({ name: 'probe', status: 'not-tested', said: `probe ${quoted(oneLine(raw, 80))}: ignored, not server=tool` })
    else named.set(m[1] as string, m[2] as string)
  }
  const all = [...new Set([...counts.keys(), ...named.keys()])].sort()
  const checked = await Promise.all(
    all.map(async (server): Promise<CheckLine> => {
      const line = (status: CheckLine['status'], said: string): CheckLine => ({ name: `mcp:${server}`, status, said: `MCP server ${server}: ${said}` })
      const count = counts.get(server)
      const probe = named.get(server)
      if (count === undefined) return line('failed', `failed: not connected (no tools listed), so its probe ${probe} wasn't run`)
      const listed = `listed (${count} tool${count === 1 ? '' : 's'})`
      if (probe === undefined) return line('listed', `${listed}, not exercised`)
      if (!names.has(`mcp__${server}__${probe}`)) return line('not-tested', `${listed}; its probe ${probe} isn't one of its tools, so not exercised`)
      // `$.mcp.call` asks no permission, so the probe's verdict is asked first, as for the shells:
      // anything but allow is not tested, and nothing is called.
      try {
        const verdict = await within($, CALL_MS, $.tool.check({ tool: `mcp__${server}__${probe}`, input: {} }))
        if (verdict === undefined) return line('not-tested', `${listed}; not tested: its probe ${probe}'s permission wasn't answered within ${CALL_MS / 1000} s`)
        const { decision, reason } = verdict.value
        if (decision !== 'allow') return line('not-tested', `${listed}; not tested: its probe ${probe} ${denied(decision, reason)}`)
      } catch (err) {
        return line('not-tested', `${listed}; not tested: its probe ${probe}'s permission can't be read (${quoted(why(err))})`)
      }
      try {
        const ran = await within($, CALL_MS, $.mcp.call(server, probe, {}))
        if (ran === undefined) return line('failed', `failed: its probe ${probe} timed out after ${CALL_MS / 1000} s`)
        if (ran.value.isError) return line('failed', `failed: its probe ${probe} reported an error (${quoted(oneLine(firstText(ran.value.content) ?? '', 160))})`)
        return line('ok', `ok (probe ${probe})`)
      } catch (err) {
        return line('failed', `failed: its probe ${probe} didn't run (${quoted(why(err))})`)
      }
    }),
  )
  return [...lines, ...checked]
}

/** The whole check: one line per tool, in order (Bash, PowerShell, the MCP servers). */
async function check($: EngineInterface): Promise<CheckLine[]> {
  let tools: readonly ToolInfo[] | string
  try {
    tools = await $.tool.list()
  } catch (err) {
    tools = why(err)
  }
  // Unlisted only when the list was read and lacks it; an unreadable list still tries the call.
  const has = (name: string): boolean => typeof tools === 'string' || tools.some(t => t.name === name)
  const bash = await shell($, 'Bash', has('Bash'))
  const powershell = await shell($, 'PowerShell', has('PowerShell'))
  return [bash, powershell, ...(await servers($, tools))]
}

/** The answer: a summary line, one line per tool, and on a failure how to repair it. */
function answer(lines: readonly CheckLine[]): string {
  const failed = lines.filter(l => l.status === 'failed')
  const head = failed.length === 0 ? 'self-check: no tool failed.' : `self-check: ${failed.length} failed (${failed.map(l => l.name).join(', ')}).`
  const hints = failed.length === 0 ? [] : [RESTART_HINT, ...(failed.some(l => l.name.startsWith('mcp:')) ? [MCP_HINT] : [])]
  return [head, ...lines.map(l => l.said), ...hints].join('\n')
}

/** Writes the check's record for conversation `id`: the failed tools by name only. Never throws. */
async function record($: EngineInterface, id: string | undefined, lines: readonly CheckLine[]): Promise<void> {
  try {
    const local = await $.env.get('LOCALAPPDATA')
    if (!isSafeFolder(local) || id === undefined) return
    const path = selfcheckPath(stateFolder(local), id)
    if (path === undefined) return
    const failed = lines.filter(l => l.status === 'failed').map(l => l.name)
    await $.fs.write(path, selfcheckRecord(await $.clock.now(), failed))
  } catch (err) {
    $.ui.log(`the check's record wasn't written (${why(err)}).`)
  }
}

/** The session's id, or undefined when it can't be read. */
async function sessionId($: EngineInterface): Promise<string | undefined> {
  try {
    return await $.session.id()
  } catch {
    return undefined
  }
}

/** The check at resume, once no turn is running: says nothing when every tool answered. */
async function atIdle($: EngineInterface, id: string): Promise<void> {
  if (inTurn) {
    waiting = id
    return
  }
  const lines = await check($)
  await record($, id, lines)
  const failed = lines.filter(l => l.status === 'failed')
  if (failed.length === 0) return
  $.ui.toast(`self-check at resume: ${failed.map(l => l.name).join(', ')} failed. A fresh process usually repairs a dead tool (restart_after_turn).`)
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `self-check ran at resume. ${answer(lines)}` }] } })
  } catch {
    // The toast has told the person.
  }
}

export const register: Register = (on, options) => {
  configureUpdateCheck('self-check', options)
  checkAtResume = options.checkAtResume !== 'off'
  probes = Array.isArray(options.probes) ? options.probes.filter((p): p is string => typeof p === 'string') : []

  // First, so it is outermost on this plugin's tools: it sees each answer, and adds the update
  // notice when one is due. It never waits on the check; see update-check.ts.
  on('tool.call', { tool: /^mcp__self-check__/ }, async ($, e, next) => withUpdateNotice($, e, await next(e))).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'tools_check',
      description: DESCRIPTION,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      isDeferred: false,
    })
    loadUpdateCheck($)
    return started
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: SUBAGENT }
    const lines = await check($)
    await record($, await sessionId($), lines)
    return { result: answer(lines) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-check: the check failed to run.' }))

  // The quiet check, 10 s after a resume. It answers with what the chain beneath answered, always: a
  // failure here passes the start through unchanged.
  on('classic.SessionStart', async ($, e, next) => {
    const done = await next(e)
    if (e.agent_id !== undefined || e.source !== 'resume' || !checkAtResume) return done
    const id = e.session_id
    $.clock.after(RESUME_MS, () => void atIdle($, id))
    return done
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (e.agentId === undefined) inTurn = true
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    inTurn = false
    const id = waiting
    waiting = undefined
    if (id !== undefined) $.clock.after(SETTLE_MS, () => void atIdle($, id))
    return done
  })
}
