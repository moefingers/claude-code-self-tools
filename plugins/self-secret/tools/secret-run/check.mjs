// A pasted value is tried before any command sees it.
//
// A check is an HTTP request made here, in this process, with fetch, or a
// command that reads the value on its standard input. It passes or it says,
// in a few words and without the value, why not. An HTTP check that passes
// can say what the key reached, read from the answer ("reached" in the
// profile: a template of dotted paths into its JSON), of which at most
// MAX_BODY is read. A command check that runs out of time is ended with
// every process it started.

import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_BODY = 1024 * 1024;
const MARK = "secret-run-value-placeholder";

/** A line of at most 160 characters, whitespace collapsed. */
const short = (text) => {
  const one = String(text).replace(/\s+/g, " ").trim();
  return one.length > 160 ? `${one.slice(0, 157)}...` : one;
};

/**
 * Throws when a check is malformed, or would send the value in the clear
 * to another machine: an HTTP check is https, or addresses this one, and
 * has {value} only in its path or query, never where a name lookup would
 * carry it to a DNS server.
 */
export function assertCheckable(check) {
  if (check === null) return;
  if (check?.type === "http") {
    let url;
    try {
      url = new URL(String(check.url).replaceAll("{value}", MARK));
    } catch {
      throw new Error(`the check URL ${check.url} is not a URL`);
    }
    if (
      `${url.username}${url.password}${url.host}`.toLowerCase().includes(MARK)
    )
      throw new Error(
        "a check URL takes {value} only in its path or query, never in its host",
      );
    if (!(
      url.protocol === "https:" ||
      (url.protocol === "http:" && LOOPBACK.has(url.hostname))
    ))
      throw new Error(
        `a check URL must be https unless it is this machine (${url.origin})`,
      );
    if (check.expectStatus && !check.expectStatus.every(Number.isInteger))
      throw new Error("a check's expectStatus is a list of status codes");
    return;
  }
  if (check?.type === "command") {
    const argvOk =
      Array.isArray(check.argv) &&
      check.argv.length > 0 &&
      check.argv.every((a) => typeof a === "string");
    if (!argvOk && typeof check.shell !== "string")
      throw new Error(
        "a command check names its command: argv (a list) or shell (a string)",
      );
    return;
  }
  throw new Error(`a check's type is http or command, not ${check?.type}`);
}

/** The template with each {dotted.path} read from the JSON answer, or null if one is missing. */
function reachedFrom(template, body) {
  let missing = false;
  const text = template.replace(/\{([\w.]+)\}/g, (_, path) => {
    const v = path
      .split(".")
      .reduce((o, k) => (o == null ? undefined : o[k]), body);
    if (v == null || typeof v === "object") missing = true;
    return String(v);
  });
  return missing ? null : text;
}

/** The answer's body as text, or throws once it passes MAX_BODY (and stops reading). */
async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) {
      await reader.cancel();
      throw new Error(`an answer longer than ${MAX_BODY} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Ends a process and every process it started. */
function killTree(child) {
  if (process.platform === "win32") {
    const taskkill = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "taskkill.exe",
    );
    spawnSync(taskkill, ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL"); // its process group (detached below)
  } catch {
    // The group is already gone; so is the check.
  }
}

async function httpCheck(check, value) {
  const host = new URL(check.url).host;
  const url = check.url.replaceAll("{value}", encodeURIComponent(value));
  const headers = Object.fromEntries(
    Object.entries(check.headers ?? {}).map(([k, v]) => [
      k,
      String(v).replaceAll("{value}", value),
    ]),
  );
  const seconds = check.timeoutSeconds ?? 15;
  let res;
  try {
    res = await fetch(url, {
      method: check.method ?? "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(seconds * 1000),
    });
  } catch (err) {
    if (err.name === "TimeoutError")
      return {
        ok: false,
        reason: `${host} did not answer within ${seconds} s`,
      };
    return {
      ok: false,
      reason: `couldn't reach ${host} (${err.cause?.code ?? err.message})`,
    };
  }
  let body = null;
  try {
    body = JSON.parse(await readCapped(res));
  } catch {
    // An answer that is not JSON, or longer than MAX_BODY, names nothing;
    // the status still decides.
  }
  if (!(check.expectStatus ?? [200]).includes(res.status)) {
    const said =
      typeof body?.message === "string" && body.message
        ? `: ${body.message}`
        : "";
    return {
      ok: false,
      reason: `${host} answered ${res.status} ${res.statusText}${said}`,
    };
  }
  return {
    ok: true,
    reached: check.reached ? reachedFrom(check.reached, body) : null,
  };
}

function commandCheck(check, value) {
  return new Promise((resolve) => {
    const seconds = check.timeoutSeconds ?? 30;
    const options = {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Elsewhere a group of its own, so that the group can be ended whole.
      detached: process.platform !== "win32",
    };
    const child = check.argv
      ? spawn(check.argv[0], check.argv.slice(1), options)
      : spawn(check.shell, { ...options, shell: true });
    let out = "";
    let err = "";
    let late = false;
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    const timer = setTimeout(() => {
      late = true;
      if (child.pid) killTree(child);
    }, seconds * 1000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        reason: `the check command couldn't start (${e.code ?? e.message})`,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const said = (s) =>
        s
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
      if (code === 0 && !late)
        return resolve({ ok: true, reached: said(out)[0] ?? null });
      const last = said(err).at(-1);
      resolve({
        ok: false,
        reason: late
          ? `the check command did not finish within ${seconds} s`
          : `the check command exited ${code}${last ? `: ${last}` : ""}`,
      });
    });
    // A check that exits without reading its input closes the pipe early;
    // its exit code is the answer.
    child.stdin.on("error", () => {});
    child.stdin.end(value);
  });
}

/**
 * Tries the value. Resolves { ok: true, reached } or { ok: false, reason },
 * never rejects; what it says is scrubbed.
 */
export async function runCheck(check, value, scrub) {
  if (!check) return { ok: true, reached: null };
  const result =
    check.type === "http"
      ? await httpCheck(check, value)
      : await commandCheck(check, value);
  return {
    ok: result.ok,
    reason: result.reason ? short(scrub(result.reason)) : undefined,
    reached: result.reached ? short(scrub(result.reached)) : null,
  };
}
