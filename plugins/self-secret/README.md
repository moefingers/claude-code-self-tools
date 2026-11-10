# self-secret

Lets a session run a command with a secret it never sees. You paste the secret into a form in your own browser on this machine; it is checked before anything runs, handed to that one command in an environment variable, and masked in everything the command prints. A hold keeps it in memory for a while, so later commands run without another paste. Part of [claude-code-self-tools](../../README.md).

The command is `secret-run` (its local paste: there is nothing remote here, and nothing talks to a server of ours). The plugin ships it and keeps a stable path to it for use by hand; one tool hands a session the exact line to run. The plugin itself runs nothing, and no value ever passes through it.

## Tool

`secret_run_command` (Claude sees `mcp__self-secret__secret_run_command`) answers with the exact command line, for Bash and for PowerShell 7.3 or later (Standard argument passing), and what will happen when it runs. Both lines name the copy of secret-run that session loaded, so a session runs the version it has. It runs nothing itself.

- `mode`: `once` (the default: one paste, one command), `hold` (one paste, held for `minutes`, the first command run at once), `use-hold` (a command through the live hold, no paste), `end-hold`, `hold-status` or `list`.
- `profile`: one of your profiles (`list` shows them), or `generic`, which takes its prompt and check from `options`. Needed for `once`, `hold`, `use-hold` and `end-hold`.
- `minutes`: for `hold`, more than 0 and at most 120.
- `options`: more of secret-run's options, one word each, before the command (below). Never `--` (the line puts it before the command), a flag `mode` chooses (`--hold`, `--use-hold`, `--end-hold`, `--hold-status`, `--list`, `--help`, alone or as `--flag=value`), or `--profiles`: the line does what its mode says, with your own profiles.
- `command`: for `once`, `hold` and `use-hold`, the command to run with the secret, one word each, as its argv (no shell): `["gh", "secret", "set", "DEPLOY_TOKEN"]`.

A call is refused, saying why, when its parts don't make a line: an unknown mode, a profile name secret-run wouldn't take, `minutes` out of range or with another mode, no command for a mode that runs one, a command for one that doesn't, a word `options` may not hold, more than 256 words, or a word over 8,192 characters. What the words mean (whether a check URL is https, whether a profile exists) is secret-run's to judge when it runs; a usage mistake there exits 64 and runs nothing.

The PowerShell line is left out, saying why, when a word holds a double quote (`"`): Windows PowerShell 5.1, or PowerShell 7 with Legacy argument passing, would split that word into several, so secret-run could get options the line doesn't show. Use the Bash line then. On Windows the PowerShell line calls `node.exe` by that name, so a `node.cmd` earlier on `PATH` (which would hand the words to cmd.exe) is never what runs.

A subagent is refused by the tool: you paste at the main session's request, and should know which session asks. The subagent is told to return, saying which command needs which secret. That refusal is the tool's alone: secret-run can't tell who runs it, so a subagent (or any session) that writes the line itself, or runs `--use-hold` through a live hold, isn't stopped by it. The Bash permission prompt is where you see what runs.

## How a session asks

1. A command needs a secret the session doesn't have: an API key, a token, a password. The session never asks you to paste it into the chat.
2. It calls `secret_run_command`, and tells you what to paste and why. The form shows only its title and prompt, so the session's message is how you know what the paste is for.
3. It runs the line with the Bash tool, in the foreground, with the Bash tool's longest timeout (600000 ms): the form waits 300 seconds for your paste unless `--timeout <seconds>` says otherwise.
4. What comes back to the session is the command's output, with the value masked as `[redacted]`, and its exit code. secret-run's own lines on stderr start with `secret-run:`.

Never allow-list secret-run (or `node` with its path) in your permission rules. The Bash permission prompt is where you read the command a session asks to run with your secret, and which check it names; allow-listed, any of them runs unread, and a hold runs commands without a paste.

A line for a one-off key, with no profile:

```
MSYS_NO_PATHCONV=1 node C:/path/to/.claude/plugins/cache/claude-code-self-tools/self-secret/0.1.0/tools/secret-run.mjs generic --prompt 'Paste a token that can set repository secrets' --check-url https://api.github.com/user --check-header 'Authorization: Bearer {value}' -- gh secret set DEPLOY_TOKEN
```

`MSYS_NO_PATHCONV=1` is there on Windows so that Git Bash hands every word over as written; it would rewrite a word that starts with a slash as a Windows path.

## What you do at the machine

- **A tab opens** in your default browser at `http://127.0.0.1:<port>/?n=<nonce>`, headed with the profile's title, with the prompt under it and, when the profile names one, a link to the page where the key is made (a new tab, which learns nothing of the form's address). secret-run prints the same address on stderr, for when no browser opens.
- **That address opens the form once.** Your browser's first visit trades its nonce for a cookie and moves on to `http://127.0.0.1:<port>/`; after that, the address finds nothing anywhere else, so a copy of it (the printed line, a command line, the browser's history) is no use to anyone. Open it in one browser; that browser alone has the form.
- **Paste the key and submit.** As you paste, the page says what it will trim (a line break at the end, spaces at the start) and whether the key has its shape; a paste with a space or a line break inside the key isn't put in at all. The field is masked, and it is not a password field, so the browser doesn't offer to save it.
- **A wrong key is refused on the same page**, saying why (a shape it doesn't have, or the check's answer: `api.example.com answered 401 Unauthorized`), and the form asks again. Nothing runs until a key passes.
- **Cancel** ends it, and nothing runs. So does the timeout.
- **Once a key passes**, the page says what it reached (`the account <login>`, when the profile's check says), and stops answering. The command runs.
- Paste only when you expected the request: secret-run can't tell you which session asked, or what for. That is the session's message.

## Holds

`--hold <minutes>` (at most 120) keeps the value in the memory of a small broker process after it passes, and runs the first command at once. Later commands for the same profile run through it with `--use-hold`, without another paste: the broker runs each one itself, with the value in the profile's variable and its output masked, and streams back what it printed. The session never receives the value.

- A hold is for a named profile, never `generic` (one name would hold every generic secret).
- It serves only callers whose profile matches the one it was started for: its variable, check, shape and redaction patterns. A profile that differs only by its title, prompt or url uses it.
- It ends at its time, by the clock (a machine that slept past it wakes with it over); on `--end-hold <profile>`; when its record is removed; when its broker ends (signing out ends it). The broker holds for at most 120 minutes whatever it is asked.
- A command still running when it ends finishes, with the value: one started a minute before the end keeps it for as long as it runs (a shell fed from its stdin, say). The 120 minutes are how long the broker keeps it, not how long a command it started may.
- `--hold-status` lists each hold, its time left, and its uses by time and command name, never their arguments.

## The stable command

For use by hand (a CLAUDE.md line, a script of yours), the plugin keeps a stable copy of the command in the state folder, so a path to it stays the same across the plugin's updates:

| Where | The command |
| :- | :- |
| Windows, Git Bash | `node "$LOCALAPPDATA/claude-self-tools/secret-run.mjs"` |
| Windows, PowerShell | `node "$env:LOCALAPPDATA\claude-self-tools\secret-run.mjs"` |
| macOS, Linux | `node "${XDG_STATE_HOME:-$HOME/.local/state}/claude-self-tools/secret-run.mjs"` |

It is a short file that starts an installed copy of the plugin (`tools/secret-run.mjs` in it) and says which version wrote it. A session writes it when it starts, but only from an installed copy (never a `--plugin-dir` folder, a worktree or a checkout, whose code is no release) and only where there is none or the one there says a lower version. So the shim follows the highest version installed, a session still on an older version never takes it back, and an unreviewed checkout never takes it over. The tool's lines never name it. A shim left naming a version that's gone fails, naming the missing file, and runs nothing; removing it is safe, and the next session of an installed version writes it again. It needs Node.js 20 or later on `PATH`. Its words, as `secret-run --help` prints them:

```
secret-run <profile> [--hold <minutes>] [--timeout <s>] [--redact <regex>]... -- <command...>
secret-run <profile> --use-hold [--redact <regex>]... -- <command...>
secret-run --end-hold <profile>
secret-run --hold-status
secret-run --list
secret-run generic --prompt <text> (--check-url <url> [--check-header "Name: {value}"]... [--check-status <code>]... | --check-cmd <cmd> | --no-check) [--shape <regex> --shape-says <words>] [--spaces-inside] [--url <https url>] [--env-var NAME] -- <command...>
```

- `--redact <regex>` masks more of what this run prints. `--timeout <s>` is how long the form waits (300 by default). `--profiles <file>` reads another profiles file than your own.
- `generic`: `--prompt` and exactly one of `--check-url` (with `--check-header` and `--check-status` as it needs; 200 by default), `--check-cmd` (a shell command that reads the value on its stdin and exits 0 when it is right) or `--no-check`. The value is in `SECRET` unless `--env-var` names another variable. It runs once and is never held.
- Exit codes: the command's own; 1 nothing was run (cancelled, timed out, no hold) or a hold ended mid-run; 4 the form couldn't listen; 64 a usage mistake, said on stderr, and nothing run; 127 the command couldn't start.

## Profiles

A profile names what a secret is for. Your profiles are your own: they live in `secret-profiles.json` in the state folder, never in the plugin, and nothing ships but `generic` and an example ([`tools/secret-run/profiles.example.json`](tools/secret-run/profiles.example.json)). `secret-run --list` lists them and names the file. Without a file you have `generic` alone.

The state folder is `%LOCALAPPDATA%\claude-self-tools` on Windows, and `$XDG_STATE_HOME/claude-self-tools` (or `~/.local/state/claude-self-tools`) elsewhere; `SELF_SECRET_HOME` moves it (the tests use it).

**The state folder, and any profiles file, must be yours alone to change.** A profile says where a paste goes (its check) and what runs (a check's command), so secret-run reads none from a folder or file another account could change, and says which and why (exit 64, nothing run):

- elsewhere than Windows, one owned by another user than you or root, or that its group or others can write (`chmod go-w <path>` fixes yours), as OpenSSH holds its own files;
- on Windows, one owned by another account than you, SYSTEM or Administrators, or that an allow grant lets another account write (Users, Authenticated Users, Everyone).

So `SELF_SECRET_HOME` must name a folder only you can write. On Windows that rules out a folder on a second drive whose root lets every signed-in user change what is under it, as such drives often do; `%LOCALAPPDATA%` is yours alone. The same holds for a file named with `--profiles`.

A profile holds no secret. The file is a JSON object of profiles by name (lowercase letters, digits and hyphens, at most 64; keys that start with `$` are notes; `generic` is built in and can't be redefined):

```json
{
  "github-token": {
    "title": "GitHub token",
    "envVar": "GH_TOKEN",
    "prompt": "Paste a GitHub token for the gh command that asked for it.",
    "url": "https://github.com/settings/personal-access-tokens",
    "pattern": "github",
    "check": {
      "type": "http",
      "url": "https://api.github.com/user",
      "headers": { "Authorization": "Bearer {value}", "User-Agent": "secret-run" },
      "expectStatus": [200],
      "reached": "the account {login}"
    }
  }
}
```

| Field | What it is |
| :- | :- |
| `title` | The form's heading (the name when left out). |
| `envVar` | The variable the command reads the value from. Required. |
| `prompt` | What the form asks for. Required. |
| `url` | Optional: the page where the key is made, linked under the prompt. https, with no user name or password in it. |
| `check` | Required for a named profile: what the value must pass before anything runs (below). |
| `shape` | Optional: `{ "pattern": "<regex>", "says": "<words>" }`, the key's shape and the words the form finishes "it should ..." with. A value without it is refused before the check is asked. |
| `spacesInside` | Optional: `true` lets whitespace sit inside the value (a passphrase). Leading and trailing whitespace is always trimmed. |
| `pattern` | Optional: a kind of key from [`tools/secret-run/patterns.json`](tools/secret-run/patterns.json) (`github`, `neon`, `vercel-ai-gateway`), each from its vendor's documentation, which gives the shape, `spacesInside` and redaction patterns in its place. |
| `redact` | Optional: more regular expressions to mask in what the command prints (a pattern's come first). |

A check is one of:

- `{ "type": "http", "url": ..., "method": "GET", "headers": {...}, "expectStatus": [200], "reached": "...", "timeoutSeconds": 15 }`: a request made by secret-run itself, `{value}` where the value goes, in the path, query or headers only, never the host (a name lookup would carry it to a DNS server). The URL is https, or this machine. It passes when the status is one of `expectStatus`; `reached` is a template of dotted paths into its JSON answer (`{account.name}`) that the form and stderr show. It never follows a redirect, and reads at most 1 MiB of the answer.
- `{ "type": "command", "argv": [...] }` or `{ "type": "command", "shell": "..." }`, `"timeoutSeconds": 30`: a command that reads the value on its stdin and exits 0 when it is right; its first line of output is what it reached, its last line of stderr why not. One that runs out of time is ended with every process it started.

What a check, or its command, says is scrubbed of the value before the form shows it.

## Threat model

**What it guards against:**

- **The value in the conversation.** You type it into a page in your browser, never the chat, so the session, its transcript and Claude's context never hold it. The plugin never touches it: its tool reads no secret and starts no process, and its answers hold only paths, the session's own words and fixed text. Nothing of a value crosses the plugin's events, which other plugins' hooks can see.
- **A command that prints it by accident.** Everything the command writes, on stdout and stderr, is held until its line is complete and masked before it goes on: the value, each of its lines, its upper and lower case, its URL and form encodings, its JSON escapes (as other encoders print them too: `\u` escapes past ASCII or for `<`, `>` and `&`, and `\/`), its string-literal and HTML escapes, base64 (padded and not), base64url and hex, its UTF-16, its stretch of any longer base64 blob (an HTTP Basic header), and its base64 and hex wrapped at the usual widths; and each profile's patterns. A value split across writes is still caught. secret-run's own words, the hold-status list and the hold's record hold no value either.
- **Anything off this machine.** The form and the hold's broker listen on 127.0.0.1 alone, and the form's address is the one its socket says it listens on.
- **Another web page, or a copy of the address.** The form's address carries a random 32-character nonce, which your browser's first visit trades for the form's cookie (HttpOnly, SameSite=Strict), and so spends. Every later request must carry that cookie; without it the answer is 404, so a copy of the address that leaked (the printed line, a command line another user can read, the history) is dead once your browser has opened it. A web page can't learn either: the form tells no other page its address (a same-origin referrer policy; its link sends none), its link opens with no opener, and no page can frame it. A request for another Host (a DNS rebinding page) is refused, and so is a POST your browser marks as sent from another page (an `Origin` other than the form's own, `null` included, or its `Sec-Fetch-Site`), before anything else is looked at. The page's one script is allowed by its hash alone, and the page can send nothing anywhere but to itself.
- **The browser keeping it.** The field is masked text, not a password field, so the browser offers no save; every answer says `no-store`.
- **A wrong or mistyped key.** It is trimmed, held to its shape, then checked, before anything runs; the check's HTTP request is https or this machine.
- **A value left behind.** It is never written down. A hold keeps it in one process's memory for at most 120 minutes (the broker caps it itself), though a command already running through it keeps its copy until it ends (Holds, above). The broker takes no `NODE_OPTIONS` from its caller, and on a Node that offers `--disable-sigusr1` (22.14 or later; on 23, 23.7 or later) no inspector signal either; on an older Node, a process of your own user could switch its inspector on. Its folder of records (port, pid, a random token, never the value) is yours alone (`icacls` on Windows, mode 700 elsewhere).
- **Profiles another account planted.** A state folder or profiles file another account owns or can write is refused before any profile in it is read (Profiles, above), so no one else can point a profile's check at their own server or command.
- **Another local process at a hold's port.** Each side proves it holds the hold's token (an HMAC of the other's nonce) before the other acts: a caller sends nothing but a nonce until the broker has proved itself, and a broker runs nothing for a caller that hasn't. A record whose broker is gone is cleared, not used.
- **The value in argv.** It is in the one variable of the one command, and in no command line: not secret-run's, not the broker's, not the command's.

**What it doesn't guard against:**

- **A command written to leak it.** The session chooses the command, and the command has the value. One that prints it in pieces, reversed, in some encoding not listed above, or sends it over the network or into a file, gets it out. So does any command run through a hold, which needs no paste. Masking is for accidents. Read the command a session asks to run with a secret; the Bash call shows it.
- **A look-alike form.** A session that can run commands could open a page of its own that looks like this one. Paste only when you expected the request.
- **A command you didn't read.** The tool refuses a subagent, but secret-run itself can't tell who runs it; and an allow-listed secret-run runs whatever a session writes. The Bash permission prompt is the place to read it.
- **Another server on 127.0.0.1, while a form is open.** A browser keeps cookies by host, not by port, so a page you open at another `127.0.0.1` address while a form waits is sent the form's cookie; a server there of another user's could use it to answer the form first. It never learns your value.
- **Anything running as you.** A process of your user can read the hold records (the token), talk to a broker, or read a process's memory. secret-run keeps the value from the session's view, not from your own account.
- **Your browser and clipboard.** An extension with access to the page can read the field; a clipboard history keeps what you copied.
- **The check's endpoint.** It receives the value: that is the check. Name only the vendor's own API.
- **The partial forms redaction misses:** hex with spaces between its bytes, a value with a colour code inside it or wrapped at some other width, the first part of a value alone, rot13, and its letters in a mix of cases of their own (all upper and all lower case are caught).
- **Memory written to disk** by the system (a swap file, a crash dump) while a hold is live.

## What it keeps where

In the state folder: `secret-profiles.json` (yours, when you make it), `secret-run.mjs` (the stable command, for use by hand), and `secret-run/holds/<profile>.json` for each live hold: its profile, variable, fingerprint, port, pid, a random token and its times. Nothing else, and never a value. The plugin's own store holds only the update check's answer.

## Update check

When Claude calls this plugin's tool, and the last check is 30 minutes old or there hasn't been one, the plugin checks whether a newer version is published. It fetches this plugin's `plugin.json` from the `main` branch of the repository its installed `plugin.json` names, [`plugins/self-secret/.claude-plugin/plugin.json`](https://raw.githubusercontent.com/moefingers/claude-code-self-tools/main/plugins/self-secret/.claude-plugin/plugin.json), and compares its `version` with the installed one.

- **A plain GET of a public file.** The plugin adds no headers, query or body, and sends nothing about you, the session or the machine. GitHub sees the request as it sees any web request: the address it comes from, the time, and the headers Claude Code sends on its own.
- **At most every 30 minutes.** The check's time and answer are kept in the plugin's own store, so a reload, or another session on this machine, uses that answer until it is 30 minutes old. Sessions that come due at the same moment each make their one request.
- **It never holds up the tool.** The check runs beside the call, which never waits on it. Offline, refused by policy, a 404, a rate limit, no answer within 5 seconds, or anything but a plain version such as `0.2.0` all mean no notice.
- **When a newer version is out**, a toast tells you, and the result of one of Claude's next calls ends with a line like this:

  > self-secret 0.1.0 is out of date (0.2.0 is published). To update, the person runs: claude plugin marketplace update claude-code-self-tools, then claude plugin update self-secret@claude-code-self-tools, then /reload-plugins in each open session (a new session loads the update on its own). Don't run these yourself unless the person asks.

  The line is fixed text. Only the two version numbers vary, and each must be three plain numbers. Nothing else from the fetched file reaches Claude. A session is told of each check once, and at most once every 30 minutes, not on every call, and the toast follows the same rule. A call carries only what an earlier check found: the call that starts a check doesn't wait for its answer.
- **Turn it off** with the plugin's `updateCheck` setting: `off` never checks. Set it in `/config`, or from your shell:

  ```
  echo '{"updateCheck":"off"}' | claude plugin configure self-secret@claude-code-self-tools --values-stdin
  ```

  which saves it in settings.json as `"pluginConfigs": { "self-secret@claude-code-self-tools": { "options": { "updateCheck": "off" } } }`. Nothing is checked while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, to any value, or for a subagent's call.

## Develop

secret-run's tests are Node tests beside it, run with the repository's other checks (`node scripts/test-all.mjs`), or alone:

```
node --test "plugins/self-secret/tools/secret-run/*.test.mjs"
```

They drive the form over HTTP as a browser would, against a stand-in check, with made-up values built at run time and a state folder of their own; they never open a browser or read your profiles. The hooks module's tests run with `claude plugin test plugins/self-secret`.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-secret@claude-code-self-tools
```
