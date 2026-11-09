# self-color

Lets a session set its own prompt bar color once the current turn ends, as `/color <color>` does. A session uses it to mark its role, so you can tell sessions apart at a glance: one color for a merger, another for a worker. Part of [claude-code-self-tools](../../README.md).

## Tool

`color_after_turn` (Claude sees `mcp__self-color__color_after_turn`):

- `color`: one of `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink` or `cyan`, the colors `/color` takes, or `default`, which resets the prompt bar. Anything else is refused at the call, with the list. `/color`'s own aliases (`reset`, `none`, `gray`, `grey`) aren't taken: `default` is the one way to reset.

## How it behaves

- **The color changes once the turn ends.** The call queues it; `/color <color>` runs once the turn ends with Claude's answer, and shows in the transcript as if you had typed it. With a color, `/color` sets it and prints one line, with no picker. Claude needn't end its turn for it.
- **It lasts for the session.** `default` resets it.
- **Your message first, and the color all the same.** Claude Code runs anything already waiting when the turn ends (a message you typed during it) before the change. The change does no harm late and has nothing to resume, so it runs whatever came between.
- **A toast says how it went:** `Prompt bar color set to <color>.`, or `Prompt bar color reset to default.` If Claude Code refuses the command, the toast says `/color didn't run: <why>`, and Claude is told on its next turn. If `/color` itself refuses (in a teammate session of an agent team, whose colors the team leader assigns), the toast says `Prompt bar color not set:` with `/color`'s own words, and Claude is told too.
- **An interrupted turn cancels it**, with a notice.
- **Subagents can't use it.** A subagent that calls the tool is told to finish its piece and return its result; the main session can set the color.
- **It keeps nothing past the turn.** The queued color lives in the plugin's session state for that one turn, and the turn's end takes it.

## Update check

When Claude calls one of this plugin's tools, and the last check is 30 minutes old or there hasn't been one, the plugin checks whether a newer version is published. It fetches this plugin's `plugin.json` from the `main` branch of the repository its installed `plugin.json` names, [`plugins/self-color/.claude-plugin/plugin.json`](https://raw.githubusercontent.com/moefingers/claude-code-self-tools/main/plugins/self-color/.claude-plugin/plugin.json), and compares its `version` with the installed one.

- **A plain GET of a public file.** The plugin adds no headers, query or body, and sends nothing about you, the session or the machine. GitHub sees the request as it sees any web request: the address it comes from, the time, and the headers Claude Code sends on its own.
- **At most every 30 minutes.** The check's time and answer are kept in the plugin's own store, so a reload, or another session on this machine, uses that answer until it is 30 minutes old. Sessions that come due at the same moment each make their one request.
- **It never holds up the tool.** The check runs beside the call, which never waits on it. Offline, refused by policy, a 404, a rate limit, no answer within 5 seconds, or anything but a plain version such as `0.2.0` all mean no notice.
- **When a newer version is out**, a toast tells you, and the result of one of Claude's next calls ends with a line like this:

  > self-color 0.1.0 is out of date (0.2.0 is published). To update, the person runs: claude plugin marketplace update claude-code-self-tools, then claude plugin update self-color@claude-code-self-tools, then /reload-plugins in each open session (a new session loads the update on its own). Don't run these yourself unless the person asks.

  The line is fixed text. Only the two version numbers vary, and each must be three plain numbers. Nothing else from the fetched file reaches Claude. A session is told of each check once, and at most once every 30 minutes, not on every call, and the toast follows the same rule. A call carries only what an earlier check found: the call that starts a check doesn't wait for its answer.
- **Turn it off** with the plugin's `updateCheck` setting: `off` never checks. Set it in `/config`, or from your shell:

  ```
  echo '{"updateCheck":"off"}' | claude plugin configure self-color@claude-code-self-tools --values-stdin
  ```

  which saves it in settings.json as `"pluginConfigs": { "self-color@claude-code-self-tools": { "options": { "updateCheck": "off" } } }`. Nothing is checked while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, to any value, or for a subagent's call.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-color@claude-code-self-tools
```
