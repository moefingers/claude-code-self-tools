# self-settings

Lets a session read this machine's plugin settings as the `/config` menu shows them, and change the few options on a fixed list through Claude Code's own `/config` writer. Every other option is read only: the owner changes it in `/config` by hand. Part of [claude-code-self-tools](../../README.md).

## Tools

### `settings_read`

Claude sees `mcp__self-settings__settings_read`. It takes `plugin` and `marketplace`, both optional, each matched exactly, and answers with the plugins' rows of `/config`, grouped by plugin, such as:

> self-compact (marketplace claude-code-self-tools)
> - self-compact.compactReminder, "Compact reminder", text: "40%, 60%"; set (default ""); agents may set
> - self-compact.updateCheck, "Update check", choice of on, off: "on"; default; agents may set

- **Rows are the engine's.** It reads `$.config.list()`, the rows the `/config` menu would draw now, a hidden row left out, and keeps a plugin's rows only (the panel's own are left out).
- **Each row** says its key (`<plugin>.<field>`, as `settings_set` takes it), label, kind (a choice's options with it), value, whether it was set or is at its default, whether `settings_set` may change it (`agents may set`) or not (`owner only`), and its lock (a trusted source, such as managed settings, owns it).
- **Set or at its default.** A `/config` row carries no default, and the engine hands no plugin another plugin's `userConfig`. So self-settings knows the defaults of its own marketplace's plugins from a table of their manifests (`KNOWN` in `hooks/settings.ts`, held to every manifest in this repository by `scripts/settings-manifests.test.mjs`). For any other plugin a row says `default unknown`. A plugin installed at another version than this release knows may declare another default.
- **A sensitive field is never read.** Its value is kept in secure storage, and it has no `/config` row at all. self-settings names one, from its table, as `sensitive: not shown`, for its own marketplace's plugins; none of them declares one today.
- **A value that looks like a secret is never shown**, whatever field holds it: it reads `set (looks like a secret; not shown)`. That is a token's known prefix (`sk-`, `ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`, `github_pat_`, `glpat-`, `xox`, `eyJ`, `AKIA`, `AIza`) at the start of a word, a PEM block's `-----BEGIN`, a URL with a login (anything but whitespace before an `@`, so a password holding a `/` too), a query string or a fragment, or a run of 24 or more characters of the base64 alphabets but `/` (letters, digits, `_`, `+`, `=`, `-`) that holds both a letter and a digit. The rule leans toward hiding: a long name with a digit in it is hidden too, and so is a URL with an `@` in its path. It is no guarantee either: a key cut by `/`, spaces or other marks into short runs can pass it. A path stays shown, since `/` cuts a run.
- **The marketplace** each plugin is enabled from comes from the `enabledPlugins` setting's value alone, through `$.settings.read({ key: 'enabledPlugins' })`: no other setting is read, and no file. A plugin loaded with `--plugin-dir` is enabled by no marketplace, and reads `marketplace unknown`. `agents may set` follows `settings_set`'s own rules, the marketplace's among them, so the two agree row by row.

### `settings_set`

Claude sees `mcp__self-settings__settings_set`. It takes `key` and `value`, and changes that one option, only when `key` is on the list exactly:

- `self-compact.compactReminder`;
- the `updateCheck` of every plugin of this marketplace that declares one, each written out: `self-check`, `self-chrome`, `self-clear`, `self-color`, `self-compact`, `self-context`, `self-desktop`, `self-exit`, `self-mcp`, `self-reload`, `self-remote-control`, `self-restart`, `self-secret`, `self-settings`, `self-switch`, `self-update` and `self-wake`.

Nothing else. Every other option, of any plugin, and every option a plugin adds later, is refused with these words and no others:

> owner only: /config by hand

- **Default deny, exactly.** The list is a frozen constant (`MAY_SET` in `hooks/settings.ts`). A key must equal an entry: nothing is trimmed, folded or decoded, so a key that differs by letter case, whitespace, a `@<marketplace>` part, a prefix, a suffix or a `../` is another key, and is refused. There is no reading of what an option does, and no "safe direction".
- **The plugin must be this marketplace's alone.** A `/config` row names its plugin by name, not by marketplace, so a plugin of another marketplace that took a listed plugin's name would match its key. So the plugin the key names must be enabled from `claude-code-self-tools` and from no other marketplace, as the `enabledPlugins` setting says; anything else is refused with the line above: another marketplace's plugin of that name alone, both, a setting that can't be read, and none at all (a plugin loaded with `--plugin-dir` is enabled by no marketplace, so its options are the owner's in `/config`).
- **The row is read first.** Exactly one row of that key must be listed (a hidden row is not, and is refused, though Claude Code's writer would take it), owned by the plugin the key names (a row the engine or another plugin owns under that key is refused with the line above), unlocked, and the value must fit its kind (a choice's options, a text, a number, true or false). Its value before the change is shown. A value it already holds changes nothing.
- **The change goes through `$.config.set`**, as the person's own change in the menu would: through every other plugin's `config.set` hooks, which see it as `origin: { kind: 'plugin', name: 'self-settings' }`. A refusal from one of them, or from Claude Code, is passed on as it came.
- **Read back.** The value after is read from `$.config.list()` again and shown beside the one asked when a hook changed it. A toast tells you what was set. A value that looks like a secret is never shown back, in the answer or the toast.
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

- **A plugin of this marketplace loaded from a folder** (`--plugin-dir`) is enabled by no marketplace, so `settings_set` refuses its options: it can't tell that plugin from another of the same name.
- **The key's spelling is the types' word.** `<plugin>.<field>` is how the engine's types name a plugin's row; no run has listed one yet. A session that spelled it otherwise would refuse every key, saying so, until the list follows.
- **Defaults and sensitive fields** are known for this marketplace's plugins only, as this release's manifests declare them.

## Not built

Reading another machine's settings.

## Tests

`tests/self-settings.test.ts` (with the engine stood in: the whole read answer, filters, sensitive fields, the secret rule as a table; every option on the list changed, a hook's refusal passed on, a value a hook changed, a value that looks like a secret never shown back; a locked row, a hidden row, a key that isn't a plugin's, another owner's row, unfit values, and every near-miss spelling refused, at the call and again at the serving; a subagent refused), `tests/update-check.test.ts` (the shared update check's), and `scripts/settings-manifests.test.mjs` (every field of every manifest in the repository refused unless the list names it, every entry a field that is there and isn't sensitive, the list the frozen one, and the table the manifests' own).

## What ran

Nothing yet: the tests and the type check were written with the plugin and have not run.

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
