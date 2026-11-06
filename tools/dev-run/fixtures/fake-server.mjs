// A stand-in for `next dev` in dev-run's tests: an HTTP server on the port it is given, answering
// {pid, port} and printing a Next-style request line for each request. With --grandchild it starts a
// child of its own first, so a test can see a tree kill reach it. Every copy ends by itself after two
// minutes, and a grandchild 5 s after its parent is gone, so a failing test leaves nothing running.
//
//   node fake-server.mjs <port> [--grandchild]
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const [port, ...flags] = process.argv.slice(2)
setTimeout(() => process.exit(0), 120_000).unref()

if (flags.includes('--sleeper')) {
  const later = () => setTimeout(() => process.exit(0), 5000)
  for (const event of ['end', 'error']) process.stdin.once(event, later)
  process.stdin.resume()
} else {
  if (flags.includes('--grandchild')) {
    const g = spawn(process.execPath, [fileURLToPath(import.meta.url), '0', '--sleeper'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    console.log(`grandchild ${g.pid}`)
  }
  const server = createServer((req, res) => {
    const t = Date.now()
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ pid: process.pid, port: Number(port) }))
    console.log(` ${req.method} ${req.url} 200 in ${Date.now() - t}ms`)
  })
  server.listen(Number(port), () => console.log(`fake dev server ready on ${port}, pid ${process.pid}`))
}
