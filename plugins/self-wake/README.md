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

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-wake@claude-code-self-tools
```
