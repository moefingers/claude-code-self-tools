// The shared partner code (hooks/classic.ts) on a stand-in engine, where its order matters most: two looks for one
// move, and a start whose id reads another conversation first.
//
// Canonical copy: shared/tests/classic.test.ts. It is copied, identical, to the plugins named on the next
// line, each at tests/classic.test.ts; `node scripts/sync-shared.mjs` writes them. Edit this copy only.
// Copies: self-check, self-color, self-reload, self-remote-control, self-restart, self-switch, self-wake
import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { type ClassicIo, configureClassic, type Move, moveBegins, moveLook, movePending } from '../hooks/classic'

const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'

/** A stand-in for the engine: `$.session.id()` answers when the test says, the clock stands still, timers never fire. */
function stand() {
  const reads: Array<(id: string) => void> = []
  const engine = {
    session: { id: () => new Promise<string>(resolve => reads.push(resolve)) },
    clock: {
      now: async () => 0,
      after: () => ({ cancel: () => undefined }),
      every: () => ({ cancel: () => undefined }),
    },
  }
  const kept = new Map<string, unknown>()
  const io: ClassicIo = {
    get: async key => kept.get(key),
    set: async (key, value) => void kept.set(key, value),
  }
  return { $: engine as unknown as EngineInterface, io, reads, kept }
}

/** Lets every promise ready now run. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

test('two looks for one move: the one that loses settles only once the winner has taken the move up', async () => {
  configureClassic()
  const { $, io, reads, kept } = stand()
  const taken: Move[] = []
  let release: () => void = () => undefined
  const take = async (move: Move): Promise<void> => {
    taken.push(move)
    await new Promise<void>(resolve => (release = resolve))
  }
  // A guarded process (no classic hook): a /resume ends A, and the move is looked for.
  expect(await moveBegins($, io, { reason: 'resume', sessionId: A }, take)).toEqual({ from: A, reason: 'resume' })
  expect(movePending()).toBe(true)
  // Two looks in flight at once (a timer of the plugin's and the look's own tick), each awaiting the id.
  let firstDone = false
  let secondDone = false
  void moveLook($, io, take).then(() => (firstDone = true))
  void moveLook($, io, take).then(() => (secondDone = true))
  await flush()
  expect(reads).toHaveLength(2)
  reads[0]?.(B)
  reads[1]?.(B)
  await flush()
  // The winner is taking the move up; the loser waits for it, though the move reads as no longer pending.
  expect(taken).toEqual([{ from: A, to: B, reason: 'resume' }])
  expect(kept.get('started')).toBe(B)
  expect(movePending()).toBe(false)
  expect(firstDone).toBe(false)
  expect(secondDone).toBe(false)
  release()
  await flush()
  expect(firstDone).toBe(true)
  expect(secondDone).toBe(true)
  expect(taken).toHaveLength(1)
})

test('a look that reads the conversation left takes nothing, and the move stays pending', async () => {
  configureClassic()
  const { $, io, reads } = stand()
  const taken: Move[] = []
  await moveBegins($, io, { reason: 'clear', sessionId: A }, async move => void taken.push(move))
  const look = moveLook($, io, async move => void taken.push(move))
  await flush()
  reads[0]?.(A)
  await look
  expect(taken).toEqual([])
  expect(movePending()).toBe(true)
})
