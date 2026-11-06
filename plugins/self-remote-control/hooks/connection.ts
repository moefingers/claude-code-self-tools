// This session's Remote Control as the plugin reads and runs it, for the tool (register.ts) and for
// the reconnect after a login change (relogin.ts) alike.
import type { EngineInterface } from 'claude-code'

const title = { plugin: 'self-remote-control', key: 'title' } as const

/** The remote-control command's description while this session is connected, and while it is not. */
export const CONNECTED = 'Disconnect Remote Control'
export const NOT_CONNECTED = 'Control this session from your phone or claude.ai/code'

/** Whether this session's Remote Control is connected, from the remote-control command's description. */
export type Reading =
  | { state: 'connected' | 'not connected' }
  | { state: 'unavailable' }
  | { state: 'unknown'; description: string }

/** Why a call was refused, as one line. */
export function why(err: unknown): string {
  const said = (err instanceof Error ? err.message : String(err)).trim()
  return said === '' ? 'no reason given' : said
}

/** Whether this session's Remote Control is connected, from the remote-control command's description. */
export async function read($: EngineInterface): Promise<Reading> {
  const command = (await $.command.list()).find(c => c.name === 'remote-control' && c.source === 'builtin')
  if (command === undefined) return { state: 'unavailable' }
  if (command.description === CONNECTED) return { state: 'connected' }
  if (command.description === NOT_CONNECTED) return { state: 'not connected' }
  return { state: 'unknown', description: command.description }
}

/** `read`, a failed read taken as unknown. */
export async function readNow($: EngineInterface): Promise<Reading> {
  try {
    return await read($)
  } catch (err) {
    return { state: 'unknown', description: `no reading: ${why(err)}` }
  }
}

/** Runs the remote-control command, titled `name` when there is one. */
export function runRemoteControl($: EngineInterface, name: string | undefined) {
  return $.command.run(name === undefined ? { command: 'remote-control' } : { command: 'remote-control', args: name })
}

/** The session's custom title as last carried, or undefined when it has none or none was read. */
export async function sessionTitle($: EngineInterface): Promise<string | undefined> {
  return (await $.state.get(title)).value ?? undefined
}
