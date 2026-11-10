// The profiles are the person's own, in one place that stays put across the
// plugin's updates; generic is built in; the example that ships resolves;
// and nothing of the remote paste is left to call.
//
//   node --test plugins/self-secret/tools/secret-run/profiles.test.mjs

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveProfile } from "./profiles.mjs";
import { SECRET_RUN, launch, scratch } from "./testkit.mjs";
import { PROFILES_NAME, nativePath, stateFolder } from "./where.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = join(here, "profiles.example.json");

let tmp;
let state;

before(() => {
  tmp = scratch();
  state = join(tmp.dir, "state");
});

after(() => tmp.cleanup());

const run = (args, home = state) => launch(SECRET_RUN, args, { home });

test("the state folder: SELF_SECRET_HOME, else %LOCALAPPDATA%\\claude-self-tools, else the XDG state folder", () => {
  const local = "C:\\Users\\u\\AppData\\Local";
  assert.equal(
    stateFolder({ LOCALAPPDATA: local }, "win32"),
    "C:\\Users\\u\\AppData\\Local\\claude-self-tools",
  );
  assert.equal(
    stateFolder({ LOCALAPPDATA: `${local}\\` }, "win32"),
    "C:\\Users\\u\\AppData\\Local\\claude-self-tools",
    "a trailing separator",
  );
  assert.equal(
    stateFolder({ LOCALAPPDATA: "C:/Users/u/AppData/Local" }, "win32"),
    "C:\\Users\\u\\AppData\\Local\\claude-self-tools",
    "forward slashes",
  );
  assert.equal(stateFolder({}, "win32"), null, "no %LOCALAPPDATA%: none");
  assert.equal(
    stateFolder({ XDG_STATE_HOME: "/home/u/.state" }, "linux", "/home/u"),
    "/home/u/.state/claude-self-tools",
  );
  assert.equal(
    stateFolder({ XDG_STATE_HOME: "relative" }, "linux", "/home/u"),
    "/home/u/.local/state/claude-self-tools",
    "a relative XDG_STATE_HOME is passed over",
  );
  assert.equal(
    stateFolder({}, "darwin", "/Users/u"),
    "/Users/u/.local/state/claude-self-tools",
  );
  assert.equal(
    stateFolder({ SELF_SECRET_HOME: "/d/keep", LOCALAPPDATA: local }, "win32"),
    "D:/keep",
    "SELF_SECRET_HOME first, a Git Bash spelling read as Windows reads it",
  );
  assert.equal(nativePath("/c/x/y", "linux"), "/c/x/y", "off Windows, as it is");
  assert.equal(PROFILES_NAME, "secret-profiles.json");
});

test("with no profiles file yet: generic alone, and --list says where the file goes", async () => {
  const { code, stdout } = await run(["--list"]).done;
  assert.equal(code, 0);
  assert.match(stdout, /^generic {2}SECRET {2}A secret for one command$/m);
  assert.equal(stdout.trim().split("\n").length, 2, "generic, and the note");
  assert.ok(
    stdout.includes(`(no profiles file at ${join(state, "secret-profiles.json")} yet: generic alone.`),
    stdout,
  );
  assert.equal(existsSync(state), false, "listing makes nothing");
});

test("the person's own file, in the state folder, is read with generic first", async () => {
  const mine = join(tmp.dir, "mine");
  mkdirSync(mine, { recursive: true });
  writeFileSync(
    join(mine, "secret-profiles.json"),
    JSON.stringify({
      $comment: "notes are skipped",
      "my-key": {
        title: "My key",
        envVar: "MY_KEY",
        prompt: "Paste my key.",
        check: { type: "http", url: "https://api.example.com/me" },
      },
    }),
  );
  const { code, stdout } = await run(["--list"], mine).done;
  assert.equal(code, 0);
  assert.deepEqual(
    stdout.trim().split("\n"),
    [
      "generic  SECRET  A secret for one command",
      "my-key  MY_KEY  My key",
      `(from ${join(mine, "secret-profiles.json")}; generic is built in)`,
    ],
  );
  const unknown = await run(["nope", "--", "node"], mine).done;
  assert.equal(unknown.code, 64);
  assert.match(unknown.stderr, /there are: generic, my-key\. Add yours to /);
});

test("a file can't redefine generic, and one that isn't JSON or an object is refused", async () => {
  const bad = (name, text) => {
    const dir = join(tmp.dir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "secret-profiles.json"), text);
    return dir;
  };
  for (const [dir, says] of [
    [bad("redefines", JSON.stringify({ generic: { envVar: "X", prompt: "x", check: null } })), /has a profile named generic, which is built in/],
    [bad("not-json", "{ not json"), /couldn't read the profiles in/],
    [bad("a-list", "[]"), /not an object of profiles by name/],
  ]) {
    const r = await run(["--list"], dir).done;
    assert.equal(r.code, 64, dir);
    assert.match(r.stderr, says, dir);
  }
  const missing = await run(["--list", "--profiles", join(tmp.dir, "no-such.json")]).done;
  assert.equal(missing.code, 64, "a file named with --profiles must be there");
  assert.match(missing.stderr, /couldn't read the profiles in/);
});

test("the example that ships lists, and each of its profiles resolves whole", async () => {
  const text = readFileSync(EXAMPLE, "utf8");
  const names = Object.keys(JSON.parse(text)).filter((n) => !n.startsWith("$"));
  assert.deepEqual(names, ["github-token", "example-service", "signing-passphrase"]);
  for (const name of names) {
    const p = resolveProfile(name, {}, EXAMPLE);
    assert.equal(p.name, name);
    assert.ok(p.check, `${name} has a check`);
    assert.equal(p.fromCommandLine, false);
  }
  assert.equal(
    resolveProfile("github-token", {}, EXAMPLE).shape.says,
    "start with ghp_, gho_, ghu_, ghs_, ghr_ or github_pat_ and have no spaces",
    "its pattern gives its shape",
  );
  const listed = await run(["--list", "--profiles", EXAMPLE]).done;
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /^github-token {2}GH_TOKEN {2}GitHub token$/m);
});

test("nothing ships that is anyone's own: the plugin's folder holds no profiles file but the example", () => {
  const files = readdirSync(here);
  assert.ok(!files.includes("profiles.json"), "no profiles.json beside the tool");
  assert.ok(!files.includes("secret-profiles.json"));
  assert.ok(files.includes("profiles.example.json"));
});

test("the remote paste is not here: its flags are refused, and nothing runs", async () => {
  for (const args of [
    ["generic", "--hold", "5", "--remote", "--json", "--session", "s", "--workspace", "w", "--machine", "m"],
    ["--identity"],
    ["--identity-check", "--json"],
    ["--enrol-owner"],
  ]) {
    const r = await run(args).done;
    assert.equal(r.code, 64, args.join(" "));
    assert.match(r.stderr, /Unknown option/, args.join(" "));
  }
  assert.ok(!existsSync(join(here, "remote")), "no remote/ folder");
});
