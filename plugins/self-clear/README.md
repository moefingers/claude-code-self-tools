# self-clear

Lets a session clear its own conversation, as `/clear` does, and start the next piece from a handoff it writes; only when its work is complete or its context is contaminated. Part of [claude-code-self-tools](../../README.md).

## Tool

`clear_after_turn` (Claude sees `mcp__self-clear__clear_after_turn`):

- `why` (required): `complete` (the work is done, and its notes are written down) or `contaminated` (what the context holds misleads the work). Nothing else clears.
- `handoff` (required): the first prompt of the cleared conversation, which knows nothing else. It should say what the next piece of work is, where its notes are, and anything not to redo.

## How it behaves

- **Compact or restart first.** Over long, interconnected work, a session remembers the overall story and how its piece fits in, and a clear loses that. [self-compact](../self-compact) keeps a session's context healthy with a summary, and [self-restart](../self-restart) gives a fresh process in the same conversation. So `why` is required, and must be `complete` or `contaminated`, exactly. Anything else, or none, is refused at the call, and nothing is queued:

  > A clear loses this session's memory of the whole story. Compact instead (compact_after_turn), or restart into the same conversation (restart_after_turn). Clear only when the work is complete (why: 'complete') or the context is contaminated (why: 'contaminated'), with the notes named in handoff.

  The tool's description leads with compacting and restarting, and names the two reasons.
- **It's irreversible.** A clear keeps nothing of the conversation but `handoff`, so the tool asks Claude to write its notes down first (memory, files, the PR) and to say where they are.
- **Why is recorded.** Right before `/clear` runs, a leaving row, the conversation's last, says why it was cleared and what the handoff was: *This conversation was cleared at its own request (clear_after_turn), because its work is complete (why: complete). The cleared conversation starts from the handoff: …*. The toast says why too.
- **The clear waits for the turn to end.** A command can't run while a turn is running, so the call queues it, and it runs once the turn ends with Claude's answer.
- **The handoff starts the next turn.** Once cleared, the session sends itself "Context cleared at your own request (clear_after_turn). Handoff: …", which starts a turn of its own. If Claude Code drops that prompt, the handoff is kept as a note Claude reads with your next message.
- **It checks that the clear took.** A `/clear` starts a conversation under a new session id. If the id hasn't changed (you answered no to a dialog, or a hook refused it), the conversation is as it was, the handoff isn't sent, and Claude is told on its next turn. A clear Claude Code refuses is told the same way.
- **Not while subagents are running.** Their results would come back to a conversation that no longer knows why it asked. The call is refused while a subagent is pending, running or waiting, and a clear queued earlier in the turn is cancelled if one has started by the time it would run. Background tasks can't be seen this way; the tool asks Claude to let them finish.
- **An interrupted turn cancels it**, with a notice.
- **Subagents can't use it.** A subagent is told to finish its piece and return its result.

Your plugins, their tools and their timers carry on through a clear: Claude Code doesn't restart plugins for one.

## Update check

When Claude calls this plugin's tool, and the last check is 30 minutes old or there hasn't been one, the plugin checks whether a newer version is published. It fetches this plugin's `plugin.json` from the `main` branch of the repository its installed `plugin.json` names, [`plugins/self-clear/.claude-plugin/plugin.json`](https://raw.githubusercontent.com/moefingers/claude-code-self-tools/main/plugins/self-clear/.claude-plugin/plugin.json), and compares its `version` with the installed one.

- **A plain GET of a public file.** The plugin adds no headers, query or body, and sends nothing about you, the session or the machine. GitHub sees the request as it sees any web request: the address it comes from, the time, and the headers Claude Code sends on its own.
- **At most every 30 minutes.** The check's time and answer are kept in the plugin's own store, so a reload, or another session on this machine, uses that answer until it is 30 minutes old. Sessions that come due at the same moment each make their one request.
- **It never holds up the tool.** The check runs beside the call, which never waits on it. Offline, refused by policy, a 404, a rate limit, no answer within 5 seconds, or anything but a plain version such as `0.2.0` all mean no notice.
- **When a newer version is out**, a toast tells you, and the result of one of Claude's next calls ends with a line like this:

  > self-clear 0.1.0 is out of date (0.2.0 is published). To update, the person runs: claude plugin marketplace update claude-code-self-tools, then claude plugin update self-clear@claude-code-self-tools, then /reload-plugins in each open session (a new session loads the update on its own). Don't run these yourself unless the person asks.

  The line is fixed text. Only the two version numbers vary, and each must be three plain numbers. Nothing else from the fetched file reaches Claude. A session is told of each check once, and at most once every 30 minutes, not on every call, and the toast follows the same rule. A call carries only what an earlier check found: the call that starts a check doesn't wait for its answer.
- **Turn it off** with the plugin's `updateCheck` setting: `off` never checks. Set it in `/config`, or from your shell:

  ```
  echo '{"updateCheck":"off"}' | claude plugin configure self-clear@claude-code-self-tools --values-stdin
  ```

  which saves it in settings.json as `"pluginConfigs": { "self-clear@claude-code-self-tools": { "options": { "updateCheck": "off" } } }`. Nothing is checked while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, to any value, or for a subagent's call.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-clear@claude-code-self-tools
```
