// Fixtures for self-switch's tests: a machine as the probe would report it, built at run time, and
// the decoder for the scripts the plugin runs. No real session, process or file is read: every id
// here was generated for these tests.
import { REGISTRY_KEYS, SLOT_SCRIPT_SHA256 } from '../hooks/machine'

/** This session's conversation. */
export const W = '3f6a2c1e-8b4d-4e9a-a7c2-5d1b9e0f4a6c'
/** The conversation it switches to. */
export const T = '9d2e7b4a-1c6f-4a3e-b8d5-0e7c2a9f1b3d'
/** A third conversation in the same project, for a switch on from an arrived one. */
export const X = '6f99096c-131e-42f4-ac89-702712ef1faf'
/** Another session's conversation, running in another pane. */
export const OTHER = 'c4b8e1d7-2a9f-4c6e-9b3a-7f0d5e2c8a1b'
/** The claim a window launch takes. */
export const LAUNCH = 'launch:5e1a9c3b-7d2f-4b8e-a6c4-1f9d3e7b2a5c'

/** The time the tests run at: milliseconds since the epoch. */
export const NOW = Date.UTC(2026, 10, 3, 12, 0, 0)
/**
 * A FILETIME some seconds after a fixed start, as the probe prints it: an exact decimal string.
 * FILETIMEs are 100-ns ticks, past 2^53, where a JavaScript number keeps multiples of 16 only; the
 * start isn't one, so neither is any time here. ft(1), the slot pane's, is 134062345678901240.
 */
export const ft = (seconds: number): string => String(BigInt('134062345668901240') + BigInt(seconds) * BigInt(10_000_000))

/** The folders: the repo both conversations share by default, and another project. */
export const REPO = 'C:\\work\\repo'
export const PROJECT = 'C--work-repo'
export const ELSEWHERE = 'C:\\work\\other'
export const ELSEWHERE_PROJECT = 'C--work-other'

export type RawProcess = { pid: number; ppid: number; created: string; name: string; cls?: string; ids?: string[]; cli?: true }
export type RawRegistry = { dir: number; file: number; ok: boolean; keys?: string[]; [key: string]: unknown }
export type RawProbe = {
  v: 1
  self: number
  session: { pid: number; created: string } | null
  slot: { pid: number; created: string; id: string; path: string; sha256: string | null; hashError?: string } | null
  slotSeen?: true
  procs: RawProcess[]
  registry: RawRegistry[]
  transcripts: { id: string; dir: number; project: string; mtime: number }[]
  locks: Record<string, unknown>[]
  claim: Record<string, unknown> | null
  heavy: { slot: string; winpid: number | null }[] | null
  freeKb: number | null
  errors: string[]
}

/**
 * A registry file of the shape Claude Code 2.1.318 writes: every key it was seen with, and the seven
 * values the probe copies. procStart is a string of digits, the FILETIME exact, as 2.1.318 writes it
 * (a number is still taken); version is Claude Code's version, a string.
 */
export const entry = (pid: number, sessionId: string, procStart: string | number, dir = 0): RawRegistry => ({
  dir,
  file: pid,
  ok: true,
  keys: [...REGISTRY_KEYS],
  pid,
  sessionId,
  procStart,
  status: 'idle',
  statusUpdatedAt: NOW - 60_000,
  kind: 'interactive',
  version: '2.1.318',
})

/**
 * The machine as the probe reports it, before any change a test makes:
 * - Windows Terminal (10) with two panes: PowerShell 20 running this session's claude.exe 100 (the
 *   conversation W), and PowerShell 21 running claude.exe 200 (the conversation OTHER);
 * - the probe itself, PowerShell 300 under claude.exe 100, and an MCP server's node 400 under it;
 * - the registry holds 100 and 200, of the verified shape;
 * - W's transcript and T's sit in one project folder; T's was last written an hour ago;
 * - the claim on T was taken by a launch, and the lock is the probe's own.
 */
export function machine(change?: (probe: RawProbe) => void): RawProbe {
  const probe: RawProbe = {
    v: 1,
    self: 300,
    session: { pid: 100, created: ft(2) },
    slot: null,
    procs: [
      { pid: 10, ppid: 1, created: ft(0), name: 'WindowsTerminal.exe' },
      { pid: 20, ppid: 10, created: ft(1), name: 'powershell.exe', cls: 'shell' },
      { pid: 100, ppid: 20, created: ft(2), name: 'claude.exe' },
      { pid: 21, ppid: 10, created: ft(1), name: 'powershell.exe', cls: 'shell' },
      { pid: 200, ppid: 21, created: ft(3), name: 'claude.exe' },
      { pid: 300, ppid: 100, created: ft(1000), name: 'powershell.exe', cls: 'shell' },
      { pid: 400, ppid: 100, created: ft(10), name: 'node.exe' },
    ],
    registry: [entry(100, W, ft(2)), entry(200, OTHER, ft(3))],
    transcripts: [
      { id: W, dir: 0, project: PROJECT, mtime: NOW - 30_000 },
      { id: T, dir: 0, project: PROJECT, mtime: NOW - 60 * 60_000 },
    ],
    locks: [{ id: T, mtime: NOW, ok: true, by: LAUNCH, pid: 100, created: ft(2), at: NOW, transport: 'window' }],
    claim: { id: T, taken: true, by: LAUNCH },
    heavy: null,
    freeKb: 4_500_000,
    errors: [],
  }
  change?.(probe)
  return probe
}

/**
 * The pane's parent as a slot runner whose script has the shipped hash; the claim then names it. With
 * `hashError`, the probe couldn't hash it, and says why.
 */
export function inSlot(probe: RawProbe, sha256: string | null = SLOT_SCRIPT_SHA256, hashError?: string): void {
  probe.slot = {
    pid: 20,
    created: ft(1),
    id: `20-${ft(1)}`,
    path: 'C:\\Users\\u\\AppData\\Local\\claude-self-tools\\claude-slot.ps1',
    sha256,
    ...(hashError === undefined ? {} : { hashError }),
  }
  if (sha256 === SLOT_SCRIPT_SHA256) {
    const by = `slot:20-${ft(1)}`
    probe.claim = { id: T, taken: true, by }
    probe.locks = [{ id: T, mtime: NOW, ok: true, by, pid: 100, created: ft(2), at: NOW, transport: 'slot' }]
  }
}

/** T's transcript in another project folder. */
export function elsewhere(probe: RawProbe): void {
  probe.transcripts = probe.transcripts.map(t => (t.id === T ? { ...t, project: ELSEWHERE_PROJECT } : t))
}

/** Adds a process under this session's claude.exe (or under `ppid`). */
export function under(probe: RawProbe, p: Omit<RawProcess, 'ppid'> & { ppid?: number }): void {
  probe.procs.push({ ppid: 100, ...p })
}

/** Base64 back to text, as PowerShell reads an -EncodedCommand: UTF-16LE. */
export function decode(encoded: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  const clean = encoded.replace(/=+$/, '')
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].reduce((acc, k) => (acc << 6) | Math.max(0, alphabet.indexOf(clean.charAt(i + k) || 'A')), 0)
    bytes.push((n >> 16) & 255, (n >> 8) & 255, n & 255)
  }
  const used = Math.floor((clean.length * 6) / 8)
  let out = ''
  for (let i = 0; i + 1 < used; i += 2) out += String.fromCharCode((bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8))
  return out
}

/** Every flag that would set a permission mode: none may appear in a script or an argv. */
export const PERMISSION_FLAGS = ['--permission-mode', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', 'bypassPermissions', 'acceptEdits']
