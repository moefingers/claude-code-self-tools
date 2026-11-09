# self-hierarchy

A skill for running several Claude Code sessions together on one machine as a hierarchy: one owner, a coordinator session, a merger session and lane sessions, with builder and reviewer subagents. It says who owns what, how a change goes from a build to a merge, and how the other plugins here keep each session healthy. Part of [claude-code-self-tools](../../README.md).

## Skill

`session-hierarchy` (Claude sees `self-hierarchy:session-hierarchy`; you can run it as `/self-hierarchy:session-hierarchy`). Claude loads it when a session is told it is the coordinator, the merger or a lane in a group of sessions, is briefed to start or join one, or is asked how one runs. It stays out of ordinary work in a single session.

It covers:

- **The roles.** The owner; the coordinator (priorities, routing, spawning, retiring and restarting sessions, plugin rollouts, broadcasts, conflicts between areas, the scope of rules); the merger (push asks, independent reviews, merge calls on findings, the merge queue, promotion prep); lanes, each owning an area; and builder and reviewer subagents, who do the work.
- **Who answers what.** A lane's "ship or hold?" goes to the merger alone. Work outside a session's area is flagged and routed, and another area's finding goes whole to the lane that owns it.
- **The review loop.** An independent reviewer gets the code and the questions, never the builder's conclusions. Blockers, Highs and Mediums go to the merger; Lows and Infos are filed and named in the PR body. A confirming read covers only the delta. Every push is asked for with its head sha, and pushes are bundled.
- **The owner's decisions**, one per question with a recommended option, each answer recorded where it was asked.
- **Messaging between sessions, heavy work and waiting**: name-addressed messages with a self-contained first line, one heavy job at a time above a free-memory floor, and an exit for every wait and every watch.
- **The self tools in a hierarchy**: what [compacting](../self-compact), [restarting](../self-restart), [clearing](../self-clear), [switching](../self-switch), [exiting](../self-exit), [waking](../self-wake), [reloading](../self-reload) and [checking tools](../self-check) cost, and when to use which; what an in-process `/clear` or `/resume` does to plugin state; same-tab restarts and launching sessions through the [claude wrapper](../../tools/claude-wrapper/claude-wrapper.ps1); names, Remote Control and optional role colours.
- **Pause and resume**, and what to write down before any break.

`SKILL.md` reads in one pass. `reference.md`, beside it, has each tool in detail, the lines that launch a session, and checklists for briefing a builder and a reviewer.

## How it behaves

- **A skill alone.** It has no hooks, no tools, no settings and no update check, and it makes no network request. It changes nothing on its own: it is text Claude reads.
- **It names the other plugins' tools.** A session uses only the tools of the plugins it has installed. Install the ones the skill's table names to use them.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-hierarchy@claude-code-self-tools
```

A new session loads it when it starts; in an open session, run `/reload-plugins`.
