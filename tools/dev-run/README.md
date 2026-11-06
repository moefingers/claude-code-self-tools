# dev-run

Runs one dev server for a Claude Code session on a shared Windows machine, in place of a `next dev` the session starts by hand. Several sessions share the machine, and `next dev` there grows until it runs the machine out of memory. dev-run applies one rule to every dev server: none runs more than 10 minutes without a restart, none starts without enough free memory, and none outlives its use.

Windows only. Node 24 or later; no dependencies.

```
node tools/dev-run/dev-run.mjs --name web-3271 --dir /path/to/project --port 3271 -- node node_modules/next/dist/bin/next dev -H 127.0.0.1 -p 3271
```

Everything after `--` is the server's command, run in `--dir` as an argument list, with no shell.

- **Finding the program:** a bare name like `node` or `pnpm` is looked up on PATH only, never in `--dir`, so a `node.cmd` in the project can't stand in for node. A path like `node_modules/.bin/next.cmd` is taken from `--dir`.
- **Call the program itself where you can** (`node node_modules/next/dist/bin/next dev`). A `.cmd` shim such as `pnpm` works too, through `cmd.exe /d /s /c`, but an argument with a character `cmd.exe` would read (`" % ! ^ & | < >`) is refused.
- **Listen on 127.0.0.1** (`-H 127.0.0.1`): `next dev` listens on every interface by default, and a request from another machine on the network would count as activity and keep the server from its idle exit.
- **The port:** the command must listen on `--port`. dev-run watches that port, and doesn't set it.

| Option | Default | |
| :- | :- | :- |
| `--name <label>` | | `^[a-z0-9][a-z0-9-]{0,39}$`. Names the log and the status file; one runner per name. |
| `--dir <folder>` | | The project folder. |
| `--port <n>` | | The port the server listens on. |
| `--restart-min <n>` | 10 | Restart every n minutes. At most 10. |
| `--idle-min <n>` | 20 | Stop for good after n minutes of server time with no request. |
| `--floor-gb <n>` | 6 | GiB free to start or restart at. |
| `--compile-floor-gb <n>` | 9 | GiB free before each start's first compile. The larger of the two floors applies before every spawn. |
| `--stop-gb <n>` | 4 | Stop the server when free memory falls under n GiB, then wait for the floor again. |
| `--slot[=compile\|life\|off]` | `compile` | Claim a heavy-slot slot for each start's first compile, for each whole run, or not at all. See [Heavy slots](#heavy-slots). |
| `--slot-script <path>` | found | `heavy-slot.sh`. By default `$HEAVY_SLOT_SCRIPT`, else the first one in a folder above the repository that holds `--dir` (or above `--dir`, outside a repository). Never one inside the served repository, which a project could carry, or an old worktree keep. |
| `--hit <regex>` | Next's request line | A server output line that counts as a request: ` GET /path 200 in 12ms`. |
| `--compiled <regex>` | see below | A line that ends a start's first compile. |

## What it does

1. **Starts only at the floor.** Before every spawn, free physical memory must be at least the larger of `--floor-gb` and `--compile-floor-gb`. It polls every 15 s and logs each reading while it waits. Free memory is Windows' own available physical memory (`GlobalMemoryStatusEx`, through Node's `os.freemem()`), the same figure as `(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory`, without a PowerShell process every few seconds. It never reads MSYS's `/proc/meminfo`.
2. **Runs the command**, and records the root of its process tree.
3. **Watches memory** every 10 s. Under `--stop-gb`, it stops the server, logs why, and goes back to step 1.
4. **Restarts every `--restart-min`**: stops the server, waits up to 30 s for the port to be free, then starts again at the floor, with the same command on the same port. If the port is still held after 30 s, it logs the holders' pids and ends with 1, rather than start a second server beside them.
5. **Stops only what it started, by process id.** It never uses `taskkill /T` or a name. Windows keeps a dead parent's id on its orphans and never checks it, and a later process can take that id, so `/T` can take someone else's processes. dev-run stops in this order:
   - **The root:** through Node's own handle on it, so never a process that has taken its id. dev-run reads the root's real start time right after the spawn, while the root runs.
   - **What the root started:** from one process snapshot, walking down by parent id. A child counts only if it was created at or after its parent, the rule `shared/hooks/machine.ts` uses, so an older process carrying the id as its parent is an orphan of the id's earlier owner and is left alone. If the root's id has already been taken, that newer process's children are left alone too.
   - **Deepest first, one at a time:** dev-run opens a handle on each process, checks its start time against the snapshot's again, and stops that same process through the handle (`Stop-Process`).

   Then it waits for the port to close.
6. **Stops for good when idle.** Each line matching `--hit` is a request. After `--idle-min` of server time with none, it stops the server and ends with 0, logging `idle: no request for 20 min of server time; stopping for good`. The first start counts as a request, and the idle clock stands still while the server is down, so restarts neither reset it nor run it out.
7. **Ctrl+C, Ctrl+Break, closing the console, or SIGTERM** stop the server tree, then the runner ends (130, 149, 129, 143).
8. **No orphan when the runner is killed outright.** No handler runs then, so a small guard process, started detached, holds a pipe from the runner. When the pipe ends with the server still up, the guard stops what's left of its tree. Node ends a child it spawned when it dies (a Windows job), so a Node server usually goes with the runner. A `.cmd` shim's `cmd.exe` goes too, but the server it started doesn't. The runner gives the guard the root's id and real start time once it has read them, about a second after each spawn. The guard stops the root if it still runs, then what it started, by the same walk as a stop. A runner killed in that first second leaves the guard nothing to go on.

The server's output goes to a file, never to a pipe to the runner. A Node server whose output pipe breaks dies at once, and its workers would keep the port. dev-run reads the file every 100 ms and copies each line to its own output.

The runner also refuses to start under a name whose runner is still alive, and when the port is already held by someone else (after 30 s).

## Files

Under `%LOCALAPPDATA%\claude-self-tools\dev-run\`:

- `<name>.log`: what the runner did, one timestamped line each. It records every start, stop and restart, each with why, the memory readings (every wait poll, each start, then one a minute), the heavy slot claimed and released, the idle exit, the guard's work and errors. Moved to `.log.1` past 1 MiB.
- `<name>.json`: the status, written atomically (a temporary file renamed over it), at every change. Other sessions read who runs what here.

  ```json
  { "v": 1, "name": "web-3271", "dir": "...", "port": 3271, "pid": 12345, "state": "running",
    "startedAt": 1793940734740, "lastHitAt": 1793940790000, "restarts": 2,
    "lastReason": "scheduled restart after 10 min", "slot": null, "runnerPid": 12000, "at": 1793940800000 }
  ```

  `state` is `waiting` (for memory or a slot), `running`, `restarting` or `stopped`. `pid` is the server's root, or null. Times are milliseconds since 1970. `slot` names the heavy slot held (`.gate-lock`, `.gate-lock-2`), or null. `runnerPid` is the runner.
- `<name>.out`: the server's own output, appended across restarts, moved to `.out.1` past 5 MiB.

## Heavy slots

`heavy-slot.sh` lets at most two heavy jobs (commits, builds, tests) run on the machine at once. Each takes a slot directory first, in turn, and once free memory allows. Its own notes leave long-lived `next dev` out. A dev server's heavy moment is its first compile, which takes several GiB at once. Its first page compiles only when that page is first requested.

- **`--slot` (`compile`, the default):** before each spawn, at the floor, dev-run claims a slot through `heavy-slot.sh` itself, and spawns once heavy-slot says it holds one. It releases the slot at the first line matching `--compiled`, or 3 minutes after the spawn, whichever comes first, or when the server stops before that. The default `--compiled`, read case-sensitively, is a request line with a 2xx or 3xx status, or Next's own ` ✓ Compiled …` line, at the line's start, other than middleware's, proxy's or instrumentation's, which compile before the page. So neither a request for `/compiled` nor the app's own output saying "compiled" releases the slot early. Next's `Ready` line doesn't count: Next prints it once it listens, before it has compiled anything. If memory fell under the floor while it waited for the slot, it gives the slot back and waits for the floor again.
- **`--slot=life`:** holds the slot from before each spawn until that server stops. Every restart gives it back and claims it again, so no hold outlasts `--restart-min`.
- **`--slot=off`:** no slot.

**How the claim works.** dev-run runs `bash heavy-slot.sh read -r DEV_RUN_HOLD`, with Git's bash (never `System32\bash.exe`, which is WSL) and a pipe as its input. heavy-slot queues it, waits and takes a slot as for any job, writes its owner file (the bash process, the time, `--dir`), prints `[heavy-slot] holding <slot>`, and runs `read`, which waits on the pipe. To release, dev-run ends the pipe: `read` returns and heavy-slot's own exit trap removes the slot. A claim still in the queue is ended like a server: bash through Node's handle, then what it started, by the same walk. heavy-slot drops a ticket whose holder is gone. If the runner is killed, the claim's bash dies with it, and heavy-slot reclaims a slot whose holder is gone the next time a job looks for one. `.gate-cap` applies as to any job: at 0, a server waits in `waiting` with `lastReason` `waiting for a heavy slot`. heavy-slot's lines are copied to the runner's log.

**What it costs.** A server held to its compile takes a slot for seconds when someone requests a page soon after it starts. If nobody requests one, it holds the slot for the full 3 minutes, at each start and each restart. A slot held for a compile is one fewer for commits and builds, and two servers compiling at once fill both.

**Recommendation.** Keep the default. Compiles are the bursts that ran the machine out of memory, and the slot puts them in the same queue as builds and commits, under the same cap. After a start, request the page you will work on (`curl http://localhost:<port>/<page>`), so the slot is given back as soon as it compiles, not 3 minutes later. Use `--slot=life` only for a short run that must not share the machine. It takes one of two slots for up to 10 minutes at a time, and two such servers would hold every commit until a restart. Use `--slot=off` only where no heavy-slot.sh exists. The memory floors work without slots: under 4 GiB free, which is also the default floor heavy-slot waits for, the server stops and makes room. It starts again only at 9.

## Tests

```
node --test tools/dev-run/dev-run.test.mjs
```

The tests run dev-run against a fake server (`fixtures/fake-server.mjs`, a small HTTP server that prints Next-style request lines and starts a detached child of its own), with the memory reader, the clock and the slot claim injected. The clock moves only when the runner sleeps, and stands still while a server starts or answers, so the suite takes about 75 seconds, mostly PowerShell reading the process table. They cover:

- restarts every 10 minutes on the same port, once the port is free;
- the stop under the stop floor, then the wait for the floor;
- the idle exit, across restarts;
- killing only its own tree, by PID, with a second server left running;
- the tree walk on a made-up process table, where an orphan older than the root carries the root's id as its parent;
- the walk on live, harmless processes (`fixtures/sleeper.mjs`): it stops exactly the tree it started, deepest first, and leaves an older process and a real orphan alone;
- the status file's states;
- name validation;
- Ctrl+C;
- a runner killed outright behind a `.cmd` shim, cleaned up by its guard;
- the slot taken before the spawn and released at the first compiled line or after 3 minutes;
- `--slot=life`;
- the compile floor;
- a claim through the real `heavy-slot.sh`, in a slot folder of its own, so it never takes one of the machine's slots.

Seven planted faults are each run through the same scenarios, which must fail, each on the check meant for it:

- a restart that doesn't wait for the port;
- the stop floor ignored;
- an idle clock reset at each start;
- a kill by name;
- a walk that takes an orphan older than its parent (on the made-up table, and live);
- a slot never released;
- a slot released before the compile.

Each fault is a copy of `dev-run.mjs` with one line changed. A test's stop script runs only when it is exactly dev-run's by-id script, and every process it names is one that test started.
