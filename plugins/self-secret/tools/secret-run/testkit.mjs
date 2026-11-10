// What the secret-run tests share: made-up values, a stand-in for a check
// endpoint, and the CLI run as a child with its browser kept shut and its
// state folder a temporary one.
//
// Every value here is made up, and the ones shaped like a secret are built
// when the tests run, so none sits in the repository. The tests never see a
// real key, never read the person's own profiles or holds (SELF_SECRET_HOME
// is always a folder of the test's own), and drive the form over HTTP, the
// way a browser would post it.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SECRET_RUN = join(here, "..", "secret-run.mjs");

/** A made-up value whose URL and base64 forms differ from it, new each run. */
export const FAKE = `fake+Secret/value=with&chars_${randomBytes(8).toString("hex")}`;
/** A made-up value the stand-in check refuses. */
export const WRONG = `not-the-right-value-${randomBytes(2).toString("hex")}`;

/** A key of the napi_ shape a redaction pattern masks, made up and built here. */
export const NAPI = ["napi", "_FAKE", "notreal0123"].join("");
/** A database address with a user and password in it, made up and built here. */
export const dbUrl = (user = "u", pass = "p", host = "db.example/x") =>
  `${"postgres"}ql://${user}:${pass}${"@"}${host}`;

/** A folder of its own for one test file, removed when it is done. */
export function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "self-secret-test-"));
  return {
    dir,
    file(name, text) {
      const path = join(dir, name);
      writeFileSync(path, text);
      return path;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Every form of a value that redaction promises to catch, by name. */
export function formsOf(value) {
  const bytes = Buffer.from(value, "utf8");
  return {
    exact: value,
    "URL-encoded": encodeURIComponent(value),
    "form-encoded": new URLSearchParams({ v: value }).toString().slice(2),
    base64: bytes.toString("base64"),
    "base64 unpadded": bytes.toString("base64").replace(/=+$/, ""),
    base64url: bytes.toString("base64url"),
    hex: bytes.toString("hex"),
  };
}

/** Fails, naming the form, if any form of the value appears in the text. */
export function assertNoLeak(text, value, where = "output") {
  for (const [name, form] of Object.entries(formsOf(value)))
    assert.ok(!text.includes(form), `the ${name} form leaked into ${where}`);
  const inner = Buffer.from(`user:${value}`).toString("base64");
  assert.ok(
    !text.includes(inner.slice(8, -4)),
    `the value inside a longer base64 blob leaked into ${where}`,
  );
}

/**
 * A stand-in for a check endpoint: 200 with a project for the good value,
 * 401 with a message otherwise.
 */
export function fakeCheck(good) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.headers.authorization ?? "");
    const ok = req.headers.authorization === `Bearer ${good}`;
    res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        ok
          ? { project: { id: "fake-project-123", name: "stand-in" } }
          : { code: "", message: "authorization failed" },
      ),
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/projects/fake-project-123`,
        hits,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/**
 * A child script that prints the value it was given in every form
 * redaction catches, some of it split across writes, on both streams,
 * and ends without a newline. argv: <env var> <exit code>.
 */
export const LEAKER = `
const name = process.argv[2] ?? "SECRET";
const v = process.env[name] ?? "";
const out = (s) => new Promise((r) => process.stdout.write(s, r));
const pause = () => new Promise((r) => setTimeout(r, 40));
const b = Buffer.from(v, "utf8");
await out("length " + v.length + "\\n");
await out("exact " + v + "\\n");
await out("url " + encodeURIComponent(v) + "\\n");
await out("form " + new URLSearchParams({ v }).toString().slice(2) + "\\n");
await out("b64 " + b.toString("base64") + "\\n");
await out("b64bare " + b.toString("base64").replace(/=+$/, "") + "\\n");
await out("b64url " + b.toString("base64url") + "\\n");
await out("hex " + b.toString("hex") + "\\n");
await out("basic " + Buffer.from("user:" + v).toString("base64") + "\\n");
await out("split " + v.slice(0, 7));
await pause();
await out(v.slice(7, 20));
await pause();
await out(v.slice(20) + " end\\n");
await out("pattern " + ${JSON.stringify(NAPI)} + " and " + ${JSON.stringify(dbUrl())} + "\\n");
await new Promise((r) => process.stderr.write("stderr " + v + "\\n", r));
await out("tail " + v);
process.exitCode = Number(process.argv[3] ?? 0);
`;

/**
 * A child script that says where the value it was given sits: how many of
 * its environment's variables hold it, which, and whether any of its words
 * do. argv: <env var>.
 */
export const WHERE = `
const name = process.argv[2] ?? "SECRET";
const v = process.env[name] ?? "";
const holding = Object.entries(process.env).filter(([, x]) => v && x.includes(v)).map(([k]) => k);
console.log("variables " + JSON.stringify(holding));
console.log("argv " + process.argv.some((a) => v && a.includes(v)));
`;

/** A child script that writes a marker file, to prove a command ran. */
export const MARKER = `
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], "ran");
`;

/** A child script that prints its words as JSON, to show each reached it as written. */
export const ARGV = `console.log("words " + JSON.stringify(process.argv.slice(2)));`;

const URL_RE = /http:\/\/127\.0\.0\.1:\d+\/\?n=[\w-]+/;

/** The state folder a run gets when its test names none: one per test process, removed as it exits. */
let fallbackHome = null;
function ownHome() {
  if (fallbackHome === null) {
    fallbackHome = mkdtempSync(join(tmpdir(), "self-secret-home-"));
    process.on("exit", () =>
      rmSync(fallbackHome, { recursive: true, force: true }),
    );
  }
  return fallbackHome;
}

/**
 * Run a script as a child with the browser kept shut and the state folder
 * the given home (or the test process's own), collecting what it prints.
 * formUrl() resolves with the form's address once it is printed.
 */
export function launch(script, args, { env = {}, home } = {}) {
  const own = home ?? ownHome();
  return watch(
    spawn(process.execPath, [script, ...args], {
      env: {
        ...process.env,
        SECRET_PASTE_NO_BROWSER: "1",
        SELF_SECRET_HOME: own,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

/** Collects what a child prints; waitFor and formUrl read it as it comes. */
export function watch(child) {
  let stdout = "";
  let stderr = "";
  const watchers = new Set();
  const notify = () => {
    for (const w of watchers) w();
  };
  child.stdout.on("data", (c) => {
    stdout += c.toString("utf8");
    notify();
  });
  child.stderr.on("data", (c) => {
    stderr += c.toString("utf8");
    notify();
  });
  const done = new Promise((resolve) => {
    child.on("close", (code) => {
      notify();
      resolve({ code, stdout, stderr });
    });
  });
  return {
    child,
    done,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    /** Resolves when the output matches, rejects when the child ends first. */
    waitFor(re, ms = 15000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          watchers.delete(look);
          reject(
            new Error(`timed out waiting for ${re}:\n${stdout}\n${stderr}`),
          );
        }, ms);
        const look = () => {
          const m = re.exec(stdout + stderr);
          if (m) {
            clearTimeout(timer);
            watchers.delete(look);
            resolve(m);
          } else if (child.exitCode !== null) {
            clearTimeout(timer);
            watchers.delete(look);
            reject(new Error(`ended before ${re}:\n${stdout}\n${stderr}`));
          }
        };
        watchers.add(look);
        look();
      });
    },
    async formUrl() {
      return (await this.waitFor(URL_RE))[0];
    },
  };
}

/** Posts form fields the way the browser does, without following a redirect. */
export async function post(url, fields) {
  const res = await fetch(url, {
    method: "POST",
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
  return {
    status: res.status,
    location: res.headers.get("location"),
    body: await res.text(),
  };
}

/**
 * One request with exactly the headers given (Host, Origin and
 * Sec-Fetch-Site included), as a browser or another page would send it.
 */
export function raw(url, { method = "GET", headers = {}, fields } = {}) {
  const u = new URL(url);
  const body = fields ? new URLSearchParams(fields).toString() : "";
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method,
        headers: {
          ...(fields
            ? {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(body),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: text }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** The page at a URL, as text. */
export async function page(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.text() };
}

/** The cancel button's address for a form URL. */
export function cancelUrl(formUrl) {
  const u = new URL(formUrl);
  return `${u.origin}/cancel${u.search}`;
}

/** A profiles file with one profile checked by the stand-in. */
export function profilesFile(
  dir,
  checkUrl,
  extra = {},
  name = "profiles.json",
) {
  const path = join(dir, name);
  writeFileSync(
    path,
    JSON.stringify({
      "stand-in": {
        title: "Stand-in key",
        envVar: "STAND_IN_KEY",
        prompt: "Paste the stand-in key.",
        check: {
          type: "http",
          url: checkUrl,
          headers: { Authorization: "Bearer {value}" },
          expectStatus: [200],
          reached: "project {project.name} ({project.id})",
        },
        redact: ["napi_[A-Za-z0-9]+", "postgres(ql)?://\\S+"],
        ...extra,
      },
    }),
  );
  return path;
}
