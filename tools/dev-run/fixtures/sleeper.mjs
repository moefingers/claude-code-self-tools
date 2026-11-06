// A harmless process for dev-run's live tree check. `node sleeper.mjs <depth>` prints
// "sleeper <pid> <parent pid>" and, with depth over 0, starts a copy of itself one level down,
// detached, so Node's job doesn't end it with its parent. Each copy ends 20 s after its parent is
// gone (its input closes), or after two minutes.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const depth = Number(process.argv[2] ?? 0)
setTimeout(() => process.exit(0), 120_000).unref()
console.log(`sleeper ${process.pid} ${process.ppid}`)
if (depth > 0) spawn(process.execPath, [fileURLToPath(import.meta.url), String(depth - 1)], { detached: true, stdio: ['pipe', 'inherit', 'ignore'], windowsHide: true })
const later = () => setTimeout(() => process.exit(0), 20_000)
for (const event of ['end', 'error']) process.stdin.once(event, later)
process.stdin.resume()
