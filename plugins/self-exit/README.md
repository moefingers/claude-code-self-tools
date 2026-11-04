# self-exit

Lets a session end itself once the current turn ends, as `/exit` does, with a stated reason that is recorded in its transcript for whoever resumes it. Part of [claude-code-self-tools](../../README.md).

## Tool

`exit_after_turn` (Claude sees `mcp__self-exit__exit_after_turn`):

- `reason` (required): why the session ends, such as who asked for it or what is done.
- `note` (optional): for whoever resumes the session: what was left, and where its notes are.

## How it behaves

- **The exit waits for the turn to end.** A command can't run while a turn is running, so the call queues it, and it runs once the turn ends with Claude's answer.
- **The reason is logged.** Before `/exit` runs, the reason and the note go into the conversation as a row Claude reads when the session is resumed (`claude --resume`), and into a transcript line you see, which the debug log keeps too.
- **Everything the session runs ends with it.** That means Remote Control (your phone and browser lose the session), wake-ups and background tasks. The tool description says so.
- **Not while subagents are running.** Their work would end with the session. The call is refused while a subagent is pending, running or waiting, and an exit queued earlier in the turn is cancelled if one has started by the time it would run. Background tasks can't be seen this way.
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

  > self-exit 0.1.0 is out of date (0.2.0 is published). To update, the person runs: claude plugin marketplace update claude-code-self-tools, then claude plugin update self-exit@claude-code-self-tools, then /reload-plugins in each open session (a new session loads the update on its own). Don't run these yourself unless the person asks.

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
