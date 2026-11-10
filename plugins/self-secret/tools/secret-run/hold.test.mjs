// A hold keeps the value in a broker's memory for as long as it was asked,
// runs later commands itself, answers only to its token, and ends when told,
// at expiry, or when its broker is gone. Nothing it writes, and nothing it
// says, holds the value.
//
//   node --test plugins/self-secret/tools/secret-run/hold.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exchange, holdFile, holdsDir, system32, writeHold } from "./hold.mjs";
import {
  FAKE,
  LEAKER,
  MARKER,
  SECRET_RUN,
  WHERE,
  assertNoLeak,
  fakeCheck,
  launch,
  page,
  post,
  profilesFile,
  scratch,
} from "./testkit.mjs";

let tmp;
let check;
let leaker;
let marker;
let where;
let profiles;
let state;
let home;

before(async () => {
  tmp = scratch();
  check = await fakeCheck(FAKE);
  leaker = tmp.file("leaker.mjs", LEAKER);
  marker = tmp.file("marker.mjs", MARKER);
  where = tmp.file("where.mjs", WHERE);
  profiles = profilesFile(tmp.dir, check.url);
  // The state folder, SELF_SECRET_HOME; the holds are in its secret-run/.
  state = join(tmp.dir, "state");
  home = join(state, "secret-run");
});

after(async () => {
  // Whatever a failed test left running ends here: the brokers this file started, by their own records.
  const dir = holdsDir(home);
  if (existsSync(dir))
    for (const name of readdirSync(dir)) {
      try {
        const { pid } = JSON.parse(readFileSync(join(dir, name), "utf8"));
        process.kill(pid);
      } catch {
        // already gone
      }
    }
  await check.close();
  tmp.cleanup();
});

const run = (args) => launch(SECRET_RUN, args, { home: state });
const record = (profile) =>
  JSON.parse(readFileSync(holdFile(home, profile), "utf8"));

/** Starts a hold on the stand-in profile and runs one command through it. */
async function startHold(minutes, command) {
  const cli = run([
    "stand-in",
    "--profiles",
    profiles,
    "--hold",
    minutes,
    "--",
    ...command,
  ]);
  const url = await cli.formUrl();
  const form = await page(url);
  const accepted = await post(url, { v: FAKE });
  return { cli, form, accepted, result: await cli.done };
}

/** Every principal an ACL names, from icacls. */
function principals(path) {
  const out = spawnSync(system32("icacls.exe"), [path], { encoding: "utf8" }).stdout;
  return out
    .split(/\r?\n/)
    .map((line, i) => (i === 0 ? line.slice(path.length) : line).trim())
    .filter((line) => line.includes(":("))
    .map((line) => line.slice(0, line.indexOf(":(")));
}

/** A process's own command line, as the system holds it. */
function commandLine(pid) {
  if (process.platform === "win32") {
    const ps = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    return spawnSync(
      ps,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).stdout;
  }
  return spawnSync("ps", ["-o", "args=", "-p", String(pid)], {
    encoding: "utf8",
  }).stdout;
}

/** Every file under a folder, with its text. */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = join(dir, d.name);
    return d.isDirectory() ? filesUnder(path) : [[path, readFileSync(path, "latin1")]];
  });
}

test("a hold takes one paste, and its first command runs through the broker, scrubbed", async () => {
  const { form, accepted, result } = await startHold("0.5", [
    process.execPath,
    leaker,
    "STAND_IN_KEY",
    "3",
  ]);
  assert.match(form.body, /held in memory for 30 seconds/);
  assert.match(accepted.body, /Held until/);
  assert.equal(result.code, 3, "the command's exit code is the caller's");
  assertNoLeak(result.stdout + result.stderr, FAKE);
  assert.match(result.stdout, new RegExp(`^length ${FAKE.length}$`, "m"));
  assert.match(result.stdout, /^split \[redacted\] end$/m);
  assert.match(result.stdout, /tail \[redacted\]$/);
  assert.match(result.stderr, /hold stand-in, use 1, \d\d:\d\d:\d\d, node/);
});

test("the hold's file holds a token and no value, readable by this user alone", () => {
  const path = holdFile(home, "stand-in");
  const text = readFileSync(path, "utf8");
  assertNoLeak(text, FAKE, "the hold file");
  const rec = JSON.parse(text);
  assert.deepEqual(Object.keys(rec).sort(), [
    "envVar",
    "expiresAt",
    "fingerprint",
    "pid",
    "port",
    "profile",
    "startedAt",
    "token",
  ]);
  assert.ok(rec.token.length >= 40, "a long random token");
  if (process.platform === "win32") {
    const me = userInfo().username.toLowerCase();
    for (const p of [holdsDir(home), path]) {
      const who = principals(p);
      assert.ok(who.length > 0, `icacls read ${p}`);
      for (const w of who)
        assert.equal(w.toLowerCase().split("\\").pop(), me, `${p} grants ${w}`);
    }
  } else {
    assert.equal(statSync(holdsDir(home)).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
});

test("nothing the hold wrote, and not the broker's command line, holds the value", () => {
  const written = filesUnder(state);
  assert.ok(written.length > 0, "the hold wrote its record");
  for (const [path, text] of written) assertNoLeak(text, FAKE, path);
  const line = commandLine(record("stand-in").pid);
  assert.match(line, /broker\.mjs/, "the broker's own command line was read");
  assertNoLeak(line, FAKE, "the broker's command line");
});

test("--use-hold runs another command without asking, and logs only its name", async () => {
  const cli = run([
    "stand-in",
    "--use-hold",
    "--",
    process.execPath,
    leaker,
    "STAND_IN_KEY",
  ]);
  const { code, stdout, stderr } = await cli.done;
  assert.equal(code, 0);
  assert.doesNotMatch(stdout + stderr, /\?n=/, "no form this time");
  assertNoLeak(stdout + stderr, FAKE);
  assert.match(
    stdout,
    new RegExp(`^length ${FAKE.length}$`, "m"),
    "the command had the value",
  );
  const use = stderr.split(/\r?\n/).find((l) => l.includes("use 2"));
  assert.ok(use, stderr);
  assert.doesNotMatch(
    use,
    /leaker|STAND_IN_KEY/,
    "the use is logged without its arguments",
  );
});

test("a command through a hold has the value in its one variable alone", async () => {
  const { code, stdout } = await run([
    "stand-in",
    "--use-hold",
    "--",
    process.execPath,
    where,
    "STAND_IN_KEY",
  ]).done;
  assert.equal(code, 0);
  assert.match(stdout, /^variables \["STAND_IN_KEY"\]$/m);
  assert.match(stdout, /^argv false$/m);
});

test("--hold-status lists the hold, its time left and its uses, and nothing else", async () => {
  const { code, stdout, stderr } = await run(["--hold-status"]).done;
  assert.equal(code, 0);
  assert.match(stdout, /stand-in\s+\d+ s left\s+3 uses/);
  assert.match(
    stdout,
    /^\s+use 1\s+\d\d:\d\d:\d\d\s+node/m,
    "each use, by name",
  );
  assert.match(stdout, /^\s+use 2\s+\d\d:\d\d:\d\d\s+node/m);
  assert.doesNotMatch(stdout, /leaker|STAND_IN_KEY/, "never its arguments");
  assertNoLeak(stdout + stderr, FAKE);
});

test("the broker answers only on this machine (its token: handshake.test.mjs)", async () => {
  const status = await exchange(record("stand-in"), { op: "status" });
  assert.equal(status.reply?.address, "127.0.0.1", "where its socket listens");
  assert.equal(status.reply.uses, 3);
});

test("--hold while a hold is active uses it, without another paste", async () => {
  // --timeout 5, here and in the tests below that expect no form: one that opened would give up in
  // seconds, and the test fail, rather than wait for a paste.
  const cli = run([
    "stand-in",
    "--profiles",
    profiles,
    "--timeout",
    "5",
    "--hold",
    "30",
    "--",
    process.execPath,
    "-e",
    "",
  ]);
  const { code, stdout, stderr } = await cli.done;
  assert.equal(code, 0);
  assert.doesNotMatch(stdout + stderr, /\?n=/);
  assert.match(stderr, /already held/);
  assert.match(stderr, /use 4/);
});

test("a hold is for a named profile: generic is refused one", async () => {
  // The reviewer's probe: a generic hold for FIRST_VAR served SECOND_VAR.
  const r = await run([
    "generic",
    "--prompt",
    "x",
    "--env-var",
    "FIRST_VAR",
    "--no-check",
    "--hold",
    "1",
    "--",
    process.execPath,
    "-e",
    "",
  ]).done;
  assert.equal(r.code, 64);
  assert.match(r.stderr, /named profile/);
});

test("a hold serves only the profile it was started for", async () => {
  const other = profilesFile(
    tmp.dir,
    check.url,
    { envVar: "OTHER_KEY" },
    "profiles-other.json",
  );
  const ran = join(tmp.dir, "ran-other");
  for (const how of ["--hold", "--use-hold"]) {
    const r = await run([
      "stand-in",
      "--profiles",
      other,
      ...(how === "--hold" ? ["--timeout", "5", "--hold", "5"] : ["--use-hold"]),
      "--",
      process.execPath,
      marker,
      ran,
    ]).done;
    assert.equal(r.code, 1, how);
    assert.match(r.stderr, /held for a different profile/, how);
  }
  assert.equal(existsSync(ran), false, "nothing ran");
});

test("--redact reaches a command run through a hold", async () => {
  const print = [process.execPath, "-e", "console.log('extra-12345 ok')"];
  for (const how of [["--use-hold"], ["--profiles", profiles, "--timeout", "5", "--hold", "5"]]) {
    const r = await run([
      "stand-in",
      ...how,
      "--redact",
      "extra-[0-9]+",
      "--",
      ...print,
    ]).done;
    assert.equal(r.code, 0, how.join(" "));
    assert.match(r.stdout, /^\[redacted\] ok$/m, how.join(" "));
  }
  const bad = await run([
    "stand-in",
    "--use-hold",
    "--redact",
    "(",
    "--",
    ...print,
  ]).done;
  assert.equal(bad.code, 64);
  const generic = await run([
    "stand-in",
    "--use-hold",
    "--prompt",
    "x",
    "--",
    ...print,
  ]).done;
  assert.equal(generic.code, 64, "a flag the hold would ignore is refused");
});

test("--end-hold ends it at once", async () => {
  const { pid } = record("stand-in");
  const ended = await run(["--end-hold", "stand-in"]).done;
  assert.equal(ended.code, 0);
  assert.match(ended.stdout, /Ended the hold for stand-in/);
  assert.equal(existsSync(holdFile(home, "stand-in")), false);
  const status = await run(["--hold-status"]).done;
  assert.match(status.stdout, /No active holds/);
  const ran = join(tmp.dir, "ran-after-end");
  const refused = await run([
    "stand-in",
    "--use-hold",
    "--",
    process.execPath,
    marker,
    ran,
  ]).done;
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /no active hold for stand-in/);
  assert.equal(existsSync(ran), false, "nothing ran");
  assert.ok(await gone(pid), "the broker exited");
  const again = await run(["--end-hold", "stand-in"]).done;
  assert.equal(again.code, 0);
  assert.match(again.stdout, /No active hold for stand-in/);
});

test("a hold ends by itself when its time is up", async () => {
  const { result } = await startHold("0.05", [process.execPath, "-e", ""]);
  assert.equal(result.code, 0);
  const { pid } = record("stand-in");
  assert.ok(await gone(pid, 8000), "the broker exited at expiry");
  assert.equal(existsSync(holdFile(home, "stand-in")), false);
  const ran = join(tmp.dir, "ran-after-expiry");
  const refused = await run([
    "stand-in",
    "--use-hold",
    "--",
    process.execPath,
    marker,
    ran,
  ]).done;
  assert.equal(refused.code, 1);
  assert.equal(existsSync(ran), false);
});

test("a hold ends by the clock, not a timer alone: past its expiry nothing runs", async () => {
  // A machine that slept past expiresAt wakes with the timer still pending;
  // every request and the two-second watch read the clock. A record whose
  // expiry is earlier than the broker's own shortens the hold the same way.
  await startHold("1", [process.execPath, "-e", ""]);
  const rec = record("stand-in");
  writeHold(home, {
    ...rec,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const ran = join(tmp.dir, "ran-past-expiry");
  const refused = await run([
    "stand-in",
    "--use-hold",
    "--",
    process.execPath,
    marker,
    ran,
  ]).done;
  assert.equal(refused.code, 1);
  assert.equal(existsSync(ran), false);
  assert.ok(await gone(rec.pid, 4000), "the broker ended");
});

test("a hold whose broker is gone (the session ended) is cleared, not used", async () => {
  await startHold("1", [process.execPath, "-e", ""]);
  const { pid } = record("stand-in");
  process.kill(pid);
  assert.ok(await gone(pid));
  const status = await run(["--hold-status"]).done;
  assert.match(status.stdout, /No active holds/);
  assert.equal(
    existsSync(holdFile(home, "stand-in")),
    false,
    "the stale file is removed",
  );
  const refused = await run([
    "stand-in",
    "--use-hold",
    "--",
    process.execPath,
    "-e",
    "",
  ]).done;
  assert.equal(refused.code, 1);
});

test("a hold whose record is deleted ends", async () => {
  await startHold("1", [process.execPath, "-e", ""]);
  const { pid } = record("stand-in");
  rmSync(holdFile(home, "stand-in"));
  assert.ok(await gone(pid, 6000), "the broker noticed and exited");
});

test("without --hold nothing is held", async () => {
  const cli = run([
    "stand-in",
    "--profiles",
    profiles,
    "--",
    process.execPath,
    "-e",
    "",
  ]);
  await post(await cli.formUrl(), { v: FAKE });
  assert.equal((await cli.done).code, 0);
  assert.equal(existsSync(holdFile(home, "stand-in")), false);
  assert.match((await run(["--hold-status"]).done).stdout, /No active holds/);
});

test("the broker does not take the caller's NODE_OPTIONS (an --inspect there would open it)", async () => {
  const seen = join(tmp.dir, "node-options-seen.txt");
  const hook = tmp.file(
    "hook.cjs",
    `require("node:fs").appendFileSync(${JSON.stringify(seen)}, require("node:path").basename(process.argv[1] ?? "-") + "\\n");`,
  );
  const cli = launch(
    SECRET_RUN,
    [
      "stand-in",
      "--profiles",
      profiles,
      "--hold",
      "1",
      "--",
      process.execPath,
      "-e",
      "",
    ],
    { home: state, env: { NODE_OPTIONS: `--require "${hook.replace(/\\/g, "/")}"` } },
  );
  await post(await cli.formUrl(), { v: FAKE });
  assert.equal((await cli.done).code, 0);
  const loaded = readFileSync(seen, "utf8");
  assert.match(loaded, /secret-run\.mjs/, "the caller took them");
  assert.doesNotMatch(loaded, /broker\.mjs/, "the broker did not");
  await run(["--end-hold", "stand-in"]).done;
});

test("--hold is limited to 120 minutes", async () => {
  for (const bad of ["0", "-1", "121", "soon"]) {
    // --timeout 5: were the cap gone, the form would give up in seconds rather than wait for a paste.
    const r = await run([
      "stand-in",
      "--profiles",
      profiles,
      "--timeout",
      "5",
      "--hold",
      bad,
      "--",
      "node",
    ]).done;
    assert.equal(r.code, 64, bad);
    // -1 reads as an option, and the parser refuses it first.
    assert.match(r.stderr, bad === "-1" ? /ambiguous/ : /at most 120/, bad);
  }
});

test("the broker itself holds for at most 120 minutes, whatever its caller asks", () => {
  // The broker's beginHold, run in a process of its own (it ends its process when its hold ends),
  // with no form: the caller's own checks are passed over.
  const clampHome = join(tmp.dir, "clamp-home");
  const broker = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "broker.mjs")).href;
  const harness = tmp.file(
    "clamp.mjs",
    `import { beginHold } from ${JSON.stringify(broker)};
const started = Date.now();
const r = await beginHold({
  profile: { name: "clamp", envVar: "CLAMP", fingerprint: "f", redact: [] },
  minutes: Number(process.argv[2]),
  value: "made-up-for-the-clamp",
  home: process.argv[3],
});
const held = r.status === "ok" ? (Date.parse(r.expiresAt) - started) / 60000 : null;
console.log(JSON.stringify({ status: r.status, message: r.message ?? null, held }));
if (r.status === "ok") r.end();
else process.exit(0);
`,
  );
  for (const [asked, status, low, high] of [
    ["100000", "ok", 119.9, 120.05],
    ["121", "ok", 119.9, 120.05],
    ["120", "ok", 119.9, 120.05],
    ["30", "ok", 29.9, 30.05],
    ["0", "broker-error"],
    ["-5", "broker-error"],
    ["NaN", "broker-error"],
  ]) {
    const r = spawnSync(process.execPath, [harness, asked, clampHome], {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    const got = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "null");
    assert.equal(got?.status, status, `${asked}: ${r.stdout}${r.stderr}`);
    if (status === "ok")
      assert.ok(got.held > low && got.held <= high, `${asked} held ${got.held} minutes`);
    else assert.match(got.message, /a hold lasts more than 0 minutes/, asked);
  }
  const left = existsSync(holdsDir(clampHome)) ? readdirSync(holdsDir(clampHome)) : [];
  assert.deepEqual(left, [], "each hold ended, its record cleared");
});

test("a hold's form links to its profile's url, and a profile that differs by its url alone uses the hold", async () => {
  const linked = profilesFile(
    tmp.dir,
    check.url,
    { url: "https://keys.example.com/new" },
    "profiles-linked.json",
  );
  const cli = run([
    "stand-in",
    "--profiles",
    linked,
    "--hold",
    "1",
    "--",
    process.execPath,
    "-e",
    "",
  ]);
  const url = await cli.formUrl();
  assert.match(
    (await page(url)).body,
    /<a href="https:\/\/keys\.example\.com\/new" target=_blank rel="noopener noreferrer">Make one at keys\.example\.com<\/a>/,
  );
  await post(url, { v: FAKE });
  assert.equal((await cli.done).code, 0);
  const ran = join(tmp.dir, "ran-without-url");
  const r = await run([
    "stand-in",
    "--profiles",
    profiles,
    "--use-hold",
    "--",
    process.execPath,
    marker,
    ran,
  ]).done;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(existsSync(ran), true, "the url is not in the fingerprint");
  const flag = await run([
    "stand-in",
    "--use-hold",
    "--url",
    "https://keys.example.com/new",
    "--",
    "node",
  ]).done;
  assert.equal(flag.code, 64, "--url means nothing with --use-hold");
  await run(["--end-hold", "stand-in"]).done;
});

/** True once the process is gone, false if it outlives the wait. */
async function gone(pid, ms = 5000) {
  for (let waited = 0; waited < ms; waited += 100) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(100);
  }
  return false;
}
