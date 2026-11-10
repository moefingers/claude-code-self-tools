// A caller sends a hold nothing but a nonce until the broker has proved it
// holds the hold's token, and a broker does nothing for a caller that has
// not proved the same. A record whose broker is gone, or whose port another
// process now holds, is cleared, not used.
//
//   node --test plugins/self-secret/tools/secret-run/handshake.test.mjs

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { frame, frameReader, json } from "./frames.mjs";
import { exchange, holdFile, proof, writeHold } from "./hold.mjs";
import {
  FAKE,
  SECRET_RUN,
  fakeCheck,
  launch,
  post,
  profilesFile,
  scratch,
} from "./testkit.mjs";

let tmp;
let check;
let profiles;
let state;
let home;

before(async () => {
  tmp = scratch();
  check = await fakeCheck(FAKE);
  profiles = profilesFile(tmp.dir, check.url);
  state = join(tmp.dir, "state");
  home = join(state, "secret-run");
});

after(async () => {
  const path = holdFile(home, "stand-in");
  if (existsSync(path))
    try {
      const { pid } = JSON.parse(readFileSync(path, "utf8"));
      if (pid !== process.pid) process.kill(pid);
    } catch {
      // already gone
    }
  await check.close();
  tmp.cleanup();
});

/** A made-up variable the caller's environment carries, and a made-up token: built here, at run time. */
const CANARY = `canary-made-up-${randomBytes(3).toString("hex")}`;
const TOKEN = `made-up-token-for-the-test-${"0".repeat(15)}`;
const run = (args) =>
  launch(SECRET_RUN, args, { home: state, env: { PROBE_CANARY: CANARY } });

/** Every frame in the bytes. */
function framesIn(bytes) {
  const out = [];
  frameReader(
    (type, body) => out.push({ type, body }),
    () => out.push({ type: "too large" }),
  )(bytes);
  return out;
}

/**
 * A process listening where a record points, as an unrelated server
 * might: it hangs up, answers with a proof it cannot have, or says
 * nothing at all.
 */
async function squatter(mode) {
  const got = [];
  let connections = 0;
  const server = createServer((sock) => {
    connections++;
    sock.on("data", (c) => got.push(c));
    sock.on("error", () => {
      // the caller hung up
    });
    if (mode === "hangup") setTimeout(() => sock.end(), 300);
    if (mode === "bogus")
      sock.write(frame("P", { proof: "x".repeat(43), nonce: "y".repeat(43) }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    bytes: () => Buffer.concat(got),
    connections: () => connections,
    close: () => {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

/** A record for stand-in pointing at a port, naming a pid. */
function plantRecord(port, pid) {
  writeHold(home, {
    profile: "stand-in",
    envVar: "STAND_IN_KEY",
    pid,
    port,
    token: TOKEN,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}

/** What the squatter was sent: challenges, and none of what a run carries. */
function assertOnlyChallenges(bytes, count = 1) {
  const frames = framesIn(bytes);
  assert.deepEqual(
    frames.map((f) => f.type),
    Array(count).fill("C"),
    "challenges and nothing else",
  );
  for (const f of frames)
    assert.deepEqual(Object.keys(json(f.body)), ["nonce"]);
  const text = bytes.toString("utf8");
  for (const leak of [
    "made-up-token",
    CANARY,
    '"argv"',
    '"cwd"',
    '"env"',
    "PATH",
    "Path",
  ])
    assert.ok(!text.includes(leak), `sent ${leak}`);
}

for (const mode of ["hangup", "bogus"]) {
  test(`a peer on a stale record's port that ${mode === "hangup" ? "hangs up" : "cannot prove the token"} gets a nonce and nothing else, and the record is cleared`, async () => {
    const peer = await squatter(mode);
    plantRecord(peer.port, process.pid); // a live pid: only the proof tells
    const { code, stderr } = await run([
      "stand-in",
      "--use-hold",
      "--",
      process.execPath,
      "-e",
      "",
    ]).done;
    await peer.close();
    assert.equal(code, 1);
    assert.match(stderr, /no active hold for stand-in/);
    assertOnlyChallenges(peer.bytes());
    assert.equal(existsSync(holdFile(home, "stand-in")), false, "cleared");
  });
}

test("a record whose broker's pid is gone is cleared without connecting", async () => {
  const peer = await squatter("hangup");
  const dead = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => dead.on("exit", r));
  plantRecord(peer.port, dead.pid);
  const status = await run(["--hold-status"]).done;
  assert.match(status.stdout, /No active holds/);
  plantRecord(peer.port, dead.pid);
  const used = await run([
    "stand-in",
    "--use-hold",
    "--",
    process.execPath,
    "-e",
    "",
  ]).done;
  await peer.close();
  assert.equal(used.code, 1);
  assert.equal(peer.connections(), 0, "nothing connected to that port");
  assert.equal(existsSync(holdFile(home, "stand-in")), false);
});

test("a peer that says nothing does not hang the caller", async () => {
  const peer = await squatter("silent");
  plantRecord(peer.port, process.pid);
  const started = Date.now();
  const used = await run([
    "stand-in",
    "--use-hold",
    "--",
    process.execPath,
    "-e",
    "",
  ]).done;
  const status = await run(["--hold-status"]).done;
  const ended = await run(["--end-hold", "stand-in"]).done;
  await peer.close();
  assert.ok(Date.now() - started < 25_000, "each gave up within its time");
  assert.equal(used.code, 1);
  assert.match(used.stderr, /did not answer/);
  assert.match(status.stdout, /stand-in\s+not answering/);
  assert.match(ended.stdout, /did not answer/);
  assertOnlyChallenges(peer.bytes(), 3);
  assert.equal(
    existsSync(holdFile(home, "stand-in")),
    true,
    "a broker that may be busy is not cleared",
  );
  rmSync(holdFile(home, "stand-in"), { force: true });
});

/** A raw connection to a broker, frame by frame. */
function raw(port) {
  const sock = connect({ host: "127.0.0.1", port });
  const queue = [];
  const waiters = [];
  let closed = false;
  const deliver = () => {
    while (waiters.length && (queue.length || closed))
      waiters.shift()(queue.length ? queue.shift() : null);
  };
  sock.on(
    "data",
    frameReader(
      (type, body) => {
        queue.push({ type, body });
        deliver();
      },
      () => sock.destroy(),
    ),
  );
  sock.on("error", () => {
    // a broker that hangs up on us is what some tests expect
  });
  sock.on("close", () => {
    closed = true;
    deliver();
  });
  return {
    send: (type, payload) => sock.write(frame(type, payload)),
    next: () =>
      new Promise((r) => {
        waiters.push(r);
        deliver();
      }),
    close: () => sock.destroy(),
  };
}

test("a broker proves itself, and refuses a caller that cannot prove the token", async () => {
  const cli = run([
    "stand-in",
    "--profiles",
    profiles,
    "--hold",
    "1",
    "--",
    process.execPath,
    "-e",
    "",
  ]);
  await post(await cli.formUrl(), { v: FAKE });
  assert.equal((await cli.done).code, 0);
  const rec = JSON.parse(readFileSync(holdFile(home, "stand-in"), "utf8"));

  const nonce = randomBytes(32).toString("base64url");
  const c = raw(rec.port);
  c.send("C", { nonce });
  const p = await c.next();
  assert.equal(p.type, "P");
  const { proof: theirs, nonce: theirNonce } = json(p.body);
  assert.equal(theirs, proof(rec.token, "broker", nonce), "the broker's proof");
  c.send("A", { proof: proof("not-the-token", "caller", theirNonce) });
  c.send("H", {
    op: "run",
    argv: [process.execPath, "-e", ""],
    cwd: tmp.dir,
    env: {},
  });
  const refused = await c.next();
  assert.equal(refused?.type, "M");
  assert.equal(json(refused.body).error, "refused");
  c.close();

  // A caller that skips its proof and sends the request at once is refused too.
  const hasty = raw(rec.port);
  hasty.send("C", { nonce: randomBytes(32).toString("base64url") });
  assert.equal((await hasty.next())?.type, "P");
  hasty.send("H", { op: "status" });
  const skipped = await hasty.next();
  assert.equal(skipped?.type, "M");
  assert.equal(json(skipped.body).error, "refused");
  hasty.close();

  const big = raw(rec.port);
  big.send("C", "x".repeat(100 * 1024));
  assert.equal(
    await big.next(),
    null,
    "a first frame past 64 KiB is hung up on",
  );

  const forged = await exchange(
    { ...rec, token: "x".repeat(43) },
    { op: "status" },
  );
  assert.equal(
    forged.notBroker,
    true,
    "a caller with the wrong token sends no request",
  );

  const status = await exchange(rec, { op: "status" });
  assert.equal(status.reply?.uses, 1, "nothing refused was a use");
  await exchange(rec, { op: "end" });
});
