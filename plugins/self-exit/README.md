# self-exit

Lets a session end itself once the current turn ends, as `/exit` does, with a stated reason that is recorded in its transcript for whoever resumes it. Part of [claude-code-self-tools](../../README.md).

## Tool

`exit_after_turn` (Claude sees `mcp__self-exit__exit_after_turn`):

- `reason` (required): why the session ends, such as who asked for it or what is done.
- `note` (optional): for whoever resumes the session: what was left, and where its notes are.

## How it behaves

- **Only at a finished break.** A session calls it once a piece of work is finished, never mid-merge, mid-push or mid-task: the same rule as compacting with [self-compact](../self-compact). The tool's description says so.
- **The exit waits for the turn to end.** A command can't run while a turn is running, so the call queues it, and it runs once the turn ends with Claude's answer.
- **The reason is logged.** Before `/exit` runs, the reason and the note go into the conversation as a row Claude reads when the session is resumed (`claude --resume`), and into a transcript line you see, which the debug log keeps too.
- **Remote Control and wake-ups end with it.** Your phone and browser lose the session. The tool description says so.
- **Nothing that would make `/exit` ask.** A queued `/exit` that meets a confirmation dialog waits there for you, so the plugin checks first, and refuses while anything stands, naming each with how to stop it. Claude stops them and calls again:
  - **a session cron** (from CronCreate, ScheduleWakeup or `/loop`), read with the built-in `CronList` tool through the same call the engine makes for Claude's own, and only after the permission check says `allow`, so it never opens a dialog; a durable one is named as such, since it survives the exit;
  - **a background job under the session**: a background Bash, PowerShell or Monitor job, a build, or a heavy-slot run, found by the probe of this session's processes (Windows only; the probe can't tell a Monitor's job from a Bash one, so both are a *background shell*);
  - **a subagent** that hasn't ended (anything but completed, failed or killed), whose work would end with the session. One pending, running or waiting is waited for; an idle teammate, or a status the plugin doesn't know, won't report on its own, so it says to stop it with TaskStop, or, if it is already gone, to run `/reload-plugins`.

  Each of these, alone, was seen to make a queued `/exit` stop at *Background work is running … 1. Exit and stop tasks / 2. Move to background and exit / 3. Stay* (Claude Code 2.1.318), and the plugin can't tell from `/exit`'s answer whether the dialog ended in an exit or a stay. `CronList` lists ScheduleWakeup and `/loop` jobs too; it answered in about 20 ms, mid-turn and from a timer at idle, and added no row to the transcript. Those checks ran in bypassPermissions mode: whether the permission check for `CronList` says `allow` in the default mode is untested, and where it doesn't, the exit is refused (*can't tell*), never queued into a dialog.

  Anything it can't read refuses too, saying *can't tell* and why: `CronList` whose permission would ask, or which fails; a probe that fails; agents that can't be listed. It checks at the call, so nothing is queued while anything stands, and again when the exit is armed, right before `/exit` runs. Off Windows there is no probe: crons and subagents are still read. A refusal reads, for a cron and for a background shell:

  > Not queued: cron 7f3a9c21 (Every 5 minutes: «check the deploy») is set to wake this session: delete it with CronDelete (id 7f3a9c21). Each would make /exit stop at its confirmation, or end with the session: stop them, then call again.

  > Not queued: the background shell bash.exe 4812 runs under this session (a background job of the Bash, PowerShell or Monitor tool): stop it with TaskStop (the task id its Bash, PowerShell or Monitor call gave), or let it finish. Each would make /exit stop at its confirmation, or end with the session: stop them, then call again.
- **The pending marker.** While the exit is queued or armed, the plugin keeps `%LOCALAPPDATA%\claude-self-tools\pending\<conversation>.json` as `{ "v": 1, "kind": "exit", "at": <milliseconds since the epoch> }`, written at the call and again when the exit is armed. Right before `/exit` runs, or when the exit is cancelled (a refusal when armed, an interrupted turn, a new turn), it overwrites it with `{ "v": 1, "done": true }`. The path takes the conversation's id only when it is a session id (a UUID); with any other id, or no plain `%LOCALAPPDATA%` (off Windows), nothing is written. It is a hint for the [coordinator](https://github.com/moefingers/agent-coordinator-3000), which holds its deliveries (broadcasts, answers, messages) while the marker says pending and is at most 15 minutes old (one dated more than a minute ahead reads as bad, so none holds forever), so that none starts a turn that cancels the exit; the shared machine code's `readPending` reads it as the coordinator does.
- **Only with a person at the prompt.** A `-p` run or an SDK host ends the session by itself, so the call is refused there.
- **It says when it didn't work.** If Claude Code refuses the exit, Claude is told on its next turn and the session goes on. If the session is still open a few seconds after `/exit` ran (you answered no to a dialog), a toast and a note say so.
- **An interrupted turn cancels it**, with a notice.
- **Subagents can't use it.** A subagent is told to finish its piece and return its result.

To restart rather than end the session, see [self-restart](../self-restart).

## Update check

When Claude calls this plugin's tool, and the last check is 30 minutes old or there hasn't been one, the plugin checks whether a newer version is published. It fetches this plugin's `plugin.json` from the `main` branch of the repository its installed `plugin.json` names, [`plugins/self-exit/.claude-plugin/plugin.json`](https://raw.githubusercontent.com/moefingers/claude-code-self-tools/main/plugins/self-exit/.claude-plugin/plugin.json), and compares its `version` with the installed one.

- **A plain GET of a public file.** The plugin adds no headers, query or body, and sends nothing about you, the session or the machine. GitHub sees the request as it sees any web request: the address it comes from, the time, and the headers Claude Code sends on its own.
- **At most every 30 minutes.** The check's time and answer are kept in the plugin's own store, so a reload, or another session on this machine, uses that answer until it is 30 minutes old. Sessions that come due at the same moment each make their one request.
- **It never holds up the tool.** The check runs beside the call, which never waits on it. Offline, refused by policy, a 404, a rate limit, no answer within 5 seconds, or anything but a plain version such as `0.2.0` all mean no notice.
- **When a newer version is out**, a toast tells you, and the result of one of Claude's next calls ends with a line like this:

  > self-exit 0.1.1 is out of date (0.2.0 is published). To update, the person runs: claude plugin marketplace update claude-code-self-tools, then claude plugin update self-exit@claude-code-self-tools, then /reload-plugins in each open session (a new session loads the update on its own). Don't run these yourself unless the person asks.

  The line is fixed text. Only the two version numbers vary, and each must be three plain numbers. Nothing else from the fetched file reaches Claude. A session is told of each check once, and at most once every 30 minutes, not on every call, and the toast follows the same rule. A call carries only what an earlier check found: the call that starts a check doesn't wait for its answer.
- **Turn it off** with the plugin's `updateCheck` setting: `off` never checks. Set it in `/config`, or from your shell:

  ```
  echo '{"updateCheck":"off"}' | claude plugin configure self-exit@claude-code-self-tools --values-stdin
  ```

  which saves it in settings.json as `"pluginConfigs": { "self-exit@claude-code-self-tools": { "options": { "updateCheck": "off" } } }`. Nothing is checked while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, to any value, or for a subagent's call.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-exit@claude-code-self-tools
```
