// Nothing runs until a value passes its check, only this machine reaches the
// form, only through the address it printed, and what the command prints
// reaches the caller scrubbed.
//
// Drives secret-run.mjs as a child, its browser kept shut and its state
// folder a temporary one, posting to its form as a browser would, and as the
// page's script does, against a stand-in check on this machine. What the form
// answers after its end is driven in this process (captureSecret), since
// secret-run exits as its form ends.
//
//   node --test plugins/self-secret/tools/secret-run/form.test.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  captureSecret,
  cookiesNamed,
  fromAnotherPage,
  shapeVerdict,
  trimNotes,
  wantsJson,
} from "./form.mjs";
import { resolveProfile } from "./profiles.mjs";
import {
  FAKE,
  LEAKER,
  MARKER,
  SECRET_RUN,
  WHERE,
  WRONG,
  assertNoLeak,
  browse,
  cancelUrl,
  fakeCheck,
  launch,
  page,
  post,
  profilesFile,
  raw,
  scratch,
  scriptPost,
} from "./testkit.mjs";

let tmp;
let check;
let leaker;
let marker;
let where;
let profiles;

before(async () => {
  tmp = scratch();
  check = await fakeCheck(FAKE);
  leaker = tmp.file("leaker.mjs", LEAKER);
  marker = tmp.file("marker.mjs", MARKER);
  where = tmp.file("where.mjs", WHERE);
  profiles = profilesFile(tmp.dir, check.url);
});

after(async () => {
  await check.close();
  tmp.cleanup();
});

/** The generic profile, checked by the stand-in. */
function generic(...rest) {
  return [
    "generic",
    "--prompt",
    "Paste the stand-in key",
    "--check-url",
    check.url,
    "--check-header",
    "Authorization: Bearer {value}",
    ...rest,
  ];
}

test("a wrong value is refused on the same page, and nothing runs until a right one", async () => {
  const ran = join(tmp.dir, "ran-1");
  const cli = launch(SECRET_RUN, [
    ...generic(),
    "--",
    process.execPath,
    marker,
    ran,
  ]);
  const url = await cli.formUrl();

  const form = await page(url);
  assert.equal(form.status, 200);
  assert.match(form.body, /Paste the stand-in key/);
  // LOAD-BEARING: a type=password field is what makes a browser offer to save
  // the value as a password; the field is text, masked by CSS (form.mjs).
  assert.doesNotMatch(
    form.body,
    /type=["']?password/i,
    "never a password field",
  );
  assert.match(form.body, /<input name=v type=text /);
  assert.match(form.body, /input\[name=v\]\{-webkit-text-security:disc\}/);
  assert.doesNotMatch(form.body, /<a /, "no url, no link");

  const refused = await post(url, { v: WRONG });
  assert.equal(refused.status, 303, "it sends the browser back to the form");
  assert.equal(
    new URL(refused.location, url).href,
    `${new URL(url).origin}/`,
    "the form's own address, with no nonce in it",
  );
  const again = await page(url);
  assert.match(again.body, /That key didn&#39;t work: .*401/);
  assert.doesNotMatch(
    again.body,
    new RegExp(WRONG),
    "the page never shows a value",
  );
  assert.equal(existsSync(ran), false, "nothing ran on the wrong value");
  await cli.waitFor(/didn't work/);

  const empty = await post(url, { v: "   " });
  assert.equal(empty.status, 303);
  assert.match((await page(url)).body, /Nothing was pasted/);

  const accepted = await post(url, { v: `  ${FAKE}\n` });
  assert.equal(accepted.status, 200);
  assert.match(accepted.body, /project stand-in|Received/);
  assert.match(
    accepted.body,
    /Trimmed 2 spaces at the start, and a line break at the end\./,
    "it says what it trimmed",
  );
  assert.match(
    accepted.body,
    /Running the command\. You can close this window\./,
    "the plain POST's last page says the window can be closed: no script closes it",
  );

  const { code, stdout, stderr } = await cli.done;
  assert.equal(code, 0);
  assert.equal(existsSync(ran), true, "the command ran once the value passed");
  assertNoLeak(stdout + stderr, FAKE);
  assertNoLeak(stdout + stderr, WRONG, "the output (the wrong value)");
  assert.equal(
    check.hits.at(-1),
    `Bearer ${FAKE}`,
    "the value is trimmed before the check",
  );
});

test("a named profile says which project the key reached", async () => {
  const cli = launch(SECRET_RUN, [
    "stand-in",
    "--profiles",
    profiles,
    "--",
    process.execPath,
    "-e",
    "",
  ]);
  const url = await cli.formUrl();
  assert.match((await page(url)).body, /Stand-in key/);
  const accepted = await post(url, { v: FAKE });
  assert.match(accepted.body, /project stand-in \(fake-project-123\)/);
  const { code, stderr } = await cli.done;
  assert.equal(code, 0);
  assert.match(stderr, /reached project stand-in \(fake-project-123\)/);
});

test("every form of the value, on both streams and split across writes, comes out redacted", async () => {
  const cli = launch(SECRET_RUN, [
    "stand-in",
    "--profiles",
    profiles,
    "--",
    process.execPath,
    leaker,
    "STAND_IN_KEY",
    "7",
  ]);
  await post(await cli.formUrl(), { v: FAKE });
  const { code, stdout, stderr } = await cli.done;
  assert.equal(code, 7, "the command's exit code is the caller's");
  assertNoLeak(stdout, FAKE, "stdout");
  assertNoLeak(stderr, FAKE, "stderr");
  assert.match(
    stdout,
    new RegExp(`^length ${FAKE.length}$`, "m"),
    "the command had the value",
  );
  for (const label of [
    "exact",
    "url",
    "form",
    "b64",
    "b64bare",
    "b64url",
    "hex",
  ])
    assert.match(stdout, new RegExp(`^${label} \\[redacted\\]$`, "m"), label);
  assert.match(stdout, /^basic .*\[redacted\]/m);
  assert.match(stdout, /^split \[redacted\] end$/m);
  assert.match(stdout, /^pattern \[redacted\] and \[redacted\]$/m);
  assert.match(stderr, /^stderr \[redacted\]$/m);
  assert.match(
    stdout,
    /tail \[redacted\]$/,
    "the last line, with no newline, is flushed at exit",
  );
});

test("the value reaches the command in its one variable, and in no word of its command line", async () => {
  const cli = launch(SECRET_RUN, [
    "stand-in",
    "--profiles",
    profiles,
    "--",
    process.execPath,
    where,
    "STAND_IN_KEY",
  ]);
  await post(await cli.formUrl(), { v: FAKE });
  const { code, stdout } = await cli.done;
  assert.equal(code, 0);
  assert.match(stdout, /^variables \["STAND_IN_KEY"\]$/m);
  assert.match(stdout, /^argv false$/m);
});

test("cancel ends it, and nothing runs", async () => {
  const ran = join(tmp.dir, "ran-cancel");
  const cli = launch(SECRET_RUN, [
    ...generic(),
    "--",
    process.execPath,
    marker,
    ran,
  ]);
  const url = await cli.formUrl();
  const cancelled = await post(cancelUrl(url), {});
  assert.equal(cancelled.status, 200);
  assert.match(cancelled.body, /Cancelled/);
  const { code, stderr } = await cli.done;
  assert.equal(code, 1);
  assert.match(stderr, /cancelled/);
  assert.equal(existsSync(ran), false);
});

test("no value before the timeout ends it, and nothing runs", async () => {
  const ran = join(tmp.dir, "ran-timeout");
  const cli = launch(SECRET_RUN, [
    ...generic("--timeout", "1"),
    "--",
    process.execPath,
    marker,
    ran,
  ]);
  await cli.formUrl();
  const { code, stderr } = await cli.done;
  assert.equal(code, 1);
  assert.match(stderr, /no key within 1 s/);
  assert.equal(existsSync(ran), false);
});

test("a request without the nonce, or with another, is not found", async () => {
  const ran = join(tmp.dir, "ran-nonce");
  const cli = launch(SECRET_RUN, [
    ...generic("--timeout", "20"),
    "--",
    process.execPath,
    marker,
    ran,
  ]);
  const url = new URL(await cli.formUrl());
  assert.equal((await raw(`${url.origin}/`)).status, 404);
  assert.equal((await raw(`${url.origin}/?n=wrong`)).status, 404);
  // One character off: the last, changed to another (a base64url nonce can end in x itself, 1 run in 64).
  const n = url.searchParams.get("n");
  const nearly = `${url.origin}/?n=${n.slice(0, -1)}${n.endsWith("x") ? "y" : "x"}`;
  assert.equal((await raw(nearly)).status, 404);
  for (const where of [`${url.origin}/?n=wrong`, `${url.origin}/`, url.href])
    assert.equal(
      (await raw(where, { method: "POST", fields: { v: FAKE } })).status,
      404,
      `a POST to ${new URL(where).pathname}${new URL(where).search ? "?n=…" : ""} without the cookie`,
    );
  for (const where of [`${url.origin}/cancel?n=wrong`, `${url.origin}/cancel`])
    assert.equal(
      (await raw(where, { method: "POST", fields: {} })).status,
      404,
      "nor can a page without it cancel",
    );
  // Asked for JSON, as the page's script asks: the same bare refusal, no answer to read.
  for (const where of [`${url.origin}/`, `${url.origin}/cancel`]) {
    const r = await raw(where, {
      method: "POST",
      headers: { Accept: "application/json" },
      fields: { v: FAKE },
    });
    assert.equal(r.status, 404, `JSON asked of ${new URL(where).pathname} without the cookie`);
    assert.equal(r.body, "", "and no answer in it");
  }
  assert.equal(existsSync(ran), false, "nothing ran on a post without it");
  // A wrong nonce spends nothing: the printed address still opens the form.
  assert.equal((await post(url.href, { v: FAKE })).status, 200);
  assert.equal((await cli.done).code, 0);
  assert.equal(existsSync(ran), true);
});

test("the printed address opens the form once: its nonce is traded for the form's cookie, and a copy of it is dead after", async () => {
  const ran = join(tmp.dir, "ran-once");
  const cli = launch(SECRET_RUN, [
    ...generic("--timeout", "20"),
    "--",
    process.execPath,
    marker,
    ran,
  ]);
  const url = await cli.formUrl();
  const { origin, port } = new URL(url);
  const nonce = new URL(url).searchParams.get("n");

  // The first visit: a cookie for the form, and on to the form's own address.
  const first = await raw(url);
  assert.equal(first.status, 303);
  assert.equal(first.headers.location, "/");
  const set = first.headers["set-cookie"] ?? [];
  assert.equal(set.length, 1);
  assert.match(
    set[0],
    new RegExp(`^secret-run-${port}=[\\w-]{32}; Path=/; HttpOnly; SameSite=Strict; Max-Age=20$`),
  );
  assert.ok(!set[0].includes(nonce), "the cookie is not the nonce");
  const cookie = set[0].split(";")[0];
  const [name] = cookie.split("=");

  // A copy of the address, used after: not found, by GET or POST, and nothing else opens the form.
  const again = await raw(url);
  assert.equal(again.status, 404, "the printed address, a second time");
  assert.equal(again.headers["set-cookie"], undefined, "and no cookie for it");
  assert.match(again.body, /opens the form once, and it has been opened/);
  assert.equal(
    (await raw(url, { method: "POST", fields: { v: FAKE } })).status,
    404,
  );
  for (const headers of [
    {},
    { Cookie: `${name}=${"x".repeat(32)}` },
    { Cookie: `${name}=${cookie.slice(name.length + 1, -1)}` },
    { Cookie: `${name}-other=${cookie.slice(name.length + 1)}` },
    { Cookie: `secret-run-${Number(port) + 1}=${cookie.slice(name.length + 1)}` },
  ]) {
    assert.equal((await raw(`${origin}/`, { headers })).status, 404, JSON.stringify(headers));
    assert.equal(
      (await raw(`${origin}/`, { method: "POST", headers, fields: { v: FAKE } })).status,
      404,
      JSON.stringify(headers),
    );
    assert.equal(
      (await raw(`${origin}/cancel`, { method: "POST", headers, fields: {} })).status,
      404,
      JSON.stringify(headers),
    );
  }
  assert.equal(existsSync(ran), false, "nothing ran");

  // The browser that opened it: the form, with no nonce in it; the printed address only sends it back there.
  const form = await raw(`${origin}/`, { headers: { Cookie: `other=1; ${cookie}` } });
  assert.equal(form.status, 200);
  assert.match(form.body, /<form method=post action="\/">/);
  assert.match(form.body, /formaction="\/cancel"/);
  assert.ok(!form.body.includes(nonce), "the page holds no nonce");
  const back = await raw(url, { headers: { Cookie: cookie } });
  assert.equal(back.status, 303);
  assert.equal(back.headers.location, "/");
  assert.equal(back.headers["set-cookie"], undefined, "no second cookie");
  const accepted = await raw(`${origin}/`, {
    method: "POST",
    headers: { Cookie: cookie },
    fields: { v: FAKE },
  });
  assert.equal(accepted.status, 200);
  assert.equal((await cli.done).code, 0);
  assert.equal(existsSync(ran), true);
});

test("a Cookie header is read pair by pair", () => {
  assert.deepEqual(cookiesNamed(undefined, "a"), []);
  assert.deepEqual(cookiesNamed("a=1; b=2;a=3", "a"), ["1", "3"]);
  assert.deepEqual(cookiesNamed("ab=1; xa=2", "a"), []);
  assert.deepEqual(cookiesNamed("a=x=y", "a"), ["x=y"]);
});

test("a request for another Host is refused (DNS rebinding), whatever it carries", async () => {
  const ran = join(tmp.dir, "ran-host");
  const cli = launch(SECRET_RUN, [
    ...generic("--timeout", "20"),
    "--",
    process.execPath,
    marker,
    ran,
  ]);
  const url = await cli.formUrl();
  const port = new URL(url).port;
  for (const host of [
    `attacker.example:${port}`,
    `localhost:${port}`,
    "127.0.0.1",
    `127.0.0.1:${Number(port) + 1}`,
  ]) {
    const got = await raw(url, { headers: { Host: host } });
    assert.equal(got.status, 403, `GET with Host ${host}`);
    assert.doesNotMatch(got.body, /<form/, `no form for Host ${host}`);
    const posted = await raw(url, {
      method: "POST",
      headers: { Host: host },
      fields: { v: FAKE },
    });
    assert.equal(posted.status, 403, `POST with Host ${host}`);
  }
  assert.equal(existsSync(ran), false, "nothing ran");
  assert.equal((await page(url)).status, 200, "its own Host is answered");
  assert.equal((await post(url, { v: FAKE })).status, 200);
  assert.equal((await cli.done).code, 0);
  assert.equal(existsSync(ran), true);
});

test("a POST a browser marks as from another page is refused before its nonce or value is looked at", async () => {
  const ran = join(tmp.dir, "ran-origin");
  const asked = check.hits.length;
  const cli = launch(SECRET_RUN, [
    ...generic("--timeout", "20"),
    "--",
    process.execPath,
    marker,
    ran,
  ]);
  const url = await cli.formUrl();
  const own = new URL(url).origin;
  // The person's browser has opened the form: the POSTs below carry its cookie, and are refused all the same.
  const cookie = (await raw(url)).headers["set-cookie"][0].split(";")[0];
  for (const headers of [
    { Origin: "https://attacker.example" },
    { Origin: "http://127.0.0.1:1" },
    { Origin: "http://localhost" },
    { "Sec-Fetch-Site": "cross-site" },
    { "Sec-Fetch-Site": "same-site" },
    // A sandboxed frame, a data: or file: page, or a page that sends no referrer.
    { Origin: "null" },
    { Origin: "null", "Sec-Fetch-Site": "same-origin" },
    { Origin: "null", "Sec-Fetch-Site": "cross-site" },
  ]) {
    for (const where of [`${own}/`, `${own}/cancel`, url, cancelUrl(url)]) {
      const r = await raw(where, {
        method: "POST",
        headers: { ...headers, Cookie: cookie },
        fields: { v: FAKE },
      });
      assert.equal(r.status, 403, `${JSON.stringify(headers)} to ${new URL(where).pathname}`);
      // Asked for JSON, as the page's script asks: refused the same way, with no answer to read.
      const asJson = await raw(where, {
        method: "POST",
        headers: { ...headers, Cookie: cookie, Accept: "application/json" },
        fields: { v: FAKE },
      });
      assert.equal(asJson.status, 403, `JSON, ${JSON.stringify(headers)} to ${new URL(where).pathname}`);
      assert.equal(asJson.body, "");
    }
  }
  assert.equal(existsSync(ran), false, "nothing ran");
  assert.equal(check.hits.length, asked, "the check was never asked");
  // What a browser sends from the form itself, under its same-origin referrer
  // policy: its own origin, same-origin, and the form's cookie.
  const fromForm = { Origin: own, "Sec-Fetch-Site": "same-origin", Cookie: cookie };
  const wrong = await raw(`${own}/`, { method: "POST", headers: fromForm, fields: { v: WRONG } });
  assert.equal(wrong.status, 303, "the form's own POST reaches the check");
  assert.equal(check.hits.length, asked + 1);
  const r = await raw(`${own}/`, { method: "POST", headers: fromForm, fields: { v: FAKE } });
  assert.equal(r.status, 200);
  assert.equal((await cli.done).code, 0);
  assert.equal(existsSync(ran), true);
});

test("which requests count as from another page", () => {
  const here = "127.0.0.1:5000";
  assert.equal(fromAnotherPage({}, here), false, "no header: the nonce decides");
  assert.equal(fromAnotherPage({ origin: "http://127.0.0.1:5000" }, here), false);
  assert.equal(fromAnotherPage({ origin: "null" }, here), true, "null is another page");
  assert.equal(fromAnotherPage({ origin: "null", "sec-fetch-site": "same-origin" }, here), true);
  assert.equal(fromAnotherPage({ "sec-fetch-site": "same-origin" }, here), false);
  assert.equal(fromAnotherPage({ "sec-fetch-site": "none" }, here), false);
  assert.equal(fromAnotherPage({ origin: "http://127.0.0.1:5001" }, here), true);
  assert.equal(fromAnotherPage({ origin: "https://127.0.0.1:5000" }, here), true);
  assert.equal(fromAnotherPage({ origin: "" }, here), true);
  assert.equal(fromAnotherPage({ "sec-fetch-site": "same-site" }, here), true);
  assert.equal(fromAnotherPage({ "sec-fetch-site": "cross-site" }, here), true);
});

/** This machine's addresses other than its loopback ones: where a form bound wider would answer. */
const elsewhere = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && !a.internal && a.family === "IPv4")
    .map((a) => a.address);

/** Whether something answers a TCP connection at that address and port. */
const answers = (host, port) =>
  new Promise((resolve) => {
    const sock = connect({ host, port, timeout: 2000 });
    sock.on("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });

test("the form listens on 127.0.0.1 alone: the address it prints is the one it listens on", async () => {
  const cli = launch(SECRET_RUN, [
    ...generic("--timeout", "20"),
    "--",
    process.execPath,
    "-e",
    "",
  ]);
  const url = new URL(await cli.formUrl());
  assert.equal(url.hostname, "127.0.0.1", "the socket's own address");
  for (const address of elsewhere())
    assert.equal(
      await answers(address, url.port),
      false,
      `the form answers at ${address}`,
    );
  await post(cancelUrl(url.href), {});
  assert.equal((await cli.done).code, 1);
});

test("a command check reads the value on stdin", async () => {
  const checker = tmp.file(
    "checker.mjs",
    `let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
       if (s === ${JSON.stringify(FAKE)}) { console.log("account stand-in-account"); process.exit(0); }
       console.error("refused " + s); process.exit(3);
     });`,
  );
  const path = profilesFile(
    tmp.dir,
    check.url,
    { check: { type: "command", argv: [process.execPath, checker] } },
    "profiles-command.json",
  );
  const cli = launch(SECRET_RUN, [
    "stand-in",
    "--profiles",
    path,
    "--",
    process.execPath,
    "-e",
    "",
  ]);
  const url = await cli.formUrl();
  await post(url, { v: WRONG });
  const refused = (await page(url)).body;
  assert.match(refused, /exited 3/);
  assert.doesNotMatch(
    refused,
    new RegExp(WRONG),
    "the check's own output is scrubbed",
  );
  const accepted = await post(url, { v: FAKE });
  assert.match(accepted.body, /account stand-in-account/);
  const { code } = await cli.done;
  assert.equal(code, 0);
});

test("a check that would send the value in the clear to another machine is refused", async () => {
  const cli = launch(SECRET_RUN, [
    "generic",
    "--prompt",
    "x",
    "--check-url",
    "http://example.com/check",
    "--",
    process.execPath,
    "-e",
    "",
  ]);
  const { code, stderr } = await cli.done;
  assert.equal(code, 64);
  assert.match(stderr, /https/);
  // A lookup of a name with the value in it would tell a DNS server.
  const inHost = await launch(SECRET_RUN, [
    "generic",
    "--prompt",
    "x",
    "--check-url",
    "https://{value}.example.com/check",
    "--",
    process.execPath,
    "-e",
    "",
  ]).done;
  assert.equal(inHost.code, 64);
  assert.match(inHost.stderr, /\{value\} only in its path or query/);
});

test("a check's answer is read only so far: an endless body does not hold the form", async () => {
  const endless = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    const pump = () => {
      while (res.write(chunk));
      res.once("drain", pump);
    };
    pump();
    req.socket.on("close", () => res.destroy());
  });
  await new Promise((r) => endless.listen(0, "127.0.0.1", r));
  const cli = launch(SECRET_RUN, [
    "generic",
    "--prompt",
    "x",
    "--check-url",
    `http://127.0.0.1:${endless.address().port}/`,
    "--",
    process.execPath,
    "-e",
    "",
  ]);
  const started = Date.now();
  const accepted = await post(await cli.formUrl(), { v: FAKE });
  assert.equal(accepted.status, 200);
  assert.ok(
    Date.now() - started < 8000,
    "the check did not read on to its timeout",
  );
  assert.equal((await cli.done).code, 0);
  endless.closeAllConnections();
  await new Promise((r) => endless.close(r));
});

test("a command check that runs out of time is ended with everything it started", async () => {
  // The check starts a process of its own that would write a file after
  // three seconds; ending only the check would leave it to.
  const late = join(tmp.dir, "grandchild-wrote");
  const grandchild = tmp.file(
    "grandchild.mjs",
    `import { writeFileSync } from "node:fs";
     setTimeout(() => writeFileSync(${JSON.stringify(late)}, "late"), 3000);`,
  );
  const parent = tmp.file(
    "slow-check.mjs",
    `import { spawn } from "node:child_process";
     spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "ignore" });
     setInterval(() => {}, 1000);`,
  );
  const path = profilesFile(
    tmp.dir,
    check.url,
    {
      check: {
        type: "command",
        argv: [process.execPath, parent],
        timeoutSeconds: 1,
      },
    },
    "profiles-slow.json",
  );
  const cli = launch(SECRET_RUN, [
    "stand-in",
    "--profiles",
    path,
    "--",
    process.execPath,
    "-e",
    "",
  ]);
  const url = await cli.formUrl();
  await post(url, { v: FAKE });
  assert.match((await page(url)).body, /did not finish within 1 s/);
  await post(cancelUrl(url), {});
  await cli.done;
  await new Promise((r) => setTimeout(r, 4000));
  assert.equal(
    existsSync(late),
    false,
    "the check's own process was ended too",
  );
});

test("a paste's whitespace and shape are said in words that never quote it", () => {
  assert.deepEqual(trimNotes("\n  ghp_k1 \r\n"), {
    value: "ghp_k1",
    found:
      "a line break and 2 spaces at the start, and a line break and a space at the end",
    inside: false,
  });
  assert.deepEqual(trimNotes("ghp_k1"), {
    value: "ghp_k1",
    found: "",
    inside: false,
  });
  assert.equal(trimNotes("one\ntwo").inside, true, "two lines are not one key");
  const shape = {
    pattern: "^ghp_\\S+$",
    says: "start with ghp_ and have no spaces",
  };
  assert.deepEqual(shapeVerdict("ghp_k1", shape, false), {
    ok: true,
    words: "",
  });
  assert.deepEqual(shapeVerdict("xghp_k1", shape, false), {
    ok: false,
    words:
      "It doesn't look right: it should start with ghp_ and have no spaces.",
  });
  assert.equal(
    shapeVerdict("a b", null, false).ok,
    false,
    "no space inside, shape or not",
  );
  assert.equal(
    shapeVerdict("a b", null, true).ok,
    true,
    "unless the profile allows it",
  );
});

test("a value without its shape, or with a space inside, is refused before its check is asked", async () => {
  const asked = check.hits.length;
  const cli = launch(SECRET_RUN, [
    // --timeout 20: a failed assertion before the paste leaves the form waiting no longer.
    ...generic(
      "--timeout",
      "20",
      "--shape",
      "^fake\\+\\S+$",
      "--shape-says",
      "start with fake+ and have no spaces",
    ),
    "--",
    process.execPath,
    "-e",
    "",
  ]);
  const url = await cli.formUrl();

  // LOAD-BEARING: the page's one script runs because the policy names its hash, and nothing else can.
  const res = await browse(url);
  const html = await res.text();
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, "the form has its script");
  // A browser's parser drops a carriage return before it hashes the script, so one here would
  // leave the hash below matching and the browser's not, and the script would never run.
  assert.doesNotMatch(script, /\r/, "no carriage return in the script");
  const hash = createHash("sha256").update(script).digest("base64");
  const csp = res.headers.get("content-security-policy");
  assert.equal(
    /script-src ([^;]*)/.exec(csp)?.[1],
    `'sha256-${hash}'`,
    "the policy allows that script and nothing else",
  );
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(
    /connect-src ([^;]*)/.exec(csp)?.[1],
    "'self'",
    "the page's script can send to the form's own origin, and nowhere else",
  );
  assert.equal(res.headers.get("referrer-policy"), "same-origin");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(html, /data-says="start with fake\+ and have no spaces"/);

  assert.equal((await post(url, { v: WRONG })).status, 303);
  const refused = (await page(url)).body;
  assert.match(
    refused,
    /It doesn&#39;t look right: it should start with fake\+ and have no spaces\. Nothing was checked\./,
  );
  assert.doesNotMatch(
    refused,
    new RegExp(WRONG),
    "the page never shows a value",
  );

  assert.equal((await post(url, { v: "fake+ab cd" })).status, 303);
  assert.match((await page(url)).body, /a space or line break inside it/);
  assert.equal(check.hits.length, asked, "the check was never asked");

  const accepted = await post(url, { v: ` ${FAKE}` });
  assert.equal(accepted.status, 200);
  assert.match(accepted.body, /Trimmed a space at the start\./);
  assert.equal((await cli.done).code, 0);
  assert.equal(
    check.hits.length,
    asked + 1,
    "asked once, for the value with its shape",
  );
});

test("a shape is a pattern and its words together, and a pattern that is one", async () => {
  const run = (...extra) =>
    launch(SECRET_RUN, [
      "generic",
      "--prompt",
      "x",
      "--no-check",
      ...extra,
      "--",
      "node",
    ]).done;
  const alone = await run("--shape", "^a");
  assert.equal(alone.code, 64);
  assert.match(alone.stderr, /--shape and --shape-says go together/);
  const broken = await run("--shape", "(", "--shape-says", "x");
  assert.equal(broken.code, 64);
  assert.match(broken.stderr, /pattern isn't one/);
  const empty = await run("--shape", "^a*$", "--shape-says", "x");
  assert.equal(empty.code, 64);
  assert.match(empty.stderr, /matches an empty value/);
});

test("a url is a link under the prompt, escaped, to a new tab that gets no opener or referrer", async () => {
  const cli = launch(SECRET_RUN, [
    ...generic("--url", 'https://keys.example.com/new?team=a&b="c"'),
    "--",
    process.execPath,
    "-e",
    "",
  ]);
  const url = await cli.formUrl();
  const res = await browse(url);
  const html = await res.text();
  assert.match(
    html,
    /<p>Paste the stand-in key<\/p>\n<p><a href="https:\/\/keys\.example\.com\/new\?team=a&amp;b=&quot;c&quot;" target=_blank rel="noopener noreferrer">Make one at keys\.example\.com<\/a> \(opens in a new tab\)<\/p>/,
  );
  // A link needs no script: the policy still allows the one script alone.
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  const hash = createHash("sha256").update(script).digest("base64");
  assert.equal(
    /script-src ([^;]*)/.exec(res.headers.get("content-security-policy"))?.[1],
    `'sha256-${hash}'`,
  );
  await post(cancelUrl(url), {});
  assert.equal((await cli.done).code, 1);
});

test("a url is an https address with no user name or password, or nothing runs", async () => {
  const run = (...extra) =>
    launch(SECRET_RUN, [
      "generic",
      "--prompt",
      "x",
      "--no-check",
      ...extra,
      "--",
      "node",
    ]).done;
  for (const [given, says] of [
    ["http://keys.example.com/new", /its url is http; it must be https/],
    ["javascript:alert(1)", /its url is javascript; it must be https/],
    ["keys.example.com/new", /its url isn't an address/],
    ["", /its url isn't an address/],
    [`https://me${"@"}keys.example.com/`, /user name or password/],
  ]) {
    const r = await run("--url", given);
    assert.equal(r.code, 64, given);
    assert.match(r.stderr, says, given);
  }
  const password = ["hun", "ter2"].join("");
  const credentialed = await run(
    "--url",
    `https://me:${password}${"@"}keys.example.com/`,
  );
  assert.equal(credentialed.code, 64);
  assert.match(credentialed.stderr, /user name or password/);
  assert.ok(!credentialed.stderr.includes(password), "never said back");

  const named = await launch(SECRET_RUN, [
    "stand-in",
    "--profiles",
    profiles,
    "--url",
    "https://keys.example.com/new",
    "--",
    "node",
  ]).done;
  assert.equal(named.code, 64);
  assert.match(named.stderr, /--url is for the generic profile/);
  const inFile = profilesFile(
    tmp.dir,
    check.url,
    { url: "http://keys.example.com/new" },
    "profiles-http-url.json",
  );
  const fromFile = await launch(SECRET_RUN, [
    "stand-in",
    "--profiles",
    inFile,
    "--",
    "node",
  ]).done;
  assert.equal(fromFile.code, 64);
  assert.match(fromFile.stderr, /the stand-in profile: its url is http/);
});

test("a profile's url is what its form shows, not what a hold of it is held for", () => {
  const plain = profilesFile(tmp.dir, check.url, {}, "profiles-plain.json");
  const linked = profilesFile(
    tmp.dir,
    check.url,
    { url: "https://keys.example.com/new" },
    "profiles-linked.json",
  );
  assert.equal(resolveProfile("stand-in", {}, plain).url, null);
  assert.equal(
    resolveProfile("stand-in", {}, linked).url,
    "https://keys.example.com/new",
  );
  assert.equal(
    resolveProfile("stand-in", {}, linked).fingerprint,
    resolveProfile("stand-in", {}, plain).fingerprint,
  );
});

test("the generic profile needs a prompt and a check, or --no-check", async () => {
  const noCheck = await launch(SECRET_RUN, [
    "generic",
    "--prompt",
    "x",
    "--",
    "node",
  ]).done;
  assert.equal(noCheck.code, 64);
  assert.match(noCheck.stderr, /--check-url, --check-cmd or --no-check/);
  const noPrompt = await launch(SECRET_RUN, [
    "generic",
    "--no-check",
    "--",
    "node",
  ]).done;
  assert.equal(noPrompt.code, 64);
  const unknown = await launch(SECRET_RUN, [
    "no-such-profile",
    "--profiles",
    profiles,
    "--",
    "node",
  ]).done;
  assert.equal(unknown.code, 64);
  assert.match(
    unknown.stderr,
    /there are: generic, stand-in\./,
    "it lists the profiles there are",
  );
});

test("a command that cannot start says so, scrubbed", async () => {
  const cli = launch(SECRET_RUN, [
    ...generic(),
    "--",
    join(tmp.dir, `no-such-program-${encodeURIComponent(FAKE)}.exe`),
  ]);
  await post(await cli.formUrl(), { v: FAKE });
  const { code, stderr } = await cli.done;
  assert.equal(code, 127);
  assert.match(stderr, /couldn't start .*\[redacted\]/);
  assertNoLeak(stderr, FAKE);
});

// The page's script: it sends the form by fetch and reads the answer, so the
// window keeps its one history entry and can close itself (form.mjs).

test("only an Accept of application/json alone asks for the JSON answer", () => {
  assert.equal(wantsJson({ accept: "application/json" }), true);
  for (const accept of [
    undefined,
    "",
    "*/*",
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "application/json, text/plain",
    "Application/JSON",
  ])
    assert.equal(
      wantsJson(accept === undefined ? {} : { accept }),
      false,
      String(accept),
    );
});

test("the page's one script sends the form by fetch, and closes its window only at an end", async () => {
  const cli = launch(SECRET_RUN, [
    ...generic("--timeout", "20"),
    "--",
    process.execPath,
    "-e",
    "",
  ]);
  const url = await cli.formUrl();
  const res = await browse(url);
  const html = await res.text();
  // LOAD-BEARING: held as text, since no browser runs here. One script, allowed by its hash alone.
  assert.equal(html.match(/<script/g)?.length, 1, "one script in the page");
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  const csp = res.headers.get("content-security-policy");
  assert.equal(
    /script-src ([^;]*)/.exec(csp)?.[1],
    `'sha256-${createHash("sha256").update(script).digest("base64")}'`,
  );
  assert.equal(/connect-src ([^;]*)/.exec(csp)?.[1], "'self'");

  // It sends by fetch, to the form's own two paths, with its cookie, asking for JSON; it never navigates.
  assert.equal(script.match(/\bfetch\(/g)?.length, 1, "one fetch");
  assert.match(script, /fetch\(cancel \? "\/cancel" : "\/", \{/);
  assert.match(script, /method: "POST",/);
  assert.match(script, /headers: \{ Accept: "application\/json" \},/);
  assert.match(script, /credentials: "same-origin",/);
  assert.match(script, /e\.preventDefault\(\);\n  if \(busy\) return;/);
  // A browser that can't say which button was pressed gets the plain form: a Cancel is never sent as a paste.
  assert.match(script, /\(e\) => \{\n  if \(!\("submitter" in e\)\) return;\n  e\.preventDefault\(\);/);
  assert.match(
    script,
    /const cancel = e\.submitter !== null && e\.submitter\.getAttribute\("formaction"\) === "\/cancel";/,
  );

  // It closes the window in one place, which only the end calls.
  assert.equal(script.match(/window\.close\(\)/g)?.length, 1, "one window.close()");
  assert.match(script, /const shut = \(\) => \{\n  window\.close\(\);/);
  assert.equal(script.match(/\bshut\b/g)?.length, 2, "shut, and its one call");
  assert.match(script, /setTimeout\(shut, after\);/);

  // The ends, and only these: the deadline, nothing answering, accepted (after 1.5 s), and the
  // answers that end the form. A refusal is none of them: the window stays open.
  assert.deepEqual(
    [...script.matchAll(/\bend\(([^()]*)\)/g)].map((m) => m[1]),
    ["WORDS.expired, 0", "WORDS.closed, 0", "answer.words, 1500", "answer.words, 0"],
  );
  assert.match(script, /const ENDS = \["cancelled", "closed", "expired"\];/);
  assert.match(script, /if \(state === "accepted"\) return end\(answer\.words, 1500\);/);
  assert.match(script, /if \(ENDS\.includes\(state\)\) return end\(answer\.words, 0\);/);
  assert.match(
    script,
    /\} catch \{\n    return end\(WORDS\.closed, 0\);/,
    "nothing answering at the form's address: closed",
  );

  // What it says itself; the fallback, for a window the browser keeps open, among them.
  assert.deepEqual(JSON.parse(/const WORDS = (\{.*\});/.exec(script)?.[1]), {
    closed: "This form has closed.",
    expired: "This form ran out of time. Nothing was run.",
    done: "Done. You can close this window.",
  });
  assert.match(script, /if \(window\.closed\) return;/, "the fallback only while the window is there");

  // The deadline: the time left, which the page is given and closes at.
  const left = Number(/<input name=v [^>]*data-left=(\d+)/.exec(html)?.[1]);
  assert.ok(left > 0 && left <= 20_000, `the time left, ${left} ms`);
  assert.match(script, /deadline = setTimeout\(\(\) => end\(WORDS\.expired, 0\), left\);/);

  // Without script, the form still posts as a form.
  assert.match(html, /<form method=post action="\/">/);
  assert.match(html, /formaction="\/cancel"/);
  await post(cancelUrl(url), {});
  assert.equal((await cli.done).code, 1);
});

test("a value the page's script posts that passes is answered accepted, with what it reached, never the value", async () => {
  const ran = join(tmp.dir, "ran-script");
  const cli = launch(SECRET_RUN, [
    "stand-in",
    "--profiles",
    profiles,
    "--",
    process.execPath,
    marker,
    ran,
  ]);
  const url = await cli.formUrl();
  const accepted = await scriptPost(url, { v: `  ${FAKE}\n` });
  assert.equal(accepted.status, 200);
  assert.equal(
    accepted.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.equal(accepted.headers.get("cache-control"), "no-store");
  assert.deepEqual(accepted.answer, {
    state: "accepted",
    words:
      "Trimmed 2 spaces at the start, and a line break at the end. Received. The key reached project stand-in (fake-project-123). Running the command.",
  });
  assertNoLeak(accepted.text, FAKE, "the answer");
  assert.equal((await cli.done).code, 0);
  assert.equal(existsSync(ran), true, "the command ran");
});

test("a value the page's script posts that is refused is answered with the reason, and the form stays open to paste again", async () => {
  const asked = check.hits.length;
  const cli = launch(SECRET_RUN, [
    ...generic(
      "--timeout",
      "20",
      "--shape",
      "^fake\\+\\S+$",
      "--shape-says",
      "start with fake+ and have no spaces",
    ),
    "--",
    process.execPath,
    "-e",
    "",
  ]);
  const url = await cli.formUrl();

  const unshaped = await scriptPost(url, { v: WRONG });
  assert.equal(unshaped.status, 422);
  assert.deepEqual(unshaped.answer, {
    state: "refused",
    words:
      "It doesn't look right: it should start with fake+ and have no spaces. Nothing was checked.",
  });
  assertNoLeak(unshaped.text, WRONG, "the answer");
  const empty = await scriptPost(url, { v: "   " });
  assert.equal(empty.status, 422);
  assert.deepEqual(empty.answer, { state: "refused", words: "Nothing was pasted." });
  assert.equal(check.hits.length, asked, "the check not asked yet");

  // Its shape, but not the key: the check's reason.
  const nearly = `fake+${WRONG}`;
  const refused = await scriptPost(url, { v: nearly });
  assert.equal(refused.status, 422);
  assert.equal(refused.answer?.state, "refused");
  assert.match(refused.answer?.words ?? "", /^That key didn't work: .*401/);
  assertNoLeak(refused.text, nearly, "the answer");
  assert.equal(check.hits.length, asked + 1);

  // Still open: the form, with the last reason in it, and a right value after.
  const again = await page(url);
  assert.equal(again.status, 200);
  assert.match(again.body, /<p id=error class=error role=alert>That key didn&#39;t work: .*401/);
  assert.equal((await scriptPost(url, { v: FAKE })).answer?.state, "accepted");
  assert.equal((await cli.done).code, 0);
});

test("the page's script cancels: it is told cancelled, nothing runs, and nothing answers at the form's address after", async () => {
  const ran = join(tmp.dir, "ran-script-cancel");
  const cli = launch(SECRET_RUN, [
    ...generic("--timeout", "20"),
    "--",
    process.execPath,
    marker,
    ran,
  ]);
  const url = await cli.formUrl();
  const cancelled = await scriptPost(cancelUrl(url), {});
  assert.equal(cancelled.status, 200);
  assert.deepEqual(cancelled.answer, {
    state: "cancelled",
    words: "Cancelled. Nothing was run.",
  });
  const { code, stderr } = await cli.done;
  assert.equal(code, 1);
  assert.match(stderr, /cancelled/);
  assert.equal(existsSync(ran), false);
  // What the page's script then meets: no answer at all, which it takes as closed (its catch).
  await assert.rejects(scriptPost(url, { v: FAKE }));
});

/**
 * A form served in this process, its check held until release(): its
 * address, when the check has begun, and its end. secret-run exits as its
 * form ends, so an answer the form gives after its end is held here.
 */
function heldForm(timeoutSec) {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  let begin;
  const checking = new Promise((r) => {
    begin = r;
  });
  let listening;
  const address = new Promise((r) => {
    listening = r;
  });
  const done = captureSecret({
    title: "Held form",
    prompt: "Paste a made-up key",
    timeoutSec,
    check: async () => {
      begin();
      await gate;
      return { ok: true, reached: null };
    },
    onListening: listening,
  });
  return { address, checking, release, done };
}

/** The headers the page's script sends: the form's cookie, traded for at its printed address, and the JSON Accept. */
async function scriptHeaders(url) {
  const cookie = (await raw(url)).headers["set-cookie"][0].split(";")[0];
  return { Cookie: cookie, Accept: "application/json" };
}

test("a value still being checked when the form ends is answered closed, or expired at the form's timeout", { timeout: 60_000 }, async () => {
  for (const [ending, timeoutSec, want] of [
    [
      "cancelled",
      20,
      { state: "closed", words: "This form has closed. Nothing was run." },
    ],
    [
      "timeout",
      3,
      { state: "expired", words: "This form ran out of time. Nothing was run." },
    ],
  ]) {
    const form = heldForm(timeoutSec);
    const url = await form.address;
    const { origin } = new URL(url);
    const headers = await scriptHeaders(url);
    const value = raw(`${origin}/`, {
      method: "POST",
      headers,
      fields: { v: FAKE },
    });
    await form.checking;
    if (ending === "cancelled") {
      const cancelled = await raw(`${origin}/cancel`, {
        method: "POST",
        headers,
        fields: {},
      });
      assert.equal(cancelled.status, 200);
      assert.deepEqual(JSON.parse(cancelled.body), {
        state: "cancelled",
        words: "Cancelled. Nothing was run.",
      });
    }
    assert.deepEqual(await form.done, { status: ending });
    form.release();
    const answer = await value;
    assert.equal(answer.status, 410, ending);
    assert.deepEqual(JSON.parse(answer.body), want, ending);
    assertNoLeak(answer.body, FAKE, `the answer once the form ended (${ending})`);
  }
});

/**
 * A POST begun now on a connection of its own, its request line and Host
 * sent, which finish(headers, body) completes: its status and raw text, once
 * the connection closes. The form reads its headers only when they are all
 * there, so one finished after the form's end is a request after the end.
 */
async function begun(url) {
  const { host, port } = new URL(url);
  const sock = connect({ host: "127.0.0.1", port: Number(port) });
  await once(sock, "connect");
  let text = "";
  sock.on("data", (c) => {
    text += c;
  });
  const closed = once(sock, "close");
  sock.write(`POST / HTTP/1.1\r\nHost: ${host}\r\n`);
  return {
    async finish(headers, body) {
      const all = {
        ...headers,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        Connection: "close",
      };
      sock.write(
        `${Object.entries(all)
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join("")}\r\n${body}`,
      );
      await closed;
      return { status: Number(/^HTTP\/1\.1 (\d{3}) /.exec(text)?.[1]), text };
    },
  };
}

test("a request the form reads once it has ended: the page's script is told closed, anything else finds nothing, as before", { timeout: 60_000 }, async () => {
  const form = heldForm(20);
  const url = await form.address;
  const { origin } = new URL(url);
  const headers = await scriptHeaders(url);
  const body = new URLSearchParams({ v: FAKE }).toString();
  // Begun while the form is open, so their connections outlive its end. A whole request on
  // another connection, answered, comes after the form has read their first lines.
  const fromScript = await begun(url);
  const plain = await begun(url);
  const stranger = await begun(url);
  assert.equal((await raw(`${origin}/`, { headers: { Cookie: headers.Cookie } })).status, 200);
  const cancelled = await raw(`${origin}/cancel`, {
    method: "POST",
    headers,
    fields: {},
  });
  assert.equal(cancelled.status, 200);
  assert.deepEqual(await form.done, { status: "cancelled" });

  const told = await fromScript.finish(headers, body);
  assert.equal(told.status, 410);
  assert.ok(
    told.text.includes(
      JSON.stringify({
        state: "closed",
        words: "This form has closed. Nothing was run.",
      }),
    ),
    told.text,
  );
  const asBefore = await plain.finish({ Cookie: headers.Cookie }, body);
  assert.equal(asBefore.status, 404, "a plain POST after the end, as before");
  const noCookie = await stranger.finish({ Accept: "application/json" }, body);
  assert.equal(noCookie.status, 404, "JSON asked without the cookie, as before");
  for (const r of [told, asBefore, noCookie])
    assertNoLeak(r.text, FAKE, "an answer after the end");
  form.release();
});
