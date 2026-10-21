# Changelog

Each entry names a plugin and its version, as `version` in `plugins/<name>/.claude-plugin/plugin.json` has it.

## 2026-10-21: a marketplace of plugins

The repository is now `claude-code-self-tools`: a marketplace of separate plugins under `plugins/`, each installed by name, so you install only the ones you want.

- **self-compact 0.2.2** moves to `plugins/self-compact`, its behaviour unchanged. Its marketplace is now named `claude-code-self-tools`, so it installs as `self-compact@claude-code-self-tools`. If you installed it from the marketplace `claude-code-self-compact-plugin`, remove that marketplace (`claude plugin marketplace remove claude-code-self-compact-plugin`, which also uninstalls the plugin), then add this one and install again.
- **self-reload 0.1.0**, new: `reload_plugins_after_turn` runs `/reload-plugins` once the turn ends. An optional `resume` is written to session state before the reload and sent once, after it, by whichever copy of the plugin is running.
- **self-context 0.1.0**, new: `context_usage` reports the tokens used, the window, the percentage and whether auto-compact is on, for deciding at a break whether to compact. Read-only.
- **self-config 0.1.0**, new: `set_effort` (through `/effort`) and `set_model` (through the `/config` Model row) switch the effort level and the model once the turn ends, announced from the old value to the new. They change nothing else.
- **self-wake 0.1.0**, new: `wake_after` sends the session "Wake-up: <note>" some minutes after the turn ends, one wake-up at a time, armed again after a reload of the plugin; `cancel_wake` takes it back.
- **self-remote-control 0.1.0**, new: `remote_control` reports whether this session's Remote Control is connected, and connects it only when it reads as not connected, so it never toggles a live connection off.

Every new tool refuses subagents, and every action queued by a turn that is interrupted is cancelled.

## self-compact 0.2.2 (2026-10-21)

First public release.

- The `compact_after_turn` tool: the session queues a compaction of its own conversation, with `keep` as the summary instructions. It runs once the current turn ends, one compaction per call, so a session compacts per piece of work.
- Optional `resume`: once compacted, the session sends itself that message and carries on. One resume per compaction. If Claude Code skips the compaction, the resume is still sent and says so.
- An interrupted turn cancels the queued compaction and its resume.
- Subagents are refused, because only the main conversation can compact on demand. The refusal tells the subagent to finish its piece and return its result instead.
