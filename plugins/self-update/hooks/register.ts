// Keeps the plugins this machine already has from the marketplaces the person names current, and reloads each session
// behind an install at its next idle moment. Off by default: with `autoUpdate` empty, no look runs, no lock, state file
// or install record is read or written, no command runs, and no session reloads for an update; the tool still answers,
// and the update check every self tool has still rides on it. The look is update.ts (the pure side update-logic.ts, the
// scripts scripts.ts); the reload is reload.ts.
//
// The two moments: a session's start and each main-loop turn's end, where a person is at the session (claude -p and SDK
// hosts don't look). At each, a look when one is due (update.ts), then, at a turn's end, whether this session is behind
// the machine's last install (reload.ts). A look's end asks the reload again.
//
// One tool, update_status, read-only: what self-update does on this machine and in this session. It is also the tool
// the update check rides on, as every self tool's does (update-check.ts).
import type { EngineInterface, Register } from 'claude-code'
import { reloadCheck, reloadLoaded, reloadOn, reloadRunning, reloadSeen, reloadStatusRead, reloadTurn, setReloadConf, setReloadInteractive } from './reload'
import { setUpdateConf, updateConf, updateLook, updateStatusRead } from './update'
import { autoUpdateOf, reloadAfterUpdateOf, statusText } from './update-logic'
import { configureUpdateCheck, loadUpdateCheck, withUpdateNotice } from './update-check'

const DESCRIPTION = [
  'Reports what self-update does on this machine: the marketplaces its autoUpdate setting names (or why it is off), when the machine last looked for updates and when a look last installed one, the failures in a row and the last one, and whether this session is behind an install and reloads at its next idle moment.',
  "Call it when the person asks whether their plugins are kept current, or why one wasn't updated.",
  'Read-only: it runs no command and changes nothing.',
].join(' ')

/** Whether a person is at the prompt (false under claude -p and SDK hosts): only then does a look or a reload run. */
let interactive = true

/** A look when one is due, its end asking the reload again; then the reload, at a turn's end. */
function moment($: EngineInterface, turnEnd: boolean): void {
  if (!interactive) return
  updateLook($, { reloading: reloadRunning, reloads: reloadOn, done: () => reloadCheck($) })
  if (turnEnd) reloadCheck($)
}

/** update_status's answer: nothing read with the setting empty or malformed. */
async function status($: EngineInterface): Promise<string> {
  const conf = updateConf()
  const now = await $.clock.now()
  if (conf.why !== undefined || conf.names.length === 0) return statusText({ conf, reloads: reloadOn(), state: undefined, now, loaded: undefined, interactive, record: undefined })
  const [{ cant, state }, { loaded, record }] = await Promise.all([updateStatusRead($), reloadStatusRead($)])
  return statusText({ conf, reloads: reloadOn(), ...(cant === undefined ? {} : { cant }), state, now, loaded, interactive, record })
}

export const register: Register = (on, options) => {
  configureUpdateCheck('self-update', options)
  setUpdateConf(autoUpdateOf(options.autoUpdate))
  setReloadConf(reloadAfterUpdateOf(options.reloadAfterUpdate))

  // First, so it is outermost on this plugin's tools: it sees each answer, and adds the update
  // notice when one is due. It never waits on the check; see update-check.ts.
  on('tool.call', { tool: /^mcp__self-update__/ }, async ($, e, next) => withUpdateNotice($, e, await next(e))).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    // This load's moment, before anything is awaited: a look that installs after it reloads this session.
    reloadLoaded($)
    const started = await next(e)
    interactive = e.isInteractive
    setReloadInteractive(e.isInteractive)
    await $.tool.register({
      name: 'update_status',
      description: DESCRIPTION,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      isDeferred: false,
    })
    loadUpdateCheck($)
    moment($, false)
    return started
  })

  // Before anything is awaited: a reload about to run reads it, and waits for this turn's end.
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) reloadTurn(true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    reloadTurn(false)
    // Neither waits on anything, nor throws: each runs in the background, one at a time.
    moment($, true)
    return done
  })

  // A /reload-plugins a person or another plugin runs: once it has answered, and reloaded, what was installed before it
  // started is loaded, so the session is behind that update no more (reload.ts). Only watched: it is passed on as it is.
  on('command.run', { command: 'reload-plugins' }, async ($, e, next) => {
    const at = await $.clock.now().catch(() => undefined)
    const done = await next(e)
    if (at !== undefined) reloadSeen(at, done.text)
    return done
  })

  on('tool.call', { tool: 'mcp__self-update__update_status' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: "A subagent can't read self-update's status: it is the main session's. Finish your piece and return its result; the main session can call it." }
    return { result: await status($) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'self-update: reading its status failed.' }))
}
