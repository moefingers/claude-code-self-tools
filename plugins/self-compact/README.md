# self-compact

Lets a session compact its own conversation at the break between two pieces of work, then carry on by itself. Part of [claude-code-self-tools](../../README.md).

## Tools

`compact_after_turn` (Claude sees `mcp__self-compact__compact_after_turn`):

- `keep` (required): what the summary must hold on to, such as open threads, decisions and where the session's notes are. It works like the text you type after `/compact`.
- `resume` (optional): the message that starts the session's next turn once it has compacted, naming the next piece of work and where its details are.

`compact_reminder` (Claude sees `mcp__self-compact__compact_reminder`; it sits behind ToolSearch, its name listed) sets this conversation's own [compact reminder](#compact-reminder) levels, or says where they stand:

- `levels` (optional): the levels, in the setting's form, such as `"40%, 70%"` or `"300k"`: at most 20, in at most 200 characters. They take the place of the setting's for this conversation alone. `"off"` or `""` drops them, and the setting's stand again. Left out, the tool says what the levels are, where they come from (the conversation's own, or the setting), which have passed since the last compaction (reminded, or marked when set), and where the window stands.
- `notes` (optional, with `levels`): a short note of the session's own for a level, such as `{"60%": "write the notes file first"}`: one line of plain text, at most 120 characters, with no control or format characters (no hidden or reordered text) and no angle brackets. It is shown back to the session with that level's reminder.

It answers at once and queues nothing, and a toast says what the levels are now after each change. Subagents are refused. In a process's first 15 seconds (every new session included), and after a `/clear` or a `/resume` (typed, or an in-place switch) until the session's id names the conversation it moved to (at most 2 minutes), the id may still name another conversation. So the tool sets nothing, says the session is moving between conversations and how long to wait, and the turn-end reminder waits for a later turn end then too.

## How it behaves

- **The compaction runs as the turn ends.** Claude Code can't compact while a turn is running, so the call queues it. By default (`when: "between-turns"`) it compacts from the turn's end itself, ahead of anything queued meanwhile (a message you typed, a background task's notification), which then runs on the compacted conversation; nothing is lost. If a queued turn has started by then, it compacts at that turn's end.
- **Or once the session is idle** (`when: "idle"`): half a second after a turn ends, and only if no turn has started by then, so anything queued goes first. Under a steady stream of work and notifications that can be a long way off.
- **Claude goes idle after the call.** The description ends with the words every self tool that queues for the idle moment ends with (`hooks/at-idle.ts`, the same in each): go idle at once (end the turn), and do nothing more until it has run; then carry on in the turn that follows it, started by its resume message when it sends one, else by the next message. What it queues runs only once the turn has ended and the session is idle, so anything done meanwhile pushes it back.
- **Only compacting can run between turns.** Claude Code queues a plugin's command (`/exit`, `/clear`, `/resume`, `/reload-plugins`, `/mcp`, `/rename`) behind anything waiting, at the lowest priority, so the other `_after_turn` tools run when the session is idle, and say so.
- **With `resume`, the session carries on.** Once compacted, it sends itself the `resume` message, which starts a new turn. If Claude Code skips the compaction, the message is still sent and says so. Without `resume`, the session waits for your next message.
- **One resume per compaction.** A resumed turn compacts again only if it calls the tool again.
- **An interrupted turn cancels it**, with a notice.
- **Subagents can't use it.** A subagent compacts on its own near its context limit; one that calls the tool is told to finish its piece and return its result instead.

## Compact reminder

Off unless you turn it on. A session that finishes a piece of work and forgets to compact runs on until auto-compact, often in the middle of the next piece. With the `compactReminder` setting holding context levels, or a conversation's own levels set with `compact_reminder`, the session gets a polite reminder at the first break past each one. It is not obligatory: a reminder in case the session forgot.

- **One line, at a turn's end.** When a turn of the main conversation ends with Claude's answer, and the context window has risen past a level the session hasn't been reminded of, the plugin adds one line to the session's next turn:

  > self-compact: a polite reminder, in case it slipped your mind: the context window is at 62% (620,000 of 1,000,000 tokens). Nothing is required. If the piece you just finished is complete, this could be a good break for compact_after_turn, with keep (what the summary must hold) and resume (the next piece); if you are mid-piece, carry on.

  The words are fixed; only the three numbers vary. When a level just passed carries a note of the session's own, the line ends with it, quoted and named as its own: `Your own note at 60%: "write the notes file first".` Nothing else from the conversation is in it. It goes in as a row Claude reads and you don't see as typed, with the next turn that calls the model, whoever starts it.
- **Once per passing, by design.** A level reminds once each time the window rises past it, at the first answered turn end past it. That turn end may come mid-piece (the line then says to carry on), and nothing follows at the break that finishes the piece: closer levels give more chances. Levels passed together make one line: a session that starts at 70% with `40%, 60%` set gets one line, not two. A new process (a restart, `claude --resume`), a `/clear` or a `/resume` starts the plugin's record empty, so the levels the window has already reached remind once more, in one line, at the next answered turn end.
- **A compaction arms the levels again.** After `compact_after_turn` compacts, every level reminds again at its next passing, one the compaction landed above too: at the next answered turn end, that is one line. A `/compact` or an auto-compact the plugin can't hear (Claude Code has no compaction event a plugin can hook in every session: `session.compact` is one its built-in guard passes over), so for those it reads the fall off the window, as `context_usage` reads it, at an answered turn's end: a level the window was then below reminds again the next time it is passed. A level the window is back above by the first answered turn end after such a compaction is not reminded that cycle, and one the compaction landed above stays quiet, since compacting again would not take the window under it.
- **What it never does.** It never starts a turn of its own and never shows a toast for the line. It never reminds a subagent, a turn that was interrupted or ended on an error or a refusal (the level waits for the next answered turn end), or the turn end at which a compaction is queued. With the setting empty and no levels of the conversation's own, it doesn't read the window and says nothing. It sends nothing off the machine: the levels reminded are kept in the plugin's session state, so a `/reload-plugins` keeps them. When the line isn't kept (a plugin above refuses it), the levels are put back as they were, and the next answered turn end tries once more.
- **Turn it on** with the plugin's `compactReminder` setting: a comma-separated list of levels, each a percentage of the window (`40%`, from 1% to 99%) or a token count (`400k` or `400000`, 1k or more). Empty, the default, is off. Set it in `/config`, or from your shell:

  ```
  echo '{"compactReminder":"40%, 60%, 80%"}' | claude plugin configure self-compact@claude-code-self-tools --values-stdin
  ```

  which saves it in settings.json as `"pluginConfigs": { "self-compact@claude-code-self-tools": { "options": { "compactReminder": "40%, 60%, 80%" } } }`. The plugin reads it when it loads: at the session's start, or at `/reload-plugins`.
- **A conversation's own levels.** A session calls `compact_reminder` with `levels` to set levels for its own conversation, in place of the setting's, for example an early level for a session that coordinates others, a late one for a builder with one big piece, or one just ahead of where it stands before a piece it knows is large:

  ```
  compact_reminder({ "levels": "40%, 70%", "notes": { "70%": "write the notes file first" } })
  ```

  They are kept in the plugin's store (which Claude Code keeps between sessions and reloads), under a key of the conversation's own, so they follow the conversation, not the process: across a compaction, a restart, a `claude --resume` and a `/reload-plugins`. No write touches another conversation's key. A `/clear` starts a new conversation, which has none. No other conversation sees them, so a session may set levels while the setting is empty, and only its conversation gets reminders. Levels the window already stands past when they are set are marked reminded with no line, so only a passing after the change reminds; the same when `"off"` puts the setting's back. A token level at or past the window's size is kept, and the answer says it never reminds in that window. When more than 200 conversations have levels of their own, a set drops the oldest, down to 150; a drop that fails leaves the set standing, and the debug log says so. When the marks can't be written after a set, the answer says so: a level the window already stands past may then remind at the next answered turn end. At a turn end, the conversation's id and its levels are read once each, within 2 seconds; when a read takes longer, that turn end is skipped (no line, no marks changed), and the debug log says so once. Known limits: a `/reload-plugins` inside a move's wait drops that wait (the 15 seconds of a start then begin at the reload); the plugin's mark that the process has started doesn't survive a `/clear` or a `/resume`, so a later `/reload-plugins` refuses for 15 seconds; and with more than 200 conversations with levels, the drop of the oldest can delete an old entry that its own process has just set again.
- **A value that isn't levels turns it off**, and says why once in a conversation: a toast and a line in the debug log, naming the first entry that isn't a level and what to write. A bare number under 1,000, such as `40`, is taken for a percentage without its `%`, and refused; so is a token count with a thousands separator (`400,000`: write `400000` or `400k`). A token count at or past the window's size is kept (windows differ between sessions), and the debug log says once that it never reminds in that session.

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
