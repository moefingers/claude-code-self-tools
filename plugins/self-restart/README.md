# self-restart

Lets a session restart itself on Windows. Once the current turn ends, it opens a new terminal window in the folder the session started in and exits; the new window resumes the same conversation (`claude --resume <id>`) once the old process has gone, and can start its first turn with a message the session left. It's useful after an account switch, a setting that takes effect at startup, or a plugin that won't reload. Part of [claude-code-self-tools](../../README.md).

## Tool

`restart_after_turn` (Claude sees `mcp__self-restart__restart_after_turn`):

- `reason` (required): why the session restarts. It is recorded in the transcript.
- `resume` (optional): the message that starts the session's first turn after the restart: what to check or do next.

## How it behaves

- **The restart waits for the turn to end.** The call queues it, and it starts once the turn ends with Claude's answer.
- **One new window, by a fixed path.** The plugin runs Windows PowerShell by its known path under the Windows folder (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`), with one fixed script whose only variable is the session's id, which must be a UUID. Nothing Claude passes reaches that script or its command line.
  - The script finds the session's own `claude.exe` above it.
  - It opens a new console window with `Start-Process`. When Windows Terminal is your default terminal, the window opens there.
  - That window waits for the old `claude.exe` to exit, then runs `claude --resume <id>` from your PATH, in the folder the session started in (where `--resume` finds it, even after the session moved into a worktree or another folder).
- **The session's own process.** Walking up from the launcher, a parent counts only while it is older than its child. A process that later took a gone parent's id is never mistaken for the session.
- **A resume that fails says so.** If Claude Code ends with an error, or within seconds of starting, the window shows `claude --resume <id>` and waits for Enter instead of closing on the message. A resumed session that ran and ended closes its window as a terminal does.
- **Never two copies of one session.** If the old process is still running after 10 minutes, the window says so and resumes nothing, because two copies would both write to one session. You can then run `claude --resume <id>` yourself.
- **The first prompt never goes on a command line.** `resume` waits in the plugin's own store under the session's id. The copy of this plugin in the resumed session sends it once, when that session starts. One older than 15 minutes is dropped.
- **Remote Control.** With "Enable Remote Control for all sessions" on, the resumed session connects again, under the same conversation. A copy started while the old one was still connected would leave Remote Control off, which is one more reason the window waits.
- **Everything else this process runs ends with it:** wake-ups and background tasks.
- **Not while subagents are running.** Their work would end with the process. The call is refused while a subagent is pending, running or waiting, and a restart queued earlier in the turn is cancelled if one has started by the time it would run.
- **No restart loop.** A session whose restart opened its window less than 2 minutes ago is refused another, at the call and again right before the launch.
- **Windows only, in a terminal.** Elsewhere nothing runs, and Claude is told on its next turn. A session in an app, an SDK host or a `-p` run is refused at the call.
- **It says when a step didn't work.** If the window doesn't open, nothing exits. If the exit doesn't run, the window keeps waiting for you to exit (`/exit`), up to 10 minutes.
- **An interrupted turn cancels it**, with a notice.
- **Subagents can't use it.** A subagent is told to finish its piece and return its result.

To end the session without a restart, see [self-exit](../self-exit). To pick up a plugin change without a restart, see [self-reload](../self-reload).

## Update check

When Claude calls this plugin's tool, and the last check is 30 minutes old or there hasn't been one, the plugin checks whether a newer version is published. It fetches this plugin's `plugin.json` from the `main` branch of the repository its installed `plugin.json` names, [`plugins/self-restart/.claude-plugin/plugin.json`](https://raw.githubusercontent.com/moefingers/claude-code-self-tools/main/plugins/self-restart/.claude-plugin/plugin.json), and compares its `version` with the installed one.

- **A plain GET of a public file.** The plugin adds no headers, query or body, and sends nothing about you, the session or the machine. GitHub sees the request as it sees any web request: the address it comes from, the time, and the headers Claude Code sends on its own.
- **At most every 30 minutes.** The check's time and answer are kept in the plugin's own store, so a reload, or another session on this machine, uses that answer until it is 30 minutes old. Sessions that come due at the same moment each make their one request.
- **It never holds up the tool.** The check runs beside the call, which never waits on it. Offline, refused by policy, a 404, a rate limit, no answer within 5 seconds, or anything but a plain version such as `0.2.0` all mean no notice.
- **When a newer version is out**, a toast tells you, and the result of one of Claude's next calls ends with a line like this:

  > self-restart 0.1.0 is out of date (0.2.0 is published). To update, the person runs: claude plugin marketplace update claude-code-self-tools, then claude plugin update self-restart@claude-code-self-tools, then /reload-plugins in each open session (a new session loads the update on its own). Don't run these yourself unless the person asks.

  The line is fixed text. Only the two version numbers vary, and each must be three plain numbers. Nothing else from the fetched file reaches Claude. A session is told of each check once, and at most once every 30 minutes, not on every call, and the toast follows the same rule. A call carries only what an earlier check found: the call that starts a check doesn't wait for its answer.
- **Turn it off** with the plugin's `updateCheck` setting: `off` never checks. Set it in `/config`, or from your shell:

  ```
  echo '{"updateCheck":"off"}' | claude plugin configure self-restart@claude-code-self-tools --values-stdin
  ```

  which saves it in settings.json as `"pluginConfigs": { "self-restart@claude-code-self-tools": { "options": { "updateCheck": "off" } } }`. Nothing is checked while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, to any value, or for a subagent's call.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-restart@claude-code-self-tools
```
