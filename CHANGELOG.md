# Changelog

Each version matches `version` in `.claude-plugin/plugin.json`.

## 0.2.2 (2026-10-21)

First public release.

- The `compact_after_turn` tool: the session queues a compaction of its own conversation, with `keep` as the summary instructions. It runs once the current turn ends, one compaction per call, so a session compacts per piece of work.
- Optional `resume`: once compacted, the session sends itself that message and carries on. One resume per compaction. If Claude Code skips the compaction, the resume is still sent and says so.
- An interrupted turn cancels the queued compaction and its resume.
- Subagents are refused, because only the main conversation can compact on demand. The refusal tells the subagent to finish its piece and return its result instead.
