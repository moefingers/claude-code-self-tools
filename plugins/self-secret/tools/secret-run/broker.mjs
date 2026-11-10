// A hold's broker: serves the form, keeps the value that passes in memory
// for the hold's length, and runs the commands its token's holders send.
//
// Started by secret-run (hold.mjs → startHold), detached, with no console
// and an IPC channel it uses only until the hold begins. Nothing it holds
// is written down: the record in <home>/holds/ has its port, pid and
// token. Each connection begins with the handshake (frames.mjs): the
// broker proves it holds the token, then the caller must, before the
// broker reads a request. It ends at expiry, on --end-hold, when its record
// is removed or names another broker, and with the session (Windows ends
// every process of a session when its user signs out). A command still
// running when it ends finishes; no new one starts.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck } from "./check.mjs";
import { captureSecret } from "./form.mjs";
import {
  FIRST_FRAME_MAX,
  MAX_FRAME,
  frame,
  frameReader,
  jsonOrNull,
} from "./frames.mjs";
import {
  clearHold,
  holdFile,
  proof,
  sameSecret,
  writeHold,
} from "./hold.mjs";
import { redactor } from "./redact.mjs";
import { spawnScrubbed } from "./run.mjs";

const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);

let record = null;
let home = null;
let red = null;
let value = null;
let patterns = [];
let ended = false;
let uses = 0;
/** The latest uses, by number, time and command name: what --hold-status lists. */
const recent = [];
const RECENT = 20;
let running = 0;
let server = null;

const tell = (message) =>
  new Promise((resolve) => {
    if (!process.connected) return resolve();
    process.send(message, () => resolve());
  });

/**
 * The hold ends: no new command starts and the value is let go. The broker
 * exits once every connection has closed, so a running command's last
 * output and exit code still reach its caller.
 */
function end() {
  if (ended) return;
  ended = true;
  value = null;
  clearHold(home, record);
  server.close(() => process.exit(0));
}

function serve(sock) {
  // challenge → caller's proof → request → running; closed once refused.
  let stage = "challenge";
  let child = null;
  const nonce = randomBytes(32).toString("base64url");
  const send = (type, body) => {
    if (!sock.destroyed) sock.write(frame(type, body));
  };
  const refuse = (error, message) => {
    stage = "closed";
    send("M", { error, message });
    sock.end();
  };
  const idle = setTimeout(() => sock.destroy(), 10_000);
  // A caller that goes away mid-run takes its command with it, as Ctrl-C would.
  sock.on("close", () => {
    clearTimeout(idle);
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill();
  });
  sock.on("error", () => {
    // The caller went away; close says so.
  });
  const read = frameReader(
    (type, body) => {
      if (stage === "challenge") {
        const c = type === "C" ? jsonOrNull(body) : null;
        if (typeof c?.nonce !== "string" || c.nonce.length > 256)
          return sock.destroy();
        stage = "proof";
        return send("P", {
          proof: proof(record.token, "broker", c.nonce),
          nonce,
        });
      }
      if (stage === "proof") {
        const a = type === "A" ? jsonOrNull(body) : null;
        if (!sameSecret(a?.proof, proof(record.token, "caller", nonce)))
          return refuse("refused", "not this hold's token");
        stage = "request";
        read.limit(MAX_FRAME);
        return;
      }
      if (stage === "request") {
        clearTimeout(idle);
        const h = type === "H" ? jsonOrNull(body) : null;
        if (!h) return refuse("refused", "no request");
        stage = "running";
        return handle(h);
      }
      if (stage === "running") {
        if (type === "I") child?.stdin?.write(body);
        else if (type === "E") child?.stdin?.end();
      }
    },
    () => sock.destroy(),
    { max: FIRST_FRAME_MAX },
  );
  sock.on("data", read);

  function handle(h) {
    if (over()) {
      end();
      return refuse("ended", "the hold has ended");
    }
    if (h.op === "status") {
      send("J", {
        profile: record.profile,
        expiresAt: record.expiresAt,
        uses,
        recent,
        running,
        // Where it listens, as the socket says: 127.0.0.1 (hold.test.mjs holds it there).
        address: server.address()?.address ?? null,
      });
      return sock.end();
    }
    if (h.op === "end") {
      send("J", { ended: true, running });
      sock.end();
      return end();
    }
    if (h.op !== "run")
      return refuse("refused", "not a request this broker knows");
    const strings = (a) =>
      Array.isArray(a) && a.every((s) => typeof s === "string");
    if (!strings(h.argv) || !h.argv.length)
      return refuse("refused", "no command");
    // The caller's --redact, added to the profile's for this run.
    let scrubber = red;
    if (h.redact?.length) {
      if (!strings(h.redact))
        return refuse("refused", "redaction patterns are strings");
      try {
        scrubber = redactor(value, [...patterns, ...h.redact]);
      } catch (err) {
        return refuse("refused", err.message);
      }
    }
    start(
      h.argv,
      scrubber.scrub(basename(h.argv[0])),
      {
        env: { ...(h.env ?? {}), [record.envVar]: value },
        cwd: h.cwd,
        stdin: "pipe",
      },
      scrubber,
    );
  }

  /** A command begins: its use told, its output scrubbed, its end sent back. */
  function start(argv, command, options, scrubber) {
    uses++;
    running++;
    const use = { use: uses, at: new Date().toISOString(), command };
    recent.push(use);
    if (recent.length > RECENT) recent.shift();
    send("U", { profile: record.profile, ...use });
    const run = spawnScrubbed(argv, options, scrubber, {
      out: (b) => send("O", b),
      err: (b) => send("R", b),
    });
    child = run.child;
    child?.stdin?.on("error", () => {
      // A command that exits without reading its input closes the pipe.
    });
    run.done.then((result) => {
      running--;
      send(
        "X",
        result.error
          ? {
              code: 127,
              error: scrubber.scrub(
                `couldn't start ${argv[0]} (${result.error})`,
              ),
            }
          : { code: result.code, signal: result.signal },
      );
      sock.end();
    });
  }
}

/**
 * Whether the hold is over, by the clock rather than a timer alone: a
 * machine that slept past its expiry wakes with the timer still pending.
 * Over too when its record is gone, names another broker, or names an
 * earlier expiry (a record can shorten a hold, never lengthen it).
 */
function over() {
  if (ended) return true;
  const now = Date.now();
  if (now >= Date.parse(record.expiresAt)) return true;
  let onDisk;
  try {
    onDisk = JSON.parse(readFileSync(holdFile(home, record.profile), "utf8"));
  } catch (err) {
    // Gone is gone; a file another process has open for a moment, or one
    // being rewritten, is looked at again on the next round.
    return err.code === "ENOENT";
  }
  return onDisk.pid !== process.pid || now >= Date.parse(onDisk.expiresAt);
}

function watch() {
  if (over()) end();
}

/**
 * Holds a value that passed: listens on 127.0.0.1, writes the hold's
 * record and keeps the value for `minutes`. Resolves { status: "ok",
 * expiresAt, end, server } once the hold is live (end ends it), or
 * { status: "bind-error" | "broker-error", message } when it couldn't begin.
 */
export function beginHold({ profile, minutes, value: passed, home: at }) {
  home = at;
  value = passed;
  patterns = profile.redact;
  red = redactor(value, patterns);
  return new Promise((resolve) => {
    const fail = (status, message) => {
      value = null;
      record = null;
      resolve({ status, message });
    };
    let listening = false;
    server = createServer(serve);
    // Before it listens, an error is a hold that never began. After, it is the server failing under
    // a live hold: the session is told, and the broker exits (4), its record cleared on the way out;
    // never a value let go while the server still serves.
    server.on("error", async (err) => {
      if (!listening) return fail("bind-error", err.message);
      await tell({ type: "ended", status: "bind-error", message: err.message });
      process.exit(4);
    });
    server.listen(0, "127.0.0.1", () => {
      listening = true;
      const now = Date.now();
      record = {
        profile: profile.name,
        envVar: profile.envVar,
        fingerprint: profile.fingerprint,
        pid: process.pid,
        port: server.address().port,
        token: randomBytes(32).toString("base64url"),
        startedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + minutes * 60_000).toISOString(),
      };
      try {
        writeHold(home, record);
      } catch (err) {
        server.close();
        return fail("broker-error", err.message);
      }
      setTimeout(end, minutes * 60_000);
      setInterval(watch, 2_000).unref();
      resolve({ status: "ok", expiresAt: record.expiresAt, end, server });
    });
  });
}

/** The broker's life: what its first IPC message asks, the form, then the hold. */
export function serveBroker() {
  // The caller gone before the hold began: there is nothing to hold for.
  process.on("disconnect", () => {
    if (!record) process.exit(1);
  });

  process.on("exit", () => {
    if (record) clearHold(home, record);
  });

  process.once("message", async (m) => {
    const { profile, minutes, timeoutSec, note } = m;
    const result = await captureSecret({
      title: profile.title,
      prompt: profile.prompt,
      url: profile.url,
      note,
      timeoutSec,
      check: (v) =>
        runCheck(profile.check, v, redactor(v, profile.redact).scrub),
      shape: profile.shape,
      spacesInside: profile.spacesInside,
      onListening: (url) => tell({ type: "url", url }),
      onRejected: (reason) => tell({ type: "rejected", reason }),
      successText: (reached) =>
        `Received.${reached ? ` The key reached ${reached}.` : ""} Held until ${clock(Date.now() + minutes * 60_000)}. Running the command — you can close this tab.`,
    });
    if (result.status !== "ok") {
      await tell({
        type: "ended",
        status: result.status,
        message: result.message,
      });
      process.exit(0);
    }
    const held = await beginHold({
      profile,
      minutes,
      value: result.value,
      home: m.home,
    });
    if (held.status !== "ok") {
      await tell({ type: "ended", status: held.status, message: held.message });
      process.exit(held.status === "bind-error" ? 4 : 1);
    }
    await tell({
      type: "ready",
      reached: result.reached,
      expiresAt: held.expiresAt,
    });
  });
}

// Run as the broker (hold.mjs spawns this file).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  serveBroker();
}
