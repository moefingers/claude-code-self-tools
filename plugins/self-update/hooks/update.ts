// The look: with the `autoUpdate` setting naming plugin marketplaces, this machine keeps the plugins it already has from
// them current, with Claude Code's own `claude plugin` commands. Empty, the default, is off: no look, no lock, no state
// file or install record read or written, no command. The pure side is update-logic.ts; the scripts are scripts.ts.
//
// When it looks: at the session's start and at each main-loop turn's end (register.ts), where a person is at the
// session, never from a timer of its own, and only when the machine's last look is a whole interval old: 5 minutes while
// every named marketplace is reached, stretched to an hour at most for each look in a row that couldn't reach one (its
// refresh failed, ran past its time or couldn't be started: update-logic.ts, lookEveryMs). A plugin's own update failing
// never stretches it. That time, and the counts, are in one file per plugins folder, beside the lock, so ten sessions
// make one look per interval, not ten. A look under way stamps the time before its first command and after each, so it
// reads as fresh for as long as it runs. A state file that is there but can't be read now means no look now: it is
// never taken for none, and never written over.
//
// The lock: the look takes it first (self-remote-control's two lock scripts, byte for byte, on the auto-update folder's
// lock file, made exclusively), reads the time again under it, and gives it back at its end. TAKE takes over a lock
// over 90 s old, whether its holder is alive or not, so before each command a lock more than 5 s old is given back and
// taken again with a new time (RENEW_AFTER_MS): a command never starts but under a lock at most 5 s old (a lock that
// took longer than that to take again stops the look), and one step (80 s at the most: scripts.ts, COMMAND_MS) ends
// before that lock is 90 s old. A look whose lock is taken over, or can't be taken again,
// stops at once, runs nothing more, and says so in the debug log. Another plugin that keeps plugins current takes the
// same lock file the same way; it keeps its own state file, which this one never reads or writes. The two stay apart
// only while each renews the lock this way: an updater that holds the lock longer than 90 s without renewing it can be
// taken over, and then both run commands.
//
// What a look runs (update-logic.ts, updatePlan; scripts.ts, UPDATE_SCRIPT): for each named marketplace with a plugin
// installed here, `claude plugin marketplace update <marketplace>`, then `claude plugin update <plugin>@<marketplace>
// --scope <scope>` for every install record of it: the user's from the home folder, a project's or a local one from that
// record's own folder (skipped while that folder is gone). Nothing else: no marketplace added, no plugin installed that
// has no record, no marketplace the setting doesn't name, no version asked for, never `--force`. What it reads: Claude
// Code's install records (names, scopes, folders, versions) before and after, whether a record's project folder is
// there, its own state file, this conversation's pending marker, and of each command its exit code and its last line.
//
// An exit or a restart pending: self-exit and self-restart write a marker while one is queued or armed (scripts.ts,
// pendingPath), and check, right before their command, that nothing runs under the session. So no look starts while
// this conversation's marker says one is pending (the next turn's end, or the next session, looks), and a look under way
// stops before its next command. self-switch writes no such marker, so a switch is not seen here.
//
// A command never outlives its look: the script that starts it gives it what is left of STEP_MS, counted from the
// script's own first line, then ends it with every process it started (Windows' own taskkill, the only other program
// this runs) and says so; the plugin's timeout (COMMAND_MS) is only the backstop above that. A command whose time ran
// out ends its marketplace's steps for this look.
//
// A reload this plugin runs and a look never overlap in one session: no /reload-plugins of this plugin's starts while
// this session's look is under way (reload.ts reads updateRunning), and no look starts while one is out
// (`how.reloading`). A reload would drop this module mid-look: its lock not given back, what it installed never
// recorded, a command cut off. A /reload-plugins a person or another plugin runs is not held.
//
// What it says: one transcript line and one toast per install (a record that named another version or folder after the
// commands than before), nothing when nothing changed. A failed command is recorded and tried again at the next look;
// three looks failing in a row get one toast, with the command and its last line, masked. A named marketplace with no
// plugin installed here is said once, in the transcript. An install leaves its time in the state file: a session whose
// plugins were loaded before it reloads itself at idle (reload.ts).
//
// Windows only (the lock's scripts and the launcher are Windows PowerShell's): elsewhere it does nothing and says so
// once in the debug log. Where no claude can be started, it says so once in the transcript (the person set the option)
// and runs nothing more in this session. A command that couldn't be started is a failure like any other, tried again at
// the next look.
import type { EngineInterface, Timer } from 'claude-code'
import { COMMAND_MS, isSafeFolder, pendingPath, powershellCall, powershellPath, readPending, RELEASE_SCRIPT, stateFolder, SYSTEM_ROOT, TAKE_SCRIPT, UPDATE_SCRIPT } from './scripts'
import {
  configFolderOf,
  ENDED_SAID,
  failureSaid,
  failuresNext,
  floorHolds,
  INSIDE_SAID,
  INSTALLED_FILE,
  installedLine,
  installsChanged,
  installsOf,
  lockText,
  lookDue,
  lookEveryMs,
  maskedLine,
  namesIdle,
  pluginsFolderOf,
  readReleaseReply,
  readStepReply,
  readTakeReply,
  readUpdateState,
  stepEnv,
  stepSaid,
  updateLockPath,
  updatePlan,
  updateStatePath,
  updateStateText,
  type AutoUpdate,
  type Step,
  type UpdateState,
} from './update-logic'

/** A read or a write of a file waits this long at most. */
const READ_MS = 5_000
/** One of the lock's scripts runs this long at most. */
const LOCK_RUN_MS = 15_000
/** A run is given up on this long after its own timeout. */
const RUN_GRACE_MS = 5_000

/** Where this machine keeps what a look needs: Windows PowerShell, the home folder, the install records, the self tools' state folder, the lock and the state file. */
type Place = { powershell: string; home: string; installed: string; stateDir: string; lock: string; state: string }

/** The lock as this look holds it: the text it was last taken with (undefined once it isn't held), and when. */
type Held = { text: string | undefined; at: number }

/**
 * A lock older than this when a command is about to start is given back and taken again first. One step takes 80 s at
 * the most (scripts.ts, COMMAND_MS, and the 5 s this gives up on a script after it), so a lock no older than this as the
 * step starts is still under the 90 s at which TAKE takes a lock over when the step ends.
 */
const RENEW_AFTER_MS = 5_000

/**
 * What register.ts hands a look: whether a /reload-plugins this plugin runs is out in this session (no look starts
 * then), whether sessions reload themselves here (`reloadAfterUpdate` on: the install's line says so only then), and
 * what to do at a look's end (the reload it held, and this session's own, are asked again).
 */
export type LookWith = { reloading: () => boolean; reloads: () => boolean; done: () => void }

// Module state; a reload drops it, and the machine's files carry on.
let conf: AutoUpdate = { names: [] }
/** The reason the setting is off, as last said. */
let saidOff: string | undefined
/** Why nothing more runs in this process (the helper can't run here, or no claude can be started), said once. */
let cant: string | undefined
/** The named marketplaces already said to have nothing installed here. */
const saidIdle = new Set<string>()
/** This process looks again no sooner than this, whatever the files say (update-logic.ts, floorHolds). */
let nextAt = 0
/** The look under way: one at a time. */
let looking: Promise<void> | undefined
/** The machine's folders, placed once (or why they can't be). */
let placed: Place | string | undefined

/** register.ts, from the plugin's options: the `autoUpdate` setting as read (update-logic.ts, autoUpdateOf). */
export function setUpdateConf(next: AutoUpdate): void {
  conf = next
}

/** The `autoUpdate` setting as read. */
export const updateConf = (): AutoUpdate => conf

/** Whether this session's look is under way, from the moment it is asked for to its end (its lock given back, its record written): reload.ts starts no /reload-plugins while it is. */
export function updateRunning(): boolean {
  return looking !== undefined
}

/** `work`, or 'timeout' once `ms` have passed on the engine's clock. */
async function withTimeout<T>($: EngineInterface, work: Promise<T>, ms: number): Promise<T | 'timeout'> {
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

/** The helper can't run on this machine (another platform, its folders unplaced): said once in the debug log, and nothing more is tried in this process. */
function cantRun($: EngineInterface, why: string): void {
  if (cant === undefined) $.ui.log(`self-update: autoUpdate is set, but it does nothing in this session: ${why}.`, { to: 'debug' })
  cant ??= why
}

/** No claude can be started here: said once where the person sees it (they set the option), and nothing more is tried in this process. */
function noClaude($: EngineInterface): void {
  if (cant === undefined) $.ui.log('self-update: autoUpdate is set, but no claude that Windows can start was found (in %USERPROFILE%\\.local\\bin, or on PATH), so this session updates nothing.')
  cant ??= 'no claude that Windows can start was found (in %USERPROFILE%\\.local\\bin, or on PATH)'
}

/** Claude Code's home and config folders as it reads them: USERPROFILE on Windows (else HOME), CLAUDE_CONFIG_DIR, and whether it runs on Windows. */
async function claudeFolders($: EngineInterface): Promise<{ home: string | undefined; configDir: string | undefined; windows: boolean }> {
  const [configDir, os] = await Promise.all([$.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined), $.env.get('OS').catch(() => undefined)])
  const home = os === 'Windows_NT' ? ((await $.env.get('USERPROFILE').catch(() => undefined)) ?? (await $.env.get('HOME').catch(() => undefined))) : await $.env.get('HOME').catch(() => undefined)
  return { home, configDir, windows: os === 'Windows_NT' }
}

async function place($: EngineInterface): Promise<Place | string> {
  if (placed !== undefined) return placed
  const { home, configDir, windows } = await claudeFolders($)
  if (!windows) return (placed = 'it runs on Windows only')
  const [root, local, cacheDir, cowork] = await Promise.all([
    $.env.get('SystemRoot').catch(() => undefined),
    $.env.get('LOCALAPPDATA').catch(() => undefined),
    $.env.get('CLAUDE_CODE_PLUGIN_CACHE_DIR').catch(() => undefined),
    $.env.get('CLAUDE_CODE_USE_COWORK_PLUGINS').catch(() => undefined),
  ])
  const systemRoot = (root ?? '').replace(/\\+$/, '')
  const plugins = pluginsFolderOf(configFolderOf(home, configDir, windows), cacheDir, cowork, windows)
  if (!SYSTEM_ROOT.test(systemRoot) || !isSafeFolder(local) || !isSafeFolder(home) || plugins === undefined) return (placed = "the Windows folder, %LOCALAPPDATA%, the home folder or Claude Code's plugins folder can't be placed")
  return (placed = { powershell: powershellPath(systemRoot), home, installed: `${plugins}/${INSTALLED_FILE}`, stateDir: stateFolder(local), lock: updateLockPath(local, plugins), state: updateStatePath(local, plugins) })
}

async function read($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    const text = await withTimeout($, $.fs.read(path), READ_MS)
    return text === 'timeout' ? undefined : text
  } catch {
    return undefined
  }
}

async function write($: EngineInterface, path: string, state: UpdateState): Promise<boolean> {
  try {
    return (await withTimeout($, $.fs.write(path, updateStateText(state)), READ_MS)) !== 'timeout'
  } catch {
    return false
  }
}

/** Whether a file or folder is there: true, false, or undefined when that can't be told now. */
async function existsSure($: EngineInterface, path: string): Promise<boolean | undefined> {
  try {
    const there = await withTimeout($, $.fs.exists(path), READ_MS)
    return there === 'timeout' ? undefined : there === true
  } catch {
    return undefined
  }
}

/**
 * The state file, read: the state, undefined for none (no file, or one half written: a look is then due, and decided
 * under the lock), or 'unreadable' when the file is there, or may be, but can't be read now (a read that ran out of
 * time, a file another program holds): then no look, and nothing written over it.
 */
async function readState($: EngineInterface, path: string): Promise<UpdateState | undefined | 'unreadable'> {
  const text = await read($, path)
  if (text !== undefined) return readUpdateState(text)
  return (await existsSure($, path)) === false ? undefined : 'unreadable'
}

/**
 * Whether self-exit or self-restart has an exit or a restart pending in this conversation, by the marker each writes
 * while one is queued or armed (scripts.ts, pendingPath and readPending). Read only, never written. No marker, or one
 * that says it ran, was cancelled or is stale: not pending. A marker that is there but can't be read now: pending, so a
 * look stands aside rather than meet the exit's check.
 */
async function pendingHere($: EngineInterface, where: Place): Promise<boolean> {
  let path: string | undefined
  try {
    path = pendingPath(where.stateDir, await $.session.id())
  } catch {
    return false
  }
  if (path === undefined) return false
  const text = await read($, path)
  if (text === undefined) return (await existsSure($, path)) !== false
  return readPending(text, await $.clock.now()) === 'pending'
}

/** One script by Windows PowerShell (scripts.ts, powershellCall: the script on standard input, its inputs in the environment): what it printed and how it exited, or how it failed to. */
async function runScript($: EngineInterface, powershell: string, script: string, env: Record<string, string>, timeoutMs: number, cwd?: string): Promise<{ exitCode: number; stdout: string; stderr: string } | 'not-started' | 'timed-out'> {
  const started = await $.clock.now()
  try {
    const call = powershellCall(powershell, script)
    const result = await withTimeout($, $.process.run([...call.argv], { stdin: call.stdin, env, timeoutMs, ...(cwd === undefined ? {} : { cwd }) }), timeoutMs + RUN_GRACE_MS)
    return result === 'timeout' ? 'timed-out' : { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  } catch {
    return (await $.clock.now()) - started >= timeoutMs ? 'timed-out' : 'not-started'
  }
}

/** One of the lock's two scripts (scripts.ts), run exactly as self-remote-control runs them: what it printed, or undefined. */
async function runLock($: EngineInterface, where: Place, text: string, script: string): Promise<string | undefined> {
  const ran = await runScript($, where.powershell, script, { RC_LOCK_PATH: where.lock, RC_LOCK_TEXT: text }, LOCK_RUN_MS)
  return typeof ran === 'string' || ran.exitCode !== 0 ? undefined : ran.stdout
}

/**
 * Before a command: the lock, when it is more than RENEW_AFTER_MS old, given back and taken again with a new time.
 * Undefined when it is held fresh, else why the look must stop. Given back only while it holds this look's own text (RELEASE compares it), and taken again only once
 * it was given back or is gone; a lock another updater took over, or one that can't be given back or taken, ends the look.
 */
async function renew($: EngineInterface, where: Place, held: Held): Promise<string | undefined> {
  if (held.text === undefined) return 'the lock is no longer held'
  const now = await $.clock.now()
  // Taken a moment ago (the look's own first take, or a step that ended at once): fresh enough for the next step.
  if (now >= held.at && now - held.at <= RENEW_AFTER_MS) return undefined
  const gave = await runLock($, where, held.text, RELEASE_SCRIPT)
  const given = gave === undefined ? undefined : readReleaseReply(gave)
  if (given === 'kept') {
    held.text = undefined
    return 'another updater took the lock over'
  }
  if (given !== 'released' && given !== 'gone') return "its lock couldn't be given back to be taken again"
  held.text = undefined
  const at = await $.clock.now()
  const text = lockText(at)
  const took = await runLock($, where, text, TAKE_SCRIPT)
  const taken = took === undefined ? undefined : readTakeReply(took)
  if (taken === 'taken') {
    held.text = text
    held.at = at
    // A machine so slow that taking the lock ate into its 90 s: the next command would outlast it, so none starts.
    return (await $.clock.now()) - at > RENEW_AFTER_MS ? 'its lock took more than 5 s to take again' : undefined
  }
  return taken === undefined ? "its lock couldn't be taken again" : 'another updater took the lock as it was given back'
}

/**
 * reload.ts and update_status: when a look on this machine last installed a newer version of a plugin, from the state
 * file. Undefined with the setting empty (nothing is read then), or when it can't be told. Never throws.
 */
export async function updateInstalledAt($: EngineInterface): Promise<number | undefined> {
  if (conf.names.length === 0) return undefined
  try {
    const where = await place($)
    if (typeof where === 'string') return undefined
    const state = await readState($, where.state)
    return state === undefined || state === 'unreadable' ? undefined : state.installed
  } catch {
    return undefined
  }
}

/**
 * update_status: why this session does nothing (another platform, its folders unplaced, no claude), and the machine's
 * state file as read (undefined for none yet, 'unread' when it can't be read). Only with the setting naming
 * marketplaces: register.ts never asks otherwise. Never throws.
 */
export async function updateStatusRead($: EngineInterface): Promise<{ cant?: string; state: UpdateState | undefined | 'unread' }> {
  try {
    const where = await place($)
    if (typeof where === 'string') return { cant: where, state: undefined }
    const read = await readState($, where.state)
    const state = read === 'unreadable' ? 'unread' : read
    return cant === undefined ? { state } : { cant, state }
  } catch {
    return { state: 'unread' }
  }
}

/**
 * register.ts, at the session's start and at each main-loop turn's end, where a person is at the session: a look, when
 * the setting names a marketplace, no reload of this plugin's is out here, and the machine's last look is old enough. In
 * the background, one at a time; never throws. `how.done` is called at its end, whatever came of it.
 */
export function updateLook($: EngineInterface, how: LookWith): void {
  if (conf.why !== undefined && saidOff !== conf.why) {
    saidOff = conf.why
    $.ui.log(`self-update: autoUpdate is off: ${conf.why}.`)
  }
  // Decided before anything is awaited, and `looking` set in the same breath: a reload that reads updateRunning right after waits.
  if (conf.names.length === 0 || cant !== undefined || looking !== undefined || how.reloading()) return
  looking = look($, conf.names, how)
    .catch(() => undefined)
    .finally(() => {
      looking = undefined
      // The reload this look held, and this session's own (it may be behind what was just installed), are asked again.
      how.done()
    })
}

/** One look, when one is due. */
async function look($: EngineInterface, names: readonly string[], how: LookWith): Promise<void> {
  const now = await $.clock.now()
  if (floorHolds(nextAt, now)) return
  const where = await place($)
  if (typeof where === 'string') return cantRun($, where)
  const last = await readState($, where.state)
  if (last === 'unreadable') {
    $.ui.log("self-update: no look now: its state file is there but can't be read.", { to: 'debug' })
    return
  }
  if (last !== undefined && !lookDue(last.at, now, last.unreached ?? 0)) {
    nextAt = last.at + lookEveryMs(last.unreached ?? 0)
    return
  }
  // An exit or a restart about to check this session for running processes: this moment is theirs, and the next looks.
  if (await pendingHere($, where)) {
    $.ui.log('self-update: no look now: an exit or a restart is pending in this session.', { to: 'debug' })
    return
  }
  // This process's own floor from here on, whatever happens to the files: never a fast loop.
  nextAt = now + lookEveryMs(last?.unreached ?? 0)
  const first = lockText(now)
  const took = await runLock($, where, first, TAKE_SCRIPT)
  const taken = took === undefined ? undefined : readTakeReply(took)
  if (taken !== 'taken') {
    $.ui.log(`self-update: no look now: ${taken === undefined ? "its lock couldn't be taken" : `another look holds its lock (taken ${Math.max(0, Math.round(taken.held.ageMs / 1000))} s ago)`}.`, { to: 'debug' })
    return
  }
  const held: Held = { text: first, at: now }
  try {
    await underLock($, where, names, now, how, held)
  } finally {
    if (held.text !== undefined) {
      const gave = await runLock($, where, held.text, RELEASE_SCRIPT)
      const said = gave === undefined ? undefined : readReleaseReply(gave)
      if (said === 'kept') $.ui.log('self-update: its lock had been taken over by another updater by the end of its look.', { to: 'debug' })
      else if (said !== 'released' && said !== 'gone') $.ui.log("self-update: its lock wasn't given back; it goes stale in 90 s.", { to: 'debug' })
    }
  }
}

/** The look itself, the lock held: the time read again and stamped, the commands (each under the lock taken again), what they installed, and the failures' count. */
async function underLock($: EngineInterface, where: Place, names: readonly string[], started: number, how: LookWith, held: Held): Promise<void> {
  // Read again under the lock: another session's look may have started since the first read.
  const state = await readState($, where.state)
  if (state === 'unreadable') {
    $.ui.log("self-update: no look now: its state file is there but can't be read.", { to: 'debug' })
    return
  }
  if (state !== undefined && !lookDue(state.at, started, state.unreached ?? 0)) return
  let kept: UpdateState = {
    at: started,
    fails: state?.fails ?? 0,
    told: state?.told === true,
    ...(state?.failed === undefined ? {} : { failed: state.failed }),
    ...(state?.unreached === undefined ? {} : { unreached: state.unreached }),
    ...(state?.installed === undefined ? {} : { installed: state.installed }),
  }
  // Stamped before any command: a look whose time can't be kept would be made again by every session.
  if (!(await write($, where.state, kept))) {
    $.ui.log("self-update: no look now: its state file couldn't be written.", { to: 'debug' })
    return
  }
  const before = installsOf((await read($, where.installed)) ?? '')
  if (before === undefined) {
    $.ui.log("self-update: no look now: Claude Code's install records can't be read.", { to: 'debug' })
    return
  }
  const plan = updatePlan(names, before, true)
  // A name that matches nothing installed (a misspelt one, say) would otherwise do nothing and say nothing: said once.
  for (const name of namesIdle(names, plan)) {
    if (saidIdle.has(name)) continue
    saidIdle.add(name)
    $.ui.log(`self-update: autoUpdate names ${name}, but no plugin from a marketplace of that name is installed on this machine in a scope it updates, so nothing is updated for it (a name is matched exactly, capitals included).`)
  }
  let failure: string | undefined
  /** The first refresh that failed, ran past its time or couldn't be started: this look didn't reach that marketplace (the one thing that stretches the wait to the next look). */
  let unreachedBy: string | undefined
  /** The look ended before its plan did, its counts left as they were: no claude, the lock lost, or an exit or a restart pending. */
  let stopped = false
  /** The marketplaces whose steps are over for this look: a refresh that failed, or a command whose time ran out. */
  const over = new Set<string>()
  for (const step of plan) {
    if (over.has(step.marketplace)) continue
    // A project's or a local record whose folder is gone: there is nowhere to run it from.
    if (step.kind === 'plugin' && step.folder !== undefined && (await existsSure($, step.folder)) !== true) continue
    // Before each command: an exit or a restart pending here takes this moment, and the lock is taken again, fresh.
    const halt = (await pendingHere($, where)) ? 'an exit or a restart is pending in this session' : await renew($, where, held)
    if (halt !== undefined) {
      $.ui.log(`self-update: the look stops before its next command: ${halt}.`, { to: 'debug' })
      stopped = true
      break
    }
    const ran = await runStep($, where, step)
    if (ran === 'no-claude') {
      noClaude($)
      stopped = true
      break
    }
    if (ran !== 'ok') {
      failure ??= ran.failed
      // Only a refresh's failure says a marketplace wasn't reached: a plugin's own update failing (a retired plugin's
      // record, a half-deleted worktree's) is recorded and said like any failure, and stretches nothing.
      if (step.kind === 'marketplace') unreachedBy ??= ran.failed
      // A marketplace whose refresh failed has nothing newer to install this time; one whose command ran out of time is left alone until the next look.
      if (step.kind === 'marketplace' || ran.ends) over.add(step.marketplace)
      $.ui.log(`self-update: ${ran.failed}; tried again at the next look.`, { to: 'debug' })
    }
    // After each command: a look under way reads as fresh to every other session, however long it takes.
    kept = { ...kept, at: await $.clock.now() }
    await write($, where.state, kept)
  }
  const after = installsOf((await read($, where.installed)) ?? '')
  const changes = after === undefined ? [] : installsChanged(names, before, after, true)
  const end = await $.clock.now()
  // A look that stopped short is no look's outcome: its counts stay as they were. What its commands installed is recorded all the same.
  const counted = stopped ? { fails: kept.fails, told: kept.told, failed: kept.failed, unreached: kept.unreached ?? 0, toast: undefined } : failuresNext(kept, failure, unreachedBy)
  await write($, where.state, {
    at: end,
    fails: counted.fails,
    told: counted.told,
    ...(counted.failed === undefined ? {} : { failed: counted.failed }),
    ...(counted.unreached > 0 ? { unreached: counted.unreached } : {}),
    ...(changes.length > 0 ? { installed: end } : kept.installed === undefined ? {} : { installed: kept.installed }),
  })
  // This process's floor, by what this look came to: one that reached every marketplace brings the five minutes back.
  nextAt = end + lookEveryMs(counted.unreached)
  const reloads = how.reloads()
  for (const change of changes) {
    const line = installedLine(change, reloads)
    $.ui.log(line)
    $.ui.toast(line)
  }
  if (counted.toast !== undefined) $.ui.toast(counted.toast)
}

/**
 * One command of a look, by UPDATE_SCRIPT: done; failed, as the record says it (the command's last line masked whole,
 * then cut), `ends` when its time ran out (the script ended it, the plugin's backstop gave up on the script, or the
 * script ended with no last line of its own), which ends its marketplace's steps for this look; or no claude can be
 * started here. A script that couldn't be started is a failure like any other, tried again at the next look.
 */
async function runStep($: EngineInterface, where: Place, step: Step): Promise<'ok' | 'no-claude' | { failed: string; ends: boolean }> {
  const ran = await runScript($, where.powershell, UPDATE_SCRIPT, stepEnv(step), COMMAND_MS, step.kind === 'plugin' && step.folder !== undefined ? step.folder : where.home)
  if (ran === 'not-started') return { failed: `${stepSaid(step)}: it couldn't be started`, ends: false }
  if (ran === 'timed-out') return { failed: `${stepSaid(step)}: its script gave no answer in ${COMMAND_MS / 1000} s`, ends: true }
  const reply = readStepReply(ran.stdout, ran.stderr, ran.exitCode)
  if (reply === 'no-claude') return reply
  if (reply === 'ended') return { failed: `${stepSaid(step)}: ${ENDED_SAID}`, ends: true }
  if (reply === 'inside') return { failed: `${stepSaid(step)}: ${INSIDE_SAID}`, ends: false }
  if (reply === 'refused') return { failed: `${stepSaid(step)}: its script refused the names`, ends: false }
  // No last line of its own: the script was cut off (the backstop can end it and still answer), so nothing more of this marketplace is tried in this look.
  if ('broken' in reply) return { failed: failureSaid(step, reply), ends: true }
  return reply.code === 0 ? 'ok' : { failed: failureSaid(step, { code: reply.code, line: maskedLine(reply.line, 200) }), ends: false }
}
