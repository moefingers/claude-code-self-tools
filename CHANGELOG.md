# Changelog

Each entry names a plugin and its version, as `version` in `plugins/<name>/.claude-plugin/plugin.json` has it.

## 2026-11-01: the plugins say when they're out of date

Every plugin gets the same update check. Nothing else in them changed.

- When the main session calls one of a plugin's tools, and its last check is 30 minutes old or there hasn't been one, the plugin fetches its own `plugin.json` from the repository's `main` branch: a plain GET of a public file on raw.githubusercontent.com, with no headers, no query and nothing about the person, the session or the machine. It compares the `version` there with the installed one, number by number. The check's time and answer are kept in the plugin's own store, so a reload or another session on the machine uses that answer for the rest of the 30 minutes.
- The tool call never waits on the check. A failure is silence: offline, refused by policy, a 404, a rate limit, no answer within 5 seconds, bad JSON, or a version that isn't three plain numbers.
- When a newer version is out, a toast tells the person, and one of the session's next tool results ends with a fixed line: the plugin's name, the installed and the published versions, and the update steps for the person to run, closing with "Don't run these yourself unless the person asks." Nothing else from the fetched file reaches the session. A session is told once per check, so at most once every 30 minutes, rather than on every call: these tools are called again and again in a long session, and the same line on every call would cost context and get tuned out. The toast follows the same rule.
- New `updateCheck` setting, `on` by default; `off` never checks. Nothing is checked while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, or for a subagent's call.

The versions with it:

- **self-compact 0.2.3**: the update check, on `compact_after_turn`.
- **self-context 0.1.1**: the update check, on `context_usage`.
- **self-mcp 0.1.1**: the update check, on `reconnect_mcp_after_turn`.
- **self-reload 0.1.1**: the update check, on `reload_plugins_after_turn`.
- **self-remote-control 0.2.1**: the update check, on `remote_control`.
- **self-wake 0.1.1**: the update check, on `wake_after` and `cancel_wake`.

## self-remote-control 0.2.0 (2026-10-30)

Remote Control sessions get titles. The app takes a session's title as it connects, so a session connected with a bare `/remote-control` and no `/rename` title showed up as `<hostname>-<adjective>-<noun>`.

- `connect` takes an optional `name` and runs `/remote-control <name>`. Without one, it connects under the session's own title (its `/rename` or `--name` title, which the plugin reads from the SessionStart and UserPromptSubmit hook inputs), and bare if the session has none.
- New `rename` action, `name` required: once the turn ends it runs `/rename <name>`, and nothing else. A `/rename` while connected updated the title in the app too on Claude Code 2.1.314; if the app doesn't show it, the session needs reconnecting, or renaming in the app. `rename` and `connect` in one turn rename, then connect under the new title.
- New optional `resume`, as in self-mcp and self-reload: the message that starts the session's next turn once `connect` or `rename` has run, after what happened. A connect that doesn't take then starts a turn that says so. Without it, the toast and the note on Claude's next turn stay as they were.
- Corrected: run while the session is connected, `/remote-control` doesn't disconnect. In the interactive terminal it opens the Remote Control panel and waits for the person. The plugin never runs it then, as before.
- `status` also reports the session's title.
- The queued action is kept in session state under a new key, `queued`, in place of `connectQueued`.

## self-mcp 0.1.0 (2026-10-22)

New: `reconnect_mcp_after_turn` runs `/mcp reconnect <server>`, or `/mcp reconnect all`, once the turn ends: the typed form of the `/mcp` menu's Reconnect, so it runs unattended. Its outcome is Claude Code's own transcript line; the toast and the optional `resume`, or a note Claude reads on its next turn, point to it. It refuses subagents, and an interrupted turn cancels it.

## 2026-10-21: a marketplace of plugins

The repository is now `claude-code-self-tools`: a marketplace of separate plugins under `plugins/`, each installed by name, so you install only the ones you want.

- **self-compact 0.2.2** moves to `plugins/self-compact`, its behaviour unchanged. Its marketplace is now named `claude-code-self-tools`, so it installs as `self-compact@claude-code-self-tools`. If you installed it from the marketplace `claude-code-self-compact-plugin`, remove that marketplace (`claude plugin marketplace remove claude-code-self-compact-plugin`, which also uninstalls the plugin), then add this one and install again.
- **self-reload 0.1.0**, new: `reload_plugins_after_turn` runs `/reload-plugins` once the turn ends. An optional `resume` is written to session state before the reload and sent once, after it, by whichever copy of the plugin is running.
- **self-context 0.1.0**, new: `context_usage` reports the tokens used, the window, the percentage and whether auto-compact is on, for deciding at a break whether to compact. Read-only.
- **self-wake 0.1.0**, new: `wake_after` sends the session "Wake-up: <note>" some minutes after the turn ends, one wake-up at a time, armed again after a reload of the plugin; `cancel_wake` takes it back.
- **self-remote-control 0.1.0**, new: `remote_control` reports whether this session's Remote Control is connected, and connects it only when it reads as not connected, so it never toggles a live connection off.

Every new tool refuses subagents, and every action queued by a turn that is interrupted is cancelled.

## self-compact 0.2.2 (2026-10-21)

First public release.

- The `compact_after_turn` tool: the session queues a compaction of its own conversation, with `keep` as the summary instructions. It runs once the current turn ends, one compaction per call, so a session compacts per piece of work.
- Optional `resume`: once compacted, the session sends itself that message and carries on. One resume per compaction. If Claude Code skips the compaction, the resume is still sent and says so.
- An interrupted turn cancels the queued compaction and its resume.
- Subagents are refused, because only the main conversation can compact on demand. The refusal tells the subagent to finish its piece and return its result instead.
