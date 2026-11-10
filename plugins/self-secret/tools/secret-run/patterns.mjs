// A pattern names a kind of value, declared once (patterns.json, beside this file): its shape (a
// regular expression over the trimmed value, and the words the form finishes "it should …" with),
// whether spaces may sit inside it, an optional live check (an http request the value must pass;
// never a command), and redaction patterns for what a command prints. A profile takes its shape,
// spacesInside and redaction from one by naming it ("pattern": "github"). Each comes from its
// vendor's own documentation, its `doc`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCheckable } from "./check.mjs";
import { redactor } from "./redact.mjs";

export const PATTERNS = join(
  dirname(fileURLToPath(import.meta.url)),
  "patterns.json",
);

/** A pattern's name, as a profile's is. */
export const PATTERN_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A key's shape, { pattern, says }, checked whole: the pattern a regular
 * expression over characters (the u flag) that an empty string doesn't match,
 * and says the words the form finishes "it should …" with.
 */
export function assertShape(shape) {
  if (shape === null) return;
  if (
    typeof shape !== "object" ||
    typeof shape.pattern !== "string" ||
    !shape.pattern ||
    typeof shape.says !== "string" ||
    !shape.says
  )
    throw new Error('its shape needs "pattern" and "says"');
  let re;
  try {
    re = new RegExp(shape.pattern, "u");
  } catch (err) {
    throw new Error(`its shape's pattern isn't one: ${err.message}`);
  }
  if (re.test(""))
    throw new Error("its shape's pattern matches an empty value");
}

/** Every pattern in the file, by name. */
export function loadPatterns(file = PATTERNS) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`couldn't read the patterns in ${file}: ${err.message}`);
  }
  return Object.fromEntries(
    Object.entries(raw).filter(([name]) => !name.startsWith("$")),
  );
}

/** The pattern of that name, checked whole. Throws, saying why. */
export function resolvePattern(name, file = PATTERNS) {
  const all = loadPatterns(file);
  if (!PATTERN_NAME.test(String(name)) || !Object.hasOwn(all, name))
    throw new Error(
      `there is no pattern named ${name}; there are: ${Object.keys(all).join(", ")}`,
    );
  const p = all[name];
  const pattern = {
    name,
    title: typeof p.title === "string" ? p.title : name,
    doc: typeof p.doc === "string" ? p.doc : null,
    shape: p.shape ?? null,
    spacesInside: p.spacesInside === true,
    check: p.check ?? null,
    redact: [...(p.redact ?? [])],
  };
  try {
    assertShape(pattern.shape);
    // A pattern's check is an http check alone, never a command.
    if (pattern.check !== null && pattern.check?.type !== "http")
      throw new Error("its check is an http check, or none");
    assertCheckable(pattern.check);
    if (!Array.isArray(pattern.redact) || !pattern.redact.every((r) => typeof r === "string"))
      throw new Error("its redact is a list of patterns");
    redactor("", pattern.redact);
  } catch (err) {
    throw new Error(`the pattern ${name}: ${err.message}`);
  }
  return pattern;
}
