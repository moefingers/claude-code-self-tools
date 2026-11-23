// A session behind an install reloads itself, at idle. A look that installed a newer version of a plugin (update.ts)
// leaves the time in the machine's state file; every session already running keeps the plugins it loaded until it
// reloads or restarts, and nothing in Claude Code tells it so. With `reloadAfterUpdate` on (the default) and `autoUpdate`
// naming a marketplace, a session whose plugins were loaded before that time runs /reload-plugins once, at an idle turn
// end. When they were loaded (`loaded`): this module's first moment, as a session's start begins, moved on to the
// moment any /reload-plugins that reloaded ran (this plugin's own, a person's, another plugin's). Claude Code reloads
// only the plugins that changed, so after a reload that took this module may well run on: its first moment alone would
// call the session behind an update it has already loaded.
//
// When it looks: at each main-loop turn's end (register.ts), and at the end of this session's own look, never from a
// timer of its own. It reads one thing, the state file's install time, and only with both settings on and a person at
// the session (claude -p and SDK hosts can't run a plugin's /reload-plugins: they don't look, and say nothing).
//
// When it runs: a beat after it is asked for, and only once nothing holds it, every hold read again right before
// (update-logic.ts, RELOAD_HOLDS): no turn running, an empty prompt box (the read says only whether a draft stands;
// nothing of it is kept or logged), no subagent at work, no look of this session's under way (a reload would drop it
// mid-look), no reload of this plugin's still out, and none in the last 15 minutes. Held, it waits for the next turn's
// end; it never interrupts a turn, and Claude Code runs a plugin's command only once the session is idle anyway.
//
// Never a loop: a try counts right before /reload-plugins runs, kept in the plugin's session state by the install's
// time. A reload that took (Claude Code's own `Reloaded …` line) leaves the session behind no more. One that Claude Code
// skipped (it asks for /reload-plugins --force), one that didn't run, or one whose answer is of another shape is tried
// once more, 15 minutes on at the soonest, then never again for
// that install: the person reads one line in the transcript, once, and nothing is added to the conversation. A later
// install starts its own two tries.
// Never `/reload-plugins --force`: forcing a held reload re-reads the whole conversation without the prompt cache,
// which is the person's to choose.
import type { EngineInterface, Timer } from 'claude-code'
import { updateConf, updateInstalledAt, updateRunning } from './update'
import { behindInstall, oneLine, readReloadRecord, recordFor, reloadHold, RELOAD_LINE, RELOAD_TRIES, reloadTook, RESTART_LINE, type ReloadRecord } from './update-logic'

const reloadRef = { plugin: 'self-update', key: 'reload' } as const
const lastRef = { plugin: 'self-update', key: 'lastReload' } as const
/** A read of the prompt box or the agents waits this long at most. */
const READ_MS = 5_000
/** A beat after it is asked for: the turn's end has returned, and the session is idle. */
const SETTLE_MS = 1_000
/** A /reload-plugins whose command never answered is taken as over after this long. */
const LOST_MS = 15 * 60_000

// Module state; a reload drops it, and the tries come back from $.state.
/** The `reloadAfterUpdate` setting. */
let on = true
/** Whether a person is at the prompt (false under claude -p and SDK hosts). */
let interactive = true
/** When this module was first heard of in this load: the session's plugins were loaded no later; undefined when the clock can't be read. */
let loaded: Promise<number | undefined> | undefined
/** A main-loop turn runs. */
let turnRunning = false
/** A /reload-plugins this module runs is out: from right before its command until it answers (or this module is replaced). */
let reloading = false
/** The records as this module last wrote them: the engine empties $.state when a /clear or a /resume moves the session, and this module lives on. */
const held: { record?: ReloadRecord; last?: number } = {}
/** The check under way: one at a time. */
let checking: Promise<void> | undefined
/** One more check is owed once the one under way ends (this session's look ended meanwhile, and may have installed something). */
let again = false
/** The run asked for a beat from now. */
let scheduled: Timer | undefined

/** register.ts, from the plugin's options: the `reloadAfterUpdate` setting as read. */
export function setReloadConf(value: boolean): void {
  on = value
}

/** Whether sessions reload themselves after an install (the install's line says so only then). */
export const reloadOn = (): boolean => on

/** register.ts, at session.start: whether a person is at the prompt. */
export function setReloadInteractive(value: boolean): void {
  interactive = value
}

/** register.ts, as a session's start begins, before anything is awaited: this load's moment. */
export function reloadLoaded($: EngineInterface): void {
  loaded ??= $.clock.now().catch(() => undefined)
}

/**
 * A /reload-plugins that started at `at` answered `text` (this plugin's, or one register.ts saw a person or another
 * plugin run): when it reloaded, everything installed before it started is loaded now, so the session's load time moves
 * on to `at`. One that was skipped, or whose answer isn't Claude Code's own line saying it reloaded, moves nothing.
 */
export function reloadSeen(at: number, text: string | undefined): void {
  if (!reloadTook(text)) return
  const was = loaded ?? Promise.resolve(undefined)
  loaded = was.then(before => (before === undefined || at > before ? at : before))
}

/** register.ts: a main-loop turn started (true) or ended. */
export function reloadTurn(running: boolean): void {
  turnRunning = running
}

/** Whether a /reload-plugins this plugin ran is still out: update.ts starts no look while it is. */
export function reloadRunning(): boolean {
  return reloading
}

async function readRecord($: EngineInterface): Promise<ReloadRecord | undefined> {
  try {
    return readReloadRecord((await $.state.get(reloadRef)).value) ?? held.record
  } catch {
    return held.record
  }
}

async function writeRecord($: EngineInterface, record: ReloadRecord): Promise<void> {
  held.record = record
  await $.state.set(reloadRef, record).catch(() => undefined)
}

async function readLast($: EngineInterface): Promise<number | undefined> {
  try {
    const value = (await $.state.get(lastRef)).value
    return typeof value === 'number' && Number.isFinite(value) ? value : held.last
  } catch {
    return held.last
  }
}

async function writeLast($: EngineInterface, at: number): Promise<void> {
  held.last = at
  await $.state.set(lastRef, at).catch(() => undefined)
}

/** `work`, or 'timeout' once `ms` have passed on the engine's clock. */
async function within<T>($: EngineInterface, work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: Timer | undefined
  const timeout = new Promise<'timeout'>(resolve => {
    timer = $.clock.after(ms, () => resolve('timeout'))
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    timer?.cancel()
  }
}

/** update_status: this load's moment, and the record of the reloads tried for the last install. Never throws. */
export async function reloadStatusRead($: EngineInterface): Promise<{ loaded: number | undefined; record: ReloadRecord | undefined; interactive: boolean }> {
  return { loaded: await (loaded ?? Promise.resolve(undefined)), record: await readRecord($), interactive }
}

/**
 * register.ts, at each main-loop turn's end, and at the end of this session's look: whether this session is behind the
 * machine's last install, and if so, its reload asked for a beat from now. In the background, one at a time; never throws.
 */
export function reloadCheck($: EngineInterface): void {
  if (!on || !interactive || updateConf().names.length === 0) return
  if (checking !== undefined) {
    again = true
    return
  }
  checking = check($)
    .catch(() => undefined)
    .finally(() => {
      checking = undefined
      if (!again) return
      again = false
      reloadCheck($)
    })
}

/** The install this session is behind, read now, or undefined when it is behind none. */
async function behind($: EngineInterface): Promise<number | undefined> {
  const installedAt = await updateInstalledAt($)
  if (installedAt === undefined) return undefined
  return behindInstall(installedAt, await (loaded ?? Promise.resolve(undefined)), await $.clock.now()) ? installedAt : undefined
}

async function check($: EngineInterface): Promise<void> {
  const install = await behind($)
  if (install === undefined) return
  const stored = await readRecord($)
  const record = recordFor(stored, install)
  if (record !== stored) await writeRecord($, record)
  if (record.tries >= RELOAD_TRIES) {
    if (!record.told) {
      await writeRecord($, { ...record, told: true })
      $.ui.log(RESTART_LINE)
    }
    return
  }
  scheduled?.cancel()
  scheduled = $.clock.after(SETTLE_MS, () => {
    scheduled = undefined
    void run($).catch(() => undefined)
  })
}

/** The reload, when nothing holds it now: the try counted, then /reload-plugins. Held, it waits for the next turn's end. */
async function run($: EngineInterface): Promise<void> {
  const install = await behind($)
  if (install === undefined) return
  const record = recordFor(await readRecord($), install)
  const [promptRead, agents, lastReload, now] = await Promise.all([
    within($, $.prompt.read(), READ_MS).catch(() => 'timeout' as const),
    within($, $.agent.list(), READ_MS).catch(() => 'timeout' as const),
    readLast($),
    $.clock.now(),
  ])
  const hold = reloadHold({
    interactive,
    on,
    tries: record.tries,
    turnRunning,
    draft: promptRead === 'timeout' ? undefined : promptRead.text,
    agents: agents === 'timeout' ? undefined : agents,
    looking: updateRunning(),
    reloading,
    lastReload,
    now,
  })
  if (hold !== undefined) {
    $.ui.log(`self-update: a plugin was updated after this session loaded its plugins; its reload waits: ${hold}.`, { to: 'debug' })
    return
  }
  // Read again in the same breath as `reloading` is set: a turn or a look that started since the holds were read takes it back to a later turn's end.
  if (turnRunning || updateRunning() || reloading) return
  reloading = true
  const lost = $.clock.after(LOST_MS, () => {
    reloading = false
  })
  try {
    // The try is counted before the command: the reload replaces this module, and the one it starts reads it.
    await writeRecord($, { ...record, tries: record.tries + 1 })
    await writeLast($, now)
    $.ui.log(RELOAD_LINE)
    $.ui.toast(RELOAD_LINE)
    // Read right before it runs: what was installed before this moment is what the reload loads.
    const ranAt = await $.clock.now()
    const said = (await $.command.run({ command: 'reload-plugins' })).text
    // This module runs on (a reload replaces only the plugins that changed): the reload's answer says whether it took.
    reloadSeen(ranAt, said)
    if (!reloadTook(said)) $.ui.log(`self-update: /reload-plugins didn't say it reloaded: ${said === undefined || oneLine(said, 200) === '' ? 'no answer' : oneLine(said, 200)}`, { to: 'debug' })
  } catch (error) {
    const said = (error instanceof Error ? error.message : String(error)).trim()
    $.ui.log(`self-update: /reload-plugins didn't run: ${said === '' ? 'no reason given' : said}.`, { to: 'debug' })
  } finally {
    // Its command answered (or never ran): a module the reload replaced never gets here.
    reloading = false
    lost.cancel()
  }
}
