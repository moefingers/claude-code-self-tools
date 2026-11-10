#!/usr/bin/env node
/**
 * Runs a command with a secret its caller never sees: pasted into a form in
 * the person's browser on this machine, checked before anything runs, handed
 * to the command in an environment variable, and scrubbed from everything the
 * command prints. The self-secret README is the whole account.
 *
 *   secret-run <profile> [--hold <minutes>] [--timeout <s>] [--redact <regex>]... -- <command...>
 *   secret-run <profile> --use-hold [--redact <regex>]... -- <command...>
 *   secret-run --end-hold <profile>
 *   secret-run --hold-status
 *   secret-run --list
 *   secret-run generic --prompt <text> (--check-url <url> [--check-header "Name: {value}"]...
 *       [--check-status <code>]... | --check-cmd <shell command> | --no-check)
 *       [--shape <regex> --shape-says <words>] [--spaces-inside] [--url <https url>]
 *       [--env-var <NAME>] -- <command...>
 *
 * A profile (the person's own secret-profiles.json in the state folder,
 * secret-run/where.mjs, or --profiles <file>) names the variable, the form's
 * words, the page where the key is made (--url), the check and the redaction
 * patterns; --redact <regex> adds one for a run. generic is built in: its
 * prompt and check are the command line's, and it runs once. --hold keeps the
 * value in a broker's memory for that many minutes (120 at most) after it
 * passes, and later commands run through it with --use-hold.
 *
 * Exit codes: the command's own; 1 nothing was run (cancelled, timed out, no
 * hold) or a hold ended mid-run; 4 the form could not listen; 64 a usage
 * mistake; 127 the command could not start.
 */

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { runCheck } from "./secret-run/check.mjs";
import { captureSecret, openBrowser } from "./secret-run/form.mjs";
import { json } from "./secret-run/frames.mjs";
import {
  MAX_HOLD_MINUTES,
  clearHold,
  exchange,
  holdHome,
  liveHold,
  liveHolds,
  pidAlive,
  readHold,
  startHold,
} from "./secret-run/hold.mjs";
import {
  GENERIC_ONLY,
  PROFILE_NAME,
  UsageError,
  loadProfiles,
  nativePath,
  profilesPath,
  resolveProfile,
} from "./secret-run/profiles.mjs";
import { redactor } from "./secret-run/redact.mjs";
import { exitCodeOf, spawnScrubbed } from "./secret-run/run.mjs";

const OPTIONS = {
  hold: { type: "string" },
  "use-hold": { type: "boolean" },
  "end-hold": { type: "string" },
  "hold-status": { type: "boolean" },
  list: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  timeout: { type: "string" },
  profiles: { type: "string" },
  redact: { type: "string", multiple: true },
  prompt: { type: "string" },
  "env-var": { type: "string" },
  "check-url": { type: "string" },
  "check-header": { type: "string", multiple: true },
  "check-status": { type: "string", multiple: true },
  "check-cmd": { type: "string" },
  "no-check": { type: "boolean" },
  shape: { type: "string" },
  "shape-says": { type: "string" },
  "spaces-inside": { type: "boolean" },
  url: { type: "string" },
};

const USAGE = `secret-run <profile> [--hold <minutes>] [--timeout <s>] [--redact <regex>]... -- <command...>
secret-run <profile> --use-hold [--redact <regex>]... -- <command...>
secret-run --end-hold <profile>
secret-run --hold-status
secret-run --list
secret-run generic --prompt <text> (--check-url <url> [--check-header "Name: {value}"]... [--check-status <code>]... | --check-cmd <cmd> | --no-check) [--shape <regex> --shape-says <words>] [--spaces-inside] [--url <https url>] [--env-var NAME] -- <command...>
--profiles <file> reads another profiles file than your own.
The whole account: the self-secret README`;

const say = (line) => process.stderr.write(`secret-run: ${line}\n`);
const clock = (at, seconds = false) =>
  new Date(at).toTimeString().slice(0, seconds ? 8 : 5);
const duration = (minutes) => {
  if (minutes < 1) return `${Math.round(minutes * 60)} seconds`;
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
};
const left = (until) => {
  const ms = Math.max(0, Date.parse(until) - Date.now());
  return ms < 120_000
    ? `${Math.ceil(ms / 1000)} s`
    : `${Math.ceil(ms / 60_000)} min`;
};

/** Exits once everything written has reached the caller. */
async function exit(code) {
  await new Promise((r) => process.stdout.write("", r));
  await new Promise((r) => process.stderr.write("", r));
  process.exit(code);
}

function formOpened(name) {
  return (url) => {
    const opened = openBrowser(url);
    say(
      `the form for ${name} is at ${url}${opened ? " (opening it in your browser)" : "; open it in a browser"}.`,
    );
  };
}

const rejected = (reason) =>
  say(`that key didn't work (${reason}); the form asks again.`);

/** What the form says when the paste does not end the asking. */
function endedWithout(result, timeoutSec) {
  if (result.status === "cancelled") say("cancelled; nothing was run.");
  else if (result.status === "timeout")
    say(`no key within ${timeoutSec} s; nothing was run.`);
  else if (result.status === "bind-error") {
    say(`couldn't open the form: ${result.message}`);
    return 4;
  } else say(`${result.message ?? result.status}; nothing was run.`);
  return 1;
}

/** A hold of this name held for another profile (another variable, check or patterns). */
function heldForAnother(name, record, fingerprint) {
  if (!fingerprint || record.fingerprint === fingerprint) return false;
  say(
    `${name} is held for a different profile (its variable is ${record.envVar}); nothing was run. End it first: secret-run --end-hold ${name}`,
  );
  return true;
}

/**
 * Runs the command through the profile's live hold. The request carries the
 * caller's environment, as a command run here would have it, and the
 * caller's --redact patterns; it is sent only once the broker has proved it
 * holds the hold's token (hold.mjs). fingerprint, when the caller's profile
 * is known, must be the hold's.
 */
async function runThroughHold(home, name, command, { redact = [], fingerprint } = {}) {
  const record = readHold(home, name);
  const none = () => {
    say(
      `no active hold for ${name}; start one with: secret-run ${name} --hold <minutes> -- <command>`,
    );
    return 1;
  };
  if (!record) return none();
  if (!pidAlive(record.pid)) {
    clearHold(home, record);
    return none();
  }
  if (heldForAnother(name, record, fingerprint)) return 1;
  const result = await exchange(
    record,
    {
      op: "run",
      argv: command,
      cwd: process.cwd(),
      env: process.env,
      redact,
    },
    {
      stdin: process.stdin,
      onFrame(type, body) {
        if (type === "U") {
          const use = json(body);
          say(
            `hold ${use.profile}, use ${use.use}, ${clock(use.at, true)}, ${use.command}`,
          );
        } else if (type === "O") process.stdout.write(body);
        else if (type === "R") process.stderr.write(body);
      },
    },
  );
  if (result.timedOut) {
    say(`the hold for ${name} did not answer; nothing was sent.`);
    return 1;
  }
  if (result.connectError || result.notBroker) {
    clearHold(home, record);
    return none();
  }
  if (result.error === "ended") return none();
  if (result.error) {
    say(
      `the hold refused the command (${result.message ?? result.error}); nothing was run.`,
    );
    return 1;
  }
  if (!result.exit) {
    say("the hold ended before the command finished.");
    return 1;
  }
  if (result.exit.error) {
    say(result.exit.error);
    return 127;
  }
  return exitCodeOf(result.exit);
}

/** --list: each profile's name, variable and title, then the file they came from. */
function list(file) {
  const all = loadProfiles(file);
  for (const [name, p] of Object.entries(all))
    process.stdout.write(`${name}  ${p.envVar}  ${p.title ?? ""}\n`);
  const path = profilesPath(file);
  process.stdout.write(
    existsSync(path)
      ? `(from ${path}; generic is built in)\n`
      : `(no profiles file at ${path} yet: generic alone. The self-secret README, Profiles, says how to add yours.)\n`,
  );
  return 0;
}

async function main(argv) {
  const sep = argv.indexOf("--");
  const before = sep >= 0 ? argv.slice(0, sep) : argv;
  const command = sep >= 0 ? argv.slice(sep + 1) : [];
  let parsed;
  try {
    parsed = parseArgs({
      args: before,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const { values: flags, positionals } = parsed;

  if (flags.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (flags["hold-status"]) {
    const holds = await liveHolds(holdHome());
    if (!holds.length) process.stdout.write("No active holds.\n");
    for (const { record, status } of holds) {
      process.stdout.write(
        status
          ? `${record.profile}  ${left(status.expiresAt)} left  ${status.uses} ${status.uses === 1 ? "use" : "uses"}${status.running ? `  ${status.running} running` : ""}\n`
          : `${record.profile}  not answering (broker pid ${record.pid})\n`,
      );
      for (const u of status?.recent ?? [])
        process.stdout.write(
          `    use ${u.use}  ${clock(u.at, true)}  ${u.command}\n`,
        );
    }
    return 0;
  }
  if (flags["end-hold"] !== undefined) {
    const name = flags["end-hold"];
    if (!PROFILE_NAME.test(name))
      throw new UsageError(`${name} is not a profile's name`);
    const live = await liveHold(holdHome(), name);
    if (!live) {
      process.stdout.write(`No active hold for ${name}.\n`);
      return 0;
    }
    const silent = () => {
      process.stdout.write(
        `The hold for ${name} did not answer; its broker is pid ${live.record.pid}.\n`,
      );
      return 1;
    };
    if (!live.status) return silent();
    const { reply, timedOut } = await exchange(live.record, { op: "end" });
    if (timedOut) return silent();
    const still = reply?.running
      ? ` ${reply.running} command still running keeps its copy until it exits.`
      : "";
    process.stdout.write(`Ended the hold for ${name}.${still}\n`);
    return 0;
  }
  const profilesFile = flags.profiles ? nativePath(flags.profiles) : undefined;
  if (flags.list) return list(profilesFile);

  if (positionals.length !== 1)
    throw new UsageError("name one profile (secret-run --list shows them)");
  const name = positionals[0];
  if (!command.length) throw new UsageError("give the command after --");
  command[0] = nativePath(command[0]);

  if (flags["use-hold"]) {
    if (flags.hold !== undefined)
      throw new UsageError("--hold or --use-hold, not both");
    if (!PROFILE_NAME.test(name))
      throw new UsageError(`${name} is not a profile's name`);
    // A flag the hold would ignore is refused rather than ignored.
    const ignored = [...GENERIC_ONLY, "timeout"].find(
      (f) => flags[f] !== undefined,
    );
    if (ignored)
      throw new UsageError(`--${ignored} means nothing with --use-hold`);
    try {
      redactor("", flags.redact ?? []);
    } catch (err) {
      throw new UsageError(err.message);
    }
    // When the name is a profile here, the hold must be held for it.
    let fingerprint;
    try {
      fingerprint = resolveProfile(name, {}, profilesFile).fingerprint;
    } catch {
      // Not a profile in this file: the hold's own profile is the one used.
    }
    return runThroughHold(holdHome(), name, command, {
      redact: flags.redact,
      fingerprint,
    });
  }

  const profile = resolveProfile(name, flags, profilesFile);
  const timeoutSec = flags.timeout === undefined ? 300 : Number(flags.timeout);
  if (!(timeoutSec > 0))
    throw new UsageError(`--timeout takes seconds, not ${flags.timeout}`);

  if (flags.hold !== undefined) {
    const minutes = Number(flags.hold);
    if (!(minutes > 0 && minutes <= MAX_HOLD_MINUTES))
      throw new UsageError(
        `--hold takes minutes, more than 0 and at most ${MAX_HOLD_MINUTES}, not ${flags.hold}`,
      );
    // Its prompt and check are the command line's, so one name would hold
    // every generic secret: a generic secret runs once.
    if (profile.fromCommandLine)
      throw new UsageError(
        `a hold is for a named profile; ${name} runs once. Add a profile to ${profilesPath(profilesFile)} (the self-secret README, Profiles) to hold it.`,
      );
    const home = holdHome();
    const live = await liveHold(home, name);
    if (live && !live.status) {
      say(`the hold for ${name} did not answer; nothing was run.`);
      return 1;
    }
    if (live) {
      if (heldForAnother(name, live.record, profile.fingerprint)) return 1;
      say(
        `${name} is already held (${left(live.status.expiresAt)} left); using that hold.`,
      );
      return runThroughHold(home, name, command, {
        redact: flags.redact,
        fingerprint: profile.fingerprint,
      });
    }
    const started = await startHold({
      profile,
      minutes,
      timeoutSec,
      home,
      note: `Once it passes, it is held in memory for ${duration(minutes)}, so later commands can use it without asking again. It is never written down. End it sooner with secret-run --end-hold ${name}.`,
      onUrl: formOpened(name),
      onRejected: rejected,
    });
    if (started.status !== "ok") return endedWithout(started, timeoutSec);
    say(
      `the key works${started.reached ? `; it reached ${started.reached}` : ""}.`,
    );
    say(
      `holding ${name} for ${duration(minutes)}, until ${clock(started.expiresAt)}; end it sooner with secret-run --end-hold ${name}.`,
    );
    return runThroughHold(home, name, command, {
      fingerprint: profile.fingerprint,
    });
  }

  const result = await captureSecret({
    title: profile.title,
    prompt: profile.prompt,
    url: profile.url,
    note: "Used once, in memory, by the command that asked for it, and never written down. This page stops answering once a key passes.",
    timeoutSec,
    check: (v) => runCheck(profile.check, v, redactor(v, profile.redact).scrub),
    shape: profile.shape,
    spacesInside: profile.spacesInside,
    onListening: formOpened(name),
    onRejected: rejected,
  });
  if (result.status !== "ok") return endedWithout(result, timeoutSec);
  say(
    `the key works${result.reached ? `; it reached ${result.reached}` : ""}.`,
  );
  const red = redactor(result.value, profile.redact);
  const run = spawnScrubbed(
    command,
    { env: { ...process.env, [profile.envVar]: result.value } },
    red,
    {
      out: (b) => process.stdout.write(b),
      err: (b) => process.stderr.write(b),
    },
  );
  const ended = await run.done;
  if (ended.error) {
    say(red.scrub(`couldn't start ${command[0]} (${ended.error})`));
    return 127;
  }
  return exitCodeOf(ended);
}

try {
  await exit(await main(process.argv.slice(2)));
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  say(err.message);
  say("secret-run --help shows how to call it.");
  await exit(64);
}
