# self-context

Lets a session read how full its context window is, so at the break between two pieces of work it can decide whether to compact now, rather than have auto-compact run in the middle of the next piece. Part of [claude-code-self-tools](../../README.md).

## Tool

`context_usage` (Claude sees `mcp__self-context__context_usage`), with no arguments. It answers with one line, such as:

> Context: 123,456 of 200,000 tokens (62%). Auto-compact is on. To compact at this break, call compact_after_turn.

- The figures are the ones the status line shows: the input tokens of the model's last response, against the model's window. A new or just-compacted conversation has no reading until the model's next response, and the tool says so.
- Whether auto-compact is on comes from the `/config` menu's `autoCompact` row.
- The last sentence appears only when [self-compact](../self-compact)'s `compact_after_turn` is available.

## How it behaves

- **Read-only.** It changes no setting and runs no command.
- **Subagents are refused.** The figures are the main conversation's, and Claude Code has no reading of a subagent's own window, so a subagent is told so rather than handed figures that aren't its own.

## Update check

When Claude calls one of this plugin's tools, and the last check is 30 minutes old or there hasn't been one, the plugin checks whether a newer version is published. It fetches this plugin's `plugin.json` from the `main` branch of the repository its installed `plugin.json` names, [`plugins/self-context/.claude-plugin/plugin.json`](https://raw.githubusercontent.com/moefingers/claude-code-self-tools/main/plugins/self-context/.claude-plugin/plugin.json), and compares its `version` with the installed one.

- **A plain GET of a public file, and nothing more.** The request carries no headers, no query and nothing about you, the session or the machine.
- **At most every 30 minutes.** The check's time and answer are kept in the plugin's own store, so a reload, or another session on this machine, uses that answer until it is 30 minutes old.
- **It never holds up the tool.** The check runs beside the call, which never waits on it. Offline, refused by policy, a 404, a rate limit, no answer within 5 seconds, or anything but a plain version such as `0.2.0` all mean no notice.
- **When a newer version is out**, a toast tells you, and the result of one of Claude's next calls ends with a line like this:

  > self-context 0.1.1 is out of date (0.2.0 is published). To update, the person runs: claude plugin marketplace update claude-code-self-tools, then claude plugin update self-context@claude-code-self-tools (once for each scope it is installed at, adding --scope project or --scope local for those), then /reload-plugins. Don't run these yourself unless the person asks.

  The line is fixed text. Only the two version numbers vary, and each must be three plain numbers. Nothing else from the fetched file reaches Claude. Claude is told once per check, not on every call, so at most once every 30 minutes in a session, and the toast follows the same rule. A call carries only what an earlier check found: the call that starts a check doesn't wait for its answer.
- **Turn it off** with the plugin's `updateCheck` setting: `off` never checks. It's in `/config`, or in settings.json under `pluginConfigs`, keyed by the plugin as installed (`self-context@claude-code-self-tools`). Nothing is checked while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, or for a subagent's call.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-context@claude-code-self-tools
```
