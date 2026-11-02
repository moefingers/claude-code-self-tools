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
- **Subagents can't use it.** A subagent is told to say what to check later and when, so the main session can set the wake-up.

## Update check

When Claude calls one of this plugin's tools, and the last check is 30 minutes old or there hasn't been one, the plugin checks whether a newer version is published. It fetches this plugin's `plugin.json` from the `main` branch of the repository its installed `plugin.json` names, [`plugins/self-wake/.claude-plugin/plugin.json`](https://raw.githubusercontent.com/moefingers/claude-code-self-tools/main/plugins/self-wake/.claude-plugin/plugin.json), and compares its `version` with the installed one.

- **A plain GET of a public file, and nothing more.** The request carries no headers, no query and nothing about you, the session or the machine.
- **At most every 30 minutes.** The check's time and answer are kept in the plugin's own store, so a reload, or another session on this machine, uses that answer until it is 30 minutes old.
- **It never holds up the tool.** The check runs beside the call, which never waits on it. Offline, refused by policy, a 404, a rate limit, no answer within 5 seconds, or anything but a plain version such as `0.2.0` all mean no notice.
- **When a newer version is out**, a toast tells you, and the result of one of Claude's next calls ends with a line like this:

  > self-wake 0.1.1 is out of date (0.2.0 is published). To update, the person runs: claude plugin marketplace update claude-code-self-tools, then claude plugin update self-wake@claude-code-self-tools (once for each scope it is installed at, adding --scope project or --scope local for those), then /reload-plugins. Don't run these yourself unless the person asks.

  The line is fixed text. Only the two version numbers vary, and each must be three plain numbers. Nothing else from the fetched file reaches Claude. Claude is told once per check, not on every call, so at most once every 30 minutes in a session, and the toast follows the same rule. A call carries only what an earlier check found: the call that starts a check doesn't wait for its answer.
- **Turn it off** with the plugin's `updateCheck` setting: `off` never checks. It's in `/config`, or in settings.json under `pluginConfigs`, keyed by the plugin as installed (`self-wake@claude-code-self-tools`). Nothing is checked while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, or for a subagent's call.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-wake@claude-code-self-tools
```
