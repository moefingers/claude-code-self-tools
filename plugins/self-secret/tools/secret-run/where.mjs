// Where secret-run keeps what is the person's own: one folder, the state folder, which holds the
// profiles file (secret-profiles.json), the holds (secret-run/holds/) and the stable copy of the
// command the self-secret plugin writes (secret-run.mjs). It is the folder the self-tools plugins keep
// their state in, so it stays where it is across the plugin's updates:
//
//   SELF_SECRET_HOME, when it is set (tests, or a person who keeps them elsewhere);
//   on Windows, %LOCALAPPDATA%\claude-self-tools;
//   elsewhere, $XDG_STATE_HOME/claude-self-tools when that is an absolute path, else
//   ~/.local/state/claude-self-tools.
//
// The plugin works the folder out by the same rule (hooks/shim.ts, from the engine's environment);
// invocation.test.mjs holds the two together.

import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** The profiles file's name, in the state folder. */
export const PROFILES_NAME = "secret-profiles.json";

/** A path as Git Bash writes it (/c/Users/...) in the form Node's file APIs read. */
export function nativePath(p, platform = process.platform) {
  if (platform === "win32") {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
    if (m) return `${m[1].toUpperCase()}:${m[2] ?? "/"}`;
  }
  return p;
}

/**
 * The state folder, or null when the rule finds none (Windows without
 * %LOCALAPPDATA%). Pure: it reads only what it is given.
 */
export function stateFolder(
  env = process.env,
  platform = process.platform,
  home = homedir(),
) {
  if (env.SELF_SECRET_HOME) return nativePath(env.SELF_SECRET_HOME, platform);
  if (platform === "win32")
    return env.LOCALAPPDATA
      ? win32.join(env.LOCALAPPDATA, "claude-self-tools")
      : null;
  const base = env.XDG_STATE_HOME?.startsWith("/")
    ? env.XDG_STATE_HOME
    : posix.join(home, ".local", "state");
  return posix.join(base, "claude-self-tools");
}
