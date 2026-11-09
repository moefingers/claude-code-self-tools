# self-remote-control

Lets a session report on its own [Remote Control](https://code.claude.com/docs/en/remote-control), the link that lets you follow and steer it from a phone or a browser, turn it on, and give itself a title the session list shows. Part of [claude-code-self-tools](../../README.md).

## Tool

`remote_control` (Claude sees `mcp__self-remote-control__remote_control`):

- `action` (required): `status`, `connect` or `rename`.
  - `status` answers with whether this session is connected, its title, the value of the `/config` setting for all sessions (`remoteControl`), and the clients attached now.
  - `connect` connects this session once the turn ends, if it isn't connected.
  - `rename` sets the session's title once the turn ends, with `/rename`, and does nothing else.
- `name`: the title. `rename` requires it. For `connect` it's optional: without it, the session connects under its own title (its `/rename` title) if it has one, and with no title if it doesn't. One line, at most 200 characters, the most `/rename` keeps.
- `resume` (optional, for `connect` and `rename`): the message that starts the session's next turn once the action has run, after what happened, saying what to do next.

## How it behaves

- **The title is set when the session connects.** The app's session list takes a session's title from `/remote-control <name>`, or else from its `/rename` title, at the moment it connects. With neither, the app titles the session from its last message, or with a name like `<hostname>-<adjective>-<noun>`. So `connect` passes a title.
- **`rename` runs `/rename` and nothing else.** A `/rename` while connected updated the title in the app as well when we tried it (Claude Code 2.1.314). If the app doesn't show the new title, the session needs reconnecting, or renaming in the app. `rename` never connects either: to do both, call `rename`, then `connect`, in the same turn, and the session is renamed, then connects under the new title.
- **How it knows the session's title.** Claude Code passes the session's custom title (set with `--name`, `/rename`, a hook's `sessionTitle`, or a rename from the app) to the SessionStart and UserPromptSubmit hooks as `session_title`. The plugin keeps the latest one, so `connect` knows the title as of the prompt that started the turn. A title Claude Code generated isn't a custom title and isn't passed on. With no title, `connect` runs `/remote-control` bare, as you would.
- **It never runs `/remote-control` while connected.** Run while the session is connected, `/remote-control` doesn't disconnect: in the interactive terminal it opens the Remote Control panel (the session's link, **Disconnect this session**, **Show QR code**, **Continue**) and waits for you. So `connect` runs it only when the session reads as not connected, and reads again right before it runs, holding [the Remote Control lock](#the-remote-control-lock) that other plugins take too. If the session connected in the meantime, or another plugin holds the lock, nothing runs. Disconnecting is yours, from that panel.
- **How it reads the connection.** Claude Code gives no other signal of whether this session is connected, so the plugin reads the `/remote-control` command's own description, which Claude Code works out from the connection each time it lists the command: `Disconnect Remote Control` while connected, `Control this session from your phone or claude.ai/code` while not. Any other description reads as unknown, and `connect` refuses rather than risk opening the panel. The attached clients don't tell you either: a connected session with no phone open shows only the terminal.
- **It waits for the turn to end.** The commands run once the turn ends with Claude's answer, and show in the transcript as if you had typed them. A few seconds later a toast says how it went. With `resume`, the session then sends itself what happened followed by "Resume: <resume>", which starts a new turn. Without it, the session waits for your message, and if the action didn't take, Claude is told on its next turn. If Claude Code doesn't take the resume, a toast says so and Claude gets that note instead.
- **Your message first, then no stale resume.** Claude Code runs anything already waiting when the turn ends (a message you typed during it) before the `connect` or `rename`. If you send a message after the `connect` or `rename` was queued and before its toast says how it went (typed during the turn, or while it waits to run), the `resume` isn't sent as a new message, since your message came after Claude asked to resume and is answered first. Claude gets it as a note instead, and a toast says so. Only your own messages count, at the terminal or from the app, slash commands included; one that a hook blocks doesn't. Anything else first (a background task's notification, a wake-up, another plugin's message) leaves the resume as it was, so the session doesn't sit idle.
  - **It keeps none of your words.** The plugin tells your message by the turn it was typed over (the turn id Claude Code gives it), never by its text: no prompt text is held, stored or logged.
  - **One known limit:** a message Claude Code delivers into the running turn, which Claude has read already, counts too. That resume then goes as a note, while you are there to see the toast.
- **Unavailable sessions are refused.** Without a claude.ai subscription, or where a policy turns Remote Control off, there is no command to run, and `connect` says so. `rename` still renames the session.
- **An interrupted turn cancels what it queued**, its resume included, with a notice.
- **Subagents can't use it.**

## After a login change

When the account this machine's Claude Code is signed in as changes, each session with the plugin reconnects its own Remote Control and picks up a turn the change cut off, without anyone typing. It doesn't matter how the login changed: `/login` in one session, or a tool that swaps the stored login file (for example when an account hits its usage limit).

What Claude Code does on its own (read from its source, 2.1.319): every running session re-reads the login file once its modification time changes. Remote Control stops in a session whose signed-in account changed. `/login` stops it when its dialog closes, saying *Login successful. Remote Control disconnected.* Other sessions stop it once the server confirms the new login belongs to another account (*signed-in claude.ai account or organization changed on this machine*). About ten seconds later the remote-control command reads as not connected again. A turn that the usage limit or a failed sign-in cut off stays where it stopped.

What the plugin adds, in each session:

1. **It notices the change.** Claude Code gives plugins no event for a login change, so the plugin checks every 5 seconds:
   - **The login file**: `.credentials.json` in `CLAUDE_CONFIG_DIR`, or `~/.claude`. It reads only the file's size and modification time, never its contents. That file changes on every token refresh too, so a change there only tells the plugin when to look further.
   - **The account record.** After the login file changes, the plugin reads the `oauthAccount` record in Claude Code's config file (`~/.claude.json`, or `.claude.json` in `CLAUDE_CONFIG_DIR`). Remote Control checks the same record. The plugin keeps only a hash of the account and organization ids, in the session's state. It never keeps or shows the ids, the email or anything else from the file.
   - **What counts as a change**: a record that names a different account at two checks in a row, about 5 seconds apart. One check alone isn't enough, so a swap that is undone at once isn't acted on. A refresh of the same account isn't a change, and neither is signing out.
   - **Where the login lives in a keychain** instead of a file, the plugin watches the config file itself, reading it at most every 30 seconds.
   - **If the plugin can't use the record**, for example because the config file is over the 4 MiB a plugin may read, or the record has no account id, it says so once in a toast that holds nothing from the file. It then does nothing after a login change.
2. **It reconnects Remote Control**, if it should be on. That means it read as connected when the new account was first seen, or the Remote Control for all sessions setting (`/config`, `remoteControl`) is `true`. It runs `/remote-control` under the session's title, the same way `connect` does.
   - **When it reads Remote Control**: only when it sees another account, right before a `/login` in this session, and while it handles a change, at most every 15 seconds. It never reads it on an idle session.
   - **When it runs the command**: only while it holds the Remote Control lock (below), and only on a reading of not connected taken after it took the lock.
   - **The old link.** Right after a change, the old link can still read as connected until it stops. So the plugin waits up to a minute for it to read as not connected. If it never does, nothing runs. The command doesn't depend on whether the change actually stopped Remote Control: whichever happened, the plugin ends up doing the right thing.
   - **A flapping login.** At most 3 reconnects in 10 minutes per session. Past that, one toast says the cap holds, once while it holds, and it waits for the login to settle. A change the cap held back leaves Remote Control down, since Claude Code stopped it at the switch, so it is owed: a change after it counts Remote Control as connected before, and once the oldest reconnect leaves the 10 minutes, it reconnects once more for the login as it is then, whatever account that is, even the last reconnect's, and says so in a toast of its own. It stays owed until a reconnect runs or it reads connected. Signed out then, nothing runs: signing in again is a change of its own, which reconnects it. After that toast, a new cap is told again.
   - **`/login` in this session.** It reads Remote Control before `/login` runs, because closing the login dialog turns it off. If it was connected then, it counts as connected before the change. It also waits until the dialog has closed before reconnecting.
3. **It reconnects Claude in Chrome**, once the Remote Control step settles, whatever its outcome, and before the resume. It runs `/mcp reconnect claude-in-chrome` in a session that lists Claude in Chrome's tools, or listed them before (a server the change dropped lists none). Claude in Chrome's cloud bridge routes by claude.ai account, and a session keeps the old account's connection until it reconnects. The reconnect starts the session's Chrome tab group over.
   - **Not where the coordinator plugin runs.** A session that lists the coordinator's tools (`mcp__coordinator__*`) has the coordinator reconnect Claude in Chrome, so this plugin leaves it alone there, and the toast says so, with the command to run if it doesn't reconnect. A coordinator that is off for the session's repo registers no tools, so a session there is reconnected here.
   - **Three looks.** A coordinator that is reloading lists no tools for a moment. So the plugin looks for its tools at once, 10 seconds after and 30 seconds after, and reconnects only when none of the three finds them. Coordinator tools listed earlier in the session and missing at all three looks, or a tool list that fails, leave Claude in Chrome alone, and the toast says so: never two reconnects.
   - **What the toast says**: that `/mcp reconnect` ran, which starts the tab group over (Claude Code's own line says whether it reconnected), that it hadn't finished within 15 seconds (queued or still running), or that it was refused, with the command to run by hand.
   - **The same cap as Remote Control's**: at most 3 reconnects in 10 minutes, so a flapping login doesn't start the tab group over each time. Past that, the toast says why not, once while the cap holds, and Claude in Chrome is reconnected once more with Remote Control when the oldest reconnect leaves the 10 minutes, if the login is then another account than its last reconnect's: its connection isn't stopped by a switch. A reconnect under way when the plugin reloads isn't run a second time, and the toast says so.
4. **It resumes the turn the change cut off.** If the session's last turn ended on an error a new login can clear, within the last 6 hours, and no turn has started since, the plugin sends exactly *There was a small interruption. Please resume from your last turn normally.*
   - **Errors a new login can clear**: the usage limit, a failed or refused sign-in, billing, and an outage. It doesn't resume after an invalid request, a too-long output, an unknown model, an error Claude Code classes as unknown, or one with no kind given, because those would likely fail the same way again.
   - **When it goes**: once per change, only after the reconnect has finished or failed, so your phone sees the resumed turn, and after Claude in Chrome's step. Then it waits the session's own delay, from 0 to 60 seconds, taken from the session's id. That way the sessions of one switch don't all start on the new account in the same second.
   - **A turn still running at the change**: the plugin waits for it. If that turn then ends on such an error, it gets resumed.
   - **A session at a finished break gets nothing.** A rewind past the cut-off turn isn't seen: the plugin API gives no cheap mark of the newest message, and listing the conversation copies up to 4096 messages in every session at once. The 6-hour limit bounds it.
   - **One resume per stop.** The coordinator plugin's auto-resume, or the owner's Resume on its page, may resume the same stop. Whoever takes the resume claim (below) first sends; the other sends nothing and says who resumed.
   - **The loop-breaker.** If the turn the resume started ends on an error at once (no usage, or in under 30 seconds), that conversation isn't resumed again until you type a prompt, at the terminal or from the app. A prompt you type while that turn runs counts too. A resumed turn that did real work before it hit the limit stays resumable.
5. **It shows one toast per change**, saying what happened. For example: *Login changed; Remote Control reconnected as "auth-refactor"; Claude in Chrome: /mcp reconnect ran, so its tab group starts over (Claude Code's own line says whether it reconnected); resumed: the turn ended on rate_limit 12 s ago.* The resume names the error kind its turn ended on and how long ago, in the toast and in a debug line, so a resume can be checked after the fact. While a cap holds, its line is told once: after that, a change's toast leaves it out, and a change with nothing else new to say (no reconnect that ran or failed, no resume) shows none.

The account seen and the servers seen are the machine's sign-in and the session's tools, not the conversation's: they outlive a `/clear` or a `/resume` run inside the process, though Claude Code empties a plugin's session state then. The plugin keeps a copy of each and puts it back, at each `/clear` or `/resume` and at the first read that finds it gone, so a login change after one is still seen, and one being handled then isn't dropped. The last turn and the resume's own record are the conversation's, and are forgotten at a move, so a `/clear` or a `/resume` never resumes a turn of the conversation left.

Nothing runs while a turn is running. To turn any part off, use the plugin's settings in `/config`, all three on by default:

- `reconnectOnLoginChange`: reconnect Remote Control after a login change.
- `resumeAfterLoginChange`: resume a cut-off turn after a login change.
- `reconnectChromeOnLoginChange`: reconnect Claude in Chrome after a login change, once the Remote Control step settles and before the resume, in a session with Claude in Chrome and no coordinator.

Or set them from your shell:

```
echo '{"reconnectOnLoginChange":false}' | claude plugin configure self-remote-control@claude-code-self-tools --values-stdin
```

With `reconnectOnLoginChange` and `resumeAfterLoginChange` both off, the plugin doesn't watch the login at all, so `reconnectChromeOnLoginChange` does nothing either.

## The resume claim

Two things can resume a session a usage limit stopped: this plugin's resume after a login change, and the coordinator plugin's auto-resume or the owner's Resume on its page. Each checks that no turn has run since the stop and then acts, so both could pass. The claim lets exactly one act. The protocol, the same in both plugins:

- **The file**: `%LOCALAPPDATA%\claude-self-tools\resumed\<session id>.<turn id>.json`. `<session id>` is the conversation the stop is recorded in: the one the last main-loop SessionStart of a startup, a resume or a clear named when the stopped turn ran, while `$.session.id()` still named the conversation left (it can for up to about 15 seconds after an in-process `/resume` or `/clear`), else `$.session.id()` then. It is never `$.session.id()` read when the claim is made, which right after a move back to a conversation may still name the other one. `<turn id>` is the `turnId` of the main-loop `turn.complete` whose `reason` was `error`: one per turn, the same in every plugin's hook. Both must be UUIDs.
- **What it holds**: `{"v":1,"by":"<name>","at":<ms>}` in UTF-8 with no BOM. `by` is `self-remote-control`, `coordinator` (its auto-resume) or `coordinator:owner` (the page's Resume).
- **Taking it**: only through the canonical CLAIM script (`CLAIM_SCRIPT` in `hooks/claim-script.ts`, SHA-256 `CLAIM_SHA256`, checked by `scripts/resume-claim.test.mjs`; the coordinator plugin pins the same), run the way the lock's scripts are, with `RESUME_CLAIM_PATH` and `RESUME_CLAIM_TEXT`. Right before the resume, it prints:
  - `claimed`: it created the file, so this one resumes;
  - `taken|<by>|<at>`: the file was there, so this one sends nothing and says who resumed;
  - `error|<why>`: no file could be made, so this one sends nothing.
- **It never overwrites or deletes a claim** of the stop it was given. A winner whose resume the engine refused or dropped, even after the plugin stopped waiting on it, gives the claim back with the lock's RELEASE script and its own text, so a later resume can claim it. So does a winner that finds a turn started while it claimed, or one that started and ended on the limit again (another stop, with a claim of its own): it sends nothing.
- **Clean-up**: each CLAIM deletes other claims untouched for 7 days.
- **Off Windows**, where no coordinator runs, the claim is kept in the session's own state, and the plugin resumes each stop at most once.
- **A stop recorded with no conversation** (a turn recorded before 0.4.1, the plugin reloaded since) claims nothing and resumes nothing, and the toast says why.

## The Remote Control lock

Run while a session is connected, `/remote-control` opens the Remote Control panel and waits for a person. So two plugins that both read *not connected* and both run it would leave the second run's panel open, holding the session.

Every plugin that runs `/remote-control` in a session on its own takes one lock per session first. That includes this plugin's `connect`, its reconnect after a login change, and the coordinator plugin's restart of Remote Control after a switch it made. The protocol, for any plugin that takes it:

- **The file**: `%LOCALAPPDATA%\claude-self-tools\rc\<sessionId>.lock`, where `<sessionId>` is `$.session.id()`.
- **What it holds**: `{"v":1,"by":"<plugin name>","at":<ms>}` in UTF-8 with no BOM, where `at` is when it was taken, in milliseconds since the epoch.
- **Taking and releasing it**: only through the two canonical scripts, run byte for byte. Each is one Windows PowerShell process (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive`). The script goes on standard input, run by the bootstrap `STDIN_BOOTSTRAP` in `hooks/rc-lock.ts`. The lock's path is passed in `RC_LOCK_PATH`, and the taker's text in `RC_LOCK_TEXT`, so the scripts' bytes never change. Their SHA-256 is pinned here (`TAKE_SHA256`, `RELEASE_SHA256` in `hooks/rc-lock.ts`, checked by `scripts/rc-lock.test.mjs`), and the coordinator plugin pins the same hashes.
  - **TAKE** (`TAKE_SCRIPT`) prints `taken`, or `held|<by>|<age ms>`.
    1. It creates the file exclusively.
    2. If the file is already there, it opens it with no sharing at all. Under that handle it judges the file's `at`, or the file's modification time when `at` can't be read. A lock over 90 seconds old, or over 90 seconds in the future, is stale.
    3. A stale lock is overwritten in place through the same handle. TAKE never deletes the lock, so two takers on one stale lock can't both win: the second can't open the file until the first has closed it, and by then it reads the first one's fresh `at`.
    4. It also deletes other sessions' lock files that have gone untouched for a day.
  - **RELEASE** (`RELEASE_SCRIPT`) prints `released`, `kept`, `gone` or `busy`.
    1. It opens the file letting others only delete it.
    2. It compares the file's text with the taker's own.
    3. If they match, it deletes the file while still holding that handle. Another taker's text is left untouched, so a release that comes late can't remove a lock someone else has since taken over.
- **Holding it**: from just before the fresh *not connected* reading until the session reads as connected, or for 60 seconds, whichever comes first. Then RELEASE.
- **Running**: run `/remote-control` only while holding the lock, and only after a reading of *not connected* taken after the lock was taken.
- **Who takes the file lock: any plugin that can place it.** That means `%LOCALAPPDATA%` is a plain folder, `$.session.id()` is a session id, and `%SystemRoot%` names the Windows folder. Gate on those three, not on the operating system's name, so that two plugins in one session either both use the file or neither does. Where this plugin can't place it, as off Windows, it uses a lock kept in the session's state instead, which only orders this plugin's own runs.

## Update check

When Claude calls one of this plugin's tools, and the last check is 30 minutes old or there hasn't been one, the plugin checks whether a newer version is published. It fetches this plugin's `plugin.json` from the `main` branch of the repository its installed `plugin.json` names, [`plugins/self-remote-control/.claude-plugin/plugin.json`](https://raw.githubusercontent.com/moefingers/claude-code-self-tools/main/plugins/self-remote-control/.claude-plugin/plugin.json), and compares its `version` with the installed one.

- **A plain GET of a public file.** The plugin adds no headers, query or body, and sends nothing about you, the session or the machine. GitHub sees the request as it sees any web request: the address it comes from, the time, and the headers Claude Code sends on its own.
- **At most every 30 minutes.** The check's time and answer are kept in the plugin's own store, so a reload, or another session on this machine, uses that answer until it is 30 minutes old. Sessions that come due at the same moment each make their one request.
- **It never holds up the tool.** The check runs beside the call, which never waits on it. Offline, refused by policy, a 404, a rate limit, no answer within 5 seconds, or anything but a plain version such as `0.3.0` all mean no notice.
- **When a newer version is out**, a toast tells you, and the result of one of Claude's next calls ends with a line like this:

  > self-remote-control 0.2.1 is out of date (0.3.0 is published). To update, the person runs: claude plugin marketplace update claude-code-self-tools, then claude plugin update self-remote-control@claude-code-self-tools, then /reload-plugins in each open session (a new session loads the update on its own). Don't run these yourself unless the person asks.

  The line is fixed text. Only the two version numbers vary, and each must be three plain numbers. Nothing else from the fetched file reaches Claude. A session is told of each check once, and at most once every 30 minutes, not on every call, and the toast follows the same rule. A call carries only what an earlier check found: the call that starts a check doesn't wait for its answer.
- **Turn it off** with the plugin's `updateCheck` setting: `off` never checks. Set it in `/config`, or from your shell:

  ```
  echo '{"updateCheck":"off"}' | claude plugin configure self-remote-control@claude-code-self-tools --values-stdin
  ```

  which saves it in settings.json as `"pluginConfigs": { "self-remote-control@claude-code-self-tools": { "options": { "updateCheck": "off" } } }`. Nothing is checked while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, to any value, or for a subagent's call.

## Install

```
/plugin marketplace add moefingers/claude-code-self-tools
/plugin install self-remote-control@claude-code-self-tools
```
