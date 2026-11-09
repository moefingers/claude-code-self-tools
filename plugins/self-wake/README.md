# self-wake

Lets a session wake itself later: some minutes after the turn ends, it sends itself a note that starts a turn of its own. Useful when the next step waits on something slow (a deploy, a long job, a check that reports later) that won't tell the session when it is done. Part of [claude-code-self-tools](../../README.md).

## Tools

`wake_after` (Claude sees `mcp__self-wake__wake_after`):

- `minutes` (required): how long after the turn ends, from 1 to 1440 (a day). A number outside that range is brought within it, and the result says so.
- `note` (required): what to check or do on waking. The session receives it as "Wake-up: <note>".

`cancel_wake` (Claude sees `mcp__self-wake__cancel_wake`), with no arguments: takes back the wake-up, if there is one.

## How it behaves

- **The wait starts when the turn ends.** The call queues the wake-up, and it is armed once the turn ends with Claude's answer, counting from then. If a turn is running when it fires, the note waits until the session is idle.
- **One wake-up at a time.** A new one replaces the one before it, and the result says which.
- **An interrupted turn drops the wake-up it asked for.** One armed in an earlier turn stands, and the notice says so.
- **It survives a reload of the plugin.** The wake-up is kept in session state; when the plugin's code reloads, it is armed again for the time left, or fires at once if that time has passed. It fires once.
- **It lasts as long as the session.** Quitting Claude Code drops it.
- **It survives a `/clear` or a `/resume`.** Claude Code empties a plugin's session state at a `/clear` or a `/resume` run inside the process, and no plugin start follows. The plugin keeps its own copy of the armed wake-up, puts it back into session state at each `/clear` or `/resume` (and at the first read that finds it gone, since the emptying may come a moment after), and its timer goes by that copy when session state reads empty. So `cancel_wake` and a new `wake_after` still see it.
- **A wake-up armed before a `/clear` fires after it**, into the conversation the `/clear` started: it is the session's one wake-up. Cancel it (`cancel_wake`) before a `/clear` if it was only for the conversation that ends.
- **The status line follows it.** It says *wake-up pending: …* while one is armed; a timer that sends nothing (the wake-up was taken back meanwhile) leaves it pinned to a wake-up still armed, or clears it.
- **It says whether a wake-up is armed, per conversation.** The plugin keeps `%LOCALAPPDATA%\claude-self-tools\wake\<conversation id>.json`, `{ "v": 1, "armed": true|false, "due"?: <ms>, "at": <ms> }`, written whole: at the start of each conversation the process holds (a startup, a `/resume`, a `/clear`; a fork's start writes the fork's marker and moves nothing, by the same rule [self-switch](../self-switch) reads it by: within 15 seconds of the SessionStart its id stands, and past that `$.session.id()` does), when a wake-up is armed or replaced, when it fires, and when it is cancelled. `armed` is true only while the process holds a timer for that conversation. A wake-up keeps the conversation it was armed in, so after a reload (`/reload-plugins`) it is armed again for that one, never the next one the session moves to. The armed marker is written before the turn's end returns, so a switch queued in the same turn reads it; when the write fails it is tried once more, and when that fails too the marker is removed, also before the turn's end returns, by one fixed script (a plugin can't delete a file): self-wake on with no marker reads as unknown, which holds a switch. A toast says so, or, if it couldn't be removed either, that a switch may not see the wake-up and to cancel it before switching. [self-switch](../self-switch) and the coordinator read it: a wake-up armed holds a switch, which would drop it. The marker holds ids and times, nothing of the note.
- **Subagents can't use it.** A subagent is told to say what to check later and when, so the main session can set the wake-up.

## Update check

When Claude calls one of this plugin's tools, and the last check is 30 minutes old or there hasn't been one, the plugin checks whether a newer version is published. It fetches this plugin's `plugin.json` from the `main` branch of the repository its installed `plugin.json` names, [`plugins/self-wake/.claude-plugin/plugin.json`](https://raw.githubusercontent.com/moefingers/claude-code-self-tools/main/plugins/self-wake/.claude-plugin/plugin.json), and compares its `version` with the installed one.

- **A plain GET of a public file.** The plugin adds no headers, query or body, and sends nothing about you, the session or the machine. GitHub sees the request as it sees any web request: the address it comes from, the time, and the headers Claude Code sends on its own.
- **At most every 30 minutes.** The check's time and answer are kept in the plugin's own store, so a reload, or another session on this machine, uses that answer until it is 30 minutes old. Sessions that come due at the same moment each make their one request.
- **It never holds up the tool.** The check runs beside the call, which never waits on it. Offline, refused by policy, a 404, a rate limit, no answer within 5 seconds, or anything but a plain version such as `0.2.0` all mean no notice.
- **When a newer version is out**, a toast tells you, and the result of one of Claude's next calls ends with a line like this:

  > self-wake 0.1.1 is out of date (0.2.0 is published). To update, the person runs: claude plugin marketplace update claude-code-self-tools, then claude plugin update self-wake@claude-code-self-tools, then /reload-plugins in each open session (a new session loads the update on its own). Don't run these yourself unless the person asks.

  The line is fixed text. Only the two version numbers vary, and each must be three plain numbers. Nothing else from the fetched file reaches Claude. A session is told of each check once, and at most once every 30 minutes, not on every call, and the toast follows the same rule. A call carries only what an earlier check found: the call that starts a check doesn't wait for its answer.
- **Turn it off** with the plugin's `updateCheck` setting: `off` never checks. Set it in `/config`, or from your shell:

  ```
  echo '{"updateCheck":"off"}' | claude plugin configure self-wake@claude-code-self-tools --values-stdin
  ```

  which saves it in settings.json as `"pluginConfigs": { "self-wake@claude-code-self-tools": { "options": { "updateCheck": "off" } } }`. Nothing is checked while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, to any value, or for a subagent's call.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-wake@claude-code-self-tools
```
