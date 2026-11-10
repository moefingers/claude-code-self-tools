// A profile names what a secret is for: the variable a command reads it
// from, the form's words, the page where the key is made, the check it must
// pass, and what else to redact.
//
// The profiles are the person's own: secret-profiles.json in the state
// folder (where.mjs), or the file a run names with --profiles. Nothing of
// anyone's ships with the plugin but `generic` and an example
// (profiles.example.json, beside this file). `generic` is built in: it takes
// its prompt and check from the command line, and a file can't redefine it.
// A profile may take its shape, spacesInside and redaction patterns from a
// pattern (patterns.mjs) by naming it.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertCheckable } from "./check.mjs";
import { assertShape, resolvePattern } from "./patterns.mjs";
import { redactor } from "./redact.mjs";
import { PROFILES_NAME, nativePath, stateFolder } from "./where.mjs";

export { nativePath };

/** A mistake in how the tool was called: said, and exit 64. */
export class UsageError extends Error {}

/** The built-in profile whose prompt and check are the command line's. */
export const GENERIC = "generic";

const BUILT_IN = {
  [GENERIC]: {
    title: "A secret for one command",
    envVar: "SECRET",
    fromCommandLine: true,
  },
};

/** A profile's name: also the name of its hold's file, so nothing but these. */
export const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The profiles file: the one --profiles names, else secret-profiles.json in
 * the state folder.
 */
export function profilesPath(file) {
  if (file !== undefined) return nativePath(file);
  const state = stateFolder();
  if (state === null)
    throw new UsageError(
      "%LOCALAPPDATA% is not set, so there is no state folder for the profiles file; name one with --profiles <file>",
    );
  return join(state, PROFILES_NAME);
}

/**
 * Every profile, by name: the built-in generic, then the file's. The
 * person's own file, before they make it, holds none; a file named with
 * --profiles must be there.
 */
export function loadProfiles(file) {
  const path = profilesPath(file);
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (!(err.code === "ENOENT" && file === undefined))
      throw new UsageError(
        `couldn't read the profiles in ${path}: ${err.message}`,
      );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new UsageError(
      `the profiles in ${path} are not an object of profiles by name`,
    );
  const own = Object.entries(raw).filter(([name]) => !name.startsWith("$"));
  if (own.some(([name]) => name === GENERIC))
    throw new UsageError(
      `${path} has a profile named ${GENERIC}, which is built in; give yours another name`,
    );
  return { ...BUILT_IN, ...Object.fromEntries(own) };
}

/** "Name: value" pairs from --check-header, as headers. */
function headersFrom(lines = []) {
  const headers = {};
  for (const line of lines) {
    const at = line.indexOf(":");
    if (at < 1)
      throw new UsageError(`--check-header takes "Name: value", not ${line}`);
    headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return headers;
}

/** The flags only the generic profile takes. */
export const GENERIC_ONLY = [
  "prompt",
  "env-var",
  "check-url",
  "check-header",
  "check-status",
  "check-cmd",
  "no-check",
  "shape",
  "shape-says",
  "spaces-inside",
  "url",
];

/**
 * The page where the person makes the key, which the form links to: an
 * address new URL reads, https, with no user name or password in it. A
 * refusal never says the address back, which may carry one.
 */
function assertUrl(url) {
  if (url === null) return;
  if (typeof url !== "string" || !URL.canParse(url))
    throw new Error("its url isn't an address");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:")
    throw new Error(
      `its url is ${parsed.protocol.slice(0, -1)}; it must be https`,
    );
  if (parsed.username || parsed.password)
    throw new Error(
      "its url has a user name or password in it; give the page's address alone",
    );
}

/**
 * The profile a run uses, checked whole before any form opens. flags are
 * the parsed command-line options; file, the --profiles file if one was
 * named.
 */
export function resolveProfile(name, flags = {}, file) {
  const all = loadProfiles(file);
  if (!PROFILE_NAME.test(name) || !Object.hasOwn(all, name))
    throw new UsageError(
      `there is no profile named ${name}; there are: ${Object.keys(all).join(", ")}. Add yours to ${profilesPath(file)} (the self-secret README, Profiles).`,
    );
  const p = all[name];
  if (p === null || typeof p !== "object" || Array.isArray(p))
    throw new UsageError(`the ${name} profile is not an object`);
  // A pattern named: its shape, spacesInside and redaction patterns are the
  // profile's, which then gives no shape or spacesInside of its own.
  let pattern = null;
  if (p.pattern !== undefined) {
    const own = ["shape", "spacesInside"].find((k) => p[k] !== undefined);
    if (own)
      throw new UsageError(
        `the ${name} profile names the pattern ${p.pattern} and its own ${own}; the pattern gives it`,
      );
    try {
      pattern = resolvePattern(p.pattern);
    } catch (err) {
      throw new UsageError(`the ${name} profile: ${err.message}`);
    }
  }
  // The profile's own redaction patterns: its pattern's first, then any it adds.
  const ownRedact = [...(pattern?.redact ?? []), ...(p.redact ?? [])];
  const profile = {
    name,
    title: p.title ?? name,
    envVar: p.envVar,
    prompt: p.prompt,
    url: p.url ?? null,
    check: p.check ?? null,
    shape: pattern ? pattern.shape : (p.shape ?? null),
    spacesInside: pattern ? pattern.spacesInside : p.spacesInside === true,
    redact: [...ownRedact, ...(flags.redact ?? [])],
  };

  if (p.fromCommandLine) {
    if (!flags.prompt)
      throw new UsageError(`the ${name} profile needs --prompt <text>`);
    profile.prompt = flags.prompt;
    if (flags["env-var"]) profile.envVar = flags["env-var"];
    const given = ["check-url", "check-cmd", "no-check"].filter(
      (f) => flags[f],
    );
    if (given.length !== 1)
      throw new UsageError(
        `the ${name} profile needs one of --check-url, --check-cmd or --no-check`,
      );
    if (flags["check-url"])
      profile.check = {
        type: "http",
        method: "GET",
        url: flags["check-url"],
        headers: headersFrom(flags["check-header"]),
        expectStatus: (flags["check-status"] ?? ["200"]).map(Number),
      };
    else if (flags["check-cmd"])
      profile.check = { type: "command", shell: flags["check-cmd"] };
    else profile.check = null;
    if (Boolean(flags.shape) !== Boolean(flags["shape-says"]))
      throw new UsageError(
        `--shape and --shape-says go together: the pattern, and the words that say it ("start with ghp_ and have no spaces")`,
      );
    if (flags.shape)
      profile.shape = { pattern: flags.shape, says: flags["shape-says"] };
    if (flags["spaces-inside"]) profile.spacesInside = true;
    if (flags.url !== undefined) profile.url = flags.url;
  } else {
    const misplaced = GENERIC_ONLY.find((f) => flags[f] !== undefined);
    if (misplaced)
      throw new UsageError(
        `--${misplaced} is for the generic profile; ${name} carries its own`,
      );
    if (!p.check)
      throw new UsageError(
        `the ${name} profile has no check; give it one in ${profilesPath(file)}`,
      );
  }

  if (
    typeof profile.envVar !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.envVar)
  )
    throw new UsageError(
      `the ${name} profile's variable name ${profile.envVar} is not one`,
    );
  if (typeof profile.prompt !== "string" || !profile.prompt)
    throw new UsageError(`the ${name} profile has no prompt`);
  try {
    assertCheckable(profile.check);
    assertShape(profile.shape);
    assertUrl(profile.url);
    redactor("", profile.redact);
  } catch (err) {
    throw new UsageError(`the ${name} profile: ${err.message}`);
  }
  profile.fromCommandLine = Boolean(p.fromCommandLine);
  // What a hold of this profile is held for: its variable, its check, the
  // shape a value must have and its own patterns. A hold serves only callers
  // whose profile matches. The title, prompt and url are only what the form
  // shows, and change nothing about the value held, so they are not in it.
  // A pattern's parts count as the profile's own, so naming a pattern that
  // says what a profile spelled out leaves its fingerprint as it was.
  profile.fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        envVar: profile.envVar,
        check: profile.check,
        shape: profile.shape,
        spacesInside: profile.spacesInside,
        redact: ownRedact,
      }),
    )
    .digest("base64url");
  return profile;
}
