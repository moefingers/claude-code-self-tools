// A command run with the secret in its environment, its output scrubbed.
//
// Its stdout and stderr are pipes, never the caller's own, and every byte
// goes through the redactor's line buffer before it is written on. Its
// exit code is the caller's; a command killed by a signal is 128. A
// command that could not start at all is reported, not crashed on.

import { spawn } from "node:child_process";

/**
 * Starts argv with env (and cwd), stdin as given. out and err receive the
 * scrubbed bytes. done resolves { code, signal } or { error } once both
 * streams are flushed.
 */
export function spawnScrubbed(
  argv,
  { env, cwd, stdin = "inherit" },
  red,
  { out, err },
) {
  const outLines = red.lines(out);
  const errLines = red.lines(err);
  let child = null;
  const done = new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      outLines.end();
      errLines.end();
      resolve(result);
    };
    try {
      child = spawn(argv[0], argv.slice(1), {
        env,
        cwd,
        stdio: [stdin, "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      settle({ error: red.scrub(e.code ?? e.message) });
      return;
    }
    child.stdout.on("data", (c) => outLines.push(c));
    child.stderr.on("data", (c) => errLines.push(c));
    // A process that never started has no pid; one that did reports its end on close.
    child.on("error", (e) => {
      if (child.pid === undefined)
        settle({ error: red.scrub(e.code ?? e.message) });
    });
    child.on("close", (code, signal) => {
      if (child.pid !== undefined) settle({ code, signal });
    });
  });
  return { child, done };
}

/** The exit code a run ends with: the command's own, or 128 for one a signal ended. */
export const exitCodeOf = ({ code, signal }) =>
  code !== null && code !== undefined ? code : signal ? 128 : 0;
