# self-settings

Lets a session read this machine's plugin settings as the `/config` menu shows them, and change the few options on a fixed list through Claude Code's own `/config` writer. Every other option is read only: the owner changes it in `/config` by hand. Part of [claude-code-self-tools](../../README.md).

## Tools

### `settings_read`

Claude sees `mcp__self-settings__settings_read`. It takes `plugin` and `marketplace`, both optional, each matched exactly, and answers with the plugins' rows of `/config`, grouped by plugin, such as:

> self-compact (from claude-code-self-tools)
> - self-compact.compactReminder, "Compact reminder", text: "40%, 60%"; set (default ""); agents may set
> - self-compact.updateCheck, "Update check", choice of on, off: "on"; default; agents may set

- **Rows are the engine's.** It reads `$.config.list()`, the rows the `/config` menu would draw now, a hidden row left out, and keeps a plugin's rows only (the panel's own are left out).
- **Each row** says its key (`<plugin>.<field>`, as `settings_set` takes it), label, kind (a choice's options with it), value, whether it was set or is at its default, whether `settings_set` may change it (`agents may set`) or not (`owner only`), and its lock (a trusted source, such as managed settings, owns it).
- **Set or at its default.** A `/config` row carries no default, and the engine hands no plugin another plugin's `userConfig`. So self-settings knows the defaults of its own marketplace's plugins from a table of their manifests (`KNOWN` in `hooks/settings.ts`, held to every manifest in this repository by `scripts/settings-manifests.test.mjs`). They apply to a row from `claude-code-self-tools` only: for any other plugin, and for a same-name plugin from anywhere else, a row says `default unknown`. A plugin installed at another version than this release knows may declare another default.
- **A sensitive field is never read.** Its value is kept in secure storage, and it has no `/config` row at all. self-settings names one that has no row, from its table, as `sensitive: not shown`, for its own marketplace's plugins only, under a heading of rows from `claude-code-self-tools`; none of them declares one today. A row of a field its table marks sensitive, should one be listed, is hidden from anywhere: it reads `sensitive: not shown` whatever the row's provider says, since the mark is looked up by the row's key, the plugin it names and the field. Leaning toward hiding, a same-name plugin's row, another plugin's row of that key, and a row whose provider doesn't parse are hidden too.
- **A value that looks like a secret is never shown**, whatever field holds it: it reads `set (looks like a secret; not shown)`. That is a token's known prefix (`sk-`, `ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`, `github_pat_`, `glpat-`, `xox`, `eyJ`, `AKIA`, `AIza`) at the start of a word, a PEM block's `-----BEGIN`, a URL with a login (anything but whitespace before an `@`, so a password holding a `/` too), a query string or a fragment, or a run of 24 or more characters of the base64 alphabets but `/` (letters, digits, `_`, `+`, `=`, `-`) that holds both a letter and a digit. A value over 4,096 characters (4 KB) is hidden whole, and no pattern is run over it. The rule leans toward hiding: a long name with a digit in it is hidden too, and so is a URL with an `@` in its path. It is no guarantee either: a key cut by `/`, spaces or other marks into short runs can pass it. A path stays shown, since `/` cuts a run.
- **Where a row came from is the row's own word.** A row's key names its plugin by the bare name (`self-compact.compactReminder`), while its provider holds the plugin's ID, `<name>@<source>` as the engine writes it: `self-compact@claude-code-self-tools` from a marketplace, `<name>@inline` for a plugin loaded from a folder, `<name>@builtin` for a built-in one. Each heading names the plugin and where its rows came from: `from <marketplace>`, `loaded from a folder`, `built in`, or `source unknown` for a provider that doesn't parse as an ID (kept whole, as the name). Two plugins of one name from two places are two headings. The `plugin` filter matches the bare name; `marketplace` matches the rows' own source, exactly as the engine writes it (`inline` and `builtin` too), not the `enabledPlugins` setting.
- **The `enabledPlugins` setting** is read for `settings_set`'s second rule, through `$.settings.read({ key: 'enabledPlugins' })`: no other setting is read, and no file. One entry it can't read (a value other than true or false, or a key that isn't `<plugin>@<marketplace>`) leaves the whole setting unread: every `settings_set` is refused, and a read that lists a row says so in one line, every row `owner only`. A `marketplace` filter still matches by the rows' own source. `agents may set` follows `settings_set`'s own rules, so the two agree row by row.

### `settings_set`

Claude sees `mcp__self-settings__settings_set`. It takes `key` and `value`, and changes that one option, only when `key` is on the list exactly:

- `self-compact.compactReminder`;
- the `updateCheck` of every plugin of this marketplace that declares one, each written out: `self-check`, `self-chrome`, `self-clear`, `self-color`, `self-compact`, `self-context`, `self-desktop`, `self-exit`, `self-mcp`, `self-reload`, `self-remote-control`, `self-restart`, `self-secret`, `self-settings`, `self-switch`, `self-update` and `self-wake`.

Nothing else. Every other option, of any plugin, and every option a plugin adds later, is refused with these words and no others:

> owner only: /config by hand

- **Default deny, exactly.** The list is a frozen constant (`MAY_SET` in `hooks/settings.ts`). A key must equal an entry: nothing is trimmed, folded or decoded, so a key that differs by letter case, whitespace, a `@<marketplace>` part, a prefix, a suffix or a `../` is another key, and is refused. There is no reading of what an option does, and no "safe direction".
- **The row must come from this marketplace.** Its own provider must be the key's plugin from this marketplace, `<plugin>@claude-code-self-tools`. A row loaded from a folder (`@inline`), built in, from another marketplace, of another plugin, or whose provider doesn't parse is refused with the line above.
- **And the plugin must be this marketplace's alone.** A key names its plugin by the bare name, so a plugin of another marketplace that took a listed plugin's name, enabled beside this one, shares its keys. So the plugin the key names must be enabled from `claude-code-self-tools` and from no other marketplace, as the `enabledPlugins` setting says; anything else is refused with the line above: another marketplace's plugin of that name alone, both, a setting that can't be read or holds one entry that can't be (so a same-name plugin's entry is never skipped), and none at all (a plugin loaded with `--plugin-dir` is enabled by no marketplace, so its options are the owner's in `/config`).
- **The row is read first.** Exactly one row of that key must be listed (a hidden row is not, and is refused, though Claude Code's writer would take it), owned by the plugin the key names (a row the engine or another plugin owns under that key is refused with the line above), of the kind that plugin's manifest declares, from `KNOWN` (each `updateCheck` a choice of on and off, in that order; `compactReminder` a text; another kind is refused with the line above), unlocked, and the value must fit its kind (a choice's options, a text, a number, true or false). Its value before the change is shown. A value it already holds changes nothing.
- **The change goes through `$.config.set`**, as the person's own change in the menu would: through every other plugin's `config.set` hooks, which see it as a plugin's change naming self-settings as the engine names a plugin. By the live runs ("What ran") that is likely its ID, `self-settings@claude-code-self-tools`, not the bare name; no run has seen it. A refusal from one of them, or from Claude Code, is passed on as it came.
- **Read back.** The value after is read from `$.config.list()` again and shown beside the one asked when a hook changed it. A toast tells you what the option reads now, the value read back, not the one asked (or, when it couldn't be read back, the one asked, saying so). A value that looks like a secret is never shown back, in the answer or the toast.
- **Who sees the change.** The answer says: "This session reloads `<plugin>` on its own. Other open sessions may need /reload-plugins to see it." That says only what the engine's types (2.1.331) say: a plugin's options "are fixed for this activation: a change to them reloads the plugin and `register` runs again with the new object", and `$.config.set` changes a row "as if the person did in the menu". They don't say whether another open session picks the change up by itself. No run has shown either yet.

## Where each part runs

- **At `tool.call`, the refusals that need nothing read:** for `settings_set`, a key off the list first, whatever else the call carries and whoever calls (a subagent asking for one is told it is the owner's, never that the main session could change it); then a subagent (what these tools read and change is the machine's, for the main session); then an argument a tool doesn't take. The serving refuses in the same order.
- **At `tool.run`, the serving.** A call that passes goes on to Claude Code's own permission check, and the tools are served once it is allowed. Decided on principle: a tool that reads or changes settings stays under your permission rules, as self-desktop's tools do. Each serving holds every rule again on the input it receives, whatever ran before it; `settings_set` checks the key against the list once more right before `$.config.set`.
- **A call with no rules.** A call another plugin makes through `$.tool.call`, and a script the REPL tool runs, go through the hooks with no permission rules (the engine's 2.1.331 types, the `tool` noun). The list holds for them all the same: no call through this plugin changes an option off it.
- **No `config.set` hook.** self-settings polices only its own tool; it doesn't judge other plugins' changes.

## What it never does

- It never runs `claude plugin configure`, and never reads or writes a settings file or `~/.claude.json`. The engine's calls are its only way to settings: `$.config.list`, `$.config.set`, and `$.settings.read` of the one key above. The one file it reads is its own `plugin.json`, for the update check, as every plugin here does.
- It never reads a sensitive field's value, and never installs, enables or disables a plugin.

## Known limits

- **A row's provider is read as two live runs listed it:** the plugin's ID, `<name>@<source>` ("What ran"). A provider of another shape is no row of this marketplace's, so an engine that wrote one would have every set refused, and its plugins headed `source unknown`.
- **A list in `enabledPlugins`.** The settings schema lets an entry's value be a list of texts as well as true or false; what a list means isn't guessed, so one leaves the setting unread, and every `settings_set` is refused.
- **Defaults and sensitive fields** are known for this marketplace's plugins only, as this release's manifests declare them: a default for their rows alone; a sensitive field hidden on any row of its key, whatever the row's provider (one that can't be read, or another plugin's, included), and named, when it has no row, under this marketplace's heading alone. No field is marked sensitive yet.
- **A same-name row a hook hides.** If a hook hides a same-name plugin's row (one loaded from a folder, say), only this marketplace's row is listed, so `settings_set` counts one row, and `$.config.set` sets the bare key as the engine resolves it: Claude Code's `ConfigSetArgs` takes a key and a value, with no plugin ID. It is bounded: only the options on the list, and a plugin the owner loaded on their own machine.

## Not built

Reading another machine's settings.

## Tests

`tests/self-settings.test.ts` (with the engine stood in, each row's provider an ID as the engine lists it: the whole read answer, each heading where its rows came from (this marketplace, a folder, built in, another marketplace, a provider that doesn't parse), filters by name and by source, defaults for this marketplace's rows alone, a sensitive field named and hidden, its row hidden from elsewhere too, one with no row named under this marketplace's heading alone and not under a same-name plugin's from another marketplace or a folder, a row of one hidden by its key from every provider (this marketplace, a folder, another marketplace, another plugin's ID, one that doesn't parse) with no 4-character run of its value in the answer, `agents may set` against `settings_set`'s own verdict row by row, the secret rule as a table; every option on the list changed, a hook's refusal passed on, a value a hook changed, the answer and the toast for each way the read back goes, a value that looks like a secret never shown back; a locked row, a hidden row, a key that isn't a plugin's, another owner's row, a row whose provider isn't the key's plugin from this marketplace (as a table, near misses of the ID among them: a prefix or a suffix on the source, a zero-width space or a BOM at the end of the source or the start of the name, a look-alike letter in either, a trailing newline or tab), two rows of a key from two sources, unfit values, a plugin of that name from another marketplace only, from both, from none, or marketplaces that can't be read (the odd `enabledPlugins` entries as a table, and a set and a read under one), and every near-miss spelling refused, at the call and again at the serving, each where it is refused; a subagent refused, but for a key off the list, which gets the owner-only line), `tests/update-check.test.ts` (the shared update check's), and `scripts/settings-manifests.test.mjs` (every field of every manifest in the repository refused unless the list names it, a subagent's call too, every entry a field that is there and isn't sensitive, the list the frozen one, and the table the manifests' own).

## What ran

- **The public cloud gate on 0.1.2's heads**, on Linux, the repository's whole list:
  GATE: to be filled in before the merge.
- **The same gate on 0.1.1** (2026-11-27, before the merge) ran on each round's head: `d0b8714`, `f86a788`, `f972d85` and `c9b83cd`, the last being the head that merged. On each, the steps that fail on `main` failed the same way, and self-settings' own steps passed.
- **Two live runs read real `/config` rows** with `settings_read`: a session that loaded self-settings from a folder, and 0.1.0 installed from this marketplace. A row's key named its plugin by the bare name (`self-compact.compactReminder`); its provider was the plugin's ID, `<name>@<source>` (`self-compact@claude-code-self-tools`, `self-settings@inline` from a folder, `<name>@builtin` for a built-in plugin). 0.1.0 took the ID for the name, so its read said `default unknown` and `marketplace unknown` for every plugin, and by the same reading its filters matched nothing and every set was refused: closed, and of no use. 0.1.1 reads the ID, so it is the first release that can change the listed options on a real machine.
- **Not shown by any run:** 0.1.1 or 0.1.2 in a session; an option changed through `settings_set` on a real row; another session seeing a change; and `settings_set` changing `self-settings.updateCheck`, which reloads this plugin in the middle of its own call (the read back after it is caught if it fails).

## Update check

When Claude calls one of this plugin's tools, and the last check is 30 minutes old or there hasn't been one, the plugin checks whether a newer version is published. It fetches this plugin's `plugin.json` from the `main` branch of the repository its installed `plugin.json` names, [`plugins/self-settings/.claude-plugin/plugin.json`](https://raw.githubusercontent.com/moefingers/claude-code-self-tools/main/plugins/self-settings/.claude-plugin/plugin.json), and compares its `version` with the installed one.

- **A plain GET of a public file.** The plugin adds no headers, query or body, and sends nothing about you, the session or the machine. GitHub sees the request as it sees any web request: the address it comes from, the time, and the headers Claude Code sends on its own.
- **At most every 30 minutes.** The check's time and answer are kept in the plugin's own store, so a reload, or another session on this machine, uses that answer until it is 30 minutes old. Sessions that come due at the same moment each make their one request.
- **It never holds up the tool.** The check runs beside the call, which never waits on it. Offline, refused by policy, a 404, a rate limit, no answer within 5 seconds, or anything but a plain version such as `0.2.0` all mean no notice.
- **When a newer version is out**, a toast tells you, and the result of one of Claude's next calls ends with a line like this:

  > self-settings 0.1.0 is out of date (0.2.0 is published). To update, the person runs: claude plugin marketplace update claude-code-self-tools, then claude plugin update self-settings@claude-code-self-tools, then /reload-plugins in each open session (a new session loads the update on its own). Don't run these yourself unless the person asks.

  The line is fixed text. Only the two version numbers vary, and each must be three plain numbers. Nothing else from the fetched file reaches Claude. A session is told of each check once, and at most once every 30 minutes, not on every call, and the toast follows the same rule. A call carries only what an earlier check found: the call that starts a check doesn't wait for its answer.
- **Turn it off** with the plugin's `updateCheck` setting: `off` never checks. Set it in `/config`, or from your shell:

  ```
  echo '{"updateCheck":"off"}' | claude plugin configure self-settings@claude-code-self-tools --values-stdin
  ```

  Nothing is checked while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, to any value, or for a subagent's call.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-settings@claude-code-self-tools
```
