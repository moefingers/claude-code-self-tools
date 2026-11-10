// Redaction catches the value in every form it promises, wherever a chunk
// boundary falls.
//
//   node --test plugins/self-secret/tools/secret-run/redact.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { MASK, redactor } from "./redact.mjs";
import { FAKE, NAPI, assertNoLeak, dbUrl, formsOf } from "./testkit.mjs";

const PATTERNS = ["napi_[A-Za-z0-9]+", "postgres(ql)?://\\S+"];

test("each form of the value is replaced, and the text around it kept", () => {
  // At every length's remainder by 3: a value of 3n bytes has no base64 padding, and its stretch of a
  // longer blob is the whole of its base64, so only a value of 3n + 1 or 3n + 2 bytes shows that its
  // own base64 forms, padding and all, are needles too.
  for (const value of [FAKE, `${FAKE}x`, `${FAKE}xy`]) {
    const { scrub } = redactor(value, PATTERNS);
    const rest = Buffer.byteLength(value) % 3;
    for (const [name, form] of Object.entries(formsOf(value)))
      assert.equal(scrub(`a ${form} b`), `a ${MASK} b`, `${name}, 3n + ${rest} bytes`);
  }
  const { scrub } = redactor(FAKE, PATTERNS);
  assert.equal(scrub(`a ${formsOf(FAKE).hex.toUpperCase()} b`), `a ${MASK} b`);
  assert.equal(scrub(`a ${FAKE.toUpperCase()} b`), `a ${MASK} b`, "upper case");
  assert.equal(
    scrub(`a ${Buffer.from(FAKE, "utf16le").toString("latin1")} b`),
    `a ${MASK} b`,
    "UTF-16LE",
  );
});

test("the value inside a longer base64 blob, at every alignment", () => {
  const { scrub } = redactor(FAKE, []);
  for (const prefix of ["", "u:", "user:", "Bearer x "]) {
    const blob = Buffer.from(prefix + FAKE + "!tail").toString("base64");
    const out = scrub(`Authorization: Basic ${blob}`);
    assertNoLeak(out, FAKE, `the blob after ${JSON.stringify(prefix)}`);
    assert.ok(out.includes(MASK), JSON.stringify(prefix));
  }
});

test("the profile's patterns", () => {
  const { scrub } = redactor(FAKE, PATTERNS);
  assert.equal(
    scrub(`key ${NAPI}, url ${dbUrl("u", "p", "host/db?x=1")} done`),
    `key ${MASK}, url ${MASK} done`,
  );
  assert.equal(scrub(`${"postgres"}://a${"@"}b/c`), MASK);
});

test("a pattern that matches nothing at all is refused", () => {
  assert.throws(() => redactor(FAKE, ["a*"]), /matches an empty string/);
  assert.throws(() => redactor(FAKE, ["("]), /not a valid pattern/);
});

test("a stream fed one byte at a time leaks nothing and loses nothing else", () => {
  const { lines } = redactor(FAKE, PATTERNS);
  const text = [
    `exact ${FAKE}`,
    `url ${encodeURIComponent(FAKE)}`,
    `b64 ${Buffer.from(FAKE).toString("base64")}`,
    `key ${NAPI}`,
    `plain line`,
    `tail without newline ${FAKE}`,
  ].join("\n");
  const pieces = [];
  const stream = lines((b) => pieces.push(b));
  for (const byte of Buffer.from(text)) stream.push(Buffer.from([byte]));
  const beforeEnd = Buffer.concat(pieces).toString("utf8");
  assert.ok(!beforeEnd.includes("tail without"), "an unfinished line waits");
  stream.end();
  const out = Buffer.concat(pieces).toString("utf8");
  assertNoLeak(out, FAKE);
  assert.equal(
    out,
    [
      `exact ${MASK}`,
      `url ${MASK}`,
      `b64 ${MASK}`,
      `key ${MASK}`,
      `plain line`,
      `tail without newline ${MASK}`,
    ].join("\n"),
  );
});

test("a value with multibyte characters split inside a character", () => {
  const value = "clé-secrète-ü-0123456789";
  const { lines } = redactor(value, []);
  const bytes = Buffer.from(`one ${value} two\n`);
  const pieces = [];
  const stream = lines((b) => pieces.push(b));
  const cut = Buffer.from("one clé").length - 1; // inside the é
  stream.push(bytes.subarray(0, cut));
  stream.push(bytes.subarray(cut));
  stream.end();
  assert.equal(Buffer.concat(pieces).toString("utf8"), `one ${MASK} two\n`);
});

test("bytes that are not text pass through unchanged", () => {
  const { lines } = redactor(FAKE, []);
  const binary = Buffer.from([0, 255, 254, 10, 128, 13, 10, 7]);
  const pieces = [];
  const stream = lines((b) => pieces.push(b));
  stream.push(binary.subarray(0, 3));
  stream.push(binary.subarray(3));
  stream.end();
  assert.deepEqual(Buffer.concat(pieces), binary);
});

test("a line longer than the buffer is flushed without splitting the value", () => {
  const { lines } = redactor(FAKE, []);
  const pieces = [];
  const stream = lines((b) => pieces.push(b), { maxLine: 256 });
  const long = "x".repeat(250) + FAKE + "y".repeat(250) + FAKE;
  for (let i = 0; i < long.length; i += 33)
    stream.push(Buffer.from(long.slice(i, i + 33)));
  assert.ok(pieces.length > 0, "it flushed before the end");
  stream.end();
  const out = Buffer.concat(pieces).toString("utf8");
  assertNoLeak(out, FAKE);
  assert.equal(out, "x".repeat(250) + MASK + "y".repeat(250) + MASK);
});

/** What a stream of these chunks comes out as. */
function streamed(red, chunks, opts) {
  const pieces = [];
  const stream = red.lines((b) => pieces.push(b), opts);
  for (const c of chunks) stream.push(Buffer.from(c));
  stream.end();
  return Buffer.concat(pieces).toString("utf8");
}

test("past four times the limit a line is flushed, still never through the value", () => {
  // The reviewer's probe: a pattern match spanning the line held it whole
  // until the forced flush, which cut the value after 10 characters.
  const red = redactor(FAKE, ["postgres(ql)?://\\S+"]);
  const out = streamed(
    red,
    [
      "postgres://" + "x".repeat(250) + FAKE.slice(0, 10),
      FAKE.slice(10) + " tail\n",
    ],
    { maxLine: 64 },
  );
  assertNoLeak(out, FAKE);
  assert.ok(!out.includes(FAKE.slice(10)), "the value's tail");
  assert.match(out, /\[redacted\] tail\n$/);
});

test("the value's JSON, string-literal and HTML escapes, and lowercase percent-encoding", () => {
  const q = 'fake"pass\\word<&>-0123456789';
  const { scrub } = redactor(q);
  for (const form of [
    JSON.stringify({ v: q }),
    `{ v: '${q.replace(/\\/g, "\\\\")}' }`,
    q
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;"),
    encodeURIComponent(q).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
  ]) {
    const out = scrub(form);
    assert.ok(out.includes(MASK), form);
    assert.ok(!out.includes("0123456789"), `${form} → ${out}`);
  }
});

test("a pattern reads characters, not bytes: a non-ASCII URL is masked whole", () => {
  const red = redactor("unrelated-value-123", ["postgres(ql)?://\\S+"]);
  const line = `url ${"postgres"}://user:pàssword-fake${"@"}host/db`;
  assert.equal(streamed(red, [line + "\n"]), `url ${MASK}\n`);
  assert.equal(red.scrub(line), `url ${MASK}`);
  // Split inside the à, too.
  const bytes = Buffer.from(line + "\n");
  const at = bytes.indexOf(0xa0);
  assert.equal(
    streamed(red, [bytes.subarray(0, at), bytes.subarray(at)]),
    `url ${MASK}\n`,
  );
});

test("a long line of multibyte characters is cut between characters", () => {
  const red = redactor(FAKE, []);
  const text = "é€😀".repeat(200);
  const out = streamed(red, [text.slice(0, 301), text.slice(301)], {
    maxLine: 64,
  });
  assert.equal(out, text, "no character broken");
});

test("a value that spans lines is masked whole, even when a chunk breaks inside it", () => {
  // The reviewer's probe: the short middle line went out before the rest came.
  const v = "AAAAfakeline1xyz\nshort\nBBBBfakeline2xyz";
  const out = streamed(redactor(v), [
    "key: AAAAfakeline1xyz\nshort\nBB",
    "BBfakeline2xyz\n",
  ]);
  assert.equal(out, `key: ${MASK}\n`);
});

test("a value of a few characters masks every occurrence of them: it fails closed", () => {
  assert.equal(
    redactor("ab").scrub("about the tab, abc"),
    `${MASK}out the t${MASK}, ${MASK}c`,
  );
});

test("each line of a value that spans lines is caught on its own", () => {
  const value = [
    ["-----BEGIN", "FAKE KEY-----"].join(" "),
    "AAAAfakeline1xyz",
    "BBBBfakeline2xyz",
    ["-----END", "FAKE KEY-----"].join(" "),
  ].join("\n");
  const { scrub } = redactor(value, []);
  const out = scrub("printed: BBBBfakeline2xyz only");
  assert.equal(out, `printed: ${MASK} only`);
});
