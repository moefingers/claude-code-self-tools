// The stable way to call secret-run, run for real: the shim the plugin
// writes in the state folder starts the plugin's own copy, and the lines the
// plugin hands a session, run in Bash and in PowerShell 7, reach secret-run
// and the command word for word. The plugin's code is its own
// (hooks/shim.ts, loaded here with Node's type stripping); where it works
// out the state folder, it agrees with secret-run's own rule (where.mjs).
//
//   node --test plugins/self-secret/tools/secret-run/invocation.test.mjs

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ARGV, FAKE, SECRET_RUN, assertNoLeak, post, scratch, watch } from "./testkit.mjs";
import { stateFolder } from "./where.mjs";

const typescript = Boolean(process.features?.typescript);
/** The plugin's own code, when this Node can strip its types; else the tests that need it are skipped. */
const shim = typescript
  ? await import(new URL("../../hooks/shim.ts", import.meta.url).href)
  : null;
const skipTs = typescript ? false : "this Node can't load TypeScript (process.features.typescript)";

let tmp;
let state;
let printer;
let shimPath;

before(() => {
  tmp = scratch();
  state = join(tmp.dir, "state with space");
  mkdirSync(state, { recursive: true });
  printer = tmp.file("argv.mjs", ARGV);
  if (shim !== null) {
    shimPath = join(state, shim.SHIM_NAME);
    writeFileSync(shimPath, shim.shimText(SECRET_RUN));
  }
});

after(() => tmp.cleanup());

/** A child with the browser kept shut and this file's state folder, its output watched. */
function child(command, args, env = {}) {
  return watch(
    spawn(command, args, {
      env: {
        ...process.env,
        SECRET_PASTE_NO_BROWSER: "1",
        SELF_SECRET_HOME: state,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }),
  );
}

/** Words that a shell or a command line would change if they weren't quoted exactly. */
const AWKWARD = [
  "plain",
  "two words",
  "it's",
  'say "hi"',
  "$HOME",
  "`hostname`",
  "$(hostname)",
  "*",
  "a;b&c|d",
  "%PATH%",
  "‘curly’ quotes",
  "back\\slash\\",
  "/starts/with/slash",
  "-dash",
  "--",
  "é ü 😀",
  "",
];

/** Posts the made-up value to the form a run opens, and returns how the run ended. */
async function paste(run) {
  const url = await run.formUrl();
  assert.equal((await post(url, { v: FAKE })).status, 200);
  return run.done;
}

test("the shim names the plugin's own copy by a file URL, and holds nothing else", { skip: skipTs }, () => {
  const text = shim.shimText(SECRET_RUN);
  const lines = text.trim().split("\n");
  assert.equal(lines[0], "#!/usr/bin/env node");
  const imported = lines.filter((l) => !l.startsWith("#") && !l.startsWith("//"));
  assert.equal(imported.length, 1, "one line of code");
  const url = /^import "([^"]+)";$/.exec(imported[0])?.[1];
  assert.ok(url, imported[0]);
  assert.equal(fileURLToPath(url), SECRET_RUN);
  const awkward =
    process.platform === "win32"
      ? "C:\\Some Folder\\100%\\#1?\\tools\\secret-run.mjs"
      : "/some folder/100%/#1?/tools/secret-run.mjs";
  assert.equal(
    fileURLToPath(shim.fileUrl(awkward)),
    awkward,
    "a space, a percent sign, a hash and a question mark survive",
  );
});

test("the shim starts secret-run: a run through it pastes, runs and scrubs as the plugin's own copy does", { skip: skipTs }, async () => {
  const run = child(process.execPath, [
    shimPath,
    "generic",
    "--prompt",
    "Paste the made-up value",
    "--no-check",
    "--",
    process.execPath,
    "-e",
    "console.log('saw ' + process.env.SECRET)",
  ]);
  const { code, stdout, stderr } = await paste(run);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /^saw \[redacted\]$/m);
  assertNoLeak(stdout + stderr, FAKE);
  const listed = child(process.execPath, [shimPath, "--list"]);
  assert.match((await listed.done).stdout, /^generic {2}SECRET/m);
});

test("a shim whose copy is gone fails, naming it, and runs nothing", { skip: skipTs }, async () => {
  const gone = join(tmp.dir, "gone", "tools", "secret-run.mjs");
  const stale = tmp.file("stale-shim.mjs", shim.shimText(gone));
  const marker = join(tmp.dir, "ran-stale");
  const { code, stderr } = await child(process.execPath, [
    stale,
    "--list",
  ]).done;
  assert.notEqual(code, 0);
  assert.match(stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/);
  assert.ok(stderr.includes("secret-run.mjs"), stderr);
  assert.equal(existsSync(marker), false);
});

test("the Bash line reaches secret-run and the command word for word", { skip: skipTs || (spawnSync("bash", ["-c", "true"]).status !== 0 && "no bash here") }, async () => {
  const isWindows = process.platform === "win32";
  const asked = shim.askedOf({
    profile: "generic",
    options: ["--prompt", "Paste it's \"value\" $HOME", "--no-check"],
    command: [process.execPath, printer, ...AWKWARD],
  });
  assert.ok(!("refusal" in asked), asked.refusal);
  const line = shim.bashLine(shimPath, asked.args, isWindows);
  const script = tmp.file("line.sh", `${line}\n`);
  const run = child("bash", [script]);
  const { code, stdout, stderr } = await paste(run);
  assert.equal(code, 0, stderr);
  const words = JSON.parse(/^words (.*)$/m.exec(stdout)?.[1] ?? "null");
  assert.deepEqual(words, AWKWARD);
  assert.match(stderr, /the form for generic is at/);
});

/** PowerShell 7, when it is here. */
const pwsh = (() => {
  const r = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
})();

test("the PowerShell line reaches secret-run and the command word for word", { skip: skipTs || (pwsh === null && "no PowerShell 7 here") }, async () => {
  const asked = shim.askedOf({
    profile: "generic",
    options: ["--prompt", "Paste it's ‘value’ $env:HOME", "--no-check"],
    command: [process.execPath, printer, ...AWKWARD],
  });
  const line = shim.powershellLine(shimPath, asked.args);
  const script = tmp.file("line.ps1", `${line}\nexit $LASTEXITCODE\n`);
  const run = child("pwsh", ["-NoProfile", "-NonInteractive", "-File", script]);
  const { code, stdout, stderr } = await paste(run);
  assert.equal(code, 0, stderr);
  const words = JSON.parse(/^words (.*)$/m.exec(stdout)?.[1] ?? "null");
  assert.deepEqual(words, AWKWARD);
});

test("the plugin and secret-run place the state folder by the same rule", { skip: skipTs }, () => {
  for (const [env, platform] of [
    [{ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32"],
    [{ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local\\" }, "win32"],
    [{ LOCALAPPDATA: "C:/Users/u/AppData/Local" }, "win32"],
    [{ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", SELF_SECRET_HOME: "/d/keep" }, "win32"],
    [{ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", SELF_SECRET_HOME: "D:\\keep" }, "win32"],
    [{}, "win32"],
    [{ HOME: "/home/u", XDG_STATE_HOME: "/home/u/.state" }, "linux"],
    [{ HOME: "/home/u", XDG_STATE_HOME: "/home/u/.state/" }, "linux"],
    [{ HOME: "/home/u", XDG_STATE_HOME: "relative" }, "linux"],
    [{ HOME: "/home/u/" }, "darwin"],
  ]) {
    const node = stateFolder(env, platform, (env.HOME ?? "/home/u").replace(/\/+$/, ""));
    const plugin = shim.stateFolder(env, platform === "win32");
    assert.equal(plugin ?? null, node, `${JSON.stringify(env)} on ${platform}`);
  }
});

test("each mode's words are secret-run's own: the lines the plugin builds are taken by its parser", { skip: skipTs }, async () => {
  for (const [input, says] of [
    [{ mode: "list" }, /^generic {2}SECRET/m],
    [{ mode: "hold-status" }, /^No active holds\.$/m],
    [{ mode: "end-hold", profile: "nothing-held" }, /^No active hold for nothing-held\.$/m],
    [{ mode: "use-hold", profile: "nothing-held", command: ["node", "-e", ""] }, /no active hold for nothing-held/],
  ]) {
    const asked = shim.askedOf(input);
    const r = await child(process.execPath, [SECRET_RUN, ...asked.args]).done;
    assert.match(r.stdout + r.stderr, says, JSON.stringify(input));
    assert.notEqual(r.code, 64, `${JSON.stringify(input)} is no usage mistake`);
  }
  const hold = shim.askedOf({ mode: "hold", profile: "generic", minutes: 5, options: ["--prompt", "x", "--no-check"], command: ["node"] });
  const refused = await child(process.execPath, [SECRET_RUN, ...hold.args]).done;
  assert.equal(refused.code, 64);
  assert.match(refused.stderr, /a hold is for a named profile/, "secret-run judges what the words mean");
});
