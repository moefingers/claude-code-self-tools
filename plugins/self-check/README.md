# self-check

Lets a session check that its own tools answer, instead of asking you whether Bash is broken. It runs a harmless echo through the Bash and PowerShell tools exactly as Claude calls them, lists the MCP servers that are connected, and exercises a server only through a probe you name. Quietly again when the session is resumed, saying only what failed. Part of [claude-code-self-tools](../../README.md).

## Tool

`tools_check` (Claude sees `mcp__self-check__tools_check`), no arguments. Claude calls it when a tool seems dead (an empty result where there should be output, a call that never answers), before working around it.

## How it behaves

- **The built-in tools, through the same door Claude uses.** For Bash and for PowerShell, the plugin first asks the engine's permission verdict for the call (`$.tool.check`), which opens no dialog. Only when that is `allow` does it make the call (`$.tool.call`, the same call the engine makes for Claude's own tool calls): `echo selfcheck-<nonce>` for Bash, `Write-Output selfcheck-<nonce>` for PowerShell, a fresh 16-digit nonce each time, each within 10 seconds. It never starts `bash.exe` or `powershell.exe` itself.
  - **ok** only when the output holds the nonce.
  - **failed: no output** when the call answers with nothing (one session's Bash once answered every command so, while `bash.exe` itself worked); **failed:** *the output didn't hold the nonce*, the tool's error, or *timed out after 10 s*.
  - **not tested** when the verdict is anything but `allow` (*needs permission*, *refused by permissions*), or a hook refuses the call. Nothing runs then, so no dialog can open.
  - **not among this session's tools** when the session doesn't have it (PowerShell off Windows, say). That is no failure.
- **MCP servers, listed.** There is no ping for an MCP server, and calling one of its tools could do anything, so a server is listed by its tools (`mcp__<server>__<tool>`): *listed (3 tools), not exercised*. A server is exercised only through a probe you name in the `probes` setting, as `server=tool`: the server as its tools are named, and one of its tools that only reads and needs no arguments. The plugin calls it (`$.mcp.call`, with no arguments) within 10 seconds: **ok** unless it reports an error. A probe for a server that isn't connected fails (*not connected (no tools listed)*); a probe naming a tool the server doesn't list isn't run.
- **The answer** is a summary line and one line per tool. When anything failed, it ends with how to repair it:

  > A fresh process usually repairs a dead tool: restart_after_turn (self-restart; it needs a safe point). Where the coordinator runs, the merger can restart this lane (`next: 'restart'`).

  and, when an MCP server failed, that a reconnect (`reconnect_mcp_after_turn`, [self-mcp](../self-mcp)) may be all it needs. For example:

  ```
  self-check: 1 failed (Bash).
  Bash: failed: no output
  PowerShell: ok
  MCP server coordinator: listed (40 tools), not exercised
  MCP server linear: ok (probe whoami)
  A fresh process usually repairs a dead tool: restart_after_turn (self-restart; it needs a safe point). Where the coordinator runs, the merger can restart this lane (`next: 'restart'`).
  ```
- **At resume, quietly.** When the session is resumed (Claude Code's SessionStart with `source: "resume"`), the plugin runs the same check 10 seconds later, once no turn is running (it waits for a running turn to end). A passing check says nothing. A failure is said once: a toast, and one row Claude reads with your next message; it never starts a turn. The `checkAtResume` setting turns this off.
- **The record.** Each check writes `%LOCALAPPDATA%\claude-self-tools\selfcheck\<conversation>.json`: `{ "v": 1, "at": <milliseconds since the epoch>, "failed": ["Bash", "mcp:linear"] }`, the failed tools by name only (`Bash`, `PowerShell`, `mcp:<server>`), at most 8. The path takes the conversation's id only when it is a session id (a UUID), and nothing is written without a plain `%LOCALAPPDATA%`. The [coordinator](https://github.com/moefingers/agent-coordinator-3000)'s lane report carries those names, so the merger sees a lane whose tools died; the shared machine code's `readSelfcheck` reads it as the coordinator does. It is the only file the plugin writes.
- **Subagents can't use it.** A subagent is told to return its result saying which tool seemed dead; the main session can check.

**Seen live** (Claude Code 2.1.318): the Bash echo through `$.tool.call`, 10 seconds after a resume, answered in 1.8 seconds, added no row to the transcript and showed nothing on screen; so the check at resume is quiet, and `checkAtResume` is on by default. The call takes the tool's arguments at its top level (`{ tool: 'Bash', command }`), the permission check under `input`; a call shaped otherwise is an error result, which fails. Those checks ran in bypassPermissions mode: whether the permission check says `allow` for the echoes in the default mode is untested. Where it doesn't, the tool is *not tested*, never put to a dialog. If a later Claude Code shows the plugin's calls, turn `checkAtResume` off and let Claude check on demand.

## Settings

- `checkAtResume` (`on`): `off` checks only when Claude calls `tools_check`.
- `probes` (none): MCP servers to exercise, each `server=tool`. Name only a tool that reads and needs no arguments; a server not named here is listed, never called. From your shell:

  ```
  echo '{"probes":["linear=whoami"]}' | claude plugin configure self-check@claude-code-self-tools --values-stdin
  ```

## Update check

When Claude calls this plugin's tool, and the last check is 30 minutes old or there hasn't been one, the plugin checks whether a newer version is published. It fetches this plugin's `plugin.json` from the `main` branch of the repository its installed `plugin.json` names, [`plugins/self-check/.claude-plugin/plugin.json`](https://raw.githubusercontent.com/moefingers/claude-code-self-tools/main/plugins/self-check/.claude-plugin/plugin.json), and compares its `version` with the installed one.

- **A plain GET of a public file.** The plugin adds no headers, query or body, and sends nothing about you, the session or the machine. GitHub sees the request as it sees any web request: the address it comes from, the time, and the headers Claude Code sends on its own.
- **At most every 30 minutes.** The check's time and answer are kept in the plugin's own store, so a reload, or another session on this machine, uses that answer until it is 30 minutes old. Sessions that come due at the same moment each make their one request.
- **It never holds up the tool.** The check runs beside the call, which never waits on it. Offline, refused by policy, a 404, a rate limit, no answer within 5 seconds, or anything but a plain version such as `0.2.0` all mean no notice.
- **When a newer version is out**, a toast tells you, and the result of one of Claude's next calls ends with a line like this:

  > self-check 0.1.0 is out of date (0.2.0 is published). To update, the person runs: claude plugin marketplace update claude-code-self-tools, then claude plugin update self-check@claude-code-self-tools, then /reload-plugins in each open session (a new session loads the update on its own). Don't run these yourself unless the person asks.

  The line is fixed text. Only the two version numbers vary, and each must be three plain numbers. Nothing else from the fetched file reaches Claude. A session is told of each check once, and at most once every 30 minutes, not on every call, and the toast follows the same rule. A call carries only what an earlier check found: the call that starts a check doesn't wait for its answer.
- **Turn it off** with the plugin's `updateCheck` setting: `off` never checks. Set it in `/config`, or from your shell:

  ```
  echo '{"updateCheck":"off"}' | claude plugin configure self-check@claude-code-self-tools --values-stdin
  ```

  which saves it in settings.json as `"pluginConfigs": { "self-check@claude-code-self-tools": { "options": { "updateCheck": "off" } } }`. Nothing is checked while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, to any value, or for a subagent's call.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-check@claude-code-self-tools
```
