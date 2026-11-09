# self-color

Lets a session set its own prompt bar color once the current turn ends, as `/color <color>` does. A session uses it to mark its role, so you can tell sessions apart at a glance: one color for a coordinating session, another for workers. Part of [claude-code-self-tools](../../README.md).

## Tool

`color_after_turn` (Claude sees `mcp__self-color__color_after_turn`):

- `color`: one of `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink` or `cyan`, the colors `/color` takes, or `default`, which resets the prompt bar. Anything else is refused at the call, with the list. `/color`'s own aliases (`reset`, `none`, `gray`, `grey`) aren't taken: `default` is the one way to reset.

## How it behaves

- **The color changes after the turn ends.** The call queues it; half a second after the turn ends with Claude's answer, once no turn and no `/resume` or `/clear` is running, the plugin runs `/color <color>`, which shows in the transcript as if you had typed it. With a color, `/color` sets it and prints one line, with no picker. Claude needn't end its turn for it.
- **It lasts until it's changed.** `default` resets it.
- **A message of yours in between only puts it off.** The change has no resume, so nothing in it can go stale: if a turn of yours starts before it runs (a message you typed during Claude's turn, say), it goes once that turn has ended, and the color still changes.
- **A move to another conversation drops it.** A `/resume` or a `/clear` that runs before the change (typed during the turn, or run by another plugin) would move the session first, and the color would land on the conversation moved to. So the change waits while one runs, and when the session's start says it moved, the change is dropped, with a toast: `Prompt bar color change dropped: this session moved to another conversation.` A `/resume` that ends without moving (its picker closed) lets the change go. The half second after the turn's end is there so that such a command has started when the change would go; once the change has gone to Claude Code, it can't be taken back.
- **A toast says what ran.** In an interactive session `/color` prints its own line in the transcript and hands the plugin no text, so the toast can't tell whether it took: `/color <color> ran: Claude Code's line above says whether it took.` That line is `Session color set to: <color>` or `Session color reset to default` when it took, and `/color`'s own refusal when it didn't (in a teammate session of an agent team, whose colors the team leader assigns).
- **Headless, the toast says how it went**, since `/color` hands its line back there: `Prompt bar color set to <color>.` or `Prompt bar color reset to default.` for its exact success line, and `/color <color> said: <its line>` for anything else (its refusal, or a cloud session's warning that the color is set on this screen only), which Claude is told too.
- **If Claude Code refuses the command**, the toast says `/color didn't run: <why>`, and Claude is told on its next turn.
- **An interrupted turn cancels it**, with a notice: one you stopped, or one that ended on an error.
- **Subagents can't use it.** A subagent that calls the tool is told to finish its piece and return its result; the main session can set the color.
- **It keeps nothing past the change.** The queued color lives in the plugin's session state for the turn that queued it; the turn's end takes it, and the plugin holds it until it runs or is dropped.

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
