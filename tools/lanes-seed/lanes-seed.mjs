#!/usr/bin/env node
// lanes-seed: proposes a lanes.json (D65) from a session inventory, and prints it. It never writes a
// file: the proposal is applied by hand, once checked (copy it to <config folder>\lanes.json, or have the
// coordinator plugin write its entries with lanesUpdateScript).
//
//   node tools/lanes-seed/lanes-seed.mjs --csv <inventory.csv> [--ws <workspace id>] [--home <name>=<window>]... [--at <ms>]
//
// The inventory is system-overhaul's (scratchpad sessions\inventory.csv): one row per conversation on
// disk, the canonical conversation of each session name marked in its `lane` column. Each marked row
// becomes one entry, by that name: `session` its session_id, `folder` its folder, `ws` the workspace
// (`default` unless --ws), `tab` its name, and `window` its home window when it has one. The homes (Mo,
// 2026-11-06) are the defaults below; --home overrides or adds one, `--home name=` removes it. A name
// without a home has no window: it goes anywhere. Every entry is checked by the machine code's
// laneEntry, as readLanes reads it; a row that fails is left out and said on standard error, as is a
// name marked twice (the first kept). It reads no transcript, and nothing but the CSV given.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const machine = await import(pathToFileURL(join(ROOT, 'shared', 'hooks', 'machine.ts')).href)

/** Mo's four windows (2026-11-06): window 1 the coordinator's and the merger's; 2 video-lab; 3 three lanes; 4 overflow. */
export const HOMES = {
  'agent-coordinator-3000': 'claude-1',
  'system-overhaul': 'claude-1',
  'video-lab': 'claude-2',
  'olivia-work': 'claude-3',
  'ui-general': 'claude-3',
  'package-bumper': 'claude-3',
}

/** A CSV's rows (RFC 4180: quoted fields, doubled quotes, line breaks inside quotes), the first row the header. */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  const body = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        field += '"'
        i += 1
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && body[i + 1] === '\n') i += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  const [header = [], ...data] = rows
  return data.filter(r => r.length > 1 || r[0] !== '').map(r => Object.fromEntries(header.map((name, i) => [name, r[i] ?? ''])))
}

/** The proposal: `{ file, skipped }`, `file` lanes.json's object, `skipped` one line per row left out and why. */
export function propose(rows, { ws = 'default', homes = HOMES, at = Date.now() } = {}) {
  const lanes = {}
  const skipped = []
  for (const row of rows) {
    const name = (row.lane ?? '').trim()
    if (name === '') continue
    if (name in lanes) {
      skipped.push(`${name}: marked twice; kept ${lanes[name].session}, left out ${row.session_id}`)
      continue
    }
    const window = homes[name]
    const raw = { session: row.session_id, folder: row.folder, ...(window ? { window } : {}), tab: name, ws, at }
    const entry = machine.laneEntry(name, raw)
    if (entry === undefined) {
      skipped.push(`${name}: not an entry lanes.json takes (${JSON.stringify(raw)})`)
      continue
    }
    lanes[name] = entry
  }
  return { file: { v: 1, at, lanes }, skipped }
}

/** The arguments: --csv, --ws, --home (repeated), --at. */
export function parseArgs(argv) {
  const out = { homes: { ...HOMES } }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--csv' && value !== undefined) out.csv = value
    else if (flag === '--ws' && value !== undefined) out.ws = value
    else if (flag === '--at' && value !== undefined) out.at = Number(value)
    else if (flag === '--home' && value !== undefined && value.includes('=')) {
      const [name, window] = [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]
      if (window === '') delete out.homes[name]
      else out.homes[name] = window
    } else throw new Error(`not an argument this takes: ${flag}`)
    i += 1
  }
  if (out.csv === undefined) throw new Error('--csv <inventory.csv> is needed')
  return out
}

// Run as a command only: never when a test loads this file.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && !process.env.NODE_TEST_CONTEXT) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const { file, skipped } = propose(parseCsv(readFileSync(args.csv, 'utf8')), { ...(args.ws ? { ws: args.ws } : {}), homes: args.homes, ...(args.at ? { at: args.at } : {}) })
    for (const line of skipped) console.error(`left out: ${line}`)
    // The proposal, never written: check it, then apply it by hand.
    console.log(JSON.stringify(file, null, 2))
  } catch (err) {
    console.error(`lanes-seed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
