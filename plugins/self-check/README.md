# self-check

Lets a session check that its own tools answer, instead of asking you whether Bash is broken. It runs a harmless echo through the Bash and PowerShell tools exactly as Claude calls them, says on Windows how much room the session env leaves a Bash command, lists the MCP servers that are connected, and exercises a server only through a probe you name. Quietly again when the session is resumed, saying only what failed. And it guards Bash against the commonest way it dies on Windows: a session env that grows at every start until Git Bash cuts the command off (below). Part of [claude-code-self-tools](../../README.md).

## Tool

`tools_check` (Claude sees `mcp__self-check__tools_check`), no arguments. Claude calls it when a tool seems dead (an empty result where there should be output, a call that never answers), before working around it.

## How it behaves

- **The built-in tools, through the same door Claude uses.** For Bash and for PowerShell, the plugin first asks the engine's permission verdict for the call (`$.tool.check`), which opens no dialog. Only when that is `allow` does it make the call (`$.tool.call`, the same call the engine makes for Claude's own tool calls): `echo selfcheck-<nonce>` for Bash, `Write-Output selfcheck-<nonce>` for PowerShell, a fresh 16-digit nonce each time, each within 10 seconds. It never starts `bash.exe` or `powershell.exe` itself.
  - **ok** only when the output holds the nonce.
  - **failed: no output** when the call answers with nothing (one session's Bash once answered every command so, while `bash.exe` itself worked); **failed:** *the output didn't hold the nonce*, the tool's error, or *timed out after 10 s*.
  - **not tested** when the verdict is anything but `allow` (*needs permission*, *refused by permissions*), or a hook refuses the call. Nothing runs then, so no dialog can open.
  - **not among this session's tools** when the session doesn't have it (PowerShell off Windows, say). That is no failure.
- **MCP servers, listed.** There is no ping for an MCP server, and calling one of its tools could do anything, so a server is listed by its tools (`mcp__<server>__<tool>`): *listed (3 tools), not exercised*. A server is exercised only through a probe you name in the `probes` setting, as `server=tool`: the server as its tools are named, and one of its tools that only reads and needs no arguments. `$.mcp.call` asks no permission, so the plugin first asks the probe tool's permission verdict (`$.tool.check` on `mcp__<server>__<tool>`), as for the shells: anything but `allow` is **not tested**, and the server isn't called. Then it calls the probe (`$.mcp.call`, with no arguments) within 10 seconds: **ok** unless it reports an error. A probe for a server that isn't connected fails (*not connected (no tools listed)*); a probe naming a tool the server doesn't list isn't run.
- **Bash's env, on Windows.** A line after Bash's says how much room this session's env script leaves a Bash command, and a verdict: **BROKEN** when none is left (every command is cut), **AT RISK** when under 2,000 characters are (long commands are cut), **OK** otherwise. The script is measured as Claude Code builds it (below): `CLAUDE_ENV_FILE`'s text when that is set in Claude Code's own environment, then this session's env hook files, each trimmed, joined by newlines; the room is 8,186 less about 470 characters of Claude Code's own wrapper, less the script. Only lengths are read out, never a value. When the verdict is AT RISK or BROKEN and the `envDedupe` setting is on, the check also runs the dedupe (below) and says what it did. The dedupe doesn't drop Claude Code's cached copy of the script, so after it the line ends with the next step: *Claude Code still holds the old copy: now move the PowerShell tool's directory away and back, in two calls in the main session (`Set-Location ..`, then `Set-Location` to the folder it was in), then retry Bash*. Off Windows (no `%USERPROFILE%` or `CLAUDE_CONFIG_DIR` drive folder) there is no line.
- **Words from outside stay data.** A hook's refusal, a tool's error, a probe's error and the unexpected output are each kept to one line and quoted in «…», a guillemet inside escaped, so the row read at resume carries them as data, never as instructions.
- **The answer** is a summary line and one line per tool. It ends with how to repair what failed:
  - **A dead Bash whose env is AT RISK or BROKEN, or couldn't be measured**, and **any env AT RISK or BROKEN**, get the env repair:

    > A Bash that runs nothing (no output, or `unexpected EOF` from a short command) is most often this session's env grown too long: Claude Code puts the session's env hook files (`~/.claude/session-env/<session>/*-hook-<n>.sh`) into every Bash call, and Git Bash drops everything past the call's 8,186th character, the command first (anthropics/claude-code#103861). The repair: dedupe those files, keeping each variable's last assignment, which leaves the same environment (self-check does it at each session start and in a check that finds the env at risk, while its envDedupe setting is on; the Bash env line says what it did), then have Claude Code read them again: in the main session, move the PowerShell tool's directory and back in two calls (`Set-Location ..`, then `Set-Location` to the folder it was in), and try Bash `echo ok`. A fresh process alone doesn't repair it: a resume reads the same files, unless the dedupe at its start shrinks them.

  - **Any other dead tool**, a dead Bash with an OK env included:

    > A fresh process usually repairs a dead tool: restart_after_turn (self-restart; it needs a safe point). Where the coordinator runs, the merger can restart this lane (`next: 'restart'`).

  - **A failed MCP server** adds that a reconnect (`reconnect_mcp_after_turn`, [self-mcp](../self-mcp)) may be all it needs.

  For example:

  ```
  self-check: 1 failed (Bash).
  Bash: failed: no output
  Bash env: BROKEN: every Bash call carries 16,205 characters of session env, none left for the command (8,489 over) before Git Bash's cut at 8,186. Deduped now to 665 characters (OK), the same environment. Claude Code still holds the old copy: now move the PowerShell tool's directory away and back, in two calls in the main session (`Set-Location ..`, then `Set-Location` to the folder it was in), then retry Bash
  PowerShell: ok
  MCP server coordinator: listed (40 tools), not exercised
  MCP server linear: ok (probe whoami)
  A Bash that runs nothing (no output, or `unexpected EOF` from a short command) is most often ... (the env repair above)
  ```
- **At resume, quietly.** When the session is resumed (Claude Code's SessionStart with `source: "resume"`), the plugin runs the same check 10 seconds later, once no turn is running (it waits for a running turn to end). A passing check says nothing, and neither does an env AT RISK while Bash still answers. A failure is said once: a toast, and one row Claude reads with your next message; it never starts a turn. The `checkAtResume` setting turns this off.
- **The record.** Each check writes `%LOCALAPPDATA%\claude-self-tools\selfcheck\<conversation>.json`: `{ "v": 1, "at": <milliseconds since the epoch>, "failed": ["Bash", "mcp:linear"] }`, the failed tools by name only (`Bash`, `PowerShell`, `mcp:<server>`), at most 8. The path takes the conversation's id only when it is a session id (a UUID), and nothing is written without a plain `%LOCALAPPDATA%`. The [coordinator](https://github.com/moefingers/agent-coordinator-3000)'s lane report carries those names, so the merger sees a lane whose tools died; the shared machine code's `readSelfcheck` reads it as the coordinator does. Besides it, the plugin writes only what the env guard does (below).
- **Subagents can't use it.** A subagent is told to return its result saying which tool seemed dead; the main session can check.

**Seen live** (Claude Code 2.1.318): the Bash echo through `$.tool.call`, 10 seconds after a resume, answered in 1.8 seconds, added no row to the transcript and showed nothing on screen; so the check at resume is quiet, and `checkAtResume` is on by default. The call takes the tool's arguments at its top level (`{ tool: 'Bash', command }`), the permission check under `input`; a call shaped otherwise is an error result, which fails. Those checks ran in bypassPermissions mode: whether the permission check says `allow` for the echoes in the default mode is untested. Where it doesn't, the tool is *not tested*, never put to a dialog. If a later Claude Code shows the plugin's calls, turn `checkAtResume` off and let Claude check on demand.

## The Bash env guard

**Why Bash dies.** Claude Code (read from its 2.1.319 bundle) builds every Bash call as one `bash.exe -c` string: its shell snapshot, then this session's env script, then the command, then a line that records the working directory. The env script is every `(setup|sessionstart|cwdchanged|filechanged)-hook-<n>.sh` in `~/.claude/session-env/<session id>/` (under `CLAUDE_CONFIG_DIR` when that is set), in that order and by number. Git Bash (its MSYS runtime, 3.6.x) runs only the first 8,186 characters of a `-c` string and drops the rest without a word. A SessionStart hook that appends to its env file at every start makes the script grow for as long as the session id lives, across every resume and compaction: the Vercel plugin adds three `export` lines each time, about 222 bytes. So a long-lived, compacting session first has its long commands cut (`unexpected EOF while looking for matching '`), then every command (exit 0, no output: *Bash completed with no output*). A resume reads the same files, so it doesn't help. Upstream: [anthropics/claude-code#103861](https://github.com/anthropics/claude-code/issues/103861).

**The dedupe.** In each hook file, only the last assignment of each variable is kept, in the order those lines stand, each line as it was; blank and comment lines go. Every value a plain line can hold expands nothing (no `$`, no backtick), so a shell that sources the file ends up with the same environment. A file is left as it is when:
- any line isn't a plain assignment, by Claude Code's own test (`NAME=value`, optionally after `export ` or `declare -x `; a value of plain characters, single-quoted text, or double-quoted text with no `$` or backtick);
- a variable an earlier line exported is set by its last line without `export` (keeping that line alone would unexport it);
- it isn't clean UTF-8;
- the dedupe wouldn't make it shorter;
- it changed between the read and the rewrite.

Nothing is rewritten while the hook files total 2 KB (2,048 bytes) or less, so a healthy session is left alone; a session that dedupes at about 2 KB stays far under the cut. Before a rewrite the file's text goes to `<name>.bak`: one backup per file, overwritten by the next dedupe, never a pile. Claude Code reads only names ending in `-hook-<n>.sh`, so a backup is never put into a call. `CLAUDE_ENV_FILE` is counted, never rewritten.

**When.**
- **Right after each session start**, of every kind (startup, resume, clear, compact, fork), in the main session. The plugin hooks Claude Code's classic SessionStart and does its work after the chain beneath it: the settings hooks, which is where every plugin's SessionStart command hooks run, so they have all appended by then, and the work is awaited before the start ends. Claude Code drops its cached copy of the env script after each SessionStart, Setup, CwdChanged and FileChanged hook, and builds it again only at the next Bash call, so that call reads the deduped files. This is the one place the files grow, so a dedupe here keeps them short.
- **In a check that finds the env AT RISK or BROKEN** (`tools_check`, or the quiet one at resume). That covers a session already over the line when the plugin was installed or updated. Claude Code has already built its copy by then, so it reads the deduped files once its copy is dropped: when the shell tool's working directory moves (Claude Code drops it then), or at the next start. That is why the env repair says to move the PowerShell tool's directory and back, in two calls, in the main session (a subagent can't move it).
- Not before each Bash call: a hook there would read the folder on every call to catch what the start already caught, and once Claude Code holds its copy, a rewrite changes nothing until the copy is dropped. Not after a delay: the session's first Bash call may come first.

The debug log (`claude --debug`) has a line for each dedupe: the files, their lengths before and after, and why any was left as it was. Never a value.

**What was seen, and what wasn't.** The cut, the files and the cache were read from Claude Code 2.1.319 and reproduced outside it: Git Bash given a session's real files ran the command with 105 env lines and nothing with 110. The dedupe's rules were run on a copy of a broken session's files (16,206 bytes became 666, and the sorted environment a shell ended up with was byte for byte the same), and moving the PowerShell tool's directory and back made a live session read the files again. The plugin's own dedupe, at a start and in a check, is so far covered by its tests (fakes only), not yet seen in a live session.

## Settings

- `checkAtResume` (`on`): `off` checks only when Claude calls `tools_check`.
- `envDedupe` (`on`): `off` never rewrites the session's env hook files, at a start or in a check; `tools_check` still says how much room they leave. From your shell:

  ```
  echo '{"envDedupe":"off"}' | claude plugin configure self-check@claude-code-self-tools --values-stdin
  ```
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
