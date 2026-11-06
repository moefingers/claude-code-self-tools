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
// - Bash's env: on Windows, how much room this session's env script leaves a Bash command, since
//   Claude Code inlines it into every call and Git Bash runs only the first 8,186 characters of one
//   (env-guard.ts): OK, AT RISK or BROKEN, on a line after Bash's.
// The answer is one line per tool; on a failure it says how to repair one: for a dead Bash whose env
// is at fault, the dedupe and a move of the PowerShell tool's directory and back, never a fresh
// process alone (a resume reads the same files); for any other dead tool, a fresh process.
//
// At resume, quietly: on the classic SessionStart with `source: "resume"`, 10 s later and once no
// turn is running, the same check runs, and only a failure is said: a toast, and one row the model
// reads with the next message (it never starts a turn). The `checkAtResume` setting turns that off.
//
// The env guard (the `envDedupe` setting, on by default): right after the SessionStart hooks beneath
// this plugin have run (every source: startup, resume, clear, compact, fork), and when a check finds
// the env AT RISK or BROKEN, this session's setup and sessionstart env files are deduped (env-guard.ts)
// once they total over 2 KB, under a 5-second deadline for starting any write. Why then: SessionStart hooks are what grows the files without end (Claude Code clears
// the cwdchanged and filechanged ones itself), and as settings hooks they sit beneath every hooks
// module in the classic chain, so after `next` they have all appended; Claude Code drops its cached
// copy of the script after each SessionStart, Setup, CwdChanged and FileChanged hook and builds it
// again only at the next Bash call, so a dedupe here is what that call reads. A dedupe in a check
// lands after the copy was built, so it takes effect when the copy is dropped again: the shell
// tool's directory moving, or the next start.
//
// Each check writes one record, %LOCALAPPDATA%\claude-self-tools\selfcheck\<conversation>.json:
// `{ v: 1, at, failed }`, the failed tools by name only, which the coordinator's lane report carries.
// Besides that record, the plugin writes only the deduped env files and their backups (.orig, once; .bak).
import type { EngineInterface, Register, ToolInfo } from 'claude-code'
import type { CheckLine, EnvVerdict } from '../types'
import { dedupeFolder, envFolder, outcomeLine, readEnv, refusedFiles, rewritten } from './env-guard'
import type { DedupeOutcome, EnvReading } from './env-guard'
import { DEDUPE_OVER, dedupe, GIT_BASH_LIMIT, grouped, roomPhrase, verdictOf } from './env-rules'
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

/** The env guard's deadline: no write of a dedupe starts after it, at a session start or in a check. */
const ENV_MS = 5_000
/** How much longer a dedupe past its deadline is waited for: a write already under way, and putting a file back. */
const ENV_GRACE_MS = 5_000

/** What a failure adds when its cause isn't Bash's env: a fresh process usually repairs a dead tool. */
const RESTART_HINT =
  "A fresh process usually repairs a dead tool: restart_after_turn (self-restart; it needs a safe point). Where the coordinator runs, the merger can restart this lane (`next: 'restart'`)."
/** What a dead Bash adds when its env is at fault or unmeasured, and what an env at risk adds. */
const ENV_HINT = [
  "A Bash that runs nothing (no output, or `unexpected EOF` from a short command) is most often this session's env grown too long: Claude Code puts the session's env hook files (`~/.claude/session-env/<session>/*-hook-<n>.sh`) into every Bash call, and Git Bash drops everything past the call's 8,186th character, the command first (anthropics/claude-code#103861).",
  "The repair: dedupe those files, keeping each variable's last assignment, which leaves the same environment (self-check does it at each session start and in a check that finds the env at risk, while its envDedupe setting is on; the Bash env line says what it did), then have Claude Code read them again: in the main session, move the PowerShell tool's directory and back in two calls (`Set-Location ..`, then `Set-Location` to the folder it was in), and try Bash `echo ok`.",
  "A fresh process alone doesn't repair it: a resume reads the same files, unless the dedupe at its start shrinks them.",
].join(' ')
/**
 * The next step after a check's own dedupe: the dedupe doesn't drop Claude Code's cached copy of the
 * env script, a move of the shell's directory does.
 */
const AFTER_DEDUPE =
  "Claude Code still holds the old copy: now move the PowerShell tool's directory away and back, in two calls in the main session (`Set-Location ..`, then `Set-Location` to the folder it was in), then retry Bash"
/** What an env at risk adds when the dedupe refused a file: never a rewrite by hand. */
const REFUSED_HINT =
  "A file the Bash env line says was left as it was must not be edited by hand, with Bash, PowerShell or an edit tool: the dedupe couldn't show that a rewrite keeps the environment the same, and a wrong edit breaks every Bash call. Tell the person which file it is, so they can find the plugin that writes it."
/** What a check adds when an env file may be damaged: a restart reads it again, so the person puts it back. */
const DAMAGED_HINT =
  "An env file the Bash env line says may be damaged can break every Bash call, and a restart or a resume reads it again, so neither repairs it. Don't rewrite it by hand: tell the person, naming the file and its .bak (its text before the failed rewrite), so they can put it back."
/** What a failed MCP server adds: a reconnect may be all it needs. */
const MCP_HINT = 'An MCP server that failed may need only a reconnect: reconnect_mcp_after_turn (self-mcp).'

const DESCRIPTION = [
  "Checks that this session's own tools answer: it runs a harmless echo of a fresh nonce through the Bash and the PowerShell tools, as you would call them, each within 10 s, and checks the output holds it; on Windows it says how much room this session's env leaves a Bash command (Git Bash runs only the first 8,186 characters of a call); it lists the MCP servers whose tools are connected, and exercises a server only through a probe the person named in the plugin's settings.",
  'Call it when a tool seems dead (an empty result where there should be output, an `unexpected EOF` from a short command, a call that never answers), before working around it.',
  'It opens no permission dialog (a tool whose call would ask is "not tested"). It writes its own record of what failed and, when it finds the env at risk and the envDedupe setting is on, a deduped copy of this session\'s env hook files (the same environment, with backups).',
  'One line per tool: ok, or failed and why; on a failure it says how to repair it.',
].join(' ')

const SUBAGENT =
  "A subagent can't run the session's tool check. Finish your piece and return its result, saying which tool seemed dead: the main session can check."

/** The plugin's settings, read at load. */
let checkAtResume = true
let envDedupe = true
let probes: readonly string[] = []

/**
 * The env files a dedupe may have left damaged (its rewrite and putting the file back both failed),
 * by env folder: a check says so, in place of the fresh-process hint, which can't repair them.
 */
const damaged = new Map<string, Set<string>>()

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

/**
 * The Bash env line of a check: the verdict on the env as Bash runs with it now (before any dedupe
 * the check makes), or no verdict when it couldn't be measured; `said` is the line.
 */
type EnvLine = { readonly verdict: EnvVerdict | undefined; readonly said: string; readonly hasRefused?: boolean; readonly damaged?: readonly string[] }

/** The files a dedupe left as they were, and why, as a phrase; empty when it left none. */
function leftAlone(outcome: DedupeOutcome): string {
  if (outcome.kind === 'under') return ''
  // The plugin's own words as they are; an error from outside it (another plugin's refusal) quoted.
  const left = outcome.files.flatMap(f => {
    if (!('left' in f) || f.left === 'nothing-to-drop') return []
    const said = [f.why ?? f.left.replace(/-/g, ' '), ...(f.error === undefined ? [] : [quoted(oneLine(f.error, 160))])].join(': ')
    return [`${f.name} (${said})`]
  })
  return left.length === 0 ? '' : `; left as ${left.length === 1 ? 'it was' : 'they were'}: ${left.join(', ')}`
}

/**
 * Measures the env script of the session whose env folder is `folder`, and when it is AT RISK or
 * BROKEN and the envDedupe setting is on, dedupes the folder (over 2 KB only) and says so; then names
 * each env file a dedupe may have left damaged, until it reads as plain assignments again.
 */
async function measureEnv($: EngineInterface, folder: string): Promise<EnvLine> {
  const line = await measureNow($, folder)
  const known = damaged.get(folder)
  for (const name of [...(known ?? [])]) {
    const text = await $.fs.read(`${folder}\\${name}`).catch(() => undefined)
    if (text !== undefined && !('refused' in dedupe(text))) known?.delete(name)
  }
  const names = [...(known ?? [])]
  if (names.length === 0) return line
  const note = names.map(name => `${name} may be damaged (a dedupe's rewrite and putting it back both failed; its earlier text is in ${name}.orig and ${name}.bak)`)
  return { ...line, damaged: names, said: `${line.said}. ${note.join('; ')}` }
}

/**
 * Records the files a dedupe of `folder` may have left damaged, and says so at once in a toast
 * naming each and its backups: every Bash call may fail until it is put back.
 */
function noteDamaged($: EngineInterface, folder: string, outcome: DedupeOutcome): void {
  if (outcome.kind !== 'done') return
  const names = outcome.files.flatMap(f => ('left' in f && f.left === 'restore-failed' ? [f.name] : []))
  if (names.length === 0) return
  const known = damaged.get(folder) ?? new Set<string>()
  for (const name of names) known.add(name)
  damaged.set(folder, known)
  for (const name of names) {
    $.ui.toast(`self-check: the env file ${name} may be damaged: the dedupe's rewrite failed, and so did putting it back. Its earlier text is in ${name}.orig and ${name}.bak. Every Bash call may fail until it is put back.`)
  }
}

/** The env line from what the env script measures now, and what a dedupe did about it. */
async function measureNow($: EngineInterface, folder: string): Promise<EnvLine> {
  let now: EnvReading
  try {
    now = await readEnv($, folder)
  } catch (err) {
    return { verdict: undefined, said: `Bash env: not measured: its files can't be read (${quoted(why(err))})` }
  }
  const verdict = verdictOf(now.inlined)
  const head = `Bash env: ${verdict}: every Bash call carries ${grouped(now.inlined)} characters of session env, ${roomPhrase(now.inlined)} before Git Bash's cut at ${grouped(GIT_BASH_LIMIT)}`
  if (verdict === 'OK') return { verdict, said: head }
  if (!envDedupe) return { verdict, said: `${head}. Not deduped: the envDedupe setting is off` }
  let outcome: DedupeOutcome | undefined
  try {
    outcome = await boundedDedupe($, folder)
  } catch (err) {
    return { verdict, said: `${head}. The dedupe failed (${quoted(why(err))})` }
  }
  if (outcome === undefined) return { verdict, said: `${head}. The dedupe didn't finish within ${(ENV_MS + ENV_GRACE_MS) / 1000} s; it starts no write after ${ENV_MS / 1000} s` }
  $.ui.log(outcomeLine(outcome), { to: 'debug' })
  noteDamaged($, folder, outcome)
  if (outcome.kind === 'under') return { verdict, said: `${head}. Not deduped: its setup and sessionstart files hold ${grouped(outcome.bytes)} bytes, at or under ${grouped(DEDUPE_OVER)}` }
  const hasRefused = refusedFiles(outcome).length > 0
  if (rewritten(outcome).length === 0) {
    const left = leftAlone(outcome)
    return { verdict, hasRefused, said: left === '' ? `${head}. Nothing to dedupe: each variable is set once` : `${head}. Not deduped${left}` }
  }
  let after: EnvReading
  try {
    after = await readEnv($, folder)
  } catch (err) {
    return { verdict, hasRefused, said: `${head}. Deduped now, but the files can't be read again (${quoted(why(err))})${leftAlone(outcome)}. ${AFTER_DEDUPE}` }
  }
  return {
    verdict,
    hasRefused,
    said: `${head}. Deduped now to ${grouped(after.inlined)} characters (${verdictOf(after.inlined)}), the same environment${leftAlone(outcome)}. ${AFTER_DEDUPE}`,
  }
}

/**
 * The dedupe of `folder` under the env guard's deadline: a timer marks it stopped at 5 s, so no
 * write starts after that; one already under way, and putting a file back after it, are waited for
 * 5 s more. Undefined when even that runs out; the flag stays set, so nothing more starts.
 */
async function boundedDedupe($: EngineInterface, folder: string): Promise<DedupeOutcome | undefined> {
  let isStopped = false
  const deadline = $.clock.after(ENV_MS, () => {
    isStopped = true
  })
  try {
    const done = await within($, ENV_MS + ENV_GRACE_MS, dedupeFolder($, folder, { stop: { isStopped: () => isStopped } }))
    return done?.value
  } finally {
    isStopped = true
    deadline.cancel()
  }
}

/** The Bash env line for session `id`: undefined off Windows, or where the session id isn't one. */
async function envOf($: EngineInterface, id: string | undefined): Promise<EnvLine | undefined> {
  let folder: string | undefined
  try {
    folder = await envFolder($, id)
  } catch {
    return undefined
  }
  if (folder === undefined) return undefined
  // Reading the files gets 10 s; a dedupe in between has its own deadline and grace on top.
  const bound = CALL_MS + ENV_MS + ENV_GRACE_MS
  try {
    const measured = await within($, bound, measureEnv($, folder))
    return measured?.value ?? { verdict: undefined, said: `Bash env: not measured: its files weren't read within ${bound / 1000} s` }
  } catch (err) {
    return { verdict: undefined, said: `Bash env: not measured (${quoted(why(err))})` }
  }
}

/** A check's lines: one per tool, in order (Bash, PowerShell, the MCP servers), and Bash's env line. */
type Checked = { readonly lines: CheckLine[]; readonly env: EnvLine | undefined }

/** The whole check, for session `id`. */
async function check($: EngineInterface, id: string | undefined): Promise<Checked> {
  let tools: readonly ToolInfo[] | string
  try {
    tools = await $.tool.list()
  } catch (err) {
    tools = why(err)
  }
  // Unlisted only when the list was read and lacks it; an unreadable list still tries the call.
  const has = (name: string): boolean => typeof tools === 'string' || tools.some(t => t.name === name)
  const bash = await shell($, 'Bash', has('Bash'))
  const env = bash.status === 'absent' ? undefined : await envOf($, id)
  const powershell = await shell($, 'PowerShell', has('PowerShell'))
  return { lines: [bash, powershell, ...(await servers($, tools))], env }
}

/** Whether a dead Bash is to be put down to its env: measured at risk, or not measured on Windows. */
function envSuspect(env: EnvLine | undefined): boolean {
  return env !== undefined && env.verdict !== 'OK'
}

/** The answer: a summary line, one line per tool (Bash's env after Bash), and how to repair what failed. */
function answer({ lines, env }: Checked): string {
  const failed = lines.filter(l => l.status === 'failed')
  const head = failed.length === 0 ? 'self-check: no tool failed.' : `self-check: ${failed.length} failed (${failed.map(l => l.name).join(', ')}).`
  const isBashDead = failed.some(l => l.name === 'Bash')
  const isEnvAtRisk = env?.verdict === 'AT RISK' || env?.verdict === 'BROKEN'
  const isDamaged = (env?.damaged?.length ?? 0) > 0
  const hints = [
    ...(isDamaged ? [DAMAGED_HINT] : []),
    ...(isEnvAtRisk || (isBashDead && envSuspect(env)) ? [ENV_HINT] : []),
    ...(isEnvAtRisk && env?.hasRefused === true ? [REFUSED_HINT] : []),
    ...(failed.some(l => l.name !== 'Bash') || (isBashDead && !envSuspect(env) && !isDamaged) ? [RESTART_HINT] : []),
    ...(failed.some(l => l.name.startsWith('mcp:')) ? [MCP_HINT] : []),
  ]
  const said = lines.flatMap(l => (l.name === 'Bash' && env !== undefined ? [l.said, env.said] : [l.said]))
  return [head, ...said, ...hints].join('\n')
}

/** The env guard at a session start: dedupes session `id`'s setup and sessionstart files once they total over 2 KB. Never throws. */
async function guardAtStart($: EngineInterface, id: string | undefined): Promise<void> {
  try {
    const folder = await envFolder($, id)
    if (folder === undefined) return
    const outcome = await boundedDedupe($, folder)
    if (outcome === undefined) $.ui.log(`session env: the dedupe didn't finish within ${(ENV_MS + ENV_GRACE_MS) / 1000} s; it starts no write after ${ENV_MS / 1000} s`, { to: 'debug' })
    else if (outcome.kind === 'done') {
      $.ui.log(outcomeLine(outcome), { to: 'debug' })
      noteDamaged($, folder, outcome)
    }
  } catch (err) {
    $.ui.log(`session env: the dedupe failed (${why(err)})`, { to: 'debug' })
  }
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
  // A /clear or a switch since the resume: this process runs another conversation now, and the check
  // (its env folder above all) is not this one's to make.
  if ((await sessionId($)) !== id) return
  const checked = await check($, id)
  await record($, id, checked.lines)
  const failed = checked.lines.filter(l => l.status === 'failed')
  if (failed.length === 0) return
  const names = failed.map(l => l.name).join(', ')
  $.ui.toast(
    failed.some(l => l.name === 'Bash') && (checked.env?.damaged?.length ?? 0) > 0
      ? `self-check at resume: ${names} failed. An env file may be damaged; the note Claude reads names it.`
      : failed.some(l => l.name === 'Bash') && envSuspect(checked.env)
      ? `self-check at resume: ${names} failed. Bash's session env may have grown too long; the note Claude reads says how to repair it.`
      : `self-check at resume: ${names} failed. A fresh process usually repairs a dead tool (restart_after_turn).`,
  )
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `self-check ran at resume. ${answer(checked)}` }] } })
  } catch {
    // The toast has told the person.
  }
}

export const register: Register = (on, options) => {
  configureUpdateCheck('self-check', options)
  checkAtResume = options.checkAtResume !== 'off'
  envDedupe = options.envDedupe !== 'off'
  damaged.clear()
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
    const id = await sessionId($)
    const checked = await check($, id)
    await record($, id, checked.lines)
    return { result: answer(checked) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-check: the check failed to run.' }))

  // After the SessionStart hooks beneath have run, of every source: the env guard, awaited, so the
  // session's first Bash call reads what it leaves; then, at a resume, the quiet check 10 s later. It
  // answers with what the chain beneath answered, always: a failure here passes the start through
  // unchanged.
  on('classic.SessionStart', async ($, e, next) => {
    const done = await next(e)
    if (e.agent_id !== undefined) return done
    if (envDedupe) await guardAtStart($, typeof e.session_id === 'string' ? e.session_id : await sessionId($))
    if (e.source !== 'resume' || !checkAtResume) return done
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
