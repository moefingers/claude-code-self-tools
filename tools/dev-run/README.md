# dev-run

Runs one dev server for a Claude Code session on a shared Windows machine, in place of a `next dev` the session starts by hand. Several sessions share the machine, and `next dev` there grows until it runs the machine out of memory. dev-run applies one rule to every dev server: none runs more than 10 minutes without a restart, none starts without enough free memory, and none outlives its use.

Windows only. Node 24 or later; no dependencies.

```
node tools/dev-run/dev-run.mjs --name web-3271 --dir /path/to/project --port 3271 -- node node_modules/next/dist/bin/next dev -H 127.0.0.1 -p 3271
```

Everything after `--` is the server's command, run in `--dir` as an argument list, with no shell.

- **Finding the program:** every command is resolved to a full path before the spawn, so the spawn never searches a folder itself.
  - A bare name like `node`, `node.exe` or `pnpm` is looked up on PATH only (its absolute entries), never in `--dir`, so a `node.cmd` or `node.exe` in the project can't stand in for node.
  - A path like `node_modules/.bin/next.cmd` is taken from `--dir`.
  - A command that isn't found is refused.
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
| `--slot-script <path>` | found | `heavy-slot.sh`, which must exist. By default it is `$HEAVY_SLOT_SCRIPT`, a full Windows path such as `C:\path\to\heavy-slot.sh`. Otherwise it is the first one found in a folder above the outermost repository that holds `--dir`, or above `--dir` itself outside any repository. It is never one inside the served repository, which a project could carry or an old worktree keep. A worktree or submodule nested in another repository, as Claude Code's `.claude/worktrees` are, counts as inside that one. |
| `--hit <regex>` | Next's request line | A server output line that counts as a request: ` GET /path 200 in 12ms`. |
| `--compiled <regex>` | see below | A line that ends a start's first compile. |

## What it does

1. **Starts only at the floor.** Before every spawn, free physical memory must be at least the larger of `--floor-gb` and `--compile-floor-gb`. It polls every 15 s and logs each reading while it waits. Free memory is Windows' own available physical memory (`GlobalMemoryStatusEx`, through Node's `os.freemem()`), the same figure as `(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory`, without a PowerShell process every few seconds. It never reads MSYS's `/proc/meminfo`.
2. **Runs the command**, and records the root of its process tree.
3. **Watches memory** every 10 s. Under `--stop-gb`, it stops the server, logs why, and goes back to step 1.
4. **Restarts every `--restart-min`**: stops the server, waits up to 30 s for the port to be free, then starts again at the floor, with the same command on the same port. If the port is still held after 30 s, it logs the holders' pids and ends with 1, rather than start a second server beside them.
5. **Stops only what it started, by process id.** It never uses `taskkill /T` or a name. Windows keeps a dead parent's id on its orphans and never checks it, and a later process can take that id, so `/T` can take someone else's processes. dev-run stops in this order:
   - **The root:** through Node's own handle on it, so never a process that has taken its id. dev-run reads the root's real start time right after the spawn, while the root runs. If the root has ended by the time the read comes back, the time is dropped, because by then its id may be another process's. Nothing is then stopped by id, and what the root started is left to the port wait.
   - **What the root started:** from one process snapshot, walking down by parent id. A child counts only if it was created at or after its parent, the rule `shared/hooks/machine.ts` uses, so an older process carrying the id as its parent is an orphan of the id's earlier owner and is left alone. Once the root is gone, a child must also have been created before the root ended (dev-run notes the time) and before any later owner of its id started, so a process started under a reused id is left alone, even when that later owner has ended too.
   - **Deepest first, one at a time:** dev-run opens a handle on each process, checks its start time against the snapshot's again, and stops that same process through the handle (`Stop-Process`).

   Then it waits for the port to close.
6. **Stops for good when idle.** Each line matching `--hit` is a request. After `--idle-min` of server time with none, it stops the server and ends with 0, logging `idle: no request for 20 min of server time; stopping for good`. The first start counts as a request, and the idle clock stands still while the server is down, so restarts neither reset it nor run it out.
7. **Ctrl+C, Ctrl+Break, closing the console, or SIGTERM** stop the server tree, then the runner ends (130, 149, 129, 143).
8. **No orphan when the runner is killed outright.** No handler runs then, so a small guard process, started detached, holds a pipe from the runner. When the pipe ends with the server still up, the guard stops what's left of its tree. Node ends a child it spawned when it dies (a Windows job), so a Node server usually goes with the runner. A `.cmd` shim's `cmd.exe` goes too, but the server it started doesn't.
   - **What the guard is told:** the runner tells it the root's id at once, with the time just before the spawn, then the root's real start time once read, and the moment the root ended when it sees that. It sends `done` when it ends by itself. The guard takes an end only for the root it names, since a slow exit of an earlier root can come after a new spawn.
   - **When the pipe ends without `done`:** the guard stops what is left by the same walk as a stop. Its lower bound is the root's start time, or the time before the spawn if the runner died before reading it. Its upper bound is the root's end, since a dead root starts nothing: the moment the runner saw it end, or else the moment the pipe ended, plus 100 ms. The bound is exact even when the root died seconds before the runner.
   - **The status file:** the guard marks it `stopped` with the reason, even when no server was running.

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

- **`--slot` (`compile`, the default):** before each spawn, at the floor, dev-run claims a slot through `heavy-slot.sh` itself, and spawns once heavy-slot says it holds one. It releases the slot at the first line matching `--compiled`, or 3 minutes after the spawn, whichever comes first, or when the server stops before that. If memory fell under the floor while it waited for the slot, it gives the slot back and waits for the floor again.

  **What ends a first compile.** The default `--compiled` is read case-sensitively:
  - **Next 16:** it prints `○ Compiling / ...` while it compiles, and for a first compile no `Compiled` line at all, only the request line once the page answers: ` GET / 200 in 1.2s (compile: 1.1s, render: 120ms)`. So a request line with a 2xx status ends it.
  - **Not a 3xx.** A redirect, for example a proxy's 307 from `/` to `/login`, is answered before any page has compiled.
  - **Older Next (webpack):** it prints ` ✓ Compiled / in 3.1s`, and that line counts too, at the line's start. Middleware's, proxy's and instrumentation's lines don't, since they compile before the page.
  - **Not "Ready":** Next prints it once it listens, before it has compiled anything.
  - **Not other text:** neither a request for `/compiled` nor the app's own output saying "compiled" releases the slot early.
  - **A project that logs no requests** (`logging: { incomingRequests: false }` in `next.config`, or an `ignore` pattern matching its pages) prints no request line. Such a server holds the slot for the full 3 minutes at each start. Worse, `--hit` never matches either, so the idle exit comes 20 minutes into the server's time whatever its use. Give it a `--hit` that matches a line it does print, or keep request logging on.
- **`--slot=life`:** holds the slot from before each spawn until that server stops. Every restart gives it back and claims it again, so no hold outlasts `--restart-min`.
- **`--slot=off`:** no slot.

**How the claim works.** dev-run runs `bash heavy-slot.sh read -r DEV_RUN_HOLD`, with Git's bash (never `System32\bash.exe`, which is WSL) and a pipe as its input. heavy-slot queues it, waits and takes a slot as for any job, writes its owner file (the bash process, the time, `--dir`), prints `[heavy-slot] holding <slot>`, and runs `read`, which waits on the pipe. To release, dev-run ends the pipe: `read` returns and heavy-slot's own exit trap removes the slot. A claim still in the queue is ended like a server: bash through Node's handle, then what it started, by the same walk. heavy-slot drops a ticket whose holder is gone. If the runner is killed, the claim's bash dies with it, and heavy-slot reclaims a slot whose holder is gone the next time a job looks for one. `.gate-cap` applies as to any job: at 0, a server waits in `waiting` with `lastReason` `waiting for a heavy slot`. heavy-slot's lines are copied to the runner's log.

**What it costs.** A server held to its compile takes a slot for seconds when someone requests a page soon after it starts. If nobody requests one, it holds the slot for the full 3 minutes, at each start and each restart. A slot held for a compile is one fewer for commits and builds, and two servers compiling at once fill both.

**Recommendation.** Keep the default. Compiles are the bursts that ran the machine out of memory, and the slot puts them in the same queue as builds and commits, under the same cap. After a start, request the page you will work on (`curl http://localhost:<port>/<page>`), so the slot is given back as soon as it compiles, not 3 minutes later. Use `--slot=life` only for a short run that must not share the machine. It takes one of two slots for up to 10 minutes at a time, and two such servers would hold every commit until a restart. Use `--slot=off` only where no heavy-slot.sh exists. The memory floors work without slots: under 4 GiB free, which is also the default floor heavy-slot waits for, the server stops and makes room. It starts again only at 9.

## Tests

```
node --test tools/dev-run/dev-run.test.mjs
```

The tests run dev-run against a fake server (`fixtures/fake-server.mjs`, a small HTTP server that prints Next-style request lines and starts a detached child of its own), with the memory reader, the clock and the slot claim injected. The clock moves only when the runner sleeps, and stands still while a server starts or answers, so the suite takes about 100 seconds, mostly PowerShell reading the process table. They cover:

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
- a root that ends while its start time is read, in a run and in a queued slot claim: no time is kept, and nothing is stopped by id;
- a dead root whose id a later process took, started a child under, and gave up: that child is left alone;
- the guard of a runner whose root died seconds before it: on a made-up table, nothing a later owner of the root's id started is taken, and an end reported for an earlier root is ignored;
- `--stop-only` files that refuse (missing, a folder, malformed, a device) and one that allows, and a refusal reported as one;
- the guard of a runner killed before it read the root's start time: the server behind a shim is stopped, and the status says `stopped`;
- the slot taken before the spawn and released at the first compiled line or after 3 minutes;
- `--slot=life`;
- the compile floor;
- a claim through the real `heavy-slot.sh`, in a slot folder of its own, so it never takes one of the machine's slots.

Planted faults are each run through the same scenarios, which must fail, each on the check meant for it:

- a restart that doesn't wait for the port;
- the stop floor ignored;
- an idle clock reset at each start;
- a kill by name;
- a walk that takes an orphan older than its parent (on the made-up table, and live);
- a start time kept though it was read after the root ended (in a run, and in a queued claim);
- a dead root's walk with no bound at its end;
- a slot-script walk that stops at the innermost repository;
- a guard that ignores a root whose start time it wasn't told;
- a guard that ignores the root's end the runner saw, and bounds by the pipe's end alone;
- a slot never released;
- a slot released before the compile.

Each fault is a copy of `dev-run.mjs` with one line changed.

**What a test may stop.** Every test hands dev-run an exec that works as an allow-list. It runs only these:
- the process-table snapshot;
- `netstat -ano`;
- a start-time read of a process the test started;
- dev-run's exact stop script, when every target is a process the test started or one descended from it.

Descent is checked apart from dev-run's own walk: up from each target, in the snapshot dev-run read, each parent no younger than its child, to a process the test started and timed while holding its handle. Anything else is refused, and a stopped process is dropped from the list.

The CLI test runs the runner and its guard as processes of their own, so it uses `--stop-only <file>`, a flag for tests only and left out of the usage text.
- **What it does:** it confines every stop, the runner's and its guard's (the runner passes it on), to the processes listed in the file, one `<pid> <start time>` per line. It can only narrow what is stopped.
- **Bad files refuse:** a missing, unreadable or malformed file refuses every stop, and so does anything that isn't a regular file, which is never read (a device or a pipe could block). A refused stop is logged, and reported in the status, as refused.
- **A flag, not an environment variable,** so nothing inherited from the environment can switch off tree stops.
