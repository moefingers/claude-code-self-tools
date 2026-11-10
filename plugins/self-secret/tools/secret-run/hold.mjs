// A hold: the value kept in a broker's memory for a set time after its
// first paste, so later commands run without another. The caller never
// receives the value: it asks the broker to run a command, and the broker
// runs it, with the value set and the output scrubbed, and streams back
// what it printed.
//
// The broker listens on 127.0.0.1. Its token is written, with its port and
// pid and nothing secret, to <home>/holds/<profile>.json: home is
// secret-run in the state folder (where.mjs). The holds folder is this
// user's alone (icacls on Windows, mode 700 elsewhere). Each side proves it
// holds the token before the other acts (frames.mjs): the caller sends
// nothing but a nonce until the broker has proved itself, so a record whose
// port another process now holds gets nothing else. A record whose broker is
// gone (its pid ended, nothing listening, or what listens cannot prove the
// token) is cleared the next time anything looks for it; a broker that does
// not answer within the time is reported, and its record kept.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIRST_FRAME_MAX,
  MAX_FRAME,
  frame,
  frameReader,
  json,
  jsonOrNull,
} from "./frames.mjs";
import { PROFILE_NAME, UsageError } from "./profiles.mjs";
import { assertOwn, stateFolder, system32 } from "./where.mjs";

export { system32 };

export const MAX_HOLD_MINUTES = 120;

const BROKER = join(dirname(fileURLToPath(import.meta.url)), "broker.mjs");

/** Where holds are kept: secret-run in the state folder, which must be the person's own to change (where.mjs). */
export function holdHome() {
  const state = stateFolder();
  if (state === null)
    throw new UsageError(
      "%LOCALAPPDATA% is not set, so there is no state folder to keep holds in",
    );
  try {
    assertOwn([{ path: state, what: "the state folder" }]);
  } catch (err) {
    throw new UsageError(err.message);
  }
  return join(state, "secret-run");
}
export const holdsDir = (home) => join(home, "holds");
export function holdFile(home, profile) {
  if (!PROFILE_NAME.test(profile))
    throw new Error(`${profile} is not a profile's name`);
  return join(holdsDir(home), `${profile}.json`);
}

/** This user's security identifier, as Windows names it (whoami /user). */
function userSid() {
  const r = spawnSync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const sid = /"(S-1-[\d-]+)"/.exec(r.stdout ?? "")?.[1];
  if (!sid) throw new Error("couldn't read this user's SID from whoami /user");
  return sid;
}

/** Makes the folder, and leaves it readable and writable by this user alone. */
export function secureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") return chmodSync(dir, 0o700);
  // Inheritance off, every inherited grant gone, and one grant, to this
  // user by SID (a name can be ambiguous), that the files made inside
  // inherit.
  const sid = userSid();
  const r = spawnSync(
    system32("icacls.exe"),
    [dir, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`],
    { encoding: "utf8", windowsHide: true },
  );
  if (r.status !== 0)
    throw new Error(
      `couldn't limit ${dir} to ${userInfo().username}: ${`${r.stdout}${r.stderr}`.trim()}`,
    );
}

/** Writes a hold's record, whole or not at all. */
export function writeHold(home, record) {
  secureDir(holdsDir(home));
  const path = holdFile(home, record.profile);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  renameSync(tmp, path);
}

/** A hold's record, or null. */
export function readHold(home, profile) {
  try {
    return JSON.parse(readFileSync(holdFile(home, profile), "utf8"));
  } catch {
    // No file, or one half-written: no hold either way.
    return null;
  }
}

/** Removes a hold's record, if it is still the one given. */
export function clearHold(home, record) {
  const now = readHold(home, record.profile);
  if (now && now.pid === record.pid && now.port === record.port)
    rmSync(holdFile(home, record.profile), { force: true });
}

/** One side's proof that it holds the token: an HMAC of the other's nonce. */
export const proof = (token, role, nonce) =>
  createHmac("sha256", String(token))
    .update(`secret-run ${role}\0${nonce}`)
    .digest("base64url");

/** The strings are equal, compared in constant time. */
export function sameSecret(given, want) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(String(want));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether a process of this user with that pid is running. */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: no such process. EPERM: another user's, so not this user's broker.
    return false;
  }
}

/**
 * Sends one request to a hold's broker and collects its answer, once the
 * broker has proved it holds the record's token: until then the caller
 * sends a nonce and nothing else. onFrame sees the frames a run streams
 * (U, O, R); stdin, if given, is forwarded once the broker has begun the
 * command. Gives up when no answer (J, M, or a run's U) comes within
 * timeoutMs. Resolves { reply, error, message, exit, connectError,
 * notBroker, timedOut }.
 */
export function exchange(
  record,
  request,
  { onFrame = () => {}, stdin = null, timeoutMs = 5_000 } = {},
) {
  return new Promise((resolve) => {
    const result = {
      reply: null,
      error: null,
      message: null,
      exit: null,
      connectError: null,
      notBroker: false,
      timedOut: false,
    };
    const nonce = randomBytes(32).toString("base64url");
    let proven = false;
    let forwarding = false;
    const sock = connect({ host: "127.0.0.1", port: record.port });
    const timer = setTimeout(() => {
      result.timedOut = true;
      sock.destroy();
    }, timeoutMs);
    const notBroker = () => {
      result.notBroker = true;
      sock.destroy();
    };
    const forward = () => {
      if (!stdin || forwarding) return;
      forwarding = true;
      stdin.on("data", (d) => sock.write(frame("I", d)));
      stdin.on("end", () => sock.write(frame("E", "")));
    };
    const read = frameReader(
      (type, body) => {
        if (!proven) {
          const p = type === "P" ? jsonOrNull(body) : null;
          if (
            typeof p?.nonce !== "string" ||
            !sameSecret(p.proof, proof(record.token, "broker", nonce))
          )
            return notBroker();
          proven = true;
          read.limit(MAX_FRAME);
          sock.write(
            frame("A", { proof: proof(record.token, "caller", p.nonce) }),
          );
          sock.write(frame("H", request));
          return;
        }
        if (type === "J") {
          clearTimeout(timer);
          result.reply = json(body);
        } else if (type === "M") {
          clearTimeout(timer);
          const { error, message } = json(body);
          Object.assign(result, { error, message });
        } else if (type === "X") result.exit = json(body);
        else {
          if (type === "U") {
            clearTimeout(timer);
            forward();
          }
          onFrame(type, body);
        }
      },
      () => (proven ? sock.destroy() : notBroker()),
      { max: FIRST_FRAME_MAX },
    );
    sock.on("connect", () => sock.write(frame("C", { nonce })));
    sock.on("data", read);
    // Failing before anything was read means nothing listens there;
    // failing later is a run cut short, which the missing X says.
    sock.on("error", (err) => {
      if (sock.bytesRead === 0 && !result.timedOut)
        result.connectError ??= err.code ?? err.message;
    });
    sock.on("close", () => {
      clearTimeout(timer);
      // Hung up on before proving anything: not a broker of this hold.
      if (!proven && !result.timedOut && !result.connectError)
        result.notBroker = true;
      if (forwarding) stdin.pause();
      resolve(result);
    });
  });
}

/**
 * The hold for a profile: { record, status } when its broker answers,
 * { record, status: null } when it does not answer in time, or null when
 * there is none. A record whose broker is gone is cleared: its pid ended,
 * nothing listens on its port, or what listens cannot prove its token.
 */
export async function liveHold(home, profile) {
  const record = readHold(home, profile);
  if (!record) return null;
  if (!pidAlive(record.pid)) {
    clearHold(home, record);
    return null;
  }
  const { reply, timedOut } = await exchange(record, { op: "status" });
  if (reply) return { record, status: reply };
  if (timedOut) return { record, status: null };
  clearHold(home, record);
  return null;
}

/** Every live hold, by profile. */
export async function liveHolds(home) {
  const dir = holdsDir(home);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .filter((n) => PROFILE_NAME.test(n));
  const found = await Promise.all(names.map((n) => liveHold(home, n)));
  return found.filter(Boolean);
}

/**
 * Starts a broker that serves the form for this profile and, once a value
 * passes, holds it. Resolves { status: "ok", reached, expiresAt } once the
 * hold is live, or the form's own ending (cancelled, timeout, bind-error),
 * or broker-error.
 */
export function startHold({
  profile,
  minutes,
  timeoutSec,
  home,
  note,
  onUrl,
  onRejected,
}) {
  return new Promise((resolve) => {
    // The broker holds the value for its whole life: no inspector may be
    // switched on in it from outside.
    const flags = process.allowedNodeEnvironmentFlags.has("--disable-sigusr1")
      ? ["--disable-sigusr1"]
      : [];
    // Nor may options the caller's Node was given (an --inspect, a
    // --require) reach it.
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const broker = spawn(process.execPath, [...flags, BROKER], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
      env,
      // Its own folder, so it never keeps the caller's folder from being removed.
      cwd: homedir(),
    });
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    broker.on("message", (m) => {
      if (m.type === "url") onUrl(m.url);
      else if (m.type === "rejected") onRejected(m.reason);
      else if (m.type === "ready") {
        broker.disconnect();
        broker.unref();
        settle({ status: "ok", reached: m.reached, expiresAt: m.expiresAt });
      } else if (m.type === "ended")
        settle({ status: m.status, message: m.message });
    });
    broker.on("error", (err) =>
      settle({ status: "broker-error", message: err.message }),
    );
    broker.on("exit", (code) =>
      settle({
        status: "broker-error",
        message: `the broker exited (${code}) before the hold began`,
      }),
    );
    broker.send({ type: "start", profile, minutes, timeoutSec, home, note });
  });
}
