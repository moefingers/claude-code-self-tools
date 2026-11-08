# self-compact

Lets a session compact its own conversation at the break between two pieces of work, then carry on by itself. Part of [claude-code-self-tools](../../README.md).

## Tool

`compact_after_turn` (Claude sees `mcp__self-compact__compact_after_turn`):

- `keep` (required): what the summary must hold on to, such as open threads, decisions and where the session's notes are. It works like the text you type after `/compact`.
- `resume` (optional): the message that starts the session's next turn once it has compacted, naming the next piece of work and where its details are.

## How it behaves

- **The compaction runs as the turn ends.** Claude Code can't compact while a turn is running, so the call queues it. By default (`when: "between-turns"`) it compacts from the turn's end itself, ahead of anything queued meanwhile (a message you typed, a background task's notification), which then runs on the compacted conversation; nothing is lost. If a queued turn has started by then, it compacts at that turn's end.
- **Or once the session is idle** (`when: "idle"`): half a second after a turn ends, and only if no turn has started by then, so anything queued goes first. Under a steady stream of work and notifications that can be a long way off.
- **Only compacting can run between turns.** Claude Code queues a plugin's command (`/exit`, `/clear`, `/resume`, `/reload-plugins`, `/mcp`, `/rename`) behind anything waiting, at the lowest priority, so the other `_after_turn` tools run when the session is idle, and say so.
- **With `resume`, the session carries on.** Once compacted, it sends itself the `resume` message, which starts a new turn. If Claude Code skips the compaction, the message is still sent and says so. Without `resume`, the session waits for your next message.
- **One resume per compaction.** A resumed turn compacts again only if it calls the tool again.
- **An interrupted turn cancels it**, with a notice.
- **Subagents can't use it.** A subagent compacts on its own near its context limit; one that calls the tool is told to finish its piece and return its result instead.

## Update check

When Claude calls one of this plugin's tools, and the last check is 30 minutes old or there hasn't been one, the plugin checks whether a newer version is published. It fetches this plugin's `plugin.json` from the `main` branch of the repository its installed `plugin.json` names, [`plugins/self-compact/.claude-plugin/plugin.json`](https://raw.githubusercontent.com/moefingers/claude-code-self-tools/main/plugins/self-compact/.claude-plugin/plugin.json), and compares its `version` with the installed one.

- **A plain GET of a public file.** The plugin adds no headers, query or body, and sends nothing about you, the session or the machine. GitHub sees the request as it sees any web request: the address it comes from, the time, and the headers Claude Code sends on its own.
- **At most every 30 minutes.** The check's time and answer are kept in the plugin's own store, so a reload, or another session on this machine, uses that answer until it is 30 minutes old. Sessions that come due at the same moment each make their one request.
- **It never holds up the tool.** The check runs beside the call, which never waits on it. Offline, refused by policy, a 404, a rate limit, no answer within 5 seconds, or anything but a plain version such as `0.3.0` all mean no notice.
- **When a newer version is out**, a toast tells you, and the result of one of Claude's next calls ends with a line like this:

  > self-compact 0.2.3 is out of date (0.3.0 is published). To update, the person runs: claude plugin marketplace update claude-code-self-tools, then claude plugin update self-compact@claude-code-self-tools, then /reload-plugins in each open session (a new session loads the update on its own). Don't run these yourself unless the person asks.

  The line is fixed text. Only the two version numbers vary, and each must be three plain numbers. Nothing else from the fetched file reaches Claude. A session is told of each check once, and at most once every 30 minutes, not on every call, and the toast follows the same rule. A call carries only what an earlier check found: the call that starts a check doesn't wait for its answer.
- **Turn it off** with the plugin's `updateCheck` setting: `off` never checks. Set it in `/config`, or from your shell:

  ```
  echo '{"updateCheck":"off"}' | claude plugin configure self-compact@claude-code-self-tools --values-stdin
  ```

  which saves it in settings.json as `"pluginConfigs": { "self-compact@claude-code-self-tools": { "options": { "updateCheck": "off" } } }`. Nothing is checked while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, to any value, or for a subagent's call.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-compact@claude-code-self-tools
```

Pairs with [self-context](../self-context), whose `context_usage` tells the session how full the window is before it decides.
