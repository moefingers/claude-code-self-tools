// The profiles are the person's own, in one place that stays put across the
// plugin's updates; generic is built in; the example that ships resolves;
// and nothing of the remote paste is left to call.
//
//   node --test plugins/self-secret/tools/secret-run/profiles.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
import {
  PROFILES_NAME,
  nativePath,
  stateFolder,
  system32,
  trustRefusal,
} from "./where.mjs";

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
  mkdirSync(mine, { recursive: true, mode: 0o700 });
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
    { mode: 0o600 },
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
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "secret-profiles.json"), text, { mode: 0o600 });
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
  // Read from a copy in this test's own folder: a checkout's folder may be one other accounts can
  // write (a drive whose root grants it), which secret-run rightly refuses a profiles file in.
  const example = tmp.file("example-profiles.json", text);
  const names = Object.keys(JSON.parse(text)).filter((n) => !n.startsWith("$"));
  assert.deepEqual(names, ["github-token", "example-service", "signing-passphrase"]);
  for (const name of names) {
    const p = resolveProfile(name, {}, example);
    assert.equal(p.name, name);
    assert.ok(p.check, `${name} has a check`);
    assert.equal(p.fromCommandLine, false);
  }
  assert.equal(
    resolveProfile("github-token", {}, example).shape.says,
    "start with ghp_, gho_, ghu_, ghs_, ghr_ or github_pat_ and have no spaces",
    "its pattern gives its shape",
  );
  const listed = await run(["--list", "--profiles", example]).done;
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /^github-token {2}GH_TOKEN {2}GitHub token$/m);
});

test("nothing ships that is anyone's own: the plugin's folder holds no profiles file but the example", () => {
  const files = readdirSync(here);
  assert.ok(!files.includes("profiles.json"), "no profiles.json beside the tool");
  assert.ok(!files.includes("secret-profiles.json"));
  assert.ok(files.includes("profiles.example.json"));
});

const ME_UID = 1000;
/** A stat that answers each path from a table, ENOENT for the rest: POSIX's facts on any system. */
const fakeStat = (table) => (path) => {
  if (!Object.hasOwn(table, path))
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  return table[path];
};
const posixRefusal = (table, entries = [
  { path: "/home/u/.local/state/claude-self-tools", what: "the state folder" },
  { path: "/home/u/.local/state/claude-self-tools/secret-profiles.json", what: "the profiles file" },
]) => trustRefusal(entries, { platform: "linux", stat: fakeStat(table), uid: ME_UID });

test("POSIX: a state folder or profiles file another user owns, or its group or others can write, is refused", () => {
  const dir = "/home/u/.local/state/claude-self-tools";
  const file = `${dir}/secret-profiles.json`;
  const own = { uid: ME_UID, mode: 0o40700 };
  const ownFile = { uid: ME_UID, mode: 0o100600 };
  // Yours alone, or root's (which can change anything already), or not there yet: used.
  assert.equal(posixRefusal({ [dir]: own, [file]: ownFile }), null);
  assert.equal(posixRefusal({ [dir]: { uid: ME_UID, mode: 0o40755 }, [file]: { uid: ME_UID, mode: 0o100644 } }), null, "readable by others is fine");
  assert.equal(posixRefusal({ [dir]: { uid: 0, mode: 0o40755 }, [file]: ownFile }), null, "root's");
  assert.equal(posixRefusal({}), null, "nothing there yet");
  assert.equal(posixRefusal({ [dir]: own }), null, "no profiles file yet");
  // Another user's, or writable by the group or others: refused, saying which and why.
  assert.equal(
    posixRefusal({ [dir]: { uid: 1001, mode: 0o40700 }, [file]: ownFile }),
    `secret-run won't use the state folder ${dir}: it belongs to uid 1001, not to you (uid ${ME_UID}). The state folder and the profiles file must be yours alone to change (the self-secret README, Profiles).`,
  );
  assert.match(posixRefusal({ [dir]: own, [file]: { uid: 1001, mode: 0o100600 } }), /^secret-run won't use the profiles file .*secret-profiles\.json: it belongs to uid 1001/);
  for (const [mode, who] of [
    [0o40770, "its group can write it \\(mode 0770;"],
    [0o40707, "others can write it \\(mode 0707;"],
    [0o40777, "its group and others can write it \\(mode 0777;"],
    [0o41777, "its group and others can write it \\(mode 1777;"],
  ])
    assert.match(posixRefusal({ [dir]: { uid: ME_UID, mode }, [file]: ownFile }), new RegExp(`the state folder ${dir}: ${who} chmod go-w makes it yours alone\\)`), mode.toString(8));
  assert.match(posixRefusal({ [dir]: own, [file]: { uid: ME_UID, mode: 0o100664 } }), /the profiles file .*: its group can write it \(mode 0664;/);
  // One that can't be looked at is refused, never passed over.
  const denied = (path) => {
    throw Object.assign(new Error(`EACCES: ${path}`), { code: "EACCES" });
  };
  assert.match(trustRefusal([{ path: dir, what: "the state folder" }], { platform: "linux", stat: denied, uid: ME_UID }), /it couldn't be looked at \(EACCES\)/);
});

test("Windows: one owned by another account, or that another account can write, is refused", () => {
  const ME = "S-1-5-21-1-2-3-1001";
  const OTHER = "S-1-5-21-1-2-3-1002";
  const acl = (facts) => () => ({ me: ME, facts });
  const entries = [
    { path: "C:\\Users\\u\\AppData\\Local\\claude-self-tools", what: "the state folder" },
    { path: "C:\\Users\\u\\AppData\\Local\\claude-self-tools\\secret-profiles.json", what: "the profiles file" },
  ];
  const refusal = (facts) => trustRefusal(entries, { platform: "win32", acl: acl(facts) });
  const mine = { owner: ME, writers: [ME, "S-1-5-18", "S-1-5-32-544"] };
  assert.equal(refusal([mine, mine]), null, "yours, SYSTEM's and Administrators'");
  assert.equal(refusal([{ owner: "S-1-5-32-544", writers: ["S-1-5-32-544", "S-1-3-0", "S-1-3-4", ME] }, { missing: true }]), null, "owned by Administrators; the owner's stand-ins");
  assert.equal(
    refusal([{ owner: OTHER, writers: [OTHER] }, mine]),
    `secret-run won't use the state folder ${entries[0].path}: it is owned by ${OTHER}, not by you (${ME}). The state folder and the profiles file must be yours alone to change (the self-secret README, Profiles).`,
  );
  for (const sid of ["S-1-1-0", "S-1-5-11", "S-1-5-32-545", OTHER])
    assert.match(refusal([mine, { owner: ME, writers: [ME, sid] }]), new RegExp(`the profiles file .*secret-profiles\\.json: ${sid} can write it\\.`), sid);
  assert.match(refusal([{ error: "Access is denied." }, mine]), /the state folder .*: who owns it couldn't be read \(Access is denied\.\)/);
  const silent = () => {
    throw new Error("Windows PowerShell didn't say (exit 1)");
  };
  assert.match(trustRefusal(entries, { platform: "win32", acl: silent }), /who owns it couldn't be read: Windows PowerShell didn't say/);
});

test("on this machine: a state folder another account can write is refused before any profile is read, and used once it is yours alone", async () => {
  const home = join(tmp.dir, "shared-state");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "secret-profiles.json"), "{}", { mode: 0o600 });
  const open = () =>
    process.platform === "win32"
      ? spawnSync(system32("icacls.exe"), [home, "/grant", "*S-1-1-0:(OI)(CI)M"], { encoding: "utf8", windowsHide: true })
      : chmodSync(home, 0o777);
  const close = () =>
    process.platform === "win32"
      ? spawnSync(system32("icacls.exe"), [home, "/remove:g", "*S-1-1-0", "/t"], { encoding: "utf8", windowsHide: true })
      : chmodSync(home, 0o700);
  open();
  try {
    for (const args of [["--list"], ["--hold-status"], ["generic", "--prompt", "x", "--no-check", "--", "node"]]) {
      const refused = await run(args, home).done;
      assert.equal(refused.code, 64, args.join(" "));
      assert.match(
        refused.stderr,
        process.platform === "win32"
          ? /secret-run won't use the state folder .*shared-state: S-1-1-0 can write it\./
          : /secret-run won't use the state folder .*shared-state: its group and others can write it/,
        args.join(" "),
      );
      assert.doesNotMatch(refused.stderr, /the form for/, "no form opened");
    }
  } finally {
    close();
  }
  const used = await run(["--list"], home).done;
  assert.equal(used.code, 0, used.stderr);
  assert.match(used.stdout, /^generic {2}SECRET/m);
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
