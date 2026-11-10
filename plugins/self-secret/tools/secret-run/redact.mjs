// What a command prints is scrubbed of the value it was given before
// anyone sees it.
//
// Every form of the value an ordinary tool prints is a needle: the value,
// each of its lines, its URL and form encodings (either case of hex), its
// JSON escapes (\uXXXX past ASCII or for < > &, and \/, as encoders print
// them), its string-literal and HTML escapes, base64 (padded and not),
// base64url and hex, and its stretch of any longer base64 blob it sits in,
// at each of the three alignments (an HTTP Basic header, a JSON body); its
// upper and lower case, its UTF-16LE, and a long value's lines as base64
// wraps them at 64 and 76 columns and hex at 60. The profile adds patterns
// of its own, read over characters (the u flag). Each match becomes MASK.
//
// Output is held until its line is complete, the stream ends, or the line
// outgrows maxLine, and then scrubbed as UTF-8 text; a line that is not
// UTF-8 is scrubbed byte for byte and passes through otherwise unchanged.
// Nothing is let out that could be the start of a needle still arriving,
// and a cut falls between characters, never through a match. Past four
// times maxLine a line is cut even through a pattern's match, never
// through a needle.
//
// Redaction guards against a value printed by accident. A command written
// to leak the value (in pieces, reversed, sent over the network) is not
// stopped by it: the self-secret README, Threat model. Nor are these,
// printed by accident or not: hex with spaces between its bytes, a value
// with a colour code inside it or wrapped at some other width, the first
// part of a value alone, rot13, and its letters in a case of their own
// mixing (all upper and all lower are caught; matching every case would
// need a held-back start that ignores case too).

import { isUtf8 } from "node:buffer";

export const MASK = "[redacted]";

/**
 * The shortest derived form worth a needle: shorter would mask ordinary text.
 * A caller may lower it (redactor's minDerived), so that a short value's
 * encoded forms are masked too.
 */
const MIN_DERIVED = 8;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lowerHex = (s) => s.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
/** The shortest wrapped line worth a needle, however short a caller lets derived forms be: a wrap's last line can be a few characters. */
const MIN_WRAPPED = 8;
/** A form's lines, as a tool that wraps it at that width prints them. */
const wrapped = (s, width) =>
  s.length <= width
    ? []
    : (s.match(new RegExp(`.{1,${width}}`, "g")) ?? []).filter(
        (line) => line.length >= MIN_WRAPPED,
      );

/**
 * The value's JSON string escapes as encoders print them, between the
 * quotes: JSON.stringify's own; with every character past ASCII as \uXXXX
 * (Python's json.dumps, PHP's json_encode); with < > & escaped the same
 * way (Go's encoding/json); with / as \/ (PHP); and each mix of those, the
 * escapes' hex in either case.
 */
function jsonForms(value) {
  const base = JSON.stringify(value).slice(1, -1);
  const u = (c, upper) => {
    const hex = c.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${upper ? hex.toUpperCase() : hex}`;
  };
  const out = new Set();
  for (const ascii of [false, true])
    for (const html of [false, true])
      for (const slash of [false, true])
        for (const upper of [false, true]) {
          let s = base;
          // Each UTF-16 unit past ASCII (a surrogate pair is two escapes).
          if (ascii) s = s.replace(/[^\x00-\x7f]/g, (c) => u(c, upper));
          if (html) s = s.replace(/[<>&\u2028\u2029]/g, (c) => u(c, upper));
          if (slash) s = s.replace(/\//g, "\\/");
          out.add(s);
        }
  return [...out];
}

/** The value's stretch of a longer base64 blob, at each alignment. */
function base64Stretches(bytes) {
  const out = [];
  for (let shift = 0; shift < 3; shift++) {
    const enc = Buffer.concat([Buffer.alloc(shift), bytes]).toString("base64");
    const last = shift + bytes.length - 1; // the value's last byte
    // A character covers bits [6i, 6i + 6); it is the value's alone when
    // its first byte is the value's first or later and its last byte is
    // the value's last or earlier.
    const start = Math.ceil((8 * shift) / 6);
    const end = Math.floor((8 * (last + 1) - 6) / 6);
    if (end >= start) out.push(enc.slice(start, end + 1));
  }
  return out;
}

/** Every form of the value redaction looks for, longest first. */
export function needlesOf(value, minDerived = MIN_DERIVED) {
  const set = new Set([value]);
  const derived = (s) => {
    if (s.length >= minDerived) set.add(s);
  };
  for (const line of value.split(/\r?\n/)) derived(line.trim());
  const bytes = Buffer.from(value, "utf8");
  const b64 = bytes.toString("base64");
  const url = encodeURIComponent(value);
  const form = new URLSearchParams({ v: value }).toString().slice(2);
  for (const f of [
    url,
    lowerHex(url),
    form,
    lowerHex(form),
    ...jsonForms(value),
    value.replace(/\\/g, "\\\\"),
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;"),
    b64,
    b64.replace(/=+$/, ""),
    bytes.toString("base64url"),
    bytes.toString("hex"),
    bytes.toString("hex").toUpperCase(),
    value.toUpperCase(),
    value.toLowerCase(),
    // UTF-16LE: for an ASCII value, its bytes are valid UTF-8 (a NUL after each character).
    Buffer.from(value, "utf16le").toString("latin1"),
    ...wrapped(b64, 64),
    ...wrapped(b64, 76),
    ...wrapped(bytes.toString("hex"), 60),
  ])
    derived(f);
  if (bytes.length >= 6)
    for (const s of base64Stretches(bytes)) {
      derived(s);
      derived(s.replace(/\+/g, "-").replace(/\//g, "_"));
    }
  set.delete("");
  return [...set].sort((a, b) => b.length - a.length);
}

/** A profile's pattern as a global regex over characters, refused if it could mask nothing. */
function compile(pattern) {
  let re;
  try {
    re = new RegExp(pattern, "gu");
  } catch (err) {
    throw new Error(
      `redaction pattern ${pattern} is not a valid pattern: ${err.message}`,
    );
  }
  if (new RegExp(pattern, "u").test(""))
    throw new Error(`redaction pattern ${pattern} matches an empty string`);
  return re;
}

/** The length of the bytes without an unfinished UTF-8 character at their end. */
function completeLength(buf) {
  let i = buf.length - 1;
  while (i >= 0 && buf.length - i < 4 && (buf[i] & 0xc0) === 0x80) i--;
  if (i < 0) return buf.length;
  const lead = buf[i];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return buf.length - i < need ? i : buf.length;
}

/**
 * A redactor for one value and a profile's patterns: scrub() for a
 * string, lines() for a byte stream. `minDerived`: how short a derived form
 * may be and still be masked (MIN_DERIVED unless given).
 */
export function redactor(value, patterns = [], { minDerived } = {}) {
  const res = patterns.map(compile);
  const needles = value ? needlesOf(value, minDerived) : [];
  const literal = needles.length
    ? new RegExp(needles.map(escape).join("|"), "g")
    : null;
  // The needles as their UTF-8 bytes, one latin1 character a byte, for
  // output that is not text and for finding where a cut may fall.
  const latin1 = needles.map((n) => Buffer.from(n, "utf8").toString("latin1"));
  const literalBytes = latin1.length
    ? new RegExp(latin1.map(escape).join("|"), "g")
    : null;
  const longest = Math.max(1, ...latin1.map((n) => n.length));

  const apply = (text, lit) => {
    let out = lit ? text.replace(lit, MASK) : text;
    for (const re of res) out = out.replace(re, MASK);
    return out;
  };

  /** The string, scrubbed. */
  const scrub = (text) => apply(String(text), literal);

  /** Bytes, scrubbed: as UTF-8 text, or byte for byte a line that is not. */
  const scrubBytes = (buf) => {
    if (isUtf8(buf))
      return Buffer.from(apply(buf.toString("utf8"), literal), "utf8");
    const parts = [];
    for (let start = 0; start < buf.length;) {
      const nl = buf.indexOf(0x0a, start);
      const end = nl < 0 ? buf.length : nl + 1;
      const line = buf.subarray(start, end);
      parts.push(
        isUtf8(line)
          ? Buffer.from(apply(line.toString("utf8"), literal), "utf8")
          : Buffer.from(apply(line.toString("latin1"), literalBytes), "latin1"),
      );
      start = end;
    }
    return Buffer.concat(parts);
  };

  /** Where each match of a regex starts and ends, in bytes. */
  const spans = (buf, l1, re, overText) => {
    const out = [];
    re.lastIndex = 0;
    if (overText) {
      const text = buf.subarray(0, completeLength(buf)).toString("utf8");
      for (const m of text.matchAll(re)) {
        const s = Buffer.byteLength(text.slice(0, m.index), "utf8");
        out.push([s, s + Buffer.byteLength(m[0], "utf8")]);
      }
    } else
      for (const m of l1.matchAll(re))
        out.push([m.index, m.index + m[0].length]);
    return out;
  };

  /**
   * How much of buf, up to end, may go out: not the start of a needle
   * still arriving, not through a needle, nor through a pattern's match
   * while guarding patterns, and only between characters.
   */
  const cutPoint = (buf, end, guardPatterns) => {
    const l1 = buf.toString("latin1");
    let cut = end;
    for (let p = Math.max(0, end - (longest - 1)); p < end; p++) {
      const tail = l1.slice(p, end);
      if (latin1.some((n) => n.length > tail.length && n.startsWith(tail))) {
        cut = p;
        break;
      }
    }
    const text = guardPatterns && isUtf8(buf.subarray(0, completeLength(buf)));
    const matches = [
      ...(literalBytes ? spans(buf, l1, literalBytes, false) : []),
      ...(guardPatterns ? res.flatMap((re) => spans(buf, l1, re, text)) : []),
    ];
    for (let moved = true; moved && cut > 0;) {
      moved = false;
      for (const [s, e] of matches)
        if (s < cut && e > cut) {
          cut = s;
          moved = true;
        }
      while (cut > 0 && cut < buf.length && (buf[cut] & 0xc0) === 0x80) {
        cut--;
        moved = true;
      }
    }
    return Math.max(cut, 0);
  };

  /**
   * A line-buffered scrubber: push() each chunk as it comes, end() when
   * the stream ends. write receives Buffers.
   */
  const lines = (write, { maxLine = 1 << 20 } = {}) => {
    let pending = Buffer.alloc(0);
    const flushTo = (end, guardPatterns) => {
      const cut = cutPoint(pending, end, guardPatterns);
      if (cut > 0) write(scrubBytes(pending.subarray(0, cut)));
      pending = pending.subarray(cut);
    };
    return {
      push(chunk) {
        const c = Buffer.from(chunk);
        pending = pending.length ? Buffer.concat([pending, c]) : c;
        const nl = pending.lastIndexOf(0x0a);
        if (nl >= 0) flushTo(nl + 1, true);
        // A line this long that a pattern still holds whole is cut anyway
        // past four times the limit, rather than kept forever.
        if (pending.length > maxLine)
          flushTo(pending.length, pending.length <= 4 * maxLine);
      },
      end() {
        if (pending.length) write(scrubBytes(pending));
        pending = Buffer.alloc(0);
      },
    };
  };

  return { scrub, lines };
}
