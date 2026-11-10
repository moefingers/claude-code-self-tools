// What secret-run and a hold's broker say to each other over the socket:
// frames of one type byte, a four-byte length and a payload.
//
// The handshake, before anything else: the caller sends C (a nonce of its
// own); the broker answers P (its proof that it holds the hold's token, an
// HMAC of the caller's nonce, and a nonce of its own); only if that proof
// is right does the caller send A (its proof, an HMAC of the broker's
// nonce) and then H, the request (JSON). The token itself never crosses.
//
// Then, to the broker: I bytes for the command's stdin, E the end of
// stdin. From it: J an answer (JSON), U a use begun (JSON), O and R the
// command's scrubbed stdout and stderr, X how it ended (JSON), M a refusal
// (JSON: error, message).

/** The most a frame may carry once both sides have proved themselves. */
export const MAX_FRAME = 16 * 1024 * 1024;
/** The most a frame may carry before then. */
export const FIRST_FRAME_MAX = 64 * 1024;

/** One frame. A payload that is not a Buffer or a string is sent as JSON. */
export function frame(type, payload) {
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(
        typeof payload === "string" ? payload : JSON.stringify(payload),
        "utf8",
      );
  const head = Buffer.alloc(5);
  head.write(type, 0, 1, "latin1");
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

/**
 * A data handler that calls onFrame(type, body) per whole frame, and onBad
 * on one longer than max. limit(n) changes max, for the frames after the
 * one being handled.
 */
export function frameReader(onFrame, onBad, { max = MAX_FRAME } = {}) {
  let buf = Buffer.alloc(0);
  let cap = max;
  let bad = false;
  const read = (chunk) => {
    if (bad) return;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 5 && !bad) {
      const len = buf.readUInt32BE(1);
      if (len > cap) {
        bad = true;
        buf = Buffer.alloc(0);
        onBad();
        return;
      }
      if (buf.length < 5 + len) return;
      const type = String.fromCharCode(buf[0]);
      const body = buf.subarray(5, 5 + len);
      buf = buf.subarray(5 + len);
      onFrame(type, body);
    }
  };
  read.limit = (n) => {
    cap = n;
  };
  return read;
}

/** A frame's JSON payload. */
export const json = (body) => JSON.parse(body.toString("utf8"));

/** A frame's JSON payload, or null when it is not JSON. */
export function jsonOrNull(body) {
  try {
    return json(body);
  } catch {
    // Not JSON is not a frame this protocol sends; the caller refuses it.
    return null;
  }
}
