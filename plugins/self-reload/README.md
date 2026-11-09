# self-reload

Lets a session reload its own plugins once the current turn ends, as `/reload-plugins` does, then carry on by itself. Useful when the session edits a plugin and needs the change live, for example to try a tool it just changed. Part of [claude-code-self-tools](../../README.md).

## Tool

`reload_plugins_after_turn` (Claude sees `mcp__self-reload__reload_plugins_after_turn`):

- `resume` (optional): the message that starts the session's next turn once the plugins have reloaded, saying what to check or do next.

## How it behaves

- **The reload waits for the turn to end.** The call queues it; `/reload-plugins` runs once the turn ends with Claude's answer, and shows in the transcript as if you had typed it.
- **With `resume`, the session carries on**: it sends itself "Plugins reloaded. Resume: …", which starts a new turn. Without `resume`, it waits for your next message.
- **Sent once, through its own reload.** The reload replaces this plugin's code too, so the `resume` is written to session state before the command runs. Whichever copy of the plugin is running when the reload is done sends it, once. A resume that no reload picks up within ten minutes is dropped, with a notice, rather than sent late.
- **A turn first, then no stale resume.** Claude Code runs anything already waiting when the turn ends (a message you typed during it) before the reload. If your own message starts a turn after the reload was queued, the `resume` isn't sent as a new message, since your message came after Claude asked to resume and is answered first. Claude gets it as a note instead, and a toast says so. Any other turn first (a background task's notification, another plugin's message) leaves the resume as it was, so the session doesn't sit idle.
- **A refused or skipped reload is reported.** If Claude Code refuses to run `/reload-plugins` for a plugin, or the command skips the reload (it does when the reload would change which MCP tools are loaded, until it is run with `--force`, which this plugin leaves to you), a toast says so, and the resume, if there is one, is sent saying the reload didn't happen. Without a resume, Claude is told on its next turn.
- **An interrupted turn cancels it**, with a notice.
- **Subagents can't use it.** A subagent that calls the tool is told to finish its piece and say a reload is needed.

## Update check

When Claude calls one of this plugin's tools, and the last check is 30 minutes old or there hasn't been one, the plugin checks whether a newer version is published. It fetches this plugin's `plugin.json` from the `main` branch of the repository its installed `plugin.json` names, [`plugins/self-reload/.claude-plugin/plugin.json`](https://raw.githubusercontent.com/moefingers/claude-code-self-tools/main/plugins/self-reload/.claude-plugin/plugin.json), and compares its `version` with the installed one.

- **A plain GET of a public file.** The plugin adds no headers, query or body, and sends nothing about you, the session or the machine. GitHub sees the request as it sees any web request: the address it comes from, the time, and the headers Claude Code sends on its own.
- **At most every 30 minutes.** The check's time and answer are kept in the plugin's own store, so a reload, or another session on this machine, uses that answer until it is 30 minutes old. Sessions that come due at the same moment each make their one request.
- **It never holds up the tool.** The check runs beside the call, which never waits on it. Offline, refused by policy, a 404, a rate limit, no answer within 5 seconds, or anything but a plain version such as `0.2.0` all mean no notice.
- **When a newer version is out**, a toast tells you, and the result of one of Claude's next calls ends with a line like this:

  > self-reload 0.1.1 is out of date (0.2.0 is published). To update, the person runs: claude plugin marketplace update claude-code-self-tools, then claude plugin update self-reload@claude-code-self-tools, then /reload-plugins in each open session (a new session loads the update on its own). Don't run these yourself unless the person asks.

  The line is fixed text. Only the two version numbers vary, and each must be three plain numbers. Nothing else from the fetched file reaches Claude. A session is told of each check once, and at most once every 30 minutes, not on every call, and the toast follows the same rule. A call carries only what an earlier check found: the call that starts a check doesn't wait for its answer.
- **Turn it off** with the plugin's `updateCheck` setting: `off` never checks. Set it in `/config`, or from your shell:

  ```
  echo '{"updateCheck":"off"}' | claude plugin configure self-reload@claude-code-self-tools --values-stdin
  ```

  which saves it in settings.json as `"pluginConfigs": { "self-reload@claude-code-self-tools": { "options": { "updateCheck": "off" } } }`. Nothing is checked while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, to any value, or for a subagent's call.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-reload@claude-code-self-tools
```
